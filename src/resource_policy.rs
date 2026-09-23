use crate::settings::Settings;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockedResource {
    ArtistTools,
    Advertising,
}

// Exact resources observed in the live profile. Never block SoundCloud's media,
// consent UI, OAuth, fraud prevention, or the standby player frame.
pub fn blocked_resource(raw: &str, document: bool, prefs: &Settings) -> Option<BlockedResource> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    if document
        && prefs.cleanup
        && matches!(host, "soundcloud.com" | "www.soundcloud.com")
        && url.path() == "/n/embeds/credit-tracker"
    {
        return Some(BlockedResource::ArtistTools);
    }
    if prefs.efficiency
        && ((host == "www.redditstatic.com" && url.path() == "/ads/pixel.js")
            || (host == "cm.g.doubleclick.net" && url.path() == "/partnerpixels"))
    {
        return Some(BlockedResource::Advertising);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_blocks_the_observed_optional_resources() {
        let prefs = Settings::default();
        assert_eq!(
            blocked_resource(
                "https://soundcloud.com/n/embeds/credit-tracker?ref=test",
                true,
                &prefs
            ),
            Some(BlockedResource::ArtistTools)
        );
        assert_eq!(
            blocked_resource("https://www.redditstatic.com/ads/pixel.js", false, &prefs),
            Some(BlockedResource::Advertising)
        );
        assert_eq!(
            blocked_resource(
                "https://cm.g.doubleclick.net/partnerpixels?x=1",
                true,
                &prefs
            ),
            Some(BlockedResource::Advertising)
        );
    }
    #[test]
    fn playback_login_consent_and_security_are_not_blocked() {
        for url in [
            "https://soundcloud.com/n/pages/standby",
            "https://soundcloud.com/n/embeds/credit-tracker-other",
            "https://soundcloud.com/settings/streaming",
            "https://api-v2.soundcloud.com/media/test",
            "https://cf-media.sndcdn.com/test",
            "https://accounts.google.com/o/oauth2/auth",
            "https://cdn.cookielaw.org/script.js",
            "https://cadmus.script.ac/d24657ks8lvxjy/script.js",
            "https://soundcloud.com.example.invalid/n/embeds/credit-tracker",
            "https://soundcloud.com:8443/n/embeds/credit-tracker",
            "https://www.redditstatic.com/other.js",
        ] {
            assert_eq!(
                blocked_resource(url, true, &Settings::default()),
                None,
                "{url}"
            );
        }
        assert_eq!(
            blocked_resource(
                "https://soundcloud.com/n/embeds/credit-tracker",
                false,
                &Settings::default()
            ),
            None
        );
    }
    #[test]
    fn each_filter_can_be_disabled() {
        let prefs = Settings {
            cleanup: false,
            efficiency: false,
            ..Settings::default()
        };
        assert_eq!(
            blocked_resource(
                "https://soundcloud.com/n/embeds/credit-tracker",
                true,
                &prefs
            ),
            None
        );
        assert_eq!(
            blocked_resource("https://www.redditstatic.com/ads/pixel.js", false, &prefs),
            None
        );
    }
}
