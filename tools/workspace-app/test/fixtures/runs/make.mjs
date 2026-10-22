// Rebuilds the run fixtures in this folder: one run folder per run status (and one per main
// waiting kind), for the run views (wave 3b) and routes/runs.test.mjs.
//
//   node tools/workspace-app/test/fixtures/runs/make.mjs
//
// It drives the real engine (runs/wiring.mjs) with test/fake-claude.mjs as claude, in a temporary
// workspace with the synthetic "example" project, through every status a run can have. Each
// time a run rests in the state wanted, its folder is copied here as example/<fixture id>/ with
// run.json, timeline.jsonl, inputs/, gates/ and final/ (stages/ and tmp/ are left out). Temporary
// paths become synthetic ones (C:\dev\claude-workspace, C:\dev\example-run,
// C:\Users\user\AppData\Local\claude-workspace), and the result is checked for the user name.
// Nothing real is touched: no real claude starts and everything else happens under os.tmpdir().
// Load the fixtures into a data folder with install.mjs.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../app.mjs';
import * as store from '../../../runs/store.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, removeTree, runGit, tempDir, writeFiles } from '../../helpers.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HUB = fileURLToPath(new URL('../../../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('../../fake-claude.mjs', import.meta.url));
const OUT = join(HERE, 'example');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The synthetic places the temporary ones become.
const PLACES = {
  hub: 'C:\\dev\\claude-workspace',
  tree: 'C:\\dev\\example-run',
  data: 'C:\\Users\\user\\AppData\\Local\\claude-workspace',
  temp: 'C:\\Users\\user\\AppData\\Local\\Temp\\ws-fixtures',
};

async function setup() {
  const base = tempDir('w');
  const root = join(base, 'hub');
  const dataDir = join(base, 'data');
  const tree = join(base, 't');
  const fakeDir = join(base, 'fake');
  const main = join(root, 'projects', 'example');
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  await makeRepo(main, { files: exampleRepoFiles() });
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({ isolation: { worktreePath: tree } }) });
  writeFiles(fakeDir, { 'none.json': {} });
  const script = new Map();
  const claudeCommand = opts => {
    const s = script.get(opts.stage) || {};
    const args = [process.execPath, FAKE, '--fixture', s.fixture || 'auto', '--delay-ms', '1'];
    for (const [flag, key] of [['--structured-file', 'structured'], ['--writes-file', 'writes']]) {
      if (!s[key]) continue;
      const f = join(fakeDir, `${opts.stage}-${opts.attempt}-${key}.json`);
      writeFileSync(f, JSON.stringify(s[key]));
      args.push(flag, f);
    }
    return args;
  };
  const rec = async () => ({ sessionId: '' });
  const actions = { tools: { claude: '' }, startClaude: rec, runTool: async () => ({ status: 0, output: '' }) };
  const app = createApp({
    root, token: 'x', actions, getPort: () => 0, dataDir,
    engineOptions: { claudeCommand, timing: { tailMs: 25, tickMs: 200 }, deps: { trustFor: async () => true } },
  });
  return { base, root, dataDir, tree, main, script, app, manager: await app.getEngine() };
}

// Polls the run until `until(run)` holds; throws with the run's state when it rests elsewhere.
async function waitRun(w, id, until, what, ms = 60_000) {
  const end = Date.now() + ms;
  let run = null;
  while (Date.now() < end) {
    run = await store.findRun(w.dataDir, id);
    if (run && until(run)) {
      // A run at rest: let its driver finish too, so the next click is not refused as busy.
      if (run.status !== 'running') await w.manager.settled();
      return store.findRun(w.dataDir, id);
    }
    await sleep(100);
  }
  throw new Error(`${what}: run ${id} is ${run && run.status} at ${run && run.current && run.current.stage} (${run && run.statusReason})`);
}
const waiting = kind => r => r.status === 'waiting' && r.waiting && r.waiting.kind === kind;
const status = s => r => r.status === s;

// The three ways a path is written in the files: as is, JSON-escaped, with forward slashes.
const STYLES = [p => p, p => p.replace(/\\/g, '\\\\'), p => p.replace(/\\/g, '/')];

// A function that replaces every temporary path (any style, either case of the drive letter).
function replacer(w) {
  const pairs = [
    [w.main, `${PLACES.hub}\\projects\\example`],
    [w.root, PLACES.hub],
    [w.tree, PLACES.tree],
    [w.dataDir, PLACES.data],
    [w.base, PLACES.temp],
    [homedir(), 'C:\\Users\\user'],
  ];
  const rules = [];
  for (const [from, to] of pairs) {
    for (const style of STYLES) {
      for (const drive of [s => s.replace(/^[a-z]:/, d => d.toUpperCase()), s => s.replace(/^[A-Z]:/, d => d.toLowerCase())]) {
        rules.push([style(drive(from)), style(to)]);
      }
    }
  }
  // Longest first, so a folder's own path is replaced before its parent's.
  rules.sort((a, b) => b[0].length - a[0].length);
  return text => rules.reduce((t, [from, to]) => t.split(from).join(to), text);
}

// Copies a run's folder here as example/<fixtureId>/ with the id and the temporary paths
// replaced. Left out, to keep the fixtures small: stages/, tmp/, empty files outside gates/,
// pids.json, and every gate folder except the run's last one (only with `gates`, for the review
// and log views).
function snapshot(w, run, fixtureId, fix, { gates = false } = {}) {
  const from = store.runDir(w.dataDir, run);
  const to = join(OUT, fixtureId);
  const lastGate = gates && run.lastGate && run.lastGate.folder ? run.lastGate.folder.split('/').join(sep) : null;
  rmSync(to, { recursive: true, force: true });
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(from, full);
      if (/^(stages|tmp)(\\|\/|$)/.test(rel) || e.name === 'pids.json') continue;
      if (/^gates(\\|\/|$)/.test(rel) && rel !== 'gates' && !(lastGate && (rel === lastGate || rel.startsWith(lastGate + sep)))) continue;
      if (e.isDirectory()) { walk(full); continue; }
      // Empty files go, except gate logs: the checks summary names them.
      if (statSync(full).size === 0 && !/^gates(\\|\/)/.test(rel)) continue;
      const text = fix(readFileSync(full, 'utf8')).split(run.id).join(fixtureId);
      const target = join(to, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, text);
    }
  };
  walk(from);
  console.log(`  ${fixtureId}: ${run.status}${run.waiting ? ` (${run.waiting.kind})` : ''}`);
}

async function build(w) {
  const fix = replacer(w);
  const { manager, script } = w;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const start = async (pipeline, values) => (await manager.start({ project: 'example', pipeline, values })).runId;
  const act = (id, name, payload = {}) => manager.action(id, name, payload);
  const TOTAL = 'apps/web/src/features/cart/total.mjs';
  const CENTS = 'apps/web/src/features/cart/cents.mjs';
  const PIN = 'apps/web/src/features/cart/total.pin.test.mjs';
  const RECORD = 'docs/records/CART-CENTS.md';

  // Explain: passed, failed (init mismatch), capped (max turns), paused-limit (usage limit).
  script.set('answer', { structured: { answer: 'charge(cents) in apps/api/src/billing/charge.mjs adds 21% tax and rounds.',
    sources: [{ path: 'apps/api/src/billing/charge.mjs', line: 1, note: 'the function' }], openQuestions: [], suggestedNote: '' } });
  let id = await start('explain', { what: 'What does charge do?' });
  snapshot(w, await waitRun(w, id, status('passed'), 'explain'), '261022-100001-explain-passed', fix);
  for (const [fixture, want, name] of [['init-mismatch-model', 'failed', 'failed'], ['max-turns', 'capped', 'capped'], ['usage-limit', 'paused-limit', 'paused-limit']]) {
    script.set('answer', { fixture });
    id = await start('explain', { what: `Where is the cart total computed (${name})?` });
    const n = { failed: 2, capped: 3, 'paused-limit': 4 }[name];
    snapshot(w, await waitRun(w, id, status(want), `explain ${name}`), `261022-10000${n}-explain-${name}`, fix);
  }

  // Running, then cancelled by you (the hang fixture never ends on its own).
  script.set('answer', { fixture: 'hang' });
  id = await start('explain', { what: 'How do sessions work?' });
  snapshot(w, await waitRun(w, id, r => r.status === 'running' && (r.stages[0].attempts || []).length > 0, 'explain running'), '261022-100005-explain-running', fix);
  await manager.cancel(id);

  // Review: waiting for triage.
  writeFileSync(join(w.main, ...TOTAL.split('/')), 'export const total = items => items.reduce((s, i) => s + i, 0) * 1;\n');
  script.set('review', { structured: { verdict: 'fix', notProven: ['Expo totals'], findings: [
    { severity: 'medium', kind: 'issue', rule: 'correctness', path: TOTAL, line: 1, claim: 'The * 1 does nothing and hides intent.', evidence: 'line 1', suggestion: 'Remove it.' },
    { severity: 'low', kind: 'follow-up', rule: 'tests', path: TOTAL, line: 0, claim: 'No test covers an empty cart.', evidence: '', suggestion: 'Add one.' }] } });
  id = await start('review', { target: 'uncommitted', focus: ['correctness', 'tests'] });
  snapshot(w, await waitRun(w, id, waiting('triage'), 'review'), '261022-100006-review-triage', fix);
  await act(id, 'triage', { decisions: [{ ref: 'F1', decision: 'fix' }, { ref: 'F2', decision: 'dismiss', reason: 'Later' }] });
  await act(id, 'done');
  await runGit(w.main, ['checkout', '--', TOTAL]);

  // The run worktree.
  id = await start('setup-worktree', {});
  await waitRun(w, id, status('passed'), 'setup-worktree');

  // Refactor: plan gate, parked, fence gate, review gate, in a terminal, committed.
  script.set('scope', { structured: { summary: 'Move the cart total into a cents helper.',
    files: [{ path: TOTAL, why: 'the math' }, { path: 'apps/web/src/features/cart/extra.mjs', why: 'a helper' }, { path: 'package.json', why: 'a script' }],
    risks: [{ kind: 'ui', path: TOTAL, note: 'the cart page shows this total' }], existingTests: ['apps/web/src/features/cart/total.test.mjs'],
    slices: [{ title: 'Cents', goal: 'total sums in cents', files: [TOTAL, 'apps/web/src/features/cart/extra.mjs', 'package.json'], tests: [PIN], outOfScope: ['Expo'], estLines: 10 }],
    questions: ['Keep the name total?'] } });
  script.set('prove', { structured: { tests: [{ path: PIN, name: 'total pins the sum', proves: 'the sum stays the same' }], notes: '' },
    writes: { [PIN]: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\n\ntest('total pins the sum', () => {\n  assert.equal(total([1, 2, 3]), 6);\n});\n" } });
  script.set('implement', { structured: { changes: [{ path: TOTAL, what: 'uses the cents helper' }, { path: CENTS, what: 'the cents helper' }, { path: RECORD, what: 'the record' }],
    recordPath: RECORD, commitMessage: 'Move cart totals into a cents helper', notProven: ['Expo cart totals'] },
  writes: { [TOTAL]: "import { sumCents } from './cents.mjs';\n\nexport const total = items => sumCents(items);\n",
    [CENTS]: 'export const sumCents = items => items.reduce((s, i) => s + i, 0);\n', [RECORD]: '# CART-CENTS\n\nThe cart total uses a cents helper.\n' } });
  script.set('review', { structured: { verdict: 'ship', notProven: ['Expo cart totals'], findings: [
    { severity: 'low', kind: 'follow-up', rule: 'naming', path: CENTS, line: 1, claim: 'sumCents could say it expects whole cents.', evidence: 'line 1', suggestion: 'A short comment.' }] } });
  id = await start('refactor', { what: 'Move cart totals into a cents helper' });
  snapshot(w, await waitRun(w, id, waiting('plan'), 'refactor plan'), '261022-100007-refactor-plan-gate', fix);
  await act(id, 'park');
  snapshot(w, await waitRun(w, id, status('parked'), 'refactor parked'), '261022-100008-refactor-parked', fix);
  await act(id, 'unpark');
  await waitRun(w, id, waiting('plan'), 'refactor unparked');
  await act(id, 'approve', { removedFiles: ['apps/web/src/features/cart/extra.mjs'], ticked: ['package.json'], answers: [{ q: 'Keep the name total?', a: 'Yes' }] });
  snapshot(w, await waitRun(w, id, waiting('fence'), 'refactor fence'), '261022-100009-refactor-fence-gate', fix);
  await act(id, 'allow', { paths: [CENTS] });
  snapshot(w, await waitRun(w, id, waiting('review'), 'refactor review gate'), '261022-100010-refactor-review-gate', fix, { gates: true });
  await act(id, 'takeover', { mode: 'acceptEdits' });
  snapshot(w, await waitRun(w, id, status('in-terminal'), 'refactor in terminal'), '261022-100011-refactor-in-terminal', fix);
  await act(id, 'back');
  await waitRun(w, id, waiting('review'), 'refactor back at the review gate');
  await act(id, 'approve');
  let run = await waitRun(w, id, waiting('commit'), 'refactor commit gate');
  const message = readFileSync(join(store.runDir(w.dataDir, run), 'final', 'commit-msg.txt'), 'utf8');
  await act(id, 'commit', { message, files: run.gatedTree.files, treeSha: run.gatedTree.treeSha });
  snapshot(w, await waitRun(w, id, status('committed'), 'refactor committed'), '261022-100012-refactor-committed', fix, { gates: true });

  // A second refactor whose change breaks the pin: two automatic fix rounds, then gates-red;
  // then cancelled by you.
  script.set('implement', { structured: { changes: [{ path: TOTAL, what: 'sums in cents' }], recordPath: '', commitMessage: 'Sum the cart in cents', notProven: [] },
    writes: { [TOTAL]: 'export const total = items => items.reduce((s, i) => s + i * 100, 0);\n' } });
  id = await start('refactor', { what: 'Sum the cart total in cents' });
  await waitRun(w, id, waiting('plan'), 'refactor 2 plan');
  await act(id, 'approve', { removedFiles: ['apps/web/src/features/cart/extra.mjs', 'package.json'] });
  snapshot(w, await waitRun(w, id, status('gates-red'), 'refactor 2 gates-red', 120_000), '261022-100013-refactor-gates-red', fix, { gates: true });
  await act(id, 'cancel');
  snapshot(w, await waitRun(w, id, status('cancelled'), 'refactor 2 cancelled'), '261022-100014-refactor-cancelled', fix);

  // Interrupted: the app closes while a stage runs.
  script.set('answer', { fixture: 'hang' });
  id = await start('explain', { what: 'How are invoices numbered?' });
  await waitRun(w, id, r => r.status === 'running' && (r.stages[0].attempts || []).length > 0, 'explain 2 running');
  await manager.shutdown();
  snapshot(w, await waitRun(w, id, status('interrupted'), 'explain interrupted'), '261022-100015-explain-interrupted', fix);

  // Nothing private may be left: the user name and the temporary folder.
  const leaks = [userInfo().username, w.base].filter(Boolean).map(s => s.toLowerCase());
  const scan = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      const text = readFileSync(full, 'utf8').toLowerCase();
      for (const l of leaks) if (text.includes(l) || text.includes(l.replace(/\\/g, '\\\\'))) throw new Error(`${full} still contains "${l}"`);
    }
  };
  scan(OUT);
  let bytes = 0;
  const size = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) size(f); else bytes += statSync(f).size; } };
  size(OUT);
  console.log(`Wrote ${readdirSync(OUT).length} run fixtures (${Math.round(bytes / 1024)} KB) to ${relative(HUB, OUT).split(sep).join('/')}.`);
}

// Builds the fixtures; the engine stops (tree-killing any fake claude) and the temporary
// workspace goes, also when a step fails.
async function main() {
  const w = await setup();
  try {
    await build(w);
  } finally {
    await w.manager.shutdown().catch(() => {});
    removeTree(w.base);
  }
}

main().then(() => process.exit(0), err => { console.error(`make.mjs: ${err.stack || err.message}`); process.exit(1); });
