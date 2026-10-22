// Tests for gates/fences.mjs: every bucket, rename handling, the allowance path, plan removals,
// the read-only pipelines, must-tick listing and the paths Claude Code protects (ADDENDUM A6).
// The profile is the synthetic "example" fixture in test/fixtures/g0/profile.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkFences, editableInStage, fenceSummary, forbiddenFiles, mustTickFiles, normalizeChanged, planFilePaths, planPaths, touchedPaths } from './fences.mjs';

const profile = JSON.parse(readFileSync(new URL('../test/fixtures/g0/profile.json', import.meta.url), 'utf8'));
const M = path => ({ path, status: 'M' });
const A = path => ({ path, status: 'A' });
const D = path => ({ path, status: 'D' });
const R = (oldPath, path) => ({ path, oldPath, status: 'R' });
const bucketOf = (fence, path) => ['forbidden', 'mustTick', 'pinnedChanged', 'existingTestChanged', 'outsidePlan'].find(b => fence[b].some(e => e.path === path)) || null;
const plan = (files, extra = {}) => ({ files, ...extra });

test('forbidden: always fails, whatever the plan says, and ignores case', () => {
  const f = checkFences({ profile, changed: [M('vendor/lib.mjs'), A('apps/web/.ENV'), A('apps/api/x/generated.json'), M('.claude/settings.json')], plan: plan(['vendor/lib.mjs', 'apps/web/.ENV']) });
  for (const p of ['vendor/lib.mjs', 'apps/web/.ENV', 'apps/api/x/generated.json', '.claude/settings.json']) assert.equal(bucketOf(f, p), 'forbidden', p);
  assert.equal(f.ok, false);
  assert.equal(f.hardFail, true);
  assert.match(f.forbidden[0].reason, /forbidden in a run/);
  assert.equal(f.forbidden.find(e => e.path === 'vendor/lib.mjs').glob, 'vendor/**');
});

test('forbiddenExisting: an existing migration may never change; a new one must be ticked', () => {
  const changed = [M('apps/api/migrations/001_init.sql'), A('apps/api/migrations/002_add.sql')];
  const f = checkFences({ profile, changed, plan: plan(['apps/api/migrations/001_init.sql', 'apps/api/migrations/002_add.sql']) });
  assert.equal(bucketOf(f, 'apps/api/migrations/001_init.sql'), 'forbidden');
  assert.match(f.forbidden[0].reason, /existed at base/);
  assert.equal(bucketOf(f, 'apps/api/migrations/002_add.sql'), 'mustTick');
  const ticked = checkFences({ profile, changed: [A('apps/api/migrations/002_add.sql')], plan: plan(['apps/api/migrations/002_add.sql']), ticked: ['apps/api/migrations/002_add.sql'] });
  assert.equal(ticked.ok, true);
});

test('a path that is new by status but existed at base counts as existing', () => {
  const f = checkFences({ profile, changed: [A('apps/api/migrations/001_init.sql')], existsAtBase: p => p === 'apps/api/migrations/001_init.sql' });
  assert.equal(bucketOf(f, 'apps/api/migrations/001_init.sql'), 'forbidden');
  const withSet = checkFences({ profile, changed: [A('apps/api/migrations/001_init.sql')], existsAtBase: new Set(['APPS/api/migrations/001_init.sql']) });
  assert.equal(bucketOf(withSet, 'apps/api/migrations/001_init.sql'), 'forbidden');
});

test('an async existsAtBase is refused in plain words instead of reading every file as old', () => {
  const changed = [A('apps/web/src/fresh.test.mjs')];
  assert.throws(() => checkFences({ profile, changed, plan: plan([]), existsAtBase: async () => false }), /existsAtBase must answer at once; pass a Set or an array/);
  assert.throws(() => mustTickFiles(profile, ['apps/api/migrations/009.sql'], { existsAtBase: async () => true }), /must answer at once/);
  // A sync function still works.
  assert.equal(checkFences({ profile, changed, plan: plan([]), existsAtBase: () => false }).ok, true);
});

test('mustTick: config and risk files fail until ticked, and the message says to tick them', () => {
  const changed = [M('apps/web/package.json'), M('apps/api/src/auth/session.mjs'), M('.github/workflows/ci.yml')];
  const f = checkFences({ profile, changed, plan: plan(changed.map(c => c.path)) });
  assert.deepEqual(f.mustTick.map(e => e.path), changed.map(c => c.path));
  assert.match(f.mustTick[0].reason, /tick it at the plan gate/);
  const ok = checkFences({ profile, changed, plan: plan(changed.map(c => c.path), { ticked: ['apps/web/package.json', 'apps/api/src/auth/session.mjs'] }), ticked: ['.github/workflows/ci.yml'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.mustTick.length, 0);
});

test('pinnedChanged: an existing contract test outside the plan fails; a new one is a new test', () => {
  const f = checkFences({ profile, changed: [M('apps/api/src/billing.contract.test.mjs'), A('apps/api/src/new.contract.test.mjs')], plan: plan([]) });
  assert.equal(bucketOf(f, 'apps/api/src/billing.contract.test.mjs'), 'pinnedChanged');
  assert.equal(bucketOf(f, 'apps/api/src/new.contract.test.mjs'), null);
  const listed = checkFences({ profile, changed: [M('apps/api/src/billing.contract.test.mjs')], plan: plan(['apps/api/src/billing.contract.test.mjs']) });
  assert.equal(listed.ok, true);
});

test('pinnedChanged: only plan.files unpins a contract test, not a slice test list or a removed file', () => {
  const pinned = 'apps/api/src/billing.contract.test.mjs';
  // The slice's `tests` list is Claude's and can't be edited at the plan gate, so it never unpins.
  const viaTests = checkFences({ profile, changed: [M('apps/api/src/billing/charge.mjs'), M(pinned)], plan: plan(['apps/api/src/billing/charge.mjs'], { tests: [pinned] }) });
  assert.equal(bucketOf(viaTests, pinned), 'pinnedChanged');
  assert.equal(viaTests.ok, false);
  assert.equal(viaTests.hardFail, true);
  assert.match(viaTests.pinnedChanged[0].reason, /plan's files don't list/);
  // A pinned file you removed from the plan's files is pinned again.
  const removed = checkFences({ profile, changed: [M(pinned)], plan: plan(['apps/api/src/billing/charge.mjs', pinned], { removedFiles: [pinned] }) });
  assert.equal(bucketOf(removed, pinned), 'pinnedChanged');
  // An existing non-pinned test in the slice's tests is still covered (the plan prompts list changed tests there).
  const plainTest = checkFences({ profile, changed: [M('apps/web/src/cart.test.mjs')], plan: plan(['apps/web/src/cart.mjs'], { tests: ['apps/web/src/cart.test.mjs'] }) });
  assert.equal(plainTest.ok, true);
});

test('existingTestChanged: fails unless the plan lists the test (files or tests)', () => {
  const changed = [M('apps/web/src/cart.test.mjs')];
  const f = checkFences({ profile, changed, plan: plan(['apps/web/src/cart.mjs']) });
  assert.equal(bucketOf(f, 'apps/web/src/cart.test.mjs'), 'existingTestChanged');
  assert.match(fenceSummary(f), /1 existing test changed/);
  assert.equal(checkFences({ profile, changed, plan: plan([], { tests: ['apps/web/src/cart.test.mjs'] }) }).ok, true);
  assert.equal(checkFences({ profile, changed, plan: plan(['APPS/WEB/src/cart.test.mjs']) }).ok, true);
  // A deleted existing test is a changed existing test too.
  assert.equal(bucketOf(checkFences({ profile, changed: [D('apps/web/src/cart.test.mjs')], plan: plan([]) }), 'apps/web/src/cart.test.mjs'), 'existingTestChanged');
});

test('outsidePlan: the rest, except plan files, new tests, always-allowed records and ticked files', () => {
  const changed = [M('apps/web/src/cart.mjs'), M('apps/web/src/other.mjs'), A('apps/web/src/cart.test.mjs'), A('docs/records/CART-1.md'), M('docs/README.md')];
  const f = checkFences({ profile, changed, plan: plan(['apps/web/src/cart.mjs']) });
  assert.deepEqual(f.outsidePlan.map(e => e.path), ['apps/web/src/other.mjs']);
  assert.equal(f.ok, false);
  assert.equal(f.hardFail, false);
  assert.equal(f.needsYou, true);
  assert.deepEqual(f.scope, { inPlan: 4, total: 5, allowedByUser: [], outside: ['apps/web/src/other.mjs'] });
  assert.match(fenceSummary(f), /1 file outside the plan needs your OK/);
});

test('the allowance path: a file you allowed passes, and the summary says so', () => {
  const changed = [M('apps/web/src/cart.mjs'), M('apps/web/src/other.mjs')];
  const allowances = [{ path: 'apps/web/src/other.mjs', at: '2026-10-22T10:00:00Z', stage: 'checks', reason: 'allowed at the fence gate' }];
  const f = checkFences({ profile, changed, plan: plan(['apps/web/src/cart.mjs']), allowances });
  assert.equal(f.ok, true);
  assert.deepEqual(f.allowedByUser, ['apps/web/src/other.mjs']);
  assert.deepEqual(f.scope, { inPlan: 1, total: 2, allowedByUser: ['apps/web/src/other.mjs'], outside: [] });
  assert.equal(fenceSummary(f), 'Pass, 1 allowed by you');
  // An allowance never covers a hard bucket.
  const hard = checkFences({ profile, changed: [M('vendor/x.mjs'), M('apps/web/src/b.test.mjs')], plan: plan([]), allowances: ['vendor/x.mjs', 'apps/web/src/b.test.mjs'] });
  assert.equal(bucketOf(hard, 'vendor/x.mjs'), 'forbidden');
  assert.equal(bucketOf(hard, 'apps/web/src/b.test.mjs'), 'existingTestChanged');
  assert.equal(hard.ok, false);
});

test('files removed from the plan are outside it again', () => {
  const p = plan(['apps/web/src/a.mjs', 'apps/web/src/b.mjs'], { removedFiles: ['apps/web/src/b.mjs'], tests: ['apps/web/src/a.test.mjs'] });
  assert.deepEqual([...planPaths(p)], ['apps/web/src/a.mjs', 'apps/web/src/a.test.mjs']);
  assert.deepEqual([...planFilePaths(p)], ['apps/web/src/a.mjs']);
  const f = checkFences({ profile, changed: [M('apps/web/src/a.mjs'), M('apps/web/src/b.mjs')], plan: p });
  assert.deepEqual(f.outsidePlan.map(e => e.path), ['apps/web/src/b.mjs']);
});

test('renames: the old path is an existing file that changed, the new path a new file', () => {
  // Moving an existing test out of its place changes an existing test.
  const t = checkFences({ profile, changed: [R('apps/web/src/a.test.mjs', 'apps/web/src/moved/a.test.mjs')], plan: plan([]) });
  assert.equal(bucketOf(t, 'apps/web/src/a.test.mjs'), 'existingTestChanged');
  assert.equal(bucketOf(t, 'apps/web/src/moved/a.test.mjs'), null);
  // Renaming an existing migration is forbidden; renaming into a forbidden path too.
  const m = checkFences({ profile, changed: [R('apps/api/migrations/001_init.sql', 'apps/api/old/001.sql'), R('src/x.mjs', 'vendor/x.mjs')], plan: plan(['apps/api/old/001.sql', 'src/x.mjs', 'vendor/x.mjs']) });
  assert.equal(bucketOf(m, 'apps/api/migrations/001_init.sql'), 'forbidden');
  assert.equal(bucketOf(m, 'vendor/x.mjs'), 'forbidden');
  // A planned rename of a source file passes when the plan lists both sides.
  const ok = checkFences({ profile, changed: [R('apps/web/src/a.mjs', 'apps/web/src/b.mjs')], plan: plan(['apps/web/src/a.mjs', 'apps/web/src/b.mjs']) });
  assert.equal(ok.ok, true);
  assert.equal(ok.scope.total, 2);
  // With only the old side planned, the new side waits for you.
  const half = checkFences({ profile, changed: [R('apps/web/src/a.mjs', 'apps/web/src/b.mjs')], plan: plan(['apps/web/src/a.mjs']) });
  assert.deepEqual(half.outsidePlan.map(e => e.path), ['apps/web/src/b.mjs']);
});

test('read-only pipelines report only forbidden and must-tick files, as information', () => {
  const changed = [M('vendor/x.mjs'), M('apps/web/package.json'), M('apps/web/src/a.test.mjs'), M('apps/web/src/a.mjs')];
  for (const pipeline of ['review', 'check']) {
    const f = checkFences({ profile, changed, pipeline });
    assert.equal(f.ok, true);
    assert.equal(f.readOnly, true);
    assert.equal(f.hardFail, false);
    assert.equal(f.needsYou, false);
    assert.deepEqual(f.forbidden.map(e => e.path), ['vendor/x.mjs']);
    assert.deepEqual(f.mustTick.map(e => e.path), ['apps/web/package.json']);
    assert.equal(f.existingTestChanged.length + f.outsidePlan.length + f.pinnedChanged.length, 0);
    assert.match(fenceSummary(f), /^Information: 1 forbidden file, 1 config or risk file changed$/);
  }
});

test('with no plan, every changed source file is outside the plan', () => {
  const f = checkFences({ profile, changed: [M('apps/web/src/a.mjs'), A('apps/web/src/a.test.mjs')], pipeline: 'debug' });
  assert.deepEqual(f.outsidePlan.map(e => e.path), ['apps/web/src/a.mjs']);
});

test('normalizeChanged and touchedPaths map git letters and backslashes', () => {
  assert.deepEqual(normalizeChanged([{ path: '.\\a\\b.mjs', status: 'C', oldPath: 'a/c.mjs' }, { path: 'x', status: '?' }, { path: 'y', status: 'T' }, { status: 'M' }]), [
    { path: 'a/b.mjs', status: 'A', oldPath: 'a/c.mjs' }, { path: 'x', status: 'A' }, { path: 'y', status: 'M' },
  ]);
  assert.deepEqual(touchedPaths([R('a.mjs', 'b.mjs'), D('c.mjs')]), [
    { path: 'a.mjs', status: 'R', isNew: false, deleted: true },
    { path: 'b.mjs', status: 'R', isNew: true, deleted: false },
    { path: 'c.mjs', status: 'D', isNew: false, deleted: true },
  ]);
});

test('bare paths: existsAtBase decides whether they are new; without it they count as existing', () => {
  const exists = p => p !== 'apps/web/src/fresh.test.mjs' && p !== 'apps/api/migrations/009.sql';
  const f = checkFences({ profile, changed: ['apps/web/src/fresh.test.mjs', 'apps/web/src/old.test.mjs', 'apps/api/migrations/009.sql'], plan: plan([]), existsAtBase: exists });
  assert.equal(bucketOf(f, 'apps/web/src/fresh.test.mjs'), null);              // a new test file
  assert.equal(bucketOf(f, 'apps/web/src/old.test.mjs'), 'existingTestChanged');
  assert.equal(bucketOf(f, 'apps/api/migrations/009.sql'), 'mustTick');         // mustTickNew applies
  const strict = checkFences({ profile, changed: ['apps/web/src/fresh.test.mjs'], plan: plan([]) });
  assert.equal(bucketOf(strict, 'apps/web/src/fresh.test.mjs'), 'existingTestChanged');
  assert.deepEqual(normalizeChanged(['a\\b.mjs', { path: 'c.mjs' }]), [{ path: 'a/b.mjs', status: 'M', unknown: true }, { path: 'c.mjs', status: 'M', unknown: true }]);
});

test('mustTickFiles lists what the plan gate must ask about', () => {
  assert.deepEqual(mustTickFiles(profile, ['apps/web/src/a.mjs', 'apps/web/package.json', 'apps/api/migrations/003.sql', 'tsconfig.json']),
    ['apps/api/migrations/003.sql', 'apps/web/package.json', 'tsconfig.json']);
  // An existing migration (status M) is not a must-tick-new file.
  assert.deepEqual(mustTickFiles(profile, [{ path: 'apps/api/migrations/001.sql', status: 'M' }, { path: 'apps/api/migrations/004.sql', status: 'A' }]), ['apps/api/migrations/004.sql']);
  assert.deepEqual(mustTickFiles({}, ['package.json']), []);
});

test('mustTickFiles with existsAtBase: an existing migration is not offered as a tick; forbiddenFiles flags it', () => {
  const base = new Set(['apps/api/migrations/001_init.sql', 'apps/web/package.json']);
  const paths = ['apps/api/migrations/001_init.sql', 'apps/api/migrations/005_new.sql', 'apps/web/package.json', 'vendor/lib.mjs', 'apps/web/src/a.mjs'];
  // Without existsAtBase a bare string may be new, so the old migration is offered (the old behaviour).
  assert.deepEqual(mustTickFiles(profile, paths), ['apps/api/migrations/001_init.sql', 'apps/api/migrations/005_new.sql', 'apps/web/package.json']);
  // With it, the existing migration can never pass the fence, so it is not a tick.
  assert.deepEqual(mustTickFiles(profile, paths, { existsAtBase: base }), ['apps/api/migrations/005_new.sql', 'apps/web/package.json']);
  assert.deepEqual(mustTickFiles(profile, paths, { existsAtBase: p => base.has(p) }), ['apps/api/migrations/005_new.sql', 'apps/web/package.json']);
  // A forbidden file is never offered, even without existsAtBase.
  assert.deepEqual(mustTickFiles({ fences: { forbidden: ['vendor/**'], mustTick: ['vendor/**'] } }, ['vendor/x.json']), []);
  const forb = forbiddenFiles(profile, paths, { existsAtBase: base });
  assert.deepEqual(forb.map(x => [x.path, x.glob]), [['apps/api/migrations/001_init.sql', 'apps/api/migrations/**'], ['vendor/lib.mjs', 'vendor/**']]);
  assert.match(forb[0].reason, /existed at base and may never change/);
  // Without existsAtBase only fences.forbidden is known for sure.
  assert.deepEqual(forbiddenFiles(profile, paths).map(x => x.path), ['vendor/lib.mjs']);
});

test('editableInStage: Claude Code protects .claude, .git, .husky, .vscode and .mcp.json', () => {
  for (const p of ['.husky/pre-commit', '.claude/settings.json', 'apps/x/.claude/a.md', '.vscode/settings.json', '.git/config', '.mcp.json']) assert.equal(editableInStage(p), false, p);
  for (const p of ['package.json', 'tsconfig.json', '.github/workflows/ci.yml', 'CLAUDE.md', '.gitignore', 'src/husky.mjs']) assert.equal(editableInStage(p), true, p);
});

test('an invalid testPattern is reported in plain words', () => {
  assert.throws(() => checkFences({ profile: { fences: { testPattern: '(' } }, changed: [M('a.mjs')] }), /fences.testPattern "\(" is not a valid regular expression/);
});
