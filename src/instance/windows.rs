use crate::APP_NAME;
use std::{io, path::Path};
use windows_sys::{
    core::BOOL,
    Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{
            AllowSetForegroundWindow, EnumWindows, GetPropW, PostMessageW, RegisterWindowMessageW,
            SetPropW, ASFW_ANY,
        },
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// FNV-1a. Unlike std's DefaultHasher, the result never changes between Rust
/// releases, so builds from different toolchains still share one lock name.
fn profile_key(profile: &Path) -> u64 {
    profile.to_string_lossy().to_lowercase().bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Posted to the running window by a second launch; it shows and focuses itself,
/// including when it is hidden in the tray.
pub fn show_message() -> u32 {
    unsafe { RegisterWindowMessageW(wide(&format!("{APP_NAME}.Show")).as_ptr()) }
}

unsafe extern "system" fn signal(window: HWND, key: LPARAM) -> BOOL {
    if GetPropW(window, wide(APP_NAME).as_ptr()) as usize == key as usize {
        PostMessageW(window, show_message(), 0, 0);
        return 0;
    }
    1
}

pub struct Instance(HANDLE, u64);
impl Instance {
    pub fn acquire(profile: &Path) -> io::Result<Option<Self>> {
        let key = profile_key(profile);
        let name = wide(&format!("Local\\{APP_NAME}-{key:016x}"));
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(handle);
                // The title follows the playing track, so find the window by its profile tag.
                AllowSetForegroundWindow(ASFW_ANY);
                EnumWindows(Some(signal), key as LPARAM);
                return Ok(None);
            }
            Ok(Some(Self(handle, key)))
        }
    }

    /// Tags the main window so a second launch with the same profile can find it.
    pub fn mark(&self, window: isize) {
        unsafe { SetPropW(window as HWND, wide(APP_NAME).as_ptr(), self.1 as usize as HANDLE) };
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
