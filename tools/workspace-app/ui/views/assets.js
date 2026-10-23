// Assets (#assets), in two sections:
//
// - Library first: the asset library (asset-library.mjs), shared assets and every project's, with
//   filters by place (shared or a project), kind and tag, a search, and Show archived. Each card
//   has a preview: an image's thumbnail from /library-file, the first lines of a text asset
//   (fetched as text and shown as text only: it is untrusted), a PDF's icon. A card opens the
//   asset's details (parts/library-dialogs.js: versions with Open and Download, a new version, the
//   title, description and tags, Archive or Restore). New asset… uploads files as new assets,
//   shared or for a project; files pasted or dropped on the view open it too (main.js onFiles).
// - Then the game assets of every project's asset pipeline (projects/<p>/assets/): renders,
//   checks, a 3D view of the model (viewer.js) and your verdict. A sprite (asset.json "kind":
//   "sprite", from tools/sprite.mjs) opens its own dialog (sprite-dialog.js: an HD-2D diorama and
//   a pixel view). The pipeline's scripts make everything else.
//
// Inbox images (views/images.js, the image upload) opens from the button at the top. The library
// loads on show, after every change and when the window gets the focus back; the filter bar is
// built once and kept, so a repaint never closes a select or moves the caret. projectAssetsCard()
// is also the project page's Assets tab (views/project/assets.js). The pure helpers
// (countText, placeForNew) are exported for views/assets.test.mjs.
import { act, api, checkServer, fmtTime, h, keepFocus, keyed, plural, qs, toast } from '../lib.js';
import { dialog, openDialog } from '../dialog.js';
import { go, refresh, state } from '../store.js';
import { createViewer } from '../viewer.js';
import { spriteDialog } from '../sprite-dialog.js';
import { createMemo } from '../parts/patch.js';
import { filterAssets, KINDS, kindPlural, listLibrary, placeChoices, tagsOf } from '../parts/library.js';
import { assetCard as libraryCard } from '../parts/library-ui.js';
import { newAssetDialog, openAssetDialog } from '../parts/library-dialogs.js';

const assetUrl = (project, path) => `/asset-file?${qs({ project, path })}`;
const STATUS_BADGE = { approved: 'ok', review: 'blue', revise: 'warn', rejected: 'warn' };
let viewer = null;
dialog.addEventListener('close', () => { if (viewer) { viewer.dispose(); viewer = null; } });

function checkBadge(c, label = '') {
  if (!c) return h('span', { class: 'badge' }, `${label}not checked`);
  const parts = [`${c.pass} pass`, c.warn ? `${c.warn} warn` : null, c.fail ? `${c.fail} fail` : null].filter(Boolean);
  return h('span', { class: `badge ${c.fail ? 'warn' : 'ok'}`, title: c.checkedAt ? `checked ${fmtTime(c.checkedAt)}` : null }, `${label}${parts.join(' · ')}`);
}

function assetCard(project, a) {
  const sprite = a.kind === 'sprite';
  return h('button', { class: 'asset-card', on: { click: () => assetDialog(project, a.id) } },
    h('span', { class: 'asset-thumb' }, a.thumb ? h('img', { src: assetUrl(project, a.thumb), alt: '', loading: 'lazy', class: sprite ? 'pixel' : null }) : 'no renders yet'),
    h('span', { class: 'asset-info' },
      h('b', {}, a.name),
      h('span', { class: 'muted' }, `${a.style} · ${a.category} · ${a.cls}`),
      h('span', { class: 'row-actions' },
        h('span', { class: `badge ${STATUS_BADGE[a.status] || ''}` }, a.status || 'no status'),
        sprite ? h('span', { class: 'badge blue' }, 'sprite') : null,
        h('span', { class: 'badge violet' }, a.source),
        checkBadge(a.final))));
}

// One project's assets (an entry of state.assets: { project, assets }) as a card of thumbnails.
export function projectAssetsCard(p) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, p.project), h('span', { class: 'muted' }, plural(p.assets.length, 'asset'))),
    h('div', { class: 'card-body' }, p.assets.length
      ? h('div', { class: 'asset-grid' }, p.assets.map(a => assetCard(p.project, a)))
      : h('div', { class: 'empty' }, 'No assets yet: node tools/asset.mjs new <style>/<category>/<Name> ...')));
}

// ---------------------------------------------------------------- the library section

const memo = createMemo();
const FOCUS_RELOAD_MS = 5000;
let lib = { data: null, error: '', at: 0 }; // GET /api/library?archived=1
const filters = { place: '', kind: '', tag: '', q: '', archived: false };
let section = null;
let parts = null; // the parts built once: { head, bar, controls, results, game }

// "4 of 9 assets" (archived ones count only while they are shown).
export function countText(shown, list, archived = false) {
  const total = (Array.isArray(list) ? list : []).filter(a => a && (archived || !a.archived)).length;
  return shown === total ? plural(total, 'asset') : `${shown} of ${plural(total, 'asset')}`;
}

// Where New asset… starts: the project the place filter shows, else the shared library.
export const placeForNew = place => (String(place || '').startsWith('project:') ? place : 'shared');

async function loadLibrary() {
  try {
    lib = { data: (await listLibrary({ archived: true })).assets || [], error: '', at: Date.now() };
  } catch (e) {
    if (e.network) checkServer();
    lib = { data: lib.data, error: e.message, at: Date.now() };
  }
  paintLibrary();
}

const onFocus = () => { if (Date.now() - lib.at > FOCUS_RELOAD_MS) loadLibrary(); };

function openNew(files = [], pasted = false) {
  newAssetDialog({
    place: placeForNew(filters.place), places: placeChoices(lib.data, state && state.projects), files, pasted, onCreated: () => loadLibrary(),
  });
}

// The filter bar: built once; its selects get new options only when the choices change.
function filterBar() {
  const place = h('select', { id: 'libPlaceFilter', on: { change: e => { filters.place = e.target.value; paintLibrary(); } } });
  const kind = h('select', { id: 'libKindFilter', on: { change: e => { filters.kind = e.target.value; paintLibrary(); } } },
    h('option', { value: '' }, 'Every kind'), KINDS.map(k => h('option', { value: k }, kindPlural(k))));
  const tag = h('select', { id: 'libTagFilter', on: { change: e => { filters.tag = e.target.value; paintLibrary(); } } });
  let typing = 0;
  const search = h('input', {
    id: 'libSearch', type: 'search', placeholder: 'Search titles, descriptions, tags and refs', autocomplete: 'off',
    on: { input: e => { filters.q = e.target.value; clearTimeout(typing); typing = setTimeout(paintLibrary, 120); } },
  });
  const archived = h('input', { type: 'checkbox', on: { change: e => { filters.archived = e.target.checked; paintLibrary(); } } });
  const count = h('span', { class: 'muted small lib-count', 'aria-live': 'polite' });
  const bar = h('div', { class: 'lib-filters', role: 'search', 'aria-label': 'Filter the library' },
    h('label', { for: 'libPlaceFilter' }, h('span', {}, 'Place'), place),
    h('label', { for: 'libKindFilter' }, h('span', {}, 'Kind'), kind),
    h('label', { for: 'libTagFilter' }, h('span', {}, 'Tag'), tag),
    h('label', { for: 'libSearch', class: 'grow' }, h('span', {}, 'Search'), search),
    h('label', { class: 'check' }, archived, 'Show archived'),
    count);
  return { bar, controls: { place, kind, tag, search, archived, count } };
}

function setOptions(select, options, value, key) {
  const sig = JSON.stringify(options);
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(...options.map(o => h('option', { value: o.value }, o.label)));
  }
  const want = options.some(o => o.value === value) ? value : '';
  if (select.value !== want) select.value = want;
  filters[key] = want;
}

function resultsBody() {
  if (!lib.data) {
    return lib.error
      ? h('div', { class: 'note red ck-error' }, h('span', {}, `The library could not be read: ${lib.error}`), ' ',
        keyed(h('button', { class: 'link', type: 'button', on: { click: loadLibrary } }, 'Try again'), 'lib:retry'))
      : h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading the library…')));
  }
  const shown = filterAssets(lib.data, filters);
  if (!lib.data.length) {
    return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No library assets yet'),
      'Reference images, Markdown, text and JSON files and PDFs that runs, flows and project settings can attach, each upload a new version. Shared ones serve every project.',
      h('div', { class: 'mt-4' }, keyed(h('button', { class: 'btn primary', type: 'button', on: { click: () => openNew() } }, 'New asset…'), 'lib:new-empty'))));
  }
  if (!shown.length) {
    return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'Nothing matches these filters'),
      h('div', { class: 'mt-4' }, keyed(h('button', { class: 'btn', type: 'button', on: { click: clearFilters } }, 'Clear the filters'), 'lib:clear'))));
  }
  return h('div', { class: 'lib-grid' }, shown.map(a => libraryCard(a, { onOpen: () => openAssetDialog(a.ref, { onChange: () => loadLibrary() }) })));
}

function clearFilters() {
  Object.assign(filters, { place: '', kind: '', tag: '', q: '', archived: false });
  const c = parts.controls;
  c.place.value = '';
  c.kind.value = '';
  c.tag.value = '';
  c.search.value = '';
  c.archived.checked = false;
  paintLibrary();
  c.search.focus();
}

// The filter options, the count and the cards, from the library answer and the filters.
function paintLibrary() {
  if (!parts || !section) return;
  const c = parts.controls;
  setOptions(c.place, [{ value: '', label: 'Everywhere' }, ...placeChoices(lib.data, state && state.projects)], filters.place, 'place');
  setOptions(c.tag, [{ value: '', label: 'Every tag' }, ...tagsOf(lib.data).map(t => ({ value: t, label: t }))], filters.tag, 'tag');
  const shown = lib.data ? filterAssets(lib.data, filters).length : 0;
  c.count.textContent = lib.data ? countText(shown, lib.data, filters.archived) : '';
  const body = memo('results', [lib.data, lib.error, filters], resultsBody);
  if (parts.results.firstChild !== body) keepFocus(parts.results, () => parts.results.replaceChildren(body));
}

// ---------------------------------------------------------------- the view

function gameAssets() {
  return memo('game', [state.assets], () => (state.assets.length
    ? h('div', { class: 'stack' }, state.assets.map(projectAssetsCard))
    : h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, 'No asset pipeline found'), 'A project shows here when it has tools/asset.mjs (3D) or tools/sprite.mjs (sprites) and an assets/ folder.'))));
}

function buildParts() {
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Assets'),
    h('p', {}, 'The asset library (shared and per project, each upload a new version), then the game assets of each project\'s asset pipeline.')),
  h('div', { class: 'row-actions' },
    keyed(h('button', { class: 'btn primary', type: 'button', title: 'Upload images, text or PDFs as new library assets', on: { click: () => openNew() } }, 'New asset…'), 'lib:new'),
    h('button', {
      class: 'btn', type: 'button', dataset: { key: 'inbox-images' }, title: 'Upload images into the hub inbox, a project or an agent',
      on: { click: () => go('images') },
    }, 'Inbox images')));
  const { bar, controls } = filterBar();
  return { head, bar, controls, results: h('div', { class: 'lib-results' }), game: h('div', {}) };
}

function render(el) {
  section = el;
  if (!parts || !el.contains(parts.head)) {
    parts = buildParts();
    el.replaceChildren(parts.head,
      h('h3', { class: 'sec' }, 'Library'), parts.bar, parts.results,
      h('h3', { class: 'sec' }, 'Game assets'), parts.game);
  }
  paintLibrary();
  const game = gameAssets();
  if (parts.game.firstChild !== game) parts.game.replaceChildren(game);
}

function checkTable(c) {
  if (!c) return h('p', { class: 'muted' }, 'Not checked at this stage yet.');
  return h('div', {},
    h('p', { class: 'muted small-text' }, [c.checkedAt ? `Checked ${fmtTime(c.checkedAt)}` : '', c.triangles != null ? `${c.triangles} triangles` : '',
      c.dimensionsM ? `${['width', 'depth', 'height'].map(k => Number(c.dimensionsM[k] ?? 0).toFixed(3)).join(' × ')} m (w × d × h)` : ''].filter(Boolean).join(' · ')),
    h('table', { class: 'ctable asset-checks' }, h('tbody', {}, c.checks.map(k => h('tr', { class: k.status },
      h('td', {}, h('span', { class: `badge ${k.status === 'pass' ? 'ok' : 'warn'}` }, k.status)),
      h('td', { class: 'mono' }, k.id),
      h('td', { class: 'msg' }, k.message))))));
}

function renderStrip(project, paths) {
  return h('div', { class: 'gallery small strip' }, paths.map(p => h('button', { class: 'pic', title: p.split('/').pop(), on: { click: () => window.open(assetUrl(project, p), '_blank') } },
    h('img', { src: assetUrl(project, p), alt: p.split('/').pop(), loading: 'lazy' }))));
}

async function assetDialog(project, id) {
  let d;
  try { d = await api(`/api/asset?${qs({ project, id })}`); } catch (e) { toast(e.message, true); return; }
  if (d.kind === 'sprite') {
    if (viewer) { viewer.dispose(); viewer = null; }
    const statusBadge = s => h('span', { class: `badge ${STATUS_BADGE[s] || ''}` }, s || 'none');
    return spriteDialog(project, d, { assetUrl, checkTable, renderStrip, statusBadge });
  }
  const a = d.asset;
  const canvas = h('canvas', { class: 'viewer-canvas', 'aria-label': `3D view of ${a.name}` });
  const info = h('span', { class: 'muted small-text' }, 'Loading the model…');
  let model = d.models.final ? 'final' : 'raw';
  const modelButtons = ['final', 'raw'].filter(m => d.models[m]).map(m => h('button', {
    class: `btn small${m === model ? ' primary' : ''}`, dataset: { model: m },
    on: { click: () => { model = m; for (const b of modelButtons) b.classList.toggle('primary', b.dataset.model === m); load(); } },
  }, m === 'final' ? 'Final (export)' : 'Raw (gen)'));
  const turn = h('input', { type: 'checkbox', checked: true, on: { change: () => viewer && viewer.setAutoRotate(turn.checked) } });
  const wire = h('input', { type: 'checkbox', on: { change: () => viewer && viewer.setWire(wire.checked) } });
  async function load() {
    if (!viewer) return;
    info.textContent = 'Loading the model…';
    try { await viewer.load(assetUrl(project, d.models[model])); } catch (e) { info.textContent = e.message; }
  }

  const notes = h('textarea', { rows: 3, placeholder: 'Notes for the verdict (what to change, what is good)', maxlength: 2000 });
  const verdict = v => async () => {
    const r = await act(api('/api/asset-verdict', { method: 'POST', body: { project, id, verdict: v, notes: notes.value } }));
    if (r) { dialog.close(); refresh(); }
  };
  const facts = [
    ['Status', h('span', { class: `badge ${STATUS_BADGE[a.status] || ''}` }, a.status || 'none')],
    ['Style', a.style], ['Class', a.class], ['Source', a.source || 'procedural'],
    ['Size (brief)', a.sizeM ? ['height', 'width', 'depth'].filter(k => a.sizeM[k]).map(k => `${k[0]} ${a.sizeM[k]}`).join(' · ') + ' m' : '?'],
    a.provenance && a.provenance.from ? ['From', `${a.provenance.from}${a.provenance.model ? ` (${a.provenance.model})` : ''}`] : null,
    a.provenance && a.provenance.license ? ['Licence', a.provenance.license] : null,
    d.generation ? ['Generation', `${d.generation.credits} credits${d.generation.finishedAt ? `, ${fmtTime(d.generation.finishedAt)}` : ''}`] : null,
    ['Folder', h('code', {}, d.dir)],
  ].filter(Boolean);

  let stage = d.checks.final ? 'final' : 'raw';
  const checksBox = h('div', {});
  const stageButtons = ['final', 'raw'].map(s => h('button', {
    class: `btn small${s === stage ? ' primary' : ''}`, dataset: { stage: s },
    on: { click: () => { stage = s; for (const b of stageButtons) b.classList.toggle('primary', b.dataset.stage === s); checksBox.replaceChildren(checkTable(d.checks[s])); } },
  }, s === 'final' ? 'Final check' : 'Raw check'));
  checksBox.replaceChildren(checkTable(d.checks[stage]));

  const body = h('div', { class: 'asset-detail' },
    h('div', { class: 'asset-top' },
      h('div', { class: 'viewer' },
        d.models.final || d.models.raw ? canvas : h('div', { class: 'empty' }, 'No model yet.'),
        h('div', { class: 'viewer-bar' }, modelButtons,
          h('label', { class: 'check' }, turn, 'Turn'), h('label', { class: 'check' }, wire, 'Wireframe'),
          h('button', { class: 'btn small ghost', on: { click: () => viewer && viewer.reset() } }, 'Reset view'), info),
        h('p', { class: 'muted small-text' }, 'Drag to turn · scroll to zoom · Shift+drag to pan · double-click to reset')),
      h('div', { class: 'asset-side' },
        h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        h('div', { class: 'verdict' },
          h('div', { class: 'section-label' }, 'Your verdict'),
          notes,
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small primary', on: { click: verdict('approve') } }, 'Approve'),
            h('button', { class: 'btn small', on: { click: verdict('revise') } }, 'Revise'),
            h('button', { class: 'btn small', on: { click: verdict('reject') } }, 'Reject')),
          h('p', { class: 'muted small-text' }, 'Sets the status in asset.json and adds a dated line to the brief\'s log.')))),
    h('div', { class: 'section-label' }, 'Checks', h('span', { class: 'row-actions' }, stageButtons)),
    checksBox,
    d.renders.final.length ? [h('div', { class: 'section-label' }, 'Final renders'), renderStrip(project, d.renders.final)] : null,
    d.renders.raw.length ? [h('div', { class: 'section-label' }, 'Raw renders'), renderStrip(project, d.renders.raw)] : null,
    d.concept.length ? [h('div', { class: 'section-label' }, 'Concept'), renderStrip(project, d.concept)] : null,
    d.log.length ? [h('div', { class: 'section-label' }, 'Brief log (newest first)'), h('ul', { class: 'log' }, d.log.map(l => h('li', {}, l)))] : null);

  openDialog(`${a.name} · ${project}`, body, { wide: true, actions: [h('button', { class: 'btn primary', on: { click: () => dialog.close() } }, 'Close')] });
  dialog.classList.add('asset');
  if (viewer) { viewer.dispose(); viewer = null; }
  if (d.models.final || d.models.raw) {
    try {
      viewer = createViewer(canvas, { onInfo: ({ triangles }) => { info.textContent = `${triangles} triangles`; } });
      load();
    } catch (e) { info.textContent = e.message; }
  }
}

export default {
  id: 'assets',
  label: 'Assets',
  icon: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  count: s => s.assets.reduce((n, p) => n + p.assets.length, 0) || '',
  render,
  onShow() {
    loadLibrary();
    window.addEventListener('focus', onFocus);
  },
  onHide() {
    window.removeEventListener('focus', onFocus);
  },
  // Pasted images and dropped files open New asset with them (main.js routes them here).
  onFiles: (files, pasted) => openNew(files, pasted),
};
