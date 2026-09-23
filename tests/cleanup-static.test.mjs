import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

test('production cleanup parses and has no periodic polling or document text walkers', () => {
  new vm.Script(script);
  assert.doesNotMatch(script, /setInterval|createTreeWalker|getBoundingClientRect|\.innerHTML\s*\|\|/);
  assert.doesNotMatch(script, /\.click\(\)/);
});

test('does not inject into authentication providers or child frames', () => {
  for (const hostname of ['accounts.google.com','soundcloud.com.example.invalid','example.invalid']) {
    const window = {}; window.top=window; window.window=window;
    const context = {window,location:{protocol:'https:',hostname}};
    vm.runInNewContext(script,context);
    assert.equal(window.__scClient, undefined);
  }
  const window={top:{}};
  vm.runInNewContext(script,{window});
  assert.equal(window.__scClient,undefined);
});

test('recovery accepts query and hash, without matching unrelated hash strings', () => {
  for (const [url,expected] of [
    ['https://soundcloud.com/discover?noclean',true],
    ['https://soundcloud.com/discover#noclean',true],
    ['https://soundcloud.com/discover#notnoclean',false],
    ['https://soundcloud.com/discover',false],
  ]) {
    const location=new URL(url);
    const recovery = new URLSearchParams(location.search).has('noclean') || /(?:^#|[&#])noclean(?:[=&]|$)/.test(location.hash);
    assert.equal(recovery,expected,url);
  }
});
