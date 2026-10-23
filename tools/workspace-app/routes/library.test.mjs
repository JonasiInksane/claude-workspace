// Tests for routes/library.mjs and the /library-file route in app.mjs: uploads (a new asset, a
// new version), the listing, one asset, meta, archive and resolve, each with its refusals; then
// the real app over HTTP for /library-file (types, nosniff, the sandbox CSP, sign-in, listed
// versions only) and an upload through the app's POST checks. The hub is a temporary one with the
// synthetic projects "example" and "other" (no git repo is needed).
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../app.mjs';
import { writeFiles } from '../test/helpers.mjs';
import { call, routeHub } from '../test/fixtures/routes/hub.mjs';
import { routes } from './library.mjs';

const MB = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

async function setup(t) {
  const h = await routeHub(t, { present: false, profile: null });
  writeFiles(h.root, { 'projects/example/README.md': '# example\n', 'projects/other/README.md': '# other\n' });
  return { ...h, api: routes(h.ctx) };
}

// POST /api/library/upload as app.mjs calls it: the raw bytes as the body, the rest in the query.
// `length` sets the content-length header (a large one is refused before the body is read).
async function upload(api, query, buf, { length = buf.length } = {}) {
  const url = new URL('http://127.0.0.1/api/library/upload');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const req = Object.assign(Readable.from([buf]), { headers: { 'content-length': String(length) } });
  try {
    return { status: 200, body: await api['POST /api/library/upload'](req, null, url) };
  } catch (e) {
    return { status: e.status || 500, body: { ok: false, error: e.message } };
  }
}

test('an upload makes a new asset; the listing shows it and GET /api/library/asset has every version', async t => {
  const { api, root } = await setup(t);
  const r = await upload(api, { scope: 'shared', title: 'Style guide', name: 'guide.md', tags: 'brand, ui', description: 'How we write', note: 'v1' }, Buffer.from('# Style\n'));
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.ok, r.body.ref, r.body.version, r.body.added], [true, 'shared:style-guide', 1, true]);
  assert.ok(existsSync(join(root, 'inbox', 'attachments', '_assets', 'style-guide', 'v1.md')));
  const p = await upload(api, { scope: 'project', project: 'example', title: 'Logo', kind: 'image', name: 'logo.png' }, PNG);
  assert.deepEqual([p.status, p.body.ref], [200, 'example:logo']);
  const list = await call(api, 'GET /api/library', { query: { project: 'example' } });
  assert.equal(list.status, 200, list.body.error);
  assert.deepEqual(list.body.assets.map(a => [a.ref, a.kind, a.tags]), [['shared:style-guide', 'text', ['brand', 'ui']], ['example:logo', 'image', []]]);
  assert.deepEqual((await call(api, 'GET /api/library')).body.assets.map(a => a.ref), ['shared:style-guide', 'example:logo']);
  assert.deepEqual((await call(api, 'GET /api/library', { query: { project: 'other' } })).body.assets.map(a => a.ref), ['shared:style-guide']);
  const one = await call(api, 'GET /api/library/asset', { query: { ref: 'shared:style-guide' } });
  assert.equal(one.status, 200, one.body.error);
  const a = one.body.asset;
  assert.deepEqual([a.title, a.description, a.versions.length, a.versions[0].note, a.versions[0].originalName], ['Style guide', 'How we write', 1, 'v1', 'guide.md']);
  assert.equal((await call(api, 'GET /api/library', { query: { project: 'ghost' } })).status, 404);
  assert.equal((await call(api, 'GET /api/library/asset', { query: { ref: 'shared:nope' } })).status, 404);
  assert.equal((await call(api, 'GET /api/library/asset')).status, 400);
});

test('an upload with ref and expect adds a version; a stale expect is a 409; the same file again adds nothing', async t => {
  const { api } = await setup(t);
  const { ref } = (await upload(api, { scope: 'shared', title: 'Guide', name: 'guide.md' }, Buffer.from('one'))).body;
  const two = await upload(api, { ref, expect: 1, name: 'guide.md', note: 'tighter' }, Buffer.from('two'));
  assert.equal(two.status, 200, two.body.error);
  assert.deepEqual([two.body.ref, two.body.version, two.body.added, two.body.asset.versionCount], [ref, 2, true, 2]);
  const same = await upload(api, { ref, expect: 2 }, Buffer.from('two'));
  assert.deepEqual([same.status, same.body.version, same.body.added], [200, 2, false]);
  const stale = await upload(api, { ref, expect: 1 }, Buffer.from('three'));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /has 2 versions now, not 1/);
  assert.equal((await upload(api, { ref }, Buffer.from('three'))).status, 400, 'expect is required');
  const renamed = await upload(api, { ref, expect: 2, title: 'Renamed' }, Buffer.from('three'));
  assert.equal(renamed.status, 400);
  assert.match(renamed.body.error, /POST \/api\/library\/meta/);
  assert.equal((await upload(api, { ref, expect: 2, title: '', scope: 'shared' }, Buffer.from('three'))).status, 200, 'empty create-only fields are fine');
  assert.equal((await upload(api, { ref: 'shared:nope', expect: 1 }, Buffer.from('x'))).status, 404);
  assert.deepEqual((await call(api, 'GET /api/library/asset', { query: { ref } })).body.asset.versions.map(v => v.n), [1, 2, 3]);
});

test('uploads are refused for a wrong kind, SVG, too large, empty, bad refs and ../ in any part; nothing is written', async t => {
  const { api, root } = await setup(t);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const cases = [
    [{ scope: 'shared', title: 'x', kind: 'pdf', name: 'notes.md' }, Buffer.from('# notes'), 415],
    [{ scope: 'shared', title: 'x', kind: 'image' }, Buffer.from('text'), 415],
    [{ scope: 'shared', title: 'x', name: 'logo.svg' }, svg, 415],
    [{ scope: 'shared', title: 'x' }, svg, 415],
    [{ scope: 'shared', title: 'x', name: 'logo.png' }, svg, 415],
    [{ scope: 'shared', title: 'x', name: 'page.html' }, Buffer.from('<p>x</p>'), 415],
    [{ scope: 'shared', title: 'x', name: 'big.md' }, Buffer.alloc(2 * MB + 1, 0x61), 413],
    [{ scope: 'shared', title: 'x' }, Buffer.concat([PNG, Buffer.alloc(25 * MB + 1 - PNG.length)]), 413],
    [{ scope: 'shared', title: 'x' }, Buffer.alloc(0), 400],
    [{ scope: 'shared' }, PNG, 400],
    [{ scope: 'shared', title: 'x', kind: 'svg' }, PNG, 400],
    [{ scope: 'everyone', title: 'x' }, PNG, 400],
    [{ scope: 'project', title: 'x' }, PNG, 400],
    [{ scope: 'project', project: '../example', title: 'x' }, PNG, 404],
    [{ scope: 'project', project: '..\\example', title: 'x' }, PNG, 404],
    [{ scope: 'project', project: 'example/../other', title: 'x' }, PNG, 404],
    [{ scope: 'project', project: 'ghost', title: 'x' }, PNG, 404],
    [{ ref: 'shared:../x', expect: 1 }, PNG, 400],
    [{ ref: 'shared:..%2Fx', expect: 1 }, PNG, 400],
    [{ ref: '../example:x', expect: 1 }, PNG, 404],
    [{ ref: 'example:..', expect: 1 }, PNG, 400],
    [{ ref: 'shared', expect: 1 }, PNG, 400],
  ];
  for (const [query, buf, status] of cases) {
    const r = await upload(api, query, buf);
    assert.equal(r.status, status, `${JSON.stringify(query)}: ${r.body.error}`);
    assert.equal(r.body.ok, false);
  }
  // A body that says it is over 25 MB is refused before it is read.
  const early = await upload(api, { scope: 'shared', title: 'x' }, PNG, { length: 26 * MB });
  assert.deepEqual([early.status, early.body.error], [413, 'request is larger than 25 MB']);
  const sharedDir = join(root, 'inbox', 'attachments', '_assets');
  assert.ok(!existsSync(sharedDir) || readdirSync(sharedDir).length === 0, 'no asset folder was made');
  assert.ok(!existsSync(join(root, 'inbox', 'attachments', 'example')));
  assert.deepEqual((await call(api, 'GET /api/library')).body.assets, []);
});

test('meta and archive: changes with the version count, a 409 when stale, archived assets only with archived=1', async t => {
  const { api } = await setup(t);
  const { ref } = (await upload(api, { scope: 'shared', title: 'Guide' }, Buffer.from('one'))).body;
  const m = await call(api, 'POST /api/library/meta', { body: { ref, title: 'House style', description: 'All of it', tags: ['brand'], expect: 1 } });
  assert.equal(m.status, 200, m.body.error);
  assert.deepEqual([m.body.ok, m.body.asset.title, m.body.asset.id, m.body.asset.description, m.body.asset.tags], [true, 'House style', 'guide', 'All of it', ['brand']]);
  await upload(api, { ref, expect: 1 }, Buffer.from('two'));
  const stale = await call(api, 'POST /api/library/meta', { body: { ref, title: 'Old page', expect: 1 } });
  assert.equal(stale.status, 409);
  for (const [body, status] of [
    [{ ref, title: '', expect: 2 }, 400], [{ ref, expect: 2 }, 400], [{ ref, title: 'x' }, 400], [{ ref, tags: 'a,b!', expect: 2 }, 400],
    [{ ref: 'shared:../guide', title: 'x', expect: 2 }, 400], [{ ref: 'ghost:guide', title: 'x', expect: 2 }, 404],
    [[ref], 400], ['null', 400], ['{not json', 400],
  ]) {
    const r = await call(api, 'POST /api/library/meta', { body });
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.body.error}`);
  }
  assert.equal((await call(api, 'GET /api/library/asset', { query: { ref } })).body.asset.title, 'House style');
  const a = await call(api, 'POST /api/library/archive', { body: { ref, archived: true } });
  assert.deepEqual([a.status, a.body.ok, a.body.asset.archived], [200, true, true]);
  assert.deepEqual((await call(api, 'GET /api/library')).body.assets, []);
  assert.deepEqual((await call(api, 'GET /api/library', { query: { archived: '1' } })).body.assets.map(x => [x.ref, x.archived]), [[ref, true]]);
  assert.equal((await upload(api, { ref, expect: 2 }, Buffer.from('three'))).status, 409, 'no new versions while archived');
  assert.equal((await call(api, 'POST /api/library/archive', { body: { ref, archived: 'no' } })).status, 400);
  assert.equal((await call(api, 'POST /api/library/archive', { body: { ref: 'shared:nope', archived: false } })).status, 404);
  assert.equal((await call(api, 'POST /api/library/archive', { body: { ref, archived: false } })).body.asset.archived, false);
  assert.equal((await call(api, 'GET /api/library')).body.assets.length, 1);
});

test('POST /api/library/resolve: what a project\'s attachments point to; another project\'s ref is refused', async t => {
  const { api } = await setup(t);
  const guide = (await upload(api, { scope: 'shared', title: 'Guide', name: 'guide.md' }, Buffer.from('one'))).body.ref;
  const logo = (await upload(api, { scope: 'project', project: 'example', title: 'Logo' }, PNG)).body.ref;
  const map = (await upload(api, { scope: 'project', project: 'other', title: 'Map' }, PNG)).body.ref;
  const r = await call(api, 'POST /api/library/resolve', {
    body: { project: 'example', attachments: [{ ref: guide, pin: null }, { ref: logo, pin: 1 }, { ref: 'shared:gone' }] },
  });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.items.map(i => [i.ref, i.version, i.kind, !!i.missing]), [[guide, 1, 'text', false], [logo, 1, 'image', false], ['shared:gone', null, null, true]]);
  assert.equal(r.body.items[0].rel, 'inbox/attachments/_assets/guide/v1.md');
  const other = await call(api, 'POST /api/library/resolve', { body: { project: 'example', attachments: [{ ref: guide }, { ref: map }] } });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /other:map belongs to projects\/other/);
  assert.equal((await call(api, 'POST /api/library/resolve', { body: { attachments: [{ ref: logo }] } })).status, 400, 'without a project, only shared assets');
  assert.equal((await call(api, 'POST /api/library/resolve', { body: { project: 'example', attachments: 'shared:guide' } })).status, 400);
  assert.equal((await call(api, 'POST /api/library/resolve', { body: { project: 'example', attachments: [{ ref: '../example:logo' }] } })).status, 404);
  assert.equal((await call(api, 'POST /api/library/resolve', { body: { project: 'ghost', attachments: [] } })).status, 404);
});

// The real app on a free port. The sign-in cookie is the token itself, as app.mjs sets it.
async function startApp(t, h) {
  const token = 'library-test-token';
  let port = 0;
  const server = createServer(createApp({ root: h.root, token, actions: h.ctx.actions, getPort: () => port, dataDir: h.dataDir }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (method, path, { body, signedIn = true, headers = {} } = {}) => new Promise((resolveP, reject) => {
    const head = { Host: `127.0.0.1:${port}`, ...(signedIn ? { Cookie: `wsapp_${port}=${token}` } : {}) };
    if (method === 'POST') Object.assign(head, { Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1' });
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...head, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolveP({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('GET /library-file in the app: the stored type, text as text/plain, nosniff and a sandbox CSP; signed in only; listed versions only', async t => {
  const h = await setup(t);
  const http = await startApp(t, h);
  const md = Buffer.from('# <b>Guide</b><script>alert(1)</script>\n');
  const up = await http('POST', `/api/library/upload?scope=shared&title=${encodeURIComponent('Style guide')}&name=guide.md`, { body: md });
  assert.equal(up.status, 200, up.buf.toString());
  assert.equal(up.json.ref, 'shared:style-guide');
  assert.equal((await http('POST', '/api/library/upload?scope=project&project=example&title=Logo', { body: PNG })).json.ref, 'example:logo');
  const text = await http('GET', '/library-file?ref=shared%3Astyle-guide&v=1');
  assert.equal(text.status, 200, text.buf.toString());
  assert.equal(text.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(text.headers['x-content-type-options'], 'nosniff');
  assert.equal(text.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(text.headers['content-disposition'], undefined);
  assert.deepEqual(text.buf, md);
  const img = await http('GET', '/library-file?ref=example:logo&v=1');
  assert.deepEqual([img.status, img.headers['content-type'], img.headers['content-security-policy']], [200, 'image/png', "default-src 'none'; sandbox"]);
  assert.deepEqual(img.buf, PNG);
  const saved = await http('GET', '/library-file?ref=example:logo&v=1&download=1');
  assert.equal(saved.headers['content-disposition'], 'attachment; filename="logo-v1.png"');
  for (const [path, status] of [
    ['/library-file?ref=shared:style-guide&v=2', 404], ['/library-file?ref=shared:style-guide', 400],
    ['/library-file?ref=shared:style-guide&v=..%2F..%2Fsecret', 400], ['/library-file?ref=shared:..%2F..%2Fx&v=1', 400],
    ['/library-file?ref=..%2Fexample:logo&v=1', 404], ['/library-file?ref=other:logo&v=1', 404], ['/library-file?v=1', 400],
  ]) assert.equal((await http('GET', path)).status, status, path);
  assert.equal((await http('GET', '/library-file?ref=shared:style-guide&v=1', { signedIn: false })).status, 403, 'only signed in');
  assert.equal((await http('POST', '/api/library/upload?scope=shared&title=x', { body: PNG, headers: { Origin: 'http://evil.example' } })).status, 403, 'POST checks apply');
  assert.deepEqual((await http('GET', '/api/library')).json.assets.map(a => a.ref), ['shared:style-guide', 'example:logo']);
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
