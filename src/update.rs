#[cfg(windows)]
mod imp {
    //! Updates from GitHub releases: at most one check a day, and an install only when the user
    //! asks. The downloaded golow.exe must match the SHA-256 published beside it before it
    //! replaces anything, and the running build is kept as golow.previous.exe.
    use crate::http;
    use serde_json::Value;
    use std::{fs, path::PathBuf};
    use url::Url;
    use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};

    const LATEST: &str = "https://api.github.com/repos/Alx8g/golow/releases/latest";

    #[derive(Debug, Clone)]
    pub struct Release {
        pub version: String,
        pub page: String,
        exe: Url,
        sha: Url,
    }

    fn numbers(version: &str) -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split(['.', '-'])
            .map_while(|part| part.parse().ok())
            .collect()
    }

    /// Whether `tag` is a later version than `current`, comparing numbers, not text.
    pub fn newer(current: &str, tag: &str) -> bool {
        let (current, tag) = (numbers(current), numbers(tag));
        !tag.is_empty() && tag > current
    }

    pub fn parse(json: &Value) -> Option<Release> {
        let asset = |name: &str| {
            json["assets"].as_array()?.iter().find(|a| a["name"] == name)?["browser_download_url"]
                .as_str()
                .and_then(|url| Url::parse(url).ok())
                .filter(|url| url.scheme() == "https" && url.host_str() == Some("github.com"))
        };
        Some(Release {
            version: json["tag_name"].as_str()?.trim_start_matches('v').to_owned(),
            page: json["html_url"].as_str().unwrap_or_default().to_owned(),
            exe: asset("golow.exe")?,
            sha: asset("golow.exe.sha256")?,
        })
    }

    /// The latest release, if it is newer than this build.
    pub fn check() -> Option<Release> {
        parse(&http::get_json(&Url::parse(LATEST).ok()?)?)
            .filter(|r| newer(env!("CARGO_PKG_VERSION"), &r.version))
    }

    fn sha256(bytes: &[u8]) -> String {
        let mut digest = [0u8; 32];
        let _ = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, bytes, &mut digest) };
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn download(url: &Url, limit: usize) -> Result<Vec<u8>, String> {
        let response = http::request("GET", url, "", &[], limit).ok_or("download failed")?;
        if response.status != 200 {
            return Err(format!("download answered {}", response.status));
        }
        Ok(response.body)
    }

    /// Downloads, verifies and swaps in the new build. Takes effect on the next start.
    pub fn install(release: &Release) -> Result<PathBuf, String> {
        let expected =
            String::from_utf8(download(&release.sha, 4096)?).map_err(|_| "bad checksum file")?;
        let expected = expected.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
        let exe = download(&release.exe, 64 * 1024 * 1024)?;
        if expected.len() != 64 || sha256(&exe) != expected {
            return Err("the download did not match its published checksum".into());
        }
        let current = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = current.parent().ok_or("no install folder")?;
        let (fresh, previous) = (dir.join("golow.update.exe"), dir.join("golow.previous.exe"));
        fs::write(&fresh, &exe).map_err(|e| format!("cannot write to {}: {e}", dir.display()))?;
        let _ = fs::remove_file(&previous);
        // Windows lets a running program be renamed, not overwritten.
        fs::rename(&current, &previous).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&fresh, &current) {
            let _ = fs::rename(&previous, &current);
            return Err(error.to_string());
        }
        Ok(current)
    }

    /// Starts the installed build once this process has exited.
    fn relaunch_command(exe: &PathBuf, profile: &str) -> std::process::Command {
        let mut command = std::process::Command::new(exe);
        command.args(["--after", &std::process::id().to_string()]);
        if !profile.is_empty() {
            command.args(["--profile", profile]);
        }
        command
    }

    pub fn relaunch(exe: &PathBuf, profile: &str) -> bool {
        relaunch_command(exe, profile).spawn().is_ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn restart_keeps_named_profiles_as_one_argument() {
            let exe = PathBuf::from("golow.exe");
            for profile in ["", "Work", "dj sets"] {
                let command = relaunch_command(&exe, profile);
                let args: Vec<_> = command.get_args().map(|arg| arg.to_str().unwrap()).collect();
                assert_eq!(&args[..2], ["--after", &std::process::id().to_string()]);
                if profile.is_empty() {
                    assert_eq!(args.len(), 2);
                } else {
                    assert_eq!(&args[2..], ["--profile", profile]);
                }
            }
        }

        #[test]
        fn compares_versions_by_number() {
            assert!(newer("0.2.0", "v0.3.0"));
            assert!(newer("0.9.0", "0.10.0"));
            assert!(!newer("0.3.0", "v0.3.0"));
            assert!(!newer("0.3.0", "0.2.9"));
            assert!(!newer("0.3.0", "nightly"));
        }

        #[test]
        fn needs_both_assets_from_github() {
            let release = |exe: &str| {
                json!({"tag_name": "v0.3.0", "html_url": "https://github.com/Alx8g/golow/releases/tag/v0.3.0", "assets": [
                {"name": "golow.exe", "browser_download_url": exe},
                {"name": "golow.exe.sha256", "browser_download_url": "https://github.com/Alx8g/golow/releases/download/v0.3.0/golow.exe.sha256"}]})
            };
            assert_eq!(
                parse(&release(
                    "https://github.com/Alx8g/golow/releases/download/v0.3.0/golow.exe"
                ))
                .unwrap()
                .version,
                "0.3.0"
            );
            assert!(parse(&release("https://evil.example/golow.exe")).is_none());
            assert!(parse(&json!({"tag_name": "v0.3.0", "assets": []})).is_none());
            assert_eq!(
                sha256(b"abc"),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
        }
    }
}
#[cfg(windows)]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    //! Updates from GitHub releases. A release carries `golow-macos.zip` and
    //! `golow-macos.zip.sha256`; the app only installs after the archive matches that checksum.
    use crate::http;
    use serde_json::Value;
    use std::{fs, io::Write, path::PathBuf, process::Stdio};
    use url::Url;

    const LATEST: &str = "https://api.github.com/repos/Alx8g/golow/releases/latest";

    #[derive(Debug, Clone)]
    pub struct Release {
        pub version: String,
        pub page: String,
        zip: Url,
        sha: Url,
    }

    fn numbers(version: &str) -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split(['.', '-'])
            .map_while(|part| part.parse().ok())
            .collect()
    }

    /// Whether `tag` is a later version than `current`, comparing numbers, not text.
    pub fn newer(current: &str, tag: &str) -> bool {
        let (current, tag) = (numbers(current), numbers(tag));
        !tag.is_empty() && tag > current
    }

    pub fn parse(json: &Value) -> Option<Release> {
        let asset = |name: &str| {
            json["assets"].as_array()?.iter().find(|a| a["name"] == name)?["browser_download_url"]
                .as_str()
                .and_then(|url| Url::parse(url).ok())
                .filter(|url| url.scheme() == "https" && url.host_str() == Some("github.com"))
        };
        Some(Release {
            version: json["tag_name"].as_str()?.trim_start_matches('v').to_owned(),
            page: json["html_url"].as_str().unwrap_or_default().to_owned(),
            zip: asset("golow-macos.zip")?,
            sha: asset("golow-macos.zip.sha256")?,
        })
    }

    /// The latest release, if it is newer than this build.
    pub fn check() -> Option<Release> {
        parse(&http::get_json(&Url::parse(LATEST).ok()?)?)
            .filter(|r| newer(env!("CARGO_PKG_VERSION"), &r.version))
    }

    fn sha256(bytes: &[u8]) -> Result<String, String> {
        let mut child = std::process::Command::new("shasum")
            .args(["-a", "256"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child.stdin.as_mut().ok_or("no shasum input")?.write_all(bytes).map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("shasum failed".into());
        }
        Ok(String::from_utf8_lossy(&output.stdout).split_whitespace().next().unwrap_or_default().to_owned())
    }

    fn download(url: &Url, limit: usize) -> Result<Vec<u8>, String> {
        let response = http::request("GET", url, "", &[], limit).ok_or("download failed")?;
        if response.status != 200 {
            return Err(format!("download answered {}", response.status));
        }
        Ok(response.body)
    }

    fn bundle() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        exe.ancestors()
            .find(|path| path.extension().is_some_and(|ext| ext == "app"))
            .map(|path| path.to_path_buf())
            .ok_or_else(|| "GoLow is not running from an app bundle".into())
    }

    /// Downloads, verifies, unpacks and swaps in the new bundle. Takes effect on the next start.
    pub fn install(release: &Release) -> Result<PathBuf, String> {
        let expected = String::from_utf8(download(&release.sha, 4096)?).map_err(|_| "bad checksum file")?;
        let expected = expected.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
        let zip = download(&release.zip, 192 * 1024 * 1024)?;
        if expected.len() != 64 || sha256(&zip)? != expected {
            return Err("the download did not match its published checksum".into());
        }
        let app = bundle()?;
        let parent = app.parent().ok_or("no install folder")?.to_path_buf();
        let stage = std::env::temp_dir().join(format!("golow-update-{}-{}", std::process::id(), release.version));
        let _ = fs::remove_dir_all(&stage);
        fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
        let archive = stage.join("golow-macos.zip");
        fs::write(&archive, &zip).map_err(|e| e.to_string())?;
        let unpacked = std::process::Command::new("ditto")
            .arg("-x").arg("-k").arg(&archive).arg(&stage)
            .status()
            .map_err(|e| e.to_string())?;
        if !unpacked.success() {
            let _ = fs::remove_dir_all(&stage);
            return Err("the downloaded app archive did not unpack".into());
        }
        let fresh = stage.join("GoLow.app");
        let fresh_exe = fresh.join("Contents/MacOS/GoLow");
        if !fresh_exe.is_file() {
            let _ = fs::remove_dir_all(&stage);
            return Err("the archive did not contain GoLow.app".into());
        }
        let previous = parent.join("GoLow.previous.app");
        let _ = fs::remove_dir_all(&previous);
        fs::rename(&app, &previous).map_err(|e| format!("cannot move the current app aside: {e}"))?;
        if let Err(error) = fs::rename(&fresh, &app) {
            let _ = fs::rename(&previous, &app);
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("cannot install the new app: {error}"));
        }
        let _ = fs::remove_dir_all(&stage);
        Ok(app.join("Contents/MacOS/GoLow"))
    }

    /// Starts the installed build once this process has exited.
    fn relaunch_command(exe: &PathBuf, profile: &str) -> std::process::Command {
        let mut command = std::process::Command::new(exe);
        command.args(["--after", &std::process::id().to_string()]);
        if !profile.is_empty() {
            command.args(["--profile", profile]);
        }
        command
    }

    pub fn relaunch(exe: &PathBuf, profile: &str) -> bool {
        relaunch_command(exe, profile).spawn().is_ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn compares_versions_by_number() {
            assert!(newer("0.2.0", "v0.3.0"));
            assert!(newer("0.9.0", "0.10.0"));
            assert!(!newer("0.3.0", "v0.3.0"));
            assert!(!newer("0.3.0", "0.2.9"));
            assert!(!newer("0.3.0", "nightly"));
        }

        #[test]
        fn needs_both_macos_assets_from_github() {
            let release = |zip: &str| {
                json!({"tag_name": "v0.3.0", "html_url": "https://github.com/Alx8g/golow/releases/tag/v0.3.0", "assets": [
                {"name": "golow-macos.zip", "browser_download_url": zip},
                {"name": "golow-macos.zip.sha256", "browser_download_url": "https://github.com/Alx8g/golow/releases/download/v0.3.0/golow-macos.zip.sha256"}]})
            };
            assert_eq!(parse(&release("https://github.com/Alx8g/golow/releases/download/v0.3.0/golow-macos.zip")).unwrap().version, "0.3.0");
            assert!(parse(&release("https://evil.example/golow-macos.zip")).is_none());
            assert!(parse(&json!({"tag_name": "v0.3.0", "assets": []})).is_none());
            assert_eq!(sha256(b"abc").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        }
    }
}
#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    #![allow(dead_code)]

    use serde_json::Value;
    use std::path::PathBuf;
    use url::Url;
    #[derive(Debug, Clone)]
    pub struct Release {
        pub version: String,
        pub page: String,
        exe: Url,
        sha: Url,
    }
    fn numbers(version: &str) -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split(['.', '-'])
            .map_while(|part| part.parse().ok())
            .collect()
    }
    pub fn newer(current: &str, tag: &str) -> bool {
        let (current, tag) = (numbers(current), numbers(tag));
        !tag.is_empty() && tag > current
    }
    pub fn parse(json: &Value) -> Option<Release> {
        let asset = |name: &str| {
            json["assets"].as_array()?.iter().find(|a| a["name"] == name)?["browser_download_url"]
                .as_str()
                .and_then(|url| Url::parse(url).ok())
                .filter(|url| url.scheme() == "https" && url.host_str() == Some("github.com"))
        };
        Some(Release {
            version: json["tag_name"].as_str()?.trim_start_matches('v').to_owned(),
            page: json["html_url"].as_str().unwrap_or_default().to_owned(),
            exe: asset("golow.exe")?,
            sha: asset("golow.exe.sha256")?,
        })
    }
    pub fn check() -> Option<Release> {
        None
    }
    pub fn install(_release: &Release) -> Result<PathBuf, String> {
        Err("in-app updates are unsupported on this platform".into())
    }
    pub fn relaunch(_exe: &PathBuf, _profile: &str) -> bool {
        false
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use imp::*;
