// Creates or clones a project in projects/<name> and adds the matching template files.
//
// Usage:
//   node tools/new-project.mjs <name> --type nextjs|game [--from <git-url>]
//
// - <name> must be kebab-case (my-app). The target is projects/<name>.
// - Without --from: creates the folder and runs `git init`.
// - With --from: runs `git clone <url> projects/<name>` (HTTPS URLs work).
// - Then copies templates/<type>/ into the project. Existing files are never overwritten.
//   templates/<type>/README.md is skipped (it describes the template itself).
//   {{PROJECT_NAME}} in text files is replaced with <name>.
// - No npm install and no network access other than git clone.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = ['nextjs', 'game'];
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const PLACEHOLDER = '{{PROJECT_NAME}}';

function fail(msg) {
  console.error(`new-project: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log('Usage: node tools/new-project.mjs <name> --type nextjs|game [--from <git-url>]');
}

function parseArgs(argv) {
  const out = { name: undefined, type: undefined, from: undefined };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else { val = argv[++i]; }
      if (!['type', 'from'].includes(key)) fail(`unknown option --${key}`);
      if (val === undefined || val === '') fail(`--${key} needs a value`);
      out[key] = val;
    } else if (out.name === undefined) {
      out.name = a;
    } else {
      fail(`unexpected argument "${a}"`);
    }
  }
  return out;
}

// On Windows, deep paths (node_modules, or a workspace under a long or virtualized folder)
// can exceed 260 characters, so git runs with core.longpaths and the new repo keeps it.
const WIN = process.platform === 'win32';
const LONGPATHS = WIN ? ['-c', 'core.longpaths=true'] : [];

function git(args, opts = {}) {
  return spawnSync('git', [...LONGPATHS, ...args], { encoding: 'utf8', ...opts });
}

function hasGit() {
  const r = git(['--version']);
  return !r.error && r.status === 0;
}

function normalizeUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function isEmptyDir(dir) {
  return readdirSync(dir).length === 0;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(relative(base, full));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function copyTemplate(templateDir, target, name) {
  let added = 0;
  let kept = 0;
  for (const rel of listFiles(templateDir)) {
    const relPosix = rel.split('\\').join('/');
    if (relPosix.toLowerCase() === 'readme.md') continue; // describes the template, not the project
    const dest = join(target, rel);
    if (existsSync(dest)) {
      console.log(`  kept (exists)  ${relPosix}`);
      kept++;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    let buf = readFileSync(join(templateDir, rel));
    const isText = !buf.subarray(0, 8000).includes(0);
    if (isText && buf.includes(PLACEHOLDER)) {
      buf = Buffer.from(buf.toString('utf8').split(PLACEHOLDER).join(name), 'utf8');
    }
    writeFileSync(dest, buf, { flag: 'wx' }); // wx: never overwrite, even in a race
    console.log(`  added          ${relPosix}`);
    added++;
  }
  return { added, kept };
}

// ---- main ----
const opts = parseArgs(process.argv.slice(2));
if (!opts.name) { usage(); fail('a project name is required'); }
if (!NAME_RE.test(opts.name)) fail(`"${opts.name}" is not kebab-case. Use lowercase letters, digits and dashes, for example my-app.`);
if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(opts.name)) fail(`"${opts.name}" is a reserved name on Windows. Pick another name.`);
if (!opts.type) { usage(); fail('--type is required (nextjs or game)'); }
if (!TYPES.includes(opts.type)) fail(`--type must be one of: ${TYPES.join(', ')}`);
if (opts.from !== undefined && opts.from.startsWith('-')) fail('--from must be a git URL');

const templateDir = join(root, 'templates', opts.type);
if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
  fail(`template folder templates/${opts.type}/ was not found. Nothing was created.`);
}

const target = join(root, 'projects', opts.name);
const targetRel = `projects/${opts.name}`;
const gitOk = hasGit();
let alreadyCloned = false;

if (existsSync(target)) {
  if (!statSync(target).isDirectory()) fail(`${targetRel} exists and is not a folder.`);
  if (!isEmptyDir(target)) {
    // Allowed only when --from was used and the folder is that clone (re-running adds missing template files).
    if (opts.from && gitOk && existsSync(join(target, '.git'))) {
      const r = git(['-C', target, 'remote', 'get-url', 'origin']);
      if (r.status === 0 && normalizeUrl(r.stdout) === normalizeUrl(opts.from)) alreadyCloned = true;
    }
    if (!alreadyCloned) {
      fail(`${targetRel} already exists and is not empty. Pick another name or remove that folder yourself.`);
    }
  }
}

if (opts.from) {
  if (!gitOk) fail('git was not found on PATH. Install Git for Windows, then try again.');
  if (alreadyCloned) {
    console.log(`${targetRel} is already a clone of ${opts.from}; skipping git clone.`);
  } else {
    console.log(`Cloning ${opts.from} into ${targetRel} ...`);
    const cfg = WIN ? ['--config', 'core.longpaths=true'] : [];
    const r = git(['clone', ...cfg, '--', opts.from, target], { stdio: 'inherit', encoding: undefined });
    if (r.error || r.status !== 0) fail('git clone failed (see the message above). Check the URL and your access.');
  }
} else {
  mkdirSync(target, { recursive: true });
  if (gitOk) {
    const r = git(['init', '--quiet', target]);
    if (r.status === 0 && WIN) git(['-C', target, 'config', 'core.longpaths', 'true']);
    if (r.status === 0) console.log(`Created ${targetRel} and ran git init.`);
    else console.warn(`Created ${targetRel}, but git init failed: ${(r.stderr || '').trim()}`);
  } else {
    console.warn(`Created ${targetRel}. git was not found, so git init was skipped.`);
  }
}

console.log(`Template files from templates/${opts.type}/:`);
const { added, kept } = copyTemplate(templateDir, target, opts.name);
console.log(`${added} added, ${kept} kept.`);

console.log('');
console.log('Next steps:');
console.log(`  cd ${targetRel}`);
if (!opts.from && opts.type === 'nextjs') {
  console.log('  Add the app code. If create-next-app refuses a non-empty folder, scaffold it in a');
  console.log('  temporary folder and move the files in (keep CLAUDE.md and .claude/).');
}
if (!opts.from && opts.type === 'game') {
  console.log('  Add your engine project (Godot, Unity or a web game) in this folder.');
}
console.log('  claude');
console.log('  /onboard-project   (maps the code and fills in CLAUDE.md)');
