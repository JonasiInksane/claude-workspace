// The launcher (#launcher/<pipeline>, SPEC 5.5; mockup #v-launcher): the form that starts a
// pipeline run in store.currentProject. Pills pick the pipeline; the big question is the
// pipeline's `ask` (its first field); the other fields follow, the advanced ones inside Options
// with a one-line summary. While you type, POST /api/runs { preview: true } (debounced 350 ms)
// fills the exact prompt of the first stage, what the run will do (stages marked Code, Claude or
// You), what it cannot do, its limits and where it runs. The server's refusals show as notes and
// turn Start off, with the reason as visible text next to the button. Start (or Ctrl+Enter, once
// a preview has loaded) posts the same values without `preview` and opens #run/<id>; an error is
// a toast and the form stays.
//
// The shell renders the view on every store change, so the form is kept: it is rebuilt only when
// the pipeline, the project or the pipeline's definition changes, and the values live here per
// project and pipeline (leaving and coming back keeps them). A draft handed over by the intent
// box, the palette or a project's page (store.launchDraft) starts a fresh form with its text and
// finding filled in.
//
// Special fields: a finding picker (open findings in the order Next up picks them, from GET
// /api/findings), a path field with suggestions (GET /api/project `paths`) and an image picker
// (the newest 40 images under inbox/attachments). The server checks every value again
// (runs/catalog.mjs checkValues): nothing here decides what may run.
import { api, fmtAgo, h, keepFocus, keyed, toast } from '../lib.js';
import {
  clearLaunchDraft, currentProject, go, goProject, hashFor, launchDraft, loadPipelines, pipelines, state, sub as routeSub, view,
} from '../store.js';

// ---------------------------------------------------------------- pure helpers (tested)

export const PIPELINE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LEVELS = ['quick', 'standard', 'paranoid'];
export const IMAGES_MAX = 40;
export const DEBOUNCE_MS = 350;
// The same rule as runs/catalog.mjs IMAGE_RE: an image under inbox/attachments a run accepts.
const IMAGE_RE = /^[A-Za-z0-9 _.()-]+(?:\/[A-Za-z0-9 _.()-]+)*\.(?:png|jpe?g|gif|webp)$/i;
const ATTACHMENTS = 'inbox/attachments/';
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const BLAST_RANK = { small: 0, medium: 1, large: 2 };
const asList = x => (Array.isArray(x) ? x : []);

// Fields that matter only for some values of another field. The server clears them otherwise
// (catalog.mjs crossCheck), so they are hidden here and sent empty.
const SHOWN_WHEN = {
  'review.n': v => v.target === 'last',
  'review.branch': v => v.target === 'app',
  'architecture.commit': v => v.compare === 'commit',
};
export function fieldShown(pipelineId, key, values = {}) {
  const rule = SHOWN_WHEN[`${pipelineId}.${key}`];
  return rule ? !!rule(values || {}) : true;
}

// "How careful?": a select whose options are exactly the three check levels (care, level).
export const isLevelField = f => !!f && f.kind === 'select' && asList(f.options).length === LEVELS.length
  && f.options.every(o => LEVELS.includes(o[0]));

export function defaultValue(f) {
  if (f.kind === 'multi') return Array.isArray(f.default) ? [...f.default] : [];
  if (f.kind === 'bool') return f.default === true;
  return f.default == null ? '' : String(f.default);
}
export function defaultValues(def) {
  const out = {};
  for (const f of asList(def && def.fields)) out[f.key] = defaultValue(f);
  return out;
}

const isText = f => !!f && (f.kind === 'textarea' || f.kind === 'text');
// The free-text request field (`what`), or null (Fix, Review, Check and Architecture have none).
export const whatField = def => asList(def && def.fields).find(f => f.key === 'what' && isText(f)) || null;
// Where typed text from the intent box goes: `what`, else the first textarea (Fix: its notes).
export const textTarget = def => whatField(def) || asList(def && def.fields).find(f => f.kind === 'textarea') || null;

// A fresh form from a draft ({ what, findingId }): { values, unused }. `unused` is text that no
// field takes (Review, Check, Architecture), shown under the question so it isn't lost silently.
// "fix EX-3" says nothing beyond the finding it picks, so it doesn't go into the notes.
export function draftValues(def, draft = {}) {
  const values = defaultValues(def);
  let text = String((draft && draft.what) || '').trim().slice(0, 2000);
  const finding = asList(def && def.fields).find(f => f.kind === 'finding');
  const id = String((draft && draft.findingId) || '');
  if (finding && id) {
    values[finding.key] = id;
    const rest = text.split(id).join(' ').replace(/\b(?:fix|close|finding)\b/gi, '').replace(/[\s.,:;!?-]+/g, '');
    if (!rest) text = '';
  }
  if (!text) return { values, unused: '' };
  const target = textTarget(def);
  if (!target) return { values, unused: text };
  values[target.key] = text.slice(0, target.max || 2000);
  return { values, unused: '' };
}

// What goes to POST /api/runs: every field of the pipeline, hidden ones empty.
export function valuesToSend(def, values = {}) {
  const out = {};
  for (const f of asList(def && def.fields)) {
    if (!fieldShown(def.id, f.key, values)) out[f.key] = f.kind === 'multi' ? [] : f.kind === 'bool' ? false : '';
    else out[f.key] = values[f.key] === undefined ? defaultValue(f) : values[f.key];
  }
  return out;
}

export const isMissing = (f, v) => !!f && !!f.required
  && (f.kind === 'multi' ? !asList(v).length : !String(v == null ? '' : v).trim());

// The sentence for an empty required question.
export function missingText(f) {
  if (!f) return '';
  if (f.kind === 'finding') return 'Pick a finding first.';
  if (isText(f)) return 'Say what you want first.';
  return `${f.label} needs an answer.`;
}

const optionLabel = (f, v) => (asList(f.options).find(o => o[0] === v) || [])[1] || '';
function displayValue(f, v) {
  if (f.kind === 'multi') {
    const list = asList(v);
    const total = asList(f.options).length;
    if (total > 3) return `${list.length} of ${total}`;
    return list.length ? list.map(x => optionLabel(f, x) || x).join(', ') : 'none';
  }
  if (f.kind === 'bool') return v ? 'yes' : 'no';
  if (f.kind === 'select') return optionLabel(f, v) || 'not set';
  const s = String(v == null ? '' : v).trim();
  if (!s) return f.kind === 'path' ? 'Claude finds it' : 'not set';
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

// The line next to "Options": "Where: Claude finds it · Kind: Auto · Standard · Keep out: not set".
export function optionsSummary(def, values = {}) {
  const parts = [];
  for (const f of asList(def && def.fields)) {
    if (!f.advanced || !fieldShown(def.id, f.key, values)) continue;
    parts.push(isLevelField(f) ? optionLabel(f, values[f.key]) || 'Standard' : `${f.label}: ${displayValue(f, values[f.key])}`);
  }
  return parts.join(' · ');
}

// Open findings in the order Next up picks them (findings/store.mjs rankOpen): owner decisions
// last, then highest severity, smallest blast radius, earliest phase, audit order.
export function rankOpenFindings(doc) {
  const findings = asList(doc && doc.findings);
  const order = new Map();
  asList(doc && doc.phases).forEach((p, i) => order.set(String(p && p.id), i));
  const phaseAt = id => (id === null || id === undefined ? 999 : order.has(String(id)) ? order.get(String(id)) : 998);
  return findings
    .map((f, i) => ({ f, i }))
    .filter(x => x.f && x.f.status === 'open' && typeof x.f.id === 'string' && x.f.id)
    .sort((a, b) => (a.f.ownerDecision ? 1 : 0) - (b.f.ownerDecision ? 1 : 0)
      || (SEVERITY_RANK[a.f.severity] ?? 9) - (SEVERITY_RANK[b.f.severity] ?? 9)
      || (BLAST_RANK[a.f.blast] ?? 1) - (BLAST_RANK[b.f.blast] ?? 1)
      || phaseAt(a.f.phase) - phaseAt(b.f.phase) || a.i - b.i)
    .map(x => x.f);
}

// The image picker's choices from several lists of { path (from the hub root), name, mtime }:
// images under inbox/attachments that a run accepts, newest first, at most `max`. `value` is the
// path inside inbox/attachments (what the screenshot field takes).
export function imageChoices(lists = [], max = IMAGES_MAX) {
  const seen = new Map();
  for (const img of asList(lists).flat()) {
    if (!img || typeof img.path !== 'string' || !img.path.startsWith(ATTACHMENTS)) continue;
    const value = img.path.slice(ATTACHMENTS.length);
    if (!IMAGE_RE.test(value) || value.split('/').includes('..') || seen.has(value)) continue;
    seen.set(value, { value, path: img.path, name: img.name || value.split('/').pop(), mtime: String(img.mtime || '') });
  }
  return [...seen.values()].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, max);
}

// Why Start is off, or '' when it may start. `missing` is the empty-question sentence; `stale`
// says the values changed since the preview shown, so its problems may be gone already. The
// refusals have their own notes right above the buttons, so the reason points at them.
export function startBlock({ project, def, preview, previewError, starting, missing, stale = false }) {
  if (!project) return 'Pick a project first.';
  if (!def) return 'Pick a pipeline first.';
  if (def.disabledReason) return def.disabledReason;
  if (starting) return 'Starting the run…';
  if (missing) return missing;
  if (stale && (previewError || !preview || preview.error || asList(preview.refusals).length)) return 'updating the preview…';
  if (previewError) return 'the preview could not be loaded (see the note above).';
  if (!preview) return 'waiting for the preview…';
  if (preview.error) return preview.error;
  const refusals = asList(preview.refusals);
  if (refusals.length === 1) return 'see the note above.';
  if (refusals.length > 1) return `${refusals.length} problems, listed above.`;
  return '';
}

// "Where: <where>." without a doubled full stop after "app/1022-…".
export const whereSentence = where => `Where: ${where}${/[.…]$/.test(where) ? '' : '.'}`;

// ---------------------------------------------------------------- fixed texts

const WHO = { code: 'Code', claude: 'Claude', you: 'You' };
const WHEN_TEXT = {
  verifyNeeded: 'only on Paranoid or a risky path',
  deep: 'only with Deep',
  hasCandidates: 'only when the scan finds new candidates',
  needsDecision: 'only when triage flags something',
  pinnable: 'only when a failing test can pin the bug',
  notChild: 'skipped on later slices',
};
const LEVEL_TEXT = {
  quick: 'Static checks, types and unit tests where the change is',
  standard: 'Quick, plus the wider test groups the profile adds for what changed',
  paranoid: 'Standard, plus integration tests and a verify pass',
};
const HINTS = {
  explain: 'One sentence is enough. This run only reads files and answers with sources.',
  review: 'Read-only: the review lists findings, and you decide what to fix.',
  check: 'Code only: no Claude, zero tokens.',
  architecture: 'Tick none for every lens. The scan is free; Claude only triages new candidates.',
  fix: 'Open findings, in the order Next up picks them.',
  debug: 'Say what you see. Claude investigates first; nothing is edited before you pick a hypothesis.',
  feature: 'Say what users should be able to do. Claude writes a spec first; nothing is edited before you approve it.',
};
const EDIT_HINT = 'One sentence is enough. The first stage finds the files and proposes a plan. Nothing is edited before you approve it.';
const hintFor = def => HINTS[def.id] || (def.editing ? EDIT_HINT : def.blurb ? `This run: ${def.blurb}.` : '');
const FIELD_HINTS = {
  path: 'A folder or file inside the repo. Suggestions come from its folders.',
  image: 'The newest images in the inbox. Paste one in Images to add it.',
};
const SEVERITY_CLASS = { critical: 'red', high: 'red', medium: 'amber' };
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------- view state

const forms = new Map(); // "<project>/<pipeline>" -> { values, unused }, kept while the page lives
const catalogs = new Map(); // project -> the GET /api/pipelines answer this view loaded
const findings = new Map(); // project -> { loading, list, error, at }
const projectInfo = new Map(); // project -> { label, paths, at }
let images = { loading: false, list: null, error: '', at: 0 };
const DATA_TTL_MS = 30_000;

const S = {
  el: null, root: null, key: '', project: '', def: null, rec: null, pendingDraft: null,
  refs: null, // the parts painted in place: title, crumb, fields, summary, prompt, aside, notes, start, why...
  preview: null, previewFor: '', previewError: '', loading: false, seq: 0, timer: null, inflight: null,
  starting: false, tried: false, focusPill: '', optsOpen: true, promptOpen: false,
};

const formKey = (project, id) => `${project}/${id}`;

// The form record of a pipeline in a project; fields the definition gained get their defaults.
function formFor(project, def) {
  const key = formKey(project, def.id);
  let rec = forms.get(key);
  if (!rec) { rec = { values: defaultValues(def), unused: '' }; forms.set(key, rec); }
  for (const f of def.fields) if (!(f.key in rec.values)) rec.values[f.key] = defaultValue(f);
  return rec;
}

// Forgets a form (after a start or Cancel), so the next visit builds a fresh one.
function dropForm(project, id) {
  forms.delete(formKey(project, id));
  S.key = '';
}

// The pipeline list of `project`: the store's when it is for this project, else this view's copy.
function catalogFor(project) {
  if (pipelines.project === project && (pipelines.loaded || pipelines.error !== undefined)) return pipelines;
  return catalogs.get(project) || { project, list: [], routes: [], loaded: false, pending: true };
}

const projectLabel = project => (projectInfo.get(project) || {}).label || project;
const profiled = project => !!(state && asList(state.projects).some(p => p.name === project && p.hasProfile));

// ---------------------------------------------------------------- data for the special fields

async function loadProjectInfo(project) {
  const hit = projectInfo.get(project);
  if (!project || (hit && Date.now() - hit.at < DATA_TTL_MS)) return;
  projectInfo.set(project, { ...(hit || {}), at: Date.now() });
  try {
    const r = await api(`/api/project?name=${encodeURIComponent(project)}`);
    const label = r.project && r.project.label ? String(r.project.label) : project;
    projectInfo.set(project, { label, paths: asList(r.paths).filter(p => typeof p === 'string'), at: Date.now() });
  } catch {
    projectInfo.set(project, { label: project, paths: [], at: Date.now() });
  }
  if (S.project !== project || !S.refs) return;
  S.refs.title.textContent = titleText(S.def, project);
  S.refs.crumb.textContent = projectLabel(project);
  paintPaths();
}

async function loadFindings(project) {
  const hit = findings.get(project);
  if (!project || (hit && (hit.loading || Date.now() - hit.at < DATA_TTL_MS))) return;
  findings.set(project, { ...(hit || { list: null }), loading: true, at: Date.now() });
  let next;
  try {
    const r = await api(`/api/findings?project=${encodeURIComponent(project)}`);
    next = { loading: false, list: rankOpenFindings(r.doc), error: '', at: Date.now() };
  } catch (e) {
    next = { loading: false, list: null, error: e.message, at: Date.now() };
  }
  findings.set(project, next);
  if (S.project === project) paintField('finding');
}

// The hub's image folder (GET /api/images) plus the inbox images /api/state lists.
async function loadImages() {
  if (images.loading || (images.list && Date.now() - images.at < DATA_TTL_MS)) return;
  images = { ...images, loading: true };
  let hub = [];
  let error = '';
  try { hub = asList((await api('/api/images?hub=1')).images); } catch (e) { error = e.message; }
  const inbox = state && state.inbox ? asList(state.inbox.items) : [];
  images = { loading: false, list: imageChoices([hub, inbox]), error: hub.length || inbox.length ? '' : error, at: Date.now() };
  paintField('image');
}

function loadFieldData(def, project) {
  loadProjectInfo(project);
  if (def.fields.some(f => f.kind === 'finding')) loadFindings(project);
  if (def.fields.some(f => f.kind === 'image')) loadImages();
}

// ---------------------------------------------------------------- values and the preview

function setValue(key, value) {
  if (!S.rec) return;
  S.rec.values[key] = value;
  if (S.tried) markMissing(false);
  paintVisibility();
  S.refs.summary.textContent = optionsSummary(S.def, S.rec.values);
  schedulePreview();
  paintFoot();
}

function schedulePreview(now = false) {
  clearTimeout(S.timer);
  S.timer = setTimeout(runPreview, now ? 0 : DEBOUNCE_MS);
}

const sentValues = () => valuesToSend(S.def, S.rec.values);
const isFresh = () => !!S.rec && S.previewFor === JSON.stringify(sentValues());

// Asks the server what a start with these values would do. Answers that arrive after a newer
// request went out (or after the form changed) are dropped.
function runPreview() {
  clearTimeout(S.timer);
  S.timer = null;
  if (!S.def || !S.project || !S.rec) return Promise.resolve();
  const seq = ++S.seq;
  const values = sentValues();
  const signature = JSON.stringify(values);
  S.loading = true;
  paintBusy();
  S.inflight = (async () => {
    let preview = null;
    let error = '';
    try {
      const r = await api('/api/runs', { method: 'POST', body: { project: S.project, pipeline: S.def.id, values, preview: true } });
      preview = r.preview && typeof r.preview === 'object' ? r.preview : {};
    } catch (e) {
      error = e.message;
    }
    if (seq !== S.seq) return;
    Object.assign(S, { preview, previewError: error, previewFor: signature, loading: false });
    paintPreview();
  })();
  return S.inflight;
}

// The preview for the values on screen: the one shown, or a new one right away.
function flushPreview() {
  if (!S.timer && !S.loading && isFresh()) return Promise.resolve();
  if (!S.timer && S.loading && S.inflight) return S.inflight.then(() => (isFresh() ? null : runPreview()));
  return runPreview();
}

const mainField = () => (S.def && S.def.fields[0]) || null;
const missingNow = () => (S.rec && mainField() && isMissing(mainField(), S.rec.values[mainField().key]) ? missingText(mainField()) : '');
const blockNow = () => startBlock({
  project: S.project, def: S.def, preview: S.preview, previewError: S.previewError, starting: S.starting, missing: missingNow(),
  stale: !!S.rec && (!!S.timer || S.loading) && !isFresh(),
});

// Start run and Ctrl+Enter. An empty question is marked on the field; otherwise the preview for
// the values on screen must have loaded and show no refusal.
async function start({ viaKeyboard = false } = {}) {
  if (S.starting || !S.def || !S.rec) return;
  if (missingNow()) {
    S.tried = true;
    markMissing(true);
    return;
  }
  if (viaKeyboard && !S.preview && !S.previewError) {
    toast('Wait for the preview: Ctrl+Enter starts the run once it shows.', true);
    return;
  }
  await flushPreview();
  const reason = blockNow();
  if (reason) { toast(`Start is off: ${reason}`, true); return; }
  const project = S.project;
  const def = S.def;
  S.starting = true;
  paintFoot();
  try {
    const r = await api('/api/runs', { method: 'POST', body: { project, pipeline: def.id, values: sentValues() } });
    S.starting = false;
    dropForm(project, def.id);
    go('run', r.runId);
  } catch (e) {
    S.starting = false;
    toast(e.message, true);
    paintFoot();
    schedulePreview(true); // a lock taken meanwhile now shows as a refusal
  }
}

// Cancel: the typed values go, and the project's page (or Today) shows.
function cancelForm() {
  if (S.def) dropForm(S.project, S.def.id);
  if (S.project && profiled(S.project)) goProject(S.project);
  else go('today');
}

// ---------------------------------------------------------------- building the form

function titleText(def, project) {
  const label = def ? def.label : 'New run';
  return project ? `${label} · ${projectLabel(project)}` : label;
}

function header(def, project) {
  const crumbButton = project ? h('button', { class: 'link', type: 'button', on: { click: () => goProject(project) } }, projectLabel(project)) : null;
  const title = h('h2', { tabindex: '-1' }, titleText(def, project));
  S.refs = { title, crumb: crumbButton || h('span') };
  return h('div', { class: 'view-head' }, h('div', {},
    h('p', { class: 'crumb' }, crumbButton, crumbButton ? ' / ' : null, 'New run'),
    title));
}

// One pill per pipeline (aria-pressed). A pipeline that can't start keeps its pill: the form
// then says why.
function pills(catalog, current) {
  const list = asList(catalog.list).filter(p => p && !p.hidden);
  if (!list.length) return null;
  return h('div', { class: 'pipes', role: 'group', 'aria-label': 'Pipeline' }, list.map(p => keyed(h('button', {
    type: 'button', class: p.disabledReason ? 'pipe off' : 'pipe', 'aria-pressed': p.id === current ? 'true' : 'false',
    dataset: { pipeline: p.id }, on: { click: () => switchPipeline(p.id) },
  }, p.label), `pill:${p.id}`)));
}

// Another pipeline: the question text goes along when the other one's is still empty. The hash
// is replaced (no history entry per pill); onShow puts the focus back on the pill.
function switchPipeline(id) {
  if (!S.def || id === S.def.id) return;
  const target = asList(catalogFor(S.project).list).find(p => p.id === id);
  const from = whatField(S.def);
  const text = from && S.rec ? String(S.rec.values[from.key] || '').trim() : '';
  const to = whatField(target);
  if (text && to) {
    const rec = formFor(S.project, target);
    if (!String(rec.values[to.key] || '').trim()) rec.values[to.key] = text.slice(0, to.max || 2000);
  }
  S.focusPill = id;
  location.replace(hashFor('launcher', id));
}

// One field: { wrap, paint? }. The first field is the big question (the pipeline's ask).
// Every catalog kind renders: textarea, text, path, select (pills, or the level cards), multi,
// bool, finding and image; an unknown kind falls back to a text field.
function buildField(def, f, { main = false } = {}) {
  const values = S.rec.values;
  const id = `l-${f.key}`;
  const labelText = main && def.ask ? def.ask : f.label;
  const hint = main ? hintFor(def) : FIELD_HINTS[f.kind] || '';
  const hintEl = hint ? h('small', { id: `${id}-hint`, class: 'field-hint' }, hint) : null;
  const errEl = main ? h('span', { class: 'form-error', id: 'l-err', hidden: true }, missingText(f)) : null;
  const describedBy = [hint ? `${id}-hint` : '', main ? 'l-err' : ''].filter(Boolean).join(' ') || null;
  const optional = !f.required && ['text', 'textarea', 'path', 'image'].includes(f.kind) ? h('small', {}, 'Optional') : null;
  const cls = main ? 'field big-q' : 'field';
  const unused = main && S.rec.unused ? h('p', { class: 'muted small' }, `You typed: “${S.rec.unused}”. Pick the options that match it.`) : null;

  if (f.kind === 'textarea' || f.kind === 'text' || f.kind === 'path') {
    const attrs = {
      id, maxlength: f.max || null, 'aria-describedby': describedBy, 'aria-required': f.required ? 'true' : null,
      placeholder: main ? def.placeholder || null : f.kind === 'path' ? 'Let Claude find it' : null,
    };
    const ctl = f.kind === 'textarea'
      ? h('textarea', { ...attrs, rows: main ? 3 : Math.min(f.lines || 3, 5) })
      : h('input', { ...attrs, type: 'text', autocomplete: 'off', spellcheck: f.kind === 'path' ? 'false' : null,
        list: f.kind === 'path' ? 'l-paths' : null, inputmode: f.key === 'n' ? 'numeric' : null, class: f.key === 'n' ? 'narrow' : null });
    ctl.value = values[f.key] == null ? '' : String(values[f.key]);
    keyed(ctl, `f:${f.key}`);
    ctl.addEventListener('input', () => setValue(f.key, ctl.value));
    return { wrap: h('div', { class: cls }, h('label', { for: id }, h('span', {}, labelText), optional), ctl, hintEl, errEl, unused) };
  }

  if (f.kind === 'bool') {
    const box = keyed(h('input', { type: 'checkbox', id, checked: !!values[f.key] }), `f:${f.key}`);
    box.addEventListener('change', () => setValue(f.key, box.checked));
    return { wrap: h('div', { class: cls }, h('label', { class: 'check', for: id }, box, labelText), hintEl) };
  }

  if (f.kind === 'multi') {
    const options = asList(f.options);
    const boxes = options.map(([value]) => {
      const box = keyed(h('input', { type: 'checkbox', name: id, value, checked: asList(values[f.key]).includes(value) }), `f:${f.key}:${value}`);
      box.addEventListener('change', () => setValue(f.key, boxes.filter(b => b.checked).map(b => b.value)));
      return box;
    });
    const empty = f.key === 'lenses' ? 'The profile lists no lenses, so every probe runs.' : 'The profile gives no options here.';
    return { wrap: h('fieldset', { class: cls, 'aria-describedby': describedBy }, h('legend', {}, labelText), hintEl,
      options.length ? h('div', { class: 'checks-row' }, boxes.map((b, i) => h('label', { class: 'check' }, b, options[i][1]))) : h('p', { class: 'muted small' }, empty),
      unused) };
  }

  if (f.kind === 'select' && isLevelField(f)) return levelField(f, { cls, labelText, hintEl, describedBy });

  if (f.kind === 'select') {
    const radios = asList(f.options).map(([value, label]) => {
      const r = keyed(h('input', { type: 'radio', name: id, value, checked: values[f.key] === value }), `f:${f.key}:${value}`);
      r.addEventListener('change', () => { if (r.checked) setValue(f.key, value); });
      return h('label', {}, r, h('span', {}, label));
    });
    return { wrap: h('fieldset', { class: cls, 'aria-describedby': describedBy }, h('legend', {}, labelText), hintEl, h('div', { class: 'seg' }, radios), unused) };
  }

  if (f.kind === 'finding') {
    const box = h('div', { class: 'pick-list' });
    const paint = () => box.replaceChildren(...findingChoices(f, id));
    paint();
    return { wrap: h('fieldset', { class: cls, 'aria-describedby': describedBy }, h('legend', {}, labelText), hintEl, box, errEl, unused), paint };
  }

  if (f.kind === 'image') {
    const box = h('div', { class: 'img-pick' });
    const paint = () => box.replaceChildren(...imagePicks(f, id));
    paint();
    return { wrap: h('fieldset', { class: cls, 'aria-describedby': describedBy }, h('legend', {}, labelText, ' ', optional), hintEl, box), paint };
  }

  // A kind this page doesn't know yet: a plain text field, so the run can still be started.
  const ctl = keyed(h('input', { id, type: 'text', autocomplete: 'off', maxlength: f.max || null }), `f:${f.key}`);
  ctl.value = values[f.key] == null ? '' : String(values[f.key]);
  ctl.addEventListener('input', () => setValue(f.key, ctl.value));
  return { wrap: h('div', { class: cls }, h('label', { for: id }, labelText), ctl) };
}

// "How careful?" as three cards. While the preview says the request touches a risky path
// (levelReason), Quick is off with the reason shown, and a Quick choice moves to Standard.
function levelField(f, { cls, labelText, hintEl, describedBy }) {
  const inputs = new Map();
  const cards = asList(f.options).map(([value, label]) => {
    const r = keyed(h('input', { type: 'radio', name: `l-${f.key}`, value, checked: S.rec.values[f.key] === value }), `f:${f.key}:${value}`);
    r.addEventListener('change', () => { if (r.checked) setValue(f.key, value); });
    inputs.set(value, r);
    return h('label', {}, r, h('span', {}, h('b', {}, label), LEVEL_TEXT[value] || ''));
  });
  const note = h('p', { class: 'note', id: `l-${f.key}-why`, hidden: true });
  S.refs.level = { key: f.key, inputs, note };
  return { wrap: h('fieldset', { class: cls, 'aria-describedby': [describedBy, note.id].filter(Boolean).join(' ') },
    h('legend', {}, labelText), hintEl, h('div', { class: 'care' }, cards), note) };
}

// The finding picker: open findings as radios, highest priority first (Next up's order). When
// GET /api/findings fails, the pipeline's own list of open findings (id and title) is used.
function findingChoices(f, id) {
  const data = findings.get(S.project) || { loading: true };
  let list = data.list || null;
  if (!list && asList(f.options).length) list = f.options.map(([value, label]) => ({ id: value, title: String(label).replace(`${value}: `, '') }));
  if (data.loading && !list) return [h('p', { class: 'muted small' }, 'Loading the open findings…')];
  const out = [];
  if (data.error) out.push(h('p', { class: 'note' }, `The findings could not be loaded: ${data.error}`));
  if (!list || !list.length) {
    out.push(h('p', { class: 'muted small' }, 'No open findings. Import them from the audit on the project\'s Findings tab.'),
      h('div', {}, h('button', { class: 'btn small', type: 'button', on: { click: () => goProject(S.project, 'findings') } }, 'Open Findings')));
    return out;
  }
  for (const item of list) {
    const r = keyed(h('input', { type: 'radio', name: id, value: item.id, checked: S.rec.values[f.key] === item.id }), `f:${f.key}:${item.id}`);
    r.addEventListener('change', () => { if (r.checked) setValue(f.key, item.id); });
    const meta = [item.phase != null && item.phase !== '' ? `Phase ${item.phase}` : '', item.blast ? `${item.blast} blast radius` : '',
      item.ownerDecision ? 'waits on an owner decision' : ''].filter(Boolean).join(' · ');
    out.push(h('label', { class: 'pick' }, r, h('span', { class: 'pick-body' },
      h('span', { class: 'pick-top' }, h('span', { class: 'mono' }, item.id),
        item.severity ? h('span', { class: `badge ${SEVERITY_CLASS[item.severity] || ''}`.trim() }, cap(item.severity)) : null),
      h('span', { class: 'pick-title' }, item.title || ''),
      meta ? h('small', {}, meta) : null)));
  }
  return out;
}

// The image picker: None, then the newest inbox images as thumbnails (radios).
function imagePicks(f, id) {
  const value = S.rec.values[f.key] || '';
  const pick = (v, body, key) => {
    const r = keyed(h('input', { type: 'radio', name: id, value: v, checked: value === v }), `f:${f.key}:${key}`);
    r.addEventListener('change', () => { if (r.checked) setValue(f.key, v); });
    return h('label', {}, r, body);
  };
  const out = [pick('', h('span', { class: 'img-card' }, h('span', { class: 'img-none', 'aria-hidden': 'true' }, 'No image'), h('span', { class: 'img-name' }, 'None')), 'none')];
  const list = images.list || [];
  for (const img of list) {
    out.push(pick(img.value, h('span', { class: 'img-card' },
      h('img', { src: `/img?path=${encodeURIComponent(img.path)}`, alt: '', loading: 'lazy' }),
      h('span', { class: 'img-name', title: img.value }, img.name),
      img.mtime ? h('small', {}, fmtAgo(img.mtime)) : null), img.value));
  }
  // A choice that is no longer among the newest images stays chosen and visible.
  if (value && images.list && !list.some(i => i.value === value)) {
    out.push(pick(value, h('span', { class: 'img-card' }, h('span', { class: 'img-none', 'aria-hidden': 'true' }, 'Older image'),
      h('span', { class: 'img-name', title: value }, value.split('/').pop())), 'kept'));
  }
  if (images.loading && !images.list) out.push(h('p', { class: 'muted small img-note' }, 'Loading the inbox images…'));
  else if (images.error) out.push(h('p', { class: 'note img-note' }, `The inbox images could not be loaded: ${images.error}`));
  else if (images.list && !list.length) {
    out.push(h('p', { class: 'muted small img-note' }, 'No images in the inbox yet. ',
      h('button', { class: 'link', type: 'button', on: { click: () => go('images') } }, 'Open Images'), ' and paste one.'));
  }
  return out;
}

function buildForm(def) {
  const fieldsByKey = new Map();
  const add = (f, opts) => { const r = buildField(def, f, opts); fieldsByKey.set(f.key, r); return r.wrap; };
  const [first, ...rest] = def.fields;
  const summary = h('span', { class: 'muted', id: 'l-sum' }, optionsSummary(def, S.rec.values));
  const mainPart = first ? add(first, { main: true }) : null;
  const plainPart = rest.filter(f => !f.advanced).map(f => add(f));
  const advanced = rest.filter(f => f.advanced);
  const opts = advanced.length ? h('details', { class: 'opts', open: S.optsOpen, on: { toggle: e => { S.optsOpen = e.target.open; } } },
    h('summary', {}, h('b', {}, 'Options'), ' ', summary),
    h('div', { class: 'opts-body' }, advanced.map(f => add(f)))) : null;
  const prompt = h('pre', { class: 'output', id: 'l-prompt', tabindex: '0', 'aria-label': 'Exact prompt for the first stage' });
  const promptBox = h('details', { class: 'opts', open: S.promptOpen, on: { toggle: e => { S.promptOpen = e.target.open; } } },
    h('summary', {}, h('b', {}, 'Exact prompt for the first stage'), ' ', h('span', { class: 'muted' }, 'live preview')), prompt);

  const stages = h('ol', { class: 'plan' });
  const cannot = h('ul', { class: 'cannot' });
  const caps = h('dl', { class: 'facts' });
  const where = h('p', { class: 'muted small where' });
  const aside = h('aside', { class: 'launch-plan', 'aria-labelledby': 'l-will' },
    h('h3', { id: 'l-will' }, 'This run will'), stages,
    h('h3', {}, 'It cannot'), cannot,
    h('h3', {}, 'Limits'), caps, where);

  const top = def.disabledReason ? h('div', { class: 'launch-notes' }, h('p', { class: 'note' }, def.disabledReason, ' ',
    S.project ? h('button', { class: 'link', type: 'button', on: { click: () => goProject(S.project) } }, 'Open the project')
      : h('button', { class: 'link', type: 'button', on: { click: () => go('projects') } }, 'Open Projects'))) : null;
  const notes = h('div', { class: 'launch-notes', hidden: true });
  const why = h('p', { class: 'reason launch-why', id: 'l-why', hidden: true });
  const startBtn = keyed(h('button', { class: 'btn primary', type: 'button', 'aria-keyshortcuts': 'Control+Enter', on: { click: () => start() } }, 'Start run'), 'start');
  const cancel = keyed(h('button', { class: 'btn ghost', type: 'button', on: { click: cancelForm } }, 'Cancel'), 'cancel');
  const form = h('form', { class: 'card launch', novalidate: '', 'aria-label': `New ${def.label} run`, on: { submit: e => e.preventDefault() } },
    top,
    h('div', { class: 'launch-grid' },
      h('div', { class: 'launch-form' }, mainPart, plainPart, opts, promptBox),
      aside),
    notes,
    h('div', { class: 'card-foot launch-foot' },
      h('span', { class: 'muted push' }, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'Enter'), ' starts the run'),
      why, cancel, startBtn));
  Object.assign(S.refs, { fields: fieldsByKey, summary, prompt, aside, stages, cannot, caps, where, notes, start: startBtn, why });
  return form;
}

// ---------------------------------------------------------------- painting in place

function paintField(kind) {
  if (!S.refs || !S.refs.fields || !S.def) return;
  for (const f of S.def.fields) {
    if (f.kind !== kind) continue;
    const r = S.refs.fields.get(f.key);
    if (r && r.paint) keepFocus(r.wrap, r.paint);
  }
}

function paintPaths() {
  const list = S.refs && S.refs.paths;
  if (!list) return;
  list.replaceChildren(...asList((projectInfo.get(S.project) || {}).paths).map(p => h('option', { value: p })));
}

function paintVisibility() {
  if (!S.refs || !S.refs.fields) return;
  for (const f of S.def.fields) {
    const r = S.refs.fields.get(f.key);
    if (r) r.wrap.hidden = !fieldShown(S.def.id, f.key, S.rec.values);
  }
}

// Shows (on a failed start) or clears the "Say what you want first." error of the question.
function markMissing(on) {
  const f = mainField();
  const err = S.root && S.root.querySelector('#l-err');
  if (!f || !err) return;
  const show = on && !!missingNow();
  err.hidden = !show;
  const ctl = S.root.querySelector(`#l-${f.key}`);
  if (ctl) {
    if (show) ctl.setAttribute('aria-invalid', 'true'); else ctl.removeAttribute('aria-invalid');
    if (show) ctl.focus();
  } else if (show) {
    const first = S.root.querySelector(`input[name="l-${f.key}"]`);
    if (first) first.focus();
  }
}

// While a preview loads, what the old one said fades a little (aria-busy, launcher.css).
const BUSY_PARTS = ['aside', 'prompt', 'notes'];
function paintBusy() {
  if (!S.refs || !S.refs.aside) return;
  for (const k of BUSY_PARTS) S.refs[k].setAttribute('aria-busy', 'true');
}

function stageRow(s) {
  const who = WHO[s.who] ? s.who : 'code';
  const detail = [s.kind === 'claude' && s.model ? `${s.model}/${s.effort || 'default'}` : '', s.profileText || '', s.goal || '',
    s.when && WHEN_TEXT[s.when] ? WHEN_TEXT[s.when] : ''].filter(Boolean).join(' · ');
  return h('li', {}, h('span', { class: `who ${who}` }, WHO[who]), h('span', {}, s.label || s.id, detail ? h('small', {}, detail) : null));
}

// Everything that comes from the preview (or from the definition until one has loaded).
function paintPreview() {
  if (!S.refs || !S.refs.aside) return;
  const def = S.def;
  const p = S.preview || {};
  for (const k of BUSY_PARTS) S.refs[k].removeAttribute('aria-busy');
  S.refs.stages.replaceChildren(...asList(p.stages && p.stages.length ? p.stages : def.stages).map(stageRow));
  S.refs.cannot.replaceChildren(...asList(p.cannot && p.cannot.length ? p.cannot : def.cannot).map(c => h('li', {}, c)));
  const caps = asList(p.caps && p.caps.length ? p.caps : def.caps).filter(c => Array.isArray(c) && c.length === 2);
  S.refs.caps.replaceChildren(...caps.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
    ...(def.claude ? [h('dt', {}, 'Usage'), h('dd', {}, 'shown as turns and minutes; dollars only as an estimate')] : []));
  S.refs.where.textContent = S.preview && p.where
    ? `${whereSentence(p.where)}${p.lock ? ' It holds the project lock while it runs: one editing run at a time.' : ''}`
    : 'Where: shown once the preview has loaded.';
  S.refs.prompt.textContent = S.previewError ? `The preview could not be loaded: ${S.previewError}`
    : !S.preview ? 'Loading the preview…'
      : p.prompt ? p.prompt
        : p.error ? `The prompt shows once the request is complete: ${p.error}`
          : def.claude ? 'The first Claude stage runs only after the code steps, so its prompt is built then.'
            : 'No Claude stage: this run is code only and costs zero tokens.';
  paintLevel();
  paintNotes();
  paintFoot();
}

function paintLevel() {
  const lv = S.refs.level;
  if (!lv) return;
  const reasons = S.preview ? asList(S.preview.levelReason).filter(Boolean) : [];
  const quick = lv.inputs.get('quick');
  if (quick) quick.disabled = reasons.length > 0;
  if (reasons.length && S.rec.values[lv.key] === 'quick') {
    S.rec.values[lv.key] = 'standard';
    const std = lv.inputs.get('standard');
    if (std) std.checked = true;
    S.refs.summary.textContent = optionsSummary(S.def, S.rec.values);
    schedulePreview();
  }
  lv.note.hidden = !reasons.length;
  lv.note.textContent = reasons.length ? `Quick is off: ${reasons.join('; ')}. A run on this path uses at least Standard.` : '';
}

// Refusals and warnings as visible text above the buttons (a value problem is the reason next
// to Start instead, so it isn't said twice).
function paintNotes() {
  const p = S.preview || {};
  const out = [];
  if (S.previewError) out.push(h('p', { class: 'note red' }, `The preview could not be loaded: ${S.previewError}`));
  for (const r of asList(p.refusals)) out.push(h('p', { class: 'note' }, r));
  for (const w of asList(p.warnings)) out.push(h('p', { class: 'note info' }, w));
  S.refs.notes.replaceChildren(...out);
  S.refs.notes.hidden = !out.length;
}

// Start is disabled with the reason as visible text next to it (SPEC 5.11).
function paintFoot() {
  if (!S.refs || !S.refs.start) return;
  const reason = blockNow();
  S.refs.start.disabled = !!reason;
  S.refs.start.textContent = S.starting ? 'Starting…' : 'Start run';
  S.refs.why.hidden = !reason;
  S.refs.why.textContent = !reason ? '' : S.starting ? reason : `Start is off: ${reason}`;
  if (reason) S.refs.start.setAttribute('aria-describedby', 'l-why'); else S.refs.start.removeAttribute('aria-describedby');
}

// ---------------------------------------------------------------- the view

function render(el, { sub }) {
  S.el = el;
  const id = PIPELINE_RE.test(sub || '') ? sub : '';
  if (launchDraft && launchDraft.pipeline === id) {
    S.pendingDraft = { ...launchDraft };
    clearLaunchDraft();
  }
  const project = currentProject;
  const catalog = catalogFor(project);
  const def = id ? asList(catalog.list).find(p => p && p.id === id && !p.hidden) || null : null;
  let fresh = false;
  if (def && S.pendingDraft && S.pendingDraft.pipeline === id) {
    forms.set(formKey(project, id), draftValues(def, S.pendingDraft));
    S.pendingDraft = null;
    fresh = true;
  }
  const key = JSON.stringify([id, project, !!catalog.loaded, catalog.error || '', asList(catalog.list).map(p => [p.id, p.label, p.disabledReason]), def]);
  if (!fresh && key === S.key && S.root && el.contains(S.root)) return;
  S.key = key;
  build(el, { id, project, catalog, def });
}

function build(el, { id, project, catalog, def }) {
  clearTimeout(S.timer);
  S.seq++; // an answer for the old form is dropped
  Object.assign(S, { project, def, rec: def ? formFor(project, def) : null, preview: null, previewError: '', previewFor: '', loading: false, tried: false });
  const parts = [header(def, project), pills(catalog, id)];
  if (!project) {
    parts.push(h('div', { class: 'card' }, h('div', { class: 'card-body' },
      h('p', {}, 'Pick a project first: runs start in a project with a profile.'),
      h('button', { class: 'btn mt-3', type: 'button', on: { click: () => go('projects') } }, 'Open Projects'))));
  } else if (!catalog.loaded) {
    const text = catalog.pending ? 'Loading the pipelines…'
      : catalog.error ? `The pipeline list could not be loaded: ${catalog.error}`
        : 'This app has no pipeline list yet, so nothing can be started here.';
    parts.push(h('p', { class: catalog.pending ? 'muted' : 'note' }, text));
  } else if (!def) {
    parts.push(h('p', { class: id ? 'note' : 'muted' }, id ? `There is no pipeline called ${id}. Pick one above.` : 'Pick a pipeline above.'));
  } else {
    const paths = h('datalist', { id: 'l-paths' });
    S.refs.paths = paths;
    parts.push(buildForm(def), paths);
  }
  S.root = h('div', { class: 'launcher', on: { keydown: onKey } }, parts);
  el.replaceChildren(S.root);
  if (!def) return;
  paintVisibility();
  paintPaths();
  paintPreview();
  loadFieldData(def, project);
  schedulePreview(true);
}

// Ctrl+Enter anywhere in the launcher starts the run (SPEC 5.5, wave 4 check 19).
function onKey(e) {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (!S.def || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  start({ viaKeyboard: true });
}

// Repaints after this view's own loads (the shell repaints on store changes).
function repaint() {
  if (!S.el || view !== 'launcher') return;
  keepFocus(S.el, () => render(S.el, { sub: routeSub }));
}

function onShow() {
  const project = currentProject;
  loadPipelines(project).then(v => {
    if (v && v.project === project) catalogs.set(project, v);
    repaint();
  });
  if (S.def && S.rec) {
    loadFieldData(S.def, project);
    schedulePreview(true);
  }
  if (S.focusPill && S.root) {
    const pill = [...S.root.querySelectorAll('.pipe')].find(b => b.dataset.pipeline === S.focusPill);
    if (pill) pill.focus({ preventScroll: true });
  }
  S.focusPill = '';
}

function onHide() {
  clearTimeout(S.timer);
  S.timer = null;
  S.seq++;
  S.loading = false;
}

export default {
  id: 'launcher',
  label: 'New run',
  icon: '<path d="M12 5v14M5 12h14"/>',
  render,
  onShow,
  onHide,
};
