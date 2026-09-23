use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub cleanup: bool,
    pub efficiency: bool,
    pub compact: bool,
    pub always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cleanup: true,
            efficiency: true,
            compact: false,
            always_on_top: false,
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
    pub fn valid(&self) -> bool {
        (360..=16384).contains(&self.w)
            && (160..=16384).contains(&self.h)
            && self.x.unsigned_abs() <= 100_000
            && self.y.unsigned_abs() <= 100_000
    }
}

pub fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Option<T> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec(value)?)
}

#[derive(Default)]
pub struct DeferredSave(Option<Instant>);

impl DeferredSave {
    pub fn mark(&mut self, now: Instant) {
        self.0 = Some(now + Duration::from_millis(350));
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.0
    }
    pub fn take_if_due(&mut self, now: Instant) -> bool {
        if self.0.is_some_and(|deadline| now >= deadline) {
            self.0 = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_enable_optimizations_not_intrusive_ui() {
        let s = Settings::default();
        assert!(s.cleanup && s.efficiency);
        assert!(!s.compact && !s.always_on_top);
        assert_eq!(serde_json::from_str::<Settings>("{}").unwrap(), s);
    }
    #[test]
    fn rejects_unknown_native_settings() {
        assert!(serde_json::from_str::<Settings>(r#"{"command":"delete"}"#).is_err());
    }
    #[test]
    fn move_storm_only_saves_after_idle() {
        let start = Instant::now();
        let mut d = DeferredSave::default();
        for i in 0..100 {
            d.mark(start + Duration::from_millis(i * 10));
        }
        assert!(!d.take_if_due(start + Duration::from_millis(1000)));
        assert!(d.take_if_due(start + Duration::from_millis(1400)));
        assert!(!d.take_if_due(start + Duration::from_millis(1500)));
    }
    #[test]
    fn minimized_zero_size_is_not_saved() {
        assert!(!WindowState {
            x: 0,
            y: 0,
            w: 0,
            h: 0
        }
        .valid());
        assert!(WindowState {
            x: -100,
            y: 0,
            w: 1280,
            h: 800
        }
        .valid());
    }
}
