// Which buttons a run offers right now, and why the others are off. The page shows every action
// with its reason; the manager and the executor check the same function before they act, so a
// button the page shows as off can't be pressed through the API either.
//
// allowedActions(run, pipelineDef, ctx) returns [{action, label, enabled, reason}] for every
// action in ACTIONS, in that order. ctx = { running: a stage process or the run's driver is
// active, trusted: true | false | undefined (unknown counts as trusted; the cockpit shows the
// exact command to trust the folder) }.
//
// Status rules (SPEC 2.7, runs/store.mjs): passed, cancelled and committed are over for good.
// failed is terminal too: the executor has saved the patch, reset the tree and released the
// lock, so only Retry stage (which takes the lock again and restores the patch) and Save as
// report stay on.
import { FIX_ROUNDS } from './catalog.mjs';

export const ACTIONS = ['approve', 'revise', 'allow', 'sendback', 'fix', 'commit', 'stop', 'cancel', 'retry', 'resume',
  'takeover', 'back', 'park', 'unpark', 'triage', 'done', 'report', 'next-slice'];
// Over for good: nothing can continue these runs.
export const ENDED = ['passed', 'cancelled', 'committed'];
// The store's terminal statuses (endedAt is set): ENDED plus failed.
export const TERMINAL = [...ENDED, 'failed'];
// Statuses in which a run still holds its tree (and, for editing runs, the lock) and waits.
const HOLDING = ['waiting', 'gates-red', 'capped', 'paused-limit', 'interrupted'];

const LABELS = {
  approve: 'Approve', revise: 'Revise', allow: 'Allow for this run', sendback: 'Send back', fix: 'Fix selected',
  commit: 'Commit…', stop: 'Stop, keep patch', cancel: 'Cancel run', retry: 'Retry stage', resume: 'Resume session',
  takeover: 'Open in terminal', back: 'Back to app', park: 'Park run', unpark: 'Resume parked run', triage: 'Save triage',
  done: 'Done', report: 'Save as report', 'next-slice': 'Start next slice',
};
const APPROVE_LABEL = { plan: 'Approve plan', spec: 'Approve spec', hypothesis: 'Approve hypothesis', review: 'Approve' };

const stagesOf = run => (Array.isArray(run.stages) ? run.stages : []);
const sessionOf = st => {
  const list = (st && st.attempts) || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].sessionId) return list[i].sessionId;
  return '';
};

// The index of the stage the run is at: run.current.index, or the first stage not done.
export function currentIndex(run) {
  const stages = stagesOf(run);
  const i = run.current && Number.isInteger(run.current.index) ? run.current.index : -1;
  if (i >= 0 && i < stages.length) return i;
  const open = stages.findIndex(s => s.status !== 'done' && s.status !== 'skipped');
  return open >= 0 ? open : Math.max(0, stages.length - 1);
}

// The latest session id of stage `index` ('' when it has none).
export function lastSessionId(run, index) {
  return sessionOf(stagesOf(run)[index]);
}

// The Claude stage Take over resumes: the current one when it is a Claude stage with a session,
// otherwise the latest edit stage with a session, otherwise the latest Claude stage with one.
// Returns -1 when no Claude stage has a session yet.
export function takeoverStageIndex(run, def) {
  const stages = stagesOf(run);
  const at = currentIndex(run);
  const isClaude = i => !!(def && def.stages[i] && def.stages[i].kind === 'claude');
  if (isClaude(at) && sessionOf(stages[at])) return at;
  let fallback = -1;
  for (let i = Math.min(at, stages.length - 1); i >= 0; i--) {
    if (!isClaude(i) || !sessionOf(stages[i])) continue;
    if (def.stages[i].profile === 'EDIT') return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

// A finished debug run whose bug no test could pin: it ends passed and still offers Take over.
export function isUnpinnableEnd(run, def) {
  if (!def || def.id !== 'debug' || run.status !== 'passed') return false;
  const i = def.stages.findIndex(s => s.id === 'prove');
  return i >= 0 && (stagesOf(run)[i] || {}).status === 'skipped';
}

const findingsOf = run => (((run.outputs || {}).review || {}).findings || []);
// Green gates: the checks stage is done and its tree hash is recorded.
export function gatesGreen(run) {
  const checks = stagesOf(run).find(s => s.id === 'checks');
  return !!(checks && checks.status === 'done' && run.gatedTree && run.gatedTree.treeSha);
}

// Every rule: the reason an action is off, or '' when it is on.
function reasons(run, def, ctx) {
  const status = run.status;
  const w = run.waiting ? run.waiting.kind : '';
  const ended = ENDED.includes(status);
  const busy = !!ctx.running || status === 'running';
  const i = currentIndex(run);
  const st = stagesOf(run)[i] || {};
  const sdef = (def && def.stages && def.stages[i]) || {};
  const rounds = run.fixRounds || {};
  const maxUser = Number.isInteger(rounds.maxUser) ? rounds.maxUser : FIX_ROUNDS.maxUser;
  const userRounds = rounds.user || 0;
  const editing = !!(def && def.editing);
  const rule = {};
  const set = (action, ok, reason) => { rule[action] = ok ? '' : reason; };

  set('approve', ['plan', 'spec', 'hypothesis', 'review'].includes(w), 'Nothing is waiting for an approval.');
  set('revise', ['plan', 'spec', 'hypothesis'].includes(w), 'Revise works at the plan, spec or hypothesis gate.');
  set('allow', w === 'fence', 'Allow works only at the fence gate.');
  set('sendback', ['fence', 'review'].includes(w) || status === 'gates-red',
    'Send back works at the fence or review gate, or after red gates.');
  const roundsLeft = userRounds < maxUser;
  if (status === 'gates-red') set('fix', roundsLeft, `You used all ${maxUser} fix rounds; take over or stop.`);
  else if (w !== 'review') set('fix', false, 'Fix works at the review gate.');
  else if (!findingsOf(run).length) set('fix', false, 'The review found nothing to fix.');
  else set('fix', roundsLeft, `You used all ${maxUser} fix rounds; take over or stop.`);
  set('commit', ['review', 'commit'].includes(w) && gatesGreen(run), 'Commit needs green gates and a recorded tree hash.');

  let stopWhy = '';
  if (!editing) stopWhy = 'Only editing runs have a patch to keep; use Cancel run.';
  else if (busy) stopWhy = 'Cancel the running stage instead.';
  else if (!HOLDING.includes(status) || !run.treeReady) stopWhy = 'Stop works while an editing run holds its tree and waits for you.';
  set('stop', !stopWhy, stopWhy);

  let cancelWhy = '';
  if (status === 'in-terminal') cancelWhy = 'Close the terminal session and use Back to app first.';
  else if (TERMINAL.includes(status)) cancelWhy = 'The run has ended.';
  else if (!busy && !HOLDING.includes(status) && status !== 'parked') cancelWhy = 'Nothing is running or waiting.';
  set('cancel', !cancelWhy, cancelWhy);

  const open = !ended && status !== 'in-terminal' && status !== 'parked';
  set('retry', ['interrupted', 'failed', 'capped'].includes(st.status) && !busy && open,
    'Retry works when the current stage failed, was capped or was interrupted.');
  set('resume', ['interrupted', 'capped', 'paused-limit'].includes(st.status) && sdef.kind === 'claude' && !!sessionOf(st) && !busy && open && status !== 'failed',
    'Resume needs an interrupted, capped or paused Claude stage with a session.');

  const t = takeoverStageIndex(run, def);
  let takeWhy = '';
  if (busy) takeWhy = 'Cancel the running stage first.';
  else if (status === 'in-terminal') takeWhy = 'The run is already in a terminal.';
  else if (status === 'parked') takeWhy = 'Resume the parked run first.';
  else if (status === 'failed') takeWhy = 'Retry the stage first; the tree was reset when the run failed.';
  else if (ended && !isUnpinnableEnd(run, def)) takeWhy = 'The run has ended.';
  else if (t < 0) takeWhy = 'No Claude stage of this run has a session yet.';
  else if (ctx.trusted === false) takeWhy = 'Run claude once in the folder to trust it.';
  set('takeover', !takeWhy, takeWhy);

  set('back', status === 'in-terminal', 'Back to app works while the run is in a terminal.');
  set('park', status === 'waiting' && !!run.lockHeld && editing && !busy, 'Park works while an editing run waits for you and holds the lock.');
  set('unpark', status === 'parked', 'The run is not parked.');
  set('triage', ['triage', 'decide'].includes(w), 'Triage works when the findings wait for you.');
  set('done', ['triage', 'decide'].includes(w), 'Done works when the findings wait for you.');
  const hasOutputs = Object.keys(run.outputs || {}).length > 0;
  set('report', !busy && status !== 'in-terminal' && (hasOutputs || TERMINAL.includes(status)), 'There is nothing to report yet.');
  const plan = run.plan || {};
  const slices = ((plan.output || {}).slices || []).length;
  set('next-slice', !!def && def.id === 'feature' && status === 'committed' && plan.schema === 'spec.v1'
    && Number.isInteger(plan.slice) && plan.slice + 1 < slices,
  'Start next slice works after a feature slice is committed and the spec has more slices.');
  return { rule, w };
}

export function allowedActions(run, def, ctx = {}) {
  const { rule, w } = reasons(run || {}, def, ctx || {});
  return ACTIONS.map(action => ({
    action,
    label: action === 'approve' && APPROVE_LABEL[w] ? APPROVE_LABEL[w] : LABELS[action],
    enabled: rule[action] === '',
    reason: rule[action],
  }));
}

// One action's verdict: { ok, reason }.
export function actionAllowed(run, def, action, ctx = {}) {
  const a = allowedActions(run, def, ctx).find(x => x.action === action);
  if (!a) return { ok: false, reason: `There is no action called ${String(action).slice(0, 40)}.` };
  return { ok: a.enabled, reason: a.reason };
}
