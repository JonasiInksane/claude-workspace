// Assets: game assets from a project's asset pipeline (projects/<p>/assets/): renders, checks,
// a 3D view of the model (viewer.js), and the user's verdict. A sprite (asset.json "kind":
// "sprite", from tools/sprite.mjs) opens its own dialog instead (sprite-dialog.js: an HD-2D
// diorama and a pixel view). The pipeline's scripts make everything else. The view shows in
// the nav only when a project has a pipeline.
import { act, api, fmtTime, h, plural, qs, toast } from '../lib.js';
import { dialog, openDialog } from '../dialog.js';
import { refresh, state } from '../store.js';
import { createViewer } from '../viewer.js';
import { spriteDialog } from '../sprite-dialog.js';

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

function render(el) {
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Assets'),
    h('p', {}, 'Game assets from each project\'s asset pipeline: renders, checks, the model in 3D, and your verdict.')));
  if (!state.assets.length) {
    el.replaceChildren(head, h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, 'No asset pipeline found'), 'A project shows here when it has tools/asset.mjs (3D) or tools/sprite.mjs (sprites) and an assets/ folder.')));
    return;
  }
  el.replaceChildren(head, h('div', { class: 'stack' }, state.assets.map(p => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, p.project), h('span', { class: 'muted' }, plural(p.assets.length, 'asset'))),
    h('div', { class: 'card-body' }, p.assets.length
      ? h('div', { class: 'asset-grid' }, p.assets.map(a => assetCard(p.project, a)))
      : h('div', { class: 'empty' }, 'No assets yet: node tools/asset.mjs new <style>/<category>/<Name> ...'))))));
}

function checkTable(c) {
  if (!c) return h('p', { class: 'muted' }, 'Not checked at this stage yet.');
  return h('div', {},
    h('p', { class: 'muted small-text' }, [c.checkedAt ? `Checked ${fmtTime(c.checkedAt)}` : '', c.triangles != null ? `${c.triangles} triangles` : '',
      c.dimensionsM ? `${['width', 'depth', 'height'].map(k => Number(c.dimensionsM[k] ?? 0).toFixed(3)).join(' × ')} m (w × d × h)` : ''].filter(Boolean).join(' · ')),
    h('table', { class: 'checks' }, h('tbody', {}, c.checks.map(k => h('tr', { class: k.status },
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
  visible: s => !!s.assets.length,
  render,
};
