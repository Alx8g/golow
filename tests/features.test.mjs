// Mix mode, playback tools, list badges and the blocklist, against a synthetic SoundCloud page
// that plays a real (silent) audio file through GoLow's hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {edge, prelude, withEdge} from './harness.mjs';

const tracklist = '00:00 Intro Artist - Opening\n01:30 Kettama - Fade Away\n03:00 ID - ID\n04:00 Howtin - Silk';
const track = (path, extra = {}) => ({kind: 'track', permalink_url: 'https://soundcloud.com' + path, duration: 300000, title: path.split('/').pop(),
  user: {username: 'DJ Artist', permalink_url: 'https://soundcloud.com/artist'}, policy: 'ALLOW', ...extra});
const api = {'/stream': {collection: [
  {track: track('/dj/mix', {id: 1, title: 'Big Mix', description: tracklist})},
  {track: track('/dj/long', {id: 2, title: 'Long Mix', duration: 2400000})},
  {track: track('/a/preview', {policy: 'SNIP', user: {username: 'P', permalink_url: 'https://soundcloud.com/p'}})},
  {track: track('/a/region', {policy: 'BLOCK', user: {username: 'R', permalink_url: 'https://soundcloud.com/r'}})},
  {track: track('/a/free', {downloadable: true, has_downloads_left: true, user: {username: 'F', permalink_url: 'https://soundcloud.com/f'}})},
  {track: track('/a/ai', {tag_list: 'suno "lo fi"', user: {username: 'A', permalink_url: 'https://soundcloud.com/ai'}})},
]}};
const item = (path, artist) => `<li class="soundList__item" id="${path.split('/').pop()}"><a class="soundTitle__username" href="${artist}">x</a><a class="soundTitle__title" href="${path}">${path}</a></li>`;
const page = `<!doctype html><html><head></head><body><div id="app">
<header class="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header>
<ul class="lazyLoadingList">${item('/a/preview', '/p')}${item('/a/region', '/r')}${item('/a/free', '/f')}${item('/a/ai', '/ai')}${item('/dj/other', '/artist')}</ul>
<iframe class="webiIframe" id="webi" src="/n/dj/mix"></iframe>
<div class="playControls"><div class="playControls__elements">
<button class="skipControl__previous">Prev</button><button class="playControls__play" id="play">Play</button><button class="skipControl__next" id="next">Next</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true" id="passed">0:00</span></div>
<div class="playbackTimeline__progressWrapper" id="progress" style="width:300px;height:10px"></div>
<div class="playbackTimeline__duration"><span aria-hidden="true" id="duration">5:00</span></div>
<div class="playControls__volume">Volume</div>
<div class="playbackSoundBadge"><a class="playbackSoundBadge__lightLink" href="/artist" title="DJ Artist"></a><a class="playbackSoundBadge__titleLink" id="badge" href="" title=""></a></div>
</div></div></div>
<script>
// Five minutes of silence as a real WAV, so the audio element can seek and change speed.
const rate = 8000, length = rate * 300, wav = new ArrayBuffer(44 + length), view = new DataView(wav);
const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
text(0, 'RIFF'); view.setUint32(4, 36 + length, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, length, true);
new Uint8Array(wav, 44).fill(128);
const audio = window.__audio = new Audio(URL.createObjectURL(new Blob([wav], {type: 'audio/wav'})));
window.__nextClicks = 0;
document.getElementById('next').addEventListener('click', () => window.__nextClicks++);
document.getElementById('play').addEventListener('click', event => event.target.classList.toggle('playing'));
document.getElementById('progress').addEventListener('click', event => {
  const box = event.currentTarget.getBoundingClientRect();
  window.__seek = (event.clientX - box.left) / box.width;
});
// SoundCloud starting a track: the badge, clock and play state follow.
window.__start = (path, title, duration = '5:00', passed = '0:00') => {
  const badge = document.getElementById('badge');
  badge.setAttribute('href', path); badge.title = title;
  document.getElementById('duration').textContent = duration;
  document.getElementById('passed').textContent = passed;
  document.getElementById('play').classList.add('playing');
  return audio.play();
};
const request = new XMLHttpRequest();
request.open('GET', 'https://api-v2.soundcloud.com/stream?limit=10');
request.send();
</script></body></html>`;
const trackPage = `<!doctype html><html><head></head><body><main><p id="desc">Tracklist<br>01:30: Kettama - Fade Away<br>04:00 Howtin - Silk<br>Recorded 2026-08-26 12:30:45.5</p></main></body></html>`;

const checks = `(async () => {
  ${prelude}
  for (let i = 0; i < 50 && !client.diagnostics().tracks; i++) await wait(100);
  assert(client.diagnostics().tracks >= 6, 'API answers fill the track cache');
  const audio = window.__audio, at = path => document.querySelector('#badge').getAttribute('href');

  // Badges on list items, from the API data.
  const badge = id => byId(id).querySelector('.soundTitle__title').getAttribute('data-golow-badge');
  assert(badge('preview') === 'Preview' && badge('region') === 'Not available' && badge('free') === 'Free download' && badge('ai') === 'AI?', 'badges: ' + [badge('preview'), badge('region'), badge('free'), badge('ai')]);
  assert(getComputedStyle(byId('region')).opacity === '0.5', 'unavailable tracks are dimmed');

  // A mix with a tracklist: the playing chapter goes to the app.
  await window.__start('/dj/mix', 'Big Mix');
  await wait(100);
  assert(sent().now === 'Intro Artist - Opening · Big Mix' && sent().artist === 'Intro Artist' && sent().title === 'Opening' && sent().album === 'Big Mix', 'first chapter: ' + JSON.stringify(sent()));
  audio.currentTime = 91; byId('passed').textContent = '1:31';
  await wait(100);
  assert(sent().now === 'Kettama - Fade Away · Big Mix' && sent().seconds === 90, 'second chapter: ' + JSON.stringify(sent()));
  audio.currentTime = 185; byId('passed').textContent = '3:05';
  await wait(100);
  assert(sent().now === 'ID - ID · Big Mix' && sent().artist === '' && sent().title === '', 'unknown IDs are shown but carry nothing to scrobble');

  // Skips seek the audio element itself, to the second, not the timeline.
  client.command('forward');
  assert(Math.abs(audio.currentTime - 215) < 1 && window.__seek === undefined, 'skip forward 30 s: ' + audio.currentTime);
  client.command('back');
  assert(Math.abs(audio.currentTime - 205) < 1, 'skip back 10 s: ' + audio.currentTime);

  // Speed is kept per track and survives SoundCloud resetting it.
  client.command('speed', 1.5);
  assert(audio.playbackRate === 1.5 && barRoot().getElementById('speed').textContent === '1.5×', 'speed set');
  audio.playbackRate = 1;
  await wait(50);
  assert(audio.playbackRate === 1.5, 'speed restored after SoundCloud resets it');
  assert(JSON.parse(localStorage.getItem('golow-speeds'))['/dj/mix'] === 1.5, 'speed remembered for the track');

  // Bookmarks, shown on the timeline.
  client.command('bookmark');
  const marks = JSON.parse(localStorage.getItem('golow-bookmarks'))['/dj/mix'];
  assert(marks.length === 1 && Math.abs(marks[0].t - 205) <= 1, 'bookmark saved');
  assert(byId('golow-marks')?.parentElement === byId('progress') && byId('golow-marks').shadowRoot.querySelectorAll('b').length === 1 &&
    byId('golow-marks').shadowRoot.querySelectorAll('i').length === 3, 'chapter ticks and the bookmark dot sit on the timeline');

  // The Now tab: tracklist with the current chapter, bookmarks, go to a time.
  client.command('panel', 'now');
  const body = overlay().getElementById('body');
  assert(body.querySelectorAll('li').length === 5 && body.querySelector('li.current')?.textContent.includes('ID - ID'), 'tracklist and bookmark listed, current chapter marked');
  const goTo = body.querySelector('input[aria-label="Go to time"]');
  goTo.value = '1:00';
  goTo.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
  assert(Math.abs(audio.currentTime - 60) < 1, 'go to 1:00');
  client.command('panel', 'now');
  assert(overlay().getElementById('drawer').hidden, 'the panel button toggles the panel');

  // Clickable times on the track page frame seek the playing track.
  const frame = byId('webi'), doc = frame.contentDocument, win = frame.contentWindow;
  for (let i = 0; i < 20 && !win.CSS.highlights.get('golow-time'); i++) await wait(100);
  const ranges = [...win.CSS.highlights.get('golow-time')];
  assert(ranges.length === 2 && ranges[0].toString() === '01:30', 'times in the description are highlighted');
  const box = ranges[1].getBoundingClientRect();
  doc.getElementById('desc').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientX: box.left + 2, clientY: box.top + box.height / 2}));
  assert(Math.abs(audio.currentTime - 240) < 1, 'clicking 04:00 seeks there: ' + audio.currentTime);

  // Never play an artist: hidden from lists, skipped now and when they come up again.
  barRoot().getElementById('block').click();
  const option = [...overlay().querySelectorAll('.menu button')].find(button => button.textContent.includes('DJ Artist'));
  option.click();
  assert(window.__nextClicks === 1 && hidden('other'), 'blocking the artist skips and hides them');
  await window.__start('/dj/other', 'Other');
  await wait(100);
  assert(window.__nextClicks === 2, 'a blocked artist is skipped when they come up');
  client.command('panel', 'blocked');
  overlay().getElementById('body').querySelector('button.btn').click();
  assert(!hidden('other'), 'unblocking shows them again');

  // Long tracks keep their own position, and resume there.
  await window.__start('/dj/long', 'Long Mix', '40:00', '20:00');
  await wait(100);
  assert(JSON.parse(localStorage.getItem('golow-positions'))['/dj/long'].t === 1200, 'long track position saved');
  client.command('panel', 'continue');
  assert(overlay().getElementById('body').textContent.includes('Long Mix'), 'continue listening lists it');
  await window.__start('/dj/mix', 'Big Mix');
  await wait(50);
  window.__seek = undefined;
  await window.__start('/dj/long', 'Long Mix', '40:00', '0:00');
  await wait(100);
  assert(Math.abs(window.__seek - 0.5) < 0.01, 'resumes at 20:00: ' + window.__seek);

  // Sleep timer: fades, pauses, and puts the volume back.
  audio.volume = 0.8;
  client.command('sleep', 0.05);
  await wait(3600);
  assert(!byId('play').classList.contains('playing') && Math.abs(audio.volume - 0.8) < 0.01, 'sleep timer paused and restored the volume: ' + audio.volume);
  return 'ok';
})()`;

test('mix mode, playback tools, badges and the blocklist in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  await withEdge({routes: [['/n/', trackPage], ['/', page]], api}, async ({evaluate, navigate}) => {
    await navigate('/feed', "document.readyState === 'complete' && document.getElementById('webi').contentDocument?.readyState === 'complete'");
    assert.equal(await evaluate(checks), 'ok');
  });
});
