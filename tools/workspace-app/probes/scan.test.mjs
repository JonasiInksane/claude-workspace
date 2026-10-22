// Tests for probes/scan.mjs: exact counts on the synthetic fixture tree and on the example repo,
// the madge run through a fake core/proc (graph base folder, failures, madge missing), `only`,
// `ids`, cancelling, secret files that are never read, redacted details, argv placeholders and
// the CLI.
// Every write goes to a folder under os.tmpdir(); the fixture tree itself is never changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as helpers from '../test/helpers.mjs';
import { main, parseArgs, resolveProbeArgv, scan } from './scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'test', 'fixtures', 'probes');
const TREE = join(FIX, 'tree');
const PROFILE_FILE = join(FIX, 'profile.json');
const PROFILE = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
const MADGE = ['node_modules', 'madge', 'bin', 'cli.js'];

// The madge --json graph the fake runner prints (paths relative to apps/api, as with --basedir .):
// file cycles {charge, service}, {log, teams/router}, {solo/a, solo/b}; one module cycle
// {audit, billing, teams}; modules audit, billing, solo, teams.
const GRAPH = {
  'src/modules/billing/router.ts': ['src/modules/billing/charge.ts', 'src/core/trpc.ts'],
  'src/modules/billing/charge.ts': ['src/modules/teams/service.ts'],
  'src/modules/teams/service.ts': ['src/modules/billing/charge.ts', 'src/modules/audit/log.ts'],
  'src/modules/audit/log.ts': ['src/modules/teams/router.ts'],
  'src/modules/teams/router.ts': ['src/modules/audit/log.ts'],
  'src/core/trpc.ts': [],
  'src/modules/solo/a.ts': ['src/modules/solo/b.ts'],
  'src/modules/solo/b.ts': ['src/modules/solo/a.ts'],
};

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `wp6-${prefix}-`));
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) copyFileSync(a, b);
  }
}

// A scratch copy of the fixture tree, optionally with a fake madge package in node_modules and the
// source files the fake graph names (the cycles probe checks that graph paths exist in the tree).
function treeCopy(t, { madgeAt = '.', graphFiles = !!madgeAt } = {}) {
  const dir = tempDir('tree');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyDir(TREE, dir);
  if (madgeAt) writeFiles(dir, { [join(madgeAt, ...MADGE)]: '// not a real madge\n' });
  if (graphFiles) {
    for (const file of Object.keys(GRAPH)) {
      if (!existsSync(join(dir, 'apps', 'api', file))) writeFiles(dir, { [join('apps', 'api', file)]: 'export {};\n' });
    }
  }
  return dir;
}

// The fake graph as madge prints it without --basedir: relative to the source folder ("src").
const relativeToSrc = graph => Object.fromEntries(Object.entries(graph)
  .map(([k, deps]) => [k.replace(/^src\//, ''), deps.map(d => d.replace(/^src\//, ''))]));

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

// A stand-in for core/proc.mjs: records each call and answers with a canned result.
function fakeProc(answer = { exitCode: 0, stdout: JSON.stringify(GRAPH), stderr: '' }) {
  const calls = [];
  return {
    calls,
    async runCapture(opts) {
      calls.push(opts);
      return typeof answer === 'function' ? answer(opts) : answer;
    },
  };
}

const withoutRule = v => {
  const { rule, ...rest } = v;
  assert.match(rule, /^[0-9a-f]{12}$/);
  return rest;
};

test('every probe kind gives its exact count on the fixture tree', async () => {
  const r = await scan({ profile: PROFILE, tree: TREE, sha: 'abc123' });
  const v = id => withoutRule(r.values[id]);
  assert.equal(r.sha, 'abc123');
  assert.equal(r.tree, TREE);
  assert.equal(r.subset, undefined);
  assert.equal(r.node, process.versions.node);
  assert.ok(Number.isFinite(Date.parse(r.at)));
  assert.ok(r.durationMs >= 0);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(v('procedures'), {
    value: 11,
    display: '11 keys: 5 shop · 1 protected · 4 public · 1 unknown',
    byClass: { shop: 5, protected: 1, public: 4, unknown: 1 },
    byBuilder: { teamProcedure: 4, billingProcedure: 1, openProcedure: 4, authedProcedure: 1, weirdProcedure: 1 },
    nonShop: ['billing.publicPrice', 'billing.webhook', 'core.health', 'teams.legacy', 'teams.members.invite', 'teams.mine'],
    filtered: false,
  });
  assert.deepEqual(v('missingAssert'), { value: 2, display: '2', checked: 4 });
  assert.deepEqual(v('openInputs'), {
    value: 2, display: '2', byClass: { public: 2 }, byBuilder: { openProcedure: 2 },
    nonShop: ['billing.publicPrice', 'teams.members.invite'], filtered: true,
  });
  assert.deepEqual(v('stringDates'), { value: 4, display: '4', files: 6, filesWithHits: 3, matches: 4 });
  assert.deepEqual(v('consoleCalls'), { value: 1, display: '1', files: 5, filesWithHits: 1, matches: 1 });
  assert.deepEqual(v('awaitInLoop'), { value: 1, display: '1', starts: 2 });
  assert.deepEqual(v('clientComponents'), { value: 3, display: '3 files', files: 4, filesWithHits: 3, matches: 3 });
  assert.deepEqual(v('asNever'), { value: 3, display: '3', files: 12, filesWithHits: 2, matches: 3 });
  assert.deepEqual(v('deepImports'), { value: 5, display: '5', targets: { alpha: 2, gamma: 2, beta: 1 }, files: 11 });
  assert.deepEqual(v('publicTs'), { value: 2, display: '2 of 4', of: 4, withBoundaryTest: 1, higherIsBetter: true });
  assert.deepEqual(v('localeWeb'), {
    value: 4, display: '1–4 per locale', min: 1, max: 4, perLocale: { de: 4, fr: 1 }, sourceKeys: 6, locales: 2,
  });
  assert.deepEqual(v('localeMobile'), { value: 1, display: '1 per locale', min: 1, max: 1, perLocale: { de: 1 }, sourceKeys: 2, locales: 1 });
  assert.deepEqual(v('expoParity'), { value: 50, display: '50%', matched: 2, total: 4, missing: ['delta', 'gamma'], higherIsBetter: true });
  // The fixture has no node_modules, so the cycles probe fails and only that probe fails.
  assert.deepEqual(r.errors, { apiCycles: 'madge not installed in this tree' });
  assert.equal(r.values.apiCycles, undefined);
});

test('the tracked example profile scans the synthetic example repo', async t => {
  const dir = helpers.tempDir('wp6-example-', t);
  helpers.writeFiles(dir, helpers.exampleRepoFiles());
  const r = await scan({ profile: helpers.fakeProfile(), tree: dir });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(Object.keys(r.values).sort(), ['deepImports', 'localeWeb', 'missingAssert', 'procedures', 'publicTs', 'todoCount']);
  assert.equal(r.values.procedures.display, '3 keys: 2 shop · 1 public');
  assert.deepEqual(r.values.procedures.nonShop, ['items.list']);
  assert.equal(r.values.missingAssert.value, 1);
  assert.deepEqual(r.details.missingAssert.map(d => d.text), ['items.remove: memberProcedure']);
  assert.equal(r.values.todoCount.value, 0);
  assert.equal(r.values.publicTs.display, '1 of 1');
  assert.equal(r.values.deepImports.value, 0);
  assert.equal(r.values.localeWeb.display, '1 per locale');
});

test('details name the file, line and text behind each count', async () => {
  const r = await scan({ profile: PROFILE, tree: TREE });
  const charge = 'apps/api/src/modules/billing/charge.ts';
  assert.deepEqual(r.details.stringDates, [
    // A match over two lines is reported on the line it starts, with both lines as its text.
    { path: charge, line: 6, text: "invoice.due = new Date( '2026-01-31'," },
    { path: charge, line: 17, text: "return new Date('2026-02-01');" },
    { path: 'apps/api/src/modules/billing/router.ts', line: 25, text: 'export const launched = new Date("2025-06-01");' },
    { path: 'apps/api/src/modules/teams/router.ts', line: 25, text: "const founded = new Date('2024-01-01');" },
  ]);
  assert.deepEqual(r.details.awaitInLoop, [{ path: charge, line: 14, text: 'await charge(ctx, input);' }]);
  assert.deepEqual(r.details.consoleCalls, [{ path: 'apps/api/src/core/trpc.ts', line: 10, text: "console.warn('builders ready');" }]);
  assert.deepEqual(r.details.missingAssert, [
    { path: 'apps/api/src/modules/billing/router.ts', line: 14, text: 'billing.refund: teamProcedure' },
    { path: 'apps/api/src/modules/teams/router.ts', line: 14, text: 'teams.members.list: teamProcedure' },
  ]);
  assert.deepEqual(r.details.deepImports.map(d => `${d.path.split('/').slice(-2).join('/')}:${d.line} ${d.text}`), [
    'alpha/Panel.tsx:2 @/features/beta/internal/helper',
    'alpha/Panel.tsx:4 ../gamma/thing',
    'internal/helper.ts:1 @/features/gamma/thing',
    'gamma/View.tsx:3 @/features/alpha/own.ts',
    'gamma/thing.ts:3 @/features/alpha/Panel',
  ]);
  assert.deepEqual(r.details.clientComponents.map(d => d.path), [
    'apps/web/src/app/page.tsx', 'apps/web/src/features/alpha/Panel.tsx', 'apps/web/src/features/gamma/View.tsx',
  ]);
  assert.equal(r.details.procedures.length, 11);
  assert.deepEqual(r.details.procedures.find(d => d.text.startsWith('teams.members.invite')),
    { path: 'apps/api/src/modules/teams/router.ts', line: 17, text: 'teams.members.invite: openProcedure' });
  assert.equal(r.details.localeWeb.length, 5);
  assert.deepEqual(r.details.localeWeb.find(d => d.text === 'de: home.list'), { path: 'apps/web/messages/de/home.json', line: 0, text: 'de: home.list' });
  assert.deepEqual(r.details.expoParity.map(d => d.text), ['delta has no Expo module', 'gamma has no Expo module']);
});

test('the cycles probe runs madge from node_modules through proc, with a system-only env', async t => {
  const tree = treeCopy(t);
  const proc = fakeProc();
  process.env.WP6_PRIVATE_TOKEN = 'x'.repeat(8);
  t.after(() => { delete process.env.WP6_PRIVATE_TOKEN; });
  const rows = [];
  const r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc, onRow: row => rows.push(row) });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(withoutRule(r.values.apiCycles), {
    value: 3,
    display: '3 of 4 modules',
    largestModuleCycle: 3,
    modules: 4,
    files: 8,
    filesInCycles: 6,
    largestModules: ['audit', 'billing', 'teams'],
  });
  assert.equal(r.details.apiCycles.length, 3);
  assert.equal(r.details.apiCycles[0].text.startsWith('cycle of 2 files: '), true);
  assert.equal(proc.calls.length, 1);
  const call = proc.calls[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [join(tree, ...MADGE), '--json', '--basedir', '.', '--extensions', 'ts', 'src']);
  assert.equal(call.cwd, join(tree, 'apps', 'api'));
  assert.equal(call.timeoutMs, 60000);
  assert.equal(call.env.NO_COLOR, '1');
  assert.equal(call.env.WP6_PRIVATE_TOKEN, undefined);
  for (const k of Object.keys(call.env)) assert.match(k, /^(PATH|PATHEXT|SystemRoot|windir|ComSpec|SystemDrive|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|USERNAME|COMPUTERNAME|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|NO_COLOR|FORCE_COLOR)$/);
  assert.deepEqual(rows.map(x => [x.kind, x.ok, x.probe, x.status, x.msg]), [['gate', true, 'apiCycles', 'pass', 'API import cycles: 3 of 4 modules']]);
  assert.ok(rows[0].durationMs >= 0);
});

test('a graph printed relative to the source folder (no --basedir) is read relative to the probe cwd', async t => {
  const tree = treeCopy(t);
  const profile = {
    ...PROFILE,
    probes: PROFILE.probes.map(p => (p.id === 'apiCycles'
      ? { ...p, argv: ['{node}', '{pkg:madge/bin/cli.js}', '--json', '--extensions', 'ts', 'src'] }
      : p)),
  };
  const proc = fakeProc({ code: 0, stdout: JSON.stringify(relativeToSrc(GRAPH)), stderr: '' });
  const r = await scan({ profile, tree, ids: ['apiCycles'], proc });
  assert.deepEqual(r.errors, {});
  const v = r.values.apiCycles;
  assert.equal(v.value, 3);
  assert.equal(v.largestModuleCycle, 3);
  assert.equal(v.modules, 4);
  assert.equal(v.warning, undefined);
  // Detail paths are tree-relative; the cycle names are relative to the probe cwd.
  for (const d of r.details.apiCycles) assert.match(d.path, /^apps\/api\/src\/modules\//);
  assert.match(r.details.apiCycles[0].text, /^cycle of 2 files: src\/modules\//);
});

test('graph paths that exist nowhere under the probe cwd fail the probe, not give a wrong module count', async t => {
  const tree = treeCopy(t);
  const elsewhere = { 'lib/modules/a/x.ts': ['lib/modules/b/y.ts'], 'lib/modules/b/y.ts': ['lib/modules/a/x.ts'] };
  const r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ code: 0, stdout: JSON.stringify(elsewhere) }) });
  assert.equal(r.values.apiCycles, undefined);
  assert.match(r.errors.apiCycles, /were not found under apps\/api, so its modules can't be read\. Pass --basedir/);
  // Without moduleRegex the file cycle count still stands, with a warning about the paths.
  const plain = { ...PROFILE, probes: PROFILE.probes.map(p => (p.id === 'apiCycles' ? { ...p, moduleRegex: undefined } : p)) };
  const r2 = await scan({ profile: plain, tree, ids: ['apiCycles'], proc: fakeProc({ code: 0, stdout: JSON.stringify(elsewhere) }) });
  assert.equal(r2.values.apiCycles.value, 1);
  assert.match(r2.values.apiCycles.warning, /were not found under apps\/api.*--basedir/);
});

test('an empty madge graph fails the probe instead of recording 0 cycles', async t => {
  const tree = treeCopy(t);
  const r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ exitCode: 0, stdout: '{}', stderr: '' }) });
  assert.equal(r.values.apiCycles, undefined);
  assert.equal(r.errors.apiCycles, "madge found no files; check the probe's cwd and source folder");
});

test('folder probes fail when their folder moved, instead of counting 0', async t => {
  const tree = treeCopy(t, { madgeAt: '' });
  rmSync(join(tree, 'apps', 'web', 'src', 'features'), { recursive: true, force: true });
  mkdirSync(join(tree, 'apps', 'web', 'src', 'modules'), { recursive: true });
  const r = await scan({ profile: PROFILE, tree, ids: ['deepImports', 'publicTs', 'expoParity', 'asNever'] });
  assert.deepEqual(r.errors, {
    deepImports: 'apps/web/src/features is not a folder in this tree',
    publicTs: 'apps/web/src/features is not a folder in this tree',
    expoParity: 'apps/web/src/features is not a folder in this tree',
  });
  assert.deepEqual(Object.keys(r.values), ['asNever']);
});

test('a tool that cannot start or prints too much fails the cycles probe with a plain message', async t => {
  const tree = treeCopy(t);
  let r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ code: null, stdout: '', stderr: '', error: new Error('Could not start node.exe: ENOENT') }) });
  assert.equal(r.errors.apiCycles, 'madge did not start: Could not start node.exe: ENOENT');
  r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ code: 0, stdout: '{"a":', stderr: '', truncated: true }) });
  assert.equal(r.errors.apiCycles, 'madge printed more output than the app reads; the graph is incomplete');
  const proc = fakeProc();
  await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc });
  assert.ok(proc.calls[0].maxBytes >= 32 * 1024 * 1024);
});

test('a madge in the probe folder wins over the one at the tree root', async t => {
  const tree = treeCopy(t);
  writeFiles(tree, { [join('apps', 'api', ...MADGE)]: '// nearer\n' });
  const proc = fakeProc();
  await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc });
  assert.equal(proc.calls[0].args[0], join(tree, 'apps', 'api', ...MADGE));
});

test('madge missing from the tree fails the probe with a plain message, even if one sits above it', async t => {
  const outer = tempDir('outer');
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  writeFiles(outer, { [join(...MADGE)]: '// outside the tree\n' });
  const tree = join(outer, 'tree');
  copyDir(TREE, tree);
  const proc = fakeProc();
  const rows = [];
  const r = await scan({ profile: PROFILE, tree, ids: ['apiCycles', 'deepImports'], proc, onRow: row => rows.push(row) });
  assert.deepEqual(r.errors, { apiCycles: 'madge not installed in this tree' });
  assert.equal(r.values.deepImports.value, 5);
  assert.equal(proc.calls.length, 0);
  assert.deepEqual(rows.map(x => [x.kind, x.ok, x.msg]), [
    ['gate', true, 'Web deep imports: 5'],
    ['gate', false, 'API import cycles: probe failed: madge not installed in this tree'],
  ]);
});

test('madge failures become one plain error per probe', async t => {
  const tree = treeCopy(t);
  const cases = [
    [{ exitCode: 2, stdout: '', stderr: '\nError: boom\n  at x' }, 'madge exited with code 2: Error: boom'],
    [{ exitCode: null, stdout: '', stderr: '', timedOut: true }, 'madge did not finish within 60 s'],
    [{ exitCode: 0, stdout: 'Processed 3 files', stderr: '' }, 'madge printed no JSON graph'],
    [{ code: 0, stdout: '[1, 2]', stderr: '' }, 'madge printed no JSON graph'],
    [() => { throw new Error('spawn failed'); }, 'spawn failed'],
  ];
  for (const [answer, message] of cases) {
    const r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc(answer) });
    assert.equal(r.errors.apiCycles, message);
  }
});

test('the cycles probe flags a partial graph and a moduleRegex that matches nothing', async t => {
  const tree = treeCopy(t);
  const charge = 'src/modules/billing/charge.ts';
  const service = 'src/modules/teams/service.ts';
  const partial = { [charge]: [service, 'src/missing.ts'], [service]: [charge] };
  let r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ exitCode: 0, stdout: JSON.stringify(partial) }) });
  assert.equal(r.values.apiCycles.partial, 1);
  assert.equal(r.values.apiCycles.largestModuleCycle, 2);
  assert.deepEqual(r.values.apiCycles.largestModules, ['billing', 'teams']);
  const relativeToSrc = { 'modules/a/x.ts': ['modules/b/y.ts'], 'modules/b/y.ts': ['modules/a/x.ts'] };
  r = await scan({ profile: PROFILE, tree, ids: ['apiCycles'], proc: fakeProc({ exitCode: 0, stdout: JSON.stringify(relativeToSrc) }) });
  assert.equal(r.values.apiCycles, undefined);
  assert.match(r.errors.apiCycles, /--basedir/);
  const noModules = { ...PROFILE, probes: PROFILE.probes.map(p => (p.id === 'apiCycles' ? { ...p, moduleRegex: undefined } : p)) };
  r = await scan({ profile: noModules, tree, ids: ['apiCycles'], proc: fakeProc() });
  assert.equal(r.values.apiCycles.display, '3 file cycles');
});

test('only limits the file probes to the given paths; folder probes still see the whole tree', async () => {
  const only = [
    'apps/api/src/modules/billing/router.ts',
    'apps\\web\\src\\features\\gamma\\View.tsx',
    'apps/api/src/gone.ts',
    '../outside.ts',
    'C:/abs/path.ts',
  ];
  const r = await scan({ profile: PROFILE, tree: TREE, only });
  assert.equal(r.values.procedures.value, 5);
  assert.deepEqual(r.values.procedures.nonShop, ['billing.publicPrice', 'billing.webhook']);
  assert.equal(r.values.missingAssert.value, 1);
  assert.equal(r.values.stringDates.value, 1);
  assert.equal(r.values.asNever.value, 2);
  assert.equal(r.values.clientComponents.value, 1);
  assert.equal(r.values.deepImports.value, 1);
  assert.equal(r.values.consoleCalls.value, 0);
  assert.equal(r.subset, true);
  assert.equal(r.values.publicTs.value, 2);
  assert.equal(r.values.localeWeb.value, 4);
});

test('readFile replaces the disk read, for example to scan files at a base commit', async () => {
  const base = {
    'apps/api/src/modules/billing/router.ts': [
      "export const billingRouter = router({",
      "  ping: openProcedure.query(() => 1),",
      "  pay: teamProcedure.mutation(({ ctx }) => ctx.pay()),",
      "});",
    ].join('\n'),
  };
  const read = rel => (rel in base ? base[rel] : null);
  const r = await scan({ profile: PROFILE, tree: TREE, only: Object.keys(base), ids: ['procedures', 'missingAssert'], readFile: read });
  assert.equal(r.values.procedures.value, 2);
  assert.deepEqual(r.values.procedures.nonShop, ['billing.ping']);
  assert.equal(r.values.missingAssert.value, 1);
});

test('ids picks probes and reports the ones the profile lacks', async () => {
  const r = await scan({ profile: PROFILE, tree: TREE, ids: ['asNever', 'nope', 'asNever'] });
  assert.deepEqual(Object.keys(r.values), ['asNever']);
  assert.deepEqual(r.missing, ['nope']);
  // A scan of some probes is a subset, which metrics.recordScan refuses to save.
  assert.equal(r.subset, true);
});

test('a broken probe fails alone; a broken profile or tree throws', async () => {
  const profile = {
    ...PROFILE,
    probes: [
      { id: 'a', kind: 'mystery' },
      { id: 'b', kind: 'regexCount', files: ['**/*.ts'], regex: '(' },
      { id: 'c', kind: 'regexCount', regex: 'x' },
      { id: 'd', kind: 'regexCount', files: ['apps/web/src/**/*.tsx'], regex: 'use client', flags: 'g' },
      { id: 'e', kind: 'constructor' },
      { id: 'f', kind: 'regexCount', files: ['apps/web/src/**/*.tsx'], regex: 'USE CLIENT', flags: 'i' },
    ],
  };
  const r = await scan({ profile, tree: TREE });
  assert.equal(r.errors.a, 'unknown probe kind "mystery"');
  assert.match(r.errors.b, /^probe "b": "regex" is not a valid regex/);
  assert.equal(r.errors.c, 'probe "c" needs "files", a list of globs');
  assert.equal(r.errors.d, 'probe "d": "flags" may only hold i, s and u');
  assert.equal(r.errors.e, 'unknown probe kind "constructor"');
  assert.equal(r.values.f.value, 3);
  await assert.rejects(scan({ profile: { probes: [{ id: 'x', kind: 'regexCount' }, { id: 'x', kind: 'regexCount' }] }, tree: TREE }),
    /lists probe "x" twice/);
  await assert.rejects(scan({ profile: { probes: [{ kind: 'regexCount' }] }, tree: TREE }), /Probe 1 in the profile has no valid id/);
  await assert.rejects(scan({ profile: PROFILE, tree: join(TREE, 'README.md') }), /is not a folder/);
  await assert.rejects(scan({ tree: TREE }), /needs a profile/);
  const empty = await scan({ profile: {}, tree: TREE });
  assert.deepEqual(empty.values, {});
});

test('a cancelled scan stops with an AbortError', async t => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(scan({ profile: PROFILE, tree: TREE, signal: ac.signal }), { name: 'AbortError', message: 'The scan was cancelled.' });
  const tree = treeCopy(t);
  const mid = new AbortController();
  const proc = fakeProc(opts => {
    assert.equal(opts.signal, mid.signal);
    mid.abort();
    throw new Error('killed');
  });
  await assert.rejects(scan({ profile: PROFILE, tree, ids: ['apiCycles', 'asNever'], proc, signal: mid.signal }), { name: 'AbortError' });
  // Cancelled while the last probe walks the tree: the scan still throws instead of returning a
  // count from a walk that stopped early.
  const late = new AbortController();
  const profile = { probes: [{ id: 'last', kind: 'regexCount', files: ['**/*.tsx'], regex: 'x' }] };
  const slow = scan({ profile, tree, signal: late.signal, readFile: async () => { late.abort(); return 'x'; } });
  await assert.rejects(slow, { name: 'AbortError' });
});

test('a listener that throws never stops the scan', async () => {
  const r = await scan({ profile: PROFILE, tree: TREE, ids: ['asNever'], onRow: () => { throw new Error('bad listener'); } });
  assert.equal(r.values.asNever.value, 3);
});

test('the rule hash follows the probe definition, not its label', async () => {
  const one = await scan({ profile: PROFILE, tree: TREE, ids: ['asNever', 'missingAssert'] });
  const relabeled = { ...PROFILE, probes: PROFILE.probes.map(p => (p.id === 'asNever' ? { ...p, label: 'Other', measures: 'other' } : p)) };
  const two = await scan({ profile: relabeled, tree: TREE, ids: ['asNever'] });
  assert.equal(two.values.asNever.rule, one.values.asNever.rule);
  const changed = { ...PROFILE, probes: PROFILE.probes.map(p => (p.id === 'asNever' ? { ...p, regex: '\\bas any\\b' } : p)) };
  const three = await scan({ profile: changed, tree: TREE, ids: ['asNever'] });
  assert.notEqual(three.values.asNever.rule, one.values.asNever.rule);
  const otherAssert = await scan({ profile: { ...PROFILE, assertPattern: 'check\\(' }, tree: TREE, ids: ['missingAssert'] });
  assert.notEqual(otherAssert.values.missingAssert.rule, one.values.missingAssert.rule);
});

test('the rule hash ignores "_" comment keys and timeoutSec', async t => {
  const tree = treeCopy(t);
  const rule = async profile => (await scan({ profile, tree, ids: ['apiCycles', 'openInputs', 'procedures'], proc: fakeProc() })).values;
  const edit = (id, change) => ({ ...PROFILE, probes: PROFILE.probes.map(p => (p.id === id ? change(p) : p)) });
  const one = await rule(PROFILE);
  // A comment, a longer madge timeout and a comment inside a nested option or a profile part.
  const commented = await rule({
    ...edit('apiCycles', p => ({ ...p, _note: 'madge takes 2 minutes here', timeoutSec: 600 })),
    builders: { ...PROFILE.builders, _why: 'synthetic builders' },
  });
  assert.equal(commented.apiCycles.rule, one.apiCycles.rule);
  assert.equal(commented.procedures.rule, one.procedures.rule);
  const nested = await rule(edit('openInputs', p => ({ ...p, filter: { ...p.filter, _note: 'inputs only' } })));
  assert.equal(nested.openInputs.rule, one.openInputs.rule);
  // A real change still counts.
  const cwd = await rule(edit('apiCycles', p => ({ ...p, moduleRegex: '^src/([^/]+)/' })));
  assert.notEqual(cwd.apiCycles.rule, one.apiCycles.rule);
});

test('walks skip node_modules and .git, and a broken locale file counts as missing', async t => {
  const tree = treeCopy(t, { madgeAt: '' });
  writeFiles(tree, {
    'apps/web/src/node_modules/pkg/x.tsx': "'use client';\nconst a = 1 as never;\n",
    'apps/web/src/.git/y.tsx': "'use client';\n",
    'apps/web/messages/nl/common.json': '{ "save": ',
  });
  const r = await scan({ profile: PROFILE, tree, ids: ['asNever', 'clientComponents', 'localeWeb'] });
  assert.equal(r.values.asNever.value, 3);
  assert.equal(r.values.clientComponents.value, 3);
  assert.deepEqual(r.values.localeWeb.perLocale, { de: 4, fr: 1, nl: 6 });
  assert.deepEqual(r.values.localeWeb.badFiles, ['apps/web/messages/nl/common.json']);
  assert.equal(r.values.localeWeb.display, '1–6 per locale');
});

test('secret files are never read, whatever the probe globs say', async t => {
  const tree = treeCopy(t, { madgeAt: '' });
  const marker = 'PROBE_SECRET_MARKER';
  writeFiles(tree, {
    '.env': `${marker}=1\n`,
    'apps/api/.env.local': `${marker}=2\n`,
    'apps/api/.npmrc': `${marker}\n`,
    'apps/web/.sentryclirc': `${marker}\n`,
    'apps/api/keys/private.txt': `${marker}\n`,
    'apps/api/notes.txt': `${marker}\n`,
  });
  const profile = {
    secrets: { denyReadGlobs: ['**/KEYS/**'] },
    probes: [
      { id: 'all', kind: 'regexCount', files: ['**', '**/.env*', '.env'], regex: marker },
      { id: 'named', kind: 'regexCount', files: ['.env', 'apps/api/.npmrc'], regex: marker },
    ],
  };
  const r = await scan({ profile, tree });
  assert.equal(r.values.all.value, 1);
  assert.deepEqual(r.details.all.map(d => d.path), ['apps/api/notes.txt']);
  assert.equal(r.values.named.value, 0);
  // `only` and a replaced readFile can't reach them either.
  const viaOnly = await scan({ profile, tree, only: ['.env', 'apps/api/.env.local', 'apps/api/notes.txt'], readFile: () => `${marker}\n` });
  assert.equal(viaOnly.values.all.value, 1);
});

test('detail texts and probe errors are redacted', async t => {
  const tree = treeCopy(t, { madgeAt: '' });
  const key = `${'sk_'}${'live_'}${'x'.repeat(24)}`;
  const allowed = `${'sk_'}${'live_'}${'y'.repeat(24)}`;
  writeFiles(tree, { 'apps/api/src/keys.ts': `const a = '${key}'; // KEYLINE\nconst b = '${allowed}'; // KEYLINE\n` });
  const profile = {
    secrets: { allowValues: [allowed] },
    probes: [
      { id: 'keys', kind: 'regexCount', files: ['apps/api/src/*.ts'], regex: 'KEYLINE' },
      { id: 'bad', kind: 'regexCount', files: ['apps/api/src/*.ts'], regex: `(${key}` },
    ],
  };
  const r = await scan({ profile, tree });
  assert.equal(r.values.keys.value, 2);
  const [first, second] = r.details.keys.map(d => d.text);
  assert.ok(!first.includes(key), first);
  assert.match(first, /sk_l…\[redacted \d+\]/);
  assert.ok(second.includes(allowed));
  assert.ok(!r.errors.bad.includes(key), r.errors.bad);
});

test('walks never follow a junction, so a loop or a link out of the tree is not scanned', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async t => {
  const tree = treeCopy(t, { madgeAt: '' });
  const outside = tempDir('outside');
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFiles(outside, { 'evil.tsx': "'use client';\nconst x = y as never;\n" });
  symlinkSync(outside, join(tree, 'apps', 'web', 'src', 'features', 'alpha', 'linked'), 'junction');
  symlinkSync(join(tree, 'apps', 'web', 'src'), join(tree, 'apps', 'web', 'src', 'features', 'beta', 'loop'), 'junction');
  symlinkSync(outside, join(tree, 'apps', 'web', 'src', 'features', 'epsilon'), 'junction');
  const r = await scan({ profile: PROFILE, tree, ids: ['asNever', 'clientComponents', 'publicTs', 'deepImports'] });
  assert.equal(r.values.asNever.value, 3);
  assert.equal(r.values.clientComponents.value, 3);
  assert.equal(r.values.publicTs.of, 4);
  assert.equal(r.values.deepImports.value, 5);
  // `only` can't reach through a link either.
  const viaLink = await scan({ profile: PROFILE, tree, ids: ['asNever'], only: ['apps/web/src/features/alpha/linked/evil.tsx'] });
  assert.equal(viaLink.values.asNever.value, 0);
});

test('resolveProbeArgv resolves {node}, {pkg:...} and {tree} and refuses anything else', async t => {
  const tree = treeCopy(t);
  const argv = await resolveProbeArgv(['{node}', '{pkg:madge/bin/cli.js}', '--root={tree}', 'src'], { root: tree, cwd: 'apps/api' });
  assert.deepEqual(argv, [process.execPath, join(tree, ...MADGE), `--root=${tree}`, 'src']);
  await assert.rejects(resolveProbeArgv(['node', 'x.js'], { root: tree }), /must start with \{node\}/);
  await assert.rejects(resolveProbeArgv(['{node}', '{npmCli}'], { root: tree }), /uses \{npmCli\}, which probes can't use/);
  await assert.rejects(resolveProbeArgv(['{node}', '{pkg:../evil.js}'], { root: tree }), /is not a package path/);
  await assert.rejects(resolveProbeArgv(['{node}', '{pkg:@scope/tool/cli.js}'], { root: tree }), /^Error: @scope\/tool not installed in this tree$/);
  await assert.rejects(resolveProbeArgv(['{node}'], { root: tree, cwd: '../..' }), /is outside the tree/);
});

test('parseArgs reads the CLI flags', () => {
  assert.deepEqual(parseArgs(['--project', 'example', '--tree', 'x', '--write', '--json', '--data-dir', 'd', '--profile', 'p.json']), {
    project: 'example', tree: 'x', write: true, json: true, dataDir: 'd', profileFile: 'p.json', ids: null, help: false,
  });
  assert.deepEqual(parseArgs(['--project', 'example', '--ids', 'a, b']).ids, ['a', 'b']);
  // A scan of some probes would be saved as the newest scan, with no value for the others.
  assert.equal(parseArgs(['--project', 'example', '--write', '--ids', 'a']).error, '--write saves full scans only; leave out --ids');
  assert.equal(parseArgs(['--project', 'Bad Name']).error, '--project needs a project name (lowercase letters, digits and hyphens)');
  assert.equal(parseArgs(['--project']).error, '--project needs a value');
  assert.equal(parseArgs(['--project', 'example', '--bogus']).error, 'unknown argument "--bogus"');
  assert.equal(parseArgs(['--help']).help, true);
});

function sink() {
  const s = { text: '', write(chunk) { s.text += chunk; return true; } };
  return s;
}

test('the CLI scans the fixture tree and prints a table or JSON', async () => {
  const out = sink();
  const err = sink();
  const code = await main(['--project', 'example', '--tree', TREE, '--profile', PROFILE_FILE], { stdout: out, stderr: err });
  assert.equal(code, 0, err.text);
  assert.match(out.text, /^Scanned .+ \(14 probes\)/);
  assert.match(out.text, /\n {2}deepImports {7}5 {2}\(Web deep imports\)\n/);
  assert.match(out.text, /apiCycles +probe failed: madge not installed in this tree/);
  const json = sink();
  assert.equal(await main(['--project', 'example', '--tree', TREE, '--profile', PROFILE_FILE, '--json', '--ids', 'publicTs'], { stdout: json, stderr: err }), 0);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.values.publicTs.display, '2 of 4');
  assert.deepEqual(Object.keys(parsed.values), ['publicTs']);
});

test('the CLI --write saves the scan in the data folder only', async t => {
  const dataDir = tempDir('data');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const out = sink();
  const err = sink();
  const code = await main(['--project', 'example', '--tree', TREE, '--profile', PROFILE_FILE, '--data-dir', dataDir, '--write'], { stdout: out, stderr: err });
  assert.equal(code, 0, err.text);
  const doc = JSON.parse(readFileSync(join(dataDir, 'metrics', 'example.json'), 'utf8'));
  assert.equal(doc.scans.length, 1);
  assert.equal(doc.scans[0].values.deepImports.value, 5);
  assert.equal(doc.scans[0].score, 48);
  assert.match(out.text, new RegExp(`Saved scan ${doc.scans[0].id} in `));
  assert.ok(existsSync(join(dataDir, 'metrics', 'example', `${doc.scans[0].id}.details.json`)));
  assert.equal(existsSync(join(TREE, 'metrics')), false);
});

test('the CLI refuses a missing profile, a bad project and a missing tree', async () => {
  const err = sink();
  assert.equal(await main(['--project', 'example', '--tree', TREE, '--profile', join(FIX, 'nope.json')], { stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /nope\.json does not exist/);
  const err2 = sink();
  assert.equal(await main(['--project', 'BAD'], { stdout: sink(), stderr: err2 }), 1);
  assert.match(err2.text, /--project needs a project name/);
  const err3 = sink();
  assert.equal(await main(['--project', 'example', '--tree', join(FIX, 'no-such-tree'), '--profile', PROFILE_FILE], { stdout: sink(), stderr: err3 }), 1);
  assert.match(err3.text, /is not a folder/);
  const err4 = sink();
  assert.equal(await main(['--project', 'example', '--tree', TREE, '--profile', PROFILE_FILE, '--write', '--ids', 'asNever'], { stdout: sink(), stderr: err4 }), 1);
  assert.match(err4.text, /^scan: --write saves full scans only; leave out --ids/);
});

test('the CLI file runs as a script', async () => {
  const script = join(here, 'scan.mjs');
  const { code, stdout } = await new Promise(done => {
    execFile(process.execPath, [script, '--project', 'example', '--tree', TREE, '--profile', PROFILE_FILE, '--json', '--ids', 'asNever'],
      { windowsHide: true, timeout: 30000 }, (e, so) => done({ code: e ? e.code : 0, stdout: String(so) }));
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).values.asNever.value, 3);
});
