// The project page's Agents tab (#project/<name>/agents, asset and plain projects): the project's
// agents with what the Projects view offers for them (views/projects.js agentsSection): Start one
// isolated (its own memory and images), Edit its file, its Memory, its Images, + New agent, and
// the archived agents with Restore. Archive is in the Edit dialog, as in Projects.
//
// Data: the state only (state.projects[i].agents and archived). The card is rebuilt only when
// what it shows changed, so a refresh keeps the focus and the open Archived fold.
import { h } from '../../lib.js';
import { state } from '../../store.js';
import { createMemo, patch } from '../../parts/patch.js';
import { agentsSection } from '../projects.js';

const memo = createMemo();

// What the card shows of a project (and of the tools that decide whether Start works).
export const agentsDeps = p => [p.name, p.agents, p.archived, p.sharedImages, p.launchable, p.linked, p.realPath,
  !!(state && state.tools && state.tools.claude), state && state.tools ? state.tools.editor : ''];

function agentsCard(p) {
  return memo(`agents:${p.name}`, agentsDeps(p), () => h('div', { class: 'card project ag-card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Agents'),
      h('span', { class: 'muted small' }, 'Each agent keeps its own memory and images; only its own sessions can read them.')),
    h('div', { class: 'card-body' }, agentsSection(p))));
}

export default {
  id: 'agents',
  label: 'Agents',
  render(el, ctx) {
    patch(el, [agentsCard(ctx.project)]);
  },
};
