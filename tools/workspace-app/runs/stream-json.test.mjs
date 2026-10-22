// Tests for runs/stream-json.mjs: the normalizer on every recorded fixture, the init check (A4),
// the usage-limit and login helpers (A12) and redaction of rows (R16).
// Run: node --test tools/workspace-app/runs/stream-json.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALWAYS_PRESENT_TOOLS, MSG_MAX, TARGET_MAX, checkInit, createNormalizer, expectedInitFor, isLoginProblem, isUsageLimit,
  rateLimitSummary, resultErrorText, samePath, summarizeInit, toolTarget,
} from './stream-json.mjs';
import { redact } from '../gates/secrets.mjs';
import { tempDir } from '../test/helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'test', 'fixtures', 'stream');
const fixtureNames = () => readdirSync(FIX).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).sort();
// The lines fake-claude would print: its own {"_fake": ...} instruction lines are not output.
const fixtureLines = name => readFileSync(join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(l => l.trim())
  .filter(l => { const o = JSON.parse(l); return !(o._fake && o.type === undefined); });
const events = name => fixtureLines(name).map(l => JSON.parse(l));
const initOf = name => events(name).find(e => e.type === 'system' && e.subtype === 'init');

function normalize(name, opts = {}) {
  const n = createNormalizer({ stage: 'scope', attempt: 2, ...opts });
  const rows = [];
  for (const line of fixtureLines(name)) rows.push(...n.push(line));
  return { rows, state: n.state };
}
const kinds = rows => rows.map(r => (r.kind === 'tool' ? `tool:${r.tool.phase}${r.ok === false ? ':fail' : ''}` : r.kind));
// A key-shaped string built at runtime, so no literal key sits in the repo (SPEC section 0).
const fakeKey = () => ['sk', 'live', 'x'.repeat(24)].join('_');

test('every fixture normalizes: turns equal num_turns, rows are well formed, nothing unknown', () => {
  const names = fixtureNames();
  assert.ok(names.length >= 30, `only ${names.length} fixtures`);
  for (const name of names) {
    const { rows, state } = normalize(name);
    const results = events(name).filter(e => e.type === 'result');
    if (results.length) assert.equal(state.turns, results.at(-1).num_turns, `${name}: turns`);
    assert.deepEqual(state.unknown, name === 'bg-results' ? { 'system/task_notification': 1 } : {}, `${name}: unknown`);
    for (const r of rows) {
      assert.ok(['text', 'tool', 'deny', 'result', 'info', 'error'].includes(r.kind), `${name}: kind ${r.kind}`);
      assert.equal(r.stage, 'scope');
      assert.equal(r.attempt, 2);
      assert.ok(Number.isInteger(r.turn) && r.turn >= 1, `${name}: turn ${r.turn}`);
      assert.ok(typeof r.msg === 'string' && r.msg.length <= MSG_MAX, `${name}: msg length`);
      assert.ok(!Number.isNaN(Date.parse(r.t)));
      if (r.tool) assert.ok(r.tool.target.length <= TARGET_MAX);
    }
    const init = initOf(name);
    if (init) assert.equal(state.sessionId, init.session_id, `${name}: session id`);
  }
});

test('a structured run maps to start, tool, text, reminder and result rows', () => {
  const { rows, state } = normalize('success-structured');
  assert.deepEqual(kinds(rows), ['info', 'tool:start', 'tool:end', 'tool:start', 'tool:end', 'text', 'info', 'tool:start', 'tool:end', 'result']);
  assert.equal(rows[0].msg, 'Claude started: claude-haiku-5-5, manual mode, tools Glob, Grep, Read, StructuredOutput (Claude Code 2.1.307)');
  assert.equal(rows[1].msg, 'Read package.json', 'tool paths are shown relative to the working folder');
  assert.deepEqual(rows[2].tool, { name: 'Read', target: 'package.json', id: rows[1].tool.id, phase: 'end' });
  assert.equal(rows[2].ok, true);
  assert.equal(rows[3].msg, 'Read src/app.js');
  assert.match(rows[5].msg, /^"The package name is .*"$/, 'text rows are quoted');
  assert.equal(rows[6].msg, 'Claude Code reminded Claude to return the structured result');
  assert.equal(rows[7].msg, 'StructuredOutput (the stage result)');
  assert.match(rows[9].msg, /^Finished: 5 turns, ≈\$0\.00 API-equiv\.$/);
  assert.equal(rows[9].ok, true);
  assert.deepEqual(state.result.structured_output, { name: 'spike-e4a', lines: 3 });
  assert.equal(state.messageIds.size, 3);
  assert.equal(state.toolUses, 3);
});

test('init can come after session_title_changed (spike E11)', () => {
  const { rows, state } = normalize('resume');
  assert.equal(state.title, 'spike-E11');
  assert.equal(state.inits, 1);
  assert.equal(rows[0].kind, 'info');
  assert.match(rows[0].msg, /^Claude started/);
});

test('denials come from tool_result_meta, system/permission_denied and result.permission_denials, once each', () => {
  const hook = normalize('denials-hook');
  assert.deepEqual(hook.state.denials.map(d => [d.tool, d.input.command]), [['Bash', 'echo DENY_EXIT2'], ['Bash', 'echo DENY_JSON']]);
  const hookRows = hook.rows.filter(r => r.kind === 'deny');
  assert.deepEqual(hookRows.map(r => r.msg), ['Denied: Bash echo DENY_EXIT2 (guard hook)', 'Denied: Bash echo DENY_JSON (guard hook)']);
  assert.ok(hookRows.every(r => r.ok === false && r.tool.phase === 'end'));
  const read = normalize('denials-read-rules');
  assert.deepEqual(read.state.denials.map(d => d.tool), ['Read', 'Grep']);
  assert.equal(read.rows.filter(r => r.kind === 'deny').length, 2);
  assert.match(read.rows.find(r => r.kind === 'deny' && r.tool.name === 'Grep').msg, /\(rule\)$/);
  const bash = normalize('denials-bash-check');
  assert.deepEqual(bash.state.denials.map(d => d.input.command), ['cat .env', 'echo $PATH', 'node -e "console.log(1)"']);
  const edit = normalize('denials-edit-protected');
  assert.equal(edit.state.denials.length, 10);
  assert.ok(edit.state.denials.every(d => typeof d.id === 'string' && d.id));
});

test('stops, partial runs and background tasks map to their rows', () => {
  assert.match(normalize('max-turns').rows.at(-1).msg, /^Stopped at the turn limit: 3 turns/);
  assert.equal(normalize('max-turns').rows.at(-1).ok, false);
  assert.match(normalize('budget-stop').rows.at(-1).msg, /^Stopped by the budget backstop: 1 turn/);
  const partial = normalize('cancelled-partial');
  assert.equal(partial.state.result, null);
  assert.equal(partial.rows.at(-1).msg, 'Task started: Run node interval command in foreground and wait for it to finish');
  const bg = normalize('bg-results');
  assert.equal(bg.state.results.length, 2);
  assert.match(bg.state.result.structured_output.summary, /after the background task/, 'the last result wins');
  const n = createNormalizer();
  assert.deepEqual(n.push(JSON.stringify({ type: 'system', subtype: 'task_started', description: 'watch', is_backgrounded: true })).map(r => r.msg), ['Background task started: watch']);
  assert.match(normalize('login-needed').rows.at(-1).msg, /^Ended with an error: Invalid API key/, 'subtype "success" with is_error reads as an error');
});

test('thinking, rate limits, tool_progress and unknown lines produce no rows', () => {
  const t = { now: 1000 };
  const n = createNormalizer({ now: () => t.now });
  assert.deepEqual(n.push(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }] } })), []);
  assert.equal(n.state.thinking, 1);
  assert.deepEqual(n.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 })), []);
  t.now = 2000;
  assert.deepEqual(n.push(JSON.stringify({ type: 'tool_progress', tool_use_id: 'x' })), []);
  assert.equal(n.state.lastActivityAt, 2000);
  assert.deepEqual(n.push(JSON.stringify({ type: 'mystery' })), []);
  assert.deepEqual(n.push(JSON.stringify({ type: 'system', subtype: 'brand_new' })), []);
  assert.deepEqual(n.push('{ not json'), []);
  assert.deepEqual(n.push(''), []);
  assert.deepEqual(n.state.unknown, { mystery: 1, 'system/brand_new': 1, '(unparsed)': 1 });
  const retry = n.push(JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 529 }));
  assert.deepEqual(retry.map(r => [r.kind, r.msg, r.src]), [['info', 'Claude\'s API call failed; retry 2 of 10: 529', 'api_retry']]);
});

test('rate_limit_event is kept as state.rateLimit and worded by rateLimitSummary (A12)', () => {
  const { state, rows } = normalize('success-plan');
  assert.ok(!rows.some(r => /rate/i.test(r.msg)));
  assert.deepEqual(state.rateLimit, { status: 'allowed', type: 'five_hour', utilization: 0.42, resetsAt: 1792674000, sevenDayUtilization: 0.17 });
  const d = new Date(1792674000 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(rateLimitSummary(state.rateLimit), `Usage, 5-hour window: 42% (resets ${hhmm})`);
  assert.equal(normalize('usage-limit').state.rateLimit.status, 'rejected');
  assert.match(rateLimitSummary(normalize('usage-limit').state.rateLimit), /^Usage, 5-hour window: 100% \(resets \d\d:\d\d\), limit reached$/);
  assert.equal(rateLimitSummary(null), '');
  assert.equal(rateLimitSummary({ utilization: 0.5 }), 'Usage, 5-hour window: 50%');
});

test('R16: secrets are redacted in text, tool and denial rows before they are cut', () => {
  const key = fakeKey();
  const n = createNormalizer({ redact: s => redact(s) });
  n.push(JSON.stringify({ type: 'system', subtype: 'init', cwd: 'C:\\t', session_id: 's', tools: [], model: 'claude-opus-5-5', permissionMode: 'default' }));
  const rows = [
    ...n.push(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: `The key is ${key} in config.` }] } })),
    ...n.push(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${key}` } }] } })),
    ...n.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: `failed: ${key}` }] },
      tool_result_meta: [{ id: 't1', permission_decision: { decision: 'reject', source: 'hook' } }] })),
    ...n.push(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`boom ${key}`], num_turns: 2 })),
  ];
  for (const r of rows) assert.ok(!r.msg.includes(key), `${r.kind} row leaked: ${r.msg}`);
  assert.match(rows[0].msg, /sk_l…\[redacted \d+\]/);
  assert.ok(!JSON.stringify(n.state.denials).includes(key), 'denial inputs are redacted too');
  assert.ok(!rows.some(r => r.tool && r.tool.target.includes(key)));
});

test('rows are cut to 300 characters and targets to 120', () => {
  const n = createNormalizer();
  const [text] = n.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'word '.repeat(200) }] } }));
  assert.ok(text.msg.length <= MSG_MAX && text.msg.startsWith('"') && text.msg.endsWith('"'));
  const [tool] = n.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: { pattern: 'p'.repeat(500) } }] } }));
  assert.equal(tool.tool.target.length, TARGET_MAX);
  assert.ok(tool.tool.target.endsWith('…'));
});

test('toolTarget picks file_path, pattern in path, path, pattern or command', () => {
  const cwd = 'C:\\work\\tree';
  assert.equal(toolTarget({ file_path: 'C:\\work\\tree\\src\\a.ts' }, cwd), 'src/a.ts');
  assert.equal(toolTarget({ file_path: 'c:\\WORK\\tree\\src\\a.ts' }, cwd), 'src/a.ts', 'case-insensitive');
  assert.equal(toolTarget({ file_path: 'C:\\work\\treehouse\\a.ts' }, cwd), 'C:\\work\\treehouse\\a.ts', 'a sibling folder stays absolute');
  assert.equal(toolTarget({ pattern: 'TODO', path: 'C:\\work\\tree\\src' }, cwd), 'TODO in src');
  assert.equal(toolTarget({ path: 'C:\\work\\tree\\src' }, cwd), 'src');
  assert.equal(toolTarget({ pattern: '**/*.ts' }, cwd), '**/*.ts');
  assert.equal(toolTarget({ command: 'tg-check  test\n a' }, cwd), 'tg-check test a');
  assert.equal(toolTarget(null, cwd), '');
  assert.equal(toolTarget({ other: 1 }, cwd), '');
});

const expectFor = (init, over = {}) => ({ mode: 'manual', model: 'haiku', tools: ['Read', 'Grep', 'Glob'], cwd: init.cwd, schema: true, addDirs: [], ...over });

test('checkInit passes the recorded restricted READ init with a schema (A4)', () => {
  assert.deepEqual([...ALWAYS_PRESENT_TOOLS], [], 'there is no EndConversation');
  for (const name of ['success-structured', 'success-plan', 'missing-structured', 'usage-limit']) {
    const init = initOf(name);
    assert.deepEqual(checkInit(init, expectFor(init)), { ok: true, problems: [] }, name);
  }
  const noSchema = initOf('max-turns');
  assert.deepEqual(checkInit(noSchema, expectFor(noSchema, { schema: false })), { ok: true, problems: [] });
  const edit = initOf('denials-edit-protected');
  assert.deepEqual(checkInit(edit, expectFor(edit, { mode: 'acceptEdits', tools: ['Read', 'Edit', 'Write'], schema: false })).problems, []);
});

test('checkInit names each mismatch in plain words', () => {
  const init = initOf('success-structured');
  const problems = over => checkInit(init, expectFor(init, over)).problems;
  assert.deepEqual(problems({ model: 'opus' }), ['asked for opus, got haiku']);
  assert.deepEqual(checkInit(initOf('init-mismatch-model'), expectFor(initOf('init-mismatch-model'), { model: 'opus' })).problems, ['asked for opus, got sonnet']);
  assert.deepEqual(problems({ model: 'claude-haiku-5-5' }), [], 'a full id is compared exactly');
  assert.deepEqual(problems({ model: 'claude-haiku-4-5' }), ['asked for claude-haiku-4-5, got claude-haiku-5-5']);
  assert.deepEqual(problems({ model: 'haiku[1m]' }), [], 'a context suffix is ignored');
  assert.deepEqual(problems({ mode: 'acceptEdits' }), ['asked for acceptEdits mode, got manual']);
  assert.deepEqual(problems({ schema: false }), ['unexpected tools StructuredOutput']);
  assert.deepEqual(problems({ tools: ['Read', 'Grep', 'Glob', 'Bash'] }), ['missing tools Bash']);
  assert.deepEqual(problems({ tools: ['Read', 'Grep'] }), ['unexpected tools Glob']);
  assert.match(problems({ cwd: 'C:\\somewhere\\else' })[0], /^working folder is .*, not C:\\somewhere\\else$/);
  assert.deepEqual(problems({ cwd: `${init.cwd.toUpperCase()}\\` }), [], 'the cwd compares without case or a trailing slash');
  assert.deepEqual(problems({ addDirs: ['C:\\runs\\r1\\inputs'] }), ['missing extra folders C:\\runs\\r1\\inputs']);
  assert.deepEqual(checkInit({ ...init, additional_directories: ['C:\\x'] }, expectFor(init)).problems, ['unexpected extra folders C:\\x']);
  assert.deepEqual(checkInit({ ...init, additional_directories: ['c:\\X\\'] }, expectFor(init, { addDirs: ['C:\\x'] })).problems, []);
  assert.deepEqual(checkInit(null, expectFor(init)), { ok: false, problems: ['Claude did not report its setup'] });
});

test('checkInit refuses MCP tools, a connected MCP server and an unrestricted session', () => {
  const mcp = initOf('init-mcp-tools');
  const p = checkInit(mcp, expectFor(mcp)).problems;
  assert.deepEqual(p, ['8 MCP tools are loaded (mcp__claude_ai_Claude_Docs__batch …)', 'MCP servers are connected (claude.ai Claude Docs)']);
  const full = initOf('init-default');
  const fp = checkInit(full, expectFor(full, { schema: false })).problems;
  assert.ok(fp.includes('project memory is on, so --restricted did not take effect'));
  assert.ok(fp.includes('output style is Explanatory, so project settings were loaded'));
  assert.ok(fp.some(x => /^unexpected tools Task, Bash/.test(x)));
  const manual = initOf('init-manual-read');
  assert.ok(checkInit(manual, expectFor(manual, { schema: false })).problems.some(x => /MCP tools are loaded/.test(x)));
});

test('expectedInitFor and summarizeInit', () => {
  const spec = { profile: 'CHECK', model: 'opus', cwd: 'C:\\t', schema: { type: 'object', properties: {} }, addDirs: ['C:\\i'] };
  assert.deepEqual(expectedInitFor(spec), { mode: 'manual', model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Bash'], cwd: 'C:\\t', schema: true, addDirs: ['C:\\i'] });
  assert.deepEqual(summarizeInit(initOf('success-plan')), {
    model: 'claude-haiku-5-5', permissionMode: 'default', tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'],
    cwd: initOf('success-plan').cwd, ccVersion: '2.1.307',
  });
  assert.deepEqual(summarizeInit(null), { model: null, permissionMode: null, tools: [], cwd: null, ccVersion: null });
});

test('isUsageLimit reads error text, stderr and the rate-limit status, never Claude\'s own words', () => {
  const usage = events('usage-limit').find(e => e.type === 'result');
  assert.ok(isUsageLimit(usage, []));
  assert.ok(isUsageLimit({ subtype: 'error_during_execution', is_error: true }, [], { rateLimit: { status: 'rejected' } }));
  assert.ok(isUsageLimit({ subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429 Too Many Requests'] }));
  assert.ok(isUsageLimit(null, [], { stderr: 'Claude AI usage limit reached|1792674000' }));
  assert.ok(isUsageLimit(null, [{ kind: 'info', src: 'api_retry', msg: 'retry 3: rate limit' }]));
  assert.ok(isUsageLimit({ is_error: true, api_error_status: 429 }));
  const success = events('success-plan').find(e => e.type === 'result');
  assert.ok(!isUsageLimit({ ...success, result: 'I reviewed the rate limit middleware.' }, [], { rateLimit: { status: 'rejected' } }));
  assert.ok(!isUsageLimit(null, [{ kind: 'text', msg: '"The usage limit code looks fine"' }]), 'text rows are Claude\'s words');
  assert.ok(!isUsageLimit(events('max-turns').find(e => e.type === 'result')));
});

test('retry rows and stderr never override a result that says why it ended', () => {
  const retried = [{ kind: 'info', src: 'api_retry', msg: 'Claude\'s API call failed; retry 1 of 10: 429 rate_limit_error' }];
  const noise = { stderr: 'API rate limit hit (429), retrying; oauth token refreshed' };
  const maxTurns = events('max-turns').find(e => e.type === 'result');
  const budget = events('budget-stop').find(e => e.type === 'result');
  assert.ok(!isUsageLimit(maxTurns, retried, { ...noise, rateLimit: { status: 'rejected' } }));
  assert.ok(!isUsageLimit(budget, retried, noise));
  assert.ok(!isLoginProblem(maxTurns, noise.stderr));
  assert.ok(!isLoginProblem(budget, 'Not logged in. Please run /login'));
  // An error that comes back as subtype success says why in its own text.
  const apiError = { subtype: 'success', is_error: true, result: 'API Error: Connection error.' };
  assert.ok(!isUsageLimit(apiError, retried, noise));
  assert.ok(!isLoginProblem(apiError, noise.stderr));
  assert.ok(isUsageLimit({ ...apiError, result: 'API Error: 429 rate_limit_error' }, []));
  // An error that doesn't say why, or no result at all: the side channels count.
  assert.ok(isUsageLimit({ subtype: 'error_during_execution', is_error: true }, retried));
  assert.ok(isUsageLimit({ is_error: true }, [], noise));
  assert.ok(isUsageLimit(null, retried));
  assert.ok(isLoginProblem({ subtype: 'error_during_execution', is_error: true }, 'Not logged in. Please run /login'));
});

test('isLoginProblem reads the result error and stderr', () => {
  const login = events('login-needed').find(e => e.type === 'result');
  assert.ok(isLoginProblem(login, ''));
  assert.ok(isLoginProblem(null, 'Not logged in. Please run /login'));
  assert.ok(isLoginProblem({ is_error: true, errors: ['OAuth token has expired'] }));
  assert.ok(!isLoginProblem(events('success-plan').find(e => e.type === 'result'), 'oauth'));
  assert.ok(!isLoginProblem(events('max-turns').find(e => e.type === 'result'), ''));
  assert.equal(resultErrorText(events('max-turns').find(e => e.type === 'result')), 'Reached maximum number of turns (2)');
  assert.equal(resultErrorText(null), '');
});

test('samePath compares resolved paths without case, and through junctions by real path', t => {
  const dir = tempDir('wp9-same-', t);
  assert.ok(samePath(dir, `${dir.toUpperCase()}\\`));
  assert.ok(samePath(dir, join(dir, 'x', '..')));
  assert.ok(!samePath(dir, join(dir, 'x')));
  assert.ok(!samePath(dir, ''));
  assert.ok(!samePath(null, dir));
});
