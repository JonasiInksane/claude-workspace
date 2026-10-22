// The Assets view's dialog for a sprite (an asset whose asset.json says "kind": "sprite";
// views/assets.js opens it): the HD-2D diorama and the pixel view (sprite-viewer.js) with the
// animation, direction and lighting controls, the palette, the facts and the verdict; then the
// checks, the review images, the concept images and the brief's log.
import { act, api, fmtTime, h } from './lib.js';
import { dialog, openDialog } from './dialog.js';
import { refresh } from './store.js';
import { createPixelView, createSpriteViewer, loadSprite } from './sprite-viewer.js';

let views = []; // the open dialog's viewers; closing the dialog frees them
dialog.addEventListener('close', () => { for (const v of views) v.dispose(); views = []; });

// The direction picker, laid out as on a map seen from the camera (south faces you).
const COMPASS = [['north-west', '↖'], ['north', '↑'], ['north-east', '↗'], ['west', '←'], null, ['east', '→'],
  ['south-west', '↙'], ['south', '↓'], ['south-east', '↘']];
const OPTIONS = [['night', 'Night', false], ['torch', 'Torch', true], ['shadows', 'Shadows', true], ['normals', 'Normal map', true],
  ['dof', 'Depth of field', true], ['bloom', 'Bloom', true]];

// kit: helpers shared with the 3D dialog: assetUrl, checkTable, renderStrip, statusBadge.
export async function spriteDialog(project, d, { assetUrl, checkTable, renderStrip, statusBadge }) {
  for (const v of views) v.dispose();
  views = [];
  const a = d.asset;
  const hasSheet = !!(d.sprite && d.sprite.sheet && d.sprite.json);
  let viewer = null;
  let pixels = null;

  const stage = h('canvas', { class: 'viewer-canvas sprite-stage', 'aria-label': `HD-2D view of ${a.name}` });
  const pixelCanvas = h('canvas', { class: 'sprite-pixels', 'aria-label': `Pixels of ${a.name}` });
  const info = h('span', { class: 'muted small-text' }, hasSheet ? 'Loading the sprite…' : '');
  const frameInfo = h('span', { class: 'muted small-text mono' }, '');
  const palette = h('div', { class: 'swatches' });
  const animSelect = h('select', { class: 'sprite-select', 'aria-label': 'Animation', on: { change: () => setAnim(animSelect.value) } });
  const dirButtons = new Map();
  const compass = h('div', { class: 'compass', role: 'group', 'aria-label': 'Direction' }, COMPASS.map(c => {
    if (!c) return h('span', { class: 'compass-mid' });
    const b = h('button', { class: 'btn small', title: c[0], 'aria-label': `Face ${c[0]}`, on: { click: () => setDir(c[0]) } }, c[1]);
    dirButtons.set(c[0], b);
    return b;
  }));
  const walk = h('input', { type: 'checkbox', on: { change: () => { if (viewer) viewer.setWalk(walk.checked); } } });
  const toggles = OPTIONS.map(([key, label, on]) => {
    const input = h('input', { type: 'checkbox', checked: on, dataset: { key }, on: { change: () => { if (viewer) viewer.setOption(key, input.checked); } } });
    return h('label', { class: 'check' }, input, label);
  });
  const zoom = h('select', { class: 'sprite-select', 'aria-label': 'Zoom', on: { change: () => pixels && pixels.setZoom(Number(zoom.value)) } },
    [1, 2, 3, 4, 5, 6, 8].map(n => h('option', { value: n, selected: n === 4 }, `${n}×`)));
  const play = h('button', { class: 'btn small', on: { click: () => { if (pixels) { pixels.toggle(); play.textContent = pixels.playing ? 'Pause' : 'Play'; } } } }, 'Pause');
  const step = delta => h('button', { class: 'btn small', 'aria-label': delta < 0 ? 'Previous frame' : 'Next frame',
    on: { click: () => { if (pixels) { pixels.step(delta); play.textContent = 'Play'; } } } }, delta < 0 ? '◀' : '▶');

  function setAnim(name) {
    if (viewer) viewer.setAnimation(name);
    if (pixels) pixels.setAnimation(name);
  }
  function setDir(dir) {
    if (walk.checked) { walk.checked = false; if (viewer) viewer.setWalk(false); }
    if (viewer) viewer.setDirection(dir);
    if (pixels) pixels.setDirection(dir);
  }
  const showDir = dir => { for (const [k, b] of dirButtons) b.classList.toggle('primary', k === dir); };

  const notes = h('textarea', { rows: 3, placeholder: 'Notes for the verdict (what to change, what is good)', maxlength: 2000 });
  const verdict = v => async () => {
    const r = await act(api('/api/asset-verdict', { method: 'POST', body: { project, id: d.id, verdict: v, notes: notes.value } }));
    if (r) { dialog.close(); refresh(); }
  };
  const check = d.checks.final;
  const gen = d.generation;
  const factsBox = h('dl', { class: 'facts' });
  const facts = extra => [
    ['Status', statusBadge(a.status)],
    ['Style', a.style], ['Class', a.class], ['Source', a.source || '?'],
    check && check.heightPx ? ['Character', `${check.heightPx} px tall${check.widthPx ? `, ${check.widthPx} px wide` : ''}`] : null,
    check && check.colors ? ['Colours', String(check.colors)] : null,
    ...extra,
    a.provenance && a.provenance.from ? ['From', `${a.provenance.from}${a.provenance.model ? ` (${a.provenance.model})` : ''}`] : null,
    a.provenance && a.provenance.license ? ['Licence', a.provenance.license] : null,
    gen ? ['Generation', [gen.usd != null ? `$${Number(gen.usd).toFixed(2)}` : '', gen.generations != null ? `${gen.generations} generations` : '',
      gen.credits != null ? `${gen.credits} credits` : '', gen.finishedAt ? fmtTime(gen.finishedAt) : ''].filter(Boolean).join(', ') || 'recorded'] : null,
    ['Folder', h('code', {}, d.dir)],
  ].filter(Boolean);
  const showFacts = (extra = []) => factsBox.replaceChildren(...facts(extra).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  showFacts();

  const strip = paths => { const s = renderStrip(project, paths); s.classList.add('pixel'); return s; };
  const body = h('div', { class: 'asset-detail' },
    h('div', { class: 'asset-top' },
      h('div', { class: 'viewer' },
        hasSheet ? stage : h('div', { class: 'empty' }, h('b', {}, 'No sprite sheet yet'), 'node tools/sprite.mjs finalize <asset> writes export/SPR_<Name>.png and .json.'),
        hasSheet ? h('div', { class: 'viewer-bar' }, h('label', { class: 'check' }, 'Animation', animSelect), h('label', { class: 'check' }, walk, 'Walk around'),
          toggles, h('button', { class: 'btn small ghost', on: { click: () => viewer && viewer.reset() } }, 'Reset view'), info) : null,
        hasSheet ? h('p', { class: 'muted small-text' }, 'Drag to orbit · scroll to zoom · double-click to reset. Walk around turns the character by its movement, as in a game.') : null),
      h('div', { class: 'asset-side' },
        hasSheet ? h('div', { class: 'sprite-pixel-box' },
          pixelCanvas,
          h('div', { class: 'sprite-bar' }, compass,
            h('div', { class: 'sprite-play' }, h('div', { class: 'row-actions' }, step(-1), play, step(1)), h('label', { class: 'check' }, 'Zoom', zoom), frameInfo)),
          palette) : null,
        factsBox,
        h('div', { class: 'verdict' },
          h('div', { class: 'section-label' }, 'Your verdict'),
          notes,
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small primary', on: { click: verdict('approve') } }, 'Approve'),
            h('button', { class: 'btn small', on: { click: verdict('revise') } }, 'Revise'),
            h('button', { class: 'btn small', on: { click: verdict('reject') } }, 'Reject')),
          h('p', { class: 'muted small-text' }, 'Sets the status in asset.json and adds a dated line to the brief\'s log.')))),
    h('div', { class: 'section-label' }, 'Checks'),
    checkTable(check),
    d.renders.final.length ? [h('div', { class: 'section-label' }, 'Review images'), strip(d.renders.final)] : null,
    d.concept.length ? [h('div', { class: 'section-label' }, 'Concept'), renderStrip(project, d.concept)] : null,
    d.log.length ? [h('div', { class: 'section-label' }, 'Brief log (newest first)'), h('ul', { class: 'log' }, d.log.map(l => h('li', {}, l)))] : null);

  openDialog(`${a.name} · ${project}`, body, { wide: true, actions: [h('button', { class: 'btn primary', on: { click: () => dialog.close() } }, 'Close')] });
  dialog.classList.add('asset', 'sprite');
  if (!hasSheet) return;

  try {
    viewer = createSpriteViewer(stage, {
      onInfo: i => { showDir(i.dir); if (!i.walking && i.anim && animSelect.value !== i.anim) animSelect.value = i.anim; },
      onError: m => { info.textContent = m; },
    });
    views.push(viewer);
  } catch (e) { info.textContent = e.message; }
  pixels = createPixelView(pixelCanvas, {
    onFrame: f => { frameInfo.textContent = `${f.anim} · ${f.dir} · ${f.index + 1}/${f.count} · ${f.duration} ms`; },
  });
  views.push(pixels);
  const url = path => (path ? assetUrl(project, path) : '');
  try {
    const sprite = await loadSprite({ json: url(d.sprite.json), sheet: url(d.sprite.sheet), normal: url(d.sprite.normal), emissive: url(d.sprite.emissive) });
    if (!pixelCanvas.isConnected) return; // the dialog closed or changed while loading
    animSelect.replaceChildren(...sprite.names.map(n => h('option', { value: n }, n)));
    // The largest zoom at which a whole cell fits the pixel view (about 240 px).
    const fit = [1, 2, 3, 4, 5, 6, 8].filter(n => n * Math.max(sprite.cell.w, sprite.cell.h) <= 240).pop() || 1;
    zoom.value = String(fit);
    pixels.setZoom(fit);
    await pixels.load(sprite);
    if (viewer) await viewer.load(sprite);
    for (const input of toggles.map(t => t.querySelector('input'))) {
      if (input.dataset.key === 'normals' && !sprite.normalMap) { input.checked = false; input.disabled = true; }
    }
    palette.replaceChildren(...sprite.palette.map(hex => { const s = h('span', { class: 'swatch', title: hex }); s.style.backgroundColor = hex; return s; }));
    showFacts([['Cell', `${sprite.cell.w} × ${sprite.cell.h} px, ${sprite.ppm} px per metre`],
      ['Sheet', `${sprite.frames.length} frames, ${sprite.names.length} animations${sprite.emissiveMap ? ', glowing pixels' : ''}`]]);
    info.textContent = '';
  } catch (e) {
    info.textContent = e.message;
  }
}
