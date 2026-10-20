// PostToolUse hook for Edit|Write (registered in .claude/settings.json).
// Reads the hook JSON from stdin. If the edited file is inside the workspace, but not under
// projects/, inbox/ or .claude/worktrees/ and not index.html itself, it rebuilds the navigator
// (tools/build-index.mjs).
// It always exits 0 and prints nothing, so it never blocks or distracts Claude.
// Test by hand (PowerShell):
//   '{"tool_input":{"file_path":"knowledge/INDEX.md"}}' | node tools/hooks/after-edit.mjs
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Workspace root = two levels up from tools/hooks/, never the current directory.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_TOP = new Set(['projects', 'inbox']);

// Read all of stdin, but give up after a few seconds so the hook can never hang.
function readStdin(ms = 5000) {
  return new Promise(done => {
    if (process.stdin.isTTY) return done('');
    let raw = '';
    const finish = () => { clearTimeout(timer); done(raw); };
    const timer = setTimeout(() => {
      try { process.stdin.destroy(); } catch { /* ignore */ }
      done(raw);
    }, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// Real path of p (junctions and redirected folders resolved). If p doesn't exist,
// resolve its nearest existing parent and re-append the rest.
function real(p) {
  let cur = p;
  const rest = [];
  for (let i = 0; i < 100; i++) {
    try { return join(realpathSync.native(cur), ...rest.slice().reverse()); } catch { /* go up */ }
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.push(basename(cur));
    cur = parent;
  }
  return p;
}

// Path of abs relative to base, or null if abs is not inside base (case-insensitive on Windows).
function inside(base, abs) {
  const rel = relative(base, abs);
  if (rel === '' || isAbsolute(rel) || /^\.\.([\\/]|$)/.test(rel)) return null;
  return rel;
}

function shouldRebuild(filePath, cwd) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return false;
  let p = filePath.trim();
  // Git Bash style /c/Users/... -> C:/Users/... on Windows.
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) p = `${p[1]}:${p.slice(2)}`;
  const base = typeof cwd === 'string' && cwd ? cwd : root;
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p);
  // Compare as given first, then with real paths (the script's own path is already resolved).
  const rel = inside(root, abs) || inside(real(root), real(abs));
  if (!rel) return false; // outside the workspace
  const parts = rel.split(/[\\/]+/).map(s => s.toLowerCase());
  if (SKIP_TOP.has(parts[0])) return false;
  if (parts.length === 1 && parts[0] === 'index.html') return false;
  // The navigator never shows .claude/worktrees/ (worktree sessions), so skip those too.
  if (parts[0] === '.claude' && parts[1] === 'worktrees') return false;
  return true;
}

async function main() {
  const raw = await readStdin();
  let input;
  // trimStart() also drops a BOM (Windows PowerShell 5.1 adds one when piping text to node).
  try { input = JSON.parse(raw.trimStart()); } catch { return; }
  if (!input || typeof input !== 'object') return;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (!shouldRebuild(toolInput.file_path, input.cwd)) return;
  const script = join(root, 'tools', 'build-index.mjs');
  if (!existsSync(script)) return;
  spawnSync(process.execPath, [script], { cwd: root, stdio: 'ignore', timeout: 25000, windowsHide: true });
}

main()
  .catch(() => { /* never fail the hook */ })
  .finally(() => process.exit(0));
