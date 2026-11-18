//! Window messages tao does not surface: hotkeys, taskbar thumbnail buttons, and the
//! announcement that the taskbar button exists. Some arrive sent rather than posted, so they
//! never pass the event loop's message hook; a window subclass sees both.
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, SetWindowSubclass},
        WindowsAndMessaging::{RegisterWindowMessageW, WM_COMMAND, WM_HOTKEY},
    },
};

const THBN_CLICKED: usize = 0x1800;

pub enum Native {
    Hotkey(usize),
    Thumb(u32),
    TaskbarReady,
}

type Handler = Box<dyn Fn(Native)>;

fn taskbar_created() -> u32 {
    let name: Vec<u16> = "TaskbarButtonCreated".encode_utf16().chain(Some(0)).collect();
    unsafe { RegisterWindowMessageW(name.as_ptr()) }
}

unsafe extern "system" fn proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    data: usize,
) -> LRESULT {
    let handler = &*(data as *const Handler);
    match message {
        WM_HOTKEY => handler(Native::Hotkey(wparam)),
        WM_COMMAND if wparam >> 16 == THBN_CLICKED => {
            handler(Native::Thumb((wparam & 0xFFFF) as u32))
        }
        _ if message == taskbar_created() => handler(Native::TaskbarReady),
        _ => {}
    }
    DefSubclassProc(window, message, wparam, lparam)
}

/// Routes the messages above to `handler` for the life of the window.
pub fn subclass(window: isize, handler: impl Fn(Native) + 'static) -> bool {
    // Leaked on purpose: the subclass lives as long as the main window, which is the process.
    let data = Box::into_raw(Box::new(Box::new(handler) as Handler)) as usize;
    unsafe { SetWindowSubclass(window as HWND, Some(proc), 1, data) != 0 }
}
