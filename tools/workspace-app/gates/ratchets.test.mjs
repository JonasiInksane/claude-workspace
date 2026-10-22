// Tests for gates/ratchets.mjs: test counting, a lost test, a new .only/.skip/todo (added lines
// only), unchanged and moved code, deleted and renamed test files, metric and allowlist ratchets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, allowlistItems, allowlistRatchet, countTests, itemKey, metricRatchet, metricValue, skipKinds, testRatchet } from './ratchets.mjs';

const TP = '\\.(test|integration)\\.mjs$';
const BASE = [
  "import { test } from 'node:test';",
  "test('adds', () => {});",
  "test('subtracts', () => {});",
  "describe('suite', () => {",
  "  it('works', () => {});",
  "  it.skip('later', () => {});",
  '});',
].join('\n');

// A fake repository: base and head texts by path.
function reader(map) {
  return async p => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null);
}

test('countTests counts test( and it( calls, skip/only/todo calls and options', () => {
  assert.deepEqual(countTests(BASE), { tests: 4, skip: 1, only: 0, todo: 0 });
  const src = [
    "test('a', { skip: true }, () => {});",
    "test('b', { only: true }, () => {});",
    "test('c', { todo: 'later' });",
    "it.only('d', () => {});",
    "test.todo('e');",
    "t.test('sub', () => {});",
    "await submit(form); wait (1);",
  ].join('\n');
  assert.deepEqual(countTests(src), { tests: 6, skip: 1, only: 2, todo: 2 });
  assert.deepEqual(countTests(null), { tests: 0, skip: 0, only: 0, todo: 0 });
});

test('skipKinds finds skips in one line, including describe variants and t.skip()', () => {
  assert.deepEqual(skipKinds("describe.only('x', () => {"), ['only']);
  assert.deepEqual(skipKinds('  t.skip();'), ['skip']);
  assert.deepEqual(skipKinds("test('x', { skip: 'flaky on CI' }, fn)"), ['skip']);
  assert.deepEqual(skipKinds("test('x', fn)"), []);
});

test('addedLines ignores moved and re-indented lines', () => {
  assert.deepEqual(addedLines('a\nb\nc', '  c\na\nb\nd'), [{ line: 4, text: 'd' }]);
  assert.deepEqual(addedLines('x\nx', 'x\nx\nx'), [{ line: 3, text: 'x' }]);
  assert.deepEqual(addedLines(null, 'one'), [{ line: 1, text: 'one' }]);
});

test('a lost test fails with before and after counts', async () => {
  const head = BASE.replace("test('subtracts', () => {});\n", '');
  const r = await testRatchet({ changed: [{ path: 'apps/api/src/math.test.mjs', status: 'M' }], readAtBase: reader({ 'apps/api/src/math.test.mjs': BASE }), readAtHead: reader({ 'apps/api/src/math.test.mjs': head }), testPattern: TP });
  assert.equal(r.ok, false);
  assert.deepEqual(r.lost, [{ path: 'apps/api/src/math.test.mjs', before: 4, after: 3 }]);
  assert.deepEqual(r.newSkips, []);
});

test('a new .only fails with its line; a skip that was already there does not', async () => {
  const head = BASE.replace("test('adds'", "test.only('adds'");
  const r = await testRatchet({ changed: [{ path: 'a.test.mjs', status: 'M' }], readAtBase: reader({ 'a.test.mjs': BASE }), readAtHead: reader({ 'a.test.mjs': head }), testPattern: TP });
  assert.equal(r.ok, false);
  assert.deepEqual(r.newSkips, [{ path: 'a.test.mjs', kind: 'only', line: 2 }]);
  assert.deepEqual(r.lost, []);
});

test('unchanged counts pass: reformatting and moving tests is fine', async () => {
  const head = BASE.split('\n').reverse().map(l => `  ${l}`).join('\n') + "\ntest('new one', () => {});";
  const r = await testRatchet({ changed: [{ path: 'a.test.mjs', status: 'M' }], readAtBase: reader({ 'a.test.mjs': BASE }), readAtHead: reader({ 'a.test.mjs': head }), testPattern: TP });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, [{ path: 'a.test.mjs', before: 4, after: 5 }]);
});

test('a deleted test file loses every test; a new test file with a skip fails; renames compare the old file', async () => {
  const deleted = await testRatchet({ changed: [{ path: 'gone.test.mjs', status: 'D' }], readAtBase: reader({ 'gone.test.mjs': BASE }), readAtHead: reader({}), testPattern: TP });
  assert.deepEqual(deleted.lost, [{ path: 'gone.test.mjs', before: 4, after: 0 }]);

  const added = await testRatchet({ changed: [{ path: 'new.test.mjs', status: 'A' }], readAtBase: reader({}), readAtHead: reader({ 'new.test.mjs': "test('a', () => {});\ntest.skip('b', () => {});" }), testPattern: TP });
  assert.deepEqual(added.lost, []);
  assert.deepEqual(added.newSkips, [{ path: 'new.test.mjs', kind: 'skip', line: 2 }]);

  const renamed = await testRatchet({ changed: [{ path: 'b.test.mjs', oldPath: 'a.test.mjs', status: 'R' }], readAtBase: reader({ 'a.test.mjs': BASE }), readAtHead: reader({ 'b.test.mjs': BASE }), testPattern: TP });
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.files, [{ path: 'b.test.mjs', before: 4, after: 4 }]);
});

test('files that are not tests are ignored, and a missing testPattern is an error', async () => {
  const r = await testRatchet({ changed: [{ path: 'src/a.mjs', status: 'M' }], readAtBase: () => { throw new Error('should not read'); }, readAtHead: () => null, testPattern: TP });
  assert.deepEqual(r, { ok: true, lost: [], newSkips: [], files: [] });
  await assert.rejects(testRatchet({ changed: [], readAtBase: reader({}), readAtHead: reader({}), testPattern: '' }), /no fences.testPattern/);
});

test('metricValue reads numbers, {value} objects and dotted fields', () => {
  const v = { deepImports: { value: 12, display: '12' }, serverCycles: { value: 3, largestModuleCycle: 9 }, plain: 4 };
  assert.equal(metricValue(v, 'deepImports'), 12);
  assert.equal(metricValue(v, 'serverCycles.largestModuleCycle'), 9);
  assert.equal(metricValue(v, 'plain'), 4);
  assert.equal(metricValue(v, 'missing'), null);
  assert.equal(metricValue(null, 'x'), null);
});

test('metricRatchet: worse fails, same and better pass, missing is reported', () => {
  const r = metricRatchet({
    base: { serverCycles: { value: 3, largestModuleCycle: 9 }, deepImports: { value: 12 }, publicTs: { value: 2 } },
    head: { serverCycles: { value: 3, largestModuleCycle: 10 }, deepImports: { value: 10 }, publicTs: { value: 1 } },
    metrics: ['serverCycles', 'serverCycles.largestModuleCycle', 'deepImports', 'publicTs', 'localeWeb'],
    higherIsBetter: ['publicTs'],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows.map(x => [x.metric, x.status, x.change]), [
    ['serverCycles', 'same', 0], ['serverCycles.largestModuleCycle', 'worse', 1], ['deepImports', 'better', -2], ['publicTs', 'worse', -1], ['localeWeb', 'missing', null],
  ]);
  assert.deepEqual(r.missing, ['localeWeb']);
  assert.equal(metricRatchet({ base: { deepImports: 5 }, head: { deepImports: 4 } }).ok, true);
});

test('allowlistRatchet: not set up, added fails, removed is information', () => {
  assert.deepEqual(allowlistRatchet({ nonShopNow: ['a.b'], allowlist: null }), { ok: true, added: [], removed: [], notSetUp: true });
  const r = allowlistRatchet({ nonShopNow: ['billing.publicSummary', 'auth.login', { id: 'auth.logout' }], allowlist: { version: 1, list: ['auth.login', 'auth.logout', 'old.gone'] } });
  assert.deepEqual(r, { ok: false, added: ['billing.publicSummary'], removed: ['old.gone'], notSetUp: false });
  assert.equal(allowlistRatchet({ nonShopNow: [], allowlist: ['x.y'] }).ok, true);
});

test('itemKey and allowlistItems accept the shapes probes and files use', () => {
  assert.equal(itemKey('a.b'), 'a.b');
  assert.equal(itemKey({ id: 'x' }), 'x');
  assert.equal(itemKey({ module: 'billing', key: 'pay' }), 'billing.pay');
  assert.equal(itemKey({ path: 'a.mjs', line: 3, text: '  rawBuilder()  ' }), 'a.mjs::rawBuilder()');
  assert.deepEqual(allowlistItems(['a']), ['a']);
  assert.deepEqual(allowlistItems({ procedures: ['b'] }), ['b']);
  assert.equal(allowlistItems({}), null);
  assert.equal(allowlistItems(undefined), null);
});
