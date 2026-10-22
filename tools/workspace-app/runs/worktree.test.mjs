// Tests for runs/worktree.mjs. Run: node --test tools/workspace-app/runs/worktree.test.mjs
// Each test builds a synthetic "example" project repo under the temp folder (core.autocrlf=false,
// user t <t@t>) and a run worktree next to it. Install and generate are a fake runCommand that
// writes into the ignored node_modules folder; nothing real is installed and nothing leaves the
// temp folder. The commit tests use a fake pre-commit hook that rewrites a file, the way
// lint-staged does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, treeHash } from '../core/git.mjs';
import {
  APP_PREFIX, BRANCH_MODE_FILE, STOP_WORDS, applyChanges, applyPatch, archiveBranch, branchModeCheck, branchModeState,
  branchName, checkBranchName, commitInTree, finishBranchMode, loadWorktreeRecord, prepareBranchMode, prepareRunTree,
  resetTree, runTreeHashes, samePath, savePatch, setupLogFile, setupWorktree, worktreeRecordFile, worktreeStatus,
} from './worktree.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- helpers (test-only, sync)

function sh(dir, args, env = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const read = (dir, rel) => readFileSync(join(dir, rel));
const text = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

function commitAll(dir, msg) {
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', msg]);
  return sh(dir, ['rev-parse', 'HEAD']);
}

const BASE_FILES = {
  '.gitignore': 'node_modules/\n*.log\n.env\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  'db/schema.txt': 'model One {}\n',
  'apps/api/src/a.txt': 'a\n',
  'apps/api/src/b.txt': 'b\n',
  'apps/web/src/c.txt': 'c\n',
  'README.md': '# example\n',
};

// Text with every line ending as CRLF, the way a Windows editor saves it.
const crlf = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.replace(/\r?\n/g, '\r\n')]));

// A synthetic "example" project: { root, main, run, dataDir, base, profile }. With autocrlf the
// repo has core.autocrlf=true and its files are written with CRLF, as on a Windows checkout.
function fixture(t, { dev = [], autocrlf = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ws-wt-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const main = join(root, 'example');
  mkdirSync(main, { recursive: true });
  sh(main, ['init', '-q', '-b', 'main']);
  const config = { 'core.autocrlf': autocrlf ? 'true' : 'false', 'user.name': 't', 'user.email': 't@t', 'commit.gpgsign': 'false', 'core.hooksPath': join(main, '.git', 'hooks') };
  for (const [k, v] of Object.entries(config)) sh(main, ['config', k, v]);
  writeFiles(main, autocrlf ? crlf(BASE_FILES) : BASE_FILES);
  const base = commitAll(main, 'init');
  const run = join(root, 'example-run');
  const dataDir = join(root, 'data');
  const command = kind => ({ kind, workspace: 'root', cwd: '.', argv: ['{node}', '-e', '0'], onlyTree: 'run', timeoutSec: 60 });
  const profile = {
    version: 1, project: 'example', label: 'Example',
    git: { integrationBranch: 'main', remote: 'origin', branchPrefix: 'app/', archivePrefix: 'archive/app/' },
    isolation: {
      mode: 'worktree', worktreePath: run, lockfile: 'package-lock.json', schemaFiles: ['db/schema.txt'],
      setup: ['install', 'generate'], refresh: { onLockfile: ['install', 'generate'], onSchema: ['generate'] },
    },
    ports: { dev, localServices: [], closed: { host: '127.0.0.1', port: 1 } },
    commands: { 'install:root': command('install'), generate: command('generate') },
  };
  return { root, main, run, dataDir, base, profile };
}

// A fake gates/commands.mjs runCommand: records calls, writes a marker into node_modules (ignored)
// and a log file into the gate folder. `fail` names command ids that exit 1.
function fakeRunner({ fail = [] } = {}) {
  const calls = [];
  const runCommand = async ({ profile, commandId, tree, files, gateDir, signal, proc }) => {
    calls.push({ commandId, tree, files, hasGateDir: existsSync(gateDir), signal, proc, project: profile.project });
    writeFiles(tree, { [`node_modules/.${commandId.replace(/\W/g, '-')}-${calls.length}`]: 'x' });
    writeFileSync(join(gateDir, `${commandId.replace(/\W/g, '-')}.log`), `fake output of ${commandId}\n`);
    const bad = fail.includes(commandId);
    return { status: bad ? 'fail' : 'pass', exitCode: bad ? 1 : 0, durationMs: 7, log: `${commandId.replace(/\W/g, '-')}.log` };
  };
  return { runCommand, calls, ids: () => calls.map(c => c.commandId) };
}

async function setUp(fx, runner = fakeRunner()) {
  const lines = [];
  const record = await setupWorktree({ ...fx, mainDir: fx.main, onLine: l => lines.push(l), runCommand: runner.runCommand, proc: { fake: true } });
  return { record, lines, runner };
}

function writeHook(main, body) {
  const file = join(main, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
}

function messageFile(root, msg = 'Example change\n\nBody.\n') {
  const file = join(root, 'commit-msg.txt');
  writeFileSync(file, msg);
  return file;
}

function listen(t) {
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer(s => s.destroy());
    server.once('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => server.close(() => r())));
      resolveP(server.address().port);
    });
  });
}

const branches = dir => sh(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort();
const porcelain = dir => sh(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
// Entries in the stash reflog (0 when there is no stash at all).
function stashCount(dir) {
  const r = spawnSync('git', ['-C', dir, 'log', '-g', '--format=%gs', 'refs/stash', '--'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
}

// ---------------------------------------------------------------- setup and status

test('setupWorktree adds a detached worktree, runs install then generate, and writes the record', async t => {
  const fx = fixture(t);
  assert.equal((await worktreeStatus({ ...fx, mainDir: fx.main })).state, 'none');
  const { record, lines, runner } = await setUp(fx);

  assert.deepEqual(runner.ids(), ['install:root', 'generate'], 'setup entries are kinds resolved to command ids');
  assert.ok(runner.calls.every(c => c.tree === fx.run && c.hasGateDir && c.proc?.fake && c.project === 'example' && c.files.length === 0));
  assert.equal(sh(fx.run, ['rev-parse', 'HEAD']), fx.base);
  assert.equal(sh(fx.run, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached');
  assert.equal(porcelain(fx.run), '', 'node_modules is ignored, so the tree stays clean');

  assert.equal(record.status, 'ready');
  assert.equal(record.version, 1);
  assert.equal(record.path, fx.run);
  assert.equal(record.mainDir, fx.main);
  assert.equal(record.log, 'worktrees/example-setup.log');
  assert.equal(record.error, null);
  assert.match(record.lockHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(record.schemaHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual({ lockHash: record.lockHash, schemaHash: record.schemaHash }, await runTreeHashes(fx.run, fx.profile));
  assert.equal(record.installMs, 7);
  assert.ok(record.lastInstallAt && record.lastGenerateAt && record.createdAt);
  assert.deepEqual(await loadWorktreeRecord(fx.dataDir, 'example'), record);
  assert.equal(worktreeRecordFile(fx.dataDir, 'example'), join(fx.dataDir, 'worktrees', 'example.json'));

  const log = readFileSync(setupLogFile(fx.dataDir, 'example'), 'utf8');
  assert.match(log, /git worktree add --detach/);
  assert.match(log, /fake output of install:root/);
  assert.match(log, /fake output of generate/);
  assert.ok(lines.some(l => /is ready/.test(l)));

  const st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'ready');
  assert.equal(st.status, 'ready', 'status mirrors state');
  assert.equal(st.path, fx.run);
  assert.equal(st.registered, true);
  assert.equal(st.head, fx.base);
  assert.equal(st.detached, true);
  assert.match(st.text, /example-run is ready at [0-9a-f]{7}/);
});

test('setupWorktree refuses an existing folder that is not a worktree, and paths inside the checkout', async t => {
  const fx = fixture(t);
  mkdirSync(fx.run);
  writeFileSync(join(fx.run, 'mine.txt'), 'keep me');
  const runner = fakeRunner();
  await assert.rejects(setUp(fx, runner), /already exists and is not a worktree/);
  assert.equal(runner.calls.length, 0);
  assert.equal(text(fx.run, 'mine.txt'), 'keep me');
  assert.equal(await loadWorktreeRecord(fx.dataDir, 'example'), null, 'a refusal writes no record');
  assert.equal((await worktreeStatus({ ...fx, mainDir: fx.main })).state, 'blocked');

  const inside = { ...fx, profile: { ...fx.profile, isolation: { ...fx.profile.isolation, worktreePath: join(fx.main, 'run') } } };
  await assert.rejects(setUp(inside), /overlap/);
  const relative = { ...fx, profile: { ...fx.profile, isolation: { ...fx.profile.isolation, worktreePath: 'run' } } };
  await assert.rejects(setUp(relative), /absolute local path/);
  await assert.rejects(setupWorktree({ ...fx, mainDir: join(fx.main, 'apps'), runCommand: runner.runCommand }), /not the top folder/);
  const missing = { ...fx, profile: { ...fx.profile, isolation: { ...fx.profile.isolation, setup: ['install', 'seed'] } } };
  rmSync(fx.run, { recursive: true });
  await assert.rejects(setUp(missing), /no "seed" command/);
});

test('a failed setup command marks the record failed; running setup again reuses the worktree', async t => {
  const fx = fixture(t);
  await assert.rejects(setUp(fx, fakeRunner({ fail: ['generate'] })), /generate failed with exit code 1; see the setup log/);
  const failed = await loadWorktreeRecord(fx.dataDir, 'example');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /generate failed/);
  const st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'failed');
  assert.match(st.text, /last setup of example-run failed/);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base }), /not set up yet \(the last setup failed\)/);

  const again = await setUp(fx);
  assert.equal(again.record.status, 'ready');
  assert.equal(again.record.createdAt, failed.createdAt);
  assert.ok(again.lines.some(l => /reusing it/.test(l)));
  assert.match(readFileSync(setupLogFile(fx.dataDir, 'example'), 'utf8'), /Setup failed[\s\S]*reusing it/);
});

test('worktreeStatus reports dirty, on-branch and missing trees', async t => {
  const fx = fixture(t);
  await setUp(fx);
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'edited\n' });
  let st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'dirty');
  assert.match(st.text, /1 changed file;/);
  sh(fx.run, ['checkout', '-q', '--', '.']);
  sh(fx.run, ['switch', '-q', '-c', 'side']);
  st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'on-branch');
  assert.equal(st.branch, 'side');
  sh(fx.main, ['worktree', 'remove', '--force', fx.run]);
  st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'missing');
  assert.match(st.text, /is gone; set it up again/);
});

test('worktreeStatus and setupWorktree name a worktree whose folder is gone, and a moved path', async t => {
  const fx = fixture(t);
  await setUp(fx);
  rmSync(fx.run, { recursive: true, force: true, maxRetries: 5 });
  const st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.status, 'missing');
  assert.match(st.text, /still registered as a worktree .* run git worktree prune in/);
  await assert.rejects(setUp(fx), /folder is gone; run git worktree prune/);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base }), /folder is gone/);

  sh(fx.main, ['worktree', 'prune']); // the user's step
  const moved = { ...fx, profile: { ...fx.profile, isolation: { ...fx.profile.isolation, worktreePath: join(fx.root, 'elsewhere') } } };
  const m = await worktreeStatus({ ...moved, mainDir: fx.main });
  assert.equal(m.state, 'moved');
  assert.match(m.text, /was set up at .*example-run; run the setup again/);
  const again = await setUp(moved);
  assert.equal(again.record.status, 'ready');
  assert.equal((await worktreeStatus({ ...moved, mainDir: fx.main })).state, 'ready');
});

test('a run tree git can no longer read is failed, not ready, and nothing runs in it', async t => {
  const fx = fixture(t);
  await setUp(fx);
  rmSync(join(fx.run, '.git')); // the tree's link to the repository is gone
  const st = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(st.state, 'failed');
  assert.equal(st.status, 'failed');
  assert.match(st.text, /Git can't read .*example-run as a checkout \(.*not a git repository.*\)\. A run can't use example-run until this is fixed\./);
  assert.match(st.error, /not a git repository/);
  assert.equal(st.head, null);
  const runner = fakeRunner();
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base, runCommand: runner.runCommand }), /Git can't read .*example-run as a checkout/);
  await assert.rejects(setUp(fx, runner), /Git can't read .*example-run as a checkout/);
  assert.equal(runner.calls.length, 0);

  // When a folder further up is a repository, git finds that one instead: still refused.
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'left in the broken tree\n' });
  sh(fx.root, ['init', '-q']);
  const up = await worktreeStatus({ ...fx, mainDir: fx.main });
  assert.equal(up.state, 'failed');
  assert.match(up.text, /example-run has lost its link to the repository \(git finds .* there instead\); move the folder away and run git worktree prune/);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base, runCommand: runner.runCommand }), /lost its link/);
  await assert.rejects(resetTree(fx.run, fx.base), /not the top folder of a git checkout/);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'left in the broken tree\n', 'nothing was reset');
});

test('setupWorktree reuses a clean worktree, but refuses one with changes or on a branch', async t => {
  const fx = fixture(t);
  await setUp(fx);
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'unsaved work\n' });
  const runner = fakeRunner();
  await assert.rejects(setUp(fx, runner), /example-run has 1 changed file \(apps\/api\/src\/a\.txt\); the app never stashes/);
  assert.equal(runner.calls.length, 0);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'unsaved work\n', 'nothing is wiped');
  sh(fx.run, ['checkout', '-q', '--', '.']);
  sh(fx.run, ['switch', '-q', '-c', 'side']);
  await assert.rejects(setUp(fx, runner), /on branch side; run git switch --detach/);
  sh(fx.run, ['switch', '-q', '--detach']);
  assert.equal((await setUp(fx, runner)).record.status, 'ready');
});

test('a setup or refresh command that leaves changed files fails, and the reason reaches the message', async t => {
  const fx = fixture(t);
  const dirty = {
    calls: [],
    runCommand: async ({ commandId, tree }) => {
      if (commandId === 'generate') writeFiles(tree, { 'db/schema.txt': 'rewritten by generate\n' });
      return { status: 'pass', exitCode: 0, durationMs: 1, log: '' };
    },
  };
  await assert.rejects(setUp(fx, dirty), /install:root and generate left 1 changed file in example-run \(db\/schema\.txt\); fix those commands in the profile, then set it up again/);
  assert.equal((await loadWorktreeRecord(fx.dataDir, 'example')).status, 'failed');
  sh(fx.run, ['checkout', '-q', '--', '.']);

  const erroring = { runCommand: async ({ commandId }) => ({ status: 'error', exitCode: null, reason: `${commandId} is not installed in this tree` }) };
  await assert.rejects(setUp(fx, erroring), /install:root failed \(install:root is not installed in this tree\); see the setup log/);
  const skipping = { runCommand: async () => ({ status: 'skip', exitCode: null, reason: 'Not run: no matching files' }) };
  await assert.rejects(setUp(fx, skipping), /install:root did not run \(Not run: no matching files\)/);
  const throwing = { runCommand: async () => { throw new Error('spawn failed'); } };
  await assert.rejects(setUp(fx, throwing), /spawn failed/);
  assert.match(readFileSync(setupLogFile(fx.dataDir, 'example'), 'utf8'), /install:root could not run: spawn failed/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(setupWorktree({ ...fx, mainDir: fx.main, runCommand: fakeRunner().runCommand, signal: ac.signal }), /cancelled/);
});

test('without a runner, setup runs the profile commands through gates/commands.mjs (integration)', async t => {
  const fx = fixture(t);
  // Real profile commands: node writes an ignored *.log marker into the tree.
  const command = (kind, file) => ({ kind, workspace: 'root', cwd: '.', argv: ['{node}', '-e', `require('fs').writeFileSync('${file}', 'done')`], onlyTree: 'run', timeoutSec: 60 });
  const profile = {
    ...fx.profile,
    env: { preset: {}, heapMb: 512, neverSet: [] },
    secrets: { trackedSecretFiles: [], denyReadGlobs: [], allowValues: [] },
    commands: { 'install:root': command('install', 'install-done.log'), generate: command('generate', 'generate-done.log') },
  };
  const record = await setupWorktree({ profile, mainDir: fx.main, dataDir: fx.dataDir });
  assert.equal(record.status, 'ready');
  assert.equal(text(fx.run, 'install-done.log'), 'done');
  assert.equal(text(fx.run, 'generate-done.log'), 'done');
  assert.equal(porcelain(fx.run), '');
  assert.match(readFileSync(setupLogFile(fx.dataDir, 'example'), 'utf8'), /install:root finished in \d+ s[\s\S]*generate finished in \d+ s/);
});

// ---------------------------------------------------------------- prepareRunTree

test('prepareRunTree checks out the base and refreshes only when the lockfile or schema changed', async t => {
  const fx = fixture(t);
  await setUp(fx);
  const first = fakeRunner();
  const opts = () => ({ ...fx, mainDir: fx.main, runCommand: first.runCommand });

  let r = await prepareRunTree({ ...opts(), baseSha: fx.base });
  assert.deepEqual(r, { tree: fx.run, head: fx.base, refreshed: [], ran: [] });

  writeFiles(fx.main, { 'db/schema.txt': 'model One {}\nmodel Two {}\n' });
  const schemaSha = commitAll(fx.main, 'schema');
  const lines = [];
  r = await prepareRunTree({ ...opts(), baseSha: schemaSha, onLine: l => lines.push(l) });
  assert.equal(r.head, schemaSha);
  assert.deepEqual(r.refreshed, ['generate']);
  assert.deepEqual(r.ran, ['generate'], 'the executor reads the same list as ran');
  assert.ok(lines.some(l => /the schema changed; running generate/.test(l)));

  writeFiles(fx.main, { 'package-lock.json': '{"lockfileVersion":3,"x":1}\n' });
  const lockSha = commitAll(fx.main, 'lock');
  r = await prepareRunTree({ ...opts(), baseSha: lockSha });
  assert.deepEqual(r.refreshed, ['install:root', 'generate']);
  const rec = await loadWorktreeRecord(fx.dataDir, 'example');
  assert.deepEqual({ lockHash: rec.lockHash, schemaHash: rec.schemaHash }, await runTreeHashes(fx.run, fx.profile));

  r = await prepareRunTree({ ...opts(), baseSha: lockSha });
  assert.deepEqual(r.refreshed, [], 'hashes recorded, nothing to redo');
  // Going back to an older base changes the hashes again.
  r = await prepareRunTree({ ...opts(), baseSha: fx.base });
  assert.deepEqual(r.refreshed, ['install:root', 'generate']);
  assert.equal(sh(fx.run, ['rev-parse', 'HEAD']), fx.base);
});

test('prepareRunTree refuses a dirty tree, a tree on a branch and a bad base, and retries a failed refresh', async t => {
  const fx = fixture(t);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base }), /example-run is not set up yet; run the worktree setup/);
  await setUp(fx);
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'x\n', 'new.txt': 'n\n' });
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base }), /example-run has 2 changed files; the app never stashes\./);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'x\n', 'refusing leaves the changes alone');
  sh(fx.run, ['checkout', '-q', '--', '.']);
  rmSync(join(fx.run, 'new.txt'));
  sh(fx.run, ['switch', '-q', '-c', 'side']);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base }), /on branch side, not a detached HEAD/);
  sh(fx.run, ['switch', '-q', '--detach']);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: '--orphan' }), /not a commit sha/);
  await assert.rejects(prepareRunTree({ ...fx, mainDir: '', baseSha: fx.base }), /main checkout folder is missing/);

  writeFiles(fx.main, { 'db/schema.txt': 'changed\n' });
  const sha = commitAll(fx.main, 'schema');
  const failing = fakeRunner({ fail: ['generate'] });
  await assert.rejects(prepareRunTree({ ...fx, mainDir: fx.main, baseSha: sha, runCommand: failing.runCommand }), /generate failed with exit code 1; see the setup log/);
  assert.match((await loadWorktreeRecord(fx.dataDir, 'example')).error, /generate failed/);
  const ok = fakeRunner();
  const r = await prepareRunTree({ ...fx, mainDir: fx.main, baseSha: sha, runCommand: ok.runCommand });
  assert.deepEqual(r.refreshed, ['generate'], 'the failed refresh is tried again');
  assert.equal((await loadWorktreeRecord(fx.dataDir, 'example')).error, null);

  const moved = { ...fx, profile: { ...fx.profile, isolation: { ...fx.profile.isolation, worktreePath: join(fx.root, 'elsewhere') } } };
  await assert.rejects(prepareRunTree({ ...moved, mainDir: fx.main, baseSha: sha }), /was set up at/);
});

// ---------------------------------------------------------------- patches and resets

test('savePatch, resetTree and applyPatch round trip tracked, deleted, untracked and binary changes', async t => {
  const fx = fixture(t);
  await setUp(fx);
  const bin = Buffer.from([0, 255, 1, 254, 10, 13, 10, 0]);
  writeFiles(fx.run, {
    'apps/api/src/a.txt': 'a changed\n', 'apps/web/src/new folder/n.txt': 'new\n', 'apps/web/src/img.bin': bin,
    'node_modules/keep.js': 'ignored, must survive', 'debug.log': 'ignored too',
  });
  rmSync(join(fx.run, 'apps/api/src/b.txt'));
  const before = await changedFiles(fx.run, fx.base);
  assert.deepEqual(before.map(f => `${f.status} ${f.path}`), ['M apps/api/src/a.txt', 'D apps/api/src/b.txt', 'A apps/web/src/img.bin', 'A apps/web/src/new folder/n.txt']);

  const patchFile = join(fx.root, 'run1', 'final', 'stopped.patch');
  const saved = await savePatch(fx.run, fx.base, patchFile);
  assert.equal(saved.file, patchFile);
  assert.equal(saved.files, 4);
  assert.equal(saved.empty, false);
  assert.ok(saved.bytes > 0 && existsSync(patchFile));

  const reset = await resetTree(fx.run, fx.base);
  assert.equal(reset.head, fx.base);
  assert.equal(porcelain(fx.run), '');
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'a\n');
  assert.equal(existsSync(join(fx.run, 'apps/web/src/new folder')), false);
  assert.equal(text(fx.run, 'node_modules/keep.js'), 'ignored, must survive', 'git clean -fd keeps ignored files');
  assert.equal(text(fx.run, 'debug.log'), 'ignored too');

  assert.deepEqual(await applyPatch(fx.run, patchFile), { applied: true });
  assert.deepEqual(await changedFiles(fx.run, fx.base), before);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'a changed\n');
  assert.deepEqual(read(fx.run, 'apps/web/src/img.bin'), bin);
  assert.equal(existsSync(join(fx.run, 'apps/api/src/b.txt')), false);

  await resetTree(fx.run, fx.base);
  const empty = await savePatch(fx.run, fx.base, join(fx.root, 'empty.patch'));
  assert.equal(empty.empty, true);
  assert.deepEqual(await applyPatch(fx.run, empty.file), { applied: false });
  await assert.rejects(applyPatch(fx.run, join(fx.root, 'nope.patch')), /does not exist/);
});

test('savePatch never writes secret files, and leaves out the profile globs as well', async t => {
  const fx = fixture(t);
  await setUp(fx);
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'a2\n', 'apps/api/.env.local': 'TOKEN=1\n', 'config/.npmrc': 'x=1\n', 'config/keys.json': '{"k":1}\n' });
  const plain = await savePatch(fx.run, fx.base, join(fx.root, 'plain.patch'));
  const plainBody = readFileSync(plain.file, 'utf8');
  assert.equal(plain.files, 2);
  assert.match(plainBody, /apps\/api\/src\/a\.txt/);
  assert.match(plainBody, /config\/keys\.json/);
  assert.doesNotMatch(plainBody, /\.env|\.npmrc|TOKEN|x=1/);

  const saved = await savePatch(fx.run, fx.base, join(fx.root, 'p.patch'), { exclude: ['config/keys.*'] });
  const body = readFileSync(saved.file, 'utf8');
  assert.equal(saved.files, 1);
  assert.match(body, /apps\/api\/src\/a\.txt/);
  assert.doesNotMatch(body, /\.env|\.npmrc|TOKEN|keys\.json/);
});

test('samePath ignores case, slashes and trailing separators; checkBranchName refuses ref tricks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-wt-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(samePath(dir, `${dir}\\`));
  assert.ok(samePath(dir, dir.replace(/\\/g, '/')));
  if (process.platform === 'win32') assert.ok(samePath(dir, dir.toUpperCase()));
  assert.ok(!samePath(dir, join(dir, 'x')));
  for (const ok of ['app/1022-x', 'archive/app/1022-x', 'app/1022-x-2']) assert.equal(checkBranchName(ok), ok);
  for (const bad of ['', '-D', 'app/x..y', 'app//x', 'app/.x', 'app/x/', 'app/x.', 'app/x.lock', 'app/x.lock/y', 'a b', 'app/x~1', 'app/x^', 'app/x:y', 'x'.repeat(130)]) {
    assert.throws(() => checkBranchName(bad), /not a valid branch name/, bad);
  }
});

test('resetTree and applyPatch refuse the main checkout unless branch mode allows it', async t => {
  const fx = fixture(t);
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'user work\n', 'notes.txt': 'user notes\n' });
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout, not the app's run worktree/);
  assert.equal(text(fx.main, 'apps/api/src/a.txt'), 'user work\n');
  assert.equal(text(fx.main, 'notes.txt'), 'user notes\n');
  const p = await savePatch(fx.main, fx.base, join(fx.root, 'main.patch'));
  await assert.rejects(applyPatch(fx.main, p.file), /main checkout/);
  await assert.rejects(resetTree(fx.main, 'HEAD'), /not a commit sha/);
  await assert.rejects(resetTree(join(fx.main, 'apps'), fx.base, { allowMain: true }), /not the top folder of a git checkout/);

  // allowMain alone is not enough while the checkout is on one of the user's branches.
  await assert.rejects(resetTree(fx.main, fx.base, { allowMain: true }), /main checkout on branch main, so it is not in branch mode/);
  await assert.rejects(applyPatch(fx.main, p.file, { allowMain: true }), /on branch main/);
  assert.equal(text(fx.main, 'apps/api/src/a.txt'), 'user work\n');
  assert.equal(text(fx.main, 'notes.txt'), 'user notes\n');

  // Branch mode: detached (as prepareBranchMode leaves it), and the caller says so explicitly.
  sh(fx.main, ['switch', '-q', '--detach', fx.base]);
  await resetTree(fx.main, fx.base, { allowMain: true });
  assert.equal(porcelain(fx.main), '');
  await applyPatch(fx.main, p.file, { allowMain: true });
  assert.equal(text(fx.main, 'notes.txt'), 'user notes\n');
});

test('applyChanges copies the main checkout\'s uncommitted changes into the run tree', async t => {
  const fx = fixture(t);
  await setUp(fx);
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'main edit\n', 'apps/web/src/fresh.txt': 'fresh\n', 'config/secret.json': '{"k":"v"}\n', '.env': 'IGNORED=1\n' });
  rmSync(join(fx.main, 'README.md'));
  const mainBefore = porcelain(fx.main);
  const r = await applyChanges({ tree: fx.run, mainDir: fx.main, mode: 'uncommitted', exclude: ['config/secret*'] });
  assert.equal(r.applied, true);
  assert.equal(r.patchFile, null, 'the temporary patch is removed');
  assert.deepEqual(r.files, ['README.md', 'apps/api/src/a.txt', 'apps/web/src/fresh.txt']);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'main edit\n');
  assert.equal(existsSync(join(fx.run, 'config/secret.json')), false, 'excluded');
  assert.equal(existsSync(join(fx.run, '.env')), false, 'ignored files never travel');
  assert.equal(porcelain(fx.main), mainBefore, 'the main checkout is unchanged');

  await assert.rejects(applyChanges({ tree: fx.run, mainDir: fx.main }), /has 3 changed files; the app never stashes/);
  await resetTree(fx.run, fx.base);
  const kept = join(fx.root, 'inputs', 'diff.patch');
  const r2 = await applyChanges({ tree: fx.run, mainDir: fx.main, patchFile: kept });
  assert.equal(r2.patchFile, kept);
  assert.ok(existsSync(kept));

  await resetTree(fx.run, fx.base);
  sh(fx.main, ['stash', 'push', '-q', '-u']); // test setup: a clean main checkout
  assert.deepEqual(await applyChanges({ tree: fx.run, mainDir: fx.main }), { applied: false, patchFile: null, bytes: 0, files: [] });
  sh(fx.main, ['stash', 'pop', '-q']);
  await assert.rejects(applyChanges({ tree: fx.main, mainDir: fx.main }), /main checkout/);
  await assert.rejects(applyChanges({ tree: fx.run, mainDir: fx.main, mode: 'branch' }), /Only uncommitted changes/);
  writeFiles(fx.main, { 'x.txt': 'x\n' });
  sh(fx.main, ['add', 'x.txt']);
  sh(fx.main, ['commit', '-q', '-m', 'moved on']);
  await assert.rejects(applyChanges({ tree: fx.run, mainDir: fx.main }), /prepare the run tree at/);
});

// ---------------------------------------------------------------- the commit gate

async function gatedChange(fx) {
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'a by claude\n', 'apps/api/src/new.txt': 'new by claude\n', 'apps/web/src/c.txt': 'not gated\n' });
  rmSync(join(fx.run, 'apps/api/src/b.txt'));
  const files = ['apps/api/src/a.txt', 'apps/api/src/b.txt', 'apps/api/src/new.txt'];
  const gatedTreeSha = await treeHash(fx.run, fx.base, files, join(fx.root, 'gate', 'tree.index'));
  return { files, gatedTreeSha };
}

test('commitInTree commits exactly the gated files on a new branch and detaches again', async t => {
  const fx = fixture(t);
  await setUp(fx);
  const { files, gatedTreeSha } = await gatedChange(fx);
  const mainBranchesBefore = branches(fx.main);
  const r = await commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-example-change', files, messageFile: messageFile(fx.root), gatedTreeSha });

  assert.match(r.sha, /^[0-9a-f]{40}$/);
  assert.equal(r.branch, 'app/1022-example-change');
  assert.equal(r.treeSha, gatedTreeSha);
  assert.deepEqual(r.hookChanged, []);
  assert.equal(r.stashDelta, 0);
  assert.deepEqual(r.leftover, ['apps/web/src/c.txt'], 'the ungated change stays uncommitted');
  assert.ok(r.at);
  assert.equal(sh(fx.run, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached after the commit');
  assert.equal(sh(fx.run, ['rev-parse', 'HEAD']), r.sha);
  assert.deepEqual(branches(fx.main), [...mainBranchesBefore, 'app/1022-example-change'].sort());
  assert.equal(sh(fx.main, ['log', '-1', '--format=%s', 'app/1022-example-change']), 'Example change');
  assert.deepEqual(sh(fx.main, ['diff', '--name-only', fx.base, r.sha]).split('\n'), files);
  // The branch is free: the main checkout may switch to it.
  sh(fx.main, ['switch', '-q', 'app/1022-example-change']);
});

test('commitInTree reports files a pre-commit hook rewrote and stash entries it left', async t => {
  const fx = fixture(t);
  await setUp(fx);
  // Like lint-staged: reformat a staged file, stage it again, and leave a backup stash entry.
  writeHook(fx.main, [
    "printf 'formatted by hook\\n' > apps/api/src/a.txt",
    'git add apps/api/src/a.txt',
    'c=$(git commit-tree "HEAD^{tree}" -p HEAD -m backup)',
    'git update-ref --create-reflog -m "On app/1022-hooked: automatic backup" refs/stash "$c"',
  ].join('\n'));
  const { files, gatedTreeSha } = await gatedChange(fx);
  const r = await commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-hooked', files, messageFile: messageFile(fx.root), gatedTreeSha });
  assert.deepEqual(r.hookChanged, ['apps/api/src/a.txt']);
  assert.notEqual(r.treeSha, gatedTreeSha);
  assert.equal(r.stashDelta, 1);
  assert.equal(sh(fx.main, ['show', `${r.sha}:apps/api/src/a.txt`]), 'formatted by hook');
});

test('commitInTree refuses a tree that changed since the gates ran (409), and nothing is created', async t => {
  const fx = fixture(t);
  await setUp(fx);
  const { files, gatedTreeSha } = await gatedChange(fx);
  writeFiles(fx.run, { 'apps/api/src/new.txt': 'edited after the gates\n' });
  const before = branches(fx.main);
  await assert.rejects(
    commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-late', files, messageFile: messageFile(fx.root), gatedTreeSha }),
    e => e.status === 409 && e.code === 'TREE_CHANGED' && /Tree changed since gates ran/.test(e.message),
  );
  assert.deepEqual(branches(fx.main), before);
  assert.equal(sh(fx.run, ['rev-parse', 'HEAD']), fx.base);
});

test('a failing pre-commit hook leaves no branch and keeps the changes, unstaged', async t => {
  const fx = fixture(t);
  await setUp(fx);
  writeHook(fx.main, 'echo "lint failed: 2 problems" >&2\nexit 1');
  const { files, gatedTreeSha } = await gatedChange(fx);
  const before = branches(fx.main);
  await assert.rejects(
    commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-blocked', files, messageFile: messageFile(fx.root), gatedTreeSha }),
    e => /The commit did not go through: .*lint failed/.test(e.message) && /Nothing was committed/.test(e.message) && /lint failed/.test(e.stderr),
  );
  assert.deepEqual(branches(fx.main), before);
  assert.equal(sh(fx.run, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  assert.equal(sh(fx.run, ['rev-parse', 'HEAD']), fx.base);
  assert.equal(sh(fx.run, ['diff', '--cached', '--name-only']), '', 'nothing left staged');
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'a by claude\n');
  assert.equal(text(fx.run, 'apps/api/src/new.txt'), 'new by claude\n');
});

test('commitInTree checks its inputs and the tree before doing anything', async t => {
  const fx = fixture(t);
  await setUp(fx);
  const { files, gatedTreeSha } = await gatedChange(fx);
  const msg = messageFile(fx.root);
  const call = over => commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-x', files, messageFile: msg, gatedTreeSha, ...over });
  await assert.rejects(call({ branch: '-D' }), /not a valid branch name/);
  await assert.rejects(call({ branch: 'app/x..y' }), /not a valid branch name/);
  await assert.rejects(call({ gatedTreeSha: '' }), /gated tree hash/);
  await assert.rejects(call({ files: [] }), /no files/);
  await assert.rejects(call({ files: ['../outside.txt'] }), /not a path inside/);
  writeFileSync(join(fx.root, 'empty-msg.txt'), '');
  await assert.rejects(call({ messageFile: join(fx.root, 'empty-msg.txt') }), /missing or empty/);
  sh(fx.main, ['branch', 'app/1022-taken']);
  await assert.rejects(call({ branch: 'app/1022-taken' }), /already exists/);
  writeFiles(fx.main, { 'later.txt': 'l\n' });
  const later = commitAll(fx.main, 'later');
  await assert.rejects(call({ base: later }), /not detached at the base/);
  sh(fx.run, ['add', 'apps/web/src/c.txt']);
  await assert.rejects(call({}), /already has staged changes/);
  sh(fx.run, ['restore', '--staged', '--', '.']);
  sh(fx.run, ['switch', '-q', '-c', 'side']);
  await assert.rejects(call({}), /on branch side/);
});

test('with core.autocrlf=true and CRLF files: copy, park, resume and commit keep the gated tree hash', async t => {
  const fx = fixture(t, { autocrlf: true });
  await setUp(fx);
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'a\r\n', 'the run tree is checked out with CRLF');
  assert.equal(porcelain(fx.run), '');

  // The user's CRLF edits and a new CRLF file travel from the main checkout into the run tree.
  const edited = { 'apps/api/src/a.txt': 'a from main\r\nline two\r\n', 'apps/api/src/new.txt': 'new\r\nfile\r\n' };
  writeFiles(fx.main, edited);
  const files = ['apps/api/src/a.txt', 'apps/api/src/new.txt'];
  const copied = await applyChanges({ tree: fx.run, mainDir: fx.main });
  assert.deepEqual(copied.files, files);
  for (const [rel, body] of Object.entries(edited)) assert.equal(text(fx.run, rel), body, `${rel} arrives byte for byte`);
  const mainHash = await treeHash(fx.main, fx.base, files);
  assert.equal(await treeHash(fx.run, fx.base, files), mainHash, 'both trees hash the same');

  // Stop (patch, reset) and resume (apply) inside the linked worktree.
  const before = await changedFiles(fx.run, fx.base);
  const patch = await savePatch(fx.run, fx.base, join(fx.root, 'crlf', 'stopped.patch'));
  assert.equal(patch.files, 2);
  await resetTree(fx.run, fx.base);
  assert.equal(porcelain(fx.run), '');
  assert.equal(text(fx.run, 'apps/api/src/a.txt'), 'a\r\n');
  assert.equal(existsSync(join(fx.run, 'apps/api/src/new.txt')), false);
  await applyPatch(fx.run, patch.file);
  assert.deepEqual(await changedFiles(fx.run, fx.base), before);
  for (const [rel, body] of Object.entries(edited)) assert.equal(text(fx.run, rel), body, `${rel} comes back byte for byte`);

  // The gate's hash, then a hook that only re-stages the files and one that rewrites line endings.
  const gatedTreeSha = await treeHash(fx.run, fx.base, files, join(fx.root, 'gate', 'crlf.index'));
  assert.equal(gatedTreeSha, mainHash);
  writeHook(fx.main, [
    'git add apps/api/src/a.txt apps/api/src/new.txt',
    "printf 'new\\nfile\\n' > apps/api/src/new.txt",
    'git add apps/api/src/new.txt',
  ].join('\n'));
  const c = await commitInTree({ tree: fx.run, base: fx.base, branch: 'app/1022-crlf', files, messageFile: messageFile(fx.root), gatedTreeSha });
  assert.equal(c.treeSha, gatedTreeSha, 'the committed tree is the gated tree');
  assert.deepEqual(c.hookChanged, [], 'line endings alone are no hook change');
  assert.deepEqual(c.leftover, [], 'and leave nothing uncommitted');
  assert.equal(sh(fx.main, ['cat-file', 'blob', `${c.sha}:apps/api/src/a.txt`]), 'a from main\nline two', 'stored with LF');
  await resetTree(fx.run, c.sha);
  assert.equal(porcelain(fx.run), '');
});

// ---------------------------------------------------------------- branch mode

test('branchModeCheck refuses changed files and listening dev ports', async t => {
  const fx = fixture(t);
  assert.deepEqual((await branchModeCheck({ profile: fx.profile, mainDir: fx.main })).reasons, []);
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'x\n', 'n.txt': 'n\n' });
  let c = await branchModeCheck({ profile: fx.profile, mainDir: fx.main });
  assert.equal(c.ok, false);
  assert.equal(c.changed, 2);
  assert.equal(c.reason, '2 changed files; commit or set them aside yourself, the app never stashes.');
  sh(fx.main, ['checkout', '-q', '--', '.']);
  rmSync(join(fx.main, 'n.txt'));

  const port = await listen(t);
  const withPort = { ...fx.profile, ports: { ...fx.profile.ports, dev: [port] } };
  c = await branchModeCheck({ profile: withPort, mainDir: fx.main });
  assert.equal(c.ok, false);
  assert.deepEqual(c.ports, [port]);
  assert.equal(c.reason, `Example port ${port} is in use; stop dev servers first.`);
  const port2 = await listen(t);
  c = await branchModeCheck({ profile: { ...withPort, ports: { ...withPort.ports, dev: [port, port2] } }, mainDir: fx.main });
  assert.match(c.reason, new RegExp(`Example ports ${port} and ${port2} are in use`));
});

test('branchModeCheck refuses a merge or rebase in progress, and gives the reason as refusal too', async t => {
  const fx = fixture(t);
  const c0 = await branchModeCheck({ profile: fx.profile, mainDir: fx.main });
  assert.deepEqual([c0.ok, c0.reason, c0.refusal, c0.operation], [true, '', '', null]);
  mkdirSync(join(fx.main, '.git', 'rebase-merge'));
  const c = await branchModeCheck({ profile: fx.profile, mainDir: fx.main });
  assert.equal(c.ok, false);
  assert.equal(c.operation, 'rebase');
  assert.match(c.reason, /A rebase is in progress in .*; finish or abort it yourself first\./);
  assert.equal(c.refusal, c.reason);
  await assert.rejects(prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base }), /rebase is in progress/);
  assert.equal(sh(fx.main, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

test('prepareBranchMode detaches at the base and finishBranchMode switches back', async t => {
  const fx = fixture(t);
  writeFiles(fx.main, { 'x.txt': 'x\n' });
  const head = commitAll(fx.main, 'second');
  const p = await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base });
  assert.equal(p.tree, fx.main);
  assert.equal(p.head, fx.base);
  assert.deepEqual(p.original, { branch: 'main', sha: head });
  assert.equal(p.originalBranch, 'main');
  assert.equal(sh(fx.main, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');

  writeFiles(fx.main, { 'apps/api/src/a.txt': 'run edit\n' });
  await assert.rejects(finishBranchMode({ mainDir: fx.main, original: p.original }), /1 changed file; save or drop them/);
  await resetTree(fx.main, fx.base, { allowMain: true });
  assert.deepEqual(await finishBranchMode({ mainDir: fx.main, original: p.original }), { branch: 'main', sha: head });

  writeFiles(fx.main, { 'dirty.txt': 'd\n' });
  await assert.rejects(prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base }), /1 changed file; commit or set them aside yourself/);
  assert.equal(sh(fx.main, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'a refusal switches nothing');
  assert.equal(existsSync(join(fx.main, '.git', BRANCH_MODE_FILE)), false, 'and records nothing');
  rmSync(join(fx.main, 'dirty.txt'));

  // A checkout that was detached: the executor keeps only originalBranch (''), so the record
  // supplies the commit to go back to.
  sh(fx.main, ['switch', '-q', '--detach', fx.base]);
  const q = await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: head });
  assert.deepEqual(q.original, { branch: null, sha: fx.base });
  assert.equal(q.originalBranch, '');
  assert.deepEqual(await finishBranchMode({ mainDir: fx.main, branch: q.originalBranch }), { branch: null, sha: fx.base });
  await assert.rejects(finishBranchMode({ mainDir: fx.main, original: {} }), /no recorded branch/);
  await assert.rejects(prepareBranchMode({ profile: fx.profile, mainDir: join(fx.main, 'apps'), baseSha: fx.base }), /not the top folder/);
});

test('branch mode: reset and patch need allowMain, the record covers only its own commit gate, and it all ends at finish', async t => {
  const fx = fixture(t);
  writeFiles(fx.main, { 'x.txt': 'x\n' });
  const head = commitAll(fx.main, 'second');
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout/, 'refused before branch mode');

  const runId = '261022-104212-example';
  const p = await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base, runId });
  const state = await branchModeState(fx.main);
  assert.equal(state.base, fx.base);
  assert.equal(state.runId, runId);
  assert.equal(state.atBase, true);
  assert.equal(state.head, fx.base);
  assert.deepEqual(state.original, { branch: 'main', sha: head });
  assert.ok(existsSync(join(fx.main, '.git', BRANCH_MODE_FILE)));
  await assert.rejects(prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base }), /already in branch mode for run 261022-104212-example; finish that run first/);

  // The run edits, is stopped (patch, reset), resumed (apply) and committed, all in main.
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'run edit\n', 'apps/api/src/n.txt': 'new\n' });
  const patch = await savePatch(fx.main, fx.base, join(fx.root, 'bm', 'stopped.patch'));
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout, not the app's run worktree/, 'the record alone never allows a reset');
  assert.equal(text(fx.main, 'apps/api/src/n.txt'), 'new\n');
  await resetTree(fx.main, fx.base, { allowMain: true });
  assert.equal(porcelain(fx.main), '');
  await assert.rejects(applyPatch(fx.main, patch.file), /main checkout/, 'nor a patch');
  await applyPatch(fx.main, patch.file, { allowMain: true });
  const files = ['apps/api/src/a.txt', 'apps/api/src/n.txt'];
  const gatedTreeSha = await treeHash(fx.main, fx.base, files);
  const commit = over => commitInTree({ tree: fx.main, base: fx.base, branch: 'app/1022-branch-mode', files, messageFile: messageFile(fx.root), gatedTreeSha, ...over });
  await assert.rejects(commit({ runId: 'another-run' }), /does not commit in .*: it is a main checkout/, 'a record of another run does not count');
  const c = await commit({ runId });
  assert.equal(c.commitTree, gatedTreeSha);
  assert.equal(sh(fx.main, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached after the commit');
  const after = await branchModeState(fx.main);
  assert.ok(after && after.atBase === false && after.head === c.sha, 'still in branch mode until finish, at the new app/ branch tip');
  await assert.rejects(prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base }), /already in branch mode/);

  // The executor passes the branch name it stored.
  assert.deepEqual(await finishBranchMode({ mainDir: fx.main, branch: p.originalBranch }), { branch: 'main', sha: head });
  assert.equal(existsSync(join(fx.main, '.git', BRANCH_MODE_FILE)), false);
  assert.equal(await branchModeState(fx.main), null);
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout/, 'refused again after the run');
  await assert.rejects(resetTree(fx.main, fx.base, { allowMain: true }), /on branch main/, 'even with allowMain, back on the branch');
  await assert.rejects(applyPatch(fx.main, patch.file), /main checkout/);
  assert.equal(sh(fx.main, ['log', '-1', '--format=%s', 'app/1022-branch-mode']), 'Example change');
});

test('commitInTree in branch mode with allowMain, the way the executor calls it', async t => {
  const fx = fixture(t);
  const p = await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base });
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'run edit\n' });
  const files = ['apps/api/src/a.txt'];
  const gatedTreeSha = await treeHash(fx.main, fx.base, files);
  const c = await commitInTree({ tree: fx.main, base: fx.base, branch: 'app/1022-allowed', files, messageFile: messageFile(fx.root), gatedTreeSha, allowMain: true });
  assert.equal(c.treeSha, gatedTreeSha);
  assert.deepEqual(await finishBranchMode({ mainDir: fx.main, original: p.original }), { branch: 'main', sha: fx.base });
});

test('a branch mode record left behind after a manual switch back counts for nothing', async t => {
  const fx = fixture(t);
  const file = join(fx.main, '.git', BRANCH_MODE_FILE);
  writeFileSync(file, JSON.stringify({ version: 1, base: fx.base, original: { branch: 'main', sha: fx.base }, runId: 'old' }));
  assert.equal(await branchModeState(fx.main), null, 'HEAD is on a branch, so the record is stale');
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'user work\n' });
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout/);
  assert.equal(text(fx.main, 'apps/api/src/a.txt'), 'user work\n');
  sh(fx.main, ['checkout', '-q', '--', '.']);
  writeFileSync(file, 'not json');
  assert.equal(await branchModeState(fx.main), null, 'an unreadable record counts as none');
  writeFileSync(file, JSON.stringify({ version: 1, base: '--orphan', original: { branch: 'main' } }));
  assert.equal(await branchModeState(fx.main), null, 'a record without a commit sha counts as none');
  const p = await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base, runId: 'new' });
  assert.equal((await branchModeState(fx.main)).runId, 'new', 'a stale record is replaced');
  await finishBranchMode({ mainDir: fx.main, original: p.original });
});

test('a crash-left branch mode record never lets the app touch a checkout the user detached somewhere else', async t => {
  const fx = fixture(t);
  writeFiles(fx.main, { 'x.txt': 'x\n' });
  const head = commitAll(fx.main, 'second');
  // A branch mode run starts, then the app stops without finishBranchMode (a crash).
  await prepareBranchMode({ profile: fx.profile, mainDir: fx.main, baseSha: fx.base, runId: 'crashed' });
  assert.ok(existsSync(join(fx.main, '.git', BRANCH_MODE_FILE)));
  // The user takes the checkout back, detached at another commit, and works there.
  sh(fx.main, ['switch', '-q', '--detach', 'main']);
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'user work\n', 'notes.txt': 'user notes\n' });
  assert.equal(await branchModeState(fx.main), null, 'HEAD is not where the run put it, so the record is stale');

  const p = await savePatch(fx.main, head, join(fx.root, 'user.patch'));
  await assert.rejects(resetTree(fx.main, fx.base), /main checkout, not the app's run worktree/);
  await assert.rejects(applyPatch(fx.main, p.file), /main checkout/);
  const files = ['apps/api/src/a.txt'];
  const gatedTreeSha = await treeHash(fx.main, head, files);
  await assert.rejects(
    commitInTree({ tree: fx.main, base: head, branch: 'app/1022-x', files, messageFile: messageFile(fx.root), gatedTreeSha }),
    /does not commit in .*: it is a main checkout/,
  );
  assert.equal(text(fx.main, 'apps/api/src/a.txt'), 'user work\n', 'tracked work survives');
  assert.equal(text(fx.main, 'notes.txt'), 'user notes\n', 'untracked work survives');
  assert.equal(sh(fx.main, ['rev-parse', 'HEAD']), head, 'HEAD did not move');
  assert.ok(!branches(fx.main).includes('app/1022-x'));
  await assert.rejects(finishBranchMode({ mainDir: fx.main }), /no recorded branch/, 'a stale record supplies no branch to switch to');

  // The same with HEAD detached at a child of the recorded base that is not an app/ branch tip.
  sh(fx.main, ['stash', 'push', '-q', '-u']); // test setup only
  sh(fx.main, ['switch', '-q', '--detach', fx.base]);
  writeFiles(fx.main, { 'y.txt': 'y\n' });
  sh(fx.main, ['add', 'y.txt']);
  sh(fx.main, ['commit', '-q', '-m', 'user commit on a detached head']);
  assert.equal(await branchModeState(fx.main), null);
});

test('commitInTree refuses a main checkout that is not in branch mode', async t => {
  const fx = fixture(t);
  sh(fx.main, ['switch', '-q', '--detach', fx.base]);
  writeFiles(fx.main, { 'apps/api/src/a.txt': 'edit\n' });
  const files = ['apps/api/src/a.txt'];
  const gatedTreeSha = await treeHash(fx.main, fx.base, files);
  const before = branches(fx.main);
  await assert.rejects(
    commitInTree({ tree: fx.main, base: fx.base, branch: 'app/1022-x', files, messageFile: messageFile(fx.root), gatedTreeSha }),
    /does not commit in .*: it is a main checkout/,
  );
  assert.deepEqual(branches(fx.main), before);
  sh(fx.main, ['switch', '-q', 'main']);
  await assert.rejects(
    commitInTree({ tree: fx.main, base: fx.base, branch: 'app/1022-x', files, messageFile: messageFile(fx.root), gatedTreeSha, allowMain: true }),
    /on branch main, so it is not in branch mode/,
  );
  assert.deepEqual(branches(fx.main), before);
});

// ---------------------------------------------------------------- names and archive

test('branchName builds app/<mmdd>-<slug> from up to three meaningful words', () => {
  const day = new Date(2026, 9, 22, 12, 0, 0);
  assert.equal(branchName('Move SaleTab money math into a tested cents module', day), 'app/1022-saletab-money-math');
  assert.equal(branchName('Fix the login bug on the web', day), 'app/1022-login-bug-web');
  assert.equal(branchName('Refactor: add an id', day), 'app/1022-change', 'nothing meaningful left');
  assert.equal(branchName('', day), 'app/1022-change');
  assert.equal(branchName('Crème brûlée café', new Date(2026, 0, 5)), 'app/0105-creme-brulee-cafe');
  assert.equal(branchName('cache cache CACHE layer', day), 'app/1022-cache-layer');
  assert.equal(branchName('x'.repeat(30) + ' ' + 'y'.repeat(30), day), `app/1022-${'x'.repeat(30)}-${'y'.repeat(9)}`);
  assert.equal(branchName('split pricing', day, ['app/1022-split-pricing']), 'app/1022-split-pricing-2');
  assert.equal(branchName('split pricing', day, new Set(['app/1022-split-pricing', 'app/1022-split-pricing-2'])), 'app/1022-split-pricing-3');
  assert.equal(branchName('split pricing', day, [{ name: 'app/1022-split-pricing' }]), 'app/1022-split-pricing-2');
  assert.equal(branchName('split pricing', day.toISOString(), ['refs/heads/app/1022-split-pricing']), 'app/1022-split-pricing-2');
  assert.throws(() => branchName('x', 'not a date'), /not a date/);
  assert.ok(STOP_WORDS.has('the') && STOP_WORDS.has('refactor'));
  assert.equal(APP_PREFIX, 'app/');
});

test('archiveBranch renames app/ branches to archive/app/ and refuses the rest', async t => {
  const fx = fixture(t);
  sh(fx.main, ['branch', 'app/0101-old']);
  sh(fx.main, ['branch', 'feature/x']);
  assert.deepEqual(await archiveBranch(fx.main, 'app/0101-old'), { from: 'app/0101-old', to: 'archive/app/0101-old' });
  assert.ok(branches(fx.main).includes('archive/app/0101-old'));
  assert.ok(!branches(fx.main).includes('app/0101-old'));

  await assert.rejects(archiveBranch(fx.main, 'feature/x'), /Only app\/ branches can be archived/);
  await assert.rejects(archiveBranch(fx.main, 'main'), /Only app\/ branches/);
  await assert.rejects(archiveBranch(fx.main, 'app/0101-nope'), /There is no branch/);
  await assert.rejects(archiveBranch(fx.main, 'app/../main'), /not a valid branch name/);

  sh(fx.main, ['worktree', 'add', '-q', '-b', 'app/0102-busy', join(fx.root, 'busy')]);
  await assert.rejects(archiveBranch(fx.main, 'app/0102-busy'), /is checked out in .*busy; switch that checkout/);
  sh(fx.main, ['switch', '-q', '-c', 'app/0103-here']);
  await assert.rejects(archiveBranch(fx.main, 'app/0103-here'), /is checked out in/);
  sh(fx.main, ['switch', '-q', 'main']);
  sh(fx.main, ['branch', 'app/0101-old']);
  await assert.rejects(archiveBranch(fx.main, 'app/0101-old'), /archive\/app\/0101-old already exists; the app never overwrites a branch/);
});

// ---------------------------------------------------------------- R17 and R18

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const literalsIn = text => [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map(m => m[1] ?? m[2] ?? m[3]);

// The argument lists a module hands to git: the array literal after every git(<dir>, call, plus
// shared flag lists (const NAME_FLAGS = [...]). Each comes back as its string literals in order.
function gitArgLists(src) {
  const code = stripComments(src);
  const calls = [...code.matchAll(/\bgit\(\s*[\w.]+\s*,\s*\[([\s\S]*?)\]/g)].map(m => ({ raw: m[1], lits: literalsIn(m[1]) }));
  const flags = [...code.matchAll(/const\s+\w+_FLAGS\s*=\s*\[([\s\S]*?)\]/g)].map(m => ({ raw: m[1], lits: literalsIn(m[1]), flags: true }));
  return [...calls, ...flags];
}

// Which git subcommands the app may run, and what may follow some of them.
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'symbolic-ref', 'log', 'status', 'for-each-ref', 'worktree', 'diff', 'ls-files',
  'cat-file', 'ls-tree', 'remote', 'rev-list', 'read-tree', 'add', 'write-tree', 'checkout', 'restore', 'clean', 'apply', 'switch', 'branch', 'commit']);
const NEVER = ['push', 'merge', 'stash', 'pull', 'rebase', 'reset', 'fetch', 'cherry-pick', 'prune', 'gc', '--no-verify', '-n', '--force', '-f',
  '-x', '-X', '-fdx', '-xfd', '-ffd', '-fx', '--hard', '-D', '-C', '--discard-changes', '--mirror', '--delete', '--ignored'];

test('R17/R18 static: the git argument lists never push, merge, stash, skip hooks or clean ignored files', () => {
  let count = 0;
  for (const file of [join(here, '..', 'core', 'git.mjs'), join(here, 'worktree.mjs')]) {
    const src = readFileSync(file, 'utf8');
    for (const { raw, lits, flags } of gitArgLists(src)) {
      count++;
      const where = `${basename(file)}: [${raw.trim().slice(0, 100)}]`;
      for (const bad of NEVER) assert.ok(!lits.includes(bad), `${where} passes "${bad}"`);
      if (flags) continue;
      assert.match(raw.trim(), /^['"`]/, `${where} starts with a literal subcommand`);
      const [sub, next] = lits;
      assert.ok(ALLOWED_SUBCOMMANDS.has(sub), `${where}: git ${sub} is not on the allowed list`);
      if (sub === 'commit') assert.deepEqual(lits, ['commit', '-F'], `${where}: commit takes only -F <file>`);
      if (sub === 'clean') assert.deepEqual(lits, ['clean', '-fd'], `${where}: clean is -fd only`);
      if (sub === 'branch') assert.ok(['-m', '-d'].includes(next), `${where}: branch only renames or removes an empty gate branch`);
      if (sub === 'worktree') assert.ok(['list', 'add'].includes(next), `${where}: worktree only lists or adds`);
      if (sub === 'remote') assert.equal(next, 'get-url', where);
      if (sub === 'checkout') assert.deepEqual(lits.slice(0, 3), ['checkout', '-q', '--detach'], `${where}: checkout only detaches`);
    }
    // Outside argument lists too: no stash literal, no hook skipping, no blocking or shell spawns.
    assert.ok(!literalsIn(stripComments(src)).includes('stash'), `${file} names the stash command`);
    assert.doesNotMatch(src, /--no-verify/, file);
    assert.doesNotMatch(src, /spawnSync|execSync|shell:\s*true|\.cmd['"]|\.bat['"]/, file);
  }
  assert.ok(count >= 40, `the scan found ${count} git argument lists`);
});

test('R17/R18 behaviour: a whole run touches the main checkout only by adding the commit branch', async t => {
  const fx = fixture(t);
  // The user's own work in progress in the main checkout, which must survive untouched.
  writeFiles(fx.main, { 'apps/web/src/c.txt': 'user is editing\n', 'scratch/notes.md': 'user notes\n' });
  writeHook(fx.main, "printf 'formatted\\n' > apps/api/src/new.txt\ngit add apps/api/src/new.txt");
  const mainStatus = porcelain(fx.main);
  const mainHead = sh(fx.main, ['rev-parse', 'HEAD']);
  const mainBranches = branches(fx.main);
  const mainIndex = readFileSync(join(fx.main, '.git', 'index'));
  const stashBefore = stashCount(fx.main);

  // Trace2 events record every git process; the app's own calls are the top-level ones (a sid
  // without "/"). git's internal children and the project's hook commands are nested below them.
  const trace = join(fx.root, 'git-trace2.jsonl');
  const saved = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  t.after(() => { if (saved === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = saved; });

  const runner = fakeRunner();
  await setupWorktree({ ...fx, mainDir: fx.main, runCommand: runner.runCommand });
  await prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base, runCommand: runner.runCommand });
  // Claude's edits, a stop that keeps the patch, a resume, then the commit gate.
  writeFiles(fx.run, { 'apps/api/src/a.txt': 'claude\n', 'apps/api/src/new.txt': 'claude new\n' });
  const patch = await savePatch(fx.run, fx.base, join(fx.root, 'stopped.patch'));
  await resetTree(fx.run, fx.base);
  await prepareRunTree({ ...fx, mainDir: fx.main, baseSha: fx.base, runCommand: runner.runCommand });
  await applyPatch(fx.run, patch.file);
  const files = ['apps/api/src/a.txt', 'apps/api/src/new.txt'];
  const gatedTreeSha = await treeHash(fx.run, fx.base, files);
  const branch = branchName('Example api change', new Date(2026, 9, 22), mainBranches);
  const c = await commitInTree({ tree: fx.run, base: fx.base, branch, files, messageFile: messageFile(fx.root), gatedTreeSha });
  assert.deepEqual(c.hookChanged, ['apps/api/src/new.txt']);
  await resetTree(fx.run, c.sha);
  delete process.env.GIT_TRACE2_EVENT;

  assert.equal(porcelain(fx.main), mainStatus, 'the main checkout files are untouched');
  assert.equal(sh(fx.main, ['rev-parse', 'HEAD']), mainHead);
  assert.deepEqual(readFileSync(join(fx.main, '.git', 'index')), mainIndex, 'the main index is untouched');
  assert.deepEqual(branches(fx.main), [...mainBranches, branch].sort(), 'only the commit branch was added');
  assert.equal(stashCount(fx.main), stashBefore);
  assert.equal(existsSync(join(fx.main, '.git', BRANCH_MODE_FILE)), false, 'worktree mode writes no branch mode record');
  assert.equal(text(fx.main, 'scratch/notes.md'), 'user notes\n');

  const commands = appGitCommands(trace);
  assert.ok(commands.length > 20, `the trace saw ${commands.length} app git commands`);
  assert.ok(commands.some(a => a[0] === 'commit' && a[1] === '-F'), 'the trace saw the commit');
  assert.ok(commands.some(a => a[0] === 'worktree' && a[1] === 'add'), 'the trace saw the setup');
  for (const [sub, ...rest] of commands) {
    const cmd = [sub, ...rest].join(' ');
    assert.ok(!['push', 'merge', 'stash', 'pull', 'rebase', 'reset', 'fetch'].includes(sub), `ran git ${cmd}`);
    assert.ok(!rest.includes('--no-verify') && !(sub === 'commit' && rest.includes('-n')), `ran git ${cmd}`);
    if (sub === 'clean') assert.deepEqual(rest, ['-fd'], `ran git ${cmd}`);
  }
  // The commit leaves no background maintenance running in the user's repo.
  const nested = appGitCommands(trace, { nested: true });
  assert.ok(nested.some(a => a[0] === 'add'), 'the trace saw the hook');
  assert.ok(!nested.some(a => a[0] === 'maintenance' || a[0] === 'gc'), 'no auto maintenance after the commit');
});

// Git commands from a trace2 event file, as argument lists with git's own "-c x=y" and
// "-C <dir>" options dropped: the top-level "start" events (the app's own calls), or with
// nested: true the ones started below them (git's internal children and hook commands).
function appGitCommands(file, { nested = false } = {}) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('"event":"start"')) continue;
    const e = JSON.parse(line);
    if (String(e.sid).includes('/') !== nested) continue;
    const argv = e.argv.slice(1);
    while (argv[0] === '-c' || argv[0] === '-C') argv.splice(0, 2);
    out.push(argv);
  }
  return out;
}
