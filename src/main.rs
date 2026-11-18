#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calls;
mod discord;
mod filter;
mod hotkeys;
mod http;
mod instance;
mod lastfm;
mod lyrics;
mod native;
mod notify;
mod policy;
mod remote;
mod settings;
mod shell;
mod store;
mod taskbar;
mod update;

use calls::{Answer, Services};
use serde_json::{json, Value};
use settings::{
    read_json, write_json, Call, Message, NowPlaying, Settings, StartPage, WindowState,
};
use std::{
    cell::{Cell, RefCell},
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::windows::{EventLoopBuilderExtWindows, WindowExtWindows},
    window::{Icon, Window, WindowBuilder, WindowId},
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};
use wry::{
    MemoryUsageLevel, NewWindowResponse, PageLoadEvent, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

pub const APP_NAME: &str = env!("APP_NAME");
const SAVE_DELAY: Duration = Duration::from_millis(350);

#[derive(Clone, Debug)]
enum Action {
    Settings(Settings),
    Now(NowPlaying),
    Call(Call),
    /// Settles a page request answered on a worker thread.
    Reply(u32, Result<Value, String>),
    /// A page command from the tray, hotkeys, taskbar or the remote: `window.__scClient.command`.
    Command(&'static str, Value),
    Hotkey(usize),
    TaskbarReady,
    Zoom(f64),
    Update(update::Release),
    Installed(PathBuf),
    PageLoaded,
    ClosePopup(WindowId),
    Show,
    PlayPause,
    Quit,
}

struct Popup {
    _view: WebView,
    window: Window,
}

/// `--profile NAME` runs a separate SoundCloud account; `--after PID` waits for a closing copy.
struct Args {
    profile: String,
    after: Option<u32>,
}

fn args() -> Args {
    let (mut profile, mut after, mut args) = (String::new(), None, std::env::args().skip(1));
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--profile" => {
                profile = args.next().filter(|name| calls::valid_profile(name)).unwrap_or_default()
            }
            "--after" => after = args.next().and_then(|pid| pid.parse().ok()),
            _ => {}
        }
    }
    Args { profile, after }
}

fn wait_for(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 10_000);
            CloseHandle(handle);
        }
    }
}

fn base_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GOLOW_PROFILE_DIR") {
        return dir.into();
    }
    let data = dirs::data_dir().expect("Windows app data directory unavailable");
    // Keep using a profile from the SoundCloud Go+ builds. Moving it risks sign-in and DRM state.
    let (legacy, current) = (data.join("soundcloud-go-client"), data.join("golow"));
    if legacy.exists() && !current.exists() {
        legacy
    } else {
        current
    }
}

/// Startup timings only: no visited URLs or authentication tokens.
fn log(dir: &Path, started: Instant, message: &str) {
    if let Ok(mut file) = std::fs::File::options().append(true).open(dir.join("startup.log")) {
        let _ = writeln!(file, "t={:.2}s {message}", started.elapsed().as_secs_f32());
    }
}

fn set_background(view: &WebView, hidden: bool, efficiency: bool) {
    let level = if hidden && efficiency { MemoryUsageLevel::Low } else { MemoryUsageLevel::Normal };
    let _ = view.set_memory_usage_level(level);
    let _ = view.set_visible(!hidden);
}

fn apply_window(
    window: &Window,
    next: &Settings,
    previous: &Settings,
    normal: &mut PhysicalSize<u32>,
) {
    window.set_always_on_top(next.always_on_top);
    if next.compact != previous.compact {
        if next.compact {
            if !window.is_minimized() {
                *normal = window.inner_size();
            }
            // Mini player: just SoundCloud's 48px control bar.
            window.set_min_inner_size(Some(LogicalSize::new(420.0, 56.0)));
            window.set_inner_size(LogicalSize::new(720.0, 56.0));
        } else {
            window.set_min_inner_size(Some(LogicalSize::new(360.0, 400.0)));
            window.set_inner_size(*normal);
        }
    }
}

fn scrobble(lastfm: &Option<std::sync::mpsc::Sender<lastfm::Event>>, event: lastfm::Event) {
    if let Some(lastfm) = lastfm {
        let _ = lastfm.send(event);
    }
}

/// Shown while music keeps playing behind a closed window.
fn tray(rgba: &[u8], w: u32, h: u32, tooltip: &str) -> Option<TrayIcon> {
    let item = |id: &str, label: &str| MenuItem::with_id(id, label, true, None);
    let (show, play, next, quit) = (
        item("show", &format!("Show {APP_NAME}")),
        item("play", "Play/Pause"),
        item("next", "Next track"),
        item("quit", "Quit"),
    );
    let sleep = Submenu::with_items(
        "Sleep timer",
        true,
        &[
            &item("sleep:15", "15 minutes"),
            &item("sleep:30", "30 minutes"),
            &item("sleep:60", "1 hour"),
            &item("sleep:-1", "End of this track"),
            &item("sleep:0", "Off"),
        ],
    )
    .ok()?;
    let separator = PredefinedMenuItem::separator();
    let menu = Menu::with_items(&[&show, &play, &next, &sleep, &separator, &quit]).ok()?;
    TrayIconBuilder::new()
        .with_icon(tray_icon::Icon::from_rgba(rgba.to_vec(), w, h).ok()?)
        .with_tooltip(tooltip)
        .with_menu(Box::new(menu))
        .build()
        .ok()
}

/// Settles a page request: `window.__scClient.reply(id, value, error)`.
fn reply(view: &WebView, id: u32, result: Result<Value, String>) {
    let (value, error) = match result {
        Ok(value) => (value, Value::Null),
        Err(error) => (Value::Null, Value::String(error)),
    };
    let _ = view.evaluate_script(&format!("window.__scClient?.reply({id},{value},{error});"));
}

/// Tells the page something happened in the app: `window.__scClient.event(name, data)`.
fn notice(view: &WebView, name: &str, data: &Value) {
    let _ = view.evaluate_script(&format!("window.__scClient?.event({},{data});", json!(name)));
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// At most one GitHub check a day, recorded in update.json.
fn check_updates(dir: &Path, proxy: EventLoopProxy<Action>) {
    let file = dir.join("update.json");
    let checked = read_json::<Value>(&file).and_then(|v| v["checked"].as_u64()).unwrap_or(0);
    if unix_now().saturating_sub(checked) < 20 * 3600 {
        return;
    }
    std::thread::spawn(move || {
        let _ = write_json(&file, &json!({"checked": unix_now()}));
        if let Some(release) = update::check() {
            let _ = proxy.send_event(Action::Update(release));
        }
    });
}

/// The page script and what it needs to know about this build.
fn init_script(prefs: &Settings, profile: &str) -> Result<String, serde_json::Error> {
    let app = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "profile": profile,
        "lastfm": lastfm::KEY.is_some(),
        "hotkeys": hotkeys::ACTIONS.iter().map(|(action, keys)| (action.to_string(), json!(keys))).collect::<serde_json::Map<_, _>>(),
    });
    Ok(format!(
        "window.__scInitialSettings={};window.__scLastfm={};window.__scApp={app};\n{}",
        serde_json::to_string(prefs)?,
        lastfm::KEY.is_some(),
        include_str!(concat!(env!("OUT_DIR"), "/client.js"))
    ))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let Args { profile, after } = args();
    if let Some(pid) = after {
        wait_for(pid);
    }
    let base = base_dir();
    let dir = if profile.is_empty() { base.clone() } else { base.join("profiles").join(&profile) };
    std::fs::create_dir_all(&dir)?;
    let Some(instance) = instance::Instance::acquire(&dir)? else {
        return Ok(());
    };
    std::fs::write(dir.join("startup.log"), format!("{APP_NAME} {}\n", env!("CARGO_PKG_VERSION")))?;
    let mut prefs: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
    // A second launch posts show_message to this window; the hook turns it into an action.
    let (show_message, hook_proxy) = (instance::show_message(), Rc::new(RefCell::new(None)));
    let hook_target: Rc<RefCell<Option<EventLoopProxy<Action>>>> = hook_proxy.clone();
    let event_loop = EventLoopBuilder::<Action>::with_user_event()
        .with_msg_hook(move |msg| {
            let msg = unsafe { &*msg.cast::<windows_sys::Win32::UI::WindowsAndMessaging::MSG>() };
            let ours = msg.message == show_message;
            if let (true, Some(proxy)) = (ours, hook_target.borrow().as_ref()) {
                let _ = proxy.send_event(Action::Show);
            }
            ours
        })
        .build();
    let target = (*event_loop).clone();
    let proxy = event_loop.create_proxy();
    *hook_proxy.borrow_mut() = Some(proxy.clone());
    let tray_proxy = Mutex::new(proxy.clone());
    TrayIconEvent::set_event_handler(Some(move |event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = tray_proxy.lock().unwrap().send_event(Action::Show);
        }
    }));
    let menu_proxy = Mutex::new(proxy.clone());
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let action = match event.id.0.as_str() {
            "play" => Action::PlayPause,
            "next" => Action::Command("next", Value::Null),
            "quit" => Action::Quit,
            id => match id.strip_prefix("sleep:").and_then(|minutes| minutes.parse::<i32>().ok()) {
                Some(minutes) => Action::Command("sleep", json!(minutes)),
                None => Action::Show,
            },
        };
        let _ = menu_proxy.lock().unwrap().send_event(action);
    }));

    let title =
        if profile.is_empty() { APP_NAME.to_owned() } else { format!("{APP_NAME} ({profile})") };
    let mut builder = WindowBuilder::new()
        .with_title(&title)
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(360.0, 400.0));
    let saved = read_json::<WindowState>(&dir.join("window.json")).filter(WindowState::valid);
    if let Some(state) = &saved {
        builder = builder.with_inner_size(PhysicalSize::new(state.w, state.h));
        let on_screen = event_loop.available_monitors().any(|monitor| {
            let (pos, size) = (monitor.position(), monitor.size());
            state.x < pos.x + size.width as i32
                && state.y < pos.y + size.height as i32
                && state.x + state.w as i32 > pos.x
                && state.y + 40 > pos.y
        });
        if on_screen {
            builder = builder.with_position(PhysicalPosition::new(state.x, state.y));
        }
    }
    let (w, h) = (env!("APP_ICON_WIDTH").parse()?, env!("APP_ICON_HEIGHT").parse()?);
    let icon = include_bytes!(concat!(env!("OUT_DIR"), "/icon.rgba"));
    let window =
        builder.with_window_icon(Icon::from_rgba(icon.to_vec(), w, h).ok()).build(&event_loop)?;
    instance.mark(window.hwnd());
    log(&dir, started, "window_built");
    let mut normal_size = window.inner_size();
    let position = window.outer_position().unwrap_or(PhysicalPosition::new(100, 100));
    let mut win_state = WindowState {
        x: position.x,
        y: position.y,
        w: normal_size.width,
        h: normal_size.height,
        last: String::new(),
        zoom: saved.as_ref().map_or(1.0, |state| state.zoom),
    };
    apply_window(&window, &prefs, &Settings { compact: false, ..prefs.clone() }, &mut normal_size);

    // Hotkeys, taskbar buttons and the taskbar-ready notice arrive as window messages.
    let native_proxy = proxy.clone();
    native::subclass(window.hwnd(), move |message| {
        let _ = native_proxy.send_event(match message {
            native::Native::Hotkey(id) => Action::Hotkey(id),
            native::Native::Thumb(taskbar::PREVIOUS) => Action::Command("previous", Value::Null),
            native::Native::Thumb(taskbar::NEXT) => Action::Command("next", Value::Null),
            native::Native::Thumb(_) => Action::PlayPause,
            native::Native::TaskbarReady => Action::TaskbarReady,
        });
    });
    let mut hotkeys = hotkeys::Hotkeys::new(window.hwnd());
    let mut hotkey_status = json!(hotkeys.apply(prefs.hotkeys, &prefs.shortcuts));
    // Fails until Windows announces the taskbar button; TaskbarReady retries then.
    let mut thumbs = taskbar::Taskbar::add(window.hwnd(), false).ok();
    log(
        &dir,
        started,
        if thumbs.is_some() { "taskbar_buttons" } else { "taskbar_buttons_pending" },
    );

    let mut context = WebContext::new(Some(dir.join("webview")));
    let script = init_script(&prefs, &profile)?;
    let discord = discord::start(discord::APP_ID);
    let lastfm = lastfm::KEY.map(|key| lastfm::start(key, dir.clone()));
    if prefs.lastfm {
        scrobble(&lastfm, lastfm::Event::Connect);
    }
    let mut services = Services::new(base.clone(), dir.clone(), profile.clone(), proxy.clone());
    services.set_remote(prefs.remote);
    if prefs.updates {
        check_updates(&dir, proxy.clone());
    }
    let popups: Rc<RefCell<Vec<Popup>>> = Rc::default();
    let (popup_store, popup_proxy, ipc_proxy, load_proxy, log_dir) =
        (popups.clone(), proxy.clone(), proxy.clone(), proxy.clone(), dir.clone());
    // Links the page opens in a new window go to the browser, at most one a second.
    let last_external = Cell::new(Instant::now() - Duration::from_secs(5));
    // Hardware acceleration off is for machines where the GPU path misbehaves.
    let browser_args = if prefs.gpu { "" } else { "--disable-gpu" };
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_initialization_script(&script)
        .with_background_color((11, 11, 12, 255))
        .with_devtools(cfg!(debug_assertions))
        // Ctrl+wheel, Ctrl+plus, Ctrl+minus and Ctrl+0 zoom the page.
        .with_hotkeys_zoom(true)
        // Explicit arguments avoid Wry's default SmartScreen-disabling flag.
        // Standard Chromium background throttling stays enabled.
        .with_additional_browser_args(browser_args)
        .with_navigation_handler(|url| policy::navigation_allowed(&url))
        .with_ipc_handler(move |request| {
            // Requests can carry data such as a library backup; settings and now-playing are small.
            let body = request.body();
            if body.len() > store::LIMIT + 4096
                || !policy::soundcloud_page(&request.uri().to_string())
            {
                return;
            }
            let _ = ipc_proxy.send_event(match serde_json::from_str(body) {
                Ok(Message::Settings(next)) if body.len() <= 16384 => {
                    Action::Settings(next.sanitized())
                }
                Ok(Message::Now(now)) if body.len() <= 4096 => Action::Now(now),
                Ok(Message::Call(call)) => Action::Call(call),
                _ => return,
            });
        })
        .with_new_window_req_handler(move |url, features| {
            if let Some(external) = policy::external(&url) {
                if last_external.get().elapsed() >= Duration::from_secs(1) {
                    last_external.set(Instant::now());
                    shell::open_url(&external);
                }
                return NewWindowResponse::Deny;
            }
            if !policy::navigation_allowed(&url) || popup_store.borrow().len() >= 3 {
                return NewWindowResponse::Deny;
            }
            let Ok(window) = WindowBuilder::new()
                .with_title("SoundCloud sign in")
                .with_inner_size(LogicalSize::new(600.0, 740.0))
                .build(&target)
            else {
                return NewWindowResponse::Deny;
            };
            let (id, close_proxy) = (window.id(), popup_proxy.clone());
            let Ok(view) = WebViewBuilder::new()
                .with_environment(features.opener.environment)
                .with_additional_browser_args("")
                .with_devtools(cfg!(debug_assertions))
                .with_navigation_handler(|url| policy::navigation_allowed(&url))
                .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                .with_initialization_script("window.close=()=>window.ipc.postMessage('close');")
                .with_ipc_handler(move |request| {
                    if request.body() == "close"
                        && policy::navigation_allowed(&request.uri().to_string())
                    {
                        let _ = close_proxy.send_event(Action::ClosePopup(id));
                    }
                })
                .build(&window)
            else {
                return NewWindowResponse::Deny;
            };
            let webview = view.webview();
            popup_store.borrow_mut().push(Popup { _view: view, window });
            NewWindowResponse::Create { webview }
        })
        .with_on_page_load_handler(move |event, _| {
            let finished = matches!(event, PageLoadEvent::Finished);
            if finished {
                let _ = load_proxy.send_event(Action::PageLoaded);
            }
            log(&log_dir, started, if finished { "page_finished" } else { "page_started" });
        })
        .build(&window)?;
    log(&dir, started, "webview_built");
    let rules =
        |prefs: &Settings| filter::Rules { cleanup: prefs.cleanup, efficiency: prefs.efficiency };
    let filter_prefs = Rc::new(Cell::new(rules(&prefs)));
    if let Err(error) = filter::install(&view, filter_prefs.clone()) {
        log(&dir, started, &format!("optional_resource_filter_unavailable {error}"));
    }
    // Zoom stays where the user left it.
    if (0.25..=5.0).contains(&win_state.zoom) && win_state.zoom != 1.0 {
        let _ = view.zoom(win_state.zoom);
    }
    let zoom_proxy = proxy.clone();
    let on_zoom =
        webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
            if let Some(controller) = controller {
                let mut factor = 1.0;
                unsafe { controller.ZoomFactor(&mut factor)? };
                let _ = zoom_proxy.send_event(Action::Zoom(factor));
            }
            Ok(())
        }));
    let mut token = 0;
    // Raised for the user's own zooming; zoom the app sets is saved where it is set.
    let _ = unsafe { view.controller().add_ZoomFactorChanged(&on_zoom, &mut token) };
    // The chosen start page, or the page open at the last exit.
    let last = saved.map(|state| state.last).filter(|path| {
        path.starts_with('/') && policy::soundcloud_page(&format!("https://soundcloud.com{path}"))
    });
    let start = match (prefs.start_page, last) {
        (StartPage::Last, Some(path)) => path,
        (page, _) => page.path().into(),
    };
    view.load_url(&format!("https://soundcloud.com{start}"))?;
    let (mut save_at, mut minimized) = (None::<Instant>, false);
    let (mut now_playing, mut tray_icon) = (None::<String>, None::<TrayIcon>);

    event_loop.run(move |event, _, control_flow| {
        let _keep_alive = &instance;
        let mut exit = false;
        match event {
            Event::UserEvent(Action::Now(now)) => {
                if prefs.lastfm {
                    scrobble(
                        &lastfm,
                        match &now.now {
                            // Unknown tracks inside a mix ("ID - ID") are shown, never scrobbled.
                            Some(_) if now.artist.is_empty() && now.title.is_empty() => {
                                lastfm::Event::Paused
                            }
                            Some(_) => {
                                let (artist, title) = lastfm::split(&now.artist, &now.title);
                                lastfm::Event::Playing { artist, title, seconds: now.seconds }
                            }
                            None => lastfm::Event::Paused,
                        },
                    );
                }
                if prefs.now_file {
                    // For stream overlays: "Artist - Title" while playing, empty when paused.
                    let line = match (&now.now, now.artist.is_empty() || now.title.is_empty()) {
                        (None, _) => String::new(),
                        (Some(text), true) => text.clone(),
                        (Some(_), false) => format!("{} - {}", now.artist, now.title),
                    };
                    let _ = std::fs::write(dir.join("now-playing.txt"), line);
                }
                now_playing = now.now.map(|title| title.chars().take(200).collect());
                if prefs.discord {
                    let _ = discord.send(now_playing.clone());
                }
                if let Some(thumbs) = &mut thumbs {
                    thumbs.set_playing(now_playing.is_some());
                }
                let full = now_playing.as_ref().map(|now| format!("{now} · {title}"));
                window.set_title(full.as_deref().unwrap_or(&title));
                if let Some(tray) = &tray_icon {
                    let _ = tray.set_tooltip(full.as_deref());
                }
            }
            Event::UserEvent(Action::Show) => {
                tray_icon = None;
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
                minimized = false;
                set_background(&view, false, prefs.efficiency);
            }
            Event::UserEvent(Action::PlayPause) => {
                let _ =
                    view.evaluate_script("document.querySelector('.playControls__play')?.click()");
            }
            Event::UserEvent(Action::Command(name, arg)) => {
                let script = format!("window.__scClient?.command({},{arg});", json!(name));
                let _ = view.evaluate_script(&script);
            }
            Event::UserEvent(Action::Hotkey(id)) => match hotkeys::Hotkeys::action(id) {
                Some("show") => {
                    let _ = proxy.send_event(Action::Show);
                }
                Some(name) => {
                    let _ = view
                        .evaluate_script(&format!("window.__scClient?.command({});", json!(name)));
                }
                None => {}
            },
            Event::UserEvent(Action::TaskbarReady) => {
                thumbs = taskbar::Taskbar::add(window.hwnd(), now_playing.is_some()).ok();
                log(
                    &dir,
                    started,
                    if thumbs.is_some() { "taskbar_buttons" } else { "taskbar_buttons_failed" },
                );
            }
            Event::UserEvent(Action::Zoom(factor)) if (0.25..=5.0).contains(&factor) => {
                win_state.zoom = factor;
                save_at = Some(Instant::now() + SAVE_DELAY);
            }
            Event::UserEvent(Action::Call(call)) => match call.call.as_str() {
                "zoom" => {
                    let factor = call.args["factor"].as_f64().unwrap_or(1.0).clamp(0.25, 5.0);
                    let result =
                        view.zoom(factor).map(|()| json!(factor)).map_err(|e| e.to_string());
                    // Only the user's own zooming raises ZoomFactorChanged, so save this one here.
                    if result.is_ok() {
                        win_state.zoom = factor;
                        save_at = Some(Instant::now() + SAVE_DELAY);
                    }
                    reply(&view, call.id, result);
                }
                "hotkeys" => reply(&view, call.id, Ok(hotkey_status.clone())),
                _ => {
                    if let Answer::Now(result) = services.answer(&call) {
                        reply(&view, call.id, result);
                    }
                }
            },
            Event::UserEvent(Action::Reply(id, result)) => reply(&view, id, result),
            Event::UserEvent(Action::Update(release)) => {
                notice(&view, "update", &json!({"version": release.version, "page": release.page}));
                services.release = Some(release);
            }
            Event::UserEvent(Action::Installed(exe)) => {
                services.installed = Some(exe);
                notice(&view, "installed", &Value::Null);
            }
            Event::UserEvent(Action::Quit) => exit = true,
            Event::UserEvent(Action::ClosePopup(id)) => {
                popups.borrow_mut().retain(|p| p.window.id() != id)
            }
            Event::UserEvent(Action::PageLoaded) => {
                if let Ok(json) = serde_json::to_string(&prefs) {
                    let _ = view.evaluate_script(&format!("window.__scClient?.update({json});"));
                }
                notice(&view, "hotkeys", &hotkey_status);
                if let Some(release) = &services.release {
                    notice(
                        &view,
                        "update",
                        &json!({"version": release.version, "page": release.page}),
                    );
                }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::UserEvent(Action::Settings(next)) => {
                if next.lastfm != prefs.lastfm {
                    scrobble(
                        &lastfm,
                        if next.lastfm { lastfm::Event::Connect } else { lastfm::Event::Paused },
                    );
                }
                if next.discord != prefs.discord {
                    let _ = discord.send(now_playing.clone().filter(|_| next.discord));
                }
                if next.hotkeys != prefs.hotkeys || next.shortcuts != prefs.shortcuts {
                    hotkey_status = json!(hotkeys.apply(next.hotkeys, &next.shortcuts));
                    notice(&view, "hotkeys", &hotkey_status);
                }
                if next.now_file != prefs.now_file && !next.now_file {
                    let _ = std::fs::remove_file(dir.join("now-playing.txt"));
                }
                if next.updates && !prefs.updates {
                    check_updates(&dir, proxy.clone());
                }
                services.set_remote(next.remote);
                apply_window(&window, &next, &prefs, &mut normal_size);
                prefs = next;
                filter_prefs.set(rules(&prefs));
                if let Err(error) = write_json(&dir.join("settings.json"), &prefs) {
                    log(&dir, started, &format!("settings_save_failed {error}"));
                }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::WindowEvent { window_id, event, .. } if window_id == window.id() => {
                match event {
                    // Closing while music plays keeps it playing from the tray.
                    WindowEvent::CloseRequested if now_playing.is_some() => {
                        let tooltip = format!("{} · {title}", now_playing.as_deref().unwrap_or(""));
                        if tray_icon.is_none() {
                            tray_icon = tray(icon, w, h, &tooltip);
                        }
                        if tray_icon.is_some() {
                            window.set_visible(false);
                            minimized = true;
                            set_background(&view, true, prefs.efficiency);
                            save_at = Some(Instant::now());
                        } else {
                            exit = true;
                        }
                    }
                    WindowEvent::CloseRequested => exit = true,
                    WindowEvent::Resized(size) => {
                        let hidden = window.is_minimized() || size.width == 0 || size.height == 0;
                        if hidden != minimized {
                            minimized = hidden;
                            set_background(&view, minimized, prefs.efficiency);
                        }
                        // Minimized, maximized and compact geometry never replaces the normal size.
                        if !hidden && !window.is_maximized() && !prefs.compact {
                            (win_state.w, win_state.h, normal_size) =
                                (size.width, size.height, size);
                            save_at = Some(Instant::now() + SAVE_DELAY);
                        }
                    }
                    WindowEvent::Moved(pos) if !window.is_minimized() && !window.is_maximized() => {
                        (win_state.x, win_state.y) = (pos.x, pos.y);
                        save_at = Some(Instant::now() + SAVE_DELAY);
                    }
                    _ => {}
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                popups.borrow_mut().retain(|p| p.window.id() != window_id)
            }
            _ => {}
        }
        // A scrobble that is due goes out before the app exits.
        if let (true, Some(lastfm)) = (exit && prefs.lastfm, &lastfm) {
            let (done, flushed) = std::sync::mpsc::channel();
            if lastfm.send(lastfm::Event::Quit(done)).is_ok() {
                let _ = flushed.recv_timeout(Duration::from_secs(3));
            }
        }
        // Window-state writes wait for a pause in move/resize storms, and happen on close.
        if exit {
            win_state.last = view
                .url()
                .ok()
                .filter(|url| policy::soundcloud_page(url))
                .and_then(|url| url::Url::parse(&url).ok())
                .map(|url| url.path().chars().take(512).collect())
                .unwrap_or_default();
            if prefs.now_file {
                let _ = std::fs::write(dir.join("now-playing.txt"), "");
            }
        }
        if (exit || save_at.is_some_and(|at| Instant::now() >= at)) && win_state.valid() {
            save_at = None;
            if let Err(error) = write_json(&dir.join("window.json"), &win_state) {
                log(&dir, started, &format!("window_save_failed {error}"));
            }
        }
        *control_flow = match (exit, save_at) {
            (true, _) => ControlFlow::Exit,
            (false, Some(at)) => ControlFlow::WaitUntil(at),
            (false, None) => ControlFlow::Wait,
        };
    });
}
