// Launcher (#launcher/<pipeline>, for store.currentProject). A stub until wave 3b
// (UI-LAUNCHER) replaces this file: it shows the pipeline from the route, the project, and
// the text the intent box or the palette handed over (store.launchDraft), plus what the
// pipeline list (GET /api/pipelines) says about it. Starting a run comes in the next step.
import { h } from '../lib.js';
import { currentProject, go, launchDraft, loadPipelines, pipelineDef, pipelines } from '../store.js';

const PIPELINE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function render(el, { sub }) {
  const id = PIPELINE_RE.test(sub) ? sub : '';
  const draft = launchDraft && launchDraft.pipeline === id ? launchDraft : null;
  const project = (draft && draft.project) || currentProject;
  const def = id ? pipelineDef(id) : null;
  const facts = [
    ['Pipeline', def ? def.label : id || 'none chosen'],
    ['Project', project || 'none chosen yet'],
    ['Request', draft && draft.what ? draft.what : 'empty'],
    draft && draft.findingId ? ['Finding', draft.findingId] : null,
  ].filter(Boolean);
  el.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {},
      project ? h('p', { class: 'crumb' }, h('button', { class: 'link', type: 'button', on: { click: () => go('cockpit', project) } }, project), ' / New run') : null,
      h('h2', {}, def ? def.label : 'New run'),
      h('p', {}, def && def.ask ? def.ask : 'Built in the next step.'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        def && def.blurb ? h('p', { class: 'muted mt-3' }, `This pipeline: ${def.blurb}.`) : null,
        def && def.disabledReason ? h('p', { class: 'note mt-3' }, def.disabledReason) : null,
        !pipelines.loaded ? h('p', { class: 'note info mt-3' }, 'The pipeline list is not available yet, so nothing more is known about this pipeline.') : null,
        pipelines.loaded && id && !def ? h('p', { class: 'note mt-3' }, `There is no pipeline called ${id}.`) : null),
      h('div', { class: 'card-foot' }, 'Built in the next step: options, the exact first prompt, what the run will and cannot do, and Start run.')));
}

export default {
  id: 'launcher',
  label: 'New run',
  icon: '<path d="M12 5v14M5 12h14"/>',
  render,
  // The pipeline list for the draft's project (a missing route leaves it empty).
  onShow: () => { loadPipelines((launchDraft && launchDraft.project) || currentProject); },
};
