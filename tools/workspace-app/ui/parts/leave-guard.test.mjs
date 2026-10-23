// Tests for parts/leave-guard.js with a stand-in DOM (test/dom.mjs): no guard, the guarded screen
// itself and a clean editor never ask; unsaved work asks, OK runs onDiscard and lets the route
// through, Cancel puts the guarded address back without a new history entry; clearing only the
// guard of the given screen; a broken dirty() never blocks; and beforeunload asks only with
// unsaved work. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, installDom } from '../../test/dom.mjs';

const dom = installDom({ hash: '#project/example/settings' });
after(() => dom.uninstall());
const { beforeUnload, clearLeaveGuard, guardedHash, mayLeave, setLeaveGuard } = await import('./leave-guard.js');

const HASH = '#project/example/settings';
let dirty = false;
let discarded = 0;
const questions = [];
const ask = answer => q => { questions.push(q); return answer; };
const guard = () => setLeaveGuard({ hash: HASH, dirty: () => dirty, message: 'Discard your changes to the settings of example?', onDiscard: () => { discarded++; } });

test('no guard, the guarded screen itself, or nothing to lose: the route goes through without a question', () => {
  clearLeaveGuard();
  assert.equal(mayLeave('#today', ask(false)), true);
  guard();
  assert.equal(guardedHash(), HASH);
  assert.equal(mayLeave(HASH, ask(false)), true, 'showing the same screen again is not leaving');
  dirty = false;
  assert.equal(mayLeave('#today', ask(false)), true);
  assert.deepEqual(questions, []);
  assert.equal(discarded, 0);
});

test('unsaved work: Cancel keeps the screen and puts its address back; OK discards and goes', () => {
  guard();
  dirty = true;
  dom.location.hash = '#project/example/overview'; // where the click went
  const entries = dom.history.entries.length;
  assert.equal(mayLeave('#project/example/overview', ask(false)), false);
  assert.equal(dom.location.hash, HASH, 'the address is the settings tab again');
  assert.equal(dom.history.entries.length, entries, 'no new history entry');
  assert.deepEqual(questions, ['Discard your changes to the settings of example?']);
  assert.equal(guardedHash(), HASH, 'the guard stays');
  assert.equal(mayLeave('#runs', ask(true)), true);
  assert.equal(discarded, 1);
  assert.equal(guardedHash(), '', 'a discarded draft has nothing left to guard');
  assert.equal(mayLeave('#runs', ask(false)), true);
  questions.length = 0;
});

test('clearLeaveGuard clears only the given screen; a guard without hash or dirty() is no guard', () => {
  guard();
  clearLeaveGuard('#project/other/settings');
  assert.equal(guardedHash(), HASH);
  clearLeaveGuard(HASH);
  assert.equal(guardedHash(), '');
  setLeaveGuard({ hash: HASH });
  assert.equal(guardedHash(), '');
  setLeaveGuard(null);
  assert.equal(guardedHash(), '');
});

test('a dirty() that throws never blocks a route', () => {
  setLeaveGuard({ hash: HASH, dirty: () => { throw new Error('gone'); } });
  assert.equal(mayLeave('#today', ask(false)), true);
  clearLeaveGuard();
});

test('beforeunload asks only while there is unsaved work', () => {
  guard();
  dirty = false;
  const clean = fakeEvent('beforeunload');
  assert.equal(beforeUnload(clean), undefined);
  assert.equal(clean.defaultPrevented, false);
  dirty = true;
  const e = fakeEvent('beforeunload');
  assert.equal(beforeUnload(e), '');
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.returnValue, '');
  // The module listens on the window itself.
  const ev = fakeEvent('beforeunload', { bubbles: false });
  dom.window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  clearLeaveGuard();
});
