// Project cockpit (#cockpit/<project>). A stub until wave 3b (UI-COCKPIT) replaces this file:
// it names the project from the route, shows what GET /api/state knows about it (fields the
// server doesn't send yet show as "not known yet"), and offers the intent box, which opens the
// launcher. The checks, audit board, branches and recent runs come in the next step.
import { h } from '../lib.js';
import { countOf, currentProject, go, loadPipelines, pipelines, state } from '../store.js';
import { intentBox } from '../parts/intent.js';

// One intent box per project, kept across re-renders so typed text survives a refresh. It is
// built again once when the pipeline list arrives (for the quick row).
const boxes = new Map();

function intentFor(name) {
  const ready = pipelines.loaded && pipelines.project === name;
  const key = `${name}|${ready ? 'ready' : 'waiting'}`;
  if (!boxes.has(key)) {
    boxes.set(key, intentBox({
      label: `What do you want to do in ${name}?`,
      placeholder: 'Describe it in your own words',
      project: name,
      quick: ready ? pipelines.list.map(d => ({ pipeline: d.id, label: d.label, disabledReason: d.disabledReason })) : [],
    }));
  }
  return boxes.get(key);
}

function render(el, { sub }) {
  const name = sub || currentProject;
  const p = name ? (state.projects || []).find(x => x.name === name) : null;
  const head = h('div', { class: 'view-head' },
    h('div', {}, h('h2', {}, name || 'Project cockpit'),
      p && p.realPath ? h('p', { class: 'mono' }, p.realPath) : h('p', {}, 'Built in the next step.')),
    p ? h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', on: { click: () => go('health', name) } }, 'Health and wins'),
      h('button', { class: 'btn', type: 'button', on: { click: () => go('projects') } }, 'Projects')) : null);

  if (!p) {
    el.replaceChildren(head, h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, name ? `No project named ${name}` : 'No project chosen yet'),
      'A project with a private profile gets a cockpit in the nav. The full cockpit is built in the next step.')));
    return;
  }
  el.replaceChildren(head,
    intentFor(name),
    h('div', { class: 'card mt-4' },
      h('div', { class: 'card-head' }, h('h3', {}, 'What the app knows'), h('span', { class: 'muted small' }, 'from /api/state')),
      h('div', { class: 'card-body' }, h('dl', { class: 'facts' },
        h('dt', {}, 'Profile'), h('dd', {}, p.hasProfile === undefined ? 'not known yet' : p.hasProfile ? 'yes' : 'none yet'),
        h('dt', {}, 'Linked checkout'), h('dd', {}, p.linked === undefined ? 'not known yet' : p.linked ? 'yes' : 'no'),
        h('dt', {}, 'Waiting for you'), h('dd', {}, p.waiting === undefined ? 'not known yet' : String(countOf(p.waiting))),
        h('dt', {}, 'Running'), h('dd', {}, p.running === undefined ? 'not known yet' : String(countOf(p.running))))),
      h('div', { class: 'card-foot' }, 'Built in the next step: setup checklist, checks, audit board, branches and worktrees, recent runs.')));
}

export default {
  id: 'cockpit',
  label: 'Project cockpit',
  icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  render,
  // Loads the project's pipeline list for the intent box (a missing route just leaves it empty).
  onShow: ({ sub }) => { loadPipelines(sub || currentProject); },
};
