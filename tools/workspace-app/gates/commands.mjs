// Check commands from the project profile: which ones a check level runs (planChecks), the files
// each one gets (expandFiles), and running one with a scrubbed env, a timeout and parsed output
// (runCommand, rerunFiles). gates/check.mjs strings these together into a check summary.
//
// - Every command is `{node} <script> ...` from the profile, never a shell or a .cmd file. It runs
//   through core/proc.mjs spawnLogged with stdout and stderr in log files in the gate folder, the
//   env from gates/env.mjs, and its own TEMP and TMP folder (spike A9: <runDir>/tmp/<gate folder>
//   inside a run, else <gateDir>/tmp).
// - Placeholders are filled by profile/profile.mjs resolveArgv, so {pkg:...} works the same as
//   everywhere else ("<rel> is not installed in this tree").
// - Output: TAP for tests (gates/tap.mjs), "file(line,col): error TSxxxx: msg" lines for tsc,
//   ESLint's JSON for lint, Prettier's "[warn] file" lines for format; other kinds go by exit code.
//   Error identities come from gates/baseline.mjs (file::TSxxxx::message, file::ruleId::message).
// - When a failing test has no file in the TAP, the command runs again one file per invocation
//   (at most min(4, cpus - 1) at a time), and remembers that for the rest of the process. Passing
//   tests without a file are fine: on Node 24 they never have one in a multi-file run (only
//   failures carry a location), and a failure's identity is what the baseline compares.
// - A file list too long for one Windows command line is split into parts.
// - Paths are posix and relative to the tree root unless a name says otherwise (cwdRel, Abs).
// - pids.json in the gate folder lists every check process ({pid, image, startedAt}), so startup
//   recovery can tell a leftover check from an unrelated process.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import * as realProc from '../core/proc.mjs';
import { writeJsonAtomic } from '../core/datadir.mjs';
import { DEFAULT_SKIP_DIRS, walk } from '../core/glob.mjs';
import { affectedWorkspaces, resolveArgv, workspaceOf } from '../profile/profile.mjs';
import { lintErrorId, numberDuplicates, typeErrorId } from './baseline.mjs';
import { checkEnv } from './env.mjs';
import { redact } from './secrets.mjs';
import { parseTap, UNKNOWN_FILE } from './tap.mjs';

export { UNKNOWN_FILE };
export const MAX_CMDLINE = 30000;
const DEFAULT_TIMEOUT_SEC = 300;
const STDERR_TAIL = 1000;

// ---------------------------------------------------------------------------------------------
// Paths

// A tree-relative posix path: "" for the root, null for anything absolute or outside the tree.
export function cleanRel(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  if (!s) return '';
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const n = posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (n === '.' || n === '') return '';
  if (n === '..' || n.startsWith('../')) return null;
  return n;
}

const joinRel = (a, b) => cleanRel(posix.join(a || '.', b || '.'));
const dirRel = p => cleanRel(posix.dirname(p));
const under = (path, dir) => dir === '' || path === dir || path.startsWith(`${dir}/`);
const inSkippedDir = p => p.split('/').slice(0, -1).some(seg => DEFAULT_SKIP_DIRS.includes(seg));

// A tree-relative path seen from a tree-relative folder: ("apps/web", "apps/web/src/a.ts") ->
// "src/a.ts". Pure string work: posix.relative would resolve against the Windows cwd.
export function relFrom(dir, p) {
  if (!dir) return p;
  const a = dir.split('/');
  const b = p.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

// The tree-relative path of a file named relative to a command's cwd (test ids use that form).
export function treeRelOf(command, cwdRelFile) {
  return joinRel(cleanRel(command?.cwd ?? '.') || '', cwdRelFile);
}

// The command's working folder, tree-relative ("" for the root). Throws when it leaves the tree.
function commandCwd(command, commandId) {
  const c = cleanRel(command?.cwd ?? '.');
  if (c === null) throw new Error(`Command ${commandId} has a working folder outside the tree.`);
  return c;
}

// The log file base name for a command or check id: "test:web" -> "test-web".
export function logName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

// The TEMP folder for checks writing logs to gateDir: <runDir>/tmp/<gate folder> when gateDir is
// <runDir>/gates/<folder> (the run's tmp folder is an orphan-scan needle, spike A11), otherwise
// <gateDir>/tmp.
export function checkTmpDir(gateDir) {
  const g = resolve(gateDir);
  if (basename(dirname(g)).toLowerCase() === 'gates') return join(dirname(dirname(g)), 'tmp', basename(g));
  return join(g, 'tmp');
}

// ---------------------------------------------------------------------------------------------
// Workspaces and planning

export function commandOf(profile, commandId) {
  const cmd = profile?.commands?.[commandId];
  if (!cmd || typeof cmd !== 'object') throw new Error(`The profile has no command "${commandId}".`);
  if (!Array.isArray(cmd.argv) || !cmd.argv.length) throw new Error(`Command ${commandId} has no argv.`);
  return cmd;
}

// The workspace that owns a path (profile/profile.mjs workspaceOf: the longest matching dir).
export function ownerOf(profile, path) {
  return workspaceOf(profile, path);
}

const commandsOfKind = (ws, kind) => (Array.isArray(ws?.[kind]) ? ws[kind] : []);

// The groups a level runs, in order, for example ['G0', 'G1', 'G2'].
export function levelGroups(profile, level) {
  const groups = profile?.levels?.[level]?.groups;
  if (!Array.isArray(groups)) throw new Error(`The profile has no check level "${level}".`);
  return groups.slice();
}

// Changed entries from core/git ({path, status, oldPath}) or plain paths. `all` holds every
// path a change touched (rename sources too), `live` the ones that still exist.
function changedPaths(changed) {
  const all = new Set();
  const live = new Set();
  for (const c of changed || []) {
    const e = typeof c === 'string' ? { path: c } : (c || {});
    const p = cleanRel(e.path);
    if (!p) continue;
    all.add(p);
    if (e.status !== 'D') live.add(p);
    const old = e.oldPath ? cleanRel(e.oldPath) : '';
    if (old) all.add(old);
  }
  return { all: [...all], live: [...live] };
}

// "apps/api/, packages/shared/" -> "apps/api and packages/shared".
function describePrefixes(prefixes) {
  const names = (prefixes || []).map(p => String(p).replace(/\/+$/, '')).filter(Boolean);
  if (!names.length) return 'the watched folders';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function testRegex(profile, cmd) {
  const src = cmd?.files?.pattern || profile?.fences?.testPattern;
  return src ? new RegExp(src) : /\.test\.[cm]?[jt]sx?$/;
}

// Workspaces whose `kind` commands a change needs. Types follow affectedBy too (a server change
// can break web types); lint and tests run for the workspaces that own a changed path.
function workspacesFor(profile, ch, kind, everything) {
  const withKind = (profile.workspaces || []).filter(ws => commandsOfKind(ws, kind).length);
  if (everything) return withKind;
  if (kind === 'types') return affectedWorkspaces(profile, ch.all, 'types');
  const owners = new Set(ch.all.map(p => ownerOf(profile, p)).filter(Boolean));
  return withKind.filter(ws => owners.has(ws));
}

// Items for a perWorkspace group (G1 types, G2 lint and test).
function perWorkspaceItems(profile, gid, group, ch, everything) {
  const items = [];
  const kinds = [].concat(group.perWorkspace);
  const chosen = new Map(kinds.map(k => [k, new Set(workspacesFor(profile, ch, k, everything))]));
  for (const ws of profile.workspaces || []) {
    for (const kind of kinds) {
      if (!chosen.get(kind).has(ws)) continue;
      const owned = ch.all.filter(p => ownerOf(profile, p) === ws);
      const ownedLive = owned.filter(p => ch.live.includes(p));
      for (const commandId of commandsOfKind(ws, kind)) {
        const cmd = commandOf(profile, commandId);
        const item = { id: commandId, group: gid, label: `${group.label}: ${ws.label || ws.id}`, commandId, workspace: ws.id, kind: cmd.kind || kind };
        if (!everything && kind === 'lint') {
          item.files = ownedLive;
          if (!ownedLive.length) item.skipReason = 'Not run: no changed files to lint';
        } else if (!everything && kind === 'test' && group.serverFocused === ws.id) {
          const re = testRegex(profile, cmd);
          item.files = ownedLive.filter(p => re.test(p));
          item.folders = [...new Set(owned.filter(p => !re.test(p)).map(dirRel).filter(d => d !== null))];
          if (!item.files.length && !item.folders.length) item.skipReason = `Not run: no ${ws.label || ws.id} tests near the changed files`;
        }
        items.push(item);
      }
    }
  }
  return items;
}

// Items for a command group (G3, G4): run when a `when` prefix matches and every required port
// listens; otherwise listed as skipped with the reason.
function commandGroupItems(profile, gid, group, ch, everything, listening) {
  const when = group.when || [];
  const hit = everything || !when.length || ch.all.some(p => when.some(pre => p.startsWith(pre)));
  const commands = group.commands || [];
  return commands.map(commandId => {
    const cmd = commandOf(profile, commandId);
    const item = {
      id: commandId, group: gid, label: commands.length > 1 ? `${group.label}: ${commandId}` : group.label,
      commandId, workspace: cmd.workspace, kind: cmd.kind,
    };
    const need = [...new Set([...(group.requiresPorts || []), ...(cmd.requiresPorts || [])])];
    const missing = need.filter(p => !listening.includes(p));
    if (!hit) item.skipReason = `Not run: ${describePrefixes(when)} unchanged`;
    else if (missing.length) {
      item.skipReason = `Not run: start the reliability containers yourself (port ${missing.join(', ')} is not answering)`;
      item.missingPorts = missing;
    }
    return item;
  });
}

// One item per command id. A run beats a skip, and a full run beats a focused one (G3's full
// server tests replace G2's focused ones); two focused runs merge their files.
function dedupe(items) {
  const rank = it => (it.skipReason ? 0 : (it.files || it.folders) ? 1 : 2);
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.id);
    if (!prev || rank(it) > rank(prev)) best.set(it.id, it);
    else if (rank(it) === 1 && rank(prev) === 1) {
      prev.files = [...new Set([...(prev.files || []), ...(it.files || [])])];
      prev.folders = [...new Set([...(prev.folders || []), ...(it.folders || [])])];
    }
  }
  return items.filter(it => best.get(it.id) === it);
}

// The commands a level runs for a change, in order:
//   [{id, group, label, commandId, workspace, kind, files?, folders?, skipReason?, missingPorts?}]
// - G0 rows are not planned here: they come from runG0 (gates/g0.mjs) at run time.
// - G1: the types commands of every workspace the change affects (owner or affectedBy).
// - G2: lint (on that workspace's changed files) and tests of the workspaces owning changed
//   paths; for the group's serverFocused workspace, only the changed test files plus the tests in
//   the folders of changed source files (`folders`, expanded by expandFiles).
// - G3 when a `when` prefix matches; G4 also needs every required port to listen. `listening`
//   lists the ports that answer (core/ports anyListening); runChecks fills it in, and without it
//   G4 is listed as not run.
// - what 'everything' selects every workspace and full runs.
export function planChecks({ profile, level, changed = [], what = 'uncommitted', listening = [] } = {}) {
  if (!profile || typeof profile !== 'object') throw new Error('planChecks needs a profile.');
  const ch = changedPaths(changed);
  const everything = what === 'everything';
  const items = [];
  for (const gid of levelGroups(profile, level)) {
    if (gid === 'G0') continue;
    const group = profile.groups?.[gid];
    if (!group) throw new Error(`Check level "${level}" uses group ${gid}, which the profile does not define.`);
    if (group.perWorkspace) items.push(...perWorkspaceItems(profile, gid, group, ch, everything));
    else items.push(...commandGroupItems(profile, gid, group, ch, everything, Array.isArray(listening) ? listening : []));
  }
  return dedupe(items);
}

// ---------------------------------------------------------------------------------------------
// File lists

async function isFile(abs) {
  try { return (await stat(abs)).isFile(); } catch { return false; }
}

async function filesIn(absDir) {
  try {
    return (await readdir(absDir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name);
  } catch { return []; }
}

// The files a command runs on, tree-relative and sorted. From `files.list`, or a walk of
// `files.roots` (relative to the command's cwd) filtered by `files.pattern`. `only` keeps just
// those paths; `folders` adds the matching files directly inside those folders. Without a files
// spec the result is `only` itself (format and lint on changed files). Missing files, files in
// node_modules and similar folders, and paths outside the tree are dropped.
export async function expandFiles(command, { tree, only, folders } = {}) {
  if (!tree) throw new Error('expandFiles needs the tree folder.');
  const cwd = commandCwd(command, 'command');
  const spec = command?.files;
  const onlySet = only ? new Set(only.map(cleanRel).filter(Boolean)) : null;
  const folderSet = folders ? new Set(folders.map(cleanRel).filter(p => p !== null)) : null;
  const picked = onlySet || folderSet;
  let out = [];
  let checkExists = true;
  if (!spec) {
    out = onlySet ? [...onlySet] : [];
  } else if (Array.isArray(spec.list)) {
    out = spec.list.map(p => joinRel(cwd, p)).filter(Boolean);
    if (picked) out = out.filter(p => onlySet?.has(p) || folderSet?.has(dirRel(p)));
  } else {
    const roots = (spec.roots?.length ? spec.roots : ['.']).map(r => joinRel(cwd, r)).filter(r => r !== null);
    const re = spec.pattern ? new RegExp(spec.pattern) : null;
    const matches = p => {
      const r = roots.find(root => under(p, root));
      if (r === undefined) return false;
      return !re || re.test(r === '' ? p : p.slice(r.length + 1));
    };
    if (picked) {
      const cands = new Set(onlySet || []);
      for (const dir of folderSet || []) for (const name of await filesIn(join(tree, dir))) cands.add(joinRel(dir, name));
      out = [...cands].filter(matches);
    } else {
      for (const r of roots) {
        const found = await walk(join(tree, r), { pattern: re || /./, skipDirs: DEFAULT_SKIP_DIRS }).catch(() => []);
        out.push(...found.map(f => joinRel(r, f)).filter(p => p && matches(p)));
      }
      checkExists = false;
    }
  }
  const kept = [];
  for (const p of [...new Set(out)].sort()) {
    if (inSkippedDir(p)) continue;
    if (checkExists && !(await isFile(join(tree, p)))) continue;
    kept.push(p);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Command lines

// A short, readable form for the checks table: "node tsx --test --test-reporter=tap (109 files)".
export function displayCommand(command, { fileCount = 0, base = '' } = {}) {
  const words = (command?.argv || []).map(a => {
    if (a === '{node}') return 'node';
    if (a === '{npmCli}') return 'npm';
    if (a === '{files}') return `(${fileCount} file${fileCount === 1 ? '' : 's'})`;
    const s = String(a).replace(/\{pkg:([^{}\s]+)\}/g, (_, rel) => rel.split('/')[0])
      .replace(/\{tree\}/g, '<tree>').replace(/\{base\}/g, base ? base.slice(0, 7) : '<base>');
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  });
  return words.join(' ').slice(0, 300);
}

// The full argv ([program, ...args]) for some tree-relative files. Throws on an unknown
// placeholder or a {pkg:} that is not installed (profile/profile.mjs resolveArgv).
export function commandArgv(command, { commandId = 'command', tree, cwdAbs, files = [], base = '' } = {}) {
  if (!Array.isArray(command?.argv) || command.argv[0] !== '{node}') {
    throw new Error(`Command ${commandId} must start with {node}; the app only runs node scripts.`);
  }
  const argv = files.length ? command.argv : command.argv.filter(a => a !== '{files}');
  return resolveArgv(argv, { tree, cwd: cwdAbs, files, base: base || undefined });
}

const cmdLength = argv => argv.reduce((n, a) => n + String(a).length + 3, 0);

// Splits files into parts whose command line stays under `max` characters.
function chunkFiles(baseLength, files, max) {
  const chunks = [];
  let cur = [];
  let len = baseLength;
  for (const f of files) {
    const l = f.length + 3;
    if (cur.length && len + l > max) { chunks.push(cur); cur = []; len = baseLength; }
    cur.push(f);
    len += l;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Output parsers

const toPosix = p => String(p).replace(/\\/g, '/');
const cap = (s, n = 2048) => (String(s).length > n ? `${String(s).slice(0, n)}...` : String(s));
const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
const noRedact = s => String(s);

const TSC_RE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TSC_GLOBAL_RE = /^error (TS\d+): (.*)$/;

// tsc errors as [{id, file, line, col, code, message}]. The id (gates/baseline.mjs typeErrorId)
// has no line or column, so an edit above an old error doesn't make it "new".
export function parseTscOutput(text, { redact: red = noRedact } = {}) {
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m = TSC_RE.exec(line);
    if (m) {
      const file = toPosix(m[1].trim());
      const message = cap(oneLine(red(m[5])), 500);
      errors.push({ id: typeErrorId({ file, code: m[4], message }), file, line: Number(m[2]), col: Number(m[3]), code: m[4], message });
      continue;
    }
    m = TSC_GLOBAL_RE.exec(line.trim());
    if (m) {
      const message = cap(oneLine(red(m[2])), 500);
      errors.push({ id: typeErrorId({ file: '(project)', code: m[1], message }), file: '(project)', line: 0, col: 0, code: m[1], message });
    }
  }
  return errors;
}

// ESLint --format json. Errors as [{id, file, line, col, rule, ruleId, message}] with the id from
// gates/baseline.mjs lintErrorId; files are made relative to cwdAbs. Returns {ok, errors,
// warnings}; ok is false when the output is not ESLint JSON.
export function parseEslintJson(text, { cwdAbs = '', redact: red = noRedact } = {}) {
  const src = String(text || '').trim();
  let data = null;
  try { data = JSON.parse(src); } catch {
    const at = src.search(/^\[/m);
    if (at >= 0) { try { data = JSON.parse(src.slice(at)); } catch { data = null; } }
  }
  if (!Array.isArray(data)) return { ok: false, errors: [], warnings: 0 };
  const errors = [];
  let warnings = 0;
  for (const f of data) {
    const abs = String(f?.filePath || '');
    const file = toPosix(cwdAbs && isAbsolute(abs) ? relative(cwdAbs, abs) : abs);
    for (const m of f?.messages || []) {
      if (m.severity !== 2) { warnings++; continue; }
      const ruleId = m.ruleId || null;
      const message = cap(oneLine(red(m.message || '')), 500);
      errors.push({ id: lintErrorId({ file, ruleId, message }), file, line: m.line || 0, col: m.column || 0, rule: ruleId || '(parse)', ruleId, message });
    }
  }
  return { ok: true, errors, warnings };
}

// prettier --check: the "[warn] <file>" lines, without the closing summary line.
export function parsePrettierCheck(text) {
  const files = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\[warn\]\s+(.+)$/.exec(raw.trim());
    if (m && !/code style issues|run prettier/i.test(m[1])) files.push(toPosix(m[1].trim()));
  }
  return files;
}

// The keys gates/baseline.mjs commandEntry gives errors: ids sorted, repeats numbered " (2)".
// Returns the errors in that order with `key` set, so a row can show the new ones.
export function keyedErrors(errors) {
  const sorted = [...(errors || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keys = numberDuplicates(sorted.map(e => e.id));
  return sorted.map((e, i) => ({ ...e, key: keys[i] }));
}

// ---------------------------------------------------------------------------------------------
// TAP results (gates/tap.mjs owns the shape: tests [{id, file, status, failure: {kind, message}}]).

export function tapRows(tap) {
  return (tap?.tests || []).map(t => ({
    id: String(t.id ?? ''), file: t.file || UNKNOWN_FILE, status: t.status || 'pass',
    kind: t.failure?.kind || (t.status === 'fail' ? 'other' : ''), message: t.failure?.message || '',
  }));
}

function mergeTap(taps) {
  const out = { tests: [], files: [], counts: { pass: 0, fail: 0, skip: 0, todo: 0 }, parseErrors: [], summary: null };
  for (const t of taps) {
    if (!t) continue;
    out.tests.push(...(t.tests || []));
    out.files.push(...(t.files || []));
    for (const k of Object.keys(out.counts)) out.counts[k] += Number(t.counts?.[k]) || 0;
    out.parseErrors.push(...(t.parseErrors || []));
    if (t.summary) {
      out.summary = out.summary || {};
      for (const [k, v] of Object.entries(t.summary)) if (typeof v === 'number') out.summary[k] = (out.summary[k] || 0) + v;
    }
  }
  return out;
}

const lostFailures = tap => tapRows(tap).some(t => t.status === 'fail' && t.file === UNKNOWN_FILE);

// ---------------------------------------------------------------------------------------------
// Processes

const perFileCommands = new Set();
const pidQueues = new Map();
const reservedLogs = new Set();

async function readJsonFile(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch { return ''; }
}

async function exists(abs) {
  try { await stat(abs); return true; } catch { return false; }
}

// A log base name no other invocation in this gate folder uses: logs are opened for appending, so
// G0's lint run and G2's lint run of the same command must not share a file.
async function reserveLog(gateDir, base) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const key = join(gateDir, name).toLowerCase();
    if (reservedLogs.has(key)) continue;
    if (await exists(join(gateDir, `${name}.log`)) || await exists(join(gateDir, `${name}.stderr.log`))) continue;
    reservedLogs.add(key);
    return name;
  }
  throw new Error(`The gate folder has too many logs named ${base}.`);
}

// pids.json: {version, procs: [{checkId, log, pid, image, startedAt, endedAt}]}. Writes are queued
// per file because per-file runs start several processes at once.
function updatePids(gateDir, change) {
  const file = join(gateDir, 'pids.json');
  const next = (pidQueues.get(file) || Promise.resolve()).then(async () => {
    const doc = (await readJsonFile(file)) || { version: 1, procs: [] };
    if (!Array.isArray(doc.procs)) doc.procs = [];
    change(doc);
    await writeJsonAtomic(file, doc);
  }).catch(() => { /* pids.json only helps recovery; it never fails a check */ });
  pidQueues.set(file, next);
  next.then(() => { if (pidQueues.get(file) === next) pidQueues.delete(file); });
  return next;
}

function processRecord(proc, handle, program) {
  if (handle?.record?.pid) return handle.record;
  try {
    if (typeof proc.startRecord === 'function' && handle?.child) {
      const rec = proc.startRecord(handle.child);
      if (rec?.pid) return rec;
    }
  } catch { /* fall back to what spawn told us */ }
  return { pid: handle?.pid ?? null, image: realProc.imageName(program), startedAt: Date.now() };
}

// Runs one invocation of the command on `files` (tree-relative) and reads its output back.
async function invoke(ctx, files, logBase) {
  const name = await reserveLog(ctx.gateDir, logBase);
  const inv = {
    files, log: `${name}.log`, stderrLog: `${name}.stderr.log`, exitCode: null, timedOut: false,
    startError: '', notStarted: false, stdout: '', stderr: '', durationMs: 0, tap: null,
  };
  const left = ctx.deadline - Date.now();
  if (left <= 0) { inv.timedOut = true; inv.notStarted = true; return inv; }
  if (ctx.signal?.aborted) { inv.notStarted = true; return inv; }
  const argv = commandArgv(ctx.cmd, { commandId: ctx.commandId, tree: ctx.tree, cwdAbs: ctx.cwdAbs, files, base: ctx.base });
  const cwdFiles = files.map(f => relFrom(ctx.cwdRel, f));
  const stdoutFile = join(ctx.gateDir, inv.log);
  const stderrFile = join(ctx.gateDir, inv.stderrLog);
  const started = Date.now();
  let handle;
  try {
    handle = await ctx.proc.spawnLogged({
      command: argv[0], args: argv.slice(1), cwd: ctx.cwdAbs, env: ctx.env, stdoutFile, stderrFile, timeoutMs: left, signal: ctx.signal,
    });
  } catch (e) {
    inv.startError = e.message;
    return inv;
  }
  if (!handle?.pid && !handle?.child) inv.notStarted = Boolean(ctx.signal?.aborted);
  const rec = processRecord(ctx.proc, handle, argv[0]);
  const entry = { checkId: ctx.checkId, log: inv.log, pid: rec.pid, image: rec.image, startedAt: rec.startedAt, endedAt: null };
  const noted = rec.pid ? updatePids(ctx.gateDir, doc => doc.procs.push(entry)) : Promise.resolve();
  const r = await handle.done;
  inv.exitCode = typeof r?.code === 'number' ? r.code : null;
  inv.timedOut = r?.timedOut === true;
  if (r?.error) inv.startError = r.error.message || String(r.error);
  inv.durationMs = Date.now() - started;
  await noted;
  if (rec.pid) await updatePids(ctx.gateDir, doc => { const e = doc.procs.find(p => p.log === entry.log && p.pid === entry.pid); if (e) e.endedAt = Date.now(); });
  inv.stdout = await readText(stdoutFile);
  inv.stderr = await readText(stderrFile);
  if (ctx.cmd.kind === 'test') {
    try {
      inv.tap = parseTap(inv.stdout, { files: cwdFiles, cwd: ctx.cwdAbs, allow: ctx.allow });
    } catch (e) {
      inv.tap = { tests: [], files: [], counts: { pass: 0, fail: 0, skip: 0, todo: 0 }, summary: null, parseErrors: [{ line: null, message: e.message }] };
    }
  }
  return inv;
}

// Runs fn over items with at most `limit` at a time; stops taking new items once cancelled.
async function pool(items, limit, fn, signal) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out.filter(Boolean);
}

export const perFileLimit = cmd => Math.max(1, Math.min(4, (cpus().length || 2) - 1, Number(cmd?.concurrency) || 4));

function runPerFile(ctx, files, name) {
  return pool(files, perFileLimit(ctx.cmd), (f, i) => invoke(ctx, [f], `${name}.f${String(i + 1).padStart(3, '0')}`), ctx.signal);
}

// ---------------------------------------------------------------------------------------------
// Results

function baseResult(ctx, extra = {}) {
  return {
    status: 'pass', exitCode: null, durationMs: 0, log: '', logs: [], command: ctx.display,
    files: ctx.files || [], fileCount: ctx.files?.length || 0, reason: '', ...extra,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function interpretTests(ctx, invs, out, bad) {
  const tap = mergeTap(invs.map(i => i.tap));
  out.tap = tap;
  out.counts = tap.counts;
  const fails = tap.counts.fail;
  if (fails) { out.status = 'fail'; out.reason = plural(fails, 'failing test'); }
  else if (bad) { out.status = 'error'; out.reason = `${ctx.commandId} exited with code ${bad.exitCode} and its TAP shows no failing test`; }
  else if (!tap.tests.length && !tap.summary && invs.some(i => !i.notStarted)) {
    out.status = 'error';
    out.reason = `${ctx.commandId} printed no TAP results; check that --test-reporter=tap reaches node`;
  } else if (!tap.tests.length) out.reason = 'No tests ran';
}

function interpretTypes(ctx, invs, out, bad) {
  out.errors = invs.flatMap(i => parseTscOutput(i.stdout, { redact: ctx.red }));
  if (out.errors.length) { out.status = 'fail'; out.reason = plural(out.errors.length, 'type error'); }
  else if (bad) { out.status = 'error'; out.reason = `${ctx.commandId} exited with code ${bad.exitCode} and printed no error it could read`; }
}

function interpretLint(ctx, invs, out, bad) {
  const parsed = invs.filter(i => !i.notStarted).map(i => ({ inv: i, ...parseEslintJson(i.stdout, { cwdAbs: ctx.cwdAbs, redact: ctx.red }) }));
  out.errors = parsed.flatMap(p => p.errors);
  out.warnings = parsed.reduce((n, p) => n + p.warnings, 0);
  const broken = parsed.find(p => !p.ok || p.inv.exitCode === 2);
  if (broken) { out.status = 'error'; out.reason = `ESLint did not finish (exit code ${broken.inv.exitCode})`; }
  else if (out.errors.length) { out.status = 'fail'; out.reason = plural(out.errors.length, 'lint error'); }
  else if (bad) { out.status = 'fail'; out.reason = `ESLint exited with code ${bad.exitCode}`; }
}

function interpretFormat(ctx, invs, out, bad) {
  const files = invs.flatMap(i => parsePrettierCheck(`${i.stdout}\n${i.stderr}`));
  out.errors = files.map(f => ({ id: `${f}::format`, file: f, message: 'not formatted' }));
  const other = invs.find(i => !i.notStarted && i.exitCode !== 0 && i.exitCode !== 1);
  if (other) { out.status = 'error'; out.reason = `the formatter exited with code ${other.exitCode}`; }
  else if (files.length) { out.status = 'fail'; out.reason = plural(files.length, 'unformatted file'); }
  else if (bad) { out.status = 'fail'; out.reason = `the formatter exited with code ${bad.exitCode}`; }
}

const INTERPRET = { test: interpretTests, types: interpretTypes, lint: interpretLint, format: interpretFormat };

// Turns the invocations into one result for the command.
function interpret(ctx, invs, startedAt) {
  const ran = invs.filter(i => !i.notStarted);
  const bad = ran.find(i => i.exitCode !== 0);
  const out = baseResult(ctx, {
    exitCode: ran.length ? (bad ? bad.exitCode : 0) : null,
    durationMs: Date.now() - startedAt,
    log: invs[0]?.log || '',
    logs: invs.map(i => i.log),
  });
  if (ctx.perFile) out.perFile = true;
  const fn = INTERPRET[ctx.cmd.kind];
  if (fn) fn(ctx, invs, out, bad);
  else if (bad) { out.status = 'fail'; out.reason = `${ctx.commandId} exited with code ${bad.exitCode}`; }
  const startError = invs.find(i => i.startError);
  if (ctx.signal?.aborted) { out.status = 'cancelled'; out.reason = 'Cancelled'; }
  else if (startError) { out.status = 'error'; out.reason = `Could not run ${ctx.commandId}: ${ctx.red(startError.startError)}`; }
  else if (invs.some(i => i.timedOut)) { out.status = 'error'; out.reason = `Timed out after ${Number(ctx.cmd.timeoutSec) || DEFAULT_TIMEOUT_SEC} s`; }
  if (out.status === 'error' || out.status === 'fail') {
    const src = invs.find(i => i.stderr.trim());
    if (src) out.stderrTail = cap(ctx.red(src.stderr.trim().slice(-STDERR_TAIL)), STDERR_TAIL);
  }
  return out;
}

async function folderExists(abs) {
  try { return (await stat(abs)).isDirectory(); } catch { return false; }
}

// The files to pass for {files}: the caller's list (tree-relative, existing files only) or the
// command's own file spec.
async function filesFor(o, cmd, tree) {
  if (!o.files) return expandFiles(cmd, { tree });
  const out = [];
  for (const f of new Set(o.files.map(cleanRel).filter(Boolean))) {
    if (!inSkippedDir(f) && await isFile(join(tree, f))) out.push(f);
  }
  return out;
}

// Shared by runCommand and rerunFiles.
async function execute(o) {
  const startedAt = Date.now();
  const { profile, commandId, tree, gateDir } = o;
  const cmd = commandOf(profile, commandId);
  const usesFiles = cmd.argv.includes('{files}');
  const allow = profile?.secrets?.allowValues || [];
  const ctx = {
    cmd, commandId, checkId: o.checkId || commandId, tree, gateDir, signal: o.signal, base: o.base || '', allow,
    red: s => String(redact(String(s ?? ''), { allow })),
    display: displayCommand(cmd, { base: o.base }), files: [],
  };
  try {
    ctx.cwdRel = commandCwd(cmd, commandId);
    ctx.cwdAbs = resolve(tree, ctx.cwdRel || '.');
    if (!(await folderExists(ctx.cwdAbs))) throw new Error(`The folder ${ctx.cwdRel || '.'} does not exist in ${tree}.`);
    if (usesFiles) {
      ctx.files = await filesFor(o, cmd, tree);
      ctx.display = displayCommand(cmd, { fileCount: ctx.files.length, base: o.base });
      if (!ctx.files.length) return baseResult(ctx, { status: 'skip', reason: 'Not run: no matching files' });
    }
    if (o.signal?.aborted) return baseResult(ctx, { status: 'cancelled', reason: 'Cancelled' });
    await mkdir(gateDir, { recursive: true });
    ctx.proc = o.proc || realProc;
    const tmp = o.tmpDir || checkTmpDir(gateDir);
    await mkdir(tmp, { recursive: true });
    ctx.env = checkEnv(profile, { command: cmd, extra: { TEMP: tmp, TMP: tmp } });
    const emptyArgv = commandArgv(cmd, { commandId, tree, cwdAbs: ctx.cwdAbs, base: ctx.base });
    const timeoutMs = (Number(cmd.timeoutSec) || DEFAULT_TIMEOUT_SEC) * 1000;
    ctx.deadline = Date.now() + timeoutMs;
    const name = o.name || logName(ctx.checkId);
    const memo = `${commandId}|${resolve(tree).toLowerCase()}`;
    ctx.perFile = usesFiles && cmd.kind === 'test' && (o.perFile === true || Number(cmd.concurrency) > 0 || perFileCommands.has(memo));
    let invs;
    if (ctx.perFile) {
      invs = await runPerFile(ctx, ctx.files, name);
    } else {
      const chunks = usesFiles ? chunkFiles(cmdLength(emptyArgv), ctx.files, o.maxCmdLine || MAX_CMDLINE) : [[]];
      invs = [];
      for (let i = 0; i < chunks.length && !o.signal?.aborted; i++) {
        invs.push(await invoke(ctx, chunks[i], chunks.length > 1 ? `${name}.part${i + 1}` : name));
      }
      const lost = invs.some(i => i.files.length > 1 && !i.timedOut && lostFailures(i.tap));
      if (cmd.kind === 'test' && lost && !o.signal?.aborted) {
        // A failing test has no file in the TAP: run each file on its own, with a fresh timeout.
        perFileCommands.add(memo);
        ctx.perFile = true;
        ctx.deadline = Date.now() + timeoutMs;
        invs = await runPerFile(ctx, ctx.files, `${name}.perfile`);
      }
    }
    return interpret(ctx, invs, startedAt);
  } catch (e) {
    return baseResult(ctx, { status: 'error', reason: ctx.red(e.message), durationMs: Date.now() - startedAt });
  }
}

// Runs one profile command and returns
//   {status: pass|fail|error|skip|cancelled, exitCode, durationMs, log, logs, command, files,
//    fileCount, reason, counts?, tap?, errors?, warnings?, stderrTail?, perFile?}
// - `files` (tree-relative) replaces the command's own file list; with {files} in argv and no
//   existing file the command is skipped. Commands without {files} ignore it.
// - `treeMode: 'main'` skips commands marked onlyTree "run" (install, generate).
// - Optional: base (for {base}), tmpDir, checkId (names the log), name, perFile, maxCmdLine.
// It never throws for a command that can't run; that is a result with status 'error'.
export async function runCommand(opts) {
  if (!opts?.profile) throw new Error('runCommand needs a profile.');
  const cmd = commandOf(opts.profile, opts.commandId);
  if (!opts.tree) throw new Error('runCommand needs the tree folder.');
  if (!opts.gateDir) throw new Error('runCommand needs a gate folder for its logs.');
  if (cmd.onlyTree === 'run' && opts.treeMode === 'main') {
    return {
      status: 'skip', exitCode: null, durationMs: 0, log: '', logs: [], command: displayCommand(cmd), files: [], fileCount: 0,
      reason: `Not run: ${opts.commandId} runs only in the run worktree`,
    };
  }
  return execute(opts);
}

// Reruns test files once, one invocation per file, with logs named <check>.rerun<round>.fNNN.
// Same options and result as runCommand; `files` is required.
export async function rerunFiles(opts) {
  if (!opts?.files?.length) throw new Error('rerunFiles needs at least one file.');
  return runCommand({ ...opts, perFile: true, name: `${logName(opts.checkId || opts.commandId)}.rerun${opts.round || 1}` });
}
