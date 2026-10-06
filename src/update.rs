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
    version.trim_start_matches('v').split(['.', '-']).map_while(|part| part.parse().ok()).collect()
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
pub fn relaunch(exe: &PathBuf) -> bool {
    std::process::Command::new(exe)
        .args(["--after", &std::process::id().to_string()])
        .spawn()
        .is_ok()
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
    fn needs_both_assets_from_github() {
        let release = |exe: &str| {
            json!({"tag_name": "v0.3.0", "html_url": "https://github.com/Alx8g/golow/releases/tag/v0.3.0", "assets": [
                {"name": "golow.exe", "browser_download_url": exe},
                {"name": "golow.exe.sha256", "browser_download_url": "https://github.com/Alx8g/golow/releases/download/v0.3.0/golow.exe.sha256"}]})
        };
        assert_eq!(
            parse(&release("https://github.com/Alx8g/golow/releases/download/v0.3.0/golow.exe"))
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
