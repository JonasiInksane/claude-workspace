// The project page's Settings tab (#project/<name>/settings, every type): the project's rules and
// settings (project-settings.mjs on the server keeps them as numbered, immutable versions in the
// private data folder), and below them the project's profile.
//
// - Where they apply, said at the top: every Claude stage of runs in this project and every
//   session the app starts here (Start Claude here, skills, flows, agents).
// - The editor: the rules (Markdown, edited and saved as plain text, with a live count against the
//   limit), the defaults (model, effort, permission mode; empty is "your own default"), the
//   pre-approved tools (the flows' rule syntax) and the attached assets, each with its state from
//   POST /api/library/resolve (title, kind, version, missing or archived), following the latest
//   version or pinned to one; Attach… opens a picker of the shared assets and the project's own.
//   Problems show next to their field while you type (the server's checks, mirrored in
//   parts/settings-form.js) and after a refused save (the server's own sentences).
// - Save sends basedOn, the version the editor opened. A 409 (another save came first) keeps what
//   you typed on screen and offers Reload, Compare and Copy my rules; a newer version that a
//   refresh brings while you type says the same before you save. Unsaved changes are guarded:
//   leaving the tab or the page asks first (parts/leave-guard.js, asked by main.js on every route
//   change), and the draft survives a repaint, another tab's data or a type change.
// - Versions: every saved version, newest first; View shows one read-only, Compare shows the line
//   diff of the rules (parts/textdiff.js) and the other settings field by field against the
//   current one.
// - The profile (the private file that makes a project a code project), as before: for a code
//   project whether it is there and valid, with the --check command; for another project, Create
//   from the example.
//
// The editor's controls are built once per project and kept (with the draft) until it is saved or
// discarded, so a repaint never moves the caret or closes a select; the cards around it are patched
// (parts/patch.js). Data: project-data.js parts `settings` and `library`, plus `project` for a code
// project's profile. A project whose folder name the data folder can't hold has no settings.
//
// The pure helpers (checkCommand, profileStatus) are exported for settings.test.mjs; the form's
// logic is in parts/settings-form.js.
import { api, copy, fmtAgo, fmtTime, h, keyed, plural, toast } from '../../lib.js';
import { closeDialog, dialog, openDialog } from '../../dialog.js';
import { projectHash } from '../../store.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, reload, requestMark, slot, use } from '../../parts/project-data.js';
import { btn, cardHead, DATA_NAME_RE, errorNote, loadingBody, minute, short, stateCard } from '../../parts/project-ui.js';
import { createProfile } from '../../parts/project-actions.js';
import { clearLeaveGuard, setLeaveGuard } from '../../parts/leave-guard.js';
import {
  assetChanges, checkFields, DEFAULT_LIMITS, fieldDiff, fieldsOf, PERMISSION_WORDS, pinText, problemCount, rulesCount, sameFields,
  saveBody, splitProblems, tidyFields,
} from '../../parts/settings-form.js';
import { attachmentBadges, getAsset, kindWord, pinWords, resolveAttachments, versionNumbers } from '../../parts/library.js';
import { kindIcon } from '../../parts/library-ui.js';
import { assetPicker } from '../../parts/library-dialogs.js';
import { diffSummary, lineDiff, textDiffView } from '../../parts/textdiff.js';

const memo = createMemo();
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const DEFAULT_CHOICES = { effort: ['low', 'medium', 'high', 'xhigh', 'max'], permissionMode: ['manual', 'plan', 'acceptEdits', 'auto'] };
const FIELD_PROBLEMS = ['rules', 'model', 'effort', 'permissionMode', 'allowedTools', 'assets'];

// ---------------------------------------------------------------- pure helpers (tested)

// The command that checks a project's profile from a terminal (run from the workspace root).
export const checkCommand = name => `node tools/workspace-app/profile/profile.mjs --check ${name}`;

// GET /api/project's profile part ({ exists, valid, errors, warnings, path }) as
// { state: 'valid' | 'invalid' | 'missing' | 'unknown', text, items }.
export function profileStatus(pr) {
  if (!pr || typeof pr !== 'object') return { state: 'unknown', text: 'Not loaded yet.', items: [] };
  if (!pr.exists) return { state: 'missing', text: 'No profile yet.', items: [] };
  const errors = Array.isArray(pr.errors) ? pr.errors.map(String) : [];
  const warnings = Array.isArray(pr.warnings) ? pr.warnings.map(String) : [];
  if (!pr.valid) return { state: 'invalid', text: `The profile has ${plural(errors.length, 'problem')}.`, items: errors };
  return { state: 'valid', text: warnings.length ? `Present and valid, with ${plural(warnings.length, 'warning')}.` : 'Present and valid.', items: warnings };
}

// ---------------------------------------------------------------- small DOM helpers

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// A field's problems in its list, the control marked invalid while there are any.
function setProblems(list, control, items) {
  const sig = JSON.stringify(items);
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.replaceChildren(...items.map(t => h('li', {}, t)));
  }
  list.hidden = !items.length;
  if (!control) return;
  if (items.length) control.setAttribute('aria-invalid', 'true');
  else control.removeAttribute('aria-invalid');
}

const problemList = id => h('ul', { class: 'st-problems', id, hidden: true });

function choiceSelect(id, values, words, describedBy) {
  const select = h('select', { id, 'aria-describedby': describedBy });
  fillChoices(select, values, words, '');
  return select;
}

// The options of a defaults select: "Your own default", the choices, and a stored value that is
// no longer one of them (so opening an old version never changes it silently).
function fillChoices(select, values, words, keep) {
  const list = [...values];
  if (keep && !list.includes(keep)) list.push(keep);
  select.replaceChildren(h('option', { value: '' }, 'Your own default'),
    ...list.map(v => h('option', { value: v }, values.includes(v) ? (words && words[v]) || v : `${v} (no longer offered)`)));
  select.value = keep || '';
}

// ---------------------------------------------------------------- the editor (one per project)

const editors = new Map(); // project -> editor; the draft lives here until it is saved or discarded
const detailVersions = new Map(); // "<ref>#<latest sha>" -> version numbers of an asset with gaps

const baseOf = current => ({
  version: current ? current.version : 0,
  savedAt: current ? current.savedAt : '',
  fields: tidyFields(fieldsOf(current)),
});

function readFields(ed) {
  return {
    rules: ed.rules.value, model: ed.model.value, effort: ed.effort.value, permissionMode: ed.mode.value,
    allowedTools: ed.tools.value, assets: ed.assets.map(a => ({ ref: a.ref, pin: a.pin })),
  };
}

const isDirty = ed => !sameFields(readFields(ed), ed.base.fields);

function setFields(ed, f) {
  ed.rules.value = f.rules;
  ed.model.value = f.model;
  fillChoices(ed.effort, ed.choices.effort, null, f.effort);
  fillChoices(ed.mode, ed.choices.permissionMode, PERMISSION_WORDS, f.permissionMode);
  ed.tools.value = f.allowedTools;
  ed.assets = f.assets.map(a => ({ ref: a.ref, pin: a.pin }));
}

// Back to a saved version: its values in the controls, nothing pending.
function rebase(ed, current) {
  ed.base = baseOf(current);
  setFields(ed, ed.base.fields);
  ed.conflict = null;
  ed.serverProblems = null;
  ed.error = '';
}

function makeEditor(name, d) {
  const id = s => `st-${s}-${name}`;
  const ed = {
    name, base: baseOf(d.current), limits: { ...DEFAULT_LIMITS, ...(d.limits || {}) },
    choices: { ...DEFAULT_CHOICES, ...(d.choices || {}) }, assets: [], rows: new Map(),
    conflict: null, serverProblems: null, error: '', saving: false, savedMark: 0, library: null, libraryError: '',
    resolved: { key: '', items: [], error: '' }, resolving: '', resolveTimer: 0,
  };
  ed.rules = h('textarea', {
    id: id('rules'), class: 'code-edit st-rules', rows: 16, spellcheck: 'false', 'aria-describedby': `${id('rules-help')} ${id('count')} ${id('rules-problems')}`,
    placeholder: 'For example:\n- Money is stored in cents, never as floats.\n- Every change to checkout gets a test first.\n- Ask before adding a dependency.',
  });
  ed.count = h('span', { class: 'st-count', id: id('count') });
  ed.model = h('input', {
    id: id('model'), list: id('models'), maxlength: 80, autocomplete: 'off', spellcheck: 'false', placeholder: 'Your own default (or opus, sonnet, …)',
    'aria-describedby': `${id('defaults-help')} ${id('model-problems')}`,
  });
  ed.effort = choiceSelect(id('effort'), ed.choices.effort, null, `${id('defaults-help')} ${id('effort-problems')}`);
  ed.mode = choiceSelect(id('mode'), ed.choices.permissionMode, PERMISSION_WORDS, `${id('defaults-help')} ${id('permissionMode-problems')}`);
  ed.tools = h('input', {
    id: id('tools'), class: 'mono', maxlength: 4000, autocomplete: 'off', spellcheck: 'false', placeholder: 'Read, Grep, Bash(npm test:*)',
    'aria-describedby': `${id('tools-help')} ${id('allowedTools-problems')}`,
  });
  ed.problems = Object.fromEntries(FIELD_PROBLEMS.map(k => [k, problemList(id(`${k}-problems`))]));
  ed.assetList = h('ul', { class: 'st-assets', 'aria-label': 'Attached assets' });
  ed.assetEmpty = h('p', { class: 'muted small st-assets-empty' }, 'No assets attached.');
  ed.assetNote = h('p', { class: 'muted small', hidden: true });
  ed.attachBtn = btn(`st:attach:${name}`, 'Attach…', () => openPicker(ed), { describedBy: id('attach-why') });
  ed.attachWhy = h('span', { class: 'reason', id: id('attach-why') });
  ed.assetCount = h('span', { class: 'muted small' });
  ed.head = h('span', { class: 'muted small' });
  ed.conflictText = h('span', {});
  ed.conflictBox = h('div', { class: 'note red st-conflict', role: 'alert', hidden: true }, ed.conflictText,
    h('div', { class: 'row-actions' },
      btn(`st:reload:${name}`, 'Reload', () => reloadLatest(ed), { cls: 'btn small primary', title: 'Loads the current version; your changes go' }),
      btn(`st:compare-mine:${name}`, 'Compare', () => compareWithMine(ed), { title: 'Shows the current version next to your changes' }),
      btn(`st:copy-rules:${name}`, 'Copy my rules', () => copyRules(ed), { title: 'Puts the rules you typed on the clipboard' })));
  ed.errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
  ed.status = h('span', { class: 'st-status', 'aria-live': 'polite' });
  ed.why = h('span', { class: 'reason', id: id('save-why') });
  ed.discardBtn = btn(`st:discard:${name}`, 'Discard changes', () => discard(ed), { cls: 'btn' });
  ed.saveBtn = btn(`st:save:${name}`, 'Save', () => save(ed), { cls: 'btn primary', describedBy: id('save-why'), title: 'Saves a new version (Ctrl+S)' });

  setFields(ed, ed.base.fields);
  const onInput = () => { ed.serverProblems = null; ed.error = ''; sync(ed); };
  for (const c of [ed.rules, ed.model, ed.tools]) c.addEventListener('input', onInput);
  for (const c of [ed.effort, ed.mode]) c.addEventListener('change', onInput);

  ed.card = h('div', { class: 'card st-editor', on: { keydown: e => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(ed); } } } },
    cardHead('Rules and settings', ed.head),
    h('div', { class: 'card-body form st-form' },
      h('div', { class: 'st-block' },
        h('label', { for: id('rules'), class: 'st-label' }, 'Rules'),
        h('p', { class: 'muted small', id: id('rules-help') }, 'Markdown, kept as plain text: Claude reads it as you write it, after the project\'s CLAUDE.md. Say what to always or never do here, and why.'),
        ed.rules,
        h('div', { class: 'st-rules-foot' }, ed.count),
        ed.problems.rules),
      h('fieldset', { class: 'st-block st-defaults' },
        h('legend', {}, 'Defaults'),
        h('p', { class: 'muted small', id: id('defaults-help') }, 'Empty means your own default. A flow\'s own settings win over these.'),
        h('div', { class: 'st-defaults-grid' },
          h('label', { for: id('model') }, 'Model', ed.model, h('datalist', { id: id('models') }, MODELS.map(m => h('option', { value: m }))), ed.problems.model),
          h('label', { for: id('effort') }, 'Effort', ed.effort, ed.problems.effort),
          h('label', { for: id('mode') }, 'Permission mode', ed.mode, ed.problems.permissionMode))),
      h('div', { class: 'st-block' },
        h('label', { for: id('tools'), class: 'st-label' }, 'Pre-approved tools'),
        h('p', { class: 'muted small', id: id('tools-help') }, 'Allowed without asking in every session here, after a flow\'s own (20 at most together). The rules of a flow: Read, Grep, Bash(npm test:*).'),
        ed.tools,
        ed.problems.allowedTools),
      h('div', { class: 'st-block' },
        h('div', { class: 'st-assets-head' }, h('span', { class: 'st-label' }, 'Attached assets'), ed.assetCount,
          h('span', { class: 'row-actions' }, ed.attachWhy, ed.attachBtn)),
        h('p', { class: 'muted small' }, 'Saved with each version: each follows its latest version or stays pinned to one. Runs, sessions and flows started here get them in those versions (a run copies them into its inputs). A missing one stops the start; an archived one is still used.'),
        ed.assetList, ed.assetEmpty, ed.assetNote, ed.problems.assets),
      h('div', { class: 'st-alerts' }, ed.conflictBox, ed.errorBox)),
    h('div', { class: 'card-foot st-foot' }, ed.status, h('span', { class: 'push row-actions' }, ed.why, ed.discardBtn, ed.saveBtn)));
  return ed;
}

function editorFor(name, d) {
  if (!editors.has(name)) editors.set(name, makeEditor(name, d));
  return editors.get(name);
}

// True when the settings part `S` shows an older version than the editor's from a request that
// left before the editor's last save (project-data.js requestMark): versions only grow, so that is
// the request being late, not news, and it is passed over.
function isLate(ed, S) {
  const d = dataOf(S);
  const v = d && d.current ? d.current.version : 0;
  return v < ed.base.version && ((S && S.asked) || 0) <= ed.savedMark;
}

// New data for an open editor (`S`, the settings part): the limits and the library; another
// current version replaces a clean editor's values, and marks a dirty one as behind (a save would
// be refused); that mark goes again once the current version is the editor's own again.
function syncData(ed, S, library) {
  const d = dataOf(S);
  ed.limits = { ...DEFAULT_LIMITS, ...(d.limits || {}) };
  if (library) {
    ed.library = dataOf(library) ? dataOf(library).assets || [] : ed.library;
    ed.libraryError = library.error && !dataOf(library) ? library.error : '';
  }
  const cur = d.current || null;
  const v = cur ? cur.version : 0;
  if (ed.saving || isLate(ed, S)) { /* nothing to learn from it */ } else if (v !== ed.base.version) {
    if (!isDirty(ed)) rebase(ed, cur);
    else if (!ed.conflict) {
      ed.conflict = { fromRefresh: true, message: v ? `v${v} of these settings was saved elsewhere since you opened ${ed.base.version ? `v${ed.base.version}` : 'them'}, so a save now would be refused.`
        : `The settings you opened (v${ed.base.version}) are gone from the data folder, so a save now would be refused.` };
    }
  } else {
    if (cur) ed.base.savedAt = cur.savedAt;
    if (ed.conflict && ed.conflict.fromRefresh) ed.conflict = null;
  }
  sync(ed);
}

// Everything the editor shows that depends on its state, written in place.
function sync(ed) {
  const f = readFields(ed);
  const count = rulesCount(f.rules, ed.limits.rules);
  setText(ed.count, count.text);
  ed.count.className = `st-count ${count.state}`;
  const mine = checkFields(f, ed.limits, ed.choices);
  const server = ed.serverProblems || {};
  const controls = { rules: ed.rules, model: ed.model, effort: ed.effort, permissionMode: ed.mode, allowedTools: ed.tools, assets: null };
  for (const k of FIELD_PROBLEMS) setProblems(ed.problems[k], controls[k], [...mine[k], ...(server[k] || []).filter(t => !mine[k].includes(t))]);
  const other = [...(server.other || []), ed.error].filter(Boolean);
  setText(ed.errorBox, other.join(' '));
  ed.errorBox.hidden = !other.length;

  setText(ed.head, ed.base.version ? `v${ed.base.version}${ed.base.savedAt ? `, saved ${fmtAgo(ed.base.savedAt)}` : ''}` : 'Nothing saved yet: the first save makes v1');
  ed.head.title = ed.base.savedAt ? fmtTime(ed.base.savedAt) : '';
  const dirty = isDirty(ed);
  // The server's 409 ends with "Reload them, then save again."; the buttons below say how.
  const said = ed.conflict ? ed.conflict.message.replace(/\s*Reload them, then save again\.\s*$/, '') : '';
  setText(ed.conflictText, ed.conflict ? `${said} What you typed stays here until you choose: Reload loads the current version and drops your changes; Compare shows the two side by side.` : '');
  ed.conflictBox.hidden = !ed.conflict;
  const blocked = problemCount(mine) > 0;
  setText(ed.status, ed.saving ? 'Saving…' : dirty ? 'Unsaved changes' : ed.base.version ? `Saved as v${ed.base.version}` : 'Nothing saved yet');
  ed.status.classList.toggle('dirty', dirty && !ed.saving);
  setText(ed.why, ed.conflict ? 'Reload first.' : blocked && dirty ? 'Fix the marked fields first.' : '');
  ed.saveBtn.disabled = ed.saving || !dirty || !!ed.conflict || blocked;
  ed.discardBtn.disabled = ed.saving || !dirty;
  renderAssets(ed);
}

// ---------------------------------------------------------------- attached assets

const libEntry = (ed, ref) => (ed.library || []).find(a => a && a.ref === ref) || null;
const resolvedItem = (ed, ref) => (ed.resolved.items || []).find(i => i && i.ref === ref) || null;

// The version numbers to offer for an attached asset, or null while they are unknown (an asset
// with gaps in its numbers is asked for once).
function versionsFor(ed, ref) {
  const entry = libEntry(ed, ref);
  if (!entry || !entry.latest) return null;
  const quick = versionNumbers(entry);
  if (quick) return quick;
  const key = `${ref}#${entry.latest.sha256}`;
  if (!detailVersions.has(key)) {
    detailVersions.set(key, null);
    getAsset(ref).then(r => { detailVersions.set(key, versionNumbers(r.asset)); renderAssets(ed); }, () => detailVersions.delete(key));
  }
  return detailVersions.get(key);
}

function makeRow(ed, ref) {
  const row = { ref, sig: '' };
  row.icon = h('span', { class: 'st-asset-icon', 'aria-hidden': 'true' });
  row.title = h('span', { class: 'title' });
  row.sub = h('span', { class: 'sub' });
  row.badges = h('span', { class: 'row-actions st-asset-badges' });
  row.select = keyed(h('select', {
    class: 'st-pin',
    on: {
      change: () => {
        const a = ed.assets.find(x => x.ref === ref);
        if (a) a.pin = row.select.value ? Number(row.select.value) : null;
        ed.serverProblems = null;
        sync(ed);
        resolveSoon(ed);
      },
    },
  }), `st:pin:${ref}`);
  row.remove = keyed(h('button', { class: 'btn small ghost', type: 'button', on: { click: () => removeAsset(ed, ref) } }, 'Remove'), `st:rm:${ref}`);
  row.el = h('li', { class: 'st-asset' }, row.icon, h('span', { class: 'main' }, row.title, row.sub), row.badges, row.select, row.remove);
  return row;
}

function updateRow(ed, row, a) {
  const item = resolvedItem(ed, a.ref);
  const entry = libEntry(ed, a.ref);
  const title = (item && item.title) || (entry && entry.title) || a.ref;
  const kind = (item && item.kind) || (entry && entry.kind) || '';
  const latest = entry && entry.latest ? entry.latest.n : null;
  const versions = versionsFor(ed, a.ref) || [];
  if (row.kind !== kind) { row.kind = kind; row.icon.replaceChildren(kindIcon(kind || 'broken')); }
  setText(row.title, title);
  const uses = item && !item.missing && item.version ? `uses v${item.version}` : '';
  setText(row.sub, [title === a.ref ? '' : a.ref, kind ? kindWord(kind) : '', uses].filter(Boolean).join(' · '));
  const badges = attachmentBadges(item);
  const bsig = JSON.stringify(badges);
  if (row.bsig !== bsig) {
    row.bsig = bsig;
    row.badges.replaceChildren(...badges.map(b => h('span', { class: `badge ${b.cls}`, title: b.title }, b.text)));
  }
  // The options change only when the versions do, so a select in use keeps its focus.
  const pinned = Number.isSafeInteger(a.pin) && !versions.includes(a.pin) ? a.pin : null;
  const sig = JSON.stringify([latest, versions, pinned]);
  if (row.sig !== sig) {
    row.sig = sig;
    row.select.replaceChildren(...[h('option', { value: '' }, pinWords(null, latest)),
      ...versions.map(n => h('option', { value: String(n) }, `v${n}`)),
      pinned ? h('option', { value: String(pinned) }, `v${pinned} (not there)`) : null].filter(Boolean));
  }
  const want = Number.isSafeInteger(a.pin) ? String(a.pin) : '';
  if (row.select.value !== want) row.select.value = want;
  row.select.setAttribute('aria-label', `Version of ${title}`);
  row.remove.setAttribute('aria-label', `Remove ${title}`);
}

function renderAssets(ed) {
  for (const ref of [...ed.rows.keys()]) if (!ed.assets.some(a => a.ref === ref)) ed.rows.delete(ref);
  const nodes = ed.assets.map(a => {
    if (!ed.rows.has(a.ref)) ed.rows.set(a.ref, makeRow(ed, a.ref));
    const row = ed.rows.get(a.ref);
    updateRow(ed, row, a);
    return row.el;
  });
  patch(ed.assetList, nodes);
  ed.assetList.hidden = !nodes.length;
  ed.assetEmpty.hidden = nodes.length > 0;
  setText(ed.assetCount, nodes.length ? `${nodes.length} of at most ${ed.limits.assets}` : '');
  const note = ed.resolved.error ? `Their state could not be checked: ${ed.resolved.error}` : ed.libraryError ? `The library could not be read: ${ed.libraryError}` : '';
  setText(ed.assetNote, note);
  ed.assetNote.hidden = !note;
  const full = ed.assets.length >= ed.limits.assets;
  const why = full ? `At most ${ed.limits.assets} can be attached.` : !ed.library ? 'Loading the library…' : '';
  setText(ed.attachWhy, why);
  ed.attachBtn.disabled = !!why;
}

// Asks the server what each attachment points to, once per list (and library answer); the rows
// show the answer when it arrives.
function resolveSoon(ed) {
  const list = ed.assets.map(a => ({ ref: a.ref, pin: a.pin }));
  const key = JSON.stringify([list, (ed.library || []).map(a => [a.ref, a.latest && a.latest.n, a.archived])]);
  if (key === ed.resolved.key || key === ed.resolving) return;
  clearTimeout(ed.resolveTimer);
  if (!list.length) { ed.resolved = { key, items: [], error: '' }; renderAssets(ed); return; }
  ed.resolving = key;
  ed.resolveTimer = setTimeout(async () => {
    let next;
    try { next = { key, items: (await resolveAttachments(ed.name, list)).items || [], error: '' }; } catch (e) { next = { key, items: [], error: e.message }; }
    if (ed.resolving !== key) return; // a newer list was asked for meanwhile
    ed.resolving = '';
    ed.resolved = next;
    renderAssets(ed);
  }, 120);
}

function removeAsset(ed, ref) {
  const i = ed.assets.findIndex(a => a.ref === ref);
  if (i < 0) return;
  const hadFocus = ed.rows.has(ref) && ed.rows.get(ref).el.contains(document.activeElement);
  ed.assets.splice(i, 1);
  ed.serverProblems = null;
  sync(ed);
  resolveSoon(ed);
  if (!hadFocus) return;
  const next = ed.assets[i] || ed.assets[i - 1];
  (next && ed.rows.has(next.ref) ? ed.rows.get(next.ref).remove : ed.attachBtn).focus();
}

function openPicker(ed) {
  assetPicker({
    project: ed.name, assets: ed.library || [], attached: ed.assets.map(a => a.ref), limit: ed.limits.assets,
    onAttach: async refs => {
      for (const ref of refs) if (!ed.assets.some(a => a.ref === ref)) ed.assets.push({ ref, pin: null });
      ed.serverProblems = null;
      sync(ed);
      resolveSoon(ed);
      toast(`${plural(refs.length, 'asset')} attached; save to keep ${refs.length === 1 ? 'it' : 'them'}`);
    },
  });
}

// ---------------------------------------------------------------- saving

async function save(ed) {
  if (ed.saveBtn.disabled) return;
  ed.saving = true;
  ed.serverProblems = null;
  ed.error = '';
  sync(ed);
  const fields = readFields(ed);
  try {
    const r = await api('/api/project-settings', { method: 'POST', body: saveBody(ed.name, ed.base.version, fields) });
    ed.base = { version: r.version, savedAt: r.unchanged ? ed.base.savedAt : new Date().toISOString(), fields: tidyFields(fields) };
    ed.savedMark = requestMark();
    ed.conflict = null;
    toast(r.message || `Saved as v${r.version}`);
    reload(ed.name);
  } catch (e) {
    if (e.status === 409) { ed.conflict = { message: e.message }; reload(ed.name); }
    else if (e.status === 400) ed.serverProblems = splitProblems(e.message);
    else ed.error = e.network ? 'The app server could not be reached; nothing was saved.' : e.message;
  }
  ed.saving = false;
  sync(ed);
}

// Discard changes: back to the version the editor opened, or to a newer one that came meanwhile.
function discard(ed) {
  if (!isDirty(ed) || !confirm(`Discard your changes to the settings of ${ed.name}?`)) return;
  setFields(ed, ed.base.fields);
  ed.serverProblems = null;
  ed.error = '';
  const S = slot(ed.name).settings;
  const d = dataOf(S);
  if (d && !isLate(ed, S) && (d.current ? d.current.version : 0) !== ed.base.version) rebase(ed, d.current);
  sync(ed);
  resolveSoon(ed);
}

// Reload in the conflict note: the current version replaces the draft. reload() resolves with an
// answer to a request made after the click (one already out may predate the newest save).
async function reloadLatest(ed) {
  await reload(ed.name);
  const S = slot(ed.name).settings;
  const d = dataOf(S);
  if (!d || S.error) { toast(S && S.error ? `The settings could not be loaded: ${S.error}` : 'The settings could not be loaded; try again.', true); return; }
  rebase(ed, d.current);
  sync(ed);
  resolveSoon(ed);
  toast(d.current ? `Loaded v${d.current.version}` : 'Loaded: nothing is saved now');
  ed.rules.focus();
}

async function compareWithMine(ed) {
  await reload(ed.name);
  const d = dataOf(slot(ed.name).settings);
  const cur = d ? d.current : null;
  compareDialog(ed.name, { label: cur ? `v${cur.version} (current)` : 'Nothing saved', fields: fieldsOf(cur) }, { label: 'Your changes', fields: readFields(ed) });
}

function copyRules(ed) {
  const text = ed.rules.value;
  if (!navigator.clipboard) { copy(text); return; }
  navigator.clipboard.writeText(text).then(() => toast('Your rules are on the clipboard'), () => toast('Could not copy to the clipboard', true));
}

// ---------------------------------------------------------------- versions: list, view, compare

const versionCache = new Map(); // "<project>@<v>#<sha>" -> Promise of that version (they never change)

function fetchVersion(name, v) {
  const key = `${name}@${v.version}#${v.sha256}`;
  if (!versionCache.has(key)) {
    const p = api(`/api/project-settings/version?project=${encodeURIComponent(name)}&v=${v.version}`).then(r => r.settings);
    p.catch(() => versionCache.delete(key));
    versionCache.set(key, p);
  }
  return versionCache.get(key);
}

const emptyWord = (key, value) => value || (key === 'allowedTools' ? 'None' : key === 'assets' ? 'None' : 'Your own default');

function settingsFacts(f) {
  return h('dl', { class: 'facts' },
    [['Model', emptyWord('model', f.model)], ['Effort', emptyWord('effort', f.effort)],
      ['Permission mode', f.permissionMode ? PERMISSION_WORDS[f.permissionMode] || f.permissionMode : 'Your own default'],
      ['Pre-approved tools', emptyWord('allowedTools', f.allowedTools)]].map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

async function viewVersion(name, v, current) {
  let s;
  try { s = await fetchVersion(name, v); } catch (e) { toast(e.message, true); return; }
  const f = tidyFields(fieldsOf(s));
  const isCurrent = current && current.version === s.version;
  const body = h('div', { class: 'st-view' },
    h('dl', { class: 'facts' },
      h('dt', {}, 'Saved'), h('dd', {}, s.savedAt ? `${fmtTime(s.savedAt)} (${fmtAgo(s.savedAt)})` : 'Unknown'),
      h('dt', {}, 'Based on'), h('dd', {}, s.basedOn ? `v${s.basedOn}` : 'Nothing: the first version'),
      h('dt', {}, 'SHA-256'), h('dd', {}, h('code', {}, s.sha256))),
    h('div', { class: 'section-label' }, h('span', {}, 'Rules')),
    f.rules ? h('pre', { class: 'st-rules-view', tabindex: '0', 'aria-label': `Rules of v${s.version}` }, f.rules) : h('p', { class: 'muted' }, 'No rules.'),
    h('div', { class: 'section-label' }, h('span', {}, 'Defaults and tools')),
    settingsFacts(f),
    h('div', { class: 'section-label' }, h('span', {}, 'Attached assets')),
    f.assets.length ? h('ul', { class: 'st-view-assets' }, f.assets.map(a => h('li', {}, h('code', {}, a.ref), ` · ${pinText(a.pin)}`)))
      : h('p', { class: 'muted' }, 'None.'));
  openDialog(`Settings v${s.version} of ${name}${isCurrent ? ' (current)' : ''}`, body, {
    wide: true,
    actions: [
      !isCurrent && current ? h('button', { class: 'btn', type: 'button', on: { click: () => compareVersions(name, v, current) } }, `Compare with v${current.version}`) : null,
      h('button', { class: 'btn primary', type: 'button', on: { click: closeDialog } }, 'Close'),
    ].filter(Boolean),
  });
  dialog.classList.add('st-dialog');
}

async function compareVersions(name, from, to) {
  let a;
  let b;
  try { [a, b] = await Promise.all([fetchVersion(name, from), fetchVersion(name, to)]); } catch (e) { toast(e.message, true); return; }
  compareDialog(name, { label: `v${a.version}`, fields: fieldsOf(a) }, { label: `v${b.version}`, fields: fieldsOf(b) });
}

const CHANGE_WORDS = {
  added: c => `Attached ${c.ref} (${pinText(c.after)})`,
  removed: c => `Removed ${c.ref}`,
  pin: c => `${c.ref}: ${pinText(c.before)} to ${pinText(c.after)}`,
};

// Two sets of fields side by side: the rules as a line diff, the rest field by field.
function compareDialog(name, a, b) {
  const x = tidyFields(a.fields);
  const y = tidyFields(b.fields);
  const diff = lineDiff(x.rules, y.rules);
  const rows = fieldDiff(x, y);
  const changes = assetChanges(x, y);
  const body = h('div', { class: 'st-compare' },
    h('div', { class: 'section-label' }, h('span', {}, `Rules, ${a.label} to ${b.label}`), h('span', {}, diffSummary(diff))),
    diff.added || diff.removed
      ? [diff.approximate ? h('p', { class: 'note' }, 'The rules differ in too many lines to match them up; the old lines show as removed and the new ones as added.') : null,
        textDiffView(diff, { label: `Rules, ${a.label} to ${b.label}` })]
      : h('p', { class: 'muted' }, 'The rules are the same.'),
    h('div', { class: 'section-label' }, h('span', {}, 'Other settings')),
    h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable st-fields' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Setting'), h('th', { scope: 'col' }, a.label), h('th', { scope: 'col' }, b.label))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.changed ? 'changed' : null },
        h('th', { scope: 'row' }, r.label, r.changed ? h('span', { class: 'badge amber' }, 'changed') : null),
        h('td', {}, r.key === 'permissionMode' && r.before ? PERMISSION_WORDS[r.before] || r.before : emptyWord(r.key, r.before)),
        h('td', {}, r.key === 'permissionMode' && r.after ? PERMISSION_WORDS[r.after] || r.after : emptyWord(r.key, r.after))))))),
    changes.length ? h('ul', { class: 'st-changes' }, changes.map(c => h('li', {}, CHANGE_WORDS[c.change](c)))) : null);
  openDialog(`Compare ${a.label} with ${b.label} · ${name}`, body, {
    wide: true, actions: [h('button', { class: 'btn primary', type: 'button', on: { click: closeDialog } }, 'Close')],
  });
  dialog.classList.add('st-dialog');
}

function versionRow(name, v, current, previous) {
  const isCurrent = current && v.version === current.version;
  const when = v.savedAt ? h('time', { datetime: v.savedAt, title: fmtTime(v.savedAt) }, `Saved ${fmtAgo(v.savedAt)}`) : null;
  return h('li', { class: v.problem ? 'st-broken' : null },
    h('div', { class: 'main' },
      h('div', { class: 'title' }, `v${v.version}`, isCurrent ? [' ', h('span', { class: 'badge ok' }, 'current')] : null),
      v.problem ? h('div', { class: 'sub wrap text-red' }, v.problem)
        : h('div', { class: 'sub' }, when, ' · ', h('code', { title: v.sha256 }, short(v.sha256)), v.basedOn ? ` · based on v${v.basedOn}` : ' · the first')),
    v.problem ? null : h('div', { class: 'row-actions' },
      btn(`st:view:${v.version}`, 'View', () => viewVersion(name, v, current), { ariaLabel: `View v${v.version}` }),
      !isCurrent && current ? btn(`st:cmp:${v.version}`, `Compare with v${current.version}`, () => compareVersions(name, v, current)) : null,
      isCurrent && previous ? btn(`st:cmp:${v.version}`, `Compare with v${previous.version}`, () => compareVersions(name, previous, v)) : null));
}

function versionsCard(name, d) {
  const versions = Array.isArray(d.versions) ? d.versions : [];
  const current = d.current ? versions.find(v => v.version === d.current.version) || null : null;
  return memo(`versions:${name}`, [versions, current && current.version, minute()], () => {
    const head = cardHead('Versions', h('span', { class: 'muted small' }, 'every save is a new version; none is ever changed'));
    if (!versions.length) return h('div', { class: 'card' }, head, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'No versions yet. The first save makes v1.')));
    const previous = versions.find(v => current && v.version < current.version && !v.problem) || null;
    return h('div', { class: 'card st-versions' }, head, h('div', { class: 'card-body' },
      h('ul', { class: 'list' }, versions.map(v => versionRow(name, v, current, previous)))));
  });
}

// ---------------------------------------------------------------- the cards around the editor

function whereNote() {
  return memo('where', [], () => h('div', { class: 'note info st-where' },
    h('b', {}, 'Where these apply: '),
    'every Claude stage of runs in this project (a run keeps the version it started with) and every session the app starts here: Start Claude here, skills, flows and agents. Hub sessions get none.'));
}

function settingsNodes(name) {
  const S = slot(name).settings;
  const d = dataOf(S);
  if (!d) {
    return [memo(`load:${name}`, [S ? S.error : ''], () => h('div', { class: 'card' }, cardHead('Rules and settings'),
      S && S.error ? h('div', { class: 'card-body' }, errorNote(S.error, 'settings')) : loadingBody()))];
  }
  const ed = editorFor(name, d);
  syncData(ed, S, slot(name).library);
  resolveSoon(ed);
  return [
    S.error ? memo(`stale:${name}`, [S.error], () => errorNote(`The settings could not be loaded again: ${S.error}`, 'settings')) : null,
    ed.card,
    versionsCard(name, d),
  ];
}

function codeProfileCard(name, P) {
  const d = dataOf(P);
  const st = profileStatus(d && d.profile);
  return memo(`profile:${name}`, [st, d && d.profile && d.profile.path, P && P.error], () => {
    const head = cardHead('Profile', h('span', { class: 'muted small' }, 'private: in the data folder, never in the hub'));
    if (!d) return h('div', { class: 'card' }, head, P && P.error ? h('div', { class: 'card-body' }, errorNote(P.error, 'project')) : loadingBody());
    const cls = st.state === 'valid' ? 'ok' : st.state === 'invalid' ? 'red' : 'amber';
    const word = { valid: 'Valid', invalid: 'Has problems', missing: 'Missing', unknown: 'Unknown' }[st.state];
    const path = d.profile && d.profile.path;
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body vgrid' },
      h('p', {}, h('span', { class: `badge ${cls}` }, word), ' ', st.text),
      path ? h('p', { class: 'mono st-path' }, path) : null,
      st.items.length ? h('ul', { class: st.state === 'invalid' ? 'st-items errors' : 'st-items' }, st.items.map(t => h('li', {}, t))) : null,
      st.state === 'missing' ? h('div', {}, btn('st:create', 'Create from the example', () => createProfile(name), { cls: 'btn small primary' })) : null,
      h('div', { class: 'st-check' },
        h('p', { class: 'muted small' }, 'Check it from a terminal in the workspace folder:'),
        h('div', { class: 'row-actions' }, h('code', { class: 'st-command' }, checkCommand(name)),
          btn('st:copy', 'Copy', () => copy(checkCommand(name)), { title: 'Copies the command' })))));
  });
}

// An asset or plain project: what a profile would add, and the button that makes one.
function otherProfileCard(p) {
  const valid = DATA_NAME_RE.test(p.name);
  return memo(`profile-other:${p.name}`, [valid], () => h('div', { class: 'card' },
    cardHead('Profile', h('span', { class: 'muted small' }, 'private: in the data folder, never in the hub')),
    h('div', { class: 'card-body vgrid' },
      h('p', {}, 'No profile. With one, this becomes a code project: runs, checks, findings and architecture scans work for it, in the Tasks, Findings, Changes, Checks and Architecture tabs.'),
      valid
        ? h('div', {}, btn('st:create', 'Create from the example', () => createProfile(p.name), { cls: 'btn small primary' }),
          h('p', { class: 'muted small mt-2' }, 'It starts from the synthetic example; replace its values with the project\'s own.'))
        : h('p', { class: 'note' }, 'A profile needs a lowercase folder name (letters, digits and single hyphens).'))));
}

// ---------------------------------------------------------------- the tab

const isCode = p => !!(p && p.type && p.type.id === 'code');
let release = () => {};

export default {
  id: 'settings',
  label: 'Settings',
  render(el, ctx) {
    const p = ctx.project;
    const named = DATA_NAME_RE.test(p.name);
    patch(el, [
      named ? whereNote() : null,
      ...(named ? settingsNodes(p.name) : [memo(`noname:${p.name}`, [], () => stateCard('No settings for this folder name',
        `The app keeps settings only for projects whose folder name is lowercase letters, digits and single hyphens; projects/${p.name} is not. Rename the folder to give it settings.`))]),
      isCode(p) ? codeProfileCard(p.name, slot(p.name).project) : otherProfileCard(p),
    ]);
  },
  onShow(ctx) {
    release();
    const p = ctx.project;
    const named = DATA_NAME_RE.test(p.name);
    release = use(p.name, [...(named ? ['settings', 'library'] : []), ...(isCode(p) ? ['project'] : [])]);
    clearLeaveGuard();
    if (!named) return;
    setLeaveGuard({
      hash: projectHash(p.name, 'settings', ctx.rest),
      dirty: () => { const ed = editors.get(p.name); return !!ed && isDirty(ed); },
      message: `Discard your unsaved changes to the settings of ${p.name}?`,
      onDiscard: () => editors.delete(p.name),
    });
  },
  onHide() {
    release();
    release = () => {};
    clearLeaveGuard();
  },
};
