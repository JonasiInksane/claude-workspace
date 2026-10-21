// Tests for the workspace app's HTTP handler (tools/workspace-app/app.mjs), over real HTTP on a
// free port, with a throwaway workspace and a fake `actions` object that records calls instead
// of starting programs. Run: node --test "tools/**/*.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.mjs';
import { localDate } from './uploads.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const TOKEN = 'test-token-123';
let root, server, port, calls, cookie;

function put(rel, text) {
  const f = join(root, ...rel.split('/'));
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

function call(method, path, { headers = {}, body, auth = true, post = method === 'POST' } = {}) {
  const h = { Host: `127.0.0.1:${port}`, ...headers };
  if (auth && cookie) h.Cookie = cookie;
  if (post) Object.assign(h, { Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1' }, headers);
  const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  if (data && !h['Content-Type']) h['Content-Type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
  return new Promise((resolveP, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
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
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ws-app-'));
  put('projects/Tattoo/CLAUDE.md', '# Tattoo');
  put('projects/Tattoo/.claude/agents/art.md', '---\nname: art\ndescription: "Draws: things"\nmemory: project\n---\nBody\n');
  put('projects/Tattoo/.claude/agent-memory/art/MEMORY.md', '- [Palette](palette.md): warm colours');
  put('projects/Tattoo/.claude/agent-memory/art/palette.md', 'orange and cream');
  put('projects/Tattoo/.claude/agents/plain.md', '---\nname: plain\ndescription: p\n---\n');
  put('projects/Tattoo/secret.png', 'x');
  mkdirSync(join(root, 'projects', 'we;ird'), { recursive: true });
  put('reports/reports.json', JSON.stringify({ reports: [
    { id: 'r1', title: 'Audit', type: 'audit', status: 'active', updated: '2026-10-20', folder: 'reports/r1' },
    { id: 'evil', title: 'Evil', type: 'x', status: 'active', updated: '2026-10-19', folder: '../outside' },
    { id: 'old', title: 'Old', type: 'x', status: 'done', updated: '2026-10-01' },
    { id: 'file', title: 'A file', type: 'x', status: 'done', updated: '2026-10-01', folder: 'reports/r1/report.md' },
  ] }));
  put('reports/r1/report.md', '# Audit');
  put('inbox/idea.md', 'idea');
  put('inbox/attachments/_hub/2026-10-21/shot.png', PNG);

  calls = [];
  const rec = name => async args => { calls.push({ name, ...args }); };
  const actions = {
    tools: { wt: 'wt.exe', claude: 'claude.exe', edge: '', editor: { name: 'Cursor' } },
    startClaude: rec('startClaude'), startAgent: rec('startAgent'), openFolder: rec('openFolder'),
    openEditor: rec('openEditor'), openNavigator: rec('openNavigator'), openWindow: rec('openWindow'),
  };
  server = createServer(createApp({ root, token: TOKEN, actions, workspaceTag: 'tag123', getPort: () => port }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test('sign-in: wrong host, missing cookie and wrong token are refused; the token sets a strict cookie', async () => {
  for (const host of [`evil.example:${port}`, `127.0.0.1:${port}.`, `127.0.0.1.:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `[::1]:${port}`]) {
    assert.equal((await call('GET', '/health', { headers: { Host: host }, auth: false })).status, 403, host);
  }
  assert.equal((await call('GET', '/health', { headers: { Host: `LOCALHOST:${port}` }, auth: false })).status, 200);
  const health = (await call('GET', '/health', { auth: false })).json;
  assert.deepEqual(health, { ok: true, app: 'claude-workspace-app', workspace: 'tag123' });
  assert.equal((await call('GET', '/api/state', { auth: false })).status, 403);
  assert.equal((await call('GET', '/?t=wrong', { auth: false })).status, 403);
  const r = await call('GET', `/?t=${TOKEN}`, { auth: false });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  const set = r.headers['set-cookie'][0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
});

test('POST needs the same origin and the app header', async () => {
  assert.equal((await call('POST', '/api/ping', { post: false })).status, 403);
  assert.equal((await call('POST', '/api/ping', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/ping', { headers: { Origin: 'null' } })).status, 403);
  // A plain form post from another page has no app header.
  assert.equal((await call('POST', '/api/ping', { post: false, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'text/plain' } })).status, 403);
  assert.equal((await call('POST', '/api/ping')).json.ok, true);
});

test('a cookie from another port is not accepted', async () => {
  const other = cookie.replace(`wsapp_${port}=`, `wsapp_${port + 1}=`);
  assert.equal((await call('GET', '/api/state', { auth: false, headers: { Cookie: other } })).status, 403);
});

test('JSON bodies over 64 KB get a 413, also without Content-Length', async () => {
  const big = { project: 'Tattoo', agent: 'x', role: 'r'.repeat(70 * 1024) };
  const r = await call('POST', '/api/agents', { body: big });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /64 KB/);
  const chunked = await new Promise((resolveP, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/agents',
      headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1', 'Transfer-Encoding': 'chunked' },
    }, res => { res.resume(); res.on('end', () => resolveP(res.statusCode)); });
    req.on('error', reject);
    for (let i = 0; i < 80; i++) req.write('x'.repeat(1024));
    req.end();
  });
  assert.equal(chunked, 413);
});

test('state lists projects, agents, active reports and the inbox', async () => {
  const s = (await call('GET', '/api/state')).json;
  const tattoo = s.projects.find(p => p.name === 'Tattoo');
  assert.equal(tattoo.hasClaudeMd, true);
  assert.equal(tattoo.launchable, true);
  assert.deepEqual(tattoo.agents.map(a => [a.name, a.isolated, a.memoryFiles]), [['art', true, 2], ['plain', false, 0]]);
  assert.equal(tattoo.agents[0].description, 'Draws: things');
  assert.equal(s.projects.find(p => p.name === 'we;ird').launchable, false);
  assert.deepEqual(s.reports.map(r => r.id), ['r1', 'evil']);
  assert.equal(s.inbox.total, 2);
  assert.equal(s.tools.editor, 'Cursor');
});

test('uploads go to the chosen agent folder; non-images, unknown agents and huge files are refused', async () => {
  const ok = await call('POST', '/api/upload?project=tattoo&agent=art&name=ref.png', { body: PNG });
  assert.equal(ok.status, 200, ok.buf.toString());
  assert.equal(ok.json.path, `inbox/attachments/Tattoo/art/${localDate()}/ref.png`);
  assert.ok(existsSync(join(root, 'inbox', 'attachments', 'Tattoo', 'art', localDate(), 'ref.png')));

  assert.equal((await call('POST', '/api/upload?hub=1&name=x.svg', { body: Buffer.from('<svg onload="alert(1)"></svg>') })).status, 415);
  assert.equal((await call('POST', '/api/upload?project=Tattoo&agent=ghost', { body: PNG })).status, 404);
  assert.equal((await call('POST', '/api/upload?project=Tattoo&agent=..%2F..%2Fx', { body: PNG })).status, 404);
  const big = Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)]);
  assert.equal((await call('POST', '/api/upload?hub=1', { body: big })).status, 413);
});

test('images are listed per target and served only from the inbox, sandboxed', async () => {
  const list = (await call('GET', '/api/images?project=Tattoo&agent=art')).json;
  assert.equal(list.images.length, 1);
  const img = await call('GET', `/img?path=${encodeURIComponent(list.images[0].path)}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(img.headers['content-security-policy'], /sandbox/);
  mkdirSync(join(root, 'inbox', 'folder.png'), { recursive: true });
  for (const bad of ['projects/Tattoo/secret.png', 'inbox/../projects/Tattoo/secret.png', 'inbox/idea.md', '../outside.png', 'inbox/folder.png', 'inbox']) {
    assert.equal((await call('GET', `/img?path=${encodeURIComponent(bad)}`)).status, 404, bad);
  }
});

test('memory shows MEMORY.md first, only for real agents', async () => {
  const m = (await call('GET', '/api/memory?project=Tattoo&agent=art')).json;
  assert.deepEqual(m.files.map(f => f.name), ['MEMORY.md', 'palette.md']);
  assert.equal(m.files[1].content, 'orange and cream');
  assert.equal((await call('GET', '/api/memory?project=Tattoo&agent=..%2Fart')).status, 404);
  // No memory of its own: nothing to show, and no folder gets created for it.
  assert.equal((await call('GET', '/api/memory?project=Tattoo&agent=plain')).status, 400);
  assert.equal((await call('POST', '/api/open', { body: { place: 'memory', project: 'Tattoo', agent: 'plain' } })).status, 400);
  assert.ok(!existsSync(join(root, 'projects', 'Tattoo', '.claude', 'agent-memory', 'plain')));
});

test('launch starts the hub, projects and isolated agents, and refuses the rest', async () => {
  calls.length = 0;
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'hub', continueLast: true } })).status, 200);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'project', project: 'tattoo' } })).status, 200);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'agent', project: 'Tattoo', agent: 'art' } })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.dir || c.project, c.agent || '', !!c.continueLast]), [
    ['startClaude', root, '', true],
    ['startClaude', join(root, 'projects', 'Tattoo'), '', false],
    ['startAgent', 'Tattoo', 'art', false],
  ]);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'agent', project: 'Tattoo', agent: 'plain' } })).status, 400);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'agent', project: 'Tattoo', agent: 'ghost' } })).status, 404);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'project', project: 'we;ird' } })).status, 400);
  assert.equal((await call('POST', '/api/launch', { body: { kind: 'nope' } })).status, 400);
});

test('open stays inside the workspace', async () => {
  calls.length = 0;
  assert.equal((await call('POST', '/api/open', { body: { place: 'report', report: 'r1' } })).status, 200);
  assert.equal((await call('POST', '/api/open', { body: { place: 'report', report: 'evil' } })).status, 404);
  assert.equal((await call('POST', '/api/open', { body: { place: 'report', report: 'file' } })).status, 404);
  assert.equal((await call('POST', '/api/open', { body: { place: 'images', project: 'Tattoo', agent: '_shared' } })).status, 200);
  assert.equal((await call('POST', '/api/open', { body: { place: 'project', project: 'Tattoo', with: 'editor' } })).status, 200);
  assert.equal((await call('POST', '/api/open', { body: { place: 'inbox', with: 'editor' } })).status, 400);
  assert.deepEqual(calls.map(c => [c.name, c.dir]), [
    ['openFolder', join(root, 'reports', 'r1')],
    ['openFolder', join(root, 'inbox', 'attachments', 'Tattoo', '_shared')],
    ['openEditor', join(root, 'projects', 'Tattoo')],
  ]);
});

test('new agents are made by tools/new-agent.mjs, with its checks', async () => {
  const ok = await call('POST', '/api/agents', { body: { project: 'Tattoo', agent: 'sound', role: 'Makes sound effects.' } });
  assert.equal(ok.status, 200, ok.buf.toString());
  assert.match(readFileSync(join(root, 'projects', 'Tattoo', '.claude', 'agents', 'sound.md'), 'utf8'), /memory: project/);
  const bad = await call('POST', '/api/agents', { body: { project: 'Tattoo', agent: 'Sound FX' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /kebab-case/);
  assert.equal((await call('POST', '/api/agents', { body: { project: 'Tattoo', agent: 'art' } })).status, 400);
  // Option-like names never reach new-agent as options (it would print help and "succeed").
  for (const agent of ['-h', '--help', '--root=x', '']) {
    assert.equal((await call('POST', '/api/agents', { body: { project: 'Tattoo', agent } })).status, 400, agent);
  }
  const roleFlag = await call('POST', '/api/agents', { body: { project: 'Tattoo', agent: 'flags', role: '--help' } });
  assert.equal(roleFlag.status, 200, roleFlag.buf.toString());
  assert.match(readFileSync(join(root, 'projects', 'Tattoo', '.claude', 'agents', 'flags.md'), 'utf8'), /--help/);
});
