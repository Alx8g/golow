(() => {
  'use strict';
  if (window.top !== window || location.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) return;
  if (window.__scClient) return;

  const settings = Object.assign({cleanup:true, efficiency:true, compact:false, always_on_top:false}, window.__scInitialSettings);
  const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);
  const promoSelector = [
    '.upsellBanner', '.premiumUpsell', '.mobileAppsButtons', '.appBanner',
    '[data-testid="promoted-track"]', '[data-testid="upsell-banner"]',
    '[data-testid="artist-pro-banner"]', '.artistProBanner', '.artistUpsell',
    '.homeCreditTracker',
    '.announcementBanner', '.announcementBanner__content',
    'a[href="/go"]', 'a[href="/pro"]', 'a[href^="/go?"]', 'a[href^="/pro?"]',
    'a[href^="https://artists.soundcloud.com"]'
  ].join(',');
  // Artist Tools is an embedded iframe inside homeCreditTracker. Hide its exact
  // host module, not artistShortcutsModule, which contains the user's New Tracks.
  const explicitPromo = /^(?:upsellBanner|premiumUpsell|mobileAppsButtons|appBanner|artistProBanner|artistUpsell|homeCreditTracker)$/;
  const protectedSelector = 'audio,video,input,form,[role="dialog"],.playControls,button[aria-label*="Play"],button[aria-label*="Pause"]';
  const hidden = new Set();
  const pending = new Set();
  let observer = null, timer = null, style = null, host = null, shadow = null, nativeHidden = false;
  let fullScanNeeded = true, status = null;
  const counters = {scans:0, mutations:0, candidates:0};
  const visible = () => !document.hidden && !nativeHidden;
  const cleanupEnabled = () => settings.cleanup && !recovery && visible();
  const send = value => {
    if (window.ipc && typeof window.ipc.postMessage === 'function') window.ipc.postMessage(JSON.stringify(value));
  };

  function isPromo(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement || el === host) return false;
    if (['root','app','main','__next'].includes(el.id) || el.matches(protectedSelector) || el.querySelector(protectedSelector)) return false;
    if (el.tagName === 'A') return true;
    if ([...el.classList].some(name => explicitPromo.test(name))) return true;
    if (['promoted-track','upsell-banner','artist-pro-banner'].includes(el.getAttribute('data-testid'))) return true;
    return /get heard by up to 100 listeners|unlock artist tools|try artist pro|uploading tracks just got/i.test(el.textContent || '');
  }

  function scan(root) {
    if (!cleanupEnabled() || !root || (root !== document && !root.isConnected)) return;
    counters.scans++;
    const candidates = [];
    if (root.nodeType === 1 && root.matches(promoSelector)) candidates.push(root);
    if (root.querySelectorAll) candidates.push(...root.querySelectorAll(promoSelector));
    for (const el of candidates) {
      counters.candidates++;
      if (!isPromo(el)) continue;
      el.setAttribute('data-sc-client-hidden', '');
      hidden.add(el);
    }
    for (const el of hidden) if (!el.isConnected) hidden.delete(el);
  }

  function flush() {
    timer = null;
    if (!cleanupEnabled()) { pending.clear(); return; }
    const roots = [...pending]; pending.clear();
    for (const root of roots) if (!roots.some(other => other !== root && other.contains && other.contains(root))) scan(root);
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    pending.clear();
  }

  function refreshLifecycle() {
    stop();
    if (!settings.cleanup || recovery) {
      for (const el of hidden) el.removeAttribute('data-sc-client-hidden');
      hidden.clear();
      fullScanNeeded = true;
    }
    if (!cleanupEnabled() || !document.body) return;
    if (fullScanNeeded) { scan(document); fullScanNeeded = false; }
    observer = new MutationObserver(records => {
      counters.mutations += records.length;
      for (const record of records) {
        for (const node of record.removedNodes) {
          for (const el of hidden) if (node === el || (node.contains && node.contains(el))) hidden.delete(el);
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node === host || node === style) continue;
          pending.add(node);
          if (pending.size > 128) { pending.clear(); pending.add(document); break; }
        }
      }
      if (pending.size && timer === null) timer = setTimeout(flush, 150);
    });
    observer.observe(document.body, {childList:true, subtree:true});
  }

  function updateStatus() {
    if (!shadow) return;
    const text = status ? `Cache: ${status.cache_mib.toFixed(1)} MiB. Background memory: ${status.low_memory ? 'Low' : 'Normal'}.` : 'Cache size is calculated only when settings are opened.';
    shadow.getElementById('status').textContent = text;
    for (const key of ['cleanup','efficiency','compact','always_on_top']) shadow.getElementById(key).checked = !!settings[key];
    shadow.getElementById('recovery').hidden = !recovery;
  }

  function settingsOpen(open = true) {
    if (!shadow) return;
    shadow.getElementById('panel').hidden = !open;
    if (open) { send({type:'status'}); updateStatus(); shadow.getElementById('close').focus(); }
  }

  function mount() {
    if (!document.body) return;
    style = document.createElement('style');
    style.id = 'sc-client-style';
    style.textContent = '[data-sc-client-hidden]{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
    host = document.createElement('div'); host.id = 'sc-client-settings';
    host.style.cssText = 'position:fixed;right:14px;top:58px;z-index:2147483647;';
    shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>
      :host{font:13px/1.5 system-ui,sans-serif;color:#eee;color-scheme:dark}button,a,label{font:inherit}button,a{cursor:pointer}button{background:#242427;color:#eee;border:1px solid #555;border-radius:6px;padding:7px 10px}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #ff5500;outline-offset:2px}button:hover{background:#38383c}#panel{box-sizing:border-box;background:#151517;border:1px solid #555;border-radius:10px;padding:16px;width:320px;max-width:calc(100vw - 28px);max-height:calc(100vh - 100px);overflow:auto;box-shadow:0 6px 25px #0008;margin-top:6px}h2{font-size:16px;margin:0 0 10px}label{display:block;margin:10px 0}p{margin:9px 0;color:#bbb}a{color:#ff9866}#close{float:right}#status{font-size:12px}[hidden]{display:none!important}
      </style>
      <button id="open" aria-label="SoundCloud app settings" title="App settings (Ctrl+,)">App settings</button>
      <section id="panel" role="dialog" aria-label="SoundCloud app settings" hidden>
      <button id="close" aria-label="Close settings">Close</button><h2>SoundCloud Go+</h2>
      <label><input id="cleanup" type="checkbox"> Hide promotions</label>
      <label><input id="efficiency" type="checkbox"> Reduce background memory</label>
      <label><input id="compact" type="checkbox"> Compact window</label>
      <label><input id="always_on_top" type="checkbox"> Keep window on top</label>
      <p id="recovery" hidden>Cleanup is disabled by the noclean recovery URL.</p>
      <p><a href="https://soundcloud.com/settings/streaming">Audio quality settings</a></p>
      <p>Choose High quality audio for eligible Go+ tracks. This app does not infer quality from your subscription.</p>
      <p id="status"></p><p>Login and playback stay active in the background. No automatic cache clearing.</p>
      <p>Ctrl+, opens settings. Standard SoundCloud media controls remain available.</p>
      </section>`;
    document.body.appendChild(host);
    shadow.getElementById('open').addEventListener('click', () => settingsOpen(shadow.getElementById('panel').hidden));
    shadow.getElementById('close').addEventListener('click', () => { settingsOpen(false); shadow.getElementById('open').focus(); });
    for (const key of ['cleanup','efficiency','compact','always_on_top']) {
      shadow.getElementById(key).addEventListener('change', event => {
        settings[key] = event.target.checked;
        if (key === 'cleanup') { fullScanNeeded = true; refreshLifecycle(); }
        send({type:'settings', value:settings});
      });
    }
    updateStatus(); refreshLifecycle();
  }

  document.addEventListener('visibilitychange', () => { fullScanNeeded = true; refreshLifecycle(); });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === ',') { event.preventDefault(); settingsOpen(true); }
    if (event.key === 'Escape' && shadow && !shadow.getElementById('panel').hidden) settingsOpen(false);
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', () => { fullScanNeeded = true; refreshLifecycle(); });
  window.__scClient = Object.freeze({
    setNativeHidden(hidden) { nativeHidden = !!hidden; fullScanNeeded = true; refreshLifecycle(); },
    update(value) { Object.assign(settings, value); fullScanNeeded = true; refreshLifecycle(); updateStatus(); },
    status(value) { status = value; updateStatus(); },
    openSettings:settingsOpen,
    diagnostics() { return {...counters, observer_active:!!observer, timer_active:timer !== null, hidden_count:hidden.size, visible:visible(), settings:{...settings}, recovery}; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();
})();
