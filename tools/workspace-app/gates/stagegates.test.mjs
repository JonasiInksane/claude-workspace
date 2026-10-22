// Tests for gates/stagegates.mjs on synthetic TAP results: gate B for pins (exist, new or in the
// plan, ran, passed, sha256 recorded) and for red tests (an assertion failure that is not a known
// failure), pinsIntact, redNowPasses, the tenant denial-test heuristic, and test lookup by
// cwd-relative ids. One test feeds real TAP text through gates/tap.mjs to check the two agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineIds, denialTestPresent, findTest, gateB, lookupTest, pinsIntact, redNowPasses, sha256Hex, testStatus } from './stagegates.mjs';
import { tapLines } from '../test/helpers.mjs';

const TP = '\\.(test|integration)\\.mjs$';
const CART = 'apps/web/src/cart/total.test.mjs';
const MONEY = 'apps/api/src/billing/money.test.mjs';

// A parsed TAP result as gates/tap.mjs returns it: ids are relative to the command's cwd.
const T = (file, name, status, kind) => ({ id: `${file}::${name}`, file, name, status, ...(kind ? { failure: { kind, message: 'x' } } : {}) });
const tapOf = (...tests) => ({ tests, counts: { pass: tests.filter(t => t.status === 'pass').length, fail: tests.filter(t => t.status === 'fail').length, skip: 0, todo: 0 } });

// A fake tree: file bytes now, and which files existed at base.
function fakeTree({ now = {}, base = {} } = {}) {
  return {
    sha256: async p => (Object.prototype.hasOwnProperty.call(now, p) ? sha256Hex(now[p]) : null),
    readAtBase: async p => (Object.prototype.hasOwnProperty.call(base, p) ? base[p] : null),
    readBytes: async p => (Object.prototype.hasOwnProperty.call(now, p) ? Buffer.from(now[p]) : null),
  };
}

function runner(tap) {
  const calls = [];
  const fn = async files => { calls.push(files); return tap; };
  fn.calls = calls;
  return fn;
}

const pinsList = { tests: [{ path: CART, name: 'total sums', proves: 'adds' }, { path: CART, name: 'total of nothing', proves: 'zero' }], notes: '' };

test('gate B pins: new tests that ran and passed are pinned with their sha256', async () => {
  const tree = fakeTree({ now: { [CART]: 'test("a")' } });
  const runFiles = runner(tapOf(T('src/cart/total.test.mjs', 'total sums', 'pass'), T('src/cart/total.test.mjs', 'total of nothing', 'pass')));
  const r = await gateB({ kind: 'pins', tests: pinsList, runFiles, ...tree, changed: [{ path: CART, status: 'A' }], plan: { files: ['apps/web/src/cart/total.mjs'] }, testPattern: TP });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(runFiles.calls, [[CART]]);
  assert.deepEqual(r.pins, [{ path: CART, sha256: sha256Hex('test("a")'), tests: ['total sums', 'total of nothing'] }]);
  assert.deepEqual(r.perTest.map(t => t.status), ['pass', 'pass']);
  assert.deepEqual(r.notChecked, []);
});

test('gate B pins: a missing, skipped or failing test, or a missing file, is a problem', async () => {
  const tree = fakeTree({ now: { [CART]: 'x' } });
  const tests = { tests: [...pinsList.tests, { path: CART, name: 'skipped one' }, { path: 'apps/web/src/gone.test.mjs', name: 'nowhere' }] };
  const tap = tapOf(T('src/cart/total.test.mjs', 'total sums', 'fail', 'assertion'), T('src/cart/total.test.mjs', 'skipped one', 'skip'));
  const r = await gateB({ kind: 'pins', tests, runFiles: runner(tap), ...tree, changed: [], plan: { files: [] }, testPattern: TP });
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /apps\/web\/src\/gone\.test\.mjs does not exist in the tree/);
  assert.match(text, /"total sums" fails on the unchanged code; a pin must pass/);
  assert.match(text, /"total of nothing" did not run/);
  assert.match(text, /"skipped one" was marked skip/);
  assert.deepEqual(r.pins.map(p => p.path), [CART]);
});

test('gate B pins: an existing test file must be in the plan; without a plan that is listed as not checked', async () => {
  const tree = fakeTree({ now: { [CART]: 'new' }, base: { [CART]: 'old' } });
  const tap = tapOf(T('src/cart/total.test.mjs', 'total sums', 'pass'), T('src/cart/total.test.mjs', 'total of nothing', 'pass'));
  const outside = await gateB({ kind: 'pins', tests: pinsList, runFiles: runner(tap), ...tree, changed: [], plan: { files: ['x.mjs'] } });
  assert.match(outside.problems.join(), /existed at base and is not in the plan/);
  const inPlan = await gateB({ kind: 'pins', tests: pinsList, runFiles: runner(tap), ...tree, changed: [], plan: { files: [], tests: [CART] } });
  assert.equal(inPlan.ok, true);
  const noPlan = await gateB({ kind: 'pins', tests: pinsList, runFiles: runner(tap), ...tree });
  assert.equal(noPlan.ok, true);
  assert.equal(noPlan.notChecked.length, 2);
  assert.match(noPlan.notChecked.join('\n'), /only test files changed/);
  assert.match(noPlan.notChecked.join('\n'), /is in the plan/);
});

test('gate B: the prove stage may change test files only (a rename out of a test name counts)', async () => {
  const tree = fakeTree({ now: { [CART]: 'x' } });
  const tap = tapOf(T('src/cart/total.test.mjs', 'total sums', 'pass'), T('src/cart/total.test.mjs', 'total of nothing', 'pass'));
  const r = await gateB({ kind: 'pins', tests: pinsList, runFiles: runner(tap), ...tree, testPattern: TP,
    changed: [{ path: CART, status: 'A' }, { path: 'apps/web/src/cart/total.mjs', status: 'M' }, { path: 'apps/web/src/b.test.mjs', oldPath: 'apps/web/src/b.mjs', status: 'R' }] });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /changed files that are not tests: apps\/web\/src\/cart\/total\.mjs, apps\/web\/src\/b\.test\.mjs/);
});

test('gate B red: an assertion failure that is not a known failure passes the gate', async () => {
  const tree = fakeTree({ now: { [MONEY]: 'x' } });
  const tests = { tests: [{ path: MONEY, name: 'rounds half cents up', proves: 'the bug' }] };
  const r = await gateB({ kind: 'red', tests, runFiles: runner(tapOf(T('src/billing/money.test.mjs', 'rounds half cents up', 'fail', 'assertion'))), ...tree,
    baseline: { commands: { 'test:api': { failures: [{ id: 'src/billing/other.test.mjs::old', kind: 'assertion' }] } } } });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.redTests, [{ path: MONEY, name: 'rounds half cents up', baseKind: 'assertion' }]);
  assert.equal(r.perTest[0].failureKind, 'assertion');
});

test('gate B red: a passing test, a crash, a timeout or a known failure does not count', async () => {
  const tree = fakeTree({ now: { [MONEY]: 'x' } });
  const tests = { tests: ['passes', 'crashes', 'times out', 'already known'].map(name => ({ path: MONEY, name })) };
  const f = 'src/billing/money.test.mjs';
  const tap = tapOf(T(f, 'passes', 'pass'), T(f, 'crashes', 'fail', 'crash'), T(f, 'times out', 'fail', 'timeout'), T(f, 'already known', 'fail', 'assertion'));
  const r = await gateB({ kind: 'red', tests, runFiles: runner(tap), ...tree, baseline: { commands: { 'test:api': { failures: [{ id: `${f.toUpperCase()}::ALREADY KNOWN` }] } } } });
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /"passes" passes on the unchanged code; a red test must fail first/);
  assert.match(text, /"crashes" fails with a crash failure, not an assertion/);
  assert.match(text, /"times out" fails with a timeout failure/);
  assert.match(text, /"already known" is already a known failure in the baseline/);
});

test('gate B: no listed tests, and an unknown kind', async () => {
  const r = await gateB({ kind: 'red', tests: { tests: [] }, runFiles: runner(tapOf()), ...fakeTree() });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /listed no tests/);
  await assert.rejects(gateB({ kind: 'green', tests: [], runFiles: runner(tapOf()), ...fakeTree() }), /kind "pins" or "red"/);
});

test('pinsIntact: byte-identical and green passes; a changed byte, a gone file or a failing pin does not', async () => {
  const pins = [{ path: CART, sha256: `sha256:${sha256Hex('pinned').toUpperCase()}`, tests: ['total sums'] }];
  const green = tapOf(T('src/cart/total.test.mjs', 'total sums', 'pass'));
  assert.deepEqual(await pinsIntact({ pins, readBytes: fakeTree({ now: { [CART]: 'pinned' } }).readBytes, tap: green }), { ok: true, changed: [], failed: [] });
  const edited = await pinsIntact({ pins, readBytes: fakeTree({ now: { [CART]: 'pinned!' } }).readBytes, tap: green });
  assert.equal(edited.ok, false);
  assert.deepEqual(edited.changed.map(c => [c.path, c.before, c.after]), [[CART, sha256Hex('pinned'), sha256Hex('pinned!')]]);
  const gone = await pinsIntact({ pins, readBytes: fakeTree().readBytes, tap: green });
  assert.equal(gone.changed[0].after, null);
  const red = await pinsIntact({ pins, readBytes: fakeTree({ now: { [CART]: 'pinned' } }).readBytes, tap: tapOf(T('src/cart/total.test.mjs', 'total sums', 'fail', 'assertion')) });
  assert.deepEqual(red.failed, [{ path: CART, name: 'total sums', status: 'fail' }]);
  const notRun = await pinsIntact({ pins, readBytes: fakeTree({ now: { [CART]: 'pinned' } }).readBytes, tap: null });
  assert.equal(notRun.failed[0].status, 'not run');
});

test('redNowPasses: every red test passes now, or it says which still fail', () => {
  const redTests = [{ path: MONEY, name: 'rounds half cents up' }, { path: MONEY, name: 'refunds' }];
  const f = 'src/billing/money.test.mjs';
  assert.deepEqual(redNowPasses({ redTests, tap: tapOf(T(f, 'rounds half cents up', 'pass'), T(f, 'refunds', 'pass')) }), { ok: true, stillFailing: [], failed: [] });
  const r = redNowPasses({ redTests, tap: tapOf(T(f, 'rounds half cents up', 'pass'), T(f, 'refunds', 'fail', 'assertion')) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.stillFailing, [{ path: MONEY, name: 'refunds', status: 'fail' }]);
  assert.equal(r.failed, r.stillFailing);
  assert.equal(redNowPasses({ redTests, tap: tapOf() }).stillFailing[0].status, 'missing');
});

test('denialTestPresent: needed only for tenant paths, and needs a denial word and a no-side-effect check', async () => {
  const hits = [{ path: 'apps/api/src/auth/session.mjs', tag: 'tenant', glob: 'apps/api/src/auth/**' }];
  const files = {
    'apps/api/src/auth/session.test.mjs': "test('outsider', async () => { await assert.rejects(call(), /FORBIDDEN/); assert.equal(send.calls.length, 0); });",
    'apps/api/src/auth/half.test.mjs': "test('outsider', () => assert.throws(call, /UNAUTHORIZED/));",
    'apps/api/src/auth/session.mjs': 'FORBIDDEN not called',
  };
  const readAtHead = async p => files[p] ?? null;
  const none = await denialTestPresent({ changed: [], readAtHead, riskHits: [{ path: 'x', tag: 'money' }] });
  assert.deepEqual([none.ok, none.required, none.heuristic], [true, false, true]);
  const ok = await denialTestPresent({ changed: [{ path: 'apps/api/src/auth/session.mjs', status: 'M' }, { path: 'apps/api/src/auth/session.test.mjs', status: 'A' }], readAtHead, riskHits: { tags: ['tenant'], hits }, testPattern: TP });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.files, ['apps/api/src/auth/session.test.mjs']);
  assert.match(ok.reason, /heuristic/);
  // A denial without a no-side-effect check, a source file with the words, and a deleted test do not count.
  const bad = await denialTestPresent({ changed: [{ path: 'apps/api/src/auth/half.test.mjs', status: 'M' }, { path: 'apps/api/src/auth/session.mjs', status: 'M' }, { path: 'apps/api/src/auth/session.test.mjs', status: 'D' }], readAtHead, riskHits: hits, testPattern: TP });
  assert.equal(bad.ok, false);
  assert.equal(bad.required, true);
  assert.match(bad.reason, /no changed test checks a denial/);
});

test('findTest matches cwd-relative ids by path suffix, preferring the exact path and the full name', () => {
  const tap = tapOf(
    { id: 'src/a.test.mjs::suite > works', file: 'src/a.test.mjs', status: 'pass' },
    { id: 'apps/web/src/a.test.mjs::works', file: 'apps/web/src/a.test.mjs', status: 'fail' },
    { id: 'src/b.test.mjs::outer > inner > deep', file: 'src/b.test.mjs', status: 'pass' },
  );
  assert.equal(findTest(tap, 'apps/web/src/a.test.mjs', 'works').status, 'fail');        // exact path first
  assert.equal(findTest(tap, 'apps/api/src/a.test.mjs', 'suite > works').status, 'pass');
  assert.equal(findTest(tap, 'apps/web/src/b.test.mjs', 'inner > deep').id, 'src/b.test.mjs::outer > inner > deep');
  assert.equal(findTest(tap, 'apps/web/src/b.test.mjs', 'deep').id, 'src/b.test.mjs::outer > inner > deep');
  assert.equal(findTest(tap, 'apps/web/src/b.test.mjs', 'nope'), null);
  assert.equal(testStatus(null), 'missing');
  assert.equal(testStatus({ ok: false }), 'fail');
  assert.equal(testStatus({ directive: 'todo' }), 'todo');
  assert.deepEqual([...baselineIds(['A::b', { id: 'C::d' }])], ['a::b', 'c::d']);
});

test('ambiguous TAP matches: two workspaces with the same relative file, or two describe blocks, are never guessed', async () => {
  // runTests merges TAP from two workspaces; both print src/lib/x.test.mjs::rounds.
  const twoWorkspaces = tapOf(T('src/lib/x.test.mjs', 'rounds', 'pass'), T('src/lib/x.test.mjs', 'rounds', 'fail', 'assertion'));
  const path = 'apps/web/src/lib/x.test.mjs';
  assert.equal(findTest(twoWorkspaces, path, 'rounds'), null);
  assert.deepEqual(lookupTest(twoWorkspaces, path, 'rounds').ambiguous, ['src/lib/x.test.mjs::rounds', 'src/lib/x.test.mjs::rounds']);
  // A tree-relative path in the TAP (an exact match) settles it.
  const prefixed = tapOf(T(path, 'rounds', 'pass'), T('apps/api/src/lib/x.test.mjs', 'rounds', 'fail', 'assertion'));
  assert.equal(findTest(prefixed, path, 'rounds').status, 'pass');
  // Two describe blocks whose names end the same way.
  const blocks = tapOf(T(CART, 'web > total', 'pass'), T(CART, 'api > total', 'fail', 'assertion'));
  assert.equal(lookupTest(blocks, CART, 'total').hit, null);
  assert.equal(findTest(blocks, CART, 'api > total').status, 'fail');               // the full name is unique
  // Gate B, pinsIntact and redNowPasses report it instead of borrowing a result.
  const r = await gateB({ kind: 'pins', tests: { tests: [{ path: CART, name: 'total' }] }, runFiles: runner(blocks), ...fakeTree({ now: { [CART]: 'x' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.perTest[0].status, 'ambiguous');
  assert.match(r.problems[0], /"total" matches 2 tests in the TAP output .*can't be told apart/);
  const pins = [{ path, sha256: sha256Hex('p'), tests: ['rounds'] }];
  assert.deepEqual((await pinsIntact({ pins, readBytes: fakeTree({ now: { [path]: 'p' } }).readBytes, tap: twoWorkspaces })).failed, [{ path, name: 'rounds', status: 'ambiguous' }]);
  assert.equal(redNowPasses({ redTests: [{ path, name: 'rounds' }], tap: twoWorkspaces }).stillFailing[0].status, 'ambiguous');
});

test('real TAP from the test runner: gate B red reads the failure kind gates/tap.mjs reports', async t => {
  let parseTap;
  try { ({ parseTap } = await import('./tap.mjs')); } catch { t.skip('gates/tap.mjs is not available'); return; }
  const text = tapLines([
    { name: 'rounds half cents up', ok: false, location: `${'src/billing/money.test.mjs'}:3:1`, expected: '2', actual: '1' },
    { name: 'crashes', ok: false, location: 'src/billing/money.test.mjs:9:1', code: 'ERR_TEST_FAILURE', errorName: 'TypeError', error: 'boom' },
  ]);
  const tap = parseTap(text, { files: ['src/billing/money.test.mjs'], cwd: process.cwd() });
  const tests = { tests: [{ path: MONEY, name: 'rounds half cents up' }, { path: MONEY, name: 'crashes' }] };
  const r = await gateB({ kind: 'red', tests, runFiles: async () => tap, ...fakeTree({ now: { [MONEY]: 'x' } }) });
  assert.equal(r.perTest[0].ok, true, JSON.stringify(r.perTest[0]));
  assert.equal(r.perTest[1].ok, false);
  assert.notEqual(r.perTest[1].failureKind, 'assertion');
});
