// Tests for tools/lib/projects.mjs: linking an existing checkout as projects/<name> (a junction),
// unlinking it without touching the checkout, and starting linked projects in their real folder.
// Run: node tools/run-tests.mjs
// Every test builds a throwaway hub and a scratch checkout in the temp folder (git repos with
// core.autocrlf=false and a synthetic "example" origin). Junction tests are skipped off Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectDir, resolveProject } from './lib/agents.mjs';
import {
  checkLinkTarget, isLinked, linkProject, normalizeGitUrl, normalizeWinPath, realProjectDir, redactUrl, sameGitUrl, samePath,
  unlinkProject,
} from './lib/projects.mjs';

const WIN = process.platform === 'win32';
const winOnly = { skip: !WIN && 'junctions are Windows-only' };
const URL = 'https://github.com/example-org/example.git';
const ID = '8c1e0a52-3b6d-4f0e-9a1b-2c3d4e5f6a7b';
const toolsDir = dirname(fileURLToPath(import.meta.url));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function makeRepo(dir, origin) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 't'], ['user.email', 't@t']]) git(dir, 'config', k, v);
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

// Links in a folder are removed one by one (rmdir, never recursive) before the folder itself
// goes, so cleaning up can never reach into a checkout through a junction.
function removeLinks(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (lstatSync(full).isSymbolicLink()) rmdirSync(full);
    else if (e.isDirectory()) removeLinks(full);
  }
}

// A hub (with projects/repos.json listing "example") and a scratch checkout of "example".
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'ws-link-'));
  t.after(() => { removeLinks(base); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'hub');
  put(join(root, 'projects', 'repos.json'), JSON.stringify({ repos: [{ name: 'example', url: URL, requires: [] }] }));
  const target = makeRepo(join(base, 'checkout', 'example'), URL);
  put(join(target, 'keep.txt'), 'keep me');
  put(join(target, 'src', 'deep.txt'), 'deep');
  return { base, root, target };
}

test('normalizeWinPath and samePath: one spelling per folder', winOnly, () => {
  assert.equal(normalizeWinPath('C:/x/'), 'c:\\x');
  assert.equal(normalizeWinPath('c:\\x'), 'c:\\x');
  assert.equal(normalizeWinPath('C:/x/'), normalizeWinPath('c:\\x'));
  assert.equal(normalizeWinPath('C:\\Users\\Me\\..\\Me\\code\\'), 'c:\\Users\\Me\\code');
  assert.equal(normalizeWinPath('C:\\'), 'c:\\');
  assert.equal(normalizeWinPath('C:/'), 'c:\\');
  assert.ok(samePath('C:/x/', 'c:\\X'));
  assert.ok(!samePath('C:\\a', 'C:\\ab'));
});

test('git URLs match however the repo was cloned; credentials never show', () => {
  for (const u of ['git@github.com:example-org/example.git', 'https://GitHub.com/example-org/example/', 'https://github.com/example-org/example',
    'ssh://git@github.com:22/example-org/example.git', `https://t:${'tok' + 'en'.repeat(10)}@github.com/example-org/example.git`]) {
    assert.ok(sameGitUrl(u, URL), u);
  }
  assert.equal(normalizeGitUrl('git@GitHub.com:Org/Repo.git'), 'https://github.com/Org/Repo');
  // GitHub and GitLab ignore the case of owner and repo; other hosts don't.
  assert.ok(sameGitUrl('https://github.com/Example-Org/Example.git', URL));
  assert.ok(sameGitUrl('git@gitlab.com:Example-Org/example.git', 'https://gitlab.com/example-org/example'));
  assert.ok(!sameGitUrl('https://git.example.com/Example-Org/example.git', 'https://git.example.com/example-org/example.git'));
  assert.ok(!sameGitUrl('https://github.com/example-org/other.git', URL));
  assert.ok(!sameGitUrl('https://gitlab.com/example-org/example.git', URL));
  assert.ok(!sameGitUrl('', URL));
  const secret = 'ghp_' + 'x'.repeat(30);
  assert.equal(redactUrl(`https://user:${secret}@github.com/o/r.git`), 'https://github.com/o/r.git');
  assert.equal(redactUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

test('checkLinkTarget refuses each bad request, in order, with a plain message', winOnly, async t => {
  const { base, root, target } = setup(t);
  put(join(root, 'projects', 'repos.json'), JSON.stringify({ repos: [
    { name: 'example', url: URL, requires: [] }, { name: 'taken', url: 'https://github.com/example-org/taken.git', requires: [] },
  ] }));
  mkdirSync(join(root, 'projects', 'taken'));
  makeRepo(join(root, 'inner'), URL);
  mkdirSync(join(base, 'plain'));
  mkdirSync(join(target, 'sub'));
  const noOrigin = makeRepo(join(base, 'no-origin'));
  const secret = 'ghp_' + 'y'.repeat(30);
  const wrongOrigin = makeRepo(join(base, 'wrong'), `https://u:${secret}@github.com/someone/else.git`);
  // A junction outside the hub that leads into it: only the real path shows it is inside.
  const via = join(base, 'via');
  symlinkSync(join(root, 'inner'), via, 'junction');

  const cases = [
    ['Example', target, 'invalid', /not a project name/],
    ['we;ird', target, 'invalid', /not a project name/],
    ['..', target, 'invalid', /not a project name/],
    ['../x', target, 'invalid', /not a project name/],
    ['other', 'not even a path', 'not-listed', /not in projects\/repos\.json/], // the name is checked before the path
    ['taken', target, 'exists', /projects\/taken already exists/],
    ['example', '', 'invalid', /full folder path/],
    ['example', 'checkout\\example', 'invalid', /not a full path/],
    ['example', '\\checkout\\example', 'invalid', /network path|not a full path/],
    ['example', '\\\\server\\share\\example', 'invalid', /network path/],
    ['example', '//server/share/example', 'invalid', /network path/],
    ['example', 'C:\\', 'invalid', /whole drive/],
    ['example', 'c:/', 'invalid', /whole drive/],
    ['example', join(root, 'inner'), 'invalid', /inside the workspace hub/],
    ['example', via, 'invalid', /inside the workspace hub/],
    ['example', root, 'invalid', /inside the workspace hub/],
    ['example', base, 'invalid', /contains the workspace hub/],
    ['example', join(target, 'keep.txt'), 'invalid', /not a folder/],
    ['example', join(base, 'missing'), 'invalid', /not a folder/],
    ['example', join(base, 'plain'), 'invalid', /not a git checkout/],
    ['example', join(target, 'sub'), 'invalid', /inside the git checkout .*Link the checkout's top folder/],
    ['example', noOrigin, 'invalid', /no origin remote/],
    ['example', wrongOrigin, 'invalid', /origin of .* is https:\/\/github\.com\/someone\/else\.git, but projects\/repos\.json lists/],
  ];
  for (const [name, path, code, re] of cases) {
    const r = await checkLinkTarget(root, name, path);
    assert.equal(r.code, code, `${name} ${path}: ${r.error}`);
    assert.match(r.error, re, `${name} ${path}`);
    assert.equal(r.realPath, '');
    assert.ok(!r.error.includes(secret), 'credentials are never shown');
  }
  for (const bad of [null, 42, { path: target }]) assert.equal((await checkLinkTarget(root, 'example', bad)).code, 'invalid');

  // Accepted: forward slashes and a trailing slash, and an scp-style origin of the same repo.
  const ok = await checkLinkTarget(root, 'example', `${target.replace(/\\/g, '/')}/`);
  assert.deepEqual([ok.error, ok.code, ok.origin], ['', '', URL]);
  assert.ok(samePath(ok.realPath, target));
  const scp = makeRepo(join(base, 'scp', 'example'), 'git@github.com:example-org/example.git');
  assert.equal((await checkLinkTarget(root, 'example', scp)).error, '');
  const otherCase = makeRepo(join(base, 'case', 'example'), 'https://github.com/Example-Org/Example.git');
  assert.equal((await checkLinkTarget(root, 'example', otherCase)).error, '');
  assert.ok(!existsSync(projectDir(root, 'example')), 'a check changes nothing');
});

test('link and unlink a scratch junction: the checkout and its files are untouched', winOnly, async t => {
  const { root, target } = setup(t);
  const before = { keep: statSync(join(target, 'keep.txt')).mtimeMs, deep: statSync(join(target, 'src', 'deep.txt')).mtimeMs, list: readdirSync(target).sort() };

  const linked = await linkProject(root, 'example', target);
  assert.ok(samePath(linked.realPath, target));
  assert.equal(linked.origin, URL);
  const link = projectDir(root, 'example');
  assert.ok(lstatSync(link).isSymbolicLink(), 'a junction, not a copy');
  assert.ok(isLinked(root, 'example'));
  assert.ok(samePath(realProjectDir(root, 'example'), target));
  assert.equal(resolveProject(root, 'example').name, 'example', 'the hub finds it by name');
  assert.equal(readFileSync(join(link, 'keep.txt'), 'utf8'), 'keep me');

  // Linking again, or over the link, is refused.
  await assert.rejects(linkProject(root, 'example', target), e => e.code === 'exists' && /already exists/.test(e.message));

  const r = unlinkProject(root, 'example');
  assert.ok(samePath(r.target, target), r.target);
  assert.throws(() => lstatSync(link), /ENOENT/);
  assert.ok(!isLinked(root, 'example'));
  // The checkout is all there, unchanged.
  assert.deepEqual(readdirSync(target).sort(), before.list);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep me');
  assert.equal(readFileSync(join(target, 'src', 'deep.txt'), 'utf8'), 'deep');
  assert.equal(statSync(join(target, 'keep.txt')).mtimeMs, before.keep);
  assert.equal(statSync(join(target, 'src', 'deep.txt')).mtimeMs, before.deep);
  assert.ok(existsSync(join(target, '.git')));

  assert.throws(() => unlinkProject(root, 'example'), e => e.code === 'missing');
  // It can be linked again after an unlink.
  await linkProject(root, 'example', target);
  assert.ok(isLinked(root, 'example'));
  unlinkProject(root, 'example');
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep me');
});

test('unlink refuses a real folder and leaves it whole', winOnly, t => {
  const { root } = setup(t);
  const real = put(join(root, 'projects', 'game', 'notes.md'), 'mine');
  assert.throws(() => unlinkProject(root, 'game'), e => e.code === 'not-link' && /real folder, not a link/.test(e.message));
  assert.equal(readFileSync(real, 'utf8'), 'mine');
  for (const bad of ['..', '../hub', 'a/b', 'Game', '']) assert.throws(() => unlinkProject(root, bad), e => e.code === 'invalid', bad);
  assert.ok(existsSync(real));
});

test('R24: projects.mjs has no way to delete a folder tree (only rmdirSync or unlinkSync on the link itself)', () => {
  const src = readFileSync(join(toolsDir, 'lib', 'projects.mjs'), 'utf8');
  assert.doesNotMatch(src, /\brmSync\b|\brm\(|\bfsp?\.rm\b|\bpromises\b|rimraf|Remove-Item|rmdir \/s|\bdel \//i);
  // The one recursive option creates projects/ before linking.
  assert.deepEqual(src.match(/recursive:\s*true/g), ['recursive: true']);
  assert.match(src, /mkdirSync\(dirname\(link\), \{ recursive: true \}\)/);
  assert.match(src, /\brmdirSync\(link\)/);
});

test('realProjectDir: normal folders stay as they are; a broken link says so and can still be unlinked', winOnly, t => {
  const { base, root } = setup(t);
  mkdirSync(join(root, 'projects', 'plain'));
  assert.equal(realProjectDir(root, 'plain'), projectDir(root, 'plain'));
  assert.ok(!isLinked(root, 'plain'));
  const gone = join(base, 'gone');
  mkdirSync(gone);
  symlinkSync(gone, projectDir(root, 'broken'), 'junction');
  rmdirSync(gone);
  assert.ok(isLinked(root, 'broken'));
  assert.throws(() => realProjectDir(root, 'broken'), e => e.status === 404 && /links to a folder that is gone/.test(e.message));
  unlinkProject(root, 'broken');
  assert.ok(!isLinked(root, 'broken'));
});

test('agent-session.mjs starts a linked project\'s agent in the real folder, with the session id', winOnly, async t => {
  const { base, root, target } = setup(t);
  put(join(target, '.claude', 'agents', 'artist.md'), '---\nname: artist\ndescription: Draws.\nmemory: project\n---\n');
  await linkProject(root, 'example', target);
  // A stand-in claude.exe first on PATH: --print only prints, so nothing is started.
  const bin = join(base, 'bin');
  put(join(bin, 'claude.exe'), '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  env.PATH = [bin, dirname(process.execPath)].join(delimiter);
  const out = execFileSync(process.execPath, [join(toolsDir, 'agent-session.mjs'), 'example', 'artist', '--print', '--root', root, '--session-id', ID],
    { encoding: 'utf8', env, windowsHide: true });
  const printed = JSON.parse(out);
  assert.ok(samePath(printed.cwd, target), printed.cwd);
  assert.equal(printed.command, join(bin, 'claude.exe'));
  assert.deepEqual(printed.args.slice(0, 2), ['--agent', 'artist']);
  assert.deepEqual(printed.args.slice(-2), ['--session-id', ID]);
  const bad = (() => {
    try { execFileSync(process.execPath, [join(toolsDir, 'agent-session.mjs'), 'example', 'artist', '--print', '--root', root, '--session-id', 'nope'], { encoding: 'utf8', env, windowsHide: true, stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); }
  })();
  assert.match(bad, /--session-id needs a session id/);
  unlinkProject(root, 'example');
});
