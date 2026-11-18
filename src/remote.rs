//! The phone remote: a small web page on the local network that controls GoLow. Its address
//! carries a random key that only the QR code in GoLow shows, and it can only press GoLow's own
//! player buttons. It runs only while the setting is on.
use qrcode::{Color, QrCode};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    net::{IpAddr, TcpListener, TcpStream, UdpSocket},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

pub const COMMANDS: &[&str] =
    &["toggle", "next", "previous", "back", "forward", "like", "volume_up", "volume_down"];
const PAGE: &str = include_str!("remote.html");
// Tests stay on loopback, which never triggers a Windows Firewall prompt.
#[cfg(not(test))]
const BIND: std::net::Ipv4Addr = std::net::Ipv4Addr::UNSPECIFIED;
#[cfg(test)]
const BIND: std::net::Ipv4Addr = std::net::Ipv4Addr::LOCALHOST;

/// What the phone shows. Positions are extrapolated on the phone from `at`.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct State {
    pub title: String,
    pub artist: String,
    pub artwork: String,
    pub playing: bool,
    pub passed: f64,
    pub total: f64,
    pub at: u64,
}

#[derive(serde::Deserialize, Serialize)]
struct Saved {
    port: u16,
    key: String,
}

pub struct Remote {
    pub url: String,
    stop: Arc<AtomicBool>,
    port: u16,
}

fn random_key() -> String {
    let mut bytes = [0u8; 16];
    let _ = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The address other devices on the network reach this PC at. Connecting a UDP socket only
/// picks a route; nothing is sent.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// The QR code as rows of 0 and 1, which the page draws.
pub fn qr(text: &str) -> Option<(usize, String)> {
    let code = QrCode::new(text).ok()?;
    Some((
        code.width(),
        code.to_colors().iter().map(|c| if *c == Color::Dark { '1' } else { '0' }).collect(),
    ))
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https://i1.sndcdn.com\r\n\
         Connection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

type Command = Arc<dyn Fn(&'static str, Option<f64>) + Send + Sync>;

fn handle(
    mut stream: TcpStream,
    key: &str,
    state: &Mutex<State>,
    command: &Command,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") && request.len() < 8192 {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let text = String::from_utf8_lossy(&request);
    let mut line = text.lines().next().unwrap_or_default().split(' ');
    let (method, path) = (line.next().unwrap_or_default(), line.next().unwrap_or_default());
    let mut parts = path.trim_start_matches('/').split('/');
    if !parts.next().is_some_and(|given| same(given, key)) {
        return respond(&mut stream, "404 Not Found", "text/plain", b"Not found");
    }
    match (method, parts.next().unwrap_or_default(), parts.next()) {
        ("GET", "", None) => {
            respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes())
        }
        ("GET", "state", None) => {
            let body = serde_json::to_vec(&*state.lock().unwrap()).unwrap_or_default();
            respond(&mut stream, "200 OK", "application/json", &body)
        }
        ("POST", "cmd", Some(name)) => match COMMANDS.iter().find(|c| **c == name) {
            Some(name) => {
                command(name, None);
                respond(&mut stream, "204 No Content", "text/plain", b"")
            }
            None => respond(&mut stream, "404 Not Found", "text/plain", b"Not found"),
        },
        ("POST", "seek", Some(seconds)) => {
            match seconds.parse::<f64>().ok().filter(|s| s.is_finite() && *s >= 0.0) {
                Some(seconds) => {
                    command("seek", Some(seconds));
                    respond(&mut stream, "204 No Content", "text/plain", b"")
                }
                None => respond(&mut stream, "400 Bad Request", "text/plain", b"Bad request"),
            }
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"Not found"),
    }
}

impl Remote {
    /// Starts listening on the local network. The port and key persist in remote.json, so a
    /// phone that saved the page keeps working.
    pub fn start(dir: &Path, state: Arc<Mutex<State>>, command: Command) -> io::Result<Self> {
        let file = dir.join("remote.json");
        let saved: Saved = crate::settings::read_json(&file)
            .filter(|s: &Saved| s.key.len() == 32)
            .unwrap_or_else(|| Saved { port: 47823, key: random_key() });
        let listener =
            TcpListener::bind((BIND, saved.port)).or_else(|_| TcpListener::bind((BIND, 0)))?;
        let port = listener.local_addr()?.port();
        let _ = crate::settings::write_json(&file, &Saved { port, key: saved.key.clone() });
        let ip = lan_ip().ok_or_else(|| io::Error::other("not connected to a network"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let (stopped, key, active) =
            (stop.clone(), saved.key.clone(), Arc::new(AtomicUsize::new(0)));
        thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::Relaxed) {
                    break;
                }
                // A few phones at most; extra connections are dropped rather than queued.
                let Ok(stream) = stream else { continue };
                if active.fetch_add(1, Ordering::Relaxed) >= 8 {
                    active.fetch_sub(1, Ordering::Relaxed);
                    continue;
                }
                let (key, state, command, active) =
                    (key.clone(), state.clone(), command.clone(), active.clone());
                thread::spawn(move || {
                    let _ = handle(stream, &key, &state, &command);
                    active.fetch_sub(1, Ordering::Relaxed);
                });
            }
        });
        Ok(Self { url: format!("http://{ip}:{port}/{}", saved.key), stop, port })
    }
}

impl Drop for Remote {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Wakes the blocking accept so the thread sees the stop flag.
        let _ = TcpStream::connect_timeout(
            &([127, 0, 0, 1], self.port).into(),
            Duration::from_millis(200),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn serves_only_with_the_key_and_only_known_commands() {
        let dir = std::env::temp_dir().join(format!("golow-remote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pressed = Arc::new(Mutex::new(Vec::new()));
        let log = pressed.clone();
        let state = Arc::new(Mutex::new(State { title: "Track".into(), ..State::default() }));
        let Ok(remote) =
            Remote::start(&dir, state, Arc::new(move |name, _| log.lock().unwrap().push(name)))
        else {
            return; // No network on this machine: nothing to serve.
        };
        let key = remote.url.rsplit('/').next().unwrap().to_owned();
        let port = remote.port;
        assert!(get(port, "GET / HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(get(port, "GET /0123456789abcdef0123456789abcdef HTTP/1.1\r\n\r\n")
            .starts_with("HTTP/1.1 404"));
        assert!(get(port, &format!("GET /{key} HTTP/1.1\r\n\r\n")).contains("GoLow remote"));
        assert!(get(port, &format!("GET /{key}/state HTTP/1.1\r\n\r\n"))
            .contains("\"title\":\"Track\""));
        assert!(get(port, &format!("POST /{key}/cmd/next HTTP/1.1\r\n\r\n"))
            .starts_with("HTTP/1.1 204"));
        assert!(get(port, &format!("POST /{key}/cmd/quit HTTP/1.1\r\n\r\n"))
            .starts_with("HTTP/1.1 404"));
        assert_eq!(*pressed.lock().unwrap(), ["next"]);
        drop(remote);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn qr_codes_are_square() {
        let (width, modules) =
            qr("http://192.168.1.2:47823/0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(modules.len(), width * width);
    }
}
