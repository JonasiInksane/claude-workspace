// Tests for the sidebar's entries (parts/nav.js): the order (Today, Projects with every project
// nested, Assets, Flows, Runs with up to three review gates nested), the amber waiting count of a
// code project only, the counts' words for screen readers, Library at the foot, and which entry is
// the screen on show. Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footItems, isCurrentItem, MAX_REVIEW_ITEMS, navItems } from './nav.js';

const views = {
  today: { id: 'today', label: 'Today', icon: 'T' },
  projects: { id: 'projects', label: 'Projects', icon: 'P', count: s => s.projects.length || '' },
  assets: { id: 'assets', label: 'Assets', icon: 'A', count: s => s.assets.reduce((n, p) => n + p.assets.length, 0) || '' },
  flows: { id: 'flows', label: 'Flows', icon: 'F', count: s => s.flows.length || '' },
  runs: { id: 'runs', label: 'Runs', icon: 'R' },
  tools: { id: 'tools', label: 'Library', icon: 'L' },
};
const state = {
  projects: [
    { name: 'example', type: { id: 'code' }, waiting: 4 },
    { name: 'notes', type: { id: 'generic' }, waiting: 2 },
    { name: 'sample-art', type: { id: 'assets' }, waiting: 0 },
  ],
  assets: [{ project: 'sample-art', assets: [{}] }],
  flows: [],
};
const reviews = ['r1', 'r2', 'r3', 'r4'].map(id => ({ id, title: `Refactor ${id}` }));

test('the order: Today, Projects with its projects, Assets, Flows, Runs with its review gates', () => {
  const items = navItems(state, { views, running: 2, reviews });
  assert.deepEqual(items.map(i => i.key), [
    'today', 'projects', 'project/example', 'project/notes', 'project/sample-art', 'assets', 'flows', 'runs', 'review/r1', 'review/r2', 'review/r3',
  ]);
  assert.equal(MAX_REVIEW_ITEMS, 3);
  const byKey = new Map(items.map(i => [i.key, i]));
  assert.deepEqual(['project/example', 'project/notes', 'review/r1'].map(k => byKey.get(k).cls), ['sub', 'sub', 'sub'], 'nested entries');
  assert.deepEqual([byKey.get('project/example').route, byKey.get('project/example').sub], ['project', 'example']);
  assert.equal(byKey.get('review/r2').label, 'Review gate: Refactor r2');
  assert.ok(!items.some(i => i.key === 'images' || i.key === 'tools' || /health/.test(i.key)), 'no Images, Library or Health and wins in the main nav');
});

test('counts: a code project shows its waiting runs in amber; every count has words for screen readers', () => {
  const byKey = new Map(navItems(state, { views, running: 2, reviews: [] }).map(i => [i.key, i]));
  assert.deepEqual([byKey.get('project/example').count, byKey.get('project/example').countCls, byKey.get('project/example').sr], [4, 'amber', ', 4 waiting']);
  assert.equal(byKey.get('project/notes').count, '', 'only a code project has runs to wait on');
  assert.equal(byKey.get('project/sample-art').count, '');
  assert.deepEqual([byKey.get('projects').count, byKey.get('projects').sr], [3, ', 3 projects']);
  assert.deepEqual([byKey.get('assets').count, byKey.get('assets').sr], [1, ', 1 asset']);
  assert.deepEqual([byKey.get('flows').count, byKey.get('flows').sr], ['', ''], 'no flows: no count');
  assert.deepEqual([byKey.get('runs').count, byKey.get('runs').sr], [2, ', 2 running']);
  const idle = new Map(navItems(state, { views, running: 0 }).map(i => [i.key, i]));
  assert.deepEqual([idle.get('runs').count, idle.get('runs').sr], ['', '']);
});

test('odd input: no state, a project without a name, a view that says it is not visible', () => {
  assert.deepEqual(navItems(null, { views: { ...views, projects: { ...views.projects, count: () => '' }, assets: { ...views.assets, count: () => '' }, flows: { ...views.flows, count: () => '' } } })
    .map(i => i.key), ['today', 'projects', 'assets', 'flows', 'runs']);
  const items = navItems({ ...state, projects: [null, { name: '' }, { name: 'x', waiting: [1, 2] , type: { id: 'code' } }] }, { views });
  assert.deepEqual(items.filter(i => i.route === 'project').map(i => [i.key, i.count]), [['project/x', 2]], 'a list of waiting runs counts too');
  const hidden = navItems(state, { views: { ...views, flows: { ...views.flows, visible: () => false } } });
  assert.ok(!hidden.some(i => i.key === 'flows'));
});

test('the foot: Library, at the #library route', () => {
  assert.deepEqual(footItems(state, { views }).map(i => [i.key, i.route, i.label]), [['tools', 'library', 'Library']]);
  assert.deepEqual(footItems(state, {}), []);
});

test('isCurrentItem: a project entry covers every tab of its project; Runs covers a run; a gate only its run', () => {
  const p = { route: 'project', sub: 'example' };
  assert.equal(isCurrentItem(p, 'project', 'example/checks'), true);
  assert.equal(isCurrentItem(p, 'project', 'example'), true);
  assert.equal(isCurrentItem(p, 'project', 'examples/overview'), false);
  assert.equal(isCurrentItem(p, 'runs', ''), false);
  assert.equal(isCurrentItem({ route: 'runs' }, 'run', 'r1'), true);
  assert.equal(isCurrentItem({ route: 'review', sub: 'r1' }, 'review', 'r1'), true);
  assert.equal(isCurrentItem({ route: 'review', sub: 'r1' }, 'review', 'r2'), false);
  assert.equal(isCurrentItem({ route: 'library' }, 'tools', ''), true, 'the Library entry is current on views/tools.js');
  assert.equal(isCurrentItem({ route: 'projects' }, 'project', 'example/overview'), false, 'Projects itself is only the list');
});
