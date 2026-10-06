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
xhr.setRequestHeader = function (name, value) {
  if (pending.has(this) && /^authorization$/i.test(name) && /^OAuth \S+$/.test(value)) session.token = value;
  return xhrHeader.call(this, name, value);
};
function tapped() {
  const raw = pending.get(this);
  emit('health', this.status, raw);
  if (this.status < 200 || this.status >= 300 || !['', 'text', 'json'].includes(this.responseType)) return;
  let json;
  try { json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); } catch { return; }
  received(raw, json);
}
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
