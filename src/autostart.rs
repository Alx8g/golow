#[cfg(windows)]
mod imp {
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
                let result =
                    RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value_name.as_ptr());
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
}
#[cfg(windows)]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    //! Start-at-login through a per-user LaunchAgent. The agent starts GoLow hidden in the
    //! menu bar; it is created only when the user turns the setting on.
    use std::{path::{Path, PathBuf}, process::Command};

    fn escaped(text: &str) -> String {
        text.chars()
            .map(|c| match c {
                '&' => "&amp;".into(),
                '<' => "&lt;".into(),
                '>' => "&gt;".into(),
                '"' => "&quot;".into(),
                '\'' => "&apos;".into(),
                c => c.to_string(),
            })
            .collect()
    }

    /// One label per account, using launchd-safe characters.
    pub fn label(profile: &str) -> String {
        let suffix: String = profile
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || "-_".contains(c) { c } else { '-' })
            .collect();
        if suffix.is_empty() {
            "com.alx8g.golow".into()
        } else {
            format!("com.alx8g.golow.{suffix}")
        }
    }

    fn plist_path(profile: &str) -> Option<PathBuf> {
        Some(
            dirs::home_dir()?
                .join("Library/LaunchAgents")
                .join(format!("{}.plist", label(profile))),
        )
    }

    fn plist(exe: &Path, profile: &str) -> String {
        let mut arguments = format!("    <string>{}</string>\n    <string>--background</string>\n", escaped(&exe.to_string_lossy()));
        if !profile.is_empty() {
            arguments += &format!("    <string>--profile</string>\n    <string>{}</string>\n", escaped(profile));
        }
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
{}  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
            escaped(&label(profile)),
            arguments
        )
    }

    fn uid() -> Option<String> {
        let output = Command::new("/usr/bin/id").arg("-u").output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn bootout(path: &Path, profile: &str) {
        if let Some(uid) = uid() {
            let _ = Command::new("/bin/launchctl")
                .args(["bootout", &format!("gui/{uid}/{}", label(profile))])
                .output();
        }
        // Legacy form covers older macOS releases and any service loaded by path.
        let _ = Command::new("/bin/launchctl").arg("unload").arg(path).output();
    }

    pub fn set(on: bool, profile: &str) -> bool {
        let Some(path) = plist_path(profile) else { return false };
        if !on {
            bootout(&path, profile);
            return std::fs::remove_file(&path).is_ok() || !path.exists();
        }
        let Ok(exe) = std::env::current_exe() else { return false };
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return false;
            }
        }
        if std::fs::write(&path, plist(&exe, profile)).is_err() {
            return false;
        }
        bootout(&path, profile);
        let bootstrapped = uid().is_some_and(|uid| {
            Command::new("/bin/launchctl")
                .args(["bootstrap", &format!("gui/{uid}")])
                .arg(&path)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        });
        bootstrapped
            || Command::new("/bin/launchctl")
                .arg("load")
                .arg(&path)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn plist_starts_hidden_and_keeps_the_account() {
            let exe = Path::new("/Users/x/Applications/GoLow.app/Contents/MacOS/GoLow");
            let xml = plist(exe, "dj sets");
            assert!(xml.contains("<string>/Users/x/Applications/GoLow.app/Contents/MacOS/GoLow</string>"));
            assert!(xml.contains("<string>--background</string>"));
            assert!(xml.contains("<string>--profile</string>"));
            assert!(xml.contains("<string>dj sets</string>"));
            assert!(xml.contains("<string>com.alx8g.golow.dj-sets</string>"));
        }

        #[test]
        fn plist_text_is_xml_escaped() {
            let xml = plist(Path::new("/tmp/A&B.app/Contents/MacOS/GoLow"), "");
            assert!(xml.contains("A&amp;B.app"));
        }
    }
}
#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    #![allow(dead_code)]

    pub fn set(_on: bool, _profile: &str) -> bool {
        false
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use imp::*;
