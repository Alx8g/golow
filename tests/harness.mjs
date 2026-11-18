// Shared test plumbing: the page script bundled exactly as build.rs bundles it, and headless
// Microsoft Edge driven over the DevTools protocol against pages served locally. Never loads
// SoundCloud or an account.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const pageDir = new URL('../src/page/', import.meta.url);
export const script = '(() => {\n' + fs.readdirSync(pageDir).filter(name => name.endsWith('.js')).sort()
  .map(name => fs.readFileSync(new URL(name, pageDir), 'utf8') + '\n').join('') + '})();\n';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const edge = [process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));

// Keep the top-frame guard, drop the origin check: like WebView2 here, frames get no script.
export const fixture = script.replace(/location\.protocol !== 'https:' \|\|\s*!\['soundcloud\.com', 'www\.soundcloud\.com'\]\.includes\(location\.hostname\)/, 'false');

// routes: [[prefix, html]], first match wins. api: {pathPart: json} answers for api-v2 requests.
export async function withEdge({routes, api = {}}, run) {
  if (fixture === script) throw new Error('origin guard not found in the page script');
  const server = http.createServer((req, res) => res.writeHead(200, {'content-type': 'text/html'})
    .end(routes.find(([prefix]) => req.url.startsWith(prefix))?.[1] ?? routes.at(-1)[1]));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'golow-test-'));
  const browser = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank']);
  try {
    // Edge may still hold the file open while writing it, so retry until a port is readable.
    let port;
    for (let i = 0; i < 150 && !port; i++) {
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
      if (!port) await sleep(100);
    }
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => Object.assign(ws, {onopen: resolve, onerror: reject}));
    const replies = new Map();
    let id = 0;
    ws.onmessage = ({data}) => {
      const message = JSON.parse(data);
      if (message.method === 'Fetch.requestPaused') {
        const body = JSON.stringify(Object.entries(api).find(([key]) => message.params.request.url.includes(key))?.[1] || {});
        ws.send(JSON.stringify({id: ++id, method: 'Fetch.fulfillRequest', params: {requestId: message.params.requestId, responseCode: 200,
          responseHeaders: [{name: 'Content-Type', value: 'application/json'}, {name: 'Access-Control-Allow-Origin', value: '*'}],
          body: Buffer.from(body).toString('base64')}}));
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const navigate = async (to, ready = "document.readyState === 'complete'") => {
      await cdp('Page.navigate', {url: base + to});
      for (let i = 0; i < 50 && !await evaluate(ready).catch(() => false); i++) await sleep(100);
    };
    // Like WebView2, inject before any page script. The IPC stub records what the app would get.
    await cdp('Page.enable');
    // As main.rs injects it: what the page knows about the app build.
    const app = {version: '0.0.0', profile: '', lastfm: false, hotkeys: {toggle: 'Ctrl+Alt+Shift+P', next: 'Ctrl+Alt+Shift+N', previous: 'Ctrl+Alt+Shift+B',
      back: 'Ctrl+Alt+Shift+Comma', forward: 'Ctrl+Alt+Shift+Period', like: 'Ctrl+Alt+Shift+L', volume_up: 'Ctrl+Alt+Shift+Equal',
      volume_down: 'Ctrl+Alt+Shift+Minus', bookmark: 'Ctrl+Alt+Shift+K', show: 'Ctrl+Alt+Shift+S'}};
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `window.__scApp=${JSON.stringify(app)};window.__scMessages=[];window.ipc={postMessage:s=>window.__scMessages.push(JSON.parse(s))};`});
    await cdp('Page.addScriptToEvaluateOnNewDocument', {source: fixture});
    await resize(1280);
    await cdp('Fetch.enable', {patterns: [{urlPattern: 'https://api-v2.soundcloud.com/*'}]});
    await run({cdp, evaluate, resize, navigate});
    ws.close();
  } finally {
    server.close();
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, sleep(5000)]);
    // Edge helpers can hold the temporary profile briefly after the browser exits.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); } catch {}
  }
}

// In-page assertion helpers, prepended to each check script.
export const prelude = `const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const byId = id => document.getElementById(id);
  const hidden = target => getComputedStyle(typeof target === 'string' ? byId(target) : target).display === 'none';
  const sent = () => window.__scMessages.filter(m => !('call' in m)).at(-1) || {};
  const overlay = () => byId('golow-overlay')?.shadowRoot;
  const barRoot = () => byId('golow-bar')?.shadowRoot;
  const client = window.__scClient;`;
