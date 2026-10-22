// Tests for gates/tap.mjs: both TAP shapes, file and test identity, failure kinds, counts, YAML
// values, cut-off output, and message capping and redaction.
//
// The fixtures in test/fixtures/tap/ are real `node --test --test-reporter=tap` output from Node
// 24.11.1, run on synthetic files of the "example" project with the temp folder rewritten to
// C:\work\example. node20-files-wrapped.tap is the Node 20 shape (each file a top-level subtest
// named by its absolute path) built from the same single-file runs. node24-file-failure.tap is a
// file whose tests passed but whose process then failed (an error after a test ended).
//
// One test runs the real `node --test --test-reporter=tap` of the Node running this suite on tiny
// files in a temp folder, so the shape that Node prints today (wrapped on 20, located on 24) is
// checked live on each PC.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_TEST, MESSAGE_CAP, UNKNOWN_FILE, cleanMessage, parseTap, testId } from './tap.mjs';

const tempRoots = [];
after(() => { for (const d of tempRoots) rmSync(d, { recursive: true, force: true }); });

const FIXTURES = fileURLToPath(new URL('../test/fixtures/tap/', import.meta.url));
const fixture = name => readFileSync(`${FIXTURES}${name}`, 'utf8');
const CWD = 'C:\\work\\example';
const API = 'apps/api/src/billing/cents.test.mjs';
const WEB = 'apps/web/src/format.test.mjs';
const BOTH = [API, WEB];
const ids = r => r.tests.map(t => t.id);
const byId = (r, id) => r.tests.find(t => t.id === id);
const tap = lines => lines.join('\n');
const messages = r => r.parseErrors.map(e => e.message).join('\n');

const ALL_IDS = [
  `${API}::cents > adds cents`,
  `${API}::cents > rounds half up`,
  `${API}::cents > format > pads to two digits`,
  `${API}::totals a basket`,
  `${WEB}::formats dates > iso`,
  `${WEB}::formats dates > locale`,
  `${WEB}::labels > shows a label`,
  `${WEB}::labels > same name`,
  `${WEB}::labels > same name (2)`,
];
const FAILING = [`${API}::cents > rounds half up`, `${WEB}::formats dates > locale`, `${WEB}::labels > same name (2)`];

test('testId joins a posix file path and the names', () => {
  assert.equal(testId('src\\a\\b.test.ts', ['slots', 'returns tomorrow']), 'src/a/b.test.ts::slots > returns tomorrow');
  assert.equal(testId('x.test.mjs', 'one'), 'x.test.mjs::one');
});

test('Node 20: file-wrapped subtests give each test its file', () => {
  const r = parseTap(fixture('node20-files-wrapped.tap'), { files: BOTH, cwd: CWD });
  assert.deepEqual(ids(r), ALL_IDS);
  assert.deepEqual(r.counts, { pass: 6, fail: 3, skip: 0, todo: 0 });
  assert.equal(r.unknownFileTests, 0);
  assert.deepEqual(r.parseErrors, []);
  assert.deepEqual(r.files.map(f => [f.file, f.counts.pass, f.counts.fail, f.crashed]), [[API, 3, 1, false], [WEB, 3, 2, false]]);
  assert.equal(r.files[0].durationMs, 61.402, 'the wrapper duration is the file duration (to the microsecond)');
  assert.deepEqual(r.summary, { tests: 12, suites: 3, pass: 6, fail: 6, cancelled: 0, skipped: 0, todo: 0, durationMs: 130.2208 });
  const rounds = byId(r, `${API}::cents > rounds half up`);
  assert.equal(rounds.status, 'fail');
  assert.deepEqual(rounds.path, ['cents', 'rounds half up']);
  assert.equal(rounds.failure.kind, 'assertion');
  assert.equal(rounds.failure.code, 'ERR_ASSERTION');
  assert.equal(rounds.failure.location, `${API}:6:3`);
  assert.equal(rounds.failure.message, 'Expected values to be strictly equal:\n\n100 !== 101');
  assert.equal(rounds.failure.expected, '101');
  assert.equal(rounds.failure.actual, '100');
  assert.equal(byId(r, `${WEB}::formats dates > locale`).failure.kind, 'other');
  assert.equal(byId(r, `${WEB}::formats dates > locale`).failure.message, 'Locale data is missing for "xx"');
});

test('Node 24: failures are placed by their location; a passing top-level test without one is unknown', () => {
  const r = parseTap(fixture('node24-location.tap'), { files: BOTH, cwd: CWD });
  const unknown = `${UNKNOWN_FILE}::totals a basket`;
  assert.deepEqual(ids(r), ALL_IDS.map(id => (id === `${API}::totals a basket` ? unknown : id)));
  assert.equal(byId(r, `${API}::cents > adds cents`).status, 'pass', 'a passing child takes the file of its suite');
  assert.equal(r.unknownFileTests, 1);
  assert.match(messages(r), /1 test has no file .*one file per invocation/);
  assert.deepEqual(r.files.map(f => f.file), [API, UNKNOWN_FILE, WEB]);
  assert.deepEqual(r.counts, { pass: 6, fail: 3, skip: 0, todo: 0 });
});

test('identity is the same for Node 20, Node 24 one file at a time, and repeated parses', () => {
  const n20 = parseTap(fixture('node20-files-wrapped.tap'), { files: BOTH, cwd: CWD });
  const api = parseTap(fixture('node24-single-api.tap'), { files: [API], cwd: CWD });
  const web = parseTap(fixture('node24-single-web.tap'), { files: [WEB], cwd: CWD });
  assert.deepEqual([...ids(api), ...ids(web)], ids(n20));
  assert.deepEqual(api.tests.map(t => t.status), n20.tests.slice(0, 4).map(t => t.status));
  const n24 = parseTap(fixture('node24-location.tap'), { files: BOTH, cwd: CWD });
  const failing = r => r.tests.filter(t => t.status === 'fail').map(t => t.id);
  assert.deepEqual(failing(n24), FAILING);
  assert.deepEqual(failing(n20), FAILING);
  assert.deepEqual(parseTap(fixture('node24-location.tap'), { files: BOTH, cwd: CWD }), n24);
  const crlf = fixture('node20-files-wrapped.tap').replace(/\n/g, '\r\n');
  assert.deepEqual(parseTap(crlf, { files: BOTH, cwd: CWD }), n20);
});

test('ids are relative to the command cwd', () => {
  const r = parseTap(fixture('node20-files-wrapped.tap'), {
    files: ['src/billing/cents.test.mjs', '../web/src/format.test.mjs'], cwd: `${CWD}\\apps\\api`,
  });
  assert.equal(r.tests[0].id, 'src/billing/cents.test.mjs::cents > adds cents');
  assert.equal(r.tests[8].id, '../web/src/format.test.mjs::labels > same name (2)');
  assert.equal(byId(r, 'src/billing/cents.test.mjs::cents > rounds half up').failure.location, 'src/billing/cents.test.mjs:6:3');
});

test('files may be absolute, and match without regard to case on Windows', () => {
  const abs = parseTap(fixture('node20-files-wrapped.tap'), { files: [`${CWD}\\apps\\api\\src\\billing\\cents.test.mjs`, `${CWD}\\${WEB}`], cwd: CWD });
  assert.deepEqual(ids(abs), ALL_IDS);
  if (process.platform !== 'win32') return;
  const upper = parseTap(fixture('node24-single-api.tap'), { files: ['Apps/API/src/billing/cents.test.mjs'], cwd: 'c:\\WORK\\example' });
  assert.equal(upper.tests[0].id, 'Apps/API/src/billing/cents.test.mjs::cents > adds cents', 'the id keeps the spelling of `files`');
  const both = parseTap(fixture('node24-location.tap'), { files: ['APPS/API/src/billing/cents.test.mjs', WEB], cwd: CWD });
  assert.equal(both.tests[1].id, 'APPS/API/src/billing/cents.test.mjs::cents > rounds half up');
});

test('without a file list, wrappers, file-level failures and locations still give files', () => {
  const n20 = parseTap(fixture('node20-files-wrapped.tap'), { cwd: CWD });
  assert.deepEqual(ids(n20), ALL_IDS, 'absolute wrapper names are files');
  const n24 = parseTap(fixture('node24-location.tap'), { cwd: CWD });
  assert.equal(n24.tests[1].id, `${API}::cents > rounds half up`);
  assert.equal(n24.unknownFileTests, 1);
  const crash = parseTap(fixture('crash-import.tap'), { cwd: CWD });
  assert.equal(crash.tests[0].id, `apps/api/src/missing-import.test.mjs::${FILE_TEST}`, 'a name equal to its own location file is a file');
});

test('a single file run places every test in that file, even with helper locations', () => {
  const text = tap([
    'TAP version 13',
    '# Subtest: shared contract',
    'not ok 1 - shared contract',
    '  ---',
    "  location: 'C:\\\\work\\\\example\\\\apps\\\\api\\\\test\\\\helpers.mjs:12:3'",
    "  failureType: 'testCodeFailure'",
    "  error: 'boom'",
    '  ...',
    '1..1',
    '# tests 1',
  ]);
  const one = parseTap(text, { files: ['apps/api/src/contract.test.mjs'], cwd: CWD });
  assert.equal(one.tests[0].id, 'apps/api/src/contract.test.mjs::shared contract');
  assert.equal(one.tests[0].failure.location, 'apps/api/test/helpers.mjs:12:3');
  const two = parseTap(text, { files: ['apps/api/src/contract.test.mjs', 'apps/api/src/other.test.mjs'], cwd: CWD });
  assert.equal(two.tests[0].file, UNKNOWN_FILE, 'a location outside the listed files proves nothing');
});

test('Node 24: a file that cannot load is a crash at file level, with the error from stderr', () => {
  const files = ['apps/api/src/missing-import.test.mjs', 'apps/api/src/syntax.test.mjs', 'apps/api/src/ok.test.mjs'];
  const r = parseTap(fixture('crash-import.tap'), { files, cwd: CWD });
  const missing = byId(r, `apps/api/src/missing-import.test.mjs::${FILE_TEST}`);
  const syntax = byId(r, `apps/api/src/syntax.test.mjs::${FILE_TEST}`);
  assert.equal(missing.type, 'file');
  assert.equal(missing.failure.kind, 'crash');
  assert.match(missing.failure.message, /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
  assert.equal(syntax.failure.kind, 'crash');
  assert.equal(syntax.failure.message, "SyntaxError: Unexpected token '='");
  assert.deepEqual(r.files.filter(f => f.crashed).map(f => f.file), files.slice(0, 2));
  assert.deepEqual(r.counts, { pass: 1, fail: 2, skip: 0, todo: 0 });
});

test('Node 20: a wrapper failure is a crash without passing tests, otherwise other', () => {
  const wrapper = (name, inner, yaml, comments = []) => [
    ...comments,
    `# Subtest: C:\\\\work\\\\example\\\\apps\\\\api\\\\src\\\\${name}`,
    ...inner,
    `not ok 1 - C:\\\\work\\\\example\\\\apps\\\\api\\\\src\\\\${name}`,
    '  ---', '  duration_ms: 40.5', ...yaml, '  ...',
  ];
  const own = ["  failureType: 'testCodeFailure'", '  exitCode: 1', '  signal: ~', "  error: 'test failed'", "  code: 'ERR_TEST_FAILURE'"];
  const passing = ['    # Subtest: works', '    ok 1 - works', '      ---', '      duration_ms: 0.4', '      ...', '    1..1'];
  const crashed = parseTap(tap(['TAP version 13', ...wrapper('a.test.mjs', [], own, [
    "# Error [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension \".ts\" for C:\\\\work\\\\example\\\\apps\\\\api\\\\src\\\\a.test.ts",
  ]), '1..1', '# tests 1']), { files: ['apps/api/src/a.test.mjs'], cwd: CWD });
  assert.deepEqual(ids(crashed), [`apps/api/src/a.test.mjs::${FILE_TEST}`]);
  assert.equal(crashed.tests[0].failure.kind, 'crash');
  assert.match(crashed.tests[0].failure.message, /^Error \[ERR_UNKNOWN_FILE_EXTENSION\]/);
  assert.equal(crashed.files[0].crashed, true);

  const late = parseTap(tap(['TAP version 13', ...wrapper('b.test.mjs', passing, own), '1..1', '# tests 2']), { files: ['apps/api/src/b.test.mjs'], cwd: CWD });
  assert.deepEqual(ids(late), ['apps/api/src/b.test.mjs::works', `apps/api/src/b.test.mjs::${FILE_TEST}`]);
  assert.equal(late.tests[1].failure.kind, 'other', 'tests passed, so the file did load');
  assert.equal(late.tests[1].failure.message, 'test failed');

  const lateSyntax = parseTap(tap(['TAP version 13', ...wrapper('c.test.mjs', passing, own, ['# SyntaxError: Unexpected end of input']), '1..1', '# tests 2']), {
    files: ['apps/api/src/c.test.mjs'], cwd: CWD,
  });
  assert.equal(lateSyntax.tests[1].failure.kind, 'crash', 'a SyntaxError is a crash even after passes');

  const subtests = ["  failureType: 'subtestsFailed'", "  error: '1 subtest failed'", "  code: 'ERR_TEST_FAILURE'"];
  const failingChild = ['    # Subtest: breaks', '    not ok 1 - breaks', '      ---', "      failureType: 'testCodeFailure'", "      error: 'x'", '      ...', '    1..1'];
  const plain = parseTap(tap(['TAP version 13', ...wrapper('d.test.mjs', failingChild, subtests), '1..1', '# tests 2']), { files: ['apps/api/src/d.test.mjs'], cwd: CWD });
  assert.deepEqual(ids(plain), ['apps/api/src/d.test.mjs::breaks'], 'a wrapper failing only because of a subtest adds no file-level failure');
});

test('Node 24: a file failing after its tests passed is a file-level failure with the error Node printed', () => {
  const f = 'apps/api/src/late-timer.test.mjs';
  const r = parseTap(fixture('node24-file-failure.tap'), { files: [f], cwd: CWD });
  assert.deepEqual(r.tests.map(t => [t.id, t.status, t.type]), [
    [`${f}::leaves a timer`, 'pass', 'test'],
    [`${f}::second`, 'pass', 'test'],
    [`${f}::${FILE_TEST}`, 'fail', 'file'],
  ]);
  const file = r.tests[2].failure;
  assert.equal(file.kind, 'other', 'its tests passed, so the file did load');
  assert.match(file.message, /^Error: Test "leaves a timer" at apps\\api\\src\\late-timer\.test\.mjs:2:1 generated asynchronous activity/);
  assert.equal(file.location, `${f}:1:1`);
  assert.deepEqual(r.files.map(x => [x.file, x.counts.pass, x.counts.fail, x.crashed]), [[f, 2, 1, false]]);
  assert.deepEqual(r.parseErrors, []);
});

test('Node 24: a file with no tests reports a pass named by its path, which adds no test', () => {
  const text = tap([
    'TAP version 13',
    '# Subtest: apps\\\\api\\\\src\\\\empty.test.mjs',
    'ok 1 - apps\\\\api\\\\src\\\\empty.test.mjs',
    '  ---', '  duration_ms: 42.0363', "  type: 'test'", '  ...',
    '1..1', '# tests 1', '# pass 1',
  ]);
  const r = parseTap(text, { files: ['apps/api/src/empty.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests, []);
  assert.deepEqual(r.parseErrors, []);
  assert.deepEqual(r.counts, { pass: 0, fail: 0, skip: 0, todo: 0 });
});

test('Node 20: a file wrapper named by a relative path works too', () => {
  const text = tap([
    'TAP version 13',
    '# Subtest: apps\\\\api\\\\src\\\\billing\\\\cents.test.mjs',
    '    # Subtest: adds cents', '    ok 1 - adds cents', '      ---', '      duration_ms: 0.4', '      ...',
    '    1..1',
    'ok 1 - apps\\\\api\\\\src\\\\billing\\\\cents.test.mjs', '  ---', '  duration_ms: 50.1', '  ...',
    '1..1', '# tests 1',
  ]);
  const r = parseTap(text, { files: [API], cwd: CWD });
  assert.deepEqual(ids(r), [`${API}::adds cents`]);
  assert.equal(r.files[0].durationMs, 50.1);
});

test('test-level kinds from real output: JSON.parse SyntaxError is other, a missing import is crash', () => {
  const r = parseTap(tap([
    'TAP version 13',
    'not ok 1 - json parse', '  ---', "  failureType: 'testCodeFailure'",
    "  error: \"Expected property name or '}' in JSON at position 1 (line 1 column 2)\"", "  code: 'ERR_TEST_FAILURE'", "  name: 'SyntaxError'", '  ...',
    'not ok 2 - missing import', '  ---', "  failureType: 'testCodeFailure'",
    "  error: \"Cannot find module 'C:\\\\work\\\\example\\\\not-there.mjs'\"", "  code: 'ERR_MODULE_NOT_FOUND'", '  ...',
    'not ok 3 - rejects', '  ---', "  failureType: 'testCodeFailure'", "  error: 'Missing expected rejection.'",
    "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", "  operator: 'rejects'", '  ...',
    'not ok 4 - assertion in a hook', '  ---', "  failureType: 'hookFailed'", "  error: 'x'", "  code: 'ERR_ASSERTION'", '  ...',
    'not ok 5 - cancelled', '  ---', "  failureType: 'cancelledByParent'", "  error: 'test did not finish before its parent and was cancelled'", '  ...',
    '1..5', '# tests 5',
  ]), { files: ['a.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests.map(t => t.failure.kind), ['other', 'crash', 'assertion', 'hook', 'other']);
  assert.equal(r.tests[0].failure.errorName, 'SyntaxError');
  assert.equal(r.tests[1].failure.message, "Cannot find module 'C:\\work\\example\\not-there.mjs'");
});

test('escaped names: backslashes, hashes and escaped control characters', () => {
  const r = parseTap(tap([
    'TAP version 13',
    'ok 1 - a \\\\ b \\# c',
    'ok 2 - looks like \\# SKIP but is not',
    'not ok 3 - tab\\\\there',
    '1..3', '# tests 3',
  ]), { files: ['a.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests.map(t => [t.name, t.status]), [
    ['a \\ b # c', 'pass'],
    ['looks like # SKIP but is not', 'pass'],
    ['tab\\there', 'fail'],
  ]);
});

test('skip and todo directives, reasons and escaped names', () => {
  const r = parseTap(fixture('skip-todo.tap'), { files: ['apps/api/src/skip-todo.test.mjs'], cwd: CWD });
  const f = 'apps/api/src/skip-todo.test.mjs';
  assert.deepEqual(r.tests.map(t => [t.name, t.status, t.reason || '']), [
    ['skipped', 'skip', ''],
    ['skipped with reason', 'skip', 'needs the reliability containers'],
    ['todo', 'todo', ''],
    ['todo that fails', 'todo', 'not built yet'],
    ['skips at runtime', 'skip', 'no database'],
    ['passes # with a hash', 'pass', ''],
  ]);
  assert.equal(r.tests[5].id, `${f}::passes # with a hash`);
  assert.equal(r.tests[3].failure, undefined, 'a failing todo is not a failure');
  assert.deepEqual(r.counts, { pass: 1, fail: 0, skip: 3, todo: 2 });
  assert.equal(r.summary.skipped, 3);
});

test('a timeout is kind timeout', () => {
  const r = parseTap(fixture('timeout.tap'), { files: ['apps/api/src/timeout.test.mjs'], cwd: CWD });
  const t = byId(r, 'apps/api/src/timeout.test.mjs::waits too long');
  assert.equal(t.failure.kind, 'timeout');
  assert.equal(t.failure.failureType, 'testTimeoutFailure');
  assert.equal(t.failure.message, 'test timed out after 50ms');
  assert.deepEqual(r.counts, { pass: 1, fail: 1, skip: 0, todo: 0 });
  assert.equal(r.summary.cancelled, 1, "Node's own summary counts the timeout as cancelled");
});

test('hook failures: the suite fails as hook, cancelled tests fail as other', () => {
  const f = 'apps/api/src/hook.test.mjs';
  const r = parseTap(fixture('hook.tap'), { files: [f], cwd: CWD });
  assert.deepEqual(r.tests.map(t => [t.id, t.failure.kind, t.type]), [
    [`${f}::with a broken before > first`, 'other', 'test'],
    [`${f}::with a broken before > second`, 'other', 'test'],
    [`${f}::with a broken before`, 'hook', 'suite'],
    [`${f}::with a broken beforeEach > third`, 'hook', 'test'],
  ]);
  assert.equal(r.tests[0].failure.failureType, 'cancelledByParent');
  assert.equal(r.tests[2].failure.message, 'setup failed');
  assert.equal(byId(r, `${f}::with a broken beforeEach`), undefined, 'a suite failing only through a subtest is not counted twice');
});

test('which results count: leaves, failed or skipped empty suites, parents failing on their own', () => {
  const r = parseTap(tap([
    'TAP version 13',
    '# Subtest: skipped suite', 'ok 1 - skipped suite # SKIP', '  ---', "  type: 'suite'", '  ...',
    '# Subtest: empty suite', 'ok 2 - empty suite', '  ---', "  type: 'suite'", '  ...',
    '# Subtest: throws in body', 'not ok 3 - throws in body', '  ---', "  type: 'suite'", "  failureType: 'testCodeFailure'", "  error: 'body boom'", '  ...',
    '# Subtest: fails after subtests',
    '    # Subtest: child', '    ok 1 - child', '      ---', "      type: 'test'", '      ...', '    1..1',
    'not ok 4 - fails after subtests', '  ---', "  type: 'test'", "  failureType: 'testCodeFailure'", "  error: 'after'", '  ...',
    '1..4', '# tests 3',
  ]), { files: ['a.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests.map(t => [t.id, t.status]), [
    ['a.test.mjs::skipped suite', 'skip'],
    ['a.test.mjs::throws in body', 'fail'],
    ['a.test.mjs::fails after subtests > child', 'pass'],
    ['a.test.mjs::fails after subtests', 'fail'],
  ]);
});

test('YAML values: inspect quoting, block scalars, nested values, numbers and null', () => {
  const r = parseTap(tap([
    'TAP version 13',
    'not ok 1 - quoted',
    '  ---',
    '  duration_ms: 1.5',
    "  failureType: 'testCodeFailure'",
    "  error: 'it\\'s \\x41\\u00e9\\u{1F600}\\n\\\\done'",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    '  expected:',
    '    a: 2',
    '    list:',
    "      - 'x'",
    '  actual: ~',
    '  ...',
    'not ok 2 - double',
    '  ---',
    '  error: "say \\"hi\\" isn\'t it"',
    '  ...',
    'not ok 3 - block',
    '  ---',
    '  error: |-',
    '    first line',
    '    ',
    '      indented',
    '    last',
    '  ...',
    "not ok 4 - yaml quotes",
    '  ---',
    "  error: 'it''s'",
    '  ...',
    '1..4',
    '# tests 4',
  ]), { files: ['a.test.mjs'], cwd: CWD });
  const [q, d, b, y] = r.tests;
  assert.equal(q.durationMs, 1.5);
  assert.equal(q.failure.message, "it's Aé\u{1F600}\n\\done");
  assert.equal(q.failure.kind, 'assertion');
  assert.equal(q.failure.expected, "a: 2\nlist:\n  - 'x'");
  assert.equal(q.failure.actual, 'null');
  assert.equal(d.failure.message, 'say "hi" isn\'t it');
  assert.equal(b.failure.message, 'first line\n\n  indented\nlast');
  assert.equal(y.failure.message, "it's");
});

test('output cut off mid-run keeps the finished tests and says what is missing', () => {
  const full = fixture('node24-single-api.tap');
  const cutAt = full.indexOf('    1..1');
  const r = parseTap(full.slice(0, cutAt), { files: [API], cwd: CWD });
  assert.deepEqual(ids(r), [`${API}::cents > adds cents`, `${API}::cents > rounds half up`, `${API}::cents > format > pads to two digits`]);
  const text = messages(r);
  assert.match(text, /ended before "format" finished/);
  assert.match(text, /ended before "cents" finished/);
  assert.match(text, /no summary at the end/);

  const inYaml = parseTap(full.slice(0, full.indexOf("operator: 'strictEqual'")), { files: [API], cwd: CWD });
  assert.match(messages(inYaml), /ended inside the YAML block/);
  assert.equal(byId(inYaml, `${API}::cents > rounds half up`).failure.kind, 'assertion');

  const leaf = parseTap(tap(['TAP version 13', '# Subtest: hangs']), { files: [API], cwd: CWD });
  assert.deepEqual(leaf.tests.map(t => [t.id, t.status, t.failure.kind]), [[`${API}::hangs`, 'fail', 'crash']]);
  assert.match(leaf.tests[0].failure.message, /ended before this test finished/);
});

test('plan mismatches, bail outs and empty output are parse errors', () => {
  const r = parseTap(tap(['TAP version 13', 'ok 1 - a', 'Bail out! database is down', '1..3', '# tests 1']), { files: ['a.test.mjs'], cwd: CWD });
  assert.match(messages(r), /plan says 3 top-level tests but 1 were reported/);
  assert.match(messages(r), /bailed out: database is down/);
  assert.deepEqual(parseTap('', { cwd: CWD }).parseErrors.map(e => e.message), ['There is no TAP output.']);
  assert.deepEqual(parseTap('plain text from a crash\n', { cwd: CWD }).tests, []);
});

test('repeated names in one file get numbered ids', () => {
  const r = parseTap(tap(['TAP version 13', 'ok 1 - same', 'not ok 2 - same', 'ok 3 - same', '1..3', '# tests 3']), { files: ['a.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests.map(t => [t.id, t.dup || 1]), [['a.test.mjs::same', 1], ['a.test.mjs::same (2)', 2], ['a.test.mjs::same (3)', 3]]);
});

// Top-level tests of src/a.test.mjs in the Node 24 shape: [name, passed]. As in real output, only
// a failure carries a location, so in a run of several files a pass can't be placed.
function topLevelTap(results) {
  const lines = ['TAP version 13'];
  results.forEach(([name, passed], i) => {
    lines.push(`# Subtest: ${name}`, `${passed ? 'ok' : 'not ok'} ${i + 1} - ${name}`, '  ---', '  duration_ms: 0.2', "  type: 'test'");
    if (!passed) {
      lines.push(`  location: 'C:\\\\work\\\\example\\\\src\\\\a.test.mjs:${i + 3}:1'`, "  failureType: 'testCodeFailure'",
        "  error: 'Expected 1 to be 2'", "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'");
    }
    lines.push('  ...');
  });
  const failed = results.filter(r => !r[1]).length;
  lines.push(`1..${results.length}`, `# tests ${results.length}`, `# pass ${results.length - failed}`, `# fail ${failed}`);
  return tap(lines);
}

test('a placed test whose name repeats an earlier unplaced one counts as unplaced', () => {
  const files = ['src/a.test.mjs', 'src/b.test.mjs'];
  const text = topLevelTap([['same', true], ['same', false], ['other', true]]);
  const multi = parseTap(text, { files, cwd: CWD });
  // One file at a time, the same tests are 'same' (pass) and 'same (2)' (fail): the multi-file
  // parse must not call the failure 'src/a.test.mjs::same', the id of the pass.
  const single = parseTap(text, { files: ['src/a.test.mjs'], cwd: CWD });
  assert.deepEqual(single.tests.map(t => [t.id, t.status]),
    [['src/a.test.mjs::same', 'pass'], ['src/a.test.mjs::same (2)', 'fail'], ['src/a.test.mjs::other', 'pass']]);
  assert.deepEqual(multi.tests.map(t => [t.id, t.file, t.status]), [
    [`${UNKNOWN_FILE}::same`, UNKNOWN_FILE, 'pass'],
    [`${UNKNOWN_FILE}::same (2)`, UNKNOWN_FILE, 'fail'],
    [`${UNKNOWN_FILE}::other`, UNKNOWN_FILE, 'pass'],
  ]);
  assert.equal(multi.tests[1].failure.location, 'src/a.test.mjs:4:1', 'the failure still says where it is');
  assert.ok(multi.tests.some(t => t.status === 'fail' && t.file === UNKNOWN_FILE), 'the runner sees a failure without a file and reruns per file');
  assert.equal(multi.unknownFileTests, 3);
  assert.match(messages(multi), /2 tests have no file/);
  assert.match(messages(multi), /1 test has the name of an earlier test with no file .*repeat number/);
  for (const t of multi.tests) {
    if (t.file !== UNKNOWN_FILE) assert.equal(byId(single, t.id)?.status, t.status, `${t.id} means the same test in both parses`);
  }
});

test('a repeat that comes only after a placed test leaves it placed', () => {
  // The failure comes first: no earlier test shares its name, so its number is 1 in any run.
  const text = topLevelTap([['first', true], ['same', false], ['same', true]]);
  const r = parseTap(text, { files: ['src/a.test.mjs', 'src/b.test.mjs'], cwd: CWD });
  assert.deepEqual(r.tests.map(t => t.id), [`${UNKNOWN_FILE}::first`, 'src/a.test.mjs::same', `${UNKNOWN_FILE}::same`]);
  assert.doesNotMatch(messages(r), /repeat number/);
  const wrapped = parseTap(fixture('node20-files-wrapped.tap'), { files: BOTH, cwd: CWD });
  assert.equal(byId(wrapped, `${WEB}::labels > same name (2)`).file, WEB, 'file-wrapped repeats stay placed');
});

test('messages are redacted and capped at 2 KB', () => {
  const key = 'sk_' + 'live_' + 'x'.repeat(24);
  const long = `${key} ${'y'.repeat(5000)}`;
  const r = parseTap(tap([
    'TAP version 13',
    'not ok 1 - leaks',
    '  ---',
    `  error: '${long}'`,
    `  expected: '${key}'`,
    `  actual: 'fine'`,
    '  ...',
    '1..1',
    '# tests 1',
  ]), { files: ['a.test.mjs'], cwd: CWD });
  const f = r.tests[0].failure;
  assert.ok(!f.message.includes(key), 'the key is redacted in the message');
  assert.ok(!f.expected.includes(key), 'the key is redacted in expected');
  assert.ok(f.message.startsWith('sk_l'), 'the first four characters stay');
  assert.ok(f.message.length <= MESSAGE_CAP + 40, `capped (${f.message.length})`);
  assert.match(f.message, /cut at 2048 characters/);
  assert.equal(f.actual, 'fine');
});

test('a custom redactor and allow list are used', () => {
  const seen = [];
  const redact = (text, { allow }) => { seen.push(allow); return text.replace(/secret/g, '[gone]'); };
  const r = parseTap(tap(['TAP version 13', 'not ok 1 - x', '  ---', "  error: 'a secret here'", '  ...', '1..1', '# tests 1']), {
    files: ['a.test.mjs'], cwd: CWD, redact, allow: ['ok-value'],
  });
  assert.equal(r.tests[0].failure.message, 'a [gone] here');
  assert.deepEqual(seen[0], ['ok-value']);
  assert.equal(cleanMessage('x'.repeat(10), { cap: 4 }), 'xxxx… (cut at 4 characters)');
  assert.equal(cleanMessage(null), '');
  assert.equal(cleanMessage({ a: 1 }), '{"a":1}');
});

// ---- live: the TAP this Node prints -----------------------------------------------------------

// Runs `node --test --test-reporter=tap <files>` in `cwd` and returns its stdout. The runner marks
// its own children with NODE_TEST_CONTEXT; a nested runner that inherits it would not print TAP.
function nodeTap(cwd, files) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODE_TEST_CONTEXT') delete env[k];
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', () => resolveP(out));
  });
}

test(`live: Node ${process.versions.node} output gives the same ids per file and in one invocation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp3-tap-live-'));
  tempRoots.push(dir);
  const api = 'apps/api/src/sum.test.mjs';
  const web = 'apps/web/src/label.test.mjs';
  mkdirSync(join(dir, 'apps', 'api', 'src'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'web', 'src'), { recursive: true });
  writeFileSync(join(dir, api), [
    "import { describe, it, test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "describe('sum', () => {",
    "  it('adds', () => assert.equal(1 + 1, 2));",
    "  it('rounds', () => assert.equal(100, 101));",
    '});',
    "test('top level passes', () => {});",
    "test('skipped', { skip: 'not here' }, () => {});",
    "test('same', () => {});",
    "test('same', () => assert.equal(1, 2));",
    '',
  ].join('\n'));
  writeFileSync(join(dir, web), [
    "import { test } from 'node:test';",
    "test('label', async t => {",
    "  await t.test('shows', () => {});",
    "  await t.test('breaks', () => { throw new Error('no label'); });",
    '});',
    "test('times out', { timeout: 20 }, () => new Promise(r => setTimeout(r, 400)));",
    '',
  ].join('\n'));
  const files = [api, web];
  const [both, onlyApi, onlyWeb] = await Promise.all([nodeTap(dir, files), nodeTap(dir, [api]), nodeTap(dir, [web])]);
  const multi = parseTap(both, { files, cwd: dir });
  const single = [parseTap(onlyApi, { files: [api], cwd: dir }), parseTap(onlyWeb, { files: [web], cwd: dir })];
  const perFile = single.flatMap(r => r.tests);

  for (const r of [multi, ...single]) {
    assert.ok(r.summary, `there is a summary:\n${r === multi ? both : ''}`);
    // Both warnings about tests without a file say "no file in the TAP output".
    assert.deepEqual(r.parseErrors.filter(e => !/no file in the TAP output/.test(e.message)), []);
  }
  assert.deepEqual(perFile.map(t => [t.id, t.status, t.failure ? t.failure.kind : '']), [
    [`${api}::sum > adds`, 'pass', ''],
    [`${api}::sum > rounds`, 'fail', 'assertion'],
    [`${api}::top level passes`, 'pass', ''],
    [`${api}::skipped`, 'skip', ''],
    [`${api}::same`, 'pass', ''],
    [`${api}::same (2)`, 'fail', 'assertion'],
    [`${web}::label > shows`, 'pass', ''],
    [`${web}::label > breaks`, 'fail', 'other'],
    [`${web}::times out`, 'fail', 'timeout'],
  ]);
  const placedFails = multi.tests.filter(t => t.status === 'fail' && t.file !== UNKNOWN_FILE).map(t => t.id).sort();
  const lostFails = multi.tests.filter(t => t.status === 'fail' && t.file === UNKNOWN_FILE).map(t => t.name);
  const allFails = perFile.filter(t => t.status === 'fail').map(t => t.id).sort();
  const known = new Map(perFile.map(t => [t.id, t.status]));
  for (const t of multi.tests) {
    if (t.file === UNKNOWN_FILE) continue;
    assert.equal(known.get(t.id), t.status, `${t.id} has the same id and status in one invocation`);
  }
  const wrapped = /^# Subtest: .*sum\.test\.mjs$/m.test(both);
  if (wrapped) {
    assert.equal(multi.unknownFileTests, 0, 'file-wrapped output (Node 20) places every test');
    assert.deepEqual(placedFails, allFails, 'every failure is placed');
  } else {
    assert.ok(multi.unknownFileTests > 0, 'located output (Node 24) cannot place passing top-level tests');
    assert.deepEqual(placedFails, allFails.filter(id => id !== `${api}::same (2)`), 'the other failures are placed');
    assert.deepEqual(lostFails, ['same'], 'the repeated failure has no file, so the runner reruns per file');
  }
  assert.deepEqual(multi.counts, { pass: 4, fail: 4, skip: 1, todo: 0 });
});
