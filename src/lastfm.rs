//! Last.fm scrobbling. It runs in the app, not in SoundCloud's page, so the session key never
//! reaches third-party scripts. WinHTTP and Windows' MD5 keep it free of extra crates.
//! The API key and secret come from GOLOW_LASTFM_KEY and GOLOW_LASTFM_SECRET at build time.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::mpsc::{channel, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_MD5_ALG_HANDLE};

pub const KEY: Option<&str> = option_env!("GOLOW_LASTFM_KEY");
const SECRET: &str = match option_env!("GOLOW_LASTFM_SECRET") {
    Some(secret) => secret,
    None => "",
};

pub enum Event {
    /// A track is playing; repeated for the same track after a pause.
    Playing {
        artist: String,
        title: String,
        seconds: u32,
    },
    Paused,
    /// The user switched scrobbling on: sign in through the browser if needed.
    Connect,
    /// Flush a pending scrobble, then acknowledge so the app can exit.
    Quit(Sender<()>),
}

/// SoundCloud uploads often read "Artist - Title"; otherwise the uploader is the artist.
pub fn split(uploader: &str, title: &str) -> (String, String) {
    for separator in [" - ", " – ", " — "] {
        if let Some((artist, track)) = title.split_once(separator) {
            if !artist.trim().is_empty() && !track.trim().is_empty() {
                return (artist.trim().into(), track.trim().into());
            }
        }
    }
    (uploader.trim().into(), title.trim().into())
}

fn md5_hex(input: &str) -> String {
    let mut digest = [0u8; 16];
    let _ = unsafe { BCryptHash(BCRYPT_MD5_ALG_HANDLE, None, input.as_bytes(), &mut digest) };
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Last.fm's signature: every parameter sorted by name, concatenated, then the secret.
fn signed(params: &[(&str, &str)], key: &str) -> String {
    let mut all: Vec<(&str, &str)> = params.to_vec();
    all.push(("api_key", key));
    all.sort();
    let signature =
        md5_hex(&(all.iter().map(|(k, v)| format!("{k}{v}")).collect::<String>() + SECRET));
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(all)
        .append_pair("api_sig", &signature)
        .append_pair("format", "json")
        .finish()
}

fn post(body: &str) -> Option<Value> {
    let url = url::Url::parse("https://ws.audioscrobbler.com/2.0/").ok()?;
    let headers = "Content-Type: application/x-www-form-urlencoded";
    let response = crate::http::request("POST", &url, headers, body.as_bytes(), 1024 * 1024)?;
    serde_json::from_slice(&response.body).ok()
}

fn call(key: &str, method: &str, params: &[(&str, &str)]) -> Option<Value> {
    let mut all = params.to_vec();
    all.push(("method", method));
    post(&signed(&all, key))
}

/// Desktop sign-in: the user approves GoLow in their browser, then a session key is issued.
fn sign_in(key: &str) -> Option<String> {
    let token = call(key, "auth.getToken", &[])?["token"].as_str()?.to_string();
    let approve = format!("https://www.last.fm/api/auth/?api_key={key}&token={token}");
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &approve])
        .spawn()
        .ok()?;
    for _ in 0..60 {
        thread::sleep(Duration::from_secs(5));
        if let Some(session) = call(key, "auth.getSession", &[("token", &token)]) {
            if let Some(sk) = session["session"]["key"].as_str() {
                return Some(sk.to_string());
            }
        }
    }
    None
}

struct Play {
    artist: String,
    title: String,
    seconds: u32,
    started: u64,
    listened: Duration,
    since: Option<Instant>,
    scrobbled: bool,
}

impl Play {
    fn heard(&self) -> Duration {
        self.listened + self.since.map_or(Duration::ZERO, |since| since.elapsed())
    }
    /// Last.fm's rule: tracks over 30 s count once half, or 4 minutes, has been heard.
    fn due(&self) -> bool {
        !self.scrobbled
            && self.seconds > 30
            && self.heard() >= Duration::from_secs(u64::from(self.seconds / 2).min(240))
    }
}

/// Scrobbles on a worker thread. The session key is kept in the profile directory.
pub fn start(key: &'static str, profile: PathBuf) -> Sender<Event> {
    let (sender, events) = channel();
    thread::spawn(move || {
        let store = profile.join("lastfm.json");
        let mut session: Option<String> = crate::settings::read_json::<Value>(&store)
            .and_then(|saved| saved["key"].as_str().map(String::from));
        let mut play: Option<Play> = None;
        loop {
            let event = events.recv_timeout(Duration::from_secs(10));
            let sk = session.clone().unwrap_or_default();
            let scrobble = |play: &mut Play| {
                if play.due() && !sk.is_empty() {
                    play.scrobbled = true;
                    let at = play.started.to_string();
                    call(
                        key,
                        "track.scrobble",
                        &[
                            ("artist", &play.artist),
                            ("track", &play.title),
                            ("timestamp", &at),
                            ("sk", &sk),
                        ],
                    );
                }
            };
            match event {
                Ok(Event::Playing { artist, title, seconds }) => match &mut play {
                    Some(current) if current.artist == artist && current.title == title => {
                        current.since.get_or_insert_with(Instant::now);
                    }
                    _ => {
                        if let Some(previous) = &mut play {
                            scrobble(previous);
                        }
                        if !sk.is_empty() {
                            let length = seconds.to_string();
                            call(
                                key,
                                "track.updateNowPlaying",
                                &[
                                    ("artist", &artist),
                                    ("track", &title),
                                    ("duration", &length),
                                    ("sk", &sk),
                                ],
                            );
                        }
                        let started =
                            SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
                        play = Some(Play {
                            artist,
                            title,
                            seconds,
                            started,
                            listened: Duration::ZERO,
                            since: Some(Instant::now()),
                            scrobbled: false,
                        });
                    }
                },
                Ok(Event::Paused) => {
                    if let Some(current) = &mut play {
                        current.listened = current.heard();
                        current.since = None;
                    }
                }
                Ok(Event::Connect) if session.is_none() => {
                    session = sign_in(key);
                    if let Some(sk) = &session {
                        let _ = crate::settings::write_json(&store, &json!({"key": sk}));
                    }
                }
                Ok(Event::Connect) => {}
                Ok(Event::Quit(done)) => {
                    if let Some(current) = &mut play {
                        scrobble(current);
                    }
                    let _ = done.send(());
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // Scrobble as soon as a playing track crosses the threshold.
            if let Some(current) = &mut play {
                scrobble(current);
            }
        }
    });
    sender
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_with_an_artist_prefix_are_split() {
        assert_eq!(
            split("Uploader", "Fred again.. - Mabe"),
            ("Fred again..".into(), "Mabe".into())
        );
        assert_eq!(
            split("Van Halen", "Jump (2004 Remaster)"),
            ("Van Halen".into(), "Jump (2004 Remaster)".into())
        );
        assert_eq!(split("Uploader", " - Untitled"), ("Uploader".into(), "- Untitled".into()));
    }

    #[test]
    fn md5_and_signature_follow_last_fm() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
        let body = signed(&[("method", "auth.getToken")], "k");
        let expected = md5_hex(&format!("api_keykmethodauth.getToken{SECRET}"));
        assert_eq!(body, format!("api_key=k&method=auth.getToken&api_sig={expected}&format=json"));
    }

    /// Needs network: `cargo test -- --ignored lastfm`.
    #[test]
    #[ignore]
    fn reaches_last_fm_over_winhttp() {
        let reply = call("invalid-key", "auth.getToken", &[]).expect("a JSON reply");
        assert_eq!(reply["error"], 10, "{reply}");
    }

    #[test]
    fn scrobbles_after_half_the_track_or_four_minutes() {
        let play = |seconds, heard: u64| Play {
            artist: String::new(),
            title: String::new(),
            seconds,
            started: 0,
            listened: Duration::from_secs(heard),
            since: None,
            scrobbled: false,
        };
        assert!(!play(200, 99).due() && play(200, 100).due());
        assert!(!play(3600, 239).due() && play(3600, 240).due());
        assert!(!play(25, 25).due(), "tracks of 30 s or less never scrobble");
    }
}
