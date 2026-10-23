// The run store: run folders, run.json, the runs index and each run's timeline, all under
// dataDir/runs (SPEC 2.3, 2.7-2.9). Runs live outside the hub, so nothing here reaches the public
// repo.
//
//   runs/index.jsonl                  one line per change of status, stage or waiting kind
//   runs/<project>/<runId>/run.json   the authoritative state; no stage can write here
//   runs/<project>/<runId>/timeline.jsonl   the rows the page shows, seq = line number
//   runs/<project>/<runId>/{inputs,stages,gates,final,tmp}/
//
// - run.json is written atomically (core/datadir.mjs), one write at a time per run.
// - The index gets a line only when status, current.stage or the waiting kind changed since the
//   last line for that run. Readers take the last line per id. Past 5 MB it is rewritten with the
//   latest line per id (temporary file, then rename).
// - Timeline rows get `seq`, the 1-based line number, so a poller asks "rows after seq N". A torn
//   last line (a crash mid-write) keeps its line number, and the next append starts a fresh line.
// - inputs/ files are hashed when written; verifyInputs re-hashes them before a gate (R27). Plain
//   names sit in inputs/ itself; the copies of the project's attached assets in inputs/assets/
//   (assets/<scope>-<id>@v<n>.<ext>, attached-assets.mjs), the only subfolder.
// - A new run records the project's current settings version, `projectSettings: { version,
//   sha256 }` or null (project-settings.mjs), read once here: its Claude stages get the rules of
//   that version, so a save during the run changes nothing in it.
// - A run started by the manager gets its input manifest (runs/manifest.mjs) at creation, with
//   manifestSha256, the hash of its canonical JSON. It is frozen: the object is read-only in
//   memory, and a save whose manifest no longer matches that hash is refused. A run whose run.json
//   was edited by hand is still loaded (its page shows the mismatch) and can be stopped, but never
//   saved as running again. Runs from before manifests, and runs created without one, have
//   manifest null.
// Ids and names are checked by regex before any path is joined, so ".." can never reach out.
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { appendJsonl, canonicalJson, PROJECT_RE, readJson, readJsonl, renameRetry, sha256Text, writeJsonAtomic } from '../core/datadir.mjs';
import { currentSettings, isSettingsRef, settingsRef } from '../project-settings.mjs';
import { ASSET_INPUT_DIR, ASSET_INPUT_RE } from '../attached-assets.mjs';
import { manifestHash, manifestProblem } from './manifest.mjs';

export const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
export const RUN_STATUSES = ['running', 'waiting', 'in-terminal', 'passed', 'failed', 'gates-red', 'capped', 'parked',
  'cancelled', 'interrupted', 'paused-limit', 'committed'];
export const TERMINAL_STATUSES = ['passed', 'failed', 'cancelled', 'committed'];
export const STAGE_STATUSES = ['pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'capped', 'cancelled',
  'interrupted', 'paused-limit'];
export const WAITING_KINDS = ['plan', 'spec', 'hypothesis', 'fence', 'review', 'commit', 'triage', 'decide'];
export const ROW_KINDS = ['text', 'tool', 'deny', 'result', 'gate', 'stage', 'you', 'status', 'info', 'error'];
export const INDEX_MAX_BYTES = 5 * 1024 * 1024;
export const MSG_MAX = 300;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // pipeline and stage ids
const INPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RUN_FOLDERS = ['inputs', 'stages', 'gates', 'final', 'tmp'];
// Words that say little about a run, left out of its id.
const STOP_WORDS = new Set(('the and for with into from that this these those then than when what where which who why how ' +
  'our all any its are was were not but out off onto over about also can could should would will make move fix add use ' +
  'using get set let new please some more less each every there their them they you your does did some way').split(' '));

const iso = ms => new Date(ms).toISOString();
const cap =(s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Runs fn after every earlier call with the same key has finished (one writer per file).
const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

function checkProject(project) {
  if (!PROJECT_RE.test(String(project ?? ''))) throw new Error(`"${project}" is not a project name.`);
  return project;
}

function checkRunId(id) {
  if (!RUN_ID_RE.test(String(id ?? ''))) throw new Error(`"${id}" is not a run id.`);
  return id;
}

function checkName(name, what) {
  if (!NAME_RE.test(String(name ?? '')) || String(name).length > 40) throw new Error(`"${name}" is not a valid ${what}.`);
  return name;
}

export const isTerminal = status => TERMINAL_STATUSES.includes(status);
const runsRoot = dataDir => join(resolve(dataDir), 'runs');
const indexFile = dataDir => join(runsRoot(dataDir), 'index.jsonl');
const projectRunsDir = (dataDir, project) => join(runsRoot(dataDir), checkProject(project));

// The folder of one run. Takes (dataDir, project, id) or (dataDir, run).
export function runDir(dataDir, projectOrRun, id) {
  const isRun = projectOrRun && typeof projectOrRun === 'object';
  const project = isRun ? projectOrRun.project : projectOrRun;
  const runId = isRun ? projectOrRun.id : id;
  return join(projectRunsDir(dataDir, project), checkRunId(runId));
}

// An absolute path inside a run folder from a relative posix path such as "stages/01-scope".
// Refuses empty parts, "." and "..", drive letters and backslashes.
export function runPath(dataDir, run, rel) {
  const parts = String(rel ?? '').split('/');
  if (!rel || parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) {
    throw new Error(`"${rel}" is not a path inside the run folder.`);
  }
  return join(runDir(dataDir, run), ...parts);
}

const pad2 = n => String(n).padStart(2, '0');

function folderName(stageIndex, stageId) {
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 99) throw new Error(`${stageIndex} is not a stage index (0 to 99).`);
  return `${pad2(stageIndex)}-${checkName(stageId, 'stage id')}`;
}

function suffix(letter, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${n} is not a valid ${letter === 'a' ? 'attempt' : 'round'} number.`);
  return n >= 2 ? `-${letter}${n}` : '';
}

// "stages/NN-<id>" for attempt 1, "stages/NN-<id>-aK" for attempt K >= 2 (relative, posix).
export function stageFolder(run, stageIndex, stageId, attempt = 1) {
  return `stages/${folderName(stageIndex, stageId)}${suffix('a', attempt)}`;
}

// "gates/NN-<id>" for round 1, "gates/NN-<id>-rR" for round R >= 2 (relative, posix).
export function gateFolder(run, stageIndex, stageId, round = 1) {
  return `gates/${folderName(stageIndex, stageId)}${suffix('r', round)}`;
}

// "tmp/NN-<id>": the stage's TEMP and TMP. Claude's Bash tool writes TEMP into every command line,
// which lets the orphan scan recognise leftovers (spike A9).
export function tmpFolder(run, stageIndex, stageId) {
  return `tmp/${folderName(stageIndex, stageId)}`;
}

function slugWords(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 2);
}

// A run id: "<yymmdd>-<hhmmss>-<pipeline>-<two words>" in UTC, for example
// "261022-104212-refactor-saletab-money". `taken(id)` says whether an id is in use; "-2", "-3"
// are added until one is free.
export function newRunId(pipeline, text = '', date = new Date(), taken = () => false) {
  checkName(pipeline, 'pipeline id');
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('A run id needs a valid date.');
  const stamp = `${pad2(d.getUTCFullYear() % 100)}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  const base = [stamp, pipeline, ...slugWords(text)].join('-').slice(0, 58).replace(/-+$/, '');
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken(id)) return id;
  }
  throw new Error('Could not find a free run id.');
}

async function listNames(dir, { dirs = true } = {}) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(e => (dirs ? e.isDirectory() : e.isFile())).map(e => e.name);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

// The run ids in use in every project. Ids are global (findRun, the manager's drivers, the page's
// #run/<id>), so two projects must never share one.
async function takenIds(dataDir) {
  const ids = new Set();
  for (const p of (await listNames(runsRoot(dataDir))).filter(n => PROJECT_RE.test(n))) {
    for (const id of await listNames(projectRunsDir(dataDir, p))) ids.add(id);
  }
  return ids;
}

// newRunId, checked against the run folders of every project.
export async function freeRunId(dataDir, project, pipeline, text, date = new Date()) {
  checkProject(project);
  const existing = await takenIds(dataDir);
  return newRunId(pipeline, text, date, id => existing.has(id));
}

function normalizeStage(s, n) {
  if (!s || typeof s !== 'object') throw new Error('Each stage needs an id and a kind.');
  checkName(s.id, 'stage id');
  const stage = { ...s, id: s.id, n: Number.isInteger(s.n) ? s.n : n, kind: s.kind, status: s.status || 'pending' };
  if (s.kind === 'claude' && !Array.isArray(stage.attempts)) stage.attempts = [];
  return stage;
}

function firstStage(stages) {
  const s = stages.find(x => x.status !== 'skipped' && x.status !== 'done');
  return s ? { stage: s.id, index: s.n, attempt: 1, round: 1 } : null;
}

// The 2.7 shape with every field present.
function newRunObject(init, id, at) {
  const stages = (init.stages || []).map(normalizeStage);
  const run = {
    version: 1, id, project: init.project, pipeline: init.pipeline, parent: null, title: '', values: {},
    level: null, levelReason: [], reviewEffort: null, createdAt: at, updatedAt: at, endedAt: null,
    status: 'running', statusReason: '', current: firstStage(stages), waiting: null,
    isolation: null, base: null, branch: null, commit: null,
    versions: { node: process.versions.node, claudeCode: null }, projectSettings: null, manifest: null, manifestSha256: null,
    lockHeld: false, plan: null, allowances: [], pins: [], redTests: [], inputsHashes: {},
    fixRounds: { auto: 0, user: 0, maxAuto: 2, maxUser: 2 }, gatedTree: null, stages, takeover: null, error: null,
  };
  for (const [k, v] of Object.entries(init)) {
    if (!['id', 'version', 'createdAt', 'updatedAt', 'endedAt', 'stages', 'manifestSha256'].includes(k) && v !== undefined) run[k] = v;
  }
  run.title = cap(String(run.title || ''), 200);
  return run;
}

// Makes a value read-only all the way down (the manifest: nothing may change it after creation).
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// The manifest a new run gets: null, or a checked manifest (runs/manifest.mjs), frozen, with its
// hash. Throws on a manifest of the wrong shape.
function frozenManifest(manifest) {
  if (manifest === undefined || manifest === null) return { manifest: null, manifestSha256: null };
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(`The run can't be created: ${problem}.`);
  const copy = JSON.parse(JSON.stringify(manifest));
  return { manifest: deepFreeze(copy), manifestSha256: manifestHash(copy) };
}

// Whether a run still has the manifest it was created with: none and no hash, or a manifest whose
// hash is manifestSha256.
function manifestKept(run) {
  const has = run.manifest !== undefined && run.manifest !== null;
  const hash = run.manifestSha256 ?? null;
  if (!has && hash === null) return true;
  return has && hash !== null && manifestHash(run.manifest) === hash;
}

const manifestText = run => canonicalJson([run.manifest ?? null, run.manifestSha256 ?? null]);

// Throws when a run's manifest no longer matches the hash it was created with (or one of the two
// is gone): a manifest never changes. One exception, so the engine can still stop such a run
// (recovery, cancel, a stage that failed): run.json was edited by hand, and this save leaves the
// run stopped (any status but running) and writes back exactly the manifest and hash run.json
// holds now. The edit stays for the run page to show (manifestOk: false), and the run can't go on.
async function checkManifestKept(file, run) {
  if (manifestKept(run)) return;
  if (run.status !== 'running') {
    const found = await serial(file, () => readJson(file, null)).catch(() => null);
    if (found && typeof found === 'object' && manifestText(found) === manifestText(run)) return;
  }
  throw new Error(`The input manifest of run ${run.id} changed after the run was created; a run's manifest never changes.`);
}

function checkStatuses(run) {
  if (!RUN_STATUSES.includes(run.status)) throw new Error(`"${run.status}" is not a run status.`);
  for (const s of run.stages || []) {
    if (!STAGE_STATUSES.includes(s.status)) throw new Error(`"${s.status}" is not a stage status (stage ${s.id}).`);
  }
  if (run.waiting && !WAITING_KINDS.includes(run.waiting.kind)) throw new Error(`"${run.waiting.kind}" is not a waiting kind.`);
}

// A free run id (init.id when given and free in every project), with its folder made.
async function claimRunId(dataDir, init, now) {
  const wanted = init.id ? checkRunId(init.id) : null;
  if (wanted && (await takenIds(dataDir)).has(wanted)) throw new Error(`Run ${wanted} already exists.`);
  for (let attempt = 0; ; attempt++) {
    const candidate = wanted || await freeRunId(dataDir, init.project, init.pipeline, init.slugText ?? init.title, new Date(now()));
    try {
      await mkdir(runDir(dataDir, init.project, candidate)); // not recursive: fails if the id is taken
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (wanted || attempt >= 3) throw new Error(`Run ${candidate} already exists.`);
    }
  }
}

// The settings version a new run uses: init.projectSettings when given (null or { version,
// sha256 }), otherwise the project's current one. Read before the run folder exists, so settings
// that can't be read stop the start and leave nothing behind.
async function runSettings(dataDir, init) {
  if (init.projectSettings === undefined) return settingsRef(await currentSettings(dataDir, init.project));
  if (!isSettingsRef(init.projectSettings)) throw new Error('projectSettings must be null or { version, sha256 } of saved settings.');
  return init.projectSettings;
}

// Creates the run folder (with inputs/, stages/, gates/, final/, tmp/) and run.json, and indexes
// the run. `init` holds any run.json fields to set (project and pipeline are required; `id` is
// optional and must be free; projectSettings defaults to the project's current settings version;
// `manifest`, optional, is the run's input manifest, which gets its manifestSha256 here and is
// frozen from then on). Returns the run.
export async function createRun(dataDir, init = {}, { now = Date.now } = {}) {
  checkProject(init.project);
  checkName(init.pipeline, 'pipeline id');
  const { manifest, manifestSha256 } = frozenManifest(init.manifest);
  const projectSettings = await runSettings(dataDir, init);
  await mkdir(projectRunsDir(dataDir, init.project), { recursive: true });
  // One creation at a time per data folder, so two projects can't pick the same free id at once.
  const id = await serial(runsRoot(dataDir), () => claimRunId(dataDir, init, now));
  const dir = runDir(dataDir, init.project, id);
  for (const f of RUN_FOLDERS) await mkdir(join(dir, f), { recursive: true });
  const { slugText, ...fields } = init;
  const run = newRunObject({ ...fields, projectSettings, manifest }, id, iso(now()));
  run.manifestSha256 = manifestSha256;
  checkStatuses(run);
  await saveRun(dataDir, run, { now });
  runProjects.set(id, run.project);
  return run;
}

// Reads run.json of one run; null when it doesn't exist. Its manifest comes back read-only.
export async function loadRun(dataDir, project, id) {
  const file = join(runDir(dataDir, project, id), 'run.json');
  const run = await readJson(file, null);
  if (run === null) return null;
  if (!run || typeof run !== 'object' || run.id !== id || run.project !== project) {
    throw new Error(`${file} does not describe run ${id} of ${project}.`);
  }
  if (run.manifest && typeof run.manifest === 'object') deepFreeze(run.manifest);
  return run;
}

const runProjects = new Map(); // run id -> project, so findRun rarely lists folders

// Finds a run by id in any project; null for an unknown or malformed id.
export async function findRun(dataDir, id) {
  if (!RUN_ID_RE.test(String(id ?? ''))) return null;
  const known = runProjects.get(id);
  if (known) {
    const run = await loadRun(dataDir, known, id).catch(() => null);
    if (run) return run;
    runProjects.delete(id);
  }
  for (const project of (await listNames(runsRoot(dataDir))).filter(p => PROJECT_RE.test(p))) {
    const run = await loadRun(dataDir, project, id);
    if (run) { runProjects.set(id, project); return run; }
  }
  return null;
}

// Every run.json on disk (or of one project), for startup recovery, which can't rely on the
// index. Unreadable runs are not thrown: they are listed in `unreadable` ({ id, project,
// message }), so recovery can tell "could not read" from "not there", and described in `errors`.
export async function scanRuns(dataDir, { project } = {}) {
  const projects = project ? [checkProject(project)] : (await listNames(runsRoot(dataDir))).filter(p => PROJECT_RE.test(p));
  const runs = [];
  const errors = [];
  const unreadable = [];
  for (const p of projects) {
    for (const id of (await listNames(projectRunsDir(dataDir, p))).filter(n => RUN_ID_RE.test(n))) {
      try {
        const run = await loadRun(dataDir, p, id);
        if (run) runs.push(run);
      } catch (err) {
        unreadable.push({ id, project: p, message: err.message });
        errors.push(`Run ${id} of ${p} could not be read: ${err.message}`);
      }
    }
  }
  return { runs, errors, unreadable };
}

// What a status change looks like in the index (SPEC 2.8, plus createdAt and endedAt so a list
// can show durations without opening every run).
export function indexLine(run, at) {
  return {
    at, id: run.id, project: run.project, pipeline: run.pipeline, title: run.title, status: run.status,
    stage: run.current?.stage ?? null, waiting: run.waiting?.kind ?? null, level: run.level ?? null,
    branch: run.branch ?? null, commit: run.commit?.sha ?? null, parent: run.parent ?? null,
    createdAt: run.createdAt ?? null, endedAt: run.endedAt ?? null,
  };
}

const indexKey = (status, stage, waiting) => JSON.stringify([status ?? null, stage ?? null, waiting ?? null]);

async function fileSize(file) {
  try { return (await stat(file)).size; } catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
}

// Per index file: the last indexed key of every run id and the size we expect the file to have.
// If the size differs (a restart, or another writer), the state is read again from the file.
const indexStates = new Map();

async function indexState(file) {
  const size = await fileSize(file);
  const cached = indexStates.get(file);
  if (cached && cached.size === size) return cached;
  const { rows } = await readJsonl(file);
  const keys = new Map();
  for (const r of rows) if (r && typeof r.id === 'string') keys.set(r.id, indexKey(r.status, r.stage, r.waiting));
  const state = { keys, size };
  indexStates.set(file, state);
  return state;
}

async function compactUnlocked(file, { maxBytes = INDEX_MAX_BYTES, force = false } = {}) {
  const before = await fileSize(file);
  if (!force && before <= maxBytes) return { compacted: false, before, after: before, runs: null };
  const { rows } = await readJsonl(file);
  const latest = new Map();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue;
    latest.delete(r.id); // re-insert so the order follows each run's last change
    latest.set(r.id, r);
  }
  const text = [...latest.values()].map(r => JSON.stringify(r)).join('\n') + (latest.size ? '\n' : '');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await renameRetry(tmp, file);
  const keys = new Map([...latest.values()].map(r => [r.id, indexKey(r.status, r.stage, r.waiting)]));
  indexStates.set(file, { keys, size: Buffer.byteLength(text) });
  return { compacted: true, before, after: Buffer.byteLength(text), runs: latest.size };
}

// Rewrites the index with the latest line per run when it is over `maxBytes` (or with `force`).
export function compactIndex(dataDir, opts = {}) {
  const file = indexFile(dataDir);
  return serial(file, () => compactUnlocked(file, opts));
}

function indexIfChanged(dataDir, run, at) {
  const file = indexFile(dataDir);
  return serial(file, async () => {
    const state = await indexState(file);
    const key = indexKey(run.status, run.current?.stage, run.waiting?.kind);
    if (state.keys.get(run.id) === key) return false;
    await appendJsonl(file, indexLine(run, at));
    state.keys.set(run.id, key);
    state.size = await fileSize(file);
    if (state.size > INDEX_MAX_BYTES) await compactUnlocked(file);
    return true;
  });
}

// Writes run.json (atomically, one write at a time per run) and appends an index line when the
// status, stage or waiting kind changed. Sets updatedAt, and endedAt while the status is
// terminal. Refuses a run whose manifest no longer matches its manifestSha256, unless run.json
// already holds that manifest and the save stops the run (checkManifestKept). Returns the run.
export async function saveRun(dataDir, run, { now = Date.now } = {}) {
  checkProject(run?.project);
  checkRunId(run.id);
  checkStatuses(run);
  const file = join(runDir(dataDir, run), 'run.json');
  await checkManifestKept(file, run);
  const at = iso(now());
  run.version = run.version || 1;
  run.updatedAt = at;
  run.endedAt = isTerminal(run.status) ? run.endedAt || at : null;
  await serial(file, () => writeJsonAtomic(file, run));
  await indexIfChanged(dataDir, run, at);
  return run;
}

// The latest index line of every run, newest first, filtered by project, pipeline, status (one
// or a list), parent, and `before` (a run id, for paging). `limit` is 1 to 500 (default 50).
export async function listRuns(dataDir, { project, pipeline, status, parent, before, limit = 50 } = {}) {
  const { rows } = await readJsonl(indexFile(dataDir));
  const latest = new Map();
  for (const r of rows) if (r && RUN_ID_RE.test(String(r.id))) latest.set(r.id, r);
  const statuses = status ? new Set([].concat(status)) : null;
  const n = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  return [...latest.values()]
    .filter(r => (!project || r.project === project) && (!pipeline || r.pipeline === pipeline)
      && (!statuses || statuses.has(r.status)) && (parent === undefined || r.parent === parent)
      && (!before || r.id < before))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, n);
}

const timelineFile = (dataDir, run) => join(runDir(dataDir, run), 'timeline.jsonl');

// Per timeline file: the number of lines and the size we expect, recounted when they differ.
const timelineStates = new Map();

async function countLines(file) {
  let buf;
  try { buf = await readFile(file); } catch (err) {
    if (err.code === 'ENOENT') return { lines: 0, size: 0, torn: false };
    throw err;
  }
  let lines = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) lines++;
  const torn = buf.length > 0 && buf[buf.length - 1] !== 0x0a;
  // A torn last line keeps its number; the next append ends it with a newline first.
  return { lines: lines + (torn ? 1 : 0), size: buf.length, torn };
}

const ROW_EXTRA_MAX = 300;
const TOOL_PHASES = ['start', 'end'];

// The stored form of a row: seq, t, kind, stage, attempt first, msg capped at 300 characters and
// passed through `redact`; tool targets capped at 120, and the tool's `phase` ('start' for the
// call, 'end' for its result, from runs/stream-json.mjs) kept. Other plain fields are kept
// (strings capped), objects other than `tool` are dropped.
function cleanRow(row, seq, at, redact) {
  const scrub = s => (redact ? String(redact(String(s))) : String(s));
  const out = { seq, t: typeof row.t === 'string' ? row.t : at, kind: ROW_KINDS.includes(row.kind) ? row.kind : 'info',
    stage: row.stage ?? null, attempt: row.attempt ?? null };
  if (row.turn !== undefined) out.turn = row.turn;
  out.msg = cap(scrub(row.msg ?? ''), MSG_MAX);
  if (row.tool && typeof row.tool === 'object') {
    out.tool = { name: cap(String(row.tool.name ?? ''), 80), target: cap(scrub(row.tool.target ?? ''), 120), id: row.tool.id ?? null };
    if (TOOL_PHASES.includes(row.tool.phase)) out.tool.phase = row.tool.phase;
  }
  for (const [k, v] of Object.entries(row)) {
    if (k in out || k === 'tool') continue;
    if (typeof v === 'string') out[k] = cap(scrub(v), ROW_EXTRA_MAX);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

// Appends rows to the run's timeline and returns the last seq (the number of rows so far).
// Options: `now` for timestamps, `redact(text)` applied to every message (secrets.redact).
export function appendTimeline(dataDir, run, rows, { now = Date.now, redact } = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && typeof r === 'object');
  const file = timelineFile(dataDir, run);
  return serial(file, async () => {
    let st = timelineStates.get(file);
    if (!st || st.size !== await fileSize(file)) st = await countLines(file);
    if (!list.length) return st.lines;
    const at = iso(now());
    const lead = st.torn ? '\n' : '';
    const text = `${lead}${list.map((r, i) => JSON.stringify(cleanRow(r, st.lines + i + 1, at, redact))).join('\n')}\n`;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, text);
    const next = { lines: st.lines + list.length, size: st.size + Buffer.byteLength(text), torn: false };
    timelineStates.set(file, next);
    return next.lines;
  });
}

// Timeline rows after `since` (a seq; 0 for all), at most `limit` (1 to 2000, default 500).
// Returns { rows, next, more }: pass `next` as the following `since`.
export async function readTimeline(dataDir, run, since = 0, limit = 500) {
  const from = Math.max(0, Number.parseInt(since, 10) || 0);
  const n = Math.min(2000, Math.max(1, Number.parseInt(limit, 10) || 500));
  const { rows, next } = await readJsonl(timelineFile(dataDir, run), { from, limit: n + 1 });
  const more = rows.length > n;
  const out = more ? rows.slice(0, n) : rows;
  return { rows: out, next: more ? (out[out.length - 1].seq ?? next) : next, more };
}

// A plain name in inputs/, or assets/<scope>-<id>@v<n>.<ext> for an attached asset's copy.
const isInputName = s => (INPUT_NAME_RE.test(s) && !s.includes('..')) || ASSET_INPUT_RE.test(s);

function checkInputName(name) {
  const s = String(name ?? '');
  if (!isInputName(s)) throw new Error(`"${name}" is not a valid input file name.`);
  return s;
}

const hashOf = buf => `sha256:${sha256Text(buf)}`;

// Writes inputs/<name>, records its hash in run.inputsHashes and saves the run (R27: the hash
// lives in run.json, which no stage can reach). `name` is a plain file name, or an asset copy's
// assets/<scope>-<id>@v<n>.<ext>. Returns the hash.
export async function writeInput(dataDir, run, name, data, opts = {}) {
  const file = join(runDir(dataDir, run), 'inputs', ...checkInputName(name).split('/'));
  const buf = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data ?? ''), 'utf8');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  const hash = hashOf(buf);
  run.inputsHashes = { ...(run.inputsHashes || {}), [name]: hash };
  await saveRun(dataDir, run, opts);
  return hash;
}

async function listEntries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// What is in inputs/ that run.inputsHashes doesn't list: names in inputs/ itself, and in
// inputs/assets/ (as "assets/<name>") when that is a real folder. Anything else is extra,
// including a link where the assets folder should be.
async function extraInputs(dir, recorded) {
  const extra = [];
  for (const e of await listEntries(dir)) {
    if (e.name === ASSET_INPUT_DIR && e.isDirectory()) {
      for (const a of await listEntries(join(dir, ASSET_INPUT_DIR))) {
        const rel = `${ASSET_INPUT_DIR}/${a.name}`;
        if (!Object.hasOwn(recorded, rel)) extra.push(rel);
      }
    } else if (!Object.hasOwn(recorded, e.name)) extra.push(e.name);
  }
  return extra;
}

// Re-hashes inputs/ against run.inputsHashes. Returns { ok, changed, missing, extra, problems }:
// a changed or missing file, or one the app never wrote, makes ok false.
export async function verifyInputs(dataDir, run) {
  const dir = join(runDir(dataDir, run), 'inputs');
  const recorded = run.inputsHashes || {};
  const changed = [];
  const missing = [];
  for (const [name, hash] of Object.entries(recorded)) {
    if (!isInputName(name)) { changed.push(name); continue; }
    let buf;
    try { buf = await readFile(join(dir, ...name.split('/'))); } catch (err) {
      if (err.code === 'ENOENT') { missing.push(name); continue; }
      throw err;
    }
    if (hashOf(buf) !== hash) changed.push(name);
  }
  const extra = await extraInputs(dir, recorded);
  const problems = [
    ...changed.map(n => `inputs/${n} changed after the app wrote it.`),
    ...missing.map(n => `inputs/${n} is missing.`),
    ...extra.map(n => `inputs/${n} was not written by the app.`),
  ];
  return { ok: problems.length === 0, changed, missing, extra, problems };
}
