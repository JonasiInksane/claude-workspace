// PostToolUse hook (matcher Edit|Write): runs Prettier on the one file Claude just edited.
//
// Wired in .claude/settings.json in exec form, so it works on Windows without a shell:
//   { "type": "command", "command": "node",
//     "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/format-file.mjs"], "timeout": 60 }
//
// It formats the file only when ALL of these hold:
//   - tool_input.file_path (from the hook JSON on stdin) is inside this project,
//   - the extension is one Prettier handles (see EXTENSIONS),
//   - the nearest package.json (walking up from the file) lists prettier in
//     dependencies or devDependencies,
//   - Prettier is installed: node_modules/.bin/prettier (prettier.cmd on Windows), or
//     node_modules/prettier itself (then its script runs with node). It never downloads Prettier.
// Otherwise it does nothing. It always exits 0 and prints nothing, so it never blocks Claude.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.css', '.scss', '.md', '.mdx', '.html', '.yml', '.yaml',
]);
const IS_WIN = process.platform === 'win32';
const CMD_PATH_LIMIT = 250; // cmd.exe can't run a .cmd file whose full path nears 260 characters

// Real path (follows junctions, symlinks and redirected folders), so a file path and the
// project root compare correctly even when they reach the same folder by different routes.
function real(p) {
  try { return realpathSync.native(p); } catch { return p; }
}

// This file lives in <project>/.claude/hooks/, so the project root is two folders up.
const PROJECT_ROOT = real(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));

function done() {
  process.exit(0);
}

process.on('uncaughtException', done);
process.on('unhandledRejection', done);

function readStdin(timeoutMs) {
  return new Promise((res) => {
    if (process.stdin.isTTY) { res(''); return; }
    let data = '';
    const timer = setTimeout(() => res(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); res(data); });
    process.stdin.on('error', () => { clearTimeout(timer); res(data); });
  });
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function listsPrettier(pkgFile) {
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''));
    return Boolean(
      (pkg.dependencies && pkg.dependencies.prettier) ||
      (pkg.devDependencies && pkg.devDependencies.prettier)
    );
  } catch {
    return false;
  }
}

// The JS entry point of an installed Prettier (node_modules/prettier/package.json "bin").
function prettierScript(nodeModules) {
  try {
    const pkgRoot = join(nodeModules, 'prettier');
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.prettier;
    const script = rel ? join(pkgRoot, rel) : null;
    return script && existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

// Walks from `start` up to PROJECT_ROOT (inclusive) and returns the first non-null test(dir).
function findUp(start, test) {
  let dir = start;
  while (isInside(PROJECT_ROOT, dir)) {
    const hit = test(dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main() {
  const raw = (await readStdin(5000)).replace(/^\uFEFF/, '').trim();
  if (!raw) return;

  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const given = input && input.tool_input && input.tool_input.file_path;
  if (typeof given !== 'string' || !given) return;

  const asGiven = resolve(typeof input.cwd === 'string' && input.cwd ? input.cwd : PROJECT_ROOT, given);
  if (!EXTENSIONS.has(extname(asGiven).toLowerCase())) return;
  if (!existsSync(asGiven) || !statSync(asGiven).isFile()) return;
  const file = real(asGiven);
  if (!isInside(PROJECT_ROOT, file)) return;

  // The nearest package.json that lists prettier decides where Prettier runs.
  const pkgDir = findUp(dirname(file), (dir) => (listsPrettier(join(dir, 'package.json')) ? dir : null));
  if (!pkgDir) return;

  const binName = IS_WIN ? 'prettier.cmd' : 'prettier';
  const bin = findUp(pkgDir, (dir) => {
    const candidate = join(dir, 'node_modules', '.bin', binName);
    return existsSync(candidate) ? candidate : null;
  });

  const args = ['--write', '--ignore-unknown', file];
  let command = null;
  if (bin && !IS_WIN) {
    command = (opts) => spawnSync(bin, args, opts);
  } else if (bin && bin.length < CMD_PATH_LIMIT && !/["%]/.test(file + bin)) {
    // A .cmd shim only runs through cmd.exe (shell: true), so both paths are quoted.
    command = (opts) => spawnSync(`"${bin}" --write --ignore-unknown "${file}"`, { ...opts, shell: true });
  } else {
    // No .cmd shim (not every package manager makes one), or cmd.exe can't run it (very deep
    // folder, or a character it misreads): run Prettier's own script with node instead.
    const script = findUp(pkgDir, (dir) => prettierScript(join(dir, 'node_modules')));
    if (script) command = (opts) => spawnSync(process.execPath, [script, ...args], opts);
  }
  if (!command) return; // Prettier listed but not installed: skip quietly.

  // Run from the package folder so Prettier finds .prettierignore there. Windows can't start
  // a process in a folder whose path is longer than about 258 characters; then retry from
  // the current folder (Prettier still finds its config next to the file).
  const base = { stdio: 'ignore', timeout: 50000, windowsHide: true };
  const r = command({ ...base, cwd: pkgDir });
  if (r.error && r.error.code === 'ENOENT') command(base);
}

main().then(done, done);
