// Tests for the project page's Tasks tab (views/project/tasks.js): grouping runs into tasks (a
// root run and every run below it, at any depth), the order (tasks newest first by their latest
// run, the runs below a root oldest first), a parent older than the list, parent loops and bad
// rows; then the tab in a stand-in DOM (test/dom.mjs): rows that open their run, the empty state
// and the note when the list is cut. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true, runs: [] }));
const store = await import('../../store.js');
const { slot, TASK_LIMIT } = await import('../../parts/project-data.js');
const { groupTasks, default: tasks } = await import('./tasks.js');

const run = (id, parent = null, over = {}) => ({ id, parent, project: 'example', pipeline: 'refactor', title: `T ${id}`, status: 'passed', ...over });

test('groupTasks: a root run with every run below it, at any depth', () => {
  const rows = [run('05', '04'), run('04', '01'), run('03'), run('02', '01'), run('01')];
  const t = groupTasks(rows);
  assert.deepEqual(t.map(x => x.root.id), ['01', '03'], 'two tasks; the one with the newest run first');
  assert.deepEqual(t[0].runs.map(r => r.id), ['02', '04', '05'], 'below the root: oldest first, grandchildren too');
  assert.equal(t[0].latest, '05');
  assert.deepEqual(t[1].runs, []);
  assert.equal(t[0].continues, false);
});

test('groupTasks: newest first by the latest run, not by when the root started', () => {
  const t = groupTasks([run('09'), run('08', '02'), run('05'), run('02')]);
  assert.deepEqual(t.map(x => [x.root.id, x.latest]), [['09', '09'], ['02', '08'], ['05', '05']]);
});

test('groupTasks: a parent older than the list starts its own task, marked as continuing', () => {
  const t = groupTasks([run('07', '00-gone'), run('08', '07')]);
  assert.equal(t.length, 1);
  assert.equal(t[0].root.id, '07');
  assert.equal(t[0].continues, true);
  assert.deepEqual(t[0].runs.map(r => r.id), ['08']);
});

test('groupTasks: a parent loop or a run that is its own parent cannot hang it; each run shows once', () => {
  const loop = groupTasks([run('a', 'b'), run('b', 'a'), run('c', 'c')]);
  const ids = loop.flatMap(x => [x.root.id, ...x.runs.map(r => r.id)]).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.deepEqual(groupTasks(null), []);
  assert.deepEqual(groupTasks([null, 3, {}, { id: '' }, { id: 7 }]), [], 'rows without an id are left out');
});

const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'tasks'], realPath: 'C:\\x' };
const ctx = () => ({ state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });

test('the tab: tasks with their runs; a row opens its run', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  slot('example').tasks = { data: { runs: [run('03', '01', { status: 'waiting', waiting: 'review', title: 'Slice 2' }), run('02'), run('01', null, { title: 'Refactor totals' })] } };
  const el = dom.document.createElement('div');
  tasks.render(el, ctx());
  const text = textOf(el);
  assert.match(text, /2 tasks from 3 runs, newest first\./);
  const items = el.querySelectorAll('li.task');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Refactor totals/);
  assert.match(items[0].querySelector('.task-runs').textContent, /Slice 2/);
  assert.match(items[0].querySelector('.task-runs').getAttribute('aria-label'), /Runs started from Refactor totals/);
  dom.click(el.querySelector('[data-key="task:03"]'));
  assert.equal(dom.location.hash, '#run/03', 'every row links to its run');
});

test('the tab: no runs yet, a failed load, and a list cut at the limit', () => {
  const el = dom.document.createElement('div');
  slot('example').tasks = { data: { runs: [] } };
  tasks.render(el, ctx());
  assert.match(textOf(el), /No tasks yet/);
  slot('example').tasks = { data: undefined, error: 'Could not reach the app server', status: undefined };
  tasks.render(el, ctx());
  assert.match(textOf(el), /Could not reach the app server/);
  slot('example').tasks = { data: { runs: Array.from({ length: TASK_LIMIT }, (_, i) => run(String(i).padStart(4, '0'))) } };
  tasks.render(el, ctx());
  assert.match(textOf(el), new RegExp(`Only the newest ${TASK_LIMIT} runs are grouped here`));
});
