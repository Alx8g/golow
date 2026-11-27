// Power-user tools: a persistent GoLow queue, a command palette, listening recaps and
// playlist maintenance. These build on the player, radar, backup and stats pieces above.

// --- Persistent queue ---
// SoundCloud's own Next up is fragile and hard to restore. GoLow keeps its own ordered list in
// local storage, resumes it after a restart, and uses playPath for tracks that are not on the page.
const queueDefaults = {items: [], index: 0, active: false};
const queueState = Object.assign({}, queueDefaults, stored('queue', queueDefaults));
if (!Array.isArray(queueState.items)) queueState.items = [];
queueState.items = queueState.items.filter(item => item && typeof item.path === 'string').slice(0, 1000);
queueState.index = Math.max(0, Math.min(Number(queueState.index) || 0, Math.max(0, queueState.items.length - 1)));
let queueLastAdvance = 0;

function saveQueue() {
  queueState.index = Math.max(0, Math.min(queueState.index, Math.max(0, queueState.items.length - 1)));
  if (!queueState.items.length) queueState.active = false;
  store('queue', queueState);
  refreshPanel('queue');
}
function queueItemFor(path) {
  const known = tracks.get(path);
  return {
    path,
    title: known?.title || decodeURIComponent(path.split('/').pop() || 'Track').replace(/[-_]+/g, ' '),
    artist: known?.artist || path.split('/')[1] || '',
    duration: known?.duration || 0,
    artwork: known?.artwork || '',
    added: Date.now(),
  };
}
async function queueAdd(path, next = false, quiet = false) {
  path = pathOf(path || '');
  if (!path || path === '/') return false;
  if (!tracks.has(path)) await trackAt(path).catch(() => null);
  const item = queueItemFor(path);
  const existing = queueState.items.findIndex(entry => entry.path === path);
  if (existing >= 0) {
    queueState.items.splice(existing, 1);
    if (queueState.active && existing < queueState.index) queueState.index -= 1;
  }
  let at = next && queueState.active ? queueState.index + 1 : queueState.items.length;
  at = Math.max(0, Math.min(at, queueState.items.length));
  queueState.items.splice(at, 0, item);
  if (queueState.active && at <= queueState.index && queueState.items.length > 1) queueState.index += 1;
  saveQueue();
  if (!quiet) toast(`${next ? 'Queued next' : 'Added to GoLow queue'}: ${item.title}`);
  return true;
}
async function queueAddCurrent(next = false) {
  if (!player.path) return toast('Play or choose a track first.');
  await queueAdd(player.path, next);
}
function queueMove(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= queueState.items.length) return;
  [queueState.items[index], queueState.items[to]] = [queueState.items[to], queueState.items[index]];
  if (queueState.index === index) queueState.index = to;
  else if (queueState.index === to) queueState.index = index;
  saveQueue();
}
function queueRemove(index) {
  queueState.items.splice(index, 1);
  if (queueState.active && index < queueState.index) queueState.index -= 1;
  if (queueState.active && index === queueState.index) queueState.active = false;
  saveQueue();
}
async function playQueue(index = queueState.index) {
  const item = queueState.items[index];
  if (!item) return;
  queueState.index = index;
  queueState.active = true;
  saveQueue();
  closePanel();
  await playPath(item.path);
}
function queueExpected() {
  return queueState.active ? queueState.items[queueState.index] : null;
}
on('tick', () => {
  const expected = queueExpected();
  if (!expected || !player.playing || player.path !== expected.path || !player.total) return;
  if (queueState.index + 1 >= queueState.items.length || player.total - player.passed > 1) return;
  if (Date.now() - queueLastAdvance < 4000) return;
  queueLastAdvance = Date.now();
  playQueue(queueState.index + 1);
});
on('track', path => {
  if (!queueState.active) return;
  const expected = queueExpected();
  if (expected && path === expected.path) return;
  const index = queueState.items.findIndex(item => item.path === path);
  if (index >= 0) {
    queueState.index = index;
    saveQueue();
    return;
  }
  // A manual choice outside the queue takes precedence; the queue itself stays saved.
  queueState.active = false;
  saveQueue();
});
barButtons.push({name: 'queue', icon: 'plus', label: 'GoLow queue', narrow: true, onclick: event => {
  popup(event.currentTarget, [{heading: 'GoLow queue'},
    {label: 'Add current track', action: () => queueAddCurrent(false)},
    {label: queueState.active ? 'Show the queue' : 'Resume the queue', action: () => queueState.active ? openPanel('queue') : playQueue()},
    {label: 'Open queue', action: () => openPanel('queue')}]);
}});
tabs.push({id: 'queue', label: 'Queue', order: 1.5, render(body) {
  const current = queueExpected();
  body.append(h('div', {cls: 'row'}, h('h2', {text: 'GoLow queue'}),
    h('button', {cls: 'btn primary', type: 'button', text: queueState.active ? 'Playing' : 'Resume', disabled: !queueState.items.length || queueState.active,
      onclick: () => playQueue()}),
    h('button', {cls: 'btn', type: 'button', text: 'Add current', disabled: !player.path, onclick: () => queueAddCurrent(false)}),
    h('button', {cls: 'btn', type: 'button', text: 'Clear', disabled: !queueState.items.length, onclick: () => { queueState.items = []; queueState.active = false; saveQueue(); }})));
  if (!queueState.items.length) {
    return body.append(h('p', {text: 'Nothing queued yet. Add the current track from here or the player bar, or queue releases from Radar. The list survives restarts.'}));
  }
  body.append(h('p', {cls: 'dim', text: current ? `Now playing ${queueState.index + 1} of ${queueState.items.length}` : `${queueState.items.length} saved tracks`}),
    h('ol', {cls: 'list'}, queueState.items.map((item, index) => h('li', {cls: queueState.active && index === queueState.index ? 'current' : ''},
      h('div', {cls: 'grow'}, h('div', {cls: 'clip', text: item.title}), h('div', {cls: 'clip dim', text: item.artist || item.path})),
      h('button', {cls: 'btn', type: 'button', text: 'Play', onclick: () => playQueue(index)}),
      h('button', {cls: 'btn', type: 'button', text: '↑', title: 'Move up', disabled: index === 0, onclick: () => queueMove(index, -1)}),
      h('button', {cls: 'btn', type: 'button', text: '↓', title: 'Move down', disabled: index === queueState.items.length - 1, onclick: () => queueMove(index, 1)}),
      h('button', {cls: 'btn', type: 'button', text: '×', title: 'Remove', onclick: () => queueRemove(index)})))));
}});

// --- Command palette ---
let palette = null, paletteInput = null, paletteList = null, paletteIndex = 0, paletteShown = [];
function commandActions() {
  const actions = [
    {label: player.playing ? 'Pause' : 'Play', hint: 'Playback', run: () => commands.toggle()},
    {label: 'Next track', hint: 'Playback', run: () => commands.next()},
    {label: 'Previous track', hint: 'Playback', run: () => commands.previous()},
    {label: 'Skip forward', hint: 'Playback', run: () => commands.forward()},
    {label: 'Skip back', hint: 'Playback', run: () => commands.back()},
    {label: 'Like current track', hint: 'Playback', run: () => commands.like()},
    {label: 'Add current track to GoLow queue', hint: 'Queue', run: () => queueAddCurrent(false)},
    {label: 'Resume GoLow queue', hint: 'Queue', when: () => queueState.items.length && !queueState.active, run: () => playQueue()},
    {label: 'Open settings', hint: 'GoLow', run: () => openSettings(true)},
    {label: 'Refresh release radar', hint: 'Radar', run: () => refreshRadar()},
    {label: 'Back up library now', hint: 'Library', run: () => backup()},
  ];
  for (const tab of tabs) actions.push({label: `Open ${tab.label}`, hint: 'Panel', run: () => openPanel(tab.id)});
  return actions.filter(action => !action.when || action.when());
}
function paletteEnsure() {
  if (palette) return;
  overlayRoot.append(h('style', {text: `
    #palette{position:absolute;top:72px;left:50%;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));padding:8px;pointer-events:auto}
    #palette input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #444;border-radius:6px;background:#111;color:#fff;font:inherit;outline:none}
    #palette input:focus{border-color:#5cf2a8}#palette ol{list-style:none;margin:6px 0 0;padding:0;max-height:360px;overflow:auto}
    #palette button{width:100%;display:flex;gap:10px;align-items:center;padding:9px 10px;border:0;border-radius:5px;background:none;color:#ddd;text-align:left;cursor:pointer}
    #palette button.current,#palette button:hover{background:#5cf2a820;color:#fff}#palette .hint{margin-left:auto;color:#888;font-size:12px}`}));
  palette = h('section', {id: 'palette', cls: 'card', role: 'dialog', 'aria-label': 'Command palette', hidden: true},
    paletteInput = h('input', {type: 'search', placeholder: 'Type a command…', 'aria-label': 'Command palette'}),
    paletteList = h('ol'));
  paletteInput.addEventListener('input', () => paletteRender());
  paletteInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      paletteIndex = Math.max(0, Math.min(paletteIndex + (event.key === 'ArrowDown' ? 1 : -1), paletteShown.length - 1));
      paletteRender();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      paletteShown[paletteIndex]?.run();
    }
  });
  overlayRoot.append(palette);
}
function paletteRender() {
  const needle = paletteInput.value.trim().toLowerCase();
  paletteShown = commandActions().filter(action => !needle || `${action.label} ${action.hint}`.toLowerCase().includes(needle)).slice(0, 12);
  paletteIndex = Math.max(0, Math.min(paletteIndex, Math.max(0, paletteShown.length - 1)));
  paletteList.replaceChildren(...paletteShown.map((action, index) => h('li', {}, h('button', {type: 'button', cls: index === paletteIndex ? 'current' : '',
    onclick: () => action.run()}, h('span', {text: action.label}), h('span', {cls: 'hint', text: action.hint})))),
    paletteShown.length ? null : h('li', {cls: 'dim', style: 'padding:10px', text: 'No matching command'}));
}
function openPalette() {
  ensureOverlay();
  paletteEnsure();
  palette.hidden = false;
  paletteInput.value = '';
  paletteIndex = 0;
  paletteRender();
  setTimeout(() => paletteInput.focus());
}
function closePalette() {
  if (palette) palette.hidden = true;
}
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    palette && !palette.hidden ? closePalette() : openPalette();
  }
}, true);
document.addEventListener('click', event => {
  if (palette && !palette.hidden && !event.composedPath().includes(palette)) closePalette();
});

// --- Listening recap ---
let recapRange = 'month', recapLoading = false;
async function ensurePlayLog() {
  if (plays || recapLoading) return;
  recapLoading = true;
  try {
    const text = await call('load', {name: 'plays', log: true});
    plays = String(text || '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { plays = []; }
  recapLoading = false;
}
function topCounts(rows, key) {
  return [...rows.reduce((map, play) => map.set(play[key], (map.get(play[key]) || 0) + play.s), new Map())]
    .filter(([name]) => name).sort((a, b) => b[1] - a[1]);
}
tabs.push({id: 'recap', label: 'Recap', order: 5.5, render(body) {
  if (!plays) {
    ensurePlayLog().then(() => refreshPanel('recap'));
    return body.append(h('p', {text: 'Loading your private listening log…'}));
  }
  const lengths = {week: 7 * DAY, month: 30 * DAY, year: 365 * DAY, all: Infinity};
  const length = lengths[recapRange], since = Date.now() - length, recent = plays.filter(play => play.at >= since);
  body.append(h('div', {cls: 'row'}, h('h2', {text: 'Listening recap'}), h('select', {'aria-label': 'Period', onchange: event => { recapRange = event.target.value; refreshPanel('recap'); }},
    [['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Last 12 months'], ['all', 'All time']].map(([value, text]) => h('option', {value, text, selected: value === recapRange})))));
  if (!recent.length) return body.append(h('p', {text: 'No plays in this period yet. GoLow records listening privately on this computer.'}));
  const secondsListened = recent.reduce((sum, play) => sum + play.s, 0);
  const [artist] = topCounts(recent, 'a'), [track] = topCounts(recent, 'n'), [genre] = topCounts(recent, 'g');
  const artists = new Set(recent.map(play => play.a).filter(Boolean));
  const before = plays.filter(play => play.at < since), oldArtists = new Set(before.map(play => play.a).filter(Boolean));
  const fresh = [...artists].filter(name => !oldArtists.has(name));
  const longest = recent.reduce((best, play) => play.s > (best?.s || 0) ? play : best, null);
  const minutes = Math.round(secondsListened / 60);
  body.append(h('p', {text: `${minutes >= 90 ? (secondsListened / 3600).toFixed(1) + ' hours' : minutes + ' minutes'} · ${recent.length} plays · ${artists.size} artists`}),
    h('ul', {cls: 'list'}, [
      artist && h('li', {}, h('span', {cls: 'grow', text: 'Top artist'}), h('strong', {text: `${artist[0]} · ${Math.round(artist[1] / 60)} min`})),
      track && h('li', {}, h('span', {cls: 'grow', text: 'Top track'}), h('strong', {text: `${track[0]} · ${Math.round(track[1] / 60)} min`})),
      genre && h('li', {}, h('span', {cls: 'grow', text: 'Top genre'}), h('strong', {text: genre[0]})),
      longest && h('li', {}, h('span', {cls: 'grow', text: 'Longest listen'}), h('strong', {text: `${longest.n} · ${Math.round(longest.s / 60)} min`})),
      h('li', {}, h('span', {cls: 'grow', text: 'New artists in this period'}), h('strong', {text: String(fresh.length)})),
    ].filter(Boolean)));
  const summary = [`GoLow recap: ${minutes} minutes, ${recent.length} plays, ${artists.size} artists.`,
    artist ? `Top artist: ${artist[0]}.` : '', track ? `Top track: ${track[0]}.` : '', genre ? `Top genre: ${genre[0]}.` : ''].filter(Boolean).join(' ');
  body.append(h('button', {cls: 'btn primary', type: 'button', text: 'Copy recap', onclick: () => {
    navigator.clipboard?.writeText(summary).then(() => toast('Recap copied.'), () => toast(summary, null, 10000));
  }}));
}});

// --- Playlist maintenance and backup restore ---
const maintenance = {duplicates: null, dead: null, checking: false, restore: null, confirmRestore: false};
function scanBackupDuplicates(latest) {
  const result = [];
  for (const list of latest?.playlists || []) {
    const seen = new Map(), duplicates = [];
    for (const track of list.tracks || []) {
      if (!track.id) continue;
      if (seen.has(track.id)) duplicates.push({...track, first: seen.get(track.id)});
      else seen.set(track.id, track);
    }
    if (duplicates.length) result.push({list, duplicates});
  }
  return result;
}
async function checkBackupAvailability(latest) {
  maintenance.checking = true;
  maintenance.dead = null;
  refreshPanel('cleanup');
  try {
    const byId = new Map();
    for (const track of latest?.likes || []) if (track.id) byId.set(track.id, {...track, where: 'likes'});
    for (const list of latest?.playlists || []) for (const track of list.tracks || []) {
      if (track.id && !byId.has(track.id)) byId.set(track.id, {...track, where: list.title});
    }
    const ids = [...byId.keys()].slice(0, 2500), present = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      maintenance.dead = {progress: `Checking ${Math.min(i + 50, ids.length)} of ${ids.length}…`, rows: null};
      refreshPanel('cleanup');
      const found = await api('tracks', {ids: ids.slice(i, i + 50).join(',')}).catch(() => null);
      if (Array.isArray(found)) for (const track of found) present.add(track.id);
    }
    maintenance.dead = {progress: null, rows: ids.filter(id => !present.has(id)).map(id => byId.get(id)), truncated: byId.size > ids.length};
  } finally {
    maintenance.checking = false;
    refreshPanel('cleanup');
  }
}
function writeApi(method, path) {
  const run = async () => {
    for (let i = 0; !session.client && i < 60; i++) await wait(250);
    if (!session.client) throw new Error('SoundCloud is still loading');
    const url = new URL(path, API);
    url.searchParams.set('client_id', session.client);
    if (session.app) url.searchParams.set('app_version', session.app);
    return await new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open(method, url.href);
      if (session.token) request.setRequestHeader('Authorization', session.token);
      request.setRequestHeader('Accept', 'application/json, text/javascript, */*; q=0.01');
      request.onloadend = () => resolve(request.status);
      request.send();
    });
  };
  const result = lane.then(run, run);
  lane = result.then(() => wait(500), () => wait(500));
  return result;
}
async function likeTrack(id) {
  const urn = encodeURIComponent(`soundcloud:tracks:${id}`);
  let status = await writeApi('POST', `likes/tracks/${urn}`);
  if (status === 404 || status === 405) status = await writeApi('POST', `likes/tracks/${id}`);
  return status >= 200 && status < 300;
}
async function restoreLikes(latest) {
  if (!maintenance.confirmRestore) {
    maintenance.confirmRestore = true;
    refreshPanel('cleanup');
    return;
  }
  maintenance.confirmRestore = false;
  maintenance.restore = {running: true, text: 'Reading current likes…'};
  refreshPanel('cleanup');
  try {
    const user = await me();
    const current = await collect(`users/${user.id}/track_likes`, {limit: 200, linked_partitioning: 1}, 20000);
    const present = new Set(current.map(item => item.track?.id).filter(Boolean));
    const missing = latest.likes.filter(track => track.id && !present.has(track.id)).slice(0, 250);
    let done = 0, failed = 0;
    for (const track of missing) {
      maintenance.restore.text = `Restoring ${done + failed + 1} of ${missing.length}: ${track.title}`;
      refreshPanel('cleanup');
      if (await likeTrack(track.id)) done += 1; else failed += 1;
    }
    maintenance.restore = {running: false, text: `Restored ${done} likes${failed ? `; ${failed} could not be restored` : ''}.`};
    toast(maintenance.restore.text);
  } catch (error) {
    maintenance.restore = {running: false, text: 'Restore stopped: ' + error.message};
  }
  refreshPanel('cleanup');
}
tabs.push({id: 'cleanup', label: 'Cleanup', order: 4.5, render(body) {
  if (!backupState.latest && !backupState.loaded) { backupState.loaded = true; loadBackups().catch(() => {}); }
  const latest = backupState.latest;
  body.append(h('h2', {text: 'Playlist maintenance'}));
  if (!latest) return body.append(h('p', {text: 'Back up your library first. GoLow uses that snapshot to find duplicates, dead tracks and likes that can be restored.'}),
    h('button', {cls: 'btn primary', type: 'button', text: 'Open backup', onclick: () => openPanel('library')}));
  if (!maintenance.duplicates) maintenance.duplicates = scanBackupDuplicates(latest);
  body.append(h('h3', {text: `Duplicate playlist tracks · ${maintenance.duplicates.reduce((n, row) => n + row.duplicates.length, 0)}`}));
  if (!maintenance.duplicates.length) body.append(h('p', {text: 'No duplicates found in the latest backup.'}));
  else body.append(h('ul', {cls: 'list'}, maintenance.duplicates.slice(0, 100).flatMap(row => row.duplicates.slice(0, 20).map(track =>
    h('li', {}, h('div', {cls: 'grow'}, h('div', {cls: 'clip', text: track.title || `Track ${track.id}`}),
      h('div', {cls: 'clip dim', text: `${track.artist} · duplicated in ${row.list.title}`})),
      track.path ? h('a', {href: track.path, text: 'Open'}) : null)))),
    h('p', {cls: 'dim', text: 'Review-only for now: GoLow does not remove playlist tracks without a safer undo flow.'}));
  body.append(h('h3', {text: 'Availability check'}),
    h('button', {cls: 'btn', type: 'button', text: maintenance.checking ? (maintenance.dead?.progress || 'Checking…') : 'Check backed-up tracks', disabled: maintenance.checking,
      onclick: () => checkBackupAvailability(latest)}));
  if (maintenance.dead?.rows) {
    body.append(h('p', {text: maintenance.dead.rows.length ? `${maintenance.dead.rows.length} backed-up tracks did not resolve as public tracks.${maintenance.dead.truncated ? ' The check stopped at 2,500 tracks.' : ''}` : 'Every checked backed-up track is still available.'}),
      h('ul', {cls: 'list'}, maintenance.dead.rows.slice(0, 150).map(track => h('li', {},
        h('div', {cls: 'grow'}, h('div', {cls: 'clip', text: track.title || `Track ${track.id}`}), h('div', {cls: 'clip dim', text: `${track.artist} · ${track.where}`})),
        h('a', {href: 'https://soundcloud.com/search?q=' + encodeURIComponent(`${track.artist} ${track.title}`), text: 'Search'})))));
  }
  body.append(h('h3', {text: 'Restore likes'}),
    h('p', {text: 'Compares the latest backup with your current likes and re-likes tracks that disappeared from your library but still exist. Limited to 250 tracks per run.'}),
    maintenance.restore?.text ? h('p', {cls: 'dim', text: maintenance.restore.text}) : null,
    h('button', {cls: 'btn primary', type: 'button', text: maintenance.confirmRestore ? 'Confirm restore' : maintenance.restore?.running ? 'Restoring…' : 'Restore missing likes',
      disabled: maintenance.restore?.running, onclick: () => restoreLikes(latest)}));
}});
