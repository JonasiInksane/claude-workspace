// The findings board on a project's Findings tab (SPEC 5.3; mockup .kanban): four
// columns, Open, In run, On branch and Done, from the `columns` of GET /api/findings. Every card
// is a button that says the finding's id, its title and "Severity · Phase · tag" in words, so the
// severity colour of its border is never the only sign (SPEC 5.11). What a click does depends on
// the column, and the view decides it through `onCard(finding, columnId, kind)`:
//   fix       an open finding: start Fix with it
//   proposed  a finding a run proposed: accept or dismiss it
//   run       a finding in a run: open that run
//   review    a finding on a branch: review the branch
//   record    a done finding: show its record and commit
// A long column shows its first few cards, then "+ N more, including ..." and a Show all toggle
// (aria-expanded) that the view keeps per column. `cardExtra(finding, columnId)` may add a control
// next to each card (the Findings tab's Ask button); card and control then share a .fcard-item.
//
// The helpers above kanban() are pure (no DOM), so ui/parts/kanban.test.mjs tests them.
import { h, keyed, plural, statusBadge } from '../lib.js';

export const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
// How many cards a column shows before "+ N more".
export const COLUMN_LIMIT = { open: 5, 'in-run': 4, 'on-branch': 4, done: 4 };
const PIPELINE_LABELS = { fix: 'Fix', refactor: 'Refactor', debug: 'Debug', feature: 'Feature', review: 'Review', check: 'Check', explain: 'Explain', architecture: 'Architecture' };

const short = sha => String(sha || '').slice(0, 7);

// The border class: done is green, critical and high red, medium amber, low muted.
export function severityClass(f, columnId) {
  if (columnId === 'done') return 'done';
  if (f.severity === 'critical' || f.severity === 'high') return 'high';
  if (f.severity === 'medium') return 'med';
  return 'low';
}

// What a click on the card does, and the words a screen reader hears for it.
export function cardAction(columnId, f) {
  if (columnId === 'open') return f.status === 'proposed' ? { kind: 'proposed', sr: 'proposed by a run: accept or dismiss' } : { kind: 'fix', sr: 'start a fix' };
  if (columnId === 'in-run') return f.runId ? { kind: 'run', sr: 'open the run' } : { kind: 'record', sr: 'no run is recorded' };
  if (columnId === 'on-branch') return { kind: 'review', sr: 'review the branch' };
  return { kind: 'record', sr: 'show the record and commit' };
}

// The card's third line: "High · Phase 1 · next up". `runs` maps run ids to index rows, for
// the in-run tag ("Refactor: Running").
export function cardMeta(f, columnId, { nextUpId = '', runs = new Map() } = {}) {
  let tag = '';
  if (columnId === 'open') {
    if (f.status === 'proposed') tag = 'proposed';
    else if (f.id === nextUpId) tag = 'next up';
    else if (f.ownerDecision) tag = 'owner decision';
    else tag = f.area || '';
  } else if (columnId === 'in-run') {
    const run = f.runId ? runs.get(f.runId) : null;
    tag = run ? `${PIPELINE_LABELS[run.pipeline] || run.pipeline}: ${statusBadge(run.status).label}` : 'in a run';
  } else if (columnId === 'on-branch') {
    tag = f.branch || 'on a branch';
  } else {
    tag = (f.commits && f.commits.length ? short(f.commits[0]) : '') || (f.records && f.records[0]) || '';
  }
  const phase = f.phase === null || f.phase === undefined || f.phase === '' ? '' : `Phase ${f.phase}`;
  return [SEVERITY_LABELS[f.severity] || f.severity || '', phase, tag].filter(Boolean).join(' · ');
}

// The cards a column shows and the ones it hides (all are shown when `expanded`).
export function splitColumn(items, limit, expanded = false) {
  const list = Array.isArray(items) ? items : [];
  if (expanded || list.length <= limit) return { shown: list, hidden: [] };
  return { shown: list.slice(0, limit), hidden: list.slice(limit) };
}

// "+ 6 more, including H29 and L-3", "+ 1 more: L-3", or '' when nothing is hidden.
export function moreText(hidden) {
  const ids = (hidden || []).map(f => f.id);
  if (!ids.length) return '';
  if (ids.length === 1) return `+ 1 more: ${ids[0]}`;
  return `+ ${ids.length} more, including ${ids[0]} and ${ids[1]}`;
}

// What a done card's toast says: its record and commit, as text.
export function recordText(f) {
  const parts = [];
  if (f.records && f.records.length) parts.push(`record ${f.records.join(', ')}`);
  if (f.commits && f.commits.length) parts.push(`commit ${f.commits.map(short).join(', ')}`);
  if (f.branch) parts.push(`branch ${f.branch}`);
  return parts.length ? `${f.id}: ${parts.join(' · ')}` : `${f.id} is ${f.status === 'done' ? 'done' : f.status}; no record or commit is recorded.`;
}

// ---------------------------------------------------------------- the board

function card(f, columnId, opts) {
  const action = cardAction(columnId, f);
  const button = keyed(h('button', {
    class: `fcard ${severityClass(f, columnId)}`, type: 'button',
    on: { click: () => opts.onCard(f, columnId, action.kind) },
  },
  h('b', {}, f.id), ' ', f.title || '',
  h('span', { class: 'sev' }, cardMeta(f, columnId, opts)),
  h('span', { class: 'sr-only' }, `: ${action.sr}`)), `f:${f.id}`);
  const extra = opts.cardExtra ? opts.cardExtra(f, columnId) : null;
  return extra ? h('div', { class: 'fcard-item' }, button, extra) : button;
}

function column(col, opts) {
  const limit = COLUMN_LIMIT[col.id] || 4;
  const expanded = opts.expanded.has(col.id);
  const { shown, hidden } = splitColumn(col.items, limit, expanded);
  const headId = `kanban-${col.id}`;
  const count = Number(col.count) || 0;
  return h('section', { class: 'col', 'aria-labelledby': headId },
    h('h4', { id: headId }, col.label,
      h('span', { 'aria-hidden': 'true' }, String(count)),
      h('span', { class: 'sr-only' }, `, ${plural(count, 'finding')}`)),
    shown.map(f => card(f, col.id, opts)),
    count ? null : h('p', { class: 'more' }, 'None'),
    hidden.length ? h('p', { class: 'more' }, moreText(hidden)) : null,
    (col.items || []).length > limit ? keyed(h('button', {
      class: 'link small more-toggle', type: 'button', 'aria-expanded': expanded ? 'true' : 'false',
      on: { click: () => opts.onToggle(col.id) },
    }, expanded ? 'Show fewer' : `Show all ${count}`), `col:${col.id}`) : null);
}

// kanban(columns, { nextUpId, runs, expanded, onCard, onToggle, cardExtra }) -> div.kanban.
//   columns   GET /api/findings columns: [{ id, label, count, items }]
//   nextUpId  the Next up finding's id (its card says "next up")
//   runs      Map of run id -> index row, for the In run tags
//   expanded  Set of column ids that show every card
//   cardExtra optional (finding, columnId) -> a node placed next to the card, or null
export function kanban(columns, { nextUpId = '', runs = new Map(), expanded = new Set(), onCard = () => {}, onToggle = () => {}, cardExtra = null } = {}) {
  const opts = { nextUpId, runs, expanded, onCard, onToggle, cardExtra };
  return h('div', { class: 'kanban' }, (columns || []).map(col => column(col, opts)));
}
