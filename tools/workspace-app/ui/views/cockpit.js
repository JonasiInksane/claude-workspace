// Project cockpit (#cockpit/<project>, SPEC 5.3; mockup #v-cockpit): one screen that shows a
// project's state and starts everything for it. The header (name, real path, Start Claude here
// and More), the facts bar (branch, changes, upstream, stashes, trust, lock, Node, warning chips
// and the "Setup N/4" checklist), notes for a missing or broken profile and a lock held for days,
// the intent box with a quick row of the eight pipelines, and the cards: Audit progress (phase
// bar and the findings board, parts/kanban.js), Checks, Health, Branches and worktrees, Recent
// runs and Run <project>.
//
// Data: GET /api/project, /api/findings, /api/metrics, /api/checks and /api/runs?project, fetched
// in parallel; each card renders as soon as its own answer is in ("Loading…" until then, an error
// in a .note when it fails). Nothing starts from here without a screen that says what it does:
// pipelines open the launcher (store.openLauncher), Check my work previews its commands before
// Start, and every change (archive, accept a baseline, import findings, park) asks first.
//
// Re-rendering: main.js calls render() on every store change, and the view repaints itself when
// an answer arrives. Each card is cached with a signature of what it shows, and patch() swaps only
// the cards whose signature changed, so the focus, an open <details> and typed text survive a
// refresh (SPEC 5.11). Controls carry their own data-key, so keepFocus() finds them again when a
// card is rebuilt. Refresh (SPEC 5.10): every 10 s while the view is visible and some run is
// running, soon after a live signal for this project, on window focus, and after an action.
//
// Exports for views/health.js: nameOf, projectLabel, patch, createMemo and refresher. The pure
// helpers (factsBadges, quickRow, checkResult, ageText) are exported for the tests.
import { act, api, checkServer, confirmDialog, copy, fmtAgo, fmtDuration, fmtTime, h, icon, keepFocus, keyed, launch, openPlace, plural, qs, toast } from '../lib.js';
import { dialog, openDialog } from '../dialog.js';
import {
  atReviewGate, currentProject, go, loadPipelines, onSignal, openLauncher, pipelineDef, pipelines, refresh, runningCount,
  runs as liveRuns, state, sub, view,
} from '../store.js';
import { intentBox } from '../parts/intent.js';
import { bar } from '../parts/bar.js';
import { spark } from '../parts/sparkline.js';
import { badge, dot } from '../parts/status.js';
import { kanban, recordText } from '../parts/kanban.js';

const ICONS = {
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pass: '<path d="m5 12 4 4 10-10"/>',
  fail: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
};
// The quick row of the intent box, in the mockup's order.
export const QUICK = ['fix', 'refactor', 'debug', 'feature', 'review', 'architecture', 'explain', 'check'];
const TREND_TEXT = { better: 'Better', same: 'Same', worse: 'Worse' };
const short = sha => String(sha || '').slice(0, 7);

// ---------------------------------------------------------------- shared with views/health.js

// The project a cockpit or health route is about: its sub-route, else the current project.
export const nameOf = subPath => String(subPath || currentProject || '');

// The profile's label once GET /api/project answered ("Example"), else the name.
export function projectLabel(name) {
  const s = slots.get(name);
  return (s && s.project && s.project.data && s.project.data.project.label) || name;
}

// Puts exactly `nodes` (nulls skipped) into `parent`, in order, moving nothing that stays: stale
// children go first, then new nodes are inserted where they belong. A focused control inside a
// node that stays keeps the focus.
export function patch(parent, nodes) {
  const want = nodes.filter(Boolean);
  const keep = new Set(want);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  want.forEach((node, i) => { if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null); });
  return parent;
}

// A cache of built nodes: memo(key, deps, build) returns the node built last time for `key` while
// the JSON of `deps` is unchanged, and builds it again otherwise.
export function createMemo() {
  const map = new Map();
  return function memo(key, deps, build) {
    const sig = JSON.stringify(deps === undefined ? null : deps);
    const hit = map.get(key);
    if (hit && hit.sig === sig) return hit.el;
    const el = build();
    map.set(key, { sig, el });
    return el;
  };
}

// Calls load(name) now, every 10 s while the window is visible and a run is running, a moment
// after a live signal for the project (at most every 5 s), and on window focus when the last load
// is over 5 s old. start(name) in onShow, stop() in onHide; now() loads at once.
export function refresher(load) {
  let name = '';
  let timer = null;
  let soon = null;
  let off = null;
  let last = 0;
  const run = () => {
    clearTimeout(soon);
    soon = null;
    last = Date.now();
    load(name);
  };
  const later = () => { if (!soon) soon = setTimeout(run, Math.max(1000, 5000 - (Date.now() - last))); };
  const onFocus = () => { if (Date.now() - last > 5000) run(); };
  const self = {
    start(n) {
      self.stop();
      name = n;
      run();
      timer = setInterval(() => { if (!document.hidden && runningCount() > 0) run(); }, 10_000);
      // Ticks (the polling fallback) are covered by the interval above.
      off = onSignal(sig => { if (!sig.tick && (!sig.project || sig.project === name)) later(); });
      window.addEventListener('focus', onFocus);
    },
    stop() {
      clearInterval(timer);
      clearTimeout(soon);
      timer = null;
      soon = null;
      if (off) off();
      off = null;
      window.removeEventListener('focus', onFocus);
    },
    now: run,
  };
  return self;
}

// "12 min", "5 h", "3 days": how long a lock has been held.
export function ageText(sec) {
  const s = Number(sec);
  if (sec === null || sec === undefined || !Number.isFinite(s) || s < 0) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}

// ---------------------------------------------------------------- pure helpers (tested)

// The facts bar badges from GET /api/project: [{ text, cls, icon?, wrap? }]. Every badge says its
// fact in words; the class only adds the colour. The lock.waiting warning is left out here: it
// gets a note with Park run instead.
export function factsBadges(d) {
  const out = [];
  const g = d.git;
  if (g && g.error) out.push({ text: 'Git could not read the checkout', cls: 'red' });
  else if (g) {
    out.push({ text: g.detached ? `Detached at ${short(g.sha)}` : g.branch || 'No branch', cls: '', icon: 'branch' });
    out.push(g.changed ? { text: `${g.changed} changed`, cls: 'amber' } : { text: 'Clean', cls: 'ok' });
    if (!g.upstream) out.push({ text: 'No upstream', cls: '' });
    else if (!g.ahead && !g.behind) out.push({ text: `Even with ${g.upstream}`, cls: 'ok' });
    else out.push({ text: `${[g.ahead ? `${g.ahead} ahead` : '', g.behind ? `${g.behind} behind` : ''].filter(Boolean).join(', ')} of ${g.upstream}`, cls: 'amber' });
    const st = g.stashes || {};
    if (st.total) out.push({ text: `${st.total} ${st.total === 1 ? 'stash' : 'stashes'} · ${st.onBranch || 0} on this branch · untouched`, cls: '' });
  }
  const iso = d.isolation || {};
  if (iso.mode === 'branch') out.push({ text: 'Branch mode', cls: 'violet' });
  const t = d.trust;
  if (g && t && !t.error) {
    if (t.state === 'trusted') out.push({ text: 'Trusted', cls: 'ok' });
    else if (t.state === 'not-trusted') out.push({ text: 'Not trusted', cls: 'amber' });
    else out.push({ text: 'Trust unknown', cls: '' });
  }
  const lock = d.lock;
  if (lock && !lock.error) {
    const tree = iso.mode === 'worktree' && iso.worktree && iso.worktree.name ? iso.worktree.name : 'Edit lock';
    if (lock.broken) out.push({ text: 'Lock file unreadable', cls: 'amber' });
    else if (lock.held) out.push({ text: `${tree} busy: ${lock.title || `run ${lock.runId}`}`, cls: 'blue' });
    else out.push({ text: 'No lock', cls: '' });
  }
  const n = d.node;
  if (n && n.active) {
    const label = (d.project && d.project.label) || 'The project';
    out.push({ text: `Checks use Node ${n.active}${n.pin ? ` · ${label} pins ${n.pin}` : ''}`, cls: n.matches === false ? 'amber' : '' });
  }
  for (const w of d.warnings || []) if (w && w.id !== 'lock.waiting') out.push({ text: w.text, cls: 'amber', wrap: true });
  return out;
}

// The quick row: [{ pipeline, label, disabledReason }] for the pipelines in QUICK that the server
// lists. An editing pipeline (isolation 'tree') waits for the run worktree in worktree mode.
export function quickRow(list, d) {
  const iso = d && d.isolation;
  const wt = iso && iso.mode === 'worktree' ? iso.worktree : null;
  const notReady = !!wt && (!!wt.error || wt.state !== 'ready');
  const treeName = (wt && wt.name) || 'the run worktree';
  return QUICK.map(id => (list || []).find(p => p && p.id === id)).filter(Boolean).map(p => ({
    pipeline: p.id, label: p.label,
    disabledReason: p.disabledReason || (p.isolation === 'tree' && notReady ? `needs ${treeName}: Set up first` : ''),
  }));
}

// A check history line as the Checks table shows it: { cls, text, icon }.
export function checkResult(line) {
  if (!line) return { cls: 'skip', text: 'Not run yet', icon: '' };
  const chip = line.chip ? ` · ${line.chip}` : '';
  switch (line.result) {
    case 'pass': return { cls: 'pass', text: `Pass${chip}`, icon: 'pass' };
    case 'fail': return { cls: 'fail', text: `Fail${chip}`, icon: 'fail' };
    case 'error': return { cls: 'fail', text: `Error${chip}`, icon: 'fail' };
    case 'refused': return { cls: 'warn', text: 'Refused', icon: 'warn' };
    case 'cancelled': return { cls: 'skip', text: 'Cancelled', icon: '' };
    default: return { cls: 'skip', text: String(line.result || 'Unknown'), icon: '' };
  }
}

// ---------------------------------------------------------------- data

// Per project: { project, findings, metrics, checks, runs }, each { data, error, status } once
// answered (undefined while loading), plus the loading flags.
const slots = new Map();
const PARTS = {
  project: name => `/api/project?${qs({ name })}`,
  findings: name => `/api/findings?${qs({ project: name })}`,
  metrics: name => `/api/metrics?${qs({ project: name })}`,
  checks: name => `/api/checks?${qs({ project: name })}`,
  runs: name => `/api/runs?${qs({ project: name, limit: 8 })}`,
};

function slot(name) {
  if (!slots.has(name)) slots.set(name, { loading: false, again: false });
  return slots.get(name);
}

// Fetches every part at once; each repaints on its own. A load while one runs is queued.
async function load(name) {
  if (!name) return;
  const s = slot(name);
  if (s.loading) { s.again = true; return; }
  s.loading = true;
  await Promise.all(Object.keys(PARTS).map(async part => {
    try {
      s[part] = { data: await api(PARTS[part](name)) };
    } catch (e) {
      if (e.network) checkServer();
      // A failed refresh keeps the last answer and shows the error next to it.
      s[part] = { data: s[part] && s[part].data, error: e.message, status: e.status };
    }
    repaint(name);
  }));
  s.loading = false;
  if (s.again) {
    s.again = false;
    load(name);
  }
}

let section = null;
const refresher_ = refresher(load);

function repaint(name) {
  if (!section || view !== 'cockpit' || nameOf(sub) !== name) return;
  keepFocus(section, () => render(section, { sub }));
}

// The part's answer, or null.
const dataOf = part => (part && part.data) || null;

// ---------------------------------------------------------------- small builders

const memo = createMemo();
const minute = () => Math.floor(Date.now() / 60_000);

function loadingBody() {
  return h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading…'));
}

// An error in a .note, with Try again.
function errorNote(text, key) {
  return h('div', { class: 'note red ck-error' }, h('span', {}, text), ' ',
    keyed(h('button', { class: 'link', type: 'button', on: { click: () => refresher_.now() } }, 'Try again'), `retry:${key}`));
}

function cardHead(title, ...extra) {
  return h('div', { class: 'card-head' }, h('h3', {}, title), extra.length ? h('div', { class: 'row-actions' }, extra) : null);
}

function badgeEl(b) {
  return h('span', { class: `badge${b.cls ? ` ${b.cls}` : ''}${b.wrap ? ' wrap' : ''}` }, b.icon ? icon(ICONS[b.icon]) : null, b.text);
}

function resEl(r) {
  return h('span', { class: `res ${r.cls}` }, r.icon ? icon(ICONS[r.icon]) : null, r.text);
}

// A button with its own data-key, so the focus finds it again after a rebuild.
function btn(key, label, onClick, { cls = 'btn small', disabled = false, describedBy = null, title = null } = {}) {
  return keyed(h('button', { class: cls, type: 'button', disabled, title, 'aria-describedby': describedBy, on: { click: onClick } }, label), key);
}

const pipeLabel = id => (pipelineDef(id) || {}).label || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Run');
const closeButton = () => h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel');
const post = (path, body) => api(path, { method: 'POST', body });

// ---------------------------------------------------------------- actions

async function createProfile(name) {
  const r = await act(post('/api/project/profile-init', { project: name }));
  if (!r) return;
  refresh();
  loadPipelines(name, { force: true });
  refresher_.now();
}

async function setupWorktree(name) {
  try {
    const r = await post('/api/project/worktree-setup', { project: name });
    toast(r.message || 'Setting up the run worktree.');
    if (r.runId) go('run', r.runId);
  } catch (e) { toast(e.message, true); }
}

async function setIsolation(name, mode) {
  if (mode === 'branch' && !(await confirmDialog('Use branch mode?',
    'Editing runs will use your main checkout on a new branch instead of the run worktree. You can switch back here at any time.', 'Use branch mode'))) return;
  if (await act(post('/api/project/isolation', { project: name, mode }))) refresher_.now();
}

function checklistAction(name, a) {
  if (a.kind === 'link') go('projects');
  else if (a.kind === 'profile-init') createProfile(name);
  else if (a.kind === 'worktree-setup') setupWorktree(name);
  else if (a.kind === 'isolation') setIsolation(name, a.mode);
  else if (a.kind === 'copy') copy(a.text || '');
}

async function park(lock) {
  const ok = await confirmDialog('Park this run?',
    `${lock.title || `Run ${lock.runId}`} waits at the ${lock.waiting || 'next'} gate and holds the lock. Parking saves its changes to final/stopped.patch and frees the lock and the run worktree. Resume it later from the run, at the same gate.`,
    'Park run');
  if (ok && await act(post('/api/runs/park', { id: lock.runId }))) refresher_.now();
}

async function archive(name, branch) {
  const ok = await confirmDialog(`Archive ${branch}?`, 'It is renamed under archive/. Nothing is deleted: the branch and its commits stay.', 'Archive');
  if (ok && await act(post('/api/project/archive-branch', { project: name, branch }))) refresher_.now();
}

// "Diff" on an app branch, and an On branch card: a read-only Review run of that branch.
async function reviewBranch(name, branch) {
  const ok = await confirmDialog(`Review ${branch}?`,
    'Starts a read-only Review of this app branch against the base. Claude reads the diff and lists findings you can fix or dismiss; nothing is changed. About 5 to 15 minutes.',
    'Start review');
  if (!ok) return;
  try {
    const r = await post('/api/runs', { project: name, pipeline: 'review', values: { target: 'app', branch } });
    if (r.runId) go('run', r.runId);
  } catch (e) { toast(e.message, true); }
}

function findingClick(name, f, kind) {
  if (kind === 'fix') openLauncher('fix', { findingId: f.id, what: `Fix ${f.id}: ${f.title || ''}`.trim(), project: name });
  else if (kind === 'proposed') proposedDialog(name, f);
  else if (kind === 'run') go('run', f.runId);
  else if (kind === 'review') {
    if (f.branch) reviewBranch(name, f.branch);
    else toast(`No branch is recorded for ${f.id}.`, true);
  } else toast(recordText(f));
}

// A finding a run proposed: Accept moves it to Open; Dismiss needs a reason.
function proposedDialog(name, f) {
  const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'e.g. a test helper, not production code' });
  const error = h('div', { class: 'form-error', hidden: true });
  const send = async status => {
    if (status === 'dismissed' && !reason.value.trim()) {
      error.textContent = 'Say why you dismiss it first.';
      error.hidden = false;
      reason.focus();
      return;
    }
    try {
      const r = await post('/api/findings/status', { project: name, id: f.id, status, reason: status === 'dismissed' ? reason.value.trim() : '' });
      dialog.close();
      toast(r.message || 'Saved.');
      refresher_.now();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  };
  openDialog(`Proposed finding ${f.id}`, h('div', { class: 'form' },
    h('p', {}, h('b', {}, f.title || f.id)),
    f.evidence ? h('p', { class: 'muted' }, f.evidence) : null,
    h('p', { class: 'muted small' }, 'A run proposed it. Accept moves it to Open, so Fix can start on it; Dismiss takes it off the board with your reason.'),
    h('label', {}, 'Reason (for Dismiss)', reason),
    error), {
    actions: [
      closeButton(),
      h('button', { class: 'btn danger', type: 'button', on: { click: () => send('dismissed') } }, 'Dismiss'),
      h('button', { class: 'btn primary', type: 'button', on: { click: () => send('open') } }, 'Accept'),
    ],
  });
}

// ---------------------------------------------------------------- import findings

const STATUS_WORDS = { proposed: 'Proposed', open: 'Open', 'in-run': 'In run', 'on-branch': 'On branch', done: 'Done', dismissed: 'Dismissed' };
const statusWord = s => (s ? STATUS_WORDS[s] || s : 'New');

async function importFindings(name) {
  try {
    const r = await post('/api/findings/import', { project: name });
    importDialog(name, r.proposal);
    refresher_.now(); // the board now shows the waiting import too
  } catch (e) { toast(e.message, true); }
}

// The proposal as a table: a checkbox per finding (ticked by default), its id, title, status now
// and proposed, and why. Rows that change come first; the others sit in a <details>. Apply sends
// the proposal's hash, so a proposal that changed meanwhile is refused (409).
function importDialog(name, proposal) {
  if (!proposal || !Array.isArray(proposal.rows)) { toast('The import proposal is empty.', true); return; }
  const rows = proposal.rows;
  const boxes = new Map();
  const row = r => {
    const box = h('input', { type: 'checkbox', checked: true, 'aria-label': `Apply ${r.id}` });
    boxes.set(r.id, box);
    return h('tr', {},
      h('td', {}, box),
      h('td', { class: 'mono' }, r.id),
      h('td', {}, r.title || ''),
      h('td', {}, statusWord(r.current)),
      h('td', {}, r.change ? h('b', {}, statusWord(r.proposed)) : statusWord(r.proposed)),
      h('td', { class: 'muted small' }, (r.why || []).join('; ')));
  };
  const table = list => h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable ck-import' },
    h('thead', {}, h('tr', {}, ['Apply', 'Finding', 'Title', 'Now', 'Proposed', 'Why'].map(t => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, list.map(row))));
  const changed = rows.filter(r => r.change);
  const same = rows.filter(r => !r.change);
  const counts = proposal.counts || {};
  const error = h('div', { class: 'form-error', hidden: true });
  const apply = h('button', { class: 'btn primary', type: 'button', on: { click: () => send() } }, 'Apply');
  async function send() {
    const picked = rows.filter(r => boxes.get(r.id).checked).map(r => r.id);
    if (!picked.length) {
      error.textContent = 'Tick at least one finding, or Cancel.';
      error.hidden = false;
      return;
    }
    apply.disabled = true;
    try {
      const r = await post('/api/findings/import/apply', { project: name, hash: proposal.hash, accept: picked.length === rows.length ? 'all' : picked });
      dialog.close();
      toast(r.message || 'Applied.');
      refresher_.now();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      apply.disabled = false;
    }
  }
  const setAll = on => { for (const b of boxes.values()) b.checked = on; };
  openDialog('Import findings', h('div', { class: 'vgrid' },
    h('p', {}, `${plural(counts.total ?? rows.length, 'finding')} in the audit; ${counts.changed ?? changed.length} would change. Nothing is written until you apply.`),
    (proposal.warnings || []).map(w => h('p', { class: 'note' }, w)),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', on: { click: () => setAll(true) } }, 'Tick all'),
      h('button', { class: 'btn small', type: 'button', on: { click: () => setAll(false) } }, 'Untick all')),
    changed.length ? table(changed) : h('p', { class: 'muted' }, 'No finding changes status.'),
    same.length ? h('details', { class: 'ck-same' }, h('summary', {}, `${plural(same.length, 'finding')} that stay as they are`), table(same)) : null,
    error), {
    wide: true,
    actions: [closeButton(), apply],
  });
}

async function reconcile(name) {
  if (await act(post('/api/findings/reconcile', { project: name }))) refresher_.now();
}

// ---------------------------------------------------------------- Check my work and baselines

const WHAT_OPTIONS = [['uncommitted', 'My uncommitted changes'], ['branch', 'This branch vs base'], ['everything', 'Everything']];
const LEVEL_OPTIONS = [['quick', 'Quick'], ['standard', 'Standard'], ['paranoid', 'Paranoid']];

function select(options, value) {
  return h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

// What the preview says the check would do, as text.
function previewView(p) {
  const where = p.treeMode === 'run' ? `In the run worktree${p.tree ? ` (${p.tree})` : ''}.` : p.treeMode === 'main' ? 'In your main checkout.' : '';
  const base = p.base ? `Base ${p.base.short}${p.what !== 'everything' ? `, ${plural(p.changed || 0, 'changed file')}` : ''}.` : '';
  return h('div', { class: 'vgrid' },
    p.refusal ? h('p', { class: 'note red' }, p.refusal) : null,
    p.busy ? h('p', { class: 'note' }, `${p.busy} Starting now is likely refused until it is free.`) : null,
    where || base ? h('p', {}, [where, base].filter(Boolean).join(' ')) : null,
    (p.notes || []).map(n => h('p', { class: 'muted small' }, n)),
    (p.commands || []).length ? h('ul', { class: 'list ck-commands' }, p.commands.map(c => h('li', {},
      h('div', { class: 'main' },
        h('div', { class: 'title' }, `${c.group} · ${c.label}`),
        c.skipReason ? h('div', { class: 'sub wrap' }, `Skipped: ${c.skipReason}`) : c.command ? h('div', { class: 'sub wrap mono' }, c.command) : null)))) : null);
}

// "Check my work": what and how careful, a preview of the commands, then Start.
function checkDialog(name) {
  const what = select(WHAT_OPTIONS, 'uncommitted');
  const level = select(LEVEL_OPTIONS, 'quick');
  const out = h('div', { class: 'ck-preview' }, h('p', { class: 'muted' }, 'Loading what it would run…'));
  const error = h('div', { class: 'form-error', hidden: true });
  const reason = h('span', { class: 'reason', id: 'ck-check-why' }, 'Start is off until the preview has loaded.');
  const start = h('button', { class: 'btn primary', type: 'button', disabled: true, 'aria-describedby': 'ck-check-why', on: { click: () => send() } }, 'Start check');
  let seq = 0;
  let timer = null;
  async function update() {
    const n = ++seq;
    start.disabled = true;
    reason.textContent = 'Start is off until the preview has loaded.';
    try {
      const p = await post('/api/checks', { project: name, what: what.value, level: level.value, preview: true });
      if (n !== seq) return;
      out.replaceChildren(previewView(p));
      start.disabled = !!p.refusal;
      reason.textContent = p.refusal ? 'Start is off: the check would be refused (see above).' : '';
    } catch (e) {
      if (n !== seq) return;
      out.replaceChildren(h('p', { class: 'note red' }, e.message));
      reason.textContent = 'Start is off: the preview failed.';
    }
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 300); };
  what.addEventListener('change', later);
  level.addEventListener('change', later);
  async function send() {
    start.disabled = true;
    error.hidden = true;
    try {
      const r = await post('/api/checks', { project: name, what: what.value, level: level.value });
      dialog.close();
      toast(r.message || 'Checking your work.');
      if (r.runId) go('run', r.runId);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      start.disabled = false;
    }
  }
  openDialog('Check my work', h('div', { class: 'form' },
    h('p', { class: 'muted' }, 'Runs the profile\'s checks with code only: no Claude, no tokens. Your .env is never loaded.'),
    h('label', {}, 'What to check', what),
    h('label', {}, 'How careful?', level),
    h('h4', { class: 'ck-sub' }, 'What it would run'),
    out, error), {
    actions: [closeButton(), reason, start],
  });
  what.focus();
  update();
}

// "Accept new baseline": loads the candidate again (so you accept what you see), lists the known
// failures that leave, then sends the candidate's hash.
async function acceptBaseline(name, key) {
  let r;
  try { r = await api(`/api/baseline?${qs({ project: name, key })}`); } catch (e) { toast(e.message, true); return; }
  const c = r.candidate;
  if (!c) {
    toast('There is no smaller baseline any more.');
    refresher_.now();
    return;
  }
  const error = h('div', { class: 'form-error', hidden: true });
  const ok = h('button', { class: 'btn primary', type: 'button', on: { click: () => send() } }, 'Accept new baseline');
  async function send() {
    ok.disabled = true;
    try {
      const a = await post('/api/baseline/accept', { project: name, key: r.key, hash: c.hash });
      dialog.close();
      toast(a.message || 'Accepted.');
      refresher_.now();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      ok.disabled = false;
    }
  }
  const leaving = r.diff && r.diff.leaving ? r.diff.leaving : c.leaving || [];
  const entering = r.diff && r.diff.entering ? r.diff.entering : c.entering || [];
  openDialog('Accept the smaller baseline?', h('div', { class: 'vgrid' },
    h('p', {}, `The baseline for ${short(r.baseline && r.baseline.baseSha)} goes from ${c.from} to ${c.to} known failures. ${c.reason || ''}`.trim()),
    h('h4', { class: 'ck-sub' }, `Leaving the baseline (${leaving.length})`),
    h('ul', { class: 'ck-ids mono' }, leaving.map(id => h('li', {}, id))),
    entering.length ? [h('h4', { class: 'ck-sub' }, `Entering the baseline (${entering.length})`), h('ul', { class: 'ck-ids mono' }, entering.map(id => h('li', {}, id)))] : null,
    h('p', { class: 'muted small' }, 'A failure that left the baseline counts as new (red) when it fails again.'),
    error), {
    actions: [closeButton(), ok],
  });
}

async function recompute(name) {
  const ok = await confirmDialog('Check everything against the baseline?',
    'Starts a Standard check of the whole tree. When known failures now pass, a smaller baseline is proposed; nothing changes until you accept it.', 'Start check');
  if (!ok) return;
  try {
    const r = await post('/api/baseline/recompute', { project: name });
    toast(r.message || 'Started.');
    if (r.runId) go('run', r.runId);
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- header, facts, notes

function moreMenu(name, p) {
  const tools = state.tools || {};
  const present = !!(p && p.present);
  const project = (p && p.folder) || name;
  const item = (key, label, fn, disabled = false) => keyed(h('button', {
    type: 'button', disabled,
    on: { click: e => { const d = e.target.closest('details'); if (d) d.open = false; fn(); } },
  }, label), key);
  return h('details', { class: 'menu' },
    keyed(h('summary', { class: 'btn', 'aria-label': 'More project actions' }, 'More', icon(ICONS.down)), 'more'),
    h('div', { class: 'menu-list' },
      item('m-continue', 'Continue last session', () => launch({ kind: 'project', project, continueLast: true }), !present || !tools.claude),
      tools.editor ? item('m-editor', `Open in ${tools.editor}`, () => openPlace({ place: 'project', project, with: 'editor' }), !present) : null,
      item('m-folder', 'Open folder', () => openPlace({ place: 'project', project }), !present),
      item('m-health', 'Health and wins', () => go('health', name)),
      item('m-agents', 'Agents', () => go('projects'))));
}

function header(name, P) {
  const d = dataOf(P);
  const p = d ? d.project : null;
  const tools = state.tools || {};
  return memo(`head:${name}`, [p, !!(P && P.error), !!tools.claude, tools.editor || ''], () => {
    const why = !p ? '' : !p.present ? 'Link the checkout first.' : !tools.claude ? 'Claude Code was not found.' : '';
    return h('div', { class: 'view-head' },
      h('div', { class: 'ck-title' }, h('h2', {}, (p && p.label) || name),
        h('p', { class: 'mono' }, p ? p.realPath || 'Not linked yet' : P && P.error ? '' : 'Loading…')),
      h('div', { class: 'row-actions' },
        btn('start', 'Start Claude here', () => launch({ kind: 'project', project: p.folder || name }),
          { cls: 'btn', disabled: !p || !!why, describedBy: why ? 'ck-start-why' : null, title: 'Opens a terminal at the real path and starts Claude there' }),
        why ? h('span', { class: 'reason', id: 'ck-start-why' }, why) : null,
        moreMenu(name, p)));
  });
}

// The "Setup N/4" checklist in the facts bar. Open by default while something is to do; your own
// open or close is kept across refreshes.
const setupOpen = new Map();
function setupDetails(name, list) {
  const done = list.filter(x => x.ok).length;
  const all = done === list.length;
  const open = setupOpen.has(name) ? setupOpen.get(name) : !all;
  const det = h('details', { class: 'setup', open },
    keyed(h('summary', { class: all ? 'all' : 'todo' }, `Setup ${done}/${list.length}`,
      h('span', { class: 'sr-only' }, all ? ', all done' : `, ${list.length - done} to do`)), 'setup'),
    h('ul', {}, list.map(x => h('li', {},
      h('span', { class: `badge ${x.ok ? 'ok' : 'amber'}` }, x.ok ? 'Done' : 'To do'),
      h('span', { class: 'text' }, x.text),
      x.action ? btn(`setup:${x.id}:a`, x.action.label, () => checklistAction(name, x.action), { cls: `btn small${x.action.kind === 'worktree-setup' ? ' primary' : ''}` }) : null,
      x.alt ? btn(`setup:${x.id}:alt`, x.alt.label, () => checklistAction(name, x.alt)) : null))));
  det.addEventListener('toggle', () => setupOpen.set(name, det.open));
  return det;
}

function factsBar(name, d) {
  const badges = factsBadges(d);
  const list = Array.isArray(d.checklist) ? d.checklist : [];
  return memo(`facts:${name}`, [badges, list], () => h('div', { class: 'card factsbar', role: 'group', 'aria-label': 'Repository status' },
    badges.map(badgeEl),
    list.length ? setupDetails(name, list) : null));
}

// Notes under the facts bar: no profile, a broken profile, a lock held for days.
function notes(name, d) {
  const lockWarn = (d.warnings || []).find(w => w && w.id === 'lock.waiting');
  const pr = d.profile || {};
  return memo(`notes:${name}`, [pr, lockWarn ? lockWarn.text : '', d.lock && d.lock.runId], () => {
    const out = [];
    if (!pr.exists) {
      out.push(h('div', { class: 'note' }, h('span', {}, 'No profile yet. The app needs one for checks and pipelines; it lives in the private data folder, never in the hub.'),
        btn('profile-init', 'Create from the example', () => createProfile(name), { cls: 'btn small primary' })));
    } else if (!pr.valid) {
      const n = (pr.errors || []).length;
      out.push(h('div', { class: 'note red ck-profile' },
        h('p', {}, `The profile has ${plural(n, 'problem')}. Fix ${n === 1 ? 'it' : 'them'} in `, h('code', {}, pr.path || 'the profile file'), ':'),
        h('ul', {}, (pr.errors || []).map(e => h('li', {}, e)))));
    }
    if (pr.exists && (pr.warnings || []).length) {
      out.push(h('div', { class: 'note info ck-profile' }, h('p', {}, 'Profile warnings:'), h('ul', {}, pr.warnings.map(w => h('li', {}, w)))));
    }
    if (lockWarn && d.lock && d.lock.runId) {
      out.push(h('div', { class: 'note' }, h('span', {}, lockWarn.text),
        btn('lock:open', 'Open run', () => go('run', d.lock.runId)),
        btn('lock:park', 'Park run', () => park(d.lock), { cls: 'btn small primary' })));
    }
    return out.length ? h('div', { class: 'ck-notes' }, out) : null;
  });
}

// One intent box per project; built again only when its label or quick row changes, and then the
// typed text moves over to the new box.
const boxes = new Map();
function intent(name, d) {
  const label = (d && d.project && d.project.label) || name;
  const ready = pipelines.loaded && pipelines.project === name;
  const quick = ready ? quickRow(pipelines.list, d) : [];
  const sig = JSON.stringify([label, quick]);
  const hit = boxes.get(name);
  if (hit && hit.sig === sig) return hit.el;
  const el = intentBox({ label: `What do you want to do in ${label}?`, placeholder: 'Describe it in your own words', project: name, quick });
  const input = el.querySelector('input');
  keyed(input, `intent:${name}`);
  for (const b of el.querySelectorAll('.quick button')) keyed(b, `quick:${b.dataset.pipeline}`);
  const old = hit ? hit.el.querySelector('input') : null;
  if (old && old.value) {
    input.value = old.value;
    input.dispatchEvent(new Event('input'));
  }
  boxes.set(name, { sig, el });
  return el;
}

// ---------------------------------------------------------------- cards

// Audit progress: the phase bar, the board, Import findings and Reconcile.
const expanded = new Map(); // project -> Set of column ids that show every card
function auditCard(name, s) {
  const F = s.findings;
  const f = dataOf(F);
  const open = expanded.get(name) || new Set();
  const runRows = [...liveRuns.waiting, ...liveRuns.running, ...((dataOf(s.runs) || {}).runs || [])].map(r => [r.id, r.pipeline, r.status]);
  return memo(`audit:${name}`, [f, F && F.error, [...open], runRows], () => {
    const source = f && f.doc && f.doc.source ? f.doc.source : null;
    const when = source && (source.confirmedAt || source.importedAt);
    const head = h('div', { class: 'card-head' },
      h('h3', {}, 'Audit progress'),
      h('span', { class: 'muted small grow' }, when ? `Statuses come from the audit, records and git. Imported ${fmtTime(when)}.` : 'Statuses come from the audit, records and git.'),
      h('div', { class: 'row-actions' },
        btn('import', 'Import findings', () => importFindings(name)),
        btn('reconcile', 'Reconcile', () => reconcile(name), { title: 'Moves findings along what git and the runs show' })));
    if (!f) return h('div', { class: 'card span2 audit' }, head, F && F.error ? h('div', { class: 'card-body' }, errorNote(F.error, 'findings')) : loadingBody());
    const body = [];
    if (F.error) body.push(errorNote(`Could not refresh: ${F.error}`, 'findings'));
    if (f.importPending) {
      const c = f.importPending.counts || {};
      body.push(h('p', { class: 'note info' }, `An import is waiting for you${c.changed !== undefined ? `: ${plural(c.changed, 'finding')} would change` : ''}. `,
        btn('import:pending', 'Look at it', () => importDialog(name, f.importPending.proposal), { cls: 'link' })));
    }
    const phases = (f.phases || []).filter(p => p.total);
    if (phases.length) {
      const cur = phases.find(p => p.left > 0) || phases[phases.length - 1];
      const later = phases.filter(p => p !== cur && p.left > 0);
      body.push(h('div', { class: 'phase' }, h('b', {}, `Phase ${cur.id}`),
        bar(cur.pct, 'green', `Phase ${cur.id}: ${cur.text}`), h('span', {}, cur.text)));
      if (later.length) body.push(h('p', { class: 'muted small phase-later' }, `Also open: ${later.map(p => `Phase ${p.id} (${p.left} left)`).join(' · ')}`));
    }
    const total = (f.columns || []).reduce((n, c) => n + (Number(c.count) || 0), 0);
    if (!total) {
      body.push(h('div', { class: 'empty' }, h('b', {}, 'No findings yet'), 'Import them from the audit the profile names. Nothing changes until you apply.'));
    } else {
      body.push(kanban(f.columns, {
        nextUpId: f.nextUp ? f.nextUp.id : '',
        runs: new Map(runRows.map(([id, pipeline, status]) => [id, { id, pipeline, status }])),
        expanded: open,
        onCard: (x, col, kind) => findingClick(name, x, kind),
        onToggle: col => {
          const set = new Set(open);
          if (set.has(col)) set.delete(col);
          else set.add(col);
          expanded.set(name, set);
          repaint(name);
        },
      }));
    }
    return h('div', { class: 'card span2 audit' }, head, h('div', { class: 'card-body' }, body));
  });
}

const LEVEL_LABELS = { quick: 'Quick', standard: 'Standard', paranoid: 'Paranoid' };

function checksCard(name, s) {
  const C = s.checks;
  const d = dataOf(s.project);
  const last = (dataOf(C) || {}).last || (d && d.checks && !d.checks.error ? d.checks : null);
  const base = d && d.baseline && !d.baseline.error ? d.baseline : null;
  const present = !!(d && d.project.present);
  return memo(`checks:${name}`, [last, C && C.error, base, present, minute()], () => {
    const why = d && !present ? 'Link the checkout first.' : '';
    const head = cardHead('Checks', btn('check', 'Check my work', () => checkDialog(name), { cls: 'btn small primary', disabled: !d || !present }));
    if (!last) return h('div', { class: 'card' }, head, C && C.error ? h('div', { class: 'card-body' }, errorNote(C.error, 'checks')) : loadingBody());
    const rows = ['quick', 'standard', 'paranoid'].map(level => {
      const line = last[level];
      const r = checkResult(line);
      return h('tr', {},
        h('td', {}, LEVEL_LABELS[level]),
        h('td', {}, line && line.runId ? btn(`check:${level}`, resEl(r), () => go('run', line.runId), { cls: 'link res-link', title: 'Open the check run' }) : resEl(r)),
        h('td', {}, line ? fmtAgo(line.at) : '–'),
        h('td', {}, line ? fmtDuration(line.durationMs) || '–' : '–'));
    });
    const c = base && base.candidate;
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      why ? h('p', { class: 'reason' }, why) : null,
      C && C.error ? errorNote(`Could not refresh: ${C.error}`, 'checks') : null,
      h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable' },
        h('thead', {}, h('tr', {}, ['Level', 'Last result', 'When', 'Took'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows))),
      c && c.to !== null && c.from !== null && c.to < c.from ? h('p', { class: 'note mt-3' },
        'Smaller baseline available for ', h('code', {}, short(base.baseSha)), `: ${c.from} → ${c.to}. ${c.reason || ''} `,
        btn('baseline:accept', 'Accept new baseline', () => acceptBaseline(name, c.key || base.key), { cls: 'link' })) : null,
      h('p', { class: 'muted small mt-2' }, base && base.key
        ? `Baseline: ${plural(base.known ?? 0, 'known failure')} at ${short(base.baseSha)}, Node ${base.node || '?'}.`
        : 'No baseline yet. The first check in the run worktree makes one.')),
    h('div', { class: 'card-foot' }, btn('baseline:recompute', 'Check everything against the baseline…', () => recompute(name), { cls: 'link', disabled: !present })));
  });
}

// Health: the score and a short list of the tiles; the full screen is Health and wins.
function healthCard(name, s) {
  const M = s.metrics;
  const m = dataOf(M);
  const tiles = m ? (m.tiles || []).map(t => [t.id, t.label, t.display, t.trend, t.badge]) : null;
  return memo(`health:${name}`, [m && m.score, tiles, m && m.latest ? m.latest.id : null, M && M.error], () => {
    const head = cardHead('Health', btn('health', 'Health and wins', () => go('health', name), { cls: 'link' }));
    if (!m) return h('div', { class: 'card' }, head, M && M.error ? h('div', { class: 'card-body' }, errorNote(M.error, 'metrics')) : loadingBody());
    const score = m.score || {};
    const body = [];
    if (M.error) body.push(errorNote(`Could not refresh: ${M.error}`, 'metrics'));
    if (!m.latest && (score.value === null || score.value === undefined)) {
      body.push(h('div', { class: 'empty' }, h('b', {}, 'No scan yet'), 'The architecture check measures the tiles with code probes: free, 1 to 3 minutes.',
        h('div', { class: 'mt-3' }, btn('arch', 'Run architecture check', () => openLauncher('architecture', { project: name }), { cls: 'btn small primary' }))));
    } else {
      const delta = Number(score.delta) || 0;
      const trend = delta > 0 ? `+${delta} this week` : delta < 0 ? `−${Math.abs(delta)} this week` : 'no change this week';
      const series = Array.isArray(score.spark) ? score.spark : [];
      body.push(h('div', { class: 'ck-score' },
        h('div', {}, h('div', { class: 'muted small' }, 'Health score'),
          h('div', { class: 'big' }, score.value === null || score.value === undefined ? '—' : String(score.value), ' ', h('span', { class: `trend ${score.trend || 'same'}` }, trend))),
        h('div', { class: 'grow' }, spark(series, `Health score, last ${plural(series.length, 'scan')}${series.length ? `: ${series[0]} to ${series[series.length - 1]}` : ''}`))));
    }
    if ((m.tiles || []).length) {
      body.push(h('ul', { class: 'ck-tiles' }, m.tiles.map(t => h('li', {},
        h('span', { class: 'label' }, t.label),
        h('span', { class: 'value' }, t.display),
        t.badge === 'Probe failed' ? h('span', { class: 'badge red' }, 'Probe failed')
          : h('span', { class: `trend ${t.trend}` }, t.value === null || t.value === undefined ? '' : TREND_TEXT[t.trend] || t.trend)))));
    }
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, body));
  });
}

function branchesCard(name, s) {
  const d = dataOf(s.project);
  if (!d) return memo(`branches:${name}`, ['loading'], () => h('div', { class: 'card' }, cardHead('Branches and worktrees'), loadingBody()));
  const { git, isolation, lock, checklist } = d;
  const unmerged = (d.warnings || []).find(w => w && w.id === 'branches.unmerged');
  const wtItem = (checklist || []).find(x => x.id === 'worktree');
  return memo(`branches:${name}`, [git, isolation, lock, unmerged ? unmerged.text : '', wtItem, d.project.folder, minute()], () => {
    const head = cardHead('Branches and worktrees');
    if (!git) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Link the checkout first.')));
    if (git.error) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, errorNote(`Git could not read the checkout: ${git.error}`, 'git')));
    const items = [];
    const project = d.project.folder || name;
    items.push(h('li', {},
      h('div', { class: 'main' },
        h('div', { class: 'title' }, `Main checkout · ${git.detached ? `detached at ${short(git.sha)}` : git.branch || 'no branch'}`),
        h('div', { class: 'sub wrap' }, `${git.changed ? `${git.changed} changed` : 'clean'} · yours; the app never switches branches here`)),
      btn('br:folder', 'Folder', () => openPlace({ place: 'project', project }))));
    const wt = isolation && isolation.worktree;
    if (isolation && isolation.mode === 'branch') {
      items.push(h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title' }, 'Branch mode'), h('div', { class: 'sub wrap' }, 'Editing runs use your main checkout on a new branch.')),
        btn('br:iso', 'Use the run worktree', () => setIsolation(name, 'worktree'))));
    } else if (wt) {
      const where = wt.error ? '' : wt.branch ? ` · ${wt.branch}` : wt.head ? ` · detached at ${short(wt.head)}` : '';
      const lockText = lock && lock.held && !lock.error ? ` · ${lock.title || `run ${lock.runId}`} holds the lock (${ageText(lock.ageSec)})` : '';
      items.push(h('li', {},
        h('div', { class: 'main' },
          h('div', { class: 'title' }, `${wt.name || 'Run worktree'}${where}`),
          h('div', { class: 'sub wrap' }, `${wt.error || wt.text || ''}${lockText}`)),
        h('div', { class: 'row-actions' },
          lock && lock.held && lock.runId ? btn('br:run', 'Open run', () => go('run', lock.runId)) : null,
          wtItem && wtItem.action && wtItem.action.kind === 'worktree-setup' ? btn('br:setup', wtItem.action.label, () => setupWorktree(name), { cls: 'btn small primary' }) : null)));
    }
    for (const b of git.appBranches || []) {
      const merged = b.merged === true ? `merged into ${git.integrationBranch || 'the base'}` : b.merged === false ? 'not merged' : '';
      items.push(h('li', {},
        h('div', { class: 'main' },
          h('div', { class: 'title' }, h('code', {}, b.name)),
          h('div', { class: 'sub wrap' }, [merged, b.subject, fmtAgo(b.at), b.worktree ? 'checked out in a worktree' : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'row-actions' },
          btn(`br:diff:${b.name}`, 'Diff', () => reviewBranch(name, b.name), { title: 'Starts a read-only Review of this branch' }),
          btn(`br:archive:${b.name}`, 'Archive', () => archive(name, b.name)))));
    }
    const others = (git.worktrees || []).filter(w => !w.main && (!wt || String(w.path).toLowerCase() !== String(wt.path || '').toLowerCase()));
    for (const w of others) {
      items.push(h('li', {}, h('div', { class: 'main' },
        h('div', { class: 'title' }, `Worktree · ${w.branch || (w.detached ? `detached at ${short(w.head)}` : 'no branch')}`),
        h('div', { class: 'sub wrap mono' }, w.path))));
    }
    const more = (git.appBranchCount || 0) - (git.appBranches || []).length;
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      h('ul', { class: 'list' }, items),
      more > 0 ? h('p', { class: 'muted small' }, `+ ${more} more app ${more === 1 ? 'branch' : 'branches'} not shown.`) : null,
      unmerged ? h('p', { class: 'note mt-2' }, unmerged.text) : null,
      git.archivedBranches ? h('p', { class: 'muted small mt-2' }, `${git.archivedBranches} archived ${git.archivedBranches === 1 ? 'branch' : 'branches'} under archive/.`) : null));
  });
}

// The newest eight runs plus the project's waiting and running ones from the store (main.js loads
// them), so those show even when they are older. null while the card's own answer is out.
function mergeRuns(name, recent) {
  if (!recent) return null;
  const out = [...recent];
  for (const r of [...liveRuns.waiting, ...liveRuns.running]) if (r.project === name && !out.some(x => x.id === r.id)) out.push(r);
  return out;
}

// Recent runs: waiting first, then running, then the rest by recency (the list is newest first).
const RUN_ORDER = { waiting: 0, running: 1 };
function runsCard(name, s) {
  const R = s.runs;
  const list = mergeRuns(name, (dataOf(R) || {}).runs);
  return memo(`runs:${name}`, [list, R && R.error, minute(), pipelines.list.length], () => {
    const head = cardHead('Recent runs', btn('runs:all', 'All runs', () => go('runs'), { cls: 'link' }));
    if (!list) return h('div', { class: 'card' }, head, R && R.error ? h('div', { class: 'card-body' }, errorNote(R.error, 'runs')) : loadingBody());
    if (!list.length) {
      return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('div', { class: 'empty' },
        h('b', {}, 'No runs yet'), 'Try Explain: 3 minutes, read-only.',
        h('div', { class: 'mt-3' }, btn('runs:explain', 'Explain', () => openLauncher('explain', { project: name }), { cls: 'btn small primary' })))));
    }
    const rows = [...list].sort((a, b) => (RUN_ORDER[a.status] ?? 2) - (RUN_ORDER[b.status] ?? 2));
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      R.error ? errorNote(`Could not refresh: ${R.error}`, 'runs') : null,
      h('ul', { class: 'list' }, rows.map(r => {
        const review = atReviewGate(r);
        const where = r.status === 'waiting' ? `waits at ${r.waiting || 'a gate'}` : r.status === 'running' && r.stage ? `stage ${r.stage}` : '';
        const time = r.status === 'running' ? fmtDuration(r.durationMs) : fmtAgo(r.endedAt || r.createdAt);
        return h('li', {}, dot(r.status),
          h('div', { class: 'main' },
            h('div', { class: 'title' }, btn(`run:${r.id}`, r.title || r.id, () => go(review ? 'review' : 'run', r.id), { cls: 'link run-link' })),
            h('div', { class: 'sub' }, [pipeLabel(r.pipeline), where, time].filter(Boolean).join(' · '))),
          badge(r.status, review ? 'Review gate' : ''));
      }))));
  });
}

function runTgCard(name, d) {
  const label = (d.project && d.project.label) || name;
  return memo(`runtg:${name}`, [label, d.runTg, d.notCovered], () => {
    const rows = Array.isArray(d.runTg) ? d.runTg : [];
    const reasons = rows.filter(r => r.disabledReason);
    return h('div', { class: 'card span2' }, h('div', { class: 'card-head' }, h('h3', {}, `Run ${label}`), h('span', { class: 'muted small' }, 'opens a Windows Terminal tab')),
      h('div', { class: 'card-body' },
        rows.length ? h('div', { class: 'row-actions' }, rows.map(r => btn(`runcmd:${r.id}`, r.label,
          () => act(post('/api/project/run-tg', { project: name, id: r.id })),
          { disabled: !!r.disabledReason, describedBy: r.disabledReason ? `runcmd-why-${r.id}` : null }))) : h('p', { class: 'muted' }, 'The profile lists nothing to run.'),
        reasons.map(r => h('p', { class: 'reason', id: `runcmd-why-${r.id}` }, `${r.label}: ${r.disabledReason}`)),
        rows.filter(r => r.warn).map(r => h('p', { class: 'note mt-3' }, `${r.label}: ${r.warn}`)),
        (d.notCovered || []).length ? h('p', { class: 'muted small mt-2' }, `Not covered yet: ${d.notCovered.join(', ')}.`) : null));
  });
}

// ---------------------------------------------------------------- whole-view states

function stateCard(key, title, text, action) {
  return memo(key, [title, text], () => h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, title), text,
    action ? h('div', { class: 'mt-4' }, action) : null)));
}

// The grid of cards per project, patched card by card.
const grids = new Map();
function grid(name, s, d) {
  if (!grids.has(name)) grids.set(name, h('div', { class: 'cgrid' }));
  return patch(grids.get(name), [
    auditCard(name, s), checksCard(name, s), healthCard(name, s), branchesCard(name, s), runsCard(name, s),
    d ? runTgCard(name, d) : null,
  ]);
}

function render(el, ctx) {
  section = el;
  const name = nameOf(ctx.sub);
  if (!name) {
    patch(el, [
      memo('head:', [], () => h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Project cockpit')))),
      stateCard('none', 'No project chosen yet', 'A project with a private profile gets a cockpit in the nav. Link or clone one in Projects.',
        btn('none:projects', 'Projects', () => go('projects'), { cls: 'btn primary' })),
    ]);
    return;
  }
  const s = slot(name);
  const P = s.project;
  const d = dataOf(P);
  const head = header(name, P);
  if (!d && P && P.error) {
    patch(el, [head, P.status === 404
      ? stateCard(`unknown:${name}`, `No project named ${name}`, P.error, btn('unknown:projects', 'Projects', () => go('projects'), { cls: 'btn primary' }))
      : memo(`err:${name}`, [P.error], () => h('div', { class: 'card' }, h('div', { class: 'card-body' }, errorNote(P.error, 'project'))))]);
    return;
  }
  if (d && !d.project.present) {
    const linked = (d.checklist || []).find(x => x.id === 'linked');
    patch(el, [head, stateCard(`unlinked:${name}`, `${d.project.label || name} is not linked yet`,
      `${linked ? linked.text : 'The app can\'t find the checkout.'} Linking makes a junction in projects/ that points at your existing checkout; nothing in the checkout is moved or changed.`,
      btn('link', 'Link existing checkout', () => go('projects'), { cls: 'btn primary' }))]);
    return;
  }
  patch(el, [
    head,
    d ? factsBar(name, d) : null,
    d ? notes(name, d) : null,
    intent(name, d),
    grid(name, s, d),
  ]);
}

export default {
  id: 'cockpit',
  label: 'Project cockpit',
  icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  render,
  // Loads the project's pipelines (the quick row) and every card, then keeps them fresh.
  onShow: ({ sub: subPath }) => {
    const name = nameOf(subPath);
    if (!name) return;
    loadPipelines(name);
    refresher_.start(name);
  },
  onHide: () => refresher_.stop(),
};
