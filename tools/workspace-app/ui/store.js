// The page's shared state: the last answer of GET /api/state, the view on screen and the route
// to it, the current project, the app settings, the pipeline catalog, the runs that wait or
// run, and the live-update signals. Every `export let` is a live binding: importers always
// read the current value, and only this module assigns them.
//
// Routing: the URL hash names the route, #<route> or #<route>/<sub>. A route is a view id,
// except for the aliases below (#library shows views/tools.js; the old #home shows Today).
// go() changes the hash, which adds a history entry (so Back works); main.js listens for
// hashchange and shows the view. A project's page is #project/<name>/<tab>[/<rest>]
// (views/project.js): projectRoute() and projectSub() take its sub-route apart and put it
// together, and canonicalProjectSub() completes it from the state (the type's first tab when
// the tab is missing or unknown). The old #cockpit/<name> and #health/<name> still work: they
// open the Overview and the Architecture tab (upgradeRoute).
//
// Routes that don't exist yet (404 while the server side is still being built) fall back to
// defaults quietly: the page keeps working with what /api/state gives.
//
// Nothing here touches the DOM or localStorage when the module loads, so Node tests can import it.
import { api, checkServer, isStopped, isTyping, toast } from './lib.js';

export let state = null; // GET /api/state; null until the first answer
export let view = 'today';
export let sub = ''; // what follows the route in the hash, '' for none
export let currentProject = ''; // the project the launcher, `g p` and the intent box use
export let settings = defaultSettings(); // GET /api/settings, or the defaults
export let pipelines = { project: '', list: [], routes: [], loaded: false }; // GET /api/pipelines
export let runs = { waiting: [], running: [], loaded: false }; // GET /api/runs rows
export let live = false; // true while the SSE stream (GET /api/events) is open
export let launchDraft = null; // { pipeline, project, what, findingId } for the launcher
export const signals = new Map(); // run id -> its last signal { run, project, seq, status }

const listeners = new Set();
let lastRefresh = 0;

// Replaces the state and tells every subscriber.
export function setState(next) {
  state = next;
  pickProject();
  changed();
}

// fn(state) runs after every change (state, settings, pipelines, runs). Returns a function
// that unsubscribes.
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() {
  if (!state) return;
  for (const fn of listeners) fn(state);
}

// Only main.js calls this, when it shows a view.
export function setView(id, subPath = '') {
  view = id;
  sub = subPath;
}

export const msSinceRefresh = () => Date.now() - lastRefresh;

// Loads the state again. Errors show as a toast (or the "not connected" overlay).
export async function refresh() {
  lastRefresh = Date.now();
  try {
    setState(await api('/api/state'));
  } catch (e) {
    if (e.network) checkServer();
    else if (!isStopped()) toast(e.message, true);
  }
}

// ---------------------------------------------------------------- routes

// Route -> view id, and back. Views keep their file names; only these routes differ.
export const ROUTE_VIEWS = { library: 'tools', home: 'today' };
export const VIEW_ROUTES = { tools: 'library' };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
export const viewOf = route => (own(ROUTE_VIEWS, route) ? ROUTE_VIEWS[route] : route);
export const routeOf = id => (own(VIEW_ROUTES, id) ? VIEW_ROUTES[id] : id);

// Routes of screens that became tabs of the project page: route -> the tab that took over.
export const LEGACY_TABS = { cockpit: 'overview', health: 'architecture' };

// An old route as the route that replaced it ({ id, sub }); any other route as it is. One without
// a name keeps its tab for the current project: a bare #health is '/architecture' (projectRoute).
export function upgradeRoute(id, subPath = '') {
  if (!own(LEGACY_TABS, id)) return { id, sub: subPath };
  const name = String(subPath || '').split('/')[0];
  return { id: 'project', sub: projectSub(name, LEGACY_TABS[id]) };
}

// '#flows/hero-sprite' <-> { id: 'flows', sub: 'hero-sprite' }. `sub` may hold more slashes;
// each part is URL-encoded in the hash. hashFor takes a view id or a route; both upgrade an old
// route, so '#cockpit/example' reads as { id: 'project', sub: 'example/overview' }.
export function hashFor(id, subPath = '') {
  const r = upgradeRoute(id, subPath);
  return `#${routeOf(r.id)}${r.sub ? `/${String(r.sub).split('/').map(encodeURIComponent).join('/')}` : ''}`;
}
export function parseHash(hash = location.hash) {
  const [id = '', ...rest] = String(hash).replace(/^#/, '').split('/');
  let subPath = rest.join('/');
  try { subPath = decodeURIComponent(subPath); } catch { subPath = ''; }
  return upgradeRoute(id, subPath);
}

// The project page's sub-route, '<name>/<tab>/<rest>', as { name, tab, rest } and back. A rest
// needs a name and a tab; empty parts are left out. '/<tab>' (no name) is that tab of the current
// project, which canonicalProjectSub fills in once the state is there; every other reader goes by
// the name and sees no project.
export function projectRoute(subPath = '') {
  const [name = '', tab = '', ...rest] = String(subPath || '').split('/');
  return { name, tab, rest: name && tab ? rest.join('/') : '' };
}
export function projectSub(name, tab = '', rest = '') {
  if (!name) return tab ? `/${tab}` : '';
  if (!tab) return String(name);
  return rest ? `${name}/${tab}/${rest}` : `${name}/${tab}`;
}
export const projectHash = (name, tab = '', rest = '') => hashFor('project', projectSub(name, tab, rest));
export const goProject = (name, tab = '', rest = '') => go('project', projectSub(name, tab, rest));

// The /api/state entry of a project by name (exact first, then without case), or null.
export function projectEntry(name, projects = state && state.projects) {
  if (!name || !Array.isArray(projects)) return null;
  const n = String(name);
  return projects.find(p => p && p.name === n) || projects.find(p => p && String(p.name).toLowerCase() === n.toLowerCase()) || null;
}

// The tabs of a project's page, from its type (state.projects[i].tabs); Overview when the
// server sent none.
export const tabsOf = p => (p && Array.isArray(p.tabs) && p.tabs.length ? p.tabs.map(String) : ['overview']);

// The project page's sub-route made whole from the state: the project's own spelling, a tab it
// has (its first tab when the tab is missing or unknown; the rest goes with an unknown tab), and
// the current project when the route names none (at the tab the route names, if that project has
// it: '/architecture' from a bare #health). Before the state is loaded, and for a project
// the state doesn't list (the page then asks the server about it), the route stays as it is (the
// current project may still change when the state arrives, so it isn't filled in before).
export function canonicalProjectSub(subPath, projects = state && state.projects, fallback = currentProject) {
  const r = projectRoute(subPath);
  const list = Array.isArray(projects) ? projects : null;
  if (!list) return projectSub(r.name, r.tab, r.rest);
  const p = projectEntry(r.name || fallback, list);
  if (!p) return r.name ? projectSub(r.name, r.tab, r.rest) : '';
  const tabs = tabsOf(p);
  const tab = tabs.includes(r.tab) ? r.tab : tabs[0];
  return projectSub(p.name, tab, tab === r.tab ? r.rest : '');
}

// Shows a view, as a new history entry. Going to the view already shown shows it again. A
// project route is completed first, as main.js will show it: the nav's #project/<name> would
// otherwise be a new entry next to the #project/<name>/overview on screen, which show() then
// replaces with that same address, so the first Back would seem to do nothing.
export function go(id, subPath = '') {
  const r = upgradeRoute(id, subPath);
  const hash = hashFor(r.id, r.id === 'project' ? canonicalProjectSub(r.sub) : r.sub);
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// ---------------------------------------------------------------- the current project

// A count that the server may send as a number or as a list.
export const countOf = v => (Array.isArray(v) ? v.length : Number(v) || 0);

// Projects with a private profile (state.projects[i].hasProfile; their type is `code`): runs,
// checks and findings work for them, and their page shows the code tabs.
export const profiledProjects = () => (state && Array.isArray(state.projects) ? state.projects.filter(p => p.hasProfile) : []);

export function setCurrentProject(name) {
  currentProject = String(name || '');
  try { if (currentProject) localStorage.setItem('ws-project', currentProject); } catch { /* storage blocked: fine */ }
}

// main.js calls this once at start: the project chosen last time in this browser.
export function restoreProject() {
  try { currentProject = localStorage.getItem('ws-project') || ''; } catch { currentProject = ''; }
}

// Keeps currentProject pointing at a project that exists; prefers a profiled one.
function pickProject() {
  const all = state && Array.isArray(state.projects) ? state.projects : [];
  if (currentProject && all.some(p => p.name === currentProject)) return;
  const first = profiledProjects()[0];
  currentProject = first ? first.name : '';
}

// ---------------------------------------------------------------- settings

// The same defaults as core/settings.mjs, used until GET /api/settings answers (or when it
// doesn't exist yet).
export function defaultSettings() {
  return {
    version: 1,
    shortcuts: { singleKey: true },
    notify: { web: true },
    fun: { celebration: true, streak: false },
    isolation: {},
    models: {},
  };
}

function mergeSettings(from) {
  const d = defaultSettings();
  if (!from || typeof from !== 'object') return d;
  for (const key of Object.keys(d)) {
    if (from[key] && typeof from[key] === 'object' && !Array.isArray(from[key])) d[key] = { ...d[key], ...from[key] };
  }
  return d;
}

export async function loadSettings() {
  try {
    const r = await api('/api/settings');
    settings = mergeSettings(r.settings);
    changed();
  } catch { /* missing route or a bad answer: keep the defaults */ }
  return settings;
}

// Sends a patch ({ fun: { streak: true } }); resolves with the saved settings. Errors reject.
export async function saveSettings(patch) {
  const r = await api('/api/settings', { method: 'POST', body: patch });
  settings = mergeSettings(r.settings);
  changed();
  return settings;
}

// True when a single-key shortcut may act now (SPEC 5.11, WCAG 2.1.4): the setting is on, no
// modifier is held, nobody is typing, no dialog is open, and the focus is inside `panel`.
export function singleKeyOk(e, panel = null) {
  if (settings.shortcuts.singleKey === false) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return false;
  if (document.querySelector('dialog[open]')) return false;
  return !panel || panel.contains(document.activeElement);
}

// ---------------------------------------------------------------- pipelines and intent routing

const pipelineCache = new Map(); // project -> { at, value }
const PIPELINE_TTL_MS = 60_000;

// The launcher catalog for a project (GET /api/pipelines?project). Cached for a minute; a
// missing route gives an empty list and no routes, so every text routes to Explain.
export async function loadPipelines(project = currentProject, { force = false } = {}) {
  const key = String(project || '');
  const hit = pipelineCache.get(key);
  if (hit && !force && Date.now() - hit.at < PIPELINE_TTL_MS) {
    pipelines = hit.value;
    return pipelines;
  }
  let value;
  try {
    const r = await api(`/api/pipelines${key ? `?project=${encodeURIComponent(key)}` : ''}`);
    value = { project: key, list: Array.isArray(r.pipelines) ? r.pipelines : [], routes: Array.isArray(r.routes) ? r.routes : [], loaded: true };
  } catch (e) {
    value = { project: key, list: [], routes: [], loaded: false, error: e.status === 404 ? '' : e.message };
  }
  pipelineCache.set(key, { at: Date.now(), value });
  pipelines = value;
  changed();
  return pipelines;
}

export const pipelineDef = id => pipelines.list.find(p => p.id === id) || null;

// Routes free text to a pipeline with the server's rules (runs/intent.mjs routesForUi):
// { pattern, flags, pipeline } in order, first match wins, Explain when nothing matches. The
// second "fix" entry, when there is one, is the profile's finding id pattern: a match there
// also gives findingId (as routeIntent does on the server).
export function matchRoute(text, routes = []) {
  const t = String(text || '').slice(0, 2000);
  if (!t.trim()) return { pipeline: 'explain' };
  const rules = [];
  for (const r of Array.isArray(routes) ? routes : []) {
    if (!r || typeof r.pattern !== 'string' || typeof r.pipeline !== 'string') continue;
    try { rules.push({ re: new RegExp(r.pattern, String(r.flags || '').replace(/[gy]/g, '')), pipeline: r.pipeline }); } catch { /* a bad pattern is skipped */ }
  }
  const fixRules = rules.filter(r => r.pipeline === 'fix');
  const idRe = fixRules.length > 1 ? fixRules[1].re : null;
  const id = idRe ? (t.match(idRe) || [])[0] || '' : '';
  for (const r of rules) {
    if (r.re.test(t)) return r.pipeline === 'fix' && id ? { pipeline: 'fix', findingId: id } : { pipeline: r.pipeline };
  }
  return { pipeline: 'explain' };
}
export const routeIntent = text => matchRoute(text, pipelines.routes);

// Opens the launcher for `pipeline`, prefilled from `draft` ({ what, findingId, project }).
export function openLauncher(pipeline, draft = {}) {
  if (draft.project) setCurrentProject(draft.project);
  launchDraft = { pipeline, project: currentProject, what: draft.what || '', findingId: draft.findingId || '' };
  go('launcher', pipeline);
}
export function clearLaunchDraft() { launchDraft = null; }

// ---------------------------------------------------------------- runs

let knownWaiting = null; // run ids seen waiting at the last load; null before the first
let runsMissingAt = 0;
const RUNS_RETRY_MS = 60_000;

// What a run waits for: an index row (GET /api/runs) has the kind as a string, a full run
// (GET /api/run) has { kind, since, detail }. '' when it waits for nothing.
export function waitingKind(r) {
  if (!r || !r.waiting) return '';
  return typeof r.waiting === 'string' ? r.waiting : String(r.waiting.kind || '');
}
// The kinds that mean "at the review gate" (the same as state.mjs on the server).
export const REVIEW_KINDS = ['review', 'commit'];
export const atReviewGate = r => REVIEW_KINDS.includes(waitingKind(r));

// Loads the runs that wait for the user and the ones running (GET /api/runs). Resolves with
// the rows that started waiting since the last load (none on the first load), for the
// notifications. A missing route is tried again a minute later at the earliest.
export async function loadRuns() {
  if (runsMissingAt && Date.now() - runsMissingAt < RUNS_RETRY_MS) return [];
  let answer;
  try {
    answer = await api('/api/runs?status=waiting,running&limit=60');
  } catch (e) {
    if (e.status === 404) runsMissingAt = Date.now();
    return [];
  }
  runsMissingAt = 0;
  const rows = Array.isArray(answer.runs) ? answer.runs.filter(r => r && typeof r.id === 'string') : [];
  runs = {
    waiting: rows.filter(r => r.status === 'waiting'),
    running: rows.filter(r => r.status === 'running'),
    loaded: true,
  };
  const ids = new Set(runs.waiting.map(r => r.id));
  const fresh = knownWaiting ? runs.waiting.filter(r => !knownWaiting.has(r.id)) : [];
  knownWaiting = ids;
  changed();
  return fresh;
}

// Runs waiting at the review gate (the nav lists up to three): from /api/state when it has
// them (runs.atReviewGate), otherwise from the loaded rows.
export function reviewWaits() {
  if (state && state.runs && Array.isArray(state.runs.atReviewGate)) return state.runs.atReviewGate;
  return runs.waiting.filter(atReviewGate);
}

// How many runs wait for the user / are running: from /api/state when it has the counts,
// otherwise from the loaded rows.
export function waitingCount() {
  return state && state.runs && state.runs.waiting != null ? countOf(state.runs.waiting) : runs.waiting.length;
}
export function runningCount() {
  return state && state.runs && state.runs.running != null ? countOf(state.runs.running) : runs.running.length;
}

// "(n) Claude Workspace" while n things wait for the user.
export function setTitleBadge(n) {
  document.title = n > 0 ? `(${n}) Claude Workspace` : 'Claude Workspace';
}

// ---------------------------------------------------------------- live signals

const signalListeners = new Set();

// fn(signal) runs for every SSE signal ({ run, project, seq, status }) and for every polling
// tick ({ tick: true }) while the stream is down. Returns a function that unsubscribes.
export function onSignal(fn) {
  signalListeners.add(fn);
  return () => signalListeners.delete(fn);
}

// main.js calls these two.
export function emitSignal(signal) {
  if (signal.run) signals.set(signal.run, signal);
  for (const fn of [...signalListeners]) {
    try { fn(signal); } catch (e) { console.error(e); }
  }
}
const pollers = new Set(); // the open livePoll loops
export function setLive(on) {
  const was = live;
  live = !!on;
  // The stream just dropped: every open view pulls now, then at its fast rate (not after the
  // up-to-10 s wait it had scheduled while the stream was up).
  if (was && !live) for (const p of [...pollers]) p.wake();
}

// Calls pull() every `ms` while the stream is down and every `liveMs` while it is up, and at
// once when a signal names `runId` (or any signal, without a runId). pull() may resolve false
// to stop (for example after a 404). Returns stop(). A view starts it in onShow and calls stop
// in onHide (SPEC 5.10: the open run view pulls every 2 s).
export function livePoll(pull, { runId = null, ms = 2000, liveMs = 10_000 } = {}) {
  let timer = null;
  let stopped = false;
  let busy = false;
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, live ? liveMs : ms);
  };
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    let keep = true;
    try { keep = (await pull()) !== false; } catch (e) { console.error(e); }
    busy = false;
    if (!keep) stop();
    else schedule();
  }
  const off = onSignal(sig => {
    if (sig.tick || (runId && sig.run !== runId)) return;
    clearTimeout(timer);
    tick();
  });
  const poller = { wake() { clearTimeout(timer); tick(); } };
  pollers.add(poller);
  function stop() {
    stopped = true;
    clearTimeout(timer);
    off();
    pollers.delete(poller);
  }
  tick();
  return stop;
}

// ---------------------------------------------------------------- notifications (SPEC 5.12)

// The run view's "Notify me when it needs me" choice per run: kept in this browser
// (localStorage ws-notify:<runId>, "1" or "0") and in memory; without one, settings.notify.web
// decides. A run turned on still notifies when the global setting is off.
const runNotify = new Map(); // run id -> true or false, the choice made in this session
const NOTIFY_KEY = 'ws-notify:';
let permissionAsked = false;

function storedNotify(runId) {
  try {
    const v = localStorage.getItem(NOTIFY_KEY + runId);
    return v === '1' ? true : v === '0' ? false : null;
  } catch { return null; }
}

// Asks for permission on the first "on" only (ADDENDUM A20).
export function setRunNotify(runId, on) {
  runNotify.set(runId, !!on);
  try { localStorage.setItem(NOTIFY_KEY + runId, on ? '1' : '0'); } catch { /* memory only */ }
  if (on) requestNotifyPermission();
}
export function notifyOn(runId) {
  const own = runNotify.has(runId) ? runNotify.get(runId) : storedNotify(runId);
  return own === null ? settings.notify.web !== false : own;
}

export function requestNotifyPermission() {
  if (permissionAsked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  permissionAsked = true;
  Notification.requestPermission().catch(() => {});
}
