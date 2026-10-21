// Tests for the workspace app's HTTP handler (tools/workspace-app/app.mjs), over real HTTP on a
// free port, with a throwaway workspace and a fake `actions` object that records calls instead
// of starting programs. Run: node tools/run-tests.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
  const rec = (name, result) => async args => { calls.push({ name, ...args }); return result; };
  const actions = {
    tools: { wt: 'wt.exe', claude: 'claude.exe', edge: '', editor: { name: 'Cursor' } },
    startClaude: rec('startClaude'), startAgent: rec('startAgent'), openFolder: rec('openFolder'),
    openEditor: rec('openEditor'), openNavigator: rec('openNavigator'), openWindow: rec('openWindow'),
    newProject: rec('newProject'), runTool: rec('runTool', { status: 1, output: '1 error' }),
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
  assert.deepEqual(calls.map(c => [c.name, c.dir || c.path]), [
    ['openFolder', join(root, 'reports', 'r1')],
    ['openFolder', join(root, 'inbox', 'attachments', 'Tattoo', '_shared')],
    ['openEditor', join(root, 'projects', 'Tattoo')],
  ]);
});

test('an agent name used by two files is flagged and does not start', async () => {
  put('projects/Dup/.claude/agents/a.md', '---\nname: twin\ndescription: a\nmemory: project\n---\n');
  put('projects/Dup/.claude/agents/more/b.md', '---\nname: twin\ndescription: b\nmemory: project\n---\n');
  const s = (await call('GET', '/api/state')).json;
  assert.deepEqual(s.projects.find(p => p.name === 'Dup').agents.map(a => a.duplicate), [true, true]);
  assert.equal(s.projects.find(p => p.name === 'Tattoo').agents[0].duplicate, false);
  calls.length = 0;
  const r = await call('POST', '/api/launch', { body: { kind: 'agent', project: 'Dup', agent: 'twin' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /more than one agent file/);
  assert.equal(calls.length, 0);
});

test('agent files can be read and saved, but not renamed, emptied or saved over newer changes', async () => {
  put('projects/Edit/.claude/agents/writer.md', '---\r\nname: writer\r\ndescription: Writes.\r\nmemory: project\r\n---\r\nOld\r\n');
  const file = join(root, 'projects', 'Edit', '.claude', 'agents', 'writer.md');
  const got = (await call('GET', '/api/agent-file?project=Edit&agent=writer')).json;
  assert.deepEqual([got.file, got.path], ['writer.md', 'projects/Edit/.claude/agents/writer.md']);
  const text = got.text.replace(/\r\n/g, '\n').replace('Old', 'New "role"');
  const save = body => call('POST', '/api/agent-file', { body: { project: 'Edit', agent: 'writer', file: 'writer.md', ...body } });
  assert.equal((await save({ text: text.replace('name: writer', 'name: other'), hash: got.hash })).status, 400);
  assert.equal((await save({ text: text.replace('description: Writes.', 'description:'), hash: got.hash })).status, 400);
  assert.equal((await save({ text, hash: 'old' })).status, 409);
  const ok = await save({ text, hash: got.hash });
  assert.equal(ok.status, 200, ok.buf.toString());
  assert.equal(readFileSync(file, 'utf8'), '---\r\nname: writer\r\ndescription: Writes.\r\nmemory: project\r\n---\r\nNew "role"\r\n');
  const warn = await save({ text: text.replace('memory: project', 'memory: user'), hash: ok.json.hash });
  assert.equal(warn.json.warnings.length, 1);
  // Only real agent files: no paths, no other names.
  assert.equal((await call('GET', '/api/agent-file?project=Edit&agent=writer&file=..%2F..%2FCLAUDE.md')).status, 404);
  assert.equal((await call('GET', '/api/agent-file?project=Edit&agent=..%2Fwriter')).status, 404);
  calls.length = 0;
  assert.equal((await call('POST', '/api/open', { body: { place: 'agent', project: 'Edit', agent: 'writer', with: 'editor' } })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.path]), [['openEditor', file]]);
});

test('archiving moves an agent out of use, keeps its memory, and restore brings it back', async () => {
  put('projects/Arch/.claude/agents/old.md', '---\nname: old\ndescription: Old one.\nmemory: project\n---\n');
  put('projects/Arch/.claude/agent-memory/old/MEMORY.md', '- kept');
  const post = (path, body) => call('POST', path, { body: { project: 'Arch', ...body } });
  assert.equal((await post('/api/agents/archive', { agent: 'old', file: 'old.md' })).status, 200);
  let p = (await call('GET', '/api/state')).json.projects.find(x => x.name === 'Arch');
  assert.deepEqual([p.agents, p.archived.map(a => [a.archivedAs, a.name])], [[], [['old.md', 'old']]]);
  assert.ok(existsSync(join(root, 'projects', 'Arch', '.claude', 'agent-memory', 'old', 'MEMORY.md')));
  // A new agent with the archived name would inherit its memory: refused.
  const again = await post('/api/agents', { agent: 'old' });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /archived agent/);
  assert.equal((await post('/api/agents/restore', { archivedAs: '..\\old.md' })).status, 400);
  assert.equal((await post('/api/agents/restore', { archivedAs: 'old.md' })).status, 200);
  p = (await call('GET', '/api/state')).json.projects.find(x => x.name === 'Arch');
  assert.deepEqual([p.agents.map(a => a.name), p.archived], [['old'], []]);
  assert.equal((await post('/api/agents/archive', { agent: 'ghost' })).status, 404);
});

test('flows: create, edit with a hash, add images, preview and run at each target, archive and restore', async () => {
  const post = (path, body) => call('POST', path, { body });
  const made = await post('/api/flows', { title: 'Hero sprite', target: 'agent', project: 'tattoo', agent: 'art', prompt: 'Draw the "hero".' });
  assert.equal(made.status, 200, made.buf.toString());
  assert.equal(made.json.slug, 'hero-sprite');
  assert.match(readFileSync(join(root, 'flows', 'hero-sprite.md'), 'utf8'), /project: "Tattoo"/);
  assert.equal((await post('/api/flows', { title: 'X', target: 'agent', project: 'Tattoo', agent: 'plain', prompt: 'p' })).status, 400);

  // Images go straight into the flow's folder (no dated subfolder) and only for real flows.
  const up = await call('POST', '/api/upload?flow=hero-sprite&name=ref.png', { body: PNG });
  assert.equal(up.status, 200, up.buf.toString());
  assert.equal(up.json.path, 'inbox/attachments/_flows/hero-sprite/ref.png');
  assert.equal((await call('POST', '/api/upload?flow=..%2Fx', { body: PNG })).status, 404);
  // Only images directly in the folder count, as only those are passed to a run.
  put('inbox/attachments/_flows/hero-sprite/sub/deeper.png', PNG);
  assert.equal((await call('GET', '/api/images?flow=hero-sprite')).json.images.length, 1);
  const s = (await call('GET', '/api/state')).json;
  assert.deepEqual(s.flows.map(f => [f.slug, f.images, f.error]), [['hero-sprite', 1, '']]);
  assert.equal(s.inbox.items.some(i => i.path.includes('_flows')), false);

  const got = (await call('GET', '/api/flow?slug=hero-sprite')).json;
  assert.equal(got.prompt, 'Draw the "hero".');
  const edit = { slug: 'hero-sprite', title: 'Hero sprite', target: 'agent', project: 'Tattoo', agent: 'art', prompt: 'Draw the hero, side view.' };
  assert.equal((await post('/api/flows', { ...edit, hash: 'stale' })).status, 409);
  assert.equal((await post('/api/flows', { ...edit, hash: got.hash })).status, 200);

  // Launch settings and captions.
  const flowNow = (await call('GET', '/api/flow?slug=hero-sprite')).json;
  assert.deepEqual(flowNow.images.map(i => [i.name, i.path, i.caption]), [['ref.png', 'inbox/attachments/_flows/hero-sprite/ref.png', '']]);
  assert.equal((await post('/api/flows', { ...edit, hash: flowNow.hash, permissionMode: 'bypassPermissions' })).status, 400);
  assert.equal((await post('/api/flows', { ...edit, hash: flowNow.hash, permissionMode: 'plan', effort: 'high', allowedTools: 'Read, Grep' })).status, 200);
  assert.equal((await post('/api/flows/caption', { slug: 'hero-sprite', image: 'ref.png', caption: 'the hero, front view' })).status, 200);
  assert.equal((await post('/api/flows/caption', { slug: 'hero-sprite', image: '..\\secret.png', caption: 'x' })).status, 400);
  assert.equal((await call('GET', '/api/flow?slug=hero-sprite')).json.images[0].caption, 'the hero, front view');

  const imgDir = join(root, 'inbox', 'attachments', '_flows', 'hero-sprite');
  const preview = await post('/api/flows/run', { slug: 'hero-sprite', notes: 'Walk cycle', preview: true });
  assert.equal(preview.json.prompt, 'Reference images for this task. Read each one before you start:\n' +
    `- Image 1: ${join(imgDir, 'ref.png')}\n  What it shows: the hero, front view\n\n` +
    'Draw the hero, side view.\n\nNotes for this run:\nWalk cycle');
  assert.deepEqual(preview.json.launch, { permissionMode: 'plan', effort: 'high', allowedTools: ['Read', 'Grep'] });
  calls.length = 0;
  assert.equal((await post('/api/flows/run', { slug: 'hero-sprite' })).status, 200);
  assert.deepEqual(calls[0].launch, { permissionMode: 'plan', effort: 'high', allowedTools: ['Read', 'Grep'] });
  await post('/api/flows', { title: 'Hub one', target: 'hub', prompt: 'Hub work' });
  await post('/api/flows', { title: 'Project one', target: 'project', project: 'Tattoo', prompt: 'Project work' });
  assert.equal((await post('/api/flows/run', { slug: 'hub-one' })).status, 200);
  assert.equal((await post('/api/flows/run', { slug: 'project-one' })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.dir || c.project, c.agent || '', c.readDirs]), [
    ['startAgent', 'Tattoo', 'art', [imgDir]],
    ['startClaude', root, '', []],
    ['startClaude', join(root, 'projects', 'Tattoo'), '', []],
  ]);
  assert.equal((await post('/api/flows/run', { slug: 'hub-one', notes: 'n'.repeat(2001) })).status, 400);
  assert.equal((await post('/api/flows/run', { slug: 'nope' })).status, 404);

  // Checked at run time: a hand-edited project path and a flow whose agent is gone don't start.
  put('flows/sneaky.md', '---\ntitle: "Sneaky"\ntarget: project\nproject: ".."\n---\n\nGo up.\n');
  put('projects/Gone/.claude/agents/temp.md', '---\nname: temp\ndescription: Temp.\nmemory: project\n---\n');
  await post('/api/flows', { title: 'Orphan', target: 'agent', project: 'Gone', agent: 'temp', prompt: 'p' });
  assert.equal((await post('/api/agents/archive', { project: 'Gone', agent: 'temp', file: 'temp.md' })).status, 200);
  calls.length = 0;
  const sneaky = await post('/api/flows/run', { slug: 'sneaky' });
  const orphan = await post('/api/flows/run', { slug: 'orphan' });
  assert.deepEqual([sneaky.status, orphan.status], [400, 400]);
  assert.match(orphan.json.error, /no usable agent "temp"/);
  assert.equal(calls.length, 0);
  assert.equal((await post('/api/flows/archive', { slug: 'sneaky' })).status, 200);
  assert.equal((await post('/api/flows/archive', { slug: 'orphan' })).status, 200);

  assert.equal((await post('/api/flows/archive', { slug: 'hub-one' })).status, 200);
  let st = (await call('GET', '/api/state')).json;
  assert.deepEqual([st.flows.map(f => f.slug), st.archivedFlows.map(f => f.archivedAs)], [['hero-sprite', 'project-one'], ['hub-one.md', 'orphan.md', 'sneaky.md']]);
  assert.equal((await post('/api/flows/restore', { archivedAs: 'hub-one.md' })).status, 200);
  st = (await call('GET', '/api/state')).json;
  assert.equal(st.flows.length, 3);
});

test('skills start Claude with a prompt built on the server, in the hub or the project', async () => {
  calls.length = 0;
  const post = body => call('POST', '/api/skill', { body });
  assert.equal((await post({ id: 'inbox-triage' })).status, 200);
  assert.equal((await post({ id: 'project-report', values: { project: 'tattoo' } })).status, 200);
  assert.equal((await post({ id: 'capture-lesson', values: { lesson: '  Say "hi"\nthen go  ' } })).status, 200);
  assert.equal((await post({ id: 'nextjs-feature', values: { project: 'Tattoo', feature: 'A booking page' } })).status, 200);
  assert.equal((await post({ id: 'context-sweep', values: { scope: 'knowledge' } })).status, 200);
  assert.deepEqual(calls.map(c => [c.dir, c.prompt]), [
    [root, '/inbox-triage'],
    [root, '/project-report Tattoo status'],
    [root, '/capture-lesson Say "hi"\nthen go'],
    [join(root, 'projects', 'Tattoo'), '/nextjs-feature A booking page'],
    [root, '/context-sweep knowledge'],
  ]);
  calls.length = 0;
  for (const [body, status] of [
    [{ id: 'write-handoff' }, 400],
    [{ id: 'rm -rf' }, 400],
    [{ id: 'capture-lesson', values: { lesson: '   ' } }, 400],
    [{ id: 'capture-lesson', values: { lesson: 'x'.repeat(2001) } }, 400],
    [{ id: 'project-report', values: { project: 'ghost' } }, 404],
    [{ id: 'project-report', values: { project: '..' } }, 404],
    [{ id: 'project-report', values: { project: 'Tattoo', type: 'evil' } }, 400],
    [{ id: 'day-recap', values: { day: 'yesterday; rm' } }, 400],
    [{ id: 'onboard-project', values: { project: 'we;ird' } }, 400],
  ]) assert.equal((await post(body)).status, status, JSON.stringify(body));
  assert.equal(calls.length, 0);
});

test('tools run from the catalog only, and the library installs only after its preview', async () => {
  calls.length = 0;
  const run = body => call('POST', '/api/run', { body });
  const check = await run({ id: 'check' });
  assert.equal(check.status, 200);
  assert.deepEqual([check.json.status, check.json.output], [1, '1 error']);
  assert.equal((await run({ id: 'library', preview: true })).status, 200);
  assert.equal((await run({ id: 'library' })).status, 400);
  assert.equal((await run({ id: 'library', confirm: 'yes' })).status, 400);
  assert.equal((await run({ id: 'library', confirm: true })).status, 200);
  assert.equal((await run({ id: 'check', preview: true })).status, 400);
  assert.equal((await run({ id: '../../evil.mjs' })).status, 400);
  // Always the app's own tools/ folder, run in the workspace root.
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(calls.map(c => [c.name, c.cwd, ...c.args]), [
    ['runTool', root, join(toolsDir, 'check-workspace.mjs')],
    ['runTool', root, join(toolsDir, 'install-library.mjs'), '--dry-run'],
    ['runTool', root, join(toolsDir, 'install-library.mjs')],
  ]);
  const state = (await call('GET', '/api/state')).json;
  assert.ok(state.catalog.skills.some(s => s.id === 'inbox-triage'));
  assert.ok(!('args' in state.catalog.skills[0]));
});

test('new projects are checked, then made by tools/new-project.mjs in a terminal', async () => {
  calls.length = 0;
  const post = body => call('POST', '/api/projects', { body });
  assert.equal((await post({ name: 'my-game', type: 'game' })).status, 200);
  assert.equal((await post({ name: 'site', type: 'nextjs', from: 'https://github.com/me/site.git' })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.project, c.type, c.from]), [
    ['newProject', 'my-game', 'game', ''],
    ['newProject', 'site', 'nextjs', 'https://github.com/me/site.git'],
  ]);
  calls.length = 0;
  for (const body of [
    { name: 'My Game', type: 'game' },
    { name: '--help', type: 'game' },
    { name: 'tattoo', type: 'game' }, // exists (other case)
    { name: 'x', type: 'unity' },
    { name: 'x', type: 'game', from: 'https://a b' },
    { name: 'x', type: 'game', from: 'https://x/y";calc' },
    { name: 'x', type: 'game', from: 'file:///C:/secret' },
    { name: 'x', type: 'game', from: '--upload-pack=calc' },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal(calls.length, 0);
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
