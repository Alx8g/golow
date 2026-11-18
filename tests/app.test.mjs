// The page side of app features: shortcuts, the phone remote, updates, accounts and window
// options. The test plays the app, answering the page's requests itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {edge, prelude, withEdge} from './harness.mjs';

const page = `<!doctype html><html><head></head><body><div id="app">
<header class="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header>
<div class="playControls"><div class="playControls__elements"><button class="playControls__play" id="play">Play</button>
<div class="playbackTimeline__timePassed"><span aria-hidden="true">0:00</span></div><div class="playbackTimeline__progressWrapper"></div>
<div class="playbackTimeline__duration"><span aria-hidden="true">3:00</span></div><div class="playControls__volume">Vol</div>
<a class="playbackSoundBadge__lightLink" href="/artist" title="Artist"></a><a class="playbackSoundBadge__titleLink" href="/artist/song" title="Song"></a></div></div>
</div></body></html>`;

const checks = `(async () => {
  ${prelude}
  const calls = name => window.__scMessages.filter(m => m.call === name);
  const answer = (name, value, error) => { const last = calls(name).at(-1); assert(last, 'the page asked for ' + name); client.reply(last.id, value, error); };
  const toasts = () => [...(overlay()?.querySelectorAll('.toast') || [])].map(t => t.textContent);

  // Shortcuts: click an action, press keys, and the app gets the new combination.
  client.event('hotkeys', {toggle: 'ok', next: 'in use'});
  client.command('panel', 'shortcuts');
  let body = overlay().getElementById('body');
  assert(body.textContent.includes('In use by another app'), 'shows which shortcuts another app holds');
  const toggle = [...body.querySelectorAll('li')].find(li => li.textContent.includes('Play or pause')).querySelector('button');
  toggle.click();
  assert(overlay().getElementById('body').textContent.includes('Press keys'), 'waits for keys');
  document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyP', key: 'P', ctrlKey: true, altKey: true, bubbles: true}));
  assert(sent().shortcuts?.toggle === 'Ctrl+Alt+P', 'records the combination: ' + JSON.stringify(sent().shortcuts));
  [...overlay().getElementById('body').querySelectorAll('li')].find(li => li.textContent.includes('Next track')).querySelector('button').click();
  document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyN', key: 'n', bubbles: true}));
  assert(sent().shortcuts?.next === undefined && toasts().some(t => t.includes('Ctrl, Alt or Win')), 'a bare key is refused');
  document.dispatchEvent(new KeyboardEvent('keydown', {code: 'Escape', key: 'Escape', bubbles: true}));

  // The phone remote draws the QR code the app sends.
  client.update({remote: true});
  client.command('panel', 'remote');
  await wait(10);
  answer('remote_info', {url: 'http://192.168.1.5:47823/0123456789abcdef0123456789abcdef', size: 2, modules: '1001'});
  await wait(10);
  body = overlay().getElementById('body');
  assert(body.querySelector('svg path')?.getAttribute('d') === 'M0 0h1v1h-1zM1 1h1v1h-1z' && body.textContent.includes('192.168.1.5'), 'QR code and address shown');
  byId('play').classList.add('playing');
  await wait(20);
  assert(calls('remote_state').at(-1)?.args.title === 'Song' && calls('remote_state').at(-1).args.playing === true, 'tells the app what the phone should show');

  // An update: offered, installed on request, then a restart.
  client.event('update', {version: '9.9.9', page: 'https://github.com/Alx8g/golow/releases/tag/v9.9.9'});
  const offer = [...overlay().querySelectorAll('.toast')].find(t => t.textContent.includes('9.9.9 is available'));
  offer.querySelector('button').click();
  await wait(10);
  answer('update_install', null);
  await wait(10);
  const ready = [...overlay().querySelectorAll('.toast')].find(t => t.textContent.includes('is installed'));
  ready.querySelector('button').click();
  assert(calls('restart').length === 1, 'restart requested');

  // Accounts list and switching.
  client.command('panel', 'accounts');
  await wait(10);
  answer('profiles', {current: '', names: ['', 'Work']});
  await wait(10);
  body = overlay().getElementById('body');
  assert(body.textContent.includes('Main account') && body.textContent.includes('Open now'), 'lists accounts');
  [...body.querySelectorAll('li')].find(li => li.textContent.includes('Work')).querySelector('button').click();
  assert(calls('switch_profile').at(-1)?.args.name === 'Work', 'switches account');

  // Mouse back goes back through SoundCloud's history.
  history.pushState({}, '', '/second');
  document.dispatchEvent(new MouseEvent('mouseup', {button: 3, bubbles: true}));
  await wait(100);
  assert(location.pathname !== '/second', 'mouse back button goes back');

  // Reduce motion.
  const style = byId('app').appendChild(Object.assign(document.createElement('div'), {style: 'transition: opacity 2s'}));
  client.openSettings(true);
  byId('sc-client-settings').shadowRoot.getElementById('reduce_motion').click();
  assert(getComputedStyle(style).transitionProperty === 'none' || getComputedStyle(style).transitionDuration === '0s', 'reduce motion stops transitions');
  return 'ok';
})()`;

test('shortcuts, phone remote, updates and accounts on the page', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  await withEdge({routes: [['/', page]]}, async ({evaluate, navigate}) => {
    await navigate('/first');
    assert.equal(await evaluate(checks), 'ok');
  });
});
