// Tests for gates/commands.mjs: planning a check level (planChecks, including the G4 skip and the
// serverFocused selection), file lists, command lines, the output parsers, and running real node
// processes with the scrubbed env (runCommand). Repos are temporary example repos with fake tsc,
// ESLint and Prettier (test/fixtures/check); test files are real node:test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../test/helpers.mjs';
import { lintErrorId, typeErrorId } from './baseline.mjs';
import { checkProfile, exampleCheckRepo, failing, passing, setFile, testFile } from '../test/fixtures/check/repo.mjs';
import {
  checkTmpDir, cleanRel, commandArgv, displayCommand, expandFiles, keyedErrors, levelGroups, logName, parseEslintJson,
  parsePrettierCheck, parseTscOutput, perFileLimit, planChecks, relFrom, rerunFiles, runCommand, tapRows, treeRelOf,
} from './commands.mjs';

const ids = items => items.map(i => i.id);
const byId = (items, id) => items.find(i => i.id === id);
const secretKey = () => `sk_${'live_'}${'x'.repeat(24)}`;

// ---------------------------------------------------------------------------------------------
// Paths

test('cleanRel keeps paths inside the tree and refuses the rest', () => {
  assert.equal(cleanRel('apps\\api\\src\\a.mjs'), 'apps/api/src/a.mjs');
  assert.equal(cleanRel('./apps/api/'), 'apps/api');
  assert.equal(cleanRel('.'), '');
  assert.equal(cleanRel(''), '');
  assert.equal(cleanRel('apps/../apps/web/x'), 'apps/web/x');
  assert.equal(cleanRel('../outside'), null);
  assert.equal(cleanRel('apps/../../x'), null);
  assert.equal(cleanRel('C:/x'), null);
  assert.equal(cleanRel('/etc/passwd'), null);
});

test('relFrom, treeRelOf and logName', () => {
  assert.equal(relFrom('apps/web', 'apps/web/src/a.ts'), 'src/a.ts');
  assert.equal(relFrom('apps/web', 'packages/x/b.ts'), '../../packages/x/b.ts');
  assert.equal(relFrom('', 'scripts/t.mjs'), 'scripts/t.mjs');
  assert.equal(treeRelOf({ cwd: 'apps/api' }, 'src/a.test.mjs'), 'apps/api/src/a.test.mjs');
  assert.equal(treeRelOf({ cwd: '.' }, 'scripts/t.mjs'), 'scripts/t.mjs');
  assert.equal(logName('test:web'), 'test-web');
  assert.equal(logName('g0.lint'), 'g0.lint');
  assert.equal(logName('::'), 'check');
});

test('checkTmpDir puts a run gate\'s TEMP under the run\'s tmp folder', () => {
  const run = join('C:\\data', 'runs', 'example', '261022-104212-check-x');
  assert.equal(checkTmpDir(join(run, 'gates', '06-checks-r2')), join(run, 'tmp', '06-checks-r2'));
  assert.equal(checkTmpDir('C:\\tmp\\gate-1'), join('C:\\tmp\\gate-1', 'tmp'));
});

// ---------------------------------------------------------------------------------------------
// planChecks

test('levelGroups lists the groups of a level and refuses an unknown one', () => {
  assert.deepEqual(levelGroups(checkProfile(), 'quick'), ['G0', 'G1', 'G2']);
  assert.throws(() => levelGroups(checkProfile(), 'huge'), /no check level "huge"/);
});

test('quick: types of affected workspaces, lint on changed files, focused API tests', () => {
  const p = checkProfile();
  const plan = planChecks({ profile: p, level: 'quick', changed: ['apps/api/src/billing/charge.mjs', 'apps/web/src/features/cart/total.mjs'] });
  assert.deepEqual(ids(plan), ['types:api', 'types:web', 'test:api', 'lint:web', 'test:web'], 'G1 rows first, then G2');
  assert.deepEqual(byId(plan, 'lint:web').files, ['apps/web/src/features/cart/total.mjs']);
  const api = byId(plan, 'test:api');
  assert.deepEqual(api.files, []);
  assert.deepEqual(api.folders, ['apps/api/src/billing']);
  assert.equal(byId(plan, 'test:web').files, undefined, 'web is not the focused workspace, so all its tests run');
  for (const item of plan) assert.ok(['G1', 'G2'].includes(item.group));
  assert.equal(byId(plan, 'types:api').label, 'Types: API');
});

test('types follow affectedBy; tests and lint only the owners', () => {
  const p = checkProfile();
  const plan = planChecks({ profile: p, level: 'quick', changed: ['apps/api/src/routes/items/router.mjs'] });
  assert.deepEqual(ids(plan), ['types:api', 'types:web', 'test:api']);
  const shared = planChecks({ profile: p, level: 'quick', changed: ['packages/shared/money.mjs'] });
  assert.deepEqual(ids(shared), ['types:api', 'types:web', 'test:root'], 'the root workspace owns packages/');
});

test('serverFocused: changed tests plus the folders of changed source files', () => {
  const p = checkProfile();
  const plan = planChecks({ profile: p, level: 'quick', changed: [
    { path: 'apps/api/src/auth/session.test.mjs', status: 'M' },
    { path: 'apps/api/src/billing/charge.mjs', status: 'M' },
    { path: 'apps/api/src/gone.test.mjs', status: 'D' },
  ] });
  const api = byId(plan, 'test:api');
  assert.deepEqual(api.files, ['apps/api/src/auth/session.test.mjs']);
  assert.deepEqual(api.folders, ['apps/api/src/billing'], 'a deleted test file adds no folder');
  const noTests = planChecks({ profile: p, level: 'quick', changed: [{ path: 'apps/api/src/x.test.mjs', status: 'D' }] });
  assert.equal(byId(noTests, 'test:api').files.length, 0);
  assert.match(planChecks({ profile: p, level: 'quick', changed: [] }).map(i => i.id).join(), /^$/);
});

test('lint of only deleted files is listed as not run', () => {
  const plan = planChecks({ profile: checkProfile(), level: 'quick', changed: [{ path: 'apps/web/src/old.mjs', status: 'D' }] });
  assert.equal(byId(plan, 'lint:web').skipReason, 'Not run: no changed files to lint');
});

test('a rename counts for both its old and its new folder', () => {
  const plan = planChecks({ profile: checkProfile(), level: 'quick', changed: [{ path: 'apps/web/src/moved.mjs', status: 'R', oldPath: 'apps/api/src/moved.mjs' }] });
  assert.ok(ids(plan).includes('types:api'));
  assert.ok(ids(plan).includes('types:web'));
  assert.deepEqual(byId(plan, 'lint:web').files, ['apps/web/src/moved.mjs']);
});

test('standard: G3 full API tests replace the focused G2 ones, or say why they did not run', () => {
  const p = checkProfile();
  const api = planChecks({ profile: p, level: 'standard', changed: ['apps/api/src/billing/charge.mjs'] });
  assert.deepEqual(ids(api), ['types:api', 'test:api']);
  assert.equal(byId(api, 'test:api').group, 'G3');
  assert.equal(byId(api, 'test:api').files, undefined);
  const web = planChecks({ profile: p, level: 'standard', changed: ['apps/web/src/features/cart/total.mjs'] });
  assert.equal(byId(web, 'test:api').group, 'G3');
  assert.equal(byId(web, 'test:api').skipReason, 'Not run: apps/api and packages/shared unchanged');
});

test('paranoid: G4 runs only when its ports listen', () => {
  const p = checkProfile();
  const changed = ['apps/api/src/billing/charge.mjs'];
  const down = byId(planChecks({ profile: p, level: 'paranoid', changed }), 'integration:api');
  assert.match(down.skipReason, /^Not run: start the reliability containers yourself/);
  assert.deepEqual(down.missingPorts, [55001]);
  const up = byId(planChecks({ profile: p, level: 'paranoid', changed, listening: [55001] }), 'integration:api');
  assert.equal(up.skipReason, undefined);
  assert.equal(up.group, 'G4');
  const web = byId(planChecks({ profile: p, level: 'paranoid', changed: ['apps/web/src/a.mjs'], listening: [55001] }), 'integration:api');
  assert.equal(web.skipReason, 'Not run: apps/api unchanged');
  assert.equal(byId(planChecks({ profile: p, level: 'standard', changed, listening: [55001] }), 'integration:api'), undefined);
});

test('everything: every workspace, full runs', () => {
  const plan = planChecks({ profile: checkProfile(), level: 'standard', what: 'everything' });
  assert.deepEqual(ids(plan).sort(), ['lint:web', 'test:api', 'test:root', 'test:web', 'types:api', 'types:web'].sort());
  for (const item of plan) {
    assert.equal(item.files, undefined, item.id);
    assert.equal(item.skipReason, undefined, item.id);
  }
});

test('planChecks refuses an unknown level or group', () => {
  assert.throws(() => planChecks({ profile: checkProfile(), level: 'nope' }), /no check level "nope"/);
  const p = checkProfile({ levels: { quick: { groups: ['G0', 'G7'] } } });
  assert.throws(() => planChecks({ profile: p, level: 'quick', changed: ['a'] }), /group G7, which the profile does not define/);
  assert.throws(() => planChecks({ level: 'quick' }), /needs a profile/);
});

// ---------------------------------------------------------------------------------------------
// File lists and command lines

test('expandFiles: roots and pattern, list, only, folders; node_modules and missing files left out', async t => {
  const { dir } = await exampleCheckRepo(t);
  setFile(dir, 'apps/api/src/node_modules/pkg/x.test.mjs', passing('hidden'));
  const p = checkProfile();
  assert.deepEqual(await expandFiles(p.commands['test:api'], { tree: dir }), [
    'apps/api/src/auth/session.test.mjs', 'apps/api/src/billing/charge.test.mjs',
  ]);
  assert.deepEqual(await expandFiles(p.commands['test:root'], { tree: dir }), ['scripts/tool.test.mjs']);
  assert.deepEqual(await expandFiles(p.commands['test:api'], { tree: dir, only: ['apps/api/src/billing/charge.test.mjs', 'apps/api/src/billing/charge.mjs', 'apps/api/src/nope.test.mjs', '../x.test.mjs'] }), [
    'apps/api/src/billing/charge.test.mjs',
  ]);
  assert.deepEqual(await expandFiles(p.commands['test:api'], { tree: dir, only: [], folders: ['apps/api/src/auth'] }), ['apps/api/src/auth/session.test.mjs']);
  assert.deepEqual(await expandFiles(p.commands['format:changed'], { tree: dir, only: ['README.md', 'scripts/tool.mjs'] }), ['scripts/tool.mjs']);
  assert.deepEqual(await expandFiles(p.commands['format:changed'], { tree: dir }), []);
  await assert.rejects(expandFiles(p.commands['test:api'], {}), /needs the tree/);
});

test('commandArgv fills placeholders; files are relative to the cwd', async t => {
  const { dir } = await exampleCheckRepo(t);
  const p = checkProfile();
  const cwdAbs = join(dir, 'apps', 'web');
  const argv = commandArgv(p.commands['lint:web'], { tree: dir, cwdAbs, files: ['apps/web/src/features/cart/total.mjs'] });
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], join(dir, 'node_modules', 'fake-eslint', 'cli.mjs'));
  assert.deepEqual(argv.slice(2), ['--format', 'json', 'src/features/cart/total.mjs']);
  assert.deepEqual(commandArgv(p.commands['lint:web'], { tree: dir, cwdAbs }).slice(2), ['--format', 'json'], 'no files: {files} is left out');
  const withBase = { argv: ['{node}', '-e', '0', '{base}', '{tree}'] };
  assert.deepEqual(commandArgv(withBase, { tree: dir, cwdAbs: dir, base: 'abc1234' }).slice(3), ['abc1234', dir]);
  assert.throws(() => commandArgv(withBase, { tree: dir, cwdAbs: dir }), /needs the base commit/);
  assert.throws(() => commandArgv({ argv: ['{node}', '{pkg:missing/cli.js}'] }, { tree: dir, cwdAbs: dir }), /missing\/cli\.js is not installed in this tree/);
  assert.throws(() => commandArgv({ argv: ['{nope}'] }, { tree: dir, cwdAbs: dir }), /must start with \{node\}/);
  assert.throws(() => commandArgv({ argv: ['{node}', '{weird}'] }, { tree: dir, cwdAbs: dir }), /not a placeholder/);
});

test('displayCommand is short and names the file count', () => {
  const p = checkProfile();
  assert.equal(displayCommand(p.commands['test:api'], { fileCount: 109 }), 'node --test --test-reporter=tap (109 files)');
  assert.equal(displayCommand(p.commands['types:api']), 'node fake-tsc');
  assert.equal(displayCommand(p.commands['lint:web'], { fileCount: 1 }), 'node fake-eslint --format json (1 file)');
});

// ---------------------------------------------------------------------------------------------
// Parsers

test('tsc errors: identity without line or column; a project-wide error; redaction', () => {
  const key = secretKey();
  const text = [
    'src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'src\\b.ts(10,1): error TS2304: Cannot find name \'x\'.',
    `src/c.ts(1,1): error TS2551: Property '${key}' does not exist.`,
    'error TS5083: Cannot read file \'tsconfig.base.json\'.',
    'Found 4 errors.',
  ].join('\r\n');
  const errors = parseTscOutput(text, { redact: s => s.replace(key, 'sk_l…[redacted]') });
  assert.equal(errors.length, 4);
  assert.equal(errors[0].id, "src/a.ts::TS2322::Type 'string' is not assignable to type 'number'.");
  assert.equal(errors[0].id, typeErrorId({ file: 'src/a.ts', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }));
  assert.equal(errors[0].line, 3);
  assert.equal(errors[1].file, 'src/b.ts');
  assert.ok(!JSON.stringify(errors).includes(key), 'the key never reaches an identity or message');
  assert.equal(errors[3].id, "(project)::TS5083::Cannot read file 'tsconfig.base.json'.");
  const moved = parseTscOutput('src/a.ts(40,9): error TS2322: Type \'string\' is not assignable to type \'number\'.');
  assert.equal(moved[0].id, errors[0].id, 'moving the code keeps the identity');
});

test('ESLint JSON: errors with identities, warnings counted, junk refused', () => {
  const cwd = join('C:\\repo', 'apps', 'web');
  const json = JSON.stringify([
    { filePath: join(cwd, 'src', 'a.mjs'), messages: [
      { ruleId: 'no-unused-vars', severity: 2, message: "'x' is   defined but never used.", line: 3, column: 7 },
      { ruleId: 'eqeqeq', severity: 1, message: 'Expected ===.', line: 4, column: 1 },
      { ruleId: null, severity: 2, message: 'Parsing error: Unexpected token', line: 9, column: 2 },
    ] },
  ]);
  const r = parseEslintJson(`Some banner line\n${json}`, { cwdAbs: cwd });
  assert.equal(r.ok, true);
  assert.equal(r.warnings, 1);
  assert.deepEqual(r.errors.map(e => e.id), [
    lintErrorId({ file: 'src/a.mjs', ruleId: 'no-unused-vars', message: "'x' is defined but never used." }),
    lintErrorId({ file: 'src/a.mjs', ruleId: null, message: 'Parsing error: Unexpected token' }),
  ]);
  assert.ok(r.errors[0].id.startsWith('src/a.mjs::no-unused-vars::'), r.errors[0].id);
  assert.equal(parseEslintJson('Oops, the config is broken').ok, false);
});

test('keyedErrors numbers repeats the way the baseline does', () => {
  const keyed = keyedErrors([{ id: 'b' }, { id: 'a' }, { id: 'a' }]);
  assert.deepEqual(keyed.map(e => e.key), ['a', 'a (2)', 'b']);
});

test('Prettier --check lines name the unformatted files', () => {
  assert.deepEqual(parsePrettierCheck('Checking formatting...\n[warn] src/a.ts\n[warn] docs\\b.md\n[warn] Code style issues found in 2 files. Run Prettier with --write to fix.\n'), ['src/a.ts', 'docs/b.md']);
});

test('tapRows reads the TAP parser\'s shape', () => {
  const rows = tapRows({ tests: [{ id: 'f::a', file: 'f', status: 'fail', failure: { kind: 'assertion', message: 'm' } }, { id: 'g::b', status: 'pass' }] });
  assert.deepEqual(rows, [
    { id: 'f::a', file: 'f', status: 'fail', kind: 'assertion', message: 'm' },
    { id: 'g::b', file: '(unknown)', status: 'pass', kind: '', message: '' },
  ]);
  assert.ok(perFileLimit({}) >= 1 && perFileLimit({}) <= 4);
  assert.equal(perFileLimit({ concurrency: 1 }), 1);
});

// ---------------------------------------------------------------------------------------------
// runCommand with real processes

test('a test command: TAP parsed, logs and pids.json written, TEMP set', async t => {
  const { dir } = await exampleCheckRepo(t);
  setFile(dir, 'apps/api/src/billing/new.test.mjs', failing('new fails', 'expected one to be two'));
  const gateDir = join(tempDir('wp4-gate-', t), 'runs', 'example', 'r1', 'gates', '06-checks');
  const r = await runCommand({ profile: checkProfile(), commandId: 'test:api', tree: dir, gateDir });
  assert.equal(r.status, 'fail');
  assert.equal(r.reason, '1 failing test');
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.counts, { pass: 2, fail: 1, skip: 0, todo: 0 });
  assert.equal(r.fileCount, 3);
  assert.equal(r.command, 'node --test --test-reporter=tap (3 files)');
  const failed = tapRows(r.tap).filter(x => x.status === 'fail');
  assert.deepEqual(failed.map(x => [x.id, x.kind]), [['src/billing/new.test.mjs::new fails', 'assertion']]);
  assert.match(failed[0].message, /expected one to be two/);
  assert.equal(r.log, 'test-api.log');
  assert.match(readFileSync(join(gateDir, r.log), 'utf8'), /^TAP version 13/);
  const pids = JSON.parse(readFileSync(join(gateDir, 'pids.json'), 'utf8'));
  assert.equal(pids.procs.length, 1);
  assert.equal(pids.procs[0].checkId, 'test:api');
  assert.equal(pids.procs[0].image.toLowerCase(), process.platform === 'win32' ? 'node.exe' : 'node');
  assert.ok(pids.procs[0].pid > 0 && pids.procs[0].startedAt > 0 && pids.procs[0].endedAt >= pids.procs[0].startedAt);
  assert.ok(existsSync(join(gateDir, '..', '..', 'tmp', '06-checks')), 'the check had its own TEMP folder in the run');
});

test('the check process sees only the scrubbed env (R9)', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const canary = `WP4_CANARY_${process.pid}`;
  const tmp = join(gateDir, 'own-tmp');
  setFile(dir, 'apps/api/src/env.test.mjs', testFile({
    'env is scrubbed': [
      `assert.equal(process.env[${JSON.stringify(canary)}], undefined, 'the canary leaked');`,
      "assert.equal(process.env.EXAMPLE_TEST_MODE, 'true');",
      "assert.equal(process.env.EXAMPLE_DB_URL, 'postgresql://test:test@127.0.0.1:1/example_test');",
      "assert.equal(process.env.NO_COLOR, '1');",
      "assert.equal(process.env.EXAMPLE_IT_DB_URL, undefined);",
      `assert.equal(process.env.TEMP, ${JSON.stringify(tmp)});`,
    ].join(' '),
  }));
  process.env[canary] = 'not-a-real-secret';
  try {
    const r = await runCommand({ profile: checkProfile(), commandId: 'test:api', tree: dir, gateDir, files: ['apps/api/src/env.test.mjs'], tmpDir: tmp });
    assert.equal(r.status, 'pass', `${r.reason}\n${JSON.stringify(tapRows(r.tap))}`);
    assert.deepEqual(r.counts, { pass: 1, fail: 0, skip: 0, todo: 0 });
  } finally {
    delete process.env[canary];
  }
});

test('types: fake tsc errors fail; a crash with no readable error is an error', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const p = checkProfile();
  assert.equal((await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir })).status, 'pass');
  setFile(dir, 'apps/api/type-errors.txt', 'src/billing/charge.mjs(1,14): error TS2322: Type string is not assignable to type number.\n');
  const r = await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir });
  assert.equal(r.status, 'fail');
  assert.equal(r.reason, '1 type error');
  assert.deepEqual(r.errors.map(e => e.id), ['src/billing/charge.mjs::TS2322::Type string is not assignable to type number.']);
  assert.equal(r.log, 'types-api-2.log', 'a second run in the same gate folder gets its own log');
  setFile(dir, 'apps/api/type-crash.txt', 'x');
  const crash = await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir });
  assert.equal(crash.status, 'error');
  assert.match(crash.reason, /exited with code 1 and printed no error it could read/);
  assert.match(crash.stderrTail, /something went wrong/);
});

test('lint: errors fail, warnings pass, a broken config is an error', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const p = checkProfile();
  setFile(dir, 'apps/web/src/a.mjs', 'export const a = 1; // LINT_ERROR(no-bad)\n');
  setFile(dir, 'apps/web/src/b.mjs', 'export const b = 1; // LINT_WARN(prefer-x)\n');
  const r = await runCommand({ profile: p, commandId: 'lint:web', tree: dir, gateDir, files: ['apps/web/src/a.mjs', 'apps/web/src/b.mjs'] });
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.errors.map(e => e.id), ['src/a.mjs::no-bad::no-bad is not allowed here.']);
  assert.equal(r.warnings, 1);
  const warn = await runCommand({ profile: p, commandId: 'lint:web', tree: dir, gateDir, files: ['apps/web/src/b.mjs'] });
  assert.equal(warn.status, 'pass');
  setFile(dir, 'apps/web/src/c.mjs', '// LINT_CRASH\n');
  const broken = await runCommand({ profile: p, commandId: 'lint:web', tree: dir, gateDir, files: ['apps/web/src/c.mjs'] });
  assert.equal(broken.status, 'error');
  assert.match(broken.reason, /ESLint did not finish \(exit code 2\)/);
});

test('format: unformatted files fail', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  setFile(dir, 'scripts/ugly.mjs', '// UNFORMATTED\n');
  const r = await runCommand({ profile: checkProfile(), commandId: 'format:changed', tree: dir, gateDir, files: ['scripts/ugly.mjs', 'scripts/tool.mjs'] });
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.errors.map(e => e.file), ['scripts/ugly.mjs']);
  const ok = await runCommand({ profile: checkProfile(), commandId: 'format:changed', tree: dir, gateDir, files: ['scripts/tool.mjs'] });
  assert.equal(ok.status, 'pass');
});

test('skips: no matching files, onlyTree run in the main checkout', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const p = checkProfile();
  const none = await runCommand({ profile: p, commandId: 'test:api', tree: dir, gateDir, files: ['apps/api/src/missing.test.mjs'] });
  assert.equal(none.status, 'skip');
  assert.equal(none.reason, 'Not run: no matching files');
  const main = await runCommand({ profile: p, commandId: 'install', tree: dir, gateDir, files: [], treeMode: 'main' });
  assert.equal(main.status, 'skip');
  assert.match(main.reason, /install runs only in the run worktree/);
  const run = await runCommand({ profile: p, commandId: 'install', tree: dir, gateDir, files: [], treeMode: 'run' });
  assert.equal(run.status, 'pass', run.reason);
  assert.equal(readdirSync(gateDir).filter(f => f.startsWith('test-api')).length, 0, 'a skipped command starts nothing');
});

test('errors: a missing package, a missing folder, an unknown command', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const p = checkProfile({ commands: { 'types:web': { argv: ['{node}', '{pkg:typescript/bin/tsc}', '--noEmit'] } } });
  const r = await runCommand({ profile: p, commandId: 'types:web', tree: dir, gateDir });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /typescript\/bin\/tsc is not installed in this tree/);
  const q = checkProfile({ commands: { 'types:api': { cwd: 'apps/missing' } } });
  assert.match((await runCommand({ profile: q, commandId: 'types:api', tree: dir, gateDir })).reason, /apps\/missing does not exist/);
  await assert.rejects(runCommand({ profile: p, commandId: 'nope', tree: dir, gateDir }), /no command "nope"/);
  await assert.rejects(runCommand({ profile: p, commandId: 'types:api', tree: dir }), /needs a gate folder/);
  await assert.rejects(rerunFiles({ profile: p, commandId: 'test:api', tree: dir, gateDir }), /at least one file/);
});

test('a timeout stops the process tree and is an error', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  setFile(dir, 'scripts/hang.mjs', 'setInterval(() => {}, 1000);\n');
  const p = checkProfile({ commands: { 'types:api': { cwd: '.', argv: ['{node}', 'scripts/hang.mjs'], timeoutSec: 1 } } });
  const started = Date.now();
  const r = await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'Timed out after 1 s');
  assert.ok(Date.now() - started < 15000);
});

test('cancel: an aborted signal stops the command', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  setFile(dir, 'scripts/hang.mjs', 'setInterval(() => {}, 1000);\n');
  const p = checkProfile({ commands: { 'types:api': { cwd: '.', argv: ['{node}', 'scripts/hang.mjs'], timeoutSec: 60 } } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const r = await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir, signal: ac.signal });
  assert.equal(r.status, 'cancelled');
  const before = new AbortController();
  before.abort();
  assert.equal((await runCommand({ profile: p, commandId: 'types:api', tree: dir, gateDir, signal: before.signal })).status, 'cancelled');
});

test('a long file list is split into parts and the results merged', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  for (let i = 1; i <= 5; i++) setFile(dir, `apps/api/src/many/m${i}.test.mjs`, i === 3 ? failing(`m${i}`) : passing(`m${i}`));
  const r = await runCommand({ profile: checkProfile(), commandId: 'test:api', tree: dir, gateDir, maxCmdLine: 120 });
  assert.ok(r.logs.length > 1, `expected several parts, got ${r.logs.join(', ')}`);
  assert.ok(r.logs.every(l => /^test-api\.part\d+\.log$/.test(l)));
  assert.equal(r.counts.fail, 1);
  assert.equal(r.counts.pass, 6);
  assert.equal(r.status, 'fail');
});

// A fake test runner that prints TAP with no file names and no locations, so the runner has to
// fall back to one file per invocation to know which file failed.
const NAMELESS_TAP = [
  "import { readFileSync } from 'node:fs';",
  'const files = process.argv.slice(2);',
  "const out = ['TAP version 13'];",
  'let fails = 0;',
  'files.forEach((f, i) => {',
  "  const bad = readFileSync(f, 'utf8').includes('FAIL_ME');",
  '  if (bad) fails++;',
  "  out.push('# Subtest: check', (bad ? 'not ok ' : 'ok ') + (i + 1) + ' - check', '  ---', '  duration_ms: 1', '  ...');",
  '});',
  "out.push('1..' + files.length);",
  "process.stdout.write(out.join('\\n') + '\\n');",
  'process.exit(fails ? 1 : 0);',
].join('\n');

test('a failing test without a file in the TAP makes the command run one file at a time', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  setFile(dir, 'scripts/nameless-tap.mjs', NAMELESS_TAP);
  setFile(dir, 'apps/api/src/a.test.mjs', '// ok\n');
  setFile(dir, 'apps/api/src/b.test.mjs', '// FAIL_ME\n');
  const p = checkProfile({ commands: { 'test:api': { argv: ['{node}', '../../scripts/nameless-tap.mjs', '{files}'] } } });
  const files = ['apps/api/src/a.test.mjs', 'apps/api/src/b.test.mjs'];
  const r = await runCommand({ profile: p, commandId: 'test:api', tree: dir, gateDir, files });
  assert.equal(r.perFile, true);
  assert.equal(r.status, 'fail');
  assert.deepEqual(tapRows(r.tap).filter(x => x.status === 'fail').map(x => x.id), ['src/b.test.mjs::check']);
  assert.ok(r.logs.every(l => /^test-api\.perfile\.f\d{3}\.log$/.test(l)), r.logs.join());
  const again = await runCommand({ profile: p, commandId: 'test:api', tree: dir, gateDir, files });
  assert.ok(again.logs.every(l => /^test-api\.f\d{3}(-\d+)?\.log$/.test(l)), `remembered for the process: ${again.logs.join()}`);
  const rr = await rerunFiles({ profile: p, commandId: 'test:api', tree: dir, gateDir, files: ['apps/api/src/b.test.mjs'], checkId: 'test:api' });
  assert.deepEqual(rr.logs, ['test-api.rerun1.f001.log']);
  assert.equal(rr.status, 'fail');
});

test('a test command whose output has no TAP at all is an error, not a pass', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  setFile(dir, 'scripts/silent.mjs', "process.stdout.write('all good, trust me\\n');\n");
  const p = checkProfile({ commands: { 'test:api': { argv: ['{node}', '../../scripts/silent.mjs', '{files}'] } } });
  const r = await runCommand({ profile: p, commandId: 'test:api', tree: dir, gateDir });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /printed no TAP results/);
});

test('secret-shaped text in a failure message is redacted', async t => {
  const { dir } = await exampleCheckRepo(t);
  const gateDir = tempDir('wp4-gate-', t);
  const key = secretKey();
  setFile(dir, 'apps/api/src/leak.test.mjs', failing('leaks', `the key is ${key}`));
  const r = await runCommand({ profile: checkProfile(), commandId: 'test:api', tree: dir, gateDir, files: ['apps/api/src/leak.test.mjs'] });
  assert.equal(r.status, 'fail');
  const msg = tapRows(r.tap)[0].message;
  assert.ok(!msg.includes(key), msg);
  assert.match(msg, /redacted/);
});
