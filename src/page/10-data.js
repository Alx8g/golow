// SoundCloud's API answers, read as the page receives them. Track details feed filters, badges,
// tracklists and backups; the session parameters let GoLow make the same read-only requests.
const API = 'https://api-v2.soundcloud.com/';
const tracks = new Map(), trackIds = new Map(), users = new Map();
const session = {client: null, app: null, token: null, me: null, following: null};

function keep(t) {
  const path = pathOf(t.permalink_url);
  if (!path) return;
  const user = t.user || {}, old = tracks.get(path);
  const text = t.description ?? old?.description ?? null;
  tracks.set(path, {id: t.id, path, title: t.title || '', artist: user.username || old?.artist || '', user: pathOf(user.permalink_url) || old?.user,
    userId: user.id ?? t.user_id, duration: t.full_duration || t.duration || 0, policy: t.policy || old?.policy || '', genre: t.genre || '',
    tags: t.tag_list || '', description: text, created: t.created_at, released: t.display_date || t.release_date || t.created_at,
    artwork: t.artwork_url || user.avatar_url || '', comments: t.comment_count || 0, purchase: t.purchase_url || '',
    free: !!(t.downloadable && t.has_downloads_left) || /\bfree\b/i.test(t.purchase_title || ''),
    transcodings: (t.media?.transcodings || old?.transcodings || []).map(m => ({url: (m.url || '').split('?')[0], preset: m.preset, quality: m.quality, protocol: m.protocol || m.format?.protocol}))});
  trackIds.set(t.id, path);
}

// Walks only the containers SoundCloud nests tracks in, with a budget, so a large answer
// costs one pass and never a deep scan.
function absorb(json) {
  const stack = [json];
  for (let budget = 20000; stack.length && budget > 0; budget--) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') stack.push(item); continue; }
    if (value.kind === 'track' && value.permalink_url) keep(value);
    if (value.kind === 'user' && value.permalink_url) users.set(pathOf(value.permalink_url), value.id);
    for (const key of ['collection', 'track', 'playlist', 'tracks', 'origin', 'item']) if (value[key] && typeof value[key] === 'object') stack.push(value[key]);
  }
}

function learn(raw) {
  try {
    const params = new URL(raw).searchParams;
    session.client = params.get('client_id') || session.client;
    session.app = params.get('app_version') || session.app;
  } catch {}
}
function received(raw, json) {
  absorb(json);
  const url = new URL(raw);
  if (url.pathname === '/me' && json?.id) session.me = {id: json.id, path: pathOf(json.permalink_url), name: json.username};
  if (/^\/users\/\d+\/followings\/ids$/.test(url.pathname) && Array.isArray(json?.collection)) session.following = new Set(json.collection);
  emit('data', url, json);
}

const pending = new WeakMap(), xhr = XMLHttpRequest.prototype, xhrOpen = xhr.open, xhrHeader = xhr.setRequestHeader;
xhr.open = function (method, url, ...rest) {
  const raw = String(url);
  if (raw.startsWith(API)) {
    pending.set(this, raw);
    learn(raw);
    this.addEventListener('loadend', tapped);
  }
  return xhrOpen.call(this, method, url, ...rest);
};
const sentHeaders = new WeakMap();
xhr.setRequestHeader = function (name, value) {
  if (pending.has(this)) {
    if (/^authorization$/i.test(name) && /^OAuth \S+$/.test(value)) session.token = value;
    sentHeaders.set(this, [...sentHeaders.get(this) || [], [name, value]]);
  }
  return xhrHeader.call(this, name, value);
};
function tapped() {
  const raw = pending.get(this);
  emit('health', this.status, raw);
  if (this.status < 200 || this.status >= 300 || !['', 'text', 'json'].includes(this.responseType)) return;
  let json;
  try { json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); } catch { return; }
  if (!fromCache.has(this)) keepInstant(raw, this);
  received(raw, json);
}

// Instant Home. Home waits on one slow API call (two seconds or more) for your mixes. The last
// answer, kept in GoLow's folder, is handed to SoundCloud at once on startup, and a fresh copy
// is fetched in the background for next time. Only for the account that fetched it, and only
// when it is under a day old.
menu.push({section: 'Interface', key: 'instant_home', label: 'Instant Home', def: true,
  hint: 'Shows your last Home mixes straight away at startup, and fetches fresh ones for next time.'});
const INSTANT = '/mixed-selections', DAY_MS = 86400000;
const fromCache = new WeakSet(), refreshes = new WeakSet();
const instant = {cache: null, served: false, savedAt: 0};
instant.ready = pref('instant_home') && window.ipc
  ? call('load', {name: 'instant-home'}, 3000).then(text => { instant.cache = JSON.parse(text || 'null'); }, () => {})
  : Promise.resolve();
// A fingerprint of the session's sign-in, so one account's Home never shows for another.
const fingerprint = text => { let hash = 0x811c9dc5; for (const c of String(text)) hash = Math.imul(hash ^ c.charCodeAt(0), 0x01000193) >>> 0; return hash.toString(16); };
const authOf = request => (sentHeaders.get(request) || []).find(([name]) => /^authorization$/i.test(name))?.[1] || '';
function keepInstant(raw, request) {
  if (new URL(raw).pathname !== INSTANT || !pref('instant_home') || Date.now() - instant.savedAt < 10 * 60000 || !window.ipc) return;
  instant.savedAt = Date.now();
  const entry = {at: Date.now(), auth: fingerprint(authOf(request)), body: request.responseText};
  call('save', {name: 'instant-home', data: JSON.stringify(entry)}).catch(() => {});
}
function respond(request, raw, body) {
  fromCache.add(request);
  const values = {readyState: 4, status: 200, statusText: 'OK', responseURL: raw, responseText: body,
    response: request.responseType === 'json' ? JSON.parse(body) : body};
  for (const [name, value] of Object.entries(values)) Object.defineProperty(request, name, {value, configurable: true});
  request.getAllResponseHeaders = () => 'content-type: application/json; charset=utf-8\r\n';
  request.getResponseHeader = name => (/^content-type$/i.test(name) ? 'application/json; charset=utf-8' : null);
  for (const type of ['readystatechange', 'load', 'loadend']) request.dispatchEvent(new ProgressEvent(type));
}
const xhrSend = xhr.send;
xhr.send = function (...args) {
  const raw = pending.get(this);
  if (!raw || refreshes.has(this) || instant.served || !pref('instant_home') || performance.now() > 20000 || new URL(raw).pathname !== INSTANT) {
    return xhrSend.apply(this, args);
  }
  instant.served = true;
  const request = this;
  // The saved copy is read from disk at startup; wait briefly for it rather than miss it.
  Promise.race([instant.ready, wait(400)]).then(() => {
    const cache = instant.cache;
    if (!cache || Date.now() - cache.at > DAY_MS || cache.auth !== fingerprint(authOf(request))) return xhrSend.apply(request, args);
    respond(request, raw, cache.body);
    // Fetch the fresh copy once startup has settled, with the same headers, for next time.
    setTimeout(() => {
      const fresh = new XMLHttpRequest();
      refreshes.add(fresh);
      fresh.open('GET', raw);
      for (const [name, value] of sentHeaders.get(request) || []) fresh.setRequestHeader(name, value);
      instant.savedAt = 0;
      fresh.send();
    }, 5000);
  });
};
// The redesigned pages use fetch for some calls.
const nativeFetch = window.fetch;
window.fetch = function (input, init) {
  const result = nativeFetch.apply(this, arguments);
  const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (raw.startsWith(API)) {
    learn(raw);
    result.then(response => {
      emit('health', response.status, raw);
      if (response.ok && /json/.test(response.headers.get('content-type') || '')) response.clone().json().then(json => received(raw, json), () => {});
    }, () => emit('health', 0, raw));
  }
  return result;
};

// GoLow's own requests: GETs only, one at a time with a pause between them, backing off when
// SoundCloud says to slow down. They look like the page's own and go through its session.
let lane = Promise.resolve();
function api(path, params = {}) {
  const run = async () => {
    for (let i = 0; !session.client && i < 60; i++) await wait(250);
    if (!session.client) throw new Error('SoundCloud is still loading');
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('client_id', session.client);
    if (session.app && !url.searchParams.has('app_version')) url.searchParams.set('app_version', session.app);
    for (let attempt = 0; ; attempt++) {
      const {status, json} = await get(url.href);
      if ((status === 429 || status >= 500) && attempt < 2) { await wait(10000 * (attempt + 1)); continue; }
      if (status < 200 || status >= 300) throw Object.assign(new Error(`SoundCloud answered ${status || 'nothing'}`), {status});
      return json;
    }
  };
  const result = lane.then(run, run);
  lane = result.then(() => wait(350), () => wait(350));
  return result;
}
function get(url) {
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    if (session.token) request.setRequestHeader('Authorization', session.token);
    request.setRequestHeader('Accept', 'application/json, text/javascript, */*; q=0.01');
    request.onloadend = () => {
      let json = null;
      try { json = JSON.parse(request.responseText); } catch {}
      resolve({status: request.status, json});
    };
    request.send();
  });
}
// Follows next_href links; stops at `max` items.
async function collect(path, params, max = 5000, progress = () => {}) {
  const items = [];
  for (let next = path, first = true; next && items.length < max; first = false) {
    const page = await api(next, first ? params : {});
    items.push(...(page?.collection || []));
    progress(items.length);
    next = page?.next_href || null;
  }
  return items.slice(0, max);
}
async function me() {
  if (!session.me) received(API + 'me', await api('me'));
  return session.me;
}
// Track details for a page path, from what the page loaded or one resolve request.
async function trackAt(path) {
  if (tracks.get(path)?.description != null) return tracks.get(path);
  try { absorb(await api('resolve', {url: 'https://soundcloud.com' + path})); } catch {}
  return tracks.get(path) || null;
}
