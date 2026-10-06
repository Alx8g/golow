// Polish and resilience: outage messages, spam flags, the comment guard, clean links, the
// stream quality, themes, custom CSS, the full-window view and region-blocked skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {edge, prelude, withEdge} from './harness.mjs';

const stream = 'https://api-v2.soundcloud.com/media/soundcloud:tracks:5/abc/stream/hls';
const api = {
  'tracks?ids=5': [{kind: 'track', id: 5, title: 'Song', permalink_url: 'https://soundcloud.com/a/song', duration: 200000, user: {username: 'A', permalink_url: 'https://soundcloud.com/a'},
    media: {transcodings: [{url: stream, preset: 'aac_256k', quality: 'hq', format: {protocol: 'ctr-encrypted-hls'}}]}},
    {kind: 'track', id: 6, title: 'Blocked', permalink_url: 'https://soundcloud.com/a/blocked', duration: 200000, policy: 'BLOCK', user: {username: 'A', permalink_url: 'https://soundcloud.com/a'}}],
  'media/soundcloud:tracks:5': {url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8'},
  'followings/ids': {collection: [42]},
  'users/42': {kind: 'user', id: 42, username: 'Friend', permalink_url: 'https://soundcloud.com/friend'},
  'users/43': {kind: 'user', id: 43, username: 'Stranger', permalink_url: 'https://soundcloud.com/stranger'},
  'broken': {__status: 503},
};
const get = url => `(() => { const r = new XMLHttpRequest(); r.open('GET', '${url}'); r.send(); })();`;
const page = `<!doctype html><html><head></head><body class="theme-dark"><div id="app">
<header class="header" id="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header>
<ul class="inbox__list"><li id="scam"><a href="/stranger">Stranger</a> transition at 0:28 is crazy, can I ask you a question?</li>
<li id="friend"><a href="/friend">Friend</a> can I ask you a question about the record label?</li><li id="normal"><a href="/stranger">Stranger</a> great set last night</li></ul>
<input id="share" value="https://soundcloud.com/a/song?si=abc123&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing">
<iframe class="webiIframe" id="webi" src="/n/a/song"></iframe>
<div class="playControls"><div class="playControls__elements"><button class="playControls__play" id="play">Play</button><button class="skipControl__next" id="next">Next</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true">0:00</span></div><div class="playbackTimeline__progressWrapper"></div>
<div class="playbackTimeline__duration"><span aria-hidden="true">3:20</span></div><div class="playControls__volume">Vol</div>
<a class="playbackSoundBadge__lightLink" href="/a" title="A"></a><a class="playbackSoundBadge__titleLink" id="badge" href="" title=""></a></div></div>
</div><script>
window.__next = 0; document.getElementById('next').addEventListener('click', () => window.__next++);
${get('https://api-v2.soundcloud.com/tracks?ids=5,6&client_id=test')}
${get('https://api-v2.soundcloud.com/users/7/followings/ids?client_id=test')}
${get('https://api-v2.soundcloud.com/users/42?client_id=test')}
${get('https://api-v2.soundcloud.com/users/43?client_id=test')}
window.__get = url => { const r = new XMLHttpRequest(); r.open('GET', url); r.send(); };
</script></body></html>`;
const trackPage = `<!doctype html><html><head></head><body><main><form id="form"><input aria-label="Add a comment to this track" id="comment">
<button aria-label="Post comment" type="submit">Post</button></form></main>
<script>window.__posts = 0; document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); window.__posts++; });</script></body></html>`;

const checks = `(async () => {
  ${prelude}
  for (let i = 0; i < 50 && client.diagnostics().tracks < 2; i++) await wait(100);
  const toasts = () => [...(overlay()?.querySelectorAll('.toast') || [])].map(t => t.textContent).join(' | ');

  // SoundCloud failing three times in a minute: a plain answer, not "check your connection".
  for (let i = 0; i < 3; i++) window.__get('https://api-v2.soundcloud.com/broken?client_id=test');
  for (let i = 0; i < 30 && !toasts().includes('servers'); i++) await wait(100);
  assert(toasts().includes("SoundCloud's servers are having problems right now (error 503)"), 'outage explained: ' + toasts());

  // Spam: a scam template from a stranger is flagged; the same words from someone followed are not.
  history.pushState({}, '', '/messages');
  document.body.append(document.createElement('div'));
  await wait(20);
  assert(byId('scam').hasAttribute('data-golow-spam') && !byId('friend').hasAttribute('data-golow-spam') && !byId('normal').hasAttribute('data-golow-spam'),
    'flags spam from strangers only');

  // Copying a share link drops the tracking codes.
  const share = byId('share');
  share.focus(); share.select();
  const copy = new ClipboardEvent('copy', {clipboardData: new DataTransfer(), bubbles: true, cancelable: true});
  share.dispatchEvent(copy);
  assert(copy.clipboardData.getData('text/plain') === 'https://soundcloud.com/a/song', 'clean link: ' + copy.clipboardData.getData('text/plain'));

  // A comment posts once, however often Enter is pressed.
  const frame = byId('webi').contentDocument;
  frame.getElementById('comment').value = 'Great track';
  frame.getElementById('form').requestSubmit();
  frame.getElementById('form').requestSubmit();
  await wait(20);
  assert(byId('webi').contentWindow.__posts === 1, 'second identical submit blocked: ' + byId('webi').contentWindow.__posts);

  // The stream quality shows once the player asks for a stream.
  byId('badge').setAttribute('href', '/a/song'); byId('badge').title = 'Song';
  byId('play').classList.add('playing');
  window.__get('${stream}?client_id=test&track_authorization=x');
  for (let i = 0; i < 30 && barRoot().getElementById('quality').hidden; i++) await wait(100);
  assert(barRoot().getElementById('quality').textContent === 'AAC 256' && !barRoot().getElementById('quality').hidden, 'quality badge: ' + barRoot().getElementById('quality').textContent);

  // A region-blocked track is skipped rather than left stuck.
  byId('badge').setAttribute('href', '/a/blocked'); byId('badge').title = 'Blocked';
  await wait(50);
  assert(window.__next === 1 && toasts().includes('not available here'), 'region-blocked track skipped');

  // Themes and custom CSS.
  client.openSettings(true);
  const theme = byId('sc-client-settings').shadowRoot.getElementById('theme');
  theme.value = 'black'; theme.dispatchEvent(new Event('change'));
  assert(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && getComputedStyle(byId('header')).backgroundColor === 'rgb(0, 0, 0)', 'pure black theme');
  client.command('panel', 'css');
  const area = overlay().getElementById('body').querySelector('textarea');
  area.value = '#header { outline: 3px solid rgb(1, 2, 3) !important; }';
  [...overlay().getElementById('body').querySelectorAll('button')].find(b => b.textContent === 'Apply').click();
  assert(getComputedStyle(byId('header')).outlineColor === 'rgb(1, 2, 3)', 'custom CSS applied');

  // Full-window now playing.
  client.command('stage');
  const stage = overlay().querySelector('[aria-label="Now playing"]');
  assert(stage && stage.textContent.includes('Blocked'), 'full-window view shows the track');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert(!overlay().querySelector('[aria-label="Now playing"]'), 'Escape closes it');
  return 'ok';
})()`;

test('outages, spam, comment guard, clean links, quality, themes and the full-window view', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  await withEdge({routes: [['/n/', trackPage], ['/', page]], api}, async ({evaluate, navigate}) => {
    await navigate('/home', "document.readyState === 'complete' && document.getElementById('webi').contentDocument?.readyState === 'complete'");
    assert.equal(await evaluate(checks), 'ok');
  });
});
