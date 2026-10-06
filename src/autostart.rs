//! "Start with Windows, ready in the tray": a Run entry under the user's registry that starts
//! GoLow hidden at sign-in, so opening it later is instant. Off unless the user turns it on;
//! uninstall.ps1 removes it.
use std::path::Path;
use windows_sys::Win32::System::Registry::{
    RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// One entry per account, so each profile can start on its own.
pub fn name(profile: &str) -> String {
    if profile.is_empty() {
        crate::APP_NAME.to_owned()
    } else {
        format!("{} ({profile})", crate::APP_NAME)
    }
}

pub fn command(exe: &Path, profile: &str) -> String {
    let mut command = format!("\"{}\" --background", exe.display());
    if !profile.is_empty() {
        command += &format!(" --profile \"{profile}\"");
    }
    command
}

pub fn set(on: bool, profile: &str) -> bool {
    let (key, value_name) = (wide(RUN), wide(&name(profile)));
    unsafe {
        if !on {
            let result = RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value_name.as_ptr());
            return result == 0 || result == 2; // 2: it was not there
        }
        let Ok(exe) = std::env::current_exe() else { return false };
        let value = wide(&command(&exe, profile));
        let bytes = (value.len() * 2) as u32;
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value_name.as_ptr(),
            REG_SZ,
            value.as_ptr().cast(),
            bytes,
        ) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_hidden_and_keeps_the_account() {
        let exe = Path::new(r"C:\Users\x\AppData\Local\Programs\GoLow\golow.exe");
        assert_eq!(
            command(exe, ""),
            r#""C:\Users\x\AppData\Local\Programs\GoLow\golow.exe" --background"#
        );
        assert_eq!(
            command(exe, "dj sets"),
            r#""C:\Users\x\AppData\Local\Programs\GoLow\golow.exe" --background --profile "dj sets""#
        );
        assert_eq!(name("Work"), "GoLow (Work)");
    }
}
