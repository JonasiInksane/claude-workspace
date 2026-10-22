// Tools: a button for every skill (starts Claude in a new terminal) and workspace tool (runs
// here and shows its output). The server builds every prompt and command (catalog.mjs).
// Exports skillDialog and skillById (the projects view's Onboard button uses them) and
// runCommand (the palette uses it with skillDialog).
import { act, api, h } from '../lib.js';
import { dialog, formDialog, openDialog } from '../dialog.js';
import { refresh, state } from '../store.js';

export const skillById = id => state.catalog.skills.find(s => s.id === id);
const startSkill = (id, values) => api('/api/skill', { method: 'POST', body: { id, values } });

function fieldControl(f, skill, preset) {
  if (f.kind === 'project') {
    const projects = state.projects.filter(p => skill.where !== 'project' || p.launchable);
    const el = h('select', { required: true }, projects.map(p => h('option', { value: p.name }, p.name)));
    if (preset.project) el.value = preset.project;
    return el;
  }
  if (f.kind === 'select') return h('select', {}, f.options.map(([value, label]) => h('option', { value }, label)));
  if (f.kind === 'date') return h('input', { type: 'date' });
  if (f.kind === 'textarea') return h('textarea', { required: !!f.required, maxlength: f.max || 200 });
  return h('input', { required: !!f.required, maxlength: f.max || 200, autocomplete: 'off' });
}

// No fields: start at once. Otherwise ask for them first. `preset` fills in a project.
export function skillDialog(skill, preset = {}) {
  if (!skill.fields.length) { act(startSkill(skill.id, {})); return; }
  const controls = skill.fields.map(f => [f.label, f.hint, fieldControl(f, skill, preset)]);
  formDialog(`${skill.label} (/${skill.id})`, skill.text, controls,
    skill.where === 'project' ? 'Start in the project' : 'Start in the hub',
    () => startSkill(skill.id, Object.fromEntries(skill.fields.map((f, i) => [f.key, controls[i][2].value]))));
}

// Runs a workspace tool and shows its output. The library shows a preview first, with a
// button that installs for real. Exported for the palette (parts/palette.js).
export async function runCommand(cmd, { preview = false, confirm = false } = {}) {
  const status = h('span', { class: 'badge' }, 'Running…');
  const pre = h('pre', { class: 'output' });
  const install = h('button', { class: 'btn primary', hidden: true, on: { click: () => runCommand(cmd, { confirm: true }) } }, 'Install now');
  openDialog(preview ? `${cmd.label}: preview` : cmd.label,
    h('div', {}, h('p', { class: 'target-path mono' }, preview ? `${cmd.command} --dry-run` : cmd.command), status, pre), {
      wide: true,
      actions: [install, h('button', { class: 'btn', on: { click: () => dialog.close() } }, 'Close')],
    });
  try {
    const r = await api('/api/command', { method: 'POST', body: { id: cmd.id, preview, confirm } });
    pre.textContent = r.output.trim() || '(no output)';
    status.textContent = r.status === 0 ? 'Finished' : `Exit code ${r.status}`;
    status.className = `badge ${r.status === 0 ? 'ok' : 'warn'}`;
    if (preview && r.status === 0) install.hidden = false;
  } catch (e) {
    status.textContent = 'Failed';
    status.className = 'badge warn';
    pre.textContent = e.message;
  }
  refresh();
}

function newProjectDialog() {
  const name = h('input', { required: true, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'my-app', autocomplete: 'off', spellcheck: 'false' });
  const type = h('select', {}, state.catalog.projectTypes.map(t => h('option', { value: t }, t === 'nextjs' ? 'Next.js' : 'Game')));
  const from = h('input', { placeholder: 'https://github.com/you/repo.git', autocomplete: 'off', spellcheck: 'false' });
  formDialog('New project', 'Runs tools/new-project.mjs in a terminal, so you can follow a clone.', [
    ['Name', 'Lowercase with dashes. It becomes projects/<name>.', name],
    ['Template', 'Copies templates/<type>/ into the project. Existing files are never overwritten.', type],
    ['Git URL', 'Optional: start from someone else\'s starter repo (the template files are added). For a repo of yours, use Projects › Repositories › Clone a repo.', from],
  ], 'Create', () => api('/api/projects', { method: 'POST', body: { name: name.value.trim(), type: type.value, from: from.value.trim() } }));
}

function toolRow(title, text, button) {
  return h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub wrap' }, text)), button);
}

function render(el) {
  const c = state.catalog;
  const skillRow = s => toolRow([s.label, ' ', h('code', {}, `/${s.id}`)], s.text, h('button', {
    class: 'btn small primary',
    disabled: !state.tools.claude || (s.fields.some(f => f.kind === 'project') && !state.projects.length),
    on: { click: () => skillDialog(s) },
  }, s.fields.length ? 'Start…' : 'Start'));
  const card = (title, rows, foot) => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, title)),
    h('div', { class: 'card-body' }, h('ul', { class: 'list' }, rows)),
    foot ? h('div', { class: 'card-foot' }, foot) : null);

  el.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Tools'),
      h('p', {}, 'Skills open Claude in a new terminal and run the command there. Workspace tools run here and show their output.'))),
    h('div', { class: 'grid2' },
      card('Hub skills', c.skills.filter(s => s.where === 'hub').map(skillRow),
        ['/write-handoff is not here: it sums up the session it runs in, so type it in that session.']),
      h('div', { class: 'stack' },
        card('Project skills', c.skills.filter(s => s.where === 'project').map(skillRow),
          ['Run /onboard-project first in a project without a CLAUDE.md.']),
        card('Workspace', [
          toolRow('New project', 'From the Next.js or game template, or cloned from a git URL.',
            h('button', { class: 'btn small', on: { click: newProjectDialog } }, 'New…')),
          ...c.commands.map(cmd => toolRow(cmd.label, cmd.text, h('button', {
            class: 'btn small', on: { click: () => runCommand(cmd, { preview: cmd.preview }) },
          }, cmd.preview ? 'Preview…' : 'Run'))),
        ]))),
  );
}

export default {
  id: 'tools',
  label: 'Tools',
  icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  render,
};
