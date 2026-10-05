(() => {
  'use strict';
  if (window.top !== window || location.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) return;
  if (window.__scClient) return;

  const PANEL = ['cleanup', 'efficiency', 'compact', 'always_on_top', 'comments', 'top_comments', 'autoplay', 'discord'];
  const KEYS = [...PANEL, 'mixes', 'played'];
  const settings = Object.assign({cleanup: true, efficiency: true, compact: false, always_on_top: false, comments: true, autoplay: true,
    mixes: true, played: true, top_comments: false, discord: false}, window.__scInitialSettings);
  // Same-origin preferences avoid briefly restoring old startup values on each
  // full navigation. Rust validates and owns the persisted native settings.
  try {
    const cached = JSON.parse(localStorage.getItem('sc-client-settings-v1') || '{}');
    for (const key of KEYS) if (typeof cached[key] === 'boolean') settings[key] = cached[key];
  } catch {}
  const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);

  // Feed filters need each track's length, which SoundCloud only draws on a canvas, and what
  // was played. Both come from the feed and history data the page downloads anyway.
  const lengths = new Map(), pathOf = url => { try { return new URL(url, location.origin).pathname; } catch { return null; } };
  let played = new Set();
  try { played = new Set(JSON.parse(localStorage.getItem('golow-played') || '[]')); } catch {}
  function remember(paths) {
    const fresh = paths.filter(at => at && !played.has(at));
    if (!fresh.length) return;
    for (const at of fresh) played.add(at);
    try { localStorage.setItem('golow-played', JSON.stringify([...played].slice(-5000))); } catch {}
    for (const item of document.querySelectorAll('[data-golow-seen]')) item.removeAttribute('data-golow-seen');
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (/^https:\/\/api-v2\.soundcloud\.com\/(stream|me\/play-history)/.test(String(url))) this.addEventListener('load', readFeedData);
    return xhrOpen.call(this, method, url, ...rest);
  };
  function readFeedData() {
    const history = [];
    try {
      for (const item of JSON.parse(this.responseText).collection || []) {
        const sound = item.track || item.playlist, at = sound && pathOf(sound.permalink_url);
        if (!at) continue;
        if (this.responseURL.includes('/play-history')) history.push(at); else lengths.set(at, sound.duration || 0);
      }
    } catch {}
    remember(history);
    for (const item of document.querySelectorAll('[data-golow-seen]')) item.removeAttribute('data-golow-seen');
    filterFeed();
  }

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
  // Readability fixes for the redesign: a visible liked state and full-contrast waveforms
  // on new track pages, plus room for content on wide monitors.
  const polish = ['button[aria-label="Unlike"]{color:#f50!important}', '[role="slider"][aria-label="Waveform"] svg>g{opacity:1!important}'];
  const wide = ['.l-container{width:min(1840px,calc(100vw - 64px))!important}', '.l-main{width:auto!important}'];
  const feedFilters = () => (settings.mixes ? [] : ['.soundList__item[data-golow-long]']).concat(settings.played ? [] : ['.soundList__item[data-golow-played]']);
  const waveformComments = ['.waveform :is(.commentPlaceholder,.commentPopover,canvas.waveformCommentsNode)', 'div:has(>[role="slider"][aria-label="Waveform"]) ol'];
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
  let host = null, shadow = null, panel = null, placer = null, wheelBar = null, nowPlaying, autoplayBusy = false;
  const $ = id => shadow.getElementById(id);
  const send = value => window.ipc?.postMessage?.(JSON.stringify(value));
  const save = () => {
    try {
      const value = JSON.stringify(settings);
      if (localStorage.getItem('sc-client-settings-v1') !== value) localStorage.setItem('sc-client-settings-v1', value);
    } catch {}
  };

  // Rules live in constructed stylesheets rebuilt from settings. SoundCloud's React pages
  // re-render <head> and <html>, but cannot remove a sheet that is not in the DOM.
  const sheet = new CSSStyleSheet(), frameSheets = new Map();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const rules = list => list.map(rule => 'html:root ' + rule).join('');
  const hide = list => list.map(selector => 'html:root ' + selector).join(',') + '{display:none!important}';
  function restyle() {
    const clean = settings.cleanup && !recovery;
    const shared = (clean ? hide([...promos, ...clutter]) + rules(polish) + 'html:root:has(>body.theme-dark){color-scheme:dark}' +
      `@media (min-width:1600px){${rules(wide)}}@media (max-width:999px){${rules(narrow)}}` : '') +
      (settings.efficiency ? hide(idleSpinners.map(s => s + ' svg:has(animate,animateTransform)')) : '') +
      (settings.comments ? '' : hide(waveformComments));
    sheet.replaceSync(shared + hide(['[data-golow-filtered]', ...feedFilters()]) + (settings.compact ? rules(mini) : ''));
    for (const [frame, frameSheet] of frameSheets) {
      frameSheet.replaceSync(shared);
      if (frame.contentDocument) sortComments(frame.contentDocument);
    }
  }
  restyle();
  // Redesigned track pages load in a same-origin /n/ iframe that WebView2 does not inject
  // into, so style each one from here once it loads. Sheets must come from the frame's realm.
  document.addEventListener('load', event => {
    const frame = event.target, doc = frame.tagName === 'IFRAME' && frame.contentDocument;  // null when cross-origin
    if (!doc || !doc.location.pathname.startsWith('/n/')) return;
    for (const old of frameSheets.keys()) if (!old.isConnected) frameSheets.delete(old);
    const frameSheet = new frame.contentWindow.CSSStyleSheet();
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, frameSheet];
    frameSheets.set(frame, frameSheet);
    restyle();
    new MutationObserver(() => sortComments(doc)).observe(doc.documentElement, {childList: true, subtree: true});
  }, true);
  // Most-liked comments first. CSS order reorders the flex list without moving React's nodes.
  const likesOf = item => {
    for (let node = item.querySelector('button[aria-label$="ike"]'); node && node !== item; node = node.parentElement) {
      if (/^\d+$/.test(node.textContent.trim())) return Number(node.textContent.trim());
    }
    return 0;
  };
  function sortComments(doc) {
    for (const item of doc.querySelectorAll('ul[aria-label="Comments"] > li')) {
      const likes = settings.top_comments ? likesOf(item) : 0;
      const order = likes ? String(-likes) : '';
      if (item.style.order !== order) item.style.order = order;
    }
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
      placer = new MutationObserver(() => {
        if (!placed()) place();
        if (location.pathname === '/feed') { filterFeed(); feedSwitches(); } else if (/^\/[^/]+\/likes$/.test(location.pathname)) likesTools();
      });
      placer.observe(document.body, {childList: true, subtree: true});
    }
    host.toggleAttribute('data-mini', settings.compact);
    const bar = document.querySelector('.playControls');
    if (bar && bar !== wheelBar) {
      wheelBar = bar;
      // The wheel over the speaker icon drives SoundCloud's own Shift+arrow volume shortcut.
      // Bound to the bar only, so page scrolling never waits on this listener.
      bar.addEventListener('wheel', event => {
        if (!event.target.closest('.playControls__volume')) return;
        event.preventDefault();
        const up = event.deltaY < 0;
        document.dispatchEvent(new KeyboardEvent('keydown', {key: up ? 'ArrowUp' : 'ArrowDown', keyCode: up ? 38 : 40, shiftKey: true, bubbles: true}));
      }, {passive: false});
      new MutationObserver(watchPlayer).observe(bar, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'title']});
      watchPlayer();
    }
    const target = document.querySelector(settings.compact ? '.playControls__elements' : '.header__right > .header__navMenu');
    if (!target || placed()) return;
    host.removeAttribute('data-floating');
    settings.compact ? target.append(host) : target.before(host);
  }
  // Tells the app what is playing (window title, close to tray), and switches SoundCloud's
  // autoplay station back off whenever it re-enables it against the user's choice.
  function watchPlayer() {
    const title = document.querySelector('.playControls__play.playing') && document.querySelector('.playbackSoundBadge__titleLink')?.title;
    const now = title ? `${title} – ${document.querySelector('.playbackSoundBadge__lightLink')?.title || ''}` : null;
    if (now !== nowPlaying) {
      send({now: nowPlaying = now});
      if (now) {
        autoplayOff();
        remember([pathOf(document.querySelector('.playbackSoundBadge__titleLink')?.getAttribute('href'))]);
        filterFeed();
      }
      followShuffle(true);
      if (now) trackPosition(true);
    } else {
      followShuffle(false);
      trackPosition(false);
    }
    if (!settings.autoplay) document.querySelector('.queueFallback__toggle .sc-toggle-on input')?.click();
  }
  // Resume where you left off: SoundCloud restores the last track after a restart but starts it
  // at 0:00, so remember the position and seek there the first time it plays again.
  let resume = null, resumed = false, savedAt = -1;
  try { resume = JSON.parse(localStorage.getItem('golow-resume')); } catch {}
  function trackPosition(trackChanged) {
    const at = pathOf(document.querySelector('.playbackSoundBadge__titleLink')?.getAttribute('href'));
    const [passed, total] = [seconds('.playbackTimeline__timePassed'), seconds('.playbackTimeline__duration')];
    if (trackChanged && !resumed) {
      resumed = true;
      if (resume?.at === at && passed < 5 && resume.t >= 30 && resume.t < total - 30) seek(resume.t / total);
    }
    if (at && nowPlaying && Math.floor(passed / 5) !== savedAt) {
      savedAt = Math.floor(passed / 5);
      try { localStorage.setItem('golow-resume', JSON.stringify({at, t: passed})); } catch {}
    }
  }
  function seek(fraction) {
    const bar = document.querySelector('.playbackTimeline__progressWrapper'), box = bar?.getBoundingClientRect();
    if (!box?.width) return;
    const point = {bubbles: true, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2};
    for (const type of ['mousedown', 'mouseup', 'click']) bar.dispatchEvent(new MouseEvent(type, point));
  }
  // SoundCloud only renders its autoplay switch inside the open queue panel, and turns it
  // back on as tracks change. Open the panel invisibly, switch it off, close it again.
  async function autoplayOff() {
    const button = document.querySelector('.playbackSoundBadge__showQueue'), queue = document.querySelector('.playControls__queue');
    if (settings.autoplay || autoplayBusy || !button || !queue || document.querySelector('.queueFallback__toggle')) return;
    autoplayBusy = true;
    queue.style.visibility = 'hidden';
    button.click();
    for (let i = 0; i < 30 && !document.querySelector('.queueFallback__toggle'); i++) await new Promise(r => setTimeout(r, 50));
    document.querySelector('.queueFallback__toggle .sc-toggle-on input')?.click();
    button.click();
    queue.style.visibility = '';
    autoplayBusy = false;
  }
  // Feed: hide mixes over 20 minutes and tracks already played, with switches next to
  // SoundCloud's own Reposts switch.
  function filterFeed() {
    if (location.pathname !== '/feed') return;
    for (const item of document.querySelectorAll('.soundList__item:not([data-golow-seen])')) {
      const at = item.querySelector('a.soundTitle__title')?.getAttribute('href');
      item.setAttribute('data-golow-seen', '');
      item.toggleAttribute('data-golow-long', (lengths.get(at) || 0) > 20 * 60 * 1000);
      item.toggleAttribute('data-golow-played', played.has(at));
    }
  }
  function feedSwitches() {
    const filters = document.querySelector('.stream__filter');
    if (filters && !filters.querySelector('[data-golow]')) {
      for (const [key, label] of [['mixes', 'Mixes'], ['played', 'Played']]) {
        const item = Object.assign(document.createElement('div'), {className: 'streamFilter__item sc-ml-2x'});
        item.dataset.golow = key;
        item.innerHTML = `<label class="streamFilter__label sc-type-light sc-text-secondary sc-type-small sc-text-body sc-mr-1x">${label}</label>` +
          '<label class="toggle sc-toggle sc-toggle-small"><span class="sc-toggle-handle"></span><input class="sc-toggle-input sc-visuallyhidden" type="checkbox"></label>';
        item.querySelector('input').addEventListener('change', event => change(key, event.target.checked));
        filters.append(item);
      }
    }
    for (const item of document.querySelectorAll('[data-golow]')) {
      item.querySelector('input').checked = settings[item.dataset.golow];
      item.querySelector('.sc-toggle').classList.toggle('sc-toggle-on', settings[item.dataset.golow]);
    }
  }

  // True shuffle. SoundCloud's queue only ever holds about 27 tracks, so its own shuffle keeps
  // repeating the same few. GoLow keeps a random order over every like and plays each pick with
  // SoundCloud's player while the Likes page stays open, including minimized or in the tray.
  const TRACK_LINK = '.playableTile__artworkLink, .soundTitle__title';
  let shuffleOrder = null, shufflePos = 0, userPick = false, nearEnd = false;
  const seconds = selector => (document.querySelector(selector + ' [aria-hidden]')?.textContent || '').split(':').reduce((t, n) => t * 60 + Number(n), 0);
  function pick(pos) {
    const at = shuffleOrder?.[pos];
    const item = at && [...listItems()].find(candidate => candidate.querySelector(TRACK_LINK)?.getAttribute('href') === at);
    if (!item) return stopShuffle();
    [shufflePos, nearEnd] = [pos, false];
    item.querySelector('.sc-button-play')?.click();
  }
  function stopShuffle() {
    shuffleOrder = null;
    const button = document.querySelector('[data-golow-tools] button');
    if (button) button.textContent = 'Shuffle all';
  }
  function followShuffle(trackChanged) {
    if (!shuffleOrder || !nowPlaying) return;
    const at = pathOf(document.querySelector('.playbackSoundBadge__titleLink')?.getAttribute('href'));
    if (trackChanged && at !== shuffleOrder[shufflePos]) {
      const index = shuffleOrder.indexOf(at);
      if (userPick && index >= 0) shufflePos = index;   // The user picked a like: carry on from there.
      else if (userPick) stopShuffle();                  // The user played something else.
      else pick(shufflePos + 1);                         // SoundCloud advanced on its own: take the next pick.
      userPick = false;
      return;
    }
    const left = seconds('.playbackTimeline__duration') - seconds('.playbackTimeline__timePassed');
    if (!nearEnd && seconds('.playbackTimeline__timePassed') > 0 && left <= 1) {
      nearEnd = true;
      pick(shufflePos + 1);
    }
  }

  // Likes: a filter box and a shuffle that covers every like, not just the ~24 loaded.
  const listItems = () => document.querySelectorAll('.lazyLoadingList :is(.badgeList__item, .soundList__item)');
  let loading = null;
  function loadAll(progress = () => {}) {
    const page = location.pathname;
    return loading ||= (async () => {
      for (let count = -1, stable = 0; stable < 4 && location.pathname === page;) {
        const now = listItems().length;
        [stable, count] = [now === count ? stable + 1 : 0, now];
        progress(count);
        scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(r => setTimeout(r, 350));
      }
      scrollTo(0, 0);
      loading = null;
    })();
  }
  function likesTools() {
    const top = document.querySelector('.collectionSection__top');
    if (!top || top.querySelector('[data-golow-tools]')) return;
    const tools = Object.assign(document.createElement('div'), {className: 'g-flex-row-centered sc-mr-2x'});
    tools.dataset.golowTools = '';
    tools.innerHTML = '<input type="search" placeholder="Filter likes" aria-label="Filter likes" class="sc-input sc-input-small sc-mr-1x">' +
      '<button type="button" class="sc-button sc-button-medium">Shuffle all</button>';
    const [input, button] = tools.children;
    input.addEventListener('input', async () => {
      const text = input.value.trim().toLowerCase();
      if (text) await loadAll();
      for (const item of listItems()) item.toggleAttribute('data-golow-filtered', !!text && !item.textContent.toLowerCase().includes(text));
    });
    button.addEventListener('click', async () => {
      if (shuffleOrder) return stopShuffle();
      button.disabled = true;
      await loadAll(count => { button.textContent = `Loading ${count}…`; });
      button.disabled = false;
      // Fisher-Yates over every loaded like.
      shuffleOrder = [...listItems()].map(item => item.querySelector(TRACK_LINK)?.getAttribute('href')).filter(Boolean);
      for (let i = shuffleOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
      }
      button.textContent = 'Stop shuffle';
      const native = document.querySelector('.shuffleControl.m-shuffling');
      if (native) native.click();
      pick(0);
    });
    (top.querySelector('.collectionSection__action') || top.lastChild).before(tools);
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
    restyle();
    place();
    if (wheelBar) watchPlayer();
    feedSwitches();
    if (!panel) return;
    for (const key of PANEL) $(key).checked = settings[key];
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
        <label>Waveform comments<input id="comments" type="checkbox" role="switch"></label>
        <label>Top comments first<input id="top_comments" type="checkbox" role="switch"></label>
        <label>Autoplay related tracks<input id="autoplay" type="checkbox" role="switch"></label>
        <label>Discord status<input id="discord" type="checkbox" role="switch"></label>
        <p id="recovery" hidden>Cleanup is off for this page (noclean).</p>
        <a id="quality" href="https://soundcloud.com/settings/streaming">Audio quality<span aria-hidden="true">›</span></a>`;
      shadow.appendChild(panel);
      for (const key of PANEL) $(key).addEventListener('change', event => change(key, event.target.checked));
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
    if (event.isTrusted && event.target.closest?.('.lazyLoadingList .sc-button-play')) userPick = true;
    // SoundCloud's own autoplay switch sets the remembered choice too.
    if (event.isTrusted && event.target.closest?.('.queueFallback__toggle')) {
      setTimeout(() => change('autoplay', !!document.querySelector('.queueFallback__toggle .sc-toggle-on')));
    }
  });
  window.addEventListener('pageshow', place);
  window.__scClient = Object.freeze({
    update(value) { Object.assign(settings, value); save(); apply(); },
    openSettings,
    diagnostics: () => ({placed: !!host && placed(), settings_built: !!panel, shuffle: shuffleOrder?.[shufflePos] ?? null, slot: host?.parentElement?.className || null,
      settings: {...settings}, recovery}),
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place, {once: true}); else place();
})();
