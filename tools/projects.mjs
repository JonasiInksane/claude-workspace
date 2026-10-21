// The project repos listed in projects/repos.json: see them, clone them, list new ones.
//
// Usage:
//   node tools/projects.mjs list                                   what is listed, cloned here, and needed
//   node tools/projects.mjs clone <name>                           clone a listed repo into projects/<name>
//   node tools/projects.mjs clone --url <url> [--name <name>] [--add] [--requires git-lfs,blender-5.2]
//                                                                  clone any repo; --add also lists it
//   node tools/projects.mjs add <name> [--requires git-lfs,blender-5.2]
//                                                                  list a project folder by its origin remote
//
// - A clone is a plain `git clone` (no template files are added; that is what new-project does).
//   It never clones into an existing folder. git may ask you to sign in to GitHub.
// - Listing a repo means another PC gets it through Setup.ps1 -Mode Install or this tool.
// - --root <dir> uses another workspace root (for tests).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { addRepo, GIT_URL, nameFromUrl, NAME_RE, originOf, readRepos, repoStatus, REQUIREMENTS, requirementStatus, unlistedProjects } from './lib/repos.mjs';

function fail(msg) {
  console.error(`projects: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { positional: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--add') out.opts.add = true;
    else if (a.startsWith('--')) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) fail(`${a} needs a value`);
      out.opts[a.slice(2)] = val;
      i++;
    } else out.positional.push(a);
  }
  return out;
}

function requiresOpt(opts) {
  const list = opts.requires ? String(opts.requires).split(',').map(s => s.trim()).filter(Boolean) : [];
  const bad = list.find(r => !REQUIREMENTS.includes(r));
  if (bad) fail(`unknown requirement "${bad}" (known: ${REQUIREMENTS.join(', ')})`);
  return list;
}

function gitClone(root, name, url) {
  const dir = join(root, 'projects', name);
  if (existsSync(dir)) fail(`projects/${name} already exists`);
  console.log(`Cloning ${url} into projects/${name} ...`);
  const r = spawnSync('git', ['clone', url, dir], { stdio: 'inherit' });
  if (r.error) fail(`could not start git: ${r.error.message}`);
  if (r.status !== 0) fail(`git clone failed (exit code ${r.status})`);
  console.log(`Cloned projects/${name}.`);
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const root = opts.root ? resolve(opts.root) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, arg] = positional;

if (command === 'list' || !command) {
  const { error } = readRepos(root);
  if (error) console.log(`warning: ${error}`);
  const have = requirementStatus();
  for (const r of repoStatus(root)) {
    const needs = r.requires.map(q => `${q}${have[q] ? '' : ' (missing)'}`).join(', ');
    const state = r.present ? (r.originMatches ? 'cloned' : `cloned, origin differs: ${r.origin}`) : 'not on this PC';
    console.log(`${r.name.padEnd(20)} ${state}${needs ? `  needs ${needs}` : ''}  ${r.url}`);
  }
  for (const u of unlistedProjects(root)) {
    console.log(`${u.name.padEnd(20)} not listed: ${u.origin ? `add it with: node tools/projects.mjs add ${u.name}` : 'no origin remote yet'}`);
  }
} else if (command === 'clone' && opts.url) {
  const url = String(opts.url).trim();
  if (!GIT_URL.test(url)) fail('the url must start with https:// or git@ and contain no spaces or quotes');
  const name = opts.name || nameFromUrl(url);
  if (!NAME_RE.test(name)) fail(`"${name}" is not a kebab-case folder name; pass --name`);
  if (opts.add) {
    const r = addRepo(root, { name, url, requires: requiresOpt(opts) });
    if (r.error) fail(r.error);
    console.log(`Listed ${name} in projects/repos.json.`);
  }
  gitClone(root, name, url);
} else if (command === 'clone') {
  const entry = readRepos(root).repos.find(r => r.name === arg);
  if (!entry) fail(`${arg || '(no name)'} is not in projects/repos.json; use clone --url <url>`);
  gitClone(root, entry.name, entry.url);
} else if (command === 'add') {
  if (!NAME_RE.test(String(arg || ''))) fail('add needs a project folder name, e.g. add my-game');
  const dir = join(root, 'projects', arg);
  if (!existsSync(dir)) fail(`projects/${arg} was not found`);
  const url = originOf(dir);
  if (!url) fail(`projects/${arg} has no origin remote; push it to GitHub first (git remote add origin <url>)`);
  const r = addRepo(root, { name: arg, url, requires: requiresOpt(opts) });
  if (r.error) fail(r.error);
  console.log(`Listed ${arg} (${url}) in projects/repos.json. Commit the workspace so other PCs get it.`);
} else {
  fail(`unknown command "${command}"; use list, clone or add`);
}
