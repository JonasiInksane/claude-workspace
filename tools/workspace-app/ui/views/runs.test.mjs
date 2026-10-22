// Tests for the pure helpers of the Runs view (views/runs.js): the GET /api/runs query for the
// filters and paging, the start-time text, where Open goes, and the duration text. The view
// itself needs a browser; it loads in Node because nothing in it touches the DOM until it renders.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationText, openTarget, PAGE, runsQuery, startedText } from './runs.js';

test('runs: the query carries only the filters that are set, plus paging', () => {
  assert.equal(runsQuery({}), `limit=${PAGE}`);
  assert.equal(runsQuery({ project: 'example', pipeline: '', status: 'waiting' }), `limit=${PAGE}&project=example&status=waiting`);
  assert.equal(runsQuery({ pipeline: 'refactor' }, { before: '261022-100010-refactor-review-gate', limit: 50 }),
    'limit=50&pipeline=refactor&before=261022-100010-refactor-review-gate');
  // The route allows 1 to 500.
  assert.equal(runsQuery({}, { limit: 9999 }), 'limit=500');
  assert.equal(runsQuery({}, { limit: 0 }), `limit=${PAGE}`);
});

test('runs: a start time is the clock today and the date before', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  assert.equal(startedText(new Date(2026, 9, 22, 9, 5).toISOString(), now), '09:05');
  assert.match(startedText(new Date(2026, 9, 20, 9, 5).toISOString(), now), /20/);
  assert.equal(startedText('', now), '');
  assert.equal(startedText('not a date', now), '');
});

test('runs: Open goes to the review gate only for a run waiting there', () => {
  assert.deepEqual(openTarget({ id: 'a', status: 'waiting', waiting: 'review' }), ['review', 'a']);
  assert.deepEqual(openTarget({ id: 'b', status: 'waiting', waiting: 'commit' }), ['review', 'b']);
  assert.deepEqual(openTarget({ id: 'c', status: 'waiting', waiting: 'plan' }), ['run', 'c']);
  assert.deepEqual(openTarget({ id: 'd', status: 'committed', waiting: null }), ['run', 'd']);
  assert.deepEqual(openTarget({ id: 'e', status: 'in-terminal', waiting: 'review' }), ['run', 'e']);
});

test('runs: a duration says "so far" until the run has ended', () => {
  assert.equal(durationText({ status: 'passed', durationMs: 252000, endedAt: '2026-10-22T10:00:00Z' }), '4 m 12 s');
  assert.equal(durationText({ status: 'committed', durationMs: 14000, endedAt: null }), '14 s');
  assert.equal(durationText({ status: 'waiting', durationMs: 4_680_000, endedAt: null }), '1 h 18 m so far');
  assert.equal(durationText({ status: 'running', durationMs: null }), '');
});
