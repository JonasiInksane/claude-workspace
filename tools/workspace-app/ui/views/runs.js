// Runs (#runs): every pipeline run, newest first, from GET /api/runs (the runs index: the latest
// line per run, plus durationMs). Three selects narrow the list on the server: project, pipeline
// and status. Each row shows the title, pipeline, status (a dot next to a text badge), stage,
// level, start time, duration and branch, with Open: the review gate for a run waiting there,
// the live run otherwise. Load more asks for the next page with `before` (the oldest id shown;
// run ids sort by time). #runs/<project> opens the list filtered to that project.
//
// The list refreshes itself while it is on screen: on a live-update signal (debounced, so a busy
// run doesn't cause a pull per timeline row), on the shell's polling tick while the stream is
// down, and when the window gets the focus back. A refresh asks for as many rows as are shown,
// so Load more pages survive it. The filter bar is built once and kept, so a refresh never closes
// an open select; only the results card is replaced, with the focus kept on the same row.
//
// The pure helpers (runsQuery, startedText, openTarget, durationText) are exported for
// views/runs.test.mjs; nothing here touches the DOM when the module loads.
import { api, fmtDuration, fmtTime, h, keepFocus, keyed, plural, qs, STATUS_BADGES } from '../lib.js';
import {
  atReviewGate, currentProject, go, loadPipelines, onSignal, openLauncher, pipelines, profiledProjects, state, waitingKind,
} from '../store.js';
import { statusPair } from '../parts/status.js';

export const PAGE = 50;
const MAX_ROWS = 500; // the route's limit
const SIGNAL_DEBOUNCE_MS = 1500;

// What a waiting run waits for, in words (index rows carry the kind as a string).
const WAIT_TEXT = {
  plan: 'the plan', spec: 'the spec', hypothesis: 'a hypothesis', fence: 'a file outside the plan',
  review: 'the review gate', commit: 'the commit', triage: 'triage', decide: 'a decision',
};
const ENDED = ['passed', 'failed', 'cancelled', 'committed'];

// ---------------------------------------------------------------- pure helpers

// The query string of GET /api/runs for these filters: { project, pipeline, status }, plus
// `before` (an id) and `limit`. Empty filters are left out.
export function runsQuery(filters = {}, { before = '', limit = PAGE } = {}) {
  const q = { limit: Math.max(1, Math.min(MAX_ROWS, Number(limit) || PAGE)) };
  for (const key of ['project', 'pipeline', 'status']) if (filters[key]) q[key] = filters[key];
  if (before) q.before = before;
  return qs(q);
}

// "10:18" for a run started today, "21 Oct, 10:18" for an older one; '' for a bad date.
export function startedText(iso, now = Date.now()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const p = n => String(n).padStart(2, '0');
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : fmtTime(iso);
}

// Where Open goes: [view, id]. A run waiting at the review gate (or the commit) opens the review.
export const openTarget = row => [row && row.status === 'waiting' && atReviewGate(row) ? 'review' : 'run', String((row && row.id) || '')];

// "4 m 12 s", or "4 m 12 s so far" for a run that hasn't ended; '' when unknown.
export function durationText(row) {
  const text = fmtDuration(row ? row.durationMs : null);
  if (!text) return '';
  return row.endedAt || ENDED.includes(row.status) ? text : `${text} so far`;
}

// ---------------------------------------------------------------- the view's data

const filters = { project: '', pipeline: '', status: '' };
// rows: the runs shown; more: a next page may exist; error: the last load's problem; missing:
// GET /api/runs answered 404 (the route isn't there yet).
let list = { rows: [], loaded: false, loading: false, more: false, error: '', missing: false };
let token = 0; // bumps on every new load, so a late answer for old filters is dropped
let section = null;
let parts = null; // { head, bar, selects: { project, pipeline, status }, results }
let lastSignature = '';
let debounce = null;
let offSignal = null;
let visible = false;

const pipelineLabel = id => {
  const def = pipelines.list.find(p => p.id === id);
  return def ? def.label : String(id || '');
};
function stageLabel(row) {
  const def = pipelines.list.find(p => p.id === row.pipeline);
  const st = def && Array.isArray(def.stages) ? def.stages.find(s => s.id === row.stage) : null;
  return st ? st.label : String(row.stage || '');
}

// Loads the first page again (reset), or refreshes the rows shown (as many as are loaded).
async function load({ reset = false } = {}) {
  const my = ++token;
  const limit = reset ? PAGE : Math.min(MAX_ROWS, Math.max(PAGE, list.rows.length));
  if (reset) list = { rows: [], loaded: false, loading: true, more: false, error: '', missing: false };
  else list.loading = true;
  paint();
  try {
    const r = await api(`/api/runs?${runsQuery(filters, { limit })}`);
    if (my !== token) return;
    const rows = Array.isArray(r.runs) ? r.runs.filter(x => x && typeof x.id === 'string') : [];
    list = { rows, loaded: true, loading: false, more: rows.length >= limit, error: '', missing: false };
  } catch (e) {
    if (my !== token) return;
    list = { ...list, loaded: true, loading: false, error: e.status === 404 ? '' : e.message, missing: e.status === 404 };
  }
  paint();
}

// The next page: the runs older than the last one shown. Pressed from the keyboard, the focus
// then moves to the first new row, so the reader continues where the list grew.
async function loadMore(e) {
  const last = list.rows[list.rows.length - 1];
  if (!last || list.loading) return;
  const fromKeyboard = !!(e && e.detail === 0);
  const my = ++token;
  list.loading = true;
  paint();
  let added = [];
  try {
    const r = await api(`/api/runs?${runsQuery(filters, { before: last.id, limit: PAGE })}`);
    if (my !== token) return;
    const seen = new Set(list.rows.map(x => x.id));
    added = (Array.isArray(r.runs) ? r.runs : []).filter(x => x && typeof x.id === 'string' && !seen.has(x.id));
    const rows = [...list.rows, ...added].slice(0, MAX_ROWS);
    list = { ...list, rows, loading: false, more: added.length >= PAGE && rows.length < MAX_ROWS, error: '' };
  } catch (err) {
    if (my !== token) return;
    list = { ...list, loading: false, error: err.message };
  }
  paint();
  if (!fromKeyboard || !added.length || !parts) return;
  const row = [...parts.results.querySelectorAll('tr[data-key]')].find(tr => tr.dataset.key === added[0].id);
  if (row) row.querySelector('button').focus();
}

function refreshSoon(ms) {
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (visible) load(); }, ms);
}
const onFocus = () => refreshSoon(300);

// ---------------------------------------------------------------- rendering

const blank = () => [h('span', { class: 'muted', 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'none')];

function runRow(r) {
  // The stage names most gates already ("Approve the plan"); the wait is spelled out only when not.
  const kind = r.status === 'waiting' ? waitingKind(r) : '';
  const waits = kind && (!r.stage || kind === 'fence') ? WAIT_TEXT[kind] || kind : '';
  const [view, id] = openTarget(r);
  const started = startedText(r.createdAt);
  const duration = durationText(r);
  const cls = r.status === 'waiting' ? 'waiting' : r.status === 'running' ? 'running' : '';
  const cell = (label, cellCls, ...kids) => h('td', { role: 'cell', 'data-label': label || null, class: cellCls || null }, kids);
  return keyed(h('tr', { role: 'row', class: cls || null },
    cell('', 'runs-cell-title',
      h('div', { class: 'runs-title', title: r.id }, r.title || r.id),
      filters.project ? null : h('div', { class: 'runs-sub' }, r.project)),
    cell('Pipeline', '', pipelineLabel(r.pipeline)),
    cell('Status', '', h('span', { class: 'runs-status' }, statusPair(r.status))),
    cell('Stage', '', r.stage ? stageLabel(r) : blank(), waits ? h('div', { class: 'runs-sub' }, `waits for ${waits}`) : null),
    cell('Level', '', r.level ? r.level.charAt(0).toUpperCase() + r.level.slice(1) : blank()),
    cell('Started', '', started ? h('time', { datetime: r.createdAt, title: fmtTime(r.createdAt) }, started) : blank()),
    cell('Duration', 'runs-num', duration ? duration.replace(/ so far$/, '') : blank(),
      / so far$/.test(duration) ? h('div', { class: 'runs-sub' }, 'so far') : null),
    cell('Branch', 'runs-branch', r.branch ? h('code', { title: r.branch }, r.branch) : blank(),
      r.commit ? h('div', { class: 'runs-sub' }, 'commit ', h('code', {}, String(r.commit).slice(0, 7))) : null),
    cell('', 'runs-cell-open', h('button', {
      class: 'btn small', type: 'button', title: view === 'review' ? 'Opens the review gate' : 'Opens the run',
      'aria-label': `${view === 'review' ? 'Open the review gate of' : 'Open'} ${r.title || r.id}`,
      on: { click: () => go(view, id) },
    }, 'Open'))), r.id);
}

function table(rows) {
  const cols = ['Run', 'Pipeline', 'Status', 'Stage', 'Level', 'Started', 'Duration', 'Branch', ''];
  return h('div', { class: 'runs-wrap' }, h('table', { class: 'runs-table', role: 'table' },
    h('caption', { class: 'sr-only' }, 'Runs, newest first'),
    h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, cols.map(c => h('th', { scope: 'col', role: 'columnheader' }, c || h('span', { class: 'sr-only' }, 'Actions'))))),
    h('tbody', { role: 'rowgroup' }, rows.map(runRow))));
}

const filtered = () => !!(filters.project || filters.pipeline || filters.status);

function clearFilters() {
  filters.project = filters.pipeline = filters.status = '';
  syncSelects();
  load({ reset: true });
  if (parts) parts.selects.project.focus();
}

// The empty card: no runs at all, or none for these filters.
function emptyCard() {
  if (filtered()) {
    return h('div', { class: 'empty' }, h('b', {}, 'No runs match these filters'),
      h('p', {}, h('button', { class: 'btn small mt-2', type: 'button', on: { click: clearFilters } }, 'Clear the filters')));
  }
  const project = profiledProjects().some(p => p.name === currentProject) ? currentProject : (profiledProjects()[0] || {}).name;
  return h('div', { class: 'empty' }, h('b', {}, 'No runs yet'), 'Try Explain: 3 minutes, read-only.',
    project
      ? h('p', {}, h('button', { class: 'btn small primary mt-2', type: 'button', on: { click: () => openLauncher('explain', { project }) } }, `Explain something in ${project}`))
      : h('p', { class: 'small mt-2' }, 'Runs need a project with a profile: set one up in its cockpit first.'));
}

function resultsCard() {
  const { rows, loaded, loading, more, error, missing } = list;
  const head = h('div', { class: 'card-head' },
    h('h3', {}, filters.project ? `Runs in ${filters.project}` : 'All runs'),
    h('span', { class: 'muted small' }, loading ? 'Loading…' : rows.length ? `${plural(rows.length, 'run')} shown · newest first` : ''));
  let body;
  if (missing) body = h('div', { class: 'card-body' }, h('p', { class: 'note info' }, 'The runs list is not available in this app yet.'));
  else if (!loaded) body = h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading…'));
  else if (!rows.length && !error) body = emptyCard();
  else body = rows.length ? table(rows) : null;
  const problem = error ? h('div', { class: 'card-body' }, h('p', { class: 'note red', role: 'alert' }, `Could not load the runs: ${error}`),
    h('button', { class: 'btn small mt-2', type: 'button', on: { click: () => load() } }, 'Try again')) : null;
  const foot = loaded && rows.length
    ? h('div', { class: 'card-foot runs-more' },
      more
        ? h('button', { class: 'btn small runs-more-btn', type: 'button', disabled: loading, on: { click: loadMore } }, loading ? 'Loading…' : 'Load more')
        : h('span', {}, rows.length >= MAX_ROWS ? `The first ${MAX_ROWS} runs are shown; narrow the filters to see older ones.` : `All ${plural(rows.length, 'run')} shown.`))
    : null;
  return h('div', { class: 'card runs-results' }, head, body, problem, foot);
}

// The choices of the three selects, from the state, the pipeline catalog and the rows loaded.
function selectOptions() {
  const projects = new Set((state && Array.isArray(state.projects) ? state.projects : []).map(p => p.name));
  for (const r of list.rows) if (r.project) projects.add(r.project);
  if (filters.project) projects.add(filters.project);
  const pipes = pipelines.list.map(p => [p.id, p.label]);
  for (const id of new Set([...list.rows.map(r => r.pipeline), filters.pipeline].filter(Boolean))) {
    if (!pipes.some(([pid]) => pid === id)) pipes.push([id, id]);
  }
  return {
    project: [['', 'All projects'], ...[...projects].sort().map(p => [p, p])],
    pipeline: [['', 'All pipelines'], ...pipes],
    status: [['', 'Any status'], ...Object.entries(STATUS_BADGES).map(([id, [label]]) => [id, label])],
  };
}

// Puts the choices into the selects (only when they changed, so an open select stays open).
function syncSelects() {
  if (!parts) return;
  const opts = selectOptions();
  for (const key of ['project', 'pipeline', 'status']) {
    const sel = parts.selects[key];
    const sig = JSON.stringify(opts[key]);
    if (sel.dataset.sig !== sig) {
      sel.replaceChildren(...opts[key].map(([value, label]) => h('option', { value }, label)));
      sel.dataset.sig = sig;
    }
    sel.value = filters[key];
  }
}

function buildParts() {
  const select = (key, label) => {
    const sel = h('select', {
      id: `runs-filter-${key}`, 'aria-label': `Filter by ${label.toLowerCase()}`,
      on: { change: () => { filters[key] = sel.value; load({ reset: true }); } },
    });
    return [sel, keyed(h('label', { class: 'runs-filter', for: `runs-filter-${key}` }, h('span', {}, label), sel), `filter-${key}`)];
  };
  const [project, projectLabel] = select('project', 'Project');
  const [pipeline, pipelineLabelEl] = select('pipeline', 'Pipeline');
  const [status, statusLabel] = select('status', 'Status');
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Runs'),
    h('p', {}, 'Every pipeline run, newest first. Open one to follow it live or to act on a gate.')));
  const bar = h('div', { class: 'runs-filters', role: 'group', 'aria-label': 'Filters' }, projectLabel, pipelineLabelEl, statusLabel,
    keyed(h('button', { class: 'btn small ghost', type: 'button', on: { click: clearFilters } }, 'Clear filters'), 'filter-clear'));
  const results = h('div', { class: 'runs-results-slot' });
  parts = { head, bar, results, selects: { project, pipeline, status } };
}

// Repaints the results card (and the select choices). The filter bar and the heading stay.
function paint() {
  if (!section) return;
  if (!parts || !section.contains(parts.head)) {
    buildParts();
    section.replaceChildren(parts.head, parts.bar, parts.results);
    lastSignature = '';
  }
  syncSelects();
  parts.bar.querySelector('.btn').hidden = !filtered();
  const signature = JSON.stringify([list, filters, pipelines.list.map(p => [p.id, p.label, (p.stages || []).map(s => [s.id, s.label])]),
    profiledProjects().map(p => p.name), currentProject]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  keepFocus(parts.results, () => parts.results.replaceChildren(resultsCard()));
}

function render(el) {
  section = el;
  paint();
}

function onShow({ sub }) {
  visible = true;
  // #runs/<project>: the list for that project (the cockpit's "All runs"). The filters are kept
  // between visits; the rows shown last stay on screen while they refresh.
  let reset = !list.loaded || !!list.error || list.missing;
  if (sub && sub !== filters.project) {
    Object.assign(filters, { project: sub, pipeline: '', status: '' });
    reset = true;
  }
  if (!pipelines.loaded) loadPipelines(currentProject);
  load({ reset });
  offSignal = onSignal(sig => refreshSoon(sig.tick ? 0 : SIGNAL_DEBOUNCE_MS));
  window.addEventListener('focus', onFocus);
}

function onHide() {
  visible = false;
  clearTimeout(debounce);
  if (offSignal) offSignal();
  offSignal = null;
  window.removeEventListener('focus', onFocus);
}

export default {
  id: 'runs',
  label: 'Runs',
  icon: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
  render,
  onShow,
  onHide,
};
