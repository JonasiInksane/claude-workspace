// Tests for test/fake-claude.mjs (the claude.exe stand-in) and the privacy rules of the stream
// fixtures it replays (ADDENDUM "Fixtures"): placeholder canary, synthetic rate-limit numbers, no
// user name, nothing secret-shaped.
// Run: node --test tools/workspace-app/test/fake-claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoFixture, parseArgs, rewriteInit } from './fake-claude.mjs';
import { SCHEMAS, SCHEMA_NAMES } from '../runs/schemas.mjs';
import { scanText } from '../gates/secrets.mjs';
import { tempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-claude.mjs');
const FIX = join(HERE, 'fixtures', 'stream');
const SID = '8c1e0000-0000-4000-8000-0000000000aa';
const files = () => readdirSync(FIX).sort();
const parse = text => text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

function runFake(args, { stdin = '', cwd } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [FAKE, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolveP({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('parseArgs splits fake options from claude flags', () => {
  const { fake, flags } = parseArgs(['--fixture', 'hang', '--delay-ms', '0', '-p', '--verbose', '--session-id', SID, '-n', 'r1-scope',
    '--tools', 'Read,Grep', '--add-dir', 'C:\\a', '--add-dir', 'C:\\b', '--json-schema', '{}']);
  assert.deepEqual(fake, { fixture: 'hang', 'delay-ms': '0' });
  assert.deepEqual(flags, { p: true, verbose: true, 'session-id': SID, n: 'r1-scope', tools: 'Read,Grep', addDirs: ['C:\\a', 'C:\\b'], 'json-schema': '{}' });
});

test('rewriteInit makes the init match the flags unless the fixture keeps a value', () => {
  const init = { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', permissionMode: 'acceptEdits', tools: ['X'], mcp_servers: [{ name: 'm' }], session_id: 'old' };
  const flags = { 'session-id': SID, model: 'opus', 'permission-mode': 'manual', tools: 'Read,Glob,Grep', 'json-schema': '{}', 'strict-mcp-config': true, addDirs: [] };
  const out = rewriteInit(init, flags, { stdinBytes: 3 });
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.permissionMode, 'default');
  assert.deepEqual(out.tools, ['Glob', 'Grep', 'Read', 'StructuredOutput']);
  assert.deepEqual(out.mcp_servers, []);
  assert.equal(out.session_id, SID);
  assert.equal(out.stdinBytes, 3);
  assert.equal(out.cwd, process.cwd());
  const kept = rewriteInit({ ...init, _fake: { keep: ['model', 'tools'] } }, flags, {});
  assert.deepEqual([kept.model, kept.tools, kept._fake], ['claude-haiku-5-5', ['X'], undefined]);
  assert.equal(rewriteInit(init, { ...flags, model: 'sonnet[1m]' }, {}).model, 'claude-sonnet-5-5');
  assert.equal(rewriteInit(init, { ...flags, resume: SID, 'session-id': undefined }, {}).session_id, SID);
});

test('the fake replays a fixture with the session id, the title first and the stdin echo', async t => {
  const cwd = tempDir('wp9-fake-', t);
  const r = await runFake(['--fixture', 'success-plan', '--delay-ms', '0', '-p', '--session-id', SID, '-n', 'r1-scope',
    '--tools', 'Read,Grep,Glob', '--json-schema', '{}', '--strict-mcp-config', '--model', 'opus'], { stdin: 'Plan it.', cwd });
  assert.equal(r.code, 0);
  const events = parse(r.stdout);
  assert.deepEqual(events[0], { type: 'system', subtype: 'session_title_changed', title: 'r1-scope', session_id: SID });
  const init = events[1];
  assert.deepEqual([init.subtype, init.session_id, init.model, init.stdinBytes, init.stdinHead], ['init', SID, 'claude-opus-5-5', 8, 'Plan it.']);
  assert.equal(init.cwd.toLowerCase(), cwd.toLowerCase());
  assert.ok(Array.isArray(init.fakeEnvNames));
  assert.ok(events.every(e => e._fake === undefined));
  assert.ok(events.filter(e => typeof e.session_id === 'string').every(e => e.session_id === SID));
  const toolPaths = events.flatMap(e => (e.type === 'assistant' ? e.message.content : [])).filter(c => c.type === 'tool_use' && c.input.file_path).map(c => c.input.file_path);
  assert.ok(toolPaths.length && toolPaths.every(p => p.toLowerCase().startsWith(cwd.toLowerCase())), 'recorded paths move into the cwd');
  assert.equal(events.at(-1).type, 'result');
});

test('the fake exits 1 on an error result, honours --resume-fixture and stderr files', async () => {
  const turns = await runFake(['--fixture', 'max-turns', '--delay-ms', '0', '-p']);
  assert.equal(turns.code, 1);
  const resumed = await runFake(['--fixture', 'missing-structured', '--resume-fixture', 'success-plan', '--delay-ms', '0', '-p', '--resume', SID]);
  assert.equal(resumed.code, 0);
  assert.ok(parse(resumed.stdout).at(-1).structured_output, 'the resume fixture was played');
  const verbose = await runFake(['--fixture', 'no-verbose', '-p']);
  assert.equal(verbose.code, 1);
  assert.equal(verbose.stdout, '');
  assert.match(verbose.stderr, /requires --verbose/);
});

test('--fixture auto picks the success fixture of the --json-schema', async () => {
  for (const name of SCHEMA_NAMES) {
    const fixture = autoFixture(JSON.stringify(SCHEMAS[name]));
    assert.equal(fixture, `success-${name.split('.')[0]}`);
    assert.ok(existsSync(join(FIX, `${fixture}.jsonl`)), fixture);
  }
  assert.equal(autoFixture('{"type":"object","properties":{}}'), '');
  assert.equal(autoFixture('not json'), '');
  const r = await runFake(['--fixture', 'auto', '--delay-ms', '0', '-p', '--json-schema', JSON.stringify(SCHEMAS['answer.v1'])]);
  assert.equal(r.code, 0);
  assert.ok(parse(r.stdout).at(-1).structured_output.answer);
  const none = await runFake(['--fixture', 'auto', '-p']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--fixture auto needs --json-schema/);
});

test('the fake refuses unknown fixtures and writes that leave the cwd', async t => {
  const missing = await runFake(['--fixture', 'no-such-fixture']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /fake-claude: no fixture/);
  const traversal = await runFake(['--fixture', '../secrets']);
  assert.equal(traversal.code, 2);
  assert.match(traversal.stderr, /is not a fixture name/);
  const cwd = tempDir('wp9-fake-', t);
  const ok = join(cwd, 'writes.json');
  writeFileSync(ok, JSON.stringify({ 'src/new.js': 'export {};\n' }));
  const wrote = await runFake(['--fixture', 'success-plan', '--delay-ms', '0', '--writes-file', ok], { cwd });
  assert.equal(wrote.code, 0);
  assert.equal(readFileSync(join(cwd, 'src', 'new.js'), 'utf8'), 'export {};\n');
  const bad = join(cwd, 'bad.json');
  writeFileSync(bad, JSON.stringify({ '../escape.js': 'x' }));
  const refused = await runFake(['--fixture', 'success-plan', '--delay-ms', '0', '--writes-file', bad], { cwd });
  assert.equal(refused.code, 2);
  assert.ok(!existsSync(join(cwd, '..', 'escape.js')));
});

test('the fixtures the spec names exist', () => {
  const names = new Set(files());
  for (const n of ['success-plan', 'missing-structured', 'init-mismatch-model', 'init-mcp-tools', 'hang', 'denials', 'max-turns',
    'usage-limit', 'login-needed', 'bg-results', 'budget-stop', 'cancelled-partial', 'resume', 'no-verbose',
    'success-tests', 'success-change', 'success-findings', 'success-answer', 'success-diagnosis', 'success-triage', 'success-spec']) {
    assert.ok(names.has(`${n}.jsonl`), `${n}.jsonl is missing`);
  }
  const lines = n => parse(readFileSync(join(FIX, `${n}.jsonl`), 'utf8'));
  assert.deepEqual(lines('init-mismatch-model')[0]._fake, { keep: ['model'] });
  assert.deepEqual(lines('init-mcp-tools')[0]._fake, { keep: ['tools', 'mcp_servers'] });
  assert.ok(lines('hang').some(l => l._fake && l._fake.hang));
  assert.equal(lines('bg-results').filter(l => l.type === 'result').length, 2);
  assert.ok(lines('usage-limit').some(l => l.type === 'rate_limit_event' && l.rate_limit_info.status === 'rejected'));
});

test('fixture privacy: valid JSON, a placeholder canary, synthetic rate limits, no user name, nothing secret-shaped', () => {
  const user = userInfo().username;
  const userRe = user && user.length >= 3 && user.toLowerCase() !== 'user' ? new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  for (const f of files()) {
    const text = readFileSync(join(FIX, f), 'utf8');
    if (userRe) assert.ok(!userRe.test(text), `${f} names the user folder`);
    assert.ok(!/not-a-real-secret/.test(text), `${f} still has the spike canary value`);
    assert.deepEqual(scanText(text), [], `${f} has a secret-shaped string`);
    assert.ok(!/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `${f} has an email address`);
    if (!f.endsWith('.jsonl')) continue;
    for (const e of parse(text)) {
      if (e.type === 'rate_limit_event') {
        const i = e.rate_limit_info;
        assert.ok([0.42, 1].includes(i.unifiedWindows.five_hour.utilization), `${f}: five-hour utilization`);
        assert.equal(i.unifiedWindows.seven_day.utilization, 0.17, `${f}: seven-day utilization`);
        assert.ok([i.resetsAt, i.unifiedWindows.five_hour.resetsAt].every(v => v === 1792674000), `${f}: resetsAt`);
      }
      if (e.messaging_socket_path) assert.match(e.messaging_socket_path, /cc-msg-placeholder$/, f);
      if (e.type === 'system' && e.subtype === 'init') assert.match(e.cwd, /^C:\\Users\\user\\/, `${f}: cwd`);
    }
  }
  assert.ok(readFileSync(join(FIX, 'bash-read-bypass.jsonl'), 'utf8').includes('CANARY_SECRET=<placeholder>'));
});
