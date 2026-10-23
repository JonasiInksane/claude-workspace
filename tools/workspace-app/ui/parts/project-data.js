// The data behind the project page's tabs (views/project.js and views/project/*.js): per project,
// the answers of the API routes the tabs show, each { data } once answered, or { data, error,
// status } when the last load failed (the previous answer stays next to the error), and undefined
// while the first load runs.
//
//   project   GET /api/project?name         facts bar, setup checklist, git, lock, baseline, profile
//   findings  GET /api/findings?project     the audit board
//   metrics   GET /api/metrics?project      the health tiles, lenses, candidates and wins
//   checks    GET /api/checks?project       the last result per level and the history
//   runs      GET /api/runs?project (8)     the newest runs (Recent runs, the board's run tags)
//   tasks     GET /api/runs?project (200)   the runs the Tasks tab groups into tasks
//   waiting   GET /api/runs?project&status=waiting   runs that wait at a gate (the Changes tab)
//   settings  GET /api/project-settings?project      rules and settings, every version (Settings, Assets)
//   library   GET /api/library?project&archived=1    shared assets plus the project's own (Settings, Assets)
//
// A screen asks for the parts it shows with use(name, parts), in its onShow, and lets go with the
// function use() returns, in its onHide. Parts in use load at once and then stay fresh: every 10 s
// while the window is visible and a run is running, a moment after a live signal for the project
// (at most every 5 s), on window focus when the last load is over 5 s old, and after an action
// (reload()). Every answer runs the onData() listeners, so the open tab repaints as soon as its
// own part is in. A part asked for while it loads loads once more afterwards.
import { api, checkServer, qs } from '../lib.js';
import { onSignal, runningCount, runs as liveRuns } from '../store.js';

export const TASK_LIMIT = 200;
export const REFRESH_MS = 10_000;
const SOON_MS = 5000;

export const PARTS = {
  project: name => `/api/project?${qs({ name })}`,
  findings: name => `/api/findings?${qs({ project: name })}`,
  metrics: name => `/api/metrics?${qs({ project: name })}`,
  checks: name => `/api/checks?${qs({ project: name })}`,
  runs: name => `/api/runs?${qs({ project: name, limit: 8 })}`,
  tasks: name => `/api/runs?${qs({ project: name, limit: TASK_LIMIT })}`,
  waiting: name => `/api/runs?${qs({ project: name, status: 'waiting', limit: 100 })}`,
  settings: name => `/api/project-settings?${qs({ project: name })}`,
  library: name => `/api/library?${qs({ project: name, archived: '1' })}`,
};
const isPart = p => Object.prototype.hasOwnProperty.call(PARTS, p);

const slots = new Map(); // project -> { [part]: { data, error, status } }
const loading = new Set(); // "<project>\0<part>" while its request is out
const again = new Set(); // ... asked for again meanwhile
const uses = new Set(); // { name, parts } of the screens on show
const listeners = new Set();

// The answers for one project ({} before the first one).
export function slot(name) {
  if (!slots.has(name)) slots.set(name, {});
  return slots.get(name);
}

// A part's answer, or null.
export const dataOf = part => (part && part.data) || null;

// fn(name, part) runs after every answer. Returns a function that unsubscribes.
export function onData(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function tell(name, part) {
  for (const fn of [...listeners]) {
    try { fn(name, part); } catch (e) { console.error(e); }
  }
}

async function loadPart(name, part) {
  const key = `${name}\0${part}`;
  if (loading.has(key)) { again.add(key); return; }
  loading.add(key);
  const s = slot(name);
  try {
    s[part] = { data: await api(PARTS[part](name)) };
  } catch (e) {
    if (e.network) checkServer();
    s[part] = { data: s[part] && s[part].data, error: e.message, status: e.status };
  }
  loading.delete(key);
  tell(name, part);
  if (again.delete(key)) await loadPart(name, part);
}

// Every part in use, per project: Map name -> Set of parts.
function inUse() {
  const out = new Map();
  for (const u of uses) {
    if (!out.has(u.name)) out.set(u.name, new Set());
    for (const p of u.parts) out.get(u.name).add(p);
  }
  return out;
}

// ---------------------------------------------------------------- staying fresh

let ticker = null;
let soon = null;
let offSignal = null;
let last = 0;

// Loads every part in use now (or only those of `name`). Resolves when they are in.
export function reload(name = '') {
  clearTimeout(soon);
  soon = null;
  last = Date.now();
  const out = [];
  for (const [n, parts] of inUse()) if (!name || n === name) for (const p of parts) out.push(loadPart(n, p));
  return Promise.all(out);
}

function later() {
  if (!soon) soon = setTimeout(() => { soon = null; reload(); }, Math.max(1000, SOON_MS - (Date.now() - last)));
}
function onFocus() {
  if (Date.now() - last > SOON_MS) reload();
}

function startTimers() {
  if (ticker) return;
  ticker = setInterval(() => { if (!document.hidden && runningCount() > 0) reload(); }, REFRESH_MS);
  // Ticks (the polling fallback while the stream is down) are covered by the interval above.
  offSignal = onSignal(sig => { if (!sig.tick && (!sig.project || inUse().has(sig.project))) later(); });
  window.addEventListener('focus', onFocus);
}

function stopTimers() {
  clearInterval(ticker);
  clearTimeout(soon);
  ticker = null;
  soon = null;
  if (offSignal) offSignal();
  offSignal = null;
  window.removeEventListener('focus', onFocus);
}

// Keeps `parts` of project `name` loaded and fresh until the returned function is called. Unknown
// part names are ignored; nothing to load gives a function that does nothing.
export function use(name, parts) {
  const want = [...new Set((Array.isArray(parts) ? parts : []).filter(isPart))];
  if (!name || !want.length) return () => {};
  const u = { name: String(name), parts: want };
  uses.add(u);
  last = Date.now();
  for (const p of want) loadPart(u.name, p);
  startTimers();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    uses.delete(u);
    if (!uses.size) stopTimers();
  };
}

// True while some screen uses a part of `name` (for tests and the view's own checks).
export const inUseBy = name => inUse().has(name);

// The project's runs that wait for the user or run now, from the store (main.js keeps them
// loaded), so a card can show them even when they are older than its own answer.
export function liveRunsOf(name) {
  return [...liveRuns.waiting, ...liveRuns.running].filter(r => r && r.project === name);
}
