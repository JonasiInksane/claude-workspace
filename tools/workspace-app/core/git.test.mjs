// Tests for core/git.mjs. Run: node --test tools/workspace-app/core/git.test.mjs
// Every test builds throwaway repos under the temp folder (core.autocrlf=false, user t <t@t>);
// nothing is fetched and no remote is contacted. Test code may run any git command it likes to
// build a situation; the module under test is what must stay read-only or index-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GitError, allDone, appBranches, assertRev, changedFiles, cleanPath, clearGitCache, commitTree, diffNames, diffText,
  existsAt, expandBraces, fileAt, git, gitPaths, headInfo, isSecretFile, logSince, lsFilesAt, mergedInto,
  operationInProgress, originUrl, parseStatus, repoSummary, revCount, stashSummary, statusSummary, toplevel, treeHash,
  worktreeKind, worktrees, SUMMARY_TTL_MS,
} from './git.mjs';

// ---------------------------------------------------------------- helpers (test-only, sync)

function sh(dir, args, env = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function tempRoot(t, prefix = 'ws-git-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  return dir;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function makeRepo(dir, files = {}, msg = 'init') {
  mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  const config = { 'core.autocrlf': 'false', 'user.name': 't', 'user.email': 't@t', 'commit.gpgsign': 'false', 'core.hooksPath': join(dir, '.git', 'hooks') };
  for (const [k, v] of Object.entries(config)) sh(dir, ['config', k, v]);
  writeFiles(dir, files);
  if (!msg) return null;
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', msg]);
  return sh(dir, ['rev-parse', 'HEAD']);
}

function commitAll(dir, msg, date = null) {
  sh(dir, ['add', '-A']);
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
  sh(dir, ['commit', '-q', '-m', msg], env);
  return sh(dir, ['rev-parse', 'HEAD']);
}

const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const read = (dir, rel) => readFileSync(join(dir, rel));

// ---------------------------------------------------------------- git()

test('git returns stdout, honours okCodes and full, and throws GitError with code and stderr', async t => {
  const dir = join(tempRoot(t), 'r');
  const sha = makeRepo(dir, { 'a.txt': 'a\n' });
  assert.equal((await git(dir, ['rev-parse', 'HEAD'])).trim(), sha);
  const buf = await git(dir, ['cat-file', 'blob', 'HEAD:a.txt'], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'a\n');
  const miss = await git(dir, ['rev-parse', '-q', '--verify', 'refs/heads/nope'], { okCodes: [0, 1], full: true });
  assert.equal(miss.code, 1);
  await assert.rejects(git(dir, ['rev-parse', '--verify', 'nope']), e => {
    assert.ok(e instanceof GitError);
    assert.equal(e.code, 128);
    assert.match(e.message, /^git rev-parse failed in /);
    assert.match(e.stderr, /nope|Needed a single revision/);
    return true;
  });
  await assert.rejects(git(join(dir, 'missing'), ['status']), GitError);
  await assert.rejects(git('', ['status']), /needs a folder/);
  await assert.rejects(git(dir, ['status', 3]), /plain strings/);
  await assert.rejects(git(dir, ['status', 'a\0b']), /plain strings/);
});

test('git stops a command at its timeout and on an aborted signal', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  // A shell alias that sleeps stands in for a slow git command.
  await assert.rejects(git(dir, ['-c', 'alias.slow=!sleep 1', 'slow'], { timeoutMs: 200 }), e => e.code === 'TIMEOUT' && /took longer than/.test(e.message));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(git(dir, ['status'], { signal: ac.signal }), e => e.code === 'ABORTED');
  const later = new AbortController();
  const p = git(dir, ['-c', 'alias.slow=!sleep 1', 'slow'], { signal: later.signal });
  setTimeout(() => later.abort(), 100);
  await assert.rejects(p, e => e.code === 'ABORTED' && /was cancelled/.test(e.message));
  // timeoutMs 0 means no timeout.
  assert.equal((await git(dir, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 0 })).trim(), 'true');
});

test('git passes one-off settings with config, and refuses keys that could smuggle options', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  assert.equal((await git(dir, ['config', '--get', 'demo.value'], { config: { 'demo.value': 'abc' } })).trim(), 'abc');
  assert.equal((await git(dir, ['config', '--get', 'demo.value'], { full: true, okCodes: [0, 1] })).code, 1, 'never written to the repo');
  for (const bad of ['-x', 'a b.c', 'alias', 'core.x\n']) {
    await assert.rejects(git(dir, ['status'], { config: { [bad]: '1' } }), /not a git setting/, bad);
  }
  await assert.rejects(git(dir, ['status'], { config: { 'core.x': 'a\nb' } }), /not a git setting/);
});

test('a timeout kills what git started too (a hook or an alias shell), not only git.exe', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  // The alias's shell writes late.txt after 1.5 s unless it is killed along with git.
  await assert.rejects(git(dir, ['-c', 'alias.slow=!sleep 1.5; echo late > late.txt', 'slow'], { timeoutMs: 300 }), e => e.code === 'TIMEOUT');
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(existsSync(join(dir, 'late.txt')), false, 'the shell under git was killed');
});

test('a timeout or cancel ends the call even when git has exited and a background process keeps its output open', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  // The alias's shell starts sleep in the background and exits at once, so git.exe is gone while
  // sleep still holds git's stdout and stderr. Without closing the pipes the call would wait 3 s.
  const bg = ['-c', 'alias.bg=!sleep 3 &', 'bg'];
  let t0 = Date.now();
  await assert.rejects(git(dir, bg, { timeoutMs: 400 }), e => e.code === 'TIMEOUT' && /took longer than 400 ms/.test(e.message));
  const timedOut = Date.now() - t0;
  assert.ok(timedOut < 2000, `the timeout ended the call after ${timedOut} ms`);
  const ac = new AbortController();
  t0 = Date.now();
  const p = git(dir, bg, { signal: ac.signal });
  setTimeout(() => ac.abort(), 400);
  await assert.rejects(p, e => e.code === 'ABORTED');
  const cancelled = Date.now() - t0;
  assert.ok(cancelled < 2000, `the cancel ended the call after ${cancelled} ms`);
  // The orphaned sleep has the repo as its folder; let it finish before the temp folder goes.
  await new Promise(r => setTimeout(r, 3200 - Math.min(timedOut, cancelled)));
});

test('allDone waits for every call before throwing the first error', async () => {
  const order = [];
  const slow = new Promise(r => setTimeout(() => { order.push('slow done'); r('slow'); }, 80));
  const bad = Promise.reject(new Error('first failure'));
  await assert.rejects(allDone([slow, bad]), /first failure/);
  assert.deepEqual(order, ['slow done']);
  assert.deepEqual(await allDone([Promise.resolve(1), 2]), [1, 2]);
});

test('git ignores GIT_DIR and GIT_INDEX_FILE from the app environment', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = join(root, 'elsewhere');
  process.env.GIT_INDEX_FILE = join(root, 'other.index');
  t.after(() => {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.index === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved.index;
  });
  assert.ok(same(await toplevel(dir), dir));
  assert.equal((await statusSummary(dir)).clean, true);
});

test('assertRev and cleanPath refuse values that could become options or escape the repo', () => {
  for (const ok of ['HEAD', 'main', 'app/1022-x', 'abc1234', 'HEAD~2', 'main^{tree}']) assert.equal(assertRev(ok), ok);
  for (const bad of ['', '-x', '--output=x', 'a b', 'a..b', 'a\nb', '@{-1}']) assert.throws(() => assertRev(bad), GitError, bad);
  assert.equal(cleanPath('./apps\\web/x.ts'), 'apps/web/x.ts');
  for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', 'a\0b']) assert.throws(() => cleanPath(bad), GitError, bad);
});

// ---------------------------------------------------------------- where am I

test('toplevel, worktreeKind and headInfo (branch, detached, unborn)', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  const sha = makeRepo(dir, { 'sub/a.txt': 'a\n' });
  assert.ok(same(await toplevel(join(dir, 'sub')), dir));
  assert.equal(await worktreeKind(dir), 'main');
  sh(dir, ['worktree', 'add', '-q', '--detach', join(root, 'wt'), 'HEAD']);
  assert.equal(await worktreeKind(join(root, 'wt')), 'linked');

  const h = await headInfo(dir);
  assert.deepEqual([h.sha, h.short, h.branch, h.detached, h.unborn, h.subject], [sha, sha.slice(0, 7), 'main', false, false, 'init']);
  assert.match(h.at, /^\d{4}-\d\d-\d\dT/);
  const d = await headInfo(join(root, 'wt'));
  assert.equal(d.detached, true);
  assert.equal(d.branch, null);
  assert.equal(d.sha, sha);

  const empty = join(root, 'empty');
  makeRepo(empty, {}, null);
  const u = await headInfo(empty);
  assert.equal(u.unborn, true);
  assert.equal(u.sha, null);
  assert.equal(u.branch, 'main');
  mkdirSync(join(root, 'plain'));
  await assert.rejects(headInfo(join(root, 'plain')), GitError);
});

// ---------------------------------------------------------------- status

test('statusSummary counts staged, unstaged, untracked and renamed files, and ahead/behind', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'old name.txt': 'o\n', 'x.txt': 'x\n' });
  sh(dir, ['branch', 'base']);
  writeFiles(dir, { 'n.txt': 'n\n' });
  commitAll(dir, 'second');
  sh(dir, ['branch', '-q', '--set-upstream-to=base']);
  writeFiles(dir, { 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'ünï code.txt': 'u\n', 'new/deep/f.txt': 'f\n' });
  sh(dir, ['add', 'b.txt']);
  sh(dir, ['mv', 'old name.txt', 'new name.txt']);
  sh(dir, ['rm', '-q', 'x.txt']);
  const s = await statusSummary(dir);
  assert.equal(s.branch, 'main');
  assert.equal(s.detached, false);
  assert.equal(s.upstream, 'base');
  assert.deepEqual([s.ahead, s.behind], [1, 0]);
  const byPath = Object.fromEntries(s.files.map(f => [f.path, f]));
  assert.equal(byPath['a.txt'].y, 'M');
  assert.equal(byPath['b.txt'].x, 'M');
  assert.equal(byPath['new name.txt'].kind, 'renamed');
  assert.equal(byPath['new name.txt'].oldPath, 'old name.txt');
  assert.equal(byPath['x.txt'].x, 'D');
  assert.equal(byPath['ünï code.txt'].kind, 'untracked');
  assert.equal(byPath['new/deep/f.txt'].kind, 'untracked');
  assert.deepEqual([s.changed, s.staged, s.unstaged, s.untracked, s.clean], [6, 3, 1, 2, false]);
});

test('parseStatus reads conflicts, a detached head and an unborn branch', () => {
  const out = ['# branch.oid (initial)', '# branch.head (detached)',
    'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 both sides.txt', '? new.txt', ''].join('\0');
  const s = parseStatus(out);
  assert.equal(s.sha, null);
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.conflicted, 1);
  assert.equal(s.files[0].path, 'both sides.txt');
  assert.equal(s.untracked, 1);
});

test('stashSummary reads the stash reflog like git stash list does', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  assert.deepEqual(await stashSummary(dir, 'main'), { total: 0, onBranch: 0 });
  // Test setup only: the module itself never runs the stash command.
  writeFiles(dir, { 'a.txt': 'a2\n' });
  sh(dir, ['stash', 'push', '-q', '-m', 'mine']);
  writeFiles(dir, { 'a.txt': 'a3\n' });
  sh(dir, ['stash', 'push', '-q']);
  sh(dir, ['switch', '-q', '-c', 'other']);
  writeFiles(dir, { 'a.txt': 'a4\n' });
  sh(dir, ['stash', 'push', '-q']);
  const listed = sh(dir, ['stash', 'list', '--format=%gs']).split('\n');
  assert.equal(listed.length, 3);
  assert.deepEqual(await stashSummary(dir, 'main'), { total: 3, onBranch: 2 });
  assert.deepEqual(await stashSummary(dir, 'other'), { total: 3, onBranch: 1 });
  assert.deepEqual(await stashSummary(dir), { total: 3, onBranch: 0 });
});

test('operationInProgress sees a half-done merge, rebase or cherry-pick, per worktree', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  sh(dir, ['worktree', 'add', '-q', '--detach', join(root, 'wt'), 'HEAD']);
  assert.equal(await operationInProgress(dir), null);
  const [mergeHead, rebase] = await gitPaths(dir, ['MERGE_HEAD', 'rebase-merge']);
  assert.ok(same(mergeHead, join(dir, '.git', 'MERGE_HEAD')));
  assert.ok(same(rebase, join(dir, '.git', 'rebase-merge')));
  await assert.rejects(gitPaths(dir, ['../config']), /not a git folder entry/);

  // A real merge conflict (test setup only).
  sh(dir, ['switch', '-q', '-c', 'side']);
  writeFiles(dir, { 'a.txt': 'side\n' });
  commitAll(dir, 'side');
  sh(dir, ['switch', '-q', 'main']);
  writeFiles(dir, { 'a.txt': 'main\n' });
  commitAll(dir, 'main');
  const r = spawnSync('git', ['-C', dir, 'merge', 'side'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(r.status, 0, 'the merge stops on the conflict');
  assert.equal(await operationInProgress(dir), 'merge');
  assert.equal(await operationInProgress(join(root, 'wt')), null, 'the other worktree is not affected');
  sh(dir, ['merge', '--abort']);
  assert.equal(await operationInProgress(dir), null);

  mkdirSync(join(dir, '.git', 'rebase-merge'));
  assert.equal(await operationInProgress(dir), 'rebase');
  rmSync(join(dir, '.git', 'rebase-merge'), { recursive: true });
  const [cp] =await gitPaths(join(root, 'wt'), ['CHERRY_PICK_HEAD']);
  writeFileSync(cp, sh(dir, ['rev-parse', 'HEAD']));
  assert.equal(await operationInProgress(join(root, 'wt')), 'cherry-pick');
  assert.equal(await operationInProgress(dir), null);
});

// ---------------------------------------------------------------- branches and worktrees

test('appBranches lists app/ branches newest first with merged flags and worktree paths', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  sh(dir, ['branch', 'app/0101-merged']);
  sh(dir, ['branch', 'apple']);
  sh(dir, ['switch', '-q', '-c', 'app/0102-open']);
  writeFiles(dir, { 'b.txt': 'b\n' });
  commitAll(dir, 'open work', '2030-01-02T10:00:00Z');
  sh(dir, ['switch', '-q', 'main']);
  sh(dir, ['worktree', 'add', '-q', join(root, 'wt'), 'app/0102-open']);
  sh(dir, ['branch', 'archive/app/0001-old']);

  const list = await appBranches(dir, { prefix: 'app/', into: 'main' });
  assert.deepEqual(list.map(b => b.name), ['app/0102-open', 'app/0101-merged']);
  assert.equal(list[0].merged, false);
  assert.equal(list[1].merged, true);
  assert.ok(same(list[0].worktree, join(root, 'wt')));
  assert.equal(list[1].worktree, null);
  assert.equal(list[0].subject, 'open work');
  assert.match(list[0].sha, /^[0-9a-f]{40}$/);
  assert.equal((await appBranches(dir))[0].merged, null);
  assert.deepEqual((await appBranches(dir, { prefix: 'archive/app/' })).map(b => b.name), ['archive/app/0001-old']);

  assert.deepEqual((await mergedInto(dir, 'main', { prefix: 'app/' })).sort(), ['app/0101-merged']);
  assert.ok((await mergedInto(dir, 'main')).includes('apple'));
  await assert.rejects(mergedInto(dir, '--all'), GitError);
});

test('worktrees lists the main checkout first, then linked ones with branch or detached', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  const sha = makeRepo(dir, { 'a.txt': 'a\n' });
  sh(dir, ['worktree', 'add', '-q', '--detach', join(root, 'run'), 'HEAD']);
  sh(dir, ['worktree', 'add', '-q', '-b', 'app/0101-x', join(root, 'side')]);
  const list = await worktrees(dir);
  assert.equal(list.length, 3);
  assert.ok(list[0].main && same(list[0].path, dir) && list[0].branch === 'main');
  const run = list.find(w => same(w.path, join(root, 'run')));
  assert.deepEqual([run.main, run.detached, run.branch, run.head], [false, true, null, sha]);
  assert.equal(list.find(w => same(w.path, join(root, 'side'))).branch, 'app/0101-x');
});

// ---------------------------------------------------------------- what changed

test('changedFiles reports A, M, D and R against base, with untracked files', async t => {
  const dir = join(tempRoot(t), 'r');
  const base = makeRepo(dir, { 'keep.txt': 'k\n', 'mod.txt': 'm\n', 'del.txt': 'd\n', 'ren.txt': 'r\n'.repeat(20) });
  writeFiles(dir, { 'mod.txt': 'm2\n', 'staged-new.txt': 's\n', 'untracked/u.txt': 'u\n' });
  sh(dir, ['add', 'staged-new.txt']);
  sh(dir, ['rm', '-q', 'del.txt']);
  sh(dir, ['mv', 'ren.txt', 'renamed.txt']);
  const files = await changedFiles(dir, base);
  assert.deepEqual(files, [
    { path: 'del.txt', status: 'D' },
    { path: 'mod.txt', status: 'M' },
    { path: 'renamed.txt', status: 'R', oldPath: 'ren.txt' },
    { path: 'staged-new.txt', status: 'A' },
    { path: 'untracked/u.txt', status: 'A' },
  ]);
  assert.ok(!(await changedFiles(dir, base, { includeUntracked: false })).some(f => f.path === 'untracked/u.txt'));
  const head = commitAll(dir, 'all');
  assert.deepEqual((await changedFiles(dir, base, { head })).map(f => `${f.status} ${f.path}`),
    ['D del.txt', 'M mod.txt', 'R renamed.txt', 'A staged-new.txt', 'A untracked/u.txt']);
  await assert.rejects(changedFiles(dir, '--cached'), GitError);
});

test('expandBraces expands alternatives for git glob pathspecs', () => {
  assert.deepEqual(expandBraces('a/*.ts'), ['a/*.ts']);
  assert.deepEqual(expandBraces('src/{a,b}/*.{ts,tsx}').sort(), ['src/a/*.ts', 'src/a/*.tsx', 'src/b/*.ts', 'src/b/*.tsx']);
  assert.deepEqual(expandBraces('{x,{y,z}}.json').sort(), ['x.json', 'y.json', 'z.json']);
  assert.throws(() => expandBraces('{a,b,c,d,e,f,g,h,i}{a,b,c,d,e,f,g,h,i}'), /more than 64/);
});

test('isSecretFile names .env files, .npmrc and .sentryclirc in any folder, but not templates', () => {
  for (const p of ['.env', 'apps/web/.env', '.env.local', 'a/.ENV.Production', '.npmrc', 'x/y/.NPMRC', '.sentryclirc', 'apps\\api\\.env.test']) {
    assert.equal(isSecretFile(p), true, p);
  }
  for (const p of ['.env.example', 'a/.env.sample', '.env.local.template', '.env.dist', 'env.ts', 'src/.envrc', 'npmrc.md', 'a.env', 'docs/.env-notes']) {
    assert.equal(isSecretFile(p), false, p);
  }
});

test('diffText includes untracked text and binary files, never secret files, and leaves out excluded globs', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  const base = makeRepo(dir, { 'a.txt': 'a\n', 'config/secret.json': '{"k":1}\n', 'apps/web/.env.local': 'X=1\n', '.npmrc': 'a=1\n', '.env.example': 'X=\n' });
  const bin = Buffer.from([0, 1, 2, 255, 254, 10, 0]);
  writeFiles(dir, {
    'a.txt': 'a2\n', 'config/secret.json': '{"k":2}\n', 'apps/web/.env.local': 'X=2\n', '.npmrc': 'a=2\n', '.env.example': 'X=\nY=\n',
    'new/n.txt': 'n\n', 'new/blob.bin': bin, 'new/.ENV.prod': 'Y=1\n', 'new/.sentryclirc': 'z\n', 'empty.txt': '',
  });
  const all = await diffText(dir, base);
  for (const p of ['a.txt', 'config/secret.json', '.env.example', 'new/n.txt', 'new/blob.bin', 'empty.txt']) {
    assert.ok(all.includes(`diff --git a/${p} b/${p}`), p);
  }
  for (const p of ['apps/web/.env.local', '.npmrc', 'new/.ENV.prod', 'new/.sentryclirc']) assert.ok(!all.includes(p), `${p} is a secret file`);
  assert.doesNotMatch(all, /X=2|Y=1|a=2/);
  assert.match(all, /GIT binary patch/);

  const cut = await diffText(dir, base, { exclude: ['**/.env*', 'config/{secret,key}.json'] });
  assert.ok(cut.includes('diff --git a/a.txt b/a.txt'));
  assert.ok(cut.includes('diff --git a/new/n.txt b/new/n.txt'));
  for (const p of ['config/secret.json', 'apps/web/.env.local', 'new/.ENV.prod', '.env.example', '.npmrc']) assert.ok(!cut.includes(p), `${p} excluded`);

  const fn = await diffText(dir, base, { exclude: p => p.startsWith('new/') || p === 'a.txt' });
  assert.ok(!fn.includes('new/n.txt') && !fn.includes('a.txt b/a.txt'));
  assert.ok(fn.includes('config/secret.json'));
  assert.ok(!fn.includes('.npmrc'), 'secret files stay out with a function too');
  assert.ok(Buffer.isBuffer(await diffText(dir, base, { encoding: 'buffer' })));
  await assert.rejects(diffText(dir, base, { exclude: 'nope' }), /list of globs or a function/);

  // The patch replays byte for byte in a clean checkout of base.
  const patch = join(root, 'all.patch');
  writeFileSync(patch, await diffText(dir, base, { encoding: 'buffer' }));
  const clone = join(root, 'clone');
  sh(root, ['clone', '-q', '-c', 'core.autocrlf=false', dir, clone]);
  sh(clone, ['checkout', '-q', '--detach', base]);
  sh(clone, ['apply', '--binary', patch]);
  for (const p of ['a.txt', 'config/secret.json', 'new/n.txt', 'new/blob.bin', 'empty.txt']) assert.deepEqual(read(clone, p), read(dir, p), p);

  const head = commitAll(dir, 'second');
  const between = await diffText(dir, base, { head, exclude: ['**/.env*'] });
  assert.ok(between.includes('new/n.txt') && !between.includes('.env'));
});

test('diffNames lists both sides of a change between two commits', async t => {
  const dir = join(tempRoot(t), 'r');
  const a = makeRepo(dir, { 'x.txt': 'x\n', 'y.txt': 'y\n'.repeat(10) });
  writeFiles(dir, { 'x.txt': 'x2\n' });
  sh(dir, ['mv', 'y.txt', 'z.txt']);
  const b = commitAll(dir, 'b');
  assert.deepEqual((await diffNames(dir, a, b)).sort(), ['x.txt', 'y.txt', 'z.txt']);
  assert.deepEqual(await diffNames(dir, await commitTree(dir, a), await commitTree(dir, a)), []);
});

// ---------------------------------------------------------------- reading commits

test('fileAt, existsAt and lsFilesAt read a commit without touching the checkout', async t => {
  const dir = join(tempRoot(t), 'r');
  const first = makeRepo(dir, { 'docs/a.md': 'first\n', 'b.bin': Buffer.from([0, 1, 2]) });
  writeFiles(dir, { 'docs/a.md': 'second\n', 'docs/c.md': 'c\n' });
  commitAll(dir, 'two');
  assert.equal(await fileAt(dir, first, 'docs/a.md'), 'first\n');
  assert.equal(await fileAt(dir, 'HEAD', './docs\\a.md'), 'second\n');
  assert.deepEqual(await fileAt(dir, first, 'b.bin', { encoding: 'buffer' }), Buffer.from([0, 1, 2]));
  assert.equal(await fileAt(dir, first, 'docs/c.md'), null);
  await assert.rejects(fileAt(dir, '0123456789abcdef0123456789abcdef01234567', 'docs/a.md'), /not a known commit/);
  await assert.rejects(fileAt(dir, first, '../outside.txt'), /not a path inside/);

  assert.equal(await existsAt(dir, first, 'docs/a.md'), true);
  assert.equal(await existsAt(dir, first, 'docs'), true);
  assert.equal(await existsAt(dir, first, 'docs/c.md'), false);
  assert.equal(await existsAt(dir, 'HEAD', 'docs/c.md'), true);
  assert.equal(await existsAt(dir, '0123456789abcdef0123456789abcdef01234567', 'docs/a.md'), false);

  assert.deepEqual((await lsFilesAt(dir, first)).sort(), ['b.bin', 'docs/a.md']);
  assert.deepEqual((await lsFilesAt(dir, 'HEAD', { paths: ['docs'] })).sort(), ['docs/a.md', 'docs/c.md']);
});

test('logSince filters by date, ref and paths', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  writeFiles(dir, { 'records/one.md': '1\n' });
  commitAll(dir, 'record one (audit X-1)', '2030-01-01T10:00:00Z');
  writeFiles(dir, { 'b.txt': 'b\n' });
  commitAll(dir, 'other work', '2030-01-05T10:00:00Z');
  writeFiles(dir, { 'records/two.md': '2\n' });
  const last = commitAll(dir, 'record two', '2030-01-09T10:00:00Z');
  sh(dir, ['switch', '-q', '-c', 'side']);
  writeFiles(dir, { 'records/side.md': 's\n' });
  commitAll(dir, 'side record', '2030-01-10T10:00:00Z');

  const recent = await logSince(dir, new Date('2030-01-04T00:00:00Z'), { ref: 'main' });
  assert.deepEqual(recent.map(c => c.subject), ['record two', 'other work']);
  assert.equal(recent[0].sha, last);
  assert.equal(recent[0].short, last.slice(0, 7));
  assert.equal(recent[0].author, 't');
  assert.ok(recent[0].at.startsWith('2030-01-09'));
  const records = await logSince(dir, { since: '2030-01-01T00:00:00Z', ref: 'side', paths: ['records'] });
  assert.deepEqual(records.map(c => c.subject), ['side record', 'record two', 'record one (audit X-1)']);
  assert.equal((await logSince(dir, { ref: 'main', max: 2 })).length, 2);
  assert.equal((await logSince(dir, null, { ref: 'main' })).length, 4);
  await assert.rejects(logSince(dir, 'not a date'), /not a date/);
});

test('originUrl, revCount and commitTree', async t => {
  const dir = join(tempRoot(t), 'r');
  const a = makeRepo(dir, { 'a.txt': 'a\n' });
  assert.equal(await originUrl(dir), '');
  sh(dir, ['remote', 'add', 'origin', 'https://example.invalid/me/example.git']);
  assert.equal(await originUrl(dir), 'https://example.invalid/me/example.git');
  await assert.rejects(originUrl(dir, '--all'), /not a remote name/);
  writeFiles(dir, { 'b.txt': 'b\n' });
  commitAll(dir, 'b');
  writeFiles(dir, { 'c.txt': 'c\n' });
  const c = commitAll(dir, 'c');
  assert.equal(await revCount(dir, `${a}..HEAD`), 2);
  assert.equal(await revCount(dir, a, c), 2);
  assert.equal(await revCount(dir, 'HEAD'), 3);
  await assert.rejects(revCount(dir, '-n1'), GitError);
  assert.equal(await commitTree(dir, c), sh(dir, ['rev-parse', 'HEAD^{tree}']));
});

// ---------------------------------------------------------------- tree hash

test('treeHash equals the commit tree after add plus commit, and never touches the real index', async t => {
  const root = tempRoot(t);
  const dir = join(root, 'r');
  const base = makeRepo(dir, { 'keep.txt': 'k\n', 'mod.txt': 'm\n', 'del.txt': 'd\n', 'other.txt': 'o\n' });
  writeFiles(dir, { 'mod.txt': 'm2\n', 'dir with space/new.txt': 'n\n', 'other.txt': 'o2\n', 'bin.dat': Buffer.from([0, 9, 8]) });
  rmSync(join(dir, 'del.txt'));
  const files = ['mod.txt', 'del.txt', 'dir with space/new.txt', 'bin.dat', 'never-existed.txt'];
  const indexFile = join(dir, '.git', 'index');
  const indexBefore = readFileSync(indexFile);
  const statusBefore = sh(dir, ['status', '--porcelain']);
  const tmpIndex = join(root, 'gate', 'tree.index');

  const hash = await treeHash(dir, base, files, tmpIndex);
  assert.match(hash, /^[0-9a-f]{40}$/);
  assert.deepEqual(readFileSync(indexFile), indexBefore, 'real index unchanged');
  assert.equal(sh(dir, ['status', '--porcelain']), statusBefore);
  assert.equal(existsSync(tmpIndex), false, 'temporary index removed');
  assert.equal(await treeHash(dir, base, files), hash, 'same hash with a default temporary index');

  // other.txt is changed but not gated: it must not be part of the tree.
  sh(dir, ['add', '-A', '--', 'mod.txt', 'del.txt', 'dir with space/new.txt', 'bin.dat']);
  sh(dir, ['commit', '-q', '-m', 'gated']);
  assert.equal(await commitTree(dir, 'HEAD'), hash);
  assert.equal(sh(dir, ['status', '--porcelain']), 'M other.txt');
});

test('with core.autocrlf=true, treeHash still equals the commit tree and patches replay', async t => {
  // The default tests use autocrlf=false; a Windows project checkout often has it on.
  const root = tempRoot(t);
  const dir = join(root, 'r');
  makeRepo(dir, {}, null);
  sh(dir, ['config', 'core.autocrlf', 'true']);
  writeFiles(dir, { 'a.txt': 'one\r\ntwo\r\n', 'b.txt': 'b\r\n' });
  const base = commitAll(dir, 'crlf base');
  assert.equal(sh(dir, ['cat-file', 'blob', `${base}:a.txt`]), 'one\ntwo', 'stored with LF');
  writeFiles(dir, { 'a.txt': 'one\r\ntwo\r\nthree\r\n', 'new.txt': 'n1\r\nn2\r\n' });
  const files = ['a.txt', 'new.txt'];
  const hash = await treeHash(dir, base, files);

  const patchFile = join(root, 'crlf.patch');
  writeFileSync(patchFile, await diffText(dir, base, { encoding: 'buffer' }));
  const clone = join(root, 'clone');
  sh(root, ['clone', '-q', '-c', 'core.autocrlf=true', dir, clone]);
  sh(clone, ['checkout', '-q', '--detach', base]);
  sh(clone, ['apply', '--binary', '--whitespace=nowarn', patchFile]);
  assert.equal(readFileSync(join(clone, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\ntwo\nthree\n');
  assert.equal(readFileSync(join(clone, 'new.txt'), 'utf8').replace(/\r\n/g, '\n'), 'n1\nn2\n');
  assert.equal(await treeHash(clone, base, files), hash, 'the replayed tree hashes the same');

  sh(dir, ['add', '--', ...files]);
  sh(dir, ['commit', '-q', '-m', 'crlf change']);
  assert.equal(await commitTree(dir, 'HEAD'), hash);
});

// ---------------------------------------------------------------- cockpit summary

test('repoSummary gives the cockpit shape and is cached for 10 s per folder', async t => {
  clearGitCache();
  t.after(clearGitCache);
  const root = tempRoot(t);
  const dir = join(root, 'r');
  const sha = makeRepo(dir, { 'a.txt': 'a\n' });
  sh(dir, ['branch', 'app/0101-done']);
  sh(dir, ['worktree', 'add', '-q', '--detach', join(root, 'run'), 'HEAD']);
  writeFiles(dir, { 'a.txt': 'a2\n', 'u.txt': 'u\n' });
  const now = Date.now();
  const p1 = repoSummary(dir, { into: 'main', now });
  const p2 = repoSummary(dir, { into: 'main', now: now + 1000 });
  assert.equal(p1, p2, 'callers within the TTL share one build');
  const s = await p1;
  assert.equal(s.branch, 'main');
  assert.equal(s.sha, sha);
  assert.equal(s.changed, 2);
  assert.deepEqual(s.stashes, { total: 0, onBranch: 0 });
  assert.deepEqual(s.appBranches.map(b => [b.name, b.merged]), [['app/0101-done', true]]);
  assert.equal(s.worktrees.length, 2);
  assert.deepEqual(s.archivedBranches, []);
  for (const k of ['ahead', 'behind', 'upstream', 'detached', 'at']) assert.ok(k in s, k);

  writeFiles(dir, { 'v.txt': 'v\n' });
  assert.equal((await repoSummary(dir, { into: 'main', now: now + 2000 })).changed, 2, 'still cached');
  assert.equal((await repoSummary(dir, { into: 'main', now: now + SUMMARY_TTL_MS + 1 })).changed, 3, 'fresh after the TTL');
  clearGitCache();
  writeFiles(dir, { 'w.txt': 'w\n' });
  assert.equal((await repoSummary(dir, { into: 'main' })).changed, 4, 'fresh after clearGitCache');
  await assert.rejects(repoSummary(join(root, 'nope')), GitError);
  await assert.rejects(repoSummary(join(root, 'nope')), GitError, 'a failed build is not cached');
});

test('the status calls leave the checkout index file alone (no optional locks)', async t => {
  const dir = join(tempRoot(t), 'r');
  makeRepo(dir, { 'a.txt': 'a\n' });
  // Touch the file so a normal git status would want to refresh the index.
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'a\n');
  const before = statSync(join(dir, '.git', 'index')).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  await statusSummary(dir);
  assert.equal(statSync(join(dir, '.git', 'index')).mtimeMs, before);
});
