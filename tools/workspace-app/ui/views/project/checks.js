// The project page's Checks tab (#project/<name>/checks, code projects), moved from the cockpit's
// Checks card (SPEC 5.3): the last result per level (Quick, Standard, Paranoid) with the numbers
// each check counted, Check my work (what and how careful, a preview of the commands, then Start),
// the baseline of known failures with "Accept new baseline" when a smaller one is waiting, and the
// last 20 checks. Checks are code, not Claude: no tokens.
//
// Counts: every number GET /api/checks gives for a check shows on its own, with its own word
// (new failures, pre-existing failures, flaky, and passed or skipped when a line has them); a
// skipped test or a pre-existing failure is never folded into passed or failed (checkCounts).
//
// Data: GET /api/checks and GET /api/project (project-data.js `checks` and `project`: the
// baseline, whether the checkout is here, and the last results when /api/checks has none).
// The pure helpers (checkResult, checkCounts, countsText) are exported for checks.test.mjs.
import { api, confirmDialog, fmtAgo, fmtDuration, h, plural, qs, toast } from '../../lib.js';
import { dialog, openDialog } from '../../dialog.js';
import { go } from '../../store.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, reload, slot, use } from '../../parts/project-data.js';
import { btn, cardHead, closeButton, errorNote, loadingBody, minute, post, resEl, short } from '../../parts/project-ui.js';

const memo = createMemo();
const LEVELS = ['quick', 'standard', 'paranoid'];
const LEVEL_LABELS = { quick: 'Quick', standard: 'Standard', paranoid: 'Paranoid' };
const WHAT_OPTIONS = [['uncommitted', 'My uncommitted changes'], ['branch', 'This branch vs base'], ['everything', 'Everything']];
const LEVEL_OPTIONS = [['quick', 'Quick'], ['standard', 'Standard'], ['paranoid', 'Paranoid']];
const HISTORY_SHOWN = 20;

// ---------------------------------------------------------------- pure helpers (tested)

// A check history line as the table shows it: { cls, text, icon }.
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

// The count keys a check line may carry, in the order they show, each with its own words.
const COUNTS = [
  ['pass', 'passed', 'passed'], ['passed', 'passed', 'passed'],
  ['fail', 'failed', 'failed'], ['failed', 'failed', 'failed'],
  ['new', 'new failure', 'new failures'],
  ['known', 'pre-existing failure', 'pre-existing failures'],
  ['flaky', 'flaky', 'flaky'],
  ['skip', 'skipped', 'skipped'], ['skipped', 'skipped', 'skipped'],
  ['todo', 'to do', 'to do'],
];

// The numbers of a history line ({ counts: { new, known, flaky, ... } }) as separate entries:
// [{ key, value, text }]. Only real numbers show; nothing is added up or folded into another.
export function checkCounts(line) {
  const c = line && line.counts && typeof line.counts === 'object' ? line.counts : {};
  const out = [];
  for (const [key, one, many] of COUNTS) {
    const v = c[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out.push({ key, value: v, text: `${v} ${v === 1 ? one : many}` });
  }
  return out;
}

// The same as one line of text: "0 new failures · 61 pre-existing failures · 1 flaky".
export const countsText = line => checkCounts(line).map(c => c.text).join(' · ');

// ---------------------------------------------------------------- Check my work and baselines

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
    reload();
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
      reload();
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

// ---------------------------------------------------------------- cards

// The numbers of one check as small separate badges (an empty cell says so in words).
function countsCell(line) {
  const list = checkCounts(line);
  if (!line) return h('span', { class: 'muted' }, '–');
  if (!list.length) return h('span', { class: 'muted small' }, 'no counts recorded');
  return h('span', { class: 'ck-counts' }, list.map(c => h('span', { class: `badge${c.key === 'new' && c.value ? ' red' : c.key === 'known' && c.value ? ' amber' : ''}` }, c.text)));
}

function resultCell(level, line) {
  const r = checkResult(line);
  return line && line.runId ? btn(`check:${level}:${line.runId}`, resEl(r), () => go('run', line.runId), { cls: 'link res-link', title: 'Open the check run' }) : resEl(r);
}

function checksCard(name, s) {
  const C = s.checks;
  const d = dataOf(s.project);
  const last = (dataOf(C) || {}).last || (d && d.checks && !d.checks.error ? d.checks : null);
  const base = d && d.baseline && !d.baseline.error ? d.baseline : null;
  const present = !!(d && d.project && d.project.present);
  return memo(`checks:${name}`, [last, C && C.error, base, present, !!d, minute()], () => {
    const why = d && !present ? 'Link the checkout first.' : '';
    const head = cardHead('Checks', btn('check', 'Check my work', () => checkDialog(name), { cls: 'btn small primary', disabled: !d || !present }));
    if (!last) return h('div', { class: 'card' }, head, C && C.error ? h('div', { class: 'card-body' }, errorNote(C.error, 'checks')) : loadingBody());
    const rows = LEVELS.map(level => {
      const line = last[level];
      return h('tr', {},
        h('td', {}, LEVEL_LABELS[level]),
        h('td', {}, resultCell(level, line)),
        h('td', {}, countsCell(line)),
        h('td', {}, line ? fmtAgo(line.at) : '–'),
        h('td', {}, line ? fmtDuration(line.durationMs) || '–' : '–'));
    });
    const c = base && base.candidate;
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      why ? h('p', { class: 'reason' }, why) : null,
      C && C.error ? errorNote(`Could not refresh: ${C.error}`, 'checks') : null,
      h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable ck-levels' },
        h('caption', { class: 'sr-only' }, 'The last check per level'),
        h('thead', {}, h('tr', {}, ['Level', 'Last result', 'Counts', 'When', 'Took'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows))),
      c && c.to !== null && c.from !== null && c.to < c.from ? h('p', { class: 'note mt-3' },
        'Smaller baseline available for ', h('code', {}, short(base.baseSha)), `: ${c.from} → ${c.to}. ${c.reason || ''} `,
        btn('baseline:accept', 'Accept new baseline', () => acceptBaseline(name, c.key || base.key), { cls: 'link' })) : null,
      h('p', { class: 'muted small mt-2' }, base && base.key
        ? `Baseline: ${plural(base.known ?? 0, 'known failure')} at ${short(base.baseSha)}, Node ${base.node || '?'}. Known failures are pre-existing: they show on their own and never turn a check red.`
        : 'No baseline yet. The first check in the run worktree makes one.')),
    h('div', { class: 'card-foot' }, btn('baseline:recompute', 'Check everything against the baseline…', () => recompute(name), { cls: 'link', disabled: !present })));
  });
}

// The last checks, newest first, each with its own numbers and a link to its run.
function historyCard(name, s) {
  const C = s.checks;
  const list = (dataOf(C) || {}).history;
  return memo(`history:${name}`, [list, minute()], () => {
    const head = cardHead('History', h('span', { class: 'muted small' }, `the last ${HISTORY_SHOWN} checks`));
    if (!Array.isArray(list)) return h('div', { class: 'card' }, head, C && C.error ? h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Not loaded.')) : loadingBody());
    if (!list.length) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'No checks yet. Check my work runs the first one.')));
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      h('ul', { class: 'list ck-history' }, list.slice(0, HISTORY_SHOWN).map((line, i) => h('li', {},
        h('div', { class: 'main' },
          h('div', { class: 'title' }, `${LEVEL_LABELS[line.level] || line.level || 'Check'} · `, resEl(checkResult(line))),
          h('div', { class: 'sub wrap' }, [countsText(line) || 'no counts recorded', fmtAgo(line.at), fmtDuration(line.durationMs),
            line.treeMode === 'run' ? 'run worktree' : line.treeMode === 'main' ? 'main checkout' : '', line.baseSha ? `base ${short(line.baseSha)}` : ''].filter(Boolean).join(' · '))),
        line.runId ? btn(`hist:${i}:${line.runId}`, 'Open', () => go('run', line.runId), { title: 'Open the check run' }) : null)))));
  });
}

// ---------------------------------------------------------------- the tab

let release = () => {};

export default {
  id: 'checks',
  label: 'Checks',
  render(el, ctx) {
    const name = ctx.project.name;
    const s = slot(name);
    patch(el, [checksCard(name, s), historyCard(name, s)]);
  },
  onShow(ctx) {
    release();
    release = use(ctx.project.name, ['checks', 'project']);
  },
  onHide() { release(); release = () => {}; },
};
