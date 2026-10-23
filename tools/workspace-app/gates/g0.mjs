// G0: the static gate every change passes before the slower checks, and before any review.
//
// Ten rows, all decided by code, never by Claude (SPEC WP5):
//   g0.diffcheck           git diff --check against base, plus the same rules on the untracked
//                          files git doesn't check
//   g0.format              the profile's format command on changed files matching format.glob
//   g0.lint                each workspace's lint commands on its changed files
//   g0.secrets             the secret scan over the added lines of the diff, plus added files with
//                          a secret-shaped name (.env*, .npmrc, .sentryclirc)
//   g0.fences              the fence buckets (gates/fences.mjs)
//   g0.ratchets.tests      no test file loses tests; no new .skip, .only or todo
//   g0.ratchets.allowlist  unguarded procedures stay on the approved allowlist
//   g0.ratchets.metrics    cycles (when the cycle probe's folder has .ts changes) and deep
//                          imports (when its features folder changed) don't go up
//   g0.contract            procedure names, the legacy router and queue names stay
//   g0.tenant              the tenant probes on the changed files: only items that are new
//                          compared with base count, matched by text across all changed files,
//                          so moved code is not new. A new unguarded procedure that isn't
//                          allowlisted, a new raw procedure or a new missing assert fails; the
//                          other probes warn (also when they can't run).
//
// Base versus head without a second checkout: files that changed are read from the base commit
// (git), and unchanged files are the same at base and head. File probes run twice on the changed
// files only (probes.scan with `only`): once as the tree is now, once with a `readFile` that gives
// the base copy of each file. Nothing is written into the tree. The cycle count needs the whole
// tree, so its base value comes from a scan taken at the base commit: `baseScan`, or the scan with
// that sha in the data folder's metrics file. Without one the metric is reported as not compared.
//
// With `head` (a commit), G0 judges base..head instead of the folder: a review of a branch reads
// every head file from git, and the cycle count is not compared.
//
// Dependencies are injected: git (core/git.mjs: git, fileAt, lsFilesAt, and changedFiles and
// diffText when `changed` holds bare paths or no diff is given), runCommand (gates/commands.mjs)
// and probes (probes/scan.mjs: scan). Rows run one at a time; the caller holds the check slot.
// A row that throws becomes an `error` row, which fails G0 (fail closed). Secret-shaped files and
// files matching the profile's secrets.denyReadGlobs are never read and never handed to a
// command, and every text that lands in a row, a log or g0.json is redacted.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { projectPaths, readJson, writeJsonAtomic, writeTextAtomic } from '../core/datadir.mjs';
import { globToRegExp, matchAny } from '../core/glob.mjs';
import { checkFences, fenceSummary, normalizeChanged, normPath, touchedPaths } from './fences.mjs';
import { isSecretFileName, redact, redactDeep, scanDiff, SECRET_FILE_PATTERN, walkDiff } from './secrets.mjs';
import { allowlistItems, allowlistRatchet, itemKey, metricRatchet, testRatchet } from './ratchets.mjs';
import { compareContract, extractContract } from './contract.mjs';

export const G0_ROWS = Object.freeze([
  { id: 'g0.diffcheck', label: 'Whitespace (git diff --check)' },
  { id: 'g0.format', label: "Format with the project's own config" },
  { id: 'g0.lint', label: 'Lint on changed files' },
  { id: 'g0.secrets', label: 'Secret scan of the diff' },
  { id: 'g0.fences', label: 'Scope fence' },
  { id: 'g0.ratchets.tests', label: 'Ratchet: test counts, .skip, .only, todo' },
  { id: 'g0.ratchets.allowlist', label: 'Ratchet: procedure allowlist' },
  { id: 'g0.ratchets.metrics', label: 'Ratchet: cycles and deep imports' },
  { id: 'g0.contract', label: 'Contract: procedures, legacy router, queues' },
  { id: 'g0.tenant', label: 'Tenant probes on changed files' },
]);
// The order rows run in: the quick in-code rows first, then commands, then probe scans.
const RUN_ORDER = ['g0.secrets', 'g0.fences', 'g0.diffcheck', 'g0.ratchets.tests', 'g0.contract',
  'g0.format', 'g0.lint', 'g0.tenant', 'g0.ratchets.allowlist', 'g0.ratchets.metrics'];
// Probe ids from the spec; a profile without one of them simply doesn't run it.
export const TENANT_PROBES = Object.freeze([
  { id: 'procedures', fails: true },
  { id: 'missingAssert', fails: true },
  { id: 'rawProcedure', fails: true },
  { id: 'unscopedLookups', fails: false },
  { id: 'publicShopId', fails: false },
]);
// Never read, never put in a diff G0 builds, never handed to a formatter or linter.
export const SECRET_GLOBS = Object.freeze(['**/.env', '**/.env.*', '**/.npmrc', '**/.sentryclirc']);
const TS_RE = /\.[cm]?tsx?$/;
const LIST_MAX = 50;
const REASON_ITEMS = 3;
const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,249}$/;

// ---------------------------------------------------------------- small helpers

const short = sha => String(sha || '').slice(0, 7);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstFew = (items, n = REASON_ITEMS) => items.slice(0, n).join('; ') + (items.length > n ? `; and ${items.length - n} more` : '');
const unique = list => [...new Set(list)];

// A commit or ref G0 may hand to git: no option-like start, no spaces, no "..".
export function checkRev(rev, what = 'commit') {
  const s = String(rev ?? '');
  if (!REV_RE.test(s) || s.includes('..')) throw new Error(`"${s.slice(0, 80)}" is not a valid ${what}.`);
  return s;
}

// A repo-relative path that is safe to join under the tree, or null.
function safeRel(p) {
  const s = normPath(p);
  if (!s || /^[A-Za-z]:/.test(s) || s.split('/').some(seg => seg === '..' || seg === '')) return null;
  return s;
}

function isInside(child, root) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// "{a,b}" alternatives, which git's glob pathspecs don't know, as separate globs.
export function expandBraces(glob, limit = 64) {
  const m = String(glob).match(/\{([^{}]*)\}/);
  if (!m) return [String(glob)];
  const out = unique(m[1].split(',').flatMap(alt => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length), limit)));
  if (out.length > limit) throw new Error(`The glob "${glob}" expands to more than ${limit} patterns.`);
  return out;
}

// The secret-file globs: the built-in ones plus the profile's denyReadGlobs.
function secretGlobs(profile) {
  const extra = Array.isArray(profile?.secrets?.denyReadGlobs) ? profile.secrets.denyReadGlobs : [];
  return unique([...SECRET_GLOBS, ...extra.map(String).filter(Boolean)]);
}

// The workspace that owns a path: the one with the longest matching dir ("." owns everything).
function ownerWorkspace(profile, path) {
  let best = null;
  for (const ws of profile?.workspaces || []) {
    const dir = normPath(ws?.dir || '.');
    const len = dir === '' || dir === '.' ? 0 : dir.length;
    if (len && path !== dir && !path.startsWith(`${dir}/`)) continue;
    if (!best || len > best.len) best = { ws, len };
  }
  return best ? best.ws : null;
}

// lint-staged matches a glob without "/" against the file name, and one with "/" against the path.
export function formatGlobMatches(glob, path) {
  if (!glob) return false;
  const p = normPath(path);
  return globToRegExp(glob).test(glob.includes('/') ? p : p.split('/').pop());
}

// Whether a lint command takes the file: under its cwd and roots, and matching its pattern.
function lintTakes(cmd, path) {
  const cwd = normPath(cmd.cwd || '.');
  const inCwd = cwd === '' || cwd === '.' ? path : path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : null;
  if (inCwd === null) return false;
  const roots = cmd.files?.roots;
  if (Array.isArray(roots) && roots.length) {
    const ok = roots.some(r => { const root = normPath(r); return root === '' || root === '.' || inCwd === root || inCwd.startsWith(`${root}/`); });
    if (!ok) return false;
  }
  if (cmd.files?.pattern) return new RegExp(cmd.files.pattern).test(path);
  return true;
}

// Whether a changed path is in a probe's scope.
function inProbeScope(probe, path) {
  if (probe.kind === 'cycles') {
    const cwd = normPath(probe.cwd || '.');
    return TS_RE.test(path) && (cwd === '' || cwd === '.' || path.startsWith(`${cwd}/`));
  }
  if (probe.kind === 'deepImports' || probe.kind === 'publicTs') {
    const dir = normPath(probe.featuresDir || '');
    return Boolean(dir) && path.startsWith(`${dir}/`);
  }
  return matchAny(probe.files || [], path) && !matchAny(probe.exclude || [], path);
}

// a minus b, counting duplicates. Items are strings, or {key} objects compared by key.
function minus(a, b) {
  const keyOf = x => (x && typeof x === 'object' ? x.key : x);
  const left = new Map();
  for (const x of b) left.set(keyOf(x), (left.get(keyOf(x)) || 0) + 1);
  return a.filter(x => { const n = left.get(keyOf(x)) || 0; if (n > 0) { left.set(keyOf(x), n - 1); return false; } return true; });
}

// Calls git and gives {code, stdout, stderr}; exit codes in okCodes don't throw.
async function gitFull(git, dir, args, okCodes, signal) {
  const run = typeof git === 'function' ? git : git?.git;
  if (typeof run !== 'function') throw new Error('G0 was started without git.');
  const r = await run(dir, args, { okCodes, full: true, signal });
  if (typeof r === 'string') return { code: 0, stdout: r, stderr: '' };
  return { code: r?.code ?? 0, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') };
}

function needGit(ctx, name) {
  if (typeof ctx.git?.[name] !== 'function') throw new Error(`G0 needs git.${name}, and the git it was given has none.`);
  return ctx.git[name];
}

// Reads a file inside the tree as text. Links are never followed, and a path that resolves
// outside the tree (through a junction above it) counts as missing.
async function readTreeFile(ctx, rel) {
  const abs = join(ctx.tree, ...rel.split('/'));
  try {
    const st = await lstat(abs);
    if (!st.isFile()) return null;
    if (!isInside(await realpath(abs), ctx.realTree)) return null;
    return await readFile(abs, 'utf8');
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(e?.code)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- the run context

// The change list as [{path, status, oldPath}]. Callers sometimes pass bare paths (runChecks
// does); their status comes from git.changedFiles, or else from what exists at base and now.
async function resolveChanged(ctx, changed) {
  const given = Array.isArray(changed) ? changed : [];
  const full = given.filter(c => c && typeof c === 'object' && c.path && c.status);
  const bare = unique(given.map(c => (typeof c === 'string' ? c : c && c.path && !c.status ? c.path : null)).filter(Boolean).map(normPath));
  const out = normalizeChanged(full);
  if (!bare.length) return out;
  const have = new Set(out.flatMap(c => [c.path, c.oldPath].filter(Boolean)));
  if (typeof ctx.git?.changedFiles === 'function') {
    const known = normalizeChanged(await ctx.git.changedFiles(ctx.tree, ctx.baseSha, ctx.head ? { head: ctx.head } : { includeUntracked: true }));
    const want = new Set(bare);
    for (const c of known) {
      if (have.has(c.path) || !(want.has(c.path) || (c.oldPath && want.has(c.oldPath)))) continue;
      out.push(c);
      have.add(c.path);
      if (c.oldPath) have.add(c.oldPath);
    }
  }
  const atBase = new Set(await ctx.baseFiles());
  for (const p of bare) {
    if (have.has(p)) continue;
    const before = atBase.has(p);
    const now = await ctx.existsHead(p);
    if (!before && !now) continue;
    out.push({ path: p, status: before ? (now ? 'M' : 'D') : 'A' });
    have.add(p);
  }
  return out;
}

// The diff text: the given one, or one built with git.diffText (secret files left out).
async function resolveDiff(ctx, diff) {
  if (typeof diff === 'string') return { text: diff };
  if (Buffer.isBuffer(diff)) return { text: diff.toString('utf8') };
  if (typeof ctx.git?.diffText !== 'function') return { error: 'No diff was given, so the secret scan could not run.' };
  try {
    const opts = ctx.head ? { head: ctx.head, includeUntracked: false } : { includeUntracked: true };
    const text = await ctx.git.diffText(ctx.tree, ctx.baseSha, { ...opts, exclude: secretGlobs(ctx.profile) });
    return { text: Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '') };
  } catch (e) {
    return { error: `The diff could not be built, so the secret scan could not run: ${e?.message || e}` };
  }
}

// The approved allowlist: the one given, else <dataDir>/profiles/<project>.allowlist.json.
// Returns {list (array or null when none is set up), known, error}.
async function resolveAllowlist(opts, project) {
  if (opts.allowlist !== undefined && opts.allowlist !== null) {
    const list = allowlistItems(opts.allowlist);
    return list ? { list, known: true } : { list: null, known: true, error: 'The allowlist G0 was given holds no list.' };
  }
  if (!opts.dataDir || !project) return { list: null, known: false };
  try {
    const file = projectPaths(opts.dataDir, project).allowlist;
    const doc = await readJson(file, null);
    if (doc === null) return { list: null, known: true };
    const list = allowlistItems(doc);
    return list ? { list, known: true } : { list: null, known: true, error: `${file} holds no list.` };
  } catch (e) {
    return { list: null, known: true, error: `The allowlist could not be read: ${e?.message || e}` };
  }
}

// Shared, memoized file access for one G0 run.
async function prepare(opts) {
  const profile = opts.profile || {};
  const ctx = {
    profile, tree: resolve(opts.tree), baseSha: checkRev(opts.baseSha, 'base commit'),
    head: opts.head ? checkRev(opts.head, 'head commit') : null,
    plan: opts.plan || null, ticked: opts.ticked || [], allowances: opts.allowances || [], pipeline: opts.pipeline || '',
    gateDir: opts.gateDir || null, git: opts.git, runCommand: opts.runCommand, probes: opts.probes, signal: opts.signal,
    proc: opts.proc, baseScan: opts.baseScan || null, dataDir: opts.dataDir || null,
    project: opts.project || profile.project || null,
    allow: Array.isArray(profile.secrets?.allowValues) ? profile.secrets.allowValues : [],
    memo: new Map(), secretsFound: 0, fence: null,
  };
  ctx.once = (key, fn) => {
    if (!ctx.memo.has(key)) ctx.memo.set(key, fn());
    return ctx.memo.get(key);
  };
  // Secret files by name, plus the profile's denyReadGlobs: never read, never handed to a command.
  const denyGlobs = secretGlobs(profile);
  ctx.isDenied = p => isSecretFileName(p) || matchAny(denyGlobs, normPath(p), { nocase: true });
  try {
    ctx.realTree = await realpath(ctx.tree);
  } catch {
    throw new Error(`The tree ${ctx.tree} does not exist.`);
  }
  ctx.baseFiles = () => ctx.once('baseFiles', async () => (await needGit(ctx, 'lsFilesAt')(ctx.tree, ctx.baseSha)).map(normPath));
  ctx.readBase = async p => {
    const rel = safeRel(p);
    if (!rel || ctx.isDenied(rel)) return null;
    return needGit(ctx, 'fileAt')(ctx.tree, ctx.baseSha, rel);
  };
  ctx.readHead = async p => {
    const rel = safeRel(p);
    if (!rel || ctx.isDenied(rel)) return null;
    return ctx.head ? needGit(ctx, 'fileAt')(ctx.tree, ctx.head, rel) : readTreeFile(ctx, rel);
  };
  ctx.existsHead = async p => {
    const rel = safeRel(p);
    if (!rel) return false;
    if (ctx.head) return (await ctx.headFiles()).includes(rel);
    try { return (await lstat(join(ctx.tree, ...rel.split('/')))).isFile(); } catch { return false; }
  };
  ctx.headFiles = () => ctx.once('headFiles', async () => {
    if (ctx.head) return (await needGit(ctx, 'lsFilesAt')(ctx.tree, ctx.head)).map(normPath).sort();
    const gone = new Set(ctx.touched.filter(t => t.deleted).map(t => t.path));
    const files = new Set((await ctx.baseFiles()).filter(p => !gone.has(p)));
    for (const p of ctx.live) files.add(p);
    return [...files].sort();
  });

  ctx.list = await resolveChanged(ctx, opts.changed);
  ctx.touched = touchedPaths(ctx.list);
  ctx.touchedSet = new Set(ctx.touched.map(t => t.path));
  ctx.live = ctx.list.filter(c => c.status !== 'D').map(c => c.path);
  // Unchanged files are identical at base and head, so they are read from the head side.
  ctx.readBaseFast = p => (ctx.touchedSet.has(normPath(p)) ? ctx.readBase(p) : ctx.readHead(p));
  const diff = await resolveDiff(ctx, opts.diff);
  ctx.diffText = diff.text ?? null;
  ctx.diffError = diff.error || '';
  ctx.allowlist = await resolveAllowlist(opts, ctx.project);
  return ctx;
}

// ---------------------------------------------------------------- probe scans

// The probes of the profile with the given ids, in that order.
function probesById(profile, ids) {
  const all = Array.isArray(profile?.probes) ? profile.probes : [];
  return ids.map(id => all.find(p => p && p.id === id)).filter(Boolean);
}

// The probe that lists unguarded procedures: "procedures", or the first routerKeys probe
// without a filter.
function proceduresProbe(profile) {
  const all = Array.isArray(profile?.probes) ? profile.probes : [];
  return all.find(p => p && p.id === 'procedures') || all.find(p => p && p.kind === 'routerKeys' && !p.filter) || null;
}

const listsProcedures = def => def.kind === 'routerKeys' && !def.filter;

// One probes.scan over `only`, reading every file through `reader`. A scanner that never calls
// the reader would compare head with head, so that is an error (fail closed).
async function scanWith(ctx, { reader, only, ids }) {
  if (!only.length) return { values: {}, details: {}, errors: {}, ran: false };
  if (typeof ctx.probes?.scan !== 'function') throw new Error('G0 was started without the probe scanner.');
  let reads = 0;
  const readFileFn = async rel => { reads++; return reader(rel); };
  const r = await ctx.probes.scan({ profile: ctx.profile, tree: ctx.tree, only, ids, readFile: readFileFn, signal: ctx.signal, proc: ctx.proc });
  const out = { values: r?.values || {}, details: r?.details || {}, errors: r?.errors || {}, ran: true };
  if (!reads && !Object.keys(out.errors).length) {
    throw new Error('The probe scanner did not read the files through G0, so base and head could not be told apart.');
  }
  return out;
}

// File probes (tenant probes, the procedures probe and deep imports) on the changed files, at
// head and at base. One scan each way serves the tenant, allowlist and metrics rows. A side with
// no files in scope is not scanned (`ran: false`): it has no items.
function subsetScans(ctx) {
  return ctx.once('subset', async () => {
    const tenant = probesById(ctx.profile, TENANT_PROBES.map(t => t.id));
    const deep = (ctx.profile?.probes || []).filter(p => p && p.kind === 'deepImports');
    const procs = proceduresProbe(ctx.profile);
    const defs = unique([...tenant, ...(procs ? [procs] : []), ...deep]);
    const inScope = p => defs.some(d => inProbeScope(d, p));
    const headOnly = ctx.live.filter(inScope);
    const baseOnly = unique(ctx.touched.filter(t => !t.isNew).map(t => t.path).filter(inScope));
    const ids = defs.map(d => d.id);
    const head = await scanWith(ctx, { reader: ctx.readHead, only: headOnly, ids });
    const base = await scanWith(ctx, { reader: ctx.readBase, only: baseOnly, ids });
    return { head, base, headOnly, baseOnly };
  });
}

// The comparable items one probe found, as [{key, show}]: unguarded procedures by id (an
// unfiltered routerKeys probe), the rest by their trimmed text. The path is left out of the key,
// so code moved from one changed file to another (with or without a git rename) is not new;
// a missing assert's text already names its procedure ("teams.kick: memberProcedure"). `show`
// is "path::text", for the row. null when the probe ran but gave no procedure list.
function probeItems(scan, def) {
  if (!scan.ran) return [];
  if (listsProcedures(def)) {
    const list = scan.values?.[def.id]?.nonShop;
    return Array.isArray(list) ? list.map(itemKey).map(k => ({ key: k, show: k })) : null;
  }
  const d = scan.details?.[def.id];
  if (!Array.isArray(d)) return [];
  return d.map(x => {
    if (typeof x === 'string') return { key: x, show: x };
    const text = String(x?.text ?? '').trim();
    return { key: text, show: `${normPath(x?.path)}::${text}` };
  });
}

// Unguarded procedures that are new in this change (head subset minus base subset).
async function newProcedures(ctx, def) {
  const s = await subsetScans(ctx);
  return new Set(minus(probeItems(s.head, def) || [], probeItems(s.base, def) || []).map(x => x.key));
}

const sameSha = (a, b) => {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

// Probe values at the base commit: `baseScan` when given, else the newest scan recorded at that
// sha in <dataDir>/metrics/<project>.json. {values, source}; empty values when there is none.
function baseValues(ctx) {
  return ctx.once('baseValues', async () => {
    const given = ctx.baseScan;
    if (given && typeof given === 'object') {
      return { values: given.values && typeof given.values === 'object' ? given.values : given, source: 'the base scan' };
    }
    if (!ctx.dataDir || !ctx.project) return { values: {}, source: '' };
    try {
      const doc = await readJson(projectPaths(ctx.dataDir, ctx.project).metrics, null);
      const scans = Array.isArray(doc?.scans) ? doc.scans : [];
      const hit = [...scans].reverse().find(s => s && s.values && sameSha(s.sha, ctx.baseSha));
      return hit ? { values: hit.values, source: `the scan at ${short(hit.sha)}` } : { values: {}, source: '' };
    } catch {
      return { values: {}, source: '' };
    }
  });
}

// ---------------------------------------------------------------- the rows

const result = (status, reason = '', extra = {}) => ({ status, reason, ...extra });

// The rules git diff --check applies by default, for new files git doesn't see (untracked).
function whitespaceProblems(diff) {
  const out = [];
  const last = new Map();
  walkDiff(diff, {
    onAdded(file, line, raw) {
      if (!file?.added || !file.path) return;
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;   // CR at the end is a line ending
      if (/[ \t]$/.test(text)) out.push({ path: file.path, line, problem: 'trailing whitespace' });
      if (/^[ \t]* \t/.test(text)) out.push({ path: file.path, line, problem: 'space before tab in indent' });
      if (/^(?:<{7}|>{7})(?: |$)|^={7}$/.test(text)) out.push({ path: file.path, line, problem: 'leftover conflict marker' });
      last.set(file.path, { line, blank: text.trim() === '' });
    },
    onFile(file) {
      const l = file?.added && last.get(file.path);
      if (l && l.blank) out.push({ path: file.path, line: l.line, problem: 'new blank line at EOF' });
    },
  });
  return out;
}

async function rowDiffcheck(ctx) {
  const specs = [':(top)', ...unique(secretGlobs(ctx.profile).flatMap(g => expandBraces(g))).map(g => `:(top,exclude,glob,icase)${g}`)];
  const revs = ctx.head ? [ctx.baseSha, ctx.head] : [ctx.baseSha];
  const r = await gitFull(ctx.git, ctx.tree, ['diff', '--check', '--no-color', ...revs, '--', ...specs], [0, 1, 2], ctx.signal);
  const problems = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^([^+\- ].*?):(\d+): (.+?)\.?$/);
    if (m && !ctx.isDenied(m[1])) problems.push({ path: m[1], line: Number(m[2]), problem: m[3] });
  }
  if (r.code !== 0 && !problems.length) throw new Error(`git diff --check failed: ${redact(r.stderr.trim() || `exit code ${r.code}`, { allow: ctx.allow })}`);
  const seen = new Set(problems.map(p => `${p.path}:${p.line}:${p.problem}`));
  // The same rules for the files git didn't check: in a folder, the untracked ones. Files git
  // checked are skipped, because git puts "new blank line at EOF" on the first trailing blank
  // line and this check on the last, so the same problem would be counted twice. A commit
  // (head) has no untracked files.
  if (ctx.diffText && !ctx.head) {
    const names = await gitFull(ctx.git, ctx.tree, ['diff', '--name-only', '--no-renames', '-z', ctx.baseSha, '--'], [0], ctx.signal);
    const checked = new Set(names.stdout.split('\0').filter(Boolean).map(normPath));
    for (const p of whitespaceProblems(ctx.diffText)) {
      if (checked.has(p.path) || ctx.isDenied(p.path) || seen.has(`${p.path}:${p.line}:${p.problem}`)) continue;
      seen.add(`${p.path}:${p.line}:${p.problem}`);
      problems.push(p);
    }
  }
  const log = problems.map(p => `${p.path}:${p.line}: ${p.problem}`).join('\n');
  const command = `git diff --check ${revs.map(short).join(' ')}`;
  if (!problems.length) return result('pass', '', { command, log, details: { problems: [] } });
  return result('fail', `${plural(problems.length, 'whitespace problem')}: ${firstFew(problems.map(p => `${p.path}:${p.line} ${p.problem}`))}.`,
    { command, log, details: { problems: problems.slice(0, LIST_MAX) } });
}

// Maps a runCommand result to a row status.
function commandStatus(r) {
  const s = String(r?.status || '');
  if (s === 'pass' || s === 'fail' || s === 'skip') return s;
  if (!s && r?.exitCode === 0) return 'pass';
  return 'error';
}

function needRunCommand(ctx) {
  if (typeof ctx.runCommand !== 'function') throw new Error('G0 was started without runCommand.');
  return ctx.runCommand;
}

async function rowFormat(ctx) {
  const fmt = ctx.profile?.format;
  if (!fmt?.cmd) return result('skip', 'Not run: the profile has no format command.');
  if (!ctx.profile.commands?.[fmt.cmd]) throw new Error(`format.cmd "${fmt.cmd}" is not one of the profile's commands.`);
  if (ctx.head) return result('skip', 'Not run: the change is a commit, and the formatter only reads the folder.');
  const files = ctx.live.filter(p => !ctx.isDenied(p) && formatGlobMatches(fmt.glob, p));
  if (!files.length) return result('skip', `Not run: no changed file matches ${fmt.glob}.`);
  // checkId names the log (g0.format.log), so a G2 check of the same command can't overwrite it.
  const r = await needRunCommand(ctx)({ profile: ctx.profile, commandId: fmt.cmd, checkId: 'g0.format', tree: ctx.tree, files, gateDir: ctx.gateDir, signal: ctx.signal, proc: ctx.proc });
  const status = commandStatus(r);
  const unformatted = (r?.errors || []).map(e => (typeof e === 'string' ? e : e?.file || itemKey(e)));
  const reason = status === 'pass' ? ''
    : status === 'skip' ? (r?.reason || 'Not run.')
    : status === 'fail' ? (unformatted.length
      ? `${plural(unformatted.length, 'file is', 'files are')} not formatted: ${firstFew(unformatted)}.`
      : `The formatter would change some of the ${plural(files.length, 'changed file')}; see the log.`)
    : `The format command did not finish (${r?.reason || r?.status || `exit code ${r?.exitCode}`}).`;
  return result(status, reason, { command: `${fmt.cmd} on ${plural(files.length, 'file')}`, logFile: r?.log, runMs: r?.durationMs, details: { files: files.slice(0, LIST_MAX), exitCode: r?.exitCode ?? null } });
}

async function rowLint(ctx) {
  if (ctx.head) return result('skip', 'Not run: the change is a commit, and the linters only read the folder.');
  const byCmd = new Map();
  for (const p of ctx.live) {
    if (ctx.isDenied(p)) continue;
    const ws = ownerWorkspace(ctx.profile, p);
    for (const id of ws?.lint || []) {
      const cmd = ctx.profile.commands?.[id];
      if (!cmd) throw new Error(`Workspace ${ws.id} names the lint command "${id}", which the profile doesn't have.`);
      if (!lintTakes(cmd, p)) continue;
      if (!byCmd.has(id)) byCmd.set(id, []);
      byCmd.get(id).push(p);
    }
  }
  if (!byCmd.size) return result('skip', 'Not run: no changed file is in a lint command\'s scope.');
  const run = needRunCommand(ctx);
  const per = [];
  for (const [id, files] of byCmd) {
    if (ctx.signal?.aborted) break;
    // G2's lint check has the id of the command ("lint:web"), so G0 names its own log g0.lint.lint-web.log.
    const r = await run({ profile: ctx.profile, commandId: id, checkId: `g0.lint.${id}`, tree: ctx.tree, files, gateDir: ctx.gateDir, signal: ctx.signal, proc: ctx.proc });
    per.push({
      id, files: files.length, status: commandStatus(r), exitCode: r?.exitCode ?? null, reason: r?.reason || '',
      errors: (r?.errors || []).slice(0, LIST_MAX).map(e => redact(typeof e === 'string' ? e : itemKey(e), { allow: ctx.allow })),
      log: r?.log || null, durationMs: r?.durationMs || 0,
    });
  }
  const ran = per.filter(x => x.status !== 'skip');
  const status = per.some(x => x.status === 'error') ? 'error' : per.some(x => x.status === 'fail') ? 'fail' : ran.length ? 'pass' : 'skip';
  const bad = per.filter(x => x.status === 'fail' || x.status === 'error');
  const reason = status === 'skip' ? (per[0]?.reason || 'Not run.')
    : !bad.length ? ''
    : `${firstFew(bad.map(x => (x.status === 'error'
      ? `${x.id} did not finish${x.reason ? ` (${x.reason})` : ''}`
      : `${x.id}: ${x.errors.length ? plural(x.errors.length, 'error') : 'errors'} in ${plural(x.files, 'file')}${x.errors[0] ? ` (${x.errors[0]})` : ''}`)))}.`;
  return result(status, reason, {
    command: per.map(x => `${x.id} on ${plural(x.files, 'file')}`).join(', '),
    logFile: per.length === 1 ? per[0].log : null,
    runMs: per.reduce((s, x) => s + x.durationMs, 0),
    details: { commands: per },
  });
}

async function rowSecrets(ctx) {
  if (ctx.diffError) throw new Error(ctx.diffError);
  const found = scanDiff(ctx.diffText || '', { allow: ctx.allow });
  // G0's own diff leaves secret files out, so their names come from the change list.
  const flagged = new Set(found.filter(f => f.pattern === SECRET_FILE_PATTERN).map(f => f.path));
  for (const c of ctx.list) {
    if ((c.status === 'A' || c.status === 'R') && ctx.isDenied(c.path) && !flagged.has(c.path)) {
      found.push({ pattern: SECRET_FILE_PATTERN, path: c.path, line: 0, preview: 'a file with a secret-shaped name was added' });
      flagged.add(c.path);
    }
  }
  ctx.secretsFound = found.length;
  const command = 'secret scan of the added lines';
  const log = found.map(f => `${f.path}:${f.line}: ${f.pattern}: ${f.preview}`).join('\n');
  if (!found.length) return result('pass', '', { command, log, details: { found: [] } });
  return result('fail', `${plural(found.length, 'secret-shaped value')} in the change: ${firstFew(found.map(f => `${f.pattern} in ${f.path}${f.line ? `:${f.line}` : ''}`))}. Remove ${found.length === 1 ? 'it' : 'them'}; nothing is committed while a secret is in the diff.`,
    { command, log, details: { found: found.slice(0, LIST_MAX) } });
}

async function rowFences(ctx) {
  let existsAtBase = null;
  if (ctx.touched.some(t => t.isNew)) {
    const set = new Set((await ctx.baseFiles()).map(p => p.toLowerCase()));
    existsAtBase = p => set.has(normPath(p).toLowerCase());
  }
  const fence = checkFences({ profile: ctx.profile, changed: ctx.list, plan: ctx.plan, ticked: ctx.ticked, allowances: ctx.allowances, existsAtBase, pipeline: ctx.pipeline });
  ctx.fence = fence;
  const summary = fenceSummary(fence);
  const status = fence.readOnly
    ? (fence.forbidden.length || fence.mustTick.length ? 'warn' : 'pass')
    : fence.hardFail ? 'fail' : fence.needsYou || fence.allowedByUser.length ? 'warn' : 'pass';
  const reason = status === 'pass' ? '' : `${summary}. ${firstFew(fence.messages)}`.trim();
  return result(status, reason, { command: 'fences from the profile', log: fence.messages.join('\n'), details: { summary, scope: fence.scope } });
}

async function rowTestRatchet(ctx) {
  const r = await testRatchet({ changed: ctx.list, readAtBase: ctx.readBase, readAtHead: ctx.readHead, testPattern: ctx.profile?.fences?.testPattern });
  if (!r.files.length) return result('skip', 'Not run: no test files changed.');
  const items = [
    ...r.lost.map(l => `${l.path} lost ${plural(l.before - l.after, 'test')} (${l.before} to ${l.after})`),
    ...r.newSkips.map(s => `new ${s.kind} in ${s.path}:${s.line}`),
  ];
  return result(r.ok ? 'pass' : 'fail', r.ok ? '' : `${firstFew(items)}.`,
    { command: `test counts in ${plural(r.files.length, 'test file')} at base and head`, log: items.join('\n'), details: r });
}

async function rowContract(ctx) {
  const c = ctx.profile?.contract;
  if (!c) return result('skip', 'Not run: the profile has no contract section.');
  const queueFiles = (c.queues || []).map(q => normPath(q.file));
  const legacy = c.legacyRouter ? normPath(c.legacyRouter) : null;
  const relevant = p => matchAny(c.routerFiles || [], p) || p === legacy || queueFiles.includes(p);
  if (!ctx.touched.some(t => relevant(t.path))) return result('skip', 'Not run: no router or queue file changed.');
  const listFrom = files => globs => files.filter(p => matchAny(globs, p));
  const base = await extractContract(ctx.profile, { read: ctx.readBaseFast, list: listFrom(await ctx.baseFiles()) });
  const head = await extractContract(ctx.profile, { read: ctx.readHead, list: listFrom(await ctx.headFiles()) });
  const cmp = compareContract(base, head, { pipeline: ctx.pipeline, plan: ctx.plan });
  const counts = `${base.procedures.length} to ${head.procedures.length} procedures, ${base.legacy.length} to ${head.legacy.length} legacy keys, ${base.queues.length} to ${head.queues.length} queues`;
  return result(cmp.status, cmp.status === 'pass' ? (cmp.added.length ? cmp.messages.join(' ') : 'Unchanged') : cmp.messages.join(' '),
    { command: 'router keys, legacy router and queue names at base and head', log: [counts, ...cmp.messages, ...head.problems].join('\n'),
      details: { removed: cmp.removed, added: cmp.added, problems: unique([...base.problems, ...head.problems]), counts } });
}

// Why a new unguarded procedure isn't covered, for the tenant row's reason.
function allowlistNote(ctx) {
  if (ctx.allowlist.error) return ` (${ctx.allowlist.error})`;
  if (!ctx.allowlist.known) return ' (G0 was not given the allowlist)';
  if (!ctx.allowlist.list) return " (no allowlist is set up yet: the project's Architecture tab, Rebuild allowlist)";
  return ' (not on the allowlist)';
}

async function rowTenant(ctx) {
  const defs = probesById(ctx.profile, TENANT_PROBES.map(t => t.id));
  if (!defs.length) return result('skip', 'Not run: the profile has no tenant probes.');
  if (!ctx.touched.some(t => defs.some(d => inProbeScope(d, t.path)))) return result('skip', 'Not run: no changed file is in the tenant probes\' scope.');
  const s = await subsetScans(ctx);
  const allowed = new Set((ctx.allowlist.list || []).map(itemKey));
  const fails = [], warns = [], errors = [];
  const found = {};
  for (const def of defs) {
    const policy = TENANT_PROBES.find(t => t.id === def.id);
    const label = def.label || def.id;
    // A probe that can't run: a failing-policy probe is an error (fail closed); a warning-policy
    // probe could never fail G0, so its failure is a warning that says it was not checked.
    const broken = text => (policy.fails ? errors : warns).push(policy.fails ? text : `${text}; not checked`);
    const err = s.head.errors[def.id] || s.base.errors[def.id];
    if (err) { broken(`${label}: the probe failed (${redact(String(err), { allow: ctx.allow })})`); continue; }
    const head = probeItems(s.head, def), base = probeItems(s.base, def);
    if (head === null || base === null) { broken(`${label}: the probe gave no list of unguarded procedures`); continue; }
    let fresh = minus(head, base);
    if (listsProcedures(def)) fresh = fresh.filter(x => !allowed.has(x.key));
    if (!fresh.length) continue;
    found[def.id] = fresh.slice(0, LIST_MAX).map(x => redact(x.show, { allow: ctx.allow }));
    const note = listsProcedures(def) ? allowlistNote(ctx) : '';
    const text = `${plural(fresh.length, 'new item')} in ${label}${note}: ${found[def.id].slice(0, REASON_ITEMS).join(', ')}`;
    (policy.fails ? fails : warns).push(text);
  }
  const status = fails.length ? 'fail' : errors.length ? 'error' : warns.length ? 'warn' : 'pass';
  const all = [...fails, ...errors, ...warns];
  return result(status, all.length ? `${all.join('; ')}.` : '', {
    command: `${defs.map(d => d.id).join(', ')} on ${plural(s.headOnly.length, 'changed file')}`,
    log: all.join('\n'),
    details: { new: found, files: s.headOnly.length, baseFiles: s.baseOnly.length },
  });
}

async function rowAllowlist(ctx) {
  const def = proceduresProbe(ctx.profile);
  if (!def) return result('skip', 'Not run: the profile has no procedures probe.');
  if (!ctx.touched.some(t => inProbeScope(def, t.path))) return result('skip', 'Not run: no router file changed.');
  if (ctx.allowlist.error) throw new Error(ctx.allowlist.error);
  if (!ctx.allowlist.known) return result('skip', 'Not run: G0 was not given the allowlist.');
  if (!ctx.allowlist.list) return result('skip', "Not run: the procedure allowlist is not set up yet (the project's Architecture tab, Rebuild allowlist).");
  const only = (await ctx.headFiles()).filter(p => inProbeScope(def, p));
  const scan = await scanWith(ctx, { reader: ctx.readHead, only, ids: [def.id] });
  if (scan.errors[def.id]) throw new Error(`The ${def.id} probe failed: ${scan.errors[def.id]}`);
  const nonShopNow = scan.ran ? scan.values?.[def.id]?.nonShop : [];
  if (!Array.isArray(nonShopNow)) throw new Error(`The ${def.id} probe gave no list of unguarded procedures.`);
  const r = allowlistRatchet({ nonShopNow, allowlist: ctx.allowlist.list });
  const fresh = await newProcedures(ctx, def);
  const addedNew = r.added.filter(k => fresh.has(k));
  const addedOld = r.added.filter(k => !fresh.has(k));
  const parts = [];
  if (addedNew.length) parts.push(`${plural(addedNew.length, 'new procedure is', 'new procedures are')} not on the allowlist: ${firstFew(addedNew)}`);
  if (addedOld.length) parts.push(`${plural(addedOld.length, 'procedure was', 'procedures were')} already off the allowlist at base; rebuild it on the project's Architecture tab`);
  if (r.removed.length) parts.push(`the allowlist can shrink by ${r.removed.length}`);
  const status = addedNew.length ? 'fail' : addedOld.length ? 'warn' : 'pass';
  return result(status, parts.length ? `${parts.join('; ')}.` : '', {
    command: `${def.id} probe against the allowlist`, log: parts.join('\n'),
    details: { addedNew, addedOld, removed: r.removed, total: nonShopNow.length },
  });
}

// A metric whose probe definition changed between the base scan and now can't be compared.
function sameRule(base, head, id) {
  const a = base?.[id]?.rule, b = head?.[id]?.rule;
  return !a || !b || a === b;
}

async function rowMetrics(ctx) {
  const defs = (ctx.profile?.probes || []).filter(p => p && (p.kind === 'cycles' || p.kind === 'deepImports'));
  if (!defs.length) return result('skip', 'Not run: the profile has no cycle or deep-import probe.');
  const active = defs.filter(d => ctx.touched.some(t => inProbeScope(d, t.path)));
  if (!active.length) return result('skip', 'Not run: nothing changed where cycles or deep imports are counted.');
  const rows = [], problems = [];
  for (const d of active) {
    const label = d.label || d.id;
    if (d.kind === 'deepImports') {
      const s = await subsetScans(ctx);
      const err = s.head.errors[d.id] || s.base.errors[d.id];
      if (err) { problems.push(`${label}: the probe failed (${err})`); continue; }
      // A side with no files in this probe's scope has no deep imports there.
      const zero = { [d.id]: { value: 0 } };
      const base = s.baseOnly.some(p => inProbeScope(d, p)) ? s.base.values : zero;
      const head = s.headOnly.some(p => inProbeScope(d, p)) ? s.head.values : zero;
      rows.push(...metricRatchet({ base, head, metrics: [d.id] }).rows);
      continue;
    }
    if (ctx.head) { rows.push({ metric: d.id, before: null, after: null, change: null, status: 'missing', why: 'the change is a commit; cycles are counted on a folder' }); continue; }
    if (typeof ctx.probes?.scan !== 'function') throw new Error('G0 was started without the probe scanner.');
    const head = await ctx.probes.scan({ profile: ctx.profile, tree: ctx.tree, ids: [d.id], signal: ctx.signal, proc: ctx.proc });
    if (head?.errors?.[d.id]) { problems.push(`${label}: the probe failed (${head.errors[d.id]})`); continue; }
    const bv = await baseValues(ctx);
    if (!sameRule(bv.values, head?.values, d.id)) {
      rows.push({ metric: d.id, before: null, after: null, change: null, status: 'missing', why: 'the probe changed since the base scan' });
      continue;
    }
    const metrics = [d.id];
    if (typeof head?.values?.[d.id]?.largestModuleCycle === 'number') metrics.push(`${d.id}.largestModuleCycle`);
    rows.push(...metricRatchet({ base: bv.values, head: head?.values || {}, metrics }).rows
      .map(r => (r.status === 'missing' && r.before === null ? { ...r, why: 'no scan at the base commit yet; an architecture scan or the preflight records one' } : r)));
  }
  const worse = rows.filter(r => r.status === 'worse');
  const missing = rows.filter(r => r.status === 'missing');
  const parts = [
    ...worse.map(r => `${r.metric} went up from ${r.before} to ${r.after}`),
    ...missing.map(r => `${r.metric} not compared (${r.why || 'no value now'})`),
    ...problems,
  ];
  const status = worse.length ? 'fail' : missing.length || problems.length ? 'warn' : 'pass';
  return result(status, parts.length ? `${firstFew(parts)}.` : '', {
    command: `${active.map(d => d.id).join(', ')} at base and head`, log: parts.join('\n'), details: { rows, problems },
  });
}

const ROWS = {
  'g0.diffcheck': rowDiffcheck,
  'g0.format': rowFormat,
  'g0.lint': rowLint,
  'g0.secrets': rowSecrets,
  'g0.fences': rowFences,
  'g0.ratchets.tests': rowTestRatchet,
  'g0.ratchets.allowlist': rowAllowlist,
  'g0.ratchets.metrics': rowMetrics,
  'g0.contract': rowContract,
  'g0.tenant': rowTenant,
};

// ---------------------------------------------------------------- running G0

// Writes a text file through a temporary file and a rename, retried while Windows refuses it
// (core/datadir.mjs). Kept as an export here for the G0 rows and their tests.
export { writeTextAtomic };

// Shapes a row like a check summary row (SPEC 2.10) and writes its log when it has one.
async function finishRow(ctx, def, r, started) {
  const allow = ctx?.allow || [];
  const row = {
    id: def.id, group: 'G0', label: def.label, command: r.command || '',
    status: r.status, reason: redact(r.reason || '', { allow }),
    durationMs: r.runMs ?? Date.now() - started, log: r.logFile || null, details: redactDeep(r.details || {}, { allow }),
  };
  const gateDir = ctx?.gateDir;
  if (!row.log && gateDir && (r.log || row.reason)) {
    row.log = `${def.id}.log`;
    try { await writeTextAtomic(join(gateDir, row.log), `${redact(r.log || row.reason, { allow })}\n`); } catch { row.log = null; }
  }
  return row;
}

async function runRow(ctx, def) {
  const started = Date.now();
  let r;
  if (ctx.signal?.aborted) r = result('skip', 'Not run: cancelled.');
  else {
    try { r = await ROWS[def.id](ctx); } catch (e) { r = result('error', String(e?.message || e)); }
  }
  return finishRow(ctx, def, r, started);
}

function emit(onRow, row) {
  if (typeof onRow !== 'function') return;
  try { onRow(row); } catch { /* a progress callback never stops G0 */ }
}

// Runs every G0 row. Inputs as in SPEC WP5:
//   {profile, tree, baseSha, changed, diff, plan, ticked, allowances, pipeline, gateDir, git,
//    runCommand, probes, signal}
// `changed` is [{path, status, oldPath}] (bare paths are looked up); without `diff`, G0 builds
// one with git.diffText. Also, when given:
//   head       a commit: judge base..head from git instead of the folder
//   allowlist  the approved procedure allowlist (a list or the allowlist file's object)
//   dataDir, project  where to find the allowlist and the base scan when they aren't given
//   baseScan   a probes.scan result (or its values) taken at base, for the cycle count
//   proc       passed on to runCommand and probes.scan
//   onRow      called with each finished row, for live progress
// Returns {rows (in G0_ROWS order), fence, secretsFound (a count), ok, failed (row ids),
// cancelled}. `ok` is false while any row fails or errors, and while files outside the plan wait
// for your OK (fence.needsYou); the caller tells those apart through `fence`.
export async function runG0(opts = {}) {
  if (!opts.tree || !opts.baseSha) throw new Error('G0 needs the tree folder and the base commit.');
  let ctx = null;
  let setupError = '';
  try { ctx = await prepare(opts); } catch (e) { setupError = String(e?.message || e); }
  const allow = Array.isArray(opts.profile?.secrets?.allowValues) ? opts.profile.secrets.allowValues : [];
  const byId = new Map();
  for (const id of RUN_ORDER) {
    const def = G0_ROWS.find(r => r.id === id);
    const row = ctx
      ? await runRow(ctx, def)
      : await finishRow({ allow, gateDir: opts.gateDir || null }, def, result('error', `G0 could not start: ${setupError}`), Date.now());
    byId.set(id, row);
    emit(opts.onRow, row);
  }
  const rows = G0_ROWS.map(def => byId.get(def.id));
  const failed = rows.filter(r => r.status === 'fail' || r.status === 'error').map(r => r.id);
  const cancelled = Boolean(opts.signal?.aborted);
  const fence = ctx ? ctx.fence : null;
  const ok = !failed.length && !cancelled && !(fence && fence.needsYou);
  const out = { rows, fence, secretsFound: ctx ? ctx.secretsFound : 0, ok, failed, cancelled };
  if (opts.gateDir) {
    const doc = { version: 1, at: new Date().toISOString(), baseSha: opts.baseSha, head: opts.head || null, pipeline: opts.pipeline || '', ...out };
    try { await writeJsonAtomic(join(opts.gateDir, 'g0.json'), redactDeep(doc, { allow })); } catch { /* the result is still returned */ }
  }
  return out;
}
