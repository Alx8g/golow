//! "Listening to" status over Discord's local IPC pipe. Needs a Discord application ID,
//! set at build time with GOLOW_DISCORD_APP_ID; without one the feature is absent.
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    sync::mpsc::{channel, Sender},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

pub const APP_ID: Option<&str> = option_env!("GOLOW_DISCORD_APP_ID");

fn frame(op: u32, body: &Value) -> Vec<u8> {
    let body = body.to_string();
    [op.to_le_bytes(), (body.len() as u32).to_le_bytes()]
        .concat()
        .into_iter()
        .chain(body.bytes())
        .collect()
}

/// Reads one reply frame: (opcode, JSON body).
fn reply(pipe: &mut File) -> io::Result<(u32, Value)> {
    let mut header = [0; 8];
    pipe.read_exact(&mut header)?;
    let mut body =
        vec![0; u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize];
    pipe.read_exact(&mut body)?;
    Ok((
        u32::from_le_bytes([header[0], header[1], header[2], header[3]]),
        serde_json::from_slice(&body)?,
    ))
}

/// Handshakes on the first live pipe. Discord answers a valid ID with op 1 (READY)
/// and anything else with op 2 (CLOSE) and an error message.
pub fn connect(app_id: &str) -> io::Result<File> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "Discord is not running");
    for n in 0..10 {
        let Ok(mut pipe) =
            OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{n}"))
        else {
            continue;
        };
        pipe.write_all(&frame(0, &json!({"v": 1, "client_id": app_id})))?;
        match reply(&mut pipe)? {
            (1, _) => return Ok(pipe),
            (_, error) => last = io::Error::other(error.to_string()),
        }
    }
    Err(last)
}

/// Mirrors now-playing to Discord on a worker thread; send `None` to clear the status.
pub fn start(app_id: &'static str) -> Sender<Option<String>> {
    let (sender, updates) = channel::<Option<String>>();
    thread::spawn(move || {
        let mut pipe = None;
        for (nonce, now) in updates.into_iter().enumerate() {
            let started = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
            let activity = now.map_or(
                Value::Null,
                |title| json!({"type": 2, "details": title, "timestamps": {"start": started}}),
            );
            let message = json!({"cmd": "SET_ACTIVITY", "args": {"pid": std::process::id(), "activity": activity}, "nonce": nonce.to_string()});
            if pipe.is_none() {
                pipe = connect(app_id).ok();
            }
            // A failed write means Discord restarted or quit; reconnect on the next update.
            if let Some(open) = &mut pipe {
                if open.write_all(&frame(1, &message)).and_then(|()| reply(open)).is_err() {
                    pipe = None;
                }
            }
        }
    });
    sender
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_opcode_length_then_json() {
        let bytes = frame(1, &json!({"a": 1}));
        assert_eq!(&bytes[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(&bytes[8..], br#"{"a":1}"#);
    }

    /// Needs Discord running locally: `cargo test -- --ignored discord`.
    #[test]
    #[ignore]
    fn discord_rejects_an_unknown_application_over_the_real_pipe() {
        let error = connect("1").expect_err("an unregistered ID must be refused");
        assert!(
            error.to_string().contains("client_id") || error.to_string().contains("Invalid"),
            "{error}"
        );
    }
}
