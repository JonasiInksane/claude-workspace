// Linked checkouts: a project that lives outside the hub (for example a repo on the Desktop) shows
// up as projects/<name> through a Windows junction, so flows, agents, skills and reports find it
// by name like any other project. Nothing is moved or copied.
//
//   checkLinkTarget  every refusal, in a fixed order (name, repos.json, folder, path, git, origin)
//   linkProject      the check, then fs.symlinkSync(target, projects/<name>, 'junction')
//   unlinkProject    removes the link only (fs.rmdirSync, never recursive); refuses real folders
//   realProjectDir   where Claude and git should run: the checkout's real path for a link
//
// Why junctions: they need no admin rights or developer mode, and `resolveProject` already
// accepts them. Why the real path for launches: Claude Code keys transcripts and trust on the
// working folder, so app sessions line up with the ones started by hand in the checkout, and the
// hub's CLAUDE.md does not load there (the checkout is not under the hub).
//
// tools/lib can't import the workspace app, so this file runs git itself (async execFile, an
// argument list, windowsHide; the app calls it on request paths).
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { projectDir, resolveProject } from './agents.mjs';
import { NAME_RE, readRepos } from './repos.mjs';

const WIN = process.platform === 'win32';
// The folder names the app will start terminals in (the same rule as LAUNCHABLE in
// tools/workspace-app/lookup.mjs, which tools/lib can't import).
const LAUNCHABLE = /^[\w .()-]+$/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const MAX_PATH_TEXT = 400;
const GIT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- paths

// One spelling per folder: resolved, backslashes, lowercase drive letter, no trailing backslash
// (a drive root keeps its backslash, "c:\", because "c:" alone means "the current folder on C:").
export function normalizeWinPath(p) {
  if (!WIN) return resolve(String(p)).replace(/(.)\/+$/, '$1');
  let s = resolve(String(p)).replace(/\//g, '\\');
  s = s.replace(/^([A-Za-z]):/, (m, d) => `${d.toLowerCase()}:`);
  if (!/^[a-z]:\\$/.test(s)) s = s.replace(/\\+$/, '');
  return s;
}

// Whether two paths name the same folder. Windows paths ignore case.
export function samePath(a, b) {
  const x = normalizeWinPath(a);
  const y = normalizeWinPath(b);
  return WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Whether `child` is `parent` or a folder below it (both normalized; case ignored on Windows).
function isSameOrInside(parent, child) {
  const fold = s => (WIN ? s.toLowerCase() : s);
  const p = fold(normalizeWinPath(parent));
  const c = fold(normalizeWinPath(child));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

// The final path of an existing folder, with every junction and symlink resolved and the real
// case of each name (realpathSync.native). Drops the "\\?\" prefix Windows adds to some answers.
function realPathOf(p) {
  let r = realpathSync.native(p);
  if (/^\\\\\?\\[A-Za-z]:/.test(r)) r = r.slice(4);
  return r;
}

// ---------------------------------------------------------------- git

// Runs git without blocking: { ok, stdout, stderr }.
function git(args) {
  return new Promise(resolveP => {
    execFile('git', args, { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

// A remote URL without credentials, for messages: https://user:token@host/x -> https://host/x.
export function redactUrl(url) {
  return String(url || '').replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, '$1');
}

// One spelling per remote, so the same repo matches however it was cloned: "git@host:o/r" and
// "ssh://git@host/o/r" become "https://host/o/r"; credentials, a port, a trailing "/" and ".git"
// are dropped, and the host is lowercased. Anything else (a local path) is only trimmed.
export function normalizeGitUrl(url) {
  let u = String(url || '').trim();
  let host = '';
  let path = '';
  const scp = /^[\w.-]+@([^:/\s]+):(?!\/)(.+)$/.exec(u);
  const full = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (scp && !u.includes('://')) [, host, path] = scp;
  else if (full && !/^file:/i.test(u)) [, host, path] = full;
  const tidy = s => s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host) return tidy(u);
  return `https://${host.toLowerCase()}/${tidy(path)}`;
}

// Hosts whose owner and repo names ignore case: github.com/Example-Org/x is github.com/example-org/x.
// On other hosts the path is compared as written.
const CASELESS_HOSTS = ['github.com', 'gitlab.com'];

// Whether two remote URLs name the same repo (see normalizeGitUrl).
export function sameGitUrl(a, b) {
  if (!a || !b) return false;
  const x = normalizeGitUrl(a);
  const y = normalizeGitUrl(b);
  if (x === y) return true;
  const host = /^https:\/\/([^/]+)\//.exec(x);
  return !!host && CASELESS_HOSTS.includes(host[1]) && x.toLowerCase() === y.toLowerCase();
}

// ---------------------------------------------------------------- checks

// The answer of checkLinkTarget for a refusal. `code` says what kind it is, so the app can pick
// a status: 'invalid' (400), 'not-listed' (404) or 'exists' (409).
const refuse = (code, error) => ({ error, code, realPath: '', origin: '' });

// Checks a link request. Returns { error, code, realPath, origin }: on success error and code are
// '', realPath is the checkout's real path and origin its origin remote (credentials removed).
// Refuses, in this order: a bad name; a name not in projects/repos.json; projects/<name> already
// there; a path that is not absolute or is a network path; a drive root; a folder inside the hub
// (or one that contains it); something that is not a folder; a folder that is not the top of its
// git checkout; an origin remote that doesn't match repos.json.
export async function checkLinkTarget(root, name, target) {
  name = String(name ?? '');
  if (!NAME_RE.test(name) || !LAUNCHABLE.test(name)) {
    return refuse('invalid', `"${name}" is not a project name. Use the kebab-case name from projects/repos.json, for example my-app.`);
  }
  const entry = readRepos(root).repos.find(r => r.name === name);
  if (!entry) return refuse('not-listed', `${name} is not in projects/repos.json. Add it there first, so other PCs know its URL.`);
  if (pathTaken(root, name)) return refuse('exists', `projects/${name} already exists. Unlink or move it first.`);

  const raw = typeof target === 'string' ? target.trim() : '';
  if (!raw || raw.length > MAX_PATH_TEXT || /[\0-\x1f"]/.test(raw)) return refuse('invalid', 'Paste the full folder path of your checkout, for example C:\\Users\\you\\code\\my-app.');
  if (/^[\\/]{2}/.test(raw)) return refuse('invalid', `${raw} is a network path. Link a folder on a local drive.`);
  if (WIN ? !DRIVE_PATH.test(raw) : !raw.startsWith('/')) return refuse('invalid', `${raw} is not a full path. Start it with the drive letter, for example C:\\.`);
  const typed = normalizeWinPath(raw);
  if (WIN ? /^[a-z]:\\$/.test(typed) : typed === '/') return refuse('invalid', `${raw} is a whole drive. Link the checkout's own folder.`);

  // Inside the hub, by the typed path and (when it exists) by the real one.
  let realPath = '';
  try { realPath = realPathOf(typed); } catch { /* reported below as missing */ }
  if (/^[\\/]{2}/.test(realPath)) return refuse('invalid', `${raw} is on a network drive (${realPath}). Link a folder on a local drive.`);
  let hub = resolve(root);
  try { hub = realPathOf(root); } catch { /* keep the resolved path */ }
  for (const p of [typed, realPath].filter(Boolean)) {
    if (isSameOrInside(hub, p) || isSameOrInside(resolve(root), p)) return refuse('invalid', `${raw} is inside the workspace hub. Link a checkout that lives outside it.`);
    if (isSameOrInside(p, hub)) return refuse('invalid', `${raw} contains the workspace hub, so the link would loop the hub into itself.`);
  }
  if (!realPath || !isDirectory(realPath)) return refuse('invalid', `${raw} is not a folder on this PC.`);

  const top = await git(['-C', realPath, 'rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return refuse('invalid', `${raw} is not a git checkout (git said: ${firstLine(top.stderr) || 'no answer'}).`);
  if (!samePath(top.stdout, realPath)) {
    return refuse('invalid', `${raw} is inside the git checkout ${normalizeWinPath(top.stdout)}. Link the checkout's top folder instead.`);
  }

  const remote = await git(['-C', realPath, 'remote', 'get-url', 'origin']);
  const origin = redactUrl(remote.ok ? remote.stdout : '');
  if (!origin) return refuse('invalid', `${raw} has no origin remote, so it can't be matched with ${entry.url} from projects/repos.json.`);
  if (!sameGitUrl(remote.stdout, entry.url)) {
    return refuse('invalid', `The origin of ${raw} is ${origin}, but projects/repos.json lists ${entry.url} for ${name}. Link the right checkout.`);
  }
  return { error: '', code: '', realPath, origin };
}

const firstLine = s => String(s || '').split(/\r?\n/).find(l => l.trim()) || '';

function isDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// projects/<name> in any form: a folder, a file, a link (also a broken one), or a folder with
// the same name in another case.
function pathTaken(root, name) {
  try { lstatSync(projectDir(root, name)); return true; } catch { /* not there */ }
  return !resolveProject(root, name).error;
}

// ---------------------------------------------------------------- link and unlink

// An Error with a plain message and the refusal kind (see checkLinkTarget; also 'failed',
// 'missing' and 'not-link').
function linkError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Removes a link without touching what it points to. On Windows rmdir removes a junction or a
// directory symlink itself (RemoveDirectoryW); on other systems a symlink is unlinked. Never
// recursive.
function removeLink(link) {
  if (!WIN) { unlinkSync(link); return; }
  try { rmdirSync(link); } catch (e) {
    if (e.code !== 'ENOTDIR') throw e;
    unlinkSync(link); // a file symlink
  }
}

// Links an existing checkout as projects/<name>. Throws (with .code) when the check refuses or the
// link can't be made; returns { realPath, origin }.
export async function linkProject(root, name, target) {
  const c = await checkLinkTarget(root, name, target);
  if (c.error) throw linkError(c.code, c.error);
  const link = projectDir(root, name);
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(c.realPath, link, 'junction');
  } catch (e) {
    if (e.code === 'EEXIST') throw linkError('exists', `projects/${name} already exists. Unlink or move it first.`);
    throw linkError('failed', `Could not create the link projects/${name}: ${e.message}`);
  }
  // The link must lead exactly to the checked folder; anything else is taken down again.
  let now = '';
  try { now = realPathOf(link); } catch { /* checked below */ }
  if (!now || !samePath(now, c.realPath)) {
    try { removeLink(link); } catch { /* reported below */ }
    throw linkError('failed', `projects/${name} did not lead to ${c.realPath} after linking, so the link was removed again.`);
  }
  return { realPath: c.realPath, origin: c.origin };
}

// Removes the link projects/<name>; the checkout it points to is not touched. Refuses anything
// that is not a link. Returns { target } (where it pointed, '' when unknown).
export function unlinkProject(root, name) {
  name = String(name ?? '');
  if (!NAME_RE.test(name)) throw linkError('invalid', `"${name}" is not a project name`);
  const link = projectDir(root, name);
  let st;
  try { st = lstatSync(link); } catch { throw linkError('missing', `projects/${name} does not exist`); }
  if (!st.isSymbolicLink()) {
    throw linkError('not-link', `projects/${name} is a real folder, not a link. The app only removes links; it never deletes a folder.`);
  }
  let target = '';
  try { target = readlinkSync(link).replace(/^\\\\\?\\/, ''); } catch { /* unknown */ }
  try { removeLink(link); } catch (e) { throw linkError('failed', `Could not remove the link projects/${name}: ${e.message}`); }
  return { target };
}

// Whether projects/<name> is a link (junction or symlink), also when its target is gone.
export function isLinked(root, name) {
  try { return lstatSync(projectDir(root, name)).isSymbolicLink(); } catch { return false; }
}

// The folder to start Claude and git in: the real path for a linked project, projects/<name>
// unchanged for a normal folder. Throws (status 404) when a link's target is gone.
export function realProjectDir(root, name) {
  const dir = projectDir(root, name);
  if (!isLinked(root, name)) return dir;
  try { return realPathOf(dir); } catch {
    throw Object.assign(new Error(`projects/${name} links to a folder that is gone. Unlink it in Projects, or link the checkout again.`), { status: 404 });
  }
}
