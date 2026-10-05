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

  // Generic upsell selectors are guarded so a match can never hide the player, a form, a dialog or consent.
  const protectedSelector = 'audio,video,input,form,[role="dialog"],.playControls,.waveform,.playbackTimeline,button[aria-label*="Play"],button[aria-label*="Pause"]';
  const guarded = `:not(html,body,#root,#app,#main,#__next):not(:is(${protectedSelector})):not(:has(${protectedSelector}))` +
    ':not(:is(.playControls *,.waveform *,.playbackTimeline *))';
  const promos = ['.upsellBanner', '.premiumUpsell', '.mobileAppsButtons', '.appBanner', '[data-testid="promoted-track"]',
    '[data-testid="upsell-banner"]', '[data-testid="artist-pro-banner"]', '.artistProBanner', '.artistUpsell', '.homeCreditTracker',
    'a[href="/go"]', 'a[href="/pro"]', 'a[href^="/go?"]', 'a[href^="/pro?"]', 'a[href^="https://artists.soundcloud.com"]',
    'a[href^="https://checkout.soundcloud.com"]'].map(s => s + guarded);
  // Exact SoundCloud modules a listener never needs: creator tools, follow suggestions,
  // app-store badges, footer links and banners that sell a plan.
  const clutter = ['.header__upsellWrapper', '.header__forArtistsButton', '.header__soundInput', '.header__upload', '.whoToFollowModule',
    '.mobileApps', '.l-footer', '.l-product-banners .banner:has(a[href^="https://checkout.soundcloud.com"])'];
  // SoundCloud's layouts are fixed 960px columns. Below that, drop the sidebar, stack the
  // search filters above the results and keep the header on one row.
  const narrow = [':is(.l-container,.l-fluid-fixed,.l-main,.l-fixed-top,.l-fixed-left,.searchTitle,.searchOptions,.searchOptions *){width:auto!important}',
    ':is(.l-fixed-top,.l-fixed-left,.searchOptions,.searchOptions *){position:static!important;height:auto!important}',
    '.l-main{margin:0!important;padding-right:0!important;border-right:0!important}', '.l-fixed-fluid .l-main{padding-top:0!important}',
    '.searchOptions__navigation{display:flex;flex-wrap:wrap;gap:4px 16px}', '.searchOptions__navigationItem{padding:0!important}',
    '.l-sidebar-right{display:none!important}', '.header__left{display:flex;flex:none}', '.header__logo{width:44px!important;overflow:hidden}',
    ':is(.header__right,.header__loginMenu,.header__navWrapper){white-space:nowrap}', 'body{overflow-x:hidden}', '.playControls__control{flex-shrink:0}'];
  // Mini player: only the control bar, filling the window, with the timeline given room.
  const mini = ['body{overflow:hidden!important}', ':is(body>:not(#app),#app>:not(.playControls)){display:none!important}',
    '.playControls{top:0!important;height:auto!important;display:flex!important;align-items:center;visibility:visible!important}',
    '.playControls__inner{flex:1;transform:none!important}', '.playControls__wrapper{width:auto!important}', '.playControls__control{flex-shrink:0}',
    '.playControls__soundBadge{flex:0 1 220px!important;width:auto!important;min-width:0}', '.playControls__timeline{flex:1 1 140px!important;min-width:140px}',
    ':is(.playControls__shuffle,.playControls__repeat,.playControls__volume,.playControls__queue,.playbackSoundBadge__actions){display:none!important}'];
  // Playlist tiles keep a SMIL buffering spinner inside a play button that stays hidden
  // until hover. Hidden SMIL still forces style and layout every frame, so stop rendering
  // it exactly while SoundCloud's own rules keep the button hidden.
  const idleSpinners = ['.playableTile[data-playbutton="never"] .playableTile__playButton',
    '.playableTile[data-playbutton="hover"]:not(.m-playing) .playableTile__artwork:not(:hover) .playableTile__playButton:not(.forceVisibility)'];
  const css = [...promos, ...clutter].map(s => `html[data-sc-cleanup] ${s}`).join(',') + '{display:none!important}' +
    idleSpinners.map(s => `html[data-sc-efficiency] ${s} svg:has(animate,animateTransform)`).join(',') + '{display:none!important}' +
    'html[data-sc-cleanup]:has(>body.theme-dark){color-scheme:dark}' +
    `@media (max-width:999px){${narrow.map(rule => 'html[data-sc-cleanup] ' + rule).join('')}}` +
    mini.map(rule => 'html[data-sc-mini] ' + rule).join('');

  let host = null, shadow = null, panel = null, placer = null;
  const $ = id => shadow.getElementById(id);
  const send = value => window.ipc?.postMessage?.(JSON.stringify(value));
  const save = () => {
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
        (document.head || root).appendChild(Object.assign(document.createElement('link'), {rel: 'preconnect', href, crossOrigin: 'anonymous'}));
      }
    }
    if (!document.getElementById('sc-client-style')) {
      (document.head || root).appendChild(Object.assign(document.createElement('style'), {id: 'sc-client-style', textContent: css}));
    }
    root.toggleAttribute('data-sc-cleanup', settings.cleanup && !recovery);
    root.toggleAttribute('data-sc-efficiency', settings.efficiency);
    root.toggleAttribute('data-sc-mini', settings.compact);
    return true;
  }

  // The gear sits in SoundCloud's own header, left of the "more" menu, so it flows with the
  // header at any width. The mini player shows an expand button in the control bar instead.
  function place() {
    if (!document.body) return;
    if (!host) {
      host = Object.assign(document.createElement('div'), {id: 'sc-client-settings'});
      shadow = host.attachShadow({mode: 'open'});
      shadow.innerHTML = `<style>
        :host{position:relative;display:flex;align-items:center;margin:0 4px;font:13px/1.4 system-ui,sans-serif;color:#eee;color-scheme:dark}
        :host([data-floating]){position:fixed;top:8px;right:12px;z-index:2147483647}
        .icon{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:none;color:#ccc;cursor:pointer}
        .icon:hover,.icon[aria-expanded="true"]{color:#fff;background:#ffffff1a}:host([data-mini]) #open,:host(:not([data-mini])) #expand{display:none}
        :focus-visible{outline:2px solid #5cf2a8;outline-offset:2px}
        #panel{position:absolute;top:calc(100% + 6px);right:0;width:248px;box-sizing:border-box;padding:6px;background:#1c1c1e;border:1px solid #333;
          border-radius:8px;box-shadow:0 8px 24px #000a}
        h2{margin:6px 8px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888}
        label,a{display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:6px;color:#eee;text-decoration:none;cursor:pointer}
        label:hover,a:hover{background:#ffffff12}p{margin:4px 8px;color:#999;font-size:12px}[hidden]{display:none!important}
        input{appearance:none;flex:none;position:relative;width:30px;height:18px;margin:0;border-radius:9px;background:#48484c;cursor:pointer;transition:background .15s}
        input::before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
        input:checked{background:#5cf2a8}input:checked::before{transform:translateX(12px)}
        </style>
        <button id="open" class="icon" aria-label="GoLow settings" aria-expanded="false" title="GoLow settings (Ctrl+,)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button>
        <button id="expand" class="icon" aria-label="Exit mini player" title="Exit mini player"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></button>`;
      $('open').addEventListener('click', () => openSettings(!panel || panel.hidden));
      $('expand').addEventListener('click', () => change('compact', false));
    }
    if (!placer) {
      // SoundCloud renders its header after load and swaps it out once more. The callback is
      // a single check, so the button returns in the same frame it was dropped.
      placer = new MutationObserver(() => { if (!placed()) place(); });
      placer.observe(document.body, {childList: true, subtree: true});
    }
    host.toggleAttribute('data-mini', settings.compact);
    const target = document.querySelector(settings.compact ? '.playControls__elements' : '.header__right > .header__navMenu');
    if (!target || placed()) return;
    host.removeAttribute('data-floating');
    settings.compact ? target.append(host) : target.before(host);
  }
  const placed = () => host.isConnected && !host.hasAttribute('data-floating') &&
    host.parentElement.matches(settings.compact ? '.playControls__elements' : '.header__right');

  function change(key, value) {
    settings[key] = value;
    save();
    if (key === 'compact') openSettings(false);
    apply();
    send(settings);
  }
  function apply() {
    initializeDocument();
    place();
    if (!panel) return;
    for (const key of KEYS) $(key).checked = settings[key];
    $('recovery').hidden = !recovery;
  }

  // The panel is built on first open, so startup adds one button and no settings DOM.
  function openSettings(open = true) {
    if (open && settings.compact) return change('compact', false);
    place();
    if (!host) return;
    if (open && !host.isConnected) { host.toggleAttribute('data-floating', true); document.body.appendChild(host); }
    if (open && !panel) {
      panel = Object.assign(document.createElement('section'), {id: 'panel', role: 'dialog', ariaLabel: 'GoLow settings', hidden: true});
      panel.innerHTML = `<h2>GoLow</h2>
        <label>Clean up interface<input id="cleanup" type="checkbox" role="switch"></label>
        <label>Reduce background work<input id="efficiency" type="checkbox" role="switch"></label>
        <label>Mini player<input id="compact" type="checkbox" role="switch"></label>
        <label>Keep on top<input id="always_on_top" type="checkbox" role="switch"></label>
        <p id="recovery" hidden>Cleanup is off for this page (noclean).</p>
        <a id="quality" href="https://soundcloud.com/settings/streaming">Audio quality<span aria-hidden="true">›</span></a>`;
      shadow.appendChild(panel);
      for (const key of KEYS) $(key).addEventListener('change', event => change(key, event.target.checked));
      $('quality').addEventListener('click', () => openSettings(false));
      apply();
    }
    if (!panel) return;
    panel.hidden = !open;
    $('open').setAttribute('aria-expanded', open);
  }

  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === ',') { event.preventDefault(); openSettings(!panel || panel.hidden); }
    if (event.key === 'Escape' && panel && !panel.hidden) { openSettings(false); $('open').focus(); }
  });
  document.addEventListener('click', event => {
    if (panel && !panel.hidden && !event.composedPath().includes(host)) openSettings(false);
  });
  window.addEventListener('pageshow', place);
  window.__scClient = Object.freeze({
    update(value) { Object.assign(settings, value); save(); apply(); },
    openSettings,
    diagnostics: () => ({placed: !!host && placed(), settings_built: !!panel, slot: host?.parentElement?.className || null,
      settings: {...settings}, recovery}),
  });
  if (!initializeDocument()) {
    const rootReady = new MutationObserver(() => { if (initializeDocument()) rootReady.disconnect(); });
    rootReady.observe(document, {childList: true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place, {once: true}); else place();
})();
