// Tests for routes/metrics.mjs: the Health view's data (GET /api/metrics) and rebuilding the
// non-shop allowlist (POST /api/allowlist, preview then save). Scans, wins and the architecture
// run are written straight into a temporary data folder with the wave-2 modules; no probe or
// Claude runs. Hub and project: test/fixtures/routes/hub.mjs (the synthetic "example" project).
// Run: node --test tools/workspace-app/routes/metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { saveSettings } from '../core/settings.mjs';
import { appendWins, recordScan } from '../probes/metrics.mjs';
import { createRun, writeInput } from '../runs/store.mjs';
import { fakeProfile } from '../test/helpers.mjs';
import { call, routeHub } from '../test/fixtures/routes/hub.mjs';
import { routes } from './metrics.mjs';

const VALUES = {
  procedures: { value: 3, display: '3', nonShop: ['items.list'] },
  missingAssert: { value: 1, display: '1' },
  todoCount: { value: 2, display: '2' },
  publicTs: { value: 1, of: 1, display: '1 of 1' },
  deepImports: { value: 0, display: '0' },
  localeWeb: { value: 1, min: 1, max: 1, display: '1 per locale' },
};

async function scanned(t) {
  const h = await routeHub(t);
  const sha = (await h.git(['rev-parse', 'HEAD'])).trim();
  const rec = await recordScan(h.dataDir, 'example', { at: new Date().toISOString(), sha, branch: 'main', values: VALUES, errors: {}, details: {} },
    { profile: fakeProfile(), knownFailures: 4 });
  return { ...h, scanId: rec.scanId };
}

test('GET /api/metrics before the first scan: empty tiles, no score, the allowlist not set up', async t => {
  const h = await routeHub(t);
  const r = await call(routes(h.ctx), 'GET /api/metrics', { query: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  for (const key of ['latest', 'tiles', 'score', 'lenses', 'candidates', 'wins', 'achievements', 'boss', 'streak', 'weekly', 'allowlist']) {
    assert.ok(key in r.body, `missing ${key}`);
  }
  const b = r.body;
  assert.equal(b.latest, null);
  assert.deepEqual(b.tiles.map(x => x.id), ['knownFailures', 'deepImports', 'publicTs', 'todoCount', 'localeWeb']);
  assert.deepEqual(b.tiles.map(x => x.display), ['No baseline yet', 'No scan yet', 'No scan yet', 'No scan yet', 'No scan yet']);
  assert.deepEqual(b.score, { value: null, delta: 0, trend: 'same', spark: [] });
  assert.deepEqual(b.lenses.map(x => x.id), ['missingAssert', 'todoCount']);
  assert.deepEqual([b.candidates, b.wins, b.weekly], [null, [], []]);
  assert.deepEqual(b.achievements.map(a => [a.id, a.earned]), [['baseline-zero', false], ['boundary-builder', false], ['phase1-cleared', false]]);
  assert.equal(b.streak.enabled, false);
  assert.deepEqual(b.allowlist, { setUp: false, count: 0 });
  assert.equal((await call(routes(h.ctx), 'GET /api/metrics', { query: { project: 'C:\\x' } })).status, 400);
  assert.equal((await call(routes(h.ctx), 'GET /api/metrics', { query: { project: 'ghost' } })).status, 404);
});

test('GET /api/metrics after a scan: tiles, score, lenses, ratchet wins, the streak setting and the allowlist proposal', async t => {
  const h = await scanned(t);
  await appendWins(h.dataDir, 'example', [{ at: new Date().toISOString(), kind: 'ratchet', metric: 'todoCount', label: 'TODO comments', from: 5, to: 2, via: { kind: 'commit', sha: 'abcdef1234567' } }]);
  saveSettings(h.dataDir, { fun: { streak: true } });
  const r = await call(routes(h.ctx), 'GET /api/metrics', { query: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  const b = r.body;
  assert.equal(b.latest.id, h.scanId);
  const tile = Object.fromEntries(b.tiles.map(x => [x.id, x]));
  assert.equal(tile.todoCount.value, 2);
  assert.equal(tile.knownFailures.value, null, 'no check history yet');
  assert.equal(typeof b.score.value, 'number');
  assert.equal(b.lenses.find(x => x.id === 'todoCount').now, 2);
  assert.deepEqual(b.wins.map(w => w.text), ['TODO comments 5 → 2 via abcdef1']);
  assert.equal(b.streak.enabled, true);
  assert.deepEqual(b.allowlist, { setUp: false, count: 0, proposal: { add: ['items.list'], remove: [], count: 1, scanId: h.scanId } });
});

test('GET /api/metrics lists the last architecture check\'s candidates with the triage verdicts', async t => {
  const h = await routeHub(t);
  const run = await createRun(h.dataDir, {
    project: 'example', pipeline: 'architecture', title: 'Architecture check: all lenses', status: 'waiting',
    waiting: { kind: 'decide', since: new Date().toISOString() }, stages: [],
    outputs: { scan: { scanId: 's-261022-100700', candidates: 2 }, triage: { items: [{ ref: 'C1', verdict: 'issue', reason: 'Real.', triage: { decision: 'accept', reason: '', at: 'x' } }, { ref: 'C2', verdict: 'noise', reason: 'A test helper.' }] } },
  });
  await writeInput(h.dataDir, run, 'candidates.json', JSON.stringify([
    { ref: 'C1', probe: 'todoCount', path: 'apps/api/src/billing/charge.mjs', line: 3, text: '// TODO' },
    { ref: 'C2', probe: 'missingAssert', path: 'apps/api/src/routes/items/router.mjs', line: 7, text: 'remove' },
  ]));
  const { body } = await call(routes(h.ctx), 'GET /api/metrics', { query: { project: 'example' } });
  assert.deepEqual([body.candidates.runId, body.candidates.waiting, body.candidates.scanId], [run.id, 'decide', 's-261022-100700']);
  assert.deepEqual(body.candidates.items.map(c => [c.ref, c.label, c.verdict, c.decision ? c.decision.decision : null]),
    [['C1', 'TODO comments', 'issue', 'accept'], ['C2', 'Member procedures with no ensure check', 'noise', null]]);
});

test('POST /api/allowlist previews, refuses a stale scan (409) and saves the list from the last scan', async t => {
  const h = await scanned(t);
  const api = routes(h.ctx);
  const p = await call(api, 'POST /api/allowlist', { body: { project: 'example', preview: true } });
  assert.equal(p.status, 200, p.body.error);
  assert.deepEqual([p.body.proposal.add, p.body.proposal.remove, p.body.proposal.list, p.body.proposal.scanId, p.body.proposal.setUp], [['items.list'], [], ['items.list'], h.scanId, false]);
  assert.ok(!existsSync(join(h.dataDir, 'profiles', 'example.allowlist.json')), 'a preview writes nothing');

  const stale = await call(api, 'POST /api/allowlist', { body: { project: 'example', scanId: 's-990101-000000' } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /newer scan came in/);
  assert.equal((await call(api, 'POST /api/allowlist', { body: { project: 'example', scanId: '../x' } })).status, 400);
  const saved = await call(api, 'POST /api/allowlist', { body: { project: 'example', scanId: h.scanId } });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.count, 1);
  assert.ok(existsSync(join(h.dataDir, 'profiles', 'example.allowlist.json')));
  const m = await call(api, 'GET /api/metrics', { query: { project: 'example' } });
  assert.deepEqual(m.body.allowlist, { setUp: true, count: 1 });
});

test('POST /api/allowlist: 400 before the first scan, 404 for an unknown project', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx);
  const r = await call(api, 'POST /api/allowlist', { body: { project: 'example', preview: true } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no scan yet/);
  assert.equal((await call(api, 'POST /api/allowlist', { body: { project: 'ghost', preview: true } })).status, 404);
  assert.equal((await call(api, 'POST /api/allowlist', { body: { project: 7 } })).status, 400);
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
