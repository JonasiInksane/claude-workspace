// Tests for routes/checks.mjs: the Check my work preview and start, the check history, and the
// baseline routes (show, accept, recompute). Handlers are called directly on a temporary hub with
// the synthetic "example" project (test/fixtures/routes/hub.mjs). The run engine is a fake that
// records start() requests, so no check runs; the preview reads git in the temporary repo only.
// Run: node --test tools/workspace-app/routes/checks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../http.mjs';
import { baselineKey, candidateFrom, loadBaseline, saveBaseline, writeCandidate } from '../gates/baseline.mjs';
import { appendHistory } from '../gates/history.mjs';
import { writeFiles } from '../test/helpers.mjs';
import { busy409, call, quietDeps, routeHub } from '../test/fixtures/routes/hub.mjs';
import { routes } from './checks.mjs';

const preview = (api, body) => call(api, 'POST /api/checks', { body: { project: 'example', preview: true, ...body } });
const ids = r => r.body.commands.map(c => c.id);

test('POST /api/checks preview plans the level\'s commands for the change, in the main checkout while the run worktree is not set up', async t => {
  const h = await routeHub(t);
  writeFiles(h.mainDir, { 'apps/api/src/billing/charge.mjs': 'export const charge = cents => Math.round(cents * 1.21) + 0;\n' });
  const api = routes(h.ctx, quietDeps);

  const quick = await preview(api, {});
  assert.equal(quick.status, 200, quick.body.error);
  assert.equal(quick.body.preview, true);
  assert.deepEqual([quick.body.treeMode, quick.body.refusal, quick.body.busy, quick.body.what, quick.body.level], ['main', '', '', 'uncommitted', 'quick']);
  assert.equal(quick.body.tree, h.mainDir);
  assert.equal(quick.body.changed, 1);
  assert.match(quick.body.base.sha, /^[0-9a-f]{40}$/);
  assert.ok(quick.body.notes.some(n => /every failure counts as new/.test(n)));
  assert.deepEqual(ids(quick), ['g0', 'types:api', 'test:api']);
  const focused = quick.body.commands.find(c => c.id === 'test:api');
  assert.deepEqual([focused.group, focused.files, focused.folders], ['G2', 0, 1]);
  assert.match(focused.command, /the tests next to the changed files/);

  const standard = await preview(api, { level: 'standard' });
  assert.deepEqual(ids(standard), ['g0', 'types:api', 'test:api']);
  const full = standard.body.commands.find(c => c.id === 'test:api');
  assert.deepEqual([full.group, full.files], ['G3', null]);
  assert.match(full.command, /\(all matching files\)/);

  const paranoid = await preview(api, { level: 'paranoid' });
  const it = paranoid.body.commands.find(c => c.id === 'integration:api');
  assert.match(it.skipReason, /start the reliability containers yourself/);

  const everything = await preview(api, { what: 'everything', level: 'quick' });
  assert.deepEqual(ids(everything), ['g0', 'types:api', 'types:web', 'test:root', 'test:api', 'lint:web', 'test:web']);
  assert.equal(everything.body.changed, 0);
});

test('POST /api/checks preview of a branch sees its commits; a missing integration branch is a refusal', async t => {
  const h = await routeHub(t);
  await h.git(['switch', '-q', '-c', 'work']);
  writeFiles(h.mainDir, { 'apps/web/src/features/cart/total.mjs': 'export const total = items => items.reduce((s, i) => s + i, 0) || 0;\n' });
  await h.git(['commit', '-q', '-am', 'web change']);
  const api = routes(h.ctx, quietDeps);
  const r = await preview(api, { what: 'branch' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.refusal, '');
  assert.equal(r.body.base.sha, (await h.git(['rev-parse', 'main'])).trim());
  assert.deepEqual(ids(r), ['g0', 'types:web', 'lint:web', 'test:web']);

  const other = await routeHub(t, { profile: { git: { integrationBranch: 'trunk' } } });
  const x = await preview(routes(other.ctx, quietDeps), { what: 'branch' });
  assert.equal(x.status, 200, x.body.error);
  assert.match(x.body.refusal, /trunk has no commit in common with HEAD/);
  assert.deepEqual(x.body.commands, []);
});

test('POST /api/checks preview refuses the main checkout when it has a .env and the guard is not on the base commit (R10)', async t => {
  const guarded = await routeHub(t);
  writeFiles(guarded.mainDir, { '.env': 'EXAMPLE_TEST_MODE=false\n' });
  const ok = await preview(routes(guarded.ctx, quietDeps), {});
  assert.equal(ok.body.refusal, '');

  const h = await routeHub(t, { profile: { mainCheckoutGuard: { pattern: 'NOT_IN_THE_FILE' } } });
  writeFiles(h.mainDir, { '.env': 'EXAMPLE_TEST_MODE=false\n' });
  const r = await preview(routes(h.ctx, quietDeps), {});
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.treeMode, 'main');
  assert.equal(r.body.refusal, 'Checks would load your real .env. Add the env guard first, or set up the run worktree.');

  const none = await routeHub(t, { profile: null });
  const p = await preview(routes(none.ctx, quietDeps), {});
  assert.match(p.body.refusal, /has no profile yet/);
});

test('POST /api/checks starts a check run in the engine; its 400 and 409 come through; bad values are 400 and unknown projects 404', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/checks', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.runId, /-check-1$/);
  assert.deepEqual(h.engine.starts, [{ project: 'example', pipeline: 'check', values: { what: 'uncommitted', level: 'quick' } }]);
  await call(api, 'POST /api/checks', { body: { project: 'example', what: 'branch', level: 'paranoid' } });
  assert.deepEqual(h.engine.starts[1].values, { what: 'branch', level: 'paranoid' });

  h.engine.fail = busy409();
  assert.equal((await call(api, 'POST /api/checks', { body: { project: 'example' } })).status, 409);
  h.engine.fail = new HttpError(400, 'Checks would load your real .env.');
  const refused = await call(api, 'POST /api/checks', { body: { project: 'example' } });
  assert.deepEqual([refused.status, refused.body.error], [400, 'Checks would load your real .env.']);
  h.engine.fail = null;

  for (const [body, status, re] of [
    [{ project: 'example', what: 'all' }, 400, /what must be one of uncommitted, branch, everything/],
    [{ project: 'example', level: 'max' }, 400, /level must be one of quick, standard, paranoid/],
    [{ project: 'Example!' }, 400, /not a project name/],
    [{ project: 'ghost' }, 404, /no project ghost/],
  ]) {
    const x = await call(api, 'POST /api/checks', { body });
    assert.equal(x.status, status, `${JSON.stringify(body)}: ${x.body.error}`);
    assert.match(x.body.error, re);
  }
  const away = await routeHub(t, { present: false });
  assert.equal((await call(routes(away.ctx, quietDeps), 'POST /api/checks', { body: { project: 'example' } })).status, 404);
  assert.equal(h.engine.starts.length, 4);
});

test('GET /api/checks answers with the last result per level and the history, newest first', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const empty = await call(api, 'GET /api/checks', { query: { project: 'example' } });
  assert.deepEqual(empty.body, { ok: true, last: { quick: null, standard: null, paranoid: null }, history: [] });
  const line = (level, chip, at) => ({ at, runId: `261022-10000${at.slice(-2, -1)}-check`, level, treeMode: 'run', baseSha: 'a'.repeat(40), node: '20.15.1', result: 'pass', chip, durationMs: 1000, counts: { new: 0, known: 2, flaky: 0 } });
  await appendHistory(h.dataDir, 'example', line('quick', 'q1', '2026-10-22T09:00:01Z'));
  await appendHistory(h.dataDir, 'example', line('standard', 's1', '2026-10-22T09:00:02Z'));
  await appendHistory(h.dataDir, 'example', line('quick', 'q2', '2026-10-22T09:00:03Z'));
  const r = await call(api, 'GET /api/checks', { query: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.last.quick.chip, r.body.last.standard.chip, r.body.last.paranoid], ['q2', 's1', null]);
  assert.deepEqual(r.body.history.map(x => x.chip), ['q2', 's1', 'q1']);
  assert.equal((await call(api, 'GET /api/checks', { query: { project: '..' } })).status, 400);
  assert.equal((await call(api, 'GET /api/checks', { query: { project: 'ghost' } })).status, 404);
});

test('GET /api/baseline and POST /api/baseline/accept: the candidate is accepted only with the hash you saw (R15)', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const none = await call(api, 'GET /api/baseline', { query: { project: 'example' } });
  assert.equal(none.status, 404);
  assert.match(none.body.error, /no baseline yet/);

  const baseSha = 'ab'.repeat(20);
  const key = baselineKey({ baseSha, treeMode: 'run', node: '20.15.1' });
  const failing = ['src/a.test.mjs::a', 'src/b.test.mjs::b', 'src/c.test.mjs::c'];
  await saveBaseline(h.dataDir, 'example', key, {
    baseSha, treeMode: 'run', node: '20.15.1',
    commands: { 'test:api': { kind: 'test', status: 'fail', exitCode: 1, counts: { pass: 5, fail: 3, skip: 0, todo: 0 }, failures: failing.map(id => ({ id, kind: 'assertion' })) } },
  });
  const baseline = await loadBaseline(h.dataDir, 'example', key);
  const current = { baseSha, commands: { 'test:api': { kind: 'test', status: 'fail', exitCode: 1, failures: [{ id: failing[0], kind: 'assertion' }], passed: failing.slice(1) } } };
  await writeCandidate(h.dataDir, 'example', key, candidateFrom(baseline, current));

  const r = await call(api, 'GET /api/baseline', { query: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.key, key);
  assert.equal(r.body.baseline.known, 3);
  assert.deepEqual([r.body.candidate.from, r.body.candidate.to], [3, 1]);
  assert.deepEqual(r.body.diff, { leaving: failing.slice(1), entering: [] });
  assert.equal(r.body.candidate.commands, undefined);
  assert.match(r.body.candidate.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.body.keys.map(k => [k.key, k.hasCandidate]), [[key, true]]);
  assert.equal((await call(api, 'GET /api/baseline', { query: { project: 'example', key } })).body.key, key);
  assert.equal((await call(api, 'GET /api/baseline', { query: { project: 'example', key: '../x' } })).status, 400);
  assert.equal((await call(api, 'GET /api/baseline', { query: { project: 'example', key: `${'0'.repeat(12)}-run-node20.15.1` } })).status, 404);

  const accept = body => call(api, 'POST /api/baseline/accept', { body: { project: 'example', key, ...body } });
  const stale = await accept({ hash: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you looked at it/);
  assert.equal((await accept({ hash: 'nope' })).status, 400);
  assert.equal((await accept({ key: 'bad', hash: r.body.candidate.hash })).status, 400);
  const ok = await accept({ hash: r.body.candidate.hash });
  assert.equal(ok.status, 200, ok.body.error);
  assert.equal(ok.body.known, 1);
  assert.match(ok.body.message, /now has 1 known failure \(was 3; 2 left\)/);
  const after = JSON.parse(readFileSync(join(h.dataDir, 'baselines', 'example', `${key}.json`), 'utf8'));
  assert.equal(after.source, 'accepted');
  const again = await accept({ hash: r.body.candidate.hash });
  assert.equal(again.status, 404);
  assert.equal((await call(api, 'POST /api/baseline/accept', { body: { project: 'ghost', key, hash: r.body.candidate.hash } })).status, 404);
});

test('POST /api/baseline/recompute starts a check of everything; the engine\'s 409 comes through', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx, quietDeps);
  const r = await call(api, 'POST /api/baseline/recompute', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.ok(r.body.runId);
  assert.deepEqual(h.engine.starts, [{ project: 'example', pipeline: 'check', values: { what: 'everything', level: 'standard' } }]);
  await call(api, 'POST /api/baseline/recompute', { body: { project: 'example', level: 'paranoid' } });
  assert.equal(h.engine.starts[1].values.level, 'paranoid');
  h.engine.fail = busy409();
  assert.equal((await call(api, 'POST /api/baseline/recompute', { body: { project: 'example' } })).status, 409);
  assert.equal((await call(api, 'POST /api/baseline/recompute', { body: { project: 'example', level: 'deep' } })).status, 400);
  assert.equal((await call(api, 'POST /api/baseline/recompute', { body: { project: 'ghost' } })).status, 404);
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
