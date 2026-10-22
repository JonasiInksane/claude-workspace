// The run tree: a second checkout of a project (for example C:\dev\example-run) that only the app
// touches, so editing runs never switch branches under the user's editor or dev servers.
//
//   setupWorktree     once: git worktree add --detach, then the profile's install and generate
//                     commands, then the record in dataDir/worktrees/<project>.json
//   prepareRunTree    per run: clean and detached, check out the base, refresh install or
//                     generate only when the lockfile or schema files changed
//   applyChanges      copy the main checkout's uncommitted changes into the run tree
//   savePatch, applyPatch, resetTree   park, cancel and resume (git clean -fd only, so ignored
//                     files such as node_modules survive)
//   commitInTree      the commit gate: a new branch, exactly the gated files, the project's own
//                     hooks (never skipped), then a detached HEAD again
//   branchModeCheck, prepareBranchMode, finishBranchMode   the fallback without a worktree
//   branchName, archiveBranch   app/<mmdd>-<slug> names, and archive/app/... instead of deleting
//
// Safety: the app never stashes, never sends anything to a remote and never combines branches.
// Resets and patches refuse a main checkout unless the caller says it is in branch mode
// (allowMain), and even then only while its HEAD is detached and the branch mode record still
// counts, so neither a checkout on one of the user's branches nor one the user detached somewhere
// else is ever cleaned. In worktree mode nothing in the user's checkout changes except the
// branch created at commit. prepareBranchMode also leaves a small record in the checkout's git
// folder (finishBranchMode removes it). The record never allows a reset or a patch on its own: it
// counts only while HEAD is still where that run put it, and then it marks the checkout as busy,
// backs the caller's allowMain, and lets the commit gate commit at exactly the recorded base.
// Install and generate run through gates/commands.mjs (runCommand), which tests replace.
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  addPaths, allDone, assertRev, changedFiles, cleanPath, commitTree, diffNames, diffText, git, GitError, gitPaths, headInfo,
  operationInProgress, stashSummary, statusSummary, toplevel, treeHash, worktreeKind, worktrees,
} from '../core/git.mjs';
import { anyListening } from '../core/ports.mjs';
import { writeJsonAtomic } from '../core/datadir.mjs';

export const APP_PREFIX = 'app/';
export const ARCHIVE_PREFIX = 'archive/';
export const BRANCH_MODE_FILE = 'ws-app-branch-mode.json';
const PROJECT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const WORKTREE_ADD_MS = 10 * 60_000;
const COMMIT_MS = 10 * 60_000;
const LOG_COPY_BYTES = 256 * 1024;
// The app's commit must not leave git's background maintenance (gc) running in the user's repo.
const NO_AUTO_MAINTENANCE = { 'maintenance.auto': 'false', 'gc.auto': '0' };

// Words that say nothing about a change, left out of branch names.
export const STOP_WORDS = new Set(`
  the and for with into from onto that this these those then than when what which where while who whom whose why how
  are was were been being have has had does did doing done not but nor yet all any each every some more most less
  very also just only too our ours your yours their them they its his her she him you can could should would will
  shall may might must please make makes made add adds added update updates updated change changes changed use uses
  using move moves moved refactor refactors refactored implement implements fix fixes fixed create creates created
  remove removes removed get set put let new old via per out off over under about after before again code file files
  thing things stuff`.split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------- small helpers

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = sha => String(sha || '').slice(0, 7);
const unique = list => [...new Set(list)];
const nowIso = () => new Date().toISOString();
const someFiles = s => s.files.slice(0, 3).map(f => f.path).join(', ');

function checkProject(project) {
  if (!PROJECT_RE.test(String(project || ''))) throw new Error(`"${project}" is not a valid project name.`);
  return String(project);
}

function requireDir(dir, what) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${what} is missing.`);
  return resolve(dir);
}

function checkSha(sha, what) {
  if (!SHA_RE.test(String(sha || ''))) throw new Error(`The ${what} "${String(sha || '').slice(0, 80)}" is not a commit sha.`);
  return String(sha);
}

export function checkBranchName(name) {
  const s = String(name || '');
  const bad = !BRANCH_RE.test(s) || s.includes('..') || s.includes('//') || s.includes('/.') || s.endsWith('/')
    || s.endsWith('.') || s.split('/').some(part => part.endsWith('.lock'));
  if (bad) throw new Error(`"${s.slice(0, 80)}" is not a valid branch name.`);
  return s;
}

function norm(p) {
  let r = resolve(String(p));
  if (r.length > 3) r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

const exists = p => stat(p).then(() => true, () => false);

function real(p) {
  try { return realpathSync.native(p); } catch { return String(p); }
}

// Two spellings of one folder: case, slashes and junctions don't matter.
export function samePath(a, b) {
  return norm(a) === norm(b) || norm(real(a)) === norm(real(b));
}

function inside(child, parent) {
  const rel = relative(norm(real(parent)), norm(real(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function readJsonFile(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

const stderrLines = text => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// The last lines of git's stderr, for a short error message.
function stderrTail(text, n = 3) {
  return stderrLines(text).slice(-n).join(' / ').slice(0, 400);
}

// Why git could not read a folder: its fatal:/error: lines when it printed any, else the tail.
// The lines after them are hints; a dubious ownership refusal ends with
// "git config --global --add safe.directory C:/", which must not read as the app's advice.
export function gitReason(text, n = 2) {
  const errors = stderrLines(text).filter(s => /^(fatal|error):/.test(s));
  return errors.length ? errors.slice(-n).join(' / ').slice(0, 400) : stderrTail(text, n);
}

async function branchExists(dir, name) {
  return Boolean((await git(dir, ['rev-parse', '-q', '--verify', `refs/heads/${name}`], { okCodes: [0, 1] })).trim());
}

// ---------------------------------------------------------------- branch mode record

const branchModeFile = async mainDir => (await gitPaths(mainDir, [BRANCH_MODE_FILE]))[0];

// The full sha of a commit, or null when the repo has no such commit.
async function commitSha(dir, rev) {
  const out = await git(dir, ['rev-parse', '-q', '--verify', `${assertRev(rev, 'commit')}^{commit}`], { okCodes: [0, 1] });
  return out.trim() || null;
}

// Whether `sha` is the tip of one of the app's branches (the commit gate's new branch).
async function appBranchTip(dir, sha) {
  const out = await git(dir, ['for-each-ref', '--format=%(refname)', `--points-at=${sha}`, `refs/heads/${APP_PREFIX.replace(/\/$/, '')}`]);
  return Boolean(out.trim());
}

// The branch mode record of a main checkout while an app run uses it:
// { version, base, original: { branch, sha }, runId, since, file, head, atBase }, otherwise null.
// It counts only while HEAD is detached where that run put it: at the recorded base (atBase), or,
// right after the commit gate, at the tip of a new app/ branch whose parent is that base. A record
// left behind by a crash counts as null once the checkout is on a branch or detached anywhere else,
// so it can't vouch for a checkout the user has taken back.
export async function branchModeState(mainDir) {
  const file = await branchModeFile(mainDir);
  const rec = await readJsonFile(file).catch(() => null);
  if (!rec || typeof rec !== 'object' || !SHA_RE.test(String(rec.base || ''))) return null;
  const head = await headInfo(mainDir);
  if (!head.detached || !head.sha) return null;
  const base = await commitSha(mainDir, rec.base);
  if (!base) return null;
  const atBase = head.sha === base;
  if (!atBase && ((await commitSha(mainDir, `${head.sha}^`)) !== base || !(await appBranchTip(mainDir, head.sha)))) return null;
  return { ...rec, file, head: head.sha, atBase };
}

// Whether prepareBranchMode's record covers a commit gate in this main checkout: HEAD detached at
// the recorded base, which is also the gate's base, and the same run when the caller names one.
async function recordAllowsCommit(tree, baseFull, runId) {
  const rec = await branchModeState(tree);
  if (!rec?.atBase || rec.head !== baseFull) return false;
  return !runId || rec.runId === runId;
}

// Resets, patches and commits belong in the app's run worktree. A main checkout is allowed only
// in branch mode, and only when the caller says so: allowMain, or (for the commit gate) a check
// that the branch mode record belongs to this run (viaRecord). Even then its HEAD must be
// detached, since a checkout on a branch is the user's own work. allowMain also needs a branch
// mode record that still counts (HEAD where that run put it; branchModeState), and the same run
// when runId is given: a HEAD the user detached somewhere else is their own work too. `tree` must
// be the top folder of its checkout, so a run tree that lost its link to the repository can't
// reach a parent repo.
async function assertRunTree(tree, verb, { allowMain = false, viaRecord = null, runId = null } = {}) {
  const what = `The app does not ${verb} ${tree}`;
  if (!samePath(await toplevel(tree), tree)) throw new Error(`${what}: it is not the top folder of a git checkout.`);
  if ((await worktreeKind(tree)) !== 'main') return;
  if (!allowMain && !(viaRecord && await viaRecord())) throw new Error(`${what}: it is a main checkout, not the app's run worktree.`);
  const head = await headInfo(tree);
  if (!head.detached) throw new Error(`${what}: it is a main checkout on branch ${head.branch}, so it is not in branch mode.`);
  if (!allowMain) return;
  const rec = await branchModeState(tree);
  if (!rec) throw new Error(`${what}: its HEAD is detached at ${head.short}, but no branch mode run put it there.`);
  if (runId && rec.runId !== runId) throw new Error(`${what}: it is in branch mode for ${rec.runId ? `run ${rec.runId}` : 'another run'}, not run ${runId}.`);
}

// ---------------------------------------------------------------- record and log

export const worktreeRecordFile = (dataDir, project) => join(dataDir, 'worktrees', `${checkProject(project)}.json`);
export const setupLogFile = (dataDir, project) => join(dataDir, 'worktrees', `${checkProject(project)}-setup.log`);

// The worktree record (2.12), or null before the first setup.
export function loadWorktreeRecord(dataDir, project) {
  return readJsonFile(worktreeRecordFile(dataDir, project));
}

// Lines go to onLine (the live view) and, timestamped, to the setup log.
function makeLogger(file, onLine) {
  let chain = mkdir(dirname(file), { recursive: true }).catch(() => {});
  const write = text => { chain = chain.then(() => appendFile(file, text, 'utf8')).catch(() => {}); return chain; };
  const log = line => {
    try { onLine?.(String(line)); } catch { /* a broken listener must not stop the setup */ }
    return write(`[${nowIso()}] ${line}\n`);
  };
  log.raw = write;
  log.flush = () => chain;
  return log;
}

// The profile's isolation block, checked: { project, iso, path, name }.
function isolationOf(profile) {
  const project = checkProject(profile?.project);
  const iso = profile.isolation || {};
  const raw = String(iso.worktreePath || '');
  if (!raw || !isAbsolute(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new Error(`The ${project} profile needs isolation.worktreePath as an absolute local path.`);
  }
  const path = resolve(raw);
  return { project, iso, path, name: basename(path) };
}

async function checkMainDir(mainDir) {
  const dir = requireDir(mainDir, 'The main checkout folder');
  if (!samePath(await toplevel(dir), dir)) throw new Error(`${dir} is not the top folder of a git checkout.`);
  if ((await worktreeKind(dir)) !== 'main') throw new Error(`${dir} is an added worktree; give the project's main checkout.`);
  return dir;
}

const goneText = (path, mainDir) => `${path} is still registered as a worktree of ${mainDir}, but the folder is gone; run git worktree prune in ${mainDir}, then set it up again.`;

// The run tree must exist and be a worktree that git added for this main checkout.
async function checkRunTree(path, mainDir) {
  const wt = (await worktrees(mainDir)).find(w => !w.main && samePath(w.path, path));
  if (!(await exists(path))) throw new Error(wt ? goneText(path, mainDir) : `${path} does not exist; set up the worktree again.`);
  if (!wt) throw new Error(`${path} is not a worktree of ${mainDir}.`);
  return path;
}

// git status of a run tree folder. Throws a plain message when git can't read it there (a
// deleted .git file, a corrupt index, an ownership refusal), or when the folder has lost its link
// to the repository and git finds a checkout further up instead.
async function treeStatus(path) {
  const why = e => (e instanceof GitError && gitReason(e.stderr)) || e.message;
  let top;
  try { top = await toplevel(path); } catch (e) {
    throw new Error(`Git can't read ${path} as a checkout (${why(e)}).`);
  }
  if (!samePath(top, path)) {
    throw new Error(`${path} has lost its link to the repository (git finds ${top} there instead); move the folder away and run git worktree prune, then set it up again.`);
  }
  try { return await statusSummary(path); } catch (e) {
    throw new Error(`git status fails in ${path} (${why(e)}).`);
  }
}

// ---------------------------------------------------------------- lockfile and schema hashes

async function hashFiles(tree, files) {
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(`${rel}\0`);
    try { h.update(await readFile(join(tree, rel))); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      h.update('(missing)');
    }
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

// { lockHash, schemaHash } of the files in a tree, as the record and run.json store them.
// lockHash is the sha256 of the lockfile; schemaHash covers every schema file, name and content.
export async function runTreeHashes(tree, profile) {
  const iso = profile?.isolation || {};
  let lockHash = 'sha256:none';
  if (iso.lockfile) {
    try { lockHash = `sha256:${createHash('sha256').update(await readFile(join(tree, cleanPath(iso.lockfile)))).digest('hex')}`; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { lockHash, schemaHash: await hashFiles(tree, (iso.schemaFiles || []).map(cleanPath)) };
}

// ---------------------------------------------------------------- setup commands

// gates/commands.mjs, loaded on first use when the caller passes no runner of its own.
let commandsModule = null;
async function defaultRunCommand(opts) {
  commandsModule ||= import('../gates/commands.mjs');
  let mod;
  try { mod = await commandsModule; } catch (e) {
    commandsModule = null;
    throw new Error(`The worktree setup needs gates/commands.mjs, which could not be loaded: ${e.message}`);
  }
  return mod.runCommand(opts);
}

// A setup entry is a command id, or a command kind ("install", "generate") naming the first
// command of that kind in the profile.
function commandIdFor(profile, entry) {
  const cmds = profile.commands || {};
  if (cmds[entry]) return entry;
  const id = Object.keys(cmds).find(k => cmds[k]?.kind === entry);
  if (!id) throw new Error(`The ${profile.project} profile has no "${entry}" command for the worktree setup.`);
  return id;
}

const succeeded = r => Boolean(r) && (r.status ? r.status === 'pass' : r.exitCode === 0);

// Copies the logs a command wrote into its gate folder (output and stderr) into the setup log,
// each cut to its last LOG_COPY_BYTES.
async function copyCommandLogs(gateDir, log) {
  const names = (await readdir(gateDir).catch(() => [])).filter(n => n.endsWith('.log')).sort();
  for (const name of names) {
    const buf = await readFile(join(gateDir, name)).catch(() => null);
    if (!buf?.length) continue;
    const cut = buf.length > LOG_COPY_BYTES;
    const text = buf.subarray(buf.length - Math.min(buf.length, LOG_COPY_BYTES)).toString('utf8');
    await log.raw(`--- ${name}${cut ? ' (earlier output cut)' : ''} ---\n${text}${text.endsWith('\n') ? '' : '\n'}`);
  }
}

function failureText(id, r, signal) {
  if (signal?.aborted || r?.status === 'cancelled') return `${id} was cancelled`;
  if (r?.status === 'skip') return `${id} did not run (${r.reason || 'skipped'})`;
  const exit = Number.isInteger(r?.exitCode) ? ` with exit code ${r.exitCode}` : '';
  return `${id} failed${exit}${r?.reason ? ` (${String(r.reason).slice(0, 300)})` : ''}`;
}

// Runs the given profile commands one by one in the run tree through runCommand
// (gates/commands.mjs, or the injected one). Each gets a scratch gate folder; its logs are
// copied into the setup log. Returns [{ id, kind, ms, at }].
async function runSteps(ids, { profile, tree, runCommand, proc, signal, log }) {
  const run = typeof runCommand === 'function' ? runCommand : defaultRunCommand;
  const done = [];
  for (const id of ids) {
    if (signal?.aborted) throw new Error('The setup was cancelled.');
    const cmd = profile.commands[id];
    await log(`Running ${id} (${cmd.kind}) in ${tree}`);
    const gateDir = await mkdtemp(join(tmpdir(), 'ws-setup-'));
    const started = Date.now();
    let r;
    try {
      r = await run({ profile, commandId: id, tree, treeMode: 'run', files: [], gateDir, signal, proc });
      await copyCommandLogs(gateDir, log);
    } catch (e) {
      await log(`${id} could not run: ${e.message}`);
      throw e;
    } finally {
      await rm(gateDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    const ms = Number.isFinite(r?.durationMs) ? r.durationMs : Date.now() - started;
    if (!succeeded(r)) {
      const why = failureText(id, r, signal);
      await log(why);
      throw new Error(`${why}; see the setup log.`);
    }
    await log(`${id} finished in ${Math.round(ms / 1000)} s`);
    done.push({ id, kind: cmd.kind, ms, at: nowIso() });
  }
  return done;
}

// Record fields for the commands that just ran.
function stepTimes(ran, record) {
  const out = {};
  const installs = ran.filter(r => r.kind === 'install');
  const generates = ran.filter(r => r.kind === 'generate');
  if (installs.length) Object.assign(out, { lastInstallAt: installs.at(-1).at, installMs: installs.reduce((s, r) => s + r.ms, 0) });
  if (generates.length) out.lastGenerateAt = generates.at(-1).at;
  return { lastInstallAt: record.lastInstallAt ?? null, installMs: record.installMs ?? null, lastGenerateAt: record.lastGenerateAt ?? null, ...out };
}

// Install and generate must leave the tree clean, or every run's diff would carry their output.
async function assertCleanAfter(tree, ids, name, then) {
  const s = await statusSummary(tree);
  if (!s.clean) throw new Error(`${ids.join(' and ')} left ${plural(s.changed, 'changed file')} in ${name} (${someFiles(s)}); fix those commands in the profile, then ${then}.`);
}

// ---------------------------------------------------------------- status and setup

function describeState(st, record, mainDir) {
  const { name } = st;
  const err = typeof record?.error === 'string' ? record.error : record?.error?.message;
  if (record?.status === 'setting-up') return { state: 'setting-up', text: `${name} is being set up (or the last setup stopped part way).` };
  if (record?.status === 'failed') return { state: 'failed', text: `The last setup of ${name} failed: ${err || 'see the setup log'}` };
  if (st.exists && !st.registered) return { state: 'blocked', text: `${st.path} exists but is not a worktree of ${mainDir}; move it away or choose another path.` };
  if (record?.path && !samePath(record.path, st.path)) return { state: 'moved', text: `The profile points at ${st.path}, but the worktree was set up at ${record.path}; run the setup again.` };
  if (!st.exists && st.registered) return { state: 'missing', text: goneText(st.path, mainDir) };
  if (st.error) return { state: 'failed', text: `${st.error} A run can't use ${name} until this is fixed.` };
  if (!record) return { state: 'none', text: st.registered ? `${name} exists but the app has not set it up; run the setup.` : `${name} is not set up yet.` };
  if (!st.exists || !st.registered) return { state: 'missing', text: `${name} is gone; set it up again.` };
  if (st.clean === false) return { state: 'dirty', text: `${name} has ${plural(st.changed, 'changed file')}; a run can't start until it is clean.` };
  if (st.detached === false) return { state: 'on-branch', text: `${name} is on branch ${st.branch}; a run needs a detached HEAD.` };
  return { state: 'ready', text: `${name} is ready${st.head ? ` at ${short(st.head)}` : ''}.` };
}

// What the cockpit shows about the run tree: { mode, path, name, state, status, text, exists,
// registered, head, branch, detached, clean, changed, record, error }. state (also as status) is
// one of none, setting-up, failed, blocked, moved, missing, dirty, on-branch or ready. A tree whose
// git status can't be read is 'failed' (error says why), never 'ready'.
export async function worktreeStatus({ profile, mainDir, dataDir }) {
  const { project, iso, path, name } = isolationOf(profile);
  const st = { mode: iso.mode || 'worktree', path, name, exists: await exists(path), registered: false, head: null, branch: null, detached: null, clean: null, changed: null, record: null, error: null };
  const done = s => ({ ...st, ...s, status: s.state });
  try { st.record = await loadWorktreeRecord(dataDir, project); } catch (e) {
    return done({ state: 'failed', text: e.message });
  }
  let list;
  try { list = await worktrees(mainDir); } catch (e) {
    return done({ state: 'failed', text: `Can't list the worktrees of ${mainDir}: ${e.message}` });
  }
  st.registered = list.some(w => !w.main && samePath(w.path, path));
  if (st.exists && st.registered) {
    try {
      const s = await treeStatus(path);
      Object.assign(st, { head: s.sha, branch: s.branch, detached: s.detached, clean: s.clean, changed: s.changed });
    } catch (e) {
      st.error = e.message;
    }
  }
  return done(describeState(st, st.record, mainDir));
}

// The commit a run tree is set up at: the tip of the profile's integration branch, which every
// run checks out as its base, so install and generate prepare the tree the runs will use (not
// whatever branch the main checkout happens to be on). Without one in the profile: HEAD.
async function setupBase(main, profile) {
  const branch = profile?.git?.integrationBranch;
  if (!branch) return { rev: 'HEAD', label: 'HEAD' };
  const sha = await commitSha(main, branch);
  if (!sha) throw new Error(`The integration branch ${branch} (git.integrationBranch in the profile) is not in ${main}; fetch it, or fix the profile.`);
  return { rev: sha, label: branch };
}

// Creates (or repairs) the run tree at the integration branch (setupBase) and writes its record.
// Throws a plain message on a refusal or a failed command; the record then says "failed".
// Returns the record. runCommand defaults to gates/commands.mjs; proc and signal are passed
// through to it.
export async function setupWorktree({ profile, mainDir, dataDir, onLine, signal, proc, runCommand }) {
  const { project, iso, path, name } = isolationOf(profile);
  const main = await checkMainDir(mainDir);
  if (inside(path, main) || inside(main, path)) throw new Error(`${path} and ${main} overlap; the worktree must live outside the checkout.`);
  const registered = (await worktrees(main)).some(w => !w.main && samePath(w.path, path));
  const there = await exists(path);
  if (there && !registered) throw new Error(`${path} already exists and is not a worktree of ${main}; move it away or choose another isolation.worktreePath.`);
  if (!there && registered) throw new Error(goneText(path, main));
  if (registered) {
    // The app's own tree, but it may hold work that was never saved: never wipe it here.
    const s = await treeStatus(path);
    if (!s.clean) throw new Error(`${name} has ${plural(s.changed, 'changed file')} (${someFiles(s)}); the app never stashes. Look at git status in ${path} first.`);
    if (!s.detached) throw new Error(`${name} is on branch ${s.branch}; run git switch --detach in ${path} first.`);
  }
  const steps = unique((iso.setup || []).map(e => commandIdFor(profile, e)));
  const base = await setupBase(main, profile);
  const recordFile = worktreeRecordFile(dataDir, project);
  const log = makeLogger(setupLogFile(dataDir, project), onLine);
  const prev = await loadWorktreeRecord(dataDir, project).catch(() => null);
  const record = {
    version: 1, path, mainDir: main, status: 'setting-up', createdAt: prev?.createdAt || nowIso(),
    lockHash: null, schemaHash: null, lastInstallAt: prev?.lastInstallAt ?? null, installMs: prev?.installMs ?? null,
    lastGenerateAt: prev?.lastGenerateAt ?? null, log: `worktrees/${project}-setup.log`, error: null,
  };
  await writeJsonAtomic(recordFile, record);
  try {
    await log(`Setting up ${path} for ${project}`);
    if (registered) {
      await log(`${path} is already a worktree of ${main}; reusing it at ${base.label} (${short(base.rev)}).`);
      await git(path, ['checkout', '-q', '--detach', base.rev], { signal });
    } else {
      await log(`git worktree add --detach ${path} ${base.label}`);
      await git(main, ['worktree', 'add', '--detach', path, base.rev], { timeoutMs: WORKTREE_ADD_MS, signal });
    }
    const ran = await runSteps(steps, { profile, tree: path, runCommand, proc, signal, log });
    await assertCleanAfter(path, steps, name, 'set it up again');
    Object.assign(record, await runTreeHashes(path, profile), stepTimes(ran, record), { status: 'ready', error: null });
    await writeJsonAtomic(recordFile, record);
    await log(`${name} is ready.`);
    await log.flush();
    return record;
  } catch (e) {
    Object.assign(record, { status: 'failed', error: e.message });
    await writeJsonAtomic(recordFile, record).catch(() => {});
    await log(`Setup failed: ${e.message}`);
    await log.flush();
    throw e;
  }
}

// Gets the run tree ready for one run at baseSha. Refuses a tree with changes or on a branch.
// Reruns refresh.onLockfile / refresh.onSchema commands only when those hashes changed since
// the last install. Returns { tree, head, refreshed: [commandId] } (empty when nothing ran), with
// the same list as `ran` too, which is the name the executor reads.
// runCommand (default gates/commands.mjs), proc and signal are used only for a refresh.
export async function prepareRunTree({ profile, mainDir, dataDir, baseSha, onLine, signal, proc, runCommand }) {
  const { project, iso, path, name } = isolationOf(profile);
  checkSha(baseSha, 'base');
  const record = await loadWorktreeRecord(dataDir, project);
  if (!record || record.status !== 'ready') {
    throw new Error(`${name} is not set up yet${record?.status === 'failed' ? ' (the last setup failed)' : ''}; run the worktree setup from the cockpit first.`);
  }
  if (record.path && !samePath(record.path, path)) {
    throw new Error(`The profile points at ${path}, but the worktree was set up at ${record.path}; run the worktree setup again.`);
  }
  const tree = await checkRunTree(path, requireDir(mainDir, 'The main checkout folder'));
  const s = await treeStatus(tree);
  if (!s.clean) throw new Error(`${name} has ${plural(s.changed, 'changed file')}; the app never stashes.`);
  if (!s.detached) throw new Error(`${name} is on branch ${s.branch}, not a detached HEAD; run git switch --detach in ${tree} first.`);
  await git(tree, ['checkout', '-q', '--detach', baseSha]);
  const head = (await git(tree, ['rev-parse', 'HEAD'])).trim();
  const hashes = await runTreeHashes(tree, profile);
  const refresh = iso.refresh || {};
  const lockChanged = hashes.lockHash !== record.lockHash;
  const schemaChanged = hashes.schemaHash !== record.schemaHash;
  const ids = unique([...(lockChanged ? refresh.onLockfile || [] : []), ...(schemaChanged ? refresh.onSchema || [] : [])].map(e => commandIdFor(profile, e)));
  if (!ids.length) return { tree, head, refreshed: [], ran: [] };
  const why = [lockChanged && 'the lockfile changed', schemaChanged && 'the schema changed'].filter(Boolean).join(' and ');
  const log = makeLogger(setupLogFile(dataDir, project), onLine);
  await log(`Base ${short(head)}: ${why}; running ${ids.join(', ')}`);
  const recordFile = worktreeRecordFile(dataDir, project);
  let ran;
  try {
    ran = await runSteps(ids, { profile, tree, runCommand, proc, signal, log });
  } catch (e) {
    // The hashes stay as they were, so the next run tries the refresh again.
    await writeJsonAtomic(recordFile, { ...record, error: e.message }).catch(() => {});
    await log.flush();
    throw e;
  }
  await writeJsonAtomic(recordFile, { ...record, ...hashes, ...stepTimes(ran, record), error: null });
  await log.flush();
  await assertCleanAfter(tree, ids, name, 'start the run again');
  const refreshed = ran.map(r => r.id);
  return { tree, head, refreshed, ran: refreshed };
}

// ---------------------------------------------------------------- patches and resets

const countPatchFiles = buf => (buf.toString('latin1').match(/^diff --git /gm) || []).length;

// Applies a patch file (from savePatch or applyChanges) to the working files of a tree. A main
// checkout is refused unless the caller passes allowMain (branch mode), its HEAD is detached and
// a branch mode record (of runId, when given) still counts. An empty patch is a no-op.
export async function applyPatch(tree, file, { allowMain = false, runId = null } = {}) {
  await assertRunTree(tree, 'apply a patch to', { allowMain, runId });
  const abs = resolve(String(file || ''));
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`The patch file ${abs} does not exist.`);
  if (info.size === 0) return { applied: false };
  await git(tree, ['apply', '--binary', '--whitespace=nowarn', abs]);
  return { applied: true };
}

// Copies the main checkout's uncommitted changes (tracked and untracked; never secret files or
// `exclude`) into the run tree, which must be clean and at the same commit. Returns { applied,
// patchFile, bytes, files }. Without patchFile the patch goes to a temporary file that is removed.
export async function applyChanges({ tree, mainDir, mode = 'uncommitted', patchFile = null, exclude = [] }) {
  if (mode !== 'uncommitted') throw new Error(`Only uncommitted changes can be copied into the run tree, not "${mode}".`);
  if ((await worktreeKind(tree)) === 'main' || samePath(tree, mainDir)) {
    throw new Error(`The app does not copy changes into ${tree}: it is a main checkout, not the app's run worktree.`);
  }
  const name = basename(resolve(tree));
  const [t, m] = await allDone([headInfo(tree), headInfo(mainDir)]);
  if (t.sha !== m.sha) throw new Error(`${name} is at ${short(t.sha)} but ${mainDir} is at ${short(m.sha)}; prepare the run tree at ${short(m.sha)} first.`);
  const s = await statusSummary(tree);
  if (!s.clean) throw new Error(`${name} has ${plural(s.changed, 'changed file')}; the app never stashes.`);
  const patch = await diffText(mainDir, 'HEAD', { includeUntracked: true, exclude, encoding: 'buffer' });
  if (!patch.length) return { applied: false, patchFile: null, bytes: 0, files: [] };
  const own = !patchFile;
  const file = resolve(patchFile || join(tmpdir(), `ws-apply-${process.pid}-${randomBytes(4).toString('hex')}.patch`));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, patch);
  try {
    await applyPatch(tree, file);
  } finally {
    if (own) await rm(file, { force: true });
  }
  const files = (await changedFiles(tree, 'HEAD')).map(f => f.path);
  return { applied: true, patchFile: own ? null : file, bytes: patch.length, files };
}

// Writes the tree's changes against base (tracked and untracked; never secret files or
// `exclude`) to `file`, byte for byte, so applyPatch can bring them back.
// Returns { file, bytes, files, empty }.
export async function savePatch(tree, base, file, { exclude = [] } = {}) {
  const patch = await diffText(tree, base, { includeUntracked: true, exclude, encoding: 'buffer' });
  const out = resolve(String(file || ''));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, patch);
  return { file: out, bytes: patch.length, files: countPatchFiles(patch), empty: patch.length === 0 };
}

// Puts the tree back to a clean, detached base: restore tracked files, remove untracked files
// (git clean -fd; ignored files such as node_modules stay), then check out the base. A main
// checkout is refused unless the caller passes allowMain (branch mode), its HEAD is detached and
// a branch mode record (of runId, when given) still counts; a record alone never allows it.
// Returns { tree, head }.
export async function resetTree(tree, base, { allowMain = false, runId = null } = {}) {
  checkSha(base, 'base');
  await assertRunTree(tree, 'clean up', { allowMain, runId });
  const name = basename(resolve(tree));
  // Exit code 1 here only means there was nothing tracked to restore; the status check below
  // catches anything that really stayed behind.
  await git(tree, ['restore', '--staged', '--worktree', '--', '.'], { okCodes: [0, 1] });
  await git(tree, ['clean', '-fd']);
  await git(tree, ['checkout', '-q', '--detach', base]);
  const s = await statusSummary(tree);
  if (!s.clean) {
    throw new Error(`${name} still has ${plural(s.changed, 'changed file')} after the reset (${someFiles(s)}); close programs that hold files there and try again.`);
  }
  return { tree: resolve(tree), head: s.sha };
}

// ---------------------------------------------------------------- the commit gate

function treeChanged() {
  const e = new Error('Tree changed since gates ran; run the checks again before committing.');
  e.status = 409;
  e.code = 'TREE_CHANGED';
  return e;
}

async function stagedNames(tree, base) {
  return (await git(tree, ['diff', '--cached', '--name-only', '--no-renames', '-z', base, '--'])).split('\0').filter(Boolean);
}

// After a failed commit: back to the detached base with the changes unstaged, and the empty
// branch the gate just created removed again (it has no commits of its own).
async function undoBranch(tree, branch, baseSha) {
  try {
    await git(tree, ['switch', '-q', '--detach', baseSha]);
    await git(tree, ['branch', '-d', branch]);
    await git(tree, ['restore', '--staged', '--', '.'], { okCodes: [0, 1] });
  } catch { /* best effort; the caller's error says nothing was committed */ }
}

// The commit gate. Checks that the tree is detached at base and still hashes to gatedTreeSha
// (409 otherwise), then: git switch -c <branch>, git add exactly `files`, git commit -F
// <messageFile> with the project's hooks, git switch --detach. Returns { sha, branch, treeSha,
// commitTree, at, hookChanged: [path], stashDelta, leftover: [path] }: treeSha (also as
// commitTree) is the committed tree, hookChanged lists files the hooks rewrote, stashDelta
// counts stash entries the hooks left, leftover lists changes that stayed uncommitted.
// A main checkout (branch mode) needs allowMain, or a branch mode record at exactly this base
// (and for runId, when given).
export async function commitInTree({ tree, base, branch, files, messageFile, gatedTreeSha, allowMain = false, runId = null, timeoutMs = COMMIT_MS }) {
  checkSha(base, 'base');
  checkSha(gatedTreeSha, 'gated tree hash');
  checkBranchName(branch);
  const list = unique((files || []).map(cleanPath));
  if (!list.length) throw new Error('The commit has no files.');
  const msg = resolve(String(messageFile || ''));
  const info = await stat(msg).catch(() => null);
  if (!info || !info.isFile() || info.size === 0) throw new Error(`The commit message file ${msg} is missing or empty.`);
  const viaRecord = async () => recordAllowsCommit(tree, await commitSha(tree, base), runId);
  await assertRunTree(tree, 'commit in', { allowMain, viaRecord, runId });
  const name = basename(resolve(tree));
  const baseFull = (await git(tree, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const head = await headInfo(tree);
  if (!head.detached || head.sha !== baseFull) {
    throw new Error(`${name} is ${head.detached ? `at ${head.short}` : `on branch ${head.branch}`}, not detached at the base ${short(baseFull)}; the commit gate needs the tree the gates checked.`);
  }
  if (await branchExists(tree, branch)) throw new Error(`The branch ${branch} already exists; pick another name.`);
  const preStaged = await stagedNames(tree, baseFull);
  if (preStaged.length) throw new Error(`${name} already has staged changes (${preStaged.slice(0, 3).join(', ')}); the app stages only the gated files.`);
  if ((await treeHash(tree, baseFull, list)) !== gatedTreeSha) throw treeChanged();

  const stashBefore = (await stashSummary(tree)).total;
  await git(tree, ['switch', '-q', '-c', branch]);
  let failure = null;
  try {
    await addPaths(tree, list);
    const allowed = new Set(list);
    const extra = (await stagedNames(tree, baseFull)).filter(p => !allowed.has(p));
    if (extra.length) throw new Error(`files outside the gated list were staged (${extra.slice(0, 3).join(', ')})`);
    await git(tree, ['commit', '-F', msg], { timeoutMs, config: NO_AUTO_MAINTENANCE });
  } catch (e) {
    failure = e;
  }
  const sha = (await git(tree, ['rev-parse', 'HEAD'])).trim();
  if (failure && sha === baseFull) {
    await undoBranch(tree, branch, baseFull);
    const why = failure instanceof GitError ? stderrTail(failure.stderr) || failure.message : failure.message;
    const e = new Error(`The commit did not go through: ${why}. Nothing was committed; the changes are still in ${name}.`, { cause: failure });
    e.stderr = failure.stderr || '';
    throw e;
  }
  const treeSha = await commitTree(tree, sha);
  const hookChanged = treeSha === gatedTreeSha ? [] : await diffNames(tree, gatedTreeSha, treeSha);
  const stashAfter = (await stashSummary(tree)).total;
  await git(tree, ['switch', '-q', '--detach']);
  const leftover = (await statusSummary(tree)).files.map(f => f.path);
  return { sha, branch, treeSha, commitTree: treeSha, at: nowIso(), hookChanged, stashDelta: stashAfter - stashBefore, leftover };
}

// ---------------------------------------------------------------- branch mode

// Whether a run may use the main checkout directly: { ok, reason (also as refusal), reasons,
// changed, ports, branch, sha, detached, operation }. Refused with changed files, a merge or
// rebase that is half done, or a listening dev port.
export async function branchModeCheck({ profile, mainDir }) {
  const [s, operation, ports] = await allDone([
    statusSummary(mainDir),
    operationInProgress(mainDir),
    anyListening(profile?.ports?.dev || []),
  ]);
  const reasons = [];
  if (!s.clean) reasons.push(`${plural(s.changed, 'changed file')}; commit or set them aside yourself, the app never stashes.`);
  if (operation) reasons.push(`A ${operation} is in progress in ${mainDir}; finish or abort it yourself first.`);
  if (ports.length) {
    const label = profile?.label || profile?.project || 'The project';
    const which = ports.length === 1 ? `port ${ports[0]} is` : `ports ${ports.slice(0, -1).join(', ')} and ${ports.at(-1)} are`;
    reasons.push(`${label} ${which} in use; stop dev servers first.`);
  }
  const reason = reasons.join(' ');
  return { ok: !reasons.length, reason, refusal: reason, reasons, changed: s.changed, ports, branch: s.branch, sha: s.sha, detached: s.detached, operation };
}

// Branch mode start: check again, record where the checkout was (in its git folder, see
// branchModeState), then detach at the base. Returns { tree, head, original: { branch, sha },
// originalBranch } for run.json; originalBranch is '' when the checkout was detached.
export async function prepareBranchMode({ profile, mainDir, baseSha, runId = null }) {
  checkSha(baseSha, 'base');
  const main = await checkMainDir(mainDir);
  const active = await branchModeState(main);
  if (active) throw new Error(`${main} is already in branch mode${active.runId ? ` for run ${active.runId}` : ''}; finish that run first, or switch the checkout to a branch yourself.`);
  const check = await branchModeCheck({ profile, mainDir: main });
  if (!check.ok) throw new Error(check.reason);
  const original = { branch: check.branch, sha: check.sha };
  const file = await branchModeFile(main);
  await writeJsonAtomic(file, { version: 1, base: baseSha, original, runId, since: nowIso() });
  try {
    await git(main, ['switch', '-q', '--detach', baseSha]);
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  }
  const head = (await git(main, ['rev-parse', 'HEAD'])).trim();
  return { tree: main, head, original, originalBranch: original.branch || '' };
}

// Branch mode end: back to the branch (or commit) the checkout was on, then the branch mode
// record is removed. Takes `original` ({ branch, sha }) or `branch`; without either (or with an
// empty branch) it uses the record. Either way it switches only while the record still counts
// (branchModeState; of runId, when given): a checkout you switched or detached yourself is yours
// again, so it is left alone (a stale record is removed) and the result says switched: false.
// The checkout must be clean by then (the run's changes are committed, or saved and reset).
// Returns { branch, sha } of the checkout afterwards, plus switched: false when it was left alone.
export async function finishBranchMode({ mainDir, original = null, branch = '', runId = null }) {
  const main = requireDir(mainDir, 'The main checkout folder');
  const file = await branchModeFile(main);
  const rec = await branchModeState(main);
  const given = original?.branch || original?.sha ? original : branch ? { branch, sha: null } : null;
  const orig = given || rec?.original;
  const target = orig?.branch || orig?.sha;
  if (!target) throw new Error('There is no recorded branch to switch back to.');
  if (!rec || (runId && rec.runId !== runId)) {
    if (!rec) await rm(file, { force: true });
    const head = await headInfo(main);
    return { branch: head.branch, sha: head.sha, switched: false };
  }
  const s = await statusSummary(main);
  if (!s.clean) throw new Error(`${main} has ${plural(s.changed, 'changed file')}; save or drop them before switching back to ${target}.`);
  if (orig.branch) await git(main, ['switch', '-q', assertRev(orig.branch, 'branch')]);
  else await git(main, ['switch', '-q', '--detach', checkSha(orig.sha, 'original commit')]);
  await rm(file, { force: true });
  const head = await headInfo(main);
  return { branch: head.branch, sha: head.sha };
}

// ---------------------------------------------------------------- names and archive

// app/<mmdd>-<slug>: up to 3 words longer than 2 letters, stop words left out, "-2", "-3"...
// when the name is taken. `existing` holds branch names (strings or { name }).
export function branchName(text, date = new Date(), existing = []) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`"${date}" is not a date.`);
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const words = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const slug = (unique(words).slice(0, 3).join('-') || 'change').slice(0, 40).replace(/-+$/, '');
  const taken = new Set([...(existing || [])].map(x => String(typeof x === 'object' && x ? x.name : x).replace(/^refs\/heads\//, '')));
  const first = `${APP_PREFIX}${mmdd}-${slug}`;
  if (!taken.has(first)) return first;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${first}-${n}`)) return `${first}-${n}`;
  throw new Error(`Every name like ${first} is taken.`);
}

// Renames app/<x> to archive/app/<x> instead of deleting it. Refuses other branches, a branch
// checked out in any worktree, and an archive name that already exists. Returns { from, to }.
export async function archiveBranch(mainDir, name) {
  const from = String(name || '');
  if (!from.startsWith(APP_PREFIX)) throw new Error(`Only ${APP_PREFIX} branches can be archived; "${from.slice(0, 80)}" is not one.`);
  checkBranchName(from);
  const to = `${ARCHIVE_PREFIX}${from}`;
  if (!(await branchExists(mainDir, from))) throw new Error(`There is no branch ${from}.`);
  const holder = (await worktrees(mainDir)).find(w => w.branch === from);
  if (holder) throw new Error(`${from} is checked out in ${holder.path}; switch that checkout to another branch first.`);
  if (await branchExists(mainDir, to)) throw new Error(`${to} already exists; the app never overwrites a branch.`);
  await git(mainDir, ['branch', '-m', from, to]);
  return { from, to };
}
