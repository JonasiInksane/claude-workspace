// Tests for routes/cockpit.mjs: GET /api/project and the cockpit's buttons (run-tg, archive-branch,
// profile-init, worktree-setup, isolation). Handlers are called directly on a temporary hub with
// the synthetic "example" project (test/fixtures/routes/hub.mjs); the run engine, the terminal,
// the port probe and the trust lookup are fakes, so nothing starts and no real repo is touched.
// Run: node --test tools/workspace-app/routes/cockpit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { selfRecord } from '../core/proc.mjs';
import { acquire } from '../runs/locks.mjs';
import { createRun } from '../runs/store.mjs';
import { writeFiles } from '../test/helpers.mjs';
import { busy409, call, quietDeps, routeHub } from '../test/fixtures/routes/hub.mjs';
import { NOT_COVERED, profileProblem, projectOrThrow, routes } from './cockpit.mjs';

const NODE_ROW = { id: 'say-hi', label: 'Say hi', cwd: 'apps/web', argv: ['{node}', '-e', 'console.log(1)'], env: { EXAMPLE_FLAG: 'on' }, warn: 'Prints a line.' };
const PKG_ROW = { id: 'missing-tool', label: 'Missing tool', cwd: '.', argv: ['{node}', '{pkg:nothing-here/cli.js}'], warn: 'Needs a package.' };
const runTg = [NODE_ROW, PKG_ROW];

test('GET /api/project answers with every part of the cockpit for a linked project with a profile', async t => {
  const h = await routeHub(t, { profile: { runTg } });
  await h.git(['branch', 'app/1022-cart-total']);
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'GET /api/project', { query: { name: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  const b = r.body;
  for (const key of ['project', 'profile', 'git', 'isolation', 'trust', 'node', 'lock', 'warnings', 'checklist', 'checks', 'baseline', 'runTg', 'notCovered']) {
    assert.ok(key in b, `missing ${key}`);
  }
  assert.deepEqual([b.project.name, b.project.label, b.project.present, b.project.linked], ['example', 'Example', true, false]);
  assert.equal(b.project.realPath, h.mainDir);
  assert.equal(b.profile.exists, true);
  assert.equal(b.profile.valid, true, b.profile.errors.join('; '));
  assert.equal(b.git.branch, 'main');
  assert.equal(b.git.changed, 0);
  assert.deepEqual(b.git.stashes, { total: 0, onBranch: 0 });
  assert.deepEqual(b.git.appBranches.map(x => [x.name, x.merged]), [['app/1022-cart-total', true]]);
  assert.ok(Array.isArray(b.git.worktrees) && b.git.worktrees.length === 1);
  assert.equal(b.isolation.mode, 'worktree');
  assert.equal(b.isolation.source, 'profile');
  assert.notEqual(b.isolation.worktree.state, 'ready');
  assert.deepEqual(b.trust.state, 'trusted');
  assert.equal(b.node.active, process.versions.node);
  assert.equal(b.node.pin, '20.15.1');
  assert.equal(b.lock.held, false);
  assert.deepEqual(b.checks, { quick: null, standard: null, paranoid: null });
  assert.deepEqual(b.baseline, { key: null, known: null, candidate: null, count: 0 });
  assert.deepEqual(b.notCovered, NOT_COVERED);

  const byId = Object.fromEntries(b.checklist.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(byId), ['linked', 'profile', 'worktree', 'trusted']);
  assert.equal(byId.linked.ok, true, byId.linked.text);
  assert.match(byId.linked.text, /origin matches projects\/repos\.json/);
  assert.equal(byId.profile.ok, true);
  assert.equal(byId.worktree.ok, false);
  assert.deepEqual(byId.worktree.alt, { kind: 'isolation', mode: 'branch', label: 'Use branch mode' });
  assert.equal(byId.trusted.ok, true);

  assert.deepEqual(b.runTg.map(x => [x.id, x.label, x.warn]), runTg.map(x => [x.id, x.label, x.warn]));
  assert.equal(b.runTg[0].disabledReason, '');
  assert.match(b.runTg[1].disabledReason, /nothing-here\/cli\.js is not installed/);
  assert.ok(b.warnings.every(w => typeof w.id === 'string' && typeof w.text === 'string'));
  // Profile drift (SPEC 2.4.2) against the checkout: only the missing {pkg:...} target differs.
  assert.deepEqual(b.warnings.map(w => w.id), ['drift.pkg:nothing-here/cli.js']);
  // The launcher's path suggestions (SPEC 5.5): folders under each workspace's src/ and features.
  for (const path of ['apps/api/src/billing', 'apps/api/src/routes', 'apps/web/src/features', 'apps/web/src/features/cart']) {
    assert.ok(b.paths.includes(path), `${path} in ${b.paths.join(', ')}`);
  }
});

test('GET /api/project shows unmerged app branches, a waiting run that holds the lock, local services and an untrusted folder', async t => {
  const h = await routeHub(t);
  await h.git(['switch', '-q', '-c', 'app/1022-loose-end']);
  writeFiles(h.mainDir, { 'notes.md': 'loose\n' });
  await h.git(['add', '-A']);
  await h.git(['commit', '-q', '-m', 'loose end']);
  await h.git(['switch', '-q', 'main']);
  const run = await createRun(h.dataDir, {
    project: 'example', pipeline: 'refactor', title: 'Refactor: the cart total', status: 'waiting',
    waiting: { kind: 'plan', since: new Date(Date.now() - 3 * 86400000).toISOString() }, stages: [{ id: 'plan', kind: 'human', status: 'waiting' }],
  });
  const lock = await acquire(h.dataDir, 'example', { runId: run.id, holder: selfRecord() });
  assert.equal(lock.ok, true, lock.reason);
  const api = routes(h.ctx, {
    ports: { anyListening: async ports => ports.filter(p => p === 5432) },
    trustState: async path => ({ state: 'not-trusted', command: `cd '${path}'; claude` }),
  });
  const { status, body } = await call(api, 'GET /api/project', { query: { name: 'example' } });
  assert.equal(status, 200, body.error);
  assert.deepEqual([body.lock.held, body.lock.runId, body.lock.title, body.lock.status, body.lock.waiting], [true, run.id, 'Refactor: the cart total', 'waiting', 'plan']);
  const ids = body.warnings.map(w => w.id);
  for (const id of ['branches.unmerged', 'lock.waiting', 'services.running']) assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`);
  assert.match(body.warnings.find(w => w.id === 'lock.waiting').text, /has waited 3 days at the plan gate/);
  assert.match(body.warnings.find(w => w.id === 'services.running').text, /port 5432\./);
  const trusted = body.checklist.find(c => c.id === 'trusted');
  assert.equal(trusted.ok, false);
  assert.equal(trusted.action.kind, 'copy');
  assert.match(trusted.action.text, /; claude$/);
});

test('GET /api/project: 400 for a bad name, 404 for an unknown project, and a not-linked project shows the Link step', async t => {
  const h = await routeHub(t, { present: false });
  const api = routes(h.ctx, quietDeps);
  for (const name of ['', 'Bad Name', '../x', 'a'.repeat(65), 'EXAMPLE']) {
    const r = await call(api, 'GET /api/project', { query: { name } });
    assert.equal(r.status, 400, `${name}: ${r.body.error}`);
  }
  assert.equal((await call(api, 'GET /api/project', {})).status, 400);
  const ghost = await call(api, 'GET /api/project', { query: { name: 'ghost' } });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /no project ghost/);

  const r = await call(api, 'GET /api/project', { query: { name: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.project.present, r.body.project.realPath, r.body.git, r.body.isolation.worktree], [false, null, null, null]);
  const linked = r.body.checklist.find(c => c.id === 'linked');
  assert.equal(linked.ok, false);
  assert.deepEqual(linked.action, { kind: 'link', label: 'Link existing checkout', href: '#projects' });
  assert.match(r.body.runTg[0].disabledReason, /Link the checkout first/);
  // A project that needs its checkout is 404 until it is linked.
  assert.throws(() => projectOrThrow(h.ctx, 'example', { present: true }), e => e.status === 404 && /Link your existing checkout/.test(e.message));
});

test('GET /api/project without a profile offers Create from the example', async t => {
  const h = await routeHub(t, { profile: null });
  const r = await call(routes(h.ctx, quietDeps), 'GET /api/project', { query: { name: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.profile.exists, false);
  const step = r.body.checklist.find(c => c.id === 'profile');
  assert.equal(step.ok, false);
  assert.equal(step.action.kind, 'profile-init');
  assert.deepEqual(r.body.runTg, []);
});

test('POST /api/project/run-tg starts the row in a terminal tab with the profile warn text; refusals are 400 or 404', { skip: process.platform !== 'win32' && 'terminal programs are Windows .exe paths' }, async t => {
  const h = await routeHub(t, { profile: { runTg } });
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/project/run-tg', { body: { project: 'example', id: 'say-hi' } });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.message, /Started Say hi in a terminal tab\. Prints a line\./);
  assert.equal(r.body.warn, 'Prints a line.');
  assert.equal(h.calls.length, 1);
  const c = h.calls[0];
  assert.deepEqual([c.name, c.dir, c.program, c.args, c.env], ['runInTerminal', join(h.mainDir, 'apps', 'web'), process.execPath, ['-e', 'console.log(1)'], { EXAMPLE_FLAG: 'on' }]);
  assert.equal(c.title, 'Example: Say hi');

  for (const [body, status, re] of [
    [{ project: 'example', id: 'Bad Id' }, 400, /not a Run entry id/],
    [{ project: 'example' }, 400, /not a Run entry id/],
    [{ project: 'example', id: 'nope' }, 404, /no Run entry "nope"/],
    [{ project: 'example', id: 'missing-tool' }, 400, /Missing tool can't start: nothing-here\/cli\.js is not installed/],
    [{ project: 'ghost', id: 'say-hi' }, 404, /no project ghost/],
    [{ project: '../example', id: 'say-hi' }, 400, /not a project name/],
  ]) {
    const x = await call(api, 'POST /api/project/run-tg', { body });
    assert.equal(x.status, status, `${JSON.stringify(body)}: ${x.body.error}`);
    assert.match(x.body.error, re);
  }
  assert.equal(h.calls.length, 1);
});

test('POST /api/project/run-tg needs a valid profile', async t => {
  const h = await routeHub(t, { profile: null });
  const r = await call(routes(h.ctx, quietDeps), 'POST /api/project/run-tg', { body: { project: 'example', id: 'dev-web' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /has no profile yet\. Create one from the example on the project's Settings tab\./, 'the hint names the tab that has the button');
});

test('profileProblem: a missing or broken profile says where to fix it; a valid one says nothing', () => {
  assert.equal(profileProblem({ exists: true, valid: true, errors: [] }, 'example'), '');
  assert.match(profileProblem({ exists: false }, 'example'), /^example has no profile yet\. .*Settings tab/);
  assert.equal(profileProblem({ exists: true, valid: false, errors: ['checks.quick is missing'] }, 'example'),
    'The profile for example has 1 problem; fix it first (the project\'s Settings tab lists it). First: checks.quick is missing');
  assert.match(profileProblem({ exists: true, valid: false, errors: ['a', 'b'] }, 'example'), /has 2 problems; fix them first \(the project's Settings tab lists them\)\. First: a$/);
  assert.doesNotMatch(profileProblem({ exists: false }, 'example'), /cockpit/, 'no screen of that name any more');
});

test('POST /api/project/archive-branch renames app/<x> to archive/app/<x> and refuses everything else', async t => {
  const h = await routeHub(t);
  await h.git(['branch', 'app/1022-cart-total']);
  await h.git(['branch', 'app/1022-busy']);
  await createRun(h.dataDir, { project: 'example', pipeline: 'refactor', title: 'Refactor: busy', status: 'waiting', waiting: { kind: 'review', since: new Date().toISOString() }, branch: 'app/1022-busy', stages: [] });
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/project/archive-branch', { body: { project: 'example', branch: 'app/1022-cart-total' } });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.message, /Archived app\/1022-cart-total as archive\/app\/1022-cart-total\. Nothing was deleted\./);
  const branches = (await h.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n');
  assert.ok(branches.includes('archive/app/1022-cart-total'));
  assert.ok(!branches.includes('app/1022-cart-total'));

  for (const [body, status, re] of [
    [{ project: 'example', branch: 'main' }, 400, /only app\/ branches/],
    [{ project: 'example', branch: 'app/../main' }, 400, /only app\/ branches/],
    [{ project: 'example' }, 400, /only app\/ branches/],
    [{ project: 'example', branch: 'app/1022-gone' }, 400, /There is no branch app\/1022-gone/],
    [{ project: 'example', branch: 'app/1022-busy' }, 400, /Refactor: busy still works on app\/1022-busy/],
    [{ project: 'ghost', branch: 'app/x' }, 404, /no project ghost/],
  ]) {
    const x = await call(api, 'POST /api/project/archive-branch', { body });
    assert.equal(x.status, status, `${JSON.stringify(body)}: ${x.body.error}`);
    assert.match(x.body.error, re);
  }
});

test('POST /api/project/profile-init copies the example once; a second time is 409', async t => {
  const h = await routeHub(t, { profile: null });
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/project/profile-init', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.path, join(h.dataDir, 'profiles', 'example.json'));
  const saved = JSON.parse(readFileSync(r.body.path, 'utf8'));
  assert.equal(saved.project, 'example');
  const again = await call(api, 'POST /api/project/profile-init', { body: { project: 'example' } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /never overwrites/);
  assert.equal((await call(api, 'POST /api/project/profile-init', { body: { project: 'ghost' } })).status, 404);
  assert.equal((await call(api, 'POST /api/project/profile-init', { body: { project: 'x/../y' } })).status, 400);
  assert.ok(!existsSync(join(h.dataDir, 'profiles', 'ghost.json')));
});

test('POST /api/project/profile-init in a hub without the example profile is a 404, not a crash', async t => {
  const h = await routeHub(t, { profile: null });
  rmSync(join(h.root, 'pipelines', 'app', 'profiles', 'example.json'));
  const r = await call(routes(h.ctx, quietDeps), 'POST /api/project/profile-init', { body: { project: 'example' } });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /example profile .* could not be read/);
  assert.ok(!existsSync(join(h.dataDir, 'profiles', 'example.json')));
});

test('POST /api/project/worktree-setup starts the setup-worktree pipeline; the engine\'s 409 and the checks before it come through', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/project/worktree-setup', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.runId, /setup-worktree/);
  assert.deepEqual(h.engine.starts, [{ project: 'example', pipeline: 'setup-worktree', values: {} }]);
  h.engine.fail = busy409();
  const busy = await call(api, 'POST /api/project/worktree-setup', { body: { project: 'example' } });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /Park it or wait/);
  assert.equal((await call(api, 'POST /api/project/worktree-setup', { body: { project: 'ghost' } })).status, 404);
  assert.equal((await call(api, 'POST /api/project/worktree-setup', { body: {} })).status, 400);

  const noEngine = routes({ ...h.ctx, getEngine: undefined }, quietDeps);
  assert.equal((await call(noEngine, 'POST /api/project/worktree-setup', { body: { project: 'example' } })).status, 503);

  const bare = await routeHub(t, { profile: null });
  const x = await call(routes(bare.ctx, quietDeps), 'POST /api/project/worktree-setup', { body: { project: 'example' } });
  assert.equal(x.status, 400);
  assert.equal(bare.engine.starts.length, 0);
});

test('POST /api/project/isolation saves this PC\'s mode; GET /api/project then reports it', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/project/isolation', { body: { project: 'example', mode: 'branch' } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.mode, 'branch');
  assert.equal(JSON.parse(readFileSync(join(h.dataDir, 'settings.json'), 'utf8')).isolation.example, 'branch');
  const p = await call(api, 'GET /api/project', { query: { name: 'example' } });
  assert.deepEqual([p.body.isolation.mode, p.body.isolation.source], ['branch', 'settings']);
  assert.equal(p.body.checklist.find(c => c.id === 'worktree').ok, true);
  for (const mode of ['main', '', undefined, null]) {
    assert.equal((await call(api, 'POST /api/project/isolation', { body: { project: 'example', mode } })).status, 400);
  }
  assert.equal((await call(api, 'POST /api/project/isolation', { body: { project: 'ghost', mode: 'branch' } })).status, 404);
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
