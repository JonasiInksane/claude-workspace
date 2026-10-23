// Tests for the project page's data (parts/project-data.js) with a stand-in DOM and fetch
// (test/dom.mjs): use() loads only known parts and only for a name; a failed refresh keeps the last
// answer next to its error and status; a part asked for while it loads loads once more, and a
// reload() then resolves only with that newer answer; every
// answer tells the listeners; reload() loads what is in use; the focus listener comes with the
// first use and goes with the last; liveRunsOf() picks the project's waiting and running runs.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, reply, settle } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
let fail = false;
let gate = null; // while set, /api/findings answers only when it resolves
let asked = 0; // every request's number, in the order they were made
const calls = fakeFetch(async path => {
  const n = ++asked;
  if (path.startsWith('/api/findings') && gate) await gate.promise;
  if (path.startsWith('/api/runs?status=')) return { ok: true, runs: [{ id: 'r1', project: 'example', status: 'waiting' }, { id: 'r2', project: 'other', status: 'running' }] };
  if (fail) return reply(500, { ok: false, error: 'It broke.' });
  return { ok: true, path, n };
});
const store = await import('../store.js');
const { dataOf, inUseBy, liveRunsOf, onData, PARTS, reload, slot, use } = await import('./project-data.js');

const count = prefix => calls.filter(c => c.path.startsWith(prefix)).length;

test('use: loads each known part once, for a name; unknown parts and empty names load nothing', async () => {
  const told = [];
  const off = onData((name, part) => told.push(`${name}:${part}`));
  const release = use('example', ['project', 'nope', 'project']);
  await settle(5);
  assert.equal(count('/api/project?name=example'), 1);
  assert.equal(dataOf(slot('example').project).path, '/api/project?name=example');
  assert.deepEqual(told, ['example:project']);
  assert.equal(inUseBy('example'), true);
  release();
  release();
  assert.equal(inUseBy('example'), false, 'released (twice is harmless)');
  const before = calls.length;
  use('', ['project'])();
  use('example', 'project')();
  use('example', [])();
  await settle(5);
  assert.equal(calls.length, before, 'nothing loaded');
  off();
  assert.deepEqual(Object.keys(PARTS).sort(), ['checks', 'findings', 'library', 'metrics', 'project', 'runs', 'settings', 'tasks', 'waiting']);
  assert.equal(PARTS.settings('example'), '/api/project-settings?project=example');
  assert.equal(PARTS.library('example'), '/api/library?project=example&archived=1', 'archived too: an attached asset may be archived');
});

test('a failed refresh keeps the last answer next to its error and status', async () => {
  const release = use('keep', ['checks']);
  await settle(5);
  assert.ok(dataOf(slot('keep').checks));
  fail = true;
  await reload();
  await settle(5);
  const s = slot('keep').checks;
  assert.equal(s.error, 'It broke.');
  assert.equal(s.status, 500);
  assert.equal(s.data.path, '/api/checks?project=keep', 'the old answer is still there');
  fail = false;
  release();
});

test('a part asked for while it loads loads once more afterwards, not twice at once', async () => {
  let open;
  gate = { promise: new Promise(r => { open = r; }) };
  const a = use('busy', ['findings']);
  const b = use('busy', ['findings']);
  await settle(5);
  assert.equal(count('/api/findings?project=busy'), 1, 'one request at a time');
  gate = null;
  open();
  await settle(10);
  assert.equal(count('/api/findings?project=busy'), 2, 'then once more for the second ask');
  a();
  b();
});

test('reload while a request is out resolves with the load after it, so the caller sees fresh data', async () => {
  let open;
  gate = { promise: new Promise(r => { open = r; }) };
  const release = use('late', ['findings']);
  await settle(5);
  const mark = asked; // a change the caller makes now (a save) is newer than the request that is out
  let done = false;
  const p = reload('late').then(() => { done = true; });
  await settle(5);
  assert.equal(done, false, 'the request that was out has not answered yet');
  gate = null;
  open();
  await p;
  assert.ok(dataOf(slot('late').findings).n > mark, 'the data is from a request made after the call');
  assert.equal(count('/api/findings?project=late'), 2);
  release();
});

test('reload loads what is in use; the window focus listener lives as long as some use', async () => {
  const focusListeners = () => (dom.window.listeners.get('focus') || []).length;
  assert.equal(focusListeners(), 0);
  const release = use('fresh', ['metrics', 'runs']);
  assert.equal(focusListeners(), 1);
  await settle(5);
  const n = count('/api/metrics?project=fresh');
  await reload('fresh');
  await reload('someone-else');
  assert.equal(count('/api/metrics?project=fresh'), n + 1);
  assert.equal(count('/api/runs?project=fresh&limit=8'), 2);
  release();
  assert.equal(focusListeners(), 0);
  await reload();
  assert.equal(count('/api/metrics?project=fresh'), n + 1, 'nothing in use: nothing loads');
});

test('liveRunsOf: the project\'s waiting and running runs from the store', async () => {
  await store.loadRuns();
  assert.deepEqual(liveRunsOf('example').map(r => r.id), ['r1']);
  assert.deepEqual(liveRunsOf('nobody'), []);
});
