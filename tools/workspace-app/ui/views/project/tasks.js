// The project page's Tasks tab (#project/<name>/tasks, code projects): the project's runs grouped
// into tasks. A task is a root run plus every run started from it (run.parent, at any depth, for
// example the slices that "Start next slice" made). Tasks show newest first, by their latest run;
// each shows its root run's title, pipeline, status and when, then the runs below it in the order
// they were made. Every row links to its run (#run/<id>). No new store: the runs index is enough.
//
// Data: GET /api/runs?project (project-data.js `tasks`, the newest TASK_LIMIT runs). A run whose
// parent is older than that shows as a task of its own, marked "continues an earlier run".
// The pure helper groupTasks is exported for tasks.test.mjs.
import { fmtAgo, fmtDuration, h, plural } from '../../lib.js';
import { go } from '../../store.js';
import { badge, dot } from '../../parts/status.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, slot, TASK_LIMIT, use } from '../../parts/project-data.js';
import { btn, cardHead, errorNote, loadingBody, minute, pipeLabel } from '../../parts/project-ui.js';

const memo = createMemo();
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); // run ids sort by time

// ---------------------------------------------------------------- pure helpers (tested)

// Index rows -> [{ root, runs, latest, continues }]. `root` is a run without a parent among the
// rows, `runs` the ones below it (oldest first), `latest` the newest run id in the task, and
// `continues` true when the root's own parent is not among the rows. A parent loop can't hang it:
// following parents stops at the first run seen twice.
export function groupTasks(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r.id === 'string' && r.id);
  const byId = new Map(list.map(r => [r.id, r]));
  const rootOf = r => {
    const seen = new Set();
    let cur = r;
    while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent);
    }
    return cur;
  };
  const tasks = new Map();
  for (const r of list) {
    const root = rootOf(r);
    if (!tasks.has(root.id)) tasks.set(root.id, { root, runs: [] });
    if (r !== root) tasks.get(root.id).runs.push(r);
  }
  return [...tasks.values()].map(t => {
    const runs = [...t.runs].sort(byIdAsc);
    const latest = [t.root, ...runs].reduce((m, r) => (r.id > m ? r.id : m), '');
    return { root: t.root, runs, latest, continues: !!t.root.parent && !byId.has(t.root.parent) };
  }).sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}

// "4 min ago", or "running 3 m 10 s" while it runs.
function whenText(r) {
  if (r.status === 'running') return `running ${fmtDuration(r.durationMs) || ''}`.trim();
  return fmtAgo(r.endedAt || r.createdAt);
}

// ---------------------------------------------------------------- the card

function runRow(r, { child = false } = {}) {
  return h('div', { class: `task-row${child ? ' child' : ''}` }, dot(r.status),
    h('div', { class: 'main' },
      h('div', { class: 'title' }, btn(`task:${r.id}`, r.title || r.id, () => go('run', r.id), { cls: 'link run-link', title: r.id })),
      h('div', { class: 'sub' }, [pipeLabel(r.pipeline), whenText(r), r.branch || ''].filter(Boolean).join(' · '))),
    badge(r.status));
}

function tasksCard(name, s) {
  const T = s.tasks;
  const rows = (dataOf(T) || {}).runs;
  return memo(`tasks:${name}`, [rows, T && T.error, minute()], () => {
    const head = cardHead('Tasks', btn('tasks:runs', 'All runs', () => go('runs', name), { cls: 'link', title: 'The Runs list, filtered to this project' }));
    if (!Array.isArray(rows)) return h('div', { class: 'card' }, head, T && T.error ? h('div', { class: 'card-body' }, errorNote(T.error, 'tasks')) : loadingBody());
    const tasks = groupTasks(rows);
    if (!tasks.length) {
      return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('div', { class: 'empty' },
        h('b', {}, 'No tasks yet'), 'A task starts with a run: describe what you want on the Overview tab.')));
    }
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body' },
      T.error ? errorNote(`Could not refresh: ${T.error}`, 'tasks') : null,
      h('p', { class: 'muted small' }, `${plural(tasks.length, 'task')} from ${plural(rows.length, 'run')}, newest first.`),
      h('ul', { class: 'tasks' }, tasks.map(t => h('li', { class: 'task' },
        runRow(t.root),
        t.continues ? h('p', { class: 'muted small task-note' }, 'Continues an earlier run that is not in this list.') : null,
        t.runs.length ? h('ul', { class: 'task-runs', 'aria-label': `Runs started from ${t.root.title || t.root.id}` },
          t.runs.map(r => h('li', {}, runRow(r, { child: true })))) : null))),
      rows.length >= TASK_LIMIT ? h('p', { class: 'note info mt-3' }, `Only the newest ${TASK_LIMIT} runs are grouped here. `,
        btn('tasks:older', 'See older runs in Runs', () => go('runs', name), { cls: 'link' })) : null));
  });
}

// ---------------------------------------------------------------- the tab

let release = () => {};

export default {
  id: 'tasks',
  label: 'Tasks',
  render(el, ctx) {
    const name = ctx.project.name;
    patch(el, [tasksCard(name, slot(name))]);
  },
  onShow(ctx) {
    release();
    release = use(ctx.project.name, ['tasks']);
  },
  onHide() { release(); release = () => {}; },
};
