// Tests for runs/wiring.mjs (the real run engine for the app) and its use in app.mjs: which claude
// command a stage gets (claude.exe, the fake for tests only, a per-stage function), the lazy and
// memoized ctx.getEngine, isBusy from the engine (R21), and stopping the engine with a hard cap.
// No real claude starts here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../app.mjs';
import { claudeCommandFor, createEngine, FAKE_CLAUDE, fakeClaudeCommand, recoverySummary, stopEngine } from './wiring.mjs';
import { tempDir } from '../test/helpers.mjs';

const TEST_ENV = { WS_APP_TEST: '1' };

test('claude command: claude.exe from the launcher, nothing without it, a list or a function as given', () => {
  assert.deepEqual(claudeCommandFor({ actions: { tools: { claude: 'C:\\x\\claude.exe' } } }), ['C:\\x\\claude.exe']);
  assert.equal(claudeCommandFor({ actions: { tools: { claude: '' } } }), null);
  assert.equal(claudeCommandFor({}), null);
  assert.deepEqual(claudeCommandFor({ actions: { tools: { claude: 'claude.exe' } }, engineOptions: { claudeCommand: ['a', 'b'] } }), ['a', 'b']);
  const fn = () => ['x'];
  assert.equal(claudeCommandFor({ engineOptions: { claudeCommand: fn } }), fn);
});

test('the fake claude is for tests only (WS_APP_TEST=1) and takes a plain fixture name', () => {
  assert.throws(() => fakeClaudeCommand({ env: {} }), /for tests only; set WS_APP_TEST=1/);
  assert.deepEqual(fakeClaudeCommand({ env: TEST_ENV }), [process.execPath, FAKE_CLAUDE, '--fixture', 'auto', '--delay-ms', '30']);
  assert.deepEqual(fakeClaudeCommand({ fixture: 'hang', delayMs: 0, env: TEST_ENV }).slice(2), ['--fixture', 'hang', '--delay-ms', '0']);
  for (const bad of ['../x', 'Hang', 'a b', '']) assert.throws(() => fakeClaudeCommand({ fixture: bad, env: TEST_ENV }), /not a fixture name/, bad);
  const saved = process.env.WS_APP_TEST;
  delete process.env.WS_APP_TEST;
  try {
    assert.throws(() => claudeCommandFor({ engineOptions: { fakeClaude: true } }), /for tests only/);
  } finally {
    if (saved !== undefined) process.env.WS_APP_TEST = saved;
  }
});

test('createEngine: the manager with the launcher functions; without claude a stage fails with a plain sentence', async t => {
  const dir = tempDir('ws-wiring-', t);
  const calls = [];
  const actions = { tools: { claude: '' }, startClaude: async a => { calls.push(a); return { sessionId: 's' }; }, runTool: async () => ({ status: 0, output: '' }) };
  const m = await createEngine({ root: join(dir, 'hub'), dataDir: join(dir, 'data'), actions });
  for (const k of ['preview', 'start', 'action', 'cancel', 'recover', 'isBusy', 'signals', 'shutdown', 'settled', 'actionsFor', 'pipeline']) {
    assert.ok(m[k], k);
  }
  await m.engine.startClaude({ dir: 'x' });
  assert.deepEqual(calls, [{ dir: 'x' }], 'startClaude is the launcher\'s, bound to it');
  await assert.rejects(m.engine.claudeStage.runClaudeStage({ stage: 'answer' }), /Claude Code was not found/);
  assert.equal(typeof m.engine.claudeStage.claudeEnv, 'function');
  await assert.rejects(createEngine({ dataDir: dir }), /workspace root/);
  await assert.rejects(createEngine({ root: dir }), /data folder/);
});

test('createEngine: a function command is asked per stage with the stage options', async t => {
  const dir = tempDir('ws-wiring-', t);
  const seen = [];
  const claudeCommand = opts => { seen.push([opts.stage, opts.attempt]); throw new Error('stop here'); };
  const m = await createEngine({ root: join(dir, 'hub'), dataDir: join(dir, 'data'), engineOptions: { claudeCommand } });
  await assert.rejects(m.engine.claudeStage.runClaudeStage({ stage: 'scope', attempt: 2 }), /stop here/);
  assert.deepEqual(seen, [['scope', 2]]);
  assert.equal(m.engine.claudeCommand, undefined, 'a function command is not passed on as a list');
});

test('getEngine is lazy and memoized; a failed start is not kept; isBusy follows the engine (R21)', async t => {
  const dir = tempDir('ws-wiring-', t);
  const app = createApp({ root: join(dir, 'hub'), token: 't', actions: {}, getPort: () => 0, dataDir: join(dir, 'data') });
  assert.equal(app.isBusy(), false, 'no engine yet, nothing busy');
  const p = app.getEngine();
  assert.equal(app.getEngine(), p, 'the same promise every time');
  const m = await p;
  assert.equal(app.isBusy(), false);
  const token = m.register({ kind: 'gate', runId: 'r1' });
  assert.equal(app.isBusy(), true, 'a registered gate or stage keeps the app busy');
  m.unregister(token);
  assert.equal(app.isBusy(), false, 'a run that only waits for you does not');
  await m.shutdown();

  const saved = process.env.WS_APP_TEST;
  delete process.env.WS_APP_TEST;
  t.after(() => { if (saved !== undefined) process.env.WS_APP_TEST = saved; });
  const broken = createApp({ root: join(dir, 'hub'), token: 't', actions: {}, getPort: () => 0, dataDir: join(dir, 'data'), engineOptions: { fakeClaude: true } });
  const first = broken.getEngine();
  await assert.rejects(first, /for tests only/);
  const second = broken.getEngine();
  assert.notEqual(second, first, 'a failed start is tried again');
  await assert.rejects(second, /for tests only/);
});

test('stopEngine waits for shutdown, but never longer than its cap', async () => {
  assert.deepEqual(await stopEngine(null), { skipped: true });
  const report = { killed: [], failed: [], interrupted: ['r1'], errors: [] };
  assert.deepEqual(await stopEngine({ shutdown: async () => report }), report);
  const started = Date.now();
  assert.deepEqual(await stopEngine({ shutdown: () => new Promise(() => {}) }, { capMs: 50 }), { timedOut: true });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await stopEngine({ shutdown: () => { throw new Error('boom'); } }), { error: 'boom' });
});

test('recoverySummary: one short line, empty when nothing happened', () => {
  assert.equal(recoverySummary({}), '');
  assert.equal(recoverySummary({ interrupted: [], killed: [], adopted: [], released: [], skipped: [], errors: [] }), '');
  assert.equal(recoverySummary({ interrupted: ['a'], killed: [{}, {}], adopted: [{}], released: [], errors: ['Lock unreadable.'] }),
    'runs recovered: 1 interrupted, 2 leftover processes stopped, 1 lock kept, 1 problem: Lock unreadable.');
});
