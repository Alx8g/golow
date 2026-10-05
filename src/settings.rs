use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
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
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
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

/// Messages from the page: new settings, or what is playing (`None` when paused).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Message {
    Settings(Settings),
    Now(NowPlaying),
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NowPlaying {
    pub now: Option<String>,
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
        let playing = NowPlaying { now: Some("Track - Artist".into()) };
        assert_eq!(parse(r#"{"now":"Track - Artist"}"#), Some(Message::Now(playing)));
        assert_eq!(parse(r#"{"now":null}"#), Some(Message::Now(NowPlaying { now: None })));
        assert_eq!(parse(r#"{"command":"delete"}"#), None);
    }

    #[test]
    fn minimized_zero_size_is_not_saved() {
        assert!(!WindowState { x: 0, y: 0, w: 0, h: 0 }.valid());
        assert!(WindowState { x: -100, y: 0, w: 1280, h: 800 }.valid());
    }
}
