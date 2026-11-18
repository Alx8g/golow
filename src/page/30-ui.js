// GoLow's own interface lives in shadow roots, so SoundCloud's styles never reach it and React
// never sees it. Three hosts: the gear in the header, buttons in the player bar, and an overlay
// for the side panel, menus, toasts and the now-playing view.
const STYLE = `:host{font:13px/1.4 system-ui,sans-serif;color:#eee;color-scheme:dark}[hidden]{display:none!important}
  button,select,input,textarea{font:inherit;color:inherit}:focus-visible{outline:2px solid #5cf2a8;outline-offset:2px}
  .icon{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:none;color:#ccc;cursor:pointer}
  .icon:hover,.icon[aria-expanded="true"],.icon.on{color:#fff;background:#ffffff1a}.icon.on{color:#5cf2a8}
  .card{box-sizing:border-box;background:#1c1c1e;border:1px solid #333;border-radius:8px;box-shadow:0 8px 24px #000a}
  h2{margin:6px 8px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888}
  h3{margin:12px 8px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#777}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;box-sizing:border-box;padding:7px 8px;border:0;border-radius:6px;
    background:none;color:#eee;text-align:left;text-decoration:none;cursor:pointer}.row:hover{background:#ffffff12}
  .col{flex-direction:column;align-items:stretch;gap:4px;cursor:default}p,.note{margin:4px 8px;color:#999;font-size:12px}
  input[type=checkbox]{appearance:none;flex:none;position:relative;width:30px;height:18px;margin:0;border-radius:9px;background:#48484c;cursor:pointer;transition:background .15s}
  input[type=checkbox]::before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
  input[type=checkbox]:checked{background:#5cf2a8}input[type=checkbox]:checked::before{transform:translateX(12px)}
  input[type=text],input[type=search],select,textarea{box-sizing:border-box;padding:5px 8px;border:1px solid #444;border-radius:6px;background:#111}
  select{max-width:140px}textarea{width:100%;min-height:120px;font:12px/1.4 ui-monospace,monospace}
  .btn{padding:5px 10px;border:1px solid #444;border-radius:6px;background:#2a2a2e;cursor:pointer}.btn:hover{background:#34343a}
  .btn.primary{border-color:#5cf2a8;color:#5cf2a8}.btn:disabled{opacity:.5;cursor:default}
  .list{margin:0;padding:0;list-style:none}.list li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px}
  .list li:hover{background:#ffffff0d}.list li.current{background:#5cf2a81f}.grow{flex:1;min-width:0}
  .clip{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.time{flex:none;color:#5cf2a8;font-variant-numeric:tabular-nums;cursor:pointer}
  .dim{color:#888}.bar{height:3px;border-radius:2px;background:#333;overflow:hidden}.bar>i{display:block;height:100%;background:#f50}
  a{color:#5cf2a8}.title{margin:4px 8px 0;font-size:15px;font-weight:600}`;

function shadowHost(id, extra = '') {
  const host = h('div', {id});
  const root = host.attachShadow({mode: 'open'});
  root.append(h('style', {text: STYLE + extra}));
  return [host, root];
}
const icons = {
  gear: 'M4 7h10M18 7h2M4 17h4M12 17h8|c16 7 2|c10 17 2',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  back: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  forward: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  panel: 'M4 6h16M4 12h10M4 18h13',
  close: 'M6 6l12 12M18 6L6 18',
  block: 'M5.6 5.6l12.8 12.8|c12 12 9',
};
function icon(name, size = 20) {
  const [path, ...circles] = icons[name].split('|');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${path}"/>${circles.map(c => { const [x, y, r] = c.slice(1).split(' '); return `<circle cx="${x}" cy="${y}" r="${r}"/>`; }).join('')}</svg>`;
}
// Icon buttons use static SVG from the table above, never page data.
function iconButton(name, label, onclick, extra = {}) {
  const button = h('button', {cls: 'icon', type: 'button', 'aria-label': label, title: label, onclick, ...extra});
  button.innerHTML = icon(name);
  return button;
}

// --- Header gear and settings ---
let host = null, shadow = null, panel = null, placer = null;
const $ = id => shadow.getElementById(id);
const SECTIONS = ['Interface', 'Playback', 'Mixes and podcasts', 'Lists and feed', 'Sharing', 'App'];
menu.push(
  {section: 'Interface', key: 'cleanup', label: 'Clean up interface'},
  {section: 'Interface', key: 'efficiency', label: 'Reduce background work'},
  {section: 'Interface', key: 'compact', label: 'Mini player'},
  {section: 'Interface', key: 'always_on_top', label: 'Keep on top'},
  {section: 'Interface', key: 'comments', label: 'Waveform comments'},
  {section: 'Interface', key: 'top_comments', label: 'Top comments first'},
  {section: 'Playback', key: 'autoplay', label: 'Autoplay related tracks'},
  {section: 'Sharing', key: 'discord', label: 'Discord status'},
  {section: 'Sharing', key: 'lastfm', label: 'Scrobble to Last.fm', when: () => !!window.__scLastfm},
);
function control(item) {
  const value = pref(item.key);
  const tip = item.hint ? {title: item.hint} : {};
  if (item.type === 'button') return h('button', {cls: 'row', type: 'button', onclick: () => { openSettings(false); item.action(); }, ...tip}, item.label, h('span', {'aria-hidden': 'true', text: '›'}));
  if (item.type === 'select') {
    const parse = raw => (typeof item.def === 'number' ? Number(raw) : raw);
    return h('label', {cls: 'row', ...tip}, item.label, h('select', {id: item.key, onchange: event => change(item.key, parse(event.target.value))},
      item.options.map(([option, text]) => h('option', {value: String(option), text, selected: String(option) === String(value)}))));
  }
  if (item.type === 'text') {
    return h('label', {cls: 'row col', ...tip}, item.label, h('input', {id: item.key, type: 'text', value: value || '', placeholder: item.placeholder || '',
      onchange: event => change(item.key, event.target.value.trim())}));
  }
  return h('label', {cls: 'row', ...tip}, item.label, h('input', {id: item.key, type: 'checkbox', role: 'switch', checked: !!value,
    onchange: event => change(item.key, event.target.checked)}));
}
function buildSettings() {
  panel = h('section', {id: 'panel', cls: 'card', role: 'dialog', 'aria-label': 'GoLow settings', hidden: true},
    h('h2', {text: 'GoLow'}),
    SECTIONS.map(section => {
      const items = menu.filter(item => item.section === section && (!item.when || item.when()));
      return items.length ? [h('h3', {text: section}), items.map(control)] : null;
    }),
    h('p', {id: 'recovery', hidden: !recovery, text: 'Cleanup is off for this page (noclean).'}),
    h('a', {id: 'quality', cls: 'row', href: 'https://soundcloud.com/settings/streaming', onclick: () => openSettings(false)}, 'Audio quality', h('span', {'aria-hidden': 'true', text: '›'})));
  shadow.append(panel);
}

function place() {
  if (!document.body) return;
  if (!host) {
    [host, shadow] = shadowHost('sc-client-settings', `:host{position:relative;display:flex;align-items:center;margin:0 4px}
      :host([data-floating]){position:fixed;top:8px;right:12px;z-index:2147483647}:host([data-mini]) #open,:host(:not([data-mini])) #expand{display:none}
      #panel{position:absolute;top:calc(100% + 6px);right:0;width:280px;max-height:calc(100vh - 120px);overflow:auto;padding:6px}`);
    shadow.append(iconButton('gear', 'GoLow settings', () => openSettings(!panel || panel.hidden), {id: 'open', 'aria-expanded': 'false'}),
      iconButton('expand', 'Exit mini player', () => change('compact', false), {id: 'expand'}));
    $('open').title = 'GoLow settings (Ctrl+,)';
  }
  if (!placer) {
    // SoundCloud renders its header after load and swaps it out once more. The callback is
    // a cheap check, so the button returns in the same frame it was dropped. Observer callbacks
    // already come batched, and unlike animation frames they still run in the tray.
    placer = new MutationObserver(() => {
      if (!placed()) place();
      emit('page');
    });
    placer.observe(document.body, {childList: true, subtree: true});
  }
  host.toggleAttribute('data-mini', settings.compact);
  placeBar();
  const target = document.querySelector(settings.compact ? '.playControls__elements' : '.header__right > .header__navMenu');
  if (!target || placed()) return;
  host.removeAttribute('data-floating');
  settings.compact ? target.append(host) : target.before(host);
}
const placed = () => host.isConnected && !host.hasAttribute('data-floating') &&
  host.parentElement.matches(settings.compact ? '.playControls__elements' : '.header__right');

function change(key, value) {
  if (NATIVE.includes(key)) settings[key] = value;
  else { local[key] = value; store('prefs', local); }
  save();
  if (key === 'compact') openSettings(false);
  apply();
  if (NATIVE.includes(key)) send(settings);
}
function apply() {
  restyle();
  place();
  emit('apply');
  if (!panel) return;
  for (const item of menu) {
    const input = $(item.key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!pref(item.key); else if (document.activeElement !== host || shadow.activeElement !== input) input.value = pref(item.key) ?? '';
  }
  $('recovery').hidden = !recovery;
}
// The panel is built on first open, so startup adds one button and no settings DOM.
function openSettings(open = true) {
  if (open && settings.compact) return change('compact', false);
  place();
  if (!host) return;
  if (open && !host.isConnected) { host.toggleAttribute('data-floating', true); document.body.appendChild(host); }
  if (open && !panel) buildSettings();
  if (!panel) return;
  panel.hidden = !open;
  $('open').setAttribute('aria-expanded', open);
}

// --- Player bar buttons ---
let bar = null, barRoot = null;
const barButtons = [];   // {name, label, onclick, narrow: hide below 1100px, mini: keep in mini player}
function placeBar() {
  const elements = document.querySelector('.playControls__elements');
  if (!elements) return;
  if (!bar) {
    [bar, barRoot] = shadowHost('golow-bar', `:host{display:flex;align-items:center;gap:2px;margin:0 6px;flex-shrink:0}
      .icon{width:30px;height:30px}.text{width:auto;min-width:30px;padding:0 6px;border-radius:15px;font-size:12px;font-variant-numeric:tabular-nums}
      @media (max-width:1100px){.narrow{display:none}}:host([data-mini]) .full{display:none}`);
    for (const item of barButtons) {
      const button = item.text !== undefined
        ? h('button', {cls: 'icon text', type: 'button', id: item.name, 'aria-label': item.label, title: item.label, onclick: item.onclick, text: item.text})
        : iconButton(item.icon, item.label, item.onclick, {id: item.name});
      if (item.narrow) button.classList.add('narrow');
      if (!item.mini) button.classList.add('full');
      barRoot.append(button);
    }
  }
  bar.toggleAttribute('data-mini', settings.compact);
  // Between the timeline and the volume control.
  const volumeControl = elements.querySelector('.playControls__volume');
  if (volumeControl ? bar.nextElementSibling !== volumeControl : bar.parentElement !== elements) volumeControl ? volumeControl.before(bar) : elements.append(bar);
}
const barButton = name => barRoot?.getElementById(name);
on('page', placeBar);

// --- Overlay: side panel, menus, toasts ---
const [overlay, overlayRoot] = shadowHost('golow-overlay', `:host{position:fixed;inset:0;z-index:2147483646;pointer-events:none}
  #drawer{position:absolute;top:46px;right:0;bottom:49px;width:min(400px,100vw);display:flex;flex-direction:column;pointer-events:auto;border-radius:8px 0 0 8px}
  #tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 6px 0;border-bottom:1px solid #333}
  #tabs button{padding:6px 10px;border:0;border-bottom:2px solid transparent;background:none;color:#aaa;cursor:pointer}
  #tabs button[aria-selected="true"]{color:#fff;border-bottom-color:#5cf2a8}#tabs .icon{margin-left:auto;width:28px;height:28px}
  #body{flex:1;overflow:auto;padding:8px}
  .menu{position:absolute;min-width:180px;padding:4px;pointer-events:auto}
  #toasts{position:absolute;right:16px;bottom:64px;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .toast{display:flex;align-items:center;gap:12px;max-width:420px;padding:10px 12px;pointer-events:auto}`);
const tabs = [];   // {id, label, order, render(body)}
let drawer = null, drawerTab = null;
function ensureOverlay() { if (!overlay.isConnected && document.body) document.body.append(overlay); }
function openPanel(id = drawerTab || tabs[0]?.id, toggle = false) {
  ensureOverlay();
  if (toggle && drawer && !drawer.hidden && (id === drawerTab)) return closePanel();
  if (!drawer) {
    drawer = h('section', {id: 'drawer', cls: 'card', role: 'dialog', 'aria-label': 'GoLow panel'}, h('div', {id: 'tabs', role: 'tablist'}), h('div', {id: 'body'}));
    overlayRoot.append(drawer);
  }
  drawer.hidden = false;
  drawerTab = id;
  const strip = overlayRoot.getElementById('tabs');
  tabs.sort((a, b) => a.order - b.order);
  strip.replaceChildren(...tabs.map(tab => h('button', {type: 'button', role: 'tab', 'aria-selected': String(tab.id === id), text: tab.label, onclick: () => openPanel(tab.id)})),
    iconButton('close', 'Close panel', closePanel));
  refreshPanel(id);
  barButton('panel')?.classList.add('on');
}
function closePanel() {
  if (drawer) drawer.hidden = true;
  barButton('panel')?.classList.remove('on');
}
// Re-renders a tab if it is the one showing.
function refreshPanel(id) {
  if (!drawer || drawer.hidden || drawerTab !== id) return;
  const body = overlayRoot.getElementById('body'), tab = tabs.find(item => item.id === id);
  const scroll = body.scrollTop;
  body.replaceChildren();
  try { tab?.render(body); } catch (error) { body.append(h('p', {text: 'This part of GoLow hit a problem: ' + error.message})); }
  body.scrollTop = scroll;
}
const panelOpen = id => !!drawer && !drawer.hidden && drawerTab === id;

let openMenu = null;
function popup(anchor, items) {
  ensureOverlay();
  openMenu?.remove();
  const box = anchor.getBoundingClientRect();
  openMenu = h('div', {cls: 'menu card', role: 'menu'}, items.map(item => item.heading
    ? h('h3', {text: item.heading})
    : h('button', {cls: 'row', type: 'button', role: 'menuitemradio', 'aria-checked': String(!!item.checked), onclick: () => { closeMenu(); item.action(); }},
      item.label, item.checked ? h('span', {text: '✓'}) : null)));
  openMenu.style.left = Math.max(8, Math.min(box.left, innerWidth - 200)) + 'px';
  openMenu.style.bottom = (innerHeight - box.top + 6) + 'px';
  overlayRoot.append(openMenu);
  openMenu.querySelector('button')?.focus();
}
function closeMenu() { openMenu?.remove(); openMenu = null; }

function toast(text, action, ms = 6000) {
  ensureOverlay();
  let box = overlayRoot.getElementById('toasts');
  if (!box) overlayRoot.append(box = h('div', {id: 'toasts', role: 'status'}));
  const item = h('div', {cls: 'toast card'}, h('span', {text}), action ? h('button', {cls: 'btn', type: 'button', text: action.label, onclick: () => { item.remove(); action.run(); }}) : null);
  box.append(item);
  setTimeout(() => item.remove(), ms);
  return item;
}

document.addEventListener('keydown', event => {
  const typing = event.composedPath().some(node => node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)));
  if (event.ctrlKey && event.key === ',') { event.preventDefault(); openSettings(!panel || panel.hidden); }
  if (event.ctrlKey && event.key === '.') { event.preventDefault(); drawer && !drawer.hidden ? closePanel() : openPanel(); }
  if (event.key === 'Escape') {
    if (openMenu) closeMenu();
    else if (panel && !panel.hidden) { openSettings(false); $('open').focus(); }
    else if (drawer && !drawer.hidden) closePanel();
  }
  if (!typing && !event.ctrlKey && !event.altKey && !event.metaKey) emit('key', event);
});
document.addEventListener('click', event => {
  const path = event.composedPath();
  if (panel && !panel.hidden && !path.includes(host)) openSettings(false);
  if (openMenu && !path.includes(openMenu) && !path.includes(bar)) closeMenu();
});
