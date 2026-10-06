// The app around the page: system-wide shortcuts, the phone remote, updates, accounts, the
// start page and window options.
const appInfo = window.__scApp || {version: '', profile: '', hotkeys: {}};
menu.push(
  {section: 'Interface', key: 'reduce_motion', label: 'Reduce motion', def: false, hint: 'Turns off animations and transitions.'},
  {section: 'Sharing', key: 'now_file', label: 'Now-playing file for stream overlays',
    hint: 'Writes "Artist - Title" to now-playing.txt in GoLow\'s folder, for OBS and similar.'},
  {section: 'Sharing', key: 'open_app_folder', type: 'button', label: 'Open GoLow\'s folder', action: () => call('open_folder', {which: 'app'}).catch(() => {})},
  {section: 'App', key: 'start_page', label: 'Start page', type: 'select', options: [['discover', 'Home'], ['feed', 'Feed'], ['likes', 'Likes'],
    ['library', 'Library'], ['history', 'History'], ['last', 'Where I left off']]},
  {section: 'App', key: 'hotkeys', label: 'System-wide shortcuts', hint: 'Control GoLow from any app. Ctrl+Alt+Shift with a letter by default.'},
  {section: 'App', key: 'edit_shortcuts', type: 'button', label: 'Edit shortcuts', action: () => openPanel('shortcuts')},
  {section: 'App', key: 'remote', label: 'Phone remote', hint: 'Control GoLow from a phone on the same Wi-Fi.'},
  {section: 'App', key: 'show_remote', type: 'button', label: 'Connect a phone', action: () => openPanel('remote')},
  {section: 'App', key: 'updates', label: 'Check for updates'},
  {section: 'App', key: 'check_updates', type: 'button', label: 'Check now', action: checkForUpdate},
  {section: 'App', key: 'accounts', type: 'button', label: 'Accounts', action: () => openPanel('accounts')},
  {section: 'App', key: 'gpu', label: 'Hardware acceleration', hint: 'Turn off if video or animations flicker. Takes effect after a restart.'},
  {section: 'App', key: 'reset_zoom', type: 'button', label: 'Reset zoom (Ctrl+0)', action: () => call('zoom', {factor: 1}).catch(() => {})},
);
css.push(() => pref('reduce_motion') ? 'html:root *,html:root *::before,html:root *::after{animation-duration:0s!important;transition:none!important;scroll-behavior:auto!important}' : '');

// Mouse back and forward buttons move through SoundCloud's history, as in a browser.
const mouseNavigation = event => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  event.button === 3 ? history.back() : history.forward();
};
document.addEventListener('mouseup', mouseNavigation);
const navigable = new WeakSet();
on('frame', doc => {
  if (navigable.has(doc)) return;
  navigable.add(doc);
  doc.addEventListener('mouseup', mouseNavigation);
});

// --- Shortcuts: record a combination by pressing it ---
let hotkeyStatus = {}, recording = null;
const ACTION_NAMES = {toggle: 'Play or pause', next: 'Next track', previous: 'Previous track', back: 'Skip back', forward: 'Skip forward',
  like: 'Like', volume_up: 'Volume up', volume_down: 'Volume down', bookmark: 'Bookmark', show: 'Show GoLow'};
const keysFor = action => settings.shortcuts[action] ?? appInfo.hotkeys[action] ?? '';
// KeyboardEvent.code to the names the app registers: KeyP to P, Digit1 to 1, ArrowLeft to Left.
const keyName = code => code.replace(/^Key|^Digit|^Arrow/, '').replace(/^Numpad/, 'Numpad');
function combination(event) {
  const key = keyName(event.code);
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(event.code) || /^Numpad/.test(key)) return null;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win', key].filter(Boolean).join('+');
}
document.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { recording = null; return refreshPanel('shortcuts'); }
  const keys = event.key === 'Backspace' ? '' : combination(event);
  if (keys === null) return;
  if (keys && !/(Ctrl|Alt|Win)\+/.test(keys) && !/^F\d+$/.test(keys)) return toast('Use Ctrl, Alt or Win with the key, so typing elsewhere still works.');
  change('shortcuts', {...settings.shortcuts, [recording]: keys});
  recording = null;
  refreshPanel('shortcuts');
}, true);
tabs.push({id: 'shortcuts', label: 'Shortcuts', order: 9, render(body) {
  body.append(h('h2', {text: 'System-wide shortcuts'}),
    h('p', {text: settings.hotkeys ? 'These work from any app. Click one, then press the new keys; Backspace clears it.' : 'Turn on System-wide shortcuts in settings to use these from any app.'}),
    h('ul', {cls: 'list'}, Object.keys(appInfo.hotkeys).map(action => {
      const status = hotkeyStatus[action];
      return h('li', {}, h('span', {cls: 'grow', text: ACTION_NAMES[action] || action}),
        status && status !== 'ok' ? h('span', {cls: 'dim', text: status === 'in use' ? 'In use by another app' : 'Not valid'}) : null,
        h('button', {cls: 'btn', type: 'button', text: recording === action ? 'Press keys…' : keysFor(action) || 'Off',
          onclick: () => { recording = action; refreshPanel('shortcuts'); }}));
    })),
    h('div', {cls: 'row'}, h('button', {cls: 'btn', type: 'button', text: 'Reset to defaults', onclick: () => change('shortcuts', {})}),
      settings.hotkeys ? null : h('button', {cls: 'btn primary', type: 'button', text: 'Turn on', onclick: () => change('hotkeys', true)})));
}});

// --- Phone remote ---
function qrCode({size, modules}) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`);
  svg.setAttribute('width', '220');
  svg.setAttribute('height', '220');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for the phone remote');
  const background = document.createElementNS(ns, 'rect');
  for (const [name, value] of [['x', -4], ['y', -4], ['width', size + 8], ['height', size + 8], ['fill', '#fff']]) background.setAttribute(name, value);
  const path = document.createElementNS(ns, 'path');
  let d = '';
  for (let i = 0; i < modules.length; i++) if (modules[i] === '1') d += `M${i % size} ${Math.floor(i / size)}h1v1h-1z`;
  path.setAttribute('d', d);
  svg.append(background, path);
  return svg;
}
tabs.push({id: 'remote', label: 'Remote', order: 10, render(body) {
  body.append(h('h2', {text: 'Phone remote'}));
  if (!settings.remote) {
    return body.append(h('p', {text: 'Control GoLow from your phone: play, pause, skip, volume and like. Your phone needs to be on the same Wi-Fi as this PC.'}),
      h('button', {cls: 'btn primary', type: 'button', text: 'Turn on', onclick: () => { change('remote', true); setTimeout(() => refreshPanel('remote'), 600); }}));
  }
  const box = h('div', {}, h('p', {text: 'Starting…'}));
  body.append(box);
  call('remote_info').then(info => {
    box.replaceChildren(h('p', {text: 'Scan with your phone\'s camera, or open this address on it:'}),
      h('div', {style: 'display:grid;place-items:center;padding:8px'}, qrCode(info)),
      h('p', {cls: 'clip', text: info.url, title: info.url}),
      h('p', {text: 'Windows may ask whether GoLow can use private networks: allow it for the remote to work. Anyone with this address on your network can control playback, so treat it like a password.'}));
  }, error => box.replaceChildren(h('p', {text: error.message})));
}});
// The phone shows what plays. The page tells the app on changes, not every second.
let remoteSent = {};
on('tick', () => {
  if (!settings.remote) return;
  const state = {title: player.title, artist: player.artist, playing: player.playing, passed: position(), total: player.total, at: Date.now(),
    artwork: tracks.get(player.path)?.artwork || ''};
  const drift = Math.abs(remoteSent.passed + (Date.now() - remoteSent.at) / 1000 * (remoteSent.playing ? 1 : 0) - state.passed);
  if (state.title === remoteSent.title && state.playing === remoteSent.playing && drift < 3 && Date.now() - remoteSent.at < 30000) return;
  remoteSent = state;
  call('remote_state', state).catch(() => {});
});

// --- Updates ---
let update = null;
async function checkForUpdate() {
  try {
    const found = await call('update_check', {}, 60000);
    if (!found) return toast(`GoLow ${appInfo.version} is the latest version.`);
    emit('app', 'update', found);
  } catch (error) { toast('Could not check for updates: ' + error.message); }
}
on('app', (name, data) => {
  if (name === 'hotkeys') { hotkeyStatus = data || {}; refreshPanel('shortcuts'); }
  if (name === 'update' && data?.version && data.version !== update?.version) {
    update = data;
    toast(`GoLow ${data.version} is available.`, {label: 'Install', run: async () => {
      toast(`Downloading GoLow ${data.version}…`);
      try {
        await call('update_install', {}, 300000);
        toast(`GoLow ${data.version} is installed.`, {label: 'Restart now', run: () => call('restart').catch(error => toast(error.message))}, 30000);
      } catch (error) { toast(error.message, null, 10000); }
    }}, 20000);
  }
});

// --- Accounts ---
tabs.push({id: 'accounts', label: 'Accounts', order: 11, render(body) {
  body.append(h('h2', {text: 'Accounts'}), h('p', {text: 'Each account keeps its own sign-in, settings and history. Switching restarts GoLow.'}));
  const list = h('ul', {cls: 'list'});
  body.append(list);
  call('profiles').then(({current, names}) => {
    list.replaceChildren(...names.map(name => h('li', {}, h('span', {cls: 'grow', text: name || 'Main account'}),
      name === current ? h('span', {cls: 'dim', text: 'Open now'}) :
        h('button', {cls: 'btn', type: 'button', text: 'Switch', onclick: () => call('switch_profile', {name}).catch(error => toast(error.message))}))));
  }, error => list.replaceChildren(h('li', {text: error.message})));
  const name = h('input', {type: 'text', placeholder: 'Name, for example Work', 'aria-label': 'New account name', maxlength: '32'});
  body.append(h('h3', {text: 'Add an account'}), h('div', {cls: 'row'}, name,
    h('button', {cls: 'btn primary', type: 'button', text: 'Add and switch', onclick: () => call('add_profile', {name: name.value}).catch(error => toast(error.message))})));
}});
