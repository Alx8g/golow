import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/page/70-library.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function compare('), source.indexOf('function csv('));
function compare(likes, api) {
  const context = vm.createContext({api, previous: {likes, playlists: []}, latest: {likes: [], playlists: []}});
  vm.runInContext(code, context);
  return vm.runInContext('compare(previous, latest)', context);
}

test('all removed tracks are checked in batches beyond the first 500', async () => {
  const batches = [];
  const result = await compare(Array.from({length: 551}, (_, id) => ({id})), async (_, {ids}) => {
    const tracks = ids.split(',').map(id => ({id: Number(id)}));
    batches.push(tracks.length);
    return tracks;
  });
  assert.equal(batches.length, 12);
  assert.ok(batches.every(size => size <= 50));
  assert.ok(result.every(t => t.gone === false));
});

test('failed or malformed batches remain unknown, while other batches are checked', async () => {
  for (const fail of [() => { throw new Error('offline'); }, () => null, () => ({})]) {
    let calls = 0;
    const result = await compare(Array.from({length: 51}, (_, id) => ({id})), async () => ++calls === 1 ? fail() : []);
    assert.ok(result.slice(0, 50).every(t => t.gone === null));
    assert.equal(result[50].gone, true);
  }
});

test('empty comparisons make no requests; a successful empty lookup means gone', async () => {
  assert.equal((await compare([], () => assert.fail('no missing tracks'))).length, 0);
  assert.equal((await compare([{id: 1}], async () => []))[0].gone, true);
});
