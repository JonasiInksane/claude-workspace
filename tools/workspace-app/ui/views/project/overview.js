// The project page's Overview tab (#project/<name>/overview), the first tab of every type.
//
// Code projects (moved from the cockpit, SPEC 5.3): the facts bar (branch, changes, upstream,
// stashes, trust, lock, Node, warning chips and the "Setup N/4" checklist), notes for a missing or
// broken profile and a lock held for days, the intent box with the quick row of the eight
// pipelines, the five most recent runs, a short Health card (the Architecture tab has the rest) and
// Run <project> (the profile's dev commands, in a terminal tab).
//
// Other projects: what the project is (its type, CLAUDE.md, listed in projects/repos.json or not,
// linked or not, branch and changes when it is a git repo, its agents and assets) and how to start
// work there (Claude in the project, Continue, Onboard when there is no CLAUDE.md, its agents).
//
// Data: GET /api/project (project-data.js `project`), plus `runs` and `metrics` for code projects;
// the rest comes from the state. Cards are memoised by what they show and patched in place, so a
// refresh keeps the focus, an open <details> and the text typed into the intent box.
//
// The pure helpers (factsBadges, quickRow, aboutFacts) are exported for overview.test.mjs.
import { act, fmtAgo, fmtDuration, h, launch, plural } from '../../lib.js';
import { atReviewGate, go, goProject, openLauncher, pipelines, state } from '../../store.js';
import { intentBox } from '../../parts/intent.js';
import { spark } from '../../parts/sparkline.js';
import { badge, dot } from '../../parts/status.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, liveRunsOf, slot, use } from '../../parts/project-data.js';
import { badgeEl, btn, cardHead, DATA_NAME_RE, errorNote, loadingBody, minute, pipeLabel, post, short, startProblem } from '../../parts/project-ui.js';
import { checklistAction, park } from '../../parts/project-actions.js';
import { skillById, skillDialog } from '../tools.js';

// The quick row of the intent box, in the mockup's order.
export const QUICK = ['fix', 'refactor', 'debug', 'feature', 'review', 'architecture', 'explain', 'check'];
const RECENT = 5;
const AGENT_STARTS = 4;
const TREND_TEXT = { better: 'Better', same: 'Same', worse: 'Worse' };
const RUN_ORDER = { waiting: 0, running: 1 };

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

// What an asset or plain project is, as [label, text] rows. `p` is its /api/state entry, `d` the
// answer of GET /api/project (null while it loads), `askable` false when its name can't be asked
// about, `error` why that answer failed, `listed` whether projects/repos.json lists the project,
// and `assets` its asset count (null: no asset pipeline).
export function aboutFacts(p, { d = null, askable = true, error = '', listed = false, assets = null } = {}) {
  const rows = [['Type', `${(p.type && p.type.label) || 'Project'}${p.label && p.label !== 'Other' ? ` · ${p.label}` : ''}`]];
  rows.push(['CLAUDE.md', p.hasClaudeMd ? 'Present: Claude reads it in every session here' : 'Missing: Onboard maps the repo and writes one']);
  rows.push(['Repository list', listed ? 'Listed in projects/repos.json, so your other PCs can clone it' : 'Not listed in projects/repos.json: another PC won\'t get it']);
  rows.push(['Folder', !p.linked ? `projects/${p.name}` : p.realPath ? `Linked: ${p.realPath}` : 'Link broken: its folder is gone']);
  let git;
  if (!askable) git = 'Not read for this folder name (the app reads git for lowercase names only)';
  else if (!d && error) git = `Could not be read: ${error}`;
  else if (!d) git = 'Loading…';
  else if (!d.git) git = 'Not read: the folder is not here';
  else if (d.git.error) git = 'Not a git repository (or git could not read it)';
  else {
    const g = d.git;
    const where = g.detached ? `detached at ${short(g.sha)}` : g.branch || 'no branch';
    git = `${where} · ${g.changed ? `${g.changed} changed` : 'clean'}${g.upstream ? ` · ${g.ahead || g.behind ? [g.ahead ? `${g.ahead} ahead` : '', g.behind ? `${g.behind} behind` : ''].filter(Boolean).join(', ') : 'even'} with ${g.upstream}` : ''}`;
  }
  rows.push(['Git', git]);
  const agents = Array.isArray(p.agents) ? p.agents.length : 0;
  const archived = Array.isArray(p.archived) ? p.archived.length : 0;
  rows.push(['Agents', `${agents ? plural(agents, 'agent') : 'No agents yet'}${archived ? `, ${archived} archived` : ''}`]);
  if (assets !== null) rows.push(['Assets', assets ? plural(assets, 'asset') : 'No assets yet']);
  return rows;
}

// ---------------------------------------------------------------- code projects

const memo = createMemo();

// The "Setup N/4" checklist in the facts bar. Open by default while something is to do; your own
// open or close is kept across refreshes.
const setupOpen = new Map();
function setupDetails(name, list) {
  const done = list.filter(x => x.ok).length;
  const all = done === list.length;
  const open = setupOpen.has(name) ? setupOpen.get(name) : !all;
  const det = h('details', { class: 'setup', open },
    h('summary', { class: all ? 'all' : 'todo', dataset: { key: 'setup' } }, `Setup ${done}/${list.length}`,
      h('span', { class: 'sr-only' }, all ? ', all done' : `, ${list.length - done} to do`)),
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
        btn('profile-init', 'Create from the example', () => checklistAction(name, { kind: 'profile-init' }), { cls: 'btn small primary' })));
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
  input.dataset.key = `intent:${name}`;
  for (const b of el.querySelectorAll('.quick button')) b.dataset.key = `quick:${b.dataset.pipeline}`;
  const old = hit ? hit.el.querySelector('input') : null;
  if (old && old.value) {
    input.value = old.value;
    input.dispatchEvent(new Event('input'));
  }
  boxes.set(name, { sig, el });
  return el;
}

// The newest runs plus the project's waiting and running ones from the store, so those show even
// when they are older: waiting first, then running, then the rest by recency; at most RECENT.
function recentRuns(name, recent) {
  if (!recent) return null;
  const out = [...recent];
  for (const r of liveRunsOf(name)) if (!out.some(x => x.id === r.id)) out.push(r);
  return out.map((r, i) => [r, i]).sort((a, b) => (RUN_ORDER[a[0].status] ?? 2) - (RUN_ORDER[b[0].status] ?? 2) || a[1] - b[1])
    .map(([r]) => r).slice(0, RECENT);
}

function runsCard(name, s) {
  const R = s.runs;
  const list = recentRuns(name, (dataOf(R) || {}).runs);
  return memo(`runs:${name}`, [list, R && R.error, minute(), pipelines.list.length], () => {
    const head = cardHead('Recent runs', btn('runs:tasks', 'All tasks', () => goProject(name, 'tasks'), { cls: 'link' }));
    if (!list) return h('div', { class: 'card' }, head, R && R.error ? h('div', { class: 'card-body' }, errorNote(R.error, 'runs')) : loadingBody());
    if (!list.length) {
      return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('div', { class: 'empty' },
        h('b', {}, 'No runs yet'), 'Try Explain: 3 minutes, read-only.',
        h('div', { class: 'mt-3' }, btn('runs:explain', 'Explain', () => openLauncher('explain', { project: name }), { cls: 'btn small primary' })))));
    }
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      R.error ? errorNote(`Could not refresh: ${R.error}`, 'runs') : null,
      h('ul', { class: 'list' }, list.map(r => {
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

// Health: the score and a short list of the tiles; the Architecture tab has everything.
function healthCard(name, s) {
  const M = s.metrics;
  const m = dataOf(M);
  const tiles = m ? (m.tiles || []).map(t => [t.id, t.label, t.display, t.trend, t.badge]) : null;
  return memo(`health:${name}`, [m && m.score, tiles, m && m.latest ? m.latest.id : null, M && M.error], () => {
    const head = cardHead('Health', btn('health', 'Architecture', () => goProject(name, 'architecture'), { cls: 'link' }));
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

// The grid of cards per project, patched card by card.
const grids = new Map();
function grid(name, s, d) {
  if (!grids.has(name)) grids.set(name, h('div', { class: 'cgrid' }));
  return patch(grids.get(name), [runsCard(name, s), healthCard(name, s), d ? runTgCard(name, d) : null]);
}

function renderCode(el, name) {
  const s = slot(name);
  const P = s.project;
  const d = dataOf(P);
  patch(el, [
    !d && P && P.error ? memo(`err:${name}`, [P.error], () => h('div', { class: 'card ov-error' }, h('div', { class: 'card-body' }, errorNote(P.error, 'project')))) : null,
    d ? factsBar(name, d) : null,
    d ? notes(name, d) : null,
    intent(name, d),
    grid(name, s, d),
  ]);
}

// ---------------------------------------------------------------- asset and plain projects

function aboutCard(p) {
  const askable = DATA_NAME_RE.test(p.name);
  const P = slot(p.name).project;
  const d = askable ? dataOf(P) : null;
  const error = askable && P && P.error ? P.error : '';
  const listed = !!(state.repos && Array.isArray(state.repos.list) && state.repos.list.some(r => r && r.name === p.name));
  const entry = (state.assets || []).find(a => a && a.project === p.name);
  const facts = aboutFacts(p, { d, askable, error, listed, assets: entry ? (entry.assets || []).length : null });
  return memo(`about:${p.name}`, [facts, error], () => h('div', { class: 'card' },
    cardHead('About this project'),
    h('div', { class: 'card-body' },
      error && d ? errorNote(`Could not refresh: ${error}`, 'project') : null,
      h('dl', { class: 'facts ov-facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])))));
}

function startCard(p) {
  const problem = startProblem(p, state.tools);
  const agents = (p.agents || []).filter(a => a.valid && a.isolated && !a.duplicate);
  const deps = [p.name, problem, p.hasClaudeMd, agents.map(a => a.name), (p.agents || []).length, (p.tabs || []).includes('agents')];
  return memo(`start:${p.name}`, deps, () => {
    // An id may not hold spaces, and a folder name may.
    const why = problem ? `ov-start-why-${p.name.replace(/[^A-Za-z0-9_-]/g, '_')}` : null;
    const actions = [
      btn('ov:start', 'Start Claude here', () => launch({ kind: 'project', project: p.name }), { cls: 'btn primary', disabled: !!problem, describedBy: why }),
      btn('ov:continue', 'Continue last session', () => launch({ kind: 'project', project: p.name, continueLast: true }), { cls: 'btn', disabled: !!problem, describedBy: why }),
      p.hasClaudeMd ? null : btn('ov:onboard', 'Onboard…', () => skillDialog(skillById('onboard-project'), { project: p.name }),
        { cls: 'btn', disabled: !!problem || !skillById('onboard-project'), describedBy: why, title: 'Runs /onboard-project there: maps the repo and writes its CLAUDE.md' }),
    ];
    const agentButtons = agents.slice(0, AGENT_STARTS).map(a => btn(`ov:agent:${a.name}`, `Start ${a.name}`,
      () => launch({ kind: 'agent', project: p.name, agent: a.name }), { disabled: !!problem, describedBy: why, title: 'Opens a terminal with only this agent\'s memory and images' }));
    const toAgents = (p.tabs || []).includes('agents') ? () => goProject(p.name, 'agents') : () => go('projects');
    return h('div', { class: 'card' },
      cardHead('Start work here'),
      h('div', { class: 'card-body vgrid' },
        h('div', { class: 'row-actions' }, actions),
        problem ? h('p', { class: 'reason', id: why }, problem) : null,
        h('div', { class: 'section-label' }, h('span', {}, 'Agents'),
          btn('ov:agents', (p.agents || []).length ? 'All agents' : 'Add an agent', toAgents, { cls: 'link' })),
        agentButtons.length ? h('div', { class: 'row-actions' }, agentButtons)
          : h('p', { class: 'muted small' }, (p.agents || []).length ? 'No agent can start yet: each needs "memory: project" and a usable name.' : 'No agents yet. An agent keeps its own memory and images.')));
  });
}

const otherGrids = new Map();
function renderOther(el, p) {
  if (!otherGrids.has(p.name)) otherGrids.set(p.name, h('div', { class: 'grid2 ov-grid' }));
  patch(el, [patch(otherGrids.get(p.name), [aboutCard(p), startCard(p)])]);
}

// ---------------------------------------------------------------- the tab

const isCode = p => !!(p && p.type && p.type.id === 'code');
let release = () => {};

export default {
  id: 'overview',
  label: 'Overview',
  render(el, ctx) {
    if (isCode(ctx.project)) renderCode(el, ctx.project.name);
    else renderOther(el, ctx.project);
  },
  onShow(ctx) {
    release();
    const p = ctx.project;
    if (isCode(p)) release = use(p.name, ['project', 'runs', 'metrics']);
    else release = DATA_NAME_RE.test(p.name) ? use(p.name, ['project']) : () => {};
  },
  onHide() { release(); release = () => {}; },
};
