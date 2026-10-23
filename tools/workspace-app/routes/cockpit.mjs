// The project page's API (SPEC 4 and 5.3; it was the project cockpit's before the page got its
// tabs, hub spec plan A1, so the file keeps that name). GET /api/project answers with everything
// the page's header and its tabs' facts bar, setup checklist and cards show about one project,
// plus the launcher's path suggestions (`paths`, SPEC 5.5); the POST routes are the page's buttons:
//   POST /api/project/run-tg           one of the profile's runTg rows (a dev server) in a terminal tab
//   POST /api/project/archive-branch   app/<x> becomes archive/app/<x>; nothing is deleted
//   POST /api/project/profile-init     "Create from the example"; never overwrites a profile
//   POST /api/project/worktree-setup   starts the hidden setup-worktree pipeline in the run engine
//   POST /api/project/isolation        run worktree or branch mode, for this PC (settings.json)
//
// The page names a project and never sends a path. projectOrThrow() checks the name and finds the
// project in projects/ (a linked checkout counts), in projects/repos.json or in the private data
// folder. The other route modules behind the project page's tabs and Today (checks, findings,
// metrics, today) use the same lookup and helpers, so they are exported from here.
//
// GET /api/project builds each part on its own: a part that fails (git can't read the checkout,
// a broken worktree record) comes back as { error } and the other parts still show, so the page
// can render every card by itself. Only the POST routes change anything.
//
// `deps` is for tests only: { trustState(path), ports: { anyListening(ports) } }, so a test needs
// neither the real %USERPROFILE%\.claude.json nor whatever listens on this PC's ports.
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveProject } from '../../lib/agents.mjs';
import { isLinked, realProjectDir, redactUrl, sameGitUrl } from '../../lib/projects.mjs';
import { readRepos } from '../../lib/repos.mjs';
import { jsonHash, PROJECT_RE, projectPaths } from '../core/datadir.mjs';
import * as coreGit from '../core/git.mjs';
import * as realPorts from '../core/ports.mjs';
import { ISOLATION_MODES, loadSettings, saveSettings } from '../core/settings.mjs';
import { knownCount, listBaselines, loadBaseline, loadCandidate } from '../gates/baseline.mjs';
import { lastPerLevel } from '../gates/history.mjs';
import { HttpError, readJson } from '../http.mjs';
import { checkTerminalProgram } from '../launch.mjs';
import { createFromExample, loadProfile, profileDrift, resolveArgv } from '../profile/profile.mjs';
import { trustState as realTrustState } from '../profile/trust.mjs';
import { inspect as inspectLock } from '../runs/locks.mjs';
import { findRun, listRuns, TERMINAL_STATUSES } from '../runs/store.mjs';
import { archiveBranch, worktreeStatus } from '../runs/worktree.mjs';

const NAME_MAX = 64;
const RUN_TG_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const APP_BRANCH_RE = /^app\/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const MAX_BRANCHES = 50;
const DAY_S = 24 * 3600;
const DRIFT_TTL_MS = 60_000;
const DRIFT_CACHE_MAX = 20;
const PATHS_MAX = 400;
// What the app does not check for any project (SPEC 1.2, "Left out on purpose").
export const NOT_COVERED = ['Python agents', 'EAS builds', 'Sentry and runtime logs', 'Browser checks'];

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const message = e => (e && e.message ? e.message : String(e));

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------- shared lookups

// The project a request names: { name, folder, present, mainDir, linked, listed, hasProfile, gone }.
// `name` is the data folder's name for it (lowercase words and hyphens); `folder` its spelling in
// projects/; `mainDir` the checkout's real path (a linked checkout's target), or null while the
// project isn't in projects/. Throws 400 for a value that isn't a project name, and 404 for a
// project the workspace doesn't know, or (with `present`) one whose checkout isn't here.
export function projectOrThrow(ctx, raw, { present = false } = {}) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > NAME_MAX || !PROJECT_RE.test(name)) {
    throw new HttpError(400, `"${String(raw ?? '').slice(0, 40)}" is not a project name. Use lowercase letters, digits and single hyphens.`);
  }
  const found = resolveProject(ctx.root, name);
  const folder = found.error ? null : found.name;
  let mainDir = null;
  let gone = '';
  if (folder) {
    try { mainDir = realProjectDir(ctx.root, folder); } catch (e) { gone = message(e); }
  } else if (isLinked(ctx.root, name)) {
    gone = `projects/${name} links to a folder that is gone. Unlink it in Projects, or link the checkout again.`;
  }
  const listed = readRepos(ctx.root).repos.some(r => r && r.name === name);
  const hasProfile = existsSync(projectPaths(ctx.dataDir, name).profile);
  if (!folder && !gone && !listed && !hasProfile) {
    throw new HttpError(404, `There is no project ${name}: it is not in projects/, not in projects/repos.json and has no profile.`);
  }
  if (present && !mainDir) throw new HttpError(404, gone || `projects/${name} is not here yet. Link your existing checkout in Projects first.`);
  return { name, folder, present: !!mainDir, mainDir, linked: isLinked(ctx.root, folder || name), listed, hasProfile, gone };
}

// The project's profile, checked: { exists, valid, path, profile, errors, warnings }.
export function profileFor(ctx, p) {
  return loadProfile(ctx.dataDir, p.name, { hubRoot: ctx.root, mainDir: p.mainDir || undefined });
}

// Why a profile can't be used, or ''. The hints name the project page's Settings tab
// (#project/<name>/settings), which shows the profile and makes one from the example.
export function profileProblem(info, name) {
  if (!info.exists) return `${name} has no profile yet. Create one from the example on the project's Settings tab.`;
  if (!info.valid) {
    const n = info.errors.length;
    return `The profile for ${name} has ${plural(n, 'problem')}; fix ${n === 1 ? 'it' : 'them'} first (the project's Settings tab lists ${n === 1 ? 'it' : 'them'}).${n ? ` First: ${info.errors[0]}` : ''}`;
  }
  return '';
}

// The valid profile, or 400 with the reason.
export function profileOrThrow(info, name) {
  const problem = profileProblem(info, name);
  if (problem) throw new HttpError(400, problem);
  return info.profile;
}

// The run manager (runs/manager.mjs), made on first use by the app's wiring. Only routes that
// start a run call this.
export async function engineOf(ctx) {
  const engine = typeof ctx.getEngine === 'function' ? await ctx.getEngine() : null;
  if (!engine || typeof engine.start !== 'function') throw new HttpError(503, 'The run engine is not running in this app.');
  return engine;
}

// Run worktree or branch mode: this PC's setting first, then the profile, then the worktree.
export function isolationModeOf(settings, name, profile) {
  return (settings && settings.isolation && settings.isolation[name]) || (profile && profile.isolation && profile.isolation.mode) || 'worktree';
}

// What the page needs of a baseline candidate (no command results): from, to, the ids that leave
// and enter, and the hash to send back with Accept.
export function candidateSummary(c) {
  return {
    key: c.key || null, from: c.from ?? null, to: c.to ?? null, reason: c.reason || '', leaving: c.leaving || [], entering: c.entering || [],
    madeAt: c.madeAt || null, hash: c.hash || '',
  };
}

// A part of a response that may fail on its own: its value, or { error } with the reason.
export async function part(fn) {
  try { return await fn(); } catch (e) { return { error: message(e) }; }
}

// ---------------------------------------------------------------- GET /api/project parts

async function gitPart(p, profile) {
  if (!p.present) return null;
  const g = (profile && profile.git) || {};
  const opts = { prefix: g.branchPrefix || 'app/', archivePrefix: g.archivePrefix || 'archive/app/' };
  let s;
  let warning = '';
  try {
    s = await coreGit.repoSummary(p.mainDir, { ...opts, into: g.integrationBranch || null });
  } catch (e) {
    if (!g.integrationBranch) throw e;
    // Most likely the integration branch doesn't exist here; the summary still helps without it.
    s = await coreGit.repoSummary(p.mainDir, opts);
    warning = `The integration branch ${g.integrationBranch} was not found, so merged app branches are not marked.`;
  }
  return {
    branch: s.branch, sha: s.sha, detached: s.detached, changed: s.changed, staged: s.staged, untracked: s.untracked,
    conflicted: s.conflicted, ahead: s.ahead, behind: s.behind, upstream: s.upstream, stashes: s.stashes,
    integrationBranch: g.integrationBranch || null, appBranches: s.appBranches.slice(0, MAX_BRANCHES),
    appBranchCount: s.appBranches.length, archivedBranches: s.archivedBranches.length, worktrees: s.worktrees, at: s.at, warning,
  };
}

async function lockPart(ctx, name) {
  const info = await inspectLock(ctx.dataDir, name);
  const out = { ...info, title: null, status: null, waiting: null, waitingSince: null };
  if (!info.held || !info.runId) return out;
  const run = await findRun(ctx.dataDir, info.runId).catch(() => null);
  if (!run) return out;
  return { ...out, title: run.title, status: run.status, waiting: run.waiting ? run.waiting.kind : null, waitingSince: run.waiting ? run.waiting.since || null : null };
}

async function baselinePart(ctx, name) {
  const list = await listBaselines(ctx.dataDir, name);
  if (!list.length) return { key: null, known: null, candidate: null, count: 0 };
  const { key, hasCandidate } = list[0];
  const [b, c] = await Promise.all([loadBaseline(ctx.dataDir, name, key), hasCandidate ? loadCandidate(ctx.dataDir, name, key) : null]);
  return {
    key, known: b ? knownCount(b) : null, baseSha: b ? b.baseSha : null, treeMode: b ? b.treeMode : null, node: b ? b.node : null,
    acceptedAt: b ? b.acceptedAt : null, count: list.length, candidate: c ? candidateSummary(c) : null,
  };
}

async function trustPart(p, deps) {
  if (!p.present) return { state: 'unknown', command: '' };
  const t = await (deps.trustState || realTrustState)(p.mainDir);
  return { state: t.state, command: t.command };
}

async function originPart(p) {
  if (!p.present) return null;
  return { url: await coreGit.originUrl(p.mainDir) };
}

// The profile's local service ports that answer now (local databases and queues).
async function servicesPart(profile, deps) {
  const ports = (profile && profile.ports && profile.ports.localServices) || [];
  return ports.length ? (deps.ports || realPorts).anyListening(ports) : [];
}

// The full SHA the profile is compared with: the integration branch, else HEAD.
async function driftBase(dir, integration) {
  for (const rev of [integration, 'HEAD'].filter(Boolean)) {
    try {
      const out = await coreGit.git(dir, ['rev-parse', '-q', '--verify', `${coreGit.assertRev(rev)}^{commit}`], { okCodes: [0, 1] });
      if (out.trim()) return out.trim();
    } catch { /* try the next one */ }
  }
  throw new Error('The checkout has no commits yet, so the profile was not compared with it.');
}

// Drift between the profile and the checkout (SPEC 2.4.2), cached for a minute per base, tree and
// profile, since the cockpit refreshes often and drift reads several files through git.
const driftCache = new Map();
async function driftPart(p, profile, worktree) {
  if (!p.present || !profile) return [];
  const sha = await driftBase(p.mainDir, profile.git && profile.git.integrationBranch);
  const tree = worktree && worktree.state === 'ready' ? worktree.path : p.mainDir;
  const key = `${p.mainDir}|${sha}|${tree}|${jsonHash(profile)}`;
  const hit = driftCache.get(key);
  if (hit && Date.now() - hit.at < DRIFT_TTL_MS) return hit.promise;
  if (driftCache.size >= DRIFT_CACHE_MAX) driftCache.delete(driftCache.keys().next().value);
  const promise = profileDrift(profile, rel => coreGit.fileAt(p.mainDir, sha, rel), {
    tree, listAtBase: dir => coreGit.lsFilesAt(p.mainDir, sha, { paths: dir === '.' ? [] : [dir] }),
  });
  driftCache.set(key, { at: Date.now(), promise });
  promise.catch(() => driftCache.delete(key));
  return promise;
}

// The launcher's path suggestions (SPEC 5.5): folder names under each workspace's src/, the
// feature folders the profile's probes and expo block name, and one level more inside folders
// called features or modules. Read from the checkout's disk; posix, sorted, at most PATHS_MAX.
async function pathHints(p, profile) {
  if (!p.present || !profile) return [];
  const roots = new Set();
  for (const ws of profile.workspaces || []) if (ws && typeof ws.dir === 'string' && ws.dir !== '.') roots.add(`${ws.dir}/src`);
  for (const pr of profile.probes || []) if (pr && typeof pr.featuresDir === 'string') roots.add(pr.featuresDir);
  for (const k of ['webFeatures', 'expoModules']) if (profile.expo && typeof profile.expo[k] === 'string') roots.add(profile.expo[k]);
  const out = new Set();
  const subdirs = async rel => {
    if (rel.split('/').some(s => !s || s === '.' || s === '..')) return [];
    try {
      return (await readdir(join(p.mainDir, ...rel.split('/')), { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => e.name);
    } catch { return []; }
  };
  for (const root of roots) {
    for (const name of await subdirs(root)) {
      out.add(`${root}/${name}`);
      if (name === 'features' || name === 'modules') for (const inner of await subdirs(`${root}/${name}`)) out.add(`${root}/${name}/${inner}`);
    }
  }
  return [...out].sort().slice(0, PATHS_MAX);
}

function daysText(sinceIso, now) {
  const ms = now - Date.parse(sinceIso);
  if (!Number.isFinite(ms)) return '';
  return plural(Math.max(1, Math.floor(ms / (DAY_S * 1000))), 'day');
}

function warningsFor({ p, git, services, drift, lock, now = Date.now() }) {
  const out = [];
  if (p.gone) out.push({ id: 'link.gone', text: p.gone });
  if (Array.isArray(services) && services.length) {
    out.push({ id: 'services.running', text: `Local services are running on ${services.length === 1 ? 'port' : 'ports'} ${services.join(', ')}.` });
  }
  if (git && !git.error) {
    const unmerged = (git.appBranches || []).filter(b => b.merged === false).length;
    if (unmerged) {
      out.push({ id: 'branches.unmerged', text: `${plural(unmerged, 'unmerged app branch', 'unmerged app branches')}; new runs start from ${git.integrationBranch || 'the integration branch'} and won't include ${unmerged === 1 ? 'it' : 'them'}.` });
    }
    if (git.warning) out.push({ id: 'git.integration', text: git.warning });
  }
  if (lock && !lock.error && lock.held) {
    const since = lock.waitingSince || lock.since;
    if (lock.status === 'waiting' && since && now - Date.parse(since) >= DAY_S * 1000) {
      out.push({ id: 'lock.waiting', text: `${lock.title || `Run ${lock.runId}`} has waited ${daysText(since, now)} at the ${lock.waiting || 'next'} gate and holds the lock. Park it to free the run worktree.` });
    }
    if (lock.holderAlive === false) out.push({ id: 'lock.stale', text: `The lock of run ${lock.runId} belongs to an app that is no longer running; the next run takes it over.` });
  }
  if (Array.isArray(drift)) for (const d of drift) out.push({ id: d.id, text: d.text });
  else if (drift && drift.error) out.push({ id: 'drift.error', text: `The profile was not compared with the checkout: ${drift.error}` });
  return out;
}

// The "Setup N/4" list: linked, profile, worktree, trusted. Each { id, ok, text, action?, alt? };
// an action is { kind, label, ... } for the page to wire (link, profile-init, worktree-setup,
// isolation, copy).
function checklistFor({ ctx, p, prof, isolation, trust, origin }) {
  const entry = readRepos(ctx.root).repos.find(r => r && r.name === p.name);
  let linked;
  if (!p.present) {
    linked = { id: 'linked', ok: false, text: p.gone || 'Not linked yet. Link your existing checkout so the app can find it.', action: { kind: 'link', label: 'Link existing checkout', href: '#projects' } };
  } else if (!entry) {
    linked = { id: 'linked', ok: true, text: `projects/${p.folder} is here (it is not listed in projects/repos.json).` };
  } else if (!origin || origin.error) {
    linked = { id: 'linked', ok: false, text: `The origin remote could not be read${origin && origin.error ? `: ${origin.error}` : '.'}` };
  } else if (sameGitUrl(origin.url, entry.url)) {
    linked = { id: 'linked', ok: true, text: `${p.linked ? 'Linked checkout' : `projects/${p.folder}`} (origin matches projects/repos.json)` };
  } else {
    linked = { id: 'linked', ok: false, text: `The origin of the checkout is ${redactUrl(origin.url) || 'not set'}, but projects/repos.json lists ${entry.url}.` };
  }

  let profile;
  if (!prof.exists) profile = { id: 'profile', ok: false, text: 'No profile yet. The app needs one for checks and pipelines.', action: { kind: 'profile-init', label: 'Create from the example' } };
  else if (!prof.valid) profile = { id: 'profile', ok: false, text: `The profile has ${plural(prof.errors.length, 'problem')}; fix ${prof.errors.length === 1 ? 'it' : 'them'} in ${prof.path}.` };
  else profile = { id: 'profile', ok: true, text: 'Profile in the private data folder, not in the public hub.' };

  let worktree;
  const wt = isolation.worktree;
  const toBranch = { kind: 'isolation', mode: 'branch', label: 'Use branch mode' };
  if (!prof.valid) worktree = { id: 'worktree', ok: false, text: 'Needs a valid profile first.' };
  else if (isolation.mode === 'branch') {
    worktree = { id: 'worktree', ok: true, text: 'Branch mode: editing runs use your main checkout on a new branch.', alt: { kind: 'isolation', mode: 'worktree', label: 'Use the run worktree' } };
  } else if (!wt || wt.error) {
    worktree = { id: 'worktree', ok: false, text: wt && wt.error ? wt.error : 'Link the checkout first.', alt: toBranch };
  } else if (wt.state === 'ready') worktree = { id: 'worktree', ok: true, text: wt.text };
  else {
    const setup = ['none', 'missing', 'moved', 'failed'].includes(wt.state)
      ? { kind: 'worktree-setup', label: wt.state === 'failed' ? 'Retry' : `Set up ${wt.name}` } : undefined;
    worktree = { id: 'worktree', ok: false, text: wt.text, ...(setup ? { action: setup } : {}), alt: toBranch };
  }

  let trusted;
  if (!p.present) trusted = { id: 'trusted', ok: false, text: 'Link the checkout first.' };
  else if (trust && trust.state === 'trusted') trusted = { id: 'trusted', ok: true, text: 'Folder trusted (only needed for Open in terminal).' };
  else {
    const command = (trust && trust.command) || '';
    const what = trust && trust.state === 'unknown' ? 'Trust is unknown' : 'Not trusted yet';
    trusted = { id: 'trusted', ok: false, text: `${what} (only needed for Open in terminal). Run this once in PowerShell: ${command}`, action: { kind: 'copy', label: 'Copy command', text: command } };
  }
  return [linked, profile, worktree, trusted];
}

// ---------------------------------------------------------------- Run <project> rows

// The terminal command of one runTg row: { dir, program, args, env }. Throws a plain message when
// it can't start (no checkout, a folder outside it, a {pkg:...} that isn't installed).
function runTgCommand(row, p) {
  if (!p.present) throw new Error('Link the checkout first.');
  if (!Array.isArray(row.argv) || row.argv[0] !== '{node}') throw new Error('Only node commands start from the app; the first argument must be {node}.');
  const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : '.';
  const dir = resolve(p.mainDir, cwd);
  const rel = relative(p.mainDir, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`The folder ${cwd} is outside the checkout.`);
  if (!isDir(dir)) throw new Error(`The folder ${cwd} does not exist in the checkout.`);
  const argv = resolveArgv(row.argv, { tree: p.mainDir, cwd });
  if (row.argv.includes('{npmCli}')) {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) throw new Error(`npm was not found next to node (${npmCli}).`);
  }
  checkTerminalProgram(argv[0], argv.slice(1));
  const env = {};
  for (const [k, v] of Object.entries(row.env && typeof row.env === 'object' ? row.env : {})) env[k] = String(v);
  return { dir, program: argv[0], args: argv.slice(1), env };
}

function runTgRows(profile, p) {
  return ((profile && profile.runTg) || []).filter(r => r && typeof r === 'object').map(r => {
    let disabledReason = '';
    try { runTgCommand(r, p); } catch (e) { disabledReason = message(e); }
    return { id: r.id, label: r.label, warn: r.warn || '', disabledReason };
  });
}

// ---------------------------------------------------------------- routes

export function routes(ctx, deps = {}) {
  return {
    // ?name=<project>: the cockpit. Parts that need the checkout are null until it is linked.
    'GET /api/project': async (req, res, url) => {
      const p = projectOrThrow(ctx, url.searchParams.get('name'));
      const settings = loadSettings(ctx.dataDir);
      const prof = await profileFor(ctx, p);
      const profile = prof.valid ? prof.profile : null;
      const [git, worktree, trust, lock, checks, baseline, services, origin, paths] = await Promise.all([
        part(() => gitPart(p, profile)),
        part(() => (p.present && profile ? worktreeStatus({ profile, mainDir: p.mainDir, dataDir: ctx.dataDir }) : null)),
        part(() => trustPart(p, deps)),
        part(() => lockPart(ctx, p.name)),
        part(() => lastPerLevel(ctx.dataDir, p.name)),
        part(() => baselinePart(ctx, p.name)),
        part(() => servicesPart(profile, deps)),
        part(() => originPart(p)),
        part(() => pathHints(p, profile)),
      ]);
      const drift = await part(() => driftPart(p, profile, worktree));
      const mode = isolationModeOf(settings, p.name, profile);
      const isolation = { mode, source: settings.isolation[p.name] ? 'settings' : profile ? 'profile' : 'default', worktree };
      const pin = profile && profile.node ? profile.node.pin || null : null;
      const active = process.versions.node;
      return {
        ok: true,
        project: {
          name: p.name, folder: p.folder, label: (prof.profile && prof.profile.label) || p.name, realPath: p.mainDir,
          linked: p.linked, present: p.present, listed: p.listed,
        },
        profile: { exists: prof.exists, valid: prof.valid, errors: prof.errors, warnings: prof.warnings, path: prof.path },
        git, isolation, trust,
        node: { active, pin, matches: pin ? pin === active : null },
        lock,
        warnings: warningsFor({ p, git, services, drift, lock }),
        checklist: checklistFor({ ctx, p, prof, isolation, trust, origin }),
        checks, baseline,
        runTg: runTgRows(profile, p),
        notCovered: NOT_COVERED,
        paths,
      };
    },

    // { project, id }: one runTg row of the profile in a terminal tab at the checkout. The row's
    // warn text comes back with the answer; dev servers use the project's real settings.
    'POST /api/project/run-tg': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const profile = profileOrThrow(await profileFor(ctx, p), p.name);
      const id = typeof b.id === 'string' ? b.id : '';
      if (!RUN_TG_ID_RE.test(id)) throw new HttpError(400, `"${String(b.id ?? '').slice(0, 40)}" is not a Run entry id.`);
      const row = (profile.runTg || []).find(r => r && r.id === id);
      if (!row) throw new HttpError(404, `The ${p.name} profile has no Run entry "${id}".`);
      let cmd;
      try { cmd = runTgCommand(row, p); } catch (e) { throw new HttpError(400, `${row.label} can't start: ${message(e)}`); }
      if (!ctx.actions || typeof ctx.actions.runInTerminal !== 'function') throw new HttpError(503, 'This app cannot open terminal tabs.');
      await ctx.actions.runInTerminal({ dir: cmd.dir, title: `${profile.label || p.name}: ${row.label}`, program: cmd.program, args: cmd.args, env: cmd.env });
      return { ok: true, message: `Started ${row.label} in a terminal tab.${row.warn ? ` ${row.warn}` : ''}`, warn: row.warn || '' };
    },

    // { project, branch }: renames app/<x> to archive/app/<x>. Refused for other branches, a
    // branch a worktree has checked out, and a branch a run that is still going works on.
    'POST /api/project/archive-branch': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const branch = typeof b.branch === 'string' ? b.branch.trim() : '';
      if (!APP_BRANCH_RE.test(branch) || branch.includes('..')) {
        throw new HttpError(400, `"${String(b.branch ?? '').slice(0, 80)}" is not an app branch; only app/ branches can be archived.`);
      }
      const busy = (await listRuns(ctx.dataDir, { project: p.name, limit: 500 })).find(r => r.branch === branch && !TERMINAL_STATUSES.includes(r.status));
      if (busy) throw new HttpError(400, `${busy.title || busy.id} still works on ${branch}; finish or stop that run first.`);
      let r;
      try { r = await archiveBranch(p.mainDir, branch); } catch (e) { throw new HttpError(400, message(e)); }
      coreGit.clearGitCache();
      return { ok: true, message: `Archived ${r.from} as ${r.to}. Nothing was deleted.` };
    },

    // { project }: copies the synthetic example profile to the data folder with the project name
    // filled in. 409 when a profile exists: the app never overwrites one.
    'POST /api/project/profile-init': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      let r;
      try { r = createFromExample(ctx.root, ctx.dataDir, p.name); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        // A hub without pipelines/app/profiles/example.json: nothing to copy, not a crash.
        if (e && /example profile .* could not be read/.test(e.message)) throw new HttpError(404, e.message);
        throw e;
      }
      return { ok: true, path: r.path, message: `Created the ${p.name} profile from the example. Replace its synthetic values with the project's own.` };
    },

    // { project }: starts the setup-worktree pipeline (git worktree add, then install and
    // generate). The engine answers 409 while another run holds the project's lock.
    'POST /api/project/worktree-setup': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      profileOrThrow(await profileFor(ctx, p), p.name);
      const engine = await engineOf(ctx);
      const r = await engine.start({ project: p.name, pipeline: 'setup-worktree', values: {} });
      return { ok: true, runId: r.runId, message: 'Setting up the run worktree. Follow it in the run view.' };
    },

    // { project, mode: 'worktree' | 'branch' }: this PC's isolation mode for the project.
    'POST /api/project/isolation': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (!ISOLATION_MODES.includes(b.mode)) throw new HttpError(400, `mode must be ${ISOLATION_MODES.join(' or ')}.`);
      let s;
      try { s = saveSettings(ctx.dataDir, { isolation: { [p.name]: b.mode } }); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      const text = b.mode === 'branch' ? 'Editing runs now use your main checkout on a new branch.' : 'Editing runs now use the run worktree.';
      return { ok: true, mode: s.isolation[p.name], message: text };
    },
  };
}
