// Health and wins (#health/<project>). A stub until wave 3b (UI-COCKPIT) replaces this file:
// it names the project from the route and links back to its cockpit. The score, metric
// tiles, lenses, candidates and wins (GET /api/metrics) come in the next step.
import { h } from '../lib.js';
import { currentProject, go, state } from '../store.js';

function render(el, { sub }) {
  const name = sub || currentProject;
  const exists = !!name && (state.projects || []).some(p => p.name === name);
  el.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {},
      name ? h('p', { class: 'crumb' }, h('button', { class: 'link', type: 'button', on: { click: () => go('cockpit', name) } }, name), ' / Health') : null,
      h('h2', {}, 'Architecture health and wins'),
      h('p', {}, 'Built in the next step.'))),
    h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, exists ? `Health of ${name}` : name ? `No project named ${name}` : 'No project chosen yet'),
      'The health score, metric tiles, architecture lenses, new candidates and wins come in the next step.')));
}

export default {
  id: 'health',
  label: 'Health and wins',
  icon: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
  render,
};
