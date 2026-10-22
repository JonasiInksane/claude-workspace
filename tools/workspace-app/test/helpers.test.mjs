// Tests for test/helpers.mjs, the helpers every package's tests share: temporary folders that are
// removed without following junctions, temporary git repos, the fake profile, an example repo whose
// tests really run with the example profile's commands, TAP text and waitFor.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import {
  commitAll, exampleRepoFiles, fakeProfile, makeRepo, removeTree, runGit, tapLines, tempDir, waitFor, writeFiles,
} from './helpers.mjs';
import { exampleProfile, resolveArgv, validateProfile } from '../profile/profile.mjs';
import { walk } from '../core/glob.mjs';

// A child node. NODE_TEST_CONTEXT is removed: the parent test runner sets it, and a child
// `node --test` that inherits it reports in the runner's internal format instead of TAP.
const runNode = (args, cwd) => new Promise(resolveP => {
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  execFile(process.execPath, args, { cwd, windowsHide: true, env }, (err, stdout, stderr) => {
    resolveP({ code: err ? err.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

test('tempDir makes a folder under os.tmpdir() and removes it when the test ends', async t => {
  let dir;
  await t.test('inner', tt => {
    dir = tempDir('ws helper/odd:name', tt);
    assert.ok(existsSync(dir));
    const rel = relative(realpathSync.native(tmpdir()).toLowerCase(), dir.toLowerCase());
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `${dir} is under the temp folder`);
    assert.match(dir, /ws-helper-odd-name/);
  });
  assert.equal(existsSync(dir), false);
});

test('removeTree removes a junction inside the tree without touching its target', t => {
  const outside = tempDir('ws-target-', t);
  writeFileSync(join(outside, 'keep.txt'), 'precious');
  const dir = tempDir('ws-tree-', t);
  writeFiles(dir, { 'a/b.txt': 'x' });
  symlinkSync(outside, join(dir, 'a', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  removeTree(dir);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'precious');
  removeTree(join(dir, 'gone')); // a missing path is fine
});

test('writeFiles writes text, Buffers and JSON objects, and refuses paths that leave the folder', t => {
  const dir = tempDir('ws-write-', t);
  writeFiles(dir, { 'a/b.txt': 'hi', 'bin.dat': Buffer.from([1, 2]), 'x.json': { a: 1 } });
  assert.equal(readFileSync(join(dir, 'a', 'b.txt'), 'utf8'), 'hi');
  assert.deepEqual([...readFileSync(join(dir, 'bin.dat'))], [1, 2]);
  assert.equal(readFileSync(join(dir, 'x.json'), 'utf8'), '{\n  "a": 1\n}\n');
  for (const bad of ['../x', 'a/../../x', 'C:/x', '/x', 'a\\b', '']) assert.throws(() => writeFiles(dir, { [bad]: 'x' }), /must be a posix path inside the folder/, bad);
});

test('makeRepo and commitAll: SHAs, branch main, and the test git config', async t => {
  const dir = tempDir('ws-repo-', t);
  const sha = await makeRepo(join(dir, 'r'), { files: { 'a.txt': 'line\r\n' }, commit: 'first' });
  const repo = join(dir, 'r');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(await runGit(repo, ['log', '-1', '--format=%s']), 'first');
  assert.equal(await runGit(repo, ['config', 'core.autocrlf']), 'false');
  assert.equal(await runGit(repo, ['config', 'user.name']), 't');
  assert.equal(await runGit(repo, ['config', 'user.email']), 't@t');
  assert.equal(await runGit(repo, ['cat-file', '-s', `${sha}:a.txt`]), '6', 'CRLF is stored as written (6 bytes)');
  writeFiles(repo, { 'b.txt': 'b' });
  const sha2 = await commitAll(repo, 'second');
  assert.notEqual(sha2, sha);
  assert.equal(await runGit(repo, ['status', '--porcelain']), '');
  const sha3 = await commitAll(repo, 'empty');
  assert.notEqual(sha3, sha2, 'an empty commit is allowed');
  await assert.rejects(runGit(repo, ['show', 'nope:x']), /git show nope:x failed/);
});

test('fakeProfile copies the example and merges overrides (null removes a key, arrays replace)', () => {
  const a = fakeProfile();
  a.env.preset.EXAMPLE_TEST_MODE = 'changed';
  assert.equal(fakeProfile().env.preset.EXAMPLE_TEST_MODE, 'true', 'each call is a fresh copy');
  const b = fakeProfile({ env: { preset: { EXAMPLE_CACHE_PORT: '6379' } }, mainCheckoutGuard: null, workspaces: [{ id: 'w', dir: 'w', label: 'W' }], extra: undefined });
  assert.equal(b.env.preset.EXAMPLE_CACHE_PORT, '6379');
  assert.equal(b.env.preset.EXAMPLE_TEST_MODE, 'true', 'objects merge');
  assert.equal('mainCheckoutGuard' in b, false);
  assert.deepEqual(b.workspaces, [{ id: 'w', dir: 'w', label: 'W' }]);
  assert.equal('extra' in b, false);
  assert.deepEqual(fakeProfile(), exampleProfile());
  assert.equal(validateProfile(fakeProfile()).ok, true);
});

test('an example repo runs with the example profile commands on this Node (tests pass, TAP out)', async t => {
  const dir = tempDir('ws-example-', t);
  await makeRepo(dir, { files: exampleRepoFiles() });
  const profile = fakeProfile();
  for (const id of ['test:api', 'test:web', 'test:root', 'integration:api']) {
    const cmd = profile.commands[id];
    const cwd = join(dir, ...cmd.cwd.split('/'));
    const files = cmd.files.list
      ? cmd.files.list
      : (await Promise.all(cmd.files.roots.map(async r => (await walk(join(cwd, r), { pattern: new RegExp(cmd.files.pattern) })).map(f => `${cmd.cwd === '.' ? '' : `${cmd.cwd}/`}${r}/${f}`)))).flat();
    assert.ok(files.length > 0, `${id} has files`);
    const argv = resolveArgv(cmd.argv, { tree: dir, cwd, files });
    assert.equal(argv[0], process.execPath);
    const r = await runNode(argv.slice(1), cwd);
    assert.equal(r.code, 0, `${id}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^TAP version 13/m);
    assert.match(r.stdout, /^# fail 0$/m);
  }
  const types = profile.commands['types:api'];
  assert.equal((await runNode(resolveArgv(types.argv, { tree: dir }).slice(1), dir)).code, 0);
  const lint = profile.commands['lint:web'];
  const lr = await runNode(resolveArgv(lint.argv, { tree: dir, cwd: join(dir, 'apps', 'web'), files: ['apps/web/src/features/cart/total.mjs'] }).slice(1), join(dir, 'apps', 'web'));
  assert.deepEqual(JSON.parse(lr.stdout), []);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.ok(Object.keys(pkg['lint-staged']).includes(profile.format.glob));
  assert.equal(readFileSync(join(dir, '.nvmrc'), 'utf8').trim(), `v${profile.node.pin}`);
});

test('tapLines builds Node-style TAP: nesting, skip, todo, failures and the summary', () => {
  const text = tapLines([
    { name: 'adds', durationMs: 2 },
    { name: 'skipped one', skip: 'not today' },
    { name: 'later', todo: true },
    { name: 'a suite', type: 'suite', children: [{ name: 'inner ok' }, { name: 'inner bad', ok: false, error: 'Expected 1\nto be 2', expected: 2, actual: 1, location: "C:\\x\\a.test.mjs:3:1" }] },
    { name: 'has # hash' },
  ]);
  const lines = text.split('\n');
  assert.equal(lines[0], 'TAP version 13');
  assert.ok(lines.includes('# Subtest: adds'));
  assert.ok(lines.includes('ok 1 - adds'));
  assert.ok(lines.includes('  duration_ms: 2'));
  assert.ok(lines.includes("  type: 'test'"));
  assert.ok(lines.includes('ok 2 - skipped one # SKIP not today'));
  assert.ok(lines.includes('ok 3 - later # TODO'));
  assert.ok(lines.includes('    # Subtest: inner bad'));
  assert.ok(lines.includes('    not ok 2 - inner bad'));
  assert.ok(lines.includes("      failureType: 'testCodeFailure'"));
  assert.ok(lines.includes('      error: |-'));
  assert.ok(lines.includes('        Expected 1'));
  assert.ok(lines.includes("      code: 'ERR_ASSERTION'"));
  assert.ok(lines.includes("      location: 'C:\\\\x\\\\a.test.mjs:3:1'"), 'backslashes are doubled, as Node prints them');
  assert.ok(lines.includes('    1..2'));
  assert.ok(lines.includes('not ok 4 - a suite'));
  assert.ok(lines.includes("  failureType: 'subtestsFailed'"));
  assert.ok(lines.includes("  error: '1 subtest failed'"));
  assert.ok(lines.includes('ok 5 - has \\# hash'));
  assert.ok(lines.includes('1..5'));
  for (const s of ['# tests 6', '# suites 1', '# pass 3', '# fail 1', '# skipped 1', '# todo 1']) assert.ok(lines.includes(s), s);
  assert.ok(text.endsWith('\n'));
  assert.ok(!tapLines([{ name: 'x' }], { summary: false }).includes('# tests'));
});

test('tapLines quotes and escapes strings the way Node does', () => {
  const lines = tapLines([
    { name: 'a\\b\tc\nd#e', ok: false, expected: "it's", actual: 'it\'s "q" `b`', error: 'x\u001b', code: 'ERR_ASSERTION' },
    { name: 'crlf', ok: false, error: 'one\r\ntwo' },
  ]).split('\n');
  assert.ok(lines.includes('# Subtest: a\\\\b\\\\tc\\\\nd\\#e'), 'the subtest line is escaped too');
  assert.ok(lines.includes('not ok 1 - a\\\\b\\\\tc\\\\nd\\#e'));
  assert.ok(lines.includes('  expected: "it\'s"'));
  assert.ok(lines.includes("  actual: 'it\\'s \"q\" `b`'"));
  assert.ok(lines.includes("  error: 'x\\x1B'"));
  assert.ok(lines.includes('  error: |-') && lines.includes('    one') && lines.includes('    two'), '\\r\\n splits lines');
});

// Node 20 nests a file's tests under a "# Subtest: <file>" wrapper (4 spaces deeper); Node 24
// prints them at the top level with a location. Lines are compared without their indentation.
test('tapLines output has the same line shapes as real Node TAP for a passing and a failing test', async t => {
  const dir = tempDir('ws-tap-', t);
  writeFiles(dir, { 'a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('good', () => {});\ntest('bad', () => { assert.equal(1, 2); });\n" });
  const trimmed = text => text.split(/\r?\n/).map(l => l.trim());
  const real = trimmed((await runNode(['--test', '--test-reporter=tap', 'a.test.mjs'], dir)).stdout);
  const ours = trimmed(tapLines([{ name: 'good' }, { name: 'bad', ok: false }]));
  for (const line of ['TAP version 13', '# Subtest: good', 'ok 1 - good', 'not ok 2 - bad', "failureType: 'testCodeFailure'", "code: 'ERR_ASSERTION'", "type: 'test'", '# pass 1', '# fail 1']) {
    assert.ok(real.includes(line), `real TAP has: ${line}`);
    assert.ok(ours.includes(line), `tapLines has: ${line}`);
  }
  // The location line: decode the path Node printed, give it to tapLines, and the line must come
  // back the same (on Windows that needs Node's doubled backslashes).
  const realLoc = real.find(l => /^location: '.*a\.test\.mjs:4:\d+'$/.test(l));
  if (!realLoc) {
    t.diagnostic('This Node prints no location for the failing test; the location line was not compared.');
    return;
  }
  const path = realLoc.slice("location: '".length, -1).replace(/\\(.)/g, '$1');
  const ourLoc = trimmed(tapLines([{ name: 'bad', ok: false, location: path }])).find(l => l.startsWith('location:'));
  assert.equal(ourLoc, realLoc);
});

test('waitFor returns the first truthy value and times out with a clear message', async () => {
  let n = 0;
  assert.equal(await waitFor(() => (++n >= 3 ? 'done' : false), 1000, { interval: 5 }), 'done');
  assert.equal(await waitFor(async () => 42, 100), 42);
  await assert.rejects(waitFor(() => false, 50, { interval: 10 }), /^Error: waitFor timed out after 50 ms$/);
  await assert.rejects(waitFor(() => { throw new Error('not yet'); }, 30, { interval: 10 }), /timed out after 30 ms: not yet/);
});

test('the shared helpers keep their SPEC names', async () => {
  const mod = await import('./helpers.mjs');
  for (const name of ['tempDir', 'writeFiles', 'makeRepo', 'commitAll', 'fakeProfile', 'tapLines', 'waitFor']) {
    assert.equal(typeof mod[name], 'function', name);
  }
});
