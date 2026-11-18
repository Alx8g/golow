//! Hands links and folders to Windows: the default browser and File Explorer.
use url::Url;
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn open(target: &str) -> bool {
    let (verb, target) = (wide("open"), wide(target));
    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute reports success as a value above 32.
    code as usize > 32
}

/// Opens an https link in the default browser. Callers validate the URL first.
pub fn open_url(url: &Url) -> bool {
    url.scheme() == "https" && open(url.as_str())
}

pub fn open_folder(path: &std::path::Path) -> bool {
    path.is_dir() && open(&path.to_string_lossy())
}

/// Opens File Explorer with `path` selected.
pub fn reveal(path: &std::path::Path) -> bool {
    let (verb, explorer) = (wide("open"), wide("explorer.exe"));
    let select = wide(&format!("/select,\"{}\"", path.display()));
    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            explorer.as_ptr(),
            select.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    code as usize > 32
}
