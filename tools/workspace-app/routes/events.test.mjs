// Tests for routes/events.mjs (GET /api/events, the live update stream, SPEC 5.10) over real HTTP:
// the sign-in check, retry first, one `id:`/`data:` block per signal, at most 4 streams (429),
// unsubscribing on close, pings, and that open streams never make the app busy (R21).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { createApp, mergeRoutes } from '../app.mjs';
import { createSignalHub } from '../runs/events.mjs';
import { MAX_STREAMS, routes, signalText } from './events.mjs';
import { removeTree, tempDir, waitFor } from '../test/helpers.mjs';

const TOKEN = 'events-token';
let base, server, port, cookie, app, manager;

// Opens a stream; resolves once the headers are in, with { status, res, text(), close() }.
function open(path = '/api/events', { auth = true, onPort = port } = {}) {
  return new Promise((resolveP, reject) => {
    const headers = { Host: `127.0.0.1:${onPort}` };
    if (auth && cookie) headers.Cookie = cookie;
    const req = request({ host: '127.0.0.1', port: onPort, path, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('error', () => {});
      resolveP({ status: res.statusCode, headers: res.headers, res, text: () => text, close: () => { req.destroy(); res.destroy(); } });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  base = tempDir('ws-events-');
  app = createApp({ root: join(base, 'hub'), token: TOKEN, actions: {}, getPort: () => port, dataDir: join(base, 'data') });
  server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const signIn = await open(`/?t=${TOKEN}`, { auth: false });
  cookie = signIn.headers['set-cookie'][0].split(';')[0];
  signIn.close();
  manager = await app.getEngine();
});

after(async () => {
  await manager.shutdown();
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  removeTree(base);
});

test('a stream starts with retry and carries one id/data block per signal; data is only run, project, seq, status', async () => {
  assert.equal((await open('/api/events', { auth: false })).status, 403, 'the sign-in cookie is needed');
  const s = await open();
  assert.equal(s.status, 200);
  assert.match(s.headers['content-type'], /^text\/event-stream/);
  assert.equal(s.headers['cache-control'], 'no-store');
  await waitFor(() => s.text().startsWith('retry: 3000\n\n'));
  await waitFor(() => manager.signals.count() === 1);
  const sig = manager.signals.emit({ run: '261022-100001-explain-x', project: 'example', seq: 4, status: 'running' });
  await waitFor(() => s.text().includes('data:'));
  assert.equal(s.text(), `retry: 3000\n\nid: ${sig.id}\ndata: {"run":"261022-100001-explain-x","project":"example","seq":4,"status":"running"}\n\n`);
  assert.equal(app.isBusy(), false, 'an open stream is not work in progress (R21)');
  s.close();
  await waitFor(() => manager.signals.count() === 0, 2000);
});

test('at most 4 streams; the fifth gets 429; closing one frees a place', async () => {
  const streams = [];
  for (let i = 0; i < MAX_STREAMS; i++) streams.push(await open());
  assert.deepEqual(streams.map(s => s.status), [200, 200, 200, 200]);
  await waitFor(() => manager.signals.count() === MAX_STREAMS);
  const fifth = await open();
  assert.equal(fifth.status, 429);
  await waitFor(() => fifth.text().length > 0);
  assert.match(JSON.parse(fifth.text()).error, /At most 4 live update streams/);
  streams[0].close();
  await waitFor(() => manager.signals.count() === MAX_STREAMS - 1, 2000);
  const again = await open();
  assert.equal(again.status, 200);
  for (const s of [...streams.slice(1), again]) s.close();
  await waitFor(() => manager.signals.count() === 0, 2000);
});

test('pings keep a quiet stream alive; the timer stops with the stream', async t => {
  const hub = createSignalHub();
  let asked = 0;
  const table = mergeRoutes([routes({ getEngine: async () => { asked++; return { signals: hub }; } }, { pingMs: 40, maxStreams: 1 })]);
  assert.equal(asked, 0, 'routes(ctx) never asks for the engine');
  const srv = createServer((req, res) => table[`GET ${req.url}`](req, res).catch(e => { res.writeHead(e.status || 500); res.end(e.message); }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }));
  const s = await open('/api/events', { auth: false, onPort: srv.address().port });
  await waitFor(() => (s.text().match(/: ping\n\n/g) || []).length >= 2, 2000);
  assert.equal((await open('/api/events', { auth: false, onPort: srv.address().port })).status, 429);
  s.close();
  await waitFor(() => hub.count() === 0, 2000);
  const len = s.text().length;
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.text().length, len, 'nothing is written after the close');
});

test('signalText: the SSE block of one signal', () => {
  assert.equal(signalText({ id: 7, run: 'r', project: 'p', seq: null, status: 'waiting' }), 'id: 7\ndata: {"run":"r","project":"p","seq":null,"status":"waiting"}\n\n');
  assert.equal(signalText({ id: 1, extra: 'x' }), 'id: 1\ndata: {"run":null,"project":null,"seq":null,"status":null}\n\n');
});
