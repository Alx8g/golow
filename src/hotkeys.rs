#[cfg(windows)]
mod imp {
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
            _ if bytes.len() == 1 && bytes[0].is_ascii_lowercase() => {
                u32::from(bytes[0] - b'a') + 0x41
            }
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

    pub fn listen(_callback: impl Fn(usize) + Send + 'static) {}

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
                            if unsafe { RegisterHotKey(self.window as _, id, modifiers, key) }
                                != 0 =>
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
}
#[cfg(windows)]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    //! System-wide shortcuts through macOS's Carbon hotkey registration. Names follow
    //! KeyboardEvent.code, the same names the settings page records. Ctrl means Control,
    //! while Win/Meta/Super/Cmd mean Command.
    use global_hotkey::{
        hotkey::{Code, HotKey, Modifiers},
        GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
    };
    use std::{
        collections::{BTreeMap, HashMap},
        sync::{Mutex, OnceLock},
    };

    /// Every action, with its default. Ctrl+Alt+Shift avoids shortcuts apps and macOS use.
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

    fn code(name: &str) -> Option<Code> {
        let lower = name.to_ascii_lowercase();
        let bytes = lower.as_bytes();
        Some(match lower.as_str() {
            _ if bytes.len() == 1 && bytes[0].is_ascii_lowercase() => match bytes[0] {
                b'a' => Code::KeyA, b'b' => Code::KeyB, b'c' => Code::KeyC, b'd' => Code::KeyD,
                b'e' => Code::KeyE, b'f' => Code::KeyF, b'g' => Code::KeyG, b'h' => Code::KeyH,
                b'i' => Code::KeyI, b'j' => Code::KeyJ, b'k' => Code::KeyK, b'l' => Code::KeyL,
                b'm' => Code::KeyM, b'n' => Code::KeyN, b'o' => Code::KeyO, b'p' => Code::KeyP,
                b'q' => Code::KeyQ, b'r' => Code::KeyR, b's' => Code::KeyS, b't' => Code::KeyT,
                b'u' => Code::KeyU, b'v' => Code::KeyV, b'w' => Code::KeyW, b'x' => Code::KeyX,
                b'y' => Code::KeyY, b'z' => Code::KeyZ,
                _ => unreachable!(),
            },
            _ if bytes.len() == 1 && bytes[0].is_ascii_digit() => match bytes[0] {
                b'0' => Code::Digit0, b'1' => Code::Digit1, b'2' => Code::Digit2,
                b'3' => Code::Digit3, b'4' => Code::Digit4, b'5' => Code::Digit5,
                b'6' => Code::Digit6, b'7' => Code::Digit7, b'8' => Code::Digit8,
                b'9' => Code::Digit9,
                _ => unreachable!(),
            },
            _ if lower.starts_with('f') && lower.len() <= 3 => match lower[1..].parse::<u8>() {
                Ok(1) => Code::F1, Ok(2) => Code::F2, Ok(3) => Code::F3, Ok(4) => Code::F4,
                Ok(5) => Code::F5, Ok(6) => Code::F6, Ok(7) => Code::F7, Ok(8) => Code::F8,
                Ok(9) => Code::F9, Ok(10) => Code::F10, Ok(11) => Code::F11, Ok(12) => Code::F12,
                Ok(13) => Code::F13, Ok(14) => Code::F14, Ok(15) => Code::F15, Ok(16) => Code::F16,
                Ok(17) => Code::F17, Ok(18) => Code::F18, Ok(19) => Code::F19, Ok(20) => Code::F20,
                Ok(21) => Code::F21, Ok(22) => Code::F22, Ok(23) => Code::F23, Ok(24) => Code::F24,
                _ => return None,
            },
            "space" => Code::Space,
            "pageup" => Code::PageUp,
            "pagedown" => Code::PageDown,
            "end" => Code::End,
            "home" => Code::Home,
            "left" => Code::ArrowLeft,
            "up" => Code::ArrowUp,
            "right" => Code::ArrowRight,
            "down" => Code::ArrowDown,
            "insert" => Code::Insert,
            "delete" => Code::Delete,
            "semicolon" => Code::Semicolon,
            "equal" => Code::Equal,
            "comma" => Code::Comma,
            "minus" => Code::Minus,
            "period" => Code::Period,
            "slash" => Code::Slash,
            "backquote" => Code::Backquote,
            "bracketleft" => Code::BracketLeft,
            "backslash" => Code::Backslash,
            "bracketright" => Code::BracketRight,
            "quote" => Code::Quote,
            _ => return None,
        })
    }

    /// "Ctrl+Alt+Shift+P" into modifiers and a code. A key needs Ctrl, Alt or Command, unless it
    /// is a function key: anything else would take ordinary typing away from other apps.
    pub fn parse(text: &str) -> Option<(Modifiers, Code)> {
        let (mut modifiers, mut key) = (Modifiers::empty(), None);
        for part in text.split('+').map(str::trim) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
                "alt" | "option" => modifiers |= Modifiers::ALT,
                "shift" => modifiers |= Modifiers::SHIFT,
                "win" | "meta" | "super" | "cmd" | "command" => modifiers |= Modifiers::META,
                _ if key.is_none() => key = Some(code(part)?),
                _ => return None,
            }
        }
        let key = key?;
        let function_key = matches!(key,
            Code::F1 | Code::F2 | Code::F3 | Code::F4 | Code::F5 | Code::F6 | Code::F7 | Code::F8 |
            Code::F9 | Code::F10 | Code::F11 | Code::F12 | Code::F13 | Code::F14 | Code::F15 |
            Code::F16 | Code::F17 | Code::F18 | Code::F19 | Code::F20 | Code::F21 | Code::F22 |
            Code::F23 | Code::F24);
        (function_key || modifiers.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::META))
            .then_some((modifiers, key))
    }

    fn ids() -> &'static Mutex<HashMap<u32, usize>> {
        static IDS: OnceLock<Mutex<HashMap<u32, usize>>> = OnceLock::new();
        IDS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Listen once in a helper thread; callback receives the index used by `action` below.
    pub fn listen(callback: impl Fn(usize) + Send + 'static) {
        std::thread::spawn(move || {
            while let Ok(event) = GlobalHotKeyEvent::receiver().recv() {
                if event.state == HotKeyState::Pressed {
                    callback(event.id as usize);
                }
            }
        });
    }

    pub struct Hotkeys {
        manager: Option<GlobalHotKeyManager>,
        registered: Vec<HotKey>,
    }

    impl Hotkeys {
        pub fn new(_window: isize) -> Self {
            Self { manager: GlobalHotKeyManager::new().ok(), registered: Vec::new() }
        }

        /// The action behind a hotkey event id.
        pub fn action(id: usize) -> Option<&'static str> {
            let index = *ids().lock().ok()?.get(&(id as u32))?;
            ACTIONS.get(index).map(|(name, _)| *name)
        }

        /// Re-registers everything and reports each action: "ok", "in use", "invalid" or
        /// "unavailable" when macOS will not give GoLow a hotkey manager.
        pub fn apply(
            &mut self,
            enabled: bool,
            chosen: &BTreeMap<String, String>,
        ) -> BTreeMap<&'static str, &'static str> {
            if let Some(manager) = &self.manager {
                for hotkey in self.registered.drain(..) {
                    let _ = manager.unregister(hotkey);
                }
            }
            ids().lock().unwrap().clear();
            let mut status = BTreeMap::new();
            if !enabled {
                return status;
            }
            let Some(manager) = &self.manager else {
                for (action, _) in ACTIONS {
                    status.insert(*action, "unavailable");
                }
                return status;
            };
            for (index, (action, default)) in ACTIONS.iter().enumerate() {
                let keys = chosen.get(*action).map_or(*default, String::as_str);
                if keys.is_empty() {
                    continue;
                }
                status.insert(*action, match parse(keys) {
                    None => "invalid",
                    Some((modifiers, key)) => {
                        let hotkey = HotKey::new((!modifiers.is_empty()).then_some(modifiers), key);
                        match manager.register(hotkey) {
                            Ok(()) => {
                                ids().lock().unwrap().insert(hotkey.id(), index);
                                self.registered.push(hotkey);
                                "ok"
                            }
                            Err(_) => "in use",
                        }
                    }
                });
            }
            status
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_combinations_and_refuses_ones_that_steal_typing() {
            assert_eq!(parse("Ctrl+Alt+Shift+P"), Some((Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT, Code::KeyP)));
            assert_eq!(parse("Cmd+Period"), Some((Modifiers::META, Code::Period)));
            assert_eq!(parse("F13"), Some((Modifiers::empty(), Code::F13)));
            assert_eq!(parse("Ctrl+Digit1"), None);
            assert_eq!(parse("Ctrl+1"), Some((Modifiers::CONTROL, Code::Digit1)));
            for bad in ["P", "Shift+P", "Ctrl+", "Ctrl+P+Q", "Ctrl+Nonsense", "F25"] {
                assert_eq!(parse(bad), None, "{bad}");
            }
            for (_, default) in ACTIONS {
                assert!(parse(default).is_some(), "{default}");
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    #![allow(dead_code)]

    use std::collections::BTreeMap;
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
    pub fn parse(_text: &str) -> Option<(u32, u32)> {
        None
    }
    pub fn listen(_callback: impl Fn(usize) + Send + 'static) {}
    pub struct Hotkeys;
    impl Hotkeys {
        pub fn new(_window: isize) -> Self {
            Self
        }
        pub fn action(id: usize) -> Option<&'static str> {
            ACTIONS.get(id.checked_sub(1)?).map(|(name, _)| *name)
        }
        pub fn apply(
            &mut self,
            _enabled: bool,
            _chosen: &BTreeMap<String, String>,
        ) -> BTreeMap<&'static str, &'static str> {
            BTreeMap::new()
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use imp::*;
