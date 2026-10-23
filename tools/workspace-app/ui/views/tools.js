// Library (#library; the view file keeps its old name, tools.js): a button for every skill (starts
// Claude in a new terminal) and workspace tool (runs here and shows its output), the pipeline
// catalog, and this PC's app settings. The server builds every prompt and command (catalog.mjs).
//
// Skills open a dialog with their fields and "How the session starts": permission mode, model and
// effort, preset to the skill's catalog defaults. The choice goes to POST /api/skill as `launch`
// and the server checks it again (bypassPermissions and dontAsk stay refused there).
//
// Pipelines (GET /api/pipelines through store.loadPipelines, for the current project): per
// pipeline its stages with who runs each (Code, Claude or You), what a Claude stage may do (its
// profile text) and its caps, then "It cannot" and the limits. Read-only apart from the model and
// effort of each Claude stage, which are saved on this PC as settings.models["<pipeline>.<stage>"]
// (POST /api/settings). "Default" removes the choice, so the profile or the catalog decides again.
//
// Settings: single-key shortcuts (SPEC 5.11, WCAG 2.1.4) and the notification default (5.12).
//
// The view repaints only when what it shows changed, so a live-update refresh never closes an
// open select or folds a pipeline. Exports skillDialog and skillById (the projects view's Onboard
// button uses them) and runCommand (the palette uses it with skillDialog).
import { act, api, h, keepFocus, keyed, plural, toast } from '../lib.js';
import { dialog, formDialog, openDialog } from '../dialog.js';
import { currentProject, loadPipelines, pipelines, refresh, requestNotifyPermission, saveSettings, settings, state } from '../store.js';

export const skillById = id => state.catalog.skills.find(s => s.id === id);
const startSkill = (id, values, launch) => api('/api/skill', { method: 'POST', body: { id, values, launch } });

// ---------------------------------------------------------------- how a session starts

const MODES = [
  ['', 'Your default'], ['plan', 'Plan: reads and proposes, changes nothing'], ['acceptEdits', 'Accept edits: edits files without asking'],
  ['manual', 'Manual: asks before edits and commands'], ['auto', 'Auto'],
];
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// A <select> of [value, label] pairs with `value` chosen; a value that isn't listed (a full model
// name from a profile or a hand-edited file) is added, so it shows as it is.
function selectOf(options, value, props = {}) {
  const list = options.some(([v]) => v === value) ? options : [...options, [value, value]];
  const sel = h('select', props, list.map(([v, label]) => h('option', { value: v }, label)));
  sel.value = value;
  return sel;
}

// "plan mode · model opus · effort high", or '' when every value is the user's own default.
const launchText = l => [l.permissionMode && `${l.permissionMode} mode`, l.model && `model ${l.model}`, l.effort && `effort ${l.effort}`]
  .filter(Boolean).join(' · ');

// The "How the session starts" box of a skill dialog: { box, value() }.
function launchBox(defaults = {}) {
  const mode = selectOf(MODES, defaults.permissionMode || '');
  const model = selectOf([['', 'Your default'], ...MODELS.map(m => [m, m])], defaults.model || '');
  const effort = selectOf([['', 'Your default'], ...EFFORTS.map(e => [e, e])], defaults.effort || '');
  const value = () => ({ permissionMode: mode.value, model: model.value, effort: effort.value });
  const summary = h('span', { class: 'muted' });
  const update = () => { summary.textContent = ` (${launchText(value()) || 'your defaults'})`; };
  for (const sel of [mode, model, effort]) sel.addEventListener('change', update);
  update();
  const box = h('details', { class: 'launch skill-launch', open: !!launchText(value()) },
    h('summary', {}, 'How the session starts', summary),
    h('div', { class: 'two-col' },
      h('label', {}, 'Permission mode', h('small', {}, 'Plan suits work that should explore and propose first.'), mode),
      h('label', {}, 'Model', h('small', {}, 'An alias; your default when empty.'), model),
      h('label', {}, 'Effort', h('small', {}, 'How hard Claude thinks.'), effort)),
    h('p', { class: 'muted small-text' }, 'Preset to this skill\'s defaults. Changes apply to this start only.'));
  return { box, value };
}

// ---------------------------------------------------------------- skills and tools

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

// Asks for the skill's fields (if any) and how the session starts, then starts it. `preset`
// fills in a project. A skill without fields has Start focused, so Enter starts it.
export function skillDialog(skill, preset = {}) {
  const controls = skill.fields.map(f => [f.label, f.hint, fieldControl(f, skill, preset)]);
  const launch = launchBox(skill.launch);
  formDialog(`${skill.label} (/${skill.id})`, skill.text, [...controls, launch.box],
    skill.where === 'project' ? 'Start in the project' : 'Start in the hub',
    () => startSkill(skill.id, Object.fromEntries(skill.fields.map((f, i) => [f.key, controls[i][2].value])), launch.value()));
  if (!skill.fields.length) {
    const start = dialog.querySelector('button[type="submit"]');
    if (start) start.focus();
  }
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

function toolRow(title, text, button, key) {
  return keyed(h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub wrap' }, text)), button), key);
}

const card = (title, rows, foot, note = '') => h('div', { class: 'card' },
  h('div', { class: 'card-head' }, h('h3', {}, title)),
  h('div', { class: 'card-body' }, note ? h('p', { class: 'reason lib-reason' }, note) : null, h('ul', { class: 'list' }, rows)),
  foot ? h('div', { class: 'card-foot' }, foot) : null);

function skillCards() {
  const c = state.catalog;
  const noClaude = !state.tools.claude;
  const skillRow = s => {
    const needsProject = s.fields.some(f => f.kind === 'project') && !state.projects.length;
    return toolRow([s.label, ' ', h('code', {}, `/${s.id}`)], s.text, h('button', {
      class: 'btn small primary', type: 'button', disabled: noClaude || needsProject, on: { click: () => skillDialog(s) },
    }, 'Start…'), `skill-${s.id}`);
  };
  const noClaudeText = noClaude ? 'Claude Code was not found on this PC, so skills can\'t start.' : '';
  const noProjects = !noClaude && !state.projects.length ? 'No projects yet, so project skills can\'t start.' : '';
  return h('div', { class: 'grid2' },
    card('Hub skills', c.skills.filter(s => s.where === 'hub').map(skillRow),
      ['/write-handoff is not here: it sums up the session it runs in, so type it in that session.'], noClaudeText),
    h('div', { class: 'stack' },
      card('Project skills', c.skills.filter(s => s.where === 'project').map(skillRow),
        ['Run /onboard-project first in a project without a CLAUDE.md.'], noClaudeText || noProjects),
      card('Workspace', [
        toolRow('New project', 'From the Next.js or game template, or cloned from a git URL.',
          h('button', { class: 'btn small', type: 'button', on: { click: newProjectDialog } }, 'New…'), 'tool-new-project'),
        ...c.commands.map(cmd => toolRow(cmd.label, cmd.text, h('button', {
          class: 'btn small', type: 'button', on: { click: () => runCommand(cmd, { preview: cmd.preview }) },
        }, cmd.preview ? 'Preview…' : 'Run'), `tool-${cmd.id}`)),
      ])));
}

// ---------------------------------------------------------------- pipelines

const WHO = { code: 'Code', claude: 'Claude', you: 'You' };
// When a stage with `when` runs (runs/catalog.mjs PREDICATES), in words.
const WHEN_TEXT = {
  verifyNeeded: 'Only at Paranoid or when the change touches a risky path.',
  deep: 'Only for a Deep review.',
  hasCandidates: 'Only when the scan finds new candidates.',
  needsDecision: 'Only when triage flags something for you.',
  pinnable: 'Only when the bug can be pinned with a test; otherwise the run ends with the diagnosis.',
  notChild: 'Skipped for the next slice of a feature (the spec is already approved).',
};
const SOURCE_TEXT = { catalog: 'catalog default', profile: 'from the project profile', settings: 'your choice on this PC' };

// Why a review or verify stage may run on a stronger model than the one chosen (catalog.mjs).
function raisedNote(pipelineId, stageId) {
  if (!['review', 'verify'].includes(stageId)) return '';
  if (pipelineId === 'review') return 'Quick reviews start from sonnet/high, Deep ones from opus/xhigh; a choice here applies to both.';
  if (pipelineId === 'fix') return 'Always raised to at least opus/xhigh in Fix a finding.';
  return 'Raised to at least opus/xhigh at Paranoid or when the change touches a risky path.';
}

let catalogState = 'idle'; // idle | loading | ready | missing | error
const openPipes = new Set(); // pipeline ids whose details are open (kept across repaints)

// Saves one model or effort choice (or removes it with ''), then reloads the catalog so the
// resolved values and their source show. The select stays enabled (and focused) meanwhile: the
// repaint puts the focus back on it by its data-key.
async function saveModel(key, field, value, what) {
  try {
    await saveSettings({ models: { [key]: { [field]: value || null } } });
    await loadPipelines(currentProject, { force: true });
    toast(value ? `Saved: ${what} uses ${field} ${value}.` : `Saved: ${what} uses the default ${field} again.`);
  } catch (e) {
    toast(e.message, true);
  }
  paint(true);
}

function modelControls(p, s) {
  const key = `${p.id}.${s.id}`;
  const chosen = (settings.models && settings.models[key]) || {};
  const what = `${p.label} · ${s.label}`;
  const control = (field, values) => {
    const current = chosen[field] || '';
    const fallback = current ? 'Default' : `Default (${s[field] || 'unknown'})`;
    const sel = selectOf([['', fallback], ...values.map(v => [v, v])], current, {
      'aria-label': `${field === 'model' ? 'Model' : 'Effort'} for ${what}`,
      on: { change: () => saveModel(key, field, sel.value, what) },
    });
    return keyed(h('label', { class: 'lib-pick' }, h('span', {}, field === 'model' ? 'Model' : 'Effort'), sel), `${key}.${field}`);
  };
  return h('div', { class: 'lib-models' }, control('model', MODELS), control('effort', EFFORTS),
    h('span', { class: 'muted small' }, `Now ${s.model || '?'}/${s.effort || '?'}: ${SOURCE_TEXT[s.modelSource] || 'default'}`));
}

function stageItem(p, s) {
  const isClaude = s.who === 'claude' && s.model;
  const caps = s.caps ? `${plural(s.caps.maxTurns, 'turn')}, ${s.caps.minutes} min` : '';
  const note = isClaude ? raisedNote(p.id, s.id) : '';
  return h('li', { class: 'lib-stage' },
    h('span', { class: `lib-who ${s.who || 'code'}` }, WHO[s.who] || s.who || 'Code'),
    h('div', { class: 'lib-stage-main' },
      h('div', {}, h('b', {}, s.label), s.goal ? h('small', {}, s.goal) : null),
      isClaude ? h('div', { class: 'lib-meta' }, h('span', { class: 'mono' }, s.profileText || s.profile || ''), caps ? h('span', {}, `Caps: ${caps}`) : null) : null,
      s.when ? h('div', { class: 'lib-meta' }, h('span', {}, WHEN_TEXT[s.when] || 'Only when needed.')) : null,
      isClaude ? modelControls(p, s) : null,
      note ? h('p', { class: 'muted small' }, note) : null));
}

function pipelineItem(p) {
  const claudeStages = p.stages.filter(s => s.who === 'claude').length;
  const box = h('details', { class: 'lib-pipe', open: openPipes.has(p.id) },
    h('summary', {},
      h('span', { class: 'lib-pipe-name' }, p.label),
      h('span', { class: 'muted lib-pipe-blurb' }, p.blurb || ''),
      h('span', { class: 'lib-pipe-tags' },
        h('span', { class: `badge${p.editing ? ' amber' : ''}` }, p.editing ? 'edits in the run worktree' : p.claude ? 'read-only' : 'code only'),
        h('span', { class: 'badge' }, claudeStages ? `${plural(claudeStages, 'Claude stage')}` : 'no Claude'),
        p.expected ? h('span', { class: 'muted small' }, p.expected) : null)),
    h('div', { class: 'lib-pipe-body' },
      h('div', {},
        h('h4', {}, 'This run will'),
        h('ol', { class: 'lib-stages' }, p.stages.map(s => stageItem(p, s)))),
      h('aside', { class: 'lib-pipe-side' },
        h('h4', {}, 'It cannot'),
        h('ul', { class: 'lib-cannot' }, (p.cannot || []).map(c => h('li', {}, c))),
        h('h4', {}, 'Limits'),
        h('dl', { class: 'facts' }, (p.caps || []).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        currentProject && p.disabledReason ? h('p', { class: 'note mt-3' }, `Can't start in ${currentProject} now: ${p.disabledReason}`) : null)));
  box.addEventListener('toggle', () => { if (box.open) openPipes.add(p.id); else openPipes.delete(p.id); });
  return keyed(box, `pipe-${p.id}`);
}

function pipelinesCard() {
  let body;
  if (catalogState === 'missing') body = h('p', { class: 'note info' }, 'The pipeline catalog is not available in this app yet.');
  else if (catalogState === 'error') body = h('p', { class: 'note red' }, `Could not load the pipelines: ${pipelines.error || 'unknown error'}`);
  else if (!pipelines.list.length) body = h('p', { class: 'muted' }, 'Loading…');
  else {
    body = [
      h('p', { class: 'muted small' }, 'What each run does, stage by stage. Read-only, except the model and effort of each Claude stage: ',
        'a choice there is saved on this PC and used by every project.',
        currentProject ? ` The values now shown are the ones a run in ${currentProject} would use.` : ''),
      h('div', { class: 'lib-pipes' }, pipelines.list.map(pipelineItem)),
    ];
  }
  return h('div', { class: 'card mt-4' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Pipelines'), h('span', { class: 'muted small' }, 'what the app\'s runs may and may not do')),
    h('div', { class: 'card-body' }, body));
}

// ---------------------------------------------------------------- settings

function permissionText() {
  if (typeof Notification === 'undefined') return 'This window has no system notifications, so a toast and the (n) in the title tell you.';
  if (Notification.permission === 'granted') return 'System notifications are allowed.';
  if (Notification.permission === 'denied') return 'System notifications are blocked for this app, so a toast and the (n) in the title tell you.';
  return 'System notifications: not asked yet. Turning this on asks once.';
}

// Saves one on/off setting; on an error the box flips back. The repaint keeps the focus on it.
async function saveSwitch(patch, text, box) {
  try {
    await saveSettings(patch);
    toast(text);
  } catch (e) {
    box.checked = !box.checked;
    toast(e.message, true);
  }
  paint(true);
}

function settingsCard() {
  const single = h('input', { type: 'checkbox', checked: settings.shortcuts.singleKey !== false, 'aria-describedby': 'lib-single-help' });
  single.addEventListener('change', () => saveSwitch({ shortcuts: { singleKey: single.checked } },
    single.checked ? 'Single-key shortcuts are on.' : 'Single-key shortcuts are off.', single));
  const notify = h('input', { type: 'checkbox', checked: settings.notify.web !== false, 'aria-describedby': 'lib-notify-help' });
  notify.addEventListener('change', () => {
    if (notify.checked) requestNotifyPermission(); // asked on a click only, and only once (A20)
    saveSwitch({ notify: { web: notify.checked } }, notify.checked ? 'You will be told when a run needs you.' : 'Run notifications are off.', notify);
  });
  return h('div', { class: 'card mt-4' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Settings'), h('span', { class: 'muted small' }, 'saved on this PC')),
    h('div', { class: 'card-body lib-settings' },
      keyed(h('div', { class: 'lib-setting' },
        h('label', { class: 'check' }, single, h('b', {}, 'Single-key shortcuts')),
        h('p', { class: 'muted small', id: 'lib-single-help' },
          'T, F, C, j, k and Space act only while the focus is inside their panel (the live run or the review gate). ',
          'Turn this off if you use speech input or press keys by accident.')), 'set-single'),
      keyed(h('div', { class: 'lib-setting' },
        h('label', { class: 'check' }, notify, h('b', {}, 'Tell me when a run needs me')),
        h('p', { class: 'muted small', id: 'lib-notify-help' },
          'The default for every run; a run can turn it off for itself. ', permissionText())), 'set-notify')),
    h('div', { class: 'card-foot' }, 'Keys everywhere: ', h('kbd', {}, 'Ctrl K'), ' opens the palette; ',
      h('kbd', {}, 'g'), ' then ', h('kbd', {}, 't'), ', ', h('kbd', {}, 'p'), ', ', h('kbd', {}, 'a'), ', ', h('kbd', {}, 'f'), ' or ', h('kbd', {}, 'r'),
      ' jumps to Today, the current project\'s page, Assets, Flows or Runs.'));
}

// ---------------------------------------------------------------- the view

let section = null;
let lastSignature = '';

// Repaints when what the view shows changed (or always with `force`).
function paint(force = false) {
  if (!section || !state) return;
  const signature = JSON.stringify([state.catalog, state.tools.claude, state.projects.map(p => [p.name, p.launchable]),
    pipelines.list, catalogState, settings, currentProject]);
  if (!force && signature === lastSignature && section.firstChild) return;
  lastSignature = signature;
  keepFocus(section, () => section.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Library'),
      h('p', {}, 'Skills open Claude in a new terminal and run the command there. Workspace tools run here and show their output. ',
        'Pipelines are what the app\'s runs do, stage by stage.'))),
    skillCards(),
    pipelinesCard(),
    settingsCard()));
}

function render(el) {
  section = el;
  paint();
}

async function onShow() {
  if (catalogState === 'ready' && pipelines.loaded && pipelines.project === currentProject) return;
  catalogState = 'loading';
  const r = await loadPipelines(currentProject);
  catalogState = r.loaded ? 'ready' : r.error ? 'error' : 'missing';
  paint(true);
}

export default {
  id: 'tools',
  label: 'Library',
  icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  render,
  onShow,
};
