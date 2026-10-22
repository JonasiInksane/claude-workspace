// Tests for probes/metrics.mjs: the health score formula, ratchet win detection, the wins log,
// the metrics file (history cap, details pruning, ids), the known-failure series from the check
// history, the health tiles, the lens table and new candidates.
// Every file is written under a temporary data folder in os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';
import {
  DETAIL_SCANS, DETAILS_CAP, MAX_SCANS, appendWins, detectWins, gitIsAncestor, healthScore, knownFailuresFrom, lensRows,
  loadDetails, loadMetrics, loadWins, metricLabel, metricValue, newCandidates, partScore, recordScan, scoreTrend, tiles,
} from './metrics.mjs';

const PROJECT = 'example';

const PROFILE = {
  probes: [
    { id: 'deepImports', kind: 'deepImports', label: 'Web deep imports', measures: 'imports into another feature' },
    { id: 'publicTs', kind: 'publicTs', label: 'public.ts boundaries', measures: 'features with a public.ts' },
    { id: 'cycles', kind: 'cycles', label: 'Import cycles', measures: 'file cycles and the largest module cycle' },
    { id: 'localeWeb', kind: 'localeParity', label: 'Missing web i18n keys', measures: 'keys missing per locale' },
    { id: 'procedures', kind: 'routerKeys', label: 'Procedures by guard', measures: 'router keys per builder' },
    { id: 'missingAssert', kind: 'missingAssert', label: 'Team procedures with no check', measures: 'keys with no check call' },
    { id: 'todo', kind: 'regexCount', label: 'TODO comments', measures: 'TODO comments', action: null },
    { id: 'expoParity', kind: 'expoParity', label: 'Mobile parity', measures: 'features with a mobile module' },
  ],
  tiles: ['knownFailures', 'cycles.largestModuleCycle', 'deepImports', 'publicTs', 'procedures.nonShopVsAllowlist', 'localeWeb', 'expoParity', 'todo'],
  lenses: ['missingAssert', 'todo'],
  score: {
    _note: 'comments are skipped',
    knownFailures: { weight: 2, target: 0, ref: 10 },
    'cycles.largestModuleCycle': { weight: 2, target: 0, ref: 8 },
    deepImports: { weight: 2, target: 0, ref: 20 },
    publicTs: { weight: 1, target: 4, ref: 0, higherIsBetter: true },
    'localeWeb.max': { weight: 1, target: 0, ref: 10 },
  },
};

// Scan values shaped like scan() returns them.
function vals(o = {}) {
  const deep = o.deep ?? 10;
  const pub = o.pub ?? 1;
  const cyc = o.cyc ?? 4;
  const loc = o.loc ?? 5;
  return {
    deepImports: { value: deep, display: String(deep), rule: o.deepRule || 'r-deep' },
    publicTs: { value: pub, of: 4, display: `${pub} of 4`, higherIsBetter: true, rule: 'r-pub' },
    cycles: { value: 3, largestModuleCycle: cyc, modules: 6, display: `${cyc} of 6 modules`, largestModules: ['a', 'b', 'c', 'd', 'e'], rule: 'r-cyc', ...(o.partial ? { partial: o.partial } : {}) },
    localeWeb: { value: loc, min: 2, max: loc, display: `2–${loc} per locale`, rule: 'r-loc' },
    procedures: { value: 12, nonShop: o.nonShop || ['orders.health', 'teams.mine'], filtered: false, rule: 'r-proc' },
    missingAssert: { value: o.ma ?? 2, display: String(o.ma ?? 2), rule: 'r-ma' },
    todo: { value: 7, display: '7', rule: 'r-todo' },
    expoParity: { value: o.expo ?? 50, display: `${o.expo ?? 50}%`, higherIsBetter: true, missing: ['maps', 'pos'], rule: 'r-expo' },
  };
}

const result = (values, o = {}) => ({
  at: o.at || '2026-10-22T10:00:00.000Z', sha: o.sha === undefined ? 'a'.repeat(40) : o.sha, branch: o.branch || null,
  node: '24.11.1', durationMs: 1200, values, details: o.details || {}, errors: o.errors || {}, missing: [],
});

const dataDir = t => tempDir('wp6-metrics-', t);

// ---------------------------------------------------------------- score

test('partScore is 1 at the target, 0 at the reference point, linear between, clamped', () => {
  assert.equal(partScore(5, 0, 10), 0.5);
  assert.equal(partScore(0, 0, 10), 1);
  assert.equal(partScore(-3, 0, 10), 1);
  assert.equal(partScore(10, 0, 10), 0);
  assert.equal(partScore(25, 0, 10), 0);
  assert.equal(partScore(1, 4, 0, true), 0.25);
  assert.equal(partScore(9, 4, 0, true), 1);
  assert.equal(partScore(-1, 4, 0, true), 0);
  assert.equal(partScore(3, 3, 3), 1);
  assert.equal(partScore(4, 3, 3), 0);
});

test('healthScore is round(100 × Σ weight·part / Σ weight) over the metrics that have a value', () => {
  // cycles 4 of ref 8: 0.5 × 2; deep 10 of ref 20: 0.5 × 2; publicTs 1 of 4: 0.25 × 1;
  // localeWeb.max 5 of ref 10: 0.5 × 1. knownFailures has no value, so it is left out: 2.75 / 6.
  assert.equal(healthScore(PROFILE, vals()), 46);
  // With knownFailures 5 of ref 10 (0.5 × 2): 3.75 / 8 = 46.875.
  assert.equal(healthScore(PROFILE, { ...vals(), knownFailures: { value: 5 } }), 47);
  assert.equal(healthScore(PROFILE, { ...vals({ deep: 0, cyc: 0, pub: 4, loc: 0 }), knownFailures: { value: 0 } }), 100);
  assert.equal(healthScore(PROFILE, { ...vals({ deep: 99, cyc: 99, pub: 0, loc: 99 }), knownFailures: { value: 99 } }), 0);
  // A bare number counts as a value too.
  assert.equal(healthScore({ score: { x: { weight: 1, target: 0, ref: 4 } } }, { x: 1 }), 75);
  assert.equal(healthScore(PROFILE, {}), null);
  assert.equal(healthScore({}, vals()), null);
  assert.equal(healthScore({ score: { deepImports: { weight: 0, target: 0, ref: 20 } } }, vals()), null);
});

test('healthScore takes a fallback value for a metric with none, so a failed probe cannot raise it', () => {
  // cycles 8 of ref 8: 0 × 2; deep 0.5 × 2; publicTs 0.25 × 1; localeWeb.max 0.5 × 1: 1.75 / 6 = 29.
  const all = vals({ cyc: 8 });
  assert.equal(healthScore(PROFILE, all), 29);
  // Left out, the failed cycles probe would raise the score to 1.75 / 4 = 44.
  const { cycles, ...failed } = all;
  assert.equal(healthScore(PROFILE, failed), 44);
  const asked = [];
  const fallback = path => { asked.push(path); return path === 'cycles.largestModuleCycle' ? 8 : null; };
  assert.equal(healthScore(PROFILE, failed, { fallback }), 29);
  assert.deepEqual(asked.sort(), ['cycles.largestModuleCycle', 'knownFailures']);
  assert.equal(healthScore(PROFILE, failed, { fallback: () => 'not a number' }), 44);
});

test('metricValue and metricLabel read metric paths', () => {
  const v = vals();
  assert.equal(metricValue(v, 'deepImports'), 10);
  assert.equal(metricValue(v, 'cycles.largestModuleCycle'), 4);
  assert.equal(metricValue(v, 'localeWeb.max'), 5);
  assert.equal(metricValue(v, 'cycles.nope'), null);
  assert.equal(metricValue(v, 'nope'), null);
  assert.equal(metricValue({ n: 3 }, 'n'), 3);
  assert.equal(metricValue({ n: 3 }, 'n.x'), null);
  assert.equal(metricLabel(PROFILE, 'cycles.largestModuleCycle'), 'Import cycles (largest module cycle)');
  assert.equal(metricLabel(PROFILE, 'localeWeb.max'), 'Missing web i18n keys (worst locale)');
  assert.equal(metricLabel(PROFILE, 'knownFailures'), 'Known test failures');
  assert.equal(metricLabel(PROFILE, 'procedures.nonShopVsAllowlist'), 'Non-shop procedures');
  assert.equal(metricLabel(null, 'other.thing'), 'other (thing)');
});

// ---------------------------------------------------------------- wins

test('detectWins: lower is better unless higherIsBetter, and only tracked metrics count', () => {
  const via = { kind: 'commit', sha: '7b3e9c1', branch: 'app/1022-x', runId: 'r1' };
  const at = '2026-10-22T11:00:00.000Z';
  const wins = detectWins(vals({ deep: 10, pub: 1, cyc: 4, loc: 5 }), vals({ deep: 8, pub: 2, cyc: 5, loc: 3 }), via, { profile: PROFILE, at });
  assert.deepEqual(wins, [
    { at, kind: 'ratchet', metric: 'deepImports', label: 'Web deep imports', from: 10, to: 8, via },
    { at, kind: 'ratchet', metric: 'publicTs', label: 'public.ts boundaries', from: 1, to: 2, via },
    // localeWeb and localeWeb.max moved together: one win, under the plain metric.
    { at, kind: 'ratchet', metric: 'localeWeb', label: 'Missing web i18n keys', from: 5, to: 3, via },
  ]);
  assert.deepEqual(detectWins(vals({ deep: 8 }), vals({ deep: 10 }), null, { profile: PROFILE }), []);
  assert.deepEqual(detectWins(vals({ pub: 2 }), vals({ pub: 1 }), null, { profile: PROFILE }), []);
  const cyc = detectWins(vals({ cyc: 6 }), vals({ cyc: 4 }), null, { profile: PROFILE });
  assert.deepEqual(cyc.map(w => [w.metric, w.label, w.from, w.to, w.via]), [['cycles.largestModuleCycle', 'Import cycles (largest module cycle)', 6, 4, null]]);
  // expoParity is a tile with no score entry: its kind says higher is better.
  assert.deepEqual(detectWins(vals({ expo: 50 }), vals({ expo: 60 }), null, { profile: PROFILE }).map(w => w.metric), ['expoParity']);
  assert.deepEqual(detectWins(null, vals(), null), []);
});

test('detectWins never counts a changed probe rule or a partial graph on one side as progress', () => {
  assert.deepEqual(detectWins(vals({ deep: 10 }), vals({ deep: 2, deepRule: 'r-other' }), null, { profile: PROFILE }), []);
  assert.deepEqual(detectWins(vals({ cyc: 6 }), vals({ cyc: 2, partial: 30 }), null, { profile: PROFILE }), []);
  assert.deepEqual(detectWins(vals({ cyc: 6, partial: 3 }), vals({ cyc: 2, partial: 4 }), null, { profile: PROFILE }).map(w => w.metric), ['cycles.largestModuleCycle']);
  // A metric missing on either side is skipped.
  const { deepImports, ...noDeep } = vals();
  assert.deepEqual(detectWins(noDeep, vals({ deep: 1 }), null, { profile: PROFILE }), []);
});

test('detectWins skips a probe that warned about its input on either side', () => {
  const warned = (values, warning) => ({ ...values, cycles: { ...values.cycles, warning } });
  const why = 'The madge graph paths were not found under api, so the cycle paths may be wrong.';
  assert.deepEqual(detectWins(vals({ cyc: 6 }), warned(vals({ cyc: 0 }), why), null, { profile: PROFILE }), []);
  assert.deepEqual(detectWins(warned(vals({ cyc: 6 }), why), vals({ cyc: 2 }), null, { profile: PROFILE }), []);
  // Other probes in the same scan still count.
  assert.deepEqual(detectWins(vals({ cyc: 6, deep: 10 }), warned(vals({ cyc: 0, deep: 9 }), why), null, { profile: PROFILE }).map(w => w.metric), ['deepImports']);
});

test('detectWins without a profile compares every probe value, lower is better', () => {
  const wins = detectWins({ a: { value: 5 }, b: { value: 1, higherIsBetter: true }, c: { value: 2 } },
    { a: { value: 4 }, b: { value: 2, higherIsBetter: true }, c: { value: 3 } }, { kind: 'scan' });
  assert.deepEqual(wins.map(w => [w.metric, w.from, w.to]), [['a', 5, 4], ['b', 1, 2]]);
});

test('appendWins logs a ratchet win once per 30 days and an achievement once', async t => {
  const dir = dataDir(t);
  const old = { at: '2026-08-01T10:00:00.000Z', kind: 'ratchet', metric: 'todo', label: 'TODO comments', from: 9, to: 8, via: null };
  writeFiles(dir, { 'wins/example.jsonl': `${JSON.stringify(old)}\n` });
  const now = new Date().toISOString();
  const win = { at: now, kind: 'ratchet', metric: 'deepImports', label: 'Web deep imports', from: 10, to: 8, via: { kind: 'commit', sha: 'abc' } };
  const again = { ...win, via: { kind: 'scan', scanId: 's-261022-100000' } };
  const repeatOld = { ...old, at: now };
  const badge = { at: now, kind: 'achievement', id: 'boundary-builder', label: 'Boundary builder' };
  assert.deepEqual(await appendWins(dir, PROJECT, [win, badge, null, { kind: 7 }]), [win, badge]);
  assert.deepEqual(await appendWins(dir, PROJECT, [again, badge, repeatOld]), [repeatOld]);
  assert.deepEqual(await appendWins(dir, PROJECT, []), []);
  const lines = readFileSync(join(dir, 'wins', 'example.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, [old, win, badge, repeatOld]);
  assert.deepEqual(await loadWins(dir, PROJECT, { limit: 2 }), [repeatOld, badge]);
  await assert.rejects(appendWins(dir, 'Bad Name', [win]), /is not a project name/);
});

// ---------------------------------------------------------------- known failures from the checks

test('knownFailuresFrom reads one level of the check history, standard first', async t => {
  const dir = dataDir(t);
  assert.equal(await knownFailuresFrom(dir, PROJECT), null);
  const line = (at, level, known, res = 'fail') => JSON.stringify({ at, runId: 'r', level, result: res, chip: '', counts: { new: 0, known, flaky: 0 } });
  writeFiles(dir, {
    'checks/example/history.jsonl': [
      line('2026-10-10T10:00:00.000Z', 'standard', 61),
      line('2026-10-16T10:00:00.000Z', 'standard', 60),
      line('2026-10-18T10:00:00.000Z', 'quick', 3),
      line('2026-10-20T10:00:00.000Z', 'standard', 58),
      line('2026-10-21T10:00:00.000Z', 'standard', 0, 'refused'),
      '{"torn": ',
      line('2026-10-22T10:00:00.000Z', 'standard', 57, 'pass'),
      '',
    ].join('\n'),
  });
  // The week window starts at the oldest line within 7 days of the latest one (60 on 10-16).
  assert.deepEqual(await knownFailuresFrom(dir, PROJECT), { value: 57, spark: [61, 60, 58, 57], weekAgo: 60, level: 'standard', at: '2026-10-22T10:00:00.000Z' });
  const quickOnly = dataDir(t);
  writeFiles(quickOnly, { 'checks/example/history.jsonl': `${line('2026-10-18T10:00:00.000Z', 'quick', 3)}\n` });
  assert.equal((await knownFailuresFrom(quickOnly, PROJECT)).level, 'quick');
});

// ---------------------------------------------------------------- the metrics file

test('recordScan saves the scan, its details and the score in the data folder', async t => {
  const dir = dataDir(t);
  const details = { deepImports: Array.from({ length: DETAILS_CAP + 20 }, (_, i) => ({ path: `f${i}.ts`, line: i, text: 'x' })) };
  const r = await recordScan(dir, PROJECT, result(vals(), { details, branch: 'main' }), { profile: PROFILE, knownFailures: 5 });
  assert.match(r.scanId, /^s-\d{6}-\d{6}$/);
  assert.equal(r.score, 47);
  assert.deepEqual(r.wins, []);
  const doc = await loadMetrics(dir, PROJECT);
  assert.equal(doc.version, 1);
  assert.equal(doc.project, PROJECT);
  assert.equal(doc.scans.length, 1);
  const s = doc.scans[0];
  assert.deepEqual(Object.keys(s), ['id', 'at', 'sha', 'branch', 'durationMs', 'node', 'values', 'errors', 'score']);
  assert.equal(s.id, r.scanId);
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.values.knownFailures, { value: 5, display: '5' });
  assert.equal(s.values.deepImports.value, 10);
  const saved = await loadDetails(dir, PROJECT, r.scanId);
  assert.equal(saved.deepImports.length, DETAILS_CAP);
  assert.deepEqual(readdirSync(dir).sort(), ['metrics']);
  assert.ok(existsSync(join(dir, 'metrics', 'example', `${r.scanId}.details.json`)));
  await assert.rejects(recordScan(dir, PROJECT, { values: null }), /has no values/);
  await assert.rejects(recordScan(dir, '../x', result(vals())), /is not a project name/);
});

test('recordScan refuses a scan limited to some probes or files', async t => {
  const dir = dataDir(t);
  await assert.rejects(recordScan(dir, PROJECT, { ...result(vals()), subset: true }, { profile: PROFILE, knownFailures: null }),
    { message: 'Only full scans are saved; this scan ran only some probes or files.' });
  assert.deepEqual((await loadMetrics(dir, PROJECT)).scans, []);
});

test('recordScan scores a failed probe with its last stored value', async t => {
  const dir = dataDir(t);
  const opts = { profile: PROFILE, knownFailures: null };
  // The numbers are the healthScore test's: 29 with cycles at its reference point, 44 without it.
  const ok = await recordScan(dir, PROJECT, result(vals({ cyc: 8 }), { sha: 'a1' }), opts);
  assert.equal(ok.score, 29);
  const { cycles, ...rest } = vals({ cyc: 8 });
  const broken = await recordScan(dir, PROJECT, result(rest, { sha: 'b2', errors: { cycles: 'madge not installed in this tree' } }), opts);
  assert.equal(broken.score, 29, 'madge breaking is not progress');
  const doc = await loadMetrics(dir, PROJECT);
  assert.deepEqual(doc.scans[1].scoreCarried, ['cycles.largestModuleCycle']);
  assert.equal(doc.scans[0].scoreCarried, undefined);
  // A metric missing without a probe error (the probe isn't in the scan) is not carried.
  const gone = await recordScan(dir, PROJECT, result(rest, { sha: 'c3' }), opts);
  assert.equal(gone.score, 44);
  // With no earlier value to carry the metric is left out, as before.
  const fresh = dataDir(t);
  assert.equal((await recordScan(fresh, PROJECT, result(rest, { errors: { cycles: 'x' } }), opts)).score, 44);
});

test('recordScan logs wins against the previous scan only when the commit changed', async t => {
  const dir = dataDir(t);
  const opts = { profile: PROFILE, knownFailures: null };
  await recordScan(dir, PROJECT, result(vals({ deep: 10 }), { sha: 'a1', at: '2026-10-20T10:00:00.000Z' }), opts);
  const second = await recordScan(dir, PROJECT, result(vals({ deep: 8 }), { sha: 'b2', at: '2026-10-21T10:00:00.000Z', branch: 'main' }), opts);
  assert.deepEqual(second.wins.map(w => [w.metric, w.from, w.to]), [['deepImports', 10, 8]]);
  assert.deepEqual(second.wins[0].via, { kind: 'scan', scanId: second.scanId, sha: 'b2', branch: 'main' });
  assert.equal(second.wins[0].at, '2026-10-21T10:00:00.000Z');
  // Same commit again: no win, even though the number dropped (the probe or tree changed, not the code).
  const same = await recordScan(dir, PROJECT, result(vals({ deep: 6 }), { sha: 'b2', at: '2026-10-21T11:00:00.000Z' }), opts);
  assert.deepEqual(same.wins, []);
  // A scan without a sha can't be compared, and later scans compare with the last one that has one.
  const noSha = await recordScan(dir, PROJECT, result(vals({ deep: 4 }), { sha: null, at: '2026-10-21T12:00:00.000Z' }), opts);
  assert.deepEqual(noSha.wins, []);
  // The commit gate logs a win (as the executor does); the next scan finds the same win and does
  // not log it twice.
  const via = { kind: 'commit', sha: 'c3', branch: 'app/1022-x', runId: 'r9' };
  assert.equal((await appendWins(dir, PROJECT, detectWins(vals({ deep: 6 }), vals({ deep: 3 }), via, { profile: PROFILE }))).length, 1);
  const after = await recordScan(dir, PROJECT, result(vals({ deep: 3 }), { sha: 'c3', at: '2026-10-22T09:00:00.000Z' }), opts);
  assert.deepEqual(after.wins, []);
  const lines = readFileSync(join(dir, 'wins', 'example.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(w => [w.from, w.to, w.via.kind]), [[10, 8, 'scan'], [6, 3, 'commit']]);
  // `via` credits the scan's wins to something else.
  const credited = await recordScan(dir, PROJECT, result(vals({ deep: 1 }), { sha: 'd4', at: '2026-10-22T10:00:00.000Z' }), { ...opts, via });
  assert.deepEqual(credited.wins.map(w => [w.from, w.to, w.via]), [[3, 1, via]]);
});

test('recordScan without git logs no wins across a branch switch', async t => {
  const dir = dataDir(t);
  const opts = { profile: PROFILE, knownFailures: null };
  await recordScan(dir, PROJECT, result(vals({ deep: 10 }), { sha: 'a1', branch: 'feature-a' }), opts);
  const other = await recordScan(dir, PROJECT, result(vals({ deep: 8 }), { sha: 'b2', branch: 'feature-b' }), opts);
  assert.deepEqual(other.wins, []);
  const next = await recordScan(dir, PROJECT, result(vals({ deep: 7 }), { sha: 'b3', branch: 'feature-b' }), opts);
  assert.deepEqual(next.wins.map(w => [w.from, w.to]), [[8, 7]]);
});

test('recordScan compares only with a scan of an ancestor commit', async t => {
  const dir = dataDir(t);
  // main: m1 -> m2 -> m3; side branches off m1 with s1. Ancestors of each commit:
  const history = { m1: [], m2: ['m1'], s1: ['m1'], m3: ['m1', 'm2'] };
  const asked = [];
  const isAncestor = async (older, newer) => { asked.push(`${older}<${newer}`); return history[newer].includes(older); };
  const opts = { profile: PROFILE, knownFailures: null, isAncestor };
  const at = n => `2026-10-2${n}T10:00:00.000Z`;
  await recordScan(dir, PROJECT, result(vals({ deep: 10 }), { sha: 'm2', at: at(0) }), opts);
  // The side branch has fewer deep imports, but m2 is not its ancestor: no win.
  assert.deepEqual((await recordScan(dir, PROJECT, result(vals({ deep: 6 }), { sha: 's1', at: at(1) }), opts)).wins, []);
  // Back on main at m2 (a commit scanned before): no win for 6 -> 10 or anything else.
  assert.deepEqual((await recordScan(dir, PROJECT, result(vals({ deep: 10 }), { sha: 'm2', at: at(2) }), opts)).wins, []);
  // m3 skips the side scan and compares with m2.
  asked.length = 0;
  const m3 = await recordScan(dir, PROJECT, result(vals({ deep: 9 }), { sha: 'm3', at: at(3) }), opts);
  assert.deepEqual(m3.wins.map(w => [w.metric, w.from, w.to]), [['deepImports', 10, 9]]);
  assert.deepEqual(asked, ['m2<m3']);
  // Checking out an older commit with better numbers is not a win either.
  assert.deepEqual((await recordScan(dir, PROJECT, result(vals({ deep: 4 }), { sha: 'm1', at: at(4) }), opts)).wins, []);
});

test('recordScan asks git in the scanned tree which earlier scan is an ancestor', async t => {
  const repo = tempDir('wp6-ancestry-', t);
  const m1 = await makeRepo(repo, { files: { 'a.txt': 'one\n' } });
  await runGit(repo, ['checkout', '-q', '-b', 'side']);
  writeFiles(repo, { 'b.txt': 'side\n' });
  const s1 = await commitAll(repo, 'side');
  await runGit(repo, ['checkout', '-q', 'main']);
  writeFiles(repo, { 'c.txt': 'main\n' });
  const m2 = await commitAll(repo, 'main');
  assert.equal(await gitIsAncestor(repo, m1, m2), true);
  assert.equal(await gitIsAncestor(repo, s1, m2), false);
  assert.equal(await gitIsAncestor(repo, '0'.repeat(40), m2), null);
  assert.equal(await gitIsAncestor(repo, '--all', m2), null, 'only commit ids reach git');
  const dir = dataDir(t);
  const opts = { profile: PROFILE, knownFailures: null };
  const scanAt = (sha, deep, n) => ({ ...result(vals({ deep }), { sha, at: `2026-10-2${n}T10:00:00.000Z` }), tree: repo });
  await recordScan(dir, PROJECT, scanAt(m1, 10, 0), opts);
  // The side branch grew from m1, so its drop is real progress there.
  assert.deepEqual((await recordScan(dir, PROJECT, scanAt(s1, 6, 1), opts)).wins.map(w => [w.from, w.to]), [[10, 6]]);
  // m2 is compared with m1, not with the side branch it doesn't contain.
  const win = await recordScan(dir, PROJECT, scanAt(m2, 9, 2), opts);
  assert.deepEqual(win.wins.map(w => [w.from, w.to, w.via.sha]), [[10, 9, m2]]);
});

test('recordScan uses the stored profile and the check history when the caller passes neither', async t => {
  const dir = dataDir(t);
  writeFiles(dir, {
    'profiles/example.json': { ...PROFILE, version: 1, project: PROJECT },
    'checks/example/history.jsonl': `${JSON.stringify({ at: '2026-10-22T08:00:00.000Z', level: 'standard', result: 'fail', counts: { new: 0, known: 5, flaky: 0 } })}\n`,
  });
  const r = await recordScan(dir, PROJECT, result(vals()));
  assert.equal(r.score, 47);
  const doc = await loadMetrics(dir, PROJECT);
  assert.deepEqual(doc.scans[0].values.knownFailures, { value: 5, display: '5' });
  const none = await recordScan(dir, PROJECT, result(vals()), { profile: null, knownFailures: null });
  assert.equal(none.score, null);
  assert.equal((await loadMetrics(dir, PROJECT)).scans[1].values.knownFailures, undefined);
  // No profile file at all: the scan is still saved, without a score.
  const bare = dataDir(t);
  assert.equal((await recordScan(bare, PROJECT, result(vals()))).score, null);
});

test('recordScan keeps 200 scans and the details of the last 20, and never reuses an id', async t => {
  const dir = dataDir(t);
  const old = Array.from({ length: MAX_SCANS }, (_, i) => ({ id: `s-250101-${String(i).padStart(6, '0')}`, at: '2025-01-01T00:00:00.000Z', values: { deepImports: { value: i } }, errors: {} }));
  writeFiles(dir, {
    'metrics/example.json': { version: 1, project: PROJECT, scans: old },
    [`metrics/example/${old[0].id}.details.json`]: {},
    [`metrics/example/${old[MAX_SCANS - 1].id}.details.json`]: {},
    'metrics/example/notes.txt': 'not a details file, kept',
  });
  const at = '2026-10-22T10:00:00.000Z';
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await recordScan(dir, PROJECT, result(vals(), { at }), { profile: null, knownFailures: null })).scanId);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[1], `${ids[0]}-2`);
  assert.equal(ids[2], `${ids[0]}-3`);
  const doc = await loadMetrics(dir, PROJECT);
  assert.equal(doc.scans.length, MAX_SCANS);
  assert.equal(doc.scans[0].id, old[3].id);
  assert.deepEqual(doc.scans.slice(-3).map(s => s.id), ids);
  const files = readdirSync(join(dir, 'metrics', 'example')).sort();
  assert.ok(files.includes('notes.txt'));
  assert.ok(!files.includes(`${old[0].id}.details.json`));
  assert.ok(files.includes(`${old[MAX_SCANS - 1].id}.details.json`));
  // Fill up past 20 stored details: only the newest 20 stay.
  for (let i = 0; i < DETAIL_SCANS; i++) {
    await recordScan(dir, PROJECT, result(vals(), { at: `2026-10-23T10:00:${String(i).padStart(2, '0')}.000Z` }), { profile: null, knownFailures: null });
  }
  const after = readdirSync(join(dir, 'metrics', 'example')).filter(f => f.endsWith('.details.json'));
  assert.equal(after.length, DETAIL_SCANS);
  assert.equal(await loadDetails(dir, PROJECT, ids[0]), null);
});

test('two scans recorded at the same moment both land in the file', async t => {
  const dir = dataDir(t);
  const opts = { profile: PROFILE, knownFailures: null };
  const [a, b] = await Promise.all([
    recordScan(dir, PROJECT, result(vals({ deep: 9 }), { sha: 'x1' }), opts),
    recordScan(dir, PROJECT, result(vals({ deep: 7 }), { sha: 'x2' }), opts),
  ]);
  assert.notEqual(a.scanId, b.scanId);
  const doc = await loadMetrics(dir, PROJECT);
  assert.deepEqual(doc.scans.map(s => s.values.deepImports.value), [9, 7]);
});

test('loadMetrics gives an empty history for a new project and refuses a broken file', async t => {
  const dir = dataDir(t);
  assert.deepEqual(await loadMetrics(dir, PROJECT), { version: 1, project: PROJECT, scans: [] });
  writeFiles(dir, { 'metrics/example.json': '{ "scans": ' });
  await assert.rejects(loadMetrics(dir, PROJECT), /example\.json is not valid JSON/);
  writeFiles(dir, { 'metrics/example.json': { version: 1, scans: 'nope' } });
  await assert.rejects(loadMetrics(dir, PROJECT), /has no scans list/);
  writeFiles(dir, { 'metrics/example.json': { version: 1, scans: [null, { id: 'x' }, { id: 'y', values: {} }] } });
  assert.deepEqual((await loadMetrics(dir, PROJECT)).scans.map(s => s.id), ['y']);
});

// ---------------------------------------------------------------- tiles

// Four scans: one old (outside the week), then 6 days, 2 days and 0 days before the last.
function history(last = {}, lastErrors = {}) {
  const scan = (at, values, errors = {}) => ({ id: `s-${at.slice(2, 10).replace(/-/g, '')}-100000`, at, sha: 'x', values, errors, score: null });
  return {
    version: 1,
    project: PROJECT,
    scans: [
      scan('2026-10-01T10:00:00.000Z', vals({ deep: 20, pub: 0, cyc: 6, expo: 40 })),
      scan('2026-10-16T10:00:00.000Z', vals({ deep: 12, pub: 1, cyc: 5, expo: 40 })),
      scan('2026-10-20T10:00:00.000Z', vals({ deep: 11, pub: 2, cyc: 5, expo: 45 })),
      scan('2026-10-22T10:00:00.000Z', { ...vals({ deep: 9, pub: 2, cyc: 5, expo: 50 }), ...last }, lastErrors),
    ],
  };
}

const byId = list => Object.fromEntries(list.map(t => [t.id, t]));

test('tiles show value, week trend, spark, summary and the action for each metric family', () => {
  const list = tiles(PROFILE, history(), { knownFailures: { value: 3, spark: [5, 4, 3], weekAgo: 5 } });
  assert.deepEqual(list.map(x => x.id), PROFILE.tiles);
  const t = byId(list);
  assert.deepEqual(t.deepImports, {
    id: 'deepImports', label: 'Web deep imports', measures: 'imports into another feature', value: 9, display: '9',
    trend: 'better', delta: -3, spark: [20, 12, 11, 9], summary: '9, down 3 this week', note: '',
    action: { pipeline: 'refactor', what: 'Add a public.ts boundary to one web feature' }, badge: null,
  });
  assert.equal(t.publicTs.display, '2 of 4');
  assert.equal(t.publicTs.trend, 'better');
  assert.equal(t.publicTs.summary, '2, up 1 this week');
  assert.deepEqual(t.publicTs.action, { pipeline: 'refactor', what: 'Add a public.ts boundary to one web feature' });
  const cyc = t['cycles.largestModuleCycle'];
  assert.equal(cyc.label, 'Import cycles (largest module cycle)');
  assert.equal(cyc.display, '5 of 6 modules');
  assert.equal(cyc.trend, 'same');
  assert.equal(cyc.summary, '5, no change this week');
  assert.deepEqual(cyc.action, { pipeline: 'refactor', what: 'Untangle the module cycle around a, b, c, d' });
  assert.deepEqual(cyc.spark, [6, 5, 5, 5]);
  assert.equal(t.localeWeb.display, '2–5 per locale');
  assert.deepEqual(t.localeWeb.action, { pipeline: 'feature', what: 'Fill the missing i18n keys for one locale' });
  assert.equal(t.expoParity.trend, 'better');
  assert.deepEqual(t.expoParity.action, { pipeline: 'feature', what: 'Expo parity: add a module for maps' });
  assert.equal(t.todo.action, null);
  assert.deepEqual([t.knownFailures.value, t.knownFailures.trend, t.knownFailures.delta, t.knownFailures.summary], [3, 'better', -2, '3, down 2 this week']);
  assert.deepEqual(t.knownFailures.spark, [5, 4, 3]);
  assert.deepEqual(t.knownFailures.action, { pipeline: 'fix', what: 'Fix the known test failures' });
});

test('tiles: a worse trend, a goal reached and a partial graph', () => {
  const t = byId(tiles(PROFILE, history({ deepImports: { value: 0, display: '0', rule: 'r-deep' }, cycles: { ...vals().cycles, largestModuleCycle: 7, partial: 12 } })));
  assert.equal(t.deepImports.badge, 'At goal');
  assert.equal(t.deepImports.action, null);
  assert.equal(t['cycles.largestModuleCycle'].trend, 'worse');
  assert.equal(t['cycles.largestModuleCycle'].summary, '7, up 2 this week');
  assert.equal(t['cycles.largestModuleCycle'].badge, 'Partial graph');
  assert.match(t['cycles.largestModuleCycle'].note, /^Partial graph: 12 imports did not resolve/);
});

test('a value the probe warned about is never shown as a goal reached', () => {
  const warning = 'The madge graph paths were not found under api, so the cycle paths may be wrong.';
  const t = byId(tiles(PROFILE, history({ cycles: { ...vals().cycles, largestModuleCycle: 0, warning } })));
  const tile = t['cycles.largestModuleCycle'];
  assert.equal(tile.value, 0);
  assert.equal(tile.badge, null);
  assert.equal(tile.note, warning);
  assert.equal(tile.action.pipeline, 'refactor');
});

test('a probe that failed in the last scan shows the reason on its tile', () => {
  const { cycles, ...rest } = vals();
  const metrics = history({}, { cycles: 'madge not installed in this tree' });
  metrics.scans[3].values = rest;
  const tile = byId(tiles(PROFILE, metrics))['cycles.largestModuleCycle'];
  assert.equal(tile.display, '—');
  assert.equal(tile.note, 'probe failed: madge not installed in this tree');
  assert.equal(tile.summary, 'probe failed: madge not installed in this tree');
  assert.equal(tile.badge, 'Probe failed');
  assert.equal(tile.value, null);
  assert.deepEqual(tile.spark, [6, 5, 5]);
});

test('the non-shop procedures tile compares the last scan with the allowlist', () => {
  const metrics = history();
  const id = 'procedures.nonShopVsAllowlist';
  const none = byId(tiles(PROFILE, metrics))[id];
  assert.equal(none.label, 'Non-shop procedures');
  assert.equal(none.badge, 'No allowlist');
  assert.equal(none.display, '2 non-shop');
  assert.match(none.note, /Rebuild the allowlist/);
  const inside = byId(tiles(PROFILE, metrics, { allowlist: ['orders.health', 'teams.mine', 'old.gone'] }))[id];
  assert.equal(inside.badge, 'Within allowlist');
  assert.equal(inside.display, '2 of 2 allowed');
  assert.equal(inside.outside, 0);
  assert.equal(inside.action, null);
  const outside = byId(tiles(PROFILE, metrics, { allowlist: ['orders.health'] }))[id];
  assert.equal(outside.badge, '1 outside the allowlist');
  assert.equal(outside.note, 'Not on the allowlist: teams.mine');
  assert.equal(outside.display, '1 of 2 allowed');
  const failed = history({}, { procedures: 'probe broke' });
  delete failed.scans[3].values.procedures;
  assert.equal(byId(tiles(PROFILE, failed, { allowlist: [] }))[id].note, 'probe failed: probe broke');
});

test('the known failures tile: no baseline, at zero, a plain number and a tracking finding', () => {
  const kf = knownFailures => byId(tiles(PROFILE, history(), { knownFailures })).knownFailures;
  assert.equal(kf(null).display, 'No baseline yet');
  assert.equal(kf(null).value, null);
  assert.equal(kf(0).badge, 'At goal');
  assert.equal(kf(0).action, null);
  assert.deepEqual([kf(4).display, kf(4).spark, kf(4).trend], ['4', [4], 'same']);
  assert.deepEqual(kf({ value: 4, finding: 'EX-12' }).action, { pipeline: 'fix', what: 'Fix EX-12: the known test failures', finding: 'EX-12' });
});

test('tile actions can be replaced or hidden by the caller', () => {
  const actions = { deepImports: { pipeline: 'refactor', what: 'Split the cart feature', finding: 'EX-3' }, localeWeb: null, knownFailures: { pipeline: 'fix', what: 'EX-1' } };
  const t = byId(tiles(PROFILE, history(), { knownFailures: 2, actions }));
  assert.deepEqual(t.deepImports.action, { pipeline: 'refactor', what: 'Split the cart feature', finding: 'EX-3' });
  assert.equal(t.localeWeb.action, null);
  assert.deepEqual(t.knownFailures.action, { pipeline: 'fix', what: 'EX-1' });
  assert.deepEqual(t.publicTs.action, { pipeline: 'refactor', what: 'Add a public.ts boundary to one web feature' });
});

test('tiles before the first scan say so', () => {
  const list = tiles(PROFILE, { scans: [] });
  assert.equal(list.length, PROFILE.tiles.length);
  const t = byId(list);
  assert.equal(t.deepImports.display, 'No scan yet');
  assert.deepEqual(t.deepImports.spark, []);
  assert.equal(t.deepImports.action, null);
  assert.deepEqual(tiles(null, null), []);
});

test('scoreTrend and lensRows summarise the history', () => {
  const metrics = history();
  metrics.scans.forEach((s, i) => { s.score = [40, 50, 55, 60][i]; });
  assert.deepEqual(scoreTrend(metrics), { value: 60, delta: 10, trend: 'better', spark: [40, 50, 55, 60] });
  assert.deepEqual(scoreTrend({ scans: [] }), { value: null, delta: 0, trend: 'same', spark: [] });
  metrics.scans[2].values.missingAssert.value = 4;
  assert.deepEqual(lensRows(PROFILE, metrics), [
    { id: 'missingAssert', label: 'Team procedures with no check', measures: 'keys with no check call', now: 2, change: '−2', delta: -2, error: '' },
    { id: 'todo', label: 'TODO comments', measures: 'TODO comments', now: 7, change: 'same', delta: 0, error: '' },
  ]);
  const first = { scans: [metrics.scans[0]] };
  assert.equal(lensRows(PROFILE, first)[0].change, 'first scan');
  const broken = history({}, { todo: 'bad regex' });
  assert.deepEqual(lensRows(PROFILE, broken)[1], { id: 'todo', label: 'TODO comments', measures: 'TODO comments', now: null, change: '', delta: null, error: 'bad regex' });
});

// ---------------------------------------------------------------- new candidates

test('newCandidates lists lens items not in the previous scan, by path and text', () => {
  const prev = {
    missingAssert: [{ path: 'api/a/router.ts', line: 10, text: 'a.list: teamProcedure' }],
    todo: [{ path: 'api/x.ts', line: 1, text: '// TODO one' }],
  };
  const next = {
    // The same item on another line is not new.
    missingAssert: [{ path: 'api/a/router.ts', line: 14, text: 'a.list: teamProcedure' }, { path: 'api/a/router.ts', line: 20, text: 'a.wipe: teamProcedure' }],
    todo: [{ path: 'api/x.ts', line: 1, text: '// TODO one' }, { path: 'api/y.ts', line: 3, text: '// TODO two' }, { path: 'api/y.ts', line: 9, text: '// TODO two' }],
    // A probe the previous scan didn't have is not compared, so it can't flood the list.
    fresh: [{ path: 'z.ts', line: 1, text: 'z' }],
  };
  const ids = ['missingAssert', 'todo', 'fresh'];
  assert.deepEqual(newCandidates(prev, next, { ids }), [
    { probe: 'missingAssert', path: 'api/a/router.ts', line: 20, text: 'a.wipe: teamProcedure' },
    { probe: 'todo', path: 'api/y.ts', line: 3, text: '// TODO two' },
  ]);
  assert.deepEqual(newCandidates(prev, next, { ids: ['todo'] }).map(c => c.probe), ['todo']);
  assert.equal(newCandidates(prev, next, { ids, max: 1 }).length, 1);
  assert.deepEqual(newCandidates(null, next, { ids }), []);
  assert.deepEqual(newCandidates({}, next, { ids }), []);
  const many = { todo: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, line: 1, text: 't' })) };
  assert.equal(newCandidates({ todo: [] }, many, { ids }).length, 30);
});

test('newCandidates compares the lenses only: ids or the profile are required', () => {
  const prev = { missingAssert: [], todo: [], procedures: [] };
  const next = {
    missingAssert: [{ path: 'a.ts', line: 1, text: 'a' }],
    todo: [{ path: 'b.ts', line: 1, text: 'b' }],
    procedures: [{ path: 'c.ts', line: 1, text: 'every router key' }],
  };
  // PROFILE.lenses is ['missingAssert', 'todo']: router keys are not candidates.
  assert.deepEqual(newCandidates(prev, next, { profile: PROFILE }).map(c => c.probe), ['missingAssert', 'todo']);
  // A lens may be a metric path; its probe's details are compared.
  assert.deepEqual(newCandidates(prev, next, { ids: ['todo.value', 'todo'] }).map(c => c.probe), ['todo']);
  assert.deepEqual(newCandidates(prev, next, { ids: [] }), []);
  assert.throws(() => newCandidates(prev, next), { message: 'newCandidates needs the lens ids (opts.ids) or the profile (opts.profile).' });
  assert.throws(() => newCandidates(prev, next, { max: 30, profile: {} }), /needs the lens ids/);
});

test('newCandidates compares like recordScan stores: both sides capped, nothing new from past the cap', () => {
  const item = i => ({ path: `f${String(i).padStart(4, '0')}.ts`, line: 1, text: 'TODO' });
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => item(from + i));
  // The stored previous details stop at DETAILS_CAP; the scan found DETAILS_CAP + 100 items.
  const stored = { todo: range(0, DETAILS_CAP) };
  assert.deepEqual(newCandidates(stored, { todo: range(0, DETAILS_CAP + 100) }, { ids: ['todo'] }), []);
  // Ten items early in the list are gone: items that move up from past the cap are not new.
  assert.deepEqual(newCandidates(stored, { todo: [...range(0, 5), ...range(15, DETAILS_CAP + 100)] }, { ids: ['todo'] }), []);
  // A new item inside the stored window is found.
  const added = { path: 'f0002b.ts', line: 3, text: 'TODO' };
  const next = [...range(0, 3), added, ...range(3, DETAILS_CAP + 100)];
  assert.deepEqual(newCandidates(stored, { todo: next }, { ids: ['todo'] }), [{ probe: 'todo', ...added }]);
  // A previous list below the cap was complete, so anything after it is new.
  assert.equal(newCandidates({ todo: range(0, 10) }, { todo: range(0, 12) }, { ids: ['todo'] }).length, 2);
});
