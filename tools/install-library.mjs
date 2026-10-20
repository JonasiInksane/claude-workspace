// Installs the global library into ~/.claude so the skills and agents work in every project.
//
// Usage:
//   node tools/install-library.mjs [--target <dir>] [--dry-run]
//
// - library/skills/<name>/**  ->  <target>/skills/<name>/
// - library/agents/*.md       ->  <target>/agents/
// - Default target: ~/.claude (on Windows %USERPROFILE%\.claude).
// - Reports "new", "updated" or "unchanged" per skill/agent by comparing file contents.
// - Never deletes anything in the target. Extra files you added there are left alone.
// - A same-named file with different content is backed up to <target>/library-backups/<timestamp>/
//   before it is replaced (that folder is outside skills/ and agents/, so Claude Code ignores it).
// Re-run after editing anything in library/.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const library = join(root, 'library');
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '__pycache__', '.git']);

function fail(msg) {
  console.error(`install-library: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { target: join(homedir(), '.claude'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log('Usage: node tools/install-library.mjs [--target <dir>] [--dry-run]');
      process.exit(0);
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--target') {
      const v = argv[++i];
      if (!v) fail('--target needs a folder');
      out.target = resolve(v);
    } else if (a.startsWith('--target=')) {
      const v = a.slice('--target='.length);
      if (!v) fail('--target needs a folder');
      out.target = resolve(v);
    } else fail(`unknown argument "${a}". Usage: node tools/install-library.mjs [--target <dir>] [--dry-run]`);
  }
  return out;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

function sameContent(a, b) {
  if (!existsSync(b)) return false;
  const sa = statSync(a);
  const sb = statSync(b);
  if (!sb.isFile() || sa.size !== sb.size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

// Copies a list of files; returns "new" | "updated" | "unchanged" for the item as a whole.
// Files that exist with other content are copied to backupBase first.
function installItem(files, srcBase, dstBase, existedBefore, dryRun, backupBase) {
  let changed = 0;
  for (const rel of files) {
    const src = join(srcBase, rel);
    const dst = join(dstBase, rel);
    if (sameContent(src, dst)) continue;
    changed++;
    if (existsSync(dst)) {
      const bak = join(backupBase, rel);
      if (dryRun) console.log(`    would back up ${dst}`);
      else {
        mkdirSync(dirname(bak), { recursive: true });
        writeFileSync(bak, readFileSync(dst));
        backedUp++;
        console.log(`    backed up ${dst} -> ${bak}`);
      }
    }
    if (!dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
  }
  if (!existedBefore) return { state: 'new', changed };
  return { state: changed ? 'updated' : 'unchanged', changed };
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(library)) fail(`library/ not found at ${library}`);

const skillsSrc = join(library, 'skills');
const agentsSrc = join(library, 'agents');
const skillsDst = join(opts.target, 'skills');
const agentsDst = join(opts.target, 'agents');
const tag = opts.dryRun ? '[dry-run] ' : '';
const counts = { new: 0, updated: 0, unchanged: 0 };
let backedUp = 0;
const now = new Date();
const two = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
const backupRoot = join(opts.target, 'library-backups', stamp);
// Sessions only watch folders that existed when they started, so remember which ones are new.
const skillsDirExisted = existsSync(skillsDst);
const agentsDirExisted = existsSync(agentsDst);
const pad = s => (s + ':').padEnd(11);

console.log(`${tag}Installing library to ${opts.target}`);

if (existsSync(skillsSrc)) {
  const skills = readdirSync(skillsSrc, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP.has(e.name))
    .map(e => e.name)
    .sort();
  for (const name of skills) {
    const src = join(skillsSrc, name);
    const dst = join(skillsDst, name);
    const files = listFiles(src);
    if (!files.some(f => f === 'SKILL.md')) {
      console.warn(`  warning: library/skills/${name} has no SKILL.md (copied anyway)`);
    }
    const { state, changed } = installItem(files, src, dst, existsSync(dst), opts.dryRun, join(backupRoot, 'skills', name));
    counts[state]++;
    const detail = state === 'updated' ? ` (${changed} of ${files.length} files changed)` : '';
    console.log(`  ${pad(state)} skills/${name}${detail}`);
  }
} else {
  console.warn('  warning: library/skills not found');
}

if (existsSync(agentsSrc)) {
  const agents = readdirSync(agentsSrc, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md')
    .map(e => e.name)
    .sort();
  for (const file of agents) {
    const dst = join(agentsDst, file);
    const { state } = installItem([file], agentsSrc, agentsDst, existsSync(dst), opts.dryRun, join(backupRoot, 'agents'));
    counts[state]++;
    console.log(`  ${pad(state)} agents/${file}`);
  }
} else {
  console.warn('  warning: library/agents not found');
}

console.log(`${tag}${counts.new} new, ${counts.updated} updated, ${counts.unchanged} unchanged` +
  (backedUp ? `, ${backedUp} file(s) backed up to ${backupRoot}` : '') + '.' +
  (opts.dryRun ? ' Nothing was written.' : ''));
if (!opts.dryRun && !skillsDirExisted && existsSync(skillsDst)) {
  console.log(`Note: ${skillsDst} was just created. In a Claude Code session that was already open, run /reload-skills.`);
}
if (!opts.dryRun && !agentsDirExisted && existsSync(agentsDst)) {
  console.log(`Note: ${agentsDst} was just created. Restart Claude Code sessions that were already open to see the agents.`);
}
console.log("Skills and agents reload automatically in running sessions; if one doesn't show up, restart Claude Code.");
