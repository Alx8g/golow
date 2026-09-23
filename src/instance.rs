use std::{
    hash::{Hash, Hasher},
    io,
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
    System::Threading::CreateMutexW,
    UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE},
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub struct Instance(HANDLE);
impl Instance {
    pub fn acquire(profile: &Path) -> io::Result<Option<Self>> {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        profile.to_string_lossy().to_lowercase().hash(&mut hash);
        let name = wide(&format!("Local\\SoundCloudGoPlus-{:016x}", hash.finish()));
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(handle);
                let title = wide("SoundCloud Go+");
                let window = FindWindowW(std::ptr::null(), title.as_ptr());
                if !window.is_null() {
                    ShowWindow(window, SW_RESTORE);
                    SetForegroundWindow(window);
                }
                return Ok(None);
            }
            Ok(Some(Self(handle)))
        }
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
