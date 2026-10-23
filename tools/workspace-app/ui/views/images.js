// Inbox images (#images): upload into the hub inbox, a project's shared folder or one agent's
// folder, and the gallery of the chosen folder. The chosen target is remembered in localStorage.
// It is not in the nav: the Assets view opens it (its crumb leads back there, and the nav marks
// Assets while it shows). Exports setTarget (the projects view picks a target, then opens this
// view) and uploadFiles (the flow editor uploads into a flow's folder with it).
import { $, api, copy, fmtSize, h, icon, openPlace, plural, qs, toast } from '../lib.js';
import { openDialog, dialog } from '../dialog.js';
import { go, refresh, state } from '../store.js';

const MAX_UPLOAD = 25 * 1024 * 1024;
const ICON_UPLOAD = '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>';

let currentDir = { key: '', dir: '' }; // folder of the image target, once loaded
let galleryCache = { key: '', nodes: [] }; // shown again while a refresh reloads the gallery
const recentUploads = [];
let imageTarget = loadTarget();

// ---------------------------------------------------------------- image target

function loadTarget() {
  try { return JSON.parse(localStorage.getItem('imageTarget')) || { hub: true }; } catch { return { hub: true }; }
}
export function setTarget(t) {
  imageTarget = t;
  try { localStorage.setItem('imageTarget', JSON.stringify(t)); } catch { /* private mode */ }
}
// A target is { hub: true }, { project, agent } (agent may be '_shared') or { flow, title }.
const targetKey = t => (t.hub ? 'hub' : t.flow ? `f:${t.flow}` : `p:${t.project}/${t.agent}`);
const targetParams = t => (t.hub ? { hub: '1' } : t.flow ? { flow: t.flow } : { project: t.project, agent: t.agent });
function targetLabel(t) {
  if (t.hub) return 'Hub';
  if (t.flow) return `flow ${t.title || t.flow}`;
  return `${t.project} · ${t.agent === '_shared' ? 'shared' : t.agent}`;
}
function allTargets() {
  const list = [{ hub: true }];
  for (const p of state.projects) {
    list.push({ project: p.name, agent: '_shared' });
    for (const a of p.agents.filter(x => x.valid)) list.push({ project: p.name, agent: a.name });
  }
  return list;
}

// ---------------------------------------------------------------- gallery

function lightbox(img) {
  openDialog(img.name, h('div', { class: 'lightbox' },
    h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name }),
    h('p', { class: 'target-path mono' }, img.abs)), {
    wide: true,
    actions: [
      h('button', { class: 'btn', on: { click: () => copy(img.abs) } }, 'Copy path'),
      h('button', { class: 'btn primary', on: { click: () => dialog.close() } }, 'Close'),
    ],
  });
}

// zoom: false inside another dialog (the lightbox would replace it).
function imageTile(img, { zoom = true } = {}) {
  return h('div', { class: 'tile' },
    h('button', { class: 'pic', title: `${img.name} (${fmtSize(img.size)})`, on: { click: () => (zoom ? lightbox(img) : window.open(`/img?${qs({ path: img.path })}`, '_blank')) } },
      h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name, loading: 'lazy' })),
    h('div', { class: 'meta' }, h('span', { title: img.name }, img.name),
      h('button', { class: 'icon-btn', title: 'Copy the full path', on: { click: () => copy(img.abs) } }, 'Copy')));
}

async function loadGallery(box, pathEl) {
  const key = targetKey(imageTarget);
  let r;
  try { r = await api(`/api/images?${qs(targetParams(imageTarget))}`); } catch (e) {
    box.replaceChildren(h('div', { class: 'empty' }, e.message));
    return;
  }
  if (key !== targetKey(imageTarget) || !box.isConnected) return; // target changed or view re-rendered
  currentDir = { key, dir: r.dir };
  pathEl.textContent = r.dir;
  if (!r.images.length) {
    box.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'No images here yet'), 'Drop, paste or choose images above.'));
  } else {
    const days = new Map();
    for (const img of r.images) {
      const d = img.date || 'Not in a dated folder';
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(img);
    }
    box.replaceChildren(...[...days].flatMap(([d, imgs]) => [h('div', { class: 'day' }, d), h('div', { class: 'gallery' }, imgs.map(imageTile))]));
  }
  galleryCache = { key, nodes: [...box.childNodes] };
}

function drawUploads() {
  const list = $('#uploads');
  if (list) list.replaceChildren(...recentUploads.map(u => h('li', { class: u.cls }, u.text)));
}

function render(el) {
  if (!allTargets().some(t => targetKey(t) === targetKey(imageTarget))) setTarget({ hub: true });
  const select = h('select', {
    'aria-label': 'Where images are saved',
    on: { change: e => { setTarget(allTargets().find(t => targetKey(t) === e.target.value) || { hub: true }); render(el); } },
  });
  select.append(h('option', { value: 'hub' }, 'Hub · not for a project yet (triaged later)'));
  for (const p of state.projects) {
    select.append(h('optgroup', { label: p.name },
      h('option', { value: targetKey({ project: p.name, agent: '_shared' }) }, `${p.name} · shared by all agents`),
      p.agents.filter(a => a.valid).map(a => h('option', { value: targetKey({ project: p.name, agent: a.name }) }, `${p.name} · ${a.name}`))));
  }
  select.value = targetKey(imageTarget);

  const key = targetKey(imageTarget);
  const pathEl = h('div', { class: 'target-path mono' }, currentDir.key === key ? currentDir.dir : ' ');
  const input = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, hidden: true,
    on: { change: e => { uploadFiles([...e.target.files], false); e.target.value = ''; } },
  });
  const drop = h('div', {
    class: 'drop', id: 'dropZone', tabindex: '0', role: 'button', 'aria-label': 'Choose images to upload',
    on: {
      click: () => input.click(),
      keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    },
  }, icon(ICON_UPLOAD), h('b', {}, 'Drop images here, or paste with Ctrl+V'),
  h('span', {}, `Saved to ${targetLabel(imageTarget)} in today's folder · PNG, JPEG, GIF, WebP or BMP (saved as PNG) up to 25 MB`));
  // Same target as last time (a refresh): keep the old gallery until the new one is loaded.
  const gallery = h('div', {}, galleryCache.key === key ? galleryCache.nodes : h('div', { class: 'empty' }, 'Loading…'));

  el.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {},
      h('p', { class: 'crumb' }, h('button', { class: 'link', type: 'button', dataset: { key: 'crumb-assets' }, on: { click: () => go('assets') } }, 'Assets'), ' / Inbox images'),
      h('h2', {}, 'Inbox images'),
      h('p', {}, 'Agent images stay with that agent: only its own sessions can read them. Hub images wait in the inbox for triage.'))),
    h('div', { class: 'target-bar' },
      h('label', {}, 'Save to ', select),
      h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'images', ...targetParams(imageTarget) }) } }, 'Open folder'),
      h('button', {
        class: 'btn small',
        on: { click: () => (currentDir.key === targetKey(imageTarget) ? copy(currentDir.dir) : toast('The folder is still loading.', true)) },
      }, 'Copy folder path')),
    pathEl, drop, input,
    h('ul', { class: 'uploads', id: 'uploads' }, recentUploads.map(u => h('li', { class: u.cls }, u.text))),
    gallery,
  );
  loadGallery(gallery, pathEl);
}

// Uploads into `target` (default: the chosen one), one file at a time, with a line per file.
export async function uploadFiles(files, pasted, target = imageTarget) {
  const images = files.filter(f => /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type) || !f.type);
  if (!images.length) { toast('Only PNG, JPEG, GIF, WebP and BMP images can be uploaded.', true); return; }
  let saved = 0;
  for (const f of images) {
    const label = pasted ? 'pasted image' : f.name;
    const entry = { cls: '', text: `Uploading ${label}…` };
    recentUploads.unshift(entry);
    recentUploads.length = Math.min(recentUploads.length, 8);
    drawUploads();
    if (f.size > MAX_UPLOAD) {
      Object.assign(entry, { cls: 'err', text: `${label}: larger than 25 MB` });
      drawUploads();
      continue;
    }
    try {
      const r = await api(`/api/upload?${qs({ ...targetParams(target), name: pasted ? '' : f.name })}`, { method: 'POST', raw: f, contentType: f.type });
      Object.assign(entry, { cls: 'ok', text: `Saved ${r.path}` });
      saved++;
    } catch (e) {
      const why = e.network ? 'could not be read or sent' : e.message;
      Object.assign(entry, { cls: 'err', text: `${label}: ${why}` });
    }
    drawUploads();
  }
  if (saved) toast(`${plural(saved, 'image')} saved to ${targetLabel(target)}`);
  await refresh();
}

export default {
  id: 'images',
  label: 'Inbox images',
  icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  render,
  // Pasted or dropped image files while this view is on screen.
  onFiles: (files, pasted) => uploadFiles(files, pasted),
};
