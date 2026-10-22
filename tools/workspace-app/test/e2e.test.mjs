// End to end: the real app (createApp) with the real run engine (runs/wiring.mjs: manager,
// executor, store, worktree, checks, gates, Claude stage) driven over HTTP the way the page drives
// it (sign-in cookie, Origin, X-Workspace-App), with test/fake-claude.mjs as claude.
//
// One temporary workspace holds a copy of pipelines/app (the stage prompts) and the synthetic
// "example" project (a git repo matching pipelines/app/profiles/example.json); its profile and
// runs live in a temporary data folder, and its run worktree next to them. Each Claude stage gets
// its own fake output through engineOptions.claudeCommand as a function of the stage
// (runs/wiring.mjs): the structured result (--structured-file) and, for edit stages, the files
// it writes (--writes-file). Nothing here starts a real claude or touches a real repository.
//
// Covered: Explain (streams, answer.json, passed), Review (triage; Dismiss records a reason) and
// Refactor in the run worktree (preflight, scope, plan gate approved with a removed file and a
// ticked must-tick file, prove, Gate B pins, implement, a file outside the plan allowed at the
// fence gate, checks green, review, review gate, commit on app/<mmdd>-<slug> with the gated tree,
// the worktree detached again). Plus the SSE stream seeing the runs change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, runGit, tempDir, writeFiles } from './helpers.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TOKEN = 'e2e-token';
const STEP_MS = 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A temporary workspace, data folder and run worktree path, the app on a free port, signed in.
async function world(t) {
  // Short on purpose: the profile allows a run worktree path of at most 50 characters.
  const base = tempDir('w', t);
  const root = join(base, 'hub');
  const dataDir = join(base, 'data');
  const tree = join(base, 't');
  const fakeDir = join(base, 'fake');
  const main = join(root, 'projects', 'example');
  // git must never climb above the temp folder (this PC has a stray C:\.git).
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; });

  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  await makeRepo(main, { files: exampleRepoFiles() });
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({ isolation: { worktreePath: tree } }) });
  writeFiles(fakeDir, { 'none.json': {} });

  // The fake output per stage id: { structured, writes } (files under fakeDir).
  const script = new Map();
  const claudeCommand = opts => {
    const s = script.get(opts.stage) || {};
    const args = [process.execPath, FAKE, '--fixture', 'auto', '--delay-ms', '1'];
    if (s.structured) {
      const f = join(fakeDir, `${opts.stage}-${opts.attempt}.out.json`);
      writeFileSync(f, JSON.stringify(s.structured));
      args.push('--structured-file', f);
    }
    if (s.writes) {
      const f = join(fakeDir, `${opts.stage}-${opts.attempt}.writes.json`);
      writeFileSync(f, JSON.stringify(s.writes));
      args.push('--writes-file', f);
    }
    return args;
  };

  const calls = [];
  const rec = name => async args => { calls.push({ name, ...args }); return {}; };
  const actions = { tools: { wt: '', claude: '', edge: '', editor: null }, startClaude: rec('startClaude'), runTool: rec('runTool') };
  let port = 0;
  const app = createApp({
    root, token: TOKEN, actions, getPort: () => port, dataDir,
    engineOptions: { claudeCommand, timing: { tailMs: 25, tickMs: 200 } },
  });
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.destroy();
    const m = await app.getEngine();
    await m.shutdown();
    await new Promise(r => server.close(r));
  });

  const raw = (method, path, { body, cookie } = {}) => new Promise((resolveP, reject) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1', 'Content-Type': 'application/json' });
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolveP({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const signIn = await raw('GET', `/?t=${TOKEN}`);
  const cookie = signIn.headers['set-cookie'][0].split(';')[0];
  const call = (method, path, body) => raw(method, path, { body, cookie });
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    assert.equal(r.status, 200, `${method} ${path}: ${r.text.slice(0, 500)}`);
    return r.json;
  };

  // The run, polled until `until(run)` holds (or it ends somewhere else, which fails the test).
  async function waitRun(id, until, what) {
    const end = Date.now() + STEP_MS;
    let last = null;
    while (Date.now() < end) {
      last = (await ok('GET', `/api/run?id=${id}&since=0&limit=2000`));
      if (until(last.run)) return last;
      if (['failed', 'cancelled', 'gates-red', 'interrupted', 'capped', 'paused-limit'].includes(last.run.status)) break;
      await sleep(100);
    }
    const rows = last ? last.rows.slice(-12).map(r => `${r.kind}: ${r.msg}`).join('\n  ') : '';
    assert.fail(`${what}: run ${id} is ${last && last.run.status} (${last && last.run.statusReason}) at ${last && last.run.current && last.run.current.stage}\n  ${rows}`);
  }
  const waiting = kind => r => r.status === 'waiting' && r.waiting && r.waiting.kind === kind;

  // An SSE stream: collects the signals it receives.
  function openEvents() {
    return new Promise((resolveP, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }, res => {
        const got = { status: res.statusCode, text: '', signals: [] };
        res.setEncoding('utf8');
        res.on('data', d => {
          got.text += d;
          for (const m of d.matchAll(/^id: (\d+)\ndata: (.+)$/gm)) got.signals.push({ id: Number(m[1]), ...JSON.parse(m[2]) });
        });
        streams.push(res);
        resolveP(got);
      });
      req.on('error', reject);
      req.end();
    });
  }

  return { base, root, dataDir, tree, main, script, app, calls, call, ok, waitRun, waiting, openEvents };
}

const TOTAL = 'apps/web/src/features/cart/total.mjs';
const EXTRA = 'apps/web/src/features/cart/extra.mjs';
const PIN = 'apps/web/src/features/cart/total.pin.test.mjs';
const CENTS = 'apps/web/src/features/cart/cents.mjs';
const RECORD = 'docs/records/CART-CENTS.md';

test('explain, review and refactor through the real engine over HTTP, with fake-claude', { timeout: 240_000 }, async t => {
  const w = await world(t);
  const { script, ok, call, waitRun, waiting } = w;
  const events = await w.openEvents();
  assert.equal(events.status, 200);

  await t.test('explain: streams, saves answer.json, passes', async () => {
    script.set('answer', { structured: {
      answer: 'charge(cents) in apps/api/src/billing/charge.mjs adds 21% tax and rounds.',
      sources: [{ path: 'apps/api/src/billing/charge.mjs', line: 1, note: 'the function' }], openQuestions: [], suggestedNote: '',
    } });
    const pipelines = await ok('GET', '/api/pipelines?project=example');
    assert.ok(pipelines.pipelines.some(p => p.id === 'refactor' && !p.disabledReason));
    const preview = await ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'What does charge do?' }, preview: true });
    assert.match(preview.preview.prompt, /What does charge do\?/);
    const explain = await ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'What does charge do?' } });
    const r = await waitRun(explain.runId, x => x.status === 'passed', 'explain');
    assert.ok(r.rows.some(row => row.kind === 'tool'), 'tool rows stream into the timeline');
    assert.ok(r.rows.some(row => row.kind === 'status' && row.msg === 'Run passed'));
    assert.equal(r.run.stages[0].attempts[0].model, 'sonnet');
    const answer = await ok('GET', `/api/run-file?id=${explain.runId}&name=answer`);
    assert.match(JSON.parse(answer.text).answer, /adds 21% tax/);
    assert.ok(events.signals.some(s => s.run === explain.runId && s.project === 'example' && s.status === 'passed'), 'the SSE stream saw the run end');
  });

  await t.test('review: reaches triage; Dismiss needs and records a reason', async () => {
    writeFileSync(join(w.main, ...TOTAL.split('/')), 'export const total = items => items.reduce((s, i) => s + i, 0) * 1;\n');
    script.set('review', { structured: { verdict: 'fix', notProven: [], findings: [
      { severity: 'low', kind: 'issue', rule: 'style', path: TOTAL, line: 1, claim: 'The * 1 does nothing.', evidence: 'line 1', suggestion: 'Remove it.' }] } });
    const review = await ok('POST', '/api/runs', { project: 'example', pipeline: 'review', values: { target: 'uncommitted' } });
    const r = await waitRun(review.runId, waiting('triage'), 'review to triage');
    assert.equal(r.run.outputs.review.findings[0].id, 'F1');
    assert.match((await ok('GET', `/api/run-diff?id=${review.runId}&file=${encodeURIComponent(TOTAL)}`)).hunks, /\* 1/);
    const dismissNoReason = await call('POST', '/api/runs/triage', { id: review.runId, decisions: [{ ref: 'F1', decision: 'dismiss' }] });
    assert.equal(dismissNoReason.status, 400);
    await ok('POST', '/api/runs/triage', { id: review.runId, decisions: [{ ref: 'F1', decision: 'dismiss', reason: 'Fine for now' }] });
    await ok('POST', '/api/runs/done', { id: review.runId });
    await waitRun(review.runId, x => x.status === 'passed', 'review after Done');
    const saved = JSON.parse((await ok('GET', `/api/run-file?id=${review.runId}&name=review`)).text);
    assert.deepEqual([saved.findings[0].triage.decision, saved.findings[0].triage.reason], ['dismiss', 'Fine for now']);
    await runGit(w.main, ['checkout', '--', TOTAL]);
  });

  await t.test('refactor in the run worktree: plan, prove, fence, checks, review, commit on an app branch', async () => {
    const manager = await w.app.getEngine();
    const setup = await manager.start({ project: 'example', pipeline: 'setup-worktree', values: {} });
    await waitRun(setup.runId, x => x.status === 'passed', 'setup-worktree');

    script.set('scope', { structured: {
      summary: 'Move the cart total into a cents helper.',
      files: [{ path: TOTAL, why: 'the math' }, { path: EXTRA, why: 'a helper' }, { path: 'package.json', why: 'a script' }],
      risks: [], existingTests: ['apps/web/src/features/cart/total.test.mjs'],
      slices: [{ title: 'Cents', goal: 'total sums in cents', files: [TOTAL, EXTRA, 'package.json'], tests: [PIN], outOfScope: [], estLines: 10 }],
      questions: ['Keep the name total?'],
    } });
    script.set('prove', {
      structured: { tests: [{ path: PIN, name: 'total pins the sum', proves: 'the sum stays the same' }], notes: '' },
      writes: { [PIN]: [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { total } from './total.mjs';",
        '',
        "test('total pins the sum', () => {",
        '  assert.equal(total([1, 2, 3]), 6);',
        '});',
        '',
      ].join('\n') },
    });
    // CENTS is not in the plan: the fence gate stops for it.
    script.set('implement', {
      structured: { changes: [{ path: TOTAL, what: 'uses the cents helper' }, { path: CENTS, what: 'the cents helper' }, { path: RECORD, what: 'the record' }],
        recordPath: RECORD, commitMessage: 'Move cart totals into a cents helper', notProven: [] },
      writes: {
        [TOTAL]: "import { sumCents } from './cents.mjs';\n\nexport const total = items => sumCents(items);\n",
        [CENTS]: 'export const sumCents = items => items.reduce((s, i) => s + i, 0);\n',
        [RECORD]: '# CART-CENTS\n\nThe cart total uses a cents helper.\n',
      },
    });
    script.set('review', { structured: { verdict: 'ship', notProven: [], findings: [] } });

    const refactor = await ok('POST', '/api/runs', { project: 'example', pipeline: 'refactor', values: { what: 'Move cart totals into a cents helper' } });
    const id = refactor.runId;
    let r = await waitRun(id, waiting('plan'), 'refactor to the plan gate');
    assert.equal(r.run.isolation.treeMode, 'run');
    assert.equal(r.run.isolation.tree, w.tree);
    assert.match(r.run.stages[0].meta, /clean · base [0-9a-f]{7} · baseline computed/);
    assert.deepEqual(r.run.waiting.detail.mustTick, ['package.json']);
    const state = await ok('GET', '/api/state');
    assert.deepEqual([state.runs.waiting, state.projects.find(p => p.name === 'example').waiting], [1, 1]);
    const busy = await call('POST', '/api/runs', { project: 'example', pipeline: 'refactor', values: { what: 'A second refactor' } });
    assert.equal(busy.status, 409, 'one editing run per project');
    assert.match(busy.json.error, /is busy with Refactor: Move cart totals/);

    const approved = await ok('POST', '/api/runs/approve', { id, removedFiles: [EXTRA], ticked: ['package.json'], answers: [{ q: 'Keep the name total?', a: 'Yes' }] });
    assert.deepEqual(approved.run.plan.removedFiles, [EXTRA]);
    assert.deepEqual(approved.run.plan.ticked, ['package.json']);
    assert.deepEqual(approved.run.plan.files, [TOTAL, 'package.json']);
    r = await waitRun(id, waiting('fence'), 'refactor to the fence gate');
    assert.deepEqual(r.run.pins.map(p => p.path), [PIN], 'Gate B pinned the new test on the old code');
    assert.deepEqual(r.run.waiting.detail.paths, [CENTS]);
    await ok('POST', '/api/runs/allow', { id, paths: [CENTS] });

    r = await waitRun(id, waiting('review'), 'refactor to the review gate');
    assert.deepEqual(r.run.gatedTree.files, [CENTS, TOTAL, PIN, RECORD].sort());
    const reviewData = await ok('GET', `/api/run-review?id=${id}`);
    assert.equal(reviewData.verdict, 'ship');
    assert.equal(reviewData.checks.result, 'pass');
    assert.ok(reviewData.checks.checks.some(c => c.id === 'test:web' && c.status === 'pass'), 'the web tests really ran');
    assert.deepEqual(reviewData.proof.scope.allowedByUser, [CENTS]);
    assert.ok(reviewData.files.some(f => f.path === TOTAL && f.add > 0));
    assert.match((await ok('GET', `/api/run-diff?id=${id}&file=${encodeURIComponent(TOTAL)}`)).hunks, /sumCents/);
    const gate = r.run.lastGate.folder.replace(/^gates\//, '');
    assert.match((await ok('GET', `/api/run-file?id=${id}&name=log&gate=${gate}&check=test:web`)).text, /total pins the sum/);

    await ok('POST', '/api/runs/approve', { id });
    r = await waitRun(id, waiting('commit'), 'refactor to the commit gate');
    const msg = (await ok('GET', `/api/run-file?id=${id}&name=commit-msg`)).text;
    const stale = await call('POST', '/api/runs/commit', { id, message: msg, files: r.run.gatedTree.files, treeSha: 'f'.repeat(40) });
    assert.equal(stale.status, 409);
    const committed = await ok('POST', '/api/runs/commit', { id, message: msg, files: r.run.gatedTree.files, treeSha: r.run.gatedTree.treeSha });
    assert.equal(committed.run.status, 'committed', committed.message);
    const branch = committed.run.commit.branch;
    assert.match(branch, /^app\/\d{4}-[a-z0-9-]+$/);
    assert.equal(await runGit(w.main, ['rev-parse', `${branch}^{tree}`]), r.run.gatedTree.treeSha, 'the commit has the gated tree');
    assert.deepEqual((await runGit(w.main, ['show', '--name-only', '--format=', branch])).split('\n').sort(), r.run.gatedTree.files);
    assert.equal(await runGit(w.tree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'the run worktree is detached again');
    assert.equal(await runGit(w.main, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the main checkout stays on its branch');
    assert.equal(await runGit(w.main, ['status', '--porcelain']), '', 'and is untouched');
    const list = await ok('GET', '/api/runs?project=example');
    assert.deepEqual(list.runs.filter(x => x.id === id).map(x => x.status), ['committed']);
    assert.ok(!existsSync(join(w.dataDir, 'runs', 'example.lock')), 'the lock is released');
  });
});

