// Tests for the pure helpers of the live run view (views/run.js), its timeline and stage list
// (parts/timeline.js) and its gate cards (parts/gatecards.js): which buttons each status shows,
// button labels, the meters (turns, stage time, estimate, usage window), the header facts, the
// celebration condition, tool rows folded into one line, replay pacing, stage states and meta
// lines, plan slices, evidence paths, the fence's default note and triage decisions. The view
// needs a browser; these modules load in Node because nothing in them touches the DOM until
// they render (the checks table, which does, is loaded only when a Check run shows it). One test
// renders the view in the stand-in DOM (test/dom.mjs) for the header's Ask button.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionLabel, allGreen, currentIndex, estimateUsd, fmtStageTime, fmtUsd, metaParts, notifyKey, rateLimitParts, rateLimitText,
  stageMs, stateActions, statusText, turnMeter, turnStage,
} from './run.js';
import { foldRows, kindGroup, kindLabel, replayDelay, rowState, stageMeta, stageState } from '../parts/timeline.js';
import { fakeFetch, installDom, settle } from '../../test/dom.mjs';
import { actionOf, changedDecisions, decisionsProblem, evidencePaths, fenceNote, gateKey, sliceFiles } from '../parts/gatecards.js';

const A = (action, enabled = true, reason = '', label = action) => ({ action, label, enabled, reason });

test('run: the state card shows the status\'s buttons; "always" ones even when off', () => {
  const run = {
    status: 'capped',
    actions: [A('resume', true, '', 'Resume session'), A('retry', false, 'nope'), A('stop', false, 'Only editing runs have a patch to keep.'), A('report', true)],
  };
  assert.deepEqual(stateActions(run).map(a => a.action), ['resume', 'report']);
  assert.deepEqual(stateActions({ ...run, status: 'gates-red', actions: [A('fix', false, 'You used all 2 fix rounds.'), A('stop')] }).map(a => a.action), ['fix', 'stop']);
  assert.deepEqual(stateActions({ status: 'running', actions: [A('cancel')] }), []);
  assert.deepEqual(stateActions({ status: 'waiting', actions: [A('park', false, 'x')] }), []);
  assert.deepEqual(stateActions(null), []);
});

test('run: Resume says +20 turns once; Fix again counts your rounds', () => {
  const capped = { current: { index: 0 }, stages: [{ status: 'capped' }] };
  assert.equal(actionLabel(capped, A('resume', true, '', 'Resume session')), 'Resume (+20 turns)');
  assert.equal(actionLabel({ ...capped, stages: [{ status: 'capped', bonusUsed: true }] }, A('resume', true, '', 'Resume session')), 'Resume session');
  const red = { status: 'gates-red', fixRounds: { user: 1, maxUser: 2 }, stages: [] };
  assert.equal(actionLabel(red, A('fix', true, '', 'Fix selected')), 'Fix again (round 2 of 2)');
  assert.equal(actionLabel({ status: 'waiting' }, A('retry', true, '', 'Retry stage')), 'Retry stage');
});

test('run: the waiting badge names the gate', () => {
  assert.equal(statusText({ status: 'waiting', waiting: { kind: 'fence' } }), 'Needs you: file outside the plan');
  assert.equal(statusText({ status: 'waiting', waiting: { kind: 'plan' } }), 'Needs you: plan');
  assert.equal(statusText({ status: 'running' }), '');
  assert.equal(statusText({ status: 'waiting', waiting: { kind: 'odd' } }), '');
});

test('run: the turn meter follows the current or latest Claude stage, live while it runs', () => {
  const run = {
    current: { index: 2 },
    stages: [
      { id: 'scope', kind: 'claude', label: 'Scope', attempts: [{ k: 1, turns: 5, maxTurns: 40 }] },
      { id: 'plan', kind: 'human' },
      { id: 'implement', kind: 'claude', label: 'Implement', attempts: [{ k: 2, maxTurns: 60 }] },
    ],
  };
  assert.equal(currentIndex(run), 2);
  assert.equal(turnStage(run).id, 'implement');
  assert.deepEqual(turnMeter(run, new Map([['implement#2', 7]])), { label: 'Turns · Implement', n: 7, max: 60 });
  assert.deepEqual(turnMeter({ ...run, current: { index: 1 } }), { label: 'Turns · Scope', n: 5, max: 40 });
  assert.deepEqual(turnMeter({ stages: [{ id: 'pre', kind: 'gate', status: 'running' }] }), { label: 'Turns', n: 0, max: 0 });
  assert.equal(currentIndex({ stages: [{ status: 'done' }, { status: 'skipped' }, { status: 'pending' }] }), 2);
});

test('run: stage time runs to now while running or waiting, else to the recorded end', () => {
  const t0 = '2026-10-22T10:00:00.000Z';
  const now = Date.parse('2026-10-22T10:05:00.000Z');
  assert.equal(stageMs({ status: 'running', startedAt: t0 }, now), 300_000);
  assert.equal(stageMs({ status: 'waiting', startedAt: t0 }, now), 300_000);
  assert.equal(stageMs({ status: 'done', startedAt: t0, endedAt: '2026-10-22T10:00:12.000Z' }, now), 12_000);
  assert.equal(stageMs({ status: 'capped', startedAt: t0, attempts: [{ endedAt: '2026-10-22T10:01:00.000Z' }] }, now), 60_000);
  assert.ok(Number.isNaN(stageMs({ status: 'interrupted', startedAt: t0 }, now)));
  assert.ok(Number.isNaN(stageMs({ status: 'pending' }, now)));
  assert.equal(fmtStageTime(12_400), '12 s');
  assert.equal(fmtStageTime(11 * 60_000 + 5000), '11 min');
  assert.equal(fmtStageTime(NaN), '');
});

test('run: the estimate adds every attempt; tiny sums read "< $0.01"', () => {
  const run = { stages: [{ attempts: [{ estUsd: 1.2 }, { estUsd: 0.6 }] }, { attempts: [{}] }, { kind: 'gate' }] };
  assert.equal(estimateUsd(run), 1.7999999999999998);
  assert.equal(fmtUsd(estimateUsd(run)), '≈ $1.80 API-equivalent');
  assert.equal(fmtUsd(0.0016), '< $0.01 API-equivalent');
  assert.equal(fmtUsd(estimateUsd({ stages: [] })), 'no estimate yet');
});

test('run: the usage window reads like the server\'s summary (ADDENDUM A12)', () => {
  const resetsAt = Math.floor(new Date(2026, 9, 22, 14, 0, 0).getTime() / 1000);
  assert.deepEqual(rateLimitParts({ status: 'allowed', utilization: 0.42, resetsAt }), { pct: 42, resets: '14:00', limited: false });
  assert.equal(rateLimitText({ status: 'allowed', utilization: 0.42, resetsAt }), 'Usage, 5-hour window: 42% (resets 14:00)');
  assert.equal(rateLimitText({ status: 'rejected', utilization: 1, resetsAt }), 'Usage, 5-hour window: 100% (resets 14:00), limit reached');
  assert.equal(rateLimitText({ utilization: 0.5 }), 'Usage, 5-hour window: 50%');
  assert.equal(rateLimitText(null), '');
  assert.equal(rateLimitText({ utilization: 'x' }), '');
});

test('run: header facts, the celebration condition and the notify key', () => {
  const run = {
    branch: 'app/1022-x', base: { branch: 'main', sha: '3509c76000ee' }, isolation: { mode: 'worktree', tree: 'C:\\dev\\example-run' },
    level: 'standard', levelReason: ['money path: src/pay/**'],
  };
  assert.deepEqual(metaParts(run), [{ code: 'app/1022-x' }, { text: 'base main 3509c76' }, { text: 'run worktree example-run' }, { text: 'Standard (money path: src/pay/**)' }]);
  assert.deepEqual(metaParts({ isolation: { mode: 'none', treeMode: 'main' }, base: { sha: 'abcdef12' } }), [{ text: 'base abcdef1' }, { text: 'read-only in the main checkout' }]);
  assert.equal(allGreen({ lastGate: { result: 'green' }, allowances: [] }), true);
  assert.equal(allGreen({ lastGate: { result: 'green' }, allowances: [{ path: 'a' }] }), false);
  assert.equal(allGreen({ lastGate: { result: 'red' } }), false);
  assert.equal(notifyKey('261022-1-x'), 'ws-notify:261022-1-x');
});

test('run: Ask in the header shows once the run is loaded and opens the Ask panel for it (parts/ask-panel.js)', async () => {
  const ID = '261022-100001-explain-passed';
  const dom = installDom({ hash: `#run/${ID}` });
  try {
    fakeFetch(path => (path.startsWith('/api/run?')
      ? { ok: true, run: { id: ID, project: 'example', pipeline: 'explain', pipelineLabel: 'Explain', title: 'Explain: What does charge do?', status: 'passed',
        stages: [{ id: 'answer', kind: 'claude', status: 'done', attempts: [] }], actions: [], outputs: {} }, rows: [], next: 0, more: false }
      : { ok: true, pipelines: [], routes: [] }));
    const { default: view } = await import('./run.js');
    const section = dom.document.createElement('section');
    dom.document.body.append(section);
    view.render(section, { sub: ID });
    const askBtn = section.querySelector('.run-head-actions .ask-open-btn');
    assert.ok(askBtn, 'the header has an Ask button');
    assert.equal(askBtn.hidden, true, 'hidden until the run is loaded');
    view.onShow({ sub: ID });
    await settle(10);
    assert.equal(askBtn.hidden, false);
    assert.equal(askBtn.getAttribute('aria-label'), 'Ask about this run');
    dom.click(askBtn);
    const panel = dom.document.getElementById('ask-panel');
    assert.equal(panel.querySelector('.ask-title').textContent, 'Ask about this run');
    assert.equal(panel.querySelector('.ask-chip').textContent, 'Run · Explain: What does charge do?');
    assert.equal(askBtn.getAttribute('aria-expanded'), 'true');
    dom.click(panel.querySelector('.ask-close'));
    assert.equal(dom.document.activeElement, askBtn, 'the focus goes back to Ask');
    view.onHide();
  } finally {
    dom.uninstall();
  }
});

test('timeline: kinds, groups and states are words', () => {
  assert.equal(kindLabel('text'), 'Claude');
  assert.equal(kindLabel('deny'), 'Denied');
  assert.equal(kindLabel('constructor'), 'constructor');
  assert.deepEqual(['text', 'tool', 'deny', 'gate', 'stage', 'you'].map(kindGroup), ['text', 'tool', 'tool', 'gate', 'other', 'other']);
  assert.equal(rowState({ kind: 'tool', tool: { phase: 'start' } }), 'running');
  assert.equal(rowState({ kind: 'gate', ok: false }), 'failed');
  assert.equal(rowState({ kind: 'gate', ok: true }), '');
});

test('timeline: a tool\'s end row takes its start row\'s place', () => {
  const rows = [
    { seq: 1, kind: 'stage', msg: 'Scope started' },
    { seq: 2, kind: 'tool', msg: 'Read a', tool: { id: 't1', phase: 'start' } },
    { seq: 3, kind: 'tool', msg: 'Read b', tool: { id: 't2', phase: 'start' } },
    { seq: 4, kind: 'tool', msg: 'Read a', tool: { id: 't1', phase: 'end' }, ok: true },
    { seq: 5, kind: 'text', msg: '"done"' },
  ];
  assert.deepEqual(foldRows(rows).map(r => r.seq), [1, 4, 3, 5]);
});

test('timeline: replay waits a tenth of the recorded gap, within 40 ms and 1.5 s', () => {
  const at = s => ({ t: new Date(Date.UTC(2026, 9, 22, 10, 0, s)).toISOString() });
  assert.equal(replayDelay(at(0), at(5)), 500);
  assert.equal(replayDelay(at(0), at(0)), 40);
  assert.equal(replayDelay(at(0), at(59)), 1500);
  assert.equal(replayDelay({}, at(1)), 120);
});

test('stages: state words, a parked wait, and the meta line', () => {
  assert.deepEqual(stageState({ status: 'waiting' }), { text: 'Needs you', cls: 'waiting', mark: '●' });
  assert.equal(stageState({ status: 'waiting' }, 'parked').text, 'Parked');
  assert.equal(stageState({ status: 'cancelled' }).text, 'Stopped');
  assert.equal(stageState({ status: 'odd' }).text, 'Not started');
  const s = { who: 'claude', status: 'done', meta: '5 turns', startedAt: '2026-10-22T10:00:00Z', endedAt: '2026-10-22T10:03:00Z', attempts: [{ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }] };
  assert.equal(stageMeta(s), 'Claude · opus/high · attempt 2 · 5 turns · 3 m 0 s');
  assert.equal(stageMeta({ who: 'you', status: 'waiting', startedAt: '2026-10-22T10:00:00Z' }), 'you');
});

test('gate cards: the wait key, actions, slice files and evidence paths', () => {
  assert.equal(gateKey({ status: 'waiting', waiting: { kind: 'plan', since: 'x' } }), 'plan|x');
  assert.equal(gateKey({ status: 'parked', waiting: null }), '');
  assert.deepEqual(actionOf({ actions: [A('allow')] }, 'allow'), A('allow'));
  assert.equal(actionOf({}, 'allow'), null);
  const out = { files: [{ path: 'a.js' }, { path: 'b.js' }], slices: [{ files: ['a.js', 'c.js', 'a.js'] }, { files: [] }] };
  assert.deepEqual(sliceFiles(out, 0), ['a.js', 'c.js']);
  assert.deepEqual(sliceFiles(out, 1), ['a.js', 'b.js']);
  assert.deepEqual(sliceFiles({}, 0), []);
  assert.deepEqual(evidencePaths(['src/a.js:12 shows the bug', 'src\\b.js:3:4', '../out.js', 'C:/abs.js', 'src/a.js', 'no']), ['src/a.js', 'src/b.js', 'no']);
});

test('gate cards: the fence note and triage decisions', () => {
  assert.equal(fenceNote(['a/b.js']), 'Leave a/b.js out of this change.');
  assert.equal(fenceNote(['a.js', 'b.js']), 'Leave these files out of this change: a.js, b.js.');
  assert.equal(fenceNote([]), '');
  const saved = new Map([['F1', { decision: 'fix', reason: '' }], ['F2', null]]);
  const picks = new Map([['F1', { decision: 'fix', reason: '' }], ['F2', { decision: 'dismiss', reason: '  ' }], ['F3', { decision: '', reason: '' }]]);
  const changed = changedDecisions(picks, saved);
  assert.deepEqual(changed, [{ ref: 'F2', decision: 'dismiss', reason: '' }]);
  assert.equal(decisionsProblem(changed), 'Say why you dismiss F2.');
  assert.equal(decisionsProblem([{ ref: 'F2', decision: 'dismiss', reason: 'dup' }]), '');
  assert.equal(decisionsProblem([{ ref: 'C1', decision: 'keep', reason: 'x'.repeat(301) }]), 'The reason for C1 is longer than 300 characters.');
});
