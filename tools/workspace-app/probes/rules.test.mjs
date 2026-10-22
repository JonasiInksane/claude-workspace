// Tests for probes/rules.mjs: each probe kind called directly as KINDS[kind](probe, ctx) on a small
// in-memory tree, so the edge cases (key bodies, window bounds, import resolution, locale layouts,
// the madge graph base) are pinned down one by one. probes/scan.test.mjs covers the same kinds
// end to end on the fixture tree. Nothing here touches the disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../core/glob.mjs';
import { CLASSES, FILE_KINDS, KINDS, routerKeysIn, snippet, toolName } from './rules.mjs';

// A probe context over { "posix/path": "text" }, shaped like the one probes/scan.mjs builds.
function memCtx(files, { profile = {}, only = null, run = null } = {}) {
  const paths = Object.keys(files).sort();
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const match = (globs, p) => globs.some(g => globToRegExp(g).test(p));
  const calls = [];
  return {
    calls,
    tree: '/mem',
    profile,
    only,
    readFile: async rel => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
    walk: async (globs, exclude = [], { all = false } = {}) => {
      const pool = only && !all ? only.filter(p => p in files) : paths;
      return pool.filter(p => match(globs, p) && !match(exclude, p)).sort();
    },
    listDir: async rel => {
      const out = new Map();
      for (const p of paths) {
        if (!p.startsWith(`${rel}/`)) continue;
        const rest = p.slice(rel.length + 1).split('/');
        out.set(rest[0], rest.length > 1);
      }
      return [...out].map(([name, dir]) => ({ name, dir })).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    isFile: async rel => Object.prototype.hasOwnProperty.call(files, rel),
    isDir: async rel => dirs.has(rel),
    resolveArgv: async argv => argv.map(a => (a === '{node}' ? 'node' : a.replace(/^\{pkg:(.+)\}$/, 'node_modules/$1'))),
    run: async opts => {
      calls.push(opts);
      if (!run) throw new Error('no tool in this tree');
      return run(opts);
    },
  };
}

const BUILDERS = { teamProcedure: 'shop', staffProcedure: 'shop', signedInProcedure: 'protected', openProcedure: 'public' };

const ROUTER = [
  "import { router } from '../trpc';",
  '',
  'export const ordersRouter = router({',
  '  list: teamProcedure',
  '    .input(z.object({ teamId: z.number() }))',
  '    .query(({ ctx, input }) => ctx.db.order.findMany({ where: { teamId: input.teamId } })),',
  '  create: teamProcedure.mutation(async ({ ctx, input }) => {',
  "    ensureTeamRole(ctx, 'staff');",
  '    return ctx.db.order.create({ data: input });',
  '  }),',
  '  refund: staffProcedure.mutation(({ ctx }) => ctx.ok()),',
  '  admin: router({',
  '    wipe: teamProcedure.mutation(({ ctx }) => ctx.wipe()),',
  '    stats: signedInProcedure.query(() => 1),',
  '  }),',
  '  health: openProcedure.query(() => "ok"),',
  '  odd: strangeProcedure.query(() => 0),',
  '  nested: otherRouter,',
  '  schema: z.object({ id: z.string() }),',
  '});',
].join('\n');

test('the kind list matches the profile schema', () => {
  assert.deepEqual(Object.keys(KINDS).sort(),
    ['cycles', 'deepImports', 'expoParity', 'localeParity', 'missingAssert', 'publicTs', 'regexCount', 'routerKeys', 'windowRegex']);
  assert.deepEqual(FILE_KINDS.filter(k => !KINDS[k]), []);
  assert.deepEqual(CLASSES, ['shop', 'protected', 'public', 'unknown']);
});

test('routerKeysIn finds procedure keys with module, nested router, class and body', () => {
  const keys = routerKeysIn(ROUTER, 'apps/api/src/modules/orders/router.ts', BUILDERS);
  assert.deepEqual(keys.map(k => [k.id, k.builder, k.cls, k.line]), [
    ['orders.list', 'teamProcedure', 'shop', 4],
    ['orders.create', 'teamProcedure', 'shop', 7],
    ['orders.refund', 'staffProcedure', 'shop', 11],
    ['orders.admin.wipe', 'teamProcedure', 'shop', 13],
    ['orders.admin.stats', 'signedInProcedure', 'protected', 14],
    ['orders.health', 'openProcedure', 'public', 16],
    ['orders.odd', 'strangeProcedure', 'unknown', 17],
  ]);
  // A body runs up to the next key at the same indent: the ensureTeamRole call belongs to create.
  const list = keys.find(k => k.key === 'list');
  const create = keys.find(k => k.key === 'create');
  assert.equal(list.body.split('\n').length, 3);
  assert.doesNotMatch(list.body, /ensureTeamRole/);
  assert.match(create.body, /ensureTeamRole/);
  // The closing "})," sits at the key's indent, so it ends the body too.
  assert.equal(create.body.split('\n').length, 3);
});

test('routerKeysIn reads Windows line endings and a router file at the tree root', () => {
  const keys = routerKeysIn(ROUTER.replace(/\n/g, '\r\n'), 'router.ts', BUILDERS);
  assert.equal(keys.length, 7);
  assert.equal(keys[0].id, '..list');
  assert.doesNotMatch(keys[0].body, /\r/);
});

test('routerKeys counts per class, lists the non-shop keys and supports a filter', async () => {
  const files = { 'api/orders/router.ts': ROUTER, 'api/other/x.ts': ROUTER };
  const ctx = memCtx(files, { profile: { builders: BUILDERS } });
  const all = await KINDS.routerKeys({ id: 'procedures', files: ['api/**/router.ts'] }, ctx);
  assert.equal(all.value, 7);
  assert.equal(all.display, '7 keys: 4 shop · 1 protected · 1 public · 1 unknown');
  assert.deepEqual(all.extra.byClass, { shop: 4, protected: 1, public: 1, unknown: 1 });
  assert.deepEqual(all.extra.nonShop, ['orders.admin.stats', 'orders.health', 'orders.odd']);
  assert.equal(all.extra.filtered, false);
  assert.deepEqual(all.details[0], { path: 'api/orders/router.ts', line: 4, text: 'orders.list: teamProcedure' });

  const pub = await KINDS.routerKeys({ id: 'p', files: ['api/**/router.ts'], filter: { class: 'shop', bodyRegex: 'findMany' } }, ctx);
  assert.equal(pub.value, 1);
  assert.equal(pub.display, '1');
  assert.deepEqual(pub.details.map(d => d.text), ['orders.list: teamProcedure']);
  const byBuilder = await KINDS.routerKeys({ id: 'b', files: ['api/**/router.ts'], filter: { builder: 'staffProcedure' } }, ctx);
  assert.equal(byBuilder.value, 1);
  await assert.rejects(KINDS.routerKeys({ id: 'x', files: ['**'], filter: { class: 'admin' } }, ctx), /filter.class must be one of/);
  await assert.rejects(KINDS.routerKeys({ id: 'x', files: ['**'], filter: 'shop' }, ctx), /"filter" must be an object/);
  await assert.rejects(KINDS.routerKeys({ id: 'x' }, ctx), /needs "files", a list of globs/);
});

test('missingAssert flags shop keys without an assert call, except asserting builders', async () => {
  const profile = { builders: BUILDERS, assertingBuilders: ['staffProcedure'], assertPattern: '\\bensure[A-Z]\\w*\\s*\\(' };
  const ctx = memCtx({ 'api/orders/router.ts': ROUTER }, { profile });
  const r = await KINDS.missingAssert({ id: 'missingAssert', files: ['api/**/router.ts'] }, ctx);
  assert.equal(r.value, 2);
  assert.deepEqual(r.details.map(d => d.text), ['orders.list: teamProcedure', 'orders.admin.wipe: teamProcedure']);
  assert.deepEqual(r.extra, { checked: 3 });
  // The probe can carry its own pattern; without any pattern the probe can't run.
  const own = await KINDS.missingAssert({ id: 'm', files: ['api/**/router.ts'], assertPattern: 'findMany' }, ctx);
  assert.deepEqual(own.details.map(d => d.text), ['orders.create: teamProcedure', 'orders.admin.wipe: teamProcedure']);
  await assert.rejects(KINDS.missingAssert({ id: 'm', files: ['**'] }, memCtx({}, { profile: { builders: BUILDERS } })), /no assertPattern/);
});

test('regexCount counts every match, or files with perFile, and gives line details', async () => {
  const files = {
    'web/a.tsx': "'use client';\nconst x = y as never;\nconst z = w as never; // as never\n",
    'web/b.tsx': '"use client";\n',
    'web/c.ts': 'const q = 1;\n',
    'web/c.test.ts': 'x as never\n',
  };
  const ctx = memCtx(files);
  const all = await KINDS.regexCount({ id: 'asNever', files: ['web/**/*.{ts,tsx}'], exclude: ['**/*.test.ts'], regex: '\\bas never\\b' }, ctx);
  assert.equal(all.value, 3);
  assert.deepEqual(all.extra, { files: 3, filesWithHits: 1, matches: 3 });
  assert.deepEqual(all.details.map(d => d.line), [2, 3, 3]);
  const perFile = await KINDS.regexCount({ id: 'useClient', files: ['web/**/*.tsx'], regex: "^['\"]use client['\"]", perFile: true }, ctx);
  assert.equal(perFile.value, 2);
  assert.equal(perFile.display, '2 files');
  assert.equal(perFile.details.length, 2);
  const one = await KINDS.regexCount({ id: 'u', files: ['web/**/*.tsx'], regex: 'use client', perFile: true }, memCtx({ 'web/a.tsx': files['web/a.tsx'] }));
  assert.equal(one.display, '1 file');
  const nocase = await KINDS.regexCount({ id: 'n', files: ['web/*.tsx'], regex: 'USE CLIENT', flags: 'i' }, ctx);
  assert.equal(nocase.value, 2);
});

test('regexCount reports a multi-line match on the line it starts', async () => {
  const ctx = memCtx({ 'api/a.ts': "const a = 1;\nconst due = new Date(\n  '2026-01-31');\n" });
  const r = await KINDS.regexCount({ id: 'l', files: ['api/*.ts'], regex: "new Date\\(\\s*'" }, ctx);
  assert.equal(r.value, 1);
  assert.deepEqual(r.details, [{ path: 'api/a.ts', line: 2, text: "const due = new Date( '2026-01-31');" }]);
});

test('windowRegex counts a start once when the regex hits within `within` lines', async () => {
  const lines = [
    'for (const a of list) {', // 1: start, hit on line 4 (3 lines after)
    '  x();',
    '  y();',
    '  await save(a);',
    '}',
    'for (const b of list) {', // 6: start, hit on line 10 (4 lines after): outside within 3
    '  x();',
    '  y();',
    '  z();',
    '  await save(b);',
    '}',
    'for (const c of list) await save(c); await done();', // 12: hit on the start line, counted once
  ];
  const ctx = memCtx({ 'api/loop.ts': lines.join('\n') });
  const r = await KINDS.windowRegex({ id: 'tx', files: ['api/*.ts'], start: '\\bfor\\s*\\(', within: 3, regex: '\\bawait\\b' }, ctx);
  assert.equal(r.value, 2);
  assert.deepEqual(r.extra, { starts: 3 });
  assert.deepEqual(r.details.map(d => d.line), [4, 12]);
  await assert.rejects(KINDS.windowRegex({ id: 'tx', files: ['**'], start: 'a', regex: 'b', within: -1 }, ctx), /"within" must be a whole number/);
  await assert.rejects(KINDS.windowRegex({ id: 'tx', files: ['**'], regex: 'b' }, ctx), /needs "start"/);
});

const FEATURES = {
  'web/src/features/alpha/Panel.tsx': [
    "import { helper } from '@/features/beta/internal/helper';", // deep (alias)
    "import { api } from '@/features/beta';",                    // public: the folder's index
    "import { thing } from '../gamma/thing';",                   // deep (relative)
    "import { pub } from '@/features/gamma/public';",            // public entry
    "import { own } from './own';",                              // same feature
    "import { lib } from '@/lib/shared';",                       // not a feature
    "import type { T } from '@/features/types';",                // a file, not a feature
    "export * from '@/features/gamma/index.ts';",                // public: index with extension
    "const later = () => import('@/features/beta/internal/x');", // deep (dynamic import)
    "const old = require('../beta/internal/y');",                // deep (require)
  ].join('\n'),
  'web/src/features/alpha/own.ts': 'export const own = 1;\n',
  'web/src/features/beta/index.ts': "export * from './internal/helper';\n",
  'web/src/features/beta/internal/helper.ts': "import { x } from '../../alpha/own';\n", // deep into alpha
  'web/src/features/gamma/public.ts': 'export const pub = 1;\n',
  'web/src/features/gamma/thing.ts': 'export const thing = 1;\n',
  'web/src/features/types.ts': "import { a } from '@/features/alpha/own';\n", // not inside a feature: ignored
};

test('deepImports counts imports into another feature that skip its public entries', async () => {
  const probe = { id: 'deepImports', featuresDir: 'web/src/features/', alias: '@/features/', publicEntries: ['public', 'index'] };
  const r = await KINDS.deepImports(probe, memCtx(FEATURES));
  assert.equal(r.value, 5);
  assert.deepEqual(r.details.map(d => `${d.line}:${d.text}`), [
    '1:@/features/beta/internal/helper',
    '3:../gamma/thing',
    '9:@/features/beta/internal/x',
    '10:../beta/internal/y',
    '1:../../alpha/own',
  ]);
  assert.deepEqual(r.extra.targets, { beta: 3, alpha: 1, gamma: 1 });
  // Without the alias only relative imports count; `only` limits the importing files.
  const relOnly = await KINDS.deepImports({ ...probe, alias: '' }, memCtx(FEATURES));
  assert.equal(relOnly.value, 3);
  const only = await KINDS.deepImports(probe, memCtx(FEATURES, { only: ['web/src/features/beta/internal/helper.ts'] }));
  assert.equal(only.value, 1);
});

test('a folder probe whose folder is gone fails instead of counting 0', async () => {
  // A refactor moved the features folder: 0 deep imports or 0 of 0 boundaries would look like
  // progress on the tiles, in the wins and in the G0 ratchet.
  const moved = memCtx({ 'web/src/modules/alpha/Panel.tsx': '', 'app/m/cart/a.ts': '', 'msg/en.json': '{}' });
  await assert.rejects(KINDS.deepImports({ id: 'd', featuresDir: 'web/src/features' }, moved), { message: 'web/src/features is not a folder in this tree.' });
  await assert.rejects(KINDS.publicTs({ id: 'p', featuresDir: 'web/src/features/' }, moved), /^Error: web\/src\/features is not a folder in this tree\.$/);
  await assert.rejects(KINDS.localeParity({ id: 'l', dir: 'messages', source: 'en' }, moved), /messages is not a folder in this tree/);
  const expo = { expo: { webFeatures: 'web/src/modules', expoModules: 'app/modules' } };
  await assert.rejects(KINDS.expoParity({ id: 'e' }, memCtx({ 'web/src/modules/alpha/a.ts': '' }, { profile: expo })), /app\/modules is not a folder in this tree/);
  await assert.rejects(KINDS.expoParity({ id: 'e', webFeatures: 'web/f' }, memCtx({ 'app/modules/a/a.ts': '' }, { profile: expo })), /web\/f is not a folder in this tree/);
});

test('publicTs counts features with a public entry file of any code extension', async () => {
  const files = {
    'web/f/a/public.ts': '', 'web/f/a/aBoundary.test.ts': '',
    'web/f/b/public.mjs': '',
    'web/f/c/index.ts': '', 'web/f/c/public.test.ts': '',
    'web/f/d/sub/public.ts': '',
  };
  const r = await KINDS.publicTs({ id: 'publicTs', featuresDir: 'web/f', boundaryTestRegex: 'Boundary\\.test\\.ts$' }, memCtx(files));
  assert.equal(r.value, 2);
  assert.equal(r.display, '2 of 4');
  assert.deepEqual(r.extra, { of: 4, withBoundaryTest: 1, higherIsBetter: true });
  assert.deepEqual(r.details, [
    { path: 'web/f/a/public.ts', line: 0, text: 'a' },
    { path: 'web/f/b/public.mjs', line: 0, text: 'b (no boundary test)' },
  ]);
  const named = await KINDS.publicTs({ id: 'p', featuresDir: 'web/f', file: 'index.ts' }, memCtx(files));
  assert.equal(named.display, '1 of 4');
  await assert.rejects(KINDS.publicTs({ id: 'p', featuresDir: 'web/nothing' }, memCtx(files)), /web\/nothing is not a folder in this tree/);
});

test('localeParity reads folder and file layouts and reports the worst locale', async () => {
  const folders = {
    'msg/en/common.json': JSON.stringify({ save: 'Save', nested: { a: 'A', b: 'B' }, list: ['x'] }),
    'msg/en/home.json': JSON.stringify({ title: 'Home' }),
    'msg/de/common.json': JSON.stringify({ save: 'Speichern', nested: { a: 'A' } }),
    'msg/fr/common.json': JSON.stringify({ save: 'S', nested: { a: 'A', b: 'B' }, list: [] }),
    'msg/fr/home.json': JSON.stringify({ title: 'Accueil', extra: 'x' }),
  };
  const r = await KINDS.localeParity({ id: 'l', dir: 'msg', source: 'en' }, memCtx(folders));
  assert.equal(r.value, 3);
  assert.equal(r.display, '0–3 per locale');
  assert.deepEqual(r.extra, { min: 0, max: 3, perLocale: { de: 3, fr: 0 }, sourceKeys: 5, locales: 2 });
  assert.deepEqual(r.details.map(d => `${d.path} ${d.text}`), [
    'msg/de/common.json de: common.nested.b', 'msg/de/common.json de: common.list', 'msg/de/home.json de: home.title',
  ]);
  const flat = { 'loc/en-US.json': '﻿{ "a": 1, "b": { "c": 2 } }', 'loc/nl.json': '{ "a": 1 }', 'loc/notes.txt': 'x' };
  const f = await KINDS.localeParity({ id: 'l', dir: 'loc', source: 'en-US' }, memCtx(flat));
  assert.equal(f.display, '1 per locale');
  assert.deepEqual(f.details, [{ path: 'loc/nl.json', line: 0, text: 'nl: b.c' }]);
  const lonely = await KINDS.localeParity({ id: 'l', dir: 'loc', source: 'en-US' }, memCtx({ 'loc/en-US.json': '{}' }));
  assert.equal(lonely.display, 'no other locales');
  await assert.rejects(KINDS.localeParity({ id: 'l', dir: 'loc', source: 'pt' }, memCtx(flat)), /loc has no pt messages/);
  await assert.rejects(KINDS.localeParity({ id: 'l', dir: 'loc', source: 'en-US' }, memCtx({ 'loc/en-US.json': '[1]' })), /not a valid JSON object/);
});

test('expoParity is the share of web features with a mapped or same-named module', async () => {
  const files = {
    'web/f/cart/a.ts': '', 'web/f/users/a.ts': '', 'web/f/billing/a.ts': '', 'web/f/maps/a.ts': '',
    'app/m/cart/a.ts': '', 'app/m/staff/a.ts': '',
  };
  const profile = { expo: { webFeatures: 'web/f', expoModules: 'app/m', map: { users: 'staff', billing: 'payments' } } };
  const r = await KINDS.expoParity({ id: 'expoParity' }, memCtx(files, { profile }));
  assert.equal(r.value, 50);
  assert.equal(r.display, '50%');
  assert.deepEqual(r.extra, { matched: 2, total: 4, missing: ['billing', 'maps'], higherIsBetter: true });
  // A web features folder with no feature in it is a real 0%.
  const empty = await KINDS.expoParity({ id: 'e' }, memCtx({ 'web/f/README.md': '', 'app/m/cart/a.ts': '' }, { profile }));
  assert.equal(empty.value, 0);
  assert.equal(empty.extra.total, 0);
  await assert.rejects(KINDS.expoParity({ id: 'e' }, memCtx({}, { profile })), /web\/f is not a folder in this tree/);
  await assert.rejects(KINDS.expoParity({ id: 'e' }, memCtx(files)), /no expo section/);
});

const GRAPH = {
  'modules/a/x.ts': ['modules/b/y.ts'],
  'modules/b/y.ts': ['modules/a/x.ts', 'modules/c/z.ts'],
  'modules/c/z.ts': [],
  'core/t.ts': ['core/u.ts'],
  'core/u.ts': ['core/t.ts'],
};
const graphTree = prefix => Object.fromEntries(Object.keys(GRAPH).map(k => [`api/${prefix}${k}`, '']));
const CYCLES = { id: 'cyc', cwd: 'api', argv: ['{node}', '{pkg:madge/bin/cli.js}', '--json', '--extensions', 'ts', 'src'], moduleRegex: '^src/modules/([^/]+)/', timeoutSec: 9 };

test('cycles reads a madge graph printed relative to the source folder', async () => {
  const ctx = memCtx(graphTree('src/'), { run: async () => ({ code: 0, stdout: `Processing...\n${JSON.stringify(GRAPH)}\n`, stderr: '' }) });
  const r = await KINDS.cycles(CYCLES, ctx);
  assert.equal(r.value, 2);
  assert.equal(r.display, '2 of 3 modules');
  assert.deepEqual(r.extra, { largestModuleCycle: 2, modules: 3, files: 5, filesInCycles: 4, largestModules: ['a', 'b'] });
  assert.deepEqual(r.details.map(d => d.path), ['api/src/core/t.ts', 'api/src/modules/a/x.ts']);
  assert.equal(r.details[1].text, 'cycle of 2 files: src/modules/a/x.ts, src/modules/b/y.ts');
  assert.deepEqual(ctx.calls[0], { command: 'node', args: ['node_modules/madge/bin/cli.js', '--json', '--extensions', 'ts', 'src'], cwd: 'api', timeoutMs: 9000 });
});

test('cycles keeps a graph that is already relative to the probe cwd', async () => {
  const graph = Object.fromEntries(Object.entries(GRAPH).map(([k, v]) => [`src/${k}`, v.map(d => `src/${d}`)]));
  const ctx = memCtx(graphTree('src/'), { run: async () => ({ code: 0, stdout: JSON.stringify(graph), stderr: '' }) });
  const r = await KINDS.cycles({ ...CYCLES, argv: [...CYCLES.argv, '--basedir', '.'] }, ctx);
  assert.equal(r.extra.largestModuleCycle, 2);
  assert.equal(r.extra.warning, undefined);
});

test('cycles fails instead of recording 0 when the graph is empty or its modules cannot be read', async () => {
  const run = async () => ({ code: 0, stdout: JSON.stringify(GRAPH), stderr: '' });
  // Graph paths that exist nowhere under the probe cwd: module names would be guesses.
  await assert.rejects(KINDS.cycles(CYCLES, memCtx({}, { run })),
    { message: "The madge graph paths were not found under api, so its modules can't be read. Pass --basedir to set the base folder." });
  // A moduleRegex that matches no path would give "0 of 0 modules".
  await assert.rejects(KINDS.cycles({ ...CYCLES, moduleRegex: '^lib/([^/]+)/' }, memCtx(graphTree('src/'), { run })),
    { message: 'moduleRegex matched no file in the madge graph. Paths are read relative to api, for example src/core/t.ts.' });
  // madge printing {} (a wrong source folder or cwd) is not "no cycles".
  await assert.rejects(KINDS.cycles(CYCLES, memCtx({}, { run: async () => ({ code: 0, stdout: '{}' }) })),
    { message: "madge found no files; check the probe's cwd and source folder." });
  await assert.rejects(KINDS.cycles({ ...CYCLES, moduleRegex: undefined }, memCtx({}, { run: async () => ({ code: 0, stdout: 'Processed 0 files\n{}' }) })),
    /madge found no files/);
  // A broken moduleRegex fails before madge is started.
  const ctx = memCtx({}, { run });
  await assert.rejects(KINDS.cycles({ ...CYCLES, moduleRegex: '(' }, ctx), /"moduleRegex" is not a valid regex/);
  assert.equal(ctx.calls.length, 0);
});

test('cycles without moduleRegex keeps the file cycle count and warns when the paths are not in the tree', async () => {
  const run = async () => ({ code: 0, stdout: JSON.stringify(GRAPH), stderr: '' });
  const placed = await KINDS.cycles({ ...CYCLES, moduleRegex: undefined }, memCtx(graphTree('src/'), { run }));
  assert.equal(placed.display, '2 file cycles');
  assert.equal(placed.extra.warning, undefined);
  const lost = await KINDS.cycles({ ...CYCLES, moduleRegex: undefined }, memCtx({}, { run }));
  assert.equal(lost.value, 2);
  assert.match(lost.extra.warning, /were not found under api, so the cycle paths may be wrong/);
});

test('cycles turns tool trouble into one plain error', async () => {
  const cases = [
    [{ code: 3, stdout: '', stderr: '\n  Error: no tsconfig\n' }, 'madge exited with code 3: Error: no tsconfig'],
    [{ code: 1, stdout: 'bad things', stderr: '' }, 'madge exited with code 1: bad things'],
    [{ code: null, timedOut: true }, 'madge did not finish within 9 s.'],
    [{ code: 0, stdout: 'no json' }, 'madge printed no JSON graph.'],
  ];
  for (const [answer, message] of cases) {
    await assert.rejects(KINDS.cycles(CYCLES, memCtx({}, { run: async () => answer })), { message });
  }
  await assert.rejects(KINDS.cycles({ id: 'c' }, memCtx({})), /needs "argv"/);
});

test('toolName and snippet', () => {
  assert.equal(toolName(['{node}', '{pkg:madge/bin/cli.js}']), 'madge');
  assert.equal(toolName(['{node}', '{pkg:@scope/tool/bin.js}']), '@scope/tool');
  assert.equal(toolName(['{node}', 'x.js']), 'the tool');
  assert.equal(snippet('  a\t\tb  \n c '), 'a b c');
  const long = snippet('x'.repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});
