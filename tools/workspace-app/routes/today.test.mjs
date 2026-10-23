// Tests for routes/today.mjs: GET /api/today gathers waiting and running runs, a smaller baseline
// and a pending import, Next up, health, the inbox, recent results, Today so far and the last win;
// POST /api/today/handoff writes inbox/handoffs/<date>-<project>-day[-n].md in the (temporary)
// hub. Runs, findings and wins are written straight into a temporary data folder with the wave-2
// modules; nothing runs. Hub and project: test/fixtures/routes/hub.mjs.
// Run: node --test tools/workspace-app/routes/today.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from '../fun/fun.mjs';
import { saveFindings, savePendingImport } from '../findings/store.mjs';
import { baselineKey, candidateFrom, loadBaseline, saveBaseline, writeCandidate } from '../gates/baseline.mjs';
import { appendHistory } from '../gates/history.mjs';
import { appendWins } from '../probes/metrics.mjs';
import { createRun } from '../runs/store.mjs';
import { fakeProfile, writeFiles } from '../test/helpers.mjs';
import { call, routeHub } from '../test/fixtures/routes/hub.mjs';
import { routes } from './today.mjs';

const now = () => new Date().toISOString();

test('GET /api/today answers with every card for a quiet day', async t => {
  const h = await routeHub(t);
  writeFiles(h.dataDir, { 'profiles/other.json': fakeProfile({ project: 'other', label: 'Other' }) });
  const r = await call(routes(h.ctx), 'GET /api/today');
  assert.equal(r.status, 200, r.body.error);
  const b = r.body;
  for (const key of ['date', 'waiting', 'running', 'nextUp', 'health', 'inbox', 'recent', 'todaySoFar', 'lastWin']) assert.ok(key in b, `missing ${key}`);
  assert.equal(b.date, localDay(new Date()));
  assert.deepEqual([b.waiting, b.running, b.recent, b.nextUp, b.lastWin], [[], [], [], null, null]);
  assert.deepEqual(b.projects.map(p => [p.name, p.label, p.present, p.valid]), [['example', 'Example', true, true], ['other', 'Other', false, true]]);
  assert.deepEqual(b.health.map(x => [x.project, x.linked, x.score.value, x.knownFailures, x.node.pin]), [['example', true, null, null, '20.15.1'], ['other', false, null, null, '20.15.1']]);
  assert.deepEqual(b.inbox, { total: 0, truncated: false, groups: [] });
  assert.deepEqual([b.todaySoFar.project, b.todaySoFar.slicesCommitted, b.todaySoFar.runs, b.todaySoFar.findingsClosed], ['example', 0, 0, 0]);
  assert.match(b.todaySoFar.text, /0 slices · 0 findings closed · no checks yet/);
});

test('GET /api/today lists what waits, what runs, recent results, Next up, the inbox and the last win', async t => {
  const h = await routeHub(t);
  const stage = (id, status, extra = {}) => ({ id, kind: 'claude', status, ...extra });
  const plan = await createRun(h.dataDir, { project: 'example', pipeline: 'refactor', title: 'Refactor: cart total', status: 'waiting', waiting: { kind: 'plan', since: now() }, stages: [] });
  const review = await createRun(h.dataDir, { project: 'example', pipeline: 'fix', title: 'Fix a finding: EX-1', status: 'waiting', waiting: { kind: 'review', since: now() }, stages: [] });
  const decide = await createRun(h.dataDir, { project: 'example', pipeline: 'architecture', title: 'Architecture check: all lenses', status: 'waiting', waiting: { kind: 'decide', since: now() }, stages: [] });
  const capped = await createRun(h.dataDir, { project: 'example', pipeline: 'debug', title: 'Debug: double save', status: 'capped', stages: [] });
  const running = await createRun(h.dataDir, {
    project: 'example', pipeline: 'refactor', title: 'Refactor: money math', status: 'running', branch: null,
    isolation: { mode: 'worktree', tree: 'C:\\dev\\example-run', mainDir: h.mainDir, treeMode: 'run' },
    stages: [stage('implement', 'running', { attempts: [{ k: 1, turns: 12, maxTurns: 60 }] })],
  });
  const committed = await createRun(h.dataDir, {
    project: 'example', pipeline: 'fix', title: 'Fix a finding: EX-2', status: 'committed', branch: 'app/1022-ex-2',
    commit: { sha: 'abcdef1234567890abcdef1234567890abcdef12', branch: 'app/1022-ex-2', at: now() }, stages: [],
  });
  const check = await createRun(h.dataDir, { project: 'example', pipeline: 'check', title: 'Check my work: uncommitted changes', status: 'passed', stages: [] });
  await appendHistory(h.dataDir, 'example', { runId: check.id, level: 'quick', treeMode: 'run', baseSha: 'a'.repeat(40), node: '20.15.1', result: 'pass', chip: '0 new · 2 known', durationMs: 1000, counts: { new: 0, known: 2, flaky: 0 } });

  const baseSha = 'cd'.repeat(20);
  const key = baselineKey({ baseSha, treeMode: 'run', node: '20.15.1' });
  const ids = ['src/a.test.mjs::a', 'src/b.test.mjs::b'];
  await saveBaseline(h.dataDir, 'example', key, { baseSha, treeMode: 'run', node: '20.15.1', commands: { 'test:api': { kind: 'test', status: 'fail', exitCode: 1, failures: ids.map(id => ({ id, kind: 'assertion' })) } } });
  await writeCandidate(h.dataDir, 'example', key, candidateFrom(await loadBaseline(h.dataDir, 'example', key), { baseSha, commands: { 'test:api': { kind: 'test', status: 'fail', failures: [{ id: ids[0], kind: 'assertion' }], passed: [ids[1]] } } }));
  await savePendingImport(h.dataDir, 'example', { rows: [], hash: `sha256:${'1'.repeat(64)}`, counts: { changed: 3 } });
  await saveFindings(h.dataDir, 'example', { version: 1, project: 'example', phases: [], findings: [
    { id: 'EX-7', title: 'Loans export trusts the query', severity: 'high', phase: null, status: 'open', blast: 'small', history: [] },
  ] });
  await appendWins(h.dataDir, 'example', [{ at: now(), kind: 'ratchet', metric: 'todoCount', label: 'TODO comments', from: 4, to: 3, via: null }]);
  writeFiles(h.root, {
    'inbox/shot.png': 'x', 'inbox/notes.pdf': 'x', 'inbox/read-later.url': 'x',
    'inbox/attachments/_hub/2026-10-22/a.png': 'x', 'inbox/attachments/_hub/2026-10-22/b.png': 'x',
  });

  const { status, body } = await call(routes(h.ctx), 'GET /api/today');
  assert.equal(status, 200, body.error);
  const waiting = Object.fromEntries(body.waiting.map(w => [w.runId || w.kind, w]));
  assert.deepEqual([waiting[plan.id].badge, waiting[plan.id].action.href], ['Approve plan', `#run/${plan.id}`]);
  assert.deepEqual([waiting[review.id].badge, waiting[review.id].action.href], ['Review', `#review/${review.id}`]);
  assert.deepEqual([waiting[decide.id].badge, waiting[decide.id].action.href], ['Decide', '#project/example/architecture']);
  assert.deepEqual([waiting[capped.id].badge, waiting[capped.id].status], ['Cap reached', 'capped']);
  assert.match(waiting[plan.id].sub, /^Refactor · Example · waiting at the plan gate$/);
  assert.equal(waiting.baseline.title, 'Smaller baseline available: 2 → 1 known failures');
  assert.deepEqual([waiting.baseline.badge, waiting.baseline.action.href, waiting.baseline.key], ['Accept?', '#project/example/checks', key]);
  assert.match(waiting.import.sub, /3 changes proposed/);
  assert.equal(waiting.import.action.href, '#project/example/findings', 'an import waits on the Findings tab');
  assert.equal(body.waiting.length, 6);

  assert.equal(body.running.length, 1);
  const run = body.running[0];
  assert.deepEqual([run.runId, run.stage, run.stageLabel, run.turns, run.maxTurns, run.tree, run.badge], [running.id, 'implement', 'Implement', 12, 60, 'example-run', 'Running']);
  assert.match(run.sub, /^Implement · turns 12\/60 · \d+ min · example-run$/);

  const recent = Object.fromEntries(body.recent.map(x => [x.runId, x]));
  assert.deepEqual([recent[committed.id].badge, recent[committed.id].sub], ['Committed', 'Fix a finding · committed abcdef1 · on app/1022-ex-2']);
  assert.deepEqual([recent[check.id].badge, recent[check.id].sub], ['Passed', 'Check my work · 0 new · 2 known']);

  assert.deepEqual([body.nextUp.id, body.nextUp.project, body.nextUp.pipeline], ['EX-7', 'example', 'fix']);
  assert.equal(body.inbox.total, 5);
  assert.deepEqual(body.inbox.groups.map(g => [g.folder, g.text]).sort(), [['inbox', '1 screenshot, 1 PDF, 1 link'], ['inbox/attachments', '2 screenshots']]);
  assert.deepEqual([body.lastWin.text, body.lastWin.project], ['TODO comments 4 → 3', 'example']);
  assert.equal(body.health[0].knownFailures.value, 2);
  assert.equal(body.health[0].action.href, '#project/example/architecture');
  assert.equal(body.todaySoFar.runs, 7);
});

test('POST /api/today/handoff writes inbox/handoffs/<date>-<project>-day.md in the hub, never over an earlier one', async t => {
  const h = await routeHub(t);
  const api = routes(h.ctx);
  const date = localDay(new Date());
  const r = await call(api, 'POST /api/today/handoff', { body: { project: 'example' } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.path, `inbox/handoffs/${date}-example-day.md`);
  const text = readFileSync(join(h.root, 'inbox', 'handoffs', `${date}-example-day.md`), 'utf8');
  assert.match(text, /^# Handoff: Example, end of day/);
  for (const section of ['## Goal', '## Done', '## Decisions', '## Open', '## Next']) assert.ok(text.includes(section), section);
  const again = await call(api, 'POST /api/today/handoff', { body: { project: 'example' } });
  assert.equal(again.body.path, `inbox/handoffs/${date}-example-day-2.md`);
  assert.deepEqual(readdirSync(join(h.root, 'inbox', 'handoffs')).sort(), [`${date}-example-day-2.md`, `${date}-example-day.md`]);
  assert.ok(!existsSync(join(h.dataDir, 'inbox')), 'the note goes to the hub, nothing else is written');

  for (const [body, status] of [[{ project: '../../etc' }, 400], [{}, 400], [{ project: 'ghost' }, 404]]) {
    assert.equal((await call(api, 'POST /api/today/handoff', { body })).status, status, JSON.stringify(body));
  }
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
