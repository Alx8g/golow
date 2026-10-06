//! System-wide shortcuts, registered on the main window. Off by default, because a registered
//! combination stops reaching every other app. Names follow KeyboardEvent.code, so the page can
//! record a combination by listening for it.
use std::collections::BTreeMap;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};

/// Every action, with its default. Ctrl+Alt+Shift avoids the shortcuts apps and Windows use.
pub const ACTIONS: &[(&str, &str)] = &[
    ("toggle", "Ctrl+Alt+Shift+P"),
    ("next", "Ctrl+Alt+Shift+N"),
    ("previous", "Ctrl+Alt+Shift+B"),
    ("back", "Ctrl+Alt+Shift+Comma"),
    ("forward", "Ctrl+Alt+Shift+Period"),
    ("like", "Ctrl+Alt+Shift+L"),
    ("volume_up", "Ctrl+Alt+Shift+Equal"),
    ("volume_down", "Ctrl+Alt+Shift+Minus"),
    ("bookmark", "Ctrl+Alt+Shift+K"),
    ("show", "Ctrl+Alt+Shift+S"),
];

fn virtual_key(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    Some(match lower.as_str() {
        _ if bytes.len() == 1 && bytes[0].is_ascii_lowercase() => u32::from(bytes[0] - b'a') + 0x41,
        _ if bytes.len() == 1 && bytes[0].is_ascii_digit() => u32::from(bytes[0] - b'0') + 0x30,
        _ if lower.starts_with('f') && lower.len() <= 3 => match lower[1..].parse::<u32>() {
            Ok(n @ 1..=24) => 0x6F + n,
            _ => return None,
        },
        "space" => 0x20,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "semicolon" => 0xBA,
        "equal" => 0xBB,
        "comma" => 0xBC,
        "minus" => 0xBD,
        "period" => 0xBE,
        "slash" => 0xBF,
        "backquote" => 0xC0,
        "bracketleft" => 0xDB,
        "backslash" => 0xDC,
        "bracketright" => 0xDD,
        "quote" => 0xDE,
        _ => return None,
    })
}

/// "Ctrl+Alt+Shift+P" into modifiers and a virtual key. A key needs Ctrl, Alt or Win, unless
/// it is a function key: anything else would take ordinary typing away from other apps.
pub fn parse(text: &str) -> Option<(u32, u32)> {
    let (mut modifiers, mut key) = (0, None);
    for part in text.split('+').map(str::trim) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL,
            "alt" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "meta" => modifiers |= MOD_WIN,
            _ if key.is_none() => key = Some(virtual_key(part)?),
            _ => return None,
        }
    }
    let key = key?;
    let function_key = (0x70..=0x87).contains(&key);
    (function_key || modifiers & (MOD_CONTROL | MOD_ALT | MOD_WIN) != 0)
        .then_some((modifiers | MOD_NOREPEAT, key))
}

pub struct Hotkeys {
    window: isize,
    registered: Vec<i32>,
}

impl Hotkeys {
    pub fn new(window: isize) -> Self {
        Self { window, registered: Vec::new() }
    }

    /// The action behind a WM_HOTKEY id.
    pub fn action(id: usize) -> Option<&'static str> {
        ACTIONS.get(id.checked_sub(1)?).map(|(name, _)| *name)
    }

    /// Re-registers everything and reports each action: "ok", "in use" or "invalid".
    pub fn apply(
        &mut self,
        enabled: bool,
        chosen: &BTreeMap<String, String>,
    ) -> BTreeMap<&'static str, &'static str> {
        for id in self.registered.drain(..) {
            unsafe { UnregisterHotKey(self.window as _, id) };
        }
        let mut status = BTreeMap::new();
        if !enabled {
            return status;
        }
        for (index, (action, default)) in ACTIONS.iter().enumerate() {
            let keys = chosen.get(*action).map_or(*default, String::as_str);
            if keys.is_empty() {
                continue;
            }
            let id = index as i32 + 1;
            status.insert(
                *action,
                match parse(keys) {
                    None => "invalid",
                    Some((modifiers, key))
                        if unsafe { RegisterHotKey(self.window as _, id, modifiers, key) } != 0 =>
                    {
                        self.registered.push(id);
                        "ok"
                    }
                    Some(_) => "in use",
                },
            );
        }
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_combinations_and_refuses_ones_that_steal_typing() {
        assert_eq!(
            parse("Ctrl+Alt+Shift+P"),
            Some((MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 0x50))
        );
        assert_eq!(parse("Win+Period"), Some((MOD_WIN | MOD_NOREPEAT, 0xBE)));
        assert_eq!(parse("F13"), Some((MOD_NOREPEAT, 0x7C)));
        assert_eq!(parse("Ctrl+Digit1"), None);
        assert_eq!(parse("Ctrl+1"), Some((MOD_CONTROL | MOD_NOREPEAT, 0x31)));
        for bad in ["P", "Shift+P", "Ctrl+", "Ctrl+P+Q", "Ctrl+Nonsense", "F25"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        for (_, default) in ACTIONS {
            assert!(parse(default).is_some(), "{default}");
        }
        assert_eq!(Hotkeys::action(1), Some("toggle"));
        assert_eq!(Hotkeys::action(0), None);
    }
}
