#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod filter;
mod instance;
mod policy;
mod settings;

use settings::{read_json, write_json, Settings, WindowState};
use std::{
    cell::{Cell, RefCell},
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
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

pub const APP_NAME: &str = env!("APP_NAME");
const SAVE_DELAY: Duration = Duration::from_millis(350);

#[derive(Clone, Debug)]
enum Action {
    Settings(Settings),
    PageLoaded,
    ClosePopup(WindowId),
}

struct Popup {
    _view: WebView,
    window: Window,
}

fn app_dir() -> PathBuf {
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
    let _ = view.evaluate_script(&format!("window.__scClient?.setNativeHidden({hidden});"));
}

fn apply_window(
    window: &Window,
    next: Settings,
    previous: Settings,
    normal: &mut PhysicalSize<u32>,
) {
    window.set_always_on_top(next.always_on_top);
    if next.compact != previous.compact {
        if next.compact {
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
    std::fs::write(dir.join("startup.log"), format!("{APP_NAME} {}\n", env!("CARGO_PKG_VERSION")))?;
    let mut prefs: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let target = (*event_loop).clone();
    let proxy = event_loop.create_proxy();

    let mut builder = WindowBuilder::new()
        .with_title(APP_NAME)
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(360.0, 600.0));
    if let Some(state) =
        read_json::<WindowState>(&dir.join("window.json")).filter(WindowState::valid)
    {
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
    log(&dir, started, "window_built");
    let mut normal_size = window.inner_size();
    let position = window.outer_position().unwrap_or(PhysicalPosition::new(100, 100));
    let mut win_state =
        WindowState { x: position.x, y: position.y, w: normal_size.width, h: normal_size.height };
    apply_window(&window, prefs, Settings { compact: false, ..prefs }, &mut normal_size);

    let mut context = WebContext::new(Some(dir.join("webview")));
    let script = format!(
        "window.__scInitialSettings={};\n{}",
        serde_json::to_string(&prefs)?,
        include_str!("client.js")
    );
    let popups: Rc<RefCell<Vec<Popup>>> = Rc::default();
    let (popup_store, ipc_proxy, load_proxy, log_dir) =
        (popups.clone(), proxy.clone(), proxy.clone(), dir.clone());
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_initialization_script(&script)
        .with_background_color((11, 11, 12, 255))
        .with_devtools(cfg!(debug_assertions))
        // Explicit empty arguments avoid Wry's default SmartScreen-disabling flag.
        // Standard Chromium background throttling and GPU acceleration remain enabled.
        .with_additional_browser_args("")
        .with_navigation_handler(|url| policy::navigation_allowed(&url))
        .with_ipc_handler(move |request| {
            if request.body().len() <= 4096 && policy::soundcloud_page(&request.uri().to_string()) {
                if let Ok(next) = serde_json::from_str(request.body()) {
                    let _ = ipc_proxy.send_event(Action::Settings(next));
                }
            }
        })
        .with_new_window_req_handler(move |url, features| {
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
            let (id, close_proxy) = (window.id(), proxy.clone());
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
    let filter_prefs = Rc::new(Cell::new(prefs));
    if let Err(error) = filter::install(&view, filter_prefs.clone()) {
        log(&dir, started, &format!("optional_resource_filter_unavailable {error}"));
    }
    view.load_url("https://soundcloud.com/discover")?;
    let (mut save_at, mut minimized) = (None::<Instant>, false);

    event_loop.run(move |event, _, control_flow| {
        let _keep_alive = &instance;
        let mut exit = false;
        match event {
            Event::UserEvent(Action::ClosePopup(id)) => {
                popups.borrow_mut().retain(|p| p.window.id() != id)
            }
            Event::UserEvent(Action::PageLoaded) => {
                if let Ok(json) = serde_json::to_string(&prefs) {
                    let _ = view.evaluate_script(&format!("window.__scClient?.update({json});"));
                }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::UserEvent(Action::Settings(next)) => {
                apply_window(&window, next, prefs, &mut normal_size);
                prefs = next;
                filter_prefs.set(prefs);
                if let Err(error) = write_json(&dir.join("settings.json"), &prefs) {
                    log(&dir, started, &format!("settings_save_failed {error}"));
                }
                set_background(&view, minimized, prefs.efficiency);
            }
            Event::WindowEvent { window_id, event, .. } if window_id == window.id() => {
                match event {
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
        // Window-state writes wait for a pause in move/resize storms, and happen on close.
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
