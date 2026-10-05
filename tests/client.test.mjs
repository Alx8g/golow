// Runs src/client.js in plain contexts and in headless Microsoft Edge against synthetic
// pages served locally. Never loads SoundCloud or an account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const edge = [process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));

test('parses and has no polling or document text walkers', () => {
  new vm.Script(script);
  assert.doesNotMatch(script, /setInterval|createTreeWalker/);
});

test('does not inject into authentication providers or unrelated child frames', () => {
  for (const hostname of ['accounts.google.com', 'soundcloud.com.example.invalid', 'example.invalid']) {
    const window = {};
    window.top = window;
    vm.runInNewContext(script, {window, location: {protocol: 'https:', hostname, pathname: '/'}});
    assert.equal(window.__scClient, undefined, hostname);
  }
  const window = {top: {}};
  vm.runInNewContext(script, {window, location: {protocol: 'https:', hostname: 'soundcloud.com', pathname: '/discover'}});
  assert.equal(window.__scClient, undefined);
});

const spinner = '<svg><path><animateTransform attributeName="transform" type="rotate" dur="1s" repeatCount="indefinite"/></path></svg>';
const page = `<!doctype html><html><head></head><body><div id="app">
<header class="header"><div class="header__inner"><div class="header__left"><ul class="header__navMenu" id="main-nav"><li>Home</li></ul></div>
<div class="header__right" id="right"><div class="header__upsellWrapper" id="upsell"><a href="https://checkout.soundcloud.com/artist">Try Artist Pro</a></div>
<a class="header__forArtistsButton" id="studio" href="/artists">Artist Studio</a><div class="header__soundInput" id="upload"><a href="/upload">Upload</a><input type="file"></div>
<ul class="header__navMenu" id="more"><li>More</li></ul></div></div></header>
<div class="l-container l-content"><div class="l-product-banners"><div class="banner" id="sales"><a href="https://checkout.soundcloud.com/artist?ref=1">Learn more</a></div>
<div class="banner" id="notice">Verify your email <a href="/settings">Settings</a></div></div>
<div class="l-fluid-fixed"><div class="l-main" id="main" style="width:848px">
<div class="upsellBanner" id="promo">Try Artist Pro</div>
<div class="upsellBanner" id="protected"><button aria-label="Play track">Play</button></div>
<div class="cookieBanner" id="consent">Choose cookies <button>Accept</button></div>
<a href="/go" id="upsell-link">Go+</a><div class="homeCreditTracker" id="artist-tools"><iframe srcdoc="Artist Tools"></iframe></div>
<button class="sc-button-like" aria-label="Unlike" id="liked">Liked</button><button class="sc-button-like" aria-label="Like" id="unliked">Like</button>
<div class="waveform"><canvas class="sceneLayer"></canvas><div class="commentPlaceholder" id="old-comment"></div></div>
<div class="playableTile" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="idle">${spinner}</div></div></div>
<div class="playableTile m-playing" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="active">${spinner}</div></div></div>
<iframe class="webiIframe" id="webi" src="/n/artist/track"></iframe>
<div class="stream__filter" id="filters"><div class="streamFilter__item"><label>Reposts</label></div></div>
<ul><li class="soundList__item" id="long"><a class="soundTitle__title" href="/a/long">Long mix</a></li>
<li class="soundList__item" id="short"><a class="soundTitle__title" href="/a/short">Short track</a></li>
<li class="soundList__item" id="heard"><a class="soundTitle__title" href="/a/played">Heard before</a></li></ul>
</div><div class="l-sidebar-right" id="sidebar"><div class="whoToFollowModule" id="follow"></div><div class="mobileApps" id="mobile"></div>
<div class="l-footer" id="footer">Legal</div><article class="artistShortcutsModule" id="new-tracks"><button aria-label="Play new track">Play</button></article></div></div></div>
<div class="playControls" id="player"><section class="playControls__inner"><div class="playControls__wrapper l-container">
<div class="playControls__elements" id="elements"><button class="playControls__control" aria-label="Pause">Pause</button>
<div class="playControls__volume"><button class="volume__speakerIcon" id="speaker">Volume</button></div>
<button class="playControls__play" id="play">Play</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true" id="passed">0:00</span></div>
<div class="playbackTimeline__progressWrapper" id="progress" style="width:300px;height:10px"></div>
<div class="playbackTimeline__duration"><span aria-hidden="true" id="duration">5:00</span></div><div class="playbackSoundBadge"><a class="playbackSoundBadge__lightLink" title="Artist"></a>
<a class="playbackSoundBadge__titleLink" title="Track"></a><a class="playbackSoundBadge__showQueue" id="show-queue">Next up</a></div></div></div></section>
<div class="playControls__queue" id="queue"></div></div>
<script>
let autoplayOn = true;
document.getElementById('show-queue').addEventListener('click', () => {
  const queue = document.getElementById('queue');
  if (queue.firstChild) return queue.replaceChildren();
  queue.innerHTML = '<div class="queueFallback__toggle"><label class="sc-toggle" id="autoplay"><input type="checkbox" id="autoplay-input"></label></div>';
  document.getElementById('autoplay').classList.toggle('sc-toggle-on', autoplayOn);
  document.getElementById('autoplay-input').addEventListener('click', () => { autoplayOn = !autoplayOn; document.getElementById('autoplay').classList.toggle('sc-toggle-on', autoplayOn); });
});
window.__autoplayOn = () => autoplayOn;
document.getElementById('progress').addEventListener('click', event => {
  const box = event.currentTarget.getBoundingClientRect();
  window.__seek = (event.clientX - box.left) / box.width;
});
for (const url of ['https://api-v2.soundcloud.com/stream?limit=10', 'https://api-v2.soundcloud.com/me/play-history/tracks?limit=25']) {
  const request = new XMLHttpRequest();
  request.open('GET', url);
  request.send();
}
window.__newTrack = title => { autoplayOn = true; document.querySelector('.playbackSoundBadge__titleLink').title = title; };
</script>
</div></body></html>`;
const likesPage = `<!doctype html><html><head></head><body><div id="app">
<header class="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header>
<div class="collectionSection"><div class="collectionSection__top"><h2>Hear the tracks you have liked:</h2><div class="collectionSection__action">View</div></div>
<div class="badgeList lazyLoadingList" id="list"></div></div>
<div class="playControls"><div class="playControls__elements"><button class="shuffleControl m-shuffling" id="shuffle">Shuffle</button>
<button class="playControls__next" id="next">Next</button><button class="playControls__play" id="play">Play</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true" id="passed">0:00</span></div><div class="playbackTimeline__duration"><span aria-hidden="true" id="duration">3:00</span></div>
<a class="playbackSoundBadge__titleLink" id="badge" title="" href=""></a><a class="playbackSoundBadge__lightLink" title="Artist"></a></div></div></div>
<script>
let loaded = 0;
const list = document.getElementById('list');
const more = () => { for (let i = 0; i < 24 && loaded < 60; i++, loaded++) list.insertAdjacentHTML('beforeend', '<li class="badgeList__item" style="height:120px"><a class="playableTile__artworkLink" href="/a/t' + loaded + '">Track ' + loaded + ' by ' + (loaded % 2 ? 'Odd' : 'Even') + '</a><button class="sc-button-play" data-n="' + loaded + '">Play</button></li>'); };
// Playing a like or pressing next behaves like SoundCloud: the badge and play state follow.
const start = n => { const badge = document.getElementById('badge'); badge.href = '/a/t' + n; badge.title = 'Track ' + n; document.getElementById('play').classList.add('playing'); window.__current = n; document.getElementById('passed').textContent = '0:01'; };
more();
addEventListener('scroll', () => { if (innerHeight + scrollY >= document.documentElement.scrollHeight - 50) setTimeout(more, 100); });
document.getElementById('shuffle').addEventListener('click', event => event.target.classList.toggle('m-shuffling'));
document.addEventListener('click', event => {
  if (event.target.matches('.badgeList__item .sc-button-play')) start(Number(event.target.dataset.n));
  if (event.target.id === 'next') start((window.__current + 1) % 60);
});
</script></body></html>`;
// The redesigned track page: Material UI markup with stable aria labels only.
const trackPage = `<!doctype html><html><head></head><body>
<button aria-label="Unlike" id="liked">Liked</button><button aria-label="Like" id="unliked">Like</button>
<div><div role="slider" aria-label="Waveform"><svg><g style="opacity:.75"><rect width="2" height="9"></rect></g></svg></div>
<div><div><ol id="avatars"><li><img alt="avatar"></li></ol></div></div></div>
<ul aria-label="Comments" style="display:flex;flex-direction:column">
<li id="c1"><div><button aria-label="Like"></button></div>no likes</li>
<li id="c2"><div><div><button aria-label="Like"></button></div><span>5</span></div>five likes</li>
<li id="c3"><div><button aria-label="Unlike"></button><span>2</span></div>two likes</li></ul></body></html>`;

// Each step throws with its message on failure; Runtime.evaluate reports it.
const checks = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const byId = id => document.getElementById(id);
  const hidden = target => getComputedStyle(typeof target === 'string' ? byId(target) : target).display === 'none';
  const spinner = id => document.querySelector('#' + id + ' svg');
  const client = window.__scClient, host = () => byId('sc-client-settings'), shadow = () => host().shadowRoot;
  const sent = () => window.__scMessages.at(-1) || {};
  const frame = byId('webi').contentWindow, frameDoc = byId('webi').contentDocument, inFrame = id => frame.getComputedStyle(frameDoc.getElementById(id));
  for (const id of ['promo', 'upsell-link', 'artist-tools', 'upsell', 'studio', 'upload', 'sales', 'follow', 'mobile', 'footer']) assert(hidden(id), 'hidden: ' + id);
  for (const id of ['protected', 'consent', 'player', 'notice', 'new-tracks', 'main-nav', 'old-comment']) assert(!hidden(id), 'kept: ' + id);
  assert(hidden(spinner('idle')) && !hidden(spinner('active')), 'only spinners inside hidden play buttons stop rendering');
  assert(getComputedStyle(byId('liked')).color === 'rgb(255, 85, 0)' && getComputedStyle(byId('unliked')).color !== 'rgb(255, 85, 0)', 'liked state is orange');
  assert(byId('more').previousElementSibling === host(), 'gear sits left of the more menu');
  assert(!client.diagnostics().settings_built && !shadow().getElementById('panel'), 'settings panel deferred');

  assert(frame.__scClient === undefined && !frameDoc.getElementById('sc-client-settings'), 'track-page frame gets styles, not the app UI');
  assert(inFrame('liked').color === 'rgb(255, 85, 0)' && inFrame('unliked').color !== 'rgb(255, 85, 0)', 'liked state is orange on new track pages');
  assert(frame.getComputedStyle(frameDoc.querySelector('svg g')).opacity === '1', 'new track page waveform at full contrast');
  frameDoc.documentElement.replaceWith(frameDoc.documentElement.cloneNode(true));
  assert(inFrame('liked').color === 'rgb(255, 85, 0)', 'styles survive React replacing the document');

  const fresh = byId('right').cloneNode(true);
  fresh.querySelector('#sc-client-settings').remove();
  byId('right').replaceWith(fresh);
  await wait(0);
  assert(byId('more').previousElementSibling === host() && client.diagnostics().placed, 'gear returns after SoundCloud swaps its header');

  shadow().getElementById('open').click();
  assert(!shadow().getElementById('panel').hidden && shadow().getElementById('open').getAttribute('aria-expanded') === 'true', 'gear opens settings');
  byId('main').click();
  assert(shadow().getElementById('panel').hidden, 'outside click closes settings');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: ',', ctrlKey: true}));
  assert(!shadow().getElementById('panel').hidden, 'Ctrl+, opens settings');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
  assert(shadow().getElementById('panel').hidden, 'Escape closes settings');

  client.openSettings(true);
  shadow().getElementById('comments').click();
  await wait(50);
  assert(sent().comments === false && hidden('old-comment') && inFrame('avatars').display === 'none', 'waveform comments hide on both page generations');
  shadow().getElementById('comments').click();
  await wait(50);
  assert(!hidden('old-comment') && inFrame('avatars').display !== 'none', 'waveform comments return');

  shadow().getElementById('compact').click();
  assert(sent().compact === true && Object.keys(sent()).length === 10, 'mini player sent as one bounded settings object');
  assert(host().parentElement === byId('elements') && hidden(document.querySelector('header')) && !hidden('player'), 'mini player shows only the bar');
  assert(hidden(shadow().getElementById('open')) && !hidden(shadow().getElementById('expand')) && shadow().getElementById('panel').hidden, 'mini player offers expand');
  shadow().getElementById('expand').click();
  assert(sent().compact === false && byId('more').previousElementSibling === host(), 'expand restores the full window');

  const keys = [];
  document.addEventListener('keydown', e => keys.push((e.shiftKey ? 'Shift+' : '') + e.key));
  const wheel = new WheelEvent('wheel', {deltaY: -100, bubbles: true, cancelable: true});
  byId('speaker').dispatchEvent(wheel);
  byId('main').dispatchEvent(new WheelEvent('wheel', {deltaY: -100, bubbles: true, cancelable: true}));
  assert(wheel.defaultPrevented && keys.join() === 'Shift+ArrowUp', 'wheel over the speaker drives the volume shortcut, and only there');

  byId('play').classList.add('playing');
  await wait(0);
  assert(sent().now === 'Track – Artist', 'reports the playing track');
  byId('play').classList.remove('playing');
  await wait(0);
  assert(sent().now === null, 'reports pause');
  client.update({autoplay: false});
  window.__newTrack('Second track');
  byId('play').classList.add('playing');
  await wait(300);
  assert(!window.__autoplayOn() && !byId('queue').firstChild && byId('queue').style.visibility === '', 'autoplay switched off behind a closed queue panel when a track starts');
  byId('play').classList.remove('playing');
  client.update({autoplay: true});
  window.__newTrack('Third track');
  byId('play').classList.add('playing');
  await wait(300);
  assert(window.__autoplayOn(), 'autoplay left alone when the user wants it');
  byId('play').classList.remove('playing');
  await wait(0);

  for (const id of ['long', 'short', 'heard']) assert(!hidden(id), 'feed shows everything by default: ' + id);
  const feedSwitch = key => document.querySelector('[data-golow="' + key + '"] input');
  assert(feedSwitch('mixes') && feedSwitch('played') && feedSwitch('mixes').checked, 'feed switches sit next to Reposts');
  feedSwitch('mixes').click();
  assert(sent().mixes === false && hidden('long') && !hidden('short'), 'Mixes off hides tracks over 20 minutes');
  feedSwitch('played').click();
  assert(sent().played === false && hidden('heard') && !hidden('short'), 'Played off hides tracks from listening history');
  client.update({mixes: true, played: true});
  assert(!hidden('long') && !hidden('heard') && feedSwitch('mixes').checked, 'feed filters restore');

  const order = id => frameDoc.getElementById(id).style.order;
  assert(order('c2') === '' && order('c3') === '', 'comments keep SoundCloud order by default');
  client.update({top_comments: true});
  assert(order('c2') === '-5' && order('c3') === '-2' && order('c1') === '', 'top comments first orders by likes');
  client.update({top_comments: false});
  assert(order('c2') === '', 'top comments first can be switched off');

  document.querySelector('.playbackSoundBadge__titleLink').setAttribute('href', '/a/resume');
  document.querySelector('.playbackSoundBadge__titleLink').title = 'Resume me';
  byId('play').classList.add('playing');
  byId('passed').textContent = '1:40';
  await wait(0);
  assert(JSON.parse(localStorage.getItem('golow-resume')).t === 100, 'remembers the playing position');
  byId('play').classList.remove('playing');
  await wait(0);

  client.update({cleanup: false, efficiency: false});
  assert(!hidden('promo') && !hidden('upsell') && !hidden('follow') && !hidden(spinner('idle')), 'toggles restore content');
  client.update({cleanup: true, efficiency: true});
  assert(hidden('promo') && hidden('follow') && hidden(spinner('idle')), 're-enable');
  return 'ok';
})()`;

const likesChecks = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  for (let i = 0; i < 20 && !document.querySelector('[data-golow-tools]'); i++) await wait(50);
  const [input, button] = document.querySelector('[data-golow-tools]').children;
  assert(input && button, 'likes tools sit in the section header');
  input.value = 'odd';
  input.dispatchEvent(new Event('input'));
  for (let i = 0; i < 100 && document.querySelectorAll('.badgeList__item').length < 60; i++) await wait(100);
  await wait(2000);
  const visible = [...document.querySelectorAll('.badgeList__item')].filter(item => getComputedStyle(item).display !== 'none');
  assert(document.querySelectorAll('.badgeList__item').length === 60 && visible.length === 30 && visible.every(item => item.textContent.includes('Odd')), 'filter searches every like, not just the loaded ones');
  input.value = '';
  input.dispatchEvent(new Event('input'));
  await wait(50);
  assert([...document.querySelectorAll('.badgeList__item')].every(item => getComputedStyle(item).display !== 'none'), 'clearing the filter shows everything');
  const client = window.__scClient, badge = () => document.getElementById('badge').getAttribute('href');
  button.click();
  for (let i = 0; i < 60 && !client.diagnostics().shuffle; i++) await wait(100);
  await wait(50);
  const first = client.diagnostics().shuffle;
  assert(first && badge() === first && button.textContent === 'Stop shuffle', 'shuffle all starts its own random pick');
  assert(!document.getElementById('shuffle').classList.contains('m-shuffling'), 'SoundCloud shuffle is switched off while GoLow shuffles');
  const sequential = '/a/t' + ((window.__current + 1) % 60);
  document.getElementById('next').click();
  await wait(50);
  const second = client.diagnostics().shuffle;
  assert(second && second !== first && badge() === second, 'when SoundCloud advances on its own, the next random pick plays instead');
  document.getElementById('passed').textContent = '2:59';
  await wait(50);
  const third = client.diagnostics().shuffle;
  assert(third && third !== second && badge() === third, 'a second before the end, the next pick starts');
  const picks = new Set([first, second, third]);
  for (let i = 0; i < 57; i++) { document.getElementById('next').click(); await wait(5); picks.add(client.diagnostics().shuffle); }
  assert(picks.size === 60 || client.diagnostics().shuffle === null, 'a round plays every like once');
  button.click();
  assert(client.diagnostics().shuffle === null && button.textContent === 'Shuffle all', 'stop shuffle');
  return 'ok';
})()`;

// After a restart SoundCloud shows the last track at 0:00; pressing play seeks back.
const resumeChecks = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const badge = document.querySelector('.playbackSoundBadge__titleLink');
  badge.setAttribute('href', '/a/resume');
  badge.title = 'Resume me';
  document.getElementById('passed').textContent = '0:00';
  document.getElementById('play').classList.add('playing');
  await wait(50);
  if (Math.abs((window.__seek ?? -1) - 100 / 300) > 0.02) throw new Error('resumes at the remembered position: ' + window.__seek);
  return 'ok';
})()`;

const widthChecks = width => `(() => {
  const style = id => getComputedStyle(document.getElementById(id));
  const main = document.getElementById('main').getBoundingClientRect().width;
  if (${width} < 1000 && (style('sidebar').display !== 'none' || style('main').marginRight !== '0px')) throw new Error('narrow windows drop the sidebar');
  if (${width} >= 1600 && main <= 848) throw new Error('wide windows give the main column more room');
  return 'ok';
})()`;

test('cleans up, styles new track pages, settings, mini player, feed filters and likes tools in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  // Keep the top-frame guard, drop the origin check: like WebView2 here, frames get no script.
  const fixture = script.replace(/location\.protocol !== 'https:' \|\|\s*!\['soundcloud\.com', 'www\.soundcloud\.com'\]\.includes\(location\.hostname\)/, 'false');
  assert.notEqual(fixture, script, 'origin guard replaced in the fixture copy only');
  const server = http.createServer((req, res) => res.writeHead(200, {'content-type': 'text/html'})
    .end(req.url.startsWith('/n/') ? trackPage : req.url.startsWith('/you/likes') ? likesPage : page));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'golow-test-'));
  const browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank']);
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => Object.assign(ws, {onopen: resolve, onerror: reject}));
    const replies = new Map();
    let id = 0;
    // SoundCloud's API answers come from here: a 60-minute mix, a short track, and history.
    const api = {
      '/stream': {collection: [{track: {permalink_url: 'https://soundcloud.com/a/long', duration: 3600000}},
        {track: {permalink_url: 'https://soundcloud.com/a/short', duration: 200000}}, {track: {permalink_url: 'https://soundcloud.com/a/played', duration: 200000}}]},
      '/me/play-history': {collection: [{track: {permalink_url: 'https://soundcloud.com/a/played'}}]},
    };
    ws.onmessage = ({data}) => {
      const message = JSON.parse(data);
      if (message.method === 'Fetch.requestPaused') {
        const body = JSON.stringify(Object.entries(api).find(([key]) => message.params.request.url.includes(key))?.[1] || {});
        ws.send(JSON.stringify({id: ++id, method: 'Fetch.fulfillRequest', params: {requestId: message.params.requestId, responseCode: 200,
          responseHeaders: [{name: 'Content-Type', value: 'application/json'}, {name: 'Access-Control-Allow-Origin', value: '*'}], body: Buffer.from(body).toString('base64')}}));
      }
      replies.get(message.id)?.(message.result);
    };
    const cdp = (method, params) => new Promise(resolve => {
      replies.set(++id, resolve);
      ws.send(JSON.stringify({id, method, params}));
    });
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
      return result.result.value;
    };
    const resize = width => cdp('Emulation.setDeviceMetricsOverride', {width, height: 800, deviceScaleFactor: 1, mobile: false});
    // Like WebView2, inject before any page script, into every frame.
    await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source: 'window.__scMessages=[];window.ipc={postMessage:s=>window.__scMessages.push(JSON.parse(s))};'});
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source: fixture});
    await resize(1280);
    await cdp('Fetch.enable', {patterns: [{urlPattern: 'https://api-v2.soundcloud.com/*'}]});
    await cdp('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/feed`});
    for (let i = 0; i < 50 && await evaluate("document.readyState !== 'complete' || document.getElementById('webi').contentDocument?.readyState !== 'complete'"); i++) await sleep(100);
    assert.equal(await evaluate(checks), 'ok');
    for (const width of [700, 1700]) {
      await resize(width);
      assert.equal(await evaluate(widthChecks(width)), 'ok', `${width}px`);
    }
    await resize(1280);
    await cdp('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/feed`});
    for (let i = 0; i < 50 && await evaluate("document.readyState !== 'complete'"); i++) await sleep(100);
    assert.equal(await evaluate(resumeChecks), 'ok');
    await cdp('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/you/likes`});
    for (let i = 0; i < 50 && await evaluate("document.readyState !== 'complete'"); i++) await sleep(100);
    assert.equal(await evaluate(likesChecks), 'ok');
    ws.close();
  } finally {
    server.close();
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, sleep(5000)]);
    // Edge helpers can hold the temporary profile briefly after the browser exits.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); } catch {}
  }
});
