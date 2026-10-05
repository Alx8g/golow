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
  assert.doesNotMatch(script, /setInterval|createTreeWalker|getBoundingClientRect/);
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
</div><div class="l-sidebar-right" id="sidebar"><div class="whoToFollowModule" id="follow"></div><div class="mobileApps" id="mobile"></div>
<div class="l-footer" id="footer">Legal</div><article class="artistShortcutsModule" id="new-tracks"><button aria-label="Play new track">Play</button></article></div></div></div>
<div class="playControls" id="player"><section class="playControls__inner"><div class="playControls__wrapper l-container">
<div class="playControls__elements" id="elements"><button class="playControls__control" aria-label="Pause">Pause</button>
<div class="playControls__volume"><button class="volume__speakerIcon" id="speaker">Volume</button></div>
<button class="playControls__play" id="play">Play</button><div class="playbackSoundBadge"><a class="playbackSoundBadge__lightLink" title="Artist"></a>
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
window.__newTrack = title => { autoplayOn = true; document.querySelector('.playbackSoundBadge__titleLink').title = title; };
</script>
</div></body></html>`;
// The redesigned track page: Material UI markup with stable aria labels only.
const trackPage = `<!doctype html><html><head></head><body>
<button aria-label="Unlike" id="liked">Liked</button><button aria-label="Like" id="unliked">Like</button>
<div><div role="slider" aria-label="Waveform"><svg><g style="opacity:.75"><rect width="2" height="9"></rect></g></svg></div>
<div><div><ol id="avatars"><li><img alt="avatar"></li></ol></div></div></div></body></html>`;

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
  assert(sent().compact === true && Object.keys(sent()).length === 6, 'mini player sent as one bounded settings object');
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

  client.update({cleanup: false, efficiency: false});
  assert(!hidden('promo') && !hidden('upsell') && !hidden('follow') && !hidden(spinner('idle')), 'toggles restore content');
  client.update({cleanup: true, efficiency: true});
  assert(hidden('promo') && hidden('follow') && hidden(spinner('idle')), 're-enable');
  return 'ok';
})()`;

const widthChecks = width => `(() => {
  const style = id => getComputedStyle(document.getElementById(id));
  const main = document.getElementById('main').getBoundingClientRect().width;
  if (${width} < 1000 && (style('sidebar').display !== 'none' || style('main').marginRight !== '0px')) throw new Error('narrow windows drop the sidebar');
  if (${width} >= 1600 && main <= 848) throw new Error('wide windows give the main column more room');
  return 'ok';
})()`;

test('cleans up, styles new track pages, places settings and runs the mini player in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  // Keep the top-frame guard, drop the origin check: like WebView2 here, frames get no script.
  const fixture = script.replace(/location\.protocol !== 'https:' \|\|\s*!\['soundcloud\.com', 'www\.soundcloud\.com'\]\.includes\(location\.hostname\)/, 'false');
  assert.notEqual(fixture, script, 'origin guard replaced in the fixture copy only');
  const server = http.createServer((req, res) => res.writeHead(200, {'content-type': 'text/html'}).end(req.url.startsWith('/n/') ? trackPage : page));
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
    ws.onmessage = ({data}) => { const message = JSON.parse(data); replies.get(message.id)?.(message.result); };
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
    await cdp('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
    for (let i = 0; i < 50 && await evaluate("document.readyState !== 'complete' || document.getElementById('webi').contentDocument?.readyState !== 'complete'"); i++) await sleep(100);
    assert.equal(await evaluate(checks), 'ok');
    for (const width of [700, 1700]) {
      await resize(width);
      assert.equal(await evaluate(widthChecks(width)), 'ok', `${width}px`);
    }
    ws.close();
  } finally {
    server.close();
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await exited;
    // Edge helpers can hold the temporary profile briefly after the browser exits.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); } catch {}
  }
});
