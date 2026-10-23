// Flows: a tuned prompt plus its reference images, run in the hub, a project (a fixed one, or any
// project, chosen when it runs) or one agent. Cards with Run and Edit; the editor (create, save,
// images with captions, archive, recent runs) and the run dialog (the exact prompt, built by the
// server, with optional notes).
//
// A flow may ask one question on every run (SPEC 5.8): the editor's "Ask" is the label of the
// run dialog's text box, and "Required" means a run needs an answer. The run dialog then labels
// the box with the question, marks it required, shows "Say what you want first." and keeps
// Start off while it is empty; the server refuses an empty answer too (400), and that refusal
// shows in the dialog. The view repaints only when the flows or tools changed.
//
// A flow for any project (project "*") has a project picker in its run dialog, set to the
// project open in the app (store.currentProject) when it is one the app can start in; Start
// stays off until a project is chosen, and the server refuses a run without one too. Every
// launch is recorded with the flow's version (flow-versions.mjs); the editor lists the newest
// as "Recent runs", marked "edited since" when the flow is no longer the version that ran.
//
// Attached assets (the flow's `assets` field): the editor's asset picker lists the asset library
// (GET /api/library: shared assets, plus the target project's own), shows each attached asset's
// status (its version, pinned or the latest, archived, gone, or not allowed for the target: a hub
// flow and a flow for any project take shared assets only) and saves them as "ref@version, ...".
// The run dialog's preview shows the effective launch (the project's defaults, tools and rules
// added), the assets in the prompt, and what a run would refuse.
import { act, api, fmtAgo, fmtTime, h, keepFocus, keyed, openPlace, plural, qs, toast } from '../lib.js';
import { clearGuard, closeDialog, dialog, openDialog } from '../dialog.js';
import { currentProject, refresh, state } from '../store.js';
import { uploadFiles } from './images.js';

// The `project` of a flow for any project (ANY_PROJECT in tools/lib/flows.mjs).
const ANY_PROJECT = '*';
const isAnyProject = f => !!f && f.target === 'project' && f.project === ANY_PROJECT;

// Where a flow runs, as one select value: hub, project:<name> (project:* for any project) or
// agent:<project>/<agent>. These helpers and the ones below the editor are exported for the
// view's tests (flows.test.mjs).
export const flowTargetValue = f => (f.target === 'hub' ? 'hub' : f.target === 'project' ? `project:${f.project}` : `agent:${f.project}/${f.agent}`);
export function flowTargetLabel(f) {
  if (f.target === 'hub') return 'Hub';
  if (isAnyProject(f)) return 'Any project';
  return f.target === 'project' ? f.project : `${f.project} · ${f.agent}`;
}
export function parseTargetValue(v) {
  if (v === 'hub') return { target: 'hub', project: '', agent: '' };
  if (v.startsWith('project:')) return { target: 'project', project: v.slice(8), agent: '' };
  const rest = v.slice(6);
  const i = rest.lastIndexOf('/');
  return { target: 'agent', project: rest.slice(0, i), agent: rest.slice(i + 1) };
}

function targetSelect(current) {
  const launchable = state.projects.filter(p => p.launchable);
  const select = h('select', {},
    h('option', { value: 'hub' }, 'Hub: Claude in the workspace'),
    launchable.length ? h('option', { value: `project:${ANY_PROJECT}` }, 'Any project (choose when you run it)') : null,
    launchable.map(p => h('optgroup', { label: p.name },
      h('option', { value: `project:${p.name}` }, `${p.name}: project session`),
      p.agents.filter(a => a.valid && a.isolated && !a.duplicate)
        .map(a => h('option', { value: `agent:${p.name}/${a.name}` }, `${p.name}: ${a.name} (agent, own memory and images)`)))));
  if (current) {
    const v = flowTargetValue(current);
    if (![...select.options].some(o => o.value === v)) select.prepend(h('option', { value: v }, `${flowTargetLabel(current)} (not available now)`));
    select.value = v;
  }
  return select;
}

// "plan mode · effort high · model opus · pre-approved: Read, Grep", or '' for all defaults.
function launchSummary(launch = {}) {
  return [
    launch.permissionMode && `${launch.permissionMode} mode`,
    launch.effort && `effort ${launch.effort}`,
    launch.model && `model ${launch.model}`,
    launch.allowedTools && launch.allowedTools.length && `pre-approved: ${launch.allowedTools.join(', ')}`,
  ].filter(Boolean).join(' · ');
}

// The run dialog's line about how the session starts, from a preview (POST /api/flows/run with
// preview): the effective launch, with the project's defaults and tools already added, and
// whether its rules go into the system prompt.
export function sessionLine(r = {}) {
  const base = `Session: ${launchSummary(r.launch || {}) || 'your default mode, model and effort'}.`;
  const ps = r.projectSettings;
  if (ps && r.launch && r.launch.appendSystemPrompt) return `${base} The rules of ${r.project} (settings v${ps.version}) go into the system prompt.`;
  if (ps) return `${base} ${r.project}'s settings v${ps.version} apply.`;
  return base;
}

// ---------------------------------------------------------------- attached assets (tested)

// The project whose own assets a flow may attach: a fixed project's or an agent's; '' for the hub
// and for any project (shared assets only). `v` is a target select value.
export function assetProject(v) {
  const t = parseTargetValue(String(v || 'hub'));
  return t.target === 'hub' || t.project === ANY_PROJECT ? '' : t.project;
}

// '' when a flow with target `v` may attach `ref`, else why not.
export function assetRefusal(ref, v) {
  const left = String(ref).slice(0, String(ref).indexOf(':'));
  if (left.toLowerCase() === 'shared') return '';
  const own = assetProject(v);
  if (own && own.toLowerCase() === left.toLowerCase()) return '';
  return own ? `belongs to ${left}; this flow can attach shared assets and ${own}'s own` : `belongs to ${left}; this flow can attach shared assets only`;
}

// The `assets` text a list saves as: "shared:style-guide, example:palette@2".
export const formatAssets = list => (Array.isArray(list) ? list : []).map(a => (a.pin ? `${a.ref}@${a.pin}` : a.ref)).join(', ');

// The library entry of a ref (GET /api/library spells refs as they are stored), or null.
const entryOf = (library, ref) => (Array.isArray(library) ? library : []).find(e => e && String(e.ref).toLowerCase() === String(ref).toLowerCase()) || null;

// An attached asset's status in words: { text, cls } (cls '' | 'amber' | 'red'). `library` is the
// listing (with archived assets), `v` the target select value.
export function assetStatus(a, library, v) {
  const refusal = assetRefusal(a.ref, v);
  if (refusal) return { text: `Not allowed here: ${refusal}`, cls: 'red' };
  const e = entryOf(library, a.ref);
  if (!e) return { text: 'Not in the library: a run would refuse it', cls: 'red' };
  if (e.error || !e.latest) return { text: `Can't be read: ${e.error || 'no versions'}`, cls: 'red' };
  if (a.pin && a.pin > e.latest.n) return { text: `Has no version ${a.pin}: a run would refuse it`, cls: 'red' };
  const which = a.pin ? `Pinned to v${a.pin}${a.pin < e.latest.n ? ` (the latest is v${e.latest.n})` : ''}` : `The latest, now v${e.latest.n}`;
  return e.archived ? { text: `${which} · archived, still used (archiving only hides it)`, cls: 'amber' } : { text: which, cls: '' };
}

// The library entries the picker offers: allowed for the target, not archived, not attached yet.
export function assetChoices(library, attached, v) {
  const taken = new Set((attached || []).map(a => String(a.ref).toLowerCase()));
  return (Array.isArray(library) ? library : [])
    .filter(e => e && !e.error && !e.archived && e.latest && !taken.has(String(e.ref).toLowerCase()) && !assetRefusal(e.ref, v));
}

// The editor's "Attached assets" part. Returns { el, value() (the assets text), setTarget(v) }.
// The library is read again for every target (another project, other own assets); the rows
// keep the focus across repaints (keyed), and Remove moves it to the picker.
function assetPicker(initial, targetValue) {
  const attached = (Array.isArray(initial) ? initial : []).map(a => ({ ref: a.ref, pin: a.pin ?? null }));
  let target = targetValue;
  let library = null; // null: loading
  let failed = '';
  let seq = 0;
  const box = h('div', { class: 'flow-assets' });
  const pick = h('select', { id: 'flowAssetPick', 'aria-label': 'Asset to attach' });
  const add = h('button', { class: 'btn small', type: 'button', on: { click: () => attach() } }, 'Attach');
  const attach = () => {
    if (!pick.value) return;
    attached.push({ ref: pick.value, pin: null });
    paint();
    pick.focus();
  };
  const remove = i => {
    attached.splice(i, 1);
    paint();
    pick.focus();
  };
  const versions = n => [['', `Latest${n ? ` (v${n})` : ''}`], ...Array.from({ length: n }, (_, k) => [String(n - k), `v${n - k}`])];
  function row(a, i) {
    const e = entryOf(library, a.ref);
    const name = (e && e.title) || a.ref;
    const st = assetStatus(a, library || [], target);
    const latest = e && e.latest ? e.latest.n : 0;
    const pin = h('select', {
      'aria-label': `Version of ${name}`,
      on: { change: ev => { a.pin = ev.target.value ? Number(ev.target.value) : null; paint(); } },
    }, versions(Math.max(latest, a.pin || 0)).map(([value, label]) => h('option', { value }, label)));
    pin.value = a.pin ? String(a.pin) : '';
    return keyed(h('li', {},
      h('div', { class: 'main' },
        h('div', { class: 'title' }, name, ' ', h('span', { class: 'muted' }, `${a.ref}${e && e.kind ? ` · ${e.kind}` : ''}`)),
        h('div', { class: `sub asset-status${st.cls ? ` is-${st.cls}` : ''}` }, st.text)),
      h('div', { class: 'row-actions' }, pin,
        h('button', { class: 'btn small', type: 'button', 'aria-label': `Remove ${name}`, on: { click: () => remove(i) } }, 'Remove'))), `asset:${a.ref}`);
  }
  function paint() {
    keepFocus(box, () => {
      const choices = library ? assetChoices(library, attached, target) : [];
      pick.replaceChildren(h('option', { value: '' }, library === null ? 'Loading the library…' : choices.length ? 'Choose an asset…' : 'No other asset can be attached'),
        ...choices.map(c => h('option', { value: c.ref }, `${c.title} (${c.ref}, ${c.kind})`)));
      pick.disabled = !choices.length;
      add.disabled = !choices.length;
      box.replaceChildren(
        failed ? h('p', { class: 'form-error' }, `The asset library could not be read: ${failed}`) : null,
        attached.length ? h('ul', { class: 'list flow-asset-list' }, attached.map(row)) : h('p', { class: 'muted small-text' }, 'No assets attached.'),
        h('div', { class: 'flow-asset-add' }, pick, add));
    });
  }
  async function load() {
    const mine = ++seq;
    library = null;
    failed = '';
    paint();
    const project = assetProject(target);
    try {
      const r = await api(`/api/library?${qs({ archived: 1, project: project || undefined })}`);
      if (mine !== seq) return;
      library = Array.isArray(r.assets) ? r.assets : [];
    } catch (e) {
      if (mine !== seq) return;
      library = [];
      failed = e.message;
    }
    paint();
  }
  load();
  return {
    el: h('div', {},
      h('div', { class: 'section-label' }, h('span', {}, 'Attached assets')),
      h('p', { class: 'muted small-text' }, 'From the asset library. A run lists them after the images, in these versions. A hub flow and a flow for any project take shared assets only. ' +
        "The list is saved in the flow's file in flows/, which the hub repository commits, so each ref (a project's name and an id made from the asset's title) becomes public there."),
      box),
    value: () => formatAssets(attached),
    setTarget(v) { if (v !== target) { target = v; load(); } },
  };
}

// One image in the flow editor: its run label, its file name and an editable caption.
function flowImageTile(slug, img, i) {
  const caption = h('input', {
    class: 'caption', maxlength: 200, autocomplete: 'off', placeholder: 'What it shows (optional)', 'aria-label': `What Image ${i + 1} shows`,
  });
  caption.value = img.caption || '';
  caption.addEventListener('change', () => {
    act(api('/api/flows/caption', { method: 'POST', body: { slug, image: img.name, caption: caption.value } }));
  });
  return h('div', { class: 'tile' },
    h('button', { class: 'pic', title: img.name, on: { click: () => window.open(`/img?${qs({ path: img.path })}`, '_blank') } },
      h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name, loading: 'lazy' })),
    h('div', { class: 'meta' }, h('b', {}, `Image ${i + 1}`), h('span', { title: img.name }, img.name)),
    caption);
}

async function loadFlowThumbs(f, box) {
  try {
    const r = await api(`/api/images?${qs({ flow: f.slug })}`);
    box.replaceChildren(...r.images.slice(0, 6).map(img => h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name, title: img.name, loading: 'lazy' })));
  } catch { /* thumbnails are a nicety */ }
}

function flowCard(f) {
  const thumbs = h('div', { class: 'flow-thumbs' });
  if (f.images) loadFlowThumbs(f, thumbs);
  const badge = f.target === 'agent' ? 'violet' : f.target === 'project' ? 'blue' : '';
  // The visible reason a disabled Run… has, linked to the button for screen readers.
  const why = `flow-${f.slug}-why`;
  const off = !!f.error || !state.tools.claude;
  return h('div', { class: 'card flow' },
    h('div', { class: 'card-head' },
      h('div', { class: 'project-title' }, h('h3', {}, f.title || f.slug), h('span', { class: `badge ${badge}` }, flowTargetLabel(f))),
      h('div', { class: 'row-actions' },
        keyed(h('button', { class: 'btn primary small', type: 'button', disabled: off, 'aria-describedby': off ? why : null, on: { click: () => runFlowDialog(f) } }, 'Run…'), `flow-${f.slug}-run`),
        keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => flowDialog(f.slug) } }, 'Edit'), `flow-${f.slug}-edit`)),
      !f.error && !state.tools.claude ? h('p', { class: 'reason flow-reason', id: why }, 'Claude Code was not found on this PC, so flows can\'t run.') : null),
    h('div', { class: 'card-body' },
      f.error ? h('div', { class: 'form-error', id: why }, `Can't run: ${f.error}. Edit it to pick another target.`) : null,
      f.description ? h('p', { class: 'flow-desc' }, f.description) : null,
      h('div', { class: 'muted small-text' }, f.images ? plural(f.images, 'reference image') : 'No images', ' · ', h('code', {}, `flows/${f.slug}.md`)),
      launchSummary(f.launch) ? h('div', { class: 'muted small-text' }, `Starts with ${launchSummary(f.launch)}`) : null,
      thumbs));
}

let lastSignature = '';
let archivedOpen = false; // the "Archived flows" fold, kept across repaints

function render(el) {
  const signature = JSON.stringify([state.flows, state.archivedFlows, state.tools.claude]);
  if (signature === lastSignature && el.firstChild) return;
  lastSignature = signature;
  keepFocus(el, () => paint(el));
}

function paint(el) {
  const archived = state.archivedFlows.length
    ? h('details', { class: 'archived', open: archivedOpen, on: { toggle: e => { archivedOpen = e.currentTarget.open; } } },
      h('summary', {}, `Archived flows (${state.archivedFlows.length})`),
      h('ul', { class: 'list' }, state.archivedFlows.map(x => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title' }, x.title), h('div', { class: 'sub' }, `flows/_archived/${x.archivedAs}`)),
        h('button', {
          class: 'btn small',
          on: { click: () => act(api('/api/flows/restore', { method: 'POST', body: { archivedAs: x.archivedAs } })).then(refresh) },
        }, 'Restore')))))
    : null;
  el.replaceChildren(
    h('div', { class: 'view-head' },
      h('div', {}, h('h2', {}, 'Flows'),
        h('p', {}, 'A tuned prompt plus its reference images. Run starts Claude with both, in the hub, a project (or any project you pick) or one agent.')),
      h('button', { class: 'btn primary', on: { click: () => flowDialog('') } }, '+ New flow')),
    state.flows.length
      ? h('div', { class: 'grid2' }, state.flows.map(flowCard))
      : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No flows yet'),
        'Make one for work you repeat: a prompt you have tuned, plus the images that go with it.')),
    archived || '');
}

// Where a recorded run started: Hub, the project, or "project · agent".
export function runWhere(r) {
  if (r.target === 'hub') return 'Hub';
  return r.target === 'agent' ? `${r.project} · ${r.agent}` : r.project || 'a project';
}

const CHANGE_WORDS = { prompt: 'the prompt', images: 'the images' };

// The version line of a recorded run: `before`, the short hash (shown as code, '' without a
// version), `after` (the hub commit that version is in, and what changed in the flow since), and
// `edited` when something did. `changes` comes from GET /api/flow-runs.
export function runVersionParts(r) {
  const v = r.version;
  const edited = (r.changes || []).filter(c => CHANGE_WORDS[c]);
  const since = edited.length ? ` · since then ${edited.map(c => CHANGE_WORDS[c]).join(' and ')} changed` : '';
  if (!v) return { before: 'The version was not recorded', hash: '', after: since, edited: edited.length > 0 };
  const commit = v.committed ? ` · in hub commit ${v.hubCommit.slice(0, 7)}` : ' · not committed in the hub';
  return { before: 'Version ', hash: v.sha256.slice(0, 8), after: commit + since, edited: edited.length > 0 };
}

// The assets a recorded run got, in words: "with shared:style-guide v2, example:palette v1" ('' for none).
export const runAssetsText = r => (Array.isArray(r.assets) && r.assets.length ? `with ${r.assets.map(a => `${a.ref} v${a.version}`).join(', ')}` : '');

// One recorded launch: when and where, then its version line (and the asset versions it got), and
// "edited since" when the flow is no longer the version that ran.
function flowRunRow(r) {
  const p = runVersionParts(r);
  const when = r.at ? h('time', { datetime: r.at, title: fmtTime(r.at) }, fmtAgo(r.at)) : 'At an unknown time';
  const assets = runAssetsText(r);
  return h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title' }, when, ` · ${runWhere(r)}`),
      h('div', { class: 'sub wrap' }, p.before, p.hash ? h('code', {}, p.hash) : null, p.after),
      assets ? h('div', { class: 'sub wrap' }, assets) : null),
    p.edited ? h('span', { class: 'badge amber' }, 'edited since') : null);
}

// The editor's "Recent runs" section (newest first), loaded after the dialog opens.
function recentRuns(slug) {
  const box = h('div', { class: 'flow-runs' }, h('p', { class: 'muted small-text' }, 'Loading…'));
  api(`/api/flow-runs?${qs({ flow: slug })}`).then(r => {
    box.replaceChildren(r.runs.length
      ? h('ul', { class: 'list' }, r.runs.map(flowRunRow))
      : h('p', { class: 'muted small-text' }, 'No runs yet. Each run is listed here with the version of the flow it used.'));
  }, e => box.replaceChildren(h('p', { class: 'muted small-text' }, `Recent runs could not be read: ${e.message}`)));
  return h('div', {}, h('div', { class: 'section-label' }, h('span', {}, 'Recent runs')), box);
}

// Create (slug '') or edit a flow. A new flow reopens in edit mode, where images can be added.
async function flowDialog(slug) {
  let f = { title: '', description: '', target: 'hub', project: '', agent: '', prompt: '', hash: '' };
  if (slug) {
    try { f = await api(`/api/flow?${qs({ slug })}`); } catch (e) { toast(e.message, true); return; }
  }
  const title = h('input', { required: true, maxlength: 120, autocomplete: 'off', placeholder: 'Hero sprite from a sketch' });
  const description = h('input', { maxlength: 300, autocomplete: 'off', placeholder: 'Optional: what it is for, shown on its card' });
  const target = targetSelect(slug ? f : null);
  const prompt = h('textarea', {
    class: 'code-edit prompt-edit', 'aria-label': 'Prompt',
    placeholder: 'Write it as you would type it to Claude: the goal, the constraints, what done looks like.',
  });
  title.value = f.title;
  description.value = f.description;
  prompt.value = f.prompt;
  // The question every run asks (the run dialog's text box label), and whether it needs an answer.
  const ask = h('input', {
    maxlength: 120, autocomplete: 'off', placeholder: 'Optional, e.g. What do you want to refactor?', 'aria-describedby': 'flowAskHelp',
  });
  const askRequired = h('input', { type: 'checkbox', 'aria-describedby': 'flowRequiredHelp' });
  const requiredHelp = h('small', { id: 'flowRequiredHelp' });
  ask.value = f.ask || '';
  askRequired.checked = !!(f.ask && f.askRequired);
  // Required needs a question: the box is off (and says why) while Ask is empty.
  const syncRequired = () => {
    const empty = !ask.value.trim();
    askRequired.disabled = empty;
    if (empty) askRequired.checked = false;
    requiredHelp.textContent = empty ? 'Type a question first; then a run can require an answer.' : 'Start stays off until the run has an answer.';
  };
  ask.addEventListener('input', syncRequired);
  syncRequired();
  const askRow = h('div', { class: 'two-col ask-row' },
    h('label', {}, 'Ask', h('small', { id: 'flowAskHelp' }, 'The question the run dialog asks; the answer goes below the prompt.'), ask),
    h('div', { class: 'ask-required' },
      h('label', { class: 'check' }, askRequired, 'Required'),
      requiredHelp));
  // How the session starts (flags on the claude command; empty = the user's own default).
  const mode = h('select', {}, [
    ['', 'Your default'], ['plan', 'Plan: reads and proposes, changes nothing'], ['acceptEdits', 'Accept edits: edits files without asking'],
    ['manual', 'Manual: asks before edits and commands'], ['auto', 'Auto'],
  ].map(([value, label]) => h('option', { value }, label)));
  const model = h('input', { list: 'flowModels', maxlength: 80, autocomplete: 'off', spellcheck: 'false', placeholder: 'Your default (or opus, sonnet, haiku, fable)' });
  const effort = h('select', {}, [['', 'Your default'], ...['low', 'medium', 'high', 'xhigh', 'max'].map(e => [e, e])].map(([value, label]) => h('option', { value }, label)));
  const tools = h('input', { maxlength: 500, autocomplete: 'off', spellcheck: 'false', placeholder: 'Read, Grep, Bash(npm test:*)' });
  mode.value = f.permissionMode || '';
  model.value = f.model || '';
  effort.value = f.effort || '';
  tools.value = f.allowedTools || '';
  const launchSet = !!(f.permissionMode || f.model || f.effort || f.allowedTools);
  const launchBox = h('details', { class: 'launch', open: launchSet },
    h('summary', {}, 'How the session starts', launchSet ? '' : h('span', { class: 'muted' }, ' (your defaults)')),
    h('div', { class: 'two-col' },
      h('label', {}, 'Permission mode', h('small', {}, 'Plan suits flows that should explore and propose first.'), mode),
      h('label', {}, 'Effort', h('small', {}, 'How hard Claude thinks; the first control to change.'), effort),
      h('label', {}, 'Model', h('small', {}, 'An alias or a full model name.'), model,
        h('datalist', { id: 'flowModels' }, ['opus', 'sonnet', 'haiku', 'fable'].map(m => h('option', { value: m })))),
      h('label', {}, 'Pre-approved tools', h('small', {}, 'Allowed without asking, e.g. Read, Bash(npm test:*).'), tools)));
  const assets = assetPicker(f.assetList || [], target.value);
  target.addEventListener('change', () => assets.setTarget(target.value));
  const snapshot = () => JSON.stringify([title.value, description.value, target.value, prompt.value, mode.value, model.value, effort.value, tools.value,
    ask.value, askRequired.checked, assets.value()]);
  const initial = snapshot();
  const dirty = () => snapshot() !== initial;
  const error = h('div', { class: 'form-error', hidden: true });
  const save = h('button', { class: 'btn primary' }, slug ? 'Save' : 'Create flow');

  let upload = null;
  let images;
  if (slug) {
    const gallery = h('div', { class: 'gallery small' });
    const skipped = h('p', { class: 'form-error', hidden: true });
    // In run order, labeled the way the prompt sees them ("Image 1"), each with a caption.
    const reload = async () => {
      try {
        const r = await api(`/api/flow?${qs({ slug })}`);
        gallery.replaceChildren(...(r.images.length ? r.images.map((img, i) => flowImageTile(slug, img, i)) : [h('p', { class: 'muted' }, 'No images yet.')]));
        skipped.textContent = r.skipped.length
          ? `Not passed to runs: ${r.skipped.join(', ')}. Claude Code doesn't read BMP; drop the file again and the app saves it as PNG.` : '';
        skipped.hidden = !r.skipped.length;
      } catch (e) { gallery.replaceChildren(h('p', { class: 'muted' }, e.message)); }
    };
    upload = async (files, pasted) => { await uploadFiles(files, pasted, { flow: slug, title: f.title }); reload(); };
    const input = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, hidden: true,
      on: { change: e => { const files = [...e.target.files]; e.target.value = ''; upload(files, false); } },
    });
    images = h('div', {},
      h('div', { class: 'section-label' }, h('span', {}, 'Reference images'),
        h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'images', flow: slug }) } }, 'Open folder')),
      h('div', {
        class: 'drop compact', id: 'dialogDrop', tabindex: '0', role: 'button', 'aria-label': 'Add images to this flow',
        on: { click: () => input.click(), keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      }, h('b', {}, 'Drop images here, paste with Ctrl+V, or click to choose'),
      h('span', {}, `Saved right away in inbox/attachments/_flows/${slug}/ (BMP as PNG). A run lists them first, as Image 1, Image 2 ..., so the prompt can refer to them.`)),
      input, skipped, gallery);
    reload();
  } else {
    images = h('p', { class: 'muted hint' }, 'After you create the flow, you can add reference images to it here.');
  }

  const doSave = async () => {
    if (save.disabled) return; // Ctrl+S while a save is running, or after a create
    save.disabled = true;
    error.hidden = true;
    try {
      const body = {
        slug, hash: f.hash, title: title.value, description: description.value, prompt: prompt.value, ...parseTargetValue(target.value),
        permissionMode: mode.value, model: model.value.trim(), effort: effort.value, allowedTools: tools.value,
        ask: ask.value.trim(), askRequired: !!ask.value.trim() && askRequired.checked, assets: assets.value(),
      };
      const r = await api('/api/flows', { method: 'POST', body });
      clearGuard();
      toast(r.message);
      await refresh();
      if (slug) dialog.close();
      else flowDialog(r.slug); // Save stays disabled: this dialog is done
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      save.disabled = false;
    }
  };
  save.addEventListener('click', doSave);
  const body = h('div', { class: 'form flow-form' },
    h('div', { class: 'two-col' },
      h('label', {}, 'Title', title),
      h('label', {}, 'Runs in', h('small', {}, 'Any project: you pick one on every run. An agent has its own memory and images.'), target)),
    h('label', {}, 'Description', description),
    askRow,
    launchBox,
    h('label', {}, 'Prompt',
      h('small', {}, 'Say the goal, why it matters, the scope, what done looks like and the output you want. ' +
        'The images go above it and run notes below it when you run it. Ctrl+S saves.'), prompt),
    error,
    images,
    assets.el,
    slug ? recentRuns(slug) : null);
  body.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  });
  const archive = slug ? h('button', {
    class: 'btn danger push-left',
    on: { click: () => { if (!dirty() || confirm('Discard your changes to this flow?')) archiveFlowDialog(slug, f.title); } },
  }, 'Archive…') : null;
  openDialog(slug ? `Edit flow: ${f.title}` : 'New flow', body, {
    wide: true,
    guard: () => !dirty() || confirm('Discard your changes to this flow?'),
    upload,
    actions: [archive, h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'), save].filter(Boolean),
  });
  (slug ? prompt : title).focus();
}

function archiveFlowDialog(slug, title) {
  openDialog(`Archive ${title}?`, h('div', {},
    h('p', {}, 'Its file moves to ', h('code', {}, 'flows/_archived/'), ', so it leaves this list.'),
    h('p', { class: 'muted' }, 'Its images stay where they are. Restore (under the flows) brings it back with them.')), {
    actions: [
      h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        on: { click: async () => { dialog.close(); await act(api('/api/flows/archive', { method: 'POST', body: { slug } })); refresh(); } },
      }, 'Archive'),
    ],
  });
}

// The run dialog's projects for a flow for any project: the ones the app can start in, and the
// one to preselect, the project open in the app (store.currentProject) when it is one of them.
export function projectChoices(projects, current) {
  const choices = (Array.isArray(projects) ? projects : []).filter(p => p && p.launchable).map(p => p.name);
  return { choices, value: choices.includes(current) ? current : '' };
}

// Start in the run dialog: off, with the reason as text, while a required question has no
// answer (`needAnswer`) or a flow for any project has no project yet. `project` is null for a
// flow with a fixed place (`place`: Hub, the project, project · agent), else the chosen one.
export function startState({ needAnswer = false, project = null, place = '' } = {}) {
  const needProject = project !== null && !project;
  return {
    disabled: needAnswer || needProject,
    text: needProject ? 'Start' : `Start in ${project !== null ? project : place}`,
    reason: needProject && needAnswer ? 'Start is off until you choose a project and answer the question.'
      : needProject ? 'Start is off until you choose a project.'
        : needAnswer ? 'Start is off until you answer the question.' : '',
  };
}

// The lines under the run dialog's session line, from a preview: what a run would refuse
// ({ text, problem: true }), then the hint to choose a project and archived assets in use.
export function previewNotes(r = {}) {
  const out = (Array.isArray(r.problems) ? r.problems : []).map(text => ({ text: `A run would be refused: ${text}`, problem: true }));
  if (r.note) out.push({ text: r.note, problem: false });
  const archived = (Array.isArray(r.assets) ? r.assets : []).filter(a => a.archived && !a.missing).map(a => a.ref);
  if (archived.length) out.push({ text: `Archived, still used: ${archived.join(', ')}.`, problem: false });
  return out;
}

// The project picker of a flow for any project. Returns { pick, help, choices }.
function projectPicker() {
  const { choices, value } = projectChoices(state && state.projects, currentProject);
  const pick = h('select', { id: 'flowProject', required: true, 'aria-describedby': 'flowProjectHelp' },
    h('option', { value: '' }, choices.length ? 'Choose a project…' : 'No project can start from the app'),
    choices.map(name => h('option', { value: name }, name)));
  pick.value = value;
  const help = h('small', { id: 'flowProjectHelp' }, choices.length
    ? 'This flow runs in any project. Claude starts in the one you choose.'
    : 'Every project folder here has unusual characters in its name; start those from a terminal.');
  return { pick, help, choices };
}

// Shows the exact prompt Claude will start with (built by the server), with the run's notes: the
// answer to the flow's question when it has one (`ask`), required when the flow says so. The
// flow is read again first (GET /api/flow), because the list in the state doesn't carry the
// question. A flow for any project also asks where to run it. Exported for the palette
// (parts/palette.js), which passes a flow from the state.
export async function runFlowDialog(f) {
  let ask = '';
  let required = false;
  let anyProject = isAnyProject(f);
  try {
    const full = await api(`/api/flow?${qs({ slug: f.slug })}`);
    ask = String(full.ask || '').trim();
    required = !!(ask && full.askRequired);
    anyProject = isAnyProject(full);
  } catch (e) {
    toast(e.message, true); // the run itself is checked again by the server
  }
  const picker = anyProject ? projectPicker() : null;
  const notes = h('textarea', {
    id: 'flowNotes', maxlength: 2000, required, 'aria-required': required ? 'true' : null,
    'aria-describedby': 'flowNotesHelp flowNotesError',
    placeholder: ask ? 'One or two sentences' : 'Optional: what is different this time, for example "the hero, walking left"',
  });
  const noteError = h('span', { class: 'form-error', id: 'flowNotesError', hidden: true }, 'Say what you want first.');
  const runError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const pre = h('pre', { class: 'output' }, 'Loading…');
  const settings = h('p', { class: 'muted small-text' });
  // What a run would refuse (an attached asset that is gone, settings that can't be read), and
  // for a flow for any project the hint to choose one; updated with every preview.
  const problems = h('div', { class: 'flow-preview-problems' });
  const start = h('button', { class: 'btn primary', type: 'button' }, `Start in ${flowTargetLabel(f)}`);
  const reason = h('span', { class: 'reason push-left', id: 'flowStartReason' });
  let touched = false;
  // Start (startState): the error and aria-invalid show once the box was used, not before the
  // first key.
  const sync = () => {
    const needAnswer = required && !notes.value.trim();
    const s = startState({ needAnswer, project: picker ? picker.pick.value : null, place: flowTargetLabel(f) });
    start.disabled = s.disabled;
    start.textContent = s.text;
    reason.textContent = s.reason;
    const invalid = needAnswer && touched;
    noteError.hidden = !invalid;
    if (invalid) notes.setAttribute('aria-invalid', 'true');
    else notes.removeAttribute('aria-invalid');
  };
  let timer = 0;
  let seq = 0;
  // The preview follows the chosen project, so its settings and attached assets show too. Only
  // the newest one asked for is shown: an older answer that arrives later is dropped.
  const preview = async () => {
    clearTimeout(timer);
    const mine = ++seq;
    try {
      const body = { slug: f.slug, notes: notes.value, preview: true, ...(picker && picker.pick.value ? { project: picker.pick.value } : {}) };
      const r = await api('/api/flows/run', { method: 'POST', body });
      if (mine !== seq) return;
      pre.textContent = r.prompt;
      settings.textContent = sessionLine(r);
      problems.replaceChildren(...previewNotes(r).map(n => h('p', { class: n.problem ? 'form-error' : 'muted small-text' }, n.text)));
    } catch (e) {
      if (mine !== seq) return;
      pre.textContent = e.message;
      problems.replaceChildren();
    }
  };
  if (picker) picker.pick.addEventListener('change', () => { runError.hidden = true; sync(); preview(); });
  notes.addEventListener('input', () => {
    touched = true;
    runError.hidden = true;
    sync();
    clearTimeout(timer);
    timer = setTimeout(preview, 350);
  });
  notes.addEventListener('blur', () => { touched = true; sync(); });
  start.addEventListener('click', async () => {
    if (start.disabled) return;
    start.disabled = true;
    runError.hidden = true;
    try {
      const body = { slug: f.slug, notes: notes.value, ...(picker ? { project: picker.pick.value } : {}) };
      const r = await api('/api/flows/run', { method: 'POST', body });
      dialog.close();
      toast(r.message || 'Started');
    } catch (e) {
      // A refusal (for example 400 for an empty required answer) stays in the dialog.
      runError.textContent = e.message;
      runError.hidden = false;
      sync();
      if (start.disabled) (picker && !picker.pick.value ? picker.pick : notes).focus();
    }
  });
  const label = ask
    ? h('label', { for: 'flowNotes' }, h('span', {}, ask, required ? h('span', { class: 'muted' }, ' (required)') : null),
      h('small', { id: 'flowNotesHelp' }, required ? 'This flow needs an answer; it goes below the prompt.' : 'Optional. The answer goes below the prompt.'),
      notes, noteError)
    : h('label', { for: 'flowNotes' }, 'Notes for this run',
      h('small', { id: 'flowNotesHelp' }, 'Added below the prompt. Leave empty to run the flow as it is.'), notes, noteError);
  const where = picker ? h('label', { for: 'flowProject', class: 'flow-project' }, 'Project', picker.help, picker.pick) : null;
  openDialog(`Run: ${f.title || f.slug}`, h('div', { class: 'form' },
    where,
    label,
    runError,
    h('div', {}, h('div', { class: 'section-label' }, h('span', {}, 'Claude starts with')), settings, problems, pre)), {
    wide: true,
    actions: [reason, h('button', { class: 'btn', type: 'button', on: { click: closeDialog } }, 'Cancel'), start],
  });
  sync();
  preview();
  (picker && !picker.pick.value && picker.choices.length ? picker.pick : notes).focus();
}

export default {
  id: 'flows',
  label: 'Flows',
  icon: '<path d="M5 3l14 9-14 9z"/>',
  count: s => s.flows.length || '',
  render,
};
