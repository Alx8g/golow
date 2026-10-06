// Polish and resilience: plain answers when SoundCloud is down, recovery from blank pages,
// no double comments, flagged spam messages, clean share links, the stream quality, themes
// and a full-window now-playing view.
menu.push(
  {section: 'Interface', key: 'theme', label: 'Theme', type: 'select', def: 'default',
    options: [['default', 'SoundCloud'], ['black', 'Pure black'], ['midnight', 'Midnight blue']], hint: 'Applies to SoundCloud\'s dark mode.'},
  {section: 'Interface', key: 'edit_css', type: 'button', label: 'Custom CSS', action: () => openPanel('css')},
  {section: 'Interface', key: 'quality_badge', label: 'Show the stream quality', def: true, hint: 'Which encoding SoundCloud is sending, such as AAC 256.'},
  {section: 'Lists and feed', key: 'flag_spam', label: 'Flag likely spam messages', def: true,
    hint: 'Messages from accounts you do not follow that read like promotion or scam templates.'},
  {section: 'Sharing', key: 'clean_links', label: 'Copy share links without tracking', def: true, hint: 'Removes si= and utm_ codes from copied SoundCloud links.'},
);

// --- When SoundCloud is down, say so instead of "check your connection" ---
const failures = {server: [], network: []};
let warnedAt = 0;
on('health', status => {
  const kind = status >= 500 ? 'server' : status === 0 ? 'network' : null;
  if (!kind) return;
  const recent = failures[kind] = [...failures[kind].filter(at => Date.now() - at < 60000), Date.now()];
  if (recent.length < 3 || Date.now() - warnedAt < 5 * 60000) return;
  warnedAt = Date.now();
  toast(kind === 'server' ? `SoundCloud's servers are having problems right now (error ${status}). It is not your connection.`
    : navigator.onLine ? 'Cannot reach SoundCloud. If you use a VPN or proxy, try turning it off.' : 'You are offline. GoLow carries on when the connection is back.', null, 12000);
});
// A page that never draws, as during SoundCloud's 2026 outages, reloads once.
setTimeout(() => {
  const drawn = document.querySelector('.header, .playControls, #content, .l-container');
  const last = Number(sessionStorage.getItem('golow-reloaded')) || 0;
  if (!drawn && Date.now() - last > 2 * 60000) {
    sessionStorage.setItem('golow-reloaded', String(Date.now()));
    location.reload();
  }
}, 15000);
const frameReloaded = new WeakMap();
on('frame', (doc, frame) => {
  // The redesigned pages show this when their own script crashes.
  if (doc.body && doc.body.childElementCount < 6 && /Application error: a client-side exception/.test(doc.body.textContent) &&
      Date.now() - (frameReloaded.get(frame) || 0) > 2 * 60000) {
    frameReloaded.set(frame, Date.now());
    frame.contentWindow.location.reload();
  }
});

// --- Comments post once, however often Enter is pressed while SoundCloud is slow ---
const posted = new WeakMap();
on('frame', doc => {
  if (posted.has(doc)) return;
  posted.set(doc, {text: '', at: 0});
  const guard = event => {
    const input = doc.querySelector('input[aria-label="Add a comment to this track"], textarea[aria-label="Add a comment to this track"]');
    const isSubmit = event.type === 'submit' ? event.target.contains(input) : event.target.closest?.('button[aria-label="Post comment"]');
    if (!input || !isSubmit) return;
    const text = input.value.trim(), last = posted.get(doc);
    if (text && text === last.text && Date.now() - last.at < 15000) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast('That comment is already posting.');
      return;
    }
    posted.set(doc, {text, at: Date.now()});
  };
  doc.addEventListener('submit', guard, true);
  doc.addEventListener('click', guard, true);
});

// --- Spam messages: promotion and scam templates from accounts you do not follow ---
const SPAM = /\b(transition at|can i ask you a question|a\s?&\s?r\b|record label|promot(e|ion|ing) (your|ur|the) (music|track|song|sound)|playlist (placement|curator)|grow (your|ur) (fan|audience|account)|(more|real|organic|guaranteed) (plays|streams|followers)|feature (you|your (track|song))|submit (your|ur) (music|track)|send (me )?(a )?(dm|message) on|telegram|whatsapp|cash ?app|bitcoin|crypto|investment|you('|’)ve been selected|congratulations)\b/i;
on('page', () => {
  if (!location.pathname.startsWith('/messages') || !pref('flag_spam')) return;
  for (const item of document.querySelectorAll('.inbox__list > li:not([data-golow-checked]), .conversation__message:not([data-golow-checked])')) {
    item.setAttribute('data-golow-checked', '');
    const author = pathOf(item.querySelector('a[href^="/"]')?.getAttribute('href') || '');
    const followed = author && session.following?.has(users.get(author));
    if (!followed && SPAM.test(item.textContent)) item.setAttribute('data-golow-spam', '');
  }
});
css.push(() => pref('flag_spam') ? 'html:root [data-golow-spam]{opacity:.45}html:root [data-golow-spam]::before{content:"Possible spam";display:block;margin:4px 0;' +
  'font:600 11px system-ui,sans-serif;color:#f50;text-transform:uppercase;letter-spacing:.05em}' : '');

// --- Clean share links ---
function cleanLinks(text) {
  return String(text).replace(/https:\/\/(?:www\.|on\.|m\.)?soundcloud\.com\/[^\s"'<>]+/g, raw => {
    try {
      const url = new URL(raw);
      for (const key of [...url.searchParams.keys()]) if (key === 'si' || key.startsWith('utm_')) url.searchParams.delete(key);
      return url.href.replace(/\?$/, '');
    } catch { return raw; }
  });
}
function patchClipboard(win) {
  const clipboard = win.navigator.clipboard;
  if (!clipboard || clipboard.__golow) return;
  const write = clipboard.writeText.bind(clipboard);
  clipboard.writeText = text => write(pref('clean_links') ? cleanLinks(text) : text);
  Object.defineProperty(clipboard, '__golow', {value: true});
}
patchClipboard(window);
const cleanCopy = event => {
  const selection = String(event.target.ownerDocument?.getSelection?.() || document.getSelection() || '');
  const field = event.target.closest?.('input, textarea');
  const text = field ? field.value.slice(field.selectionStart, field.selectionEnd) : selection;
  if (!pref('clean_links') || !/[?&](si|utm_)/.test(text)) return;
  event.clipboardData.setData('text/plain', cleanLinks(text));
  event.preventDefault();
};
document.addEventListener('copy', cleanCopy, true);
const cleaned = new WeakSet();
on('frame', (doc, frame) => {
  if (cleaned.has(doc)) return;
  cleaned.add(doc);
  patchClipboard(frame.contentWindow);
  doc.addEventListener('copy', cleanCopy, true);
});

// --- Stream quality: the encoding SoundCloud is actually sending ---
const PRESETS = {aac_256k: 'AAC 256', aac_160k: 'AAC 160', aac_96k: 'AAC 96', aac_hq: 'AAC HQ', mp3_0_0: 'MP3 128', mp3_1_0: 'MP3 128', mp3_standard: 'MP3 128',
  opus_0_0: 'Opus 64', abr_hq: 'Adaptive HQ', abr_sq: 'Adaptive'};
let quality = '';
on('data', url => {
  const match = url.pathname.match(/^\/media\/soundcloud:tracks:(\d+)\//);
  if (!match) return;
  const path = trackIds.get(Number(match[1])), stream = 'https://api-v2.soundcloud.com' + url.pathname;
  const transcoding = tracks.get(path)?.transcodings.find(item => item.url === stream);
  if (!transcoding) return;
  quality = (PRESETS[transcoding.preset] || transcoding.preset) + (/encrypted/.test(transcoding.protocol || '') ? ' · protected' : '');
  showQuality();
});
function showQuality() {
  const button = barButton('quality');
  if (!button) return;
  button.hidden = !quality || !pref('quality_badge');
  button.textContent = quality.replace(' · protected', '');
  button.title = `Streaming ${quality}. Change it in SoundCloud's streaming settings.`;
}
barButtons.push({name: 'quality', text: '', label: 'Stream quality', narrow: true, onclick: () => navigate('/settings/streaming')});
on('apply', showQuality);
on('page', showQuality);

// --- Themes and custom CSS ---
const THEMES = {
  black: ['#000', '#0a0a0a', '#141414'],
  midnight: ['#0b1020', '#111833', '#1a2342'],
};
function themeCss(frame) {
  const colors = THEMES[pref('theme')];
  if (!colors) return '';
  const [page, raised, lifted] = colors;
  return frame
    ? `html:root body,html:root main{background-color:${page}!important}html:root .MuiPaper-root{background-color:${raised}!important}`
    : `html:root body.theme-dark,html:root .theme-dark :is(.header,.header__inner,.l-container,.l-main,.l-sidebar-right,.playControls__bg,.playControls__inner,` +
      `.playControls__wrapper,.dropdownMenu,.modal__modal,.queue,.queue__panel){background-color:${page}!important}` +
      `html:root .theme-dark :is(.sidebarModule,.searchOptions,.tabs__tabs){background-color:${raised}!important}` +
      `html:root .theme-dark .headerSearch__input{background-color:${lifted}!important}`;
}
css.push(() => themeCss(false) + (local.custom_css ? String(local.custom_css).replace(/<\/?style/gi, '') : ''));
frameCss.push(() => themeCss(true));
tabs.push({id: 'css', label: 'Custom CSS', order: 12, aside: true, render(body) {
  const area = h('textarea', {spellcheck: 'false', 'aria-label': 'Custom CSS', placeholder: '.header { background: #202 !important; }', value: local.custom_css || ''});
  body.append(h('h2', {text: 'Custom CSS'}), h('p', {text: 'Your own styles for SoundCloud\'s pages, applied after GoLow\'s. Use !important to win over SoundCloud.'}), area,
    h('div', {cls: 'row'}, h('button', {cls: 'btn primary', type: 'button', text: 'Apply', onclick: () => { local.custom_css = area.value.slice(0, 50000); store('prefs', local); restyle(); toast('Custom CSS applied.'); }}),
      h('button', {cls: 'btn', type: 'button', text: 'Clear', onclick: () => { area.value = ''; local.custom_css = ''; store('prefs', local); restyle(); }})));
}});

// --- Now playing, full window: big artwork, lyrics or tracklist, big controls ---
let stage = null;
function artworkFor(path) {
  const art = tracks.get(path)?.artwork || '';
  return /^https:\/\/i1\.sndcdn\.com\//.test(art) ? art.replace(/-(large|t\d+x\d+)\./, '-t500x500.') : '';
}
function openStage() {
  ensureOverlay();
  stage?.remove();
  const control = (name, label, text) => h('button', {cls: 'btn', type: 'button', 'aria-label': label, text, onclick: () => commands[name]()});
  stage = h('section', {cls: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Now playing', style: 'position:absolute;inset:0;z-index:2;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;padding:48px;pointer-events:auto;background:#0b0b0c;border-radius:0;overflow:hidden'},
    // The artwork, blurred, behind everything.
    h('img', {id: 'stage-glow', alt: '', 'aria-hidden': 'true', style: 'position:absolute;inset:-10%;width:120%;height:120%;object-fit:cover;filter:blur(80px) saturate(1.4);opacity:.35;z-index:-1'}),
    h('div', {style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px'},
      h('img', {id: 'stage-art', alt: '', style: 'width:min(42vw,62vh);aspect-ratio:1;object-fit:cover;border-radius:12px;background:#222'}),
      h('div', {id: 'stage-title', cls: 'title', style: 'font-size:22px;text-align:center'}), h('p', {id: 'stage-artist', style: 'font-size:15px;text-align:center'}),
      h('p', {id: 'stage-chapter', style: 'color:#5cf2a8;text-align:center'}),
      h('div', {cls: 'bar', style: 'width:min(42vw,62vh);height:5px'}, h('i', {id: 'stage-progress'})),
      h('div', {cls: 'row', style: 'justify-content:center;width:auto'}, control('previous', 'Previous', '⏮'), control('back', 'Skip back', '−' + pref('skip_back')),
        control('toggle', 'Play or pause', '⏯'), control('forward', 'Skip forward', '+' + pref('skip_forward')), control('next', 'Next', '⏭'))),
    h('div', {id: 'stage-side', style: 'overflow:auto;align-self:stretch'}),
    iconButton('close', 'Close (Esc)', closeStage, {style: 'position:absolute;top:16px;right:16px'}));
  overlayRoot.append(stage);
  drawStage(true);
}
function closeStage() { stage?.remove(); stage = null; }
function drawStage(full = false) {
  if (!stage) return;
  const art = artworkFor(player.path), image = stage.querySelector('#stage-art');
  if (art && image.src !== art) image.src = stage.querySelector('#stage-glow').src = art;
  stage.querySelector('#stage-title').textContent = player.title || 'Nothing playing';
  stage.querySelector('#stage-artist').textContent = player.artist;
  stage.querySelector('#stage-chapter').textContent = player.chapter ? `Now: ${player.chapter.name}` : '';
  stage.querySelector('#stage-progress').style.width = player.total ? `${position() / player.total * 100}%` : '0';
  if (!full) return;
  const side = stage.querySelector('#stage-side');
  side.replaceChildren();
  const tab = lyrics.path === player.path && (lyrics.lines.length || lyrics.plain) ? 'lyrics' : 'now';
  tabs.find(item => item.id === tab)?.render(side);
}
on('track', () => drawStage(true));
on('tick', () => drawStage());
barButtons.push({name: 'stage', icon: 'expand', label: 'Now playing, full window', narrow: true, onclick: () => (stage ? closeStage() : openStage())});
commands.stage = () => (stage ? closeStage() : openStage());
on('key', event => { if (event.key === 'Escape' && stage) closeStage(); });
