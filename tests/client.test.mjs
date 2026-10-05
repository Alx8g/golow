// Runs src/client.js in plain contexts and in headless Microsoft Edge against a synthetic
// page. Never loads SoundCloud or an account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const edge = [process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));

test('parses and has no polling, document text walkers or synthetic clicks', () => {
  new vm.Script(script);
  assert.doesNotMatch(script, /setInterval|createTreeWalker|getBoundingClientRect|\.click\(\)/);
});

test('does not inject into authentication providers or child frames', () => {
  for (const hostname of ['accounts.google.com', 'soundcloud.com.example.invalid', 'example.invalid']) {
    const window = {};
    window.top = window;
    vm.runInNewContext(script, {window, location: {protocol: 'https:', hostname}});
    assert.equal(window.__scClient, undefined, hostname);
  }
  const window = {top: {}};
  vm.runInNewContext(script, {window});
  assert.equal(window.__scClient, undefined);
});

const spinner = '<svg><path><animateTransform attributeName="transform" type="rotate" dur="1s" repeatCount="indefinite"/></path></svg>';
const html = `<html><head></head><body><div id="app">
<header class="header"><div class="header__inner"><div class="header__left"><ul class="header__navMenu" id="main-nav"><li>Home</li></ul></div>
<div class="header__right" id="right"><div class="header__upsellWrapper" id="upsell"><a href="https://checkout.soundcloud.com/artist">Try Artist Pro</a></div>
<a class="header__forArtistsButton" id="studio" href="/artists">Artist Studio</a><div class="header__soundInput" id="upload"><a href="/upload">Upload</a><input type="file"></div>
<ul class="header__navMenu" id="more"><li>More</li></ul></div></div></header>
<div class="l-container l-content"><div class="l-product-banners"><div class="banner" id="sales"><a href="https://checkout.soundcloud.com/artist?ref=1">Learn more</a></div>
<div class="banner" id="notice">Verify your email <a href="/settings">Settings</a></div></div>
<div class="l-fluid-fixed"><div class="l-main" id="main">
<div class="upsellBanner" id="promo">Try Artist Pro</div>
<div class="upsellBanner" id="protected"><button aria-label="Play track">Play</button></div>
<div class="cookieBanner" id="consent">Choose cookies <button>Accept</button></div>
<a href="/go" id="upsell-link">Go+</a><div class="homeCreditTracker" id="artist-tools"><iframe srcdoc="Artist Tools"></iframe></div>
<div class="playableTile" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="idle">${spinner}</div></div></div>
<div class="playableTile m-playing" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="active">${spinner}</div></div></div>
</div><div class="l-sidebar-right" id="sidebar"><div class="whoToFollowModule" id="follow"></div><div class="mobileApps" id="mobile"></div>
<div class="l-footer" id="footer">Legal</div><article class="artistShortcutsModule" id="new-tracks"><button aria-label="Play new track">Play</button></article></div></div></div>
<div class="playControls" id="player"><section class="playControls__inner"><div class="playControls__wrapper l-container">
<div class="playControls__elements" id="elements"><button class="playControls__control" aria-label="Pause">Pause</button></div></div></section></div>
</div></body></html>`;

// Each step throws with its message on failure; Runtime.evaluate reports it.
const checks = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const byId = id => document.getElementById(id);
  const hidden = target => getComputedStyle(typeof target === 'string' ? byId(target) : target).display === 'none';
  const spinner = id => document.querySelector('#' + id + ' svg');
  const client = window.__scClient, host = () => byId('sc-client-settings'), shadow = () => host().shadowRoot;
  const sent = () => window.__scMessages.at(-1) || {};
  await wait(100);
  for (const id of ['promo', 'upsell-link', 'artist-tools', 'upsell', 'studio', 'upload', 'sales', 'follow', 'mobile', 'footer']) assert(hidden(id), 'hidden: ' + id);
  for (const id of ['protected', 'consent', 'player', 'notice', 'new-tracks', 'main-nav']) assert(!hidden(id), 'kept: ' + id);
  assert(hidden(spinner('idle')) && !hidden(spinner('active')), 'only spinners inside hidden play buttons stop rendering');
  assert(byId('more').previousElementSibling === host(), 'gear sits left of the more menu');
  assert(!client.diagnostics().settings_built && !shadow().getElementById('panel'), 'settings panel deferred');
  assert(document.querySelectorAll('link[rel="preconnect"]').length === 3, 'three first-party preconnects');

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
  shadow().getElementById('compact').click();
  assert(sent().compact === true && Object.keys(sent()).length === 4, 'mini player sent as one bounded settings object');
  assert(document.documentElement.hasAttribute('data-sc-mini') && host().parentElement === byId('elements'), 'mini player moves the button into the bar');
  assert(hidden(document.querySelector('header')) && !hidden('player') && shadow().getElementById('panel').hidden, 'mini player shows only the bar');
  assert(hidden(shadow().getElementById('open')) && !hidden(shadow().getElementById('expand')), 'mini player offers expand');
  shadow().getElementById('expand').click();
  assert(sent().compact === false && byId('more').previousElementSibling === host(), 'expand restores the full window');

  client.update({cleanup: false, efficiency: false});
  assert(!hidden('promo') && !hidden('upsell') && !hidden('follow') && !hidden(spinner('idle')), 'toggles restore content');
  client.update({cleanup: true, efficiency: true});
  assert(hidden('promo') && hidden('follow') && hidden(spinner('idle')), 're-enable');
  return 'ok';
})()`;

const narrowChecks = `(() => {
  const style = id => getComputedStyle(document.getElementById(id));
  if (style('sidebar').display !== 'none') throw new Error('narrow windows drop the sidebar');
  if (style('main').marginRight !== '0px' || style('main').width === '568px') throw new Error('main column flows');
  return 'ok';
})()`;

test('cleans up, places settings and runs the mini player in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  const fixture = script.replace(/location\.protocol !== 'https:' \|\|\s*!\['soundcloud\.com', 'www\.soundcloud\.com'\]\.includes\(location\.hostname\)/, 'false');
  assert.notEqual(fixture, script, 'origin guard replaced in the fixture copy only');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'golow-test-'));
  const browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank']);
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    await cdp('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
    await evaluate(`document.open();document.write(${JSON.stringify(html)});document.close();`);
    await evaluate('window.__scMessages=[];window.ipc={postMessage:s=>window.__scMessages.push(JSON.parse(s))};');
    await evaluate(fixture);
    assert.equal(await evaluate(checks), 'ok');
    await cdp('Emulation.setDeviceMetricsOverride', {width: 700, height: 800, deviceScaleFactor: 1, mobile: false});
    assert.equal(await evaluate(narrowChecks), 'ok');
    ws.close();
  } finally {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await exited;
    // Edge helpers can hold the temporary profile briefly after the browser exits.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); } catch {}
  }
});
