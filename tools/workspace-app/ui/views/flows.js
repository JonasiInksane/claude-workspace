// Flows: a tuned prompt plus its reference images, run in the hub, a project or one agent.
// Cards with Run and Edit; the editor (create, save, images with captions, archive) and the run
// dialog (the exact prompt, built by the server, with optional notes).
//
// A flow may ask one question on every run (SPEC 5.8): the editor's "Ask" is the label of the
// run dialog's text box, and "Required" means a run needs an answer. The run dialog then labels
// the box with the question, marks it required, shows "Say what you want first." and keeps
// Start off while it is empty; the server refuses an empty answer too (400), and that refusal
// shows in the dialog. The view repaints only when the flows or tools changed.
import { act, api, h, keepFocus, keyed, openPlace, plural, qs, toast } from '../lib.js';
import { clearGuard, closeDialog, dialog, openDialog } from '../dialog.js';
import { refresh, state } from '../store.js';
import { uploadFiles } from './images.js';

// Where a flow runs, as one select value: hub, project:<name> or agent:<project>/<agent>.
const flowTargetValue = f => (f.target === 'hub' ? 'hub' : f.target === 'project' ? `project:${f.project}` : `agent:${f.project}/${f.agent}`);
function flowTargetLabel(f) {
  if (f.target === 'hub') return 'Hub';
  return f.target === 'project' ? f.project : `${f.project} · ${f.agent}`;
}
function parseTargetValue(v) {
  if (v === 'hub') return { target: 'hub', project: '', agent: '' };
  if (v.startsWith('project:')) return { target: 'project', project: v.slice(8), agent: '' };
  const rest = v.slice(6);
  const i = rest.lastIndexOf('/');
  return { target: 'agent', project: rest.slice(0, i), agent: rest.slice(i + 1) };
}

function targetSelect(current) {
  const select = h('select', {},
    h('option', { value: 'hub' }, 'Hub: Claude in the workspace'),
    state.projects.filter(p => p.launchable).map(p => h('optgroup', { label: p.name },
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
        h('p', {}, 'A tuned prompt plus its reference images. Run starts Claude with both, in the hub, a project or one agent.')),
      h('button', { class: 'btn primary', on: { click: () => flowDialog('') } }, '+ New flow')),
    state.flows.length
      ? h('div', { class: 'grid2' }, state.flows.map(flowCard))
      : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No flows yet'),
        'Make one for work you repeat: a prompt you have tuned, plus the images that go with it.')),
    archived || '');
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
  const snapshot = () => JSON.stringify([title.value, description.value, target.value, prompt.value, mode.value, model.value, effort.value, tools.value,
    ask.value, askRequired.checked]);
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
        ask: ask.value.trim(), askRequired: !!ask.value.trim() && askRequired.checked,
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
      h('label', {}, 'Runs in', h('small', {}, 'An agent starts with its own memory and images.'), target)),
    h('label', {}, 'Description', description),
    askRow,
    launchBox,
    h('label', {}, 'Prompt',
      h('small', {}, 'Say the goal, why it matters, the scope, what done looks like and the output you want. ' +
        'The images go above it and run notes below it when you run it. Ctrl+S saves.'), prompt),
    error,
    images);
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

// Shows the exact prompt Claude will start with (built by the server), with the run's notes: the
// answer to the flow's question when it has one (`ask`), required when the flow says so. The
// flow is read again first (GET /api/flow), because the list in the state doesn't carry the
// question. Exported for the palette (parts/palette.js), which passes a flow from the state.
export async function runFlowDialog(f) {
  let ask = '';
  let required = false;
  try {
    const full = await api(`/api/flow?${qs({ slug: f.slug })}`);
    ask = String(full.ask || '').trim();
    required = !!(ask && full.askRequired);
  } catch (e) {
    toast(e.message, true); // the run itself is checked again by the server
  }
  const notes = h('textarea', {
    id: 'flowNotes', maxlength: 2000, required, 'aria-required': required ? 'true' : null,
    'aria-describedby': 'flowNotesHelp flowNotesError',
    placeholder: ask ? 'One or two sentences' : 'Optional: what is different this time, for example "the hero, walking left"',
  });
  const noteError = h('span', { class: 'form-error', id: 'flowNotesError', hidden: true }, 'Say what you want first.');
  const runError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const pre = h('pre', { class: 'output' }, 'Loading…');
  const settings = h('p', { class: 'muted small-text' });
  const start = h('button', { class: 'btn primary', type: 'button' }, `Start in ${flowTargetLabel(f)}`);
  const reason = h('span', { class: 'reason push-left', id: 'flowStartReason' });
  let touched = false;
  // Start is off (with its reason as text) while a required answer is empty; the error and
  // aria-invalid show once the box was used, not before the first key.
  const sync = () => {
    const empty = !notes.value.trim();
    const blocked = required && empty;
    start.disabled = blocked;
    reason.textContent = blocked ? 'Start is off until you answer the question.' : '';
    const invalid = blocked && touched;
    noteError.hidden = !invalid;
    if (invalid) notes.setAttribute('aria-invalid', 'true');
    else notes.removeAttribute('aria-invalid');
  };
  let timer = 0;
  const preview = async () => {
    try {
      const r = await api('/api/flows/run', { method: 'POST', body: { slug: f.slug, notes: notes.value, preview: true } });
      pre.textContent = r.prompt;
      settings.textContent = `Session: ${launchSummary(r.launch) || 'your default mode, model and effort'}.`;
    } catch (e) { pre.textContent = e.message; }
  };
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
      const r = await api('/api/flows/run', { method: 'POST', body: { slug: f.slug, notes: notes.value } });
      dialog.close();
      toast(r.message || 'Started');
    } catch (e) {
      // A refusal (for example 400 for an empty required answer) stays in the dialog.
      runError.textContent = e.message;
      runError.hidden = false;
      sync();
      if (start.disabled) notes.focus();
    }
  });
  const label = ask
    ? h('label', { for: 'flowNotes' }, h('span', {}, ask, required ? h('span', { class: 'muted' }, ' (required)') : null),
      h('small', { id: 'flowNotesHelp' }, required ? 'This flow needs an answer; it goes below the prompt.' : 'Optional. The answer goes below the prompt.'),
      notes, noteError)
    : h('label', { for: 'flowNotes' }, 'Notes for this run',
      h('small', { id: 'flowNotesHelp' }, 'Added below the prompt. Leave empty to run the flow as it is.'), notes, noteError);
  openDialog(`Run: ${f.title || f.slug}`, h('div', { class: 'form' },
    label,
    runError,
    h('div', {}, h('div', { class: 'section-label' }, h('span', {}, 'Claude starts with')), settings, pre)), {
    wide: true,
    actions: [reason, h('button', { class: 'btn', type: 'button', on: { click: closeDialog } }, 'Cancel'), start],
  });
  sync();
  preview();
  notes.focus();
}

export default {
  id: 'flows',
  label: 'Flows',
  icon: '<path d="M5 3l14 9-14 9z"/>',
  count: s => s.flows.length || '',
  render,
};
