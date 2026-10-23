// The project page's Changes tab (#project/<name>/changes, code projects): where the work of the
// runs is. The runs of this project that wait at the review gate or the commit, each linking to
// its gate (#review/<id>), and the Branches and worktrees card moved from the cockpit (SPEC 5.3):
// the main checkout (yours; the app never switches branches there), the run worktree or branch
// mode, the app/ branches with Diff (a read-only Review run) and Archive (renamed under
// archive/, nothing is deleted), and other worktrees.
//
// Data: GET /api/project (git, isolation, lock, checklist) and the runs that wait
// (project-data.js `project` and `waiting`), plus the store's waiting runs, which arrive with the
// live updates first. The pure helpers (ageText, gateRuns) are exported for changes.test.mjs.
import { act, confirmDialog, fmtAgo, h, openPlace } from '../../lib.js';
import { atReviewGate, go } from '../../store.js';
import { badge, dot } from '../../parts/status.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, liveRunsOf, reload, slot, use } from '../../parts/project-data.js';
import { btn, cardHead, errorNote, loadingBody, minute, pipeLabel, post, short } from '../../parts/project-ui.js';
import { reviewBranch, setIsolation, setupWorktree } from '../../parts/project-actions.js';

const memo = createMemo();
const GATE_TEXT = { review: 'the review gate', commit: 'the commit' };

// ---------------------------------------------------------------- pure helpers (tested)

// "12 min", "5 h", "3 days": how long a lock has been held.
export function ageText(sec) {
  const s = Number(sec);
  if (sec === null || sec === undefined || !Number.isFinite(s) || s < 0) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}

// The runs of `name` that wait at the review gate or the commit, from the route's rows and the
// store's live ones, each once, newest first (run ids sort by time).
export function gateRuns(name, rows = [], live = []) {
  const seen = new Map();
  for (const r of [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(live) ? live : [])]) {
    if (r && typeof r.id === 'string' && r.project === name && r.status === 'waiting' && atReviewGate(r) && !seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// ---------------------------------------------------------------- actions

async function archive(name, branch) {
  const ok = await confirmDialog(`Archive ${branch}?`, 'It is renamed under archive/. Nothing is deleted: the branch and its commits stay.', 'Archive');
  if (ok && await act(post('/api/project/archive-branch', { project: name, branch }))) reload();
}

// ---------------------------------------------------------------- cards

function gatesCard(name, s) {
  const W = s.waiting;
  const rows = dataOf(W) ? dataOf(W).runs : null;
  const list = rows ? gateRuns(name, rows, liveRunsOf(name)) : null;
  return memo(`gates:${name}`, [list && list.map(r => [r.id, r.title, r.waiting, r.pipeline, r.at || r.createdAt]), W && W.error, minute()], () => {
    const head = cardHead('Waiting at the review gate', btn('gates:runs', 'All runs', () => go('runs', name), { cls: 'link' }));
    if (!list) return h('div', { class: 'card' }, head, W && W.error ? h('div', { class: 'card-body' }, errorNote(W.error, 'waiting')) : loadingBody());
    if (!list.length) {
      return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
        h('p', { class: 'muted' }, 'Nothing waits at the review gate. A run that changes code stops there before its commit.')));
    }
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      W.error ? errorNote(`Could not refresh: ${W.error}`, 'waiting') : null,
      h('ul', { class: 'list' }, list.map(r => h('li', {}, dot('waiting'),
        h('div', { class: 'main' },
          h('div', { class: 'title' }, btn(`gate:${r.id}`, r.title || r.id, () => go('review', r.id), { cls: 'link run-link', title: 'Opens the review gate' })),
          h('div', { class: 'sub' }, [pipeLabel(r.pipeline), `waits at ${GATE_TEXT[r.waiting] || 'the review gate'}`, r.branch || '', fmtAgo(r.at || r.createdAt)].filter(Boolean).join(' · '))),
        badge('waiting', r.waiting === 'commit' ? 'Commit' : 'Review gate'))))));
  });
}

function branchesCard(name, s) {
  const P = s.project;
  const d = dataOf(P);
  if (!d) {
    return memo(`branches:${name}`, ['loading', P && P.error], () => h('div', { class: 'card' }, cardHead('Branches and worktrees'),
      P && P.error ? h('div', { class: 'card-body' }, errorNote(P.error, 'project')) : loadingBody()));
  }
  const { git, isolation, lock, checklist } = d;
  const unmerged = (d.warnings || []).find(w => w && w.id === 'branches.unmerged');
  const wtItem = (checklist || []).find(x => x.id === 'worktree');
  return memo(`branches:${name}`, [git, isolation, lock, unmerged ? unmerged.text : '', wtItem, d.project.folder, P.error || '', minute()], () => {
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
      P.error ? errorNote(`Could not refresh: ${P.error}`, 'project') : null,
      h('ul', { class: 'list' }, items),
      more > 0 ? h('p', { class: 'muted small' }, `+ ${more} more app ${more === 1 ? 'branch' : 'branches'} not shown.`) : null,
      unmerged ? h('p', { class: 'note mt-2' }, unmerged.text) : null,
      git.archivedBranches ? h('p', { class: 'muted small mt-2' }, `${git.archivedBranches} archived ${git.archivedBranches === 1 ? 'branch' : 'branches'} under archive/.`) : null));
  });
}

// ---------------------------------------------------------------- the tab

const grids = new Map();
let release = () => {};

export default {
  id: 'changes',
  label: 'Changes',
  render(el, ctx) {
    const name = ctx.project.name;
    const s = slot(name);
    if (!grids.has(name)) grids.set(name, h('div', { class: 'cgrid ch-grid' }));
    patch(el, [patch(grids.get(name), [gatesCard(name, s), branchesCard(name, s)])]);
  },
  onShow(ctx) {
    release();
    release = use(ctx.project.name, ['waiting', 'project']);
  },
  onHide() { release(); release = () => {}; },
};
