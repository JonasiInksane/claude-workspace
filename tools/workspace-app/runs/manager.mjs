// The run manager: the one object the routes and the server talk to about runs.
//
// It checks and starts runs, drives each run through the executor (WP11) one `advance` at a
// time, passes your clicks to the executor, cancels, cleans up after a restart (recover) and
// before the app exits (shutdown). It owns the limits the plan sets:
// - one editing run per project: the project lock (runs/locks.mjs), held by this app's process;
// - at most 2 Claude processes and 1 check at a time: the `slots` semaphores;
// - a registry of every Claude stage and check process, for isBusy, cancel and shutdown.
// Every kill goes through core/proc.mjs `safeKill` (image and start time checked first, R19).
//
// The executor is made by `deps.createExecutor(engine)`, or passed ready as `deps.executor`.
// `engine` is deps plus what only the manager has: the guarded store, slots, signals, register,
// unregister, schedule, startRun and the lock holder (`holder`, also as `lockHolder`). What the
// executor must do:
// - advance(run, { signal }) resolves once the run waits for you or has ended, or soon after
//   `signal` aborts. On abort it just returns: the manager calls cancelPath itself.
// - handle(run, action, payload) applies one action and resolves to { message }. It leaves the
//   status 'running' when the run should go on; the manager then schedules advance.
// - cancelPath(run, reason) ends the run for good (patch, reset, release, cancelled). The manager
//   calls it before its own kills, so the executor knows a dying stage was cancelled and not
//   failed (a failed stage could tidy the tree and lose the patch).
// - abort(runId), optional, stops the run's current stage without ending the run (shutdown).
// - preview(draft), optional, resolves to { prompt, where, refusals, estimate, treeMode }.
//
// register(entry) takes { kind: 'claude'|'check'|'gate', runId, project, stage, attempt, rec }
// where the process record { pid, image, startedAt } may also be named `proc` or `record`, or a
// bare record (a Claude process). A 'gate' entry needs no record: it only keeps isBusy true.
// Check processes inside a gate are found through the gate's pids.json (gates/commands.mjs).
//
// Writes the executor makes through engine.store also send a signal (signals.emit), so the
// page's live updates need no extra calls. Once shutdown starts, the writes for the runs it
// interrupts are dropped, so a dying stage can't overwrite "interrupted". An action you clicked
// just before (Commit, Retry, a cancel) is not interrupted: shutdown waits for it, and its saves
// land, so run.json agrees with what it did to git and the lock.
//
// Inputs (plan row A6): a start reads the project's current settings once and resolves the assets
// they attach (attached-assets.mjs). Settings that can't be read, or an asset, version or file
// that is gone, refuse the start; so does a file whose bytes no longer match the SHA-256 the
// library recorded. An archived asset is used anyway, with a timeline note. The run is created
// with that settings version and its input manifest (runs/manifest.mjs), and each asset's bytes,
// as checked, are copied into inputs/assets/ through the store, so verifyInputs covers them.
import { basename, join, resolve } from 'node:path';
import { HttpError } from '../http.mjs';
import { PROJECT_RE, readJson } from '../core/datadir.mjs';
import * as realProc from '../core/proc.mjs';
import { loadSettings } from '../core/settings.mjs';
import { loadProfile, riskTags as profileRiskTags } from '../profile/profile.mjs';
import { trustState } from '../profile/trust.mjs';
import * as realFindings from '../findings/store.mjs';
import { currentSettings, settingsRef } from '../project-settings.mjs';
import * as realAttached from '../attached-assets.mjs';
import * as realCatalog from './catalog.mjs';
import * as realActions from './actions.mjs';
import * as realStore from './store.mjs';
import * as realLocks from './locks.mjs';
import { createSignalHub } from './events.mjs';
import { buildManifest } from './manifest.mjs';

export const DEFAULT_LIMITS = { claude: 2, checks: 1 };
// Runs that keep the project lock through a restart: they wait for you or can be resumed.
// A failed run keeps it too while run.lockHeld says so: the executor keeps the lock of a failed
// editing run whose tree still holds the changes, until you retry or stop it.
export const ADOPT_STATUSES = ['waiting', 'in-terminal', 'interrupted', 'capped', 'gates-red', 'paused-limit'];
// Runs that are over for good: nothing can be retried, resumed or cancelled (runs/actions.mjs).
export const ENDED_STATUSES = ['passed', 'cancelled', 'committed'];
export const PROCESS_KINDS = ['claude', 'check', 'gate'];
const ACTION_RE = /^[a-z][a-z-]{0,19}$/;
const CANCEL_SETTLE_MS = 10_000;
const SHUTDOWN_SETTLE_MS = 3_000;
const TRUST_CACHE_MS = 10_000;
const ACTION_SETTLE_MS = 3_000;
const STAGE_FOLDER_RE = /^stages\/\d{2}-[a-z0-9-]+$/;
const GATE_FOLDER_RE = /^gates\/\d{2}-[a-z0-9-]+$/;
const realClock = { now: () => Date.now() };

const iso = ms => new Date(ms).toISOString();
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = list => (Array.isArray(list) ? list.filter(s => typeof s === 'string' && s) : []);
const lastAttempt = stage => (Array.isArray(stage.attempts) && stage.attempts.length ? stage.attempts[stage.attempts.length - 1] : null);

function samePath(a, b) {
  const norm = p => resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// True when `promise` settles within `ms`. The timer doesn't keep Node alive unless `hold`:
// shutdown holds it for its few seconds, so the process can't exit before the runs it stops are
// marked interrupted.
function settlesWithin(promise, ms, { hold = false } = {}) {
  let timer;
  const timeout = new Promise(r => { timer = setTimeout(() => r(false), ms); if (!hold) timer.unref?.(); });
  return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}

// Runs async jobs one after another.
function serialQueue() {
  let tail = Promise.resolve();
  return fn => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

function abortError(name) {
  const err = new Error(`Cancelled while waiting for a free ${name} slot.`);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// A counting semaphore. acquire({ run, runId, stage, signal, onWait }) resolves to a release
// function (calling it twice is harmless). While it has to wait, the call's own onWait runs once,
// or else the slot's onWait({ name, run, runId, stage }). Waiters are served first come, first
// served. An abort while waiting rejects with an AbortError. use(opts, fn) runs fn holding a slot.
export function createSlot(name, limit, onWait = () => {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`The ${name} limit must be a whole number of at least 1.`);
  let used = 0;
  const queue = [];
  const grant = () => {
    used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      used--;
      pump();
    };
  };
  function pump() {
    while (used < limit && queue.length) {
      const w = queue.shift();
      w.cleanup();
      w.resolve(grant());
    }
  }
  function acquire({ run = null, runId = null, stage = null, signal, onWait: callWait } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(name));
    if (used < limit && !queue.length) return Promise.resolve(grant());
    return new Promise((resolveP, reject) => {
      const onAbort = () => {
        const i = queue.indexOf(w);
        if (i >= 0) queue.splice(i, 1);
        w.cleanup();
        reject(abortError(name));
      };
      const w = { resolve: resolveP, cleanup: () => signal?.removeEventListener('abort', onAbort) };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(w);
      const tell = typeof callWait === 'function' ? callWait : onWait;
      try {
        Promise.resolve(tell({ name, run, runId: runId ?? run?.id ?? null, stage })).catch(() => {});
      } catch { /* a row is nice to have */ }
    });
  }
  async function use(opts, fn) {
    const release = await acquire(opts);
    try { return await fn(); } finally { release(); }
  }
  return { name, limit, acquire, use, inUse: () => used, waiting: () => queue.length };
}

// The tree mode a pipeline uses before the executor says otherwise: 'none' pipelines read the
// main checkout; 'tree' pipelines edit the run worktree (or the main checkout in branch mode);
// 'main-ok' (check) uses the run worktree when the project uses one.
export function defaultTreeMode(need, isolationMode) {
  if (need === 'tree') return isolationMode === 'branch' ? 'main' : 'run';
  if (need === 'main-ok') return isolationMode === 'worktree' ? 'run' : 'main';
  return 'main';
}

const fieldOfKind = (def, kind) => (def.fields || []).find(f => f.kind === kind);

export function createManager({ root, dataDir, deps = {}, clock = realClock, limits = {}, actionSettleMs = ACTION_SETTLE_MS } = {}) {
  if (!dataDir) throw new Error('createManager needs the data folder (dataDir).');
  const store = deps.store || realStore;
  const locks = deps.locks || realLocks;
  const proc = deps.proc || realProc;
  const catalog = deps.catalog || realCatalog;
  const actionRules = deps.actions || realActions;
  const findingsApi = deps.findings || realFindings;
  const signals = deps.signals || createSignalHub();
  const holder = deps.holder || realProc.selfRecord();
  const now = () => clock.now();
  const profileFor = deps.profileFor || (project => loadProfile(dataDir, project));
  const riskTags = deps.riskTags || profileRiskTags;
  const getSettings = deps.getSettings || (() => loadSettings(dataDir));
  // The project's current settings (project-settings.mjs) and its attached assets.
  const projectSettingsFor = deps.projectSettingsFor || (project => currentSettings(dataDir, project));
  const attached = deps.attached || realAttached;
  const makeManifest = deps.buildManifest || buildManifest;
  const hubRoot = deps.hubRoot || root;
  const lim = { ...DEFAULT_LIMITS, ...limits };
  for (const fn of ['checkValues', 'computeLevel', 'requestPaths', 'needsLock', 'runTitle']) {
    if (typeof catalog[fn] !== 'function') throw new Error(`createManager: the catalog has no ${fn}().`);
  }
  if (typeof actionRules.allowedActions !== 'function') throw new Error('createManager: the actions module has no allowedActions().');

  const registry = new Map(); // token -> process entry
  let nextToken = 0;
  const drivers = new Map(); // run id -> { controller, promise, run }
  const pending = new Set(); // run ids to advance again when their driver finishes
  const handling = new Map(); // run id -> { name, promise }: the action or cancel being applied
  const frozen = new WeakSet(); // run objects whose saves are dropped (a driver that ignored cancel)
  const stopping = new Set(); // ids of the runs shutdown interrupts: their executor writes are dropped
  const startQueue = serialQueue();
  let closing = false;
  let shutdownPromise = null;

  const emitFor = (run, seq = null) => {
    if (run && run.id) signals.emit({ run: run.id, project: run.project, seq, status: run.status });
  };

  const stopped = run => !!run && stopping.has(run.id);

  // The store the executor gets: every write sends a signal. Writes for a run that shutdown
  // interrupts, or whose driver ignored a cancel, are dropped.
  const engineStore = {
    ...store,
    async saveRun(dir, run, opts) {
      if (stopped(run) || frozen.has(run)) return run;
      const out = await store.saveRun(dir, run, { now, ...opts });
      emitFor(run);
      return out;
    },
    async appendTimeline(dir, run, rows, opts = {}) {
      if (stopped(run)) return 0;
      const seq = await store.appendTimeline(dir, run, rows, { now, redact: deps.redact, ...opts });
      emitFor(run, seq);
      return seq;
    },
    async writeInput(dir, run, name, data, opts) {
      if (stopped(run) || frozen.has(run)) throw new Error('The app is closing; the input was not written.');
      return store.writeInput(dir, run, name, data, { now, ...opts });
    },
  };

  // A timeline row from the manager itself.
  const note = (run, kind, msg, stage = null) => engineStore.appendTimeline(dataDir, run, [{ kind, stage, msg }]);

  // The default wait row, for callers that pass the run (or a run id the manager drives) but no
  // onWait of their own.
  const waitRow = text => ({ run, runId, stage }) => {
    const r = run && run.id ? run : (runId && drivers.get(runId) && drivers.get(runId).run) || null;
    if (r) note(r, 'info', text, stage).catch(() => {});
  };
  const slots = {
    claude: createSlot('Claude', lim.claude, waitRow('Waiting for a free Claude slot')),
    checks: createSlot('check', lim.checks, waitRow('Waiting for a free check slot')),
  };

  // ---------- Process registry

  // Records a running Claude stage, check process or gate (see the header for the entry shape).
  // Returns a token for unregister. Throws on a record without a pid, an unknown kind, or a
  // Claude entry without a record.
  function register(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('register needs a process entry.');
    const bare = 'pid' in entry && !('rec' in entry || 'proc' in entry || 'record' in entry);
    const e = bare ? { kind: 'claude', rec: entry } : entry;
    const rec = e.rec || e.proc || e.record || null;
    const kind = e.kind || 'claude';
    if (!PROCESS_KINDS.includes(kind)) throw new Error(`"${kind}" is not a process kind; use claude, check or gate.`);
    if (rec && (!Number.isInteger(rec.pid) || rec.pid <= 0)) throw new Error('register needs a process record with a pid.');
    if (!rec && kind !== 'gate') throw new Error(`A ${kind} process is registered with its record { pid, image, startedAt }.`);
    const token = ++nextToken;
    registry.set(token, {
      token, kind, runId: e.runId ?? null, project: e.project ?? null, stage: e.stage ?? null, attempt: e.attempt ?? null,
      rec: rec ? { pid: rec.pid, image: String(rec.image || ''), startedAt: rec.startedAt } : null, child: e.child || null, at: now(),
    });
    return token;
  }

  function unregister(token) {
    return registry.delete(token && typeof token === 'object' ? token.token : token);
  }

  const forgetRun = runId => { for (const [t, e] of registry) if (e.runId === runId) registry.delete(t); };
  const runActive = runId => drivers.has(runId) || [...registry.values()].some(e => e.runId === runId);

  // Busy while a Claude stage or check process is registered, a run is being driven, or an
  // action is being applied. A run that only waits for you doesn't count (R21).
  const isBusy = () => registry.size > 0 || drivers.size > 0 || handling.size > 0;

  async function lookup(pids) {
    if (typeof proc.procInfoMany === 'function') return proc.procInfoMany(pids);
    const out = new Map();
    for (const pid of pids) out.set(pid, await proc.procInfo(pid));
    return out;
  }

  // Stops registered processes. The image and start time are checked first (safeKill). Only if
  // the lookup itself fails and we still hold the live handle of a child this app started is the
  // tree stopped without it: Windows can't reuse a pid while its handle is open.
  async function killEntries(all) {
    const out = { killed: [], failed: [] };
    const seen = new Set();
    const entries = all.filter(e => e.rec && Number.isInteger(e.rec.pid) && !seen.has(e.rec.pid) && seen.add(e.rec.pid));
    if (!entries.length) return out;
    const infos = await lookup(entries.map(e => e.rec.pid));
    for (const e of entries) {
      const info = infos.get(e.rec.pid);
      const childAlive = e.child && e.child.exitCode === null && e.child.signalCode === null;
      let r;
      if ((!info || info.alive === null) && childAlive) {
        const k = await proc.treeKill(e.rec.pid);
        r = { killed: k.ok && !k.gone, gone: k.gone, reason: k.message };
      } else {
        r = await proc.safeKill(e.rec, realProc.KILLABLE_IMAGES, { info });
      }
      const row = { pid: e.rec.pid, image: e.rec.image, runId: e.runId, stage: e.stage, reason: r.reason || '' };
      (r.killed || r.gone ? out.killed : out.failed).push(row);
    }
    return out;
  }

  // The check processes of a run's running gate stages that have not ended, read from the gate
  // folder's pids.json (gates/commands.mjs writes it), as registry-style entries.
  async function gateProcesses(run) {
    const out = [];
    for (const s of run.stages || []) {
      if (s.status !== 'running' || typeof s.gate !== 'string' || !GATE_FOLDER_RE.test(s.gate)) continue;
      let doc = null;
      try { doc = await readJson(join(store.runDir(dataDir, run), ...s.gate.split('/'), 'pids.json'), null); } catch { doc = null; }
      for (const p of Array.isArray(doc && doc.procs) ? doc.procs : []) {
        if (!p || !Number.isInteger(p.pid) || p.pid <= 0 || p.endedAt || typeof p.image !== 'string' || !Number.isFinite(p.startedAt)) continue;
        out.push({ kind: 'check', runId: run.id, stage: s.id, rec: { pid: p.pid, image: p.image, startedAt: p.startedAt } });
      }
    }
    return out;
  }

  // ---------- Lookups

  function pipelineDef(id) {
    const def = typeof catalog.pipelineById === 'function'
      ? catalog.pipelineById(String(id ?? ''))
      : (catalog.PIPELINES || []).find(p => p && p.id === id);
    if (!def) throw new HttpError(400, `"${String(id ?? '').slice(0, 40)}" is not a pipeline.`);
    return def;
  }

  async function loadOr404(id) {
    if (!store.RUN_ID_RE.test(String(id ?? ''))) throw new HttpError(400, 'That is not a run id.');
    const run = await store.findRun(dataDir, id);
    if (!run) throw new HttpError(404, `There is no run ${id}.`);
    return run;
  }

  const findRunQuietly = id => (id ? store.findRun(dataDir, id).catch(() => null) : Promise.resolve(null));
  // Whether a run keeps its lock: it waits for you, can be resumed, or failed with its changes
  // still in the tree (the executor then keeps run.lockHeld).
  const keepsLock = run => !!run && (ADOPT_STATUSES.includes(run.status) || (run.status === 'failed' && !!run.lockHeld));
  // A lock that belongs to a missing, ended or parked run protects nothing.
  const releasable = run => !run || (run.status !== 'running' && !keepsLock(run));
  const unreadableHolder = runId => `Could not read run ${runId}, which holds the lock; try again in a moment.`;

  // The run that holds a lock. A run that exists but can't be read (a busy file on Windows, a
  // broken run.json) is never taken for a missing one: that would free a live run's lock.
  // Resolves to { run } (run null: there is no such run) or { problem } (the refusal text).
  async function lockHolderRun(runId) {
    try {
      return { run: await store.findRun(dataDir, runId) };
    } catch {
      return { run: null, problem: unreadableHolder(runId) };
    }
  }

  function guardOpen() {
    if (closing) throw new HttpError(503, 'The app is closing.');
  }

  // { profile, problem }: problem explains a missing or invalid profile.
  async function getProfile(project) {
    let r;
    try { r = await profileFor(project); } catch (err) {
      return { profile: null, problem: `The profile for ${project} could not be read: ${err.message}` };
    }
    const missing = `${project} has no profile yet. Create one from the example on the project's Settings tab.`;
    if (r && typeof r === 'object' && 'exists' in r && 'profile' in r) {
      if (!r.exists) return { profile: null, problem: missing };
      const n = (r.errors || []).length;
      if (r.valid === false || n) {
        const them = n === 1 ? 'it' : 'them';
        return { profile: null, problem: `The profile for ${project} has ${n || 'some'} problem${n === 1 ? '' : 's'}; fix ${them} first (the project's Settings tab lists ${them}).` };
      }
      return { profile: r.profile, problem: '' };
    }
    return r ? { profile: r, problem: '' } : { profile: null, problem: missing };
  }

  // The project's current settings and the assets they attach, resolved: { settings, ref, assets,
  // problems, notes }. `problems` refuse a start (settings that can't be read, an asset, version
  // or file that is gone); `notes` go into the timeline (an archived asset is used anyway).
  async function projectInputs(project) {
    const none = { settings: null, ref: null, assets: [], problems: [], notes: [] };
    let settings;
    try { settings = await projectSettingsFor(project); } catch (err) {
      return { ...none, problems: [`The project settings of ${project} can't be read, so no run can start: ${err.message}`] };
    }
    let assets;
    try { assets = await attached.resolveAssets(root, project, (settings && settings.assets) || []); } catch (err) {
      return { ...none, settings, ref: settingsRef(settings), problems: [`The assets attached to ${project} can't be resolved: ${err.message}`] };
    }
    const gone = attached.assetProblems(assets);
    return {
      settings, ref: settingsRef(settings), assets, notes: attached.archivedNotes(assets),
      problems: gone.length ? [`The assets attached to ${project} can't be used: ${gone.join('; ')}. Fix them in the project's settings.`] : [],
    };
  }

  async function getFindings(project, def) {
    if (!fieldOfKind(def, 'finding')) return null;
    try {
      return deps.findingsFor ? await deps.findingsFor(project) : await findingsApi.loadFindings(dataDir, project);
    } catch { return null; }
  }

  // Folder trust comes from ~/.claude.json, which can be large, and the run view asks for the
  // actions on every 2 s poll: the answer is kept per tree for TRUST_CACHE_MS.
  const trustCache = new Map(); // tree -> { at, value }
  async function trustFor(run) {
    if (deps.trustFor) return deps.trustFor(run);
    const tree = run.isolation && run.isolation.tree;
    if (!tree) return undefined;
    const hit = trustCache.get(tree);
    if (hit && now() - hit.at < TRUST_CACHE_MS) return hit.value;
    let value;
    try {
      const t = await trustState(tree);
      value = t.state === 'trusted' ? true : t.state === 'not-trusted' ? false : undefined;
    } catch { value = undefined; }
    trustCache.set(tree, { at: now(), value });
    return value;
  }

  // ---------- Drafts: what a start would create

  function placeName(draft) {
    if (draft.treeMode !== 'run') return draft.project;
    const p = draft.profile && draft.profile.isolation && draft.profile.isolation.worktreePath;
    return p ? basename(p) : 'The run worktree';
  }

  const busyText = (draft, holderRun, runId) => `${placeName(draft)} is busy with ${holderRun ? holderRun.title : `run ${runId}`}. Park it or wait.`;

  function whereText(draft) {
    if (draft.isolation.mode === 'none' && !draft.lock) return 'read-only in the main checkout, no lock needed';
    if (draft.treeMode === 'run') return `the ${placeName(draft)} worktree`;
    return draft.def.editing ? 'the main checkout, on a new branch (branch mode)' : 'the main checkout';
  }

  async function executorPreview(draft) {
    if (draft.error || typeof executor.preview !== 'function') return {};
    try {
      return (await executor.preview(draft)) || {};
    } catch (err) {
      draft.warnings.push(`The preview is incomplete: ${err.message}`);
      return {};
    }
  }

  // Checks a request ({ project, pipeline, values }) and works out everything a run would get,
  // the project's settings version and attached assets included.
  async function draftFor(req, internal = {}) {
    const project = String((req && req.project) ?? '');
    if (!PROJECT_RE.test(project)) throw new HttpError(400, `"${project.slice(0, 40)}" is not a project name.`);
    const def = pipelineDef(req.pipeline);
    const rawValues = isPlainObject(req.values) ? req.values : {};
    const [settings, prof, findings, inputs] = await Promise.all([getSettings(), getProfile(project), getFindings(project, def), projectInputs(project)]);
    let checked;
    try {
      checked = (await catalog.checkValues(def, rawValues, { project, profile: prof.profile, settings, findings, dataDir, root })) || {};
    } catch (err) {
      if (err && err.status) throw err;
      checked = { error: err.message };
    }
    const error = checked.error ? (def.requires?.profile && prof.problem ? prof.problem : String(checked.error)) : '';
    const values = (!error && checked.values) || {};
    const risk = prof.profile && !error ? riskTags(prof.profile, catalog.requestPaths(values)) : { tags: [], hits: [] };
    const { level, reasons } = catalog.computeLevel(values.care || values.level, risk);
    const isolationMode = (settings && settings.isolation && settings.isolation[project]) || prof.profile?.isolation?.mode || 'worktree';
    const need = def.requires?.isolation || 'none';
    const finding = fieldOfKind(def, 'finding');
    const draft = {
      project, pipeline: def.id, def, values, error, title: error ? def.label : catalog.runTitle(def, values),
      level, levelReason: reasons || [], riskTags: risk.tags || [], findingId: (finding && values[finding.key]) || null,
      isolationMode, treeMode: defaultTreeMode(need, isolationMode), profile: prof.profile, settings,
      parent: internal.parent ?? null, refusals: [], warnings: [...inputs.notes],
      projectSettings: inputs.settings, projectSettingsRef: inputs.ref, assets: inputs.assets, assetNotes: inputs.notes,
    };
    const extra = await executorPreview(draft);
    if (extra.treeMode === 'main' || extra.treeMode === 'run') draft.treeMode = extra.treeMode;
    draft.lock = !!catalog.needsLock(def, draft.treeMode);
    draft.isolation = { mode: need === 'none' ? 'none' : isolationMode, treeMode: draft.treeMode, tree: null, mainDir: null };
    draft.refusals = [...strings(extra.refusals), ...inputs.problems];
    draft.extra = extra;
    return draft;
  }

  // The refusal text when another live run holds the lock this draft needs, else ''.
  async function lockBusy(draft) {
    const info = await locks.inspect(dataDir, draft.project, { proc, now });
    if (!info.held || info.holderAlive === false) return '';
    if (info.broken) return 'The lock file is being written; try again in a moment.';
    const { run: holderRun, problem } = await lockHolderRun(info.runId);
    if (problem) return problem;
    return releasable(holderRun) ? '' : busyText(draft, holderRun, info.runId);
  }

  // What the launcher shows before a start: { title, prompt, stages, cannot, caps, where, level,
  // levelReason, refusals, estimate, error, warnings, treeMode, lock }. A value problem is in
  // `error` (not thrown), so the page can preview while you type.
  async function preview(req = {}) {
    guardOpen();
    const draft = await draftFor(req);
    const ui = (typeof catalog.pipelineForUi === 'function' && catalog.pipelineForUi(draft.pipeline, { profile: draft.profile, settings: draft.settings })) || {};
    const refusals = [...draft.refusals];
    if (!draft.error && draft.lock) {
      const busy = await lockBusy(draft);
      if (busy) refusals.unshift(busy); // first: it usually explains the others (see start)
    }
    const x = draft.extra || {};
    return {
      title: draft.title, prompt: typeof x.prompt === 'string' ? x.prompt : '',
      stages: x.stages || ui.stages || [], cannot: x.cannot || ui.cannot || draft.def.cannot || [], caps: x.caps || ui.caps || [],
      where: x.where || whereText(draft), level: draft.level, levelReason: draft.levelReason, refusals,
      estimate: x.estimate ?? draft.def.expected ?? null, error: draft.error, warnings: draft.warnings,
      treeMode: draft.treeMode, lock: draft.lock,
    };
  }

  // ---------- Starting

  async function takeLock(draft, runId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await locks.acquire(dataDir, draft.project, { runId, holder, proc, now });
      if (r.ok) return;
      const { run: holderRun, problem } = r.lock ? await lockHolderRun(r.lock.runId) : { run: null };
      if (problem) throw new HttpError(409, problem);
      if (attempt === 0 && r.lock && releasable(holderRun)) {
        await locks.release(dataDir, draft.project, r.lock.runId);
        if (holderRun && holderRun.lockHeld) {
          holderRun.lockHeld = false;
          await store.saveRun(dataDir, holderRun, { now });
        }
        continue;
      }
      throw new HttpError(409, r.lock ? busyText(draft, holderRun, r.lock.runId) : r.reason);
    }
  }

  async function markFinding(run, findingId) {
    try {
      if (deps.setFindingStatus) {
        await deps.setFindingStatus(run.project, findingId, 'in-run', { by: 'run', runId: run.id, reason: 'run started' });
      } else {
        await findingsApi.updateFindings(dataDir, run.project,
          doc => findingsApi.setStatus(doc, findingId, 'in-run', { by: 'run', runId: run.id, reason: 'run started', at: iso(now()) }));
      }
    } catch (err) {
      await note(run, 'info', `Could not mark ${findingId} as in a run: ${err.message}`);
    }
  }

  // The input manifest of the run a draft would create (runs/manifest.mjs), for the assets whose
  // checked bytes the run gets. A template that can't be read is a 500: the run could not build
  // that stage's prompt either.
  async function manifestFor(draft, items, versions) {
    try {
      return await makeManifest({
        root: hubRoot, def: draft.def, profile: draft.profile, settings: draft.settings,
        run: { pipeline: draft.pipeline, level: draft.level, riskTags: draft.riskTags, values: draft.values, parent: draft.parent },
        projectSettings: draft.projectSettingsRef, assets: items, versions, hub: deps.hubState,
      });
    } catch (err) {
      throw new HttpError(500, `The run's input manifest could not be made, so nothing started: ${err.message}`);
    }
  }

  // Copies the checked asset files into the new run's inputs/assets/ through the store (hashed
  // there, so verifyInputs covers them). A copy that fails ends the run as failed, with the lock
  // given back, and the start reports it.
  async function copyAssets(run, draft, files) {
    try {
      for (const { item, bytes } of files) await store.writeInput(dataDir, run, attached.assetInputName(item), bytes, { now });
    } catch (err) {
      const message = `The attached assets could not be copied into the run, so it stopped: ${err.message}`;
      Object.assign(run, { status: 'failed', statusReason: message, error: { message, at: iso(now()) }, lockHeld: false });
      await store.saveRun(dataDir, run, { now });
      if (draft.lock) await locks.release(dataDir, draft.project, run.id).catch(() => {});
      await note(run, 'error', message);
      throw new HttpError(500, message);
    }
    if (files.length) {
      await note(run, 'info', `Copied ${files.length} attached asset${files.length === 1 ? '' : 's'} into inputs/assets: ${files.map(f => `${f.item.ref} v${f.item.version}`).join(', ')}.`);
    }
    for (const text of draft.assetNotes || []) await note(run, 'info', text);
  }

  // Starts a run: checks the values, refuses (400) on a problem or a refusal, and (409) when an
  // attached asset's file no longer matches its recorded hash, takes the lock for editing runs
  // and run-worktree checks (409 when busy), creates the run with its input manifest, copies the
  // attached assets into its inputs/, marks its finding in-run and schedules the executor.
  // Resolves to { runId, run }.
  // `internal` is for engine callers only (routes never pass it): { parent, skip: [stage ids],
  // extra: { more run.json fields } }.
  function start(req = {}, internal = {}) {
    if (closing) return Promise.reject(new HttpError(503, 'The app is closing.'));
    return startQueue(async () => {
      guardOpen();
      const draft = await draftFor(req, internal);
      if (draft.error) throw new HttpError(400, draft.error);
      // A run that holds the lock usually also explains the other refusals (its changes are in
      // the run worktree), so "busy with <title>" comes first.
      const busy = draft.lock ? await lockBusy(draft) : '';
      if (busy) throw new HttpError(409, busy);
      if (draft.refusals.length) throw new HttpError(400, draft.refusals.join(' '));
      const { files, problems } = await attached.readVerified(draft.assets);
      if (problems.length) throw new HttpError(409, `The assets attached to ${draft.project} can't be used: ${problems.join('; ')}. Upload the file again as a new version, or attach another version.`);
      const versions = { node: process.versions.node, claudeCode: deps.claudeVersion || null };
      const manifest = await manifestFor(draft, files.map(f => f.item), versions);
      const slugText = draft.values.what || draft.findingId || draft.title.replace(/^[^:]*:\s*/, '');
      const id = await store.freeRunId(dataDir, draft.project, draft.pipeline, slugText, new Date(now()));
      if (draft.lock) await takeLock(draft, id);
      const skip = new Set(strings(internal.skip));
      let run;
      try {
        run = await store.createRun(dataDir, {
          ...(isPlainObject(internal.extra) ? internal.extra : {}),
          id, project: draft.project, pipeline: draft.pipeline, parent: draft.parent, title: draft.title, values: draft.values,
          level: draft.level, levelReason: draft.levelReason, riskTags: draft.riskTags, isolation: draft.isolation,
          versions, projectSettings: draft.projectSettingsRef, manifest,
          lockHeld: draft.lock, findingId: draft.findingId, owner: holder,
          stages: draft.def.stages.map((s, n) => ({ id: s.id, n, kind: s.kind, status: skip.has(s.id) ? 'skipped' : 'pending' })),
        }, { now });
      } catch (err) {
        if (draft.lock) await locks.release(dataDir, draft.project, id).catch(() => {});
        throw err;
      }
      await note(run, 'status', `Started: ${run.title}`);
      await copyAssets(run, draft, files);
      if (draft.findingId) await markFinding(run, draft.findingId);
      schedule(run.id);
      return { runId: run.id, run };
    });
  }

  // ---------- Driving

  function markInterrupted(run, reason, at) {
    const stages = (run.stages || []).filter(s => s.status === 'running');
    for (const s of stages) {
      s.status = 'interrupted';
      const a = lastAttempt(s);
      if (a) { a.status = 'interrupted'; a.endedAt = a.endedAt || at; }
    }
    run.status = 'interrupted';
    run.statusReason = reason;
    run.waiting = null;
    return stages;
  }

  const runningStageName = run => ((run.stages || []).find(s => s.status === 'running') || {}).id || (run.current && run.current.stage) || 'a stage';

  // The executor failed or returned while the run still said running: interrupted, so the lock
  // stays and Retry or Resume can pick it up.
  async function stopUnexpected(runId, message) {
    const run = await findRunQuietly(runId);
    if (!run || run.status !== 'running') return;
    const at = iso(now());
    markInterrupted(run, message, at);
    run.error = { message, at };
    await store.saveRun(dataDir, run, { now });
    await store.appendTimeline(dataDir, run, [{ kind: 'error', stage: run.current ? run.current.stage : null, msg: message }], { now, redact: deps.redact });
    emitFor(run);
  }

  async function driveOnce(runId, entry) {
    const run = await findRunQuietly(runId);
    if (!run || run.status !== 'running') return;
    entry.run = run;
    const { signal } = entry.controller;
    try {
      await executor.advance(run, { signal });
    } catch (err) {
      if (!signal.aborted && !closing) await stopUnexpected(runId, `The engine stopped: ${err && err.message ? err.message : err}`);
      return;
    }
    if (signal.aborted || closing || pending.has(runId)) return;
    await stopUnexpected(runId, 'The engine stopped without finishing the stage.');
  }

  // Asks for the run to be advanced. One driver per run: a request while it is busy makes it
  // advance once more afterwards. Returns false while the app is closing.
  function schedule(runId) {
    if (closing) return false;
    if (drivers.has(runId)) { pending.add(runId); return true; }
    const entry = { controller: new AbortController(), promise: null, run: null };
    drivers.set(runId, entry);
    entry.promise = (async () => {
      await null; // let the caller finish first
      do {
        pending.delete(runId);
        await driveOnce(runId, entry);
      } while (pending.has(runId) && !entry.controller.signal.aborted && !closing);
    })().catch(() => {}).finally(() => {
      if (drivers.get(runId) === entry) drivers.delete(runId);
      if (!handling.has(runId)) forgetRun(runId);
    });
    return true;
  }

  // Resolves when no run is being driven (for tests and an orderly stop).
  async function settled() {
    while (drivers.size) await Promise.all([...drivers.values()].map(d => d.promise));
  }

  // ---------- Actions

  async function actionsFor(run) {
    let def = null;
    try { def = pipelineDef(run.pipeline); } catch { return []; }
    return actionRules.allowedActions(run, def, { running: runActive(run.id), trusted: await trustFor(run) });
  }

  async function checkAllowed(run, name) {
    const list = await actionsFor(run);
    const a = list.find(x => x.action === name);
    if (!a) throw new HttpError(400, `${name} is not an action for this run.`);
    if (!a.enabled) throw new HttpError(400, `${a.label || name} is not available: ${a.reason || 'not right now.'}`);
  }

  // Applies `fn` as the one action or cancel in flight for run `id` (the `handling` entry is set
  // before anything awaits, so a second click gets 409). Shutdown waits for it. Afterwards the
  // run's process records are dropped unless a driver still runs it (`always`: drop them anyway).
  function track(id, name, fn, { always = false } = {}) {
    const job = { name, promise: null };
    handling.set(id, job);
    job.promise = (async () => {
      try { return await fn(); } finally {
        if (handling.get(id) === job) handling.delete(id);
        if (always || !drivers.has(id)) forgetRun(id);
      }
    })();
    return job.promise;
  }

  // Applies one of your clicks. Checks it against allowedActions (400 with the reason), refuses
  // while another action runs or the run is still driven after actionSettleMs (409), then hands
  // it to the executor and schedules the run when it should go on. Resolves to { message, run }.
  async function action(id, name, payload = {}) {
    guardOpen();
    if (!ACTION_RE.test(String(name ?? ''))) throw new HttpError(400, 'That is not an action.');
    if (name === 'cancel') {
      const run = await loadOr404(id);
      await checkAllowed(run, 'cancel');
      return cancel(id);
    }
    if (handling.has(id)) throw new HttpError(409, `The run is busy with ${handling.get(id).name}; try again in a moment.`);
    return track(id, name, async () => {
      // run.json says "waiting" a moment before its driver has finished (the page shows the gate
      // and you click at once), so a driver gets actionSettleMs to finish before the refusal.
      const d = drivers.get(id);
      if (d && !(await settlesWithin(d.promise, actionSettleMs, { hold: true }))) throw new HttpError(409, 'The run is busy with a stage. Wait for it, or cancel the run.');
      const run = await loadOr404(id);
      await checkAllowed(run, name);
      const out = await executor.handle(run, name, isPlainObject(payload) ? payload : {});
      const fresh = await findRunQuietly(id);
      if (fresh && fresh.status === 'running' && !closing) schedule(id);
      // What an action hands back besides its message: the child run of "Start next slice", the
      // saved report of "Save as report".
      const extra = {};
      if (out && out.childRunId) extra.childRunId = out.childRunId;
      if (out && out.report) extra.report = out.report;
      return { message: (out && typeof out.message === 'string' && out.message) || 'Done.', ...extra, run: fresh };
    });
  }

  // Cancels a run:
  // 1. aborts its driver (the signal advance got) and starts the executor's cancel path, which
  //    marks the run as cancelling before anything dies;
  // 2. stops the run's registered processes and leftover gate checks (safeKill: image and start
  //    time first) as a backstop;
  // 3. waits for the cancel path, then up to 10 s for the driver. A driver that still hasn't
  //    finished has its later saves dropped, so it can't overwrite "cancelled".
  // Resolves to { message, run, kills }.
  async function cancel(id, { reason = 'cancelled by you' } = {}) {
    guardOpen();
    const busy = handling.get(id);
    if (busy && busy.name === 'cancel') throw new HttpError(409, 'The run is already being cancelled.');
    if (busy) throw new HttpError(409, `The run is busy with ${busy.name}; try again in a moment.`);
    return track(id, 'cancel', async () => {
      const run = await loadOr404(id);
      if (ENDED_STATUSES.includes(run.status)) throw new HttpError(400, `This run has already ended (${run.status}).`);
      const d = drivers.get(id);
      pending.delete(id);
      // Taken before the abort: a stage may unregister at once while its process still runs.
      const registered = [...registry.values()].filter(e => e.runId === id);
      if (d) d.controller.abort();
      // Called synchronously, so the executor knows about the cancel before the kills below.
      const cancelling = (async () => executor.cancelPath((d && d.run) || run, reason))();
      cancelling.catch(() => {}); // a failure is reported by the await below, after the kills
      const gates = (await gateProcesses(run)).filter(e => e.runId === id);
      const kills = await killEntries([...registered, ...registry.values(), ...gates].filter(e => e.runId === id));
      const out = await cancelling;
      if (d && !(await settlesWithin(d.promise, CANCEL_SETTLE_MS)) && d.run) frozen.add(d.run);
      const after = await findRunQuietly(id);
      emitFor(after);
      const stuck = kills.failed.map(k => `${k.image} ${k.pid}: ${k.reason}`).join('; ');
      const message = (out && typeof out.message === 'string' && out.message) || 'Cancelled.';
      return { message: stuck ? `${message} Some processes could not be stopped: ${stuck}` : message, run: after, kills };
    }, { always: true });
  }

  // ---------- Startup recovery (plan 3.10, spike A11)

  // The strings an orphan of these runs carries in its command line (spike A11; the cwd is not
  // visible in Win32_Process):
  // - the run id: the `-n` name (<runId>-<stage>) and every run folder path contain it;
  // - the run's tmp folder (each stage's TEMP and TMP, which Claude's Bash lines embed);
  // - each attempt's --settings file and name;
  // - the run worktree, unless it is the main checkout or a run in a terminal works in it now
  //   (its checks are yours, not leftovers).
  function orphanNeedles(runs, busyTrees = []) {
    const out = new Set();
    for (const run of runs) {
      const dir = store.runDir(dataDir, run);
      out.add(run.id);
      out.add(join(dir, 'tmp'));
      for (const s of run.stages || []) {
        for (const a of s.attempts || []) {
          if (typeof a.folder === 'string' && STAGE_FOLDER_RE.test(a.folder)) out.add(join(dir, ...a.folder.split('/'), 'settings.json'));
          if (typeof a.name === 'string' && a.name) out.add(a.name);
        }
      }
      const iso2 = run.isolation || {};
      const ownTree = iso2.tree && iso2.mainDir && !samePath(iso2.tree, iso2.mainDir);
      if (ownTree && !busyTrees.some(t => samePath(t, iso2.tree))) out.add(iso2.tree);
    }
    return [...out];
  }

  // Runs once at startup, before the server listens:
  // 1. a still-running Claude stage or gate check of a run marked running is stopped (after the
  //    image and start time check);
  // 2. those runs and stages become interrupted, with "The app restarted while <stage> ran.";
  // 3. locks of runs that wait or can be resumed are adopted by this app, the others released;
  // 4. orphans (Git Bash, Node, Claude) carrying an interrupted run's paths, whose parent is
  //    gone, are stopped.
  // Runs owned by another app that still runs are skipped entirely.
  // Resolves to { interrupted, killed, adopted, released, orphans, skipped, errors }.
  // Runs whose owner (run.owner, the app process that started them) is another app that still
  // runs: a second app on the same data folder. Recovery leaves those alone. One batched lookup
  // for all owners. Resolves to { ids: Set, unchecked } (unchecked: owners the lookup couldn't
  // answer for; those runs are treated as this app's, and kills still need a lookup).
  async function ownedElsewhere(runs) {
    const isSelf = r => r.pid === holder.pid && r.startedAt === holder.startedAt;
    const owned = runs.filter(r => r.owner && Number.isInteger(r.owner.pid) && !isSelf(r.owner) && !ENDED_STATUSES.includes(r.status));
    if (!owned.length) return { ids: new Set(), unchecked: 0 };
    const infos = await lookup([...new Set(owned.map(r => r.owner.pid))]);
    const match = typeof proc.matchRecord === 'function' ? proc.matchRecord : realProc.matchRecord;
    const infoOf = r => infos.get(r.owner.pid) || {};
    return {
      ids: new Set(owned.filter(r => infoOf(r).alive === true && match(r.owner, infoOf(r))).map(r => r.id)),
      unchecked: owned.filter(r => infoOf(r).alive !== true && infoOf(r).alive !== false).length,
    };
  }

  async function recover() {
    const at = iso(now());
    const report = { interrupted: [], killed: [], adopted: [], released: [], orphans: [], skipped: [], errors: [] };
    const scanned = await store.scanRuns(dataDir);
    report.errors.push(...scanned.errors);
    const { ids: elsewhere, unchecked } = await ownedElsewhere(scanned.runs);
    for (const id of elsewhere) report.skipped.push(id);
    if (elsewhere.size) report.errors.push(`${elsewhere.size} run${elsewhere.size === 1 ? '' : 's'} belong to another app that still runs, so recovery left them alone.`);
    if (unchecked) report.errors.push(`Could not check which app owns ${unchecked} run${unchecked === 1 ? '' : 's'}; recovery treated them as its own.`);
    const runs = scanned.runs.filter(r => !elsewhere.has(r.id));
    const wasRunning = runs.filter(r => r.status === 'running');

    const recs = wasRunning.flatMap(run => (run.stages || []).filter(s => s.status === 'running')
      .map(s => ({ run, stage: s.id, rec: (lastAttempt(s) || {}).proc })).filter(x => x.rec && Number.isInteger(x.rec.pid)));
    for (const run of wasRunning) {
      for (const g of await gateProcesses(run)) recs.push({ run, stage: g.stage, rec: g.rec });
    }
    if (recs.length) {
      const infos = await lookup(recs.map(x => x.rec.pid));
      for (const x of recs) {
        const info = infos.get(x.rec.pid);
        if (!info || info.alive === false) continue;
        const r = await proc.safeKill(x.rec, realProc.KILLABLE_IMAGES, { info });
        if (r.killed) report.killed.push({ pid: x.rec.pid, image: x.rec.image, why: `stage ${x.stage} of ${x.run.id}` });
        else if (!r.gone) report.errors.push(r.reason);
      }
    }

    // One run that can't be saved (a run.json edited by hand) must not stop the recovery of the
    // others: its error is reported, and it still counts as interrupted below, so its lock is kept
    // and its orphans are looked for.
    for (const run of wasRunning) {
      const name = runningStageName(run);
      const msg = `The app restarted while ${name} ran.`;
      markInterrupted(run, msg, at);
      try {
        await store.saveRun(dataDir, run, { now });
        report.interrupted.push(run.id);
        await store.appendTimeline(dataDir, run, [{ kind: 'status', stage: name === 'a stage' ? null : name, msg }], { now, redact: deps.redact });
      } catch (err) {
        report.errors.push(`Run ${run.id} could not be marked interrupted: ${err.message}`);
      }
    }

    const byId = new Map(runs.map(r => [r.id, r]));
    // Runs whose run.json could not be read: their state is unknown, so their locks are adopted
    // (kept for this app) rather than released. A later start then says the run can't be read.
    const unreadable = new Set((scanned.unreadable || []).map(u => u.id));
    const kept = new Set();
    for (const { project, lock, broken } of await locks.listLocks(dataDir)) {
      if (broken || !lock) { report.errors.push(`The lock file of ${project} is unreadable, so it was left alone.`); kept.add(project); continue; }
      if (elsewhere.has(lock.runId)) { kept.add(project); continue; }
      if (unreadable.has(lock.runId) && !byId.has(lock.runId)) {
        const r = await locks.adopt(dataDir, project, lock.runId, holder, { now });
        if (r.ok) report.adopted.push({ project, runId: lock.runId }); else report.errors.push(r.reason);
        report.errors.push(`Run ${lock.runId} holds the lock of ${project} but could not be read, so its lock was kept.`);
        kept.add(project);
        continue;
      }
      const run = byId.get(lock.runId);
      if (keepsLock(run)) {
        const r = await locks.adopt(dataDir, project, run.id, holder, { now });
        if (r.ok) { report.adopted.push({ project, runId: run.id }); kept.add(project); run.lockHeld = true; } else report.errors.push(r.reason);
      } else {
        const r = await locks.release(dataDir, project, lock.runId);
        if (r.released) report.released.push({ project, runId: lock.runId }); else report.errors.push(r.reason);
      }
    }
    for (const run of runs) {
      const shouldHold = run.lockHeld && keepsLock(run) && !kept.has(run.project);
      if (shouldHold) {
        const r = await locks.adopt(dataDir, run.project, run.id, holder, { now });
        if (r.ok) { report.adopted.push({ project: run.project, runId: run.id }); kept.add(run.project); continue; }
        report.errors.push(r.reason);
      }
      const holds = report.adopted.some(a => a.runId === run.id);
      if (run.lockHeld && !holds) {
        run.lockHeld = false;
        try { await store.saveRun(dataDir, run, { now }); } catch (err) {
          report.errors.push(`Run ${run.id} still says it holds the lock of ${run.project}: ${err.message}`);
        }
      }
    }

    const busyTrees = runs.filter(r => r.status === 'in-terminal' && r.isolation && r.isolation.tree).map(r => r.isolation.tree);
    const needles = orphanNeedles(runs.filter(r => r.status === 'interrupted'), busyTrees);
    if (needles.length && typeof proc.findOrphans === 'function') {
      const { orphans = [], error } = (await proc.findOrphans({ needles, images: realProc.ORPHAN_IMAGES })) || {};
      if (error) report.errors.push(error);
      for (const o of orphans) {
        report.orphans.push({ pid: o.pid, image: o.image, parentAlive: o.parentAlive, killable: o.killable, needle: o.needle });
        if (!o.killable || o.parentAlive) continue;
        const r = await proc.safeKill({ pid: o.pid, image: o.image, startedAt: o.startedAt }, realProc.ORPHAN_IMAGES, { info: o });
        if (r.killed) report.killed.push({ pid: o.pid, image: o.image, why: `orphan carrying ${o.needle}` });
        else if (!r.gone) report.errors.push(r.reason);
      }
    }
    for (const id of report.interrupted) emitFor(byId.get(id));
    return report;
  }

  // ---------- Shutdown (spike A11)

  // Before the app exits (spike A11: claude.exe dies with the app, but its Git Bash and Node
  // children would live on):
  // 1. from now on nothing new starts. The runs being driven, and runs with registered
  //    processes, are "stopping": the executor's saves for them are dropped from here on;
  // 2. a click being applied (an action such as Commit, or a cancel) is left to finish, since it
  //    may already have changed git or the lock; its saves still land. A run whose action just
  //    handed it to a driver is stopping like the others (a cancel is never stopped);
  // 3. every stopping run's stage is aborted (signal, and executor.abort when it has one);
  // 4. their registered Claude stage and check processes, and every check a running gate started
  //    (its pids.json), are tree-killed after the image and start time check;
  // 5. the drivers and the clicks get up to 3 s to finish. Processes of a click that is still
  //    going are then stopped as well, and the report says the click did not finish;
  // 6. runs still marked running become interrupted, with the row "The app was closing while
  //    <stage> ran." (or, after a finished click, "...did not go on after <action>."). They keep
  //    their lock, and recovery adopts it at the next start.
  // Resolves to { killed, failed, interrupted, errors }; calling it again returns the same promise.
  function shutdown({ settleMs = SHUTDOWN_SETTLE_MS } = {}) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    // Taken before anything is aborted: a stage may unregister the moment it hears the abort,
    // while its process still runs. safeKill sorts out the ones that already ended.
    const registered = [...registry.values()];
    const clicks = new Map([...handling].filter(([id, job]) => job.name === 'cancel' || !drivers.has(id)));
    for (const id of [...drivers.keys(), ...registered.map(e => e.runId)]) if (id && !clicks.has(id)) stopping.add(id);
    shutdownPromise = (async () => {
      const report = { killed: [], failed: [], interrupted: [], errors: [] };
      for (const [id, d] of drivers) if (stopping.has(id)) d.controller.abort();
      for (const id of stopping) {
        try { if (typeof executor.abort === 'function') executor.abort(id); } catch { /* the kills below still run */ }
      }
      const addKills = kills => { report.killed.push(...kills.killed); report.failed.push(...kills.failed); };
      try {
        const gates = [];
        for (const id of stopping) {
          const run = await findRunQuietly(id);
          if (run) gates.push(...await gateProcesses(run));
        }
        addKills(await killEntries([...registered, ...registry.values(), ...gates].filter(e => !clicks.has(e.runId))));
      } catch (err) { report.errors.push(`Stopping processes failed: ${err.message}`); }
      const jobs = [...clicks.values()].map(job => job.promise.catch(() => {}));
      await settlesWithin(Promise.all([...[...drivers.values()].map(d => d.promise), ...jobs]), settleMs, { hold: true });
      const unfinished = [...clicks].filter(([id, job]) => handling.get(id) === job).map(([id]) => id);
      if (unfinished.length) {
        try {
          addKills(await killEntries([...registry.values()].filter(e => unfinished.includes(e.runId))));
        } catch (err) { report.errors.push(`Stopping processes failed: ${err.message}`); }
        for (const id of unfinished) {
          report.errors.push(`${id}: the app closed before ${clicks.get(id).name} finished; check the run when the app starts again.`);
        }
      }
      const at = iso(now());
      const finished = [...clicks.keys()].filter(id => !unfinished.includes(id));
      for (const id of [...stopping, ...finished]) {
        try {
          const run = await store.findRun(dataDir, id);
          if (!run || run.status !== 'running') continue;
          const name = runningStageName(run);
          const msg = stopping.has(id) ? `The app was closing while ${name} ran.`
            : `The app was closing, so the run did not go on after ${clicks.get(id).name}.`;
          markInterrupted(run, msg, at);
          await store.saveRun(dataDir, run, { now });
          await store.appendTimeline(dataDir, run, [{ kind: 'status', stage: name === 'a stage' ? null : name, msg }], { now, redact: deps.redact });
          report.interrupted.push(id);
        } catch (err) { report.errors.push(`${id}: ${err.message}`); }
      }
      registry.clear();
      return report;
    })();
    return shutdownPromise;
  }

  // ---------- The executor

  // A child run started by the executor ("Start next slice"): `parent` and `inherit` may come in
  // the request itself. Routes call start() directly, so the page can never set them.
  function startChild(req = {}, internal = {}) {
    const { parent, inherit, skip, ...rest } = isPlainObject(req) ? req : {};
    const extra = { ...(isPlainObject(internal.extra) ? internal.extra : {}), ...(isPlainObject(inherit) ? { inherit } : {}) };
    return start(rest, { ...internal, parent: internal.parent ?? parent ?? null, skip: internal.skip ?? skip, extra });
  }

  const engine = {
    ...deps, root, hubRoot: deps.hubRoot || root, dataDir, clock, store: engineStore, locks, proc, catalog,
    actions: actionRules, profileFor, slots, signals, register, unregister, schedule, holder, lockHolder: holder,
    startRun: startChild,
  };
  const executor = deps.executor || (typeof deps.createExecutor === 'function' ? deps.createExecutor(engine) : null);
  if (!executor || ['advance', 'handle', 'cancelPath'].some(k => typeof executor[k] !== 'function')) {
    throw new Error('createManager needs an executor with advance, handle and cancelPath (deps.createExecutor or deps.executor).');
  }

  return {
    preview, start, action, cancel, recover, isBusy, slots, register, unregister, signals, shutdown,
    schedule, settled, actionsFor, executor, engine,
    pipeline: id => pipelineDef(id),
    registered: () => [...registry.values()].map(({ child, ...e }) => e),
    get closing() { return closing; },
  };
}
