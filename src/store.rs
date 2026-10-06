//! Files the page keeps outside the browser profile, so clearing site data never loses them:
//! library backups, the play log, exports. Every name is a short slug inside one folder, so
//! the page can never reach any other path.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const LIMIT: usize = 32 * 1024 * 1024;

pub fn valid(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, name: &str, ext: &str) -> Result<PathBuf, String> {
        if !valid(name) {
            return Err(format!("invalid name {name:?}"));
        }
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        Ok(self.dir.join(format!("{name}.{ext}")))
    }

    /// The saved text, or None when there is none yet.
    pub fn load(&self, name: &str, log: bool) -> Result<Option<String>, String> {
        let path = self.path(name, if log { "jsonl" } else { "json" })?;
        match fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Replaces the file in one step, so a crash mid-write keeps the previous copy.
    pub fn save(&self, name: &str, data: &str) -> Result<(), String> {
        if data.len() > LIMIT {
            return Err("too large".into());
        }
        let path = self.path(name, "json")?;
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, data).and_then(|()| fs::rename(&temp, &path)).map_err(|e| e.to_string())
    }

    /// Adds one line to a log. Lines never contain line breaks, so each stays one record.
    pub fn append(&self, name: &str, line: &str) -> Result<(), String> {
        if line.len() > 64 * 1024 || line.contains(['\n', '\r']) {
            return Err("invalid line".into());
        }
        let path = self.path(name, "jsonl")?;
        if fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0) > LIMIT {
            return Err("log full".into());
        }
        let mut file =
            fs::File::options().create(true).append(true).open(path).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())
    }

    /// Saved names starting with `prefix`, newest name last.
    pub fn list(&self, prefix: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter_map(|file| file.strip_suffix(".json").map(str::to_owned))
            .filter(|name| name.starts_with(prefix) && valid(name))
            .collect();
        names.sort();
        names
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        let path = self.path(name, "json")?;
        match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }
}

/// Writes an export the user asked for into Documents\GoLow and returns its path.
pub fn export(name: &str, ext: &str, data: &str) -> Result<PathBuf, String> {
    if !valid(name) || !["csv", "json", "txt"].contains(&ext) || data.len() > LIMIT {
        return Err("invalid export".into());
    }
    let dir = dirs::document_dir().ok_or("no Documents folder")?.join(crate::APP_NAME);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.{ext}"));
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> Store {
        let dir = std::env::temp_dir().join(format!("golow-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Store::new(dir)
    }

    #[test]
    fn names_stay_inside_the_folder() {
        for bad in ["", "../x", "a/b", "a\\b", "C:", "Upper", "-x", "a.b", &"x".repeat(49)] {
            assert!(!valid(bad), "{bad}");
        }
        assert!(valid("likes-2026-10-06"));
        assert!(temp().save("../escape", "{}").is_err());
    }

    #[test]
    fn saves_loads_appends_and_lists() {
        let store = temp();
        assert_eq!(store.load("backup-1", false).unwrap(), None);
        store.save("backup-1", r#"{"a":1}"#).unwrap();
        store.save("backup-2", "{}").unwrap();
        assert_eq!(store.load("backup-1", false).unwrap().as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(store.list("backup-"), ["backup-1", "backup-2"]);
        store.append("plays", r#"{"t":1}"#).unwrap();
        store.append("plays", r#"{"t":2}"#).unwrap();
        assert!(store.append("plays", "two\nlines").is_err());
        assert_eq!(store.load("plays", true).unwrap().unwrap().lines().count(), 2);
        store.remove("backup-1").unwrap();
        assert_eq!(store.list("backup-"), ["backup-2"]);
        let _ = fs::remove_dir_all(store.dir());
    }
}
