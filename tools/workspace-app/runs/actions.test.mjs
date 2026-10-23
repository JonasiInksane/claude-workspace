// Tests for runs/actions.mjs: which buttons a run offers and the reasons the others are off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionAllowed, ACTIONS, allowedActions, currentIndex, gatesGreen, isUnpinnableEnd, takeoverStageIndex } from './actions.mjs';
import { pipelineById } from './catalog.mjs';

const refactor = pipelineById('refactor');
const explain = pipelineById('explain');
const debug = pipelineById('debug');
const feature = pipelineById('feature');

// A refactor run at stage `at` with `status`; stages before it are done.
function run(at, status, extra = {}) {
  const stages = refactor.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: n < at ? 'done' : 'pending', attempts: s.kind === 'claude' ? [] : undefined }));
  stages[at].status = extra.stageStatus || (status === 'waiting' ? 'waiting' : status === 'running' ? 'running' : 'failed');
  return { id: 'r1', project: 'example', pipeline: 'refactor', status, stages, current: { stage: stages[at].id, index: at },
    waiting: null, fixRounds: { auto: 0, user: 0, maxAuto: 2, maxUser: 2 }, lockHeld: true, treeReady: true, outputs: {}, ...extra };
}
const at = id => refactor.stages.findIndex(s => s.id === id);
const enabled = (r, def = refactor, ctx = {}) => allowedActions(r, def, ctx).filter(a => a.enabled).map(a => a.action).sort();
const reason = (r, action, def = refactor, ctx = {}) => actionAllowed(r, def, action, ctx).reason;
const session = (r, id, sid = '11111111-1111-4111-8111-111111111111') => { r.stages[at(id)].attempts = [{ k: 1, sessionId: sid, folder: `stages/0${at(id)}-${id}` }]; return r; };

test('every action is listed once with a label', () => {
  const list = allowedActions(run(0, 'running'), refactor);
  assert.deepEqual(list.map(a => a.action), ACTIONS);
  for (const a of list) assert.ok(a.label && typeof a.reason === 'string');
});

test('a running run offers only cancel', () => {
  assert.deepEqual(enabled(run(at('implement'), 'running', { stageStatus: 'running' })), ['cancel']);
  assert.match(reason(run(at('implement'), 'running'), 'stop'), /Cancel the running stage/);
});

test('the plan gate offers approve, revise, park, stop, cancel and take over', () => {
  const r = session(run(at('plan'), 'waiting', { waiting: { kind: 'plan' } }), 'scope');
  assert.deepEqual(enabled(r), ['approve', 'cancel', 'park', 'report', 'revise', 'stop', 'takeover'].filter(a => a !== 'report'));
  assert.equal(allowedActions(r, refactor).find(a => a.action === 'approve').label, 'Approve plan');
  assert.match(reason(r, 'takeover', refactor, { trusted: false }), /Run claude once in the folder/);
  assert.equal(actionAllowed(r, refactor, 'takeover', { trusted: undefined }).ok, true);
});

test('fix needs ticked-findings at the review gate and rounds left', () => {
  const gate = run(at('review-gate'), 'waiting', { waiting: { kind: 'review' } });
  assert.match(reason(gate, 'fix'), /found nothing to fix/);
  gate.outputs.review = { findings: [{ id: 'F1' }] };
  assert.equal(actionAllowed(gate, refactor, 'fix').ok, true);
  gate.fixRounds.user = 2;
  assert.match(reason(gate, 'fix'), /used all 2 fix rounds/);
  const red = run(at('checks'), 'gates-red');
  assert.equal(actionAllowed(red, refactor, 'fix').ok, true);
  assert.equal(actionAllowed(red, refactor, 'sendback').ok, true);
  assert.equal(actionAllowed(red, refactor, 'retry').ok, true);
  assert.equal(actionAllowed(red, refactor, 'stop').ok, true);
  assert.match(reason(run(at('plan'), 'waiting', { waiting: { kind: 'plan' } }), 'fix'), /review gate/);
});

test('commit needs green gates with a recorded tree hash', () => {
  const gate = run(at('review-gate'), 'waiting', { waiting: { kind: 'review' } });
  assert.match(reason(gate, 'commit'), /green gates/);
  gate.stages[at('checks')].status = 'done';
  gate.gatedTree = { treeSha: 'abc', files: ['a'] };
  assert.equal(gatesGreen(gate), true);
  assert.equal(actionAllowed(gate, refactor, 'commit').ok, true);
  const commitGate = { ...gate, waiting: { kind: 'commit' }, current: { index: at('commit') } };
  assert.equal(actionAllowed(commitGate, refactor, 'commit').ok, true);
});

test('retry and resume follow the stage status', () => {
  const capped = session(run(at('implement'), 'capped', { stageStatus: 'capped' }), 'implement');
  assert.equal(actionAllowed(capped, refactor, 'retry').ok, true);
  assert.equal(actionAllowed(capped, refactor, 'resume').ok, true);
  const noSession = run(at('implement'), 'interrupted', { stageStatus: 'interrupted' });
  assert.match(reason(noSession, 'resume'), /with a session/);
  const paused = session(run(at('implement'), 'paused-limit', { stageStatus: 'paused-limit' }), 'implement');
  assert.equal(actionAllowed(paused, refactor, 'resume').ok, true);
  assert.equal(actionAllowed(paused, refactor, 'retry').ok, false);
  assert.equal(actionAllowed(run(at('implement'), 'waiting', { waiting: { kind: 'plan' } }), refactor, 'retry').ok, false);
});

test('a failed run allows only retry and report; ended runs allow report only', () => {
  const failed = session(run(at('implement'), 'failed', { treeReady: false, lockHeld: false }), 'implement');
  assert.deepEqual(enabled(failed), ['report', 'retry']);
  assert.match(reason(failed, 'cancel'), /has ended/);
  assert.match(reason(failed, 'takeover'), /Retry the stage first/);
  const passed = { ...run(0, 'passed'), stages: explain.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: 'done', attempts: [] })), pipeline: 'explain' };
  assert.deepEqual(enabled(passed, explain), ['report']);
});

test('a run that failed before its current stage started still offers retry', () => {
  const r = run(at('scope'), 'failed', { stageStatus: 'pending', treeReady: false, lockHeld: false });
  assert.deepEqual(enabled(r), ['report', 'retry']);
  assert.equal(actionAllowed(run(at('scope'), 'waiting', { stageStatus: 'pending' }), refactor, 'retry').ok, false);
});

test('in a terminal only back works; parked runs unpark or cancel', () => {
  const term = session(run(at('review-gate'), 'in-terminal', { stageStatus: 'waiting' }), 'implement');
  assert.deepEqual(enabled(term), ['back']);
  assert.match(reason(term, 'cancel'), /Back to app first/);
  const parked = run(at('plan'), 'parked', { stageStatus: 'waiting', lockHeld: false, treeReady: false });
  assert.deepEqual(enabled(parked), ['cancel', 'unpark']);
});

test('park needs a waiting editing run that holds the lock', () => {
  const r = run(at('plan'), 'waiting', { waiting: { kind: 'plan' }, lockHeld: false });
  assert.match(reason(r, 'park'), /holds the lock/);
  const ex = { id: 'e', pipeline: 'explain', status: 'waiting', waiting: { kind: 'plan' }, lockHeld: true, stages: [{ id: 'answer', status: 'waiting', attempts: [] }] };
  assert.equal(actionAllowed(ex, explain, 'park').ok, false);
  assert.match(reason(ex, 'stop', explain), /Only editing runs/);
});

test('allow and sendback at the fence gate; triage and done at triage', () => {
  const fence = run(at('checks'), 'waiting', { waiting: { kind: 'fence', detail: { paths: ['x'] } } });
  assert.equal(actionAllowed(fence, refactor, 'allow').ok, true);
  assert.equal(actionAllowed(fence, refactor, 'sendback').ok, true);
  const review = pipelineById('review');
  const tri = { id: 't', pipeline: 'review', status: 'waiting', waiting: { kind: 'triage' }, stages: review.stages.map((s, n) => ({ id: s.id, status: n < 3 ? 'done' : 'waiting', attempts: [] })), current: { index: 3 } };
  assert.equal(actionAllowed(tri, review, 'triage').ok, true);
  assert.equal(actionAllowed(tri, review, 'done').ok, true);
  assert.equal(actionAllowed(tri, review, 'cancel').ok, true);
});

test('take over picks the current Claude stage, else the latest edit stage', () => {
  const r = session(session(run(at('review-gate'), 'waiting', { waiting: { kind: 'review' } }), 'scope', 'a'), 'implement', 'b');
  assert.equal(takeoverStageIndex(r, refactor), at('implement'));
  const plan = session(run(at('plan'), 'waiting', { waiting: { kind: 'plan' } }), 'scope', 'a');
  assert.equal(takeoverStageIndex(plan, refactor), at('scope'));
  const none = run(at('plan'), 'waiting', { waiting: { kind: 'plan' } });
  assert.equal(takeoverStageIndex(none, refactor), -1);
  assert.match(reason(none, 'takeover'), /No Claude stage/);
  assert.equal(currentIndex({ stages: [{ status: 'done' }, { status: 'pending' }] }), 1);
});

test('a debug run that ended unpinnable still offers take over', () => {
  const stages = debug.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: n < 3 ? 'done' : 'skipped', attempts: s.kind === 'claude' ? [] : undefined }));
  stages[1].attempts = [{ sessionId: 's1', folder: 'stages/01-investigate' }];
  const r = { id: 'd', pipeline: 'debug', status: 'passed', stages, current: { index: 3 } };
  assert.equal(isUnpinnableEnd(r, debug), true);
  assert.equal(actionAllowed(r, debug, 'takeover').ok, true);
  assert.equal(isUnpinnableEnd({ ...r, status: 'committed' }, debug), false);
});

test('next slice after a committed feature slice with more slices', () => {
  const stages = feature.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: 'done', attempts: [] }));
  const r = { id: 'f', pipeline: 'feature', status: 'committed', stages, plan: { schema: 'spec.v1', slice: 0, output: { slices: [{}, {}] } } };
  assert.equal(actionAllowed(r, feature, 'next-slice').ok, true);
  r.plan.slice = 1;
  assert.equal(actionAllowed(r, feature, 'next-slice').ok, false);
});

test('an unknown action is reported, not thrown', () => {
  assert.deepEqual(actionAllowed(run(0, 'running'), refactor, 'explode'), { ok: false, reason: 'There is no action called explode.' });
});
