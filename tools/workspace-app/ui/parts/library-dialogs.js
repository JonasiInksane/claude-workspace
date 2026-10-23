// The asset library's dialogs, shared by the Assets view, a project's Assets tab and its Settings
// tab: an asset's details (openAssetDialog: the preview, the facts, every version with Open and
// Download, a new version by drop, paste or choice, the title, description and tags, Archive or
// Restore, and Attach or Detach where a project offers it), New asset (newAssetDialog: one asset
// per file, shared or for a project), and the picker of assets to attach (assetPicker: a search
// and a kind filter over shared assets and the project's own).
//
// Every change goes to routes/library.mjs with the number of versions the dialog saw (expect), so
// a change made elsewhere meanwhile is refused (409); the dialog says so and loads the asset
// again, keeping what was typed. Typed details are guarded (dialog.js `guard`): Esc, Close or the
// backdrop ask before they are lost. Files dropped or pasted on an open dialog go to it (main.js
// hands them to the dialog's upload).
import { confirmDialog, fmtAgo, fmtSize, fmtTime, h, keyed, plural, toast } from '../lib.js';
import { clearGuard, closeDialog, dialog, openDialog } from '../dialog.js';
import {
  fileKind, fileProblem, fileUrl, filterAssets, getAsset, KINDS, kindPlural, kindWord, pastedTitle, saveMeta, setArchived,
  titleFromName, uploadNew, uploadVersion,
} from './library.js';
import { assetMeta, assetPreview, dropZone, kindIcon, placeWord } from './library-ui.js';

// What the file inputs offer (the server checks the bytes either way).
export const ACCEPT = {
  any: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,.md,.markdown,.txt,.json,application/pdf',
  image: 'image/png,image/jpeg,image/gif,image/webp,image/bmp',
  text: '.md,.markdown,.txt,.json,text/plain,text/markdown,application/json',
  pdf: 'application/pdf',
};
const KIND_A = { image: 'an image', text: 'a text file', pdf: 'a PDF' };

const errorBox = () => h('div', { class: 'form-error', role: 'alert', hidden: true });
function showError(box, text) {
  box.textContent = text || '';
  box.hidden = !text;
}

// True while the page's dialog still shows `body`: work that ends after an await (an upload, a
// save) closes or retitles the dialog only then, never another dialog opened meanwhile.
const holds = body => dialog.contains(body);

// ---------------------------------------------------------------- details

// One version in the list: when, how big, its type and original name, its note and hash, with
// Open (not for a PDF: the sandboxed file route doesn't render one) and Download.
function versionRow(asset, v, latest) {
  const when = v.addedAt ? h('time', { datetime: v.addedAt, title: fmtTime(v.addedAt) }, `Added ${fmtAgo(v.addedAt)}`) : 'Added at an unknown time';
  return h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title' }, `v${v.n}`, v.n === latest ? [' ', h('span', { class: 'badge ok' }, 'latest')] : null),
      h('div', { class: 'sub wrap' }, when, ` · ${[fmtSize(v.bytes || 0), v.type, v.originalName ? `from ${v.originalName}` : ''].filter(Boolean).join(' · ')}`),
      v.note ? h('div', { class: 'sub wrap lib-note' }, v.note) : null,
      h('div', { class: 'sub mono' }, `SHA-256 ${String(v.sha256 || '').slice(0, 16)}`)),
    h('div', { class: 'row-actions' },
      asset.kind === 'pdf' ? null : keyed(h('a', {
        class: 'btn small', href: fileUrl(asset.ref, v.n), target: '_blank', rel: 'noopener', 'aria-label': `Open v${v.n} of ${asset.title}`,
      }, 'Open'), `ad:open:${v.n}`),
      keyed(h('a', {
        class: 'btn small', href: fileUrl(asset.ref, v.n, { download: true }), download: '', 'aria-label': `Download v${v.n} of ${asset.title}`,
      }, 'Download'), `ad:dl:${v.n}`)));
}

function factsList(a) {
  const latest = a.versions[a.versions.length - 1];
  const rows = [
    ['Ref', h('code', {}, a.ref)],
    ['Kind', kindWord(a.kind)],
    ['Where', a.scope === 'shared' ? 'Shared: any project can attach it' : `${a.project} only`],
    ['Versions', `${plural(a.versions.length, 'version')}${latest ? `, latest v${latest.n} (${fmtSize(latest.bytes || 0)})` : ''}`],
    a.createdAt ? ['Created', fmtTime(a.createdAt)] : null,
    a.archived ? ['State', h('span', { class: 'badge amber' }, 'Archived')] : null,
  ].filter(Boolean);
  return h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

// The details of one asset. `attach`, when a project offers it: { project, attached(), toggle() }
// (toggle resolves when the project's settings are saved). onChange(asset) runs after every change.
export async function openAssetDialog(ref, { onChange = () => {}, attach = null } = {}) {
  let asset;
  try { asset = (await getAsset(ref)).asset; } catch (e) { toast(e.message, true); return null; }
  return detailDialog(asset, { onChange, attach });
}

function detailDialog(first, { onChange, attach }) {
  let asset = first;
  const ref = first.ref;
  const title = h('input', { id: 'libTitle', maxlength: 120, autocomplete: 'off', required: true });
  const description = h('textarea', { id: 'libDescription', maxlength: 2000, rows: 3, placeholder: 'Optional: what it is and when to use it' });
  const tags = h('input', { id: 'libTags', maxlength: 600, autocomplete: 'off', spellcheck: 'false', placeholder: 'Optional, e.g. brand, ui', 'aria-describedby': 'libTagsHelp' });
  const note = h('input', { id: 'libNote', maxlength: 500, autocomplete: 'off', placeholder: 'Optional: what changed in it' });
  const noteLabel = h('label', { for: 'libNote' }, 'Note for the next version', note);
  const metaError = errorBox();
  const versionError = errorBox();
  const saveDetails = keyed(h('button', { class: 'btn small primary', type: 'button' }, 'Save details'), 'ad:save');
  const previewBox = h('div', { class: 'lib-detail-preview' });
  const factsBox = h('div', {});
  const versionsHead = h('div', { class: 'section-label' });
  const versionsBox = h('ul', { class: 'list lib-versions' });
  const archivedNote = h('p', { class: 'note', hidden: true }, 'Archived: it takes no new versions until you restore it.');
  const archiveBtn = keyed(h('button', { class: 'btn push-left', type: 'button' }), 'ad:archive');
  const attachBtn = attach ? keyed(h('button', { class: 'btn', type: 'button' }), 'ad:attach') : null;
  let initial = '';
  let shownLatest = null;
  const snapshot = () => JSON.stringify([title.value.trim(), description.value.trim(), tags.value.trim()]);
  const metaDirty = () => snapshot() !== initial;
  const setMeta = a => {
    title.value = a.title;
    description.value = a.description || '';
    tags.value = (a.tags || []).join(', ');
    initial = snapshot();
  };
  const syncSave = () => { saveDetails.disabled = !metaDirty() || !title.value.trim(); };

  const zone = dropZone({
    key: 'ad:drop', label: 'Add a version: drop a file here, paste, or click to choose',
    hint: `It must be ${KIND_A[first.kind] || 'the same kind'}. The same bytes as the latest add nothing.`,
    accept: ACCEPT[first.kind] || ACCEPT.any, multiple: false, onFiles: (files, pasted) => addVersion(files, pasted),
  });

  function paint() {
    const latest = asset.versions[asset.versions.length - 1];
    if (!latest || latest.n !== shownLatest) {
      shownLatest = latest ? latest.n : null;
      previewBox.replaceChildren(assetPreview({ ...asset, latest }, { large: true }));
    }
    factsBox.replaceChildren(factsList(asset));
    versionsHead.textContent = `Versions (${asset.versions.length}), newest first`;
    versionsBox.replaceChildren(...[...asset.versions].reverse().map(v => versionRow(asset, v, latest && latest.n)));
    archiveBtn.textContent = asset.archived ? 'Restore' : 'Archive…';
    archiveBtn.classList.toggle('danger', !asset.archived);
    zone.hidden = asset.archived;
    noteLabel.hidden = asset.archived;
    archivedNote.hidden = !asset.archived;
    if (attachBtn) attachBtn.textContent = attach.attached() ? `Detach from ${attach.project}` : `Attach to ${attach.project}`;
    const head = dialog.querySelector('#dialogTitle');
    if (head) head.textContent = asset.title;
    syncSave();
  }

  async function reload() {
    try { asset = (await getAsset(ref)).asset; } catch (e) { toast(e.message, true); return; }
    paint();
    onChange(asset);
  }

  async function doSaveDetails() {
    if (saveDetails.disabled) return;
    saveDetails.disabled = true;
    showError(metaError, '');
    try {
      const r = await saveMeta(ref, { title: title.value, description: description.value, tags: tags.value }, asset.versions.length);
      asset = r.asset;
      setMeta(asset);
      toast(`Saved the details of ${asset.title}`);
      paint();
      onChange(asset);
    } catch (e) {
      showError(metaError, e.status === 409 ? `${e.message} It was loaded again; what you typed is still here, so Save details again.` : e.message);
      if (e.status === 409) await reload();
    }
    syncSave();
  }

  async function addVersion(files, pasted = false) {
    showError(versionError, '');
    if (!files.length) return;
    if (files.length > 1) toast('One file at a time: the first one is added.', true);
    const file = files[0];
    if (asset.archived) { showError(versionError, 'Restore it first: an archived asset takes no new versions.'); return; }
    const problem = fileProblem(file, asset.kind);
    if (problem) { showError(versionError, problem); return; }
    try {
      const r = await uploadVersion(ref, file, { expect: asset.versions.length, note: note.value, pasted });
      asset = r.asset;
      if (r.added) note.value = '';
      toast(r.added ? `Added v${r.version} of ${asset.title}` : `The same as v${r.version}: nothing was added`);
      paint();
      onChange(asset);
    } catch (e) {
      showError(versionError, e.network ? 'The file could not be read or sent.' : e.message);
      if (e.status === 409) await reload();
    }
  }

  async function toggleArchive() {
    if (!asset.archived) {
      const ok = await confirmDialog(`Archive ${asset.title}?`,
        'It leaves the lists and takes no new versions. Its files stay, and settings that attach it keep it, marked archived. Restore brings it back.', 'Archive');
      if (!ok) return;
    }
    try {
      asset = (await setArchived(ref, !asset.archived)).asset;
      toast(asset.archived ? `Archived ${asset.title}` : `Restored ${asset.title}`);
      paint();
      onChange(asset);
    } catch (e) { toast(e.message, true); }
  }

  async function toggleAttach() {
    attachBtn.disabled = true;
    try { await attach.toggle(); } catch (e) { toast(e.message, true); }
    attachBtn.disabled = false;
    paint();
  }

  for (const el of [title, description, tags]) el.addEventListener('input', syncSave);
  saveDetails.addEventListener('click', doSaveDetails);
  archiveBtn.addEventListener('click', toggleArchive);
  if (attachBtn) attachBtn.addEventListener('click', toggleAttach);
  setMeta(asset);
  const body = h('div', { class: 'lib-detail' },
    h('div', { class: 'lib-detail-top' }, previewBox,
      h('div', { class: 'lib-detail-side' }, factsBox,
        h('div', { class: 'form lib-meta-form' },
          h('label', { for: 'libTitle' }, 'Title', h('small', {}, 'The id stays as it is.'), title),
          h('label', { for: 'libDescription' }, 'Description', description),
          h('label', { for: 'libTags' }, 'Tags', h('small', { id: 'libTagsHelp' }, 'Separated by commas; saved in lowercase with hyphens.'), tags),
          metaError,
          h('div', { class: 'row-actions' }, saveDetails)))),
    h('div', { class: 'lib-detail-versions' }, versionsHead,
      h('div', { class: 'form lib-add-version' }, archivedNote, zone, noteLabel, versionError),
      versionsBox));
  openDialog(asset.title, body, {
    wide: true,
    guard: () => !metaDirty() || confirm(`Discard your changes to the details of ${asset.title}?`),
    upload: (files, pasted) => addVersion(files, pasted),
    actions: [archiveBtn, attachBtn, h('button', { class: 'btn', type: 'button', on: { click: closeDialog } }, 'Close')].filter(Boolean),
  });
  dialog.classList.add('lib-dialog');
  paint();
  return { reload, get asset() { return asset; } };
}

// ---------------------------------------------------------------- new asset

// New asset: one asset per file. `places` are { value: 'shared' | 'project:<name>', label };
// `place` is the one chosen first, `lockPlace` keeps it (a project's Assets tab). `files` (and
// `pasted`) start the list; more come by drop, paste or choice. onCreated(results) gets the
// upload answers ({ ref, version, asset }). An upload can't be called back once sent, so while
// one runs the dialog stays: Cancel, Close, Esc and the files' ✕ wait for it.
export function newAssetDialog({ place = 'shared', places = [{ value: 'shared', label: 'Shared' }], lockPlace = false, files = [], pasted = false, onCreated = () => {} } = {}) {
  let chosen = []; // { file, pasted, problem, error }
  const placeSelect = h('select', { id: 'libPlace' }, places.map(p => h('option', { value: p.value }, p.value === 'shared' ? 'Shared: any project can attach it' : `${p.label} only`)));
  placeSelect.value = places.some(p => p.value === place) ? place : (places[0] || { value: 'shared' }).value;
  const lockedLabel = (places.find(p => p.value === placeSelect.value) || { label: '' }).label;
  const title = h('input', { id: 'libNewTitle', maxlength: 120, autocomplete: 'off', 'aria-describedby': 'libNewTitleHelp' });
  const titleHelp = h('small', { id: 'libNewTitleHelp' }, 'The id comes from the title and never changes.');
  const description = h('textarea', { id: 'libNewDescription', maxlength: 2000, rows: 2, placeholder: 'Optional: what it is and when to use it' });
  const tags = h('input', { id: 'libNewTags', maxlength: 600, autocomplete: 'off', spellcheck: 'false', placeholder: 'Optional, e.g. brand, ui' });
  const note = h('input', { id: 'libNewNote', maxlength: 500, autocomplete: 'off', placeholder: 'Optional: where it comes from' });
  const list = h('ul', { class: 'lib-files', 'aria-label': 'Files to upload' });
  const error = errorBox();
  const submit = keyed(h('button', { class: 'btn primary', type: 'button' }, 'Upload'), 'na:submit');
  const cancel = keyed(h('button', { class: 'btn', type: 'button', on: { click: closeDialog } }, 'Cancel'), 'na:cancel');
  let titleTouched = false;
  let busy = false;

  const placeOf = () => (placeSelect.value === 'shared' ? { scope: 'shared', project: '' } : { scope: 'project', project: placeSelect.value.slice(8) });
  // `one`: a single file was chosen when Upload was clicked (it takes the typed title).
  const titleFor = (c, one) => (one ? title.value.trim() : c.pasted ? pastedTitle() : titleFromName(c.file.name) || 'Asset');

  function add(more, isPasted = false) {
    for (const f of more) chosen.push({ file: f, pasted: !!isPasted, problem: fileProblem(f), error: '' });
    if (!titleTouched && chosen.length === 1) title.value = chosen[0].pasted ? pastedTitle() : titleFromName(chosen[0].file.name);
    showError(error, '');
    paint();
  }

  function fileRow(c, i) {
    const name = c.pasted ? 'Pasted image' : c.file.name;
    const why = c.problem || c.error;
    return h('li', { class: why ? 'bad' : null },
      kindIcon(fileKind(c.file) === 'svg' ? 'broken' : fileKind(c.file) || 'broken'),
      h('span', { class: 'main' },
        h('span', { class: 'title' }, name),
        h('span', { class: 'sub' }, `${fmtSize(c.file.size || 0)}${fileKind(c.file) && fileKind(c.file) !== 'svg' ? ` · ${kindWord(fileKind(c.file))}` : ''}`),
        why ? h('span', { class: 'sub text-red' }, why) : null),
      keyed(h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `Remove ${name}`, disabled: busy,
        on: { click: () => { if (busy) return; chosen = chosen.filter(x => x !== c); paint(); } },
      }, '✕'), `na:rm:${i}`));
  }

  function paint() {
    list.replaceChildren(...chosen.map(fileRow));
    list.hidden = !chosen.length;
    title.disabled = chosen.length > 1;
    titleHelp.textContent = chosen.length > 1 ? 'Each file becomes its own asset, titled by its file name.' : 'The id comes from the title and never changes.';
    submit.disabled = busy || !chosen.length || chosen.some(c => c.problem) || (chosen.length === 1 && !title.value.trim());
    submit.textContent = busy ? 'Uploading…' : chosen.length > 1 ? `Upload ${chosen.length} assets` : 'Upload';
    cancel.disabled = busy;
  }

  async function upload() {
    if (submit.disabled) return;
    busy = true;
    showError(error, '');
    paint();
    const done = [];
    const { scope, project } = placeOf();
    const batch = [...chosen];
    for (const c of batch) {
      try {
        const r = await uploadNew(c.file, { scope, project, title: titleFor(c, batch.length === 1), description: description.value, tags: tags.value, note: note.value, pasted: c.pasted });
        done.push(r);
        chosen = chosen.filter(x => x !== c);
      } catch (e) {
        c.error = e.network ? 'It could not be read or sent.' : e.message;
      }
    }
    busy = false;
    if (done.length) {
      toast(done.length === 1 ? `Added ${done[0].asset.title} (${done[0].ref})` : `Added ${done.length} assets`);
      onCreated(done);
    }
    if (!chosen.length) {
      if (holds(body)) { clearGuard(); dialog.close(); }
      return;
    }
    // Files dropped while it ran wait for the next Upload; only a refused one is an error.
    const refused = chosen.some(c => c.error);
    showError(error, !refused ? '' : done.length ? 'Some files were not added; each says why.' : 'Nothing was added; each file says why.');
    paint();
  }

  title.addEventListener('input', () => { titleTouched = true; paint(); });
  submit.addEventListener('click', upload);
  const zone = dropZone({
    key: 'na:drop', label: 'Drop files here, paste with Ctrl+V, or click to choose',
    hint: 'Images (PNG, JPEG, GIF, WebP, BMP) and PDFs up to 25 MB; .md, .txt and .json up to 2 MB. No SVG.',
    accept: ACCEPT.any, onFiles: (f, p) => add(f, p),
  });
  const dirty = () => chosen.length > 0 || titleTouched || !!(description.value.trim() || tags.value.trim() || note.value.trim());
  const body = h('div', { class: 'form lib-new' },
    lockPlace
      ? h('p', { class: 'muted' }, 'For ', h('b', {}, lockedLabel), ' only. Shared assets are added under Assets.')
      : h('label', { for: 'libPlace' }, 'Where', h('small', {}, 'Shared assets can be attached to any project; a project\'s own only to that project.'), placeSelect),
    zone, list,
    h('label', { for: 'libNewTitle' }, 'Title', titleHelp, title),
    h('label', { for: 'libNewDescription' }, 'Description', description),
    h('label', { for: 'libNewTags' }, 'Tags', h('small', {}, 'Separated by commas.'), tags),
    h('label', { for: 'libNewNote' }, 'Note for the first version', note),
    error);
  // While an upload runs, Close, Esc and the backdrop are refused too (the guard), with the reason.
  const guard = () => {
    if (busy) { showError(error, 'The upload is still running: wait for it to finish.'); return false; }
    return !dirty() || confirm('Discard this upload?');
  };
  openDialog('New asset', body, {
    wide: false,
    guard,
    upload: (f, p) => add(f, p),
    actions: [cancel, submit],
  });
  dialog.classList.add('lib-dialog');
  if (files.length) add(files, pasted);
  else paint();
  (lockPlace ? zone.querySelector('.drop') : placeSelect).focus();
  return { add };
}

// ---------------------------------------------------------------- the picker

function pickThumb(a) {
  if (a.kind === 'image' && a.latest) return h('span', { class: 'lib-pick-thumb', 'aria-hidden': 'true' }, h('img', { src: fileUrl(a.ref, a.latest.n), alt: '', loading: 'lazy' }));
  return h('span', { class: 'lib-pick-thumb', 'aria-hidden': 'true' }, kindIcon(a.kind));
}

// Attach assets to `project`: the shared assets plus the project's own from `assets` (a listing;
// archived and unreadable ones are left out; `only: 'shared'` leaves the project's own out too).
// `attached` are the refs it has (shown checked and fixed), `limit` how many it may have.
// onAttach(refs) resolves when they are attached (the dialog closes) or rejects with the reason
// (shown in the dialog).
export function assetPicker({ project, assets = [], attached = [], limit = 50, only = '', onAttach }) {
  const chosen = new Set();
  const taken = new Set(attached);
  const usable = (Array.isArray(assets) ? assets : []).filter(a => a && !a.archived && !a.error && a.latest
    && (a.scope === 'shared' || (!only && a.project === project)));
  const search = h('input', { type: 'search', id: 'libPickSearch', placeholder: 'Search titles, tags and refs', autocomplete: 'off', 'aria-label': 'Search assets' });
  const kind = h('select', { 'aria-label': 'Kind' }, h('option', { value: '' }, 'Every kind'), KINDS.map(k => h('option', { value: k }, kindPlural(k))));
  const list = h('ul', { class: 'lib-pick-list', 'aria-label': 'Assets you can attach' });
  const count = h('span', { class: 'reason push-left' });
  const error = errorBox();
  const attach = keyed(h('button', { class: 'btn primary', type: 'button' }, 'Attach'), 'pk:attach');

  function sync() {
    const room = Math.max(0, limit - taken.size);
    attach.disabled = !chosen.size || chosen.size > room;
    attach.textContent = chosen.size ? `Attach ${chosen.size}` : 'Attach';
    count.textContent = chosen.size > room ? `At most ${limit} can be attached; ${room} more fit.` : chosen.size ? `${plural(chosen.size, 'asset')} chosen` : '';
  }

  function row(a) {
    const isTaken = taken.has(a.ref);
    const box = h('input', {
      type: 'checkbox', checked: isTaken || chosen.has(a.ref), disabled: isTaken,
      on: { change: e => { if (e.target.checked) chosen.add(a.ref); else chosen.delete(a.ref); sync(); } },
    });
    const tagText = (a.tags || []).length ? ` · ${a.tags.join(', ')}` : '';
    return h('li', {}, keyed(h('label', { class: 'lib-pick' }, box, pickThumb(a),
      h('span', { class: 'main' },
        h('span', { class: 'title' }, a.title),
        h('span', { class: 'sub mono' }, a.ref),
        h('span', { class: 'sub' }, `${kindWord(a.kind)} · ${assetMeta(a)}${tagText}`)),
      isTaken ? h('span', { class: 'badge ok' }, 'Attached') : h('span', { class: `badge ${a.scope === 'shared' ? 'blue' : 'violet'}` }, placeWord(a))), `pk:${a.ref}`));
  }

  function paint() {
    const shown = filterAssets(usable, { kind: kind.value, q: search.value });
    list.replaceChildren(...(shown.length ? shown.map(row)
      : [h('li', { class: 'empty' }, usable.length ? 'Nothing matches the search.' : 'There are no assets to attach yet. Add one under Assets, or in the project\'s Assets tab.')]));
    sync();
  }

  search.addEventListener('input', paint);
  kind.addEventListener('change', paint);
  attach.addEventListener('click', async () => {
    if (attach.disabled) return;
    attach.disabled = true;
    showError(error, '');
    try {
      await onAttach([...chosen]);
      dialog.close();
    } catch (e) {
      showError(error, e.message);
      sync();
    }
  });
  openDialog(`Attach assets to ${project}`, h('div', { class: 'form lib-picker' },
    h('p', { class: 'muted' }, only === 'shared' ? 'Shared assets from the library.' : `Shared assets, and ${project}'s own. Each follows its latest version until you pin one.`),
    h('div', { class: 'lib-pick-filters' }, search, kind),
    list, error), {
    wide: true,
    actions: [count, h('button', { class: 'btn', type: 'button', on: { click: closeDialog } }, 'Cancel'), attach],
  });
  dialog.classList.add('lib-dialog');
  paint();
  search.focus();
}
