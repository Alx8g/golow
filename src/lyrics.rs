//! Lyrics from LRCLIB (lrclib.net), a free, open lyrics database with time-synced lines. Only
//! the artist, title and length of the playing track are sent, and only while the Lyrics tab
//! is open.
use crate::http;
use serde_json::{json, Value};
use url::Url;

/// SoundCloud titles carry upload notes LRCLIB will not know: "[FREE DL]", "(prod. X)",
/// "(Official Video)", "(Original Mix)".
pub fn clean(title: &str) -> String {
    const NOISE: &[&str] = &[
        "free",
        "download",
        "dl",
        "prod",
        "official",
        "video",
        "audio",
        "lyric",
        "out now",
        "premiere",
        "original mix",
        "extended",
        "radio edit",
        "visualizer",
        "explicit",
        "clean",
        "remaster",
        "hq",
        "hd",
    ];
    let mut out = String::new();
    let mut depth = 0;
    let mut group = String::new();
    for c in title.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                group.clear();
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                let lower = group.to_lowercase();
                if !NOISE.iter().any(|word| lower.contains(word)) {
                    out.push_str(&format!("({group})"));
                }
            }
            _ if depth > 0 => group.push(c),
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fetch(path: &str, params: &[(&str, &str)]) -> Option<Value> {
    let mut url = Url::parse("https://lrclib.net/").ok()?.join(path).ok()?;
    url.query_pairs_mut().extend_pairs(params);
    http::get_json(&url)
}

fn pick(found: &Value) -> Value {
    json!({
        "synced": found["syncedLyrics"],
        "plain": found["plainLyrics"],
        "instrumental": found["instrumental"],
        "title": found["trackName"],
        "artist": found["artistName"],
    })
}

/// The best match, or Null when LRCLIB has none.
pub fn find(artist: &str, title: &str, seconds: u32) -> Value {
    let title = clean(title);
    let duration = seconds.to_string();
    if let Some(found) = fetch(
        "api/get",
        &[("artist_name", artist), ("track_name", &title), ("duration", &duration)],
    ) {
        if found["id"].is_number() {
            return pick(&found);
        }
    }
    // A search tolerates spelling and remix differences; prefer synced results close in length.
    let results = fetch("api/search", &[("artist_name", artist), ("track_name", &title)])
        .or_else(|| fetch("api/search", &[("q", &format!("{artist} {title}"))]));
    let Some(Value::Array(results)) = results else { return Value::Null };
    let best = results
        .iter()
        .filter(|r| {
            seconds == 0
                || (r["duration"].as_f64().unwrap_or(0.0) - f64::from(seconds)).abs() <= 8.0
        })
        .max_by_key(|r| (r["syncedLyrics"].is_string(), r["plainLyrics"].is_string()));
    best.map_or(Value::Null, pick)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_upload_notes_but_keeps_remixes_and_features() {
        assert_eq!(clean("Silk [FREE DL]"), "Silk");
        assert_eq!(clean("Fade Away (Official Video) (prod. Someone)"), "Fade Away");
        assert_eq!(clean("Alive (Kettama Remix)"), "Alive (Kettama Remix)");
        assert_eq!(clean("Song (feat. Singer)"), "Song (feat. Singer)");
        assert_eq!(clean("Down Under (2004 Remaster)"), "Down Under");
    }
}
