(() => {
  'use strict';
  if (window.top !== window || location.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) return;
  if (window.__scClient) return;

  const KEYS = ['cleanup', 'efficiency', 'compact', 'always_on_top'];
  const settings = Object.assign({cleanup: true, efficiency: true, compact: false, always_on_top: false}, window.__scInitialSettings);
  // Same-origin preferences avoid briefly restoring old startup values on each
  // full navigation. Rust validates and owns the persisted native settings.
  try {
    const cached = JSON.parse(localStorage.getItem('sc-client-settings-v1') || '{}');
    for (const key of KEYS) if (typeof cached[key] === 'boolean') settings[key] = cached[key];
  } catch {}
  const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);

  // Exact, small selectors hide known promotions before their first paint.
  // Structural :has exclusions preserve player/form/consent containers.
  const promoSelectors = [
    '.upsellBanner', '.premiumUpsell', '.mobileAppsButtons', '.appBanner', '[data-testid="promoted-track"]',
    '[data-testid="upsell-banner"]', '[data-testid="artist-pro-banner"]', '.artistProBanner', '.artistUpsell',
    '.homeCreditTracker', 'a[href="/go"]', 'a[href="/pro"]', 'a[href^="/go?"]', 'a[href^="/pro?"]',
    'a[href^="https://artists.soundcloud.com"]'];
  const protectedSelector = 'audio,video,input,form,[role="dialog"],.playControls,.waveform,.playbackTimeline,button[aria-label*="Play"],button[aria-label*="Pause"]';
  const guarded = `:not(html,body,#root,#app,#main,#__next):not(:is(${protectedSelector})):not(:has(${protectedSelector}))` +
    ':not(:is(.playControls *,.waveform *,.playbackTimeline *))';
  // Playlist tiles keep a SMIL buffering spinner inside a play button that stays hidden
  // until hover. Hidden SMIL still forces style and layout every frame, so stop rendering
  // it exactly while SoundCloud's own rules keep the button hidden.
  const idleSpinners = ['.playableTile[data-playbutton="never"] .playableTile__playButton',
    '.playableTile[data-playbutton="hover"]:not(.m-playing) .playableTile__artwork:not(:hover) .playableTile__playButton:not(.forceVisibility)'];
  const css = promoSelectors.map(s => `html[data-sc-cleanup] ${s}${guarded}`).join(',') + '{display:none!important}' +
    idleSpinners.map(s => `html[data-sc-efficiency] ${s} svg:has(animate,animateTransform)`).join(',') + '{display:none!important}' +
    'html[data-sc-cleanup] [data-sc-client-hidden]{display:none!important}';
  const bannerSelector = '.announcementBanner,.announcementBanner__content';
  const bannerText = /get heard by up to 100 listeners|unlock artist tools|try artist pro|uploading tracks just got/i;

  const marked = new Set(), pending = new Set(), counters = {scans: 0, mutations: 0, candidates: 0};
  let observer = null, timer = null, style = null, shadow = null, panel = null, nativeHidden = false, fullScanNeeded = true;
  const $ = id => shadow.getElementById(id);
  const visible = () => !document.hidden && !nativeHidden;
  const cleanupEnabled = () => settings.cleanup && !recovery;
  const send = value => window.ipc?.postMessage?.(JSON.stringify(value));
  const cacheSettings = () => {
    try {
      const value = JSON.stringify(settings);
      if (localStorage.getItem('sc-client-settings-v1') !== value) localStorage.setItem('sc-client-settings-v1', value);
    } catch {}
  };

  function initializeDocument() {
    const root = document.documentElement;
    if (!root) return false;
    if (settings.efficiency) {
      for (const href of ['https://api-v2.soundcloud.com', 'https://a-v2.sndcdn.com', 'https://i1.sndcdn.com']) {
        if (document.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
        const link = Object.assign(document.createElement('link'), {rel: 'preconnect', href, crossOrigin: 'anonymous'});
        (document.head || root).appendChild(link);
      }
    }
    if (!style) {
      style = Object.assign(document.createElement('style'), {id: 'sc-client-style', textContent: css});
      (document.head || root).appendChild(style);
    }
    root.toggleAttribute('data-sc-cleanup', cleanupEnabled());
    root.toggleAttribute('data-sc-efficiency', settings.efficiency);
    return true;
  }
  // Only known notice containers need a text-based fallback. Exact promo classes
  // anywhere on the page are handled by CSS without JS callbacks.
  function scan(root) {
    if (!cleanupEnabled() || !visible() || !root || (root !== document && !root.isConnected)) return;
    counters.scans++;
    const candidates = root.nodeType === 1 && root.matches(bannerSelector) ? [root] : [];
    candidates.push(...root.querySelectorAll(bannerSelector));
    for (const el of candidates) {
      counters.candidates++;
      if (el.matches(protectedSelector) || el.querySelector(protectedSelector) || el.closest('.playControls,.waveform,.playbackTimeline')) continue;
      if (bannerText.test(el.textContent || '')) { el.setAttribute('data-sc-client-hidden', ''); marked.add(el); }
    }
    for (const el of marked) if (!el.isConnected) marked.delete(el);
  }
  function flush() {
    timer = null;
    const roots = [...pending];
    pending.clear();
    for (const root of roots) if (!roots.some(other => other !== root && other.contains(root))) scan(root);
  }
  function stop() {
    observer?.disconnect();
    clearTimeout(timer);
    observer = timer = null;
    pending.clear();
  }
  function refresh() {
    if (!initializeDocument()) return;
    stop();
    if (!cleanupEnabled()) {
      for (const el of marked) el.removeAttribute('data-sc-client-hidden');
      marked.clear();
      fullScanNeeded = true;
      return;
    }
    if (!visible() || !document.body) return;
    if (fullScanNeeded) { scan(document); fullScanNeeded = false; }
    const regions = document.querySelectorAll('.header,.announcements,.announcementBannerContainer');
    if (!regions.length) return;
    observer = new MutationObserver(records => {
      counters.mutations += records.length;
      for (const record of records) {
        const parent = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const banner = parent?.closest(bannerSelector);
        if (banner) pending.add(banner);
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.isConnected && (node.matches(bannerSelector) || node.querySelector(bannerSelector))) pending.add(node);
        }
      }
      if (pending.size && timer === null) timer = setTimeout(flush, 150);
    });
    for (const region of regions) observer.observe(region, {childList: true, subtree: true, characterData: true});
  }
  const rescan = () => { fullScanNeeded = true; refresh(); };

  // The panel is built on first open, so startup adds one button and no settings DOM.
  function openSettings(open = true) {
    if (!shadow) return;
    if (open && !panel) {
      panel = Object.assign(document.createElement('section'), {id: 'panel', role: 'dialog', ariaLabel: 'GoLow settings', hidden: true});
      panel.innerHTML = `<button id="close" aria-label="Close settings">Close</button><h2>GoLow</h2>
        <label><input id="cleanup" type="checkbox"> Hide promotions</label>
        <label><input id="efficiency" type="checkbox"> Reduce background work</label>
        <label><input id="compact" type="checkbox"> Compact window</label>
        <label><input id="always_on_top" type="checkbox"> Keep window on top</label>
        <p id="recovery" hidden>Cleanup is disabled by the noclean recovery URL.</p>
        <p><a href="https://soundcloud.com/settings/streaming">Audio quality settings</a>: choose High quality for eligible Go+ tracks.</p>
        <p>Login and playback stay active in the background. Request-filter changes apply after reload. Ctrl+, opens settings.</p>`;
      shadow.appendChild(panel);
      $('close').addEventListener('click', () => { openSettings(false); $('open').focus(); });
      for (const key of KEYS) {
        $(key).addEventListener('change', event => {
          settings[key] = event.target.checked;
          cacheSettings();
          if (key === 'cleanup') rescan(); else initializeDocument();
          send(settings);
        });
      }
    }
    if (!panel) return;
    sync();
    panel.hidden = !open;
    if (open) $('close').focus();
  }
  function sync() {
    if (!panel) return;
    for (const key of KEYS) $(key).checked = settings[key];
    $('recovery').hidden = !recovery;
  }
  function mount() {
    if (!document.body) return;
    const host = Object.assign(document.createElement('div'), {id: 'sc-client-settings'});
    host.style.cssText = 'position:fixed;right:14px;top:58px;z-index:2147483647;';
    shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = `<style>
      :host{font:13px/1.5 system-ui,sans-serif;color:#eee;color-scheme:dark}button,a,label{font:inherit}
      button{background:#242427;color:#eee;border:1px solid #555;border-radius:6px;padding:7px 10px;cursor:pointer}button:hover{background:#38383c}
      button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #5cf2a8;outline-offset:2px}
      #panel{box-sizing:border-box;background:#151517;border:1px solid #555;border-radius:10px;padding:16px;width:320px;max-width:calc(100vw - 28px);
        max-height:calc(100vh - 100px);overflow:auto;box-shadow:0 6px 25px #0008;margin-top:6px}
      h2{font-size:16px;margin:0 0 10px}label{display:block;margin:10px 0}p{margin:9px 0;color:#bbb}a{color:#5cf2a8}#close{float:right}[hidden]{display:none!important}
      </style><button id="open" aria-label="GoLow settings" title="GoLow settings (Ctrl+,)">App settings</button>`;
    $('open').addEventListener('click', () => openSettings(!panel || panel.hidden));
    document.body.appendChild(host);
    refresh();
  }

  document.addEventListener('visibilitychange', rescan);
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === ',') { event.preventDefault(); openSettings(true); }
    if (event.key === 'Escape' && panel && !panel.hidden) openSettings(false);
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', rescan);
  window.__scClient = Object.freeze({
    setNativeHidden(hidden) { if (nativeHidden !== !!hidden) { nativeHidden = !!hidden; rescan(); } },
    update(value) {
      const changed = KEYS.some(k => typeof value[k] === 'boolean' && value[k] !== settings[k]);
      Object.assign(settings, value);
      cacheSettings();
      if (changed) rescan();
      sync();
    },
    openSettings,
    diagnostics: () => ({...counters, observer_active: !!observer, timer_active: timer !== null, settings_built: !!panel,
      visible: visible(), settings: {...settings}, recovery}),
  });
  if (!initializeDocument()) {
    const rootReady = new MutationObserver(() => { if (initializeDocument()) rootReady.disconnect(); });
    rootReady.observe(document, {childList: true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();
})();
