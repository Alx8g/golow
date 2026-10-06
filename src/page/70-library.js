// Your library, kept safe and easier to manage: backups that show what disappeared, the
// playlist size limit, listening stats, the accounts you follow, playlist folders and the queue.
menu.push(
  {section: 'Lists and feed', key: 'auto_backup', label: 'Back up likes and playlists weekly', def: true,
    hint: 'Saved in GoLow\'s folder, so GoLow can tell you when tracks disappear.'},
  {section: 'Lists and feed', key: 'confirm_clear', label: 'Confirm before clearing a long queue', def: true},
);
const DAY = 86400000;
const compactTrack = t => t && ({id: t.id, title: t.title || '', artist: t.user?.username || '', path: pathOf(t.permalink_url || ''), duration: t.full_duration || t.duration || 0});
const date = at => new Date(at).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
const ago = at => { const days = Math.floor((Date.now() - at) / DAY); return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };
const playlists = new Map();   // path -> {id, title, count, owner}
on('data', (url, json) => {
  for (const item of [json, ...(json?.collection || []).map(entry => entry?.playlist || entry)]) {
    if (item?.kind === 'playlist' && item.permalink_url) {
      playlists.set(pathOf(item.permalink_url), {id: item.id, title: item.title, count: item.track_count ?? item.tracks?.length ?? 0, owner: item.user_id ?? item.user?.id});
    }
  }
});

// --- Backups ---
let backupState = {running: false, progress: '', latest: null, previous: null, missing: null};
async function fullTracks(list) {
  // Playlists list their first tracks in full and the rest as ids only.
  const missing = list.filter(t => !t.title && t.id).map(t => t.id);
  const byId = new Map(list.filter(t => t.title).map(t => [t.id, t]));
  for (let i = 0; i < missing.length; i += 50) {
    for (const t of await api('tracks', {ids: missing.slice(i, i + 50).join(',')}) || []) byId.set(t.id, t);
  }
  return list.map(t => compactTrack(byId.get(t.id)) || {id: t.id, title: '', artist: '', path: null, duration: 0});
}
async function backup() {
  if (backupState.running) return;
  backupState = {...backupState, running: true, progress: 'Starting…'};
  refreshPanel('library');
  try {
    const user = await me();
    const likes = await collect(`users/${user.id}/track_likes`, {limit: 200, linked_partitioning: 1}, 20000, n => {
      backupState.progress = `Reading likes: ${n}`;
      refreshPanel('library');
    });
    const library = await collect('me/library/all', {limit: 50, linked_partitioning: 1}, 1000);
    const lists = [];
    for (const [index, entry] of library.entries()) {
      if (!entry.playlist?.id) continue;
      backupState.progress = `Reading playlists: ${index + 1} of ${library.length}`;
      refreshPanel('library');
      const full = await api(`playlists/${entry.playlist.id}`, {representation: 'full'});
      lists.push({id: full.id, title: full.title, path: pathOf(full.permalink_url), mine: full.user_id === user.id, count: full.track_count,
        tracks: await fullTracks(full.tracks || [])});
    }
    const snapshot = {at: Date.now(), user: {id: user.id, path: user.path}, likes: likes.filter(l => l.track).map(l => ({...compactTrack(l.track), liked: l.created_at})), playlists: lists};
    await call('save', {name: 'backup-' + new Date().toISOString().slice(0, 10), data: JSON.stringify(snapshot)});
    // Keep the last eight backups.
    const names = await call('list', {prefix: 'backup-'});
    for (const old of names.slice(0, Math.max(0, names.length - 8))) await call('remove', {name: old});
    local.backup_at = snapshot.at;
    store('prefs', local);
    await loadBackups();
    toast(`Backed up ${snapshot.likes.length} likes and ${lists.length} playlists.`);
  } catch (error) {
    toast('Backup stopped: ' + error.message);
  }
  backupState.running = false;
  refreshPanel('library');
}
async function loadBackups() {
  const names = await call('list', {prefix: 'backup-'});
  const read = async name => name ? JSON.parse(await call('load', {name}) || 'null') : null;
  const [latest, previous] = [await read(names.at(-1)), await read(names.at(-2))];
  backupState = {...backupState, latest, previous, missing: latest && previous ? await compare(previous, latest) : null};
  refreshPanel('library');
}
// What was in the previous backup and is not in the latest: still on SoundCloud (you removed
// it) or gone from SoundCloud (deleted, made private, or blocked where you are).
async function compare(previous, latest) {
  const liked = new Set(latest.likes.map(t => t.id));
  const lostLikes = previous.likes.filter(t => !liked.has(t.id));
  const lostFromLists = [];
  for (const list of previous.playlists) {
    const now = latest.playlists.find(other => other.id === list.id);
    if (!now) continue;
    const present = new Set(now.tracks.map(t => t.id));
    for (const t of list.tracks) if (!present.has(t.id)) lostFromLists.push({...t, list: list.title});
  }
  const all = [...lostLikes, ...lostFromLists];
  const stillThere = new Set();
  for (let i = 0; i < all.length && i < 500; i += 50) {
    for (const t of await api('tracks', {ids: all.slice(i, i + 50).map(t => t.id).join(',')}).catch(() => []) || []) stillThere.add(t.id);
  }
  return all.map(t => ({...t, gone: !stillThere.has(t.id)}));
}
function csv(rows) {
  return rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
async function exportLikes() {
  const latest = backupState.latest;
  if (!latest) return toast('Back up first, then export.');
  const rows = [['Title', 'Artist', 'Link', 'Length', 'Liked'], ...latest.likes.map(t => [t.title, t.artist, 'https://soundcloud.com' + t.path, clock(t.duration / 1000), t.liked])];
  try {
    await call('export', {name: 'likes-' + new Date(latest.at).toISOString().slice(0, 10), ext: 'csv', data: '﻿' + csv(rows)});
    toast('Exported your likes to Documents\\GoLow.');
  } catch (error) { toast('Export failed: ' + error.message); }
}
// Weekly, a minute after start so SoundCloud's own loading comes first.
setTimeout(() => {
  if (pref('auto_backup') && window.ipc && Date.now() - (local.backup_at || 0) > 7 * DAY) backup();
}, 60000);

const CAP = 500;
tabs.push({id: 'library', label: 'Library', order: 4, render(body) {
  if (!backupState.latest && !backupState.loaded) { backupState.loaded = true; loadBackups().catch(() => {}); }
  const {latest, missing, running, progress} = backupState;
  body.append(h('h2', {text: 'Backup'}),
    h('p', {text: latest ? `Last backup ${ago(latest.at)}: ${latest.likes.length} likes, ${latest.playlists.length} playlists.` :
      'No backup yet. A backup lists every like and playlist track, so GoLow can show you what disappears later.'}),
    h('div', {cls: 'row'},
      h('button', {cls: 'btn primary', type: 'button', text: running ? progress : 'Back up now', disabled: running, onclick: backup}),
      h('button', {cls: 'btn', type: 'button', text: 'Export likes', disabled: !latest, onclick: exportLikes}),
      h('button', {cls: 'btn', type: 'button', text: 'Open folder', onclick: () => call('open_folder', {which: 'data'}).catch(() => {})})));
  if (missing?.length) {
    const gone = missing.filter(t => t.gone), removed = missing.filter(t => !t.gone);
    const row = t => h('li', {}, h('div', {cls: 'grow'}, h('div', {cls: 'clip', text: t.title || `Track ${t.id}`}),
      h('div', {cls: 'clip dim', text: [t.artist, t.list ? `from ${t.list}` : 'from your likes'].filter(Boolean).join(' · ')})),
      t.gone ? h('a', {href: 'https://soundcloud.com/search?q=' + encodeURIComponent(`${t.artist} ${t.title}`), text: 'Search'}) :
        h('a', {href: t.path, text: 'Open'}));
    if (gone.length) body.append(h('h3', {text: `Gone from SoundCloud since the backup before · ${gone.length}`}), h('ul', {cls: 'list'}, gone.slice(0, 200).map(row)));
    if (removed.length) body.append(h('h3', {text: `No longer in your likes or playlists · ${removed.length}`}), h('ul', {cls: 'list'}, removed.slice(0, 200).map(row)));
  } else if (missing) {
    body.append(h('p', {text: 'Nothing has disappeared since the backup before.'}));
  }
  const full = (latest?.playlists || []).filter(list => list.mine && list.count >= CAP * 0.9);
  if (full.length) {
    body.append(h('h3', {text: 'Playlists near SoundCloud\'s 500-track limit'}),
      h('ul', {cls: 'list'}, full.map(list => h('li', {}, h('a', {cls: 'grow clip', href: list.path, text: list.title}), h('span', {cls: 'dim', text: `${list.count} of ${CAP}`})))));
  }
}});
// On a playlist page you own, the limit shows once it is near.
on('page', () => {
  const list = playlists.get(location.pathname);
  const details = /\/sets\//.test(location.pathname) && document.querySelector('.listenDetails');
  if (!details || details.querySelector('[data-golow-cap]') || !list || list.count < CAP * 0.9 || list.owner !== session.me?.id) return;
  details.prepend(h('p', {'data-golow-cap': '', cls: 'sc-text-secondary sc-type-small', style: 'margin:8px 0;color:#f50',
    text: `${list.count} of ${CAP} tracks. SoundCloud stops adding tracks at ${CAP}.`}));
});

// --- Listening stats, from a play log kept by GoLow ---
let listening = null, heardAt = 0;
function flushPlay() {
  if (listening && listening.s >= 30) {
    call('append', {name: 'plays', line: JSON.stringify({...listening, s: Math.round(listening.s)})}).catch(() => {});
    plays = null;
  }
  listening = null;
}
on('track', path => {
  flushPlay();
  const track = tracks.get(path);
  listening = {p: path, n: player.title, a: player.artist, g: track?.genre || '', s: 0, at: Date.now(), d: player.total};
  heardAt = position();
});
on('tick', () => {
  if (!listening || listening.p !== player.path) return;
  const now = position(), step = now - heardAt;
  if (player.playing && step > 0 && step < 5) listening.s += step;
  heardAt = now;
});
addEventListener('pagehide', flushPlay);
const RANGES = {week: 7 * DAY, month: 30 * DAY, year: 365 * DAY, all: Infinity};
let statsRange = 'month', plays = null;
tabs.push({id: 'stats', label: 'Stats', order: 5, render(body) {
  if (!plays) {
    body.append(h('p', {text: 'Loading…'}));
    call('load', {name: 'plays', log: true}).then(text => {
      plays = String(text || '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      refreshPanel('stats');
    }, () => { plays = []; refreshPanel('stats'); });
    return;
  }
  const since = Date.now() - RANGES[statsRange], recent = plays.filter(play => play.at >= since);
  const tally = key => [...recent.reduce((map, play) => map.set(play[key], (map.get(play[key]) || 0) + play.s), new Map())]
    .filter(([name]) => name).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const hours = recent.reduce((sum, play) => sum + play.s, 0) / 3600;
  body.append(h('div', {cls: 'row'}, h('h2', {text: 'Your listening'}), h('select', {'aria-label': 'Period', onchange: event => { statsRange = event.target.value; refreshPanel('stats'); }},
    [['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Last 12 months'], ['all', 'All time']].map(([value, text]) => h('option', {value, text, selected: value === statsRange})))));
  if (!recent.length) return body.append(h('p', {text: 'GoLow keeps a private log of what you play here, from now on. Play a few tracks and they show up.'}));
  body.append(h('p', {text: `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} hours · ${recent.length} plays · ${new Set(recent.map(p => p.a)).size} artists`}));
  for (const [title, key] of [['Top artists', 'a'], ['Top tracks', 'n'], ['Top genres', 'g']]) {
    const top = tally(key);
    if (!top.length) continue;
    const most = top[0][1];
    body.append(h('h3', {text: title}), h('ul', {cls: 'list'}, top.map(([name, s]) => h('li', {},
      h('div', {cls: 'grow'}, h('div', {cls: 'clip', text: name}), h('div', {cls: 'bar'}, h('i', {style: `width:${Math.round(s / most * 100)}%`}))),
      h('span', {cls: 'dim', text: s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`})))));
  }
}});

// --- Following: who you follow, who follows back, and who never uploads ---
let following = null, followFilter = 'all', followBusy = false;
async function loadFollowing() {
  followBusy = true;
  refreshPanel('following');
  try {
    const user = await me();
    const [people, back] = [await collect(`users/${user.id}/followings`, {limit: 200, linked_partitioning: 1}, 10000),
      await api('me/followers/ids', {limit: 5000, linked_partitioning: 1}).catch(() => null)];
    const followers = new Set(back?.collection || []);
    following = people.map(p => ({id: p.id, name: p.username, path: pathOf(p.permalink_url), followers: p.followers_count || 0,
      tracks: p.track_count || 0, back: followers.has(p.id)}));
  } catch (error) { toast('Could not load who you follow: ' + error.message); }
  followBusy = false;
  refreshPanel('following');
}
tabs.push({id: 'following', label: 'Following', order: 7, render(body) {
  body.append(h('h2', {text: 'Following'}));
  if (!following) {
    return body.append(h('p', {text: 'See everyone you follow, who follows you back, and who has never uploaded. SoundCloud lets you follow up to 2,000 accounts.'}),
      h('button', {cls: 'btn primary', type: 'button', text: followBusy ? 'Loading…' : 'Load', disabled: followBusy, onclick: loadFollowing}));
  }
  const filters = {all: ['Everyone', () => true], notback: ['Don\'t follow you back', p => !p.back], silent: ['Never uploaded', p => !p.tracks], small: ['Under 100 followers', p => p.followers < 100]};
  const shown = following.filter(filters[followFilter][1]).sort((a, b) => a.name.localeCompare(b.name));
  body.append(h('p', {text: `${following.length.toLocaleString()} of 2,000 · ${following.filter(p => p.back).length} follow you back`}),
    h('div', {cls: 'row'}, h('select', {'aria-label': 'Show', onchange: event => { followFilter = event.target.value; refreshPanel('following'); }},
      Object.entries(filters).map(([value, [text]]) => h('option', {value, text, selected: value === followFilter}))), h('span', {cls: 'dim', text: `${shown.length} shown`})),
    h('ul', {cls: 'list'}, shown.slice(0, 500).map(p => h('li', {}, h('a', {cls: 'grow clip', href: p.path, text: p.name}),
      h('span', {cls: 'dim', text: `${p.followers.toLocaleString()} followers · ${p.tracks} tracks${p.back ? ' · follows you' : ''}`})))));
}});

// --- Playlist folders, on your Library playlists page ---
const folders = stored('folders', {});
let folderShown = '';
function saveFolders() { store('folders', folders); folderBar(true); }
function folderBar(force = false) {
  if (!/^\/you\/(sets|albums)/.test(location.pathname)) return;
  const list = document.querySelector('.lazyLoadingList');
  if (!list) return;
  let bar = document.querySelector('[data-golow-folders]');
  if (!bar || force) {
    const next = h('div', {'data-golow-folders': '', cls: 'g-flex-row-centered sc-mb-2x', style: 'gap:6px;flex-wrap:wrap'},
      ['', ...Object.keys(folders)].map(name => h('button', {type: 'button', cls: 'sc-button sc-button-small' + (name === folderShown ? ' sc-button-selected' : ''),
        text: name || 'All playlists', onclick: () => { folderShown = name; saveFolders(); }})),
      h('button', {type: 'button', cls: 'sc-button sc-button-small', text: '+ Folder', onclick: event => {
        const input = h('input', {type: 'text', cls: 'sc-input sc-input-small', placeholder: 'Folder name, then Enter', 'aria-label': 'New folder name', maxlength: '40',
          onkeydown: key => {
            const name = input.value.trim();
            if (key.key === 'Enter' && name && !folders[name]) { folders[name] = []; saveFolders(); }
            if (key.key === 'Escape') folderBar(true);
          }});
        event.currentTarget.replaceWith(input);
        input.focus();
      }}));
    bar ? bar.replaceWith(next) : list.before(next);
    bar = next;
  }
  for (const item of list.querySelectorAll('.badgeList__item')) {
    const path = pathOf(item.querySelector('a[href*="/sets/"]')?.getAttribute('href') || '');
    if (!path) continue;
    item.toggleAttribute('data-golow-filtered', !!folderShown && !folders[folderShown]?.includes(path));
    if (!item.querySelector('[data-golow-folder]') && Object.keys(folders).length) {
      item.append(h('button', {type: 'button', 'data-golow-folder': '', cls: 'sc-button sc-button-small', text: 'Folder…', title: 'Put this playlist in a folder',
        onclick: event => popup(event.currentTarget, [{heading: 'Folder'}, ...Object.keys(folders).map(name => ({label: name, checked: folders[name].includes(path),
          action: () => { folders[name] = folders[name].includes(path) ? folders[name].filter(p => p !== path) : [...folders[name], path]; saveFolders(); }}))])}));
    }
  }
}
on('page', () => folderBar());
css.push(() => 'html:root [data-golow-folder]{margin-top:4px}');

// --- Queue: no more clearing a long queue by accident ---
let clearConfirmed = false;
document.addEventListener('click', event => {
  const clear = event.target.closest?.('.queue__clear');
  const count = document.querySelectorAll('.queue__itemWrapper').length;
  if (!clear || clearConfirmed || !pref('confirm_clear') || count <= 10) { clearConfirmed = false; return; }
  event.preventDefault();
  event.stopImmediatePropagation();
  toast(`Clear ${count} tracks from Next up?`, {label: 'Clear', run: () => { clearConfirmed = true; clear.click(); }}, 8000);
}, true);
