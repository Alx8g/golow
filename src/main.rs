#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod instance;
mod policy;
mod settings;

use settings::{DeferredSave, Settings, WindowState};
use std::{
    cell::RefCell,
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
    time::Instant,
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Icon, Window, WindowBuilder, WindowId},
};
use wry::{
    MemoryUsageLevel, NewWindowResponse, PageLoadEvent, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

#[derive(Clone, Debug)]
enum Action {
    Settings(Settings),
    Status,
    PageLoaded,
    ClosePopup(WindowId),
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Settings { value: Settings },
    Status,
}

struct Popup {
    _view: WebView,
    window: Window,
}

fn app_dir() -> PathBuf {
    // Keep the existing profile in place. Moving it would risk sign-in and DRM state.
    std::env::var_os("SOUNDCLOUD_PROFILE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .expect("Windows app data directory unavailable")
                .join("soundcloud-go-client")
        })
}

fn log(dir: &Path, started: Instant, message: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup.log"))
    {
        let _ = writeln!(file, "t={:.2}s {message}", started.elapsed().as_secs_f32());
    }
}

fn load_icon() -> Option<Icon> {
    let img = image::load_from_memory(include_bytes!("../assets/icon.png"))
        .ok()?
        .to_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).ok()
}

fn cache_size(dir: &Path) -> u64 {
    fn size(path: &Path) -> u64 {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| {
                let Ok(kind) = entry.file_type() else {
                    return 0;
                };
                if kind.is_symlink() {
                    return 0;
                }
                if kind.is_dir() {
                    size(&entry.path())
                } else {
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                }
            })
            .sum()
    }
    let profile = dir.join("webview/EBWebView/Default");
    size(&profile.join("Cache")) + size(&profile.join("Code Cache"))
}

fn set_background(view: &WebView, hidden: bool, efficiency: bool) {
    let level = if hidden && efficiency {
        MemoryUsageLevel::Low
    } else {
        MemoryUsageLevel::Normal
    };
    let _ = view.set_memory_usage_level(level);
    let _ = view.set_visible(!hidden);
    let _ = view.evaluate_script(&format!("window.__scClient?.setNativeHidden({hidden});"));
}

fn apply_window(
    window: &Window,
    settings: &Settings,
    previous: &Settings,
    normal: &mut PhysicalSize<u32>,
) {
    window.set_always_on_top(settings.always_on_top);
    if settings.compact != previous.compact {
        if settings.compact {
            if !window.is_minimized() {
                *normal = window.inner_size();
            }
            window.set_min_inner_size(Some(LogicalSize::new(360.0, 160.0)));
            window.set_inner_size(LogicalSize::new(560.0, 260.0));
        } else {
            window.set_min_inner_size(Some(LogicalSize::new(360.0, 600.0)));
            window.set_inner_size(*normal);
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let dir = app_dir();
    std::fs::create_dir_all(&dir)?;
    let Some(instance) = instance::Instance::acquire(&dir)? else {
        return Ok(());
    };
    // Bounded to the current launch, with no visited URLs or authentication tokens.
    std::fs::write(
        dir.join("startup.log"),
        format!("SoundCloud Go+ {}\n", env!("CARGO_PKG_VERSION")),
    )?;
    let mut prefs: Settings = settings::read_json(&dir.join("settings.json")).unwrap_or_default();
    let stored: Option<WindowState> = settings::read_json(&dir.join("window.json"));
    let stored = stored.filter(WindowState::valid);
    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let target = (*event_loop).clone();
    let proxy = event_loop.create_proxy();
    log(&dir, started, "event_loop_ready");

    let mut builder = WindowBuilder::new()
        .with_title("SoundCloud Go+")
        .with_min_inner_size(LogicalSize::new(
            360.0,
            if prefs.compact { 160.0 } else { 600.0 },
        ));
    if let Some(state) = stored {
        builder = builder.with_inner_size(PhysicalSize::new(state.w, state.h));
        let on_screen = event_loop.available_monitors().any(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            state.x < pos.x + size.width as i32
                && state.y < pos.y + size.height as i32
                && state.x + state.w as i32 > pos.x
                && state.y + 40 > pos.y
        });
        if on_screen {
            builder = builder.with_position(PhysicalPosition::new(state.x, state.y));
        }
    } else {
        builder = builder.with_inner_size(LogicalSize::new(1280.0, 800.0));
    }
    if let Some(icon) = load_icon() {
        builder = builder.with_window_icon(Some(icon));
    }
    let window = builder.build(&event_loop)?;
    log(&dir, started, "window_built");
    let mut normal_size = window.inner_size();
    let position = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(100, 100));
    let mut win_state = WindowState {
        x: position.x,
        y: position.y,
        w: normal_size.width,
        h: normal_size.height,
    };
    let initial = Settings {
        compact: false,
        ..prefs.clone()
    };
    apply_window(&window, &prefs, &initial, &mut normal_size);

    let mut context = WebContext::new(Some(dir.join("webview")));
    let script = format!(
        "window.__scInitialSettings={};\n{}",
        serde_json::to_string(&prefs)?,
        include_str!("client.js")
    );
    let popups: Rc<RefCell<Vec<Popup>>> = Rc::new(RefCell::new(Vec::new()));
    let popup_store = popups.clone();
    let popup_proxy = proxy.clone();
    let ipc_proxy = proxy.clone();
    let log_dir = dir.clone();
    let load_proxy = proxy.clone();
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_url("https://soundcloud.com/discover")
        .with_initialization_script(&script)
        .with_background_color((11, 11, 12, 255))
        .with_devtools(cfg!(debug_assertions))
        // Explicit empty arguments avoids Wry's default SmartScreen-disabling flag.
        // Standard Chromium background throttling and GPU acceleration remain enabled.
        .with_additional_browser_args("")
        .with_navigation_handler(|url| policy::navigation_allowed(&url))
        .with_ipc_handler(move |request| {
            if request.body().len() > 4096 || !policy::soundcloud_page(&request.uri().to_string()) {
                return;
            }
            let action = match serde_json::from_str::<Message>(request.body()) {
                Ok(Message::Settings { value }) => Action::Settings(value),
                Ok(Message::Status) => Action::Status,
                Err(_) => return,
            };
            let _ = ipc_proxy.send_event(action);
        })
        .with_new_window_req_handler(move |url, features| {
            if !policy::popup_allowed(&url) || popup_store.borrow().len() >= 3 {
                return NewWindowResponse::Deny;
            }
            let Ok(popup) = WindowBuilder::new()
                .with_title("SoundCloud sign in")
                .with_inner_size(LogicalSize::new(600.0, 740.0))
                .build(&target)
            else {
                return NewWindowResponse::Deny;
            };
            let id = popup.id();
            let close_proxy = popup_proxy.clone();
            let result = WebViewBuilder::new()
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
                .build(&popup);
            let Ok(popup_view) = result else {
                return NewWindowResponse::Deny;
            };
            let native = popup_view.webview();
            popup_store.borrow_mut().push(Popup {
                _view: popup_view,
                window: popup,
            });
            NewWindowResponse::Create { webview: native }
        })
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(Action::PageLoaded);
            }
            log(
                &log_dir,
                started,
                match event {
                    PageLoadEvent::Started => "page_started",
                    PageLoadEvent::Finished => "page_finished",
                },
            );
        })
        .build(&window)?;
    log(&dir, started, "webview_built");
    let mut deferred = DeferredSave::default();
    let mut minimized = false;

    event_loop.run(move |event, _, control_flow| {
        let _keep_alive = &instance;
        let mut exit = false;
        match event {
            Event::UserEvent(Action::ClosePopup(id)) => popups.borrow_mut().retain(|popup| popup.window.id() != id),
            Event::UserEvent(Action::PageLoaded) => {
                if let Ok(json) = serde_json::to_string(&prefs) {
                    let _ = view.evaluate_script(&format!("window.__scClient?.update({json});"));
                }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::UserEvent(Action::Status) => {
                let status = serde_json::json!({"cache_mib":cache_size(&dir) as f64 / 1_048_576.0,"low_memory":minimized && prefs.efficiency});
                let _ = view.evaluate_script(&format!("window.__scClient?.status({status});"));
            }
            Event::UserEvent(Action::Settings(next)) => {
                apply_window(&window, &next, &prefs, &mut normal_size);
                prefs = next;
                if let Err(error) = settings::write_json(&dir.join("settings.json"), &prefs) { log(&dir, started, &format!("settings_save_failed {error}")); }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::WindowEvent { window_id, event, .. } if window_id == window.id() => match event {
                WindowEvent::CloseRequested => { exit = true; }
                WindowEvent::Resized(size) => {
                    let hidden = window.is_minimized() || size.width == 0 || size.height == 0;
                    if hidden != minimized { minimized = hidden; set_background(&view, minimized, prefs.efficiency); }
                    if !hidden && !window.is_maximized() && !prefs.compact {
                        win_state.w = size.width; win_state.h = size.height; normal_size = size;
                        deferred.mark(Instant::now());
                    }
                }
                WindowEvent::Moved(pos) if !window.is_minimized() && !window.is_maximized() => {
                    win_state.x = pos.x; win_state.y = pos.y; deferred.mark(Instant::now());
                }
                _ => {}
            },
            Event::WindowEvent { window_id, event:WindowEvent::CloseRequested, .. } => {
                popups.borrow_mut().retain(|popup| popup.window.id() != window_id);
            }
            _ => {}
        }
        if (exit || deferred.take_if_due(Instant::now())) && win_state.valid() {
            if let Err(error) = settings::write_json(&dir.join("window.json"), &win_state) { log(&dir, started, &format!("window_save_failed {error}")); }
        }
        *control_flow = if exit { ControlFlow::Exit }
            else if let Some(deadline) = deferred.deadline() { ControlFlow::WaitUntil(deadline) }
            else { ControlFlow::Wait };
    });
}
