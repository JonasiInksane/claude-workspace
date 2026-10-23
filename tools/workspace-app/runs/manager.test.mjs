// Tests for runs/manager.mjs with fake deps and a fake clock: starting runs, the project lock
// (R20), the Claude and check slots (R20), isBusy (R21), actions, cancel, startup recovery and
// shutdown (spike A11). The real run store and lock files are used in a temporary data folder;
// the catalog, the action rules, the executor (WP11) and every process lookup are fakes, so no
// real process is started or stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPT_STATUSES, DEFAULT_LIMITS, createManager, createSlot, defaultTreeMode } from './manager.mjs';
import * as store from './store.mjs';
import * as locks from './locks.mjs';
import * as realCatalog from './catalog.mjs';
import { manifestHash, profileHash, templateHash } from './manifest.mjs';
import { loadPrompt } from './prompts.mjs';
import { matchRecord } from '../core/proc.mjs';
import { addVersion, createAsset, setArchived } from '../asset-library.mjs';
import { saveSettings, settingsDir } from '../project-settings.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));

const HOLDER = { pid: 4242, image: 'node.exe', startedAt: 1_000_000 };
const DEAD_APP = { pid: 999, image: 'node.exe', startedAt: 900_000 };
const PROFILE = { isolation: { mode: 'worktree', worktreePath: 'C:\\dev\\tg-run' } };

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-manager-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---------- fakes

// core/proc.mjs: `procs` maps a pid to { image, startedAt } while it "runs". Every lookup and
// kill is written to the shared log.
function fakeProc(log, alive = {}) {
  const procs = { [HOLDER.pid]: { image: HOLDER.image, startedAt: HOLDER.startedAt }, ...alive };
  const infoOf = pid => (p.lookupFails ? { alive: null, error: 'The process lookup failed.' }
    : procs[pid] ? { alive: true, pid, image: procs[pid].image, startedAt: procs[pid].startedAt, commandLine: '', parentPid: 1 } : { alive: false });
  const p = {
    procs, orphans: [], lookupFails: false, matchRecord,
    async procInfo(pid) { return infoOf(pid); },
    async procInfoMany(pids) { log.push(['lookup', [...pids]]); return new Map(pids.map(x => [x, infoOf(x)])); },
    async processState(rec) { const i = infoOf(rec.pid); return i.alive === null ? 'unknown' : matchRecord(rec, i) ? 'same' : 'gone'; },
    async sameProcess(rec) { return (await p.processState(rec)) === 'same'; },
    async safeKill(rec, images = ['claude.exe', 'node.exe'], { info } = {}) {
      log.push(['safeKill', rec.pid]);
      if (!images.map(s => s.toLowerCase()).includes(String(rec.image).toLowerCase())) return { killed: false, gone: false, reason: `${rec.image} is not a program the app may stop.` };
      const i = info || infoOf(rec.pid);
      if (i.alive === null) return { killed: false, gone: false, reason: `Could not check process ${rec.pid}, so it was left running: ${i.error}` };
      if (!i.alive) return { killed: false, gone: true, reason: 'ended' };
      if (!matchRecord(rec, i)) return { killed: false, gone: true, reason: `Process ${rec.pid} is now a different program.` };
      delete procs[rec.pid];
      log.push(['killed', rec.pid]);
      return { killed: true, gone: false, reason: '' };
    },
    async treeKill(pid) { log.push(['treeKill', pid]); delete procs[pid]; return { ok: true, gone: false, code: 0, message: '' }; },
    async findOrphans(opts) { log.push(['findOrphans', opts.needles]); return { orphans: p.orphans, error: '' }; },
  };
  return p;
}

const PIPELINES = [
  { id: 'explain', label: 'Explain', editing: false, requires: { profile: true, isolation: 'none' },
    fields: [{ key: 'what', kind: 'textarea', required: true }], stages: [{ id: 'answer', kind: 'claude' }], cannot: ['Edit files'], expected: 'About 2 minutes' },
  { id: 'refactor', label: 'Refactor', editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [{ key: 'what', kind: 'textarea', required: true }],
    stages: [{ id: 'preflight', kind: 'gate' }, { id: 'scope', kind: 'claude' }, { id: 'plan', kind: 'human' }], cannot: [], expected: '' },
  { id: 'check', label: 'Check my work', editing: false, requires: { profile: true, isolation: 'main-ok' },
    fields: [{ key: 'what', kind: 'select' }], stages: [{ id: 'preflight', kind: 'gate' }, { id: 'checks', kind: 'gate' }], cannot: [], expected: '' },
  { id: 'fix', label: 'Fix a finding', editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [{ key: 'finding', kind: 'finding', required: true }], stages: [{ id: 'preflight', kind: 'gate' }, { id: 'plan', kind: 'human' }], cannot: [], expected: '' },
  { id: 'feature', label: 'Feature', editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [{ key: 'what', kind: 'textarea', required: true }], stages: [{ id: 'preflight', kind: 'gate' }, { id: 'spec', kind: 'human' }], cannot: [], expected: '' },
];

// runs/catalog.mjs, reduced to what the manager calls.
const fakeCatalog = {
  PIPELINES,
  pipelineById: id => PIPELINES.find(p => p.id === id) || null,
  checkValues(def, values, ctx) {
    if (def.requires.profile && !ctx.profile) return { error: 'This project has no profile yet.', values: null };
    const out = {};
    for (const f of def.fields) {
      const v = typeof values[f.key] === 'string' ? values[f.key].trim() : '';
      if (f.required && !v) return { error: `${f.key} is required.`, values: null };
      out[f.key] = v;
    }
    return { error: '', values: out };
  },
  computeLevel: (care, risk) => ({ level: risk.tags.length ? 'paranoid' : 'standard', reasons: risk.hits.map(h => `${h.tag} path: ${h.glob}`) }),
  requestPaths: values => (values.what && values.what.startsWith('apps/') ? [values.what] : []),
  needsLock: (def, treeMode) => !!def.editing || (def.id === 'check' && treeMode === 'run'),
  runTitle: (def, values) => `${def.label}: ${values.what || values.finding || 'everything'}`,
  pipelineForUi: () => ({ stages: [{ id: 'answer' }], cannot: ['Edit files'], caps: [['Turns', '40 per stage']] }),
};

// runs/actions.mjs, reduced.
const fakeActions = {
  allowedActions(run, def, ctx) {
    const ended = ['passed', 'cancelled', 'committed'].includes(run.status);
    return [
      { action: 'approve', label: 'Approve plan', enabled: run.status === 'waiting', reason: 'Nothing is waiting for an approval.' },
      { action: 'cancel', label: 'Cancel', enabled: !ended && run.status !== 'in-terminal', reason: 'The run has ended.' },
      { action: 'retry', label: 'Retry stage', enabled: ['interrupted', 'failed'].includes(run.status) && !ctx.running,
        reason: 'Retry works when the current stage failed, was capped or was interrupted.' },
    ];
  },
};

// Executor behaviours (what advance does), all writing through the engine like WP11 does.
const save = (engine, run) => engine.store.saveRun(engine.dataDir, run);
const pass = async (run, { engine }) => {
  for (const s of run.stages) if (s.status !== 'skipped') s.status = 'done';
  run.status = 'passed';
  await save(engine, run);
};
const waitAtHuman = async (run, { engine }) => {
  const i = run.stages.findIndex(s => s.kind === 'human' && s.status !== 'done');
  if (i < 0) return pass(run, { engine });
  run.stages.slice(0, i).forEach(s => { s.status = 'done'; });
  run.stages[i].status = 'waiting';
  run.current = { ...run.current, stage: run.stages[i].id, index: i };
  run.status = 'waiting';
  run.waiting = { kind: 'plan', since: new Date(engine.clock.now()).toISOString(), detail: '' };
  await save(engine, run);
};

// A Claude stage: takes a Claude slot, "spawns" a process (a fake pid), registers it the way the
// WP11 executor does ({ kind, proc }), then runs until ctl.finish(runId) or the signal aborts.
function claudeLike(ctl) {
  return async (run, { signal, engine }) => {
    const release = await engine.slots.claude.acquire({ runId: run.id, signal }).catch(() => null);
    if (!release) return;
    ctl.active++;
    ctl.maxActive = Math.max(ctl.maxActive, ctl.active);
    const pid = ctl.nextPid++;
    const rec = { pid, image: 'claude.exe', startedAt: 7_000_000 + pid };
    ctl.proc.procs[pid] = { image: rec.image, startedAt: rec.startedAt };
    const st = run.stages.find(s => s.kind === 'claude') || run.stages[0];
    st.status = 'running';
    st.attempts = [...(st.attempts || []), { k: 1, folder: `stages/0${st.n}-${st.id}`, proc: rec }];
    run.current = { ...run.current, stage: st.id, index: st.n };
    await save(engine, run);
    const token = engine.register({ runId: run.id, project: run.project, stage: st.id, kind: 'claude', proc: rec });
    ctl.pids.set(run.id, pid);
    ctl.started.push(run.id);
    try {
      await new Promise(resolve => {
        ctl.finishers.set(run.id, resolve);
        signal.addEventListener('abort', resolve, { once: true });
        if (signal.aborted) resolve();
      });
    } finally {
      engine.unregister(token);
      release();
      ctl.active--;
    }
    if (signal.aborted) {
      if (ctl.saveAfterAbort) { run.status = 'failed'; await save(engine, run); } // dropped while closing
      return;
    }
    st.status = 'done';
    run.status = 'passed';
    await save(engine, run);
  };
}

// A check gate: marks the stage running with a gate folder whose pids.json lists one check
// process, registers the gate (no process record) and runs until the signal aborts.
function gateLike(ctl) {
  return async (run, { signal, engine }) => {
    const st = run.stages.find(s => s.id === 'checks');
    st.status = 'running';
    st.gate = 'gates/01-checks';
    const dir = join(store.runDir(engine.dataDir, run), 'gates', '01-checks');
    mkdirSync(dir, { recursive: true });
    ctl.proc.procs[6001] = { image: 'node.exe', startedAt: 600_100 };
    writeFileSync(join(dir, 'pids.json'), JSON.stringify({ version: 1, procs: [
      { checkId: 'test:web', log: 'test-web.log', pid: 6001, image: 'node.exe', startedAt: 600_100, endedAt: null },
    ] }));
    await save(engine, run);
    const token = engine.register({ runId: run.id, project: run.project, stage: 'checks', kind: 'gate' });
    ctl.started.push(run.id);
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    engine.unregister(token);
  };
}

function makeExecutor(engine, behave) {
  const log = engine.testLog;
  const ex = {
    async advance(run, opts = {}) {
      log.push(['advance', run.id]);
      const fn = behave[run.pipeline] || pass;
      return fn(run, { ...opts, engine, ex });
    },
    async handle(run, action, payload) {
      log.push(['handle', run.id, action]);
      if (behave.handle) return behave.handle(run, action, payload, { engine });
      return { message: 'Done.' };
    },
    async cancelPath(run, reason) {
      log.push(['cancelPath', run.id]);
      await null;
      for (const s of run.stages) if (s.status === 'running' || s.status === 'waiting') s.status = 'cancelled';
      if (run.lockHeld) {
        await engine.locks.release(engine.dataDir, run.project, run.id);
        run.lockHeld = false;
      }
      run.status = 'cancelled';
      run.statusReason = reason;
      run.waiting = null;
      await save(engine, run);
      return { message: 'Cancelled.' };
    },
    abort(id) { log.push(['abort', id]); },
  };
  if (behave.preview) ex.preview = behave.preview;
  return ex;
}

function setup(t, { behave = {}, limits, alive, profile = PROFILE, settings = { isolation: {} }, deps = {}, actionSettleMs } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ws-manager-'));
  const log = [];
  const proc = fakeProc(log, alive);
  const clock = { t: Date.parse('2026-10-22T10:00:00.000Z'), now() { return this.t; } };
  const findingCalls = [];
  const ctl = { proc, active: 0, maxActive: 0, nextPid: 5001, started: [], finishers: new Map(), pids: new Map(), finish: id => ctl.finishers.get(id)() };
  const mgr = createManager({
    root: dataDir, dataDir, clock, limits, actionSettleMs,
    deps: {
      store, locks, proc, catalog: fakeCatalog, actions: fakeActions, holder: HOLDER, testLog: log,
      profileFor: async () => (profile ? { exists: true, profile, errors: [], warnings: [] } : { exists: false, profile: null, errors: [], warnings: [] }),
      getSettings: async () => settings,
      riskTags: (p, paths) => (paths.some(x => x.includes('billing')) ? { tags: ['money'], hits: [{ path: paths[0], tag: 'money', glob: 'apps/api/src/billing/**' }] } : { tags: [], hits: [] }),
      trustFor: async () => true,
      findingsFor: async () => ({ findings: [{ id: 'T-1', status: 'open' }] }),
      setFindingStatus: async (...a) => { findingCalls.push(a); },
      redact: s => s.replace(/sk_live_\w+/g, 'sk_l…[redacted]'),
      createExecutor: engine => makeExecutor(engine, typeof behave === 'function' ? behave(ctl) : behave),
      ...deps,
    },
  });
  // Stop and settle first, so no late save recreates the folder after it is removed.
  t.after(async () => {
    await mgr.shutdown({ settleMs: 50 }).catch(() => {});
    await mgr.settled().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { mgr, dataDir, log, proc, clock, ctl, findingCalls };
}

const loadRun = (dataDir, id) => store.findRun(dataDir, id);
const lockOf = (dataDir, project) => {
  const f = locks.lockFile(dataDir, project);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const timeline = async (dataDir, run) => (await store.readTimeline(dataDir, run)).rows;
const status = async (promise) => { try { await promise; return 'ok'; } catch (e) { return [e.status, e.message]; } };

// ---------- construction

test('createManager needs a data folder and an executor with advance, handle and cancelPath', t => {
  const dataDir = temp(t);
  assert.throws(() => createManager({}), /needs the data folder/);
  const base = { store, locks, catalog: fakeCatalog, actions: fakeActions, holder: HOLDER };
  assert.throws(() => createManager({ dataDir, deps: base }), /needs an executor/);
  assert.throws(() => createManager({ dataDir, deps: { ...base, executor: { advance() {} } } }), /needs an executor/);
  assert.throws(() => createManager({ dataDir, deps: { ...base, catalog: { checkValues() {} } } }), /catalog has no computeLevel/);
  const ex = { advance() {}, handle() {}, cancelPath() {} };
  const mgr = createManager({ dataDir, deps: { ...base, executor: ex } });
  assert.equal(mgr.executor, ex);
  assert.deepEqual(DEFAULT_LIMITS, { claude: 2, checks: 1 });
  assert.equal(mgr.slots.claude.limit, 2);
  assert.equal(mgr.slots.checks.limit, 1, 'one check at a time (R20)');
});

test('the engine the executor gets carries the guarded store, slots, registry, lock holder and startRun', t => {
  let seen = null;
  const dataDir = temp(t);
  createManager({
    root: dataDir, dataDir,
    deps: { store, locks, catalog: fakeCatalog, actions: fakeActions, holder: HOLDER, gitBash: 'C:\\Git\\bin\\bash.exe',
      createExecutor: e => { seen = e; return { advance() {}, handle() {}, cancelPath() {} }; } },
  });
  for (const k of ['store', 'locks', 'proc', 'catalog', 'slots', 'signals', 'register', 'unregister', 'schedule', 'startRun', 'clock']) assert.ok(seen[k], k);
  assert.equal(seen.dataDir, dataDir);
  assert.equal(seen.hubRoot, dataDir);
  assert.deepEqual(seen.holder, HOLDER);
  assert.deepEqual(seen.lockHolder, HOLDER, 'the WP11 executor reads lockHolder');
  assert.equal(seen.gitBash, 'C:\\Git\\bin\\bash.exe', 'other deps pass through');
});

test('defaultTreeMode: read-only runs use main, editing runs the worktree unless in branch mode', () => {
  assert.equal(defaultTreeMode('none', 'worktree'), 'main');
  assert.equal(defaultTreeMode('tree', 'worktree'), 'run');
  assert.equal(defaultTreeMode('tree', 'branch'), 'main');
  assert.equal(defaultTreeMode('main-ok', 'worktree'), 'run');
  assert.equal(defaultTreeMode('main-ok', 'branch'), 'main');
});

// ---------- starting

test('start creates the run, schedules the executor, signals the page and is not busy afterwards', async t => {
  const { mgr, dataDir, log } = setup(t);
  const signals = [];
  mgr.signals.subscribe(s => signals.push(s));
  const { runId, run } = await mgr.start({ project: 'example', pipeline: 'explain', values: { what: '  Why is login slow  ' } });
  assert.equal(run.status, 'running');
  assert.equal(runId, '261022-100000-explain-login-slow');
  await mgr.settled();
  const done = await loadRun(dataDir, runId);
  assert.equal(done.status, 'passed');
  assert.equal(done.title, 'Explain: Why is login slow');
  assert.deepEqual(done.values, { what: 'Why is login slow' });
  assert.equal(done.lockHeld, false);
  assert.deepEqual(done.owner, HOLDER, 'the run records which app started it');
  assert.deepEqual(done.isolation, { mode: 'none', treeMode: 'main', tree: null, mainDir: null });
  assert.deepEqual(done.stages.map(s => [s.id, s.kind, s.status]), [['answer', 'claude', 'done']]);
  assert.deepEqual(log.filter(e => e[0] === 'advance'), [['advance', runId]]);
  const rows = await timeline(dataDir, done);
  assert.equal(rows[0].kind, 'status');
  assert.equal(rows[0].msg, 'Started: Explain: Why is login slow');
  assert.ok(signals.some(s => s.run === runId && s.status === 'passed'));
  assert.ok(signals.some(s => s.run === runId && s.seq === 1), 'a timeline row signals its seq');
  assert.equal(mgr.isBusy(), false);
  assert.equal(lockOf(dataDir, 'example'), null, 'a read-only run takes no lock');
});

test('start refuses bad requests with 400 and creates nothing', async t => {
  const { mgr, dataDir } = setup(t, { behave: { preview: async d => (d.pipeline === 'check' ? { refusals: ['Checks refuse the main checkout here.'] } : {}) } });
  assert.deepEqual(await status(mgr.start({ project: '../up', pipeline: 'explain', values: { what: 'x' } })), [400, '"../up" is not a project name.']);
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'deploy', values: {} })), [400, '"deploy" is not a pipeline.']);
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'explain', values: { what: '   ' } })), [400, 'what is required.']);
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'check', values: { what: 'everything' } })), [400, 'Checks refuse the main checkout here.']);
  assert.deepEqual(await store.listRuns(dataDir), []);
});

test('a project without a profile, or with a broken one, is refused with a pointer to its Settings tab', async t => {
  const { mgr } = setup(t, { profile: null });
  const [code, msg] = await status(mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'x' } }));
  assert.equal(code, 400);
  assert.match(msg, /example has no profile yet\. Create one from the example on the project's Settings tab\./);
  assert.doesNotMatch(msg, /cockpit/, 'no screen of that name any more');
  const broken = setup(t, { deps: { profileFor: async () => ({ exists: true, valid: false, profile: null, errors: ['commands.test is missing', 'x'], warnings: [] }) } });
  const [, two] = await status(broken.mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'x' } }));
  assert.equal(two, "The profile for example has 2 problems; fix them first (the project's Settings tab lists them).");
});

test('preview shows what a start would create, with value problems in `error` rather than thrown', async t => {
  const { mgr } = setup(t);
  const p = await mgr.preview({ project: 'example', pipeline: 'explain', values: { what: 'Where is the cart total computed' } });
  for (const k of ['title', 'prompt', 'stages', 'cannot', 'caps', 'where', 'level', 'levelReason', 'refusals', 'estimate', 'error', 'warnings', 'treeMode', 'lock']) assert.ok(k in p, k);
  assert.equal(p.where, 'read-only in the main checkout, no lock needed');
  assert.equal(p.estimate, 'About 2 minutes');
  assert.deepEqual(p.cannot, ['Edit files']);
  assert.equal(p.lock, false);
  const r = await mgr.preview({ project: 'example', pipeline: 'refactor', values: { what: 'apps/api/src/billing/cents.ts' } });
  assert.equal(r.where, 'the tg-run worktree');
  assert.equal(r.treeMode, 'run');
  assert.equal(r.lock, true);
  assert.equal(r.level, 'paranoid', 'risk tags from the request paths raise the level');
  assert.deepEqual(r.levelReason, ['money path: apps/api/src/billing/**']);
  const bad = await mgr.preview({ project: 'example', pipeline: 'refactor', values: {} });
  assert.equal(bad.error, 'what is required.');
});

test('check takes the lock only when it uses the run worktree', async t => {
  const { mgr, dataDir } = setup(t, { behave: { check: waitAtHuman } });
  const a = await mgr.start({ project: 'example', pipeline: 'check', values: { what: 'everything' } });
  assert.equal(a.run.lockHeld, true);
  assert.equal(a.run.isolation.treeMode, 'run');
  assert.equal(lockOf(dataDir, 'example').runId, a.runId);
  const { mgr: m2 } = setup(t, { settings: { isolation: { example: 'branch' } } });
  const b = await m2.start({ project: 'example', pipeline: 'check', values: { what: 'everything' } });
  assert.equal(b.run.lockHeld, false);
  assert.equal(b.run.isolation.treeMode, 'main');
});

// ---------- the project lock (R20)

test('one editing run per project: a second one gets 409 "tg-run is busy with <title>. Park it or wait."', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Move money math' } });
  await mgr.settled();
  assert.equal((await loadRun(dataDir, a.runId)).status, 'waiting');
  assert.deepEqual(lockOf(dataDir, 'example'), { runId: a.runId, project: 'example', since: '2026-10-22T10:00:00.000Z', holder: HOLDER });
  const busy = 'tg-run is busy with Refactor: Move money math. Park it or wait.';
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Split the cart' } })), [409, busy]);
  assert.deepEqual((await mgr.preview({ project: 'example', pipeline: 'refactor', values: { what: 'Split the cart' } })).refusals, [busy]);
  assert.equal(await status(mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Read only' } })), 'ok', 'read-only runs need no lock');
  assert.equal(await status(mgr.start({ project: 'other', pipeline: 'refactor', values: { what: 'Elsewhere' } })), 'ok', 'locks are per project');
  await mgr.cancel(a.runId);
  assert.equal(lockOf(dataDir, 'example'), null);
  const b = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Split the cart' } });
  assert.equal(lockOf(dataDir, 'example').runId, b.runId);
});

test('a busy project answers 409 "busy with <title>", even when the run worktree also refuses (it holds that run\'s changes)', async t => {
  const dirty = 'This run needs the run worktree: example-run has 3 changed files; a run can\'t start until it is clean.';
  // The worktree refuses only once the first run has left its changes in it.
  let refuse = false;
  const { mgr } = setup(t, { behave: { refactor: waitAtHuman, preview: async () => ({ refusals: refuse ? [dirty] : [] }) } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Move money math' } });
  await mgr.settled();
  refuse = true;
  const busy = 'tg-run is busy with Refactor: Move money math. Park it or wait.';
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Another' } })), [409, busy]);
  assert.deepEqual((await mgr.preview({ project: 'example', pipeline: 'refactor', values: { what: 'Another' } })).refusals, [busy, dirty], 'busy first');
  await mgr.cancel(a.runId);
});

test('two editing starts at the same moment: exactly one gets the lock', async t => {
  const { mgr } = setup(t, { behave: { refactor: waitAtHuman } });
  const results = await Promise.all([
    status(mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'First change' } })),
    status(mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Second change' } })),
  ]);
  assert.equal(results.filter(r => r === 'ok').length, 1);
  assert.equal(results.find(r => r !== 'ok')[0], 409);
  await mgr.settled();
});

test('a lock left by an ended or parked run is taken over; one kept by a failed editing run is not', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman } });
  const old = await store.createRun(dataDir, { project: 'example', pipeline: 'refactor', id: 'r-old', status: 'passed', lockHeld: true, title: 'Refactor: old' });
  await locks.acquire(dataDir, 'example', { runId: old.id, holder: HOLDER, proc: { processState: async () => 'same' } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'New work' } });
  assert.equal(lockOf(dataDir, 'example').runId, a.runId);
  assert.equal((await loadRun(dataDir, 'r-old')).lockHeld, false);

  await store.createRun(dataDir, { project: 'beta', pipeline: 'refactor', id: 'r-failed', status: 'failed', lockHeld: true, title: 'Refactor: kept tree' });
  await locks.acquire(dataDir, 'beta', { runId: 'r-failed', holder: HOLDER, proc: { processState: async () => 'same' } });
  assert.deepEqual(await status(mgr.start({ project: 'beta', pipeline: 'refactor', values: { what: 'New work' } })),
    [409, 'tg-run is busy with Refactor: kept tree. Park it or wait.']);
});

test('a lock held by a run whose run.json cannot be read is never taken over', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman } });
  const held = await store.createRun(dataDir, { project: 'example', pipeline: 'refactor', id: 'r-broken', status: 'waiting', lockHeld: true, title: 'Refactor: busy file' });
  await locks.acquire(dataDir, 'example', { runId: held.id, holder: HOLDER, proc: { processState: async () => 'same' } });
  writeFileSync(join(store.runDir(dataDir, held), 'run.json'), '{ "half written'); // a busy or broken file, not a missing one
  const refusal = 'Could not read run r-broken, which holds the lock; try again in a moment.';
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'New work' } })), [409, refusal]);
  assert.ok((await mgr.preview({ project: 'example', pipeline: 'refactor', values: { what: 'New work' } })).refusals.includes(refusal));
  assert.equal(lockOf(dataDir, 'example').runId, 'r-broken', 'the lock stays with the run that could not be read');
});

test('a lock held by an app that has died does not block a start', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman } });
  await store.createRun(dataDir, { project: 'example', pipeline: 'refactor', id: 'r-crashed', status: 'running', lockHeld: true });
  await locks.acquire(dataDir, 'example', { runId: 'r-crashed', holder: DEAD_APP, proc: { processState: async () => 'gone' } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'After a crash' } });
  assert.equal(lockOf(dataDir, 'example').runId, a.runId);
});

// ---------- slots (R20)

test('createSlot: a counting semaphore, first come first served, with abort and a wait callback', async () => {
  const waits = [];
  const slot = createSlot('Claude', 2, w => waits.push(['slot', w.runId]));
  const r1 = await slot.acquire({ runId: 'a' });
  const r2 = await slot.acquire({ runId: 'b' });
  assert.equal(slot.inUse(), 2);
  const order = [];
  const p3 = slot.acquire({ runId: 'c' }).then(r => { order.push('c'); return r; });
  const own = [];
  const p4 = slot.acquire({ runId: 'd', onWait: w => own.push(w.runId) }).then(r => { order.push('d'); return r; });
  const c5 = new AbortController();
  const p5 = slot.acquire({ runId: 'e', signal: c5.signal });
  assert.equal(slot.waiting(), 3);
  assert.deepEqual(waits, [['slot', 'c'], ['slot', 'e']], 'the slot callback runs for callers without their own');
  assert.deepEqual(own, ['d'], 'a caller\'s own onWait replaces the slot one');
  c5.abort();
  await assert.rejects(p5, e => e.name === 'AbortError' && /free Claude slot/.test(e.message));
  assert.equal(slot.waiting(), 2);
  r1();
  r1(); // twice is harmless
  const r3 = await p3;
  assert.equal(slot.inUse(), 2);
  r2();
  const r4 = await p4;
  assert.deepEqual(order, ['c', 'd']);
  r3(); r4();
  assert.equal(slot.inUse(), 0);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(slot.acquire({ signal: pre.signal }), { name: 'AbortError' });
  await assert.rejects(slot.use({}, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(slot.inUse(), 0, 'use() releases on a throw');
  assert.equal(await slot.use({}, async () => 7), 7);
  assert.throws(() => createSlot('x', 0), /at least 1/);
});

test('at most 2 Claude stages run at once; the third waits with "Waiting for a free Claude slot" (R20)', async t => {
  const { mgr, dataDir, ctl } = setup(t, { behave: c => ({ explain: claudeLike(c) }) });
  const runs = [];
  for (const what of ['First question', 'Second question', 'Third question']) runs.push((await mgr.start({ project: 'example', pipeline: 'explain', values: { what } })).runId);
  await waitFor(() => ctl.started.length === 2);
  await tick(50);
  assert.equal(ctl.started.length, 2);
  assert.equal(mgr.slots.claude.inUse(), 2);
  assert.equal(mgr.slots.claude.waiting(), 1);
  const waiting = runs.find(id => !ctl.started.includes(id));
  await waitFor(async () => (await timeline(dataDir, { project: 'example', id: waiting })).some(r => r.msg === 'Waiting for a free Claude slot'));
  assert.equal(mgr.isBusy(), true);
  ctl.finish(ctl.started[0]);
  await waitFor(() => ctl.started.length === 3);
  ctl.finish(ctl.started[1]);
  ctl.finish(ctl.started[2]);
  await mgr.settled();
  assert.equal(ctl.maxActive, 2);
  for (const id of runs) assert.equal((await loadRun(dataDir, id)).status, 'passed');
  assert.equal(mgr.isBusy(), false);
});

test('a limit of 1 Claude slot runs stages strictly one after another', async t => {
  const { mgr, ctl } = setup(t, { limits: { claude: 1 }, behave: c => ({ explain: claudeLike(c) }) });
  await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'One' } });
  await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Two' } });
  await waitFor(() => ctl.started.length === 1);
  await tick(50);
  assert.equal(ctl.started.length, 1);
  ctl.finish(ctl.started[0]);
  await waitFor(() => ctl.started.length === 2);
  ctl.finish(ctl.started[1]);
  await mgr.settled();
  assert.equal(ctl.maxActive, 1);
});

// ---------- the registry and isBusy (R21)

test('isBusy counts registered processes and gates, never a run that only waits for you (R21)', async t => {
  const { mgr } = setup(t, { behave: { refactor: waitAtHuman } });
  assert.equal(mgr.isBusy(), false);
  const t1 = mgr.register({ pid: 5100, image: 'claude.exe', startedAt: 1 });
  assert.equal(mgr.isBusy(), true);
  assert.deepEqual(mgr.registered().map(e => [e.kind, e.rec.pid]), [['claude', 5100]]);
  mgr.unregister(t1);
  assert.equal(mgr.isBusy(), false);
  const t2 = mgr.register({ kind: 'gate', runId: 'r-1', stage: 'checks' });
  assert.equal(mgr.isBusy(), true);
  mgr.unregister(t2);
  const t3 = mgr.register({ kind: 'check', runId: 'r-1', record: { pid: 5200, image: 'node.exe', startedAt: 2 } });
  assert.equal(mgr.registered()[0].rec.pid, 5200);
  mgr.unregister(t3);
  assert.throws(() => mgr.register({ kind: 'claude', runId: 'r-1' }), /registered with its record/);
  assert.throws(() => mgr.register({ kind: 'bash', rec: { pid: 1, image: 'x', startedAt: 1 } }), /not a process kind/);
  assert.throws(() => mgr.register({ rec: { pid: 0, image: 'x', startedAt: 1 } }), /with a pid/);
  assert.throws(() => mgr.register(null), /needs a process entry/);
  await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Waits for the plan' } });
  await mgr.settled();
  assert.equal(mgr.isBusy(), false, 'a waiting run does not keep the app awake');
});

// ---------- actions

test('action checks the click against the rules, hands it to the executor and continues the run', async t => {
  const behave = {
    refactor: waitAtHuman,
    handle: async (run, action, payload, { engine }) => {
      const i = run.stages.findIndex(s => s.status === 'waiting');
      run.stages[i].status = 'done';
      run.status = 'running';
      run.waiting = null;
      await save(engine, run);
      return { message: `Plan approved with ${payload.answers.length} answer.` };
    },
  };
  const { mgr, dataDir, log } = setup(t, { behave });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Approve me' } });
  await mgr.settled();
  assert.deepEqual(await status(mgr.action(runId, 'retry', {})), [400, 'Retry stage is not available: Retry works when the current stage failed, was capped or was interrupted.']);
  assert.deepEqual(await status(mgr.action(runId, 'Bad Name!', {})), [400, 'That is not an action.']);
  assert.deepEqual(await status(mgr.action(runId, 'launch', {})), [400, 'launch is not an action for this run.']);
  assert.deepEqual(await status(mgr.action('r-nope', 'approve', {})), [404, 'There is no run r-nope.']);
  assert.deepEqual(await status(mgr.action('../x', 'approve', {})), [400, 'That is not a run id.']);
  const r = await mgr.action(runId, 'approve', { answers: ['yes'] });
  assert.equal(r.message, 'Plan approved with 1 answer.');
  await mgr.settled();
  assert.equal((await loadRun(dataDir, runId)).status, 'passed');
  assert.deepEqual(log.filter(e => e[0] === 'advance' || e[0] === 'handle').map(e => e[0]), ['advance', 'handle', 'advance']);
});

test('an action while a stage runs is refused with 409 (after the settle time)', async t => {
  const { mgr, ctl } = setup(t, { behave: c => ({ explain: claudeLike(c) }), actionSettleMs: 50 });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Busy' } });
  await waitFor(() => ctl.started.length === 1);
  assert.deepEqual(await status(mgr.action(runId, 'approve', {})), [409, 'The run is busy with a stage. Wait for it, or cancel the run.']);
  ctl.finish(runId);
  await mgr.settled();
});

test('a click right after the gate shows waits for the driver that is still finishing', async t => {
  // The driver saves "waiting" (the page can see the gate), then takes a moment to return.
  const lingering = async (run, ctx) => { await waitAtHuman(run, ctx); await tick(150); };
  const { mgr, dataDir } = setup(t, { behave: { refactor: lingering }, actionSettleMs: 2000 });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Quick click' } });
  await waitFor(async () => (await loadRun(dataDir, runId)).status === 'waiting');
  const out = await mgr.action(runId, 'approve', {});
  assert.equal(out.message, 'Done.');
  await mgr.settled();
});

// ---------- cancel

test('cancel tells the executor first, then stops the run\'s process after the record check, and frees the lock', async t => {
  const { mgr, dataDir, log, ctl, proc } = setup(t, { behave: c => ({ refactor: claudeLike(c) }) });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Cancel me' } });
  await waitFor(() => ctl.started.length === 1);
  const pid = ctl.pids.get(runId);
  assert.equal(mgr.isBusy(), true);
  const r = await mgr.cancel(runId);
  assert.equal(r.message, 'Cancelled.');
  assert.equal(r.run.status, 'cancelled');
  assert.deepEqual(r.kills.killed.map(k => k.pid), [pid]);
  const iCancel = log.findIndex(e => e[0] === 'cancelPath' && e[1] === runId);
  const iKill = log.findIndex(e => e[0] === 'safeKill' && e[1] === pid);
  assert.ok(iCancel >= 0 && iKill > iCancel, 'the executor hears about the cancel before anything is killed');
  assert.ok(!(pid in proc.procs));
  assert.ok(!log.some(e => e[0] === 'treeKill'), 'no unguarded kill');
  assert.equal(lockOf(dataDir, 'example'), null);
  await mgr.settled();
  assert.equal(mgr.isBusy(), false);
  assert.deepEqual(mgr.registered(), []);
  assert.equal((await loadRun(dataDir, runId)).status, 'cancelled');
  assert.deepEqual(await status(mgr.cancel(runId)), [400, 'This run has already ended (cancelled).']);
});

test('cancel through action() works for a run that waits, and is checked against the rules', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman } });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Wait then cancel' } });
  await mgr.settled();
  const r = await mgr.action(runId, 'cancel', {});
  assert.equal(r.run.status, 'cancelled');
  assert.equal((await loadRun(dataDir, runId)).statusReason, 'cancelled by you');
  assert.deepEqual(await status(mgr.action(runId, 'cancel', {})), [400, 'Cancel is not available: The run has ended.']);
});

test('a cancel path that fails still lets the kills happen and reports the error', async t => {
  const { mgr, ctl, proc } = setup(t, { behave: c => ({ explain: claudeLike(c) }) });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Fails to cancel' } });
  await waitFor(() => ctl.started.length === 1);
  const pid = ctl.pids.get(runId);
  mgr.executor.cancelPath = async () => { throw new Error('the tree could not be reset'); };
  await assert.rejects(mgr.cancel(runId), /the tree could not be reset/);
  assert.ok(!(pid in proc.procs), 'the process was still stopped');
  await mgr.settled();
  assert.equal(mgr.isBusy(), false, 'nothing stays marked as being handled');
});

test('a process whose pid now belongs to another program is never killed (R19)', async t => {
  const { mgr, dataDir, log, proc } = setup(t, { behave: { refactor: waitAtHuman } });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Reused pid' } });
  await mgr.settled();
  proc.procs[5300] = { image: 'claude.exe', startedAt: 9_999_999 }; // the same pid, started later: reused
  mgr.register({ kind: 'claude', runId, proc: { pid: 5300, image: 'claude.exe', startedAt: 1_234 } });
  proc.procs[5301] = { image: 'explorer.exe', startedAt: 50 };
  mgr.register({ kind: 'check', runId, rec: { pid: 5301, image: 'explorer.exe', startedAt: 50 } });
  const r = await mgr.cancel(runId);
  assert.ok(5300 in proc.procs && 5301 in proc.procs, 'both processes still run');
  assert.ok(!log.some(e => (e[0] === 'killed' || e[0] === 'treeKill') && (e[1] === 5300 || e[1] === 5301)));
  assert.match(r.message, /Some processes could not be stopped: explorer\.exe 5301/);
  assert.equal((await loadRun(dataDir, runId)).status, 'cancelled');
});

// ---------- engine failures

test('an executor that throws leaves the run interrupted with the reason, keeping its lock', async t => {
  const { mgr, dataDir } = setup(t, { behave: { refactor: async () => { throw new Error('the gate exploded'); } } });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Explode' } });
  await mgr.settled();
  const run = await loadRun(dataDir, runId);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.error.message, 'The engine stopped: the gate exploded');
  assert.ok((await timeline(dataDir, run)).some(r => r.kind === 'error' && r.msg === 'The engine stopped: the gate exploded'));
  assert.equal(lockOf(dataDir, 'example').runId, runId, 'Retry or Resume can pick it up');
  assert.equal(mgr.isBusy(), false);
});

test('an executor that returns while the run still says running leaves it interrupted', async t => {
  const { mgr, dataDir } = setup(t, { behave: { explain: async () => {} } });
  const { runId } = await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Nothing happens' } });
  await mgr.settled();
  const run = await loadRun(dataDir, runId);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.statusReason, 'The engine stopped without finishing the stage.');
});

// ---------- child runs and findings

test('engine.startRun passes parent and inherit for a child run; a start from the page cannot set them', async t => {
  const { mgr, dataDir } = setup(t, { behave: { feature: waitAtHuman } });
  const child = await mgr.engine.startRun({ project: 'example', pipeline: 'feature', values: { what: 'Slice two' }, parent: 'r-parent', inherit: { slice: 1, baseSha: 'abc' } });
  const run = await loadRun(dataDir, child.runId);
  assert.equal(run.parent, 'r-parent');
  assert.deepEqual(run.inherit, { slice: 1, baseSha: 'abc' });
  await mgr.cancel(child.runId);
  const page = await mgr.start({ project: 'example', pipeline: 'feature', values: { what: 'Sneaky' }, parent: 'r-evil', inherit: { spec: {} } });
  const run2 = await loadRun(dataDir, page.runId);
  assert.equal(run2.parent, null);
  assert.ok(!('inherit' in run2));
});

test('start with skipped stages (internal only) marks them skipped', async t => {
  const { mgr } = setup(t, { behave: { feature: waitAtHuman } });
  const r = await mgr.start({ project: 'example', pipeline: 'feature', values: { what: 'Skip' } }, { skip: ['spec'] });
  assert.deepEqual(r.run.stages.map(s => [s.id, s.status]), [['preflight', 'pending'], ['spec', 'skipped']]);
});

test('a run for a finding marks the finding in-run', async t => {
  const { mgr, findingCalls } = setup(t, { behave: { fix: waitAtHuman } });
  const { runId, run } = await mgr.start({ project: 'example', pipeline: 'fix', values: { finding: 'T-1' } });
  assert.equal(run.findingId, 'T-1');
  assert.deepEqual(findingCalls, [['example', 'T-1', 'in-run', { by: 'run', runId, reason: 'run started' }]]);
});

// ---------- startup recovery

async function seedRun(dataDir, init, mutate = () => {}) {
  const run = await store.createRun(dataDir, init);
  mutate(run);
  await store.saveRun(dataDir, run);
  return run;
}
const deadLock = (dataDir, project, runId) => locks.acquire(dataDir, project, { runId, holder: DEAD_APP, proc: { processState: async () => 'gone' } });

test('recover after a crash: kills leftovers after the record check, marks runs interrupted, sorts out locks and orphans', async t => {
  const alive = {
    501: { image: 'claude.exe', startedAt: 111 }, // run A's stage, still running
    502: { image: 'chrome.exe', startedAt: 999_999 }, // run B's old pid, now another program
    601: { image: 'node.exe', startedAt: 333 }, // run C's check, still running
    602: { image: 'node.exe', startedAt: 444 }, // run C's check that already ended (pids.json says so)
    701: { image: 'claude.exe', startedAt: 555 }, // run H's stage: another live app owns H
    777: { image: 'node.exe', startedAt: 77 }, // that other app
    801: { image: 'bash.exe', startedAt: 1 }, 802: { image: 'node.exe', startedAt: 2 }, 803: { image: 'conhost.exe', startedAt: 3 },
  };
  const { mgr, dataDir, proc, log } = setup(t, { alive });
  const tree = 'C:\\dev\\tg-run';
  const main = 'C:\\main\\example';
  const owner = DEAD_APP;
  const A = await seedRun(dataDir, { project: 'example', pipeline: 'refactor', id: 'r-a', owner, lockHeld: true,
    isolation: { mode: 'worktree', tree, mainDir: main, treeMode: 'run' },
    stages: [{ id: 'preflight', kind: 'gate', status: 'done' }, { id: 'scope', kind: 'claude' }, { id: 'plan', kind: 'human' }] }, r => {
    r.stages[1].status = 'running';
    r.stages[1].attempts = [{ k: 1, folder: 'stages/01-scope', proc: { pid: 501, image: 'claude.exe', startedAt: 111 } }];
    r.current = { stage: 'scope', index: 1, attempt: 1, round: 1 };
  });
  await deadLock(dataDir, 'example', 'r-a');
  const B = await seedRun(dataDir, { project: 'example', pipeline: 'explain', id: 'r-b', owner,
    isolation: { mode: 'none', tree: main, mainDir: main, treeMode: 'main' }, stages: [{ id: 'answer', kind: 'claude' }] }, r => {
    r.stages[0].status = 'running';
    r.stages[0].attempts = [{ k: 1, folder: 'stages/00-answer', proc: { pid: 502, image: 'claude.exe', startedAt: 222 } }];
  });
  const C = await seedRun(dataDir, { project: 'example', pipeline: 'check', id: 'r-c', owner,
    stages: [{ id: 'preflight', kind: 'gate', status: 'done' }, { id: 'checks', kind: 'gate' }] }, r => {
    r.stages[1].status = 'running';
    r.stages[1].gate = 'gates/01-checks';
  });
  const gateDir = join(store.runDir(dataDir, C), 'gates', '01-checks');
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(join(gateDir, 'pids.json'), JSON.stringify({ version: 1, procs: [
    { pid: 601, image: 'node.exe', startedAt: 333, endedAt: null }, { pid: 602, image: 'node.exe', startedAt: 444, endedAt: 445 }] }));
  const D = await seedRun(dataDir, { project: 'beta', pipeline: 'refactor', id: 'r-d', owner, status: 'waiting', lockHeld: true,
    waiting: { kind: 'plan', since: 'x', detail: '' } });
  await deadLock(dataDir, 'beta', 'r-d');
  await seedRun(dataDir, { project: 'gamma', pipeline: 'refactor', id: 'r-e', owner, status: 'passed', lockHeld: true });
  await deadLock(dataDir, 'gamma', 'r-e');
  await seedRun(dataDir, { project: 'delta', pipeline: 'fix', id: 'r-f', owner, status: 'failed', lockHeld: true });
  await deadLock(dataDir, 'delta', 'r-f');
  await seedRun(dataDir, { project: 'eps', pipeline: 'refactor', id: 'r-g', owner, status: 'parked', lockHeld: true });
  const otherApp = { pid: 777, image: 'node.exe', startedAt: 77 };
  await seedRun(dataDir, { project: 'zeta', pipeline: 'refactor', id: 'r-h', owner: otherApp, lockHeld: true, stages: [{ id: 'scope', kind: 'claude' }] }, r => {
    r.stages[0].status = 'running';
    r.stages[0].attempts = [{ k: 1, folder: 'stages/00-scope', proc: { pid: 701, image: 'claude.exe', startedAt: 555 } }];
  });
  await locks.acquire(dataDir, 'zeta', { runId: 'r-h', holder: otherApp, proc: { processState: async () => 'gone' } });
  const thetaTree = 'C:\\dev\\theta-run';
  await seedRun(dataDir, { project: 'theta', pipeline: 'refactor', id: 'r-i', owner, status: 'in-terminal', lockHeld: true,
    isolation: { mode: 'worktree', tree: thetaTree, mainDir: 'C:\\main\\theta', treeMode: 'run' } });
  await deadLock(dataDir, 'theta', 'r-i');
  await seedRun(dataDir, { project: 'theta', pipeline: 'refactor', id: 'r-j', owner, status: 'interrupted',
    isolation: { mode: 'worktree', tree: thetaTree, mainDir: 'C:\\main\\theta', treeMode: 'run' } });
  proc.orphans = [
    { pid: 801, image: 'bash.exe', startedAt: 1, parentAlive: false, killable: true, needle: tree, alive: true },
    { pid: 802, image: 'node.exe', startedAt: 2, parentAlive: true, killable: true, needle: tree, alive: true },
    { pid: 803, image: 'conhost.exe', startedAt: 3, parentAlive: false, killable: false, needle: tree, alive: true },
  ];
  const signals = [];
  mgr.signals.subscribe(s => signals.push(s.run));

  const rep = await mgr.recover();

  assert.deepEqual([...rep.interrupted].sort(), ['r-a', 'r-b', 'r-c']);
  const killed = rep.killed.map(k => k.pid).sort();
  assert.deepEqual(killed, [501, 601, 801]);
  for (const pid of [502, 602, 701, 777, 802, 803]) assert.ok(pid in proc.procs, `${pid} left alone`);
  assert.ok(!log.some(e => e[0] === 'treeKill'), 'every kill went through safeKill');

  const a = await loadRun(dataDir, 'r-a');
  assert.equal(a.status, 'interrupted');
  assert.equal(a.statusReason, 'The app restarted while scope ran.');
  assert.equal(a.stages[1].status, 'interrupted');
  assert.equal(a.stages[1].attempts[0].status, 'interrupted');
  assert.ok(a.stages[1].attempts[0].endedAt);
  assert.equal((await timeline(dataDir, a)).at(-1).msg, 'The app restarted while scope ran.');
  assert.equal((await loadRun(dataDir, 'r-b')).status, 'interrupted');
  assert.equal((await loadRun(dataDir, 'r-c')).statusReason, 'The app restarted while checks ran.');

  const adopted = rep.adopted.map(x => `${x.project}:${x.runId}`).sort();
  assert.deepEqual(adopted, ['beta:r-d', 'delta:r-f', 'example:r-a', 'theta:r-i']);
  for (const p of ['example', 'beta', 'delta', 'theta']) assert.deepEqual(lockOf(dataDir, p).holder, HOLDER, `${p} lock adopted`);
  assert.deepEqual(rep.released, [{ project: 'gamma', runId: 'r-e' }]);
  assert.equal(lockOf(dataDir, 'gamma'), null);
  assert.equal((await loadRun(dataDir, 'r-g')).lockHeld, false, 'a parked run without a lock file no longer claims one');
  assert.equal((await loadRun(dataDir, 'r-d')).status, 'waiting', 'waiting runs stay waiting');

  assert.deepEqual(rep.skipped, ['r-h']);
  assert.equal((await loadRun(dataDir, 'r-h')).status, 'running', 'another live app\'s run is left alone');
  assert.deepEqual(lockOf(dataDir, 'zeta').holder, otherApp);
  assert.ok(rep.errors.some(e => /1 run belong to another app that still runs/.test(e)));

  const needles = log.find(e => e[0] === 'findOrphans')[1];
  const dirA = store.runDir(dataDir, A);
  for (const n of ['r-a', 'r-b', 'r-c', 'r-j', join(dirA, 'tmp'), join(dirA, 'stages', '01-scope', 'settings.json'), tree]) {
    assert.ok(needles.includes(n), `needle ${n}`);
  }
  for (const n of [main, thetaTree, 'r-h', 'r-i', 'r-d']) assert.ok(!needles.includes(n), `no needle ${n}`);
  assert.deepEqual(rep.orphans.map(o => [o.pid, o.parentAlive, o.killable]), [[801, false, true], [802, true, true], [803, false, false]]);
  for (const id of ['r-a', 'r-b', 'r-c']) assert.ok(signals.includes(id), `signal for ${id}`);
  assert.ok(B && D);
});

test('recover with a failed process lookup kills nothing, still marks runs interrupted and says why', async t => {
  const { mgr, dataDir, proc, log } = setup(t, { alive: { 501: { image: 'claude.exe', startedAt: 111 } } });
  await seedRun(dataDir, { project: 'example', pipeline: 'explain', id: 'r-a', owner: DEAD_APP, stages: [{ id: 'answer', kind: 'claude' }] }, r => {
    r.stages[0].status = 'running';
    r.stages[0].attempts = [{ k: 1, folder: 'stages/00-answer', proc: { pid: 501, image: 'claude.exe', startedAt: 111 } }];
  });
  proc.lookupFails = true;
  const rep = await mgr.recover();
  assert.deepEqual(rep.interrupted, ['r-a']);
  assert.deepEqual(rep.killed, []);
  assert.ok(501 in proc.procs);
  assert.ok(!log.some(e => e[0] === 'killed' || e[0] === 'treeKill'));
  assert.ok(rep.errors.some(e => /Could not check process 501, so it was left running/.test(e)));
  assert.ok(rep.errors.some(e => /Could not check which app owns 1 run/.test(e)));
});

test('recover on an empty data folder reports nothing to do', async t => {
  const { mgr } = setup(t);
  assert.deepEqual(await mgr.recover(), { interrupted: [], killed: [], adopted: [], released: [], orphans: [], skipped: [], errors: [] });
  assert.ok(ADOPT_STATUSES.includes('interrupted') && !ADOPT_STATUSES.includes('passed'));
});

// ---------- shutdown (spike A11)

test('shutdown stops every Claude stage and gate check, marks the runs interrupted and blocks new work', async t => {
  const { mgr, dataDir, log, ctl, proc } = setup(t, { behave: c => { c.saveAfterAbort = true; return { explain: claudeLike(c), check: gateLike(c) }; } });
  const a = await mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'Long answer' } });
  const b = await mgr.start({ project: 'other', pipeline: 'check', values: { what: 'everything' } });
  await waitFor(() => ctl.started.length === 2);
  const claudePid = ctl.pids.get(a.runId);
  assert.equal(mgr.isBusy(), true);

  const rep = await mgr.shutdown({ settleMs: 1000 });
  assert.equal(mgr.shutdown(), mgr.shutdown(), 'calling it again returns the same promise');
  assert.deepEqual(rep.killed.map(k => k.pid).sort((x, y) => x - y), [claudePid, 6001].sort((x, y) => x - y));
  assert.deepEqual(rep.failed, []);
  assert.ok(!(claudePid in proc.procs) && !(6001 in proc.procs));
  const firstKill = log.findIndex(e => e[0] === 'safeKill');
  for (const id of [a.runId, b.runId]) assert.ok(log.findIndex(e => e[0] === 'abort' && e[1] === id) < firstKill, `abort ${id} before the kills`);
  assert.deepEqual([...rep.interrupted].sort(), [a.runId, b.runId].sort());

  const ra = await loadRun(dataDir, a.runId);
  assert.equal(ra.status, 'interrupted', 'the dying stage\'s own "failed" save was dropped');
  assert.equal(ra.statusReason, 'The app was closing while answer ran.');
  assert.equal(ra.stages[0].status, 'interrupted');
  assert.equal((await timeline(dataDir, ra)).at(-1).msg, 'The app was closing while answer ran.');
  const rb = await loadRun(dataDir, b.runId);
  assert.equal(rb.statusReason, 'The app was closing while checks ran.');
  assert.equal(lockOf(dataDir, 'other').runId, b.runId, 'the lock stays for recovery to adopt');

  assert.equal(mgr.closing, true);
  assert.deepEqual(await status(mgr.start({ project: 'example', pipeline: 'explain', values: { what: 'x' } })), [503, 'The app is closing.']);
  assert.deepEqual(await status(mgr.preview({ project: 'example', pipeline: 'explain', values: { what: 'x' } })), [503, 'The app is closing.']);
  assert.deepEqual(await status(mgr.action(a.runId, 'retry', {})), [503, 'The app is closing.']);
  assert.equal(mgr.schedule(a.runId), false);
  assert.deepEqual(mgr.registered(), []);
});

test('shutdown lets a click being applied finish: its saves land, and a run it left running is interrupted', async t => {
  const gates = new Map();
  const handle = async (run, action, payload, { engine }) => {
    await new Promise(r => gates.set(run.id, r));
    run.status = payload.then;
    if (payload.then === 'committed') run.commit = { sha: 'c'.repeat(40), branch: 'app/1022-commit-me' };
    await engine.store.saveRun(engine.dataDir, run);
    return { message: `Applied ${action}.` };
  };
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman, handle } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Commit me' } });
  const b = await mgr.start({ project: 'beta', pipeline: 'refactor', values: { what: 'Go on' } });
  await mgr.settled();
  const clickA = mgr.action(a.runId, 'approve', { then: 'committed' });
  const clickB = mgr.action(b.runId, 'approve', { then: 'running' });
  await waitFor(() => gates.has(a.runId) && gates.has(b.runId));
  assert.equal(mgr.isBusy(), true, 'a click being applied counts as busy');

  const closing = mgr.shutdown({ settleMs: 2000 });
  await tick();
  for (const open of gates.values()) open();
  const rep = await closing;
  assert.deepEqual(rep.errors, []);
  assert.equal((await clickA).message, 'Applied approve.');
  const ra = await loadRun(dataDir, a.runId);
  assert.equal(ra.status, 'committed', 'the click\'s save was not dropped');
  assert.equal(ra.commit.branch, 'app/1022-commit-me');
  await clickB;
  assert.deepEqual(rep.interrupted, [b.runId], 'shutdown did not let it go on, and says so');
  const rb = await loadRun(dataDir, b.runId);
  assert.equal(rb.status, 'interrupted');
  assert.equal((await timeline(dataDir, rb)).at(-1).msg, 'The app was closing, so the run did not go on after approve.');
});

test('shutdown reports a click that did not finish in time and leaves its run alone', async t => {
  let open;
  const handle = async (run, action, payload, { engine }) => {
    await new Promise(r => { open = r; });
    run.status = 'committed';
    await engine.store.saveRun(engine.dataDir, run);
    return { message: 'late' };
  };
  const { mgr, dataDir } = setup(t, { behave: { refactor: waitAtHuman, handle } });
  const a = await mgr.start({ project: 'example', pipeline: 'refactor', values: { what: 'Slow commit' } });
  await mgr.settled();
  const click = mgr.action(a.runId, 'approve', {});
  await waitFor(() => open);
  const rep = await mgr.shutdown({ settleMs: 50 });
  assert.deepEqual(rep.errors, [`${a.runId}: the app closed before approve finished; check the run when the app starts again.`]);
  assert.deepEqual(rep.interrupted, []);
  open();
  await click;
  assert.equal((await loadRun(dataDir, a.runId)).status, 'committed', 'its save still lands once it finishes');
});

test('shutdown with nothing running is quick and reports nothing', async t => {
  const { mgr } = setup(t);
  assert.deepEqual(await mgr.shutdown({ settleMs: 10 }), { killed: [], failed: [], interrupted: [], errors: [] });
});

// ---------- the input manifest and attached assets (plan row A6)

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const HUB_STATE = { commit: 'a'.repeat(40), pipelinesClean: true };

// A workspace with pipelines/app and projects/example, a shared text asset with two versions and
// a project image, and a manager on the real catalog (Explain: one Claude stage, answer).
async function assetWorld(t, { settings = null } = {}) {
  const root = temp(t);
  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  mkdirSync(join(root, 'projects', 'example'), { recursive: true });
  const style = await createAsset(root, { scope: 'shared', title: 'Style guide', originalName: 'style.md' }, Buffer.from('# Style\nUse teal.\n'));
  await addVersion(root, style.ref, Buffer.from('# Style v2\nUse navy.\n'), { originalName: 'style.md', expectVersions: 1 });
  await createAsset(root, { scope: 'project', project: 'example', title: 'Palette', originalName: 'palette.png' }, PNG);
  const dataDir = temp(t);
  const saved = await saveSettings(dataDir, 'example', settings || {
    rules: 'Money is in cents.', assets: [{ ref: 'shared:style-guide', pin: 1 }, { ref: 'example:palette', pin: null }],
  }, { basedOn: 0 });
  const log = [];
  const mgr = createManager({
    root, dataDir, clock: { now: () => Date.parse('2026-10-22T10:00:00.000Z') },
    deps: {
      store, locks, proc: fakeProc(log), catalog: realCatalog, actions: fakeActions, holder: HOLDER,
      profileFor: async () => ({ exists: true, profile: PROFILE, errors: [], warnings: [] }), getSettings: async () => ({ isolation: {} }),
      riskTags: () => ({ tags: [], hits: [] }), trustFor: async () => true, hubState: async () => HUB_STATE,
      createExecutor: engine => makeExecutor({ ...engine, testLog: log }, {}),
    },
  });
  t.after(async () => { await mgr.shutdown({ settleMs: 50 }).catch(() => {}); await mgr.settled().catch(() => {}); });
  return { root, dataDir, mgr, saved };
}
const EXPLAIN = { project: 'example', pipeline: 'explain', values: { what: 'How is tax added?' } };

test('start writes the input manifest, frozen, and copies the attached assets into inputs/assets', async t => {
  const { root, dataDir, mgr, saved } = await assetWorld(t);
  const { runId } = await mgr.start(EXPLAIN);
  await mgr.settled();
  const run = await store.findRun(dataDir, runId);
  assert.equal(run.status, 'passed', 'the executor saved the run with its manifest unchanged');
  const m = run.manifest;
  assert.equal(run.manifestSha256, manifestHash(m));
  assert.deepEqual(m.stagePrompts, [{ stage: 'answer', file: 'pipelines/app/explain/answer.md', sha256: templateHash(await loadPrompt(root, 'explain', 'answer')) }]);
  assert.deepEqual(m.profile, { sha256: profileHash(PROFILE) });
  assert.deepEqual([m.projectSettings, run.projectSettings], [{ version: 1, sha256: saved.sha256 }, { version: 1, sha256: saved.sha256 }], 'the same version as the run');
  assert.deepEqual(m.assets.map(a => [a.ref, a.pin, a.version, a.kind, a.title, a.file]), [
    ['shared:style-guide', 1, 1, 'text', 'Style guide', 'inputs/assets/shared-style-guide@v1.md'],
    ['example:palette', null, 1, 'image', 'Palette', 'inputs/assets/project-palette@v1.png'],
  ]);
  assert.deepEqual([m.models, m.efforts], [{ answer: 'sonnet' }, { answer: 'high' }]);
  assert.deepEqual(m.versions, { node: process.versions.node, claudeCode: null });
  assert.deepEqual(m.hub, HUB_STATE);
  // The copies, hashed through the store, the pinned version and not the latest.
  const inputs = join(store.runDir(dataDir, run), 'inputs', 'assets');
  assert.equal(readFileSync(join(inputs, 'shared-style-guide@v1.md'), 'utf8'), '# Style\nUse teal.\n');
  assert.deepEqual(readFileSync(join(inputs, 'project-palette@v1.png')), PNG);
  assert.equal(run.inputsHashes['assets/shared-style-guide@v1.md'], `sha256:${m.assets[0].sha256}`);
  assert.equal((await store.verifyInputs(dataDir, run)).ok, true);
  const rows = (await timeline(dataDir, run)).map(r => r.msg);
  assert.ok(rows.includes('Copied 2 attached assets into inputs/assets: shared:style-guide v1, example:palette v1.'), rows.join('\n'));
});

test('an archived asset is still used and noted; a run without attached assets gets an empty list', async t => {
  const { root, dataDir, mgr } = await assetWorld(t);
  await setArchived(root, 'example:palette', true);
  const preview = await mgr.preview(EXPLAIN);
  assert.deepEqual(preview.refusals, []);
  assert.match(preview.warnings.join(' '), /example:palette is archived; it is used anyway/);
  const { runId } = await mgr.start(EXPLAIN);
  await mgr.settled();
  const run = await store.findRun(dataDir, runId);
  assert.deepEqual(run.manifest.assets.map(a => [a.ref, !!a.archived]), [['shared:style-guide', false], ['example:palette', true]]);
  assert.ok((await timeline(dataDir, run)).some(r => r.kind === 'info' && /example:palette is archived; it is used anyway, because archiving only hides/.test(r.msg)));

  const none = await assetWorld(t, { settings: { rules: 'Just rules.' } });
  const { runId: plainId } = await none.mgr.start(EXPLAIN);
  await none.mgr.settled();
  const plain = await store.findRun(none.dataDir, plainId);
  assert.deepEqual(plain.manifest.assets, []);
  assert.ok(!existsSync(join(store.runDir(none.dataDir, plain), 'inputs', 'assets')), 'no assets folder without assets');
});

test('a missing asset or pinned version, or settings that can not be read, refuse the start and create nothing', async t => {
  const cases = [
    [{ assets: [{ ref: 'shared:style-guide', pin: 7 }] }, /The assets attached to example can't be used: shared:style-guide has no version 7\. Fix them in the project's settings\./],
    [{ assets: [{ ref: 'shared:gone', pin: null }] }, /shared:gone is not in the asset library/],
  ];
  for (const [settings, re] of cases) {
    const { dataDir, mgr } = await assetWorld(t, { settings });
    const p = await mgr.preview(EXPLAIN);
    assert.match(p.refusals.join(' '), re, 'the launcher shows it before a start');
    const [code, msg] = await status(mgr.start(EXPLAIN));
    assert.equal(code, 400);
    assert.match(msg, re);
    assert.deepEqual(await store.listRuns(dataDir), []);
  }
  const { dataDir, mgr } = await assetWorld(t);
  writeFileSync(join(settingsDir(dataDir, 'example'), 'v1.json'), '{ damaged');
  const [code, msg] = await status(mgr.start(EXPLAIN));
  assert.equal(code, 400);
  assert.match(msg, /The project settings of example can't be read, so no run can start: The settings v1 of example can't be used/);
  assert.deepEqual(await store.listRuns(dataDir), []);
});

test('a version file edited by hand after it was saved refuses the start with 409', async t => {
  const { root, dataDir, mgr } = await assetWorld(t);
  writeFileSync(join(root, 'inbox', 'attachments', '_assets', 'style-guide', 'v1.md'), '# Style\nUse pink.\n');
  const [code, msg] = await status(mgr.start(EXPLAIN));
  assert.equal(code, 409);
  assert.match(msg, /the file of shared:style-guide v1 no longer matches the SHA-256 the library recorded for it \(it was changed after it was saved\)/);
  assert.deepEqual(await store.listRuns(dataDir), []);
  rmSync(join(root, 'inbox', 'attachments', 'example', '_assets', 'palette', 'v1.png'));
  const [, gone] = await status(mgr.start(EXPLAIN));
  assert.match(gone, /the file of example:palette v1 is missing/);
});
