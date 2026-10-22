// The page's entry point (index.html loads it as a module). It builds the nav and one <section>
// per view from VIEWS, routes by the URL hash (#<view> or #<view>/<sub>, so Back works and each
// view has a URL), renders the current view whenever the state changes, sends pasted and
// dropped image files to the open dialog or the current view, and sends the heartbeat.
//
// A view module default-exports:
//   { id, label, icon, render(el, ctx), count?(state), visible?(state), onShow?(), onHide?(),
//     onFiles?(files, pasted) }
// render() fills `el` (its section) and runs on every state change while the view is shown;
// ctx is { state, sub, go, refresh }. icon is SVG inner markup (fixed, no data). count() gives
// the number next to the nav label ('' for none); visible() hides the nav entry. onFiles
// receives image files pasted or dropped while the view is on screen.
import { $, api, checkServer, h, isStopped, launch, openPlace, plural, toast } from './lib.js';
import { dialog, getDialogUpload } from './dialog.js';
import { go, hashFor, msSinceRefresh, parseHash, refresh, setView, state, sub, subscribe, view } from './store.js';
import home from './views/home.js';
import flows from './views/flows.js';
import tools from './views/tools.js';
import projects from './views/projects.js';
import assets from './views/assets.js';
import images from './views/images.js';

// The views in nav order. A new view: its module here, and its CSS file (if any) in index.html.
const VIEWS = [home, flows, tools, projects, assets, images];
const byId = new Map(VIEWS.map(v => [v.id, v]));
const navButtons = new Map();
const navCounts = new Map();
const sections = new Map();
let shown = ''; // the view on screen, '' before the first show()

// Fixed icon markup (no data inside), in the nav's own style.
function navIcon(markup) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${markup}</svg>`;
  return t.content.firstChild;
}

function buildShell() {
  for (const v of VIEWS) {
    const count = v.count ? h('span', { class: 'count' }) : null;
    // A view that can be hidden starts hidden until the state says otherwise.
    const button = h('button', { dataset: { view: v.id }, hidden: !!v.visible, on: { click: () => go(v.id) } }, navIcon(v.icon), v.label, count);
    navButtons.set(v.id, button);
    if (count) navCounts.set(v.id, count);
    $('nav').append(button);
    const section = h('section', { class: 'view', id: `view-${v.id}`, hidden: true });
    sections.set(v.id, section);
    $('main').append(section);
  }
}

// The sidebar (counts, hub buttons, tool hints) and the current view.
function render() {
  if (!state) return;
  $('#rootPath').textContent = state.root.split(/[\\/]/).pop();
  $('#rootPath').title = state.root;
  for (const v of VIEWS) {
    if (v.count) navCounts.get(v.id).textContent = v.count(state);
    if (v.visible) navButtons.get(v.id).hidden = !v.visible(state);
  }
  const missing = [];
  if (!state.tools.claude) missing.push('Claude Code not found');
  if (!state.tools.wt) missing.push('no Windows Terminal (new windows instead)');
  $('#toolsInfo').textContent = missing.join(' · ') || `Today ${state.today}`;
  for (const id of ['#startHub', '#continueHub']) $(id).disabled = !state.tools.claude;
  // Re-rendering replaces the view; keep the reader's place (show() scrolls to the top itself).
  const main = $('main');
  const top = main.scrollTop;
  byId.get(view).render(sections.get(view), { state, sub, go, refresh });
  main.scrollTop = top;
}

// Shows a view (unknown ids show home). The hash is corrected without a new history entry.
function show(id, subPath = '') {
  const next = byId.has(id) ? id : 'home';
  if (!byId.has(id)) subPath = '';
  if (shown && shown !== next && byId.get(shown).onHide) byId.get(shown).onHide();
  setView(next, subPath);
  for (const [vid, b] of navButtons) b.classList.toggle('active', vid === next);
  for (const [vid, s] of sections) s.hidden = vid !== next;
  const hash = hashFor(next, subPath);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const changed = shown !== next;
  shown = next;
  render();
  $('main').scrollTop = 0;
  if (changed && byId.get(next).onShow) byId.get(next).onShow();
}

// ---------------------------------------------------------------- events

buildShell();
subscribe(render);
$('#startHub').addEventListener('click', () => launch({ kind: 'hub' }));
$('#continueHub').addEventListener('click', () => launch({ kind: 'hub', continueLast: true }));
$('#openNavigator').addEventListener('click', () => openPlace({ place: 'navigator' }));
$('#refresh').addEventListener('click', () => refresh());
window.addEventListener('focus', () => {
  ping();
  if (msSinceRefresh() > 5000) refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
window.addEventListener('hashchange', () => { const r = parseHash(); show(r.id, r.sub); });

document.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (dialog.open) {
    const upload = getDialogUpload();
    if (!upload) return;
    // Copies from Office apps carry text and a picture: in a text box, paste the text.
    const inTextBox = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (inTextBox && [...e.clipboardData.types].includes('text/plain')) return;
    e.preventDefault();
    upload(files, true);
    return;
  }
  const current = byId.get(view);
  if (!current.onFiles) return;
  e.preventDefault();
  current.onFiles(files, true);
});
// File drags only: text drags (for example inside the New agent form) behave as usual.
// A dropped file would otherwise make the window navigate to it.
const hasFiles = e => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = dialog.open ? (getDialogUpload() ? dialog.querySelector('.drop') : null)
    : byId.get(view).onFiles ? sections.get(view).querySelector('.drop') : null;
  if (zone) zone.classList.add('over');
});
const clearDropZones = () => { for (const z of document.querySelectorAll('.drop.over')) z.classList.remove('over'); };
document.addEventListener('dragleave', e => { if (e.relatedTarget === null) clearDropZones(); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  clearDropZones();
  const upload = dialog.open ? getDialogUpload() : byId.get(view).onFiles;
  if (dialog.open && !upload) { toast('Close the dialog first, then drop the files.', true); return; }
  if (!upload) { toast('Open Images (or a flow) first, then drop the files there.', true); return; }
  const files = [];
  let folders = 0;
  for (const item of [...e.dataTransfer.items]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) { folders++; continue; }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  if (folders) toast(`${plural(folders, 'folder')} skipped: drop the images themselves.`, true);
  if (!files.length) return;
  upload(files, false);
});

// Heartbeat: the server stops itself a few minutes after the last window closes.
function ping() {
  if (isStopped()) return;
  api('/api/ping', { method: 'POST' }).catch(e => { if (e.network) checkServer(); });
}
setInterval(ping, 15000);
ping();

const start = parseHash();
show(start.id || 'home', start.sub);
refresh();
