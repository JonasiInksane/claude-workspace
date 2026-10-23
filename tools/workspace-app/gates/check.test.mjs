// Tests for gates/check.mjs: the main-checkout refusal (SPEC R10), runChecks at base and head on
// temporary git repos shaped like the synthetic example project (new, known, flaky, can-shrink,
// G0, G4, cancel, history), tg-check inside a stage (SPEC R8) directly, through the CLI and
// through the sh shim, and the check CLI with the real G0. Test files are real node:test files;
// tsc, ESLint and Prettier are fakes from test/fixtures/check. Secret-shaped strings are built at
// runtime. Everything is written under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from '../core/git.mjs';
import { commitAll, tempDir } from '../test/helpers.mjs';
import {
  checkProfile, exampleCheckRepo, failing, flakyOnce, passing, removeFile, setFile, testFile, toggled, touch,
} from '../test/fixtures/check/repo.mjs';
import { baselineKey, loadBaseline, loadCandidate, typeErrorId } from './baseline.mjs';
import {
  NO_GUARD_MESSAGE, cliMain, envFilesIn, envFilesInAsync, inStage, listeningPorts, mainCheckoutRefusal, mustTickBlocked, refusalFor, runChecks, samePath,
  stageNotRunning, stagePath, summaryText,
} from './check.mjs';
import { lastPerLevel, readHistory } from './history.mjs';
import { writeShim } from './shim.mjs';

const CHECK_PATH = fileURLToPath(new URL('./check.mjs', import.meta.url));
const NODE = process.versions.node;
const TYPE_KNOWN = 'src/billing/charge.mjs(1,14): error TS2322: Type string is not assignable to type number.';
const TYPE_NEW = 'src/auth/session.mjs(1,20): error TS2339: Property teams does not exist on type User.';
const typeId = line => {
  const m = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
  return typeErrorId({ file: m[1], code: m[4], message: m[5] });
};
const secretKey = () => `sk_${'live_'}${'q'.repeat(24)}`;

const rowsById = summary => Object.fromEntries(summary.checks.map(c => [c.id, c]));

// A fresh data folder, gate folder and an onRow collector.
function harness(t) {
  const dataDir = tempDir('wp4-data-', t);
  let n = 0;
  const rows = [];
  return {
    dataDir, rows,
    gateDir: () => join(dataDir, 'runs', 'example', '261022-100000-check-test', 'gates', `0${++n}-checks`),
    onRow: r => rows.push(r),
  };
}

// The example repo with one known failing test (while `toggle` exists) and one known type error.
async function knownRepo(t) {
  const toggle = join(tempDir('wp4-toggle-', t), 'known-bug.on');
  touch(toggle);
  const repo = await exampleCheckRepo(t, {
    files: {
      'apps/api/src/billing/known.test.mjs': toggled('known bug', toggle),
      'apps/api/type-errors.txt': `${TYPE_KNOWN}\n`,
    },
  });
  return { ...repo, toggle };
}

const base = (h, repo, extra = {}) => runChecks({
  profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: repo.dir, treeMode: 'run', baseSha: repo.sha,
  changed: [], level: 'quick', what: 'everything', role: 'base', gateDir: h.gateDir(), onRow: h.onRow, ...extra,
});
const head = async (h, repo, extra = {}) => runChecks({
  profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: repo.dir, treeMode: 'run', baseSha: repo.sha,
  changed: await git.changedFiles(repo.dir, repo.sha, { includeUntracked: true }), level: 'quick', what: 'uncommitted',
  role: 'head', gateDir: h.gateDir(), onRow: h.onRow, runG0: async () => ({ rows: [], ok: true, secretsFound: 0 }), runId: 'r-head', ...extra,
});

// ---------------------------------------------------------------------------------------------
// Main-checkout refusal (R10)

test('mainCheckoutRefusal: only the main checkout with a .env file and no matching guard', t => {
  const dir = tempDir('wp4-main-', t);
  const p = checkProfile();
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'main', guardContent: null }), '', 'no .env, nothing to protect');
  writeFileSync(join(dir, '.env.example'), 'EXAMPLE=1\n');
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'main', guardContent: null }), '', 'example files are not secrets');
  mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'api', '.env.local'), 'CANARY_SECRET=<placeholder>\n');
  assert.deepEqual(envFilesIn(p, dir), ['apps/api/.env.local']);
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'main', guardContent: null }), p.mainCheckoutGuard.message);
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'main', guardContent: 'export const x = 1;' }), p.mainCheckoutGuard.message);
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'main', guardContent: 'if (process.env.EXAMPLE_TEST_MODE) {}' }), '');
  assert.equal(mainCheckoutRefusal({ profile: p, tree: dir, treeMode: 'run', guardContent: null }), '', 'the run worktree has no real .env');
  assert.equal(mainCheckoutRefusal({ profile: checkProfile({ mainCheckoutGuard: null }), tree: dir, treeMode: 'main', guardContent: 'EXAMPLE_TEST_MODE' }), NO_GUARD_MESSAGE);
  writeFileSync(join(dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  assert.deepEqual(envFilesIn(p, dir).sort(), ['.env', 'apps/api/.env.local']);
});

test('the .env check looks at names only and never opens the file', async t => {
  for (const fn of [envFilesIn, envFilesInAsync, mainCheckoutRefusal, refusalFor]) {
    const src = fn.toString();
    assert.ok(!/readFile|openSync|createReadStream|\bopen\(/.test(src), `${fn.name} must not read files`);
  }
  assert.match(envFilesIn.toString(), /readdirSync/);
  assert.match(envFilesInAsync.toString(), /await readdir\(/);
  // A .env that is a folder would make any attempt to read it fail; the check still just sees the name.
  const dir = tempDir('wp4-main-', t);
  mkdirSync(join(dir, '.env'));
  assert.deepEqual(envFilesIn(checkProfile(), dir), ['.env']);
  assert.deepEqual(await envFilesInAsync(checkProfile(), dir), ['.env']);
  assert.equal(await refusalFor({ profile: checkProfile({ mainCheckoutGuard: null }), tree: dir, treeMode: 'main', baseSha: 'a'.repeat(40) }), NO_GUARD_MESSAGE);
});

test('refusalFor reads the guard at the base commit, not in the working tree', async t => {
  const repo = await exampleCheckRepo(t, { files: { 'apps/api/src/env.mjs': 'export const testMode = false;\n' } });
  const p = checkProfile();
  writeFileSync(join(repo.dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  setFile(repo.dir, 'apps/api/src/env.mjs', 'export const testMode = process.env.EXAMPLE_TEST_MODE;\n');
  assert.equal(await refusalFor({ profile: p, tree: repo.dir, treeMode: 'main', baseSha: repo.sha }), p.mainCheckoutGuard.message);
  const sha = await commitAll(repo.dir, 'add the guard');
  assert.equal(await refusalFor({ profile: p, tree: repo.dir, treeMode: 'main', baseSha: sha }), '');
});

test('runChecks refuses the main checkout before running anything', async t => {
  const repo = await exampleCheckRepo(t, { files: { 'apps/api/src/env.mjs': 'export const testMode = false;\n' } });
  writeFileSync(join(repo.dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  const h = harness(t);
  const gateDir = h.gateDir();
  const s = await runChecks({
    profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: repo.dir, treeMode: 'main', baseSha: repo.sha,
    changed: [], level: 'quick', what: 'everything', role: 'head', gateDir, runG0: () => { throw new Error('G0 must not run'); },
  });
  assert.equal(s.result, 'refused');
  assert.equal(s.refusal, checkProfile().mainCheckoutGuard.message);
  assert.deepEqual(s.checks, []);
  assert.deepEqual(readdirSync(gateDir), ['summary.json'], 'no command ran');
  assert.deepEqual(await readHistory(h.dataDir, 'example'), [], 'a refusal is not a finished check');
  const allowed = await exampleCheckRepo(t);
  writeFileSync(join(allowed.dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  const ok = await runChecks({
    profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: allowed.dir, treeMode: 'main', baseSha: allowed.sha,
    changed: [], level: 'quick', what: 'everything', role: 'head', gateDir: h.gateDir(),
  });
  assert.equal(ok.result, 'pass', JSON.stringify(ok.checks.map(c => [c.id, c.status, c.reason])));
  const run = await runChecks({
    profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: repo.dir, treeMode: 'run', baseSha: repo.sha,
    changed: [], level: 'quick', what: 'everything', role: 'head', gateDir: h.gateDir(),
  });
  assert.notEqual(run.result, 'refused', 'run mode is never refused');
});

// ---------------------------------------------------------------------------------------------
// Base

test('role base measures the tree and saves the first baseline', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  const s = await base(h, repo);
  assert.equal(s.result, 'pass', JSON.stringify(s.checks.map(c => [c.id, c.status, c.reason])));
  assert.equal(s.role, 'base');
  assert.equal(s.baselineKey, baselineKey({ baseSha: repo.sha, treeMode: 'run', node: NODE }));
  assert.deepEqual(s.baselineSaved.sort(), ['lint:web', 'test:api', 'test:root', 'test:web', 'types:api', 'types:web']);
  assert.deepEqual(s.tests.known, ['src/billing/known.test.mjs::known bug', typeId(TYPE_KNOWN)].sort());
  assert.equal(s.counts.known, 2);
  assert.match(s.chip, /^2 known in the new baseline/);
  const rows = rowsById(s);
  assert.equal(rows['test:api'].status, 'fail');
  assert.equal(rows['test:api'].reason, '1 failing test at base, recorded as known');
  const saved = await loadBaseline(h.dataDir, 'example', s.baselineKey);
  assert.equal(saved.source, 'first-run');
  assert.deepEqual(saved.commands['test:api'].failures.map(f => f.id), ['src/billing/known.test.mjs::known bug']);
  assert.deepEqual(saved.commands['types:api'].errors, [typeId(TYPE_KNOWN)]);
  assert.deepEqual(await readHistory(h.dataDir, 'example'), [], 'base runs add no history line');
  assert.ok(existsSync(join(h.dataDir, 'runs', 'example', '261022-100000-check-test', 'gates', '01-checks', 'summary.json')));
});

test('role base never changes an existing entry and adds only missing commands', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  const typesOnly = checkProfile({ levels: { quick: { groups: ['G0', 'G1'] } } });
  const first = await base(h, repo, { profile: typesOnly });
  assert.deepEqual(first.baselineSaved.sort(), ['types:api', 'types:web']);
  setFile(repo.dir, 'apps/api/type-errors.txt', `${TYPE_KNOWN}\n${TYPE_NEW}\n`);
  const second = await base(h, repo);
  const rows = rowsById(second);
  assert.equal(rows['types:api'].status, 'skip');
  assert.equal(rows['types:api'].reason, 'Already in the baseline');
  assert.deepEqual(second.baselineSaved.sort(), ['lint:web', 'test:api', 'test:root', 'test:web']);
  const saved = await loadBaseline(h.dataDir, 'example', second.baselineKey);
  assert.deepEqual(saved.commands['types:api'].errors, [typeId(TYPE_KNOWN)], 'the types entry stayed as first measured');
  assert.equal(saved.history.filter(x => x.action === 'first-run').length, 2);
  const third = await base(h, repo);
  assert.deepEqual(third.baselineSaved, []);
  assert.match(third.chip, /nothing new to measure/);
  assert.equal(third.result, 'pass');
});

test('role base with a command that cannot run is an error and leaves that command out', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  const p = checkProfile({ commands: { 'types:web': { argv: ['{node}', '{pkg:typescript/bin/tsc}'] } } });
  const s = await base(h, repo, { profile: p });
  assert.equal(s.result, 'error');
  assert.equal(rowsById(s)['types:web'].status, 'error');
  assert.match(rowsById(s)['types:web'].reason, /typescript\/bin\/tsc is not installed in this tree/);
  const saved = await loadBaseline(h.dataDir, 'example', s.baselineKey);
  assert.equal(saved.commands['types:web'], undefined, 'an error is never recorded as a known failure');
  assert.ok(saved.commands['types:api']);
});

// ---------------------------------------------------------------------------------------------
// Head

test('role head: a planted failure is new, a known one stays known, a flaky one is flaky', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  await base(h, repo);
  setFile(repo.dir, 'apps/api/src/billing/new.test.mjs', failing('new fails', 'a planted failure'));
  setFile(repo.dir, 'apps/api/src/billing/flaky.test.mjs', flakyOnce('flaky once'));
  setFile(repo.dir, 'apps/api/src/billing/charge.mjs', 'export const charge = cents => Math.round(cents * 1.21); // changed\n');
  setFile(repo.dir, 'apps/api/type-errors.txt', `${TYPE_KNOWN}\n${TYPE_NEW}\n`);
  h.rows.length = 0;
  const s = await head(h, repo);
  assert.equal(s.result, 'fail');
  assert.deepEqual(s.tests.new, ['src/billing/new.test.mjs::new fails', typeId(TYPE_NEW)].sort());
  assert.deepEqual(s.tests.known, ['src/billing/known.test.mjs::known bug', typeId(TYPE_KNOWN)].sort());
  assert.deepEqual(s.tests.flaky, ['src/billing/flaky.test.mjs::flaky once']);
  assert.deepEqual(s.tests.canShrink, [], 'a changed tree never shrinks the baseline');
  assert.equal(s.chip, '2 new · 2 known · 1 flaky');
  assert.deepEqual({ new: s.counts.new, known: s.counts.known, flaky: s.counts.flaky }, { new: 2, known: 2, flaky: 1 });
  const rows = rowsById(s);
  assert.equal(rows['test:api'].status, 'fail');
  assert.equal(rows['test:api'].reason, '1 new · 1 known · 1 flaky');
  assert.equal(rows['test:api'].group, 'G2', 'quick runs the focused API tests');
  assert.deepEqual(rows['test:api'].details.new, ['src/billing/new.test.mjs::new fails']);
  assert.match(rows['test:api'].details.failures[0].message, /a planted failure/);
  assert.ok(rows['test:api'].rerunLogs.length >= 2, 'the new and the flaky file were rerun');
  assert.equal(rows['types:api'].status, 'fail');
  assert.deepEqual(rows['types:api'].details.errors.map(e => e.id), [typeId(TYPE_NEW)]);
  assert.equal(rows['types:web'], undefined, 'web is not affected by a billing change');
  // onRow: a running row and a final row per check, each with a one-line msg.
  const forApi = h.rows.filter(r => r.id === 'test:api');
  assert.deepEqual(forApi.map(r => r.status), ['running', 'fail']);
  assert.equal(forApi[1].msg, 'Lint and unit tests: API: fail, 1 new · 1 known · 1 flaky');
  assert.equal(forApi[1].ok, false);
  // History and the summary file.
  const last = await lastPerLevel(h.dataDir, 'example');
  assert.equal(last.quick.result, 'fail');
  assert.equal(last.quick.runId, 'r-head');
  // The test totals are what the API tests' TAP counted at the first run (the new, the flaky and
  // the known failure; the charge test passed); the type errors are in new and known only.
  assert.deepEqual(last.quick.counts, { new: 2, known: 2, flaky: 1, pass: 1, fail: 3, skip: 0, notRun: 0 });
  assert.equal(JSON.parse(readFileSync(join(h.dataDir, 'runs', 'example', '261022-100000-check-test', 'gates', '02-checks', 'summary.json'), 'utf8')).chip, s.chip);
  assert.equal(await loadCandidate(h.dataDir, 'example', s.baselineKey), null);
});

test('role head on a clean tree at base: a known failure that passes writes a candidate', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  await base(h, repo);
  rmSync(repo.toggle);
  const s = await head(h, repo, { what: 'everything', changed: [] });
  assert.equal(s.result, 'pass', JSON.stringify(s.checks.map(c => [c.id, c.status, c.reason])));
  assert.deepEqual(s.tests.canShrink, ['src/billing/known.test.mjs::known bug']);
  assert.deepEqual(s.tests.known, [typeId(TYPE_KNOWN)]);
  assert.equal(s.chip, '0 new · 1 known · 1 now pass');
  assert.equal(rowsById(s)['test:api'].reason, '1 known now pass');
  assert.equal(s.candidate.written, true);
  const cand = await loadCandidate(h.dataDir, 'example', s.baselineKey);
  assert.deepEqual(cand.leaving, ['src/billing/known.test.mjs::known bug']);
  assert.equal(cand.hash, s.candidate.hash);
  assert.equal(cand.from, 2);
  assert.equal(cand.to, 1);
  const saved = await loadBaseline(h.dataDir, 'example', s.baselineKey);
  assert.equal(saved.commands['test:api'].failures.length, 1, 'the baseline itself waits for your click (R15)');
});

test('role head: uncommitted changes found by git block the shrink', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  await base(h, repo);
  rmSync(repo.toggle);
  setFile(repo.dir, 'docs/README.md', '# Records\n\nEdited.\n');
  const s = await head(h, repo, { what: 'everything', changed: [] });
  assert.deepEqual(s.tests.canShrink, []);
  assert.equal(s.candidate, undefined);
});

test('role head without a baseline: every failure is new', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  const s = await head(h, repo, { what: 'everything', changed: [] });
  assert.equal(s.result, 'fail');
  assert.equal(s.baselineMissing, true);
  assert.deepEqual(s.tests.new, ['src/billing/known.test.mjs::known bug', typeId(TYPE_KNOWN)].sort());
  assert.match(rowsById(s)['test:api'].reason, /no baseline entry/);
  assert.match(summaryText(s), /No baseline for this base commit yet/);
});

test('G0 comes from the injected runG0 with a bound runCommand; its rows count', async t => {
  const repo = await exampleCheckRepo(t);
  const h = harness(t);
  setFile(repo.dir, 'scripts/tool.mjs', 'export const double = n => n * 2; // edited\n');
  let seen = null;
  const runG0 = async args => {
    seen = args;
    const r = await args.runCommand({ profile: args.profile, commandId: 'format:changed', tree: args.tree, files: ['scripts/tool.mjs'] });
    const first = { id: 'g0.format', label: 'Format', status: r.status, reason: '', log: r.log };
    args.onRow(first);
    return { rows: [first, { id: 'g0.secrets', label: 'Secret scan', status: 'fail', reason: '1 secret' }], ok: false, secretsFound: 1, failed: ['g0.secrets'] };
  };
  const s = await head(h, repo, { runG0 });
  assert.deepEqual(Object.keys(seen).sort(), ['baseSha', 'gateDir', 'onRow', 'proc', 'profile', 'runCommand', 'signal', 'tree']);
  assert.equal(seen.changed, undefined, 'the caller binds changed (with statuses) itself');
  const rows = rowsById(s);
  assert.equal(rows['g0.format'].status, 'pass');
  assert.equal(rows['g0.format'].group, 'G0');
  assert.equal(rows['g0.secrets'].status, 'fail');
  assert.equal(s.result, 'fail', 'a red G0 row fails the check');
  assert.deepEqual(s.g0, { ok: false, secretsFound: 1, failed: ['g0.secrets'] });
  assert.equal(h.rows.filter(r => r.id === 'g0.format').length, 1, 'a streamed row is not sent twice');
  assert.equal(h.rows.filter(r => r.id === 'g0.secrets').length, 1);
  assert.ok(existsSync(join(seen.gateDir, rows['g0.format'].log)));
});

test('G0 problems: no runner is a skip row, a throwing runner an error row', async t => {
  const repo = await exampleCheckRepo(t);
  const h = harness(t);
  const none = await head(h, repo, { runG0: undefined, what: 'everything', changed: [] });
  assert.equal(rowsById(none).g0.status, 'skip');
  assert.equal(none.result, 'pass');
  const broken = await head(h, repo, { runG0: async () => { throw new Error('the diff could not be read'); }, what: 'everything', changed: [] });
  assert.equal(rowsById(broken).g0.status, 'error');
  assert.equal(rowsById(broken).g0.reason, 'G0 could not run: the diff could not be read');
  assert.equal(broken.result, 'error');
});

test('G4 runs when its port really listens, with the integration env', async t => {
  const server = createServer(s => s.end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const url = `postgresql://test:test@127.0.0.1:${port}/example_it`;
  const repo = await exampleCheckRepo(t, {
    files: { 'apps/api/src/db.integration.mjs': testFile({ 'sees its database': `assert.equal(process.env.EXAMPLE_IT_DB_URL, ${JSON.stringify(url)});` }) },
  });
  const h = harness(t);
  const profile = checkProfile({
    groups: { G4: { requiresPorts: [port] } },
    commands: { 'integration:api': { requiresPorts: [port], env: { EXAMPLE_IT_DB_URL: url } } },
  });
  setFile(repo.dir, 'apps/api/src/billing/charge.mjs', 'export const charge = cents => Math.round(cents * 1.21); // changed\n');
  const s = await head(h, repo, { profile, level: 'paranoid' });
  const it = rowsById(s)['integration:api'];
  assert.equal(it.status, 'pass', `${it.reason} ${it.stderrTail || ''}`);
  assert.equal(it.group, 'G4');
  server.close();
  const down = await head(h, repo, { profile, level: 'paranoid' });
  assert.match(rowsById(down)['integration:api'].reason, /^Not run: start the reliability containers yourself/);
  assert.equal(rowsById(down)['integration:api'].status, 'skip');
  assert.ok(down.counts.notRun >= 1);
});

test('listeningPorts asks only for the ports the level needs, and an explicit list wins', async () => {
  const asked = [];
  const ports = { anyListening: async list => { asked.push(list); return [list[0]]; } };
  const profile = checkProfile();
  assert.deepEqual(await listeningPorts({ profile, level: 'paranoid', ports }), [55001]);
  assert.deepEqual(asked, [[55001]]);
  assert.deepEqual(await listeningPorts({ profile, level: 'quick', ports }), [], 'no group of quick needs a port');
  assert.deepEqual(await listeningPorts({ profile, level: 'paranoid', ports, listening: [7] }), [7]);
  assert.equal(asked.length, 1);
  const broken = { anyListening: async () => { throw new Error('probe failed'); } };
  assert.deepEqual(await listeningPorts({ profile, level: 'paranoid', ports: broken }), []);
});

test('cancel: an aborted check stops and leaves no history line', async t => {
  const repo = await knownRepo(t);
  const h = harness(t);
  const before = new AbortController();
  before.abort();
  const s = await head(h, repo, { signal: before.signal, what: 'everything', changed: [] });
  assert.equal(s.result, 'cancelled');
  assert.ok(s.checks.every(c => c.status === 'skip' && c.reason === 'Cancelled'));
  const during = new AbortController();
  const s2 = await head(h, repo, {
    signal: during.signal, what: 'everything', changed: [],
    onRow: r => { if (r.status === 'running') during.abort(); },
  });
  assert.equal(s2.result, 'cancelled');
  assert.ok(s2.checks.some(c => c.status === 'cancelled'));
  assert.deepEqual(await readHistory(h.dataDir, 'example'), []);
});

test('runChecks: bad options are refused, a broken baseline file is an error', async t => {
  const repo = await exampleCheckRepo(t);
  const h = harness(t);
  const ok = { profile: checkProfile(), project: 'example', dataDir: h.dataDir, tree: repo.dir, treeMode: 'run', baseSha: repo.sha, level: 'quick', gateDir: h.gateDir() };
  await assert.rejects(runChecks({ ...ok, gateDir: undefined }), /needs a gate folder/);
  await assert.rejects(runChecks({ ...ok, role: 'middle' }), /role must be "base" or "head"/);
  await assert.rejects(runChecks({ ...ok, project: '../x' }), /not a valid project name/);
  await assert.rejects(runChecks({ ...ok, level: 'huge' }), /no check level "huge"/);
  const key = baselineKey({ baseSha: repo.sha, treeMode: 'run', node: NODE });
  mkdirSync(join(h.dataDir, 'baselines', 'example'), { recursive: true });
  writeFileSync(join(h.dataDir, 'baselines', 'example', `${key}.json`), '{ broken');
  const s = await runChecks({ ...ok, what: 'everything' });
  assert.equal(s.result, 'error');
  assert.match(s.error, /could not be read/);
});

// ---------------------------------------------------------------------------------------------
// tg-check in a stage (R8)

const RUN_ID = '261022-104212-refactor-test-run';

// A data folder with the profile and a running implement stage of a run on `repo`.
function stageSetup(t, repo, { run = {}, ctx = {}, stage = {} } = {}) {
  const dataDir = tempDir('wp4-stage-', t);
  mkdirSync(join(dataDir, 'profiles'), { recursive: true });
  writeFileSync(join(dataDir, 'profiles', 'example.json'), `${JSON.stringify(checkProfile(), null, 2)}\n`);
  const runDir = join(dataDir, 'runs', 'example', RUN_ID);
  const stageDir = join(runDir, 'stages', '05-implement');
  mkdirSync(stageDir, { recursive: true });
  const runDoc = {
    version: 1, id: RUN_ID, project: 'example', pipeline: 'refactor', status: 'running',
    isolation: { mode: 'worktree', tree: repo.dir, mainDir: 'C:\\example-main', treeMode: 'run' },
    base: { branch: 'main', sha: repo.sha },
    stages: [
      { id: 'scope', n: 1, kind: 'claude', status: 'done', attempts: [{ k: 1, folder: 'stages/01-scope', endedAt: '2026-10-22T10:00:00Z' }] },
      { id: 'implement', n: 5, kind: 'claude', status: 'running', attempts: [{ k: 1, folder: 'stages/05-implement', startedAt: '2026-10-22T10:01:00Z' }], ...stage },
    ],
    ...run,
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runDoc));
  const p = checkProfile();
  writeFileSync(join(stageDir, 'check-context.json'), JSON.stringify({
    runDir, project: 'example', tree: repo.dir, baseSha: repo.sha,
    planFiles: ['apps/api/src/billing/charge.mjs'], plannedTests: ['apps/api/src/other/planned.test.mjs'],
    ticked: [], testPattern: p.fences.testPattern, mustTick: p.fences.mustTick, allowed: ['test', 'types', 'lint'], ...ctx,
  }));
  return { dataDir, runDir, stageDir };
}

test('tg-check test runs a test that existed at base and prints a short report', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir, runDir } = stageSetup(t, repo);
  const r = await inStage(stageDir, ['test', 'apps/api/src/billing/charge.test.mjs']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, 'tg-check test: 1 test in 1 file, 1 passed, 0 failed, 0 skipped\n');
  assert.ok(existsSync(join(stageDir, 'tg-check', '001-test', 'test-api.log')));
  assert.ok(existsSync(join(runDir, 'tmp', '05-implement', 'tg-check-001-test')), 'its TEMP sits in the run tmp folder');
  setFile(repo.dir, 'apps/api/src/billing/charge.test.mjs', failing('charge adds tax', 'tax went missing'));
  const bad = await inStage(stageDir, ['test', 'apps\\api\\src\\billing\\charge.test.mjs']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^tg-check test: 1 test in 1 file, 0 passed, 1 failed/);
  assert.match(bad.text, /not ok - apps\/api\/src\/billing\/charge\.test\.mjs::charge adds tax \[assertion\]/);
  assert.match(bad.text, /tax went missing/);
  assert.ok(existsSync(join(stageDir, 'tg-check', '002-test')), 'each call gets its own log folder');
});

test('tg-check test accepts planned tests and new tests next to a plan file', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  setFile(repo.dir, 'apps/api/src/billing/extra.test.mjs', passing('extra'));
  setFile(repo.dir, 'apps/api/src/other/planned.test.mjs', passing('planned'));
  const r = await inStage(stageDir, ['test', 'apps/api/src/billing/extra.test.mjs', join(repo.dir, 'apps', 'api', 'src', 'other', 'planned.test.mjs')]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^tg-check test: 2 tests in 2 files, 2 passed/);
});

test('tg-check test refuses paths outside base, plan and plan folders', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  // (apps/api/src/auth/** is a must-tick area in the example, which would switch tg-check off first.)
  setFile(repo.dir, 'apps/web/src/features/cart/sneaky.test.mjs', passing('sneaky'));
  const outside = tempDir('wp4-outside-', t);
  writeFileSync(join(outside, 'x.test.mjs'), passing('x'));
  const cases = [
    ['apps/web/src/features/cart/sneaky.test.mjs', /cart\/sneaky\.test\.mjs is not a test that existed at base, a planned test, or a new test next to a plan file/],
    ['../outside.test.mjs', /\.\.\/outside\.test\.mjs is not a path inside the repository/],
    [join(outside, 'x.test.mjs'), /is not a path inside the repository/],
    ['apps/api/src/nope.test.mjs', /apps\/api\/src\/nope\.test\.mjs does not exist/],
    ['apps/api/src/billing/charge.mjs', /charge\.mjs is not a test file of any workspace's test command/],
  ];
  for (const [path, re] of cases) {
    const r = await inStage(stageDir, ['test', 'apps/api/src/billing/charge.test.mjs', path]);
    assert.equal(r.code, 1, path);
    assert.match(r.text, /^tg-check: tg-check test refused: /, path);
    assert.match(r.text, re, path);
  }
  assert.ok(!existsSync(join(stageDir, 'tg-check', '001-test', 'test-api.log')), 'nothing ran for a refused call');
});

test('tg-check is off while an unticked must-tick file differs from base', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  setFile(repo.dir, 'apps/api/package.json', { name: 'api', private: true, scripts: { postinstall: 'node evil.mjs' } });
  const r = await inStage(stageDir, ['test', 'apps/api/src/billing/charge.test.mjs']);
  assert.equal(r.code, 1);
  assert.equal(r.text, 'tg-check: tg-check is off while apps/api/package.json differs from base; it was not ticked in the plan.\n');
  const ticked = stageSetup(t, repo, { ctx: { ticked: ['apps/api/package.json'] } });
  assert.equal((await inStage(ticked.stageDir, ['test', 'apps/api/src/billing/charge.test.mjs'])).code, 0);
  removeFile(repo.dir, 'apps/api/package.json');
  await git.git(repo.dir, ['checkout', '--', 'apps/api/package.json']);
  setFile(repo.dir, 'apps/api/migrations/001.sql', 'create table x (id int);\n');
  const added = await inStage(stageDir, ['test', 'apps/api/src/billing/charge.test.mjs']);
  assert.match(added.text, /off while apps\/api\/migrations\/001\.sql differs from base/, 'mustTickNew counts for added files');
});

test('mustTickBlocked looks at renames and at must-tick-new only for added files', () => {
  const rules = { ticked: [], mustTick: ['**/package.json'], mustTickNew: ['db/migrations/**'] };
  assert.equal(mustTickBlocked(rules, [{ path: 'src/a.mjs', status: 'M' }]), '');
  assert.equal(mustTickBlocked(rules, [{ path: 'x/pkg.json', status: 'R', oldPath: 'x/package.json' }]), 'x/package.json');
  assert.equal(mustTickBlocked(rules, [{ path: 'db/migrations/1.sql', status: 'M' }]), '');
  assert.equal(mustTickBlocked(rules, [{ path: 'db/migrations/2.sql', status: 'A' }]), 'db/migrations/2.sql');
  assert.equal(mustTickBlocked({ ...rules, ticked: ['package.json'] }, ['package.json']), '');
  // Windows ignores case, so a different spelling is the same file (R8, as in gates/fences.mjs).
  assert.equal(mustTickBlocked(rules, [{ path: 'apps/web/PACKAGE.JSON', status: 'M' }]), 'apps/web/PACKAGE.JSON');
  assert.equal(mustTickBlocked(rules, [{ path: 'DB/Migrations/3.sql', status: 'A' }]), 'DB/Migrations/3.sql');
  assert.equal(mustTickBlocked({ ...rules, ticked: ['Apps/Web/package.json'] }, ['apps/web/package.json']), '');
});

test('tg-check works only while its own stage runs', async t => {
  const repo = await exampleCheckRepo(t);
  const args = ['test', 'apps/api/src/billing/charge.test.mjs'];
  const waiting = stageSetup(t, repo, { run: { status: 'waiting' } });
  assert.match((await inStage(waiting.stageDir, args)).text, /works only while its stage runs; the run is waiting/);
  const done = stageSetup(t, repo, { stage: { status: 'done' } });
  assert.match((await inStage(done.stageDir, args)).text, /implement is done/);
  const retried = stageSetup(t, repo, { stage: { attempts: [
    { k: 1, folder: 'stages/05-implement', endedAt: '2026-10-22T10:02:00Z' }, { k: 2, folder: 'stages/05-implement-a2' },
  ] } });
  assert.match((await inStage(retried.stageDir, args)).text, /implement is running/, 'an earlier attempt\'s shim is off');
  const other = stageSetup(t, repo, { run: { project: 'other' } });
  assert.match((await inStage(other.stageDir, args)).text, /belongs to another project/);
  const elsewhere = stageSetup(t, repo, { run: { isolation: { tree: 'C:\\somewhere-else', treeMode: 'run' } } });
  assert.match((await inStage(elsewhere.stageDir, args)).text, /another tree than its run/);
});

test('tg-check refuses the main checkout like the gates do', async t => {
  const repo = await exampleCheckRepo(t, { files: { 'apps/api/src/env.mjs': 'export const testMode = false;\n' } });
  writeFileSync(join(repo.dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  const { stageDir } = stageSetup(t, repo, { run: { isolation: { mode: 'branch', tree: repo.dir, mainDir: repo.dir, treeMode: 'main' } } });
  const r = await inStage(stageDir, ['test', 'apps/api/src/billing/charge.test.mjs']);
  assert.equal(r.code, 1);
  assert.equal(r.text, `tg-check: ${checkProfile().mainCheckoutGuard.message}\n`);
});

test('tg-check types and lint', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  const ok = await inStage(stageDir, ['types', 'api']);
  assert.equal(ok.code, 0, ok.text);
  assert.equal(ok.text, 'tg-check types api: 0 type errors\n');
  setFile(repo.dir, 'apps/api/type-errors.txt', `${TYPE_KNOWN}\n`);
  const bad = await inStage(stageDir, ['types', 'api']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^tg-check types api: 1 type error\n {2}src\/billing\/charge\.mjs\(1,14\): TS2322 Type string/);
  assert.match((await inStage(stageDir, ['types', 'root'])).text, /"root" is not a workspace with a type check\. Workspaces: api, web\./);
  const lintOk = await inStage(stageDir, ['lint', 'apps/web/src/features/cart/total.mjs']);
  assert.equal(lintOk.code, 0, lintOk.text);
  setFile(repo.dir, 'apps/web/src/features/cart/total.mjs', 'export const total = 1; // LINT_ERROR(no-magic)\n');
  const lintBad = await inStage(stageDir, ['lint', 'apps/web/src/features/cart/total.mjs']);
  assert.equal(lintBad.code, 1);
  assert.match(lintBad.text, /tg-check lint 1 file: 1 lint error\n {2}src\/features\/cart\/total\.mjs\(1,28\): no-magic no-magic is not allowed here\./);
  assert.match((await inStage(stageDir, ['lint', 'apps/api/src/billing/charge.mjs'])).text, /no lint command covers apps\/api\/src\/billing\/charge\.mjs/);
});

test('tg-check: usage, allowed subcommands, argument cap and a broken context', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  for (const argv of [[], ['run'], ['test'], ['types'], ['lint']]) {
    const r = await inStage(stageDir, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.text, /Usage: tg-check test/, argv.join(' '));
  }
  const noLint = stageSetup(t, repo, { ctx: { allowed: ['test'] } });
  assert.match((await inStage(noLint.stageDir, ['lint', 'x.mjs'])).text, /tg-check lint is not allowed in this stage/);
  const many = Array.from({ length: 201 }, (_, i) => `f${i}.test.mjs`);
  assert.match((await inStage(stageDir, ['test', ...many])).text, /at most 200 paths/);
  const empty = tempDir('wp4-nostage-', t);
  assert.equal((await inStage(empty, ['test', 'x'])).text, 'tg-check: check-context.json is missing.\n');
  writeFileSync(join(empty, 'check-context.json'), JSON.stringify({ runDir: 'relative', tree: repo.dir, project: 'example', baseSha: repo.sha }));
  assert.match((await inStage(empty, ['test', 'x'])).text, /needs absolute runDir and tree paths/);
});

test('stagePath and samePath understand Git Bash paths', () => {
  const tree = 'C:\\dev\\example-run';
  assert.equal(stagePath(tree, '/c/dev/example-run/apps/api/a.test.mjs'), 'apps/api/a.test.mjs');
  assert.equal(stagePath(tree, 'C:/dev/example-run/apps/x.mjs'), 'apps/x.mjs');
  assert.equal(stagePath(tree, 'apps\\api\\x.mjs'), 'apps/api/x.mjs');
  assert.equal(stagePath(tree, '/c/dev/other/x.mjs'), null);
  assert.equal(stagePath(tree, 'C:/dev/example-run'), null);
  assert.equal(samePath('/c/dev/x/', 'C:\\Dev\\X'), process.platform === 'win32');
  const run = { project: 'example', status: 'running', stages: [{ id: 'prove', status: 'running', attempts: [{ folder: 'stages/03-prove' }] }] };
  assert.equal(stageNotRunning(run, { runDir: 'C:\\r', tree: tree, project: 'example' }, 'C:\\r\\stages\\03-prove'), '');
  assert.match(stageNotRunning(run, { runDir: 'C:\\r', tree: tree }, 'C:\\r\\stages\\05-x'), /inside a running stage/);
});

function runNode(args, opts = {}) {
  return new Promise(res => {
    execFile(process.execPath, args, { windowsHide: true, timeout: 60_000, ...opts }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('the CLI --in-stage mode prints the report and exits 0 or 1', async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  const ok = await runNode([CHECK_PATH, '--in-stage', stageDir, 'test', 'apps/api/src/billing/charge.test.mjs']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout, 'tg-check test: 1 test in 1 file, 1 passed, 0 failed, 0 skipped\n');
  const refused = await runNode([CHECK_PATH, '--in-stage', stageDir, 'test', '../escape.test.mjs']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /not a path inside the repository/);
});

function gitSh() {
  for (const r of [process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) {
    for (const rel of ['Git\\bin\\sh.exe', 'Git\\usr\\bin\\sh.exe']) if (existsSync(join(r, rel))) return join(r, rel);
  }
  return '';
}

test('Claude\'s way in: Git Bash finds tg-check on PATH and runs the check', { skip: process.platform !== 'win32' || !gitSh() ? 'needs Git Bash on Windows' : false }, async t => {
  const repo = await exampleCheckRepo(t);
  const { stageDir } = stageSetup(t, repo);
  const binDir = join(stageDir, 'bin');
  writeShim(binDir, { nodePath: process.execPath, checkPath: CHECK_PATH, stageDir });
  const env = { PATH: `${binDir};${process.env.PATH}`, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const r = await new Promise(res => execFile(gitSh(), ['-c', 'tg-check test apps/api/src/billing/charge.test.mjs'], { cwd: repo.dir, env, windowsHide: true, timeout: 60_000 },
    (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'tg-check test: 1 test in 1 file, 1 passed, 0 failed, 0 skipped\n');
});

// ---------------------------------------------------------------------------------------------
// CLI

function cliSetup(t, profile = checkProfile()) {
  const dataDir = tempDir('wp4-cli-', t);
  mkdirSync(join(dataDir, 'profiles'), { recursive: true });
  writeFileSync(join(dataDir, 'profiles', 'example.json'), `${JSON.stringify(profile, null, 2)}\n`);
  return dataDir;
}

test('the CLI prints a summary, or JSON with --json', async t => {
  const repo = await exampleCheckRepo(t);
  const dataDir = cliSetup(t);
  const gateDir = tempDir('wp4-cligate-', t);
  const argv = ['--project', 'example', '--level', 'quick', '--tree', repo.dir, '--what', 'everything', '--data-dir', dataDir];
  const r = await cliMain(argv, { gateDir, runG0: async () => ({ rows: [], ok: true }) });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`^Check quick on .+ \\(main\\), base ${repo.sha.slice(0, 7)}, Node ${NODE.replace(/\./g, '\\.')}: pass\n`));
  assert.match(r.text, /pass {4}G2 {2}Lint and unit tests: API/);
  assert.match(r.text, /Logs: /);
  const j = await cliMain([...argv, '--json'], { gateDir: tempDir('wp4-cligate-', t), runG0: async () => ({ rows: [], ok: true }) });
  const s = JSON.parse(j.text);
  assert.equal(s.result, 'pass');
  assert.equal(s.treeMode, 'main');
  assert.equal(s.level, 'quick');
  assert.equal((await lastPerLevel(dataDir, 'example')).quick.runId, 'cli');
});

test('the CLI explains bad arguments, a missing profile and an unknown level', async t => {
  const usage = await cliMain(['--level', 'quick']);
  assert.equal(usage.code, 2);
  assert.match(usage.text, /--project <name> is required[\s\S]*Usage: node gates\/check\.mjs/);
  assert.equal((await cliMain(['--project', 'example', '--level', 'quick', '--what', 'all'])).code, 2);
  assert.match((await cliMain(['--project', 'example', '--bogus'])).text, /Unknown argument "--bogus"/);
  const empty = tempDir('wp4-cli-', t);
  const missing = await cliMain(['--project', 'example', '--level', 'quick', '--data-dir', empty, '--tree', empty]);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /there is no profile for example in .*\. Create one from the example on the project's Settings tab\./);
  const dataDir = cliSetup(t);
  const level = await cliMain(['--project', 'example', '--level', 'huge', '--data-dir', dataDir, '--tree', empty]);
  assert.match(level.text, /unknown level "huge"\. Levels: quick, standard, paranoid\./);
  const noTree = await cliMain(['--project', 'example', '--level', 'quick', '--data-dir', dataDir], { hubRoot: empty });
  assert.match(noTree.text, /projects\/example does not exist; pass --tree <dir>/);
});

test('the CLI with the real G0: a planted .skip and a fake key fail, and the key is redacted', async t => {
  const repo = await exampleCheckRepo(t);
  const dataDir = cliSetup(t);
  const key = secretKey();
  setFile(repo.dir, 'apps/api/src/billing/charge.test.mjs', testFile({ 'charge adds tax': 'assert.equal(1, 1);' }).replace("test(\"charge adds tax\"", "test.skip(\"charge adds tax\""));
  setFile(repo.dir, 'apps/api/src/billing/config.mjs', `export const apiKey = '${key}';\n`);
  const r = await cliMain(['--project', 'example', '--level', 'quick', '--tree', repo.dir, '--data-dir', dataDir], { gateDir: tempDir('wp4-cligate-', t) });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /fail +G0 +Secret scan/);
  assert.match(r.text, /fail +G0 +Ratchet: test counts/);
  assert.ok(!r.text.includes(key), 'the key never reaches the summary text');
  const j = await cliMain(['--project', 'example', '--level', 'quick', '--tree', repo.dir, '--data-dir', dataDir, '--json'], { gateDir: tempDir('wp4-cligate-', t) });
  assert.ok(!j.text.includes(key), 'nor the JSON summary');
});

test('the CLI refuses the main checkout with the guard message', async t => {
  const repo = await exampleCheckRepo(t, { files: { 'apps/api/src/env.mjs': 'export const testMode = false;\n' } });
  writeFileSync(join(repo.dir, '.env'), 'CANARY_SECRET=<placeholder>\n');
  const dataDir = cliSetup(t);
  const r = await cliMain(['--project', 'example', '--level', 'quick', '--tree', repo.dir, '--data-dir', dataDir], { gateDir: tempDir('wp4-cligate-', t) });
  assert.equal(r.code, 1);
  assert.match(r.text, /: refused\nRefused: Checks would load your real \.env\./);
  assert.ok(!r.text.includes('CANARY_SECRET'));
});

test('summaryText lists rows, new failures and the candidate', () => {
  const text = summaryText({
    level: 'standard', tree: 'C:\\dev\\example-run', treeMode: 'run', baseSha: 'abcdef0123456789', node: '24.11.1', result: 'fail',
    chip: '1 new · 0 known', checks: [{ id: 'types:api', group: 'G1', label: 'Types: API', status: 'fail', reason: '1 new', durationMs: 1500 }],
    tests: { new: ['src/a.mjs::TS1::x'] }, candidate: { written: true, from: 3, to: 2 },
  }, 'C:\\gate');
  assert.equal(text, [
    'Check standard on C:\\dev\\example-run (run), base abcdef0, Node 24.11.1: fail',
    '1 new · 0 known',
    '  fail    G1  Types: API                           1 new (1.5 s)',
    'New failures:',
    '  src/a.mjs::TS1::x',
    "A baseline candidate was written (3 -> 2 known); accept it on the project's Checks tab.",
    'Logs: C:\\gate',
    '',
  ].join('\n'));
});

test('paths in this test file resolve', () => {
  assert.ok(existsSync(CHECK_PATH));
  assert.equal(resolve(CHECK_PATH), CHECK_PATH);
});
