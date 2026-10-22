// Tests for runs/guard.mjs, the PreToolUse hook of CHECK and EDIT stages (R7). Bash may run a
// plain `tg-check ...` and nothing else, including the read-only built-ins Claude Code would
// otherwise run with no rule (spike A8: cat, grep, git grep, ls).
// Run: node --test tools/workspace-app/runs/guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_REASON, COMMAND_RE, DENY_REASON, LOG_FILE, decide, denyOutput, pathKey } from './guard.mjs';
import { guardConfig } from './settings.mjs';
import { tempDir } from '../test/helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'guard.mjs');
const CFG = guardConfig({
  tree: 'C:\\work\\tg-run', runDir: 'C:\\Data\\cw\\runs\\example\\r1', hubRoot: 'C:\\hub', dataDir: 'C:\\Data\\cw',
  mainDir: 'D:\\main', secretFiles: ['config/secret.json'],
});
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra }, session_id: 's1', tool_use_id: 't1' });

const ALLOWED = [
  'tg-check test apps/api/src/billing/charge.test.ts',
  'tg-check types web',
  'tg-check lint apps/web/src/a.ts apps/web/src/b.tsx',
  'tg-check',
  'tg-check test c:/work/tg-run/apps/api/x.test.ts',
  'tg-check test /c/work/tg-run/apps/api/x.test.ts',
  '  tg-check types api  ',
  'tg-check test apps/api/x.test.ts --name=adds',
  'tg-check test apps/web/src/@scope/x+y,z.test.ts',
];
const DENIED = [
  ['cat package.json', 'a read-only built-in (wave-4 check)'],
  ['ls', 'a read-only built-in'],
  ['git log -1', 'a read-only git command'],
  ['echo hello', 'plain echo'],
  ['grep -r CANARY_SECRET .', 'grep -r printed the canary in the spike'],
  ['cat .en?', 'a glob printed the canary in the spike'],
  ['git grep --no-index CANARY_SECRET', 'git grep printed the canary in the spike'],
  ['tg-check test a.test.ts; cat .env', 'a command list'],
  ['tg-check test a.test.ts && ls', 'and-list'],
  ['tg-check test a.test.ts | tee out', 'a pipe'],
  ['tg-check test $(cat x)', 'command substitution'],
  ['tg-check test `id`', 'backticks'],
  ['tg-check test a.test.ts > out.txt', 'redirection out'],
  ['tg-check test < in.txt', 'redirection in'],
  ['tg-check test a.test.ts\ncat x', 'a second line'],
  ['tg-check test a.test.ts\rcat x', 'a carriage return'],
  ['tg-check test a.test.ts &', 'background with &'],
  ['tg-check test .env.test.ts', 'a secret file name'],
  ['tg-check lint config/.npmrc', 'a secret file name'],
  ['tg-check lint config/secret.json', 'the profile\'s tracked secret file'],
  ['tg-check lint other/secret.json', 'the secret file\'s base name'],
  ['tg-check test ../other/a.test.ts', 'a .. segment'],
  ['tg-check test apps/../../x.test.ts', 'a .. segment inside'],
  ['tg-check test c:/data/cw/runs/example/r1/inputs/x', 'the run folder'],
  ['tg-check test /c/hub/tools/x.test.mjs', 'the hub'],
  ['tg-check test d:/main/apps/x.test.ts', 'the main checkout'],
  ['tg-check test c:/data/cw/profiles/x', 'the data folder'],
  ['tg-check test e:/elsewhere/x.test.ts', 'outside the tree'],
  ['tg-check test c:/work/tg-run-other/x.test.ts', 'a sibling with the tree as prefix'],
  ['tg-check test --dest=/etc/passwd', 'an absolute path after ='],
  ['tg-check test a --out=../x', 'a .. after ='],
  ['tg-check build', 'an unknown subcommand'],
  ['tg-check test "a b"', 'double quotes'],
  ['tg-check test \'a\'', 'single quotes'],
  ['tg-check  test a', 'two spaces'],
  ['tg-check test\ta', 'a tab'],
  ['tg-check test a\\b', 'a backslash'],
  ['TG-CHECK test a', 'another spelling'],
  ['tg-checker test a', 'a longer name'],
  ['/usr/local/bin/tg-check test a', 'a path to the shim'],
  ['tg-check test *.ts', 'a glob'],
  ['tg-check test ~/x', 'a home path'],
  ['tg-check test $HOME', 'a variable'],
  ['tg-check test a #comment', 'a comment'],
  ['npm test', 'npm'],
  ['npx tsc', 'npx'],
  ['node -e 1', 'node'],
  ['bash -c "tg-check test a"', 'a nested shell'],
  ['env tg-check test a', 'a prefix command'],
  ['TEMP=x tg-check test a', 'a variable assignment'],
  ['', 'an empty command'],
];

test('the command table: only plain tg-check calls pass', () => {
  assert.ok(ALLOWED.length + DENIED.length >= 25);
  for (const c of ALLOWED) assert.deepEqual(decide(bash(c), CFG), { decision: 'allow', reason: '' }, `should allow: ${c}`);
  for (const [c, why] of DENIED) {
    assert.deepEqual(decide(bash(c), CFG), { decision: 'deny', reason: DENY_REASON }, `should deny (${why}): ${JSON.stringify(c)}`);
  }
});

test('the command pattern is the spec\'s', () => {
  assert.equal(COMMAND_RE.source, '^tg-check(?: [A-Za-z0-9_./:@=,+-]+)*$');
  assert.equal(DENY_REASON, 'Only tg-check runs here: tg-check test <path> | types <workspace> | lint <files>.');
});

test('a background tg-check is denied with its own reason', () => {
  assert.deepEqual(decide(bash('tg-check test a.test.ts', { run_in_background: true }), CFG), { decision: 'deny', reason: BACKGROUND_REASON });
});

test('tools other than Bash pass with no decision of the guard', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'StructuredOutput']) {
    assert.equal(decide({ tool_name: tool, tool_input: { file_path: '.env' } }, CFG).decision, 'allow', tool);
    assert.equal(decide({ tool_name: tool, tool_input: {} }, null).decision, 'allow', `${tool} without a config`);
  }
});

test('broken input or a broken config denies Bash', () => {
  assert.equal(decide(null, CFG).decision, 'deny');
  assert.equal(decide({}, CFG).decision, 'deny');
  assert.equal(decide({ tool_name: 'Bash' }, CFG).decision, 'deny');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 42 } }, CFG).decision, 'deny');
  assert.equal(decide(bash('tg-check types web'), null).decision, 'deny');
  assert.equal(decide(bash('tg-check types web'), { ...CFG, version: 2 }).decision, 'deny');
  assert.equal(decide(bash('tg-check types web'), { ...CFG, forbiddenRoots: 'C:\\hub' }).decision, 'deny');
  assert.equal(decide(bash(`tg-check test ${'a'.repeat(4001)}`), CFG).decision, 'deny', 'over the length cap');
});

test('pathKey makes C:\\x, c:/x and /c/x equal', () => {
  assert.equal(pathKey('C:\\Work\\Tree\\'), 'c:/work/tree');
  assert.equal(pathKey('/c/work/tree'), 'c:/work/tree');
  assert.equal(pathKey('/c'), 'c:');
  assert.equal(pathKey('c:/work/tree'), 'c:/work/tree');
  assert.equal(pathKey('apps/web'), 'apps/web');
});

test('denyOutput is the JSON deny form of A7', () => {
  assert.deepEqual(JSON.parse(denyOutput(DENY_REASON)), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
  });
});

test('guard.mjs imports only node: built-ins, so it always starts', () => {
  const src = readFileSync(GUARD, 'utf8');
  const specifiers = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.ok(s.startsWith('node:'), `guard.mjs imports ${s}`);
});

// Runs the hook script the way Claude Code does: the input as JSON on stdin.
const runGuard = (args, stdinText) => runGuardAt(GUARD, args, stdinText);
function runGuardAt(script, args, stdinText) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolveP({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

test('the hook script denies with JSON and exit 0, allows with no output, and logs each call', async t => {
  const dir = tempDir('wp9-guard-', t);
  const cfgFile = join(dir, 'guard.json');
  writeFileSync(cfgFile, JSON.stringify(CFG));
  const denied = await runGuard([cfgFile], JSON.stringify(bash('cat package.json')));
  assert.equal(denied.code, 0);
  assert.deepEqual(JSON.parse(denied.stdout), JSON.parse(denyOutput(DENY_REASON)));
  assert.equal(denied.stderr, '');
  const allowed = await runGuard([cfgFile], JSON.stringify(bash('tg-check types web')));
  assert.deepEqual([allowed.code, allowed.stdout], [0, '']);
  const read = await runGuard([cfgFile], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } }));
  assert.deepEqual([read.code, read.stdout], [0, '']);
  const log = readFileSync(join(dir, LOG_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(r => [r.tool, r.decision, r.command]), [
    ['Bash', 'deny', 'cat package.json'], ['Bash', 'allow', 'tg-check types web'], ['Read', 'allow', ''],
  ]);
  assert.equal(log[0].session, 's1');
});

test('the hook script still guards when its folder is reached through a junction', { skip: process.platform !== 'win32' }, async t => {
  const dir = tempDir('wp9-guard-', t);
  const link = join(dir, 'runs-link');
  symlinkSync(HERE, link, 'junction');
  const cfgFile = join(dir, 'guard.json');
  writeFileSync(cfgFile, JSON.stringify(CFG));
  const r = await runGuardAt(join(link, 'guard.mjs'), [cfgFile], JSON.stringify(bash('grep -r CANARY_SECRET .')));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'a guard that does nothing would let the command run');
});

test('the hook script denies Bash on bad JSON, a missing config or no config argument', async t => {
  const dir = tempDir('wp9-guard-', t);
  const cfgFile = join(dir, 'guard.json');
  writeFileSync(cfgFile, JSON.stringify(CFG));
  for (const [args, input] of [
    [[cfgFile], 'not json'],
    [[cfgFile], ''],
    [[join(dir, 'missing.json')], JSON.stringify(bash('tg-check types web'))],
    [[], JSON.stringify(bash('tg-check types web'))],
  ]) {
    const r = await runGuard(args, input);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', `${args.join(' ')} with ${input.slice(0, 20)}`);
  }
  writeFileSync(cfgFile, '{ broken');
  const broken = await runGuard([cfgFile], JSON.stringify(bash('tg-check types web')));
  assert.equal(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
