use crate::{
    resource_policy::{blocked_resource, BlockedResource},
    settings::Settings,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    },
    WebResourceRequestedEventHandler,
};
use windows::core::{Interface, HSTRING, PWSTR};
use wry::{WebView, WebViewExtWindows};

pub struct ResourceFilter {
    view: ICoreWebView2,
    token: i64,
    pub settings: Rc<RefCell<Settings>>,
    pub artist_count: Rc<Cell<u32>>,
    pub advertising_count: Rc<Cell<u32>>,
}

impl ResourceFilter {
    pub fn install(view: &WebView, prefs: &Settings) -> windows::core::Result<Self> {
        let native = view.webview();
        // This API includes iframe requests, unlike the deprecated two-argument filter.
        let modern: ICoreWebView2_22 = native.cast()?;
        let settings = Rc::new(RefCell::new(prefs.clone()));
        let artist_count = Rc::new(Cell::new(0_u32));
        let advertising_count = Rc::new(Cell::new(0_u32));
        let config = settings.clone();
        let artist = artist_count.clone();
        let ads = advertising_count.clone();
        let environment = view.environment();
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            unsafe {
                let request = args.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                args.ResourceContext(&mut context)?;
                if let Some(kind) = blocked_resource(
                    &uri,
                    context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                    &config.borrow(),
                ) {
                    // 200 + empty body finishes iframe navigation without a retry-prone
                    // network failure. Nothing is logged or sent to a third party.
                    let response = environment.CreateWebResourceResponse(
                        None, 200, &HSTRING::from("OK"),
                        &HSTRING::from("Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: 0"),
                    )?;
                    args.SetResponse(&response)?;
                    let count = match kind {
                        BlockedResource::ArtistTools => &artist,
                        BlockedResource::Advertising => &ads,
                    };
                    count.set(count.get().saturating_add(1));
                }
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe {
            native.add_WebResourceRequested(&handler, &mut token)?;
            for (pattern, context) in [
                (
                    "https://soundcloud.com/n/embeds/credit-tracker*",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                ),
                (
                    "https://www.soundcloud.com/n/embeds/credit-tracker*",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                ),
                (
                    "https://www.redditstatic.com/ads/pixel.js*",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                ),
                (
                    "https://cm.g.doubleclick.net/partnerpixels*",
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                ),
            ] {
                modern.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &HSTRING::from(pattern),
                    context,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )?;
            }
        }
        Ok(Self {
            view: native,
            token,
            settings,
            artist_count,
            advertising_count,
        })
    }
}
impl Drop for ResourceFilter {
    fn drop(&mut self) {
        unsafe {
            let _ = self.view.remove_WebResourceRequested(self.token);
        }
    }
}
