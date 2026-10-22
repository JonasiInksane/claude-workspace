// Tests for core/glob.mjs: a table of glob cases, nocase, and a folder walk that skips junctions
// (including a junction loop). Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SKIP_DIRS, firstMatch, globToRegExp, matchAny, toPosix, walk } from './glob.mjs';
import { tempDir, writeFiles } from '../test/helpers.mjs';

// [glob, path, expected]
const CASES = [
  ['*.md', 'README.md', true],
  ['*.md', 'docs/README.md', false],
  ['*.md', '.md', true],
  ['**/*.md', 'README.md', true],
  ['**/*.md', 'docs/a/b/README.md', true],
  ['**/.env', '.env', true],
  ['**/.env', 'apps/api/.env', true],
  ['**/.env', 'apps/api/.env.local', false],
  ['**/.env.*', 'apps/web/.env.production', true],
  ['**/.env.*', '.env', false],
  ['**/.env*', '.envrc', true],
  ['.claude/**', '.claude/settings.json', true],
  ['.claude/**', '.claude', true],
  ['.claude/**', 'x/.claude/settings.json', false],
  ['**/.claude/**', 'apps/x/.claude/agents/a.md', true],
  ['apps/api/src/billing/**', 'apps/api/src/billing/charge.mjs', true],
  ['apps/api/src/billing/**', 'apps/api/src/billing/deep/er/x.mjs', true],
  ['apps/api/src/billing/**', 'apps/api/src/billingx/x.mjs', false],
  ['apps/api/src/billing/**', 'apps/api/src/bill/x.mjs', false],
  ['apps/**/router.mjs', 'apps/router.mjs', true],
  ['apps/**/router.mjs', 'apps/api/src/routes/items/router.mjs', true],
  ['apps/**/router.mjs', 'apps/api/src/routes/items/router.mjs.bak', false],
  ['apps/*/src/x.ts', 'apps/web/src/x.ts', true],
  ['apps/*/src/x.ts', 'apps/web/deep/src/x.ts', false],
  ['src/**/*.{ts,tsx}', 'src/a/b.tsx', true],
  ['src/**/*.{ts,tsx}', 'src/a/b.jsx', false],
  ['*.{ts,tsx,md}', 'notes.md', true],
  ['{a,b/{c,d}}/x', 'b/d/x', true],
  ['{a,b/{c,d}}/x', 'b/e/x', false],
  ['file?.txt', 'file1.txt', true],
  ['file?.txt', 'file12.txt', false],
  ['file?.txt', 'file/.txt', false],
  ['**/tsconfig*.json', 'apps/web/tsconfig.build.json', true],
  ['**/*.config.*', 'apps/web/next.config.mjs', true],
  ['**/*.config.*', 'apps/web/configs/x.mjs', false],
  ['wrapUp*', 'wrapUpHelpers.ts', true],
  ['a**b', 'aXYb', true],
  ['a**b', 'a/b', false],
  ['**', 'anything/at/all.txt', true],
  ['a/**/b', 'a/b', true],
  ['a/**/b', 'a/x/y/b', true],
  ['a/**/b', 'a/xb', false],
  ['x.(y)+[z]', 'x.(y)+[z]', true],
  ['x.(y)+[z]', 'xx(y)+[z]', false],
  ['\\*.md', '*.md', true],
  ['\\*.md', 'a.md', false],
  ['{unclosed', '{unclosed', true],
  ['a,b', 'a,b', true],
  ['./docs/*.md', 'docs/a.md', true],
  ['{**/x,y}', 'deep/x', true],
];

test(`glob table (${CASES.length} cases)`, () => {
  assert.ok(CASES.length >= 30);
  for (const [glob, path, want] of CASES) {
    assert.equal(globToRegExp(glob).test(path), want, `${glob} vs ${path}`);
  }
});

test('globs are anchored and case-sensitive unless nocase', () => {
  assert.equal(globToRegExp('*.md').test('x.md.bak'), false);
  assert.equal(globToRegExp('**/.env').test('apps/.ENV'), false);
  assert.equal(globToRegExp('**/.env', { nocase: true }).test('apps/.ENV'), true);
  assert.equal(globToRegExp('**/.env').flags, '');
  assert.throws(() => globToRegExp(null), /must be a string/);
});

test('matchAny and firstMatch accept Windows separators and ./ in the path', () => {
  const globs = ['apps/api/src/auth/**', 'apps/api/src/billing/**'];
  assert.equal(matchAny(globs, 'apps\\api\\src\\billing\\x.mjs'), true);
  assert.equal(matchAny(globs, './apps/api/src/auth/session.mjs'), true);
  assert.equal(matchAny(globs, 'apps/web/src/x.mjs'), false);
  assert.equal(firstMatch(globs, 'apps/api/src/billing/a.mjs'), 'apps/api/src/billing/**');
  assert.equal(firstMatch(globs, 'nope'), null);
  assert.equal(matchAny([], 'x'), false);
  assert.equal(matchAny(undefined, 'x'), false);
  assert.equal(toPosix('.\\a\\b'), 'a/b');
});

function junction(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

test('walk lists files as sorted posix paths, with pattern, exclude and skipDirs', async t => {
  const dir = tempDir('ws-walk-', t);
  writeFiles(dir, {
    'b.txt': 'x', 'a.test.mjs': 'x', 'src/x.test.mjs': 'x', 'src/x.mjs': 'x', 'src/deep/y.test.mjs': 'x',
    'node_modules/pkg/z.test.mjs': 'x', '.git/HEAD': 'x', '.next/c.test.mjs': 'x', 'gen/skip.test.mjs': 'x', '.env': 'x',
  });
  assert.deepEqual(await walk(dir), ['.env', 'a.test.mjs', 'b.txt', 'gen/skip.test.mjs', 'src/deep/y.test.mjs', 'src/x.mjs', 'src/x.test.mjs']);
  assert.deepEqual(await walk(dir, { pattern: /\.test\.mjs$/g, exclude: ['gen/**'] }), ['a.test.mjs', 'src/deep/y.test.mjs', 'src/x.test.mjs']);
  assert.deepEqual(await walk(join(dir, 'src'), { exclude: ['**/*.test.mjs'] }), ['x.mjs']);
  assert.deepEqual(await walk(dir, { pattern: /z\.test/, skipDirs: [] }), ['node_modules/pkg/z.test.mjs']);
  assert.deepEqual(DEFAULT_SKIP_DIRS, ['node_modules', '.git', '.turbo', '.next']);
  assert.deepEqual(await walk(join(dir, 'missing')), []);
});

test('walk skips a junction loop and never follows a junction out of the tree', async t => {
  const dir = tempDir('ws-walk-', t);
  const outside = tempDir('ws-walk-outside-', t);
  writeFiles(dir, { 'a/file.txt': 'x' });
  writeFiles(outside, { 'secret.txt': 'x' });
  junction(dir, join(dir, 'a', 'loop'));
  junction(outside, join(dir, 'out'));
  const files = await walk(dir);
  assert.deepEqual(files, ['a/file.txt']);
});

test('walk skips file symlinks when the OS lets us create one', async t => {
  const dir = tempDir('ws-walk-', t);
  writeFileSync(join(dir, 'real.txt'), 'x');
  try {
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'), 'file');
  } catch {
    t.skip('this account cannot create file symlinks');
    return;
  }
  assert.deepEqual(await walk(dir), ['real.txt']);
});

test('walk stops when its signal is aborted', async t => {
  const dir = tempDir('ws-walk-', t);
  mkdirSync(join(dir, 'a'));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(walk(dir, { signal: ac.signal }), { name: 'AbortError' });
});
