// Tests for probes/graph.mjs: Tarjan's strongly connected components and the module graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclesOf, moduleGraph, moduleOf, scc } from './graph.mjs';

test('scc finds the components of a known graph', () => {
  // The textbook example: {a,b,e}, {c,d,h}, {f,g}.
  const g = { a: ['b'], b: ['c', 'e', 'f'], c: ['d', 'g'], d: ['c', 'h'], e: ['a', 'f'], f: ['g'], g: ['f'], h: ['d', 'g'] };
  assert.deepEqual(scc(g), [['a', 'b', 'e'], ['c', 'd', 'h'], ['f', 'g']]);
  assert.deepEqual(cyclesOf(g).map(c => c.length), [3, 3, 2]);
});

test('scc counts every node once, including targets that are not keys', () => {
  const comps = scc({ a: ['b', 'zz'], b: ['a'] });
  assert.deepEqual(comps, [['a', 'b'], ['zz']]);
  assert.equal(comps.flat().length, 3);
});

test('a self-import and a plain chain are not cycles', () => {
  assert.deepEqual(cyclesOf({ a: ['a'], b: ['c'], c: [] }), []);
  assert.equal(scc({ a: ['a'] }).length, 1);
});

test('scc accepts a Map and Set targets', () => {
  const g = new Map([['x', new Set(['y'])], ['y', ['x']]]);
  assert.deepEqual(cyclesOf(g), [['x', 'y']]);
});

test('scc handles a 50,000-file chain without overflowing the stack', () => {
  const g = {};
  const n = 50000;
  for (let i = 0; i < n; i++) g[`f${i}`] = [`f${i + 1}`];
  g[`f${n}`] = ['f0'];
  const comps = cyclesOf(g);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].length, n + 1);
});

test('scc output order is stable: biggest first, then by name', () => {
  const g = { q: ['r'], r: ['q'], a: ['b'], b: ['a'], m: ['n', 'o'], n: ['o'], o: ['m'] };
  assert.deepEqual(scc(g), [['m', 'n', 'o'], ['a', 'b'], ['q', 'r']]);
});

test('moduleOf takes the first capture group, or the whole match', () => {
  assert.equal(moduleOf('src/modules/billing/a.ts', /^src\/modules\/([^/]+)\//), 'billing');
  assert.equal(moduleOf('src/core/a.ts', /^src\/modules\/([^/]+)\//), null);
  assert.equal(moduleOf('lib/x.ts', /^lib/), 'lib');
});

test('moduleGraph keeps only edges between different modules', () => {
  const files = {
    'src/modules/billing/a.ts': ['src/modules/billing/b.ts', 'src/modules/teams/x.ts', 'src/core/t.ts'],
    'src/modules/billing/b.ts': [],
    'src/modules/teams/x.ts': ['src/modules/billing/a.ts', 'src/modules/audit/l.ts'],
    'src/core/t.ts': [],
  };
  const mg = moduleGraph(files, '^src/modules/([^/]+)/');
  assert.deepEqual(mg, { audit: [], billing: ['teams'], teams: ['audit', 'billing'] });
  assert.deepEqual(cyclesOf(mg), [['billing', 'teams']]);
});

test('moduleGraph ignores a global flag on the regex', () => {
  const files = { 'm/a/1': ['m/b/1'], 'm/b/1': ['m/a/1'], 'm/c/1': ['m/a/1'] };
  const mg = moduleGraph(files, /^m\/([^/]+)\//g);
  assert.deepEqual(Object.keys(mg), ['a', 'b', 'c']);
  assert.deepEqual(mg.c, ['a']);
});
