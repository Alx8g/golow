use url::Url;

const HOSTS: &[&str] = &[
    "soundcloud.com",
    "www.soundcloud.com",
    "secure.soundcloud.com",
    "api-v2.soundcloud.com",
    "accounts.google.com",
    "appleid.apple.com",
    "www.facebook.com",
    "facebook.com",
    "login.live.com",
];

pub fn trusted_https(raw: &str) -> Option<Url> {
    if raw.len() > 8192 || raw.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443))
    .then_some(url)
}

/// Checked for every top-level and popup navigation, including OAuth redirects.
/// about:blank is needed by OAuth flows that open a placeholder, then navigate.
pub fn navigation_allowed(raw: &str) -> bool {
    raw == "about:blank"
        || trusted_https(raw).is_some_and(|url| {
            let host = url.host_str().unwrap_or_default();
            HOSTS.contains(&host)
                || (host == "github.com"
                    && (url.path() == "/login" || url.path().starts_with("/login/")))
        })
}

pub fn soundcloud_page(raw: &str) -> bool {
    trusted_https(raw)
        .is_some_and(|url| matches!(url.host_str(), Some("soundcloud.com" | "www.soundcloud.com")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_soundcloud_and_login_flows() {
        let urls = "https://soundcloud.com/discover https://soundcloud.com:443/settings/streaming
            https://secure.soundcloud.com/connect?client_id=test https://accounts.google.com/o/oauth2/auth
            https://appleid.apple.com/auth/authorize https://www.facebook.com/dialog/oauth
            https://github.com/login/oauth/authorize about:blank";
        for url in urls.split_whitespace() {
            assert!(navigation_allowed(url), "{url}");
        }
    }

    #[test]
    fn rejects_lookalikes_userinfo_ports_and_unsafe_schemes() {
        let urls = r"https://soundcloud.com.example.invalid/ https://soundcloud.com@example.invalid/
            https://evil@soundcloud.com/ https://soundcloud.com:8443/ http://soundcloud.com/
            javascript:alert(1) data:text/html,test file:///C:/Windows/win.ini
            https://soundcloud.com\@example.invalid/ https://accounts.google.com.example.invalid/
            https://github.com/login-evil about:blank#evil";
        for url in urls.split_whitespace() {
            assert!(!navigation_allowed(url), "{url}");
        }
    }

    #[test]
    fn native_messages_only_from_actual_soundcloud_ui() {
        assert!(soundcloud_page("https://soundcloud.com/discover"));
        for url in ["https://accounts.google.com/", "https://soundcloud.com.example.invalid/"] {
            assert!(!soundcloud_page(url), "{url}");
        }
        assert!(!soundcloud_page("https://secure.soundcloud.com/"));
    }
}
