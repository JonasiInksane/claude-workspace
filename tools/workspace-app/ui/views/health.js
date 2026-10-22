// Health and wins (#health/<project>, SPEC 5.4; mockup #v-health): what the code probes measured
// and what got better. The score row (number, trend, sparkline), the metric tiles (each with its
// trend in words, a sparkline named by a text summary, "What is this?", and Start a slice or a
// badge such as "Within allowlist"), the architecture lenses, the new candidates of the last
// architecture check (Make finding, Decide, Dismiss), and the wins: the phase boss, ratchet wins,
// the fun settings, achievements and this week's ship log. The header starts an architecture
// check (through the launcher) and rebuilds the allowlist (a preview first, then Save).
//
// Data: GET /api/metrics?project, which reads files and git only (no probe, no Claude). A probe
// that failed in the last scan shows "probe failed: <why>" on its own tile. Rendering and refresh
// work like the cockpit (views/cockpit.js): cards are cached by what they show and swapped one by
// one, controls carry data-keys, and the view refreshes every 10 s while a run is running, after
// a live signal for the project, on focus and after an action.
//
// The pure helpers (trendText, sparkLabel, changeView, verdictBadge, badgeClass, needsYou) are
// exported for the tests.
import { act, api, checkServer, fmtAgo, fmtTime, h, keepFocus, keyed, plural, qs, toast } from '../lib.js';
import { dialog, openDialog } from '../dialog.js';
import { go, openLauncher, saveSettings, settings, sub, view } from '../store.js';
import { bar } from '../parts/bar.js';
import { spark } from '../parts/sparkline.js';
import { createMemo, nameOf, patch, projectLabel, refresher } from './cockpit.js';

const TREND = { better: 'Better', same: 'Same', worse: 'Worse' };

// ---------------------------------------------------------------- pure helpers (tested)

// "Better", "Same" or "Worse"; '' for a tile without a value (no scan yet).
export const trendText = t => (t && t.value !== null && t.value !== undefined ? TREND[t.trend] || '' : '');

// The sparkline's name for screen readers: the tile's text summary plus the range it draws.
export function sparkLabel(t) {
  const s = Array.isArray(t.spark) ? t.spark : [];
  const what = t.id === 'knownFailures' ? 'check' : 'scan';
  const range = s.length ? ` Last ${plural(s.length, what)}: ${s[0]} to ${s[s.length - 1]}.` : '';
  return `${t.label}: ${t.summary || t.display || 'no value'}.${range}`;
}

// A lens row's change cell: { cls, text }. Lenses count problems, so up is a warning.
export function changeView(lens) {
  if (lens.error) return { cls: 'muted', text: '' };
  if (typeof lens.delta === 'number' && lens.delta > 0) return { cls: 'res warn', text: `${lens.change} new` };
  if (typeof lens.delta === 'number' && lens.delta < 0) return { cls: 'res pass', text: lens.change };
  return { cls: 'muted', text: lens.change || '' };
}

// A candidate's triage verdict as a badge: Issue, You decide, Noise, or Not triaged.
export function verdictBadge(verdict) {
  if (verdict === 'issue') return { text: 'Issue', cls: 'red' };
  if (verdict === 'owner-decision') return { text: 'You decide', cls: 'amber' };
  if (verdict === 'noise') return { text: 'Noise', cls: '' };
  return { text: 'Not triaged', cls: '' };
}

// The colour of a tile's badge; the badge text says the same in words.
export function badgeClass(text) {
  if (text === 'Within allowlist' || text === 'At goal') return 'ok';
  if (text === 'Probe failed' || /outside the allowlist/.test(String(text))) return 'red';
  return 'amber';
}

// How many candidates wait for a decision (an issue or "you decide" without one).
export const needsYou = items => (items || []).filter(c => (c.verdict === 'issue' || c.verdict === 'owner-decision') && !c.decision).length;

// ---------------------------------------------------------------- data

const slots = new Map(); // project -> { metrics: { data, error, status }, loading, again }

function slot(name) {
  if (!slots.has(name)) slots.set(name, { loading: false, again: false });
  return slots.get(name);
}

async function load(name) {
  if (!name) return;
  const s = slot(name);
  if (s.loading) { s.again = true; return; }
  s.loading = true;
  try {
    s.metrics = { data: await api(`/api/metrics?${qs({ project: name })}`) };
  } catch (e) {
    if (e.network) checkServer();
    s.metrics = { data: s.metrics && s.metrics.data, error: e.message, status: e.status };
  }
  s.loading = false;
  repaint(name);
  if (s.again) {
    s.again = false;
    load(name);
  }
}

let section = null;
const refresher_ = refresher(load);

function repaint(name) {
  if (!section || view !== 'health' || nameOf(sub) !== name) return;
  keepFocus(section, () => render(section, { sub }));
}

// ---------------------------------------------------------------- small builders

const memo = createMemo();
const post = (path, body) => api(path, { method: 'POST', body });
const closeButton = () => h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel');

function btn(key, label, onClick, { cls = 'btn small', disabled = false, describedBy = null, title = null } = {}) {
  return keyed(h('button', { class: cls, type: 'button', disabled, title, 'aria-describedby': describedBy, on: { click: onClick } }, label), key);
}

function errorNote(text, key) {
  return h('div', { class: 'note red' }, h('span', {}, text), ' ',
    keyed(h('button', { class: 'link', type: 'button', on: { click: () => refresher_.now() } }, 'Try again'), `retry:${key}`));
}

const cardHead = (title, ...extra) => h('div', { class: 'card-head' }, h('h3', {}, title), extra.filter(Boolean).length ? h('div', { class: 'row-actions' }, extra) : null);

// ---------------------------------------------------------------- actions

// Rebuild allowlist: the proposal from the last scan (what it adds and removes), then Save with
// that scan's id, so a newer scan in between is refused (409).
async function rebuildDialog(name) {
  let p;
  try { p = (await post('/api/allowlist', { project: name, preview: true })).proposal; } catch (e) { toast(e.message, true); return; }
  const error = h('div', { class: 'form-error', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'button', on: { click: () => send() } }, 'Save allowlist');
  async function send() {
    save.disabled = true;
    try {
      const r = await post('/api/allowlist', { project: name, scanId: p.scanId });
      dialog.close();
      toast(r.message || 'Saved.');
      refresher_.now();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      save.disabled = false;
    }
  }
  const list = (title, ids) => [h('h4', { class: 'ck-sub' }, `${title} (${ids.length})`),
    ids.length ? h('ul', { class: 'ck-ids mono' }, ids.map(id => h('li', {}, id))) : h('p', { class: 'muted small' }, 'None.')];
  openDialog('Rebuild the allowlist', h('div', { class: 'vgrid' },
    h('p', {}, `From scan ${p.scanId}${p.sha ? ` at ${String(p.sha).slice(0, 7)}` : ''}: the allowlist would hold ${plural((p.list || []).length, 'procedure')}.`),
    list('Added', p.add || []),
    list('Removed', p.remove || []),
    h('p', { class: 'muted small' }, 'After saving, a procedure the allowlist does not hold fails the checks until you rebuild it again.'),
    error), { actions: [closeButton(), save] });
}

async function makeFinding(name, c, item) {
  if (await act(post('/api/findings/propose', { project: name, runId: c.runId, ref: item.ref }))) refresher_.now();
}

// Decide (a "you decide" candidate): accept it as an issue, keep it for later, or dismiss it
// with a reason. Saved on the architecture run through POST /api/runs/triage.
function decideDialog(name, c, item, { dismissOnly = false } = {}) {
  const group = `decide-${item.ref}`;
  const choices = dismissOnly ? [['dismiss', 'Dismiss it']] : [
    ['accept', 'It is an issue: accept it (Make finding then puts it on the board)'],
    ['keep', 'Keep it for later'],
    ['dismiss', 'It is intended or noise: dismiss it'],
  ];
  const radios = choices.map(([value, label], i) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: group, value, checked: dismissOnly || i === 0 }), label));
  const reason = h('input', { type: 'text', maxlength: 300, value: dismissOnly ? item.reason || '' : '', placeholder: 'e.g. intended: staff may do this' });
  const error = h('div', { class: 'form-error', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'button', on: { click: () => send() } }, dismissOnly ? 'Dismiss' : 'Save');
  async function send() {
    const picked = radios.map(l => l.querySelector('input')).find(r => r.checked);
    const decision = picked ? picked.value : 'keep';
    if (decision === 'dismiss' && !reason.value.trim()) {
      error.textContent = 'Say why you dismiss it first.';
      error.hidden = false;
      reason.focus();
      return;
    }
    save.disabled = true;
    try {
      const r = await post('/api/runs/triage', { id: c.runId, decisions: [{ ref: item.ref, decision, reason: reason.value.trim() }] });
      dialog.close();
      toast(r.message || 'Saved.');
      refresher_.now();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      save.disabled = false;
    }
  }
  openDialog(`${dismissOnly ? 'Dismiss' : 'Decide on'} ${item.ref}: ${item.label}`, h('div', { class: 'form' },
    h('p', { class: 'mono' }, `${item.path}${item.line ? `:${item.line}` : ''}`),
    item.text ? h('p', { class: 'mono muted small' }, item.text) : null,
    item.reason ? h('p', { class: 'muted' }, `Triage: ${item.reason}`) : null,
    dismissOnly ? null : h('fieldset', { class: 'hl-choices' }, h('legend', {}, 'Your decision'), radios),
    h('label', {}, dismissOnly ? 'Reason' : 'Reason (needed to dismiss)', reason),
    error), { actions: [closeButton(), save] });
  (dismissOnly ? reason : radios[0].querySelector('input')).focus();
}

async function saveFun(key, value, label) {
  try {
    await saveSettings({ fun: { [key]: value } });
    toast(`${label} ${value ? 'on' : 'off'}.`);
    if (key === 'streak') refresher_.now();
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- cards

// Persistent containers (the tiles, the card grids) per project, patched child by child.
const blocks = new Map();
function block(key, cls, nodes) {
  if (!blocks.has(key)) blocks.set(key, h('div', { class: cls }));
  return patch(blocks.get(key), nodes);
}

function header(name, m) {
  const label = projectLabel(name);
  const latest = m && m.latest;
  const c = m && m.candidates && !m.candidates.error ? m.candidates : null;
  return memo(`head:${name}`, [label, latest ? latest.at : null, c ? [c.at, c.status, c.waiting] : null, !!m], () => {
    const parts = ['From code probes and git. No tokens.'];
    if (m) parts.push(latest ? `Last scan ${fmtTime(latest.at)}.` : 'No scan yet.');
    if (c && c.at) parts.push(`Last architecture check ${fmtTime(c.at)}${c.status === 'waiting' ? ', waiting for your decisions' : ''}.`);
    return h('div', { class: 'view-head' },
      h('div', {},
        h('p', { class: 'crumb' }, btn('crumb', label, () => go('cockpit', name), { cls: 'link' }), ' / Health'),
        h('h2', {}, 'Architecture health and wins'),
        h('p', {}, parts.join(' '))),
      h('div', { class: 'row-actions' },
        btn('rebuild', 'Rebuild allowlist…', () => rebuildDialog(name), { cls: 'btn', disabled: !latest, describedBy: latest ? null : 'hl-rebuild-why' }),
        latest ? null : h('span', { class: 'reason', id: 'hl-rebuild-why' }, 'Needs a scan first.'),
        btn('arch', 'Run architecture check', () => openLauncher('architecture', { project: name }), { cls: 'btn primary' })));
  });
}

function scoreRow(name, m) {
  const score = m.score || {};
  return memo(`score:${name}`, [score, !!m.latest], () => {
    if (!m.latest && (score.value === null || score.value === undefined)) {
      return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No scan yet'),
        'Run architecture check (free, 1-3 min). It measures the tiles below with code probes and sets the score.',
        h('div', { class: 'mt-4' }, btn('arch:empty', 'Run architecture check', () => openLauncher('architecture', { project: name }), { cls: 'btn primary' }))));
    }
    const delta = Number(score.delta) || 0;
    const trend = delta > 0 ? `+${delta} this week` : delta < 0 ? `−${Math.abs(delta)} this week` : 'no change this week';
    const series = Array.isArray(score.spark) ? score.spark : [];
    return h('div', { class: 'card score-row' },
      h('div', {}, h('div', { class: 'muted small' }, 'Health score'),
        h('div', { class: 'big' }, score.value === null || score.value === undefined ? '—' : String(score.value), ' ', h('span', { class: `trend ${score.trend || 'same'}` }, trend))),
      h('div', { class: 'grow' }, spark(series, `Health score, last ${plural(series.length, 'scan')}${series.length ? `: ${series[0]} to ${series[series.length - 1]}` : ''}`)),
      h('p', { class: 'muted small measure' }, 'A 0–100 summary of the tiles below, weighted by the project profile. It only moves when a probe number moves.'));
  });
}

function tile(name, t) {
  return memo(`tile:${name}:${t.id}`, [t], () => {
    const n = Array.isArray(t.spark) ? t.spark.length : 0;
    const failed = t.badge === 'Probe failed';
    let foot = null;
    if (t.action) {
      foot = btn(`slice:${t.id}`, 'Start a slice', () => openLauncher(t.action.pipeline, { what: t.action.what, findingId: t.action.finding || '', project: name }),
        { title: t.action.what });
    } else if (t.badge) foot = h('span', { class: `badge ${badgeClass(t.badge)}` }, t.badge);
    return h('div', { class: `tile ${t.value === null || t.value === undefined ? 'same' : t.trend}`, role: 'group', 'aria-label': t.label },
      h('div', { class: 't-top' }, h('span', {}, t.label), h('span', { class: `trend ${t.trend}` }, trendText(t))),
      h('div', { class: 'v' }, t.display),
      spark(t.spark, sparkLabel(t)),
      t.note ? h('p', { class: failed ? 'note red small' : 'muted small' }, t.note) : null,
      t.measures ? h('details', {}, keyed(h('summary', {}, 'What is this?'), `what:${t.id}`), h('p', {}, t.measures)) : null,
      h('div', { class: 't-foot' }, h('span', { class: 'muted small' }, n ? `last ${plural(n, t.id === 'knownFailures' ? 'check' : 'scan')}` : 'no data yet'), foot));
  });
}

function tilesBlock(name, m) {
  const list = m.tiles || [];
  if (!list.length) {
    return memo(`tiles:${name}:none`, [], () => h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No tiles'),
      'The project profile lists no tiles (or there is no valid profile yet).')));
  }
  return block(`tiles:${name}`, 'tiles', list.map(t => tile(name, t)));
}

function allowlistNote(name, m) {
  const al = m.allowlist;
  if (!al || al.error || !al.proposal) return null;
  return memo(`allow:${name}`, [al], () => {
    const p = al.proposal;
    const text = al.setUp
      ? `The last scan differs from the saved allowlist: ${(p.add || []).length} to add, ${(p.remove || []).length} to remove.`
      : 'No allowlist yet. Rebuild it from the last scan to set it up.';
    return h('p', { class: 'note info mt-3 hl-allow' }, `${text} `, btn('rebuild:note', 'Rebuild allowlist…', () => rebuildDialog(name), { cls: 'link' }));
  });
}

function lensesCard(name, m) {
  return memo(`lenses:${name}`, [m.lenses], () => {
    const rows = m.lenses || [];
    return h('div', { class: 'card' }, cardHead('Architecture lenses', h('span', { class: 'muted small' }, 'compared with the scan before')),
      h('div', { class: 'card-body' }, rows.length ? h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable' },
        h('thead', {}, h('tr', {}, ['Lens', 'Now', 'Change'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows.map(l => {
          const ch = changeView(l);
          return h('tr', {},
            h('td', {}, l.label, l.error ? h('div', { class: 'note red small' }, `probe failed: ${l.error}`) : null),
            h('td', {}, l.now === null || l.now === undefined ? '—' : String(l.now)),
            h('td', {}, h('span', { class: ch.cls }, ch.text)));
        })))) : h('p', { class: 'muted' }, 'The profile lists no lenses.')));
  });
}

function candidatesCard(name, m) {
  const c = m.candidates;
  return memo(`cand:${name}`, [c], () => {
    const n = c && !c.error ? needsYou(c.items) : 0;
    const head = cardHead('New candidates',
      n ? h('span', { class: 'badge amber' }, `${n} need${n === 1 ? 's' : ''} you`) : null,
      c && c.runId ? btn('cand:open', 'Open the check', () => go('run', c.runId), { cls: 'link' }) : null);
    if (!c) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'No architecture check yet. Its new candidates show here.')));
    if (c.error) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, errorNote(c.error, 'candidates')));
    const items = c.items || [];
    if (!items.length) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'No new candidates in the last check.')));
    const open = c.status === 'waiting' && ['triage', 'decide'].includes(c.waiting);
    const closedId = `hl-closed-${name}`;
    const DECISION = { accept: 'Accepted', dismiss: 'Dismissed', keep: 'Kept' };
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      h('ul', { class: 'list hl-cand' }, items.map(item => {
        const v = verdictBadge(item.verdict);
        const d = item.decision;
        const where = `${item.path}${item.line ? `:${item.line}` : ''}`;
        const actions = [];
        if (item.verdict === 'issue' || item.verdict === 'owner-decision') {
          actions.push(btn(`cand:make:${item.ref}`, 'Make finding', () => makeFinding(name, c, item)));
        }
        if (!d && item.verdict === 'owner-decision') {
          actions.push(btn(`cand:decide:${item.ref}`, 'Decide', () => decideDialog(name, c, item), { disabled: !open, describedBy: open ? null : closedId }));
        }
        if (!d && (item.verdict === 'noise' || !item.verdict)) {
          actions.push(btn(`cand:dismiss:${item.ref}`, 'Dismiss', () => decideDialog(name, c, item, { dismissOnly: true }), { disabled: !open, describedBy: open ? null : closedId }));
        }
        return h('li', {},
          h('span', { class: `badge${v.cls ? ` ${v.cls}` : ''}` }, v.text),
          h('div', { class: 'main' },
            h('div', { class: 'title' }, item.label || item.probe),
            h('div', { class: 'sub wrap mono' }, where),
            item.reason ? h('div', { class: 'sub wrap' }, `Triage: ${item.reason}`) : null,
            d ? h('div', { class: 'sub wrap' }, h('span', { class: 'badge ok' }, DECISION[d.decision] || d.decision), d.reason ? ` ${d.reason}` : '') : null),
          actions.length ? h('div', { class: 'row-actions' }, actions) : null);
      })),
      open ? null : h('p', { class: 'reason', id: closedId }, 'Decide and Dismiss are off: the check no longer waits for decisions.')));
  });
}

function bossCard(name, m) {
  const b = m.boss || {};
  return memo(`boss:${name}`, [b], () => {
    const label = b.phase ? `Phase ${b.phase} boss` : 'Phase boss';
    const tag = !b.total ? null : b.defeated ? h('span', { class: 'badge ok' }, 'Defeated') : h('span', { class: 'badge red' }, b.text);
    const ids = b.ids || [];
    return h('div', { class: 'card' }, cardHead(label, tag),
      h('div', { class: 'card-body boss' },
        b.total ? bar(b.pct, 'red', `${b.hp} of ${b.total} hit points left`) : null,
        h('p', { class: 'small muted' }, b.total
          ? `Each open High or Critical finding in Phase ${b.phase}${b.label ? ` (${b.label})` : ''} is 1 HP${ids.length ? `: ${ids.join(', ')}` : ''}. A committed fix knocks one off. At zero it becomes a trophy and the next phase appears.`
          : 'No high or critical findings in this phase.'),
        (b.trophies || []).length ? h('p', { class: 'small' }, h('b', {}, 'Trophies: '), b.trophies.map(t => `Phase ${t.phase}${t.label ? ` (${t.label})` : ''}`).join(', ')) : null));
  });
}

function winsCard(name, m) {
  return memo(`wins:${name}`, [m.wins, Math.floor(Date.now() / 60_000)], () => {
    const wins = m.wins || [];
    return h('div', { class: 'card' }, cardHead('Ratchet wins'),
      h('div', { class: 'card-body' }, wins.length ? h('ul', { class: 'list' }, wins.map(w => h('li', {}, h('div', { class: 'main' },
        h('div', { class: 'title wrap' }, w.text),
        h('div', { class: 'sub' }, fmtAgo(w.at)))))) : h('p', { class: 'muted' }, 'No ratchet wins yet. When a metric gets better in a scan, it shows here.')));
  });
}

function settingsCard(name, m) {
  const fun = settings.fun || {};
  const st = m.streak || {};
  return memo(`fun:${name}`, [fun, st], () => {
    // short: the name the toast uses ("Streak on.")
    const box = (key, label, short, on) => {
      const input = keyed(h('input', { type: 'checkbox', checked: !!on, on: { change: e => saveFun(key, e.target.checked, short) } }), `fun:${key}`);
      return h('label', { class: 'check' }, input, label);
    };
    return h('div', { class: 'card' }, cardHead('Settings'),
      h('div', { class: 'card-body vgrid' },
        box('celebration', 'Quiet celebration on a fully green commit', 'Quiet celebration', fun.celebration !== false),
        box('streak', 'Streak (off by default)', 'Streak', !!fun.streak),
        h('p', { class: 'muted small' }, 'The streak counts days with a reviewed, committed slice. Days off freeze it instead of breaking it. Starting runs does not count.'),
        st.error ? h('p', { class: 'note red small' }, st.error) : st.enabled ? h('p', { class: 'small' }, st.text) : null));
  });
}

function achievementsCard(name, m) {
  return memo(`ach:${name}`, [m.achievements], () => {
    const list = m.achievements || [];
    return h('div', { class: 'card' }, cardHead('Achievements', h('span', { class: 'muted small' }, 'tied to real wins only')),
      h('div', { class: 'card-body' }, list.length ? h('ul', { class: 'ach' }, list.map(a => h('li', { class: a.earned ? 'got' : null },
        h('b', {}, a.label), h('span', {}, a.text)))) : h('p', { class: 'muted' }, 'The project profile lists no achievements.')));
  });
}

function weekCard(name, m) {
  return memo(`week:${name}`, [m.weekly, Math.floor(Date.now() / 60_000)], () => {
    const w = m.weekly;
    let body;
    if (w && w.error) body = errorNote(w.error, 'weekly');
    else if (!Array.isArray(w) || !w.length) body = h('p', { class: 'muted' }, 'Nothing shipped with a record in the last 7 days.');
    else {
      body = h('ul', { class: 'list' }, w.map(e => h('li', {}, h('div', { class: 'main' },
        h('div', { class: 'title wrap' }, e.subject || e.short),
        h('div', { class: 'sub wrap' }, h('code', {}, e.short), (e.records || []).length ? ` · ${e.records.join(', ')}` : '', ` · ${fmtAgo(e.at)}`)))));
    }
    return h('div', { class: 'card' }, cardHead('This week', h('span', { class: 'muted small' }, 'commits with a record on the base branch')), h('div', { class: 'card-body' }, body));
  });
}

// ---------------------------------------------------------------- the view

function render(el, ctx) {
  section = el;
  const name = nameOf(ctx.sub);
  if (!name) {
    patch(el, [memo('none', [], () => h('div', {},
      h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Architecture health and wins'))),
      h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No project chosen yet'), 'Open a project\'s cockpit first.'))))]);
    return;
  }
  const s = slot(name);
  const M = s.metrics;
  const m = M && M.data;
  const head = header(name, m);
  if (!m) {
    patch(el, [head, memo(`wait:${name}`, [M ? M.error : null, M ? M.status : null], () => h('div', { class: 'card' }, h('div', { class: 'card-body' },
      !M ? h('p', { class: 'muted' }, 'Loading…')
        : M.status === 404 ? h('div', { class: 'empty' }, h('b', {}, `No project named ${name}`), M.error)
          : errorNote(M.error, 'metrics'))))]);
    return;
  }
  patch(el, [
    head,
    M.error ? memo(`stale:${name}`, [M.error], () => errorNote(`Could not refresh: ${M.error}`, 'metrics')) : null,
    scoreRow(name, m),
    memo('sec:metrics', [], () => h('h3', { class: 'sec' }, 'Metrics')),
    tilesBlock(name, m),
    allowlistNote(name, m),
    block(`g1:${name}`, 'grid2 mt-4', [lensesCard(name, m), candidatesCard(name, m)]),
    memo('sec:wins', [], () => h('h3', { class: 'sec' }, 'Wins')),
    block(`g2:${name}`, 'grid3', [bossCard(name, m), winsCard(name, m), settingsCard(name, m)]),
    block(`g3:${name}`, 'grid2 mt-4', [achievementsCard(name, m), weekCard(name, m)]),
  ]);
}

export default {
  id: 'health',
  label: 'Health and wins',
  icon: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
  render,
  onShow: ({ sub: subPath }) => {
    const name = nameOf(subPath);
    if (name) refresher_.start(name);
  },
  onHide: () => refresher_.stop(),
};
