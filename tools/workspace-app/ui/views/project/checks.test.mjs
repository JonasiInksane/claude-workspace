// Tests for the project page's Checks tab (views/project/checks.js): the result words (moved from
// the cockpit's tests), and every count a check line carries shown on its own: new failures,
// pre-existing (known) failures, flaky, and passed or skipped when a line has them, never added
// up or folded into passed or failed. Then the tab in a stand-in DOM (test/dom.mjs): the levels
// table with a counts cell per level, the smaller-baseline note and the history.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { checkCounts, checkResult, countsText, default: checks } = await import('./checks.js');

test('check results as text', () => {
  assert.deepEqual(checkResult(null), { cls: 'skip', text: 'Not run yet', icon: '' });
  assert.equal(checkResult({ result: 'pass', chip: '0 new · 61 known' }).text, 'Pass · 0 new · 61 known');
  assert.equal(checkResult({ result: 'fail', chip: '1 new' }).cls, 'fail');
  assert.equal(checkResult({ result: 'error' }).text, 'Error');
  assert.equal(checkResult({ result: 'refused' }).text, 'Refused');
  assert.equal(checkResult({ result: 'cancelled' }).cls, 'skip');
  assert.equal(checkResult({ result: 'odd' }).text, 'odd');
});

test('checkCounts: every number on its own, with its own word, in a fixed order', () => {
  assert.deepEqual(checkCounts({ counts: { new: 1, known: 61, flaky: 0 } }).map(c => c.text), ['1 new failure', '61 pre-existing failures', '0 flaky']);
  // A line with test totals too: passed and skipped stay apart from the failures.
  assert.deepEqual(checkCounts({ counts: { skip: 3, pass: 1204, known: 2, new: 0, fail: 2 } }).map(c => [c.key, c.value]),
    [['pass', 1204], ['fail', 2], ['new', 0], ['known', 2], ['skip', 3]]);
  assert.equal(countsText({ counts: { new: 0, known: 1 } }), '0 new failures · 1 pre-existing failure');
});

test('checkCounts: only real numbers show; unknown keys, text and odd values are left out', () => {
  assert.deepEqual(checkCounts(null), []);
  assert.deepEqual(checkCounts({}), []);
  assert.deepEqual(checkCounts({ counts: 'lots' }), []);
  assert.deepEqual(checkCounts({ counts: { new: '3', known: -1, flaky: Number.NaN, canShrink: 4, weird: 9 } }), []);
  assert.deepEqual(checkCounts({ counts: { known: Infinity, new: 2 } }).map(c => c.text), ['2 new failures']);
  assert.equal(countsText({}), '');
});

const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'checks'], realPath: 'C:\\x' };

test('the tab: one row per level with its counts apart, the baseline, and the history', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  const at = new Date().toISOString();
  const quick = { at, runId: '261022-100007-check-passed', level: 'quick', result: 'pass', chip: '0 new · 2 known', durationMs: 4000, counts: { new: 0, known: 2, flaky: 1 } };
  slot('example').checks = { data: { last: { quick, standard: null, paranoid: null }, history: [quick, { ...quick, at, level: 'standard', result: 'fail', counts: { new: 1, known: 2, flaky: 0 } }] } };
  slot('example').project = { data: { project: { present: true }, baseline: { key: 'k1', known: 2, baseSha: 'abcdef123456', node: '24.11.1', candidate: { key: 'k1', from: 2, to: 1, reason: '1 passes now.' } } } };
  const el = dom.document.createElement('div');
  checks.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  const rows = el.querySelectorAll('table.ck-levels tbody tr');
  assert.equal(rows.length, 3, 'Quick, Standard, Paranoid');
  const badges = rows[0].querySelectorAll('.ck-counts .badge').map(b => b.textContent);
  assert.deepEqual(badges, ['0 new failures', '2 pre-existing failures', '1 flaky'], 'each count in its own badge');
  assert.equal(rows[0].querySelectorAll('.ck-counts .badge')[1].className, 'badge amber');
  assert.match(textOf(rows[1]), /Not run yet/);
  const text = textOf(el);
  assert.match(text, /Smaller baseline available for abcdef1: 2 → 1\./);
  assert.match(text, /Known failures are pre-existing: they show on their own and never turn a check red\./);
  const history = el.querySelectorAll('.ck-history li');
  assert.equal(history.length, 2);
  assert.match(textOf(history[1]), /Standard · Fail · 0 new · 2 known/);
  assert.match(textOf(history[1]), /1 new failure · 2 pre-existing failures · 0 flaky/);
  assert.equal(history[0].querySelector('button').getAttribute('aria-label'), 'Open the Quick check run (just now)', 'each Open says which check it opens');
  dom.click(el.querySelector('[data-key="check:quick:261022-100007-check-passed"]'));
  assert.equal(dom.location.hash, '#run/261022-100007-check-passed', 'a result opens its check run');
});

test('the tab: a first load that fails says so in both cards at once, not Loading…', () => {
  const other = { ...example, name: 'other' };
  const el = dom.document.createElement('div');
  const paint = () => checks.render(el, { state: store.state, project: other, rest: '', go: store.go, refresh: () => {} });
  paint();
  assert.equal(el.querySelectorAll('.card').length, 2);
  assert.match(textOf(el.querySelectorAll('.card')[1]), /^History .*Loading…$/);
  slot('other').checks = { data: undefined, error: 'The checks could not be read.', status: 500 };
  paint();
  assert.match(textOf(el.querySelectorAll('.card')[0]), /The checks could not be read\. Try again/);
  assert.match(textOf(el.querySelectorAll('.card')[1]), /Not loaded\./, 'the history says so too, without waiting for the next minute');
});

test('the tab: Check my work is off until the checkout is here; no history yet', () => {
  slot('example').checks = { data: { last: { quick: null, standard: null, paranoid: null }, history: [] } };
  slot('example').project = { data: { project: { present: false }, baseline: { key: null } } };
  const el = dom.document.createElement('div');
  checks.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  assert.equal(el.querySelector('[data-key="check"]').disabled, true);
  assert.match(textOf(el), /Link the checkout first\./);
  assert.match(textOf(el), /No checks yet\./);
  assert.match(textOf(el), /No baseline yet\./);
});
