// Tests for runs/intent.mjs: keyword routing of the intent box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, routeIntent, routesForUi } from './intent.mjs';

const ID = '\\bEX-\\d{1,3}\\b';

test('routes the mockup examples in rule order', () => {
  const cases = [
    ['Refactor the cart totals', 'refactor'],
    ['split the big form file', 'refactor'],
    ['move the math into a cents module', 'refactor'],
    ['fix the login redirect', 'fix'],
    ['why does the export fail?', 'debug'],
    ['saving creates two records twice', 'debug'],
    ['review my uncommitted changes', 'review'],
    ['look over this branch', 'review'],
    ['find import cycles', 'architecture'],
    ['check my work', 'check'],
    ['run the checks', 'check'],
    ['add a CSV export', 'feature'],
    ['let users export their list', 'feature'],
    ['how does a saved form reach the database?', 'explain'],
  ];
  for (const [text, pipeline] of cases) assert.equal(routeIntent(text).pipeline, pipeline, text);
});

test('falls back to explain for empty or unmatched text', () => {
  assert.deepEqual(routeIntent(''), { pipeline: 'explain' });
  assert.deepEqual(routeIntent('   '), { pipeline: 'explain' });
  assert.deepEqual(routeIntent('zebra'), { pipeline: 'explain' });
  assert.deepEqual(routeIntent(null), { pipeline: 'explain' });
});

test('a finding id from the profile pattern routes to fix and is returned', () => {
  assert.deepEqual(routeIntent('EX-12 please', { idPattern: ID }), { pipeline: 'fix', findingId: 'EX-12' });
  assert.deepEqual(routeIntent('fix EX-3', { idPattern: ID }), { pipeline: 'fix', findingId: 'EX-3' });
  // refactor comes first, as in the mockup
  assert.deepEqual(routeIntent('refactor EX-3', { idPattern: ID }), { pipeline: 'refactor' });
  // without a pattern the id means nothing
  assert.deepEqual(routeIntent('EX-12 please'), { pipeline: 'explain' });
  // a broken pattern is ignored, not thrown
  assert.deepEqual(routeIntent('EX-12', { idPattern: '([' }), { pipeline: 'explain' });
});

test('very long text is cut before matching', () => {
  assert.equal(routeIntent(`${'x'.repeat(5000)} fix`).pipeline, 'explain');
});

test('routesForUi lists the same rules, with the id rule after fix', () => {
  const plain = routesForUi();
  assert.equal(plain.length, ROUTES.length);
  for (const r of plain) assert.doesNotThrow(() => new RegExp(r.pattern, r.flags));
  const withId = routesForUi({ idPattern: ID });
  assert.equal(withId.length, ROUTES.length + 1);
  assert.deepEqual(withId[2], { pattern: ID, flags: '', pipeline: 'fix' });
  assert.equal(withId[1].pipeline, 'fix');
});
