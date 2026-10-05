(() => {
  'use strict';
  if (window.top !== window || location.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) return;
  if (window.__scClient) return;

  const settings = Object.assign({cleanup:true, efficiency:true, compact:false, always_on_top:false}, window.__scInitialSettings);
  // Same-origin preferences avoid briefly restoring old startup values on each
  // full navigation. Rust validates and owns the persisted native settings.
  try {
    const cached = JSON.parse(localStorage.getItem('sc-client-settings-v1') || '{}');
    for (const key of Object.keys(settings)) if (typeof cached[key] === 'boolean') settings[key] = cached[key];
  } catch {}
  // Exact, small selectors hide known promotions before their first paint.
  // Structural :has exclusions preserve player/form/consent containers.
  const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);
  const explicitSelectors = [
    '.upsellBanner','.premiumUpsell','.mobileAppsButtons','.appBanner',
    '[data-testid="promoted-track"]','[data-testid="upsell-banner"]',
    '[data-testid="artist-pro-banner"]','.artistProBanner','.artistUpsell',
    '.homeCreditTracker','a[href="/go"]','a[href="/pro"]',
    'a[href^="/go?"]','a[href^="/pro?"]','a[href^="https://artists.soundcloud.com"]'
  ];
  const protectedSelector = 'audio,video,input,form,[role="dialog"],.playControls,.waveform,.playbackTimeline,button[aria-label*="Play"],button[aria-label*="Pause"]';
  const guarded = ':not(html,body,#root,#app,#main,#__next):not(:is('+protectedSelector+')):not(:has('+protectedSelector+')):not(:is(.playControls *,.waveform *,.playbackTimeline *))';
  const promoCss = explicitSelectors.map(selector=>'html[data-sc-cleanup] '+selector+guarded).join(',')+'{display:none!important}';
  const bannerSelector = '.announcementBanner,.announcementBanner__content';
  // Playlist tiles keep a SMIL buffering spinner inside a play button that stays
  // hidden until hover. Hidden SMIL still forces style and layout every frame, so
  // stop rendering it exactly while SoundCloud's own rules keep the button hidden.
  const idleSpinnerCss = ['.playableTile[data-playbutton="never"] .playableTile__playButton',
    '.playableTile[data-playbutton="hover"]:not(.m-playing) .playableTile__artwork:not(:hover) .playableTile__playButton:not(.forceVisibility)']
    .map(button=>'html[data-sc-efficiency] '+button+' svg:has(animate,animateTransform)').join(',')+'{display:none!important}';
  const marked = new Set(), pending = new Set();
  let observer=null, timer=null, style=null, host=null, shadow=null, nativeHidden=false;
  let fullScanNeeded=true, status=null, settingsBuilt=false;
  const counters={scans:0,mutations:0,candidates:0};
  const visible=()=>!document.hidden&&!nativeHidden;
  const markRoot=()=>{const root=document.documentElement;root.toggleAttribute('data-sc-cleanup',cleanupEnabled());root.toggleAttribute('data-sc-efficiency',!!settings.efficiency);};
  const cleanupEnabled=()=>settings.cleanup&&!recovery;
  const send=value=>{if(window.ipc&&typeof window.ipc.postMessage==='function')window.ipc.postMessage(JSON.stringify(value));};
  const cacheSettings=()=>{try{const value=JSON.stringify(settings);if(localStorage.getItem('sc-client-settings-v1')!==value)localStorage.setItem('sc-client-settings-v1',value);}catch{}};

  function preconnect(){
    if(!settings.efficiency||!document.documentElement)return;
    for(const href of ['https://api-v2.soundcloud.com','https://a-v2.sndcdn.com','https://i1.sndcdn.com']){
      if(document.querySelector('link[rel="preconnect"][href="'+href+'"]'))continue;
      const link=document.createElement('link');link.rel='preconnect';link.href=href;link.crossOrigin='anonymous';
      (document.head||document.documentElement).appendChild(link);
    }
  }
  function installStyle(){
    if(style||!document.documentElement)return;
    style=document.createElement('style');style.id='sc-client-style';
    style.textContent=promoCss+idleSpinnerCss+'html[data-sc-cleanup] [data-sc-client-hidden]{display:none!important}';
    (document.head||document.documentElement).appendChild(style);
  }
  function scan(root){
    if(!cleanupEnabled()||!visible()||!root||(root!==document&&!root.isConnected))return;
    counters.scans++;
    const candidates=[];
    if(root.nodeType===1&&root.matches(bannerSelector))candidates.push(root);
    if(root.querySelectorAll)candidates.push(...root.querySelectorAll(bannerSelector));
    for(const el of candidates){
      counters.candidates++;
      if(el.matches(protectedSelector)||el.querySelector(protectedSelector)||el.closest('.playControls,.waveform,.playbackTimeline'))continue;
      if(!/get heard by up to 100 listeners|unlock artist tools|try artist pro|uploading tracks just got/i.test(el.textContent||''))continue;
      el.setAttribute('data-sc-client-hidden','');marked.add(el);
    }
    for(const el of marked)if(!el.isConnected)marked.delete(el);
  }
  function flush(){
    timer=null;const roots=[...pending];pending.clear();
    if(!cleanupEnabled()||!visible())return;
    for(const root of roots)if(!roots.some(other=>other!==root&&other.contains&&other.contains(root)))scan(root);
  }
  function stop(){
    if(observer){observer.disconnect();observer=null;}
    if(timer!==null){clearTimeout(timer);timer=null;}
    pending.clear();
  }
  function refreshLifecycle(){
    installStyle();
    if(document.documentElement)markRoot();
    stop();
    if(!cleanupEnabled()){
      for(const el of marked)el.removeAttribute('data-sc-client-hidden');marked.clear();fullScanNeeded=true;return;
    }
    if(!visible()||!document.body)return;
    if(fullScanNeeded){scan(document);fullScanNeeded=false;}
    // Only known notice containers need a text-based fallback. Exact promo
    // classes anywhere on the page are handled by CSS without JS callbacks.
    const regions=[...document.querySelectorAll('.header,.announcements,.announcementBannerContainer')];
    if(!regions.length)return;
    observer=new MutationObserver(records=>{
      counters.mutations+=records.length;
      for(const record of records){
        const parent=record.target.nodeType===1?record.target:record.target.parentElement;
        const banner=parent?.closest(bannerSelector);if(banner)pending.add(banner);
        for(const node of record.addedNodes){
          if(node.nodeType!==1||!node.isConnected)continue;
          if(node.matches(bannerSelector)||node.querySelector(bannerSelector))pending.add(node);
        }
      }
      if(pending.size&&timer===null)timer=setTimeout(flush,150);
    });
    for(const region of regions)observer.observe(region,{childList:true,subtree:true,characterData:true});
  }

  function updateStatus() {
    if (!shadow || !settingsBuilt) return;
    const text = status ? `Cache: ${status.cache_mib == null ? 'calculating' : status.cache_mib.toFixed(1)+' MiB'}. Background memory: ${status.low_memory ? 'Low' : 'Normal'}. Optional requests skipped: ${(status.artist_requests_blocked || 0) + (status.advertising_requests_blocked || 0)}.` : 'Cache size is calculated only when settings are opened.';
    shadow.getElementById('status').textContent = text;
    for (const key of ['cleanup','efficiency','compact','always_on_top']) shadow.getElementById(key).checked = !!settings[key];
    shadow.getElementById('recovery').hidden = !recovery;
  }

  function settingsOpen(open = true) {
    if (!shadow) return;
    if (open && !settingsBuilt) buildSettings();
    if (!settingsBuilt) return;
    shadow.getElementById('panel').hidden = !open;
    if (open) { send({type:'status'}); updateStatus(); shadow.getElementById('close').focus(); }
  }

  function mount(){
    if(!document.body)return;
    preconnect();installStyle();
    host=document.createElement('div');host.id='sc-client-settings';
    host.style.cssText='position:fixed;right:14px;top:58px;z-index:2147483647;';
    shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML='<style>:host{font:13px system-ui;color-scheme:dark}button{background:#242427;color:#eee;border:1px solid #555;border-radius:6px;padding:7px 10px;cursor:pointer}</style><button id="open" aria-label="SoundCloud app settings" title="App settings (Ctrl+,)">App settings</button>';
    shadow.getElementById('open').addEventListener('click',()=>settingsOpen(true));
    document.body.appendChild(host);refreshLifecycle();
  }
  function buildSettings(){
    settingsBuilt=true;
    shadow.innerHTML = `<style>
      :host{font:13px/1.5 system-ui,sans-serif;color:#eee;color-scheme:dark}button,a,label{font:inherit}button,a{cursor:pointer}button{background:#242427;color:#eee;border:1px solid #555;border-radius:6px;padding:7px 10px}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #ff5500;outline-offset:2px}button:hover{background:#38383c}#panel{box-sizing:border-box;background:#151517;border:1px solid #555;border-radius:10px;padding:16px;width:320px;max-width:calc(100vw - 28px);max-height:calc(100vh - 100px);overflow:auto;box-shadow:0 6px 25px #0008;margin-top:6px}h2{font-size:16px;margin:0 0 10px}label{display:block;margin:10px 0}p{margin:9px 0;color:#bbb}a{color:#ff9866}#close{float:right}#status{font-size:12px}[hidden]{display:none!important}
      </style>
      <button id="open" aria-label="SoundCloud app settings" title="App settings (Ctrl+,)">App settings</button>
      <section id="panel" role="dialog" aria-label="SoundCloud app settings" hidden>
      <button id="close" aria-label="Close settings">Close</button><h2>SoundCloud Go+</h2>
      <label><input id="cleanup" type="checkbox"> Hide promotions</label>
      <label><input id="efficiency" type="checkbox"> Reduce background work</label>
      <label><input id="compact" type="checkbox"> Compact window</label>
      <label><input id="always_on_top" type="checkbox"> Keep window on top</label>
      <p id="recovery" hidden>Cleanup is disabled by the noclean recovery URL.</p>
      <p><a href="https://soundcloud.com/settings/streaming">Audio quality settings</a></p>
      <p>Choose High quality audio for eligible Go+ tracks. This app does not infer quality from your subscription.</p>
      <p id="status"></p><p>Login and playback stay active in the background. No automatic cache clearing. Request-filter changes take full effect after reload.</p>
      <p>Ctrl+, opens settings. Standard SoundCloud media controls remain available.</p>
      </section>`;
    shadow.getElementById('open').addEventListener('click', () => settingsOpen(shadow.getElementById('panel').hidden));
    shadow.getElementById('close').addEventListener('click', () => { settingsOpen(false); shadow.getElementById('open').focus(); });
    for (const key of ['cleanup','efficiency','compact','always_on_top']) {
      shadow.getElementById(key).addEventListener('change', event => {
        settings[key] = event.target.checked;
        cacheSettings();
        if (key === 'cleanup') { fullScanNeeded = true; refreshLifecycle(); } else if (key === 'efficiency') markRoot();
        send({type:'settings', value:settings});
      });
    }
    updateStatus();
  }

  document.addEventListener('visibilitychange', () => { fullScanNeeded = true; refreshLifecycle(); });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === ',') { event.preventDefault(); settingsOpen(true); }
    if (event.key === 'Escape' && shadow && settingsBuilt && !shadow.getElementById('panel').hidden) settingsOpen(false);
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', () => { fullScanNeeded = true; refreshLifecycle(); });
  window.__scClient = Object.freeze({
    setNativeHidden(hidden) { if(nativeHidden===!!hidden)return;nativeHidden=!!hidden;fullScanNeeded=true;refreshLifecycle(); },
    update(value) {const changed=Object.keys(settings).some(k=>typeof value[k]==='boolean'&&value[k]!==settings[k]);Object.assign(settings,value);cacheSettings();if(changed){fullScanNeeded=true;refreshLifecycle();}updateStatus();},
    status(value) { status = value; updateStatus(); },
    openSettings:settingsOpen,
    diagnostics() { return {...counters, observer_active:!!observer, timer_active:timer !== null, hidden_count:document.querySelectorAll(explicitSelectors.join(',')).length+marked.size,settings_built:settingsBuilt, visible:visible(), settings:{...settings}, recovery}; }
  });
  function initializeDocument(){
    if(!document.documentElement)return false;
    preconnect();installStyle();markRoot();return true;
  }
  if(!initializeDocument()){
    const rootReady=new MutationObserver(()=>{if(initializeDocument())rootReady.disconnect();});
    rootReady.observe(document,{childList:true});
    document.addEventListener('DOMContentLoaded',()=>{rootReady.disconnect();initializeDocument();},{once:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();
})();
