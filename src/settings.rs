use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io, path::Path};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub cleanup: bool,
    pub efficiency: bool,
    pub compact: bool,
    pub always_on_top: bool,
    /// Timed comments drawn on waveforms.
    pub comments: bool,
    /// SoundCloud's autoplay station after the queue ends. Off stays off.
    pub autoplay: bool,
    /// Feed items: mixes over 20 minutes, and tracks already played.
    pub mixes: bool,
    pub played: bool,
    /// Comments on redesigned track pages ordered by likes.
    pub top_comments: bool,
    /// "Listening to" status in Discord. Opt-in: it shares what is playing.
    pub discord: bool,
    /// Scrobbling to Last.fm, when built with a Last.fm API key.
    pub lastfm: bool,
    /// System-wide shortcuts. Off by default: they take keys from every other app.
    pub hotkeys: bool,
    /// Action name to key combination, such as "Ctrl+Alt+Shift+P". Empty means the defaults.
    pub shortcuts: BTreeMap<String, String>,
    pub start_page: StartPage,
    /// Hardware acceleration. A change takes effect on the next start.
    pub gpu: bool,
    /// Writes what is playing to now-playing.txt, for stream overlays.
    pub now_file: bool,
    /// The phone remote on the local network.
    pub remote: bool,
    /// Windows notifications for new releases from artists you follow.
    pub notify: bool,
    /// Checks GitHub for a newer GoLow once a day.
    pub updates: bool,
    /// Starts hidden in the tray at Windows sign-in, so opening GoLow is instant.
    pub background: bool,
    /// Closing the window keeps GoLow running in the tray instead of quitting.
    pub tray: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartPage {
    #[default]
    Discover,
    Feed,
    Likes,
    Library,
    History,
    /// The page that was open when GoLow last closed.
    Last,
}

impl StartPage {
    pub fn path(self) -> &'static str {
        match self {
            Self::Discover | Self::Last => "/discover",
            Self::Feed => "/feed",
            Self::Likes => "/you/likes",
            Self::Library => "/you/library",
            Self::History => "/you/history",
        }
    }
}

impl Settings {
    /// Bounds what the page can store: a few short shortcut entries.
    pub fn sanitized(mut self) -> Self {
        self.shortcuts.retain(|action, keys| action.len() <= 32 && keys.len() <= 48);
        while self.shortcuts.len() > 24 {
            self.shortcuts.pop_last();
        }
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cleanup: true,
            efficiency: true,
            compact: false,
            always_on_top: false,
            comments: true,
            autoplay: true,
            mixes: true,
            played: true,
            top_comments: false,
            discord: false,
            lastfm: false,
            hotkeys: false,
            shortcuts: BTreeMap::new(),
            start_page: StartPage::Discover,
            gpu: true,
            now_file: false,
            remote: false,
            notify: false,
            updates: true,
            background: false,
            tray: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// The SoundCloud path open at exit, for the "last page" start page.
    #[serde(default)]
    pub last: String,
    /// Page zoom, 1.0 for 100%.
    #[serde(default = "full_size")]
    pub zoom: f64,
}

fn full_size() -> f64 {
    1.0
}

impl WindowState {
    /// Rejects minimized (zero-size) and corrupt geometry.
    pub fn valid(&self) -> bool {
        (360..=16384).contains(&self.w)
            && (160..=16384).contains(&self.h)
            && self.x.unsigned_abs() <= 100_000
            && self.y.unsigned_abs() <= 100_000
    }
}

/// Messages from the page: new settings, what is playing (`None` when paused), or a request
/// the app answers through `window.__scClient.reply`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Message {
    Settings(Settings),
    Now(NowPlaying),
    Call(Call),
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct NowPlaying {
    pub now: Option<String>,
    pub artist: String,
    pub title: String,
    pub seconds: u32,
    /// The mix this is a track of, when the page knows the mix tracklist.
    pub album: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub call: String,
    #[serde(default)]
    pub id: u32,
    #[serde(default)]
    pub args: serde_json::Value,
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    if fs::metadata(path).ok()?.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    fs::write(path, serde_json::to_vec(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enable_optimizations_and_reject_unknown_fields() {
        let s = Settings::default();
        assert!(
            s.cleanup && s.efficiency && s.comments && s.autoplay && !s.compact && !s.always_on_top
        );
        assert_eq!(serde_json::from_str::<Settings>("{}").unwrap(), s);
        assert!(serde_json::from_str::<Settings>(r#"{"command":"delete"}"#).is_err());
    }

    #[test]
    fn page_messages_are_settings_or_now_playing_only() {
        let parse = |json| serde_json::from_str::<Message>(json).ok();
        let mini = Settings { compact: true, ..Settings::default() };
        assert_eq!(parse(r#"{"compact":true}"#), Some(Message::Settings(mini)));
        let playing = NowPlaying {
            now: Some("Track - Artist".into()),
            artist: "Artist".into(),
            title: "Track".into(),
            seconds: 200,
            album: "Mix".into(),
        };
        let json = r#"{"now":"Track - Artist","artist":"Artist","title":"Track","seconds":200,"album":"Mix"}"#;
        assert_eq!(parse(json), Some(Message::Now(playing)));
        assert_eq!(parse(r#"{"now":null}"#), Some(Message::Now(NowPlaying::default())));
        assert_eq!(parse(r#"{"command":"delete"}"#), None);
        let call =
            Call { call: "open".into(), id: 3, args: serde_json::json!({"url": "https://x"}) };
        assert_eq!(
            parse(r#"{"call":"open","id":3,"args":{"url":"https://x"}}"#),
            Some(Message::Call(call))
        );
    }

    #[test]
    fn start_pages_and_shortcut_bounds() {
        let parsed: Settings = serde_json::from_str(r#"{"start_page":"likes"}"#).unwrap();
        assert_eq!(parsed.start_page.path(), "/you/likes");
        assert!(serde_json::from_str::<Settings>(r#"{"start_page":"https://evil"}"#).is_err());
        let mut many = Settings::default();
        for i in 0..40 {
            many.shortcuts.insert(format!("a{i:02}"), "Ctrl+Alt+Shift+P".into());
        }
        many.shortcuts.insert("x".repeat(80), "P".into());
        assert_eq!(many.sanitized().shortcuts.len(), 24);
    }

    #[test]
    fn minimized_zero_size_is_not_saved() {
        let state = |w, h| WindowState { x: -100, y: 0, w, h, last: String::new(), zoom: 1.0 };
        assert!(!state(0, 0).valid());
        assert!(state(1280, 800).valid());
        let old: WindowState = serde_json::from_str(r#"{"x":1,"y":2,"w":1280,"h":800}"#).unwrap();
        assert_eq!(old.zoom, 1.0);
    }
}
