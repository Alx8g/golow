#[cfg(windows)]
mod imp {
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
}
#[cfg(windows)]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    //! Native macOS notifications through UNUserNotificationCenter. Clicks are matched back to
    //! GoLow's callback by notification identifier; dismissed notifications drop their callback.
    use block2::RcBlock;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{NSObject, NSObjectProtocol, ProtocolObject},
        AllocAnyThread,
    };
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex, Once, OnceLock,
        },
    };

    type Callbacks = Mutex<HashMap<String, Box<dyn Fn() + Send>>>;
    static CALLBACKS: OnceLock<Callbacks> = OnceLock::new();
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn callbacks() -> &'static Callbacks {
        CALLBACKS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn center() -> Retained<UNUserNotificationCenter> {
        UNUserNotificationCenter::currentNotificationCenter()
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "GoLowNotificationDelegate"]
        #[derive(Debug)]
        struct GoLowNotificationDelegate;

        unsafe impl NSObjectProtocol for GoLowNotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for GoLowNotificationDelegate {
            // Show release notifications even when GoLow is focused; the user explicitly asked for them.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List
                        | UNNotificationPresentationOptions::Sound,
                ));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let identifier = response.notification().request().identifier().to_string();
                let callback = callbacks().lock().unwrap().remove(&identifier);
                // Both clicking and dismissing retire the callback; only a click runs it.
                if response.actionIdentifier().to_string()
                    == unsafe {
                        objc2_user_notifications::UNNotificationDefaultActionIdentifier.to_string()
                    }
                {
                    if let Some(callback) = callback {
                        callback();
                    }
                }
                completion_handler.call(());
            }
        }
    );

    impl GoLowNotificationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Requests permission and installs the click delegate. Returns false outside an app bundle,
    /// where UNUserNotificationCenter cannot attribute notifications to GoLow.
    pub fn register(_dir: &std::path::Path) -> bool {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return false;
        }
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            center().requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &RcBlock::new(|_, _| {}),
            );
            let delegate = GoLowNotificationDelegate::new();
            let delegate_proto = ProtocolObject::from_retained(delegate.clone());
            center().setDelegate(Some(&delegate_proto));
            // The center holds its delegate weakly; notifications live for the app's lifetime.
            let _ = Retained::into_raw(delegate);
        });
        true
    }

    fn clean(text: &str) -> String {
        text.chars()
            .take(300)
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect()
    }

    /// Shows a notification. `clicked` runs if the user clicks it while GoLow is running.
    pub fn show(
        title: &str,
        body: &str,
        clicked: impl Fn() + Send + 'static,
    ) -> Result<(), String> {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return Err("notifications need the packaged GoLow app".into());
        }
        let identifier = format!("golow-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        callbacks().lock().unwrap().insert(identifier.clone(), Box::new(clicked));

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&clean(title)));
        content.setBody(&NSString::from_str(&clean(body)));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None,
        );
        let failed = identifier.clone();
        center().addNotificationRequest_withCompletionHandler(
            &request,
            Some(&RcBlock::new(move |error: *mut NSError| {
                if !error.is_null() {
                    callbacks().lock().unwrap().remove(&failed);
                }
            })),
        );
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn notification_text_is_bounded_and_single_line() {
            assert_eq!(clean("one\ntwo\0three"), "one two three");
            assert_eq!(clean(&"x".repeat(400)).len(), 300);
        }
    }
}
#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    #![allow(dead_code)]

    pub fn register(_dir: &std::path::Path) -> bool {
        false
    }
    pub fn show(
        _title: &str,
        _body: &str,
        _clicked: impl Fn() + Send + 'static,
    ) -> Result<(), String> {
        Err("notifications are not available on this platform yet".into())
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use imp::*;
