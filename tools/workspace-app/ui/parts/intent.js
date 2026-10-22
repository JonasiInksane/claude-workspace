// The intent box (mockup form.intent): "What do you want to do?" in your own words. While you
// type, a line under the field says which pipeline the text goes to ("Opens Refactor in
// <project>: edits in a worktree after you approve a plan."), using the server's routing rules
// from GET /api/pipelines (store.routeIntent). Continue opens the launcher for that pipeline
// with the text prefilled; nothing runs from here. Try chips fill the field; the optional
// quick row starts a pipeline directly, and a disabled one says why in visible text.
//
// The route line is described-by text for the field, not a live region: the page's only live
// region is for "waiting for you" changes (SPEC 5.11).
import { h } from '../lib.js';
import { currentProject, loadPipelines, openLauncher, pipelineDef, pipelines, routeIntent } from '../store.js';

let boxes = 0;

const HINT = 'The app picks a pipeline and shows exactly what it will do before anything runs.';

// intentBox({ label, placeholder, chips, quick, project }) -> <form>.
//   chips: [{ label, text }] (or plain strings): "Try" buttons that fill the field.
//   quick: [{ pipeline, label?, disabledReason? }] (or pipeline ids): direct start buttons.
//   project: the project the run is for; the current project when empty.
export function intentBox({ label = 'What do you want to do?', placeholder = '', chips = [], quick = [], project = '' } = {}) {
  const id = `intent-${++boxes}`;
  const projectName = () => project || currentProject;
  const input = h('input', { id, type: 'text', autocomplete: 'off', placeholder, maxlength: 2000, 'aria-describedby': `${id}-route` });
  const route = h('p', { class: 'route', id: `${id}-route` }, HINT);

  function update() {
    const text = input.value.trim();
    input.removeAttribute('aria-invalid');
    if (!text) { route.replaceChildren(HINT); return; }
    const pick = routeIntent(text);
    const def = pipelineDef(pick.pipeline);
    const where = projectName();
    route.replaceChildren('Opens ', h('b', {}, def ? def.label : pick.pipeline), where ? ` in ${where}` : '',
      def && def.blurb ? `: ${def.blurb}.` : '.');
  }
  input.addEventListener('input', update);

  function submit(e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      route.replaceChildren('Type what you want first.');
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    const pick = routeIntent(text);
    openLauncher(pick.pipeline, { what: text, findingId: pick.findingId, project: projectName() });
  }

  const chipList = (chips || []).map(c => (typeof c === 'string' ? { label: c, text: c } : c)).filter(c => c && c.label);
  const quickList = (quick || []).map(q => (typeof q === 'string' ? { pipeline: q } : q)).filter(q => q && q.pipeline);
  const quickButtons = [];
  const reasons = new Map(); // reason text -> id of its visible line
  for (const q of quickList) {
    let describedBy = null;
    if (q.disabledReason) {
      if (!reasons.has(q.disabledReason)) reasons.set(q.disabledReason, `${id}-why-${reasons.size + 1}`);
      describedBy = reasons.get(q.disabledReason);
    }
    const button = h('button', {
      class: 'btn small', type: 'button', disabled: !!q.disabledReason, 'aria-describedby': describedBy,
      dataset: { pipeline: q.pipeline, fixedLabel: q.label ? '1' : '' },
      on: { click: () => openLauncher(q.pipeline, { what: input.value.trim(), project: projectName() }) },
    }, q.label || (pipelineDef(q.pipeline) || {}).label || q.pipeline);
    quickButtons.push(button);
  }

  const form = h('form', { class: 'card intent', novalidate: '', on: { submit } },
    h('label', { class: 'intent-label', for: id }, label),
    h('div', { class: 'intent-row' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Continue')),
    route,
    chipList.length ? h('div', { class: 'chips' }, h('span', { class: 'muted' }, 'Try'),
      chipList.map(c => h('button', {
        class: 'chip', type: 'button',
        on: { click: () => { input.value = c.text || c.label; update(); input.focus(); } },
      }, c.label))) : null,
    quickButtons.length ? h('div', { class: 'quick' }, h('span', { class: 'muted' }, 'Or start directly:'), quickButtons) : null,
    reasons.size ? [...reasons].map(([text, rid]) => h('p', { class: 'reason small muted', id: rid }, text)) : null);

  // The routing rules and labels come from the server; until they are loaded every text goes
  // to Explain. When they arrive, the line and the quick labels are brought up to date.
  if (!pipelines.loaded || pipelines.project !== projectName()) {
    loadPipelines(projectName()).then(() => {
      update();
      for (const b of quickButtons) {
        const def = pipelineDef(b.dataset.pipeline);
        if (def && !b.dataset.fixedLabel) b.textContent = def.label;
      }
    });
  }
  return form;
}
