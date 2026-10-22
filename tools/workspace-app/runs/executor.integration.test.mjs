// Integration test of runs/executor.mjs with the real modules (defaultDeps): an Explain run
// through the real Claude stage (runs/claude-stage.mjs, argv.mjs, settings.mjs, stream-json.mjs),
// the real run store and real git in a temporary repo. claude itself is test/fake-claude.mjs,
// which replays a recorded Claude Code 2.1.307 stream; no real claude starts.
// Skipped with a message when the WP9 stage or the fake is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutor, DEP_FUNCTIONS, defaultDeps } from './executor.mjs';
import { pipelineById, runTitle } from './catalog.mjs';
import { fakeProfile, makeRepo, tempDir } from '../test/helpers.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = join(HERE, '..', 'test', 'fake-claude.mjs');
const FIXTURE = join(HERE, '..', 'test', 'fixtures', 'stream', 'success-answer.jsonl');
const missing = [join(HERE, 'claude-stage.mjs'), FAKE, FIXTURE].filter(f => !existsSync(f));
const skip = missing.length ? `needs ${missing.join(', ')} (WP9), which is not there yet` : false;

const fnAt = (deps, name) => name.split('.').reduce((o, k) => (o == null ? o : o[k]), deps);

test('defaultDeps provides every function the executor calls', { skip }, async t => {
  const deps = await defaultDeps({ hubRoot: HUB, dataDir: tempDir('ws-exec-deps-', t) });
  const absent = DEP_FUNCTIONS.filter(name => typeof fnAt(deps, name) !== 'function');
  assert.deepEqual(absent, [], `defaultDeps lacks ${absent.join(', ')}`);
  assert.equal(typeof deps.holder.pid, 'number');
});

test('explain through the real Claude stage, store and git with fake-claude', { skip }, async t => {
  const root = tempDir('ws-exec-int-', t);
  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  const sha = await makeRepo(repo, { files: {
    'CLAUDE.md': '# Example\n\nKeep functions small.\n',
    'AGENTS.md': '# Agents\n\n## Review rules\n\n- Findings as [severity] path:line.\n',
    'package.json': '{ "name": "spike-e4a", "private": true }\n',
    'src/app.js': 'export function add(a, b) {\n  return a + b;\n}\n',
  } });
  const profile = fakeProfile();
  const deps = await defaultDeps({
    hubRoot: HUB, dataDir,
    profileFor: async () => ({ exists: true, profile, errors: [], warnings: [] }),
    mainDirFor: async () => repo,
    getSettings: async () => ({}),
    claudeCommand: [process.execPath, FAKE, '--fixture', 'success-answer', '--delay-ms', '1'],
    timing: { tailMs: 25, tickMs: 200 },
  });
  const ex = createExecutor(deps);
  const def = pipelineById('explain');
  const values = { what: 'What does add do?', where: 'src' };
  const run = await deps.store.createRun(dataDir, {
    project: 'example', pipeline: 'explain', title: runTitle(def, values), values, level: 'standard',
    isolation: { mode: 'none', treeMode: 'main', tree: null, mainDir: null }, stages: def.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: 'pending' })),
  });
  await ex.advance(run);
  const after = await deps.store.loadRun(dataDir, 'example', run.id);
  assert.equal(after.status, 'passed', after.statusReason);
  const dir = deps.store.runDir(dataDir, after);
  const answer = JSON.parse(readFileSync(join(dir, 'final', 'answer.json'), 'utf8'));
  assert.equal(answer.answer, 'add(a, b) in src/app.js returns a + b.');
  assert.deepEqual(answer.sources.map(s => s.path), ['src/app.js']);
  // the stage folder: prompt, settings, events, result, process record
  const stageDir = join(dir, 'stages', '00-answer');
  for (const f of ['prompt.md', 'settings.json', 'events.jsonl', 'stderr.log', 'result.json', 'proc.json']) assert.ok(existsSync(join(stageDir, f)), f);
  const prompt = readFileSync(join(stageDir, 'prompt.md'), 'utf8');
  assert.match(prompt, new RegExp(`<project_instructions source="CLAUDE\\.md@${sha.slice(0, 7)}">\\n# Example\\n\\nKeep functions small\\.`));
  assert.match(prompt, /<project_instructions source="AGENTS\.md@/);
  assert.match(prompt, /<data name="request">\nQuestion: What does add do\?/);
  // the prompt went to stdin, never into argv (R26); the safety flags are there (R1, R2)
  const init = readFileSync(join(stageDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .find(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.stdinBytes, Buffer.byteLength(prompt, 'utf8'));
  const argv = init.fakeArgv;
  assert.ok(!argv.some(a => a.includes('What does add do')), 'the prompt is not in argv');
  for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--permission-prompts', '--max-turns', '--max-budget-usd', '--settings', '--session-id']) {
    assert.ok(argv.includes(flag), flag);
  }
  for (const bad of ['bypassPermissions', 'dontAsk', '--dangerously-skip-permissions', '--allowedTools']) assert.ok(!argv.includes(bad), bad);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(argv[argv.indexOf('--add-dir') + 1], join(dir, 'inputs'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  const result = JSON.parse(readFileSync(join(stageDir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'done');
  assert.equal(result.init.check, 'ok');
  const attempt = after.stages[0].attempts[0];
  assert.deepEqual([attempt.initModel, attempt.init, attempt.ccVersion, attempt.status], ['claude-sonnet-5-5', 'ok', '2.1.307', 'done']);
  assert.ok(attempt.proc && Number.isInteger(attempt.proc.pid));
  const settings = JSON.parse(readFileSync(join(stageDir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks, undefined, 'READ has no shell and no hook');
  assert.ok(settings.permissions.deny.includes('Read(//**/.env*)'));
  const rows = (await deps.store.readTimeline(dataDir, after, 0, 500)).rows;
  assert.ok(rows.some(r => r.kind === 'tool' && /Read/.test(r.msg)), 'tool rows reach the timeline');
  assert.ok(rows.some(r => r.kind === 'status' && r.msg === 'Run passed'));
});
