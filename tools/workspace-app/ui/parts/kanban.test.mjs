// Tests for the pure helpers of the findings board (parts/kanban.js, the Findings tab's Audit
// progress card): a card's text, what a click does, the border class per severity, and long
// columns that show their first cards and say what they hide. Moved here with the board from the
// cockpit's tests; the cockpit's and Health's own helpers are tested next to the tabs that took
// them over (views/project/*.test.mjs). Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAction, cardMeta, moreText, recordText, severityClass, splitColumn } from './kanban.js';

const finding = over => ({ id: 'EX-1', title: 'A thing', severity: 'high', phase: '1', area: '', status: 'open', ownerDecision: false,
  records: [], commits: [], branch: null, runId: null, ...over });

test('kanban: card text says severity, phase and a tag per column, in words', () => {
  assert.equal(cardMeta(finding(), 'open', { nextUpId: 'EX-1' }), 'High · Phase 1 · next up');
  assert.equal(cardMeta(finding({ status: 'proposed', phase: null }), 'open'), 'High · proposed');
  assert.equal(cardMeta(finding({ ownerDecision: true }), 'open'), 'High · Phase 1 · owner decision');
  assert.equal(cardMeta(finding({ area: 'members', severity: 'medium' }), 'open'), 'Medium · Phase 1 · members');
  const runs = new Map([['r1', { id: 'r1', pipeline: 'refactor', status: 'waiting' }]]);
  assert.equal(cardMeta(finding({ status: 'in-run', runId: 'r1' }), 'in-run', { runs }), 'High · Phase 1 · Refactor: Needs you');
  assert.equal(cardMeta(finding({ status: 'in-run', runId: 'gone' }), 'in-run', { runs }), 'High · Phase 1 · in a run');
  assert.equal(cardMeta(finding({ status: 'on-branch', branch: 'app/1021-x' }), 'on-branch'), 'High · Phase 1 · app/1021-x');
  assert.equal(cardMeta(finding({ status: 'done', severity: 'critical', commits: ['0123456789abcdef'] }), 'done'), 'Critical · Phase 1 · 0123456');
  assert.equal(cardMeta(finding({ status: 'done', records: ['REC-ONE'] }), 'done'), 'High · Phase 1 · REC-ONE');
});

test('kanban: a click does what its column says; border classes follow severity', () => {
  assert.equal(cardAction('open', finding()).kind, 'fix');
  assert.equal(cardAction('open', finding({ status: 'proposed' })).kind, 'proposed');
  assert.equal(cardAction('in-run', finding({ runId: 'r1' })).kind, 'run');
  assert.equal(cardAction('in-run', finding()).kind, 'record');
  assert.equal(cardAction('on-branch', finding()).kind, 'review');
  assert.equal(cardAction('done', finding()).kind, 'record');
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(severity => severityClass({ severity }, 'open')), ['high', 'high', 'med', 'low']);
  assert.equal(severityClass({ severity: 'low' }, 'done'), 'done');
});

test('kanban: long columns show the first cards and say what they hide', () => {
  const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => ({ id }));
  assert.deepEqual(splitColumn(items, 5).shown.map(f => f.id), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(splitColumn(items, 5).hidden.map(f => f.id), ['F', 'G']);
  assert.deepEqual(splitColumn(items, 5, true).hidden, []);
  assert.deepEqual(splitColumn(undefined, 5), { shown: [], hidden: [] });
  assert.equal(moreText([{ id: 'F' }, { id: 'G' }, { id: 'H' }]), '+ 3 more, including F and G');
  assert.equal(moreText([{ id: 'F' }]), '+ 1 more: F');
  assert.equal(moreText([]), '');
  assert.equal(recordText(finding({ status: 'done', records: ['REC-ONE'], commits: ['0123456789'] })), 'EX-1: record REC-ONE · commit 0123456');
  assert.equal(recordText(finding({ status: 'done' })), 'EX-1 is done; no record or commit is recorded.');
});
