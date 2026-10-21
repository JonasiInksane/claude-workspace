// Tests for tools/lib/repos.mjs and tools/projects.mjs.
// Run: node tools/run-tests.mjs
// Each test builds a throwaway workspace root in the temp folder; git repos there get fake
// remotes and nothing is fetched or pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { addRepo, checkEntry, nameFromUrl, readRepos, repoStatus, unlistedProjects } from './lib/repos.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));

function fixture(t, repos) {
  const root = mkdtempSync(join(tmpdir(), 'ws-repos-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projects'), { recursive: true });
  if (repos) writeFileSync(join(root, 'projects', 'repos.json'), JSON.stringify({ repos }));
  return root;
}

function gitRepo(dir, origin) {
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  if (origin) spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

const run = (root, ...args) => spawnSync(process.execPath, [join(toolsDir, 'projects.mjs'), ...args, '--root', root], { encoding: 'utf8' });

test('nameFromUrl and checkEntry', () => {
  assert.equal(nameFromUrl('https://github.com/me/My_Game.git'), 'my-game');
  assert.equal(nameFromUrl('git@github.com:me/tools.git'), 'tools');
  assert.equal(checkEntry({ name: 'game-dev', url: 'https://github.com/me/game-dev.git', requires: ['git-lfs'] }), '');
  for (const bad of [{ name: 'Game Dev', url: 'https://x/y.git' }, { name: 'a', url: 'file:///C:/x' }, { name: 'a', url: 'https://x/y";calc' },
    { name: 'a', url: '--upload-pack=x' }, { name: 'a', url: 'https://x/y.git', requires: ['photoshop'] }]) {
    assert.notEqual(checkEntry(bad), '', JSON.stringify(bad));
  }
});

test('readRepos skips bad entries and reports bad JSON', t => {
  const root = fixture(t, [{ name: 'ok', url: 'https://github.com/me/ok.git' }, { name: 'Bad Name', url: 'https://x/y.git' }]);
  const r = readRepos(root);
  assert.deepEqual(r.repos.map(x => x.name), ['ok']);
  assert.match(r.error, /Bad Name/);
  writeFileSync(join(root, 'projects', 'repos.json'), '{ nope');
  assert.match(readRepos(root).error, /not valid JSON/);
  assert.deepEqual(readRepos(fixture(t)).repos, []);
});

test('addRepo appends, refuses duplicates and keeps the file valid', t => {
  const root = fixture(t, [{ name: 'one', url: 'https://github.com/me/one.git' }]);
  assert.equal(addRepo(root, { name: 'two', url: 'https://github.com/me/two.git', requires: ['blender-5.2', 'blender-5.2'] }).error, '');
  assert.match(addRepo(root, { name: 'two', url: 'https://github.com/me/two.git' }).error, /already/);
  assert.match(addRepo(root, { name: 'three', url: 'ftp://x' }).error, /https/);
  const data = JSON.parse(readFileSync(join(root, 'projects', 'repos.json'), 'utf8'));
  assert.deepEqual(data.repos, [
    { name: 'one', url: 'https://github.com/me/one.git', requires: [] },
    { name: 'two', url: 'https://github.com/me/two.git', requires: ['blender-5.2'] },
  ]);
});

test('repoStatus and unlistedProjects see what is cloned, its origin, and what is not listed', t => {
  const root = fixture(t, [
    { name: 'here', url: 'https://github.com/me/here.git' },
    { name: 'moved', url: 'https://github.com/me/moved.git' },
    { name: 'away', url: 'https://github.com/me/away.git' },
  ]);
  gitRepo(join(root, 'projects', 'here'), 'https://github.com/me/here.git');
  gitRepo(join(root, 'projects', 'moved'), 'https://github.com/other/moved.git');
  gitRepo(join(root, 'projects', 'extra'), 'https://github.com/me/extra.git');
  gitRepo(join(root, 'projects', 'local-only'));
  mkdirSync(join(root, 'projects', '_scratch'));
  assert.deepEqual(repoStatus(root).map(r => [r.name, r.present, r.originMatches]), [['here', true, true], ['moved', true, false], ['away', false, true]]);
  assert.deepEqual(unlistedProjects(root).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'extra', origin: 'https://github.com/me/extra.git' }, { name: 'local-only', origin: '' }]);
});

test('projects.mjs add lists a folder by its origin; clone refuses unknown names and existing folders', t => {
  const root = fixture(t, []);
  gitRepo(join(root, 'projects', 'extra'), 'https://github.com/me/extra.git');
  gitRepo(join(root, 'projects', 'local-only'));
  assert.equal(run(root, 'add', 'extra', '--requires', 'git-lfs').status, 0);
  assert.deepEqual(readRepos(root).repos, [{ name: 'extra', url: 'https://github.com/me/extra.git', requires: ['git-lfs'] }]);
  assert.match(run(root, 'add', 'local-only').stderr, /no origin remote/);
  assert.match(run(root, 'add', 'extra').stderr, /already/);
  assert.match(run(root, 'clone', 'ghost').stderr, /not in projects\/repos.json/);
  assert.match(run(root, 'clone', 'extra').stderr, /already exists/);
  assert.match(run(root, 'clone', '--url', 'https://x y').stderr, /url must start/);
  assert.match(run(root, 'list').stdout, /extra\s+cloned/);
});
