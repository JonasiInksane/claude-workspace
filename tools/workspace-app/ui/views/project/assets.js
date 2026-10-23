// The project page's Assets tab (#project/<name>/assets, every type): the project's place in the
// asset library (asset-library.mjs): the assets attached in its settings (shared ones or its own,
// each following its latest version or pinned to one) and its own assets (images, Markdown, text,
// JSON and PDFs; each upload of new content a new version).
//
// - New asset…, the drop zone and Ctrl+V on the tab open the upload dialog for a project asset
//   (parts/library-dialogs.js newAssetDialog; files dropped anywhere on the card count too).
// - A card opens the asset's details: its versions with Open and Download, a new version, the
//   title, description and tags, Archive or Restore, and Attach or Detach.
// - Attach shared… (a picker of the shared assets) and each card's Attach or Detach save the
//   project's settings with basedOn, as the Settings tab does: only the attached assets change
//   (the server keeps every other field), and a 409 (saved elsewhere meanwhile) says so and loads
//   them again.
// - A project with an asset pipeline also shows its game assets below (views/assets.js
//   projectAssetsCard: renders, checks, the 3D or sprite view and your verdict).
//
// Data: project-data.js parts `library` (shared assets plus the project's own, archived ones too:
// an attached asset may be archived) and `settings` (the attached assets and the version they
// are in). A project whose folder name the data folder can't hold has assets but no settings, so
// nothing can be attached to it. The pure helpers (pipelineAssets, attachedEntries) are exported
// for assets.test.mjs.
import { api, h, keyed, toast } from '../../lib.js';
import { dialog } from '../../dialog.js';
import { state } from '../../store.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, reload, slot, use } from '../../parts/project-data.js';
import { btn, cardHead, DATA_NAME_RE, errorNote, loadingBody } from '../../parts/project-ui.js';
import { fieldsOf } from '../../parts/settings-form.js';
import { assetCard, dropTarget, dropZone, kindIcon } from '../../parts/library-ui.js';
import { assetPicker, newAssetDialog, openAssetDialog } from '../../parts/library-dialogs.js';
import { projectAssetsCard } from '../assets.js';

const memo = createMemo();
const shownArchived = new Set(); // projects whose archived own assets are shown

// ---------------------------------------------------------------- pure helpers (tested)

// The state.assets entry of a project with an asset pipeline, or null.
export const pipelineAssets = (name, assets = state && state.assets) =>
  (Array.isArray(assets) ? assets.find(a => a && a.project === name) : null) || null;

// The attached assets of the current settings with what the listing knows about each:
// [{ ref, pin, asset (the listing entry, or null when it is missing) }].
export function attachedEntries(current, listing) {
  const byRef = new Map((Array.isArray(listing) ? listing : []).filter(Boolean).map(a => [a.ref, a]));
  return fieldsOf(current).assets.map(a => ({ ref: a.ref, pin: a.pin, asset: byRef.get(a.ref) || null }));
}

// The badge of an attachment's pin: "Latest (v3)", "Pinned to v2", or "v7 missing" for a pin
// past the newest version.
export function pinBadge(pin, asset) {
  const latest = asset && asset.latest ? asset.latest.n : null;
  if (!Number.isSafeInteger(pin)) return { text: latest ? `Follows the latest (v${latest})` : 'Follows the latest', cls: 'ok' };
  if (latest && pin > latest) return { text: `v${pin} missing`, cls: 'red', title: 'That version is not there.' };
  return { text: `Pinned to v${pin}`, cls: 'blue' };
}

// ---------------------------------------------------------------- attaching

// Saves the project's attached assets as `change(list)` makes them (a list of { ref, pin }),
// based on the version on screen. Only `assets` is sent; the server keeps the other fields.
async function writeAttachments(name, change, done) {
  const d = dataOf(slot(name).settings);
  if (!d) { toast('The project settings are still loading; try again in a moment.', true); return false; }
  const current = d.current || null;
  try {
    const r = await api('/api/project-settings', {
      method: 'POST', body: { project: name, basedOn: current ? current.version : 0, assets: change(fieldsOf(current).assets) },
    });
    toast(r.unchanged ? r.message : `${done} (settings v${r.version})`);
    return true;
  } catch (e) {
    toast(e.status === 409 ? `The settings of ${name} changed elsewhere meanwhile. They are loaded again: try once more.` : e.message, true);
    return false;
  } finally {
    await reload(name);
  }
}

const attach = (name, refs, title) => writeAttachments(name,
  list => [...list, ...refs.filter(ref => !list.some(a => a.ref === ref)).map(ref => ({ ref, pin: null }))],
  refs.length === 1 ? `Attached ${title || refs[0]} to ${name}` : `Attached ${refs.length} assets to ${name}`);

const detach = (name, ref, title) => writeAttachments(name, list => list.filter(a => a.ref !== ref), `Detached ${title || ref} from ${name}`);

// ---------------------------------------------------------------- the cards

const places = name => [{ value: `project:${name}`, label: name }];

function openNew(name, files = [], pasted = false) {
  newAssetDialog({ place: `project:${name}`, places: places(name), lockPlace: true, files, pasted, onCreated: () => reload(name) });
}

// The details of an asset, with Attach or Detach for this project when it can have settings.
function openDetails(name, a, canAttach) {
  const isAttached = () => {
    const d = dataOf(slot(name).settings);
    return fieldsOf(d && d.current).assets.some(x => x.ref === a.ref);
  };
  openAssetDialog(a.ref, {
    onChange: () => reload(name),
    attach: canAttach ? { project: name, attached: isAttached, toggle: () => (isAttached() ? detach(name, a.ref, a.title) : attach(name, [a.ref], a.title)) } : null,
  });
}

// An attached ref the library no longer has.
function missingCard(name, entry, canAttach) {
  return h('div', { class: 'lib-card broken' },
    h('span', { class: 'lib-open lib-missing' },
      h('span', { class: 'lib-thumb broken', 'aria-hidden': 'true' }, kindIcon('broken'), h('span', {}, 'Missing')),
      h('span', { class: 'lib-info' }, h('b', { class: 'lib-title' }, entry.ref), h('span', { class: 'lib-meta' }, 'Not in the library any more'))),
    h('div', { class: 'lib-card-foot' },
      h('span', { class: 'row-actions lib-badges' }, h('span', { class: 'badge red' }, 'Missing')),
      canAttach ? h('span', { class: 'row-actions lib-actions' }, btn(`pa:detach:${entry.ref}`, 'Detach', () => detach(name, entry.ref), { ariaLabel: `Detach ${entry.ref}` })) : null));
}

function attachedCard(name, entry, canAttach) {
  if (!entry.asset) return missingCard(name, entry, canAttach);
  const a = entry.asset;
  return assetCard(a, {
    keyPrefix: 'pa', onOpen: () => openDetails(name, a, canAttach), badges: [pinBadge(entry.pin, a)],
    actions: canAttach ? [btn(`pa:detach:${a.ref}`, 'Detach', () => detach(name, a.ref, a.title), { ariaLabel: `Detach ${a.title}` })] : [],
  });
}

function ownCard(name, a, canAttach) {
  return assetCard(a, {
    keyPrefix: 'pa', onOpen: () => openDetails(name, a, canAttach),
    actions: canAttach && !a.error ? [btn(`pa:attach:${a.ref}`, 'Attach', () => attach(name, [a.ref], a.title), { ariaLabel: `Attach ${a.title} to ${name}` })] : [],
  });
}

function libraryCard(name) {
  const L = slot(name).library;
  const S = slot(name).settings;
  const listing = dataOf(L) ? dataOf(L).assets || [] : null;
  const named = DATA_NAME_RE.test(name);
  const settings = dataOf(S);
  const canAttach = named && !!settings;
  const showArchived = shownArchived.has(name);
  return memo(`library:${name}`, [listing, settings && settings.current, L && L.error, S && S.error, showArchived, named], () => {
    const attachShared = btn(`pa:attach-shared:${name}`, 'Attach shared…', () => assetPicker({
      project: name, assets: listing || [], only: 'shared', limit: settings ? settings.limits.assets : 50,
      attached: fieldsOf(settings && settings.current).assets.map(a => a.ref),
      onAttach: async refs => { if (!(await attach(name, refs))) throw new Error('Nothing was attached; see the message.'); },
    }), { disabled: !canAttach || !listing, describedBy: named ? null : `pa-why-${name}` });
    const newBtn = btn(`pa:new:${name}`, 'New asset…', () => openNew(name), { cls: 'btn small primary' });
    const own = (listing || []).filter(a => a.scope === 'project');
    const archivedCount = own.filter(a => a.archived).length;
    // Keyed: toggling it rebuilds the card, and the repaint puts the focus back on it.
    const toggle = archivedCount ? h('label', { class: 'check' },
      keyed(h('input', { type: 'checkbox', checked: showArchived, on: { change: e => { if (e.target.checked) shownArchived.add(name); else shownArchived.delete(name); reload(name); } } }), `pa:archived:${name}`),
      `Show archived (${archivedCount})`) : null;
    const head = cardHead('Library assets', toggle, attachShared, newBtn);
    if (!listing) {
      return h('div', { class: 'card' }, head, L && L.error ? h('div', { class: 'card-body' }, errorNote(L.error, 'library')) : loadingBody());
    }
    const attached = attachedEntries(settings && settings.current, listing);
    const attachedRefs = new Set(attached.map(e => e.ref));
    const ownShown = own.filter(a => !attachedRefs.has(a.ref) && (showArchived || !a.archived));
    const zone = dropZone({
      key: `pa:drop:${name}`, label: 'Drop files here, paste with Ctrl+V, or click to choose',
      hint: `They become assets of ${name}: images and PDFs up to 25 MB, .md, .txt and .json up to 2 MB.`, onFiles: (files, pasted) => openNew(name, files, pasted),
    });
    const card = h('div', { class: 'card pa-library' }, head, h('div', { class: 'card-body vgrid' },
      named ? null : h('p', { class: 'note', id: `pa-why-${name}` }, 'Assets can be attached only to a project whose folder name is lowercase letters, digits and single hyphens (it needs settings).'),
      S && S.error && named ? errorNote(`The settings could not be loaded: ${S.error}`, 'settings') : null,
      zone,
      named ? h('div', {},
        h('div', { class: 'section-label' }, h('span', {}, `Attached in its settings (${attached.length})`)),
        attached.length ? h('div', { class: 'lib-grid' }, attached.map(e => attachedCard(name, e, canAttach)))
          : h('p', { class: 'muted small' }, 'Nothing attached yet. Attach a shared asset, or one of the project\'s own below: runs, sessions and flows started here get what is attached.')) : null,
      h('div', {},
        h('div', { class: 'section-label' }, h('span', {}, named ? `Its own, not attached (${ownShown.length})` : `Its own (${ownShown.length})`)),
        ownShown.length ? h('div', { class: 'lib-grid' }, ownShown.map(a => ownCard(name, a, canAttach)))
          : h('p', { class: 'muted small' }, own.length ? 'Every asset of its own is attached.' : `No assets of its own yet: drop a file above, or use New asset….`))));
    dropTarget(card, { zone: zone.querySelector('.drop'), onFiles: (files, pasted) => openNew(name, files, pasted) });
    return card;
  });
}

// ---------------------------------------------------------------- paste on the tab

let pasteFor = '';

// Ctrl+V with files on the tab (not in a dialog: main.js gives those to the dialog). Text pasted
// into a text box stays text.
function onPaste(e) {
  if (!pasteFor || e.defaultPrevented || dialog.open || document.querySelector('dialog[open]')) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return;
  const tag = e.target && e.target.tagName;
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && [...(e.clipboardData.types || [])].includes('text/plain')) return;
  e.preventDefault();
  openNew(pasteFor, files, true);
}

// ---------------------------------------------------------------- the tab

let release = () => {};

export default {
  id: 'assets',
  label: 'Assets',
  render(el, ctx) {
    const name = ctx.project.name;
    const entry = pipelineAssets(name);
    patch(el, [
      libraryCard(name),
      entry ? memo(`pipe-head:${name}`, [], () => h('div', { class: 'sec' }, 'Game assets from the asset pipeline')) : null,
      entry ? memo(`pipeline:${name}`, [entry], () => projectAssetsCard(entry)) : null,
    ]);
  },
  onShow(ctx) {
    release();
    const name = ctx.project.name;
    release = use(name, DATA_NAME_RE.test(name) ? ['library', 'settings'] : ['library']);
    pasteFor = name;
    document.addEventListener('paste', onPaste);
  },
  onHide() {
    release();
    release = () => {};
    pasteFor = '';
    document.removeEventListener('paste', onPaste);
  },
};
