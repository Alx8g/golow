// Track lists everywhere: badges, filters, the blocklist with auto-skip, the feed switches,
// and the Likes tools (filter, true shuffle, sorting).
menu.push(
  {section: 'Lists and feed', key: 'mixes_everywhere', label: 'Feed filters apply on every list', def: false,
    hint: 'The Mixes and Played switches also filter profiles, Likes, search and playlists.'},
  {section: 'Lists and feed', key: 'badges', label: 'Badges: preview, unavailable, free download, AI', def: true},
  {section: 'Lists and feed', key: 'hide_unavailable', label: 'Hide tracks not available here', def: false},
  {section: 'Lists and feed', key: 'skip_previews', label: 'Skip 30-second previews', def: false, hint: 'Go+ tracks you can only preview.'},
  {section: 'Lists and feed', key: 'hide_ai', label: 'Hide tracks tagged as AI', def: false,
    hint: 'Uses tags and descriptions such as "Suno" or "AI generated". Untagged AI music is not caught.'},
  {section: 'Lists and feed', key: 'skip_ai', label: 'Skip tracks tagged as AI', def: false},
  {section: 'Lists and feed', key: 'hide_tags', label: 'Hide genres and tags', type: 'text', def: '', placeholder: 'phonk, hardstyle'},
);

// --- Played tracks, from listening history and from what plays here ---
const played = new Set(stored('played', []));
function remember(paths) {
  const fresh = paths.filter(path => path && !played.has(path));
  if (!fresh.length) return;
  for (const path of fresh) played.add(path);
  store('played', [...played].slice(-5000));
  unsee();
}
on('data', (url, json) => {
  if (url.pathname.startsWith('/me/play-history')) remember((json?.collection || []).map(item => pathOf(item.track?.permalink_url)));
  if (json?.collection) unsee();
});
on('track', path => remember([path]));

// --- Blocklist ---
const blocklist = stored('blocklist', {tracks: {}, artists: {}});
const isBlocked = (path, artist) => !!(path && blocklist.tracks[path]) || !!(artist && blocklist.artists[artist]);
function block(kind, path, name) {
  if (!path) return;
  if (name === null) delete blocklist[kind][path]; else blocklist[kind][path] = name;
  store('blocklist', blocklist);
  unsee();
  refreshPanel('blocked');
}
const AI = /\b(suno|udio|riffusion|ai[\s-]?(generated|music|song|cover|remix|vocals?|made|track|beat|rap)|made (with|by) ai|artificial intelligence)\b|#ai\b/i;
const aiLike = track => !!track && AI.test(`${track.title} ${track.tags} ${track.genre} ${(track.description || '').slice(0, 3000)}`);
const tagsOf = track => [track.genre, ...[...String(track.tags || '').matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2])].map(tag => String(tag || '').toLowerCase().trim()).filter(Boolean);
const hiddenTags = () => String(pref('hide_tags') || '').toLowerCase().split(',').map(tag => tag.trim()).filter(Boolean);

// --- Marking list items from the API data the page loaded ---
const ITEMS = '.soundList__item, .searchList__item, .badgeList__item, .trackList__item, .soundBadgeList__item, .queue__itemWrapper, .compactTrackList__item';
const TITLE_LINK = 'a.soundTitle__title, a.playableTile__artworkLink, .playableTile__mainHeading a, a.trackItem__trackTitle, .queueItemView__title a, a.soundBadge__title, .soundTitle__title a';
const ARTIST_LINK = 'a.soundTitle__username, a.trackItem__username, a.queueItemView__username, .playableTile__usernameHeading a, a.soundBadge__username';
function unsee() {
  for (const item of document.querySelectorAll('[data-golow-seen]')) item.removeAttribute('data-golow-seen');
  markLists();
}
function mark(item) {
  item.setAttribute('data-golow-seen', '');
  const link = item.querySelector(TITLE_LINK) || item.querySelector('a[href^="/"]');
  const path = pathOf(link?.getAttribute('href') || ''), track = tracks.get(path);
  const artist = track?.user || pathOf(item.querySelector(ARTIST_LINK)?.getAttribute('href') || '');
  const flags = {
    long: (track?.duration || 0) > 20 * 60 * 1000, played: played.has(path), blocked: isBlocked(path, artist),
    region: track?.policy === 'BLOCK', preview: track?.policy === 'SNIP', ai: aiLike(track), free: !!track?.free,
    tag: !!track && hiddenTags().some(tag => tagsOf(track).includes(tag)),
  };
  for (const [name, on] of Object.entries(flags)) item.toggleAttribute('data-golow-' + name, on);
  if (!link) return;
  const badges = [flags.preview && 'Preview', flags.region && 'Not available', flags.free && 'Free download', flags.ai && 'AI?'].filter(Boolean);
  if (badges.length && pref('badges')) link.setAttribute('data-golow-badge', badges.join(' · ')); else link.removeAttribute('data-golow-badge');
}
function markLists() {
  for (const item of document.querySelectorAll(`:is(${ITEMS}):not([data-golow-seen])`)) mark(item);
}
on('page', markLists);
on('apply', unsee);
let routed = location.pathname;
on('page', () => {
  if (location.pathname === routed) return;
  routed = location.pathname;
  restyle();
});
const feedPage = () => location.pathname === '/feed';
css.push(() => {
  const filtering = feedPage() || pref('mixes_everywhere');
  const filters = filtering ? [...settings.mixes ? [] : ['[data-golow-long]'], ...settings.played ? [] : ['[data-golow-played]']] : [];
  return hide([...filters, '[data-golow-blocked]', '[data-golow-tag]', ...pref('hide_unavailable') ? ['[data-golow-region]'] : [],
    ...pref('hide_ai') ? ['[data-golow-ai]'] : []].map(flag => `:is(${ITEMS})${flag}`)) +
    `html:root [data-golow-region]:not(.queue__itemWrapper){opacity:.5}` +
    'html:root [data-golow-badge]::after{content:attr(data-golow-badge);display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;' +
    'background:#5cf2a826;color:#5cf2a8;font:600 10px/16px system-ui,sans-serif;vertical-align:middle}';
});

// The feed switches sit next to SoundCloud's own Reposts switch.
function feedSwitches() {
  const filters = document.querySelector('.stream__filter');
  if (filters && !filters.querySelector('[data-golow]')) {
    for (const [key, label] of [['mixes', 'Mixes'], ['played', 'Played']]) {
      const item = h('div', {cls: 'streamFilter__item sc-ml-2x', 'data-golow': key},
        h('label', {cls: 'streamFilter__label sc-type-light sc-text-secondary sc-type-small sc-text-body sc-mr-1x', text: label}),
        h('label', {cls: 'toggle sc-toggle sc-toggle-small'}, h('span', {cls: 'sc-toggle-handle'}),
          h('input', {cls: 'sc-toggle-input sc-visuallyhidden', type: 'checkbox', onchange: event => change(key, event.target.checked)})));
      filters.append(item);
    }
  }
  for (const item of document.querySelectorAll('[data-golow]')) {
    item.querySelector('input').checked = settings[item.dataset.golow];
    item.querySelector('.sc-toggle').classList.toggle('sc-toggle-on', settings[item.dataset.golow]);
  }
}
on('page', () => { if (feedPage()) feedSwitches(); });
on('apply', feedSwitches);

// --- Skipping what you never want to hear ---
function unwanted(path) {
  const track = tracks.get(path);
  if (isBlocked(path, track?.user || player.artistPath)) return 'blocked';
  if (pref('skip_previews') && track?.policy === 'SNIP') return 'preview';
  if (pref('skip_ai') && aiLike(track)) return 'AI-tagged';
  return null;
}
on('track', path => {
  // The user chose this one themselves: play it.
  if (Date.now() - picked.at < 2500) return;
  const reason = unwanted(path);
  if (!reason) return;
  advance();
  toast(`Skipped a ${reason} track: ${player.title}`);
});
const advance = () => (managed ? play(pos + 1) : commands.next());
barButtons.push({name: 'block', icon: 'block', label: 'Never play…', narrow: true, onclick: event => {
  if (!player.path) return;
  popup(event.currentTarget, [{heading: 'Never play'},
    {label: `This track`, action: () => { block('tracks', player.path, `${player.title} – ${player.artist}`); advance(); }},
    {label: `Anything by ${player.artist}`.slice(0, 60), action: () => { block('artists', player.artistPath, player.artist); advance(); }},
    {label: 'Show the blocklist', action: () => openPanel('blocked')}]);
}});
tabs.push({id: 'blocked', label: 'Blocked', order: 8, render(body) {
  body.append(h('h2', {text: 'Never play'}), h('p', {text: 'Blocked artists and tracks are hidden from lists and skipped when they come up.'}));
  for (const [kind, title] of [['artists', 'Artists'], ['tracks', 'Tracks']]) {
    const entries = Object.entries(blocklist[kind]);
    body.append(h('h3', {text: `${title} · ${entries.length}`}), h('ul', {cls: 'list'}, entries.map(([path, name]) =>
      h('li', {}, h('a', {cls: 'grow clip', href: path, text: name}), h('button', {cls: 'btn', type: 'button', text: 'Unblock', onclick: () => block(kind, path, null)})))));
  }
}});

// --- Likes: a filter box, a true shuffle over every like, and sorting ---
// SoundCloud's queue only ever holds about 27 tracks, so its own shuffle keeps repeating the
// same few. GoLow keeps its own order over every like and plays each pick with SoundCloud's
// player while the Likes page stays open, including minimized or in the tray.
const LIKE_LINK = '.playableTile__artworkLink, .soundTitle__title';
const listItems = () => document.querySelectorAll('.lazyLoadingList :is(.badgeList__item, .soundList__item)');
const itemPath = item => pathOf(item.querySelector(LIKE_LINK)?.getAttribute('href') || '');
let managed = null, pos = 0, nearEnd = false, loading = null;
function play(next) {
  const at = managed?.[next];
  const item = at && [...listItems()].find(candidate => itemPath(candidate) === at);
  if (!item) return stopManaged();
  [pos, nearEnd] = [next, false];
  item.querySelector('.sc-button-play')?.click();
}
function stopManaged() {
  managed = null;
  const button = document.querySelector('[data-golow-tools] [data-shuffle]');
  if (button) button.textContent = 'Shuffle all';
}
on('track', path => {
  if (!managed || path === managed[pos]) return;
  const index = managed.indexOf(path), own = Date.now() - picked.at < 2500 && picked.inList;
  if (own && index >= 0) pos = index;      // The user picked a like: carry on from there.
  else if (own) stopManaged();             // The user played something else.
  else play(pos + 1);                      // SoundCloud advanced on its own: take the next pick.
});
on('tick', () => {
  if (!managed || !player.playing || player.path !== managed[pos]) return;
  if (!nearEnd && player.passed > 0 && player.total - player.passed <= 1) {
    nearEnd = true;
    play(pos + 1);
  }
});
function loadAll(progress = () => {}) {
  const page = location.pathname;
  return loading ||= (async () => {
    for (let count = -1, stable = 0; stable < 4 && location.pathname === page;) {
      const now = listItems().length;
      [stable, count] = [now === count ? stable + 1 : 0, now];
      progress(count);
      scrollTo(0, document.documentElement.scrollHeight);
      await wait(350);
    }
    scrollTo(0, 0);
    loading = null;
  })();
}
const playable = path => path && !unwanted(path) && tracks.get(path)?.policy !== 'BLOCK';
const SORTS = {
  title: (a, b) => (a.track?.title || a.text).localeCompare(b.track?.title || b.text),
  artist: (a, b) => (a.track?.artist || '').localeCompare(b.track?.artist || '') || (a.track?.title || '').localeCompare(b.track?.title || ''),
  longest: (a, b) => (b.track?.duration || 0) - (a.track?.duration || 0),
  shortest: (a, b) => (a.track?.duration || 0) - (b.track?.duration || 0),
  oldest: (a, b) => b.index - a.index,
};
function sortLikes(kind) {
  const items = [...listItems()].map((item, index) => ({item, index, path: itemPath(item), track: tracks.get(itemPath(item)), text: item.textContent.trim()}));
  if (kind && SORTS[kind]) items.sort(SORTS[kind]);
  items.forEach(({item}, order) => { item.style.order = kind ? String(order) : ''; });
  document.querySelector('.lazyLoadingList__list')?.toggleAttribute('data-golow-sorted', !!kind);
  return items.map(entry => entry.path).filter(playable);
}
css.push(() => 'html:root [data-golow-sorted]{display:flex!important;flex-wrap:wrap}html:root .badgeList [data-golow-sorted]>li{float:none!important}');
function likesTools() {
  const top = document.querySelector('.collectionSection__top');
  if (!top || top.querySelector('[data-golow-tools]')) return;
  const input = h('input', {type: 'search', placeholder: 'Filter likes', 'aria-label': 'Filter likes', cls: 'sc-input sc-input-small sc-mr-1x'});
  const sort = h('select', {'aria-label': 'Sort likes', cls: 'sc-mr-1x'}, [['', 'Recently liked'], ['title', 'Title A–Z'], ['artist', 'Artist A–Z'],
    ['longest', 'Longest first'], ['shortest', 'Shortest first'], ['oldest', 'Oldest liked first']].map(([value, text]) => h('option', {value, text})));
  const shuffle = h('button', {type: 'button', cls: 'sc-button sc-button-medium', 'data-shuffle': '', text: 'Shuffle all'});
  const ordered = h('button', {type: 'button', cls: 'sc-button sc-button-medium sc-ml-1x', text: 'Play in this order', hidden: true});
  input.addEventListener('input', async () => {
    const text = input.value.trim().toLowerCase();
    if (text) await loadAll();
    for (const item of listItems()) item.toggleAttribute('data-golow-filtered', !!text && !item.textContent.toLowerCase().includes(text));
  });
  sort.addEventListener('change', async () => {
    if (sort.value) { sort.disabled = true; await loadAll(); sort.disabled = false; }
    sortLikes(sort.value);
    ordered.hidden = !sort.value;
  });
  shuffle.addEventListener('click', async () => {
    if (managed) return stopManaged();
    shuffle.disabled = true;
    await loadAll(count => { shuffle.textContent = `Loading ${count}…`; });
    shuffle.disabled = false;
    // Fisher-Yates over every loaded like that GoLow would not skip.
    managed = [...listItems()].map(itemPath).filter(path => path && (!unwanted(path) || !tracks.has(path)));
    for (let i = managed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [managed[i], managed[j]] = [managed[j], managed[i]];
    }
    shuffle.textContent = 'Stop shuffle';
    document.querySelector('.shuffleControl.m-shuffling')?.click();
    play(0);
  });
  ordered.addEventListener('click', () => {
    managed = sortLikes(sort.value);
    shuffle.textContent = 'Stop';
    document.querySelector('.shuffleControl.m-shuffling')?.click();
    play(0);
  });
  const tools = h('div', {cls: 'g-flex-row-centered sc-mr-2x', 'data-golow-tools': ''}, input, sort, shuffle, ordered);
  (top.querySelector('.collectionSection__action') || top.lastChild).before(tools);
}
on('page', () => { if (/^\/[^/]+\/likes$/.test(location.pathname)) likesTools(); });
