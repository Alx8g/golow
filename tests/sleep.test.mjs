import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/page/40-player.js', import.meta.url), 'utf8');
const start = source.indexOf('const FADE =');
const timerCode = source.slice(start, source.indexOf("on('tick',", start));
function setup() {
  const waits = [], state = {pauses: 0}, el = {volume: 0.8};
  const context = vm.createContext({
    clearTimeout() {}, setTimeout: () => 1, Date, Math,
    barButton: () => null, toast() {}, media: {el}, player: {playing: true},
    commands: {toggle: () => state.pauses++},
    wait: () => new Promise(resolve => waits.push(resolve)),
  });
  vm.runInContext(timerCode, context);
  const run = code => vm.runInContext(code, context);
  return {run, waits, state, el};
}

test('cancelling or replacing a fading timer preserves playback and the replacement', async () => {
  for (const minutes of [0, 15, -1]) {
    const {run, waits, state, el} = setup();
    run('setSleep(1)');
    const fading = run('fadeOut()');
    assert.ok(el.volume < 0.8);
    run(`setSleep(${minutes})`);
    const replacement = run('sleep');
    assert.equal(el.volume, 0.8);
    waits.shift()();
    await fading;
    assert.equal(state.pauses, 0);
    assert.equal(run('sleep'), replacement);
  }
});

test('an uninterrupted fade pauses once and restores volume', async () => {
  const {run, waits, state, el} = setup();
  run('setSleep(1)');
  const fading = run('fadeOut()');
  for (let i = 0; i < 51; i++) { waits.shift()(); await new Promise(setImmediate); }
  await fading;
  assert.equal(state.pauses, 1);
  assert.equal(el.volume, 0.8);
  assert.equal(run('sleep'), null);
});

test('empty timer does nothing and manual volume changes are retained', async () => {
  const {run, waits, state, el} = setup();
  await run('fadeOut()');
  assert.equal(waits.length, 0);
  run('setSleep(1)');
  const fading = run('fadeOut()');
  el.volume = 0.4;
  waits.shift()();
  await fading;
  assert.equal(el.volume, 0.4);
  assert.equal(state.pauses, 0);
  assert.equal(run('sleep'), null);
});
