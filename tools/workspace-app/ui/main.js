// The page's entry point (index.html loads it as a module). It builds the sidebar and one
// <section> per view, routes by the URL hash (#<route> or #<route>/<sub>, so Back works and
// every screen has a URL; a screen with unsaved work asks before it is left, parts/leave-guard.js),
// renders the current view whenever the store changes, and runs the
// shell's background work: the heartbeat, refresh on focus, the live-update stream with its
// polling fallback, notifications, the theme toggle, the palette and the keyboard shortcuts.
// Pasted and dropped image files go to the open dialog or the current view (unchanged).
//
// A view module default-exports:
//   { id, label, icon, render(el, ctx), count?(state), visible?(state), onShow?(ctx), onHide?(),
//     onFiles?(files, pasted) }
// render() fills `el` (its section) and runs on every store change while the view is shown;
// ctx is { state, sub, go, refresh, project }. icon is SVG inner markup (fixed, no data).
// onShow/onHide run when the view or its sub-route (for example the run id) comes and goes:
// a view starts its polling in onShow (store.livePoll) and stops it in onHide. count() and
// visible() feed the nav entry of a plain view (Projects, Flows, Assets...). onFiles receives
// image files pasted or dropped while the view is on screen.
//
// The nav (SPEC 5.1, hub spec plan A2; parts/nav.js builds it): Today; Projects with every
// project nested under it (a code project shows its amber waiting count); Assets; Flows; Runs
// (running count) with up to three runs waiting at a review gate under it. Library sits at the
// foot of the sidebar, above the Hub session buttons. A project's page (#project/<name>/<tab>,
// views/project.js) has the tabs of its type; the old #cockpit and #health links open its
// Overview and Architecture tabs. Counts are aria-hidden and have their own screen-reader text;
// the active entry has aria-current="page".
import { $, announce, api, checkServer, focusedKey, h, icon, isStopped, isTyping, keepFocus, keyed, launch, openPlace, plural, restoreFocus, toast } from './lib.js';
import { dialog, getDialogUpload } from './dialog.js';
import {
  canonicalProjectSub, currentProject, emitSignal, go, hashFor, live, loadPipelines, loadRuns, loadSettings, msSinceRefresh, notifyOn,
  parseHash, refresh, restoreProject, reviewWaits, runningCount, setLive, setTitleBadge, setView, state, sub, subscribe, view, viewOf,
  waitingCount,
} from './store.js';
import { initPalette, isPaletteOpen, openPalette, togglePalette } from './parts/palette.js';
import { footItems, isCurrentItem, navItems as buildNav } from './parts/nav.js';
import { mayLeave } from './parts/leave-guard.js';
import today from './views/today.js';
import project from './views/project.js';
import launcher from './views/launcher.js';
import run from './views/run.js';
import review from './views/review.js';
import runs from './views/runs.js';
import home from './views/home.js';
import flows from './views/flows.js';
import tools from './views/tools.js';
import projects from './views/projects.js';
import assets from './views/assets.js';
import images from './views/images.js';

// Every view module. A new view: its module here, and its CSS file (if any) in index.html.
// home (the old dashboard) is no longer a view: Today replaced it, and #home shows Today
// (store.ROUTE_VIEWS). Its import above stays until views/home.js itself is retired.
const VIEWS = [today, project, launcher, run, review, runs, flows, tools, projects, assets, images];
const byId = new Map(VIEWS.map(v => [v.id, v]));
const sections = new Map();
let shown = ''; // the view on screen, '' before the first show()
let shownSub = '';
let navSignature = '';

function buildShell() {
  for (const v of VIEWS) {
    const section = h('section', { class: 'view', id: `view-${v.id}`, hidden: true });
    sections.set(v.id, section);
    $('main').append(section);
  }
}

const ctx = () => ({ state, sub, go, refresh, project: currentProject });

// ---------------------------------------------------------------- the sidebar

// The views behind the nav entries (parts/nav.js reads their icon and count).
const NAV_VIEWS = { today, projects, assets, flows, runs, tools };

// The nav entries for the current state: { key, route, sub, label, icon, count, countCls, sr, cls }.
const navItems = () => buildNav(state, { views: NAV_VIEWS, running: runningCount(), reviews: reviewWaits() });
const isCurrent = item => isCurrentItem(item, view, sub);

function navButton(item) {
  const hasCount = item.count !== '' && item.count != null && item.count !== 0;
  return keyed(h('button', {
    type: 'button', class: item.cls || null, title: item.title || null, 'aria-current': isCurrent(item) ? 'page' : null,
    on: { click: () => go(item.route, item.sub || '') },
  },
  item.icon ? icon(item.icon) : null,
  h('span', { class: 'nav-text' }, item.label),
  hasCount ? h('span', { class: `count${item.countCls ? ` ${item.countCls}` : ''}`, 'aria-hidden': 'true' }, String(item.count)) : null,
  hasCount && item.sr ? h('span', { class: 'sr-only' }, item.sr) : null), item.key);
}

// Rebuilds the nav (and the Library entry at the foot) only when something in it changed, and
// keeps the focus on the same entry.
function renderNav() {
  const main = navItems().map(it => ({ ...it, current: isCurrent(it) }));
  const foot = footItems(state, { views: NAV_VIEWS }).map(it => ({ ...it, current: isCurrent(it) }));
  const signature = JSON.stringify([main, foot].map(list => list.map(({ icon: _i, ...rest }) => rest)));
  if (signature === navSignature) return;
  navSignature = signature;
  for (const [nav, items] of [[$('#nav'), main], [$('#navFoot'), foot]]) {
    const key = focusedKey(nav);
    nav.replaceChildren(...items.map(navButton));
    restoreFocus(nav, key);
  }
}

function renderSide() {
  $('#rootPath').textContent = state.root.split(/[\\/]/).pop();
  $('#rootPath').title = state.root;
  $('#sideDate').textContent = state.today ? sideDate(state.today) : '';
  const notes = [];
  if (!state.tools.claude) notes.push('Claude Code was not found, so Hub session is off.');
  if (!state.tools.wt) notes.push('No Windows Terminal: sessions open in new windows.');
  $('#toolsInfo').textContent = notes.join(' ');
  $('#toolsInfo').hidden = !notes.length;
  for (const id of ['#startHub', '#continueHub']) $(id).disabled = !state.tools.claude;
  renderNav();
}

// "Thu 2026-10-22"
function sideDate(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? ymd : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${ymd}`;
}

// ---------------------------------------------------------------- views and routes

// The sidebar and the current view. Re-rendering replaces the view; the reader's place and the
// focused row (data-key) are kept. A project page whose route the new state completes (its
// first tab, a tab it has, the project's spelling) is shown at that route first.
function render() {
  if (!state) return;
  if (view === 'project') {
    const fixed = canonicalProjectSub(sub);
    if (fixed !== sub) { show('project', fixed, { focus: false }); return; }
  }
  renderSide();
  const section = sections.get(view);
  const main = $('main');
  const top = main.scrollTop;
  keepFocus(section, () => byId.get(view).render(section, ctx()));
  main.scrollTop = top;
}

// Shows the screen for a route (an unknown one shows Today). The hash is corrected without a
// new history entry (also a project route the state completes). `focus` moves the focus to the
// view's heading (after a navigation).
function show(route, subPath = '', { focus = true } = {}) {
  let id = viewOf(route);
  if (!byId.has(id)) { id = 'today'; subPath = ''; }
  if (id === 'project') subPath = canonicalProjectSub(subPath);
  const changed = shown !== id || shownSub !== subPath;
  if (changed && shown && byId.get(shown).onHide) byId.get(shown).onHide();
  setView(id, subPath);
  for (const [vid, s] of sections) s.hidden = vid !== id;
  const hash = hashFor(id, subPath);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  shown = id;
  shownSub = subPath;
  render();
  if (!changed) return;
  $('main').scrollTop = 0;
  if (focus) focusHeading(id);
  if (byId.get(id).onShow) byId.get(id).onShow(ctx());
}

// SPEC 5.11: the view's h2 takes the focus after a navigation, so a screen reader starts there.
function focusHeading(id) {
  const heading = sections.get(id).querySelector('h2');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- theme (System, Light, Dark)

// The same key as the navigator; no key means System. data-theme on <html> picks the tokens.
const THEMES = ['system', 'light', 'dark'];
const THEME_TEXT = { system: 'System', light: 'Light', dark: 'Dark' };
let theme = 'system';
function readTheme() {
  try {
    const t = localStorage.getItem('ws-theme');
    return THEMES.includes(t) ? t : 'system';
  } catch { return 'system'; }
}
function applyTheme(next) {
  theme = next;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#themeText').textContent = THEME_TEXT[theme];
  $('#themeToggle').setAttribute('aria-label', `Theme: ${THEME_TEXT[theme]}. Click to change.`);
}
function nextTheme() {
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    if (next === 'system') localStorage.removeItem('ws-theme');
    else localStorage.setItem('ws-theme', next);
  } catch { /* storage blocked: the choice lasts until a reload */ }
  applyTheme(next);
}

// ---------------------------------------------------------------- live updates (SPEC 5.10)

// One EventSource on /api/events. A signal for the open run reaches the view at once (through
// store.emitSignal and livePoll); every signal also refreshes the counts, debounced to 1 s.
// When the stream fails, the "Live updates paused, retrying" pill shows and polling takes
// over until it opens again. The browser retries a dropped stream by itself; after an HTTP
// error (404 while the route doesn't exist yet, 429 over the stream limit) it gives up, so
// the page tries again itself, slower each time (5 s up to 2 min): no request storm.
let source = null;
let retryMs = 0;
let retryTimer = null;
let countsTimer = null;

function setLiveState(on) {
  setLive(on);
  $('#livePill').hidden = on;
}

function connectLive() {
  if (typeof EventSource === 'undefined' || isStopped() || source) return;
  clearTimeout(retryTimer);
  source = new EventSource('/api/events');
  source.onopen = () => { retryMs = 0; setLiveState(true); };
  source.onmessage = e => {
    let signal;
    try { signal = JSON.parse(e.data); } catch { return; }
    if (!signal || typeof signal !== 'object') return;
    emitSignal({ run: signal.run || null, project: signal.project || null, seq: signal.seq ?? null, status: signal.status || null });
    clearTimeout(countsTimer);
    countsTimer = setTimeout(refreshCounts, 1000);
  };
  source.onerror = () => {
    setLiveState(false);
    if (source.readyState !== EventSource.CLOSED) return; // the browser reconnects by itself
    source.close();
    source = null;
    retryMs = Math.min(retryMs ? retryMs * 2 : 5000, 120_000);
    if (!isStopped()) retryTimer = setTimeout(connectLive, retryMs);
  };
}

// Polling fallback: while the stream is down and something runs, the counts (and any view
// listening through store.onSignal) refresh every 10 s, only while the window is visible.
setInterval(() => {
  if (live || document.hidden || isStopped() || !runningCount()) return;
  emitSignal({ tick: true });
  refreshCounts();
}, 10_000);

// The state (nav counts) and the runs that wait or run; then the notifications.
async function refreshCounts() {
  const [, fresh] = await Promise.all([refresh(), loadRuns()]);
  notifyWaiting(fresh || []);
}

// ---------------------------------------------------------------- notifications (SPEC 5.12)

let lastWaiting = -1;

// `fresh`: runs that started waiting since the last pull. Title badge, polite announcement,
// and a system notification when allowed (otherwise a toast). Never asks for permission here.
function notifyWaiting(fresh) {
  const n = waitingCount();
  setTitleBadge(n);
  for (const r of fresh) {
    if (!notifyOn(r.id)) continue;
    const text = `${r.title || 'A run'} needs you`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(text); } catch { toast(text); }
    } else toast(text);
  }
  if (lastWaiting !== -1 && n !== lastWaiting) {
    announce(fresh.length === 1 ? `${fresh[0].title || 'A run'} needs you. ${plural(n, 'thing')} waiting for you.` : `${plural(n, 'thing')} waiting for you.`);
  }
  lastWaiting = n;
}

// ---------------------------------------------------------------- keyboard (SPEC 5.11)

// Ctrl+K toggles the palette (also from a text field, but not over another dialog).
// g then t / p / a / f / r jumps to Today, the current project's page (Projects without one),
// Assets, Flows, Runs: the second key within 1 s, never while typing or while a dialog is open.
// Single-key shortcuts belong to the views (store.singleKeyOk checks the setting and the panel).
const G_KEYS = {
  t: () => go('today'),
  p: () => (currentProject ? go('project', currentProject) : go('projects')),
  a: () => go('assets'),
  f: () => go('flows'),
  r: () => go('runs'),
};
let gAt = 0;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    const other = [...document.querySelectorAll('dialog[open]')].some(d => d.id !== 'palette');
    if (other) return;
    e.preventDefault();
    togglePalette();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (isTyping(e.target) || document.querySelector('dialog[open]')) { gAt = 0; return; }
  if (gAt && Date.now() - gAt <= 1000) {
    gAt = 0;
    const k = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(G_KEYS, k)) { e.preventDefault(); G_KEYS[k](); }
    return;
  }
  gAt = e.key === 'g' && !e.shiftKey ? Date.now() : 0;
});

// ---------------------------------------------------------------- events

buildShell();
restoreProject();
applyTheme(readTheme());
initPalette();
subscribe(render);

$('#themeToggle').addEventListener('click', nextTheme);
window.addEventListener('storage', e => { if (e.key === 'ws-theme') applyTheme(readTheme()); });
$('#startSomething').addEventListener('click', () => { if (!isPaletteOpen()) openPalette(); });

// The Hub session split button: Start, and a menu with Continue and Open navigator.
const hubMenu = $('#hubMenu');
const closeMenus = except => { for (const d of document.querySelectorAll('details.menu[open]')) if (d !== except) d.open = false; };
$('#startHub').addEventListener('click', () => launch({ kind: 'hub' }));
$('#continueHub').addEventListener('click', () => { hubMenu.open = false; launch({ kind: 'hub', continueLast: true }); });
$('#openNavigator').addEventListener('click', () => { hubMenu.open = false; openPlace({ place: 'navigator' }); });
document.addEventListener('click', e => closeMenus(e.target.closest ? e.target.closest('details.menu') : null));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = e.target.closest ? e.target.closest('details.menu[open]') : null;
  if (!open) return;
  open.open = false;
  open.querySelector('summary').focus();
});

window.addEventListener('focus', () => {
  ping();
  if (msSinceRefresh() > 5000) refreshCounts();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
// A screen with unsaved work (the project Settings tab) may keep the route: the address goes
// back and nothing else happens (parts/leave-guard.js).
window.addEventListener('hashchange', () => {
  if (!mayLeave(location.hash)) return;
  const r = parseHash();
  show(r.id, r.sub);
});
window.addEventListener('pagehide', () => { if (source) source.close(); });

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
  if (!upload) { toast('Open Inbox images (under Assets) or a flow first, then drop the files there.', true); return; }
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
show(start.id || 'today', start.sub, { focus: false });
// The first load: the state, then what depends on the current project; settings, the runs and
// the live stream alongside. Routes that don't exist yet answer 404 and are left at defaults.
refresh().then(() => loadPipelines(currentProject));
loadSettings();
loadRuns().then(fresh => notifyWaiting(fresh));
connectLive();
