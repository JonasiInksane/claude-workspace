// The architecture scan: runs a profile's probes over a project tree and returns their numbers.
//
//   scan({ profile, tree, sha, only, ids, signal, onRow, proc, readFile })
//     -> { at, sha, tree, node, values, details, errors, missing, durationMs, subset? }
//   values[probeId]  = { value, display, rule, ...extra }  (what metrics.json keeps per scan)
//   details[probeId] = [{ path, line, text }]               (the items behind each number)
//   errors[probeId]  = "madge not installed in this tree"  (a probe that failed; the rest still run)
//   missing          = ids asked for that the profile doesn't define
//   tree             = the scanned folder (recordScan asks git there which scan to compare with)
//   subset           = true when `ids` or `only` limited the scan (metrics.recordScan refuses it)
// `rule` is a short hash of the probe's definition, so a later comparison can tell a real change
// in the code from a change in the probe. Labels, the tile action, timeoutSec and "_" comment
// keys are left out of it, since they don't change what is counted. `onRow` gets one timeline
// row per probe as it finishes:
// { kind: 'gate', ok, probe, label, status: 'pass'|'error', msg: "<label>: <display>", durationMs }.
//
// The scan only reads the tree. The one exception is the `cycles` kind, which runs madge from the
// tree's node_modules through core/proc.mjs (`proc`, loaded on demand when not passed), with a
// small system-only environment. Folder walks skip node_modules, .git, .turbo and .next and never
// follow symlinks or junctions. Secret files (.env*, .npmrc, .sentryclirc and the profile's
// secrets.denyReadGlobs) are never read, and detail texts and probe errors go through
// gates/secrets.mjs redact. `only` limits the file probes to those paths (the G0 gates pass the
// changed files); `readFile(rel)` can replace the disk read, for example to read files at a base
// commit through git.
//
// CLI (zero tokens, read-only unless --write):
//   node tools/workspace-app/probes/scan.mjs --project <p> [--tree <dir>] [--write] [--json]
//        [--data-dir <dir>] [--profile <file>] [--ids <a,b>]
//   --write saves the scan to <dataDir>/metrics/<p>.json (never into the hub or the tree). It
//   saves full scans only, so it can't be combined with --ids.
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile as fsReadFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Text } from '../core/datadir.mjs';
import { DEFAULT_SKIP_DIRS, globToRegExp, toPosix, walk as walkFolder } from '../core/glob.mjs';
import { redact } from '../gates/secrets.mjs';
import { KINDS } from './rules.mjs';

const PROBE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROJECT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAGIC_RE = /[*?{}[\]\\]/;
const TOOL_MAX_BYTES = 64 * 1024 * 1024;
// What madge gets from the environment (the same system names gates/env.mjs keeps for checks).
const TOOL_ENV_VARS = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
// Profile parts that change what a kind counts, folded into the `rule` hash.
const RULE_PROFILE_KEYS = {
  routerKeys: ['builders'],
  missingAssert: ['builders', 'assertingBuilders', 'assertPattern'],
  expoParity: ['expo'],
};
// Probe keys that don't change what is counted (timeoutSec only decides when madge is given up).
const COSMETIC_KEYS = new Set(['label', 'measures', 'action', 'timeoutSec']);

// ---------------------------------------------------------------- paths inside the tree

// A tree-relative posix path, or '' when it is absolute or climbs out with "..".
function safeRel(p) {
  const s = toPosix(p);
  if (!s || /^[A-Za-z]:/.test(s) || s.startsWith('/')) return '';
  const n = posix.normalize(s).replace(/\/+$/, '');
  if (n === '.' ) return '';
  return n.split('/').includes('..') ? '' : n;
}

function isInside(child, root) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function insideTree(root, rel) {
  const abs = resolve(root, rel || '.');
  if (!isInside(abs, root)) throw new Error(`"${rel}" is outside the tree.`);
  return abs;
}

const isFileAbs = abs => lstat(abs).then(st => st.isFile(), () => false);

// Secret files are never read, whatever a probe's globs say: .env and .env* at any depth, .npmrc,
// .sentryclirc, and the profile's secrets.denyReadGlobs (matched ignoring case, the way Windows
// opens files). To a probe they look like files that don't exist.
const SECRET_NAME_RE = /^(?:\.env.*|\.npmrc|\.sentryclirc)$/i;

function secretFilter(profile) {
  const globs = profile && profile.secrets && Array.isArray(profile.secrets.denyReadGlobs) ? profile.secrets.denyReadGlobs : [];
  const res = globs.filter(g => typeof g === 'string' && g).map(g => globToRegExp(g, { nocase: true }));
  return rel => SECRET_NAME_RE.test(posix.basename(rel)) || res.some(r => r.test(rel));
}

// The values the profile says are fine to show (test-only keys), for redaction.
const allowValues = profile => (profile && profile.secrets && Array.isArray(profile.secrets.allowValues)
  ? profile.secrets.allowValues.filter(v => typeof v === 'string' && v)
  : []);

// The folder a glob's matches live under ("apps/web/src" for "apps/web/src/**/*.tsx"), or
// { literal } when the glob names one file.
function globBase(glob) {
  const parts = toPosix(glob).split('/');
  const lit = [];
  for (const part of parts) {
    if (MAGIC_RE.test(part)) return { base: lit.join('/') };
    lit.push(part);
  }
  return { literal: lit.join('/') };
}

// ---------------------------------------------------------------- the probe context

function makeContext({ root, realRoot, profile, only, readFile, proc, signal }) {
  const isSecret = secretFilter(profile);
  const onlyList = Array.isArray(only) ? [...new Set(only.map(safeRel).filter(Boolean))] : null;
  const texts = new Map();
  const folders = new Map();

  const readDisk = async rel => {
    const abs = join(root, rel);
    try {
      // A path that resolves outside the tree (through a link) is treated as missing.
      if (!isInside(await realpath(abs), realRoot)) return null;
      return await fsReadFile(abs, 'utf8');
    } catch {
      return null;
    }
  };

  const read = rel => {
    const r = safeRel(rel);
    if (!r || isSecret(r)) return Promise.resolve(null);
    if (!texts.has(r)) {
      const load = readFile ? Promise.resolve().then(() => readFile(r)) : readDisk(r);
      texts.set(r, load.then(t => (t === null || t === undefined ? null : String(t).replace(/^﻿/, '')), () => null));
    }
    return texts.get(r);
  };

  const filesUnder = base => {
    if (!folders.has(base)) {
      const abs = join(root, base);
      folders.set(base, walkFolder(abs, { signal })
        .then(list => list.map(f => (base ? `${base}/${f}` : f)), () => []));
    }
    return folders.get(base);
  };

  // Tree files matching any of the globs and none of the excludes, sorted. With `only` (and
  // without { all: true }) the candidates are the `only` paths that exist.
  const walk = async (globs, exclude = [], { all = false } = {}) => {
    const inc = globs.map(g => globToRegExp(g));
    const exc = (exclude || []).map(g => globToRegExp(g));
    const ok = p => !isSecret(p) && inc.some(r => r.test(p)) && !exc.some(r => r.test(p));
    const out = new Set();
    if (onlyList && !all) {
      for (const p of onlyList) if (ok(p) && (await read(p)) !== null) out.add(p);
      return [...out].sort();
    }
    for (const g of globs) {
      const { base, literal } = globBase(g);
      if (literal !== undefined) {
        const r = safeRel(literal);
        if (r && ok(r) && (await isFileAbs(join(root, r)))) out.add(r);
        continue;
      }
      for (const f of await filesUnder(safeRel(base))) if (ok(f)) out.add(f);
    }
    return [...out].sort();
  };

  // The entries of one folder: [{ name, dir }], sorted, without links, dot entries, skipped dirs
  // or secret files.
  const listDir = async rel => {
    const r = safeRel(rel);
    if (!r) return [];
    let entries = [];
    try { entries = await readdir(join(root, r), { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink() || DEFAULT_SKIP_DIRS.includes(e.name)) continue;
      if (e.isDirectory()) {
        const st = await lstat(join(root, r, e.name)).catch(() => null);
        if (st && st.isDirectory() && !st.isSymbolicLink()) out.push({ name: e.name, dir: true });
      } else if (e.isFile() && !isSecret(`${r}/${e.name}`)) {
        out.push({ name: e.name, dir: false });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const isFile = async rel => {
    const r = safeRel(rel);
    return r && !isSecret(r) ? isFileAbs(join(root, r)) : false;
  };

  const isDir = async rel => {
    const r = safeRel(rel);
    if (!r) return false;
    const st = await lstat(join(root, r)).catch(() => null);
    return !!st && st.isDirectory() && !st.isSymbolicLink();
  };

  return {
    tree: root,
    profile,
    only: onlyList,
    signal,
    readFile: read,
    walk,
    listDir,
    isFile,
    isDir,
    resolveArgv: (argv, cwd) => resolveProbeArgv(argv, { root, cwd }),
    run: opts => runTool(proc, { ...opts, root, signal }),
  };
}

// ---------------------------------------------------------------- running madge

const pkgName = rel => (/^(@[^/]+\/[^/]+|[^/]+)/.exec(rel) || [rel])[0];

// "{pkg:<rel>}": the first <dir>/node_modules/<rel> from the command's folder up to the tree root.
async function findPkg(rel, cwdAbs, root) {
  let dir = cwdAbs;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...rel.split('/'));
    if (await isFileAbs(candidate)) return candidate;
    const up = dirname(dir);
    if (relative(root, dir) === '' || up === dir || !isInside(up, root)) return null;
    dir = up;
  }
}

// Resolves a probe argv: {node} is this Node, {pkg:<rel>} a file in the tree's node_modules,
// {tree} the tree root. Anything else in braces is refused, and argv[0] must be {node}, so a probe
// never starts a .cmd file or a shell.
export async function resolveProbeArgv(argv, { root, cwd = '.' }) {
  const cwdAbs = insideTree(root, cwd);
  const out = [];
  for (const raw of argv) {
    const a = String(raw);
    if (a === '{node}') { out.push(process.execPath); continue; }
    const pkg = /^\{pkg:([^{}]+)\}$/.exec(a);
    if (pkg) {
      const rel = safeRel(pkg[1]);
      if (!rel) throw new Error(`"${a}" is not a package path inside node_modules.`);
      const found = await findPkg(rel, cwdAbs, root);
      if (!found) throw new Error(`${pkgName(rel)} not installed in this tree`);
      out.push(found);
      continue;
    }
    const unknown = /\{(?!tree\})[A-Za-z][\w:./@-]*\}/.exec(a);
    if (unknown) throw new Error(`The probe argv uses ${unknown[0]}, which probes can't use (only {node}, {pkg:...} and {tree}).`);
    out.push(a.replace(/\{tree\}/g, root));
  }
  if (out[0] !== process.execPath) throw new Error('The probe argv must start with {node}.');
  return out;
}

function toolEnv(env) {
  const out = { NO_COLOR: '1', FORCE_COLOR: '0' };
  const byLower = new Map(Object.keys(env).map(k => [k.toLowerCase(), k]));
  for (const name of TOOL_ENV_VARS) {
    const k = byLower.get(name.toLowerCase());
    if (k && env[k] !== undefined) out[name] = env[k];
  }
  return out;
}

const toText = v => (v === null || v === undefined ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

async function loadProc() {
  try {
    return await import('../core/proc.mjs');
  } catch {
    return null;
  }
}

// Runs one tool through core/proc.mjs runCapture and returns
// { code, stdout, stderr, timedOut, truncated, error }. A big repo's import graph is a few MB of
// JSON, so the output cap is raised to TOOL_MAX_BYTES.
async function runTool(proc, { command, args, cwd, timeoutMs, root, signal }) {
  const runner = proc || (await loadProc());
  if (!runner || typeof runner.runCapture !== 'function') {
    throw new Error('core/proc.mjs is not available to run the tool.');
  }
  const r = (await runner.runCapture({
    command, args, cwd: insideTree(root, cwd), env: toolEnv(process.env), timeoutMs, signal, maxBytes: TOOL_MAX_BYTES,
  })) || {};
  const code = r.exitCode ?? r.code ?? r.status ?? null;
  return {
    code,
    stdout: toText(r.stdout),
    stderr: toText(r.stderr),
    timedOut: !!(r.timedOut ?? r.timeout),
    truncated: !!r.truncated,
    error: r.error || null,
  };
}

// ---------------------------------------------------------------- the scan

function cancelled() {
  const err = new Error('The scan was cancelled.');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// A value without its "_" comment keys, at any depth (profiles allow them anywhere, SPEC 2.4).
function withoutComments(v) {
  if (Array.isArray(v)) return v.map(withoutComments);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) out[k] = withoutComments(x);
  return out;
}

function ruleHash(probe, profile) {
  const def = {};
  for (const [k, v] of Object.entries(probe)) if (!COSMETIC_KEYS.has(k) && !k.startsWith('_')) def[k] = withoutComments(v);
  for (const k of RULE_PROFILE_KEYS[probe.kind] || []) def[`profile.${k}`] = withoutComments(profile[k] ?? null);
  return sha256Text(canonicalJson(def)).slice(0, 12);
}

// The probes to run, in profile order. Throws on a missing or repeated id (a broken profile).
function selectProbes(profile, ids) {
  const all = Array.isArray(profile.probes) ? profile.probes : [];
  const seen = new Set();
  all.forEach((p, i) => {
    const id = p && p.id;
    if (typeof id !== 'string' || !PROBE_ID_RE.test(id)) throw new Error(`Probe ${i + 1} in the profile has no valid id.`);
    if (seen.has(id)) throw new Error(`The profile lists probe "${id}" twice.`);
    seen.add(id);
  });
  if (!ids) return { list: all, missing: [] };
  const want = [...new Set(ids)];
  return { list: all.filter(p => want.includes(p.id)), missing: want.filter(id => !seen.has(id)) };
}

async function treeRoot(tree) {
  if (typeof tree !== 'string' || !tree) throw new Error('scan needs a tree folder.');
  const root = resolve(tree);
  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`The tree ${root} is not a folder.`);
  return { root, realRoot: await realpath(root) };
}

function emit(onRow, row) {
  if (typeof onRow !== 'function') return;
  try { onRow(row); } catch { /* a broken listener never stops the scan */ }
}

export async function scan({ profile, tree, sha = null, only = null, ids = null, signal = null, onRow = null, proc = null, readFile = null } = {}) {
  if (!profile || typeof profile !== 'object') throw new Error('scan needs a profile.');
  const { root, realRoot } = await treeRoot(tree);
  const started = Date.now();
  const { list, missing } = selectProbes(profile, ids);
  const ctx = makeContext({ root, realRoot, profile, only, readFile, proc, signal });
  const allow = allowValues(profile);
  const values = {};
  const details = {};
  const errors = {};
  for (const probe of list) {
    if (signal && signal.aborted) throw cancelled();
    const t0 = Date.now();
    const label = probe.label || probe.id;
    try {
      const kind = KINDS[probe.kind];
      if (!kind || !Object.prototype.hasOwnProperty.call(KINDS, probe.kind)) throw new Error(`unknown probe kind "${probe.kind}"`);
      const r = await kind(probe, ctx);
      // A walk cut short by the signal looks like an empty folder; never record that number.
      if (signal && signal.aborted) throw cancelled();
      values[probe.id] = { ...(r.extra || {}), value: r.value, display: r.display, rule: ruleHash(probe, profile) };
      // Detail texts are source lines; a key pasted into code must not reach the page or a stage.
      details[probe.id] = (r.details || []).map(d => ({ ...d, text: redact(String(d.text ?? ''), { allow }) }));
      emit(onRow, { kind: 'gate', ok: true, probe: probe.id, label, status: 'pass', msg: `${label}: ${r.display}`, durationMs: Date.now() - t0 });
    } catch (err) {
      if (signal && signal.aborted) throw cancelled();
      const msg = redact(String((err && err.message) || err), { allow }).replace(/\.$/, '');
      errors[probe.id] = msg;
      emit(onRow, { kind: 'gate', ok: false, probe: probe.id, label, status: 'error', msg: `${label}: probe failed: ${msg}`, durationMs: Date.now() - t0 });
    }
  }
  const out = {
    at: new Date(started).toISOString(),
    sha: sha || null,
    tree: root,
    node: process.versions.node,
    values,
    details,
    errors,
    missing,
    durationMs: Date.now() - started,
  };
  if (ids || ctx.only) out.subset = true;
  return out;
}

// ---------------------------------------------------------------- CLI

export const USAGE = [
  'Usage: node tools/workspace-app/probes/scan.mjs --project <name> [--tree <dir>] [--write] [--json]',
  '                                                [--data-dir <dir>] [--profile <file>] [--ids <a,b>]',
  '  --tree      the folder to scan (default: projects/<name> in the hub, links resolved)',
  '  --write     save the scan to <data dir>/metrics/<name>.json (full scans only, so not with --ids)',
  '  --json      print the full result as JSON',
  '  --data-dir  the private data folder (default: %LOCALAPPDATA%\\claude-workspace)',
  '  --profile   read the profile from this JSON file instead of <data dir>/profiles/<name>.json',
  '  --ids       run only these probes',
].join('\n');

export function parseArgs(argv) {
  const out = { project: '', tree: '', write: false, json: false, dataDir: '', profileFile: '', ids: null, help: false };
  const takes = { '--project': 'project', '--tree': 'tree', '--data-dir': 'dataDir', '--profile': 'profileFile', '--ids': 'ids' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (takes[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      out[takes[a]] = takes[a] === 'ids' ? v.split(',').map(s => s.trim()).filter(Boolean) : v;
    } else return { error: `unknown argument "${a}"` };
  }
  if (!out.help && !PROJECT_RE.test(out.project)) return { error: '--project needs a project name (lowercase letters, digits and hyphens)' };
  if (!out.help && out.write && out.ids) return { error: '--write saves full scans only; leave out --ids' };
  return out;
}

function gitOut(dir, args) {
  return new Promise(done => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 10000 }, (err, out) => done(err ? null : String(out).trim()));
  });
}

const samePath = (a, b) => {
  const n = p => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// The commit and branch of the tree, when the tree is the top of a git checkout.
async function gitInfo(tree) {
  const top = await gitOut(tree, ['rev-parse', '--show-toplevel']);
  if (!top || !samePath(top, tree)) return { sha: null, branch: null };
  const sha = await gitOut(tree, ['rev-parse', 'HEAD']);
  const branch = await gitOut(tree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { sha: sha || null, branch: branch && branch !== 'HEAD' ? branch : null };
}

async function loadCliProfile(args, dataDir) {
  if (args.profileFile) {
    const { readJson } = await import('../core/datadir.mjs');
    const profile = await readJson(resolve(args.profileFile), null);
    if (!profile || typeof profile !== 'object') return { error: `${resolve(args.profileFile)} does not exist.` };
    return { profile };
  }
  const { loadProfile } = await import('../profile/profile.mjs');
  const r = await loadProfile(dataDir, args.project);
  if (!r.exists) return { error: `There is no profile for ${args.project} at ${r.path}. Create one from the example first.` };
  if (r.errors && r.errors.length) return { error: `The profile for ${args.project} has errors:\n  ${r.errors.join('\n  ')}` };
  return { profile: r.profile };
}

async function cliTree(args) {
  if (args.tree) return resolve(args.tree);
  try {
    return await realpath(join(HUB_ROOT, 'projects', args.project));
  } catch {
    return null;
  }
}

function textReport(result, tree, profile) {
  const labels = new Map((profile.probes || []).map(p => [p.id, p.label || p.id]));
  const ids = [...new Set([...Object.keys(result.values), ...Object.keys(result.errors)])];
  const width = Math.max(0, ...ids.map(id => id.length));
  const head = `Scanned ${tree}${result.sha ? ` at ${result.sha.slice(0, 7)}` : ''}${result.branch ? ` on ${result.branch}` : ''}`
    + ` in ${(result.durationMs / 1000).toFixed(1)} s (${ids.length} probes)`;
  const lines = [head];
  for (const id of ids) {
    const shown = result.errors[id] ? `probe failed: ${result.errors[id]}` : result.values[id].display;
    lines.push(`  ${id.padEnd(width)}  ${shown}  (${labels.get(id) || id})`);
  }
  if (result.missing.length) lines.push(`Not in the profile: ${result.missing.join(', ')}`);
  return lines.join('\n');
}

// Runs the CLI and returns the exit code (0: scanned, 1: usage, profile or save problem).
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const say = (stream, text) => stream.write(`${text}\n`);
  const args = parseArgs(argv);
  if (args.help) { say(stdout, USAGE); return 0; }
  if (args.error) { say(stderr, `scan: ${args.error}\n${USAGE}`); return 1; }
  try {
    const { defaultDataDir } = await import('../core/datadir.mjs');
    const dataDir = args.dataDir ? resolve(args.dataDir) : defaultDataDir(env);
    const loaded = await loadCliProfile(args, dataDir);
    if (loaded.error) { say(stderr, `scan: ${loaded.error}`); return 1; }
    const tree = await cliTree(args);
    if (!tree) { say(stderr, `scan: projects/${args.project} does not exist here; pass --tree <dir>.`); return 1; }
    const git = await gitInfo(tree);
    const result = await scan({ profile: loaded.profile, tree, sha: git.sha, ids: args.ids });
    result.branch = git.branch;
    let saved = null;
    if (args.write) {
      const { recordScan } = await import('./metrics.mjs');
      saved = await recordScan(dataDir, args.project, result, { profile: loaded.profile });
    }
    if (args.json) {
      say(stdout, JSON.stringify(saved ? { ...result, scanId: saved.scanId, wins: saved.wins } : result, null, 2));
      return 0;
    }
    say(stdout, textReport(result, tree, loaded.profile));
    if (saved) {
      say(stdout, `Saved scan ${saved.scanId} in ${join(dataDir, 'metrics', `${args.project}.json`)}`);
      for (const w of saved.wins) say(stdout, `Win: ${w.label} ${w.from} → ${w.to}`);
    }
    return 0;
  } catch (err) {
    say(stderr, `scan: ${(err && err.message) || err}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main().then(code => { process.exitCode = code; });
