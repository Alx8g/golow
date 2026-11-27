//! Hands links and folders to the operating system: the default browser and file manager.
use url::Url;

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub fn open(target: &str) -> bool {
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
        code as usize > 32
    }

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
}

#[cfg(not(windows))]
mod imp {
    fn run(mut command: std::process::Command) -> bool {
        command.spawn().is_ok()
    }

    pub fn open(target: &str) -> bool {
        let mut command = std::process::Command::new("open");
        command.arg(target);
        run(command)
    }

    pub fn reveal(path: &std::path::Path) -> bool {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        run(command)
    }
}

/// Opens an https link in the default browser. Callers validate the URL first.
pub fn open_url(url: &Url) -> bool {
    url.scheme() == "https" && imp::open(url.as_str())
}

pub fn open_folder(path: &std::path::Path) -> bool {
    path.is_dir() && imp::open(&path.to_string_lossy())
}

/// Opens the file manager with `path` selected.
pub fn reveal(path: &std::path::Path) -> bool {
    imp::reveal(path)
}
