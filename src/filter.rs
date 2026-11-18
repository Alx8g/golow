use crate::policy::trusted_https;
use std::{cell::Cell, rc::Rc};
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL as ALL,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT as DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL as ALL_SOURCES,
    },
    NavigationStartingEventHandler, WebResourceRequestedEventHandler,
};
use windows::core::{Interface, HSTRING, PWSTR};
use wry::{WebView, WebViewExtWindows};

/// Exact (host, path, promo) resources observed in profiling. Promo rules match only the
/// hidden Artist Tools frame document and follow `cleanup`; the rest are ad and tracking
/// bootstraps and follow `efficiency`. Media, consent, OAuth, fraud prevention and the
/// standby player frame are never listed.
const RULES: &[(&str, &str, bool)] = &[
    ("soundcloud.com", "/n/embeds/credit-tracker", true),
    ("www.soundcloud.com", "/n/embeds/credit-tracker", true),
    ("www.redditstatic.com", "/ads/pixel.js", false),
    ("cm.g.doubleclick.net", "/partnerpixels", false),
    ("htlbid.com", "/v3/soundcloud.com/htlbid.js", false),
    ("securepubads.g.doubleclick.net", "/tag/js/gpt.js", false),
    ("c.amazon-adsystem.com", "/aax2/apstag.js", false),
    ("connect.facebook.net", "/en_US/fbevents.js", false),
    ("analytics.tiktok.com", "/i18n/pixel/events.js", false),
    // Measurement and marketing scripts that run while SoundCloud's app is starting.
    ("www.googletagmanager.com", "/gtm.js", false),
    ("www.googletagmanager.com", "/gtag/js", false),
    ("www.google-analytics.com", "/analytics.js", false),
    ("secure.quantserve.com", "/quant.js", false),
    ("rules.quantcount.com", "/rules-p-47_zcqmJsLHXQ.js", false),
    ("sb.scorecardresearch.com", "/cs/16601931/beacon.js", false),
    ("cdn.moengage.com", "/webpush/moe_webSdk.min.latest.js", false),
    ("websdk.appsflyersdk.com", "/", false),
    // The Chromecast SDK: WebView2 has no Cast support, so it can only cost startup time.
    ("www.gstatic.com", "/cv/js/sender/v1/cast_sender.js", false),
    ("www.gstatic.com", "/cast/sdk/libs/sender/1.0/cast_framework.js", false),
    ("www.gstatic.com", "/eureka/clank/154/cast_sender.js", false),
];

/// The two settings the filter follows; copied so request callbacks never borrow settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rules {
    pub cleanup: bool,
    pub efficiency: bool,
}

pub fn blocked(raw: &str, document: bool, prefs: Rules) -> bool {
    let Some(url) = trusted_https(raw) else {
        return false;
    };
    RULES.iter().any(|&(host, path, promo)| {
        url.host_str() == Some(host)
            && url.path() == path
            && if promo { document && prefs.cleanup } else { prefs.efficiency }
    })
}

pub fn install(view: &WebView, prefs: Rc<Cell<Rules>>) -> windows::core::Result<()> {
    let native = view.webview();
    // This API includes iframe requests, unlike the deprecated two-argument filter.
    let modern: ICoreWebView2_22 = native.cast()?;
    let environment = view.environment();
    let request_prefs = prefs.clone();
    let on_request = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut uri = PWSTR::null();
            args.Request()?.Uri(&mut uri)?;
            let mut context = ALL;
            args.ResourceContext(&mut context)?;
            if blocked(&take_pwstr(uri), context == DOCUMENT, request_prefs.get()) {
                // 200 + empty body finishes iframe navigation without a retry-prone failure.
                let headers =
                    "Content-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: 0";
                let response = environment.CreateWebResourceResponse(
                    None,
                    200,
                    &HSTRING::from("OK"),
                    &HSTRING::from(headers),
                )?;
                args.SetResponse(&response)?;
            }
        }
        Ok(())
    }));
    // Cancelling the frame navigation as well means the Artist Tools frame runs no script.
    let on_frame = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            if blocked(&take_pwstr(uri), true, prefs.get()) {
                args.SetCancel(true)?;
            }
        }
        Ok(())
    }));
    unsafe {
        let mut token = 0;
        native.add_WebResourceRequested(&on_request, &mut token)?;
        native.add_FrameNavigationStarting(&on_frame, &mut token)?;
        for &(host, path, promo) in RULES {
            let pattern = HSTRING::from(format!("https://{host}{path}*"));
            let context = if promo { DOCUMENT } else { ALL };
            modern.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &pattern,
                context,
                ALL_SOURCES,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_only_exact_listed_resources_and_obeys_settings() {
        let on = Rules { cleanup: true, efficiency: true };
        let off = Rules { cleanup: false, efficiency: false };
        for &(host, path, promo) in RULES {
            let url = format!("https://{host}{path}?cache=1");
            assert!(blocked(&url, true, on) && !blocked(&url, true, off), "{url}");
            assert_eq!(blocked(&url, false, on), !promo, "promo rules are document-only: {url}");
            for near in [
                format!("https://{host}.example.invalid{path}"),
                format!("https://{host}{path}-other"),
                format!("https://{host}:8443{path}"),
                format!("http://{host}{path}"),
            ] {
                assert!(!blocked(&near, true, on), "{near}");
            }
        }
    }

    #[test]
    fn playback_login_consent_and_security_pass() {
        let urls = "https://soundcloud.com/n/pages/standby https://soundcloud.com/settings/streaming
            https://api-v2.soundcloud.com/media/test https://cf-media.sndcdn.com/test
            https://accounts.google.com/o/oauth2/auth https://www.facebook.com/dialog/oauth
            https://connect.facebook.net/en_US/sdk.js https://cdn.cookielaw.org/script.js
            https://cadmus.script.ac/d24657ks8lvxjy/script.js https://www.redditstatic.com/other.js";
        for url in urls.split_whitespace() {
            assert!(!blocked(url, true, Rules { cleanup: true, efficiency: true }), "{url}");
        }
    }
}
