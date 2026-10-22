// The settings file every headless Claude stage gets (--settings <stage>\settings.json).
//
// `claude -p` silently skips malformed permission rules and ignores a settings file that fails
// validation, so rules come only from this template and a unit test pins its exact output
// (plan section 3.2). --restricted ignores user, project and local settings, so everything a
// stage must obey is repeated here:
//   - autoMemoryEnabled false: worktrees share one auto-memory folder with your own sessions;
//   - blockReadsOutsideWorkingDirectories, plus absolute Read denies for .env*, .npmrc,
//     .sentryclirc, the profile's secret files and the app's private data;
//   - Edit (and, as untested defence in depth, Write) denies for the data folder, the hub, the
//     main checkout when the stage works elsewhere, and for EDIT the files --restricted still
//     lets acceptEdits change: CLAUDE.md, AGENTS.md, .github/** and .gitignore (spike A6);
//   - Bash denies for git writes, npm, npx, uv, eas, curl and wget;
//   - for CHECK and EDIT, `Bash(tg-check *)` and the PreToolUse guard hook (guard.mjs). Deny
//     rules are no barrier for Bash (grep -r and globs leak, spike A8), so the hook is a strict
//     allowlist and the real protection.
// Rules use the documented absolute form //c/path (lowercase drive letter, forward slashes).
// The hook runs this folder's own guard.mjs, never a path built from an argument: a hook that
// fails to start is a non-blocking error, and Bash would then run unguarded.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADLESS_PROFILES } from './argv.mjs';

export const GUARD_SCRIPT = fileURLToPath(new URL('./guard.mjs', import.meta.url));
export const SETTINGS_FILE = 'settings.json';
export const GUARD_FILE = 'guard.json';
export const HOOK_TIMEOUT_SEC = 10;
export const TG_CHECK_ALLOW = 'Bash(tg-check *)';
export const SECRET_GLOBS = Object.freeze(['**/.env*', '**/.npmrc', '**/.sentryclirc']);
export const SECRET_NAMES = Object.freeze(['.env', '.npmrc', '.sentryclirc']);
// Data-folder files a stage never needs to read (2.2).
export const PRIVATE_READS = Object.freeze(['profiles/**', 'baselines/**', 'findings/**', 'metrics/**', 'wins/**',
  'reports/**', 'checks/**', 'worktrees/**', 'settings.json', 'sessions.jsonl']);
// Files --restricted acceptEdits may still change (spike E9); EDIT stages get denies for them.
export const PROTECTED_IN_TREE = Object.freeze(['CLAUDE.md', 'AGENTS.md', '.github/**', '.gitignore']);
const GIT_WRITES = ['push', 'commit', 'stash', 'reset', 'checkout', 'switch', 'rebase', 'merge'];
export const BASH_DENIES = Object.freeze([...GIT_WRITES.map(c => `Bash(git ${c} *)`),
  'Bash(npm *)', 'Bash(npx *)', 'Bash(uv *)', 'Bash(eas *)', 'Bash(curl *)', 'Bash(wget *)']);
export const GUARD_SUBCOMMANDS = Object.freeze(['test', 'types', 'lint']);

const isWinAbs = p => /^[A-Za-z]:[\\/]/.test(p);
const unique = list => [...new Set(list)];

// The //c/... form of an absolute path (globs such as ** are kept). Throws on a relative path or
// one with parentheses, which would end the rule early and get it skipped.
export function rulePath(absPath) {
  const p = String(absPath ?? '');
  if (/[()]/.test(p)) throw new Error(`${p} has parentheses, which a permission rule can't hold.`);
  if (isWinAbs(p)) {
    const n = win32.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return `//${n[0].toLowerCase()}${n.slice(2)}`;
  }
  if (p.startsWith('/') && !p.startsWith('//')) return `/${posix.normalize(p).replace(/\/+$/, '')}`;
  throw new Error(`${p || 'An empty path'} is not an absolute path.`);
}

export function absRule(tool, absPath) {
  return `${tool}(${rulePath(absPath)})`;
}

// A folder plus a relative path or glob, joined in rule form ("//c/tree" + "a/**").
const under = (dir, rel) => `${rulePath(dir)}/${rel}`;

// Two absolute paths name the same folder (Windows paths ignore case).
export function sameDir(a, b) {
  try { return rulePath(a).toLowerCase() === rulePath(b).toLowerCase(); } catch { return false; }
}

// `inner` lies inside `outer` (or is it).
export function isInside(outer, inner) {
  try {
    const o = rulePath(outer).toLowerCase();
    const i = rulePath(inner).toLowerCase();
    return i === o || i.startsWith(`${o}/`);
  } catch { return false; }
}

// A relative path or glob from the profile, in posix form; throws on anything that could leave
// the tree or break a rule.
function relEntry(rel, what) {
  const r = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r || r.startsWith('/') || isWinAbs(r) || r.split('/').includes('..') || /[()]/.test(r)) {
    throw new Error(`${what} "${rel}" must be a relative path inside the project.`);
  }
  return r;
}

function profileSecrets(profileDoc) {
  const s = (profileDoc && profileDoc.secrets) || {};
  const files = Array.isArray(s.trackedSecretFiles) ? s.trackedSecretFiles.map(f => relEntry(f, 'The secret file')) : [];
  const globs = Array.isArray(s.denyReadGlobs) ? s.denyReadGlobs.map(g => relEntry(g, 'The read-deny glob')) : [];
  return { files, globs };
}

function requireAbs(values) {
  for (const [name, v] of Object.entries(values)) {
    if (typeof v !== 'string' || !(isWinAbs(v) || v.startsWith('/'))) throw new Error(`stageSettings needs an absolute ${name}.`);
  }
}

// The settings object for one stage. mainDir defaults to tree (a stage in the main checkout).
export function stageSettings({ profile, hubRoot, dataDir, runDir, stageDir, tree, mainDir, profileDoc, nodePath = process.execPath }) {
  const p = HEADLESS_PROFILES[profile];
  if (!p || !Object.prototype.hasOwnProperty.call(HEADLESS_PROFILES, profile)) throw new Error(`"${profile}" is not a stage profile; use READ, CHECK or EDIT.`);
  const main = mainDir || tree;
  requireAbs({ hubRoot, dataDir, runDir, stageDir, tree, mainDir: main, nodePath });
  const secrets = profileSecrets(profileDoc);
  const deny = [];
  for (const g of SECRET_GLOBS) for (const tool of ['Read', 'Edit', 'Write']) deny.push(`${tool}(//${g})`);
  for (const rel of PRIVATE_READS) deny.push(`Read(${under(dataDir, rel)})`);
  const trees = sameDir(tree, main) ? [tree] : [tree, main];
  for (const dir of trees) {
    for (const f of [...secrets.files, ...secrets.globs]) deny.push(`Read(${under(dir, f)})`);
  }
  for (const f of [...secrets.files, ...secrets.globs]) deny.push(`Edit(${under(tree, f)})`, `Write(${under(tree, f)})`);
  const noEdit = [dataDir, hubRoot];
  if (!isInside(dataDir, runDir)) noEdit.push(runDir);
  if (!sameDir(tree, main)) noEdit.push(main);
  for (const dir of noEdit) deny.push(`Edit(${under(dir, '**')})`, `Write(${under(dir, '**')})`);
  if (profile === 'EDIT') {
    for (const rel of PROTECTED_IN_TREE) deny.push(`Edit(${under(tree, rel)})`, `Write(${under(tree, rel)})`);
  }
  deny.push(...BASH_DENIES);
  const permissions = { blockReadsOutsideWorkingDirectories: true };
  if (p.bash) permissions.allow = [TG_CHECK_ALLOW];
  permissions.deny = unique(deny);
  const settings = { autoMemoryEnabled: false, permissions };
  if (p.bash) {
    settings.hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{
      type: 'command', command: nodePath, args: [GUARD_SCRIPT, join(stageDir, GUARD_FILE)], timeout: HOOK_TIMEOUT_SEC,
    }] }] };
  }
  return settings;
}

// The settings for "Take over": the same rules without the hook (you approve commands yourself
// in the terminal).
export function takeoverSettings(s) {
  const copy = JSON.parse(JSON.stringify(s));
  delete copy.hooks;
  return copy;
}

// What guard.mjs reads (<stageDir>\guard.json): the folders a tg-check command may never name,
// and the file names it may never contain.
export function guardConfig({ tree, runDir, hubRoot, dataDir, mainDir, secretFiles = [] }) {
  requireAbs({ tree, runDir, hubRoot, dataDir });
  const roots = [runDir, hubRoot, dataDir];
  if (mainDir && !sameDir(tree, mainDir)) roots.push(mainDir);
  const names = [...SECRET_NAMES];
  for (const f of secretFiles) {
    const rel = relEntry(f, 'The secret file').toLowerCase();
    names.push(rel, basename(rel));
  }
  return { version: 1, tree, forbiddenRoots: unique(roots), forbiddenNames: unique(names), subcommands: [...GUARD_SUBCOMMANDS] };
}

// Writes settings.json (and guard.json for CHECK and EDIT) into the stage folder. Returns
// { settingsFile, settings, guardFile } (guardFile is '' for READ).
export async function writeStageFiles(opts) {
  const settings = stageSettings(opts);
  await mkdir(opts.stageDir, { recursive: true });
  const settingsFile = join(opts.stageDir, SETTINGS_FILE);
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  let guardFile = '';
  if (settings.hooks) {
    guardFile = join(opts.stageDir, GUARD_FILE);
    const secretFiles = profileSecrets(opts.profileDoc).files;
    const cfg = guardConfig({ tree: opts.tree, runDir: opts.runDir, hubRoot: opts.hubRoot, dataDir: opts.dataDir, mainDir: opts.mainDir, secretFiles });
    await mkdir(dirname(guardFile), { recursive: true });
    await writeFile(guardFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  return { settingsFile, settings, guardFile };
}
