// Instant Home: the last Home answer is handed to SoundCloud at once on the next start, then
// refreshed in the background; another account never sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {edge, prelude, withEdge} from './harness.mjs';

// The app's file store, kept in sessionStorage so it survives the reload.
const app = `(() => {
  const files = JSON.parse(sessionStorage.getItem('files') || '{}');
  window.ipc.postMessage = text => {
    const message = JSON.parse(text);
    window.__scMessages.push(message);
    if (!('call' in message)) return;
    const {call, id, args} = message;
    if (call === 'save') { files[args.name] = args.data; sessionStorage.setItem('files', JSON.stringify(files)); }
    const value = call === 'load' ? files[args.name] ?? null : null;
    setTimeout(() => window.__scClient?.reply(id, value), 5);
  };
})();`;
const page = `<!doctype html><html><head></head><body><div id="app"><header class="header"><div class="header__right"><ul class="header__navMenu"><li>More</li></ul></div></header></div>
<script>
window.__home = new Promise(resolve => {
  const request = new XMLHttpRequest();
  request.open('GET', 'https://api-v2.soundcloud.com/mixed-selections?client_id=test&limit=10');
  request.setRequestHeader('Authorization', sessionStorage.getItem('auth') || 'OAuth one');
  request.onloadend = () => resolve({status: request.status, body: request.responseText, state: request.readyState});
  request.send();
});
</script></body></html>`;
const homeRequests = `performance.getEntriesByType('resource').filter(r => r.name.includes('mixed-selections')).length`;

test('Instant Home hands over the last answer and refreshes it', {skip: !edge && 'Microsoft Edge not found'}, async () => {
  // A signed-in request needs a CORS preflight, which DevTools cannot answer; skip CORS here.
  const args = ['--disable-web-security'];
  await withEdge({routes: [['/', page]], api: {'mixed-selections': {collection: [{kind: 'selection', title: 'Mixed for you'}]}}, inject: app, args}, async ({evaluate, navigate}) => {
    await navigate('/discover');
    const first = await evaluate('window.__home');
    assert.equal(first.status, 200);
    assert.equal(await evaluate(homeRequests), 1, 'first start goes to the network');
    for (let i = 0; i < 20 && !await evaluate(`!!JSON.parse(sessionStorage.getItem('files') || '{}')['instant-home']`); i++) await new Promise(r => setTimeout(r, 100));

    await navigate('/discover');
    const second = await evaluate('window.__home');
    assert.equal(second.status, 200);
    assert.equal(second.state, 4);
    assert.match(second.body, /Mixed for you/);
    assert.equal(await evaluate(homeRequests), 0, 'the next start is answered from the saved copy');
    await new Promise(r => setTimeout(r, 6000));
    assert.equal(await evaluate(homeRequests), 1, 'a fresh copy is fetched in the background');

    await evaluate(`sessionStorage.setItem('auth', 'OAuth two')`);
    await navigate('/discover');
    await evaluate('window.__home');
    assert.equal(await evaluate(homeRequests), 1, 'another account goes to the network');
  });
});
