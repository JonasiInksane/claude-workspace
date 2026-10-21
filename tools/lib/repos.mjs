// projects/repos.json: which git repo belongs in which projects/ folder, and what it needs.
// Shared by tools/projects.mjs and the workspace app; Setup.ps1 reads the same file.
//
//   { "repos": [ { "name": "game-dev", "url": "https://github.com/<you>/game-dev.git",
//                  "requires": ["git-lfs", "blender-5.2"] } ] }
//
// The file is tracked by the workspace (the rest of projects/ is not), so another PC knows what
// to clone. Names are the folder names: flows and agents refer to them.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// Each listed repo with whether it is on this PC, and its origin there.
export function repoStatus(root) {
  return readRepos(root).repos.map(r => {
    const dir = join(root, 'projects', r.name);
    const present = isDir(dir);
    const origin = present ? originOf(dir) : '';
    return { ...r, present, origin, originMatches: !origin || origin === r.url };
  });
}

// Project folders that repos.json doesn't list, with their origin (empty: no remote yet).
export function unlistedProjects(root) {
  const listed = new Set(readRepos(root).repos.map(r => r.name));
  let entries = [];
  try { entries = readdirSync(join(root, 'projects'), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('_') && !listed.has(e.name))
    .filter(e => isDir(join(root, 'projects', e.name)))
    .map(e => ({ name: e.name, origin: originOf(join(root, 'projects', e.name)) }));
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
