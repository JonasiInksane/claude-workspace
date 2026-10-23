// The project page's Findings tab (#project/<name>/findings, code projects): the audit board,
// moved from the cockpit's Audit progress card (SPEC 5.3) and shown full width. The phase bar, the
// four columns (parts/kanban.js), Import findings (a proposal you tick through, applied only with
// its hash, so a proposal that changed meanwhile is refused), Reconcile (moves findings along what
// git and the runs show), and the click on a card: Fix an open finding, accept or dismiss a
// proposed one, open its run, review its branch, or show its record.
//
// Data: GET /api/findings and the newest runs (project-data.js `findings` and `runs`), plus the
// waiting and running runs from the store for the board's run tags.
import { act, fmtTime, h, keepFocus, plural, toast } from '../../lib.js';
import { dialog, openDialog } from '../../dialog.js';
import { go, openLauncher } from '../../store.js';
import { bar } from '../../parts/bar.js';
import { kanban, recordText } from '../../parts/kanban.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, liveRunsOf, reload, slot, use } from '../../parts/project-data.js';
import { btn, closeButton, errorNote, loadingBody, post } from '../../parts/project-ui.js';
import { reviewBranch } from '../../parts/project-actions.js';

const memo = createMemo();
const STATUS_WORDS = { proposed: 'Proposed', open: 'Open', 'in-run': 'In run', 'on-branch': 'On branch', done: 'Done', dismissed: 'Dismissed' };
// A finding status in words; 'New' for one the board doesn't have yet.
export const statusWord = s => (s ? (Object.prototype.hasOwnProperty.call(STATUS_WORDS, s) ? STATUS_WORDS[s] : s) : 'New');

let current = { name: '', el: null }; // the panel this tab painted last, while it is on show

// Paints the board again at once (a column folded or unfolded), keeping the focus.
function repaint(name) {
  const { el } = current;
  if (el && current.name === name) keepFocus(el, () => render(el, { project: { name } }));
}

// ---------------------------------------------------------------- actions

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
      reload();
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

async function importFindings(name) {
  try {
    const r = await post('/api/findings/import', { project: name });
    importDialog(name, r.proposal);
    reload(); // the board now shows the waiting import too
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
      reload();
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
  if (await act(post('/api/findings/reconcile', { project: name }))) reload();
}

// ---------------------------------------------------------------- the card

const expanded = new Map(); // project -> Set of column ids that show every card

function auditCard(name, s) {
  const F = s.findings;
  const f = dataOf(F);
  const open = expanded.get(name) || new Set();
  const runRows = [...liveRunsOf(name), ...((dataOf(s.runs) || {}).runs || [])].map(r => [r.id, r.pipeline, r.status]);
  return memo(`audit:${name}`, [f, F && F.error, [...open], runRows], () => {
    const source = f && f.doc && f.doc.source ? f.doc.source : null;
    const when = source && (source.confirmedAt || source.importedAt);
    const head = h('div', { class: 'card-head' },
      h('h3', {}, 'Audit progress'),
      h('span', { class: 'muted small grow' }, when ? `Statuses come from the audit, records and git. Imported ${fmtTime(when)}.` : 'Statuses come from the audit, records and git.'),
      h('div', { class: 'row-actions' },
        btn('import', 'Import findings', () => importFindings(name)),
        btn('reconcile', 'Reconcile', () => reconcile(name), { title: 'Moves findings along what git and the runs show' })));
    if (!f) return h('div', { class: 'card audit' }, head, F && F.error ? h('div', { class: 'card-body' }, errorNote(F.error, 'findings')) : loadingBody());
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
    return h('div', { class: 'card audit' }, head, h('div', { class: 'card-body' }, body));
  });
}

// ---------------------------------------------------------------- the tab

let release = () => {};

function render(el, ctx) {
  const name = ctx.project.name;
  current = { name, el };
  patch(el, [auditCard(name, slot(name))]);
}

export default {
  id: 'findings',
  label: 'Findings',
  render,
  onShow(ctx) {
    release();
    release = use(ctx.project.name, ['findings', 'runs']);
  },
  onHide() {
    release();
    release = () => {};
    current = { name: '', el: null };
  },
};
