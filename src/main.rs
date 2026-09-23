#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::time::Instant;

use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize, Position, Size},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::{Icon, WindowBuilder},
};
use wry::{NewWindowResponse, PageLoadEvent, WebContext, WebViewBuilder};
#[cfg(target_os = "windows")]
use wry::WebViewBuilderExtWindows;

// Cosmetic-only CSS: hides promoted tracks / upsell banners / app nudges.
// Does NOT block audio ads (you have Go+ so there are none anyway).
// Audio + subscription auth still go through official soundcloud.com in a
// licensed WebView2 (Edge Chromium) which HAS DRM — unlike Helium.
// NOTE: ?noclean in URL disables all hiding (emergency recovery).
const ADHIDE_JS: &str = r#"(function(){
  try{
  if(window.location.hash.indexOf("noclean") !== -1) return;
  var css = [
    'a[href="/go"],a[href$="/go"],a[href*="/go?"],a[href*="/go/"],a[href*="/go#"],',
    'a[href="/pro"],a[href$="/pro"],a[href*="/pro?"],a[href*="/pro/"],a[href*="/pro#"],',
    'a[href*="/pages/artist"],a[href*="artists.soundcloud"],',
    '.upsellBanner,.premiumUpsell,.mobileAppsButtons,.appBanner,.cookieBanner{display:none!important;}',
    '[data-testid*="promoted"],[class*="promoted"],[class*="Upsell"],[class*="upsell"],',
    '[class*="Promo"],[class*="promo"],[class*="ArtistTools"],[class*="artistTools"],',
    '[class*="ArtistPro"],[class*="artistPro"],[id*="upsell"],[id*="promo"]{display:none!important;}',
    'body{background:#0b0b0c!important;}'
  ].join("");
  function inject(){
    try{
      var root = document.head || document.documentElement;
      if(!root) return false;
      var s = document.createElement("style");
      s.setAttribute("data-scclean","1");
      s.textContent = css;
      root.appendChild(s);
      return true;
    }catch(e){ return false; }
  }
  // Never hide page structure: refuse body/html/app roots.
  function hideEl(el){
    try{
      if(!el || !el.style) return;
      if(el===document.body || el===document.documentElement) return;
      var id = "";
      try{ id = (el.id || "").toLowerCase(); }catch(e){}
      if(id==="root"||id==="app"||id==="__next"||id==="main") return;
      el.style.setProperty("display","none","important");
    }catch(e){}
  }
  function closestClick(el){
    var a = el, j;
    for(j=0;j<4 && a && a!==document.body;j++){
      if(a.tagName==="A"||a.tagName==="BUTTON") return a;
      a = a.parentElement;
    }
    return el;
  }
  // Prefer clicking the banner's own dismiss (X): SoundCloud removes the whole
  // card itself and persists the dismissal. Zero risk of hiding wrong boxes.
  function dismissIn(el){
    try{
      if(!el || el===document.body) return false;
      var btn = el.querySelector(
        'button[aria-label*="ismiss"],button[aria-label*="lose"],' +
        'button[title*="ismiss"],button[title*="lose"]');
      if(btn){ btn.click(); return true; }
      var btns = el.querySelectorAll("button");
      for(var i=0;i<btns.length;i++){
        var t = (btns[i].textContent || "").trim();
        if(t==="\u00d7"||t==="\u2715"||t==="\u2716"){ btns[i].click(); return true; }
      }
    }catch(e){}
    return false;
  }
  // Hide innermost small card only (never climb into page structure).
  function hideSmallCard(node, maxUp, maxH){
    try{
      var el = node.parentElement;
      for(var i=0;i<maxUp && el && el!==document.body;i++){
        var h = 0;
        try{ h = el.getBoundingClientRect().height; }catch(e){}
        if(h > 0 && h < maxH){ hideEl(el); return true; }
        el = el.parentElement;
      }
    }catch(e){}
    return false;
  }
  function handlePromoText(node){
    try{
      var el = node.parentElement, i;
      for(i=0;i<8 && el && el!==document.body;i++){
        if(dismissIn(el)) return;
        el = el.parentElement;
      }
      hideSmallCard(node, 4, 250);
    }catch(e){}
  }
  // Generalized promo-bar catcher: any wide + short bar with promo keywords
  // AND a dismiss control gets its X clicked (persists). No per-banner phrases.
  var PROMO_WORDS = ["get heard", "get paid", "artist pro", "try artist",
    "try it out", "uploading tracks just got", "unlock artist",
    "100 listeners", "seamless experience"];
  function promoSweep(){
    try{
      if(!document.body || document.hidden) return;
      var vw = window.innerWidth || 1200;
      var els = document.querySelectorAll("div,section,aside");
      for(var i=0;i<els.length;i++){
        var el = els[i];
        try{
          if(el.hasAttribute("data-scclean")) continue;
          var r = el.getBoundingClientRect();
          if(r.width < vw*0.6 || r.height < 30 || r.height > 160) continue;
          if(el.querySelector('button[aria-label*="Play"],button[aria-label*="Pause"],' +
             'button[aria-label*="Shuffle"],button[aria-label*="Repeat"],' +
             'audio,video,input[type="range"]')) continue;
          var txt = (el.textContent || "").toLowerCase();
          if(txt.length > 400) continue;
          var isPromo = false, k;
          for(k=0;k<PROMO_WORDS.length;k++){
            if(txt.indexOf(PROMO_WORDS[k]) !== -1){ isPromo = true; break; }
          }
          if(!isPromo) continue;
          if(dismissIn(el)){ el.setAttribute("data-scclean","1"); continue; }
          var html = el.innerHTML || "";
          var hasClose = /aria-label="[^"]*(dismiss|close)/i.test(html) ||
            el.querySelector('[aria-label*="ismiss"],[aria-label*="lose"],' +
              '[title*="ismiss"],[title*="lose"]');
          if(hasClose){ hideEl(el); el.setAttribute("data-scclean","1"); }
        }catch(e){}
      }
    }catch(e){}
  }
  function sweep(){
    try{
      if(!document.body || document.hidden) return;
      try{
        document.querySelectorAll('a[href="/go"],a[href$="/go"],a[href="/pro"],a[href$="/pro"]').forEach(hideEl);
      }catch(e){}
      var walker;
      try{ walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null); }
      catch(e){ return; }
      var n;
      while((n = walker.nextNode())){
        var raw = n.nodeValue || "";
        if(raw.indexOf("Get heard by up to 100 listeners") !== -1 ||
           raw.indexOf("Unlock Artist tools from") !== -1 ||
           raw.indexOf("Uploading tracks just got way easier") !== -1 ||
           raw.indexOf("upload, get heard") !== -1){
          handlePromoText(n);
        } else {
          var t = raw.trim();
          if(t==="Try Artist Pro" || t==="Try Artist" ||
             t==="GO+" || t==="Go+" || t==="GO PLUS"){
            hideEl(closestClick(n.parentElement));
          }
        }
      }
    }catch(e){}
  }
  // Backup: wide + short + near-textless + dismiss control, but NEVER anything
  // holding media controls (protects the bottom player bar).
  function cleanOrphans(){
    try{
      if(!document.body || document.hidden) return;
      var vw = window.innerWidth || 1200;
      var els = document.querySelectorAll("div,section,aside");
      for(var i=0;i<els.length;i++){
        var el = els[i];
        try{
          if(el.hasAttribute("data-scclean")) continue;
          var r = el.getBoundingClientRect();
          if(r.width < vw*0.6 || r.height < 30 || r.height > 140) continue;
          if(el.querySelector('button[aria-label*="Play"],button[aria-label*="Pause"],' +
             'button[aria-label*="Shuffle"],button[aria-label*="Repeat"],' +
             'audio,video,input[type="range"]')) continue;
          var txt = (el.textContent || "").trim();
          if(txt.length > 25) continue;
          var html = el.innerHTML || "";
          var hasClose = /aria-label="[^"]*(dismiss|close)/i.test(html) ||
            el.querySelector('[aria-label*="ismiss"],[aria-label*="lose"],' +
              '[title*="ismiss"],[title*="lose"]');
          if(hasClose){ hideEl(el); el.setAttribute("data-scclean","1"); }
        }catch(e){}
      }
    }catch(e){}
  }
  // Debounced for observer storms: SPA fires thousands of mutations on load.
  var lastSweep = 0;
  function sweepSoon(){
    var now = Date.now();
    if(now - lastSweep > 1000){ lastSweep = now; sweep(); }
  }
  function boot(){
    if(!inject()){ setTimeout(boot,200); return; }
    lastSweep = Date.now(); sweep();
    try{
      if(document.documentElement){
        new MutationObserver(function(){ sweepSoon(); })
          .observe(document.documentElement,{childList:true,subtree:true});
      }
    }catch(e){}
    try{ document.addEventListener("DOMContentLoaded", sweep); }catch(e){}
    try{ window.addEventListener("load", sweep); }catch(e){}
    setInterval(function(){ lastSweep = Date.now(); sweep(); }, 2000);
    setInterval(promoSweep, 3000);
    setInterval(cleanOrphans, 15000);
  }
  boot();
  }catch(e){}
})();"#;

fn data_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("soundcloud-go-client").join("webview"))
}

fn app_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("soundcloud-go-client"))
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Copy)]
struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

fn state_path() -> Option<std::path::PathBuf> {
    app_dir().map(|d| d.join("window.json"))
}

fn load_state() -> Option<WinState> {
    let p = state_path()?;
    let s = std::fs::read_to_string(p).ok()?;
    let st: WinState = serde_json::from_str(&s).ok()?;
    if st.w < 200 || st.h < 200 {
        return None;
    }
    Some(st)
}

fn save_state(st: &WinState) {
    if let Some(dir) = app_dir() {
        let _ = std::fs::create_dir_all(&dir);
    }
    if let Some(p) = state_path() {
        if let Ok(s) = serde_json::to_string(st) {
            let _ = std::fs::write(p, s);
        }
    }
}

fn load_icon() -> Option<Icon> {
    let bytes = include_bytes!("../assets/icon.png");
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).ok()
}

// Startup instrumentation: append-only log so we can audit real load times.
fn perf_log(t0: Instant, msg: &str) {
    let dt = t0.elapsed().as_secs_f32();
    if let Some(dir) = app_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("startup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = writeln!(f, "t={:.2}s {}", dt, msg);
        }
    }
}

fn main() -> wry::Result<()> {
    let t0 = Instant::now();
    // Fresh audit section per launch.
    if let Some(dir) = app_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            dir.join("startup.log"),
            format!("launch {}\n", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)),
        );
    }
    let event_loop = EventLoop::new();
    perf_log(t0, "event_loop_ready");
    let saved = load_state();
    let mut builder = WindowBuilder::new()
        .with_title("SoundCloud Go+")
        .with_min_inner_size(Size::Logical(LogicalSize::new(360.0, 600.0)));
    if let Some(st) = saved {
        builder = builder
            .with_inner_size(Size::Physical(PhysicalSize::new(st.w, st.h)))
            .with_position(Position::Physical(PhysicalPosition::new(st.x, st.y)));
    } else {
        builder = builder.with_inner_size(Size::Logical(LogicalSize::new(1280.0, 800.0)));
    }
    if let Some(icon) = load_icon() {
        builder = builder.with_window_icon(Some(icon));
    }
    let window = builder.build(&event_loop).expect("failed to build window");
    perf_log(t0, "window_built");

    let mut win_state = saved.unwrap_or_else(|| {
        let s = window.inner_size();
        let p = window.outer_position().unwrap_or(PhysicalPosition::new(100, 100));
        WinState {
            x: p.x,
            y: p.y,
            w: s.width,
            h: s.height,
        }
    });

    // Persistent profile so Go+ login survives restarts.
    let mut context = match data_dir() {
        Some(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            WebContext::new(Some(dir))
        }
        None => WebContext::default(),
    };

    let webview_builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_url("https://soundcloud.com/discover")
        .with_initialization_script(ADHIDE_JS)
        .with_background_color((11, 11, 12, 255)) // dark first paint, no white flash
        .with_devtools(true) // F12 in debug; stripped in release unless feature enabled
        .with_on_page_load_handler(move |event, url| {
            match event {
                PageLoadEvent::Started => perf_log(t0, &format!("page_started {url}")),
                PageLoadEvent::Finished => perf_log(t0, &format!("page_finished {url}")),
            }
        })
        .with_new_window_req_handler(|_url, _features| {
            // SoundCloud login (Google/Apple/Facebook OAuth) uses window.open.
            // Without this, WebView2 blocks it and SC shows "enable popup windows".
            NewWindowResponse::Allow
        })
        .with_navigation_handler(|url| {
            // Keep everything inside the app; block only obvious external junk.
            // Allow soundcloud + OAuth providers needed for login.
            let ok = url.starts_with("https://soundcloud.com")
                || url.starts_with("https://secure.soundcloud.com")
                || url.starts_with("https://api-v2.soundcloud.com")
                || url.starts_with("https://accounts.google.com")
                || url.starts_with("https://appleid.apple.com")
                || url.starts_with("https://www.facebook.com")
                || url.starts_with("https://facebook.com")
                || url.starts_with("https://login.live.com")
                || url.starts_with("https://github.com/login")
                || url.starts_with("about:blank");
            ok
        });
    // Music app: never let the OS throttle/suspend the renderer when the
    // window is minimized, occluded, or in the background.
    #[cfg(target_os = "windows")]
    let webview_builder = webview_builder.with_additional_browser_args(
        "--disable-background-timer-throttling \
         --disable-backgrounding-occluded-windows \
         --disable-renderer-backgrounding",
    );
    let _webview = webview_builder.build(&window)?;
    perf_log(t0, "webview_built");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent { event, .. } = event {
            match event {
                WindowEvent::CloseRequested => {
                    save_state(&win_state);
                    *control_flow = ControlFlow::Exit;
                }
                WindowEvent::Resized(size) => {
                    win_state.w = size.width;
                    win_state.h = size.height;
                    save_state(&win_state);
                }
                WindowEvent::Moved(pos) => {
                    win_state.x = pos.x;
                    win_state.y = pos.y;
                    save_state(&win_state);
                }
                _ => {}
            }
        }
    });
}
