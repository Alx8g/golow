//! Windows notifications (toasts). GoLow is not a packaged app, so it registers its name and
//! icon under the user's registry the first time it notifies; uninstall.ps1 removes them.
use std::path::Path;
use windows::{
    core::{Result, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};
use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

pub const AUMID: &str = "Alx8g.GoLow";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn set(key: &str, name: &str, value: &str) -> bool {
    let (key, name, value) = (wide(key), wide(name), wide(value));
    let bytes = (value.len() * 2) as u32;
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            REG_SZ,
            value.as_ptr().cast(),
            bytes,
        ) == 0
    }
}

/// The name and icon Windows shows on GoLow's notifications.
pub fn register(dir: &Path) -> bool {
    let icon = dir.join("notification-icon.png");
    if !icon.exists() && std::fs::write(&icon, include_bytes!("../assets/icon.png")).is_err() {
        return false;
    }
    let key = format!(r"Software\Classes\AppUserModelId\{AUMID}");
    set(&key, "DisplayName", crate::APP_NAME) && set(&key, "IconUri", &icon.to_string_lossy())
}

fn escape(text: &str) -> String {
    text.chars()
        .take(300)
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&apos;".into(),
            c if c.is_control() => " ".into(),
            c => c.to_string(),
        })
        .collect()
}

/// Shows a notification. `clicked` runs if the user clicks it while GoLow is running.
pub fn show(title: &str, body: &str, clicked: impl Fn() + Send + 'static) -> Result<()> {
    let xml = format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(title),
        escape(body)
    );
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.Activated(&TypedEventHandler::new(move |_, _| {
        clicked();
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_text_cannot_inject_markup() {
        assert_eq!(escape("<b>A & B</b>\n\"x\""), "&lt;b&gt;A &amp; B&lt;/b&gt; &quot;x&quot;");
        assert_eq!(escape(&"x".repeat(400)).len(), 300);
    }
}
