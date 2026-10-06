'use strict';
// GoLow's page script. build.rs joins src/page/*.js in file-name order inside one function, so
// every file shares this scope. Later files extend earlier ones through `on(...)` and `menu`.
if (window.top !== window || location.protocol !== 'https:' ||
    !['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) return;
if (window.__scClient) return;

// Settings the app persists in settings.json; Rust validates every key and value.
const settings = Object.assign({cleanup: true, efficiency: true, compact: false, always_on_top: false, comments: true, autoplay: true,
  mixes: true, played: true, top_comments: false, discord: false, lastfm: false, hotkeys: false, shortcuts: {}, start_page: 'discover',
  gpu: true, now_file: false, remote: false, notify: false, updates: true, background: false, tray: false}, window.__scInitialSettings);
const NATIVE = Object.keys(settings);
// Same-origin copies avoid briefly restoring startup values on each full navigation.
try {
  const cached = JSON.parse(localStorage.getItem('sc-client-settings-v1') || '{}');
  for (const key of NATIVE) if (typeof cached[key] === typeof settings[key] && cached[key] !== null) settings[key] = cached[key];
} catch {}
const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);

// Start the connections to SoundCloud's API and image servers while its code is still loading,
// instead of when the first request goes out. The API is called without cookies, so its hint is
// anonymous to share that connection.
function preconnect() {
  const root = document.head || document.documentElement;
  if (!root) return false;
  for (const [href, anonymous] of [['https://api-v2.soundcloud.com', true], ['https://i1.sndcdn.com', false]]) {
    const link = document.createElement('link');
    Object.assign(link, {rel: 'preconnect', href});
    if (anonymous) link.crossOrigin = 'anonymous';
    root.append(link);
  }
  return true;
}
if (!preconnect()) new MutationObserver((_, observer) => preconnect() && observer.disconnect()).observe(document, {childList: true});

// Page-only state (speeds, bookmarks, lists) lives in SoundCloud's storage for this profile.
const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem('golow-' + key)) ?? fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem('golow-' + key, JSON.stringify(value)); } catch {} };

// Feature hooks. A feature that throws (say, after a SoundCloud redesign) is logged and skipped,
// so it never takes the others down with it.
const hooks = {track: [], tick: [], page: [], apply: [], frame: [], data: [], health: [], key: [], app: []};
const on = (name, fn) => hooks[name].push(fn);
function emit(name, ...args) {
  for (const fn of hooks[name]) {
    try { fn(...args); } catch (error) { console.debug('[GoLow]', name, error); }
  }
}

// Settings menu entries, grouped by section. Native keys persist in the app; the rest locally.
// {section, key, label, type: 'switch' | 'select' | 'text' | 'button', options, def, hint, action}
const menu = [];
const local = stored('prefs', {});
const entry = key => menu.find(item => item.key === key);
const pref = key => (NATIVE.includes(key) ? settings[key] : key in local ? local[key] : entry(key)?.def);

const pathOf = url => { try { return new URL(url, location.origin).pathname.replace(/\/$/, '') || '/'; } catch { return null; } };
const send = value => window.ipc?.postMessage?.(JSON.stringify(value));
const save = () => {
  try {
    const value = JSON.stringify(settings);
    if (localStorage.getItem('sc-client-settings-v1') !== value) localStorage.setItem('sc-client-settings-v1', value);
  } catch {}
};
// SoundCloud prints times as m:ss or h:mm:ss.
const toSeconds = text => String(text).split(':').reduce((total, part) => total * 60 + Number(part), 0);
const seconds = selector => toSeconds(document.querySelector(selector + ' [aria-hidden]')?.textContent || '0');
const clock = value => {
  const s = Math.max(0, Math.floor(value)), hours = Math.floor(s / 3600), rest = new Date((s % 3600) * 1000).toISOString().slice(14, 19);
  return hours ? `${hours}:${rest}` : rest.replace(/^0/, '');
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Builds DOM from data. Text always goes in as text, never markup: titles, descriptions and
// comments are written by strangers.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else if (['hidden', 'checked', 'value', 'disabled', 'selected'].includes(key)) el[key] = value;
    else el.setAttribute(key === 'cls' ? 'class' : key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return el;
}

// Requests to the app with a reply: window.__scClient.reply(id, value) settles them.
const calls = new Map();
let callId = 0;
function call(name, args = {}, timeout = 30000) {
  if (!window.ipc?.postMessage) return Promise.reject(new Error('GoLow app not available'));
  const id = ++callId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(name + ' timed out')); }, timeout);
    calls.set(id, {resolve, reject, timer});
    send({call: name, id, args});
  });
}
