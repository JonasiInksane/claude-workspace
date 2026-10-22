// Tests for gates/baseline.mjs: keys, error identities, every compare category, chips, candidates
// with their hash, and the rule that a baseline changes only on its first run or on accepting a
// candidate with the matching hash (SPEC R15). Data folders are temporary folders under os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonHash } from '../core/datadir.mjs';
import { parseTap } from './tap.mjs';
import {
  COMMAND_FAILED, KEY_RE, acceptCandidate, baselineKey, candidateFrom, chip, commandEntry, compare, diffBaselines,
  knownCount, knownIds, knownList, lintErrorId, listBaselines, loadBaseline, loadCandidate, numberDuplicates, saveBaseline,
  typeErrorId, writeCandidate,
} from './baseline.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const KEY = '0123456789ab-run-node24.11.1';
const P = 'example';
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'wp3-baseline-'));
  roots.push(d);
  return d;
}
const baselineFile = (dir, key = KEY) => join(dir, 'baselines', P, `${key}.json`);
const candidateFile = (dir, key = KEY) => join(dir, 'baselines', P, `${key}.candidate.json`);
async function rejectsWith(promise, status, re) {
  await assert.rejects(promise, err => {
    assert.equal(err.status, status, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

// Command entries the way commandEntry() makes them.
const fail = (id, kind = 'assertion', message = 'Expected 1 to be 2') => ({ id, kind, message });
function testCmd(failures, passed = [], extra = {}) {
  const fs = failures.map(f => (typeof f === 'string' ? fail(f) : f));
  return {
    kind: 'test', status: fs.length ? 'fail' : 'pass', exitCode: fs.length ? 1 : 0,
    counts: { pass: passed.length, fail: fs.length, skip: 0, todo: 0 }, failures: fs, passed, durationMs: 100, ...extra,
  };
}
const errCmd = (kind, errors, extra = {}) => ({ kind, status: errors.length ? 'fail' : 'pass', exitCode: errors.length ? 1 : 0, errors, durationMs: 50, ...extra });
const run = (commands, extra = {}) => ({ baseSha: SHA, treeMode: 'run', node: '24.11.1', commands, ...extra });
const baselineOf = commands => ({ version: 1, project: P, key: KEY, baseSha: SHA, treeMode: 'run', node: '24.11.1', commands, history: [] });

const T = 'src/billing/cents.test.mjs';
const A = `${T}::cents > rounds half up`;
const B = `${T}::cents > adds cents`;
const C = `${T}::totals a basket`;

// ---- keys -----------------------------------------------------------------------------------

test('baselineKey is <sha12>-<treeMode>-node<version>', () => {
  assert.equal(baselineKey({ baseSha: SHA, treeMode: 'run', node: '24.11.1' }), KEY);
  assert.equal(baselineKey({ baseSha: SHA.toUpperCase(), treeMode: 'main', node: 'v20.15.1' }), '0123456789ab-main-node20.15.1');
  assert.match(KEY, KEY_RE);
  for (const bad of [{ baseSha: 'abc', treeMode: 'run', node: '24.11.1' }, { baseSha: SHA, treeMode: 'Run!', node: '24.11.1' },
    { baseSha: SHA, treeMode: 'run', node: '24' }, {}]) {
    assert.throws(() => baselineKey(bad), err => err.status === 400);
  }
});

test('keys and project names are checked before any path is built', async () => {
  const dir = dataDir();
  for (const key of ['../../escape', '0123456789ab-run-node24.11.1/../x', 'x.json', '']) {
    await rejectsWith(loadBaseline(dir, P, key), 400, /not a baseline key/);
    await rejectsWith(loadCandidate(dir, P, key), 400);
    await rejectsWith(acceptCandidate(dir, P, key, 'sha256:x'), 400);
    await rejectsWith(writeCandidate(dir, P, key, { commands: {} }), 400);
  }
  for (const project of ['../x', 'Example', 'a/b', '']) {
    await rejectsWith(loadBaseline(dir, project, KEY), 400, /not a project name/);
    await rejectsWith(listBaselines(dir, project), 400);
    await rejectsWith(saveBaseline(dir, project, KEY, run({})), 400);
  }
  assert.deepEqual(readdirSync(dir), [], 'nothing was created');
});

// ---- first run (R15) ------------------------------------------------------------------------

test('saveBaseline writes the first baseline and refuses to overwrite it', async () => {
  const dir = dataDir();
  const current = run({
    'test:api': testCmd([A], [B, C]),
    'types:api': errCmd('types', ['src/a.ts::TS2322::Type x is not assignable']),
    'lint:api': { ...errCmd('lint', []), status: 'warn', warnings: 3, files: ['src/a.ts'] },
  });
  const doc = await saveBaseline(dir, P, KEY, current, { source: 'first-run' });
  assert.equal(doc.source, 'first-run');
  assert.equal(doc.acceptedAt, null);
  assert.equal(doc.key, KEY);
  assert.equal(doc.baseSha, SHA);
  assert.deepEqual(doc.history.map(h => [h.action, h.known]), [['first-run', 2]]);
  assert.equal(doc.commands['test:api'].passed, undefined, 'pass lists are not stored');
  assert.equal(doc.commands['lint:api'].files, undefined, 'file lists are not stored');
  assert.equal(doc.commands['lint:api'].warnings, 3);
  assert.deepEqual(await loadBaseline(dir, P, KEY), doc);
  const bytes = readFileSync(baselineFile(dir));

  await rejectsWith(saveBaseline(dir, P, KEY, run({ 'test:api': testCmd([]) })), 409, /already exists.*accept a candidate/);
  await rejectsWith(saveBaseline(dir, P, KEY, current, { source: 'accepted' }), 400, /first run/);
  assert.deepEqual(readFileSync(baselineFile(dir)), bytes, 'the baseline is unchanged');

  await rejectsWith(saveBaseline(dir, P, '0123456789ab-main-node24.11.1', current), 400, /does not match the data/);
  await rejectsWith(saveBaseline(dir, P, KEY, { baseSha: SHA }), 400, /no commands/);
  assert.equal(await loadBaseline(dir, P, '0123456789ab-run-node20.15.1'), null);
});

test('saveBaseline adds the commands a baseline lacks and never changes an existing entry', async () => {
  const dir = dataDir();
  const first = await saveBaseline(dir, P, KEY, run({ 'test:api': testCmd([A], [B]) }));
  const before = JSON.stringify(first.commands['test:api']);
  const cand = await writeCandidate(dir, P, KEY, candidateFrom(first, run({ 'test:api': testCmd([], [A, B]) })));

  // What gates/check.mjs sends for role 'base': the stored entries plus the newly measured ones.
  const data = { ...first, commands: { 'test:api': testCmd([]), 'types:web': errCmd('types', ['src/a.ts::TS1::x']) } };
  const doc = await saveBaseline(dir, P, KEY, data, { source: 'first-run' });
  assert.equal(JSON.stringify(doc.commands['test:api']), before, 'the existing entry is unchanged although the data differs');
  assert.deepEqual(doc.commands['types:web'].errors, ['src/a.ts::TS1::x']);
  assert.deepEqual(doc.history.map(h => [h.action, h.commands, h.known]), [['first-run', ['test:api'], 1], ['first-run', ['types:web'], 1]]);
  assert.equal(doc.source, 'first-run');
  assert.equal(doc.createdAt, first.createdAt);
  assert.deepEqual(await loadBaseline(dir, P, KEY), doc);

  await rejectsWith(saveBaseline(dir, P, KEY, data), 409, /already exists and has test:api, types:web/);
  await rejectsWith(saveBaseline(dir, P, KEY, run({})), 400, /no command results/);
  await rejectsWith(acceptCandidate(dir, P, KEY, cand.hash), 409, /baseline changed since this candidate/);
  assert.deepEqual(await loadBaseline(dir, P, KEY), doc, 'the stale candidate changed nothing');
});

test('end to end: TAP from both Node shapes into a baseline, a head check, a candidate and accept', async () => {
  const read = name => readFileSync(fileURLToPath(new URL(`../test/fixtures/tap/${name}`, import.meta.url)), 'utf8');
  const cwd = 'C:\\work\\example';
  const files = ['apps/api/src/billing/cents.test.mjs', 'apps/web/src/format.test.mjs'];
  const f = files[0];
  // Base: Node 20 runs both files in one invocation (file-wrapped subtests).
  const baseTap = parseTap(read('node20-files-wrapped.tap'), { files, cwd });
  const dir = dataDir();
  const doc = await saveBaseline(dir, P, KEY, run({ 'test:example': commandEntry('test', { status: 'fail', exitCode: 1, tap: baseTap }) }));
  assert.equal(knownCount(doc), 3);
  // Head: Node 24, one file per invocation; the api file now passes "rounds half up" and gains a failure.
  const headText = read('node24-single-api.tap')
    .replace('not ok 2 - rounds half up', 'ok 2 - rounds half up')
    .replace('ok 1 - pads to two digits', 'not ok 1 - pads to two digits');
  const apiTap = parseTap(headText, { files: [f], cwd });
  const webTap = parseTap(read('node24-single-web.tap'), { files: [files[1]], cwd });
  const tap = { tests: [...apiTap.tests, ...webTap.tests], counts: apiTap.counts };
  const current = run({ 'test:example': commandEntry('test', { status: 'fail', exitCode: 1, tap }) });
  const cmp = compare({ baseline: doc, current, reruns: { 'test:example': { [`${f}::cents > format > pads to two digits`]: 'fail' } } });
  assert.deepEqual(cmp.new, [`${f}::cents > format > pads to two digits`]);
  assert.deepEqual(cmp.known, ['apps/web/src/format.test.mjs::formats dates > locale', 'apps/web/src/format.test.mjs::labels > same name (2)']);
  assert.deepEqual(cmp.canShrink, [`${f}::cents > rounds half up`]);
  assert.equal(chip(cmp), '1 new · 2 known · 1 now pass');
  const cand = await writeCandidate(dir, P, KEY, candidateFrom(doc, current));
  assert.deepEqual([cand.from, cand.to, cand.leaving, cand.entering], [3, 2, [`${f}::cents > rounds half up`], []]);
  const { baseline } = await acceptCandidate(dir, P, KEY, cand.hash);
  assert.equal(knownCount(baseline), 2);
  assert.deepEqual(compare({ baseline, current }).canShrink, [], 'after accepting, nothing more can shrink');
});

test('loadBaseline refuses a file that is not the baseline for its key', async () => {
  const dir = dataDir();
  mkdirSync(join(dir, 'baselines', P), { recursive: true });
  writeFileSync(baselineFile(dir), JSON.stringify({ version: 1, key: 'something-else', commands: {} }));
  await assert.rejects(loadBaseline(dir, P, KEY), /is not a baseline for/);
});

// ---- entries and error identities -----------------------------------------------------------

test('commandEntry from TAP keeps failures with kinds and the passing ids', () => {
  const text = readFileSync(fileURLToPath(new URL('../test/fixtures/tap/node24-single-api.tap', import.meta.url)), 'utf8');
  const tap = parseTap(text, { files: ['apps/api/src/billing/cents.test.mjs'], cwd: 'C:\\work\\example' });
  const e = commandEntry('test', { status: 'fail', exitCode: 1, durationMs: 120, tap });
  const f = 'apps/api/src/billing/cents.test.mjs';
  assert.deepEqual(e.failures.map(x => [x.id, x.kind]), [[`${f}::cents > rounds half up`, 'assertion']]);
  assert.match(e.failures[0].message, /100 !== 101/);
  assert.deepEqual(e.passed, [`${f}::cents > adds cents`, `${f}::cents > format > pads to two digits`, `${f}::totals a basket`]);
  assert.deepEqual(e.counts, { pass: 3, fail: 1, skip: 0, todo: 0 });
  assert.equal(commandEntry('test', {}).status, 'error', 'a result without a status is an error');
});

test('type error ids have no line or column and are relative to the cwd', () => {
  const cwd = 'C:\\work\\example\\apps\\web';
  const at = (line, col) => ({ file: `${cwd}\\src\\pos\\money.ts`, line, col, code: 'TS2322', message: "Type 'string' is not\n   assignable to type 'number'." });
  assert.equal(typeErrorId(at(3, 5), { cwd }), "src/pos/money.ts::TS2322::Type 'string' is not assignable to type 'number'.");
  assert.equal(typeErrorId(at(90, 1), { cwd }), typeErrorId(at(3, 5), { cwd }), 'moving the code keeps the id');
  assert.equal(typeErrorId({ file: 'src\\a.ts', code: 'TS7006', message: "Parameter 'x' implicitly has an 'any' type." }),
    "src/a.ts::TS7006::Parameter 'x' implicitly has an 'any' type.");
});

test('lint error ids use the rule, or parse for a parse error (the spelling gates/commands.mjs uses)', () => {
  const cwd = 'C:\\work\\example\\apps\\web';
  assert.equal(lintErrorId({ file: `${cwd}\\src\\a.tsx`, line: 4, ruleId: 'no-unused-vars', message: "'x' is defined but never used." }, { cwd }),
    "src/a.tsx::no-unused-vars::'x' is defined but never used.");
  assert.equal(lintErrorId({ file: 'src/b.ts', ruleId: null, message: 'Parsing error: Unexpected token' }), 'src/b.ts::parse::Parsing error: Unexpected token');
});

test('a type error without a file is a project error', () => {
  assert.equal(typeErrorId({ code: 'TS5023', message: "Unknown compiler option 'x'." }), "(project)::TS5023::Unknown compiler option 'x'.");
  const long = typeErrorId({ file: 'src/a.ts', code: 'TS2322', message: 'y'.repeat(900) });
  assert.ok(long.length < 600, 'identity messages are capped');
});

test('repeated error ids are numbered, so one more of the same error is new', () => {
  assert.deepEqual(numberDuplicates(['a', 'b', 'a', 'a']), ['a', 'b', 'a (2)', 'a (3)']);
  const any = line => ({ file: 'src/a.ts', line, ruleId: '@typescript-eslint/no-explicit-any', message: 'Unexpected any. Specify a different type.' });
  const base = commandEntry('lint', { status: 'fail', exitCode: 1, errors: [any(1), any(9), any(20)], warnings: 2 });
  const head = commandEntry('lint', { status: 'fail', exitCode: 1, errors: [any(2), any(3), any(10), any(30)] });
  const id = 'src/a.ts::@typescript-eslint/no-explicit-any::Unexpected any. Specify a different type.';
  assert.deepEqual(base.errors, [id, `${id} (2)`, `${id} (3)`]);
  assert.equal(base.warnings, 2);
  const cmp = compare({ baseline: baselineOf({ 'lint:web': base }), current: run({ 'lint:web': head }) });
  assert.deepEqual(cmp.new, [`${id} (4)`]);
  assert.equal(cmp.known.length, 3);
});

test('secrets in error messages are redacted in the id', () => {
  const key = 'sk_' + 'live_' + 'x'.repeat(24);
  const id = typeErrorId({ file: 'src/a.ts', code: 'TS2322', message: `Type '"${key}"' is not assignable` });
  assert.ok(!id.includes(key));
  assert.match(id, /^src\/a\.ts::TS2322::Type '"sk_l/);
});

// ---- compare --------------------------------------------------------------------------------

test('known: in the baseline and failing now', () => {
  const cmp = compare({ baseline: baselineOf({ 'test:api': testCmd([A]) }), current: run({ 'test:api': testCmd([A], [B]) }) });
  assert.deepEqual(cmp.known, [A]);
  assert.deepEqual([cmp.new, cmp.flaky, cmp.canShrink, cmp.messageChanged, cmp.missingCommands], [[], [], [], [], []]);
  assert.deepEqual(cmp.perCommand['test:api'].known, [A]);
});

test('new: not in the baseline and still failing after the rerun, or never rerun', () => {
  const baseline = baselineOf({ 'test:api': testCmd([]) });
  const current = run({ 'test:api': testCmd([A], [C]) });
  assert.deepEqual(compare({ baseline, current }).new, [A], 'no rerun: new');
  const reruns = { commands: { 'test:api': testCmd([A]) } };
  assert.deepEqual(compare({ baseline, current, reruns }).new, [A], 'failed again on the rerun: new');
});

test('flaky: not in the baseline, failing now, passing on the rerun', () => {
  const cmp = compare({
    baseline: baselineOf({ 'test:api': testCmd([A]) }),
    current: run({ 'test:api': testCmd([A, B]) }),
    reruns: { commands: { 'test:api': testCmd([], [B]) } },
  });
  assert.deepEqual(cmp.flaky, [B]);
  assert.deepEqual(cmp.known, [A]);
  assert.deepEqual(cmp.new, []);
});

test('canShrink: a known failure proven to pass now, at the same SHA only', () => {
  const baseline = baselineOf({ 'test:api': testCmd([A, B]) });
  const passing = run({ 'test:api': testCmd([B], [A, C]) });
  assert.deepEqual(compare({ baseline, current: passing }).canShrink, [A]);
  assert.deepEqual(compare({ baseline, current: { ...passing, baseSha: SHA.slice(0, 12) } }).canShrink, [A], 'an abbreviated SHA matches');
  assert.deepEqual(compare({ baseline, current: { ...passing, baseSha: OTHER_SHA } }).canShrink, [], 'another SHA never shrinks');
  assert.deepEqual(compare({ baseline, current: { ...passing, dirty: true } }).canShrink, [], 'a tree the caller marks dirty never shrinks');
  assert.deepEqual(compare({ baseline, current: { commands: passing.commands } }).canShrink, [A],
    'without a SHA the caller loaded the baseline by its own key, so the SHA is the same');
  assert.deepEqual(compare({ baseline: { ...baseline, baseSha: undefined }, current: passing }).canShrink, [], 'a baseline without a SHA proves nothing');
  const notRun = run({ 'test:api': testCmd([B], [C]) });
  assert.deepEqual(compare({ baseline, current: notRun }).canShrink, [], 'a test that did not run is not proven fixed');
  const skipped = run({ 'test:api': { ...testCmd([B], [C]), counts: { pass: 1, fail: 1, skip: 1, todo: 0 } } });
  assert.deepEqual(compare({ baseline, current: skipped }).canShrink, []);
});

test('messageChanged: a known failure whose message or kind moved, ignoring timings', () => {
  const baseline = baselineOf({ 'test:api': testCmd([fail(A, 'assertion', 'Expected 1 to be 2'), fail(B, 'timeout', 'timed out after 50ms'), fail(C)]) });
  const current = run({ 'test:api': testCmd([fail(A, 'assertion', 'Expected 1 to be 3'), fail(B, 'timeout', 'timed out after 75ms'), fail(C, 'crash')]) });
  const cmp = compare({ baseline, current });
  assert.deepEqual(cmp.messageChanged, [A, C].sort());
  assert.deepEqual(cmp.known, [A, B, C].sort());
  const change = cmp.perCommand['test:api'].changes.find(c => c.id === A);
  assert.deepEqual([change.was.message, change.now.message], ['Expected 1 to be 2', 'Expected 1 to be 3']);
});

test('missingCommands: a command the baseline lacks is listed and its failures are new', () => {
  const cmp = compare({
    baseline: baselineOf({ 'test:api': testCmd([A]) }),
    current: run({ 'test:api': testCmd([A]), 'test:web': testCmd(['src/x.test.mjs::y']) }),
  });
  assert.deepEqual(cmp.missingCommands, ['test:web']);
  assert.deepEqual(cmp.new, ['src/x.test.mjs::y']);
  assert.equal(cmp.perCommand['test:web'].missing, true);
  assert.deepEqual(compare({ baseline: null, current: run({ 'test:api': testCmd([A]) }) }).new, [A], 'no baseline at all: everything is new');
});

test('a command failing without any parsed id still fails', () => {
  const crashed = { kind: 'test', status: 'error', exitCode: 1, counts: { pass: 0, fail: 0, skip: 0, todo: 0 }, failures: [], passed: [] };
  const id = `test:api::${COMMAND_FAILED}`;
  assert.deepEqual(compare({ baseline: baselineOf({ 'test:api': testCmd([]) }), current: run({ 'test:api': crashed }) }).new, [id]);
  assert.deepEqual(compare({ baseline: baselineOf({ 'test:api': crashed }), current: run({ 'test:api': crashed }) }).known, [id]);
  assert.deepEqual(compare({ baseline: baselineOf({ 'test:api': crashed }), current: run({ 'test:api': testCmd([], [A]) }) }).canShrink, [id]);
  const cancelled = { ...crashed, status: 'cancelled' };
  assert.deepEqual(compare({ baseline: null, current: run({ 'test:api': cancelled }) }).new, [id]);
  const warned = { kind: 'lint', status: 'warn', exitCode: 0, errors: [], warnings: 4 };
  assert.deepEqual(compare({ baseline: null, current: run({ 'lint:web': warned }) }).new, [], 'warnings alone are not a failure');
});

test('types and lint: an error gone from a full run can shrink; a partial run only for its files', () => {
  const e1 = 'src/a.ts::TS2322::Type x is not assignable';
  const e2 = 'src/b.ts::TS2345::Argument y is not assignable';
  const baseline = baselineOf({ 'types:web': errCmd('types', [e1, e2]), 'lint:web': errCmd('lint', [e1, e2]) });
  const full = compare({ baseline, current: run({ 'types:web': errCmd('types', [e2]) }) });
  assert.deepEqual(full.canShrink, [e1]);
  assert.deepEqual(full.known, [e2]);
  const partial = compare({ baseline, current: run({ 'lint:web': errCmd('lint', [], { files: ['src/b.ts'] }) }) });
  assert.deepEqual(partial.canShrink, [e2], 'only the linted file counts');
  const broken = compare({ baseline, current: run({ 'types:web': { ...errCmd('types', []), status: 'error', exitCode: 1 } }) });
  assert.deepEqual(broken.canShrink, [], 'a run that errored proves nothing');
  assert.deepEqual(broken.new, [`types:web::${COMMAND_FAILED}`]);
});

test('perCommand keeps the categories of each command apart', () => {
  const cmp = compare({
    baseline: baselineOf({ 'test:api': testCmd([A]), 'test:web': testCmd([]) }),
    current: run({ 'test:api': testCmd([A]), 'test:web': testCmd([A]) }),
  });
  assert.deepEqual(cmp.perCommand['test:api'].known, [A]);
  assert.deepEqual(cmp.perCommand['test:web'].new, [A]);
  assert.deepEqual([cmp.known, cmp.new], [[A], [A]]);
});

test('compare needs current results with commands', () => {
  assert.throws(() => compare({ baseline: null }), /needs current/);
  assert.throws(() => compare({ baseline: null, current: { 'test:api': testCmd([]) } }), /current\.commands/);
  assert.throws(() => compare({ current: run({}), reruns: 'yes' }), /reruns as a map/);
  assert.deepEqual(compare({ current: run({}), reruns: {} }).new, [], 'an empty rerun map is fine');
});

test('reruns in every shape callers use; only an explicit pass makes a failure flaky', () => {
  const baseline = baselineOf({ 'test:api': testCmd([]) });
  const current = run({ 'test:api': testCmd([A, B, C]) });
  const shapes = [
    { commands: { 'test:api': testCmd([B, C], [A]) } },
    { 'test:api': testCmd([B, C], [A]) },
    { 'test:api': { [A]: 'pass', [B]: 'fail' } },
    { 'test:api': [A] },
  ];
  for (const reruns of shapes) {
    const cmp = compare({ baseline, current, reruns });
    assert.deepEqual([cmp.flaky, cmp.new], [[A], [B, C].sort()], JSON.stringify(reruns).slice(0, 80));
  }
  const noProof = compare({ baseline, current, reruns: { 'test:api': { status: 'pass', exitCode: 0, failures: [] } } });
  assert.deepEqual(noProof.flaky, [], 'a passing rerun entry without a pass list proves nothing');
  assert.deepEqual(noProof.new, [A, B, C].sort());
  const other = compare({ baseline, current, reruns: { 'test:web': { [A]: 'pass' } } });
  assert.deepEqual(other.flaky, [], 'a pass in another command does not count');
});

test('entries shaped like gates/check.mjs builds them: no kind, partial runs, repeated ids', () => {
  const e1 = 'src/a.ts::TS2322::Type x is not assignable';
  const e2 = 'src/b.ts::TS2345::Argument y is not assignable';
  const check = (errors, extra = {}) => ({ status: errors.length ? 'fail' : 'pass', exitCode: errors.length ? 1 : 0, durationMs: 9, errors, ...extra });
  const baseline = baselineOf({ 'types:web': check([e1, e2]), 'lint:web': check([e1, e1, e2], { warnings: 1 }) });
  const full = compare({ baseline, current: { commands: { 'types:web': check([e2]) } } });
  assert.deepEqual([full.canShrink, full.known], [[e1], [e2]], 'an entry with errors and no kind is an error list');
  const partial = compare({ baseline, current: { commands: { 'lint:web': check([], { partial: true, files: ['src/b.ts'] }) } } });
  assert.deepEqual(partial.canShrink, [e2], 'a partial run proves only its own files');
  const partialNoFiles = compare({ baseline, current: { commands: { 'lint:web': check([], { partial: true }) } } });
  assert.deepEqual(partialNoFiles.canShrink, [], 'a partial run without a file list proves nothing');
  const more = compare({ baseline, current: { commands: { 'lint:web': check([e1, e1, e1, e2]) } } });
  assert.deepEqual(more.new, [`${e1} (3)`], 'a third copy of an error that existed twice is new');
  assert.deepEqual(more.known, [e1, `${e1} (2)`, e2].sort());
  const fewer = compare({ baseline, current: { commands: { 'lint:web': check([e1, e2]) } } });
  assert.deepEqual(fewer.canShrink, [`${e1} (2)`]);
  const cand = candidateFrom(baseline, { commands: { 'lint:web': check([e1, e2]) } });
  assert.deepEqual(cand.commands['lint:web'].errors, [e1, e2], 'shrinking repeats keeps the lowest numbers');
  assert.deepEqual(compare({ baseline: cand, current: { commands: { 'lint:web': check([e1, e2]) } } }).known, [e1, e2].sort());
  assert.deepEqual([...knownIds(baseline, 'lint:web')].sort(), [e1, `${e1} (2)`, e2].sort());
});

test('messages are compared on their first 300 characters', () => {
  const long = 'x'.repeat(300);
  const baseline = baselineOf({ 'test:api': testCmd([fail(A, 'assertion', `${long} then this`)]) });
  const same = compare({ baseline, current: run({ 'test:api': testCmd([fail(A, 'assertion', `${long} then that`)]) }) });
  assert.deepEqual(same.messageChanged, [], 'a difference after the stored part is not a change');
  const changed = compare({ baseline, current: run({ 'test:api': testCmd([fail(A, 'assertion', `y${long}`)]) }) });
  assert.deepEqual(changed.messageChanged, [A]);
});

test('chip summarises a comparison', () => {
  assert.equal(chip({ new: [], known: new Array(61).fill('x'), flaky: ['y'] }), '0 new · 61 known · 1 flaky');
  assert.equal(chip({ new: 2, known: 58, flaky: 0, canShrink: 3 }), '2 new · 58 known · 3 now pass');
  assert.equal(chip(undefined), '0 new · 0 known');
  const cmp = compare({ baseline: baselineOf({ 'test:api': testCmd([A, B]) }), current: run({ 'test:api': testCmd([B, C], [A]) }) });
  assert.equal(chip(cmp), '1 new · 1 known · 1 now pass');
});

// ---- candidates -----------------------------------------------------------------------------

test('candidateFrom drops what passed now and nothing else', () => {
  const baseline = baselineOf({
    'test:api': testCmd([A, B], [C]),
    'types:web': errCmd('types', ['src/a.ts::TS1::x']),
  });
  assert.equal(candidateFrom(baseline, run({ 'test:api': testCmd([A, B]) })), null, 'nothing passed');
  assert.equal(candidateFrom(null, run({})), null);
  const cand = candidateFrom(baseline, run({ 'test:api': testCmd([B], [A, C]), 'types:web': errCmd('types', []) }), { now: '2026-10-22T10:00:00.000Z' });
  assert.deepEqual(cand.leaving, [A, 'src/a.ts::TS1::x'].sort());
  assert.deepEqual(cand.entering, []);
  assert.deepEqual([cand.from, cand.to], [3, 1]);
  assert.deepEqual(cand.commands['test:api'].failures.map(f => f.id), [B]);
  assert.deepEqual(cand.commands['test:api'].counts, { pass: 2, fail: 1, skip: 0, todo: 0 });
  assert.deepEqual([cand.commands['types:web'].status, cand.commands['types:web'].exitCode], ['pass', 0]);
  assert.match(cand.reason, /^2 known failures passed in a check at 0123456/);
  assert.equal(cand.hash, undefined, 'writeCandidate seals it');
  assert.equal(cand.madeAt, '2026-10-22T10:00:00.000Z');
});

async function withBaseline(commands) {
  const dir = dataDir();
  const doc = await saveBaseline(dir, P, KEY, run(commands));
  return { dir, doc };
}

test('writeCandidate seals the candidate with a hash of its content and of the baseline', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A, B]) });
  const fixed = run({ 'test:api': testCmd([B], [A]) });
  const cand = candidateFrom(doc, fixed, { now: '2026-10-22T10:00:00.000Z' });
  const saved = await writeCandidate(dir, P, KEY, cand);
  const { hash, ...rest } = saved;
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, jsonHash(rest));
  assert.equal(saved.fromHash, jsonHash(doc));
  assert.deepEqual(await loadCandidate(dir, P, KEY), saved);
  assert.equal((await writeCandidate(dir, P, KEY, cand)).hash, hash, 'the same candidate gives the same hash');
  const other = await writeCandidate(dir, P, KEY, { ...cand, reason: 'something else' });
  assert.notEqual(other.hash, hash, 'different content gives a different hash');
});

test('writeCandidate recomputes from, to, leaving and entering, and refuses a no-op', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A, B]) });
  const lying = { commands: { 'test:api': testCmd([B, C]) }, from: 99, to: 0, leaving: [], entering: [] };
  const saved = await writeCandidate(dir, P, KEY, lying);
  assert.deepEqual([saved.from, saved.to, saved.leaving, saved.entering], [2, 2, [A], [C]]);
  await rejectsWith(writeCandidate(dir, P, KEY, { commands: doc.commands }), 400, /nothing to accept/);
  await rejectsWith(writeCandidate(dir, P, KEY, { ...lying, key: '0123456789ab-main-node24.11.1' }), 400, /is for/);
  await rejectsWith(writeCandidate(dir, P, KEY, {}), 400, /no commands/);
  await rejectsWith(writeCandidate(dataDir(), P, KEY, lying), 404, /no baseline/);
});

test('acceptCandidate replaces the baseline only with the matching hash', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A, B, C]) });
  const cand = await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([B], [A, C]) })));
  const before = readFileSync(baselineFile(dir));

  await rejectsWith(acceptCandidate(dir, P, KEY, 'sha256:0000'), 409, /changed since you looked/);
  await rejectsWith(acceptCandidate(dir, P, KEY, undefined), 409);
  assert.deepEqual(readFileSync(baselineFile(dir)), before, 'a wrong hash changes nothing');
  assert.ok(existsSync(candidateFile(dir)), 'the candidate is kept');

  const { baseline, message } = await acceptCandidate(dir, P, KEY, cand.hash);
  assert.equal(message, `Baseline ${KEY} now has 1 known failure (was 3; 2 left).`);
  assert.equal(baseline.source, 'accepted');
  assert.ok(baseline.acceptedAt);
  assert.equal(baseline.createdAt, doc.createdAt);
  assert.deepEqual(baseline.commands['test:api'].failures.map(f => f.id), [B]);
  const last = baseline.history[baseline.history.length - 1];
  assert.deepEqual([last.action, last.fromKnown, last.toKnown, last.leaving, last.hash], ['accept', 3, 1, [A, C].sort(), cand.hash]);
  assert.deepEqual(await loadBaseline(dir, P, KEY), baseline);
  assert.equal(existsSync(candidateFile(dir)), false, 'the accepted candidate is gone');
  await rejectsWith(acceptCandidate(dir, P, KEY, cand.hash), 404, /no candidate/);
});

test('acceptCandidate refuses a candidate edited on disk', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A, B]) });
  const cand = await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([B], [A]) })));
  const tampered = { ...cand, commands: { 'test:api': testCmd([]) } };
  writeFileSync(candidateFile(dir), JSON.stringify(tampered));
  const before = readFileSync(baselineFile(dir));
  await rejectsWith(acceptCandidate(dir, P, KEY, cand.hash), 409, /changed after it was made/);
  assert.deepEqual(readFileSync(baselineFile(dir)), before);
});

test('acceptCandidate refuses when the baseline changed after the candidate was made', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A, B, C]) });
  const first = await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([B, C], [A]) })));
  mkdirSync(join(dir, 'held'));
  writeFileSync(join(dir, 'held', 'first.json'), JSON.stringify(first));
  const second = await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([A, C], [B]) })));
  await acceptCandidate(dir, P, KEY, second.hash);
  writeFileSync(candidateFile(dir), readFileSync(join(dir, 'held', 'first.json')));
  await rejectsWith(acceptCandidate(dir, P, KEY, first.hash), 409, /baseline changed since this candidate/);
});

test('R15: the baseline changes only on first run or an accepted matching candidate', async () => {
  const dir = dataDir();
  const base = run({ 'test:api': testCmd([A, B]) });
  const doc = await saveBaseline(dir, P, KEY, base);
  const fileText = () => readFileSync(baselineFile(dir), 'utf8');
  const s0 = fileText();
  await rejectsWith(saveBaseline(dir, P, KEY, run({ 'test:api': testCmd([]) })), 409);
  const cmp = compare({ baseline: doc, current: run({ 'test:api': testCmd([B], [A]) }) });
  assert.deepEqual(cmp.canShrink, [A]);
  const cand = await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([B], [A]) })));
  assert.equal(fileText(), s0, 'writing a candidate leaves the baseline alone');
  await rejectsWith(acceptCandidate(dir, P, KEY, `${cand.hash}0`), 409);
  assert.equal(fileText(), s0);
  await acceptCandidate(dir, P, KEY, cand.hash);
  assert.notEqual(fileText(), s0);
  assert.deepEqual([...knownIds(await loadBaseline(dir, P, KEY))], [B]);
});

// ---- listing and helpers --------------------------------------------------------------------

test('listBaselines lists keys newest first with their candidate state', async () => {
  const dir = dataDir();
  assert.deepEqual(await listBaselines(dir, P), []);
  const old = '0123456789ab-run-node20.15.1';
  await saveBaseline(dir, P, old, { ...run({ 'test:api': testCmd([A]) }), node: '20.15.1' });
  await new Promise(r => setTimeout(r, 20));
  const doc = await saveBaseline(dir, P, KEY, run({ 'test:api': testCmd([A]) }));
  await writeCandidate(dir, P, KEY, candidateFrom(doc, run({ 'test:api': testCmd([], [A]) })));
  writeFileSync(join(dir, 'baselines', P, 'notes.json'), '{}');
  writeFileSync(join(dir, 'baselines', P, `${KEY}.json.123.tmp`), '{');
  const list = await listBaselines(dir, P);
  assert.deepEqual(list.map(b => [b.key, b.hasCandidate]), [[KEY, true], [old, false]]);
  assert.ok(list[0].updatedAt >= list[1].updatedAt);
});

test('diffBaselines, knownIds and knownCount', () => {
  const a = baselineOf({ 'test:api': testCmd([A, B]), 'types:web': errCmd('types', ['src/a.ts::TS1::x']) });
  const b = baselineOf({ 'test:api': testCmd([B, C]) });
  assert.deepEqual(diffBaselines(a, b), {
    leaving: [A, 'src/a.ts::TS1::x'].sort(), entering: [C],
    byCommand: { 'test:api': { leaving: [A], entering: [C] }, 'types:web': { leaving: ['src/a.ts::TS1::x'], entering: [] } },
  });
  assert.deepEqual([...knownIds(a, 'test:api')].sort(), [A, B].sort());
  assert.equal(knownIds(a).size, 3);
  assert.equal(knownCount(a), 3);
  assert.deepEqual(knownList(a), [A, B, 'src/a.ts::TS1::x'].sort());
  assert.equal(knownCount(null), 0);
  assert.deepEqual(knownList(null), []);
});

// ---- one id in two commands -----------------------------------------------------------------

// Ids are relative to each command's cwd, so test:api and test:web can both report this one.
const SHARED = 'src/x.test.mjs::formats > a date';

test('compare counts an id once per command that fails it, so the chip matches the rows', () => {
  const baseline = baselineOf({ 'test:api': testCmd([]), 'test:web': testCmd([]) });
  const cmp = compare({ baseline, current: run({ 'test:api': testCmd([SHARED]), 'test:web': testCmd([SHARED]) }) });
  assert.deepEqual(cmp.new, [SHARED, SHARED]);
  assert.equal(cmp.new.length, cmp.perCommand['test:api'].new.length + cmp.perCommand['test:web'].new.length);
  assert.equal(chip(cmp), '2 new · 0 known');
  const known = compare({ baseline: baselineOf({ 'test:api': testCmd([SHARED]), 'test:web': testCmd([SHARED]) }),
    current: run({ 'test:api': testCmd([SHARED]), 'test:web': testCmd([SHARED]) }) });
  assert.deepEqual([known.known, known.new], [[SHARED, SHARED], []]);
});

test('a fix in one of two commands that share an id shrinks the baseline', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([SHARED, A]), 'test:web': testCmd([SHARED]) });
  assert.equal(knownCount(doc), 3);
  assert.deepEqual(knownList(doc), [SHARED, SHARED, A].sort(), 'knownList has one entry per command, like knownCount');
  assert.equal(knownIds(doc).size, 2, 'knownIds without a command is the set of ids');
  // test:web now passes the shared test; test:api still fails it.
  const current = run({ 'test:api': testCmd([SHARED, A]), 'test:web': testCmd([], [SHARED]) });
  const cmp = compare({ baseline: doc, current });
  assert.deepEqual([cmp.canShrink, cmp.known], [[SHARED], [SHARED, A].sort()]);
  const cand = candidateFrom(doc, current);
  assert.deepEqual([cand.from, cand.to, cand.leaving, cand.entering], [3, 2, [SHARED], []]);
  assert.deepEqual(cand.byCommand, { 'test:web': { leaving: [SHARED], entering: [] } });
  const saved = await writeCandidate(dir, P, KEY, cand);
  assert.deepEqual([saved.from, saved.to, saved.leaving], [3, 2, [SHARED]]);
  const { baseline, message } = await acceptCandidate(dir, P, KEY, saved.hash);
  assert.equal(message, `Baseline ${KEY} now has 2 known failures (was 3; 1 left).`);
  assert.deepEqual([...knownIds(baseline, 'test:api')].sort(), [SHARED, A].sort());
  assert.deepEqual([...knownIds(baseline, 'test:web')], []);
  assert.equal(baseline.byCommand, undefined, 'the diff stays in the candidate and the history');
});

// ---- a command the baseline lacks -----------------------------------------------------------

test('a passing command the baseline lacks is added by a first run, not by a candidate', async () => {
  const { dir, doc } = await withBaseline({ 'test:api': testCmd([A]) });
  // A candidate that only adds a passing command changes no failure, so it is refused and says how
  // the command gets in instead.
  await rejectsWith(writeCandidate(dir, P, KEY, { commands: { ...doc.commands, 'types:web': errCmd('types', []) } }), 400,
    /nothing to accept.*\(types:web\) is added by a first run/);
  assert.equal(existsSync(candidateFile(dir)), false);
  // What gates/check.mjs role 'base' saves: only the command it ran, because the baseline lacks it.
  const added = await saveBaseline(dir, P, KEY, run({ 'types:web': errCmd('types', []) }), { source: 'first-run' });
  assert.deepEqual(Object.keys(added.commands).sort(), ['test:api', 'types:web']);
  assert.deepEqual([added.commands['types:web'].status, added.commands['types:web'].errors], ['pass', []]);
  assert.deepEqual(added.commands['test:api'], doc.commands['test:api'], 'the existing entry is unchanged');
  assert.deepEqual(added.history.at(-1), { at: added.history.at(-1).at, action: 'first-run', commands: ['types:web'], known: 0 });
  assert.equal(knownCount(added), 1);
  const cmp = compare({ baseline: added, current: run({ 'test:api': testCmd([A]), 'types:web': errCmd('types', []) }) });
  assert.deepEqual([cmp.missingCommands, cmp.known, cmp.new], [[], [A], []], 'the next check finds every command in the baseline');
  await rejectsWith(saveBaseline(dir, P, KEY, run({ 'types:web': errCmd('types', []) })), 409, /already exists/);
});

// ---- messages and the allow list ------------------------------------------------------------

test('a known failure whose message holds an allowed value is not a changed message', async () => {
  const allowed = 'sk_' + 'live_' + 'a'.repeat(24);
  const text = ['TAP version 13', 'not ok 1 - charges', '  ---', `  error: 'charge failed for ${allowed}'`,
    "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", "  failureType: 'testCodeFailure'", '  ...', '1..1', '# tests 1'].join('\n');
  const tap = parseTap(text, { files: ['src/a.test.mjs'], cwd: 'C:\\work\\example', allow: [allowed] });
  assert.ok(tap.tests[0].failure.message.includes(allowed), 'the parser keeps an allowed value');
  const entry = commandEntry('test', { status: 'fail', exitCode: 1, tap });
  const { doc } = await withBaseline({ 'test:api': entry });
  assert.ok(!JSON.stringify(doc).includes(allowed), 'the baseline file never stores it');
  const cmp = compare({ baseline: doc, current: run({ 'test:api': entry }) });
  assert.deepEqual([cmp.known, cmp.messageChanged], [['src/a.test.mjs::charges'], []]);
  const moved = commandEntry('test', { status: 'fail', exitCode: 1, tap: parseTap(text.replace('charge failed', 'refund failed'),
    { files: ['src/a.test.mjs'], cwd: 'C:\\work\\example', allow: [allowed] }) });
  assert.deepEqual(compare({ baseline: doc, current: run({ 'test:api': moved }) }).messageChanged, ['src/a.test.mjs::charges'],
    'a real change still shows');
});
