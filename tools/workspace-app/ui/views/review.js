// Review gate (#review/<id>; SPEC 5.7, mockup #v-review). Everything you need to decide about a
// finished change in one place: the proof the app wrote, the checks of the last gate, the fresh
// reviewer's findings (tick some to send back), what is not proven, and the diff file by file.
// From here: Approve and commit… (the commit dialog, parts/commit-dialog.js), Send back with the
// ticked findings (the `fix` action: Implement resumes with them, at most two rounds), Open in
// terminal (take over), Stop, keep patch, and under More: send back with a note, park, save as
// report. There is no push or merge button anywhere.
//
// Data: GET /api/run (the run with its buttons and their reasons; polled lightly, and at once on
// a live signal for this run), GET /api/run-review (verdict, findings, notProven, proof, checks,
// files with risk tags) when the run changed, and GET /api/run-diff for the file on show. The
// page repaints only when the run changed; ticking a finding or picking a file updates just its
// own part, so the focus, the ticks and the diff's scroll position stay put.
//
// Keyboard (SPEC 5.7, WCAG 2.1.4): with the focus inside this view and single keys on in the
// settings, F sends back the ticked findings, T opens the terminal, C opens the commit dialog,
// j and k move between findings, and Space ticks one (it is a checkbox). The g-shortcuts of the
// shell win: a key right after g is left to them.
import { act, api, confirmDialog, fmtClock, h, icon, keepFocus, keyed, plural, qs, toast } from '../lib.js';
import { formDialog } from '../dialog.js';
import { go, goProject, livePoll, openLauncher, settings, singleKeyOk, waitingKind } from '../store.js';
import { statusPair } from '../parts/status.js';
import { checksChip, checksTable } from '../parts/checks-table.js';
import { diffSummary, diffView, fileChips, isCut, lineIndex, parseDiff, SHOW_LINES } from '../parts/diff.js';
import { isCommitDialogOpen, openCommitDialog, syncCommitDialog } from '../parts/commit-dialog.js';

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
const TERM_ICON = '<path d="m6 9 3 3-3 3"/><path d="M12 15h6"/><rect x="2" y="4" width="20" height="16" rx="2"/>';
const VERDICTS = { ship: 'ok', fix: 'amber', stop: 'red' };
const SEVERITY = { high: ['red', 'High'], medium: ['amber', 'Medium'], low: ['', 'Low'] };
const NO_PUSH = 'There is no push or merge button.';

const ticks = new Map(); // run id -> Set of ticked finding ids (kept while the page is open)
let section = null;
let m = fresh('');
let stopPoll = null;
let gAt = 0; // the time of the last "g": the shell's g-shortcuts take the next key
let bar = null; // the action bar card, repainted on its own when the ticks change
let changesCard = null; // the Changes card, repainted on its own when a file is picked

function fresh(id) {
  return {
    id, run: null, sig: '', review: null, reviewNote: '', error: '', loading: true, painted: false,
    file: '', diffs: new Map(), all: false, mark: null, acting: '',
  };
}

const asList = x => (Array.isArray(x) ? x : []);
const sha7 = s => String(s || '').slice(0, 7);
const tickedOf = id => { if (!ticks.has(id)) ticks.set(id, new Set()); return ticks.get(id); };
const actionOf = name => asList(m.run && m.run.actions).find(a => a && a.action === name) || { action: name, enabled: false, reason: 'Loading…' };
const domId = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const findings = () => asList(m.review && m.review.findings).filter(f => f && typeof f === 'object');
const files = () => asList(m.review && m.review.files).filter(f => f && typeof f.path === 'string');
const badge = (cls, text) => h('span', { class: cls ? `badge ${cls}` : 'badge' }, text);
const stageLabel = id => (asList(m.run && m.run.stages).find(s => s && s.id === id) || {}).label || id;

// A change in any of these means a repaint (the timeline growing alone does not).
const signature = run => JSON.stringify([run.updatedAt, run.status, waitingKind(run),
  asList(run.actions).map(a => [a.action, a.enabled, a.reason])]);

// ---------------------------------------------------------------- data

async function pull() {
  const id = m.id;
  if (!RUN_ID_RE.test(id)) return false;
  let r;
  try {
    r = await api(`/api/run?${qs({ id, limit: 1 })}`);
  } catch (e) {
    if (id !== m.id) return false;
    if (e.network) return true;
    m.loading = false;
    m.error = e.status === 404 ? 'There is no run with this id. Open one from Runs.' : e.message;
    paint();
    return e.status !== 404 && e.status !== 400;
  }
  if (id !== m.id) return false;
  if (!r.run) return true;
  const sig = signature(r.run);
  const changed = sig !== m.sig;
  m.run = r.run;
  m.sig = sig;
  m.error = '';
  if (changed) {
    m.diffs.clear(); // a fix round or a commit changes the diff
    await loadReview(id);
    if (id !== m.id) return false;
    m.loading = false;
    paint();
    syncCommitDialog(id, m.run);
  }
  return true;
}

// Re-pulls now (after an action, or for the commit dialog), whatever the signature says.
async function pullNow() {
  m.sig = '';
  await pull();
  return m.run;
}

async function loadReview(id) {
  try {
    const r = await api(`/api/run-review?${qs({ id })}`);
    if (id !== m.id) return;
    m.review = r;
    m.reviewNote = '';
  } catch (e) {
    if (id !== m.id) return;
    m.review = null;
    m.reviewNote = e.status === 404 ? 'There is no review for this run.' : `The review could not be loaded: ${e.message}`;
  }
  const list = files();
  if (!list.some(f => f.path === m.file)) { m.file = list.length ? list[0].path : ''; m.all = false; m.mark = null; }
  if (m.file) loadDiff(m.file);
}

async function loadDiff(path) {
  const id = m.id;
  if (m.diffs.has(path)) return;
  m.diffs.set(path, { loading: true });
  try {
    const r = await api(`/api/run-diff?${qs({ id, file: path })}`);
    if (id !== m.id) return;
    m.diffs.set(path, { parsed: parseDiff(r.hunks), truncated: !!r.truncated });
  } catch (e) {
    if (id !== m.id) return;
    m.diffs.set(path, { error: e.status === 404 ? `${path} is not in this run's diff.` : `The diff could not be loaded: ${e.message}` });
  }
  if (path === m.file) paintChanges({ focusDiff: !!(m.mark && m.mark.path === path && m.mark.pending) });
}

// ---------------------------------------------------------------- actions

// POST /api/runs/<name>; the answer's message or error shows as a toast. Then a fresh pull.
async function runAction(name, body = {}) {
  if (m.acting) return null;
  m.acting = name;
  paintBar();
  const r = await act(api(`/api/runs/${name}`, { method: 'POST', body: { id: m.id, ...body } }));
  m.acting = '';
  if (r && name === 'fix') tickedOf(m.id).clear();
  if (r && r.childRunId) go('run', r.childRunId);
  await pullNow();
  paintBar();
  return r;
}

// An action that is off says why in a toast (the keyboard shortcuts reach it with no button).
function tryAction(name, fn) {
  const a = actionOf(name);
  if (!a.enabled) { toast(a.reason || `${name} is off.`, true); return; }
  fn();
}

function sendBack() {
  // After red gates there are no findings to pick: Fix again sends the gate summary.
  if (m.run && m.run.status === 'gates-red') { tryAction('fix', () => runAction('fix')); return; }
  const ids = [...tickedOf(m.id)].filter(id => findings().some(f => f.id === id));
  tryAction('fix', () => {
    if (!ids.length) { toast('Send back is off: tick at least one finding first.', true); return; }
    runAction('fix', { findings: ids });
  });
}

function openCommit() {
  tryAction('commit', () => {
    const last = (m.run && m.run.lastGate) || {};
    openCommitDialog({
      runId: m.id, run: m.run,
      reload: pullNow,
      onDone: async () => { await pullNow(); focusFallback(); },
      celebrate: ['green', 'pass'].includes(last.result),
    });
  });
}

const takeOver = () => tryAction('takeover', () => runAction('takeover'));

async function stopKeepPatch() {
  const ok = await confirmDialog('Stop this run?', 'Your changes are saved to final/stopped.patch, the run tree is reset and the lock is released. Nothing is committed.', 'Stop, keep patch');
  if (ok) runAction('stop');
}

async function park() {
  const ok = await confirmDialog('Park this run?', 'The patch is saved, the run tree is reset and the lock is free for another run. Resume it later from the run view; it comes back to this gate.', 'Park run');
  if (ok) runAction('park');
}

function noteDialog() {
  const note = h('textarea', { maxlength: 4000, rows: 6 });
  formDialog('Send back with a note', 'Implement resumes with your note. The checks and a fresh review run again after it.',
    [['Note for Claude', 'What should change? It is passed on as data.', note]],
    'Send back', async () => {
      if (!note.value.trim()) throw new Error('Write a note for Claude first.');
      const r = await api('/api/runs/sendback', { method: 'POST', body: { id: m.id, note: note.value } });
      pullNow();
      return r;
    });
}

// ---------------------------------------------------------------- the head and the notes

function verdictBadge() {
  const r = m.review;
  if (!r || !r.verdict) return null;
  const counts = {};
  for (const f of findings()) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const parts = ['high', 'medium', 'low'].filter(s => counts[s]).map(s => `${counts[s]} ${s}`);
  return badge(VERDICTS[r.verdict] || '', `Verdict: ${r.verdict}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
}

// "opus/high" from the latest attempt of a stage, or ''.
function modelOf(stageId) {
  const st = asList(m.run && m.run.stages).find(s => s && s.id === stageId);
  const a = st && asList(st.attempts)[asList(st.attempts).length - 1];
  return a && a.model ? `${a.model}${a.effort ? `/${a.effort}` : ''}` : '';
}

const hasGate = () => asList(m.run && m.run.stages).some(s => s && s.id === 'review-gate');
const atGate = () => !!m.run && m.run.status === 'waiting' && ['review', 'commit'].includes(waitingKind(m.run));
const runLink = text => h('button', { class: 'link', type: 'button', on: { click: () => go('run', m.id) } }, text);

function head() {
  const run = m.run;
  const model = modelOf('review');
  const who = hasGate()
    ? `A fresh reviewer${model ? ` (${model})` : ''} saw the plan, the diff and the check results, not the implementer's reasoning.`
    : `A read-only reviewer${model ? ` (${model})` : ''} looked at the diff.`;
  return h('div', { class: 'view-head' }, h('div', {},
    h('p', { class: 'crumb' },
      run && run.project ? [h('button', { class: 'link', type: 'button', title: 'The project\'s Changes tab', on: { click: () => goProject(run.project, 'changes') } }, run.project), ' / '] : null,
      run ? runLink(run.title || 'Run') : h('button', { class: 'link', type: 'button', on: { click: () => go('runs') } }, 'Runs'),
      ' / Review gate'),
    h('h2', {}, 'Review gate', verdictBadge(), run && !atGate() ? statusPair(run.status) : null),
    run ? h('p', {}, who) : null));
}

// The state of the run in a line or two above the action bar.
function notes() {
  if (m.error) return [h('p', { class: 'note red rv-state' }, m.error)];
  if (m.loading) return [h('p', { class: 'muted rv-state' }, 'Loading the review…')];
  const run = m.run;
  const out = [];
  if (!run) return out;
  for (const w of asList(run.warnings)) out.push(h('p', { class: 'note rv-state' }, typeof w === 'string' ? w : String((w && w.text) || '')));
  const kind = waitingKind(run);
  const stage = run.current && run.current.stage ? stageLabel(run.current.stage) : '';
  if (run.status === 'committed' && run.commit) {
    const hook = asList(run.commit.hookChanged);
    out.push(h('p', { class: 'note info rv-state' }, 'Committed ', h('code', {}, sha7(run.commit.sha)), ' on ', h('code', {}, run.commit.branch || run.branch || ''),
      '. Not pushed. ', hook.length ? `The hook changed ${hook.join(', ')}. ` : 'The hook changed nothing. ', 'Merge it in GitKraken when you are ready.'));
  } else if (run.status === 'running') {
    out.push(h('p', { class: 'note info rv-state' }, `This run is working again${stage ? ` (${stage})` : ''}. The review reloads when it is ready.`));
  } else if (run.status === 'in-terminal') {
    const since = run.takeover && run.takeover.since ? ` since ${fmtClock(run.takeover.since)}` : '';
    out.push(h('p', { class: 'note rv-state' }, `In a terminal${since}. Close the terminal session first, then use Back to app in the run view. `, runLink('Open the run')));
  } else if (run.status === 'gates-red') {
    out.push(h('p', { class: 'note red rv-state' }, `Checks red: ${run.statusReason || 'a gate failed.'}`));
  } else if (run.status === 'parked') {
    out.push(h('p', { class: 'note rv-state' }, 'Parked: the patch is saved and the lock is free. Resume it from the run view. ', runLink('Open the run')));
  } else if (['cancelled', 'failed', 'passed'].includes(run.status)) {
    out.push(h('p', { class: run.status === 'failed' ? 'note red rv-state' : 'note rv-state' }, `This run has ended${run.statusReason ? `: ${run.statusReason}` : '.'}`));
  } else if (run.status === 'waiting' && !['review', 'commit'].includes(kind)) {
    out.push(h('p', { class: 'note rv-state' }, `This run waits for you at ${stage || kind}, not at the review gate. `, runLink('Open the run')));
  } else if (['capped', 'paused-limit', 'interrupted'].includes(run.status)) {
    out.push(h('p', { class: 'note rv-state' }, `${run.statusReason || 'The run stopped before the review gate.'} `, runLink('Open the run')));
  }
  if (m.reviewNote) out.push(h('p', { class: 'note rv-state' }, m.reviewNote));
  return out;
}

// ---------------------------------------------------------------- the action bar

function actionButton(name, label, { cls = 'btn', on, iconMarkup = '', extraOk = true } = {}) {
  const a = actionOf(name);
  const enabled = a.enabled && !m.acting && extraOk;
  return keyed(h('button', {
    class: cls, type: 'button', disabled: !enabled, 'aria-describedby': enabled ? null : `rv-why-${name}`, on: { click: on },
  }, iconMarkup ? icon(iconMarkup) : null, m.acting === name ? `${label}…` : label), `act:${name}`);
}

function moreMenu() {
  const items = [['sendback', 'Send back with a note…', noteDialog], ['park', 'Park run', park], ['report', 'Save as report', () => runAction('report')]];
  return h('details', { class: 'menu rv-more' },
    h('summary', { class: 'btn' }, 'More'),
    h('div', { class: 'menu-list' }, items.map(([name, label, fn]) => {
      const a = actionOf(name);
      return [
        keyed(h('button', {
          type: 'button', disabled: !a.enabled || !!m.acting, 'aria-describedby': a.enabled ? null : `rv-why-${name}`,
          on: { click: e => { e.currentTarget.closest('details').open = false; fn(); } },
        }, label), `act:${name}`),
        a.enabled ? null : h('p', { class: 'reason rv-menu-why', id: `rv-why-${name}` }, a.reason),
      ];
    })));
}

function barContent() {
  const run = m.run;
  if (!run) return [h('div', { class: 'rv-reasons' }, h('p', { class: 'reason' }, m.loading ? 'Loading the buttons…' : NO_PUSH))];
  if (run.status === 'committed') {
    const next = actionOf('next-slice');
    return [
      next.enabled ? actionButton('next-slice', 'Start next slice', { cls: 'btn primary', on: () => runAction('next-slice') }) : null,
      keyed(h('button', { class: 'btn', type: 'button', on: { click: () => go('run', m.id) } }, 'Open the run'), 'act:open'),
      actionButton('report', 'Save as report', { on: () => runAction('report') }),
      h('div', { class: 'rv-reasons' }, h('p', { class: 'reason' }, `Committed on a new branch. ${NO_PUSH}`)),
    ];
  }
  const n = tickedOf(m.id).size;
  const fix = actionOf('fix');
  const red = run.status === 'gates-red';
  const rounds = run.fixRounds || {};
  const round = `round ${(rounds.user || 0) + 1} of ${rounds.maxUser || 2}`;
  const fixLabel = red ? 'Fix again' : 'Send back';
  const lines = [];
  if (!fix.enabled) lines.push(h('p', { class: 'reason', id: 'rv-why-fix' }, `${fixLabel} is off: ${fix.reason}`));
  else if (red) lines.push(h('p', { class: 'reason' }, `Fix again resumes Implement with the gate summary (${round}).`));
  else if (!n) lines.push(h('p', { class: 'reason', id: 'rv-why-fix' }, 'Send back is off: tick at least one finding first.'));
  else lines.push(h('p', { class: 'reason' }, `Send back resumes Implement with the ${plural(n, 'finding')} you ticked (${round}).`));
  for (const [name, label] of [['commit', 'Approve and commit'], ['takeover', 'Open in terminal'], ['stop', 'Stop, keep patch']]) {
    const a = actionOf(name);
    if (!a.enabled) lines.push(h('p', { class: 'reason', id: `rv-why-${name}` }, `${label} is off: ${a.reason}`));
  }
  lines.push(h('p', { class: 'reason' }, NO_PUSH));
  return [
    actionButton('commit', 'Approve and commit…', { cls: 'btn primary', on: openCommit }),
    actionButton('fix', red ? 'Fix again' : n ? `Send back with ${plural(n, 'finding')}` : 'Send back', { on: sendBack, extraOk: red || n > 0 }),
    actionButton('takeover', 'Open in terminal', { on: takeOver, iconMarkup: TERM_ICON }),
    actionButton('stop', 'Stop, keep patch', { cls: 'btn ghost', on: stopKeepPatch }),
    moreMenu(),
    h('div', { class: 'rv-reasons' }, lines),
  ];
}

function actionBar() {
  bar = h('div', { class: 'card actionbar', role: 'group', 'aria-label': 'Review gate actions' }, barContent());
  return bar;
}

function paintBar() {
  if (!bar || !bar.isConnected) return;
  const had = bar.contains(document.activeElement);
  keepFocus(bar, () => bar.replaceChildren(...barContent().flat(Infinity).filter(Boolean)));
  if (had) focusFallback();
}

// After a repaint removed or disabled the focused control (a button that just acted, a commit
// that ended the gate), the focus goes to the view heading instead of the page body.
function focusFallback() {
  if (!section || section.contains(document.activeElement) || document.querySelector('dialog[open]')) return;
  const heading = section.querySelector('h2');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- proof

function proofFacts(p) {
  const rows = [];
  const add = (k, ...v) => rows.push(h('dt', {}, k), h('dd', {}, ...v));
  const codes = list => list.map((t, i) => [i ? ', ' : '', h('code', {}, t)]);
  const base = p.base || {};
  add('Base', h('code', {}, sha7(base.sha)), base.branch ? ` on ${base.branch}` : '');
  const where = !p.tree ? '' : /^main checkout/.test(p.tree) ? ` · in the ${p.tree}` : [' · in the run worktree ', h('code', {}, p.tree)];
  add('Branch', p.branch ? h('code', {}, p.branch) : 'named when you commit', where);
  add('Level', String(p.level || 'standard'), asList(p.levelReason).length ? ` (${asList(p.levelReason).join(', ')})` : '');
  const sc = p.scope || {};
  const allowed = asList(sc.allowedByUser);
  const outside = asList(sc.outside);
  add('Scope', `${Number(sc.inPlan) || 0} of ${Number(sc.total) || 0} files in the plan`,
    allowed.length ? [' · ', badge('red', `${allowed.length} allowed by you`)] : '',
    outside.length ? [' · ', badge('red', `${outside.length} outside the plan`)] : '');
  const changedTests = asList(p.existingTestsChanged);
  add('Existing tests', changedTests.length ? [badge('red', changedTests.length === 1 ? 'existing test changed' : `${changedTests.length} existing tests changed`), ' ', codes(changedTests)] : 'none changed');
  const pins = p.pins || {};
  const nPins = asList(pins.before).length;
  if (nPins) {
    add('Pins', pins.identical ? `${nPins} of ${nPins} byte-identical since Prove` : badge('red', 'changed since Prove'),
      ', ', pins.green === false ? badge('red', 'red') : 'green');
  } else add('Pins', 'none');
  const red = asList(p.redTests).map(t => (typeof t === 'string' ? t : String((t && (t.name || t.path || t.id)) || '')));
  if (red.length) add('Red tests', `${plural(red.length, 'test')} that failed before the change: `, codes(red));
  const bl = p.baseline || {};
  add('Baseline', `${Number(bl.new) || 0} new · ${Number(bl.known) || 0} known · ${Number(bl.flaky) || 0} flaky`, bl.key ? [' · ', h('code', {}, bl.key)] : '');
  const th = p.treeHash || {};
  const gated = m.run && m.run.gatedTree && m.run.gatedTree.treeSha;
  let tree;
  if (th.match === true) tree = badge('ok', 'the commit matches the checked tree');
  else if (th.match === false) tree = badge('red', 'the hook changed files after the checks');
  else if (gated && th.gated === gated) tree = badge('ok', 'matches the checked tree');
  else if (gated) tree = badge('red', 'differs from the checked tree');
  else tree = badge('', 'not recorded');
  add('Tree hash', tree, th.gated ? [' ', h('code', {}, sha7(th.gated))] : '');
  const v = p.versions || {};
  if (v.node || v.claudeCode) add('Tools', [v.node ? `Node ${v.node}` : '', v.claudeCode ? `Claude Code ${v.claudeCode}` : ''].filter(Boolean).join(' · '));
  const turns = Object.entries(p.turns || {}).filter(([, n]) => Number(n) > 0);
  if (turns.length) add('Turns', turns.map(([id, n]) => `${stageLabel(id)} ${n}`).join(' · '));
  return h('dl', { class: 'facts' }, rows);
}

function proofCard() {
  const p = m.review && m.review.proof;
  const body = p && typeof p === 'object' ? proofFacts(p)
    : h('p', { class: 'muted' }, m.loading ? 'Loading…' : 'No proof yet. The app writes it when the checks pass on the final tree.');
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Proof'), h('span', { class: 'muted small' }, 'written by the app, not by Claude')),
    h('div', { class: 'card-body' }, body));
}

// ---------------------------------------------------------------- checks

function checksCard() {
  const r = m.review;
  const summary = r && r.checks;
  const gate = r && r.gate && typeof r.gate.folder === 'string' ? r.gate.folder : '';
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Checks'), checksChip(summary)),
    h('div', { class: 'card-body' }, r
      ? checksTable(summary, { runId: m.id, gate, caption: 'Checks of the last gate run' })
      : h('p', { class: 'muted' }, m.loading ? 'Loading…' : 'No check results.')));
}

// ---------------------------------------------------------------- findings

function onTick(id, checked) {
  const set = tickedOf(m.id);
  if (checked) set.add(id); else set.delete(id);
  paintBar();
}

function finding(f, { canTick, fileSet }) {
  const id = String(f.id || '');
  const key = domId(id || `x${Math.random().toString(36).slice(2)}`);
  const sev = SEVERITY[f.severity] || ['', String(f.severity || 'Note')];
  const unconfirmed = f.status === 'unconfirmed';
  const followUp = f.kind === 'follow-up';
  const where = f.path ? `${f.path}${Number(f.line) > 0 ? `:${f.line}` : ''}` : '';
  const inDiff = !!f.path && fileSet.has(f.path);
  const project = m.run && m.run.project;
  return h('li', { class: unconfirmed ? 'finding unconfirmed' : 'finding' },
    keyed(h('input', {
      type: 'checkbox', class: 'fsel', id: `rf-${key}`, checked: tickedOf(m.id).has(id), disabled: !canTick || !id,
      'aria-describedby': `rf-${key}-claim`, on: { change: e => onTick(id, e.target.checked) },
    }), `fsel:${id}`),
    h('label', { class: 'f-head', for: `rf-${key}` },
      badge(sev[0], sev[1]),
      followUp ? badge('blue', 'Follow-up') : null,
      unconfirmed ? badge('', 'Unconfirmed') : null,
      f.rule ? h('b', {}, f.rule) : null,
      where ? h('code', {}, where) : null),
    h('p', { class: 'claim', id: `rf-${key}-claim` }, String(f.claim || '')),
    f.evidence ? h('p', { class: 'ev' }, String(f.evidence)) : null,
    f.suggestion ? h('p', { class: 'f-act' }, `Suggested: ${f.suggestion}`) : null,
    unconfirmed ? h('p', { class: 'f-act' }, 'The verify pass could not confirm this. Kept and shown, never dropped.', f.verifyNote ? ` Verify said: ${f.verifyNote}` : '') : null,
    followUp || inDiff ? h('p', { class: 'f-act f-links' },
      followUp ? keyed(h('button', { class: 'link', type: 'button', on: { click: () => openLauncher('feature', { project, what: String(f.claim || '') }) } }, 'Start a slice'), `slice:${id}`) : null,
      inDiff ? keyed(h('button', { class: 'link', type: 'button', on: { click: () => showInDiff(f.path, f.line) } }, 'Show in diff'), `show:${id}`) : null) : null);
}

function findingsCard() {
  const r = m.review;
  const list = findings();
  const canTick = !!r && actionOf('fix').enabled && !m.acting;
  const fileSet = new Set(files().map(f => f.path));
  let body;
  if (!r) body = h('p', { class: 'muted' }, m.loading ? 'Loading…' : 'No review yet.');
  else {
    body = [
      !r.verified ? h('p', { class: 'note rv-verify' }, 'Verify did not run: quick review. No second pass checked these findings.') : null,
      list.length
        ? h('ul', { class: 'findings', 'aria-label': `Findings, ${list.length}` }, list.map(f => finding(f, { canTick, fileSet })))
        : h('p', { class: 'empty' }, h('b', {}, 'No findings'), 'The reviewer found nothing to fix.'),
    ];
  }
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Findings', list.length ? h('span', { class: 'muted small' }, `(${list.length})`) : null),
      h('span', { class: 'muted small' }, canTick ? 'tick the ones to send back' : list.length ? 'ticking is off at this point of the run' : '')),
    h('div', { class: 'card-body' }, body),
    settings.shortcuts.singleKey !== false && list.length ? h('div', { class: 'card-foot rv-keys' },
      'Keys in this view: ', h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' move, ', h('kbd', {}, 'Space'), ' ticks, ', h('kbd', {}, 'F'), ' sends back, ',
      h('kbd', {}, 'T'), ' terminal, ', h('kbd', {}, 'C'), ' commit.') : null);
}

function notProvenCard() {
  const list = asList(m.review && m.review.notProven).map(String);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Not proven'), h('span', { class: 'muted small' }, 'next to every green result')),
    h('div', { class: 'card-body' }, list.length
      ? h('ul', { class: 'cannot' }, list.map(t => h('li', {}, t)))
      : h('p', { class: 'muted' }, m.review ? 'Nothing listed.' : '–')));
}

// ---------------------------------------------------------------- changes

// What a file chip says besides its name: the scope facts from the proof (these flag the chip)
// and the profile's risk tags.
function chipFiles() {
  const p = (m.review && m.review.proof) || {};
  const sc = p.scope || {};
  const allowed = new Set(asList(sc.allowedByUser));
  const outside = new Set(asList(sc.outside));
  const changedTests = new Set(asList(p.existingTestsChanged));
  const pins = new Set(asList(p.pins && p.pins.before).map(x => x && x.path));
  return files().map(f => {
    const flags = [];
    if (allowed.has(f.path)) flags.push('Allowed by you');
    if (outside.has(f.path)) flags.push('Outside the plan');
    if (changedTests.has(f.path)) flags.push('Existing test changed');
    const tags = [...flags, ...(pins.has(f.path) ? ['Pin'] : []), ...asList(f.tags).map(t => `risk: ${t}`)];
    return { path: f.path, add: f.add, del: f.del, tags, flag: flags.join(', ') };
  });
}

function selectFile(path) {
  if (m.file !== path) { m.file = path; m.all = false; m.mark = null; }
  loadDiff(path);
  paintChanges();
}

function showInDiff(path, line) {
  m.file = path;
  m.all = false;
  m.mark = { path, line: Number(line) || 0, pending: true };
  loadDiff(path);
  paintChanges({ focusDiff: true });
}

function diffParts(cur) {
  const d = m.file ? m.diffs.get(m.file) : null;
  const parts = [h('p', { class: 'diff-meta' }, h('span', { class: 'mono' }, cur.path),
    d && d.parsed ? ` · ${diffSummary(d.parsed)}` : '', cur.tags.length ? ` · ${cur.tags.join(' · ')}` : '')];
  if (!d || d.loading) return [...parts, h('p', { class: 'muted rv-pad' }, 'Loading the diff…')];
  if (d.error) return [...parts, h('p', { class: 'note red rv-note' }, d.error)];
  const mk = m.mark && m.mark.path === m.file ? m.mark : null;
  const mark = mk ? lineIndex(d.parsed, mk.line) : -1;
  const all = m.all || mark >= SHOW_LINES;
  if (mk && mk.line > 0 && mark < 0) parts.push(h('p', { class: 'muted small rv-pad' }, `Line ${mk.line} is not in a changed part of this file.`));
  parts.push(diffView(d.parsed, { path: m.file, all, mark }));
  if (d.truncated) parts.push(h('p', { class: 'note rv-note' }, "This file's diff is longer than 2 MB; it shows the start."));
  if (isCut(d.parsed, all)) {
    parts.push(h('p', { class: 'rv-pad rv-more-lines' }, `Showing the first ${SHOW_LINES} of ${d.parsed.lines.length} lines. `,
      keyed(h('button', { class: 'link', type: 'button', on: { click: () => { m.all = true; paintChanges(); } } }, 'Show all lines'), 'diff:all')));
  }
  return parts;
}

function changes() {
  const r = m.review;
  const list = chipFiles();
  const tot = files().reduce((s, f) => [s[0] + (Number(f.add) || 0), s[1] + (Number(f.del) || 0)], [0, 0]);
  const cur = list.find(f => f.path === m.file);
  let parts;
  if (!r) parts = [h('p', { class: 'muted rv-pad' }, m.loading ? 'Loading…' : 'No changes to show.')];
  else if (!list.length) parts = [h('p', { class: 'muted rv-pad' }, 'This run changed no files.')];
  else parts = [fileChips(list, { selected: m.file, onSelect: selectFile }), cur ? diffParts(cur) : null];
  changesCard = h('div', { class: 'card rv-changes' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Changes'),
      r ? h('span', { class: 'muted small' }, `${plural(list.length, 'file')} · `, h('span', { class: 'text-green' }, `+${tot[0]}`), ' ', h('span', { class: 'text-red' }, `−${tot[1]}`)) : null),
    r && r.diffTruncated ? h('p', { class: 'note rv-note' }, "The run's diff is longer than 2 MB, so files after the cut are missing here. The whole diff is in the run folder (final/diff.patch).") : null,
    parts);
  return changesCard;
}

// Replaces the Changes card only. Keeps the diff's scroll position for the same file; after
// "Show in diff" it scrolls the finding's line into view and puts the focus on the diff.
function paintChanges({ focusDiff = false } = {}) {
  if (!changesCard || !changesCard.isConnected) return;
  const old = changesCard.querySelector('pre.diff');
  const keep = old && !focusDiff && old.getAttribute('aria-label') === `Diff of ${m.file}` ? [old.scrollTop, old.scrollLeft] : null;
  const card = changesCard;
  const next = changes();
  keepFocus(card.parentNode, () => card.replaceWith(next));
  const pre = next.querySelector('pre.diff');
  if (!pre) return;
  if (keep) { pre.scrollTop = keep[0]; pre.scrollLeft = keep[1]; }
  if (!focusDiff) return;
  if (m.mark) m.mark.pending = false;
  const marked = pre.querySelector('.mark');
  if (marked) pre.scrollTop = Math.max(0, marked.offsetTop - pre.offsetTop - pre.clientHeight / 3);
  pre.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- the view

function paint() {
  if (!section) return;
  m.painted = true;
  const old = section.querySelector('pre.diff');
  const keep = old && old.getAttribute('aria-label') === `Diff of ${m.file}` ? [old.scrollTop, old.scrollLeft] : null;
  const had = section.contains(document.activeElement);
  keepFocus(section, () => section.replaceChildren(
    head(),
    ...notes(),
    actionBar(),
    h('div', { class: 'review-grid' },
      h('div', { class: 'stack' }, proofCard(), checksCard()),
      h('div', { class: 'stack' }, findingsCard(), notProvenCard())),
    changes()));
  const pre = section.querySelector('pre.diff');
  if (pre && keep) { pre.scrollTop = keep[0]; pre.scrollLeft = keep[1]; }
  if (had) focusFallback();
}

// j / k: the next or previous finding's checkbox (the first or the last when none has the focus).
function moveFinding(step) {
  const boxes = [...section.querySelectorAll('.findings input.fsel')];
  if (!boxes.length) return;
  const at = boxes.indexOf(document.activeElement);
  const next = at < 0 ? (step > 0 ? 0 : boxes.length - 1) : Math.max(0, Math.min(boxes.length - 1, at + step));
  boxes[next].focus();
  boxes[next].closest('li').scrollIntoView({ block: 'nearest' });
}

// singleKeyOk counts every <input> as typing, but a finding's checkbox is where j, k and F are
// most useful: for a checkbox the same rules are checked here, without that one.
function keyAllowed(e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement && t.type === 'checkbox')) return singleKeyOk(e, section);
  if (settings.shortcuts.singleKey === false || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (document.querySelector('dialog[open]') || isCommitDialogOpen()) return false;
  return section.contains(document.activeElement);
}

function onKey(e) {
  if (!section || section.hidden || e.defaultPrevented) return;
  const k = e.key;
  if (k === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) { gAt = Date.now(); return; }
  if (gAt && Date.now() - gAt <= 1000) { gAt = 0; return; } // g t / g p / g r belong to the shell
  gAt = 0;
  if (!['f', 'F', 't', 'T', 'c', 'C', 'j', 'k'].includes(k) || !keyAllowed(e)) return;
  e.preventDefault();
  if (k === 'f' || k === 'F') sendBack();
  else if (k === 't' || k === 'T') takeOver();
  else if (k === 'c' || k === 'C') openCommit();
  else moveFinding(k === 'j' ? 1 : -1);
}

function render(el, { sub }) {
  if (section !== el) {
    section = el;
    el.addEventListener('keydown', onKey);
  }
  if (m.id !== sub) m = fresh(sub);
  if (!m.painted) paint();
}

function onShow({ sub }) {
  if (m.id !== sub) m = fresh(sub);
  if (!RUN_ID_RE.test(sub)) {
    m.loading = false;
    m.error = sub ? 'This is not a run id.' : 'No run chosen. Open one from Runs.';
    paint();
    return;
  }
  m.sig = ''; // pull the review again on every visit
  stopPoll = livePoll(pull, { runId: sub, ms: 5000, liveMs: 20_000 });
}

function onHide() {
  if (stopPoll) stopPoll();
  stopPoll = null;
}

export default {
  id: 'review',
  label: 'Review gate',
  icon: '<path d="m5 12 5 5L20 7"/>',
  render,
  onShow,
  onHide,
};
