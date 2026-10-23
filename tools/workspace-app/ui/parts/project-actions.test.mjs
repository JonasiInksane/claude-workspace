// Tests for what the project page's shared buttons do (parts/project-actions.js), with a stand-in
// DOM and fetch (test/dom.mjs): creating a profile posts the project's name and then reloads the
// state and the pipelines (a refusal stops there), the worktree setup opens its run, the setup
// checklist's link goes to Projects, and a branch review asks first and starts only after OK.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, reply, settle } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
let refuse = false;
const calls = fakeFetch((path, { method }) => {
  if (method === 'POST' && path === '/api/project/profile-init') return refuse ? reply(409, { ok: false, error: 'A profile exists.' }) : { ok: true, message: 'Created.' };
  if (method === 'POST' && path === '/api/project/worktree-setup') return { ok: true, runId: '261023-100000-setup-worktree', message: 'Setting up.' };
  if (method === 'POST' && path === '/api/runs') return { ok: true, runId: '261023-100001-review-x' };
  return { ok: true, projects: [], pipelines: [], routes: [] };
});
const { checklistAction, createProfile, reviewBranch, setupWorktree } = await import('./project-actions.js');
const toasts = () => dom.document.querySelector('#toasts').textContent;

test('createProfile: posts the name, then reloads the state and the pipelines; a refusal stops there', async () => {
  assert.equal(await createProfile('notes'), true);
  const after1 = calls.map(c => `${c.method} ${c.path}`);
  assert.deepEqual(calls.find(c => c.path === '/api/project/profile-init').body, { project: 'notes' });
  assert.ok(after1.includes('GET /api/state'), 'the state again: the project is a code project now');
  assert.ok(after1.includes('GET /api/pipelines?project=notes'), 'and its pipelines, fresh');
  assert.match(toasts(), /Created\./);
  refuse = true;
  const n = calls.length;
  assert.equal(await createProfile('notes'), false);
  assert.deepEqual(calls.slice(n).map(c => c.path), ['/api/project/profile-init'], 'nothing else after a refusal');
  assert.match(toasts(), /A profile exists\./);
  refuse = false;
});

test('setupWorktree opens the setup run; the checklist link goes to Projects', async () => {
  await setupWorktree('example');
  assert.equal(dom.location.hash, '#run/261023-100000-setup-worktree');
  checklistAction('example', { kind: 'link' });
  assert.equal(dom.location.hash, '#projects');
  checklistAction('example', null);
  checklistAction('example', { kind: 'unknown' });
  assert.equal(dom.location.hash, '#projects', 'an action it does not know does nothing');
});

test('reviewBranch asks first: Cancel starts nothing, OK starts a read-only Review of that branch', async () => {
  const lastDialog = () => dom.document.body.querySelectorAll('dialog.confirm').pop();
  let done = reviewBranch('example', 'app/1022-cents');
  await settle();
  assert.match(lastDialog().textContent, /Review app\/1022-cents\?/);
  dom.click(lastDialog().querySelector('.btn.ghost'));
  await done;
  assert.ok(!calls.some(c => c.path === '/api/runs'), 'Cancel: nothing started');
  done = reviewBranch('example', 'app/1022-cents');
  await settle();
  dom.click(lastDialog().querySelector('.btn.primary'));
  await done;
  assert.deepEqual(calls.find(c => c.path === '/api/runs').body, { project: 'example', pipeline: 'review', values: { target: 'app', branch: 'app/1022-cents' } });
  assert.equal(dom.location.hash, '#run/261023-100001-review-x');
});
