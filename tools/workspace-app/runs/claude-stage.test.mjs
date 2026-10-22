// Tests for runs/claude-stage.mjs: every stage status path through test/fake-claude.mjs (which
// replays recorded Claude Code 2.1.307 events), plus the safety rules this module owns:
//   R11 scrubbed env, R12 init mismatch stops before any tool row, R13 missing or invalid
//   structured output fails (after ONE automatic resume, A15) and outputs are capped,
//   R16 redacted rows and result text, R26 the prompt on stdin.
// No real claude runs; everything is written under os.tmpdir().
// Run: node --test tools/workspace-app/runs/claude-stage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_ENV_VARS, RESUME_PROMPT, TIMING, checkOutputPaths, claudeEnv, expectedFor, inTreePath, parseStageDir,
  runClaudeStage, stageTmpDir, wallTick,
} from './claude-stage.mjs';
import { capStrings } from './schema-check.mjs';
import { schemaFor } from './schemas.mjs';
import { stageSettings } from './settings.mjs';
import { SYSTEM_VARS } from '../gates/env.mjs';
import { redact } from '../gates/secrets.mjs';
import * as realProc from '../core/proc.mjs';
import { tempDir, waitFor, writeFiles } from '../test/helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = join(HERE, '..', '..', '..');
const FAKE = join(HERE, '..', 'test', 'fake-claude.mjs');
const FIX = join(HERE, '..', 'test', 'fixtures', 'stream');
const fakeCmd = (fixture, ...more) => [process.execPath, FAKE, '--fixture', fixture, ...more];
const fixtureEvents = name => readFileSync(join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const recordedOutput = name => fixtureEvents(name).filter(e => e.type === 'result').at(-1).structured_output;
const readEvents = file => readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const initIn = file => readEvents(file).find(e => e.type === 'system' && e.subtype === 'init');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Key-shaped strings are built at runtime, so no literal key sits in the repo (SPEC section 0).
const fakeKey = () => ['sk', 'live', 'q'.repeat(24)].join('_');

// A tree, a run folder and a stage folder under os.tmpdir(), with a real settings object.
function setup(t, { profile = 'READ', schemaName = 'plan.v1', model = 'haiku', maxTurns = 40, folder = '01-scope', addDirs } = {}) {
  const root = tempDir('wp9-stage-', t);
  const tree = join(root, 'tree');
  writeFiles(tree, { 'src/app.js': 'export const add = (a, b) => a + b;\n', 'package.json': '{}\n' });
  const dataDir = join(root, 'data');
  const runDir = join(dataDir, 'runs', 'example', '261022-104212-x');
  const stageDir = join(runDir, 'stages', folder);
  mkdirSync(join(runDir, 'inputs'), { recursive: true });
  const spec = {
    profile, model, effort: 'high', maxTurns, budgetUsd: 5, sessionId: randomUUID(), name: `261022-104212-x-${folder.slice(3)}`,
    settingsFile: join(stageDir, 'settings.json'), cwd: tree, addDirs: addDirs ?? (profile === 'EDIT' ? [] : [join(runDir, 'inputs')]),
  };
  const settings = stageSettings({ profile, hubRoot: HUB, dataDir, runDir, stageDir, tree, mainDir: tree, profileDoc: null });
  return { root, tree, dataDir, runDir, stageDir, spec, settings, schemaName };
}

async function run(ctx, fixture, opts = {}) {
  const rows = [];
  const procs = [];
  const result = await runClaudeStage({
    spec: opts.spec || ctx.spec, prompt: opts.prompt ?? 'Plan the change to src/app.js.', stageDir: ctx.stageDir,
    env: opts.env ?? claudeEnv({}), claudeCommand: opts.claudeCommand ?? fakeCmd(fixture, ...(opts.fake || [])),
    caps: opts.caps, schemaName: 'schemaName' in opts ? opts.schemaName : ctx.schemaName, expectedInit: opts.expectedInit,
    onRow: r => { rows.push(r); if (opts.onRow) opts.onRow(r); },
    onProc: (p, e) => { procs.push([p, e]); if (opts.onProc) opts.onProc(p, e); }, signal: opts.signal,
    settings: ctx.settings, redact: opts.redact ?? (s => redact(s)), timing: opts.timing, proc: opts.proc,
    resumeSessionId: opts.resumeSessionId, clock: opts.clock,
  });
  return { result, rows, procs };
}

// A fixture folder of our own, for shapes the recorded fixtures don't have.
function customFixture(root, name, lines) {
  const dir = join(root, 'fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return ['--fixture-dir', dir];
}

test('a successful stage is done, with a capped output and every file written', async t => {
  const ctx = setup(t);
  const prompt = 'Plan the change to src/app.js.';
  const { result, rows, procs } = await run(ctx, 'success-plan', { prompt });
  assert.equal(result.status, 'done', result.reason);
  assert.equal(result.reason, '');
  assert.deepEqual([result.version, result.stage, result.attempt], [1, 'scope', 1]);
  assert.deepEqual([result.subtype, result.isError, result.exitCode, result.killedFor], ['success', false, 0, '']);
  assert.equal(result.sessionId, ctx.spec.sessionId);
  assert.deepEqual([result.numTurns, result.turnsCounted, result.processes, result.autoResumed], [5, 5, 1, false]);
  assert.ok(result.estUsd > 0 && result.estUsd < 0.01);
  assert.deepEqual(result.output, capStrings(recordedOutput('success-plan'), schemaFor('plan.v1')));
  assert.deepEqual(result.outputErrors, []);
  assert.deepEqual(result.denials, []);
  assert.deepEqual([result.init.check, result.init.problems], ['ok', []]);
  assert.deepEqual([result.init.model, result.init.permissionMode, result.init.ccVersion], ['claude-haiku-5-5', 'default', '2.1.307']);
  assert.deepEqual(result.paths, { unknown: ['src/math.js', 'src/math.test.js'], outside: [] }, 'paths that do not exist yet are listed');
  assert.equal(result.terminalReason, 'completed');
  assert.equal(result.rateLimit.utilization, 0.42);
  assert.ok(result.resultText.startsWith('{"summary"') && result.resultText.length <= 4096);
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.stageDir, 'result.json'), 'utf8')), result);
  assert.equal(readFileSync(join(ctx.stageDir, 'prompt.md'), 'utf8'), prompt);
  assert.deepEqual(JSON.parse(readFileSync(ctx.spec.settingsFile, 'utf8')), ctx.settings);
  const procFile = JSON.parse(readFileSync(join(ctx.stageDir, 'proc.json'), 'utf8'));
  assert.equal(procFile.processes.length, 1);
  assert.equal(procFile.processes[0].image.toLowerCase(), 'node.exe');
  assert.ok(Number.isInteger(procFile.processes[0].pid) && procFile.processes[0].startedAt > 0);
  assert.equal(procFile.processes[0].exitCode, 0);
  assert.deepEqual(procs.map(([, e]) => e.event), ['start', 'exit']);
  assert.equal(procs[0][0].pid, procFile.processes[0].pid);
  assert.ok(!rows.some(r => r.kind === 'error'));
  assert.match(rows[0].msg, /^Claude started: claude-haiku-5-5, manual mode/);
  assert.ok(rows.every(r => r.stage === 'scope' && r.attempt === 1));
  assert.equal(rows.at(-1).kind, 'result');
});

test('R26: the prompt reaches claude on stdin as UTF-8 and never in argv; init comes after the title', async t => {
  const ctx = setup(t);
  const prompt = 'Explique le café ☕ et le module money — PROMPT-MARKER.';
  const { result } = await run(ctx, 'success-plan', { prompt });
  assert.equal(result.status, 'done');
  const events = readEvents(join(ctx.stageDir, 'events.jsonl'));
  assert.equal(events[0].subtype, 'session_title_changed', '-n puts the title first (spike E11)');
  const init = events.find(e => e.subtype === 'init');
  assert.equal(init.stdinBytes, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(init.stdinHead, prompt);
  assert.ok(!init.fakeArgv.some(a => a.includes('PROMPT-MARKER')), 'the prompt is not in argv');
  for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--verbose']) assert.ok(init.fakeArgv.includes(flag), flag);
  assert.equal(init.fakeArgv[init.fakeArgv.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(init.fakeArgv[init.fakeArgv.indexOf('--session-id') + 1], ctx.spec.sessionId);
  assert.ok(!init.fakeArgv.includes('--input-format'));
});

test('R11: claude gets only the system variables, the shim on PATH and its own TEMP', async t => {
  const ctx = setup(t);
  const secret = () => 'v'.repeat(12);
  const leaky = {
    NPM_TOKEN: secret(), NODE_AUTH_TOKEN: secret(), npm_config_registry: 'https://registry.invalid/', GITHUB_TOKEN: secret(), GH_TOKEN: secret(),
    AWS_ACCESS_KEY_ID: secret(), AWS_SECRET_ACCESS_KEY: secret(), AWS_SESSION_TOKEN: secret(), AZURE_CLIENT_SECRET: secret(),
    GOOGLE_APPLICATION_CREDENTIALS: 'C:\\creds.json', ANTHROPIC_API_KEY: secret(), ANTHROPIC_AUTH_TOKEN: secret(), ANTHROPIC_BASE_URL: 'https://x.invalid',
    OPENAI_API_KEY: secret(), MESHY_API_KEY: secret(), SENTRY_AUTH_TOKEN: secret(), DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    NODE_OPTIONS: '--require x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_USE_BEDROCK: '1',
  };
  const shimDir = join(ctx.stageDir, 'bin');
  const tmpDir = stageTmpDir(ctx.runDir, ctx.stageDir);
  const env = claudeEnv({ shimDir, tmpDir, base: { ...process.env, ...leaky } });
  for (const name of Object.keys(leaky)) assert.ok(!(name in env), `${name} reached the env`);
  assert.ok(env.PATH.startsWith(`${shimDir};`));
  assert.deepEqual([env.TEMP, env.TMP], [tmpDir, tmpDir]);
  const { result } = await run(ctx, 'success-plan', { env });
  assert.equal(result.status, 'done');
  assert.ok(existsSync(tmpDir), 'the stage TEMP folder is created');
  const names = initIn(join(ctx.stageDir, 'events.jsonl')).fakeEnvNames.map(n => n.toLowerCase());
  // libuv copies a few Windows names (LOGONSERVER, USERDOMAIN ...) into every child env itself.
  const allowed = new Set([...CLAUDE_ENV_VARS, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'CLAUDE_CODE_GIT_BASH_PATH',
    'LOGONSERVER', 'USERDOMAIN'].map(n => n.toLowerCase()));
  for (const n of names) assert.ok(allowed.has(n), `${n} reached claude`);
  for (const name of Object.keys(leaky)) assert.ok(!names.includes(name.toLowerCase()), `${name} reached claude`);
  assert.ok(names.includes('claude_code_print_bg_wait_ceiling_ms'));
});

test('claudeEnv keeps SYSTEM_VARS only, matching names without case', () => {
  assert.deepEqual([...CLAUDE_ENV_VARS], SYSTEM_VARS, 'the same list as the check runner');
  const base = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\T', tmp: 'C:\\T', USERPROFILE: 'C:\\Users\\u', EMPTY: '', OS: '',
    NPM_TOKEN: 'x', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' };
  assert.deepEqual(claudeEnv({ base }), {
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\T', TMP: 'C:\\T', USERPROFILE: 'C:\\Users\\u',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
  const full = claudeEnv({ base, shimDir: 'C:\\run\\bin', tmpDir: 'C:\\run\\tmp\\01-scope', gitBash: 'D:\\Git\\bin\\bash.exe' });
  assert.equal(full.PATH, 'C:\\run\\bin;C:\\Windows');
  assert.deepEqual([full.TEMP, full.TMP, full.CLAUDE_CODE_GIT_BASH_PATH], ['C:\\run\\tmp\\01-scope', 'C:\\run\\tmp\\01-scope', 'D:\\Git\\bin\\bash.exe']);
  assert.equal(claudeEnv({ base: {}, shimDir: 'C:\\bin' }).PATH, 'C:\\bin');
  assert.equal(stageTmpDir('C:\\runs\\r1', 'C:\\runs\\r1\\stages\\05-implement-a2'), join('C:\\runs\\r1', 'tmp', '05-implement-a2'));
});

test('R12: an init mismatch kills the stage before any row of work is passed on', async t => {
  const ctx = setup(t, { model: 'opus' });
  const kills = [];
  const proc = { ...realProc, treeKill: pid => { kills.push(pid); return realProc.treeKill(pid); } };
  const { result, rows, procs } = await run(ctx, 'init-mismatch-model', { fake: ['--delay-ms', '150'], proc });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Stopped before any work: asked for opus, got sonnet.');
  assert.equal(result.killedFor, 'init');
  assert.deepEqual([result.init.check, result.init.problems], ['mismatch', ['asked for opus, got sonnet']]);
  assert.equal(result.init.model, 'claude-sonnet-5-5');
  assert.equal(result.output, null);
  assert.deepEqual(rows.map(r => [r.kind, r.msg]), [['error', 'Stopped before any work: asked for opus, got sonnet.']]);
  assert.deepEqual(kills, [procs[0][0].pid], 'the process tree was killed');
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.autoResumed, false);
});

test('R12: MCP tools in the init fail the stage the same way', async t => {
  const ctx = setup(t);
  const { result, rows } = await run(ctx, 'init-mcp-tools');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^Stopped before any work: 8 MCP tools are loaded .*; MCP servers are connected \(claude\.ai Claude Docs\)\.$/);
  assert.ok(!rows.some(r => r.kind === 'tool' || r.kind === 'text'));
});

test('work before any init is refused like a mismatch', async t => {
  const ctx = setup(t);
  const fake = customFixture(ctx.root, 'no-init-first', [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Working without telling you my setup.' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, structured_output: recordedOutput('success-plan') },
  ]);
  const { result, rows } = await run(ctx, 'no-init-first', { fake });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Stopped before any work: Claude did not report its setup before working.');
  assert.deepEqual(rows.map(r => r.kind), ['error']);
  assert.equal(result.init.check, 'mismatch');
});

test('A15: a success without structured_output gets one resume, which can save the stage', async t => {
  const ctx = setup(t);
  const { result, rows, procs } = await run(ctx, 'missing-structured', { fake: ['--resume-fixture', 'success-plan'] });
  assert.equal(result.status, 'done', result.reason);
  assert.deepEqual([result.autoResumed, result.processes, result.numTurns], [true, 2, 10]);
  assert.equal(result.sessionId, ctx.spec.sessionId);
  assert.deepEqual(result.output, capStrings(recordedOutput('success-plan'), schemaFor('plan.v1')));
  assert.ok(rows.some(r => r.kind === 'info' && r.msg === 'Claude returned no structured result; asking Claude once more to return it.'));
  const resumeInit = initIn(join(ctx.stageDir, 'events-resume.jsonl'));
  assert.equal(resumeInit.stdinHead, RESUME_PROMPT);
  assert.equal(resumeInit.session_id, ctx.spec.sessionId);
  const args = resumeInit.fakeArgv;
  assert.equal(args[args.indexOf('--resume') + 1], ctx.spec.sessionId);
  assert.ok(!args.includes('--session-id') && args.includes('--json-schema') && args.includes('--restricted'), 'every flag is passed again (A13)');
  assert.equal(JSON.parse(readFileSync(join(ctx.stageDir, 'proc.json'), 'utf8')).processes.length, 2);
  assert.deepEqual(procs.map(([, e]) => e.event), ['start', 'exit', 'start', 'exit']);
});

test('R13: a stage still without structured_output after the one resume fails', async t => {
  const ctx = setup(t);
  const { result, rows } = await run(ctx, 'missing-structured');
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Claude returned no structured result, even after one reminder');
  assert.deepEqual([result.autoResumed, result.processes, result.output, result.subtype], [true, 2, null, 'success']);
  assert.deepEqual(rows.at(-1), { ...rows.at(-1), kind: 'error', msg: 'Claude returned no structured result, even after one reminder' });
});

test('R12 on the automatic resume: its init mismatch is the failure reported', async t => {
  const ctx = setup(t);
  const { result, rows } = await run(ctx, 'missing-structured', { fake: ['--resume-fixture', 'init-mismatch-model'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Stopped before any work: asked for haiku, got sonnet.');
  assert.deepEqual([result.killedFor, result.autoResumed, result.processes, result.output], ['init', true, 2, null]);
  assert.deepEqual([result.init.check, result.init.problems, result.init.model], ['mismatch', ['asked for haiku, got sonnet'], 'claude-sonnet-5-5']);
  assert.equal(rows.filter(r => r.msg.startsWith('Stopped before any work')).length, 1);
  assert.ok(!rows.some(r => r.kind === 'error' && /no structured result/.test(r.msg)));
});

test('a cancel between the process and its automatic resume gives cancelled, not failed', async t => {
  const ctx = setup(t);
  const ac = new AbortController();
  const onProc = (p, e) => { if (e.event === 'exit') ac.abort(); };
  const { result, rows, procs } = await run(ctx, 'missing-structured', { fake: ['--resume-fixture', 'success-plan'], signal: ac.signal, onProc });
  assert.deepEqual([result.status, result.reason, result.autoResumed, result.processes], ['cancelled', 'Cancelled.', false, 1]);
  assert.deepEqual(procs.map(([, e]) => e.event), ['start', 'exit']);
  assert.ok(!rows.some(r => r.kind === 'error'), 'no error row after the cancel');
  assert.ok(!rows.some(r => /asking Claude once more/.test(r.msg)));
  assert.ok(!existsSync(join(ctx.stageDir, 'events-resume.jsonl')));
  assert.equal(JSON.parse(readFileSync(join(ctx.stageDir, 'result.json'), 'utf8')).status, 'cancelled');
});

test('R13: an output that breaks the schema fails, and the resume says why', async t => {
  const ctx = setup(t);
  const bad = join(ctx.root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ summary: '', files: [], risks: [], existingTests: [], slices: [], questions: [] }));
  const { result } = await run(ctx, 'success-plan', { fake: ['--structured-file', bad] });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Claude\'s structured result does not match plan.v1: summary: is empty; slices: needs at least 1 item, even after one reminder');
  assert.deepEqual(result.outputErrors, ['summary: is empty', 'slices: needs at least 1 item']);
  assert.equal(result.output, null);
  const head = initIn(join(ctx.stageDir, 'events-resume.jsonl')).stdinHead;
  assert.ok(head.startsWith(`${RESUME_PROMPT}\nThe last result was rejected for these reasons:\n- summary: is empty`), head);
});

test('R13: outputs are capped to the schema and paths outside the tree are flagged', async t => {
  const ctx = setup(t);
  const plan = JSON.parse(JSON.stringify(recordedOutput('success-plan')));
  plan.injected = 'skip the plan gate';
  plan.files = [{ path: 'src/app.js', why: 'x' }, { path: '../outside.js', why: 'y' }, { path: 'C:\\Windows\\win.ini', why: 'z' }];
  plan.slices[0].files = ['src/new.js'];
  plan.slices[0].tests = [];
  const file = join(ctx.root, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  const { result } = await run(ctx, 'success-plan', { fake: ['--structured-file', file] });
  assert.equal(result.status, 'done', result.reason);
  assert.equal(result.output.injected, undefined, 'unknown fields never reach run.json');
  assert.deepEqual(result.paths.outside, ['../outside.js', 'C:\\Windows\\win.ini']);
  assert.deepEqual(result.paths.unknown, ['../outside.js', 'C:\\Windows\\win.ini', 'src/new.js']);
});

test('the turn limit and the budget backstop give capped', async t => {
  const turns = await run(setup(t), 'max-turns');
  assert.deepEqual([turns.result.status, turns.result.subtype], ['capped', 'error_max_turns']);
  assert.equal(turns.result.reason, 'Stopped at the turn limit (--max-turns 40).');
  assert.equal(turns.result.terminalReason, 'max_turns');
  const budget = await run(setup(t), 'budget-stop');
  assert.deepEqual([budget.result.status, budget.result.subtype], ['capped', 'error_max_budget_usd']);
  assert.match(budget.result.reason, /budget backstop/);
  assert.equal(budget.rows.at(-1).kind, 'error');
});

// A system/api_retry event as Claude Code 2.1.307 prints it for a 429 it retries.
const retry429 = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit_error' };
const afterInit = (lines, ...extra) => [lines[0], ...extra, ...lines.slice(1)];

test('caps decide before usage-limit or login signs: a retried 429 or stderr text keeps capped', async t => {
  const a = setup(t);
  const turns = await run(a, 'retried', { fake: customFixture(a.root, 'retried', afterInit(fixtureEvents('max-turns'), retry429)) });
  assert.deepEqual([turns.result.status, turns.result.reason], ['capped', 'Stopped at the turn limit (--max-turns 40).']);
  assert.ok(turns.rows.some(r => r.src === 'api_retry' && / 429 /.test(`${r.msg} `)), 'the retry row is on the timeline');
  const b = setup(t);
  const noisy = { _fake: { stderr: 'API rate limit hit (429), retrying; oauth token refreshed\n' } };
  const budget = await run(b, 'noisy', { fake: customFixture(b.root, 'noisy', afterInit(fixtureEvents('budget-stop'), retry429, noisy)) });
  assert.deepEqual([budget.result.status, budget.result.reason], ['capped', 'Stopped by the budget backstop (--max-budget-usd).']);
  const c = setup(t, { maxTurns: 2 });
  const own = await run(c, 'noisy-turns', { fake: ['--delay-ms', '25', ...customFixture(c.root, 'noisy-turns', afterInit(fixtureEvents('denials-edit-protected'), retry429, noisy))] });
  assert.deepEqual([own.result.status, own.result.killedFor], ['capped', 'turns']);
  const d = setup(t);
  const wall = await run(d, 'retry-hang', { fake: customFixture(d.root, 'retry-hang', [fixtureEvents('success-plan')[0], retry429, noisy, { _fake: { hang: true } }]),
    caps: { wallMs: 600 }, timing: { tickMs: 50, tailMs: 50 } });
  assert.deepEqual([wall.result.status, wall.result.killedFor], ['capped', 'wall']);
});

test('without a result, a 429 retry row or stderr still means a usage limit or a login problem', async t => {
  const a = setup(t);
  const limit = await run(a, 'retry-crash', { fake: customFixture(a.root, 'retry-crash', [fixtureEvents('success-plan')[0], retry429, { _fake: { exit: 1 } }]) });
  assert.deepEqual([limit.result.status, limit.result.reason], ['paused-limit', 'Claude\'s usage limit was reached; resume the stage later.']);
  const b = setup(t);
  const login = await run(b, 'login-crash', { fake: customFixture(b.root, 'login-crash', [fixtureEvents('success-plan')[0], { _fake: { stderr: 'Not logged in. Please run /login\n' } }, { _fake: { exit: 1 } }]) });
  assert.deepEqual([login.result.status, login.result.reason], ['failed', 'Claude login needed: run claude in a terminal']);
});

test('the app\'s own turn cap (maxTurns + 2, counted from tool results) kills a runaway stage', async t => {
  const ctx = setup(t, { maxTurns: 2 });
  const { result } = await run(ctx, 'denials-edit-protected', { fake: ['--delay-ms', '25'] });
  assert.equal(result.status, 'capped');
  assert.equal(result.killedFor, 'turns');
  assert.equal(result.reason, 'Stopped at the app\'s turn cap: 5 turns, with --max-turns 2.');
  assert.ok(result.turnsCounted < 23, 'killed well before the recorded 23 turns');
});

test('the wall clock caps a stage that never ends, and kills its tree', async t => {
  const ctx = setup(t);
  const started = Date.now();
  const { result } = await run(ctx, 'hang', { caps: { wallMs: 600 }, timing: { tickMs: 50, tailMs: 50 } });
  assert.equal(result.status, 'capped');
  assert.equal(result.killedFor, 'wall');
  assert.equal(result.reason, 'Stopped at the time cap of 1 second.');
  assert.ok(Date.now() - started < 5000);
  const child = /fake-claude child pid (\d+)/.exec(readFileSync(join(ctx.stageDir, 'stderr.log'), 'utf8'));
  assert.ok(child, 'the fake started a grandchild');
  await waitFor(() => !alive(Number(child[1])), 5000);
});

// Neither half depends on how late real timers fire: a late tick only makes a gap longer, and the
// awake clock (10x) still counts any gap up to 3 s of real time, the asleep one (100000x) none
// over 0.3 ms. The ticks are 20 ms apart.
test('the wall clock skips gaps over 30 s (the PC slept) and counts the rest', async t => {
  const fast = factor => { const start = Date.now(); return { now: () => start + (Date.now() - start) * factor }; };
  const timing = { tickMs: 20, tailMs: 20, initMs: 1e12, lingerMs: 1e12 };
  const a = setup(t);
  const working = customFixture(a.root, 'working', [...fixtureEvents('success-plan').filter(e => e.type !== 'result'), { _fake: { hang: true } }]);
  const safety = new AbortController();
  const stop = setTimeout(() => safety.abort(), 20000);
  const awake = await run(a, 'working', { fake: working, caps: { wallMs: 2000 }, timing, clock: fast(10), signal: safety.signal });
  clearTimeout(stop);
  assert.deepEqual([awake.result.status, awake.result.killedFor], ['capped', 'wall'], 'gaps of about 0.2 s add up to the 2 s cap');
  assert.equal(awake.result.reason, 'Stopped at the time cap of 2 seconds.');
  const asleep = await run(setup(t), 'success-plan', { fake: ['--delay-ms', '80'], caps: { wallMs: 60000 }, timing, clock: fast(100000) });
  assert.equal(asleep.result.status, 'done', 'every tick gap is over 30 s, so none counts');
  assert.ok(asleep.result.durationMs > 600000, 'the stage ran far longer than the cap on that clock');
  assert.deepEqual(wallTick({ last: 0, counted: 0 }, 5000), { last: 5000, counted: 5000 });
  assert.deepEqual(wallTick({ last: 5000, counted: 5000 }, 65000), { last: 65000, counted: 5000 });
  assert.deepEqual(wallTick({ last: 5000, counted: 5000 }, 4000), { last: 4000, counted: 5000 });
  assert.deepEqual(wallTick({ last: 0, counted: 0 }, 30000), { last: 30000, counted: 30000 });
  assert.equal(TIMING.sleepGapMs, 30000);
  assert.equal(TIMING.tickMs, 5000);
  assert.equal(TIMING.tailMs, 250);
});

test('cancelling the hang fixture kills the process tree within 5 s', async t => {
  const ctx = setup(t);
  const ac = new AbortController();
  let abortedAt = 0;
  const onRow = r => {
    if (!abortedAt && r.kind === 'info') setTimeout(() => { abortedAt = Date.now(); ac.abort(); }, 300);
  };
  const { result, procs } = await run(ctx, 'hang', { signal: ac.signal, onRow });
  assert.ok(abortedAt > 0);
  assert.ok(Date.now() - abortedAt < 5000, `took ${Date.now() - abortedAt} ms`);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual([result.reason, result.killedFor], ['Cancelled.', 'cancel']);
  assert.ok(!alive(procs[0][0].pid), 'the fake claude is gone');
  const child = /fake-claude child pid (\d+)/.exec(readFileSync(join(ctx.stageDir, 'stderr.log'), 'utf8'));
  assert.ok(child);
  await waitFor(() => !alive(Number(child[1])), Math.max(100, 5000 - (Date.now() - abortedAt)));
});

test('a signal that is already aborted starts nothing', async t => {
  const ctx = setup(t);
  const ac = new AbortController();
  ac.abort();
  const { result, procs, rows } = await run(ctx, 'success-plan', { signal: ac.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(procs, []);
  assert.deepEqual(rows, []);
  assert.ok(!existsSync(join(ctx.stageDir, 'events.jsonl')));
  assert.ok(existsSync(join(ctx.stageDir, 'result.json')));
});

test('a usage limit pauses the stage; a login problem fails it with the fix', async t => {
  const limit = await run(setup(t), 'usage-limit');
  assert.equal(limit.result.status, 'paused-limit');
  assert.equal(limit.result.reason, 'Claude\'s usage limit was reached; resume the stage later.');
  assert.equal(limit.result.rateLimit.status, 'rejected');
  assert.equal(limit.result.autoResumed, false);
  const login = await run(setup(t), 'login-needed');
  assert.equal(login.result.status, 'failed');
  assert.equal(login.result.reason, 'Claude login needed: run claude in a terminal');
  assert.equal(login.result.autoResumed, false);
});

test('a run that ends without a result fails with the exit code and stderr', async t => {
  const partial = await run(setup(t), 'cancelled-partial');
  assert.equal(partial.result.status, 'failed');
  assert.equal(partial.result.reason, 'Claude stopped without a result (exit 1).');
  const verbose = await run(setup(t), 'no-verbose');
  assert.equal(verbose.result.status, 'failed');
  assert.equal(verbose.result.reason, 'Claude stopped without a result (exit 1): Error: When using --print, --output-format=stream-json requires --verbose');
  assert.deepEqual([verbose.result.init.check, verbose.result.init.problems], ['missing', []], 'no init was seen');
});

test('a claude that cannot start fails the stage; a .cmd is never started', async t => {
  const ctx = setup(t);
  const missing = await run(ctx, '', { claudeCommand: [join(ctx.root, 'missing', 'claude.exe')] });
  assert.equal(missing.result.status, 'failed');
  assert.match(missing.result.reason, /^Claude could not start: /);
  assert.deepEqual(missing.procs, [], 'no process record without a pid');
  const cmd = await run(setup(t), '', { claudeCommand: ['C:\\tools\\claude.cmd'] });
  assert.equal(cmd.result.status, 'failed');
  assert.match(cmd.result.reason, /^Claude could not start: claude\.cmd is a \.cmd or \.bat file/);
});

test('a CHECK stage reports the guard hook denials', async t => {
  const ctx = setup(t, { profile: 'CHECK', schemaName: 'answer.v1', folder: '01-investigate' });
  const { result, rows } = await run(ctx, 'denials');
  assert.equal(result.status, 'done', result.reason);
  assert.equal(result.stage, 'investigate');
  assert.deepEqual(result.denials.map(d => [d.tool, d.input.command]), [['Bash', 'echo DENY_EXIT2'], ['Bash', 'echo DENY_JSON']]);
  assert.equal(rows.filter(r => r.kind === 'deny').length, 2);
  assert.deepEqual(result.paths.unknown, []);
});

test('with two results the last one decides', async t => {
  const { result } = await run(setup(t), 'bg-results');
  assert.equal(result.status, 'done');
  assert.match(result.output.summary, /after the background task/);
});

test('a result followed by silence ends the process after the linger time (A10)', async t => {
  const ctx = setup(t);
  const lines = fixtureEvents('success-plan');
  const fake = customFixture(ctx.root, 'linger', [...lines, { _fake: { hang: true } }]);
  const { result } = await run(ctx, 'linger', { fake, timing: { tickMs: 50, tailMs: 50, lingerMs: 300 } });
  assert.equal(result.killedFor, 'linger');
  assert.equal(result.status, 'done', 'the result still counts');
  assert.deepEqual(result.output, capStrings(recordedOutput('success-plan'), schemaFor('plan.v1')));
});

test('a time cap that fires after a valid result keeps that result (done, not capped)', async t => {
  const ctx = setup(t);
  const fake = customFixture(ctx.root, 'result-then-hang', [...fixtureEvents('success-plan'), { _fake: { hang: true } }]);
  // The clock stands still until the result row arrives, so the cap can only fire after it.
  let resultAt = null;
  const start = Date.now();
  const clock = { now: () => (resultAt === null ? start : start + Date.now() - resultAt) };
  const onRow = r => { if (r.kind === 'result' && resultAt === null) resultAt = Date.now(); };
  const { result, rows } = await run(ctx, 'result-then-hang', { fake, clock, onRow, caps: { wallMs: 300 }, timing: { tickMs: 50, tailMs: 50, lingerMs: 1e12 } });
  assert.equal(result.killedFor, 'wall');
  assert.equal(result.status, 'done', result.reason);
  assert.deepEqual(result.output, capStrings(recordedOutput('success-plan'), schemaFor('plan.v1')));
  assert.ok(!rows.some(r => r.kind === 'error'));
});

test('a claude that never reports its setup is stopped after initMs', async t => {
  const ctx = setup(t);
  const fake = customFixture(ctx.root, 'silent', [{ _fake: { hang: true } }]);
  const { result } = await run(ctx, 'silent', { fake, timing: { tickMs: 50, tailMs: 50, initMs: 400 } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Claude did not report its setup within 1 second.');
});

test('R16: secrets in Claude\'s words are redacted in rows and the result text', async t => {
  const ctx = setup(t, { schemaName: 'answer.v1', folder: '00-answer' });
  const key = fakeKey();
  const lines = fixtureEvents('success-answer').map(e => {
    if (e.type === 'assistant' && e.message.content.some(c => c.type === 'text')) {
      return { ...e, message: { ...e.message, content: [{ type: 'text', text: `I found ${key} in the config.` }] } };
    }
    if (e.type === 'result') return { ...e, result: `The key ${key} is set.` };
    return e;
  });
  const fake = customFixture(ctx.root, 'leaky', lines);
  const { result, rows } = await run(ctx, 'leaky', { fake });
  assert.equal(result.status, 'done', result.reason);
  assert.ok(rows.some(r => r.kind === 'text' && /sk_l…\[redacted \d+\]/.test(r.msg)));
  for (const r of rows) assert.ok(!r.msg.includes(key), `row leaked: ${r.msg}`);
  assert.ok(!result.resultText.includes(key));
  assert.match(result.resultText, /redacted/);
});

test('resumeSessionId starts with --resume and keeps that session id', async t => {
  const ctx = setup(t);
  const sid = randomUUID();
  const { result } = await run(ctx, 'success-plan', { resumeSessionId: sid });
  assert.equal(result.status, 'done');
  assert.equal(result.sessionId, sid);
  const args = initIn(join(ctx.stageDir, 'events.jsonl')).fakeArgv;
  assert.equal(args[args.indexOf('--resume') + 1], sid);
  assert.ok(!args.includes('--session-id'));
});

test('an executor-style expectedInit without addDirs still accepts the --add-dir folder', async t => {
  const ctx = setup(t);
  const expectedInit = { model: 'haiku', mode: 'manual', permissionMode: 'manual', tools: ['Read', 'Grep', 'Glob'], cwd: ctx.tree, schema: true, schemaName: 'plan.v1' };
  const { result } = await run(ctx, 'success-plan', { expectedInit });
  assert.deepEqual([result.init.check, result.init.problems], ['ok', []]);
  const merged = expectedFor({ ...ctx.spec, schema: schemaFor('plan.v1') }, { model: 'opus', addDirs: undefined });
  assert.deepEqual(merged.addDirs, ctx.spec.addDirs);
  assert.equal(merged.model, 'opus');
});

test('bad input throws before anything starts', async t => {
  const ctx = setup(t);
  const base = { spec: ctx.spec, prompt: 'x', stageDir: ctx.stageDir, claudeCommand: fakeCmd('success-plan'), schemaName: 'plan.v1', settings: ctx.settings, redact: s => s };
  await assert.rejects(runClaudeStage({ ...base, prompt: '  ' }), /The stage prompt is empty/);
  await assert.rejects(runClaudeStage({ ...base, claudeCommand: [] }), /claudeCommand must be a list/);
  await assert.rejects(runClaudeStage({ ...base, spec: null }), /needs a stage spec/);
  await assert.rejects(runClaudeStage({ ...base, stageDir: '' }), /needs the stage folder/);
  await assert.rejects(runClaudeStage({ ...base, spec: { ...ctx.spec, model: '' } }), /The model must be/);
  await assert.rejects(runClaudeStage({ ...base, spec: { ...ctx.spec, profile: 'EDIT', addDirs: ['C:\\x'] } }), /no --add-dir/);
  await assert.rejects(runClaudeStage({ ...base, schemaName: 'nope.v1' }), /no output schema called "nope\.v1"/);
  const other = setup(t);
  await assert.rejects(runClaudeStage({ ...base, spec: other.spec, stageDir: other.stageDir, settings: undefined }), /The stage settings file is missing/);
});

test('parseStageDir, inTreePath and checkOutputPaths', async t => {
  assert.deepEqual(parseStageDir('C:\\runs\\r1\\stages\\05-implement-a2'), { index: 5, id: 'implement', attempt: 2 });
  assert.deepEqual(parseStageDir('01-scope'), { index: 1, id: 'scope', attempt: 1 });
  assert.deepEqual(parseStageDir('07-fresh-review-a3'), { index: 7, id: 'fresh-review', attempt: 3 });
  assert.deepEqual(parseStageDir('weird'), { index: null, id: 'weird', attempt: 1 });
  const tree = 'C:\\work\\tree';
  assert.equal(inTreePath('src/a.js', tree), 'src/a.js');
  assert.equal(inTreePath('./src\\a.js', tree), 'src/a.js');
  assert.equal(inTreePath('../x.js', tree), null);
  assert.equal(inTreePath('src/../../x.js', tree), null);
  assert.equal(inTreePath('C:\\work\\tree\\src\\a.js', tree), 'src/a.js');
  assert.equal(inTreePath('c:/WORK/tree/src/a.js', tree), 'src/a.js');
  assert.equal(inTreePath('C:\\work\\treehouse\\a.js', tree), null);
  assert.equal(inTreePath('C:\\work\\tree', tree), '');
  assert.equal(inTreePath('  ', tree), null);
  const ctx = setup(t);
  assert.deepEqual(await checkOutputPaths(['src/app.js', 'src/nope.js', '../out.js'], ctx.tree), { unknown: ['src/nope.js', '../out.js'], outside: ['../out.js'] });
});
