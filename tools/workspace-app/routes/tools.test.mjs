// Tests for routes/tools.mjs: skills start with their launch defaults (plan mode for the ones that
// change code) and the request's overrides, checked so the unsafe modes stay refused; tools run
// through POST /api/command (the old POST /api/run is gone). The route module is called directly
// with an `actions` recorder, so no terminal opens and no tool runs.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogForUi, skillLaunch } from '../catalog.mjs';
import * as toolRoutes from './tools.mjs';

function postReq(body) {
  const buf = Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-tools-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projects', 'example'), { recursive: true });
  const calls = [];
  const rec = (name, result) => async args => { calls.push({ name, ...args }); return result; };
  const api = toolRoutes.routes({
    root, actions: { startClaude: rec('startClaude', { sessionId: '' }), runTool: rec('runTool', { status: 0, output: 'ok' }) },
    getPort: () => 0, workspaceTag: '', dataDir: join(root, '.data'),
  });
  const call = async (key, body) => {
    try { return { status: 200, body: await api[key](postReq(body)) }; } catch (e) { return { status: e.status || 500, body: { ok: false, error: e.message } }; }
  };
  return { root, calls, call, api };
}

test('tools run through POST /api/command; POST /api/run is gone', async t => {
  const { root, calls, call, api } = setup(t);
  assert.ok('POST /api/command' in api);
  assert.ok(!('POST /api/run' in api));
  const r = await call('POST /api/command', { id: 'check' });
  assert.deepEqual([r.status, r.body.status, r.body.output, r.body.label], [200, 0, 'ok', 'Check workspace']);
  assert.match(calls[0].args[0], /check-workspace\.mjs$/);
  assert.equal(calls[0].cwd, root);
  assert.equal((await call('POST /api/command', { id: 'library' })).status, 400, 'still only after its preview');
  assert.equal((await call('POST /api/command', { id: '../evil' })).status, 400);
});

test('skills start with their launch defaults; plan mode for the ones that change code', async t => {
  const { root, calls, call } = setup(t);
  assert.equal((await call('POST /api/skill', { id: 'nextjs-feature', values: { project: 'example', feature: 'A page' } })).status, 200);
  assert.equal((await call('POST /api/skill', { id: 'onboard-project', values: { project: 'example' } })).status, 200);
  assert.equal((await call('POST /api/skill', { id: 'inbox-triage' })).status, 200);
  assert.deepEqual(calls.map(c => [c.dir, c.prompt, c.launch, c.kind, c.project || '']), [
    [join(root, 'projects', 'example'), '/nextjs-feature A page', { permissionMode: 'plan' }, 'skill', 'example'],
    [join(root, 'projects', 'example'), '/onboard-project', { permissionMode: 'plan' }, 'skill', 'example'],
    [root, '/inbox-triage', {}, 'skill', ''],
  ]);
  const ui = catalogForUi().skills;
  assert.deepEqual(ui.find(s => s.id === 'nextjs-feature').launch, { permissionMode: 'plan', model: '', effort: '' });
  assert.deepEqual(ui.find(s => s.id === 'game-feature').launch, { permissionMode: '', model: '', effort: '' });
  assert.ok(ui.every(s => s.launch && !('args' in s)));
  ui[0].launch.permissionMode = 'auto';
  assert.equal(catalogForUi().skills[0].launch.permissionMode, '', 'the page gets copies');
});

test('a skill request may override mode, model and effort, nothing else, and never with an unsafe mode', async t => {
  const { calls, call } = setup(t);
  const start = launch => call('POST /api/skill', { id: 'nextjs-feature', values: { project: 'example', feature: 'x' }, launch });
  assert.equal((await start({ effort: 'high', model: 'opus' })).status, 200);
  assert.equal((await start({ permissionMode: '' })).status, 200); // '' means your own default
  assert.equal((await start({ permissionMode: 'acceptEdits', settingsFile: 'C:\\x.json', resume: '8c1e0a52-3b6d-4f0e-9a1b-2c3d4e5f6a7b', allowedTools: 'Bash(*)', sessionId: 'x' })).status, 200);
  assert.equal((await start('plan')).status, 200); // not an object: the defaults
  assert.deepEqual(calls.map(c => c.launch), [
    { permissionMode: 'plan', model: 'opus', effort: 'high' },
    {},
    { permissionMode: 'acceptEdits' },
    { permissionMode: 'plan' },
  ]);
  calls.length = 0;
  for (const launch of [{ permissionMode: 'bypassPermissions' }, { permissionMode: 'dontAsk' }, { effort: 'huge' }, { model: '--dangerously' }]) {
    const r = await start(launch);
    assert.equal(r.status, 400, JSON.stringify(launch));
    assert.match(r.body.error, /How the session starts/);
  }
  assert.equal(calls.length, 0);
  // The same rules without HTTP.
  assert.deepEqual(skillLaunch('C:\\nowhere', 'inbox-triage', {}, { effort: 'low' }).launch, { effort: 'low' });
});
