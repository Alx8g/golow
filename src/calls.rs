//! Requests from the page that need the app. The page is SoundCloud's, so every request is
//! checked here: names, sizes and paths come from GoLow, never from the request.
use crate::{notify, policy, remote, settings::Call, shell, store, update, Action, APP_NAME};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tao::event_loop::EventLoopProxy;

pub enum Answer {
    Now(Result<Value, String>),
    /// Answered later with Action::Reply, from a worker thread.
    Later,
}

pub struct Services {
    pub base: PathBuf,
    pub dir: PathBuf,
    pub profile: String,
    pub store: store::Store,
    pub remote_state: Arc<Mutex<remote::State>>,
    pub remote: Option<remote::Remote>,
    pub release: Option<update::Release>,
    pub installed: Option<PathBuf>,
    pub proxy: EventLoopProxy<Action>,
    notifications: bool,
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().ok_or_else(|| format!("missing {key}"))
}

/// Profile names are folder names: letters, digits, spaces, dashes and underscores.
pub fn valid_profile(name: &str) -> bool {
    name.is_empty()
        || ((1..=32).contains(&name.len())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || " -_".contains(c))
            && !name.starts_with(' ')
            && !name.ends_with(' '))
}

impl Services {
    pub fn new(
        base: PathBuf,
        dir: PathBuf,
        profile: String,
        proxy: EventLoopProxy<Action>,
    ) -> Self {
        Self {
            store: store::Store::new(dir.join("data")),
            base,
            dir,
            profile,
            remote_state: Arc::default(),
            remote: None,
            release: None,
            installed: None,
            proxy,
            notifications: false,
        }
    }

    pub fn set_remote(&mut self, on: bool) {
        if on == self.remote.is_some() {
            return;
        }
        self.remote = None;
        if on {
            let proxy = Mutex::new(self.proxy.clone());
            let command = Arc::new(move |name: &'static str, arg: Option<f64>| {
                let _ = proxy
                    .lock()
                    .unwrap()
                    .send_event(Action::Command(name, arg.map_or(Value::Null, |s| json!(s))));
            });
            self.remote = remote::Remote::start(&self.dir, self.remote_state.clone(), command).ok();
        }
    }

    pub fn profiles(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.base.join("profiles"))
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| !name.is_empty() && valid_profile(name))
            .collect();
        names.sort();
        names.insert(0, String::new());
        names
    }

    pub fn notify(&mut self, title: &str, body: &str, tab: Option<String>) -> Result<(), String> {
        if !self.notifications {
            self.notifications = notify::register(&self.dir);
        }
        let proxy = Mutex::new(self.proxy.clone());
        notify::show(title, body, move || {
            let proxy = proxy.lock().unwrap();
            let _ = proxy.send_event(Action::Show);
            if let Some(tab) = &tab {
                let _ = proxy.send_event(Action::Command("panel", json!(tab)));
            }
        })
        .map_err(|e| e.to_string())
    }

    fn later(
        &self,
        id: u32,
        work: impl FnOnce() -> Result<Value, String> + Send + 'static,
    ) -> Answer {
        let proxy = self.proxy.clone();
        thread::spawn(move || {
            let _ = proxy.send_event(Action::Reply(id, work()));
        });
        Answer::Later
    }

    pub fn answer(&mut self, call: &Call) -> Answer {
        let args = &call.args;
        Answer::Now(match call.call.as_str() {
            "open" => text(args, "url")
                .ok()
                .and_then(policy::external)
                .map(|url| json!(shell::open_url(&url)))
                .ok_or_else(|| "not an external https link".into()),
            "load" => (|| {
                let content = self.store.load(text(args, "name")?, args["log"].as_bool().unwrap_or(false))?;
                Ok(content.map_or(Value::Null, Value::String))
            })(),
            "save" => (|| self.store.save(text(args, "name")?, text(args, "data")?).map(|()| Value::Null))(),
            "append" => (|| self.store.append(text(args, "name")?, text(args, "line")?).map(|()| Value::Null))(),
            "list" => Ok(json!(self.store.list(args["prefix"].as_str().unwrap_or_default()))),
            "remove" => (|| self.store.remove(text(args, "name")?).map(|()| Value::Null))(),
            "export" => (|| {
                let path = store::export(text(args, "name")?, text(args, "ext")?, text(args, "data")?)?;
                shell::reveal(&path);
                Ok(json!(path.to_string_lossy()))
            })(),
            "open_folder" => {
                let data = args["which"] == "data" && self.store.dir().is_dir();
                Ok(json!(shell::open_folder(if data { self.store.dir() } else { &self.dir })))
            }
            "notify" => (|| {
                let tab = args["tab"].as_str().filter(|t| t.len() <= 20).map(str::to_owned);
                self.notify(text(args, "title")?, args["body"].as_str().unwrap_or_default(), tab).map(|()| Value::Null)
            })(),
            "remote_info" => match &self.remote {
                Some(remote) => remote::qr(&remote.url)
                    .map(|(size, modules)| json!({"url": remote.url, "size": size, "modules": modules}))
                    .ok_or_else(|| "could not draw the QR code".into()),
                None => Err("The phone remote is off, or this PC is not on a network.".into()),
            },
            "remote_state" => {
                if let Ok(state) = serde_json::from_value::<remote::State>(args.clone()) {
                    *self.remote_state.lock().unwrap() = state;
                }
                Ok(Value::Null)
            }
            "lyrics" => {
                let (artist, title) = (text(args, "artist").unwrap_or_default().chars().take(200).collect::<String>(),
                    text(args, "title").unwrap_or_default().chars().take(300).collect::<String>());
                let seconds = args["seconds"].as_u64().unwrap_or(0).min(24 * 3600) as u32;
                if title.is_empty() {
                    return Answer::Now(Err("no title".into()));
                }
                return self.later(call.id, move || Ok(crate::lyrics::find(&artist, &title, seconds)));
            }
            "update_check" => {
                return self.later(call.id, || {
                    Ok(update::check().map_or(Value::Null, |release| json!({"version": release.version, "page": release.page})))
                })
            }
            "update_install" => {
                let Some(release) = self.release.clone() else {
                    return Answer::Now(Err("no update to install".into()));
                };
                let proxy = self.proxy.clone();
                return self.later(call.id, move || {
                    let exe = update::install(&release).map_err(|error| format!("Update failed: {error}"))?;
                    let _ = proxy.send_event(Action::Installed(exe));
                    Ok(Value::Null)
                });
            }
            "restart" => match &self.installed {
                Some(exe) if update::relaunch(exe) => {
                    let _ = self.proxy.send_event(Action::Quit);
                    Ok(Value::Null)
                }
                _ => Err("nothing to restart into".into()),
            },
            "profiles" => Ok(json!({"current": self.profile, "names": self.profiles()})),
            "switch_profile" | "add_profile" => (|| {
                let name = text(args, "name")?.trim();
                if !valid_profile(name) {
                    return Err("Use letters, numbers, spaces, - or _ (up to 32)".into());
                }
                if call.call == "add_profile" {
                    std::fs::create_dir_all(self.base.join("profiles").join(name)).map_err(|e| e.to_string())?;
                }
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let mut command = std::process::Command::new(exe);
                command.args(["--after", &std::process::id().to_string()]);
                if !name.is_empty() {
                    command.args(["--profile", name]);
                }
                command.spawn().map_err(|e| e.to_string())?;
                let _ = self.proxy.send_event(Action::Quit);
                Ok(Value::Null)
            })(),
            other => Err(format!("{APP_NAME} does not know the request {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_names_are_plain_folder_names() {
        for good in ["", "Work", "dj sets", "a-b_c"] {
            assert!(valid_profile(good), "{good}");
        }
        for bad in ["..", "a/b", "a\\b", " x", "x ", "CON:", &"x".repeat(33)] {
            assert!(!valid_profile(bad), "{bad}");
        }
    }
}
