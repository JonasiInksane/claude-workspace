// Tests for routes/findings.mjs: the board, the import (propose, then apply by hash), status
// clicks, reconcile and "Make finding" from a review or architecture run. Handlers are called
// directly on a temporary hub with the synthetic "example" project (test/fixtures/routes/hub.mjs)
// and the synthetic audit in test/fixtures/findings/audit.md. Nothing outside os.tmpdir() changes.
// Run: node --test tools/workspace-app/routes/findings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ID_PATTERN } from '../findings/import.mjs';
import { createRun, writeInput } from '../runs/store.mjs';
import { tempDir, writeFiles } from '../test/helpers.mjs';
import { call, routeHub } from '../test/fixtures/routes/hub.mjs';
import { routes } from './findings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT = readFileSync(join(here, '..', 'test', 'fixtures', 'findings', 'audit.md'), 'utf8');

// A hub whose profile points at a copy of the synthetic audit.
async function auditHub(t, more = {}) {
  const dir = tempDir('ws-rt-audit-', t);
  writeFiles(dir, { 'audit.md': AUDIT });
  return routeHub(t, { profile: { findings: { audit: join(dir, 'audit.md'), idPattern: DEFAULT_ID_PATTERN } }, ...more });
}

const board = async api => (await call(api, 'GET /api/findings', { query: { project: 'example' } })).body;

test('GET /api/findings answers with an empty board before the first import', async t => {
  const h = await auditHub(t);
  const r = await call(routes(h.ctx), 'GET /api/findings', { query: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  for (const key of ['doc', 'columns', 'phases', 'nextUp', 'importPending', 'boss']) assert.ok(key in r.body, `missing ${key}`);
  assert.deepEqual(r.body.doc.findings, []);
  assert.deepEqual(r.body.columns.map(c => [c.id, c.count]), [['open', 0], ['in-run', 0], ['on-branch', 0], ['done', 0]]);
  assert.deepEqual([r.body.phases, r.body.nextUp, r.body.importPending], [[], null, null]);
  assert.equal(typeof r.body.boss.text, 'string');
  assert.equal((await call(routes(h.ctx), 'GET /api/findings', { query: { project: 'no way' } })).status, 400);
  assert.equal((await call(routes(h.ctx), 'GET /api/findings', { query: { project: 'ghost' } })).status, 404);
});

test('POST /api/findings/import keeps a proposal; apply needs its hash (409 otherwise) and then fills the board', async t => {
  const h = await auditHub(t);
  const api = routes(h.ctx);
  const r = await call(api, 'POST /api/findings/import', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  const { proposal } = r.body;
  assert.ok(proposal.rows.length > 5, `${proposal.rows.length} rows`);
  assert.match(proposal.hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(proposal.rows.some(x => x.id === 'X1' && x.severity === 'critical'));
  assert.deepEqual((await board(api)).doc.findings, [], 'nothing is written before Apply');
  const pending = (await board(api)).importPending;
  assert.equal(pending.hash, proposal.hash);
  assert.equal(pending.proposal.rows.length, proposal.rows.length);

  const apply = body => call(api, 'POST /api/findings/import/apply', { body: { project: 'example', ...body } });
  const stale = await apply({ hash: `sha256:${'0'.repeat(64)}` });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you looked at it/);
  for (const body of [{}, { hash: 'x' }, { hash: proposal.hash, accept: 'some' }, { hash: proposal.hash, accept: ['../x'] }, { hash: proposal.hash, overrides: ['X1'] }, { hash: proposal.hash, overrides: { X1: 5 } }]) {
    assert.equal((await apply(body)).status, 400, JSON.stringify(body));
  }
  const ok = await apply({ hash: proposal.hash, accept: 'all' });
  assert.equal(ok.status, 200, ok.body.error);
  assert.equal(ok.body.message, `Applied ${proposal.rows.length} of ${proposal.rows.length} findings.`);
  assert.equal((await apply({ hash: proposal.hash })).status, 409, 'the proposal was used up');

  const b = await board(api);
  assert.equal(b.doc.findings.length, proposal.rows.length);
  assert.equal(b.importPending, null);
  assert.equal(b.nextUp.severity, 'critical');
  assert.ok(b.columns.reduce((n, c) => n + c.count, 0) > 0);
});

test('POST /api/findings/import: 400 without a readable audit, 404 without the checkout or project', async t => {
  const h = await routeHub(t, { profile: { findings: { audit: 'C:\\example-missing\\audit.md', idPattern: DEFAULT_ID_PATTERN } } });
  const r = await call(routes(h.ctx), 'POST /api/findings/import', { body: { project: 'example' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Could not read the audit file/);
  assert.equal((await call(routes(h.ctx), 'POST /api/findings/import', { body: { project: 'ghost' } })).status, 404);
  const away = await routeHub(t, { present: false });
  assert.equal((await call(routes(away.ctx), 'POST /api/findings/import', { body: { project: 'example' } })).status, 404);
  const bare = await routeHub(t, { profile: null });
  assert.equal((await call(routes(bare.ctx), 'POST /api/findings/import', { body: { project: 'example' } })).status, 400);
});

test('POST /api/findings/status follows the transition table: dismiss needs a reason, done never comes from a click', async t => {
  const h = await auditHub(t);
  const api = routes(h.ctx);
  const { proposal } = (await call(api, 'POST /api/findings/import', { body: { project: 'example' } })).body;
  await call(api, 'POST /api/findings/import/apply', { body: { project: 'example', hash: proposal.hash } });
  const open = (await board(api)).doc.findings.find(f => f.status === 'open');
  const set = body => call(api, 'POST /api/findings/status', { body: { project: 'example', id: open.id, ...body } });

  for (const [body, status, re] of [
    [{ status: 'dismissed' }, 400, /Say why you dismiss/],
    [{ status: 'done' }, 400, /Done comes from a merged branch/],
    [{ status: 'finished' }, 400, /status must be one of/],
    [{ status: 'dismissed', reason: 'x'.repeat(301) }, 400, /at most 300 characters/],
    [{ status: 'dismissed', reason: 42 }, 400, /must be text/],
    [{ id: 'ZZ-99', status: 'dismissed', reason: 'gone' }, 404, /no finding "ZZ-99"/],
    [{ id: '../x', status: 'open' }, 400, /not a finding id/],
  ]) {
    const x = await set(body);
    assert.equal(x.status, status, `${JSON.stringify(body)}: ${x.body.error}`);
    assert.match(x.body.error, re);
  }
  const d = await set({ status: 'dismissed', reason: 'Not reachable from outside.' });
  assert.equal(d.status, 200, d.body.error);
  assert.equal(d.body.finding.status, 'dismissed');
  assert.equal(d.body.finding.history, undefined);
  const back = await set({ status: 'open' });
  assert.equal(back.status, 200, back.body.error);
  const f = (await board(api)).doc.findings.find(x => x.id === open.id);
  assert.deepEqual(f.history.slice(-2).map(x => [x.from, x.to, x.by]), [['open', 'dismissed', 'user'], ['dismissed', 'open', 'user']]);
  assert.equal((await call(api, 'POST /api/findings/status', { body: { project: 'ghost', id: open.id, status: 'open' } })).status, 404);
});

test('POST /api/findings/reconcile answers with the moves it made', async t => {
  const h = await auditHub(t);
  const r = await call(routes(h.ctx), 'POST /api/findings/reconcile', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.changes, r.body.message], [[], 'Nothing to move.']);
  assert.equal((await call(routes(h.ctx), 'POST /api/findings/reconcile', { body: { project: '' } })).status, 400);
  const away = await routeHub(t, { present: false });
  assert.equal((await call(routes(away.ctx), 'POST /api/findings/reconcile', { body: { project: 'example' } })).status, 404);
});

test('POST /api/findings/propose makes a proposed finding from a review finding or an architecture candidate, once per item', async t => {
  const h = await auditHub(t);
  const api = routes(h.ctx);
  const secret = `sk_${'live_'}${'x'.repeat(24)}`;
  const review = await createRun(h.dataDir, {
    project: 'example', pipeline: 'review', title: 'Review: uncommitted changes', status: 'waiting', waiting: { kind: 'triage', since: new Date().toISOString() }, stages: [],
    outputs: { review: { findings: [{ id: 'F1', severity: 'high', claim: `The export trusts the query string (${secret})`, path: 'apps/api/src/loans/export.mjs', line: 8, evidence: 'memberId comes from the query', suggestion: 'read it from the session' }] } },
  });
  const r = await call(api, 'POST /api/findings/propose', { body: { project: 'example', runId: review.id, ref: 'F1' } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.id, r.body.created], ['AP-1', true]);
  const again = await call(api, 'POST /api/findings/propose', { body: { project: 'example', runId: review.id, ref: 'F1' } });
  assert.deepEqual([again.body.id, again.body.created], ['AP-1', false]);
  const ap1 = (await board(api)).doc.findings.find(f => f.id === 'AP-1');
  assert.deepEqual([ap1.status, ap1.severity, ap1.area, ap1.runId, ap1.ref], ['proposed', 'high', 'apps/api/src/loans/export.mjs:8', review.id, 'F1']);
  assert.ok(!ap1.title.includes(secret), 'secrets in run output are redacted');
  assert.match(ap1.evidence, /Suggestion: read it from the session/);

  const arch = await createRun(h.dataDir, {
    project: 'example', pipeline: 'architecture', title: 'Architecture check: all lenses', status: 'waiting', waiting: { kind: 'decide', since: new Date().toISOString() }, stages: [],
    outputs: { triage: { items: [{ ref: 'C1', verdict: 'issue', reason: 'A real TODO in the money path.' }] } },
  });
  await writeInput(h.dataDir, arch, 'candidates.json', JSON.stringify([{ ref: 'C1', probe: 'todoCount', path: 'apps/api/src/billing/charge.mjs', line: 3, text: '// TODO round half up' }]));
  const c = await call(api, 'POST /api/findings/propose', { body: { project: 'example', runId: arch.id, ref: 'C1' } });
  assert.equal(c.status, 200, c.body.error);
  assert.equal(c.body.id, 'AP-2');
  const ap2 = (await board(api)).doc.findings.find(f => f.id === 'AP-2');
  assert.equal(ap2.title, 'TODO comments: apps/api/src/billing/charge.mjs:3');
  assert.match(ap2.evidence, /TODO round half up · Triage: A real TODO in the money path\./);

  const explain = await createRun(h.dataDir, { project: 'example', pipeline: 'explain', title: 'Explain: x', status: 'passed', stages: [] });
  for (const [body, status, re] of [
    [{ runId: review.id, ref: 'F9' }, 404, /has no finding F9/],
    [{ runId: arch.id, ref: 'C7' }, 404, /has no candidate C7/],
    [{ runId: review.id, ref: 'f1' }, 400, /not an item of a run/],
    [{ runId: 'Not A Run', ref: 'F1' }, 400, /not a run id/],
    [{ runId: '261022-000000-review-missing', ref: 'F1' }, 404, /has no run/],
    [{ runId: explain.id, ref: 'F1' }, 400, /Only review and architecture runs/],
    [{ project: 'ghost', runId: review.id, ref: 'F1' }, 404, /no project ghost/],
  ]) {
    const x = await call(api, 'POST /api/findings/propose', { body: { project: 'example', ...body } });
    assert.equal(x.status, status, `${JSON.stringify(body)}: ${x.body.error}`);
    assert.match(x.body.error, re);
  }
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
