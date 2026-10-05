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
const html = `<html><head></head><body><header class="header" id="header"></header><div id="app">
<div class="upsellBanner" id="promo">Try Artist Pro</div>
<div class="announcementBanner" id="ordinary">Account notice <button>Close</button></div>
<div class="upsellBanner" id="protected"><button aria-label="Play track">Play</button></div>
<div class="cookieBanner" id="consent">Choose cookies <button>Accept</button></div>
<div class="playControls" id="player"><button aria-label="Pause">Pause</button></div>
<div class="track" id="track">A song about promotions <button>Like</button></div>
<a href="/go" id="upsell-link">Go+</a>
<aside><div class="homeCreditTracker" id="artist-tools"><iframe srcdoc="Artist Tools"></iframe></div>
<article class="artistShortcutsModule" id="new-tracks"><button aria-label="Play new track">Play</button></article></aside>
<div class="playableTile" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="idle">${spinner}</div></div></div>
<div class="playableTile m-playing" data-playbutton="hover"><div class="playableTile__artwork"><div class="playableTile__playButton" id="active">${spinner}</div></div></div>
<div id="dynamic"></div></div></body></html>`;

// Each step throws with its message on failure; Runtime.evaluate reports it.
const checks = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const hidden = target => getComputedStyle(typeof target === 'string' ? document.getElementById(target) : target).display === 'none';
  const spinner = id => document.querySelector('#' + id + ' svg');
  const client = window.__scClient;
  await wait(200);
  assert(hidden('promo') && hidden('upsell-link') && hidden('artist-tools'), 'explicit promos hidden');
  for (const id of ['ordinary', 'protected', 'consent', 'player', 'track', 'new-tracks']) assert(!hidden(id), 'protected content: ' + id);
  assert(hidden(spinner('idle')) && !hidden(spinner('active')), 'only spinners inside hidden play buttons stop rendering');
  const initial = client.diagnostics();
  assert(!initial.settings_built && !document.getElementById('sc-client-settings').shadowRoot.getElementById('panel'), 'settings panel deferred');
  assert(document.querySelectorAll('link[rel="preconnect"]').length === 3, 'three first-party preconnects');
  await wait(3200);
  assert(client.diagnostics().scans === initial.scans, 'no idle polling scans');
  document.getElementById('dynamic').innerHTML = '<div class="upsellBanner" id="new-promo">New upsell</div>';
  await wait(250);
  assert(hidden('new-promo'), 'new subtree cleaned');
  client.update({cleanup: false, efficiency: false});
  assert(!hidden('promo') && !hidden('new-promo') && !hidden('artist-tools') && !hidden(spinner('idle')), 'toggles restore content');
  assert(!client.diagnostics().observer_active, 'disabled cleanup disconnects observer');
  client.update({cleanup: true, efficiency: true});
  assert(hidden('promo') && hidden('artist-tools') && !hidden('new-tracks') && hidden(spinner('idle')), 're-enable');
  client.setNativeHidden(true);
  const background = client.diagnostics();
  assert(!background.observer_active && !background.timer_active, 'background has no timer or observer');
  document.getElementById('dynamic').innerHTML = '<div class="upsellBanner" id="background-promo">Later promo</div>';
  await wait(250);
  assert(hidden('background-promo') && client.diagnostics().scans === background.scans, 'CSS hides promos without background scans');
  client.setNativeHidden(false);
  client.openSettings(true);
  const shadow = document.getElementById('sc-client-settings').shadowRoot;
  assert(!shadow.getElementById('panel').hidden, 'settings opens');
  shadow.getElementById('compact').click();
  assert(window.__scMessages.some(m => m.compact === true && Object.keys(m).length === 4), 'settings sent as one bounded object');
  shadow.getElementById('close').click();
  assert(shadow.getElementById('panel').hidden, 'settings closes');
  const before = client.diagnostics().scans;
  for (let i = 0; i < 100; i++) document.getElementById('dynamic').appendChild(document.createElement('span'));
  const fake = Object.assign(document.createElement('span'), {className: 'upsellBanner'});
  document.getElementById('player').appendChild(fake);
  await wait(250);
  assert(!client.diagnostics().timer_active && client.diagnostics().scans === before, 'irrelevant and player mutations schedule no scans');
  assert(!hidden(fake), 'player subtree never cleaned');
  document.getElementById('header').innerHTML = '<div class="announcementBanner" id="header-promo">Try Artist Pro</div>';
  await wait(250);
  assert(hidden('header-promo') && client.diagnostics().scans > before, 'header announcements cleaned by the scoped observer');
  return 'ok';
})()`;

test('cleans promotions and idle spinners in a real browser', {skip: !edge && 'Microsoft Edge not found'}, async () => {
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
    const evaluate = expression => new Promise((resolve, reject) => {
      replies.set(++id, result => result.exceptionDetails ? reject(new Error(result.exceptionDetails.exception?.description)) : resolve(result.result.value));
      ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
    });
    await evaluate(`document.open();document.write(${JSON.stringify(html)});document.close();`);
    await evaluate('window.__scMessages=[];window.ipc={postMessage:s=>window.__scMessages.push(JSON.parse(s))};');
    await evaluate(fixture);
    assert.equal(await evaluate(checks), 'ok');
    ws.close();
  } finally {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await exited;
    // Edge helpers can hold the temporary profile briefly after the browser exits.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); } catch {}
  }
});
