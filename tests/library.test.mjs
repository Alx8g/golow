// Library and discovery: backups and what disappeared, the playlist limit, stats, following,
// folders, the queue guard, the release radar and lyrics. The test plays both SoundCloud's
// API (through the harness) and the app (an in-memory store answering the page's requests).
import test from 'node:test';
import assert from 'node:assert/strict';
import {edge, prelude, withEdge} from './harness.mjs';

const user = (id, name, extra = {}) => ({kind: 'user', id, username: name, permalink_url: `https://soundcloud.com/${name.toLowerCase()}`, ...extra});
const track = (id, title, extra = {}) => ({kind: 'track', id, title, duration: 200000, permalink_url: `https://soundcloud.com/a/${title.toLowerCase()}`, user: user(90, 'Artist'), ...extra});
const now = Date.now();
const api = {
  // Order matters: the first matching key answers.
  'users/7/track_likes': {collection: [{created_at: '2026-10-01T00:00:00Z', track: track(1, 'Kept')}, {created_at: '2026-09-01T00:00:00Z', track: track(2, 'Also')}]},
  'me/library/all': {collection: [{playlist: {kind: 'playlist', id: 10, title: 'Big List', permalink_url: 'https://soundcloud.com/me/sets/big-list'}}]},
  'playlists/10': {kind: 'playlist', id: 10, title: 'Big List', user_id: 7, track_count: 470, permalink_url: 'https://soundcloud.com/me/sets/big-list',
    tracks: [track(1, 'Kept'), {id: 3}]},
  'tracks?ids=3': [track(3, 'Third')],
  'tracks?ids=': [],
  'users/7/followings': {collection: [user(21, 'Mutual', {followers_count: 5000, track_count: 40}), user(22, 'Silent', {followers_count: 12, track_count: 0})]},
  'me/followers/ids': {collection: [21]},
  'stream': {collection: [
    {type: 'track', created_at: new Date(now - 3600000).toISOString(), track: track(31, 'Fresh', {display_date: new Date(now - 3600000).toISOString(), user: user(21, 'Mutual')})},
    {type: 'track-repost', created_at: new Date(now - 7200000).toISOString(), track: track(32, 'Reposted')},
  ]},
  '/me?': user(7, 'Me'),
};
const page = `<!doctype html><html><head></head><body><div id="app">
<header class="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header>
<div class="lazyLoadingList"><ul class="lazyLoadingList__list">
<li class="badgeList__item" id="t1"><a href="/me/sets/big-list">Big List</a></li><li class="badgeList__item" id="t2"><a href="/me/sets/other">Other</a></li></ul></div>
<div class="listenDetails" id="details"></div>
<div class="playControls"><div class="playControls__elements"><button class="playControls__play" id="play">Play</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true" id="passed">0:00</span></div><div class="playbackTimeline__progressWrapper"></div>
<div class="playbackTimeline__duration"><span aria-hidden="true">3:20</span></div><div class="playControls__volume">Vol</div>
<a class="playbackSoundBadge__lightLink" href="/singer" title="Singer"></a><a class="playbackSoundBadge__titleLink" id="badge" href="" title=""></a></div>
<div class="playControls__queue"><div class="queue"><button class="queue__clear" id="clear">Clear</button>${'<div class="queue__itemWrapper">x</div>'.repeat(12)}</div></div></div>
</div><script>window.__cleared = 0; document.getElementById('clear').addEventListener('click', () => window.__cleared++);</script></body></html>`;

const checks = `(async () => {
  ${prelude}
  // The app's side: a file store in memory, lyrics, and replies to every request.
  const files = new Map(), logs = new Map();
  window.ipc.postMessage = text => {
    const message = JSON.parse(text);
    window.__scMessages.push(message);
    if (!('call' in message)) return;
    const {call, id, args} = message;
    const answers = {
      save: () => { files.set(args.name, args.data); return null; },
      load: () => args.log ? (logs.get(args.name) || []).join('\\n') : files.get(args.name) ?? null,
      append: () => { logs.set(args.name, [...(logs.get(args.name) || []), args.line]); return null; },
      list: () => [...files.keys()].filter(name => name.startsWith(args.prefix)).sort(),
      remove: () => { files.delete(args.name); return null; },
      export: () => 'C:/Users/x/Documents/GoLow/' + args.name + '.' + args.ext,
      lyrics: () => ({synced: '[00:01.00] First line\\n[00:05.00] Second line', plain: 'First line\\nSecond line', title: 'Song', artist: 'Singer'}),
      notify: () => null, open_folder: () => true,
    };
    setTimeout(() => client.reply(id, answers[call] ? answers[call]() : null), 5);
  };
  for (let i = 0; i < 50 && !client.diagnostics().session; i++) await wait(100);
  assert(client.diagnostics().session, 'session parameters learned from the page');

  // A backup from last week held a playlist track that has since vanished from SoundCloud.
  const old = t => ({id: t[0], title: t[1], artist: 'Artist', path: '/a/' + t[1].toLowerCase(), duration: 200000});
  files.set('backup-2000-01-01', JSON.stringify({at: Date.now() - 7 * 86400000, likes: [old([1, 'Kept'])], playlists: [{id: 10, title: 'Big List',
    path: '/me/sets/big-list', mine: true, count: 471, tracks: [old([1, 'Kept']), old([3, 'Third']), old([4, 'Vanished'])]}]}));
  client.command('panel', 'library');
  await wait(100);
  [...overlay().getElementById('body').querySelectorAll('button')].find(b => b.textContent === 'Back up now').click();
  for (let i = 0; i < 100 && !overlay().getElementById('body').textContent.includes('Gone from SoundCloud'); i++) await wait(100);
  const saved = JSON.parse(files.get([...files.keys()].filter(name => !name.startsWith('backup-2000')).at(-1)));
  assert(saved.likes.length === 2 && saved.playlists[0].tracks.map(t => t.title).join() === 'Kept,Third', 'backup holds likes and full playlist tracks');
  const library = overlay().getElementById('body').textContent;
  assert(library.includes('Gone from SoundCloud') && library.includes('Vanished') && library.includes('from Big List') && !library.includes('No longer in your'),
    'shows the vanished playlist track: ' + library.slice(0, 300));
  assert(library.includes('470 of 500'), 'warns about a playlist near the 500-track limit');
  document.body.append(document.createElement('div'));
  await wait(20);
  assert(byId('details').querySelector('[data-golow-cap]')?.textContent.includes('470 of 500'), 'the playlist page shows the limit');

  // Stats from the play log.
  logs.set('plays', [JSON.stringify({p: '/a/x', n: 'Song A', a: 'Artist A', g: 'House', s: 600, at: Date.now()}),
    JSON.stringify({p: '/a/y', n: 'Song B', a: 'Artist B', g: 'Techno', s: 120, at: Date.now()})]);
  client.command('panel', 'stats');
  await wait(100);
  const stats = overlay().getElementById('body').textContent;
  assert(stats.includes('0.2 hours') && stats.indexOf('Artist A') < stats.indexOf('Artist B') && stats.includes('House'), 'stats rank by time: ' + stats.slice(0, 200));

  // Following: who follows back, and who never uploaded.
  client.command('panel', 'following');
  [...overlay().getElementById('body').querySelectorAll('button')].find(b => b.textContent === 'Load').click();
  for (let i = 0; i < 50 && !overlay().getElementById('body').textContent.includes('of 2,000'); i++) await wait(100);
  const select = overlay().getElementById('body').querySelector('select');
  select.value = 'silent'; select.dispatchEvent(new Event('change'));
  const silent = overlay().getElementById('body').textContent;
  assert(silent.includes('2 of 2,000') && silent.includes('Silent') && !silent.includes('Mutual5,000'), 'filters accounts that never uploaded: ' + silent.slice(0, 200));

  // Radar lists uploads, not reposts.
  client.command('panel', 'radar');
  for (let i = 0; i < 50 && !overlay().getElementById('body').textContent.includes('Fresh'); i++) await wait(100);
  const radar = overlay().getElementById('body').textContent;
  assert(radar.includes('Fresh') && !radar.includes('Reposted'), 'radar shows uploads only');

  // Lyrics follow the music.
  byId('badge').setAttribute('href', '/singer/song'); byId('badge').title = 'Song';
  byId('play').classList.add('playing');
  await wait(50);
  client.command('panel', 'lyrics');
  for (let i = 0; i < 30 && !overlay().getElementById('body').querySelector('.lyrics'); i++) await wait(100);
  byId('passed').textContent = '0:06';
  await wait(50);
  assert(overlay().getElementById('body').querySelector('li.current')?.textContent === 'Second line', 'the current lyric line is marked');
  const lyricCall = window.__scMessages.filter(m => m.call === 'lyrics').at(-1);
  assert(lyricCall.args.artist === 'Singer' && lyricCall.args.title === 'Song' && lyricCall.args.seconds === 200, 'asks for lyrics with artist, title and length');

  // Playing a track writes the play log once it has been heard for 30 seconds.
  byId('badge').setAttribute('href', '/singer/next'); byId('badge').title = 'Next';
  await wait(50);
  assert(!(logs.get('plays') || []).some(line => line.includes('/singer/song')), 'a play under 30 seconds is not logged');

  // The queue guard.
  byId('clear').click();
  assert(window.__cleared === 0, 'a long queue is not cleared on the first click');
  [...overlay().querySelectorAll('.toast')].find(t => t.textContent.includes('Clear 12 tracks')).querySelector('button').click();
  assert(window.__cleared === 1, 'confirming clears it');
  return 'ok';
})()`;

// Playlist folders, on the Library playlists page.
const folderChecks = `(async () => {
  ${prelude}
  for (let i = 0; i < 30 && !document.querySelector('[data-golow-folders]'); i++) await wait(100);
  const bar = () => document.querySelector('[data-golow-folders]');
  [...bar().querySelectorAll('button')].find(b => b.textContent === '+ Folder').click();
  const input = bar().querySelector('input');
  input.value = 'Gym';
  input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
  await wait(50);
  byId('t1').querySelector('[data-golow-folder]').click();
  [...overlay().querySelectorAll('.menu button')].find(b => b.textContent.includes('Gym')).click();
  [...bar().querySelectorAll('button')].find(b => b.textContent === 'Gym').click();
  await wait(20);
  assert(!hidden('t1') && hidden('t2'), 'a folder shows only its playlists');
  [...bar().querySelectorAll('button')].find(b => b.textContent === 'All playlists').click();
  assert(!hidden('t2'), 'all playlists again');
  return 'ok';
})()`;

test('library backups, stats, following, radar, lyrics and folders in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  const boot = `<script>const r = new XMLHttpRequest(); r.open('GET', 'https://api-v2.soundcloud.com/me/play-history/tracks?client_id=test&app_version=1'); r.send();</script>`;
  await withEdge({routes: [['/', page.replace('</body>', boot + '</body>')]], api}, async ({evaluate, navigate}) => {
    await navigate('/me/sets/big-list');
    assert.equal(await evaluate(checks), 'ok');
    await navigate('/you/sets');
    assert.equal(await evaluate(folderChecks), 'ok');
  });
});
