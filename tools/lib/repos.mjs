// projects/repos.json: which git repo belongs in which projects/ folder, and what it needs.
// Shared by tools/projects.mjs and the workspace app; Setup.ps1 reads the same file.
//
//   { "repos": [ { "name": "game-dev", "url": "https://github.com/<you>/game-dev.git",
//                  "requires": ["git-lfs", "blender-5.2"] } ] }
//
// The file is tracked by the workspace (the rest of projects/ is not), so another PC knows what
// to clone. Names are the folder names: flows and agents refer to them.
//
// Two APIs: the sync one (originOf, repoStatus, unlistedProjects, requirementStatus) for the CLI
// tools, and an async one (the same names + Async) for the workspace app, which must not block
// its server while git runs. The async one caches each folder's origin for ORIGIN_TTL_MS.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

export const REQUIREMENTS = ['git-lfs', 'blender-5.2'];
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A clone URL that stays one plain argument: no spaces, quotes or shell characters.
export const GIT_URL = /^(?:https:\/\/|git@)[\w.@:/~+-]+$/;
export const DEFAULT_BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';

export const reposFile = root => join(root, 'projects', 'repos.json');

// The folder name a clone URL suggests: https://github.com/me/My_Game.git -> my-game.
export function nameFromUrl(url) {
  const last = String(url || '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || '';
  return last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function checkEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'an entry must be an object';
  if (!NAME_RE.test(String(entry.name || ''))) return `"${entry.name}" is not a kebab-case folder name`;
  if (!GIT_URL.test(String(entry.url || '')) || String(entry.url).length > 500) return `${entry.name}: the url must start with https:// or git@ and contain no spaces or quotes`;
  const bad = (entry.requires || []).find(r => !REQUIREMENTS.includes(r));
  if (bad) return `${entry.name}: unknown requirement "${bad}" (known: ${REQUIREMENTS.join(', ')})`;
  return '';
}

// { repos, error }: the entries that pass checkEntry; `error` names the first problem found.
export function readRepos(root) {
  const file = reposFile(root);
  if (!existsSync(file)) return { repos: [], error: '' };
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return { repos: [], error: `projects/repos.json is not valid JSON: ${e.message}` }; }
  const repos = [];
  let error = '';
  for (const entry of Array.isArray(data.repos) ? data.repos : []) {
    const problem = checkEntry(entry);
    if (problem) { error ||= problem; continue; }
    repos.push({ name: entry.name, url: entry.url, requires: [...(entry.requires || [])] });
  }
  return { repos, error };
}

function writeRepos(root, repos) {
  writeFileSync(reposFile(root), JSON.stringify({ repos }, null, 2).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
}

// Adds an entry. Returns { error }.
export function addRepo(root, entry) {
  const clean = { name: String(entry.name || ''), url: String(entry.url || '').trim(), requires: [...new Set(entry.requires || [])] };
  const problem = checkEntry(clean);
  if (problem) return { error: problem };
  const { repos, error } = readRepos(root);
  if (error) return { error };
  if (repos.some(r => r.name === clean.name)) return { error: `${clean.name} is already in projects/repos.json` };
  writeRepos(root, [...repos, clean]);
  return { error: '' };
}

export function originOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : '';
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const repoEntry = (r, present, origin) => ({ ...r, present, origin, originMatches: !origin || origin === r.url });

// Each listed repo with whether it is on this PC, and its origin there.
export function repoStatus(root) {
  return readRepos(root).repos.map(r => {
    const dir = join(root, 'projects', r.name);
    const present = isDir(dir);
    return repoEntry(r, present, present ? originOf(dir) : '');
  });
}

// The project folder names that repos.json doesn't list.
function unlistedNames(root) {
  const listed = new Set(readRepos(root).repos.map(r => r.name));
  let entries = [];
  try { entries = readdirSync(join(root, 'projects'), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('_') && !listed.has(e.name))
    .filter(e => isDir(join(root, 'projects', e.name)))
    .map(e => e.name);
}

// Project folders that repos.json doesn't list, with their origin (empty: no remote yet).
export function unlistedProjects(root) {
  return unlistedNames(root).map(name => ({ name, origin: originOf(join(root, 'projects', name)) }));
}

// Whether this PC has what the requirements name. Cached for a minute (it runs programs).
let cache = { at: 0, value: null };
export function requirementStatus({ env = process.env, now = Date.now() } = {}) {
  if (cache.value && now - cache.at < 60_000) return cache.value;
  const lfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', windowsHide: true });
  const value = {
    'git-lfs': lfs.status === 0,
    'blender-5.2': existsSync(env.BLENDER_EXE || DEFAULT_BLENDER),
  };
  cache = { at: now, value };
  return value;
}

// ---------------------------------------------------------------- async (workspace app)

export const ORIGIN_TTL_MS = 10_000;
const GIT_TIMEOUT_MS = 15_000;

// Runs git without blocking. { status, stdout }; status is null when git is missing or timed out.
function gitAsync(args) {
  return new Promise(resolveP => {
    execFile('git', args, { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      const status = !err ? 0 : typeof err.code === 'number' ? err.code : null;
      resolveP({ status, stdout: String(stdout || '') });
    });
  });
}

// The origin remote of a folder ('' without one), always asked fresh.
export async function originOfAsync(dir) {
  const r = await gitAsync(['-C', dir, 'remote', 'get-url', 'origin']);
  return r.status === 0 ? r.stdout.trim() : '';
}

// The same, cached per folder for ORIGIN_TTL_MS. Callers at the same time share one git run.
const originCache = new Map();
function cachedOrigin(dir, now = Date.now()) {
  const hit = originCache.get(dir);
  if (hit && now - hit.at < ORIGIN_TTL_MS) return hit.promise;
  const promise = originOfAsync(dir);
  originCache.set(dir, { at: now, promise });
  return promise;
}

let lfsRun = null; // the `git lfs version` run in progress, shared by callers at the same time

// Forgets the cached origins and requirement checks (for tests).
export function clearRepoCache() {
  originCache.clear();
  cache = { at: 0, value: null };
  lfsRun = null;
}

export function repoStatusAsync(root) {
  return Promise.all(readRepos(root).repos.map(async r => {
    const dir = join(root, 'projects', r.name);
    const present = isDir(dir);
    return repoEntry(r, present, present ? await cachedOrigin(dir) : '');
  }));
}

export function unlistedProjectsAsync(root) {
  return Promise.all(unlistedNames(root).map(async name => ({ name, origin: await cachedOrigin(join(root, 'projects', name)) })));
}

// requirementStatus without blocking; it shares the same one-minute cache.
export async function requirementStatusAsync({ env = process.env, now = Date.now() } = {}) {
  if (cache.value && now - cache.at < 60_000) return cache.value;
  lfsRun ||= gitAsync(['lfs', 'version']).finally(() => { lfsRun = null; });
  const lfs = await lfsRun;
  const value = {
    'git-lfs': lfs.status === 0,
    'blender-5.2': existsSync(env.BLENDER_EXE || DEFAULT_BLENDER),
  };
  cache = { at: now, value };
  return value;
}
