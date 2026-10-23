// Live run (#run/<id>, SPEC 5.6, mockup #v-run): one pipeline run as it happens.
//
//   header      title, status (a dot next to a text badge), branch, base, tree, level and why,
//               "Notify me when it needs me", Open in terminal (or Back to app) and Cancel run
//   meters      turns of the Claude stage, time in this stage against its cap, fix rounds, the
//               usage window (ADDENDUM A12) and the API-equivalent estimate
//   state       what the status means and its buttons: Retry stage, Resume (+20 turns), Fix
//               again, Send back, Stop keep patch, Resume parked run, Save as report …
//   gate card   while the run waits for you (parts/gatecards.js)
//   result      Explain's answer, a debug run's diagnosis, Check my work's checks table
//   grid        the stage list and the timeline (parts/timeline.js), with Replay when finished
//
// Data: GET /api/run?id&since, pulled every 2 s while the view is open (store.livePoll: every
// 10 s while the live stream is up, and at once on a signal for this run). Only new timeline rows
// come back each time (`since`), so the timeline only appends. After a click the run is pulled
// again at once. Buttons come from run.actions (runs/actions.mjs): one that can't act now stays
// focusable and says why in visible text (SPEC 5.11). Cancel, Stop and Back to app ask first.
//
// Keyboard (SPEC 5.6, 5.11): with the focus inside #run-panel and single-key shortcuts on, T
// takes over, "." cancels (with the question), j and k move through the timeline rows.
//
// "Notify me when it needs me" is per run and lives in this browser only: localStorage key
// ws-notify:<runId> ("1" or "0"), defaulting to settings.notify.web. The shell's notification
// check (store.notifyOn) learns the choice through setRunNotify.
import { api, confirmDialog, copy, fmtAgo, fmtClock, h, keepFocus, keyed, qs, toast } from '../lib.js';
import { go, goProject, livePoll, setRunNotify, settings, singleKeyOk } from '../store.js';
import { statusPair } from '../parts/status.js';
import { bar, setBar } from '../parts/bar.js';
import { createTimeline, stageList, stageMeta } from '../parts/timeline.js';
import { actButton, actionOf, gateCard, gateKey, setFrom } from '../parts/gatecards.js';

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
const TERMINAL = ['passed', 'failed', 'cancelled', 'committed'];
const NOTIFY_PREFIX = 'ws-notify:';
const TERM_ICON = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>';
const asList = x => (Array.isArray(x) ? x : []);
const sha7 = s => String(s || '').slice(0, 7);
const cap1 = s => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : '');

// ---------------------------------------------------------------- pure helpers (tested)

export const notifyKey = id => `${NOTIFY_PREFIX}${id}`;

// What the run waits for, in the status badge: "Needs you: plan".
const WAIT_WORDS = {
  plan: 'plan', spec: 'spec', hypothesis: 'hypothesis', fence: 'file outside the plan', review: 'review gate',
  commit: 'commit', triage: 'triage', decide: 'decide',
};
export function statusText(run) {
  if (!run) return '';
  if (run.status === 'waiting' && run.waiting && WAIT_WORDS[run.waiting.kind]) return `Needs you: ${WAIT_WORDS[run.waiting.kind]}`;
  return '';
}

// The buttons the state card shows for a status: [action, always]. An "always" button shows
// even when it can't act (with its reason); the others only when they can. Take over, Back to
// app and Cancel live in the header; Send back after red gates is a small form of its own.
const STATE_ACTIONS = {
  failed: [['retry', true], ['report', false]],
  capped: [['resume', true], ['retry', false], ['stop', false], ['report', false]],
  'paused-limit': [['resume', true], ['report', false]],
  interrupted: [['retry', true], ['resume', true], ['stop', false]],
  'gates-red': [['fix', true], ['stop', false], ['report', false]],
  parked: [['unpark', true]],
  committed: [['next-slice', false], ['report', false]],
  passed: [['report', false]],
  cancelled: [['report', false]],
  waiting: [['park', false]],
};
export function stateActions(run) {
  if (!run) return [];
  return (STATE_ACTIONS[run.status] || [])
    .map(([name, always]) => ({ a: actionOf(run, name), always }))
    .filter(x => x.a && (x.always || x.a.enabled))
    .map(x => x.a);
}

// The index of the stage the run is at (as runs/actions.mjs currentIndex).
export function currentIndex(run) {
  const stages = asList(run && run.stages);
  const i = run && run.current && Number.isInteger(run.current.index) ? run.current.index : -1;
  if (i >= 0 && i < stages.length) return i;
  const open = stages.findIndex(s => s.status !== 'done' && s.status !== 'skipped');
  return open >= 0 ? open : Math.max(0, stages.length - 1);
}

// The label a state button shows when it can say more than the action's own label.
export function actionLabel(run, a) {
  if (!a) return '';
  const st = asList(run && run.stages)[currentIndex(run)] || {};
  if (a.action === 'resume' && st.status === 'capped' && !st.bonusUsed) return 'Resume (+20 turns)';
  if (a.action === 'fix' && run && run.status === 'gates-red') {
    const r = run.fixRounds || {};
    const max = Number.isInteger(r.maxUser) ? r.maxUser : 2;
    return `Fix again (round ${Math.min(max, (r.user || 0) + 1)} of ${max})`;
  }
  return a.label;
}

// The Claude stage the turn meter follows: the current one when it is a Claude stage with an
// attempt, otherwise the latest earlier one. null before any Claude stage ran.
export function turnStage(run) {
  const stages = asList(run && run.stages);
  for (let i = Math.min(currentIndex(run), stages.length - 1); i >= 0; i--) {
    const s = stages[i];
    if (s && s.kind === 'claude' && asList(s.attempts).length) return s;
  }
  return null;
}

// The turn meter: { label, n, max } for the stage turnStage picks. `live` maps
// "<stage>#<attempt>" to the highest turn the timeline has shown, for an attempt still running.
export function turnMeter(run, live = new Map()) {
  const s = turnStage(run);
  if (!s) return { label: 'Turns', n: 0, max: 0 };
  const att = asList(s.attempts);
  const last = att[att.length - 1] || {};
  const n = Number.isFinite(last.turns) ? last.turns : live.get(`${s.id}#${last.k || att.length}`) || 0;
  return { label: `Turns · ${s.label || s.id}`, n, max: Number(last.maxTurns) || 0 };
}

// The API-equivalent cost of every attempt so far, in dollars (null when nothing reported).
export function estimateUsd(run) {
  let sum = 0;
  let any = false;
  for (const s of asList(run && run.stages)) {
    for (const a of asList(s.attempts)) {
      if (typeof a.estUsd === 'number' && Number.isFinite(a.estUsd)) { sum += a.estUsd; any = true; }
    }
  }
  return any ? sum : null;
}
export function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'no estimate yet';
  return n > 0 && n < 0.01 ? '< $0.01 API-equivalent' : `≈ $${n.toFixed(2)} API-equivalent`;
}

// The latest usage report (run.rateLimit, ADDENDUM A12): { pct, resets: "14:00" or '', limited },
// or null when Claude Code reported nothing. resetsAt is in seconds since 1970.
export function rateLimitParts(rl) {
  if (!rl || typeof rl !== 'object' || typeof rl.utilization !== 'number' || !Number.isFinite(rl.utilization)) return null;
  const pct = Math.round(Math.max(0, rl.utilization) * 100);
  const at = Number(rl.resetsAt);
  const resets = Number.isFinite(at) && at > 0 ? fmtClock(new Date(at < 1e11 ? at * 1000 : at).toISOString()) : '';
  return { pct, resets, limited: rl.status === 'rejected' };
}
// "Usage, 5-hour window: 42% (resets 14:00)", the same words as the server's rateLimitSummary.
export function rateLimitText(rl) {
  const p = rateLimitParts(rl);
  if (!p) return '';
  return `Usage, 5-hour window: ${p.pct}%${p.resets ? ` (resets ${p.resets})` : ''}${p.limited ? ', limit reached' : ''}`;
}

// How long a stage has run: to now while it runs or waits, else to its end (the stage's, or its
// last attempt's). NaN when it never started or has no recorded end (an interrupted stage).
export function stageMs(stage, now = Date.now()) {
  const start = Date.parse((stage && stage.startedAt) || '');
  if (!Number.isFinite(start)) return NaN;
  const att = asList(stage.attempts);
  const endIso = stage.endedAt || (att.length ? att[att.length - 1].endedAt : '');
  const end = stage.status === 'running' || stage.status === 'waiting' ? now : Date.parse(endIso || '');
  return Number.isFinite(end) ? Math.max(0, end - start) : NaN;
}

// "12 s", "4 min": the time meter's words ('' for no time).
export function fmtStageTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
}

// Every gate ended green and nothing outside the plan was allowed: the celebration's condition.
export function allGreen(run) {
  const g = run && run.lastGate;
  return !!g && ['green', 'pass'].includes(g.result) && !asList(run.allowances).length;
}

// The header's facts: branch, base, where it runs, how careful and why.
export function metaParts(run) {
  if (!run) return [];
  const out = [];
  if (run.branch) out.push({ code: run.branch });
  if (run.base && run.base.sha) out.push({ text: `base ${run.base.branch ? `${run.base.branch} ` : ''}${sha7(run.base.sha)}` });
  const iso = run.isolation || {};
  if (iso.mode === 'worktree') out.push({ text: `run worktree${iso.tree ? ` ${String(iso.tree).split(/[\\/]/).pop()}` : ''}` });
  else if (iso.mode === 'branch') out.push({ text: 'branch mode in your checkout' });
  else if (iso.mode === 'none' || iso.treeMode === 'main') out.push({ text: 'read-only in the main checkout' });
  if (run.level) {
    const why = asList(run.levelReason).map(String);
    out.push({ text: `${cap1(run.level)}${why.length ? ` (${why.join('; ')})` : ''}` });
  }
  return out;
}

// ---------------------------------------------------------------- notify (per run, this browser)

function readNotify(id) {
  try {
    const v = localStorage.getItem(notifyKey(id));
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage blocked: the default */ }
  return settings.notify.web !== false;
}
function writeNotify(id, on) {
  try { localStorage.setItem(notifyKey(id), on ? '1' : '0'); } catch { /* storage blocked: this page only */ }
  setRunNotify(id, on); // asks for permission on the first "on" only (store.js)
}
// At load: runs you turned off before reach the shell's check, so a reload keeps them quiet.
(function feedNotify() {
  if (typeof localStorage === 'undefined') return;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NOTIFY_PREFIX) && localStorage.getItem(k) === '0') setRunNotify(k.slice(NOTIFY_PREFIX.length), false);
    }
  } catch { /* storage blocked */ }
}());

// ---------------------------------------------------------------- state

function fresh(id) {
  return {
    id, run: null, note: id ? 'Loading…' : '', missing: false, next: 0, busy: '', stage: '', wantPull: false,
    gateKey: null, gate: null, turns: new Map(), def: null, review: null, reviewKey: '', sigs: {}, sendback: '',
  };
}
let S = fresh('');
let root = null;
let el = {}; // the parts mount() builds once
let timeline = null;
let stopPoll = null;
let ticker = null;
let inflight = null;
let again = false;
const defCache = new Map(); // project -> { at, list } from GET /api/pipelines
let checksModule = null;

// True when `value` differs from the last one under `name`: a part is rebuilt only then, which
// keeps the DOM (and with it the focus and what you typed) while nothing changed.
function changed(name, value) {
  const sig = JSON.stringify(value);
  if (S.sigs[name] === sig) return false;
  S.sigs[name] = sig;
  return true;
}

// ---------------------------------------------------------------- building the view

// One meter: a label, a value, a bar and a small line (the bar repeats what the text says).
function meter(label, cls) {
  const name = h('span', {}, label);
  const value = h('b', {});
  const sub = h('small', { class: 'm-sub', hidden: true });
  const b = bar(0, cls, label);
  const box = h('div', { class: 'meter' }, h('div', { class: 'm-top' }, name, value), b, sub);
  return {
    el: box,
    set(text, pct, { title, note = '', barLabel } = {}) {
      if (title !== undefined && name.textContent !== title) name.textContent = title;
      value.textContent = text;
      b.hidden = pct === null;
      if (pct !== null) setBar(b, pct, barLabel || `${title || label}: ${text}`);
      sub.textContent = note;
      sub.hidden = !note;
    },
  };
}

function mount(section) {
  timeline = createTimeline();
  const notify = h('input', { type: 'checkbox', on: { change: e => { if (S.id) writeNotify(S.id, e.target.checked); } } });
  el = {
    crumb: h('p', { class: 'crumb' }),
    h2: h('h2', { tabindex: '-1' }, 'Live run'),
    meta: h('p', { class: 'run-meta' }),
    notify,
    notifyLabel: h('label', { class: 'check run-notify' }, notify, 'Notify me when it needs me'),
    take: actButton('Open in terminal', () => runAction('takeover'), { key: 'h-take', iconMarkup: TERM_ICON }),
    back: actButton('Back to app', () => runAction('back', {}, {
      confirm: ['Back to app?', 'Close the terminal session first. Then the app takes the tree back and the next gate runs again.', 'Back to app'],
    }), { cls: 'primary', key: 'h-back' }),
    cancel: actButton('Cancel run', () => cancelRun(), { cls: 'danger', key: 'h-cancel' }),
    warnings: h('div', { class: 'run-warnings' }),
    meters: h('div', { class: 'card meters' }),
    state: h('div', { class: 'run-state' }),
    gate: h('div', { class: 'run-gate' }),
    result: h('div', { class: 'run-result' }),
    stages: h('div', { class: 'run-stages' }),
    est: h('b', { class: 'est-value', title: 'Computed from total_cost_usd. On a subscription this is only an API-price estimate; your usage limit is what counts.' }),
  };
  el.meter = { turns: meter('Turns', 'blue'), time: meter('Time this stage', 'blue'), rounds: meter('Fix rounds', ''), usage: meter('Usage, 5-hour window', '') };
  el.meters.append(el.meter.turns.el, el.meter.time.el, el.meter.rounds.el, el.meter.usage.el,
    h('div', { class: 'est' }, h('span', { class: 'muted' }, 'Usage so far'), el.est, h('small', {}, 'Estimate only. Your usage limit is what counts.')));
  root = h('div', { id: 'run-panel', class: 'run-view' },
    h('div', { class: 'view-head' },
      h('div', { class: 'run-headline' }, el.crumb, el.h2, el.meta),
      h('div', { class: 'row-actions run-head-actions' }, el.notifyLabel, el.take.el, el.back.el, el.cancel.el)),
    el.warnings, el.meters, el.state, el.gate, el.result,
    h('div', { class: 'run-grid' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Stages'), h('span', { class: 'muted small' }, 'Claude · code · you')), el.stages),
      timeline.el));
  root.addEventListener('keydown', onKey);
  section.replaceChildren(root);
}

function switchRun(id) {
  if (timeline) { timeline.stop(); timeline.reset(); }
  S = fresh(id);
  inflight = null;
  again = false;
  if (!root) return;
  el.gate.replaceChildren();
  el.result.replaceChildren();
  el.notify.checked = RUN_ID_RE.test(id) ? readNotify(id) : false;
  if (id && !RUN_ID_RE.test(id)) S.note = 'This is not a run id.';
  if (!id) S.note = 'No run chosen. Open one from Runs.';
}

function render(section, { sub }) {
  if (!root || root.parentNode !== section) {
    mount(section);
    S.sigs = {};
    el.notify.checked = RUN_ID_RE.test(sub) ? readNotify(sub) : false;
  }
  if (sub !== S.id) switchRun(sub);
  paint();
  if (S.wantPull) {
    S.wantPull = false;
    pull();
  }
}

function paint() {
  if (!root) return;
  const run = S.run;
  paintHead(run);
  paintWarnings(run);
  el.meters.hidden = !run;
  if (run) paintMeters(run);
  paintState(run);
  paintGate(run);
  paintResult(run);
  paintStages(run);
  timeline.setReplayable(!!run && TERMINAL.includes(run.status));
}

function paintHead(run) {
  const project = run ? run.project : '';
  if (changed('crumb', [project, run && run.pipelineLabel])) {
    el.crumb.replaceChildren(
      ...(project ? [h('button', { class: 'link', type: 'button', on: { click: () => goProject(project, 'tasks') } }, project), ' / '] : []),
      h('button', { class: 'link', type: 'button', on: { click: () => go('runs') } }, 'Runs'),
      run && run.pipelineLabel ? ` / ${run.pipelineLabel}` : ' / Run');
  }
  const title = run ? run.title || run.id : 'Live run';
  if (changed('h2', [title, run && run.status, statusText(run)])) {
    el.h2.replaceChildren(h('span', { class: 'run-title' }, title), ...(run ? statusPair(run.status, statusText(run)) : []));
  }
  const meta = metaParts(run);
  if (changed('meta', meta)) {
    el.meta.replaceChildren(...meta.flatMap((m, i) => [i ? ' · ' : '', m.code ? h('code', {}, m.code) : m.text]));
    el.meta.hidden = !meta.length;
  }
  el.notifyLabel.hidden = !run || TERMINAL.includes(run.status);
  const inTerminal = !!run && run.status === 'in-terminal';
  const take = actionOf(run, 'takeover');
  const cancel = actionOf(run, 'cancel');
  el.take.el.hidden = !run || inTerminal || (TERMINAL.includes(run.status) && !(take && take.enabled));
  el.back.el.hidden = !inTerminal;
  el.cancel.el.hidden = !run || (TERMINAL.includes(run.status) && !(cancel && cancel.enabled));
  if (run) {
    setFrom(el.take, take, S.busy);
    setFrom(el.back, actionOf(run, 'back'), S.busy);
    setFrom(el.cancel, cancel, S.busy);
  }
}

// run.warnings (strings or { text }), such as "Base moved: … moved 4 commits since this run started".
function paintWarnings(run) {
  const list = asList(run && run.warnings).map(w => (typeof w === 'string' ? w : w && w.text)).filter(Boolean).map(String);
  if (!changed('warnings', list)) return;
  el.warnings.replaceChildren(...list.map(w => h('p', { class: 'note' }, w)));
  el.warnings.hidden = !list.length;
}

function paintMeters(run, now = Date.now()) {
  const t = turnMeter(run, S.turns);
  el.meter.turns.set(t.max ? `${t.n} / ${t.max}` : (t.n ? String(t.n) : '–'), t.max ? (t.n / t.max) * 100 : null,
    { title: t.label, note: t.max || t.n ? '' : 'No Claude stage has run yet.' });

  const st = asList(run.stages)[currentIndex(run)] || {};
  const ms = stageMs(st, now);
  const stageDef = S.def && asList(S.def.stages).find(x => x.id === st.id);
  const capMin = stageDef && stageDef.caps ? Number(stageDef.caps.minutes) || 0 : 0;
  const used = fmtStageTime(ms);
  const waitingNow = st.status === 'waiting';
  el.meter.time.set(used ? (capMin ? `${used} / ${capMin} min` : used) : '–', capMin && used ? (ms / (capMin * 60_000)) * 100 : null, {
    title: `${waitingNow ? 'Waiting' : 'Time'} · ${st.label || st.id || 'this stage'}`,
    note: waitingNow ? `since ${fmtClock(st.startedAt)}` : !used ? 'No time recorded for this stage.' : capMin ? '' : 'No time cap for this stage.',
  });

  const r = run.fixRounds || {};
  const editing = S.def ? !!S.def.editing : asList(run.stages).some(s => s.id === 'implement');
  if (editing) {
    const maxA = Number.isInteger(r.maxAuto) ? r.maxAuto : 2;
    const maxU = Number.isInteger(r.maxUser) ? r.maxUser : 2;
    const used2 = (r.auto || 0) + (r.user || 0);
    el.meter.rounds.set(`${used2} / ${maxA + maxU}`, (used2 / (maxA + maxU || 1)) * 100,
      { title: 'Fix rounds', note: `automatic ${r.auto || 0} of ${maxA} · yours ${r.user || 0} of ${maxU}` });
  } else {
    const stages = asList(run.stages);
    const done = stages.filter(s => s.status === 'done' || s.status === 'skipped').length;
    el.meter.rounds.set(`${done} / ${stages.length}`, stages.length ? (done / stages.length) * 100 : 0, { title: 'Stages done', note: 'Read-only: no fix rounds.' });
  }

  const p = rateLimitParts(run.rateLimit);
  el.meter.usage.set(p ? `${p.pct}%` : '–', p ? p.pct : null, {
    title: 'Usage, 5-hour window',
    note: p ? [p.resets ? `resets ${p.resets}` : '', p.limited ? 'limit reached' : ''].filter(Boolean).join(' · ') : 'Not reported yet: Claude Code reports it during a Claude stage.',
    barLabel: rateLimitText(run.rateLimit),
  });
  el.est.textContent = fmtUsd(estimateUsd(run));
}

// ---------------------------------------------------------------- the state card

// What the status means, as { cls, title, text } for the state card (null: the gate card or the
// meters say enough).
function stateNote(run) {
  const raw = String(run.statusReason || (run.error && run.error.message) || '').trim();
  const reason = raw && !/[.!?:]$/.test(raw) ? `${raw}.` : raw;
  const usage = rateLimitText(run.rateLimit);
  switch (run.status) {
    case 'failed': {
      const retry = actionOf(run, 'retry');
      return { cls: 'red', title: 'Failed.', text: `${reason || 'The run failed.'}${retry && retry.enabled ? ' Retry stage runs the stage again.' : ''}` };
    }
    case 'capped': return { cls: '', title: 'Turn cap reached.', text: `${reason} Resume gives the stage 20 more turns once; Open in terminal lets you finish it yourself.` };
    case 'paused-limit': return { cls: '', title: 'Paused: usage limit.', text: `${reason || 'Claude\'s usage limit was reached.'}${usage ? ` ${usage}.` : ''} Resume later, when the window has reset.` };
    case 'interrupted': return { cls: '', title: 'Interrupted.', text: `${reason} Retry stage starts it fresh; Resume session continues the same Claude session.` };
    case 'gates-red': return { cls: 'red', title: 'Checks red.', text: `${reason} Fix again sends the problems back to Claude; Open in terminal lets you fix them yourself.` };
    case 'in-terminal': {
      const t = run.takeover || {};
      const label = (asList(run.stages).find(s => s.id === t.stage) || {}).label || t.stage || 'The stage';
      return { cls: 'violet', title: `In terminal since ${fmtClock(t.since) || 'a moment ago'}.`, text: `${label} is open in a terminal. Close the terminal session first, then use Back to app: the next gate runs again.` };
    }
    case 'parked': {
      const p = run.parked || {};
      const at = p.waiting && p.waiting.kind ? ` at the ${WAIT_WORDS[p.waiting.kind] || p.waiting.kind} gate` : '';
      return { cls: 'muted', title: 'Parked.', text: `Parked ${fmtAgo(p.at) || ''}${at}. The lock is free for other runs.${p.patch ? ` Its changes are in ${p.patch}.` : ''} Resume it later: it comes back at the same gate.` };
    }
    case 'committed': {
      const c = run.commit || {};
      const hook = asList(c.hookChanged);
      return {
        cls: 'ok', title: `Committed ${sha7(c.sha)}${c.branch ? ` on ${c.branch}` : ''}.`,
        text: `Not pushed. Merge it in GitKraken when you are ready.${hook.length ? ` The pre-commit hook changed ${hook.join(', ')}.` : ''}${c.stashDelta ? ' The pre-commit hook left a stash entry; the app did not touch it.' : ''}`,
      };
    }
    case 'passed': return { cls: 'ok', title: 'Passed.', text: reason };
    case 'cancelled': return { cls: 'muted', title: 'Cancelled.', text: `${cap1(reason)}${run.patch ? ` Changes so far are in ${run.patch}.` : ''}` };
    default: return null;
  }
}

const CONFIRM = {
  stop: ['Stop this run?', 'Your changes are saved to final/stopped.patch and the run worktree is reset. The lock is released.', 'Stop, keep patch'],
};

function paintState(run) {
  const actions = run ? stateActions(run) : [];
  const sendback = run && run.status === 'gates-red' ? actionOf(run, 'sendback') : null;
  const note = run ? stateNote(run) : null;
  if (!changed('state', [S.note, S.missing, note, actions.map(a => [a.action, a.enabled, a.reason, actionLabel(run, a)]), sendback, S.busy])) return;
  const buttons = actions.map(a => {
    const b = actButton(actionLabel(run, a), () => runAction(a.action, {}, { confirm: CONFIRM[a.action] }),
      { cls: a.action === 'stop' ? 'ghost' : a.action === 'report' || a.action === 'park' ? '' : 'primary', key: `s-${a.action}` });
    setFrom(b, a, S.busy, '', actionLabel(run, a));
    return b.el;
  });
  let body = null;
  if (note || sendback) {
    body = h('div', { class: `card run-state-card${note && note.cls ? ` is-${note.cls}` : ''}` },
      h('div', { class: 'card-body' },
        note ? h('p', { class: 'run-state-text' }, h('b', {}, note.title), note.text ? ` ${note.text}` : '') : null,
        buttons.length ? h('div', { class: 'row-actions run-state-actions' }, buttons) : null,
        sendback ? sendbackForm(sendback) : null));
  } else if (buttons.length) {
    // Waiting: the gate card holds the decision; Park run is the quiet way out.
    body = h('div', { class: 'row-actions run-state-plain' },
      run.status === 'waiting' ? h('span', { class: 'muted small' }, 'Not deciding now? Park run frees the lock; the run comes back at this gate.') : null,
      buttons);
  }
  keepFocus(el.state, () => el.state.replaceChildren(...[
    S.note ? h('p', { class: S.missing || run ? 'note red' : 'note info' }, S.note) : null,
    body,
  ].filter(Boolean)));
}

// Send back after red gates: a note for Claude and the button (off until there is a note).
function sendbackForm(a) {
  const id = 'run-sendback-note';
  const btn = actButton('Send back with this note', () => runAction('sendback', { note: S.sendback.trim() }), { key: 's-sendback' });
  const refresh = () => setFrom(btn, a, S.busy, S.sendback.trim() ? '' : 'Write a note for Claude first.', 'Send back with this note');
  refresh();
  return keyed(h('div', { class: 'gc-field run-sendback' },
    h('label', { for: id }, 'Or send it back with your own note'),
    h('textarea', { id, rows: '2', maxlength: '2000', on: { input: e => { S.sendback = e.target.value; refresh(); } } }, S.sendback),
    h('div', { class: 'row-actions' }, btn.el)), 's-sendback-form');
}

// ---------------------------------------------------------------- gate card and results

const gateCtx = {
  act: (action, payload, opts) => runAction(action, payload, opts),
  go,
  busy: () => S.busy,
};

function paintGate(run) {
  const key = gateKey(run);
  if (key !== S.gateKey) {
    S.gateKey = key;
    S.gate = key ? gateCard(run, gateCtx) : null;
    keepFocus(el.gate, () => el.gate.replaceChildren(...(S.gate ? [S.gate.el] : [])));
  } else if (S.gate) S.gate.update(run, S.busy);
}

function isUnpinnable(run) {
  if (!run || run.pipeline !== 'debug' || run.status !== 'passed') return false;
  const prove = asList(run.stages).find(s => s.id === 'prove');
  return !!prove && prove.status === 'skipped';
}

function paintResult(run) {
  const out = (run && run.outputs) || {};
  const kind = !run ? '' : out.answer ? 'answer' : isUnpinnable(run) ? 'diagnosis' : run.pipeline === 'check' && out.checks ? 'checks' : '';
  const data = kind === 'answer' ? out.answer
    : kind === 'diagnosis' ? [out.investigate, actionOf(run, 'takeover'), S.busy]
      : kind === 'checks' ? [out.checks, S.reviewKey, !!S.review] : null;
  if (!changed('result', [kind, data])) return;
  keepFocus(el.result, () => el.result.replaceChildren(...[
    kind === 'answer' ? answerPanel(out.answer) : null,
    kind === 'diagnosis' ? diagnosisPanel(run, out.investigate || {}) : null,
    kind === 'checks' ? checksPanel(run, out.checks) : null,
  ].filter(Boolean)));
}

// Explain: the answer as text, sources as path:line, open questions, and the suggested line.
function answerPanel(a) {
  const note = String(a.suggestedNote || '').trim();
  const copyBtn = actButton('Copy a line for CLAUDE.md', () => copy(note), { key: 'r-copy' });
  copyBtn.set(!!note, 'Claude suggested no line for CLAUDE.md.');
  return h('section', { class: 'card run-answer', 'aria-labelledby': 'run-answer-h' },
    h('div', { class: 'card-head' }, h('h3', { id: 'run-answer-h' }, 'Answer'), copyBtn.el),
    h('div', { class: 'card-body' },
      h('p', { class: 'run-answer-text' }, String(a.answer || '')),
      asList(a.sources).length ? [h('h4', {}, 'Sources'), h('ul', { class: 'run-sources' }, asList(a.sources).map(s => h('li', {},
        h('code', {}, `${s.path}${s.line ? `:${s.line}` : ''}`), s.note ? h('span', { class: 'muted' }, ` ${s.note}`) : null)))] : null,
      asList(a.openQuestions).length ? [h('h4', {}, 'Open questions'), h('ul', {}, asList(a.openQuestions).map(q => h('li', {}, String(q))))] : null,
      note ? h('p', { class: 'small muted' }, 'Suggested line for CLAUDE.md: ', h('code', {}, note)) : null));
}

// Debug, unpinnable: the diagnosis, and Open in terminal to fix it by hand.
function diagnosisPanel(run, diag) {
  const take = actButton('Open in terminal', () => runAction('takeover'), { cls: 'primary', key: 'r-take', iconMarkup: TERM_ICON });
  setFrom(take, actionOf(run, 'takeover'), S.busy);
  return h('section', { class: 'card run-answer', 'aria-labelledby': 'run-diag-h' },
    h('div', { class: 'card-head' }, h('h3', { id: 'run-diag-h' }, 'Diagnosis'), take.el),
    h('div', { class: 'card-body' },
      h('p', { class: 'note' }, 'No failing test could pin this bug, so the run stopped with the diagnosis. Open it in a terminal to fix it yourself.'),
      h('ol', { class: 'run-hyps' }, asList(diag.hypotheses).map(x => h('li', {},
        h('b', {}, String(x.claim || '')), h('span', { class: 'small muted' }, ` · confidence: ${x.confidence || 'not given'}`),
        asList(x.evidence).length ? h('ul', {}, asList(x.evidence).map(e => h('li', {}, h('code', {}, String(e))))) : null))),
      diag.reproPlan ? [h('h4', {}, 'How to reproduce'), h('p', { class: 'run-answer-text' }, String(diag.reproPlan))] : null));
}

// Check my work: the summary chip and the checks table. The table is UI-REVIEW's checksTable,
// loaded on first use (it brings the dialog module, which needs the page).
function checksPanel(run, checks) {
  const body = h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading the checks…'));
  const word = checks.result === 'pass' ? 'Green' : checks.result === 'refused' ? 'Refused' : checks.result === 'cancelled' ? 'Cancelled' : 'Red';
  const cls = checks.result === 'pass' ? 'ok' : checks.result === 'refused' ? 'amber' : checks.result === 'cancelled' ? '' : 'red';
  const card = h('section', { class: 'card run-answer', 'aria-labelledby': 'run-checks-h' },
    h('div', { class: 'card-head' }, h('h3', { id: 'run-checks-h' }, 'Checks'), h('span', { class: `badge ${cls}`.trim() }, `${word}${checks.chip ? ` · ${checks.chip}` : ''}`)),
    body);
  const summary = S.review;
  if (!checksModule) checksModule = import('../parts/checks-table.js');
  checksModule.then(mod => {
    const gate = (run.lastGate && run.lastGate.folder) || '';
    body.replaceChildren(summary ? mod.checksTable(summary, { runId: run.id, gate, caption: 'Checks of this run' })
      : h('p', { class: 'muted' }, checks.refusal ? `The checks refused this tree: ${checks.refusal}` : 'Loading the checks table…'));
  }, e => { checksModule = null; body.replaceChildren(h('p', { class: 'note red' }, `The checks table could not load: ${e.message}`)); });
  return card;
}

// The meta line of a running stage ("Claude · sonnet/high · 12 s") between pulls.
function tickStages(run) {
  for (const s of asList(run.stages)) {
    if (s.status !== 'running') continue;
    const li = [...el.stages.querySelectorAll('[data-key]')].find(x => x.dataset.key === `st-${s.id}`);
    const small = li && li.querySelector('small');
    if (small) small.textContent = stageMeta(s);
  }
}

function paintStages(run) {
  const stages = asList(run && run.stages).map(s => [s.id, s.status, s.meta, s.label, s.startedAt, s.endedAt,
    asList(s.attempts).map(a => [a.model, a.effort, a.turns])]);
  if (!changed('stages', [stages, S.stage, run && run.status])) { if (run) tickStages(run); return; }
  keepFocus(el.stages, () => el.stages.replaceChildren(run ? stageList(run, { selected: S.stage, onSelect: pickStage })
    : h('p', { class: 'muted small st-empty' }, S.note || 'Loading…')));
}

function pickStage(id) {
  S.stage = id;
  const s = asList(S.run && S.run.stages).find(x => x.id === id);
  timeline.setStage(id, s ? s.label : id);
  paintStages(S.run);
}

// ---------------------------------------------------------------- pulling and acting

// Pulls the run and its new timeline rows (pages of 500 while `more`). One pull at a time: a call
// while one runs asks for one more pull after it. Resolves false to stop polling (no such run,
// or a bad id).
function pull() {
  if (inflight) { again = true; return inflight; }
  const p = (async () => {
    let keep = true;
    do { again = false; keep = await pullOnce(); } while (again && keep && inflight === p);
    return keep;
  })();
  inflight = p;
  p.finally(() => { if (inflight === p) inflight = null; });
  return p;
}

async function pullOnce() {
  const id = S.id;
  if (!RUN_ID_RE.test(id)) return false;
  // On a cold start the shell shows the view (onShow) before the first /api/state answer, and
  // renders it only after: render() pulls as soon as the view is built.
  if (!root) { S.wantPull = true; return true; }
  const prev = S.run ? S.run.status : '';
  try {
    for (let page = 0; page < 20; page++) {
      const r = await api(`/api/run?${qs({ id, since: S.next })}`);
      if (id !== S.id) return true; // another run is on screen now; its own poller runs
      for (const row of asList(r.rows)) {
        if (row && row.stage && Number.isFinite(row.turn)) {
          const k = `${row.stage}#${row.attempt || 1}`;
          S.turns.set(k, Math.max(S.turns.get(k) || 0, row.turn));
        }
      }
      timeline.append(r.rows);
      if (r.run) S.run = r.run;
      if (r.next != null) S.next = r.next;
      if (!r.more) break;
    }
    S.note = '';
    S.missing = false;
    afterPull(prev);
    paint();
    return true;
  } catch (e) {
    if (id !== S.id) return true;
    if (e.network) return true; // the heartbeat notices a stopped server
    S.missing = e.status === 404;
    S.note = S.missing ? `There is no run ${id}. The id may be wrong, or the run was removed.` : e.message;
    paint();
    return e.status !== 404 && e.status !== 400;
  }
}

// After a pull: the pipeline's caps (once a minute per project), Check's table, the celebration.
function afterPull(prev) {
  const run = S.run;
  if (!run) return;
  loadDef(run);
  if (run.pipeline === 'check' && run.lastGate && run.lastGate.at !== S.reviewKey) loadChecks(run);
  if (prev && prev !== 'committed' && run.status === 'committed' && settings.fun.celebration !== false && allGreen(run)) celebrate();
}

async function loadDef(run) {
  const project = run.project;
  const hit = defCache.get(project);
  if (hit && Date.now() - hit.at < 60_000) {
    S.def = hit.list.find(p => p.id === run.pipeline) || null;
    return;
  }
  defCache.set(project, { at: Date.now(), list: hit ? hit.list : [] });
  try {
    const r = await api(`/api/pipelines?${qs({ project })}`);
    defCache.set(project, { at: Date.now(), list: asList(r.pipelines) });
    if (S.run && S.run.project === project) {
      S.def = asList(r.pipelines).find(p => p.id === S.run.pipeline) || null;
      paint();
    }
  } catch { /* no caps: the time meter shows the time alone */ }
}

async function loadChecks(run) {
  const id = run.id;
  S.reviewKey = run.lastGate.at;
  try {
    const r = await api(`/api/run-review?${qs({ id })}`);
    if (id === S.id) { S.review = r.checks || null; paint(); }
  } catch { /* the chip still shows */ }
}

// The quiet celebration: a green flash around the window (none with reduced motion, app.css).
function celebrate() {
  const f = document.getElementById('flash');
  if (!f) return;
  f.classList.remove('on');
  void f.offsetWidth; // restarts the animation
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 1300);
  toast('Committed, with every gate green.');
}

// One click on a run button: checks it is on, asks first when `confirm` is [title, text, ok],
// posts it, shows the answer, and pulls at once. Resolves with the answer, or null.
async function runAction(action, payload = {}, { confirm } = {}) {
  const run = S.run;
  const a = actionOf(run, action);
  if (!run || !a) return null;
  if (!a.enabled) { toast(a.reason || `${a.label} is not possible now.`, true); return null; }
  if (S.busy) { toast('Wait: another action is still running.', true); return null; }
  if (confirm && !(await confirmDialog(...confirm))) return null;
  const id = S.id;
  S.busy = action;
  paint();
  try {
    const r = await api(`/api/runs/${action}`, { method: 'POST', body: { ...payload, id } });
    toast(r.message || 'Done.');
    if (id === S.id && r.run && r.run.id === id) S.run = r.run;
    if (action === 'next-slice' && r.childRunId) go('run', r.childRunId);
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    if (id === S.id) {
      S.busy = '';
      paint();
      pull();
    }
  }
}

function cancelRun() {
  const editing = S.def ? !!S.def.editing : !!(S.run && S.run.isolation && S.run.isolation.treeMode === 'run');
  return runAction('cancel', {}, {
    confirm: ['Cancel this run?', editing
      ? 'Changes so far are saved to final/stopped.patch and the run worktree is reset.'
      : 'The running stage stops. This run changes no files.', 'Cancel run'],
  });
}

// ---------------------------------------------------------------- keyboard

let gAt = 0;
function onKey(e) {
  // "g t" is the shell's jump to Today: a t right after a g is not Take over.
  if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) { gAt = Date.now(); return; }
  const afterG = Date.now() - gAt <= 1000;
  gAt = 0;
  if (!singleKeyOk(e, root)) return;
  if ((e.key === 't' || e.key === 'T') && !afterG) { e.preventDefault(); runAction('takeover'); }
  else if (e.key === '.') { e.preventDefault(); cancelRun(); }
  else if (e.key === 'j') { e.preventDefault(); timeline.move(1); }
  else if (e.key === 'k') { e.preventDefault(); timeline.move(-1); }
}

// ---------------------------------------------------------------- the view

function onShow({ sub }) {
  if (sub !== S.id) switchRun(sub);
  if (!RUN_ID_RE.test(sub)) { paint(); return; }
  stopPoll = livePoll(pull, { runId: sub });
  // The time meter and a running stage's duration move on between pulls.
  ticker = setInterval(() => { if (S.run && S.run.status === 'running') { paintMeters(S.run); tickStages(S.run); } }, 1000);
}

function onHide() {
  if (stopPoll) stopPoll();
  stopPoll = null;
  clearInterval(ticker);
  ticker = null;
  if (timeline) timeline.stop();
}

export default {
  id: 'run',
  label: 'Live run',
  icon: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
  render,
  onShow,
  onHide,
};
