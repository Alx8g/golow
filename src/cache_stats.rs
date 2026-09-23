use std::{
    path::Path,
    time::{Duration, Instant},
};

const MAX_AGE: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct CacheStats {
    value: Option<(u64, Instant)>,
    busy: bool,
}

impl CacheStats {
    pub fn value(&self) -> Option<u64> {
        self.value.map(|(bytes, _)| bytes)
    }
    pub fn request(&mut self, now: Instant) -> bool {
        if self.busy
            || self
                .value
                .is_some_and(|(_, time)| now.duration_since(time) < MAX_AGE)
        {
            return false;
        }
        self.busy = true;
        true
    }
    pub fn finish(&mut self, bytes: u64, now: Instant) {
        self.value = Some((bytes, now));
        self.busy = false;
    }
}

pub fn cache_size(dir: &Path) -> u64 {
    fn size(path: &Path) -> u64 {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| {
                let Ok(kind) = entry.file_type() else {
                    return 0;
                };
                if kind.is_symlink() {
                    return 0;
                }
                if kind.is_dir() {
                    size(&entry.path())
                } else {
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                }
            })
            .sum()
    }
    let profile = dir.join("webview/EBWebView/Default");
    size(&profile.join("Cache")) + size(&profile.join("Code Cache"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_scan_and_reuse_recent_result() {
        let now = Instant::now();
        let mut stats = CacheStats::default();
        assert_eq!(stats.value(), None);
        assert!(stats.request(now));
        assert!(!stats.request(now));
        stats.finish(123, now);
        assert_eq!(stats.value(), Some(123));
        assert!(!stats.request(now + Duration::from_secs(59)));
        assert!(stats.request(now + Duration::from_secs(61)));
    }
}
