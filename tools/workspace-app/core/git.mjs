// Git for the workspace app: every git call the app makes on a project checkout goes through here.
//
// Each call runs `git -c core.longpaths=true -C <dir> ...` as an async child process (execFile, an
// argument array, windowsHide, a 60 s default timeout), so a slow repo never blocks the server and
// no shell ever parses a path. A failure throws a GitError with the exit code and git's stderr.
// A timeout or a cancel kills git's whole process tree (hooks and filters included), and calls
// that run side by side always all finish before an error is thrown, so no git process is left
// working in a folder the caller has moved on from.
//
// The app only reads, and writes in its own run tree (runs/worktree.mjs). It never sends commits
// to a remote, never combines branches and never touches the stash: stash counts are read from the
// stash reflog, which is read-only. The real index of a checkout is never used for hashing either;
// treeHash builds the tree in a throwaway index file. Diffs and patches never carry secret files
// (.env, .npmrc, .sentryclirc), whatever the caller passes.
//
// Paths in and out are repo-relative with forward slashes. Revisions are checked before use, so a
// value from a run file can't turn into a git option.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const GIT_TIMEOUT_MS = 60_000;
export const SUMMARY_TTL_MS = 10_000;
const MAX_BUFFER = 256 * 1024 * 1024;
// Keeps one `git add` command line well under the Windows limit of 32767 characters.
const ARG_CHARS = 8000;
const UNTRACKED_CONCURRENCY = 4;

export class GitError extends Error {
  constructor(message, { code = null, stderr = '', args = [], dir = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
    this.dir = dir;
  }
}

// ---------------------------------------------------------------- running git

// Variables from the app's own environment that would point git at another repo or index, or
// change how pathspecs and config are read. Callers set the ones they need through opts.env.
const DROP_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]);

function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (DROP_ENV.has(up) || up.startsWith('GIT_CONFIG_KEY_') || up.startsWith('GIT_CONFIG_VALUE_')) continue;
    env[k] = v;
  }
  // Never wait for a password prompt, and never take optional locks (status would otherwise
  // rewrite the index of a checkout the user is working in).
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  for (const [k, v] of Object.entries(extra)) {
    // Windows env names ignore case: drop any other spelling before setting this one.
    for (const have of Object.keys(env)) if (have.toUpperCase() === k.toUpperCase()) delete env[have];
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

const subcommand = args => args.find(a => !a.startsWith('-')) || 'git';

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  return line.replace(/^(fatal|error):\s*/i, '').slice(0, 300);
}

function toGitError(err, dir, args, stderr) {
  const sub = subcommand(args);
  const info = { stderr, args, dir };
  if (err.code === 'ENOENT') return new GitError('git was not found. Install Git for Windows and make sure git is on PATH.', { ...info, code: 'ENOENT' });
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GitError(`git ${sub} printed more than ${MAX_BUFFER / 1024 / 1024} MB, so the app stopped it.`, { ...info, code: 'MAXBUFFER' });
  const code = typeof err.code === 'number' ? err.code : null;
  const why = firstLine(stderr) || `exit code ${code}`;
  return new GitError(`git ${sub} failed in ${dir}: ${why}`, { ...info, code });
}

function stoppedError(why, dir, args, stderr, timeoutMs) {
  const sub = subcommand(args);
  if (why === 'ABORTED') return new GitError(`git ${sub} was cancelled.`, { code: 'ABORTED', stderr, args, dir });
  const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
  return new GitError(`git ${sub} took longer than ${limit} and was stopped.`, { code: 'TIMEOUT', stderr, args, dir });
}

// Stops git and everything it started. On Windows a hook, a filter or an alias's shell survives
// the death of git.exe, so the whole tree goes through taskkill /T (an .exe, no shell). Then the
// output pipes are closed on the app's side: a background process that git started can hold them
// open after git is gone, and the call only ends once they close.
// When git.exe has already exited, only such an orphan is left. taskkill can't reach it through
// git's pid any more (and on Windows that pid may already belong to another program), so the app
// only closes the pipes and stops waiting.
function killTree(child) {
  const release = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
  if (child.exitCode !== null || child.signalCode !== null) return release();
  const plain = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } release(); };
  if (process.platform !== 'win32' || !child.pid) return plain();
  execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 10_000 }, plain);
}

// setTimeout fires at once for delays above 2^31 - 1 ms, so long timeouts are capped there.
const MAX_TIMER_MS = 2 ** 31 - 1;

const CONFIG_KEY_RE = /^[a-z][a-z0-9-]*(\.[A-Za-z0-9_.-]+)?\.[a-z][a-z0-9]*$/i;

// One-off settings for this call only (`-c key=value`), never written to the repo's config.
function configArgs(config) {
  const out = [];
  for (const [k, v] of Object.entries(config || {})) {
    if (!CONFIG_KEY_RE.test(k) || /[\0\r\n]/.test(String(v))) throw new GitError(`"${k}" is not a git setting the app can pass.`, { code: 'EINVAL' });
    out.push('-c', `${k}=${v}`);
  }
  return out;
}

// Runs git in `dir`. Resolves to stdout (a string, or a Buffer with encoding 'buffer'), or to
// { code, stdout, stderr } with full: true. Exit codes in okCodes count as success.
// opts: { timeoutMs (0 = none), env, config: {key: value}, okCodes = [0],
//         encoding = 'utf8' | 'buffer', full, input, signal }
export function git(dir, args, opts = {}) {
  const { timeoutMs = GIT_TIMEOUT_MS, env = {}, config = {}, okCodes = [0], encoding = 'utf8', full = false, input = null, signal } = opts;
  if (typeof dir !== 'string' || !dir) return Promise.reject(new GitError('git needs a folder to run in.', { code: 'EINVAL', args }));
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) {
    return Promise.reject(new GitError('git arguments must be a list of plain strings.', { code: 'EINVAL', dir }));
  }
  if (signal?.aborted) return Promise.reject(stoppedError('ABORTED', dir, args, '', timeoutMs));
  let extra;
  try { extra = configArgs(config); } catch (e) { return Promise.reject(e); }
  const argv = ['-c', 'core.longpaths=true', ...extra, '-C', dir, ...args];
  return new Promise((resolveP, rejectP) => {
    let child = null;
    let timer = null;
    let stopped = null; // 'TIMEOUT' or 'ABORTED' once the app has killed the command
    const stop = why => {
      if (stopped || !child) return;
      stopped = why;
      killTree(child);
    };
    const onAbort = () => stop('ABORTED');
    try {
      child = execFile('git', argv, { encoding: 'buffer', windowsHide: true, maxBuffer: MAX_BUFFER, env: gitEnv(env) },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
          if (stopped) return rejectP(stoppedError(stopped, dir, args, errText, timeoutMs));
          const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
          const out = encoding === 'buffer' ? raw : raw.toString('utf8');
          const code = !err ? 0 : typeof err.code === 'number' ? err.code : null;
          if (code !== null && okCodes.includes(code)) return resolveP(full ? { code, stdout: out, stderr: errText } : out);
          rejectP(toGitError(err, dir, args, errText));
        });
    } catch (e) {
      rejectP(toGitError(e, dir, args, ''));
      return;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => stop('TIMEOUT'), Math.min(timeoutMs, MAX_TIMER_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Git never waits on stdin: it gets the input, or an immediate end of file.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? undefined);
  });
}

// Like Promise.all, but waits for every call to finish before throwing the first error, so no
// git process is still running when the caller handles the failure.
export async function allDone(promises) {
  const results = await Promise.allSettled(promises);
  const bad = results.find(r => r.status === 'rejected');
  if (bad) throw bad.reason;
  return results.map(r => r.value);
}

// ---------------------------------------------------------------- argument checks

// A revision: a sha, a branch or a ref expression such as HEAD~2 or main^{tree}.
export function assertRev(rev, what = 'revision') {
  const s = String(rev ?? '');
  if (!s || s.length > 250 || s.startsWith('-') || /[\s\0-\x1f\x7f]|\.\.|@\{-/.test(s.replace(/\^\{\w*\}$/, ''))) {
    throw new GitError(`"${s.slice(0, 80)}" is not a valid ${what}.`, { code: 'EINVAL' });
  }
  return s;
}

// A range for rev-list: "a..b", "a...b" or one revision.
function assertRange(range) {
  const parts = String(range ?? '').split(/\.\.\.?/);
  if (parts.length > 2) throw new GitError(`"${String(range).slice(0, 80)}" is not a valid range.`, { code: 'EINVAL' });
  parts.forEach(p => assertRev(p, 'range'));
  return String(range);
}

// A repo-relative path: forward slashes, no leading "./", never absolute and never "..".
export function cleanPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!s || s.includes('\0') || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) {
    throw new GitError(`"${String(p).slice(0, 120)}" is not a path inside the repository.`, { code: 'EINVAL' });
  }
  return s.replace(/\/+$/, '');
}

const splitZ = out => String(out).split('\0').filter(Boolean);
const lines = out => String(out).split(/\r?\n/).filter(Boolean);

// Groups paths into argument lists that stay under the command-line limit.
function chunks(paths) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 3 > ARG_CHARS) { out.push(cur); cur = []; len = 0; }
    cur.push(p);
    len += p.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- where am I

// The checkout's top folder, as a native path.
export async function toplevel(dir) {
  return resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
}

// 'main' for a repository's own checkout, 'linked' for a folder added with git worktree add.
export async function worktreeKind(dir) {
  const [gitDir, common] = lines(await git(dir, ['rev-parse', '--git-dir', '--git-common-dir']));
  return resolve(dir, gitDir).toLowerCase() === resolve(dir, common).toLowerCase() ? 'main' : 'linked';
}

// { sha, short, branch, detached, unborn, subject, at } for HEAD.
export async function headInfo(dir) {
  // symbolic-ref fails (128) outside a repository, so it is also the "is this a repo" check.
  const [sym, log] = await allDone([
    git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] }),
    git(dir, ['log', '-1', '--format=%H%x1f%h%x1f%cI%x1f%s'], { full: true, okCodes: [0, 128] }),
  ]);
  const branch = sym.trim() || null;
  if (log.code !== 0) {
    if (!/does not have any commits|bad default revision|unknown revision/i.test(log.stderr)) {
      throw new GitError(`git log failed in ${dir}: ${firstLine(log.stderr) || 'exit code 128'}`, { code: 128, stderr: log.stderr, args: ['log'], dir });
    }
    return { sha: null, short: null, branch, detached: false, unborn: true, subject: '', at: null };
  }
  const [sha, short, at, subject] = log.stdout.replace(/\r?\n$/, '').split('\x1f');
  return { sha, short, branch, detached: !branch, unborn: false, subject: subject || '', at };
}

// Paths inside the repository's git folder (for example "MERGE_HEAD"), as absolute paths, in the
// order given. In an added worktree these are the worktree's own git folder entries.
export async function gitPaths(dir, names) {
  for (const name of names) {
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(String(name)) || String(name).split('/').includes('..')) {
      throw new GitError(`"${String(name).slice(0, 80)}" is not a git folder entry.`, { code: 'EINVAL' });
    }
  }
  const out = lines(await git(dir, ['rev-parse', ...names.flatMap(n => ['--git-path', n])]));
  return out.map(p => resolve(dir, p.trim()));
}

// Markers git leaves while a command waits for the user to finish it.
const IN_PROGRESS = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];

// 'merge', 'rebase', 'cherry-pick', 'revert' or 'bisect' when one is half done, otherwise null.
export async function operationInProgress(dir) {
  const paths = await gitPaths(dir, IN_PROGRESS.map(([name]) => name));
  const found = await Promise.all(paths.map(existsOnDisk));
  const i = found.indexOf(true);
  return i === -1 ? null : IN_PROGRESS[i][1];
}

// ---------------------------------------------------------------- status

// Parses `git status --porcelain=v2 --branch -z`.
export function parseStatus(out) {
  const s = { sha: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = String(out).split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') s.sha = val === '(initial)' ? null : val;
      else if (key === 'branch.head') { s.detached = val === '(detached)'; s.branch = s.detached ? null : val; }
      else if (key === 'branch.upstream') s.upstream = val;
      else if (key === 'branch.ab') {
        const m = val.match(/^\+(\d+) -(\d+)$/);
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
      }
      continue;
    }
    const f = t.split(' ');
    if (f[0] === '1') s.files.push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1], kind: 'changed' });
    else if (f[0] === '2') s.files.push({ path: f.slice(9).join(' '), oldPath: tokens[++i], x: f[1][0], y: f[1][1], kind: 'renamed' });
    else if (f[0] === 'u') s.files.push({ path: f.slice(10).join(' '), x: f[1][0], y: f[1][1], kind: 'conflict' });
    else if (f[0] === '?') s.files.push({ path: t.slice(2), x: '?', y: '?', kind: 'untracked' });
  }
  const count = fn => s.files.filter(fn).length;
  return {
    ...s,
    changed: s.files.length,
    staged: count(f => f.kind !== 'untracked' && f.x !== '.'),
    unstaged: count(f => f.kind !== 'untracked' && f.y !== '.'),
    untracked: count(f => f.kind === 'untracked'),
    conflicted: count(f => f.kind === 'conflict'),
    clean: s.files.length === 0,
  };
}

// Branch, upstream, ahead/behind and every changed, staged, untracked or conflicted file.
export async function statusSummary(dir) {
  return parseStatus(await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
}

// How many stash entries the repo has, and how many were made on `branch`. Read from the stash
// reflog (what `git stash list` prints), so the app itself never runs the stash command.
export async function stashSummary(dir, branch = null) {
  const has = await git(dir, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [0, 1] });
  if (!has.trim()) return { total: 0, onBranch: 0 };
  const subjects = lines(await git(dir, ['log', '-g', '--format=%gs', 'refs/stash', '--']));
  const mine = branch ? subjects.filter(s => s.startsWith(`On ${branch}:`) || s.startsWith(`WIP on ${branch}:`)) : [];
  return { total: subjects.length, onBranch: mine.length };
}

// ---------------------------------------------------------------- branches and worktrees

const HEADS = 'refs/heads/';
const refPattern = prefix => HEADS + String(prefix || '').replace(/\/+$/, '');

// Local branches under `prefix` (default app/), newest first:
// [{ name, sha, at, subject, worktree, merged }]. `merged` (into `into`) is null without `into`.
export async function appBranches(dir, { prefix = 'app/', into = null } = {}) {
  if (into) assertRev(into, 'branch');
  const fmt = '--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(worktreepath)%1f%(subject)';
  const [out, merged] = await allDone([
    git(dir, ['for-each-ref', fmt, refPattern(prefix)]),
    into ? mergedInto(dir, into, { prefix }) : null,
  ]);
  const mergedSet = merged ? new Set(merged) : null;
  return lines(out)
    .map(line => {
      const [ref, sha, at, wt, subject] = line.split('\x1f');
      const name = ref.slice(HEADS.length);
      return { name, sha, at, subject: subject || '', worktree: wt ? resolve(wt) : null, merged: mergedSet ? mergedSet.has(name) : null };
    })
    .filter(b => b.name.startsWith(prefix || ''))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Branch names under `prefix` whose tip is already contained in `into`.
export async function mergedInto(dir, into, { prefix = '' } = {}) {
  assertRev(into, 'branch');
  const out = await git(dir, ['for-each-ref', `--merged=${into}`, '--format=%(refname)', refPattern(prefix)]);
  return lines(out).map(r => r.slice(HEADS.length)).filter(n => n.startsWith(prefix || ''));
}

// Every checkout of the repository, the main one first:
// [{ path, head, branch, detached, bare, locked, prunable, main }].
export async function worktrees(dir) {
  const out = await git(dir, ['worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: resolve(line.slice(9)), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: !list.length };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return list;
}

// ---------------------------------------------------------------- what changed

// Maps git's status letters to the four the fences know: copies count as new files, type
// changes and unmerged paths as modified.
function statusLetter(code) {
  const c = code[0];
  if (c === 'R') return 'R';
  if (c === 'A' || c === 'C') return 'A';
  if (c === 'D') return 'D';
  return 'M';
}

function untrackedList(dir, pathspecs = []) {
  return git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs]).then(splitZ);
}

// Files that differ from `base`: [{ path, status: 'A'|'M'|'D'|'R', oldPath? }], sorted by path.
// Without `head` it compares the working tree (staged or not) and adds untracked files that are
// not ignored; with `head` it compares the two commits.
export async function changedFiles(dir, base, { includeUntracked = true, head = null } = {}) {
  assertRev(base, 'base');
  if (head) assertRev(head, 'head');
  const out = await git(dir, ['diff', '--name-status', '-M', '-z', '--no-color', base, ...(head ? [head] : []), '--']);
  const tokens = splitZ(out);
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = tokens[++i];
      const path = tokens[++i];
      files.push(code[0] === 'R' ? { path, status: 'R', oldPath } : { path, status: 'A', oldPath });
    } else {
      files.push({ path: tokens[++i], status: statusLetter(code) });
    }
  }
  if (includeUntracked && !head) {
    const known = new Set(files.map(f => f.path));
    for (const path of await untrackedList(dir)) if (!known.has(path)) files.push({ path, status: 'A' });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// "{a,b}" alternatives, which git's glob pathspecs don't know, expanded into separate globs.
export function expandBraces(glob, limit = 64) {
  const m = String(glob).match(/\{([^{}]*)\}/);
  if (!m) return [String(glob)];
  const out = [...new Set(m[1].split(',').flatMap(alt => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length), limit)))];
  if (out.length > limit) throw new GitError(`The glob "${glob}" expands to more than ${limit} patterns.`, { code: 'EINVAL' });
  return out;
}

// Secret files that never go into a diff or a patch, in any folder and with any capitals: .env
// and .env.<name> (templates such as .env.example stay), .npmrc and .sentryclirc. Fences still
// see them, since changedFiles lists every path.
export function isSecretFile(path) {
  const name = String(path).replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (name === '.env' || name === '.npmrc' || name === '.sentryclirc') return true;
  return name.startsWith('.env.') && !/\.(example|sample|template|dist)$/.test(name);
}

// Exclude pathspecs for the given globs (matched case-insensitively, so a secret file can't slip
// through with different capitals).
const globExcludes = globs => globs.flatMap(g => expandBraces(g)).map(g => `:(top,exclude,glob,icase)${g}`);
// A pathspec list: the whole tree minus the excludes (an empty list means everything).
const withTop = excludes => (excludes.length ? [':(top)', ...excludes] : []);

const DIFF_FLAGS = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

// The patch of one untracked file. Exit code 1 only means "there are differences".
function untrackedPatch(dir, path, encoding) {
  return git(dir, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', path], { okCodes: [0, 1], encoding });
}

// fn over items with at most `limit` running at once. After the first failure no new item
// starts, and the error is thrown once the running ones have finished.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { failed = true; throw e; }
    }
  };
  await allDone(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// A patch that `git apply --binary` can replay: the working tree (or `head`) against `base`,
// plus untracked files as new files. Secret files (isSecretFile) are always left out. `exclude`
// leaves out more: a list of globs (git glob rules, plus {a,b}) such as the profile's
// secrets.denyReadGlobs, or a function (path) => true.
// Returns a string, or a Buffer with encoding: 'buffer' (byte-exact, for patch files).
export async function diffText(dir, base, { includeUntracked = true, exclude = [], head = null, encoding = 'utf8' } = {}) {
  assertRev(base, 'base');
  if (head) assertRev(head, 'head');
  if (typeof exclude !== 'function' && !Array.isArray(exclude)) {
    throw new GitError('exclude must be a list of globs or a function.', { code: 'EINVAL' });
  }
  const globs = Array.isArray(exclude) ? globExcludes(exclude.map(String)) : [];
  const drop = p => isSecretFile(p) || (typeof exclude === 'function' && Boolean(exclude(p)));
  const range = [base, ...(head ? [head] : [])];
  // Tracked paths the globs keep but `drop` refuses become literal excludes (both rename sides).
  const tracked = splitZ(await git(dir, ['diff', '--name-only', '--no-renames', '-z', ...range, '--', ...withTop(globs)]));
  const literal = [...new Set(tracked.filter(drop))].map(p => `:(top,exclude,literal)${p}`);
  const parts = [await git(dir, ['diff', ...DIFF_FLAGS, '-M', ...range, '--', ...withTop([...globs, ...literal])], { encoding: 'buffer' })];
  if (includeUntracked && !head) {
    const paths = (await untrackedList(dir, withTop(globs))).filter(p => !drop(p));
    parts.push(...await mapLimit(paths, UNTRACKED_CONCURRENCY, p => untrackedPatch(dir, p, 'buffer')));
  }
  const buf = Buffer.concat(parts);
  return encoding === 'buffer' ? buf : buf.toString('utf8');
}

// Paths that differ between two commits or trees, both sides of a rename listed.
export async function diffNames(dir, a, b) {
  assertRev(a);
  assertRev(b);
  return splitZ(await git(dir, ['diff', '--name-only', '--no-renames', '-z', a, b, '--']));
}

// ---------------------------------------------------------------- reading commits

// A file's content at a commit, or null when the commit has no such file. Throws on an unknown
// commit. opts.encoding 'buffer' returns the raw bytes.
export async function fileAt(dir, sha, path, { encoding = 'utf8' } = {}) {
  assertRev(sha, 'commit');
  const p = cleanPath(path);
  const r = await git(dir, ['cat-file', 'blob', `${sha}:${p}`], { full: true, okCodes: [0, 128], encoding: 'buffer' });
  if (r.code === 0) return encoding === 'buffer' ? r.stdout : r.stdout.toString('utf8');
  const commit = await git(dir, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], { okCodes: [0, 1] });
  if (!commit.trim()) throw new GitError(`git cat-file failed in ${dir}: ${sha} is not a known commit`, { code: 128, stderr: r.stderr, dir });
  return null;
}

// Whether `path` (a file or folder) exists at the commit. An unknown commit gives false.
export async function existsAt(dir, sha, path) {
  assertRev(sha, 'commit');
  const r = await git(dir, ['cat-file', '-e', `${sha}:${cleanPath(path)}`], { full: true, okCodes: [0, 1, 128] });
  return r.code === 0;
}

// Every file path in the commit, or only those under `paths`.
export async function lsFilesAt(dir, sha, { paths = [] } = {}) {
  assertRev(sha, 'commit');
  return splitZ(await git(dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha, '--', ...paths.map(cleanPath)]));
}

function sinceArg(since) {
  if (since === null || since === undefined || since === '') return [];
  const d = since instanceof Date ? since : new Date(typeof since === 'number' ? since : String(since));
  if (Number.isNaN(d.getTime())) throw new GitError(`"${since}" is not a date.`, { code: 'EINVAL' });
  return [`--since=${d.toISOString()}`];
}

// Commits reachable from `ref`, newest first, optionally since a date and only those touching
// `paths`: [{ sha, short, at, authorAt, author, subject }]. Call as logSince(dir, since, opts)
// or logSince(dir, { since, ref, paths, max }).
export async function logSince(dir, since, opts = {}) {
  if (since && typeof since === 'object' && !(since instanceof Date)) { opts = since; since = opts.since; }
  const { ref = 'HEAD', paths = [], max = 1000 } = opts;
  assertRev(ref, 'branch');
  const n = Math.max(1, Math.min(100_000, Number(max) || 1000));
  const out = await git(dir, ['log', '-z', `--max-count=${n}`, '--format=%H%x1f%h%x1f%cI%x1f%aI%x1f%an%x1f%s', ...sinceArg(since), ref, '--', ...paths.map(cleanPath)]);
  return splitZ(out).map(rec => {
    const [sha, short, at, authorAt, author, subject] = rec.replace(/^\n/, '').split('\x1f');
    return { sha, short, at, authorAt, author, subject: subject || '' };
  });
}

// The URL of a remote ('' when there is no such remote).
export async function originUrl(dir, remote = 'origin') {
  if (!/^\w[\w.-]*$/.test(String(remote))) throw new GitError(`"${remote}" is not a remote name.`, { code: 'EINVAL' });
  const r = await git(dir, ['remote', 'get-url', remote], { full: true, okCodes: [0, 2] });
  return r.code === 0 ? r.stdout.trim() : '';
}

// The number of commits in a range ("base..HEAD") or reachable from one revision. Also accepts
// revCount(dir, from, to) for "from..to".
export async function revCount(dir, range, to = null) {
  const spec = to ? `${assertRev(range)}..${assertRev(to)}` : assertRange(range);
  return Number((await git(dir, ['rev-list', '--count', spec, '--'])).trim());
}

// The tree sha of a commit.
export async function commitTree(dir, sha) {
  assertRev(sha, 'commit');
  return (await git(dir, ['rev-parse', '--verify', `${sha}^{tree}`])).trim();
}

// ---------------------------------------------------------------- staging and tree hashes

// True when something (a file, folder or link) exists at the path.
function existsOnDisk(file) {
  return lstat(file).then(() => true, () => false);
}

// `git add -A` for exactly these files (literal names, never globs), in chunks. A path that is
// neither on disk nor in the index is skipped, since git would refuse it and there is nothing
// to record. opts.env can point GIT_INDEX_FILE at another index.
export async function addPaths(dir, files, { env = {} } = {}) {
  const list = [...new Set(files.map(cleanPath))];
  if (!list.length) return [];
  const literal = { ...env, GIT_LITERAL_PATHSPECS: '1' };
  const tracked = new Set();
  for (const part of chunks(list)) {
    for (const p of splitZ(await git(dir, ['ls-files', '-z', '--', ...part], { env: literal }))) tracked.add(p);
  }
  const onDisk = await Promise.all(list.map(p => (tracked.has(p) ? true : existsOnDisk(join(dir, p)))));
  const keep = list.filter((_, i) => onDisk[i]);
  for (const part of chunks(keep)) await git(dir, ['add', '-A', '--', ...part], { env: literal });
  return keep;
}

// The tree sha that committing exactly `files` on top of `base` would record. Built in a
// throwaway index (GIT_INDEX_FILE=tmpIndex: read-tree base, add the files, write-tree), so the
// checkout's real index is never touched. The temporary index is removed afterwards.
export async function treeHash(dir, base, files, tmpIndex = null) {
  assertRev(base, 'base');
  const index = resolve(tmpIndex || join(tmpdir(), `ws-tree-${process.pid}-${randomBytes(4).toString('hex')}.index`));
  await mkdir(dirname(index), { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', base], { env });
    await addPaths(dir, files || [], { env });
    return (await git(dir, ['write-tree'], { env })).trim();
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

// ---------------------------------------------------------------- cockpit summary

const summaryCache = new Map();

export function clearGitCache() {
  summaryCache.clear();
}

async function buildSummary(dir, { prefix, archivePrefix, into }) {
  const status = await statusSummary(dir);
  const [stashes, branches, archived, trees] = await allDone([
    stashSummary(dir, status.branch),
    appBranches(dir, { prefix, into }),
    archivePrefix ? appBranches(dir, { prefix: archivePrefix }) : [],
    worktrees(dir),
  ]);
  return {
    branch: status.branch, sha: status.sha, detached: status.detached, changed: status.changed,
    staged: status.staged, untracked: status.untracked, conflicted: status.conflicted,
    ahead: status.ahead, behind: status.behind, upstream: status.upstream,
    stashes, appBranches: branches, archivedBranches: archived, worktrees: trees,
    at: new Date().toISOString(),
  };
}

// The Git card of the cockpit: { branch, sha, detached, changed, ahead, behind, upstream,
// stashes: {total, onBranch}, appBranches, archivedBranches, worktrees, at }. Cached for
// SUMMARY_TTL_MS per folder and options; callers at the same time share one build.
export function repoSummary(dir, { prefix = 'app/', archivePrefix = 'archive/app/', into = null, now = Date.now() } = {}) {
  const key = JSON.stringify([resolve(dir).toLowerCase(), prefix, archivePrefix, into]);
  const hit = summaryCache.get(key);
  if (hit && now - hit.at < SUMMARY_TTL_MS) return hit.promise;
  const promise = buildSummary(dir, { prefix, archivePrefix, into });
  summaryCache.set(key, { at: now, promise });
  promise.catch(() => { if (summaryCache.get(key)?.promise === promise) summaryCache.delete(key); });
  return promise;
}
