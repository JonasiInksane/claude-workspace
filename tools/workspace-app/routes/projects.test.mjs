// Tests for linking and unlinking an existing checkout (POST /api/projects/link and /unlink in
// routes/projects.mjs), and for the launches that must use a linked project's real folder
// (/api/launch, /api/open, /api/flows/run, /api/skill). The route modules are called directly
// with a fake request and an `actions` recorder, so no terminal opens and no claude starts.
// Run: node tools/run-tests.mjs workspace-app
// The hub and the scratch checkout (synthetic "example" repo) live in the temp folder; junction
// tests are skipped off Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectDir } from '../../lib/agents.mjs';
import { isLinked, samePath } from '../../lib/projects.mjs';
import * as flowRoutes from './flows.mjs';
import * as launchRoutes from './launch.mjs';
import * as projectRoutes from './projects.mjs';
import * as toolRoutes from './tools.mjs';

const WIN = process.platform === 'win32';
const winOnly = { skip: !WIN && 'junctions are Windows-only' };
const URL = 'https://github.com/example-org/example.git';

// A POST request as the route handlers read it: a stream with a content-length header.
function postReq(body) {
  const buf = Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
}

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function removeLinks(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (lstatSync(join(dir, e.name)).isSymbolicLink()) rmdirSync(join(dir, e.name));
}

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'ws-link-route-'));
  t.after(() => { removeLinks(join(base, 'hub', 'projects')); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'hub');
  put(join(root, 'projects', 'repos.json'), JSON.stringify({ repos: [{ name: 'example', url: URL, requires: [] }] }));
  const target = join(base, 'checkout', 'example');
  mkdirSync(target, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 't'], ['user.email', 't@t']]) git('config', k, v);
  git('remote', 'add', 'origin', URL);
  put(join(target, 'keep.txt'), 'keep me');
  const calls = [];
  const rec = name => async args => { calls.push({ name, ...args }); return { sessionId: '' }; };
  const actions = {
    startClaude: rec('startClaude'), startAgent: rec('startAgent'), openFolder: rec('openFolder'), openEditor: rec('openEditor'),
  };
  const ctx = { root, actions, getPort: () => 0, workspaceTag: '', dataDir: join(base, 'data') };
  const api = { ...projectRoutes.routes(ctx), ...launchRoutes.routes(ctx), ...flowRoutes.routes(ctx), ...toolRoutes.routes(ctx) };
  // { status, body }: 200 with the handler's body, or the HttpError's status and message.
  const call = async (key, body) => {
    try { return { status: 200, body: await api[key](postReq(body)) }; } catch (e) { return { status: e.status || 500, body: { ok: false, error: e.message } }; }
  };
  return { base, root, target, calls, call };
}

test('POST /api/projects/link links the checkout and answers with its real path; refusals get 400, 404 or 409', winOnly, async t => {
  const { base, root, target, call } = setup(t);
  for (const [body, status, re] of [
    [{}, 400, /name and the folder path/],
    [{ name: 'example', path: 42 }, 400, /name and the folder path/],
    [{ name: 'Bad Name', path: target }, 400, /not a project name/],
    [{ name: 'ghost', path: target }, 404, /not in projects\/repos\.json/],
    [{ name: 'example', path: 'relative\\path' }, 400, /not a full path/],
    [{ name: 'example', path: join(root, 'projects') }, 400, /inside the workspace hub/],
    [{ name: 'example', path: join(base, 'missing') }, 400, /not a folder/],
  ]) {
    const r = await call('POST /api/projects/link', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.ok(!existsSync(projectDir(root, 'example')));

  const r = await call('POST /api/projects/link', { name: ' example ', path: `${target}\\` });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.project.name, 'example');
  assert.ok(samePath(r.body.project.realPath, target));
  assert.match(r.body.message, /Your checkout stays where it is/);
  assert.ok(isLinked(root, 'example'));
  const again = await call('POST /api/projects/link', { name: 'example', path: target });
  assert.equal(again.status, 409);
});

test('a linked project starts Claude, flows, skills and the editor in its real folder', winOnly, async t => {
  const { root, target, calls, call } = setup(t);
  assert.equal((await call('POST /api/projects/link', { name: 'example', path: target })).status, 200);
  put(join(root, 'flows', 'example-flow.md'), '---\ntitle: "Example flow"\ntarget: project\nproject: "example"\n---\n\nDo it.\n');
  assert.equal((await call('POST /api/launch', { kind: 'project', project: 'example' })).status, 200);
  assert.equal((await call('POST /api/flows/run', { slug: 'example-flow' })).status, 200);
  assert.equal((await call('POST /api/skill', { id: 'nextjs-feature', values: { project: 'example', feature: 'A page' } })).status, 200);
  assert.equal((await call('POST /api/open', { place: 'project', project: 'example', with: 'editor' })).status, 200);
  assert.deepEqual(calls.map(c => [c.name, c.kind || '', c.project || '']), [
    ['startClaude', 'project', 'example'], ['startClaude', 'flow', 'example'], ['startClaude', 'skill', 'example'], ['openEditor', '', ''],
  ]);
  for (const c of calls) assert.ok(samePath(c.dir || c.path, target), `${c.name}: ${c.dir || c.path}`);
  assert.ok(!samePath(target, projectDir(root, 'example')));
  // The hub keeps starting in the hub.
  calls.length = 0;
  assert.equal((await call('POST /api/launch', { kind: 'hub' })).status, 200);
  assert.deepEqual([calls[0].dir, calls[0].kind], [root, 'hub']);
});

test('POST /api/projects/unlink removes only the link; the checkout survives; real folders are refused', winOnly, async t => {
  const { base, root, target, calls, call } = setup(t);
  assert.equal((await call('POST /api/projects/link', { name: 'example', path: target })).status, 200);
  const r = await call('POST /api/projects/unlink', { name: 'example' });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.message, /Your checkout was not touched/);
  assert.ok(!isLinked(root, 'example'));
  assert.ok(!existsSync(projectDir(root, 'example')));
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(target, '.git')));
  assert.equal((await call('POST /api/projects/unlink', { name: 'example' })).status, 404);
  put(join(root, 'projects', 'game', 'notes.md'), 'mine');
  const real = await call('POST /api/projects/unlink', { name: 'game' });
  assert.equal(real.status, 400);
  assert.match(real.body.error, /real folder, not a link/);
  assert.ok(existsSync(join(root, 'projects', 'game', 'notes.md')));
  assert.equal((await call('POST /api/projects/unlink', {})).status, 400);
  assert.equal((await call('POST /api/projects/unlink', { name: '..' })).status, 400);

  // A link whose checkout is gone: launches say so (404) and start nothing; unlink still works.
  const gone = join(base, 'gone');
  mkdirSync(gone);
  symlinkSync(gone, projectDir(root, 'gone-link'), 'junction');
  rmdirSync(gone);
  calls.length = 0;
  const broken = await call('POST /api/launch', { kind: 'project', project: 'gone-link' });
  assert.ok([404].includes(broken.status), `${broken.status} ${broken.body.error}`);
  assert.equal(calls.length, 0);
  assert.equal((await call('POST /api/projects/unlink', { name: 'gone-link' })).status, 200);
});
