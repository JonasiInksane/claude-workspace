// Tests for fun/fun.mjs: Today so far, the streak, the phase boss, achievements, the weekly ship
// log and the code-written handoff note.
// Run: node --test tools/workspace-app/fun/fun.test.mjs
// Days are local calendar days, so every time here is built from a local Date. Data folders, the
// hub root and git repos are temporary folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, projectPaths, writeJsonAtomic } from '../core/datadir.mjs';
import { git } from '../core/git.mjs';
import { fakeProfile, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';
import { applyImport } from '../findings/import.mjs';
import { emptyDoc, setStatus } from '../findings/store.mjs';
import {
  achievementList, achievements, activityDays, bossBar, currentBoss, dayRuns, handoffNote, localDay, metricName, metricValue,
  recordAchievements, runFacts, saveHandoff, streak, todaySummary, weeklyLog, winText,
} from './fun.mjs';

// A local time as ISO (UTC), and the same time in git's date format with the local offset.
const local = (d, h = 12, m = 0) => {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da, h, m);
};
const iso = (d, h, m) => local(d, h, m).toISOString();
function gitDate(d, h, m) {
  const t = local(d, h, m);
  const off = -t.getTimezoneOffset();
  const pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${d}T${pad(h)}:${pad(m)}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const DAY = '2026-01-20'; // a Tuesday
const PREV = '2026-01-19';
const FAKE_B = 'b'.repeat(40);
const FAKE_C = 'c'.repeat(40);

async function commitAt(dir, files, msg, d, h, m = 0) {
  writeFiles(dir, files);
  await runGit(dir, ['add', '-A']);
  const date = gitDate(d, h, m);
  await runGit(dir, ['commit', '-q', '-m', msg], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return runGit(dir, ['rev-parse', 'HEAD']);
}

// A project repo with record commits on DAY (one from the commit gate, one interactive), a source
// change on DAY and a record commit the day before.
async function dayRepo(t) {
  const dir = join(tempDir('ws-fun-', t), 'repo');
  await makeRepo(dir, { files: { 'README.md': '# Example\n' } });
  await commitAt(dir, { 'docs/records/OLD.md': '# Old\n' }, 'Old slice', PREV, 15);
  const gate = await commitAt(dir, { 'docs/records/GATE.md': '# From the commit gate\n' }, 'Slice from the gate', DAY, 11);
  const interactive = await commitAt(dir, { 'docs/records/BY-HAND.md': '# By hand\n' }, 'Slice by hand', DAY, 16);
  await commitAt(dir, { 'src/a.mjs': 'export const a = 1;\n' }, 'Source only', DAY, 17);
  return { dir, gate, interactive };
}

// The run index, findings, metrics, check history and wins of one day.
async function dayData(dataDir, gateSha) {
  const p = projectPaths(dataDir, 'example');
  const line = (id, pipeline, status, at, extra = {}) => appendJsonl(p.runsIndex, { at, id, project: 'example', pipeline, title: `Run ${id}`, status, stage: null, waiting: null, branch: null, commit: null, ...extra });
  await line('r1', 'fix', 'running', iso(DAY, 10, 0), { createdAt: iso(DAY, 10, 0) });
  await line('r1', 'fix', 'waiting', iso(DAY, 10, 20), { createdAt: iso(DAY, 10, 0), waiting: 'plan' });
  await line('r1', 'fix', 'committed', iso(DAY, 11, 0), { createdAt: iso(DAY, 10, 0), endedAt: iso(DAY, 11, 0), commit: gateSha, branch: 'app/0120-renewal' });
  await line('r2', 'explain', 'passed', iso(DAY, 12, 30), { createdAt: iso(DAY, 12, 0), endedAt: iso(DAY, 12, 30) });
  await line('r3', 'refactor', 'running', iso(PREV, 23, 50));
  await line('r3', 'refactor', 'committed', iso(DAY, 0, 10), { commit: FAKE_B, branch: 'app/0119-split' });
  await line('r4', 'setup-worktree', 'passed', iso(DAY, 9, 0), { createdAt: iso(DAY, 9, 0) });
  await line('r5', 'fix', 'committed', iso(DAY, 9, 30), { project: 'other', createdAt: iso(DAY, 9, 0), commit: 'd'.repeat(40) });
  // r7 has a single line, as after an index compaction.
  await line('r7', 'refactor', 'committed', iso(DAY, 15, 0), { createdAt: iso(DAY, 14, 0), endedAt: iso(DAY, 15, 0), commit: FAKE_C });
  await line('r8', 'review', 'waiting', iso(DAY, 18, 0), { createdAt: iso(DAY, 17, 30), waiting: 'triage' });
  const h = (to, at, extra = {}) => ({ at, from: 'open', to, by: 'run', reason: '', ...extra });
  await writeJsonAtomic(p.findings, { ...emptyDoc('example'), phases: [{ id: '1', label: 'Phase 1: access' }], findings: [
    { id: 'X1', title: 'Loan export', severity: 'critical', phase: '1', status: 'on-branch', branch: 'app/0120-renewal', history: [h('on-branch', iso(DAY, 11, 0))] },
    { id: 'X2', title: 'Renewal links', severity: 'high', phase: '1', status: 'done', history: [h('done', iso(DAY, 13, 0), { from: 'on-branch', by: 'merged' })] },
    { id: 'X3', title: 'Catalog notes', severity: 'high', phase: '1', status: 'dismissed', history: [h('dismissed', iso(DAY, 14, 0), { by: 'user', reason: 'not reachable' })] },
    { id: 'X4', title: 'Old fix', severity: 'high', phase: '1', status: 'on-branch', branch: 'app/0119-split', history: [h('on-branch', iso(PREV, 15, 0))] },
    { id: 'X5', title: 'Still open', severity: 'high', phase: '1', status: 'open', blast: 'small', history: [] },
  ] });
  await writeJsonAtomic(p.metrics, { version: 1, project: 'example', scans: [
    { id: 's1', at: iso(PREV, 18, 0), score: 70, values: {} }, { id: 's2', at: iso(DAY, 9, 0), score: 71, values: {} },
    { id: 's3', at: iso(DAY, 18, 0), score: 73, values: { deepImports: { value: 158 } } },
  ] });
  await appendJsonl(p.checksHistory, { at: iso(DAY, 10, 30), result: 'fail', counts: { new: 2, known: 4, flaky: 0 } });
  await appendJsonl(p.checksHistory, { at: iso(DAY, 17, 0), result: 'pass', counts: { new: 0, known: 4, flaky: 1 } });
  await appendJsonl(p.wins, { at: iso(PREV, 12, 0), kind: 'achievement', id: 'boundary-builder', label: 'Boundary builder' });
  await appendJsonl(p.wins, { at: iso(DAY, 18, 5), kind: 'ratchet', metric: 'deepImports', label: 'Web deep imports', from: 163, to: 158, via: { kind: 'commit', sha: gateSha } });
}

// ---------------------------------------------------------------- Today so far

test('todaySummary counts slices from the commit gate and from records, once per commit', async t => {
  const { dir, gate, interactive } = await dayRepo(t);
  const dataDir = tempDir('ws-fun-data-', t);
  await dayData(dataDir, gate);
  const s = await todaySummary({ dataDir, project: 'example', mainDir: dir, git, date: DAY, profile: fakeProfile() });
  assert.deepEqual(s.commits.sort(), [gate.slice(0, 7), interactive.slice(0, 7), FAKE_B.slice(0, 7), FAKE_C.slice(0, 7)].sort());
  assert.equal(s.slicesCommitted, 4, 'the gate commit is in the index and touches records: counted once');
  assert.equal(s.runs, 4, 'r1, r2, r7 and r8 started today; r3 started yesterday; setup and other projects never count');
  assert.equal(s.findingsClosed, 2, 'on branch or done today; a dismissal is not a fix');
  assert.equal(s.healthDelta, 3, 'the last score today against the last one before today');
  assert.equal(s.newFailures, 0, 'the last check of the day');
  assert.equal(s.lastWin.text, `Web deep imports 163 → 158 via ${gate.slice(0, 7)}`);
  assert.equal(s.text, '4 slices · 2 findings closed · health +3 · 0 new failures');
  assert.deepEqual(s.warnings, []);
});

test('todaySummary on an empty day, without git, and when git fails', async t => {
  const dataDir = tempDir('ws-fun-data-', t);
  const s = await todaySummary({ dataDir, project: 'example', date: DAY });
  assert.deepEqual({ ...s, text: undefined }, {
    date: DAY, slicesCommitted: 0, runs: 0, findingsClosed: 0, healthDelta: null, newFailures: null, lastWin: null, commits: [], text: undefined, warnings: [],
  });
  assert.equal(s.text, '0 slices · 0 findings closed · no checks yet');
  const broken = async () => { const e = new Error('git log failed'); e.stderr = 'fatal: not a git repository'; throw e; };
  const w = await todaySummary({ dataDir, project: 'example', mainDir: dataDir, git: broken, date: DAY, profile: fakeProfile() });
  assert.match(w.warnings[0], /interactive slices were not counted: fatal: not a git repository/);
  await assert.rejects(todaySummary({ dataDir, project: 'Bad', date: DAY }), e => e.status === 400 && /not a valid project name/.test(e.message));
  await assert.rejects(todaySummary({ dataDir, project: 'example', date: '20-01-2026' }), e => e.status === 400 && /not a date/.test(e.message));
  await assert.rejects(runFacts(dataDir, '../x'), e => e.status === 400);
});

test('an import is not today\'s work: Today so far and the handoff leave its history out', async t => {
  const dataDir = tempDir('ws-fun-data-', t);
  const at = iso(DAY, 9, 0);
  const row = (id, proposed, extra = {}) => ({ id, title: `Title ${id}`, severity: 'high', phase: '1', current: null, proposed, change: true,
    why: [`audit: ${proposed}`], statusSource: 'audit', records: [], commits: [], branch: null, evidence: '', blast: 'small', area: '',
    ownerDecision: false, statusInAudit: 'open', ...extra });
  const proposal = { rows: [
    row('X1', 'done', { statusSource: 'record' }), row('X2', 'on-branch', { statusSource: 'git', branch: 'app/0119-x2' }),
    row('X3', 'dismissed', { why: ["audit: Won't fix"] }), row('X4', 'open'), row('AP-1', 'open'),
  ], phases: [{ id: '1', label: 'Phase 1: access' }], source: {}, hash: 'sha256:p' };
  const before = { ...emptyDoc('example'), findings: [{ id: 'AP-1', title: 'Proposed by a review', severity: 'medium', status: 'proposed', history: [] }] };
  let doc = applyImport(before, proposal, { at });
  const file = projectPaths(dataDir, 'example').findings;
  await writeJsonAtomic(file, doc);
  const s = await todaySummary({ dataDir, project: 'example', date: DAY });
  assert.equal(s.findingsClosed, 0, 'done and on-branch from the import are the audit\'s past');
  const note = handoffNote({ summary: s, runs: [], findings: doc, date: DAY, project: 'example' });
  const section = name => note.split(`## ${name}\n`)[1].split('\n\n')[0];
  assert.equal(section('Done'), '- Nothing finished today.');
  assert.equal(section('Decisions'), '- Confirmed the findings import.', 'no "Dismissed X3: audit: Won\'t fix", no "Accepted AP-1"');
  // Work after the import counts as usual.
  doc = setStatus(doc, 'X4', 'in-run', { by: 'run', runId: 'r1', at: iso(DAY, 10, 0) }).doc;
  doc = setStatus(doc, 'X4', 'on-branch', { by: 'run', runId: 'r1', branch: 'app/0120-x4', commit: 'a'.repeat(40), at: iso(DAY, 11, 0) }).doc;
  await writeJsonAtomic(file, doc);
  assert.equal((await todaySummary({ dataDir, project: 'example', date: DAY })).findingsClosed, 1);
  const later = handoffNote({ summary: null, runs: [], findings: doc, date: DAY, project: 'example' });
  assert.equal(later.split('## Done\n')[1].split('\n\n')[0], '- X4 committed on a branch: Title X4.');
});

test('runFacts and dayRuns survive index compaction and leave out housekeeping runs', async t => {
  const dataDir = tempDir('ws-fun-data-', t);
  await dayData(dataDir, 'a'.repeat(40));
  const facts = await runFacts(dataDir, 'example');
  assert.deepEqual([...facts.keys()], ['r1', 'r2', 'r3', 'r7', 'r8']);
  assert.equal(facts.get('r1').startedAt, iso(DAY, 10, 0));
  assert.equal(facts.get('r1').committedAt, iso(DAY, 11, 0));
  assert.equal(facts.get('r3').startedAt, iso(PREV, 23, 50), 'no createdAt: the first line');
  assert.equal(facts.get('r7').startedAt, iso(DAY, 14, 0), 'a single compacted line still knows when the run started');
  assert.equal(facts.get('r7').committedAt, iso(DAY, 15, 0));
  const runs = await dayRuns({ dataDir, project: 'example', date: DAY });
  assert.deepEqual(runs.map(r => [r.id, r.status]), [['r3', 'committed'], ['r1', 'committed'], ['r2', 'passed'], ['r7', 'committed'], ['r8', 'waiting']]);
  assert.deepEqual((await dayRuns({ dataDir, project: 'example', date: '2026-01-25' })), []);
});

// ---------------------------------------------------------------- streak

test('streak counts committed days, freezes days off and breaks on a work day without a commit', () => {
  const d = (date, runs, commits) => ({ date, runs, commits });
  assert.deepEqual(streak([d(DAY, 1, 1)]), { enabled: false, current: 0, best: 0, frozen: 0, lastFrozen: null, pendingToday: false, text: 'Streak is off.' });
  // Mon 19 commit, Tue 20 commit, Wed 21 nothing, Thu 22 commit.
  const s = streak([d('2026-01-19', 2, 1), d('2026-01-20', 1, 1), d('2026-01-22', 1, 1)], { enabled: true, today: '2026-01-22' });
  assert.deepEqual([s.current, s.best, s.frozen, s.lastFrozen, s.pendingToday], [3, 3, 1, '2026-01-21', false]);
  assert.equal(s.text, 'Streak: 3 days (Wednesday was frozen).');
  const broken = streak([d('2026-01-19', 1, 1), d('2026-01-20', 3, 0), d('2026-01-21', 1, 1)], { enabled: true, today: '2026-01-21' });
  assert.deepEqual([broken.current, broken.best], [1, 1], 'Tuesday had runs but no commit');
  assert.equal(broken.text, 'Streak: 1 day.');
  const pending = streak([d('2026-01-19', 1, 1), d('2026-01-20', 1, 0)], { enabled: true, today: '2026-01-20' });
  assert.deepEqual([pending.current, pending.pendingToday], [1, true], 'today is not over');
  assert.equal(pending.text, 'Streak: 1 day; commit a reviewed slice today to keep it going.');
  const lateCommit = streak([d('2026-01-19', 1, 0), d('2026-01-20', 0, 1)], { enabled: true, today: '2026-01-21' });
  assert.equal(lateCommit.current, 1, 'a commit counts on the day it lands, even when its run started the day before');
  assert.equal(streak([], { enabled: true, today: DAY }).text, 'Streak: 0 days.');
  const best = streak([d('2026-01-12', 1, 1), d('2026-01-13', 1, 1), d('2026-01-14', 1, 0), d('2026-01-15', 1, 1)], { enabled: true, today: '2026-01-15' });
  assert.deepEqual([best.current, best.best], [1, 2]);
});

test('activityDays counts runs on the day they started and commits on the day they landed', async t => {
  const dataDir = tempDir('ws-fun-data-', t);
  await dayData(dataDir, 'a'.repeat(40));
  assert.deepEqual(await activityDays({ dataDir, project: 'example', today: DAY }), [
    { date: PREV, runs: 1, commits: 0 }, { date: DAY, runs: 4, commits: 3 },
  ]);
  assert.deepEqual(await activityDays({ dataDir, project: 'example', today: DAY, days: 1 }), [{ date: DAY, runs: 4, commits: 3 }]);
});

// ---------------------------------------------------------------- the phase boss

const boss = (id, severity, status, phase = '1') => ({ id, title: id, severity, status, phase, history: [] });

test('bossBar counts open and in-run high and critical findings of the phase as hit points', () => {
  const doc = { ...emptyDoc('example'), phases: [{ id: '1', label: 'Phase 1: access' }, { id: '2', label: 'Phase 2: holds' }], findings: [
    boss('A', 'high', 'open'), boss('B', 'critical', 'in-run'), boss('C', 'high', 'on-branch'), boss('D', 'high', 'done'),
    boss('E', 'high', 'dismissed'), boss('F', 'medium', 'open'), boss('G', 'high', 'proposed'), boss('H', 'high', 'open', '2'),
  ] };
  assert.deepEqual(bossBar(doc, '1'), { phase: '1', label: 'Phase 1: access', hp: 2, total: 5, ids: ['A', 'B'], defeated: false, pct: 40, text: '2 HP left' });
  assert.equal(bossBar(doc, 1).hp, 2, 'a number phase id works too');
  assert.deepEqual(bossBar(doc, '9'), { phase: '9', label: 'Phase 9', hp: 0, total: 0, ids: [], defeated: false, pct: 0, text: 'No high or critical findings in this phase' });
  const cleared = { ...doc, findings: doc.findings.map(f => (f.phase === '1' && (f.status === 'open' || f.status === 'in-run') ? { ...f, status: 'on-branch' } : f)) };
  assert.equal(bossBar(cleared, '1').text, 'Defeated');
  const next = currentBoss(cleared, '1');
  assert.equal(next.phase, '2', 'a defeated phase becomes a trophy and the next phase appears');
  assert.deepEqual(next.trophies, [{ phase: '1', label: 'Phase 1: access' }]);
  assert.equal(currentBoss(doc, '1').phase, '1');
  assert.equal(currentBoss(doc, 'nope').phase, '1', 'an unknown start phase starts at the first phase');
  const allDone = { ...cleared, findings: cleared.findings.map(f => (f.phase === '2' ? { ...f, status: 'done' } : f)) };
  const end = currentBoss(allDone, '1');
  assert.deepEqual([end.phase, end.defeated, end.trophies.length], ['2', true, 2]);
});

// ---------------------------------------------------------------- achievements

test('achievements are earned from real numbers once, with readable locked texts', () => {
  const profile = fakeProfile({ probes: [{ id: 'publicTs', label: 'public.ts boundaries', kind: 'publicTs', measures: 'x' }] });
  const metrics = { scans: [{ values: { publicTs: { value: 1, of: 4 } } }, { values: { publicTs: { value: 2, of: 4 } } }] };
  const findings = { ...emptyDoc('example'), phases: [{ id: '1', label: 'Phase 1' }], findings: [boss('A', 'high', 'done'), boss('B', 'high', 'open'), boss('C', 'low', 'open')] };
  const list = achievementList({ profile, metrics, findings, earned: [], values: { knownFailures: 3 } });
  assert.deepEqual(list.map(a => [a.id, a.earned, a.met, a.text]), [
    ['baseline-zero', false, false, 'Locked · known test failures at most 0 (now 3)'],
    ['boundary-builder', false, true, 'Locked · public.ts boundaries at least 2 (now 2)'],
    ['phase1-cleared', false, false, 'Locked · every finding in Phase 1 closed (now 2 left)'],
  ]);
  const fresh = achievements({ profile, metrics, findings, earned: [], values: { knownFailures: 3 }, at: AT_FIXED });
  assert.deepEqual(fresh, [{ at: AT_FIXED, kind: 'achievement', id: 'boundary-builder', label: 'Boundary builder' }]);
  assert.deepEqual(achievements({ profile, metrics, findings, earned: ['boundary-builder'], values: { knownFailures: 3 } }), []);
  const earnedText = achievementList({ profile, metrics, findings, earned: [{ id: 'boundary-builder', at: iso(DAY, 9, 0) }] })[1].text;
  assert.equal(earnedText, `Earned · ${DAY}`);
  const zero = achievements({ profile, metrics: null, findings: null, earned: [], values: { knownFailures: 0 } });
  assert.deepEqual(zero.map(a => a.id), ['baseline-zero']);
  const odd = achievementList({ profile: { achievements: [{ id: 'x', label: 'X', when: { metric: 'm', op: '~', value: 1 } }, { id: 'y' }] } });
  assert.deepEqual(odd.map(a => a.text), ['Locked · a rule this app does not understand'], 'an entry without a rule is left out');
});

const AT_FIXED = '2026-01-20T12:00:00.000Z';

test('recordAchievements appends each new achievement to the wins log once, even when called twice at once', async t => {
  const dataDir = tempDir('ws-fun-data-', t);
  const profile = fakeProfile();
  const args = { dataDir, project: 'example', profile, metrics: null, findings: null, values: { knownFailures: 0 }, at: AT_FIXED };
  const [a, b] = await Promise.all([recordAchievements(args), recordAchievements(args)]);
  assert.deepEqual([a.length + b.length], [1]);
  const lines = readFileSync(projectPaths(dataDir, 'example').wins, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, [{ at: AT_FIXED, kind: 'achievement', id: 'baseline-zero', label: 'Baseline zero' }]);
  assert.deepEqual(await recordAchievements(args), []);
});

test('metricValue, metricName and winText read metric paths the way the metrics module does', () => {
  const values = { deepImports: { value: 158 }, serverCycles: { value: 10, largestModuleCycle: 41 }, plain: 7, bad: { value: 'x' } };
  assert.deepEqual(['deepImports', 'serverCycles.largestModuleCycle', 'plain', 'bad', 'missing', ''].map(p => metricValue(values, p)), [158, 41, 7, null, null, null]);
  const profile = { probes: [{ id: 'serverCycles', label: 'Server import cycles' }] };
  assert.equal(metricName(profile, 'serverCycles.largestModuleCycle'), 'Server import cycles, largest module cycle');
  assert.equal(metricName(profile, 'knownFailures'), 'known test failures');
  assert.equal(metricName(null, 'deepImports'), 'deepImports');
  assert.equal(winText({ kind: 'ratchet', label: 'Web deep imports', from: 163, to: 158, via: { sha: 'ABCDEF1234' } }), 'Web deep imports 163 → 158 via abcdef1');
  assert.equal(winText({ kind: 'ratchet', metric: 'asNever', from: 4, to: 3, via: { branch: 'app/0120-x' } }), 'asNever 4 → 3 via app/0120-x');
  assert.equal(winText({ kind: 'achievement', id: 'x', label: 'Cycle breaker' }), 'Achievement: Cycle breaker');
  assert.equal(winText(null), '');
  assert.equal(localDay('not a date'), '');
  assert.equal(localDay(local(DAY, 0, 5)), DAY);
});

// ---------------------------------------------------------------- weekly ship log

test('weeklyLog lists this week\'s commits on the integration branch that touch records, newest first', async t => {
  const dir = join(tempDir('ws-fun-', t), 'repo');
  await makeRepo(dir, { files: { 'README.md': '# Example\n' } });
  const old = await commitAt(dir, { 'docs/records/ANCIENT.md': '# a\n' }, 'Too old', '2026-01-05', 12);
  const one = await commitAt(dir, { 'docs/records/LOAN-EXPORT.md': '# x\n', 'docs/README.md': '# index\n' }, 'Loan export slice', '2026-01-16', 12);
  await commitAt(dir, { 'src/x.mjs': 'export {};\n' }, 'Source only', '2026-01-17', 12);
  const two = await commitAt(dir, { 'docs/records/RENEWAL.md': '# y\n', 'docs/records/README.md': '# index\n' }, 'Renewal slice', '2026-01-19', 12);
  await runGit(dir, ['switch', '-q', '-c', 'app/0119-unmerged']);
  await commitAt(dir, { 'docs/records/NOT-MERGED.md': '# z\n' }, 'Not merged', '2026-01-19', 13);
  await runGit(dir, ['switch', '-q', 'main']);
  const profile = fakeProfile({ git: { integrationBranch: 'main' } });
  const log = await weeklyLog({ git, mainDir: dir, profile, now: local(DAY, 12, 0) });
  assert.deepEqual(log.map(e => [e.sha, e.short, e.subject, e.records]), [
    [two, two.slice(0, 7), 'Renewal slice', ['RENEWAL']],
    [one, one.slice(0, 7), 'Loan export slice', ['LOAN-EXPORT']],
  ]);
  assert.ok(!log.some(e => e.sha === old));
  assert.match(log[0].at, /^2026-01-19T12:00:00/);
  assert.deepEqual(await weeklyLog({ git, mainDir: dir, profile: fakeProfile({ docs: { recordsDir: null } }) }), []);
  await assert.rejects(weeklyLog({ git, mainDir: dir, profile: fakeProfile({ git: { integrationBranch: '--all' } }) }), e => e.status === 400);
});

// ---------------------------------------------------------------- handoff

test('handoffNote writes Goal, Done, Decisions, Open and Next from the day\'s facts, redacted', () => {
  const key = ['sk', 'live', 'x'.repeat(24)].join('_');
  const runs = [
    { id: 'r1', pipeline: 'fix', title: 'Fix a finding: X1 loan export', status: 'committed', commit: 'A'.repeat(40), branch: 'app/0120-loan-export' },
    { id: 'r2', pipeline: 'explain', title: 'Explain: how renewals work', status: 'passed' },
    { id: 'r3', pipeline: 'refactor', title: `Refactor: move ${key} out of the code`, status: 'waiting', waiting: 'plan' },
    { id: 'r4', pipeline: 'debug', title: 'Debug: reminder dates', status: 'gates-red' },
    { id: 'r5', pipeline: 'review', title: 'Review: my changes', status: 'running', stage: 'review' },
  ];
  const h = (from, to, at, extra = {}) => ({ at, from, to, by: 'run', reason: '', ...extra });
  const findings = { ...emptyDoc('example'), phases: [{ id: '1', label: 'Phase 1: access' }],
    source: { confirmedAt: iso(DAY, 8, 0) }, findings: [
      { id: 'X1', title: 'Loan export', severity: 'critical', phase: '1', status: 'on-branch', branch: 'app/0120-loan-export', history: [h('in-run', 'on-branch', iso(DAY, 11, 0))] },
      { id: 'X3', title: 'Catalog notes', severity: 'high', phase: '1', status: 'dismissed', history: [h('open', 'dismissed', iso(DAY, 14, 0), { by: 'user', reason: 'only staff can reach it' })] },
      { id: 'AP-1', title: 'Proposed by a review', severity: 'medium', phase: null, status: 'open', history: [h('proposed', 'open', iso(DAY, 15, 0), { by: 'user' })] },
      { id: 'X5', title: 'Still open', severity: 'high', phase: '1', status: 'open', blast: 'small', history: [] },
      { id: 'X6', title: 'In a run', severity: 'high', phase: '1', status: 'in-run', runId: 'r9', history: [] },
    ] };
  const summary = { date: DAY, text: '1 slice · 1 finding closed · 0 new failures', lastWin: { at: iso(DAY, 11, 5), text: 'Web deep imports 163 → 158 via aaaaaaa' } };
  const note = handoffNote({ summary, runs, findings, date: DAY, project: 'example', label: 'Example', boss: bossBar(findings, '1') });
  const headings = note.split('\n').filter(l => /^#{1,2} /.test(l));
  assert.deepEqual(headings, ['# Handoff: Example, end of day', '## Goal', '## Done', '## Decisions', '## Open', '## Next']);
  assert.match(note, /^Date: 2026-01-20$/m);
  assert.match(note, /^Where: projects\/example$/m);
  assert.match(note, /^- Close Phase 1: access: 2 high or critical findings left \(X5, X6\)\.$/m);
  assert.match(note, /^- Today so far: 1 slice · 1 finding closed · 0 new failures\.$/m);
  assert.match(note, /^- Committed: Fix a finding: X1 loan export \(Fix a finding\), aaaaaaa on app\/0120-loan-export\. Not pushed\.$/m);
  assert.match(note, /^- Passed: Explain: how renewals work \(Explain\)\.$/m);
  assert.match(note, /^- X1 committed on a branch: Loan export\.$/m);
  assert.match(note, /^- Win: Web deep imports 163 → 158 via aaaaaaa\.$/m);
  assert.match(note, /^- Dismissed X3: only staff can reach it\.$/m);
  assert.match(note, /^- Accepted AP-1 as a finding\.$/m);
  assert.match(note, /^- Confirmed the findings import\.$/m);
  assert.match(note, /^- Waiting for you: .* at the plan gate\.$/m);
  assert.match(note, /^- Stopped \(checks red\): Debug: reminder dates \(Debug\)\.$/m);
  assert.match(note, /^- Running: Review: my changes \(Review\), stage review\.$/m);
  assert.match(note, /^- X1 is on app\/0120-loan-export, not merged yet\.$/m);
  assert.match(note, /^- X6 is in a run \(r9\)\.$/m);
  assert.match(note, /^1\. Answer the plan gate of Refactor: move /m);
  assert.match(note, /^3\. Review and merge app\/0120-loan-export in GitKraken when you are ready; the app never merges\.$/m);
  assert.match(note, /^4\. Start Fix for X5: Still open \(Phase 1 · small blast radius\)\.$/m);
  assert.ok(!note.includes(key), 'a secret-shaped string in a run title is redacted');
  assert.match(note, /sk_l…\[redacted \d+\]/);
  assert.ok(handoffNote({ summary, runs, findings, date: DAY, allow: [key] }).includes(key), 'allowed values stay');
  const empty = handoffNote({ summary: null, runs: [], findings: emptyDoc('example'), date: DAY });
  for (const line of ['- Nothing finished today.', '- No decisions recorded today.', '- Nothing open.', '1. Pick the next finding on the board, or run Check my work.']) {
    assert.ok(empty.includes(line), line);
  }
});

test('saveHandoff writes to inbox/handoffs and never overwrites an earlier note', async t => {
  const root = tempDir('ws-fun-hub-', t);
  const a = await saveHandoff({ root, project: 'example', date: DAY, text: '# One\n' });
  const b = await saveHandoff({ root, project: 'example', date: DAY, text: '# Two\n' });
  assert.equal(a.path, `inbox/handoffs/${DAY}-example-day.md`);
  assert.equal(b.path, `inbox/handoffs/${DAY}-example-day-2.md`);
  assert.equal(readFileSync(a.file, 'utf8'), '# One\n');
  assert.equal(readFileSync(b.file, 'utf8'), '# Two\n');
  await assert.rejects(saveHandoff({ root, project: '../x', date: DAY, text: '' }), e => e.status === 400 && /not a valid project name/.test(e.message));
  await assert.rejects(saveHandoff({ root, project: 'example', date: '..', text: '' }), e => e.status === 400 && /not a date/.test(e.message));
  await assert.rejects(saveHandoff({ root: '', project: 'example', date: DAY, text: '' }), e => e.status === 500 && /hub folder is unknown/.test(e.message));
  assert.ok(!existsSync(join(root, 'inbox', 'handoffs', '..x')));
});
