// Tests for the project page's Changes tab (views/project/changes.js): lock ages (moved from the
// cockpit's tests), which runs wait at the review gate or the commit (this project only, each once,
// newest first), and the tab in a stand-in DOM (test/dom.mjs): a gate row opens #review/<id>, and
// the branches card shows the checkout, the run worktree and the app branches.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { ageText, gateRuns, default: changes } = await import('./changes.js');

test('lock ages as text', () => {
  assert.deepEqual([ageText(30), ageText(700), ageText(5 * 3600), ageText(3 * 86400 + 5), ageText(null), ageText(-1), ageText('x')],
    ['1 min', '12 min', '5 h', '3 days', '', '', '']);
});

const w = (id, waiting, over = {}) => ({ id, project: 'example', status: 'waiting', waiting, title: `Run ${id}`, pipeline: 'refactor', ...over });

test('gateRuns: only this project, only the review gate and the commit, each once, newest first', () => {
  const rows = [w('261022-100010', 'review'), w('261022-100009', 'plan'), w('261022-100011', 'commit'), w('261022-100012', 'review', { project: 'other' })];
  const live = [w('261022-100013', 'review'), w('261022-100010', 'review'), w('261022-100014', 'review', { status: 'running' })];
  assert.deepEqual(gateRuns('example', rows, live).map(r => r.id), ['261022-100013', '261022-100011', '261022-100010']);
  assert.deepEqual(gateRuns('example', null, undefined), []);
  assert.deepEqual(gateRuns('example', [null, { id: 3 }, { waiting: 'review' }]), []);
});

const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'changes'], realPath: 'C:\\x' };

test('the tab: a run at the gate links to its review; the branches card lists the checkout, the run worktree and app branches', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  slot('example').waiting = { data: { runs: [w('261022-100010-refactor-review-gate', 'review', { title: 'Refactor: cents' })] } };
  slot('example').project = { data: {
    project: { folder: 'example', present: true },
    git: { branch: 'main', sha: 'abcdef1234', changed: 0, appBranches: [{ name: 'app/1022-cents', merged: false, subject: 'Cents helper', at: new Date().toISOString() }], appBranchCount: 3, worktrees: [] },
    isolation: { mode: 'worktree', worktree: { name: 'example-run', state: 'ready', text: 'Ready', branch: 'app/1022-cents', path: 'C:\\example-run' } },
    lock: { held: true, runId: '261022-100010-refactor-review-gate', title: 'Refactor: cents', ageSec: 700 },
    checklist: [], warnings: [{ id: 'branches.unmerged', text: '1 unmerged app branch.' }],
  } };
  const el = dom.document.createElement('div');
  changes.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  const text = textOf(el);
  assert.match(text, /Waiting at the review gate/);
  assert.match(text, /Refactor: cents/);
  assert.match(text, /Main checkout · main/);
  assert.match(text, /example-run · app\/1022-cents/);
  assert.match(text, /holds the lock \(12 min\)/);
  assert.match(text, /\+ 2 more app branches not shown\./);
  assert.match(text, /1 unmerged app branch\./);
  dom.click(el.querySelector('[data-key="gate:261022-100010-refactor-review-gate"]'));
  assert.equal(dom.location.hash, '#review/261022-100010-refactor-review-gate');
});

test('the tab: a failed refresh shows next to the branches it read last, and goes with the next answer', () => {
  const data = { project: { folder: 'example', present: true }, git: { branch: 'main', sha: 'abcdef1234', changed: 0, appBranches: [], worktrees: [] }, checklist: [] };
  slot('example').waiting = { data: { runs: [] } };
  slot('example').project = { data };
  const el = dom.document.createElement('div');
  const paint = () => changes.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  paint();
  assert.doesNotMatch(textOf(el), /Could not refresh/);
  slot('example').project = { data, error: 'git took too long', status: 500 };
  paint();
  assert.match(textOf(el), /Main checkout · main/, 'the last answer stays');
  assert.match(textOf(el), /Could not refresh: git took too long/, 'and the error shows next to it at once');
  slot('example').project = { data };
  paint();
  assert.doesNotMatch(textOf(el), /Could not refresh/);
});

test('the tab: nothing waits; a checkout git can not read says so', () => {
  slot('example').waiting = { data: { runs: [] } };
  slot('example').project = { data: { project: { folder: 'example', present: true }, git: { error: 'not a git repository' }, checklist: [] } };
  const el = dom.document.createElement('div');
  changes.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  assert.match(textOf(el), /Nothing waits at the review gate\./);
  assert.match(textOf(el), /Git could not read the checkout: not a git repository/);
});
