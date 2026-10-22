// Tests for findings/reconcile.mjs: on-branch findings become done from git (merged branch, or a
// commit on the integration branch), in-run findings follow the run index, and reconcileAndSave
// saves the result.
// Run: node --test tools/workspace-app/findings/reconcile.test.mjs
// Git runs in a temporary repo; the data folder is temporary too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendJsonl, projectPaths } from '../core/datadir.mjs';
import { git } from '../core/git.mjs';
import { commitAll, fakeProfile, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';
import { applyImport } from './import.mjs';
import { TERMINAL_RUN_STATUSES, currentFixCommits, lastPerRun, reconcile, reconcileAndSave } from './reconcile.mjs';
import { emptyDoc, loadFindings, saveFindings, setStatus } from './store.mjs';

const AT = '2026-01-20T10:00:00.000Z';

function finding(id, status, extra = {}) {
  return {
    id, title: `Finding ${id}`, severity: 'high', phase: '1', area: '', status, statusSource: 'run', blast: 'small',
    ownerDecision: false, estimateMin: null, records: [], commits: [], branch: null, runId: null, evidence: '', notes: '',
    history: [], ...extra,
  };
}

// main with three app branches: one merged and kept, one merged and then deleted, one unmerged.
async function repo(t) {
  const dir = join(tempDir('ws-rec-', t), 'repo');
  await makeRepo(dir, { files: { 'README.md': '# Example\n' } });
  const branch = async (name, file, merge) => {
    await runGit(dir, ['switch', '-q', '-c', name]);
    writeFiles(dir, { [file]: `export const x = '${name}';\n` });
    const sha = await commitAll(dir, `Work on ${name}`);
    await runGit(dir, ['switch', '-q', 'main']);
    if (merge) await runGit(dir, ['merge', '-q', '--ff-only', name]);
    return sha;
  };
  const merged = await branch('app/0115-merged', 'a.mjs', true);
  const gone = await branch('app/0117-gone', 'b.mjs', true);
  await runGit(dir, ['branch', '-q', '-D', 'app/0117-gone']);
  const open = await branch('app/0116-open', 'c.mjs', false);
  return { dir, merged, gone, open };
}

const profile = fakeProfile({ git: { integrationBranch: 'main' } });

const index = shas => [
  { at: AT, id: 'r-cancel', project: 'example', status: 'running', branch: null, commit: null },
  { at: AT, id: 'r-cancel', project: 'example', status: 'cancelled', branch: null, commit: null },
  { at: AT, id: 'r-wait', project: 'example', status: 'waiting', branch: null, commit: null },
  { at: AT, id: 'r-commit', project: 'example', status: 'committed', branch: 'app/0116-open', commit: shas.open },
  { at: AT, id: 'r-passed', project: 'example', status: 'passed', branch: null, commit: null },
  { at: AT, id: 'r-capped', project: 'example', status: 'capped', branch: null, commit: null },
  { at: AT, id: 'r-nocommit', project: 'example', status: 'committed', branch: null, commit: null },
];

test('reconcile moves on-branch to done only from git, and in-run back by the run index', async t => {
  const shas = await repo(t);
  const doc = { ...emptyDoc('example'), findings: [
    finding('A', 'on-branch', { branch: 'app/0115-merged', commits: [shas.merged.slice(0, 7)] }),
    finding('B', 'on-branch', { branch: 'app/0116-open', commits: [shas.open] }),
    finding('C', 'on-branch', { branch: 'app/0117-gone', commits: [shas.gone],
      history: [{ at: AT, from: 'in-run', to: 'on-branch', by: 'run', reason: '', branch: 'app/0117-gone', commit: shas.gone }] }),
    finding('D', 'on-branch', { branch: null, commits: ['deadbeef'] }),
    finding('E', 'in-run', { runId: 'r-cancel' }),
    finding('F', 'in-run', { runId: 'r-wait' }),
    finding('G', 'in-run', { runId: 'r-commit' }),
    finding('H', 'in-run', { runId: 'r-missing' }),
    finding('I', 'in-run', { runId: 'r-passed' }),
    finding('J', 'open'),
    finding('K', 'in-run', { runId: 'r-capped' }),
    finding('L', 'in-run', { runId: 'r-nocommit' }),
  ] };
  const frozen = JSON.stringify(doc);
  const r = await reconcile({ doc, mainDir: shas.dir, profile, git, runsIndex: index(shas), at: AT });
  assert.equal(JSON.stringify(doc), frozen, 'the input document is not changed');
  assert.deepEqual(r.doc.findings.map(f => [f.id, f.status]), [
    ['A', 'done'], ['B', 'on-branch'], ['C', 'done'], ['D', 'on-branch'], ['E', 'open'], ['F', 'in-run'],
    ['G', 'on-branch'], ['H', 'in-run'], ['I', 'open'], ['J', 'open'], ['K', 'in-run'], ['L', 'in-run'],
  ]);
  assert.deepEqual(r.changes, [
    { id: 'A', from: 'on-branch', to: 'done', reason: 'app/0115-merged is merged into main' },
    { id: 'C', from: 'on-branch', to: 'done', reason: `commit ${shas.gone.slice(0, 7)} is on main` },
    { id: 'E', from: 'in-run', to: 'open', reason: 'run r-cancel ended cancelled without a commit' },
    { id: 'G', from: 'in-run', to: 'on-branch', reason: `run r-commit committed ${shas.open.slice(0, 7)}` },
    { id: 'I', from: 'in-run', to: 'open', reason: 'run r-passed ended passed without a commit' },
  ]);
  const a = r.doc.findings[0];
  assert.equal(a.statusSource, 'merged');
  assert.deepEqual(a.history.at(-1), { at: AT, from: 'on-branch', to: 'done', by: 'merged', reason: 'app/0115-merged is merged into main', branch: 'app/0115-merged' });
  const g = r.doc.findings[6];
  assert.equal(g.branch, 'app/0116-open');
  assert.deepEqual(g.commits, [shas.open]);
  assert.equal(r.doc.findings[4].runId, null, 'a finding given back by its run has no run any more');
  assert.deepEqual(r.warnings, [
    "H is in a run the run index doesn't know (r-missing); it stays in run.",
    'L: run r-nocommit committed, but the index has no branch or commit, so it stays in run.',
  ]);
  assert.deepEqual(TERMINAL_RUN_STATUSES, ['passed', 'failed', 'cancelled', 'committed']);
});

test('reconcile looks only at the current fix: an older commit on main never makes a later, unmerged fix done', async t => {
  const dir = join(tempDir('ws-rec-', t), 'repo');
  await makeRepo(dir, { files: { 'README.md': '# Example\n' } });
  writeFiles(dir, { 'a.mjs': 'export const a = 1;\n' });
  const partial = await commitAll(dir, 'Partial fix (audit X1)');
  // The import proposes done from that commit, and you set X1 back to open.
  const proposal = { rows: [{ id: 'X1', title: 'T', severity: 'high', phase: null, current: null, proposed: 'done', change: true, why: ['commit'],
    statusSource: 'git', records: [], commits: [partial.slice(0, 7)], branch: null, evidence: '', blast: 'small', area: '', ownerDecision: false,
    statusInAudit: 'open' }], phases: [], source: {}, hash: 'sha256:p' };
  let doc = applyImport(emptyDoc('example'), proposal, { overrides: { X1: 'open' }, at: AT });
  // A Fix run then commits on an app branch that is not merged.
  await runGit(dir, ['switch', '-q', '-c', 'app/0120-x1']);
  writeFiles(dir, { 'b.mjs': 'export const b = 2;\n' });
  const fix = await commitAll(dir, 'Real fix');
  await runGit(dir, ['switch', '-q', 'main']);
  doc = setStatus(doc, 'X1', 'in-run', { by: 'run', runId: 'r1', at: AT }).doc;
  doc = setStatus(doc, 'X1', 'on-branch', { by: 'run', runId: 'r1', branch: 'app/0120-x1', commit: fix, at: AT }).doc;
  // Even an old SHA on main in the commits list (an earlier fix, a hand edit) doesn't count.
  doc = { ...doc, findings: [{ ...doc.findings[0], commits: [partial, ...doc.findings[0].commits] }] };
  assert.deepEqual(currentFixCommits(doc.findings[0]), [fix]);
  const r = await reconcile({ doc, mainDir: dir, profile, git, runsIndex: [], at: AT });
  assert.deepEqual(r.changes, []);
  assert.equal(r.doc.findings[0].status, 'on-branch');
  // Once the fix itself is merged and its branch deleted, its own commit makes it done.
  await runGit(dir, ['merge', '-q', '--ff-only', 'app/0120-x1']);
  await runGit(dir, ['branch', '-q', '-D', 'app/0120-x1']);
  const merged = await reconcile({ doc, mainDir: dir, profile, git, runsIndex: [], at: AT });
  assert.deepEqual(merged.changes, [{ id: 'X1', from: 'on-branch', to: 'done', reason: `commit ${fix.slice(0, 7)} is on main` }]);
});

test('currentFixCommits reads the latest move to on-branch only', () => {
  const sha = c => c.repeat(7);
  assert.deepEqual(currentFixCommits({ history: [
    { to: 'on-branch', by: 'import', commits: [sha('a'), 'not a sha'] }, { to: 'dismissed', by: 'user' }, { to: 'open', by: 'user' },
    { to: 'in-run', by: 'run' }, { to: 'on-branch', by: 'run', commit: sha('b') },
  ] }), [sha('b')]);
  assert.deepEqual(currentFixCommits({ history: [{ to: 'on-branch', by: 'import', branch: 'app/x', commits: [sha('c'), sha('c')] }] }), [sha('c')]);
  assert.deepEqual(currentFixCommits({ history: [{ to: 'on-branch', by: 'run', branch: 'app/x' }] }), [], 'a branch only: the branch check decides');
  assert.deepEqual(currentFixCommits({ commits: [sha('d')], history: [] }), [], 'commits without a move to on-branch never count');
  assert.deepEqual(currentFixCommits(null), []);
});

test('reconcile without an integration branch warns and leaves on-branch findings alone', async () => {
  const doc = { ...emptyDoc('example'), findings: [finding('A', 'on-branch', { branch: 'app/x' })] };
  const noGit = async () => { throw new Error('git must not run'); };
  const r = await reconcile({ doc, mainDir: 'C:\\nowhere', profile: fakeProfile({ git: { integrationBranch: null } }), git: noGit, runsIndex: [] });
  assert.equal(r.doc, doc);
  assert.deepEqual(r.changes, []);
  assert.match(r.warnings[0], /no git.integrationBranch/);
  const none = await reconcile({ doc: emptyDoc('example'), mainDir: 'C:\\nowhere', profile, git: noGit, runsIndex: [] });
  assert.deepEqual(none.changes, [], 'nothing on a branch: git is not asked');
});

test('lastPerRun keeps the last row per run id and accepts a ready Map', () => {
  const m = lastPerRun([{ id: 'a', status: 'running' }, { id: 'b', status: 'waiting' }, { id: 'a', status: 'failed' }, null, { status: 'x' }]);
  assert.deepEqual([...m.entries()].map(([k, v]) => [k, v.status]), [['a', 'failed'], ['b', 'waiting']]);
  assert.equal(lastPerRun(m), m);
});

test('reconcileAndSave reads the run index, saves the board once and is a no-op the second time', async t => {
  const shas = await repo(t);
  const dataDir = tempDir('ws-rec-data-', t);
  await saveFindings(dataDir, 'example', { ...emptyDoc('example'), findings: [
    finding('A', 'on-branch', { branch: 'app/0115-merged' }), finding('E', 'in-run', { runId: 'r-cancel' }), finding('Z', 'in-run', { runId: 'r-other' }),
  ] }, { baseHash: null });
  const file = projectPaths(dataDir, 'example').runsIndex;
  for (const row of index(shas)) await appendJsonl(file, row);
  await appendJsonl(file, { at: AT, id: 'r-other', project: 'other-project', status: 'failed' });
  const r = await reconcileAndSave({ dataDir, project: 'example', mainDir: shas.dir, profile, git, at: AT });
  assert.equal(r.changed, true);
  assert.deepEqual(r.changes.map(c => c.id), ['A', 'E']);
  assert.match(r.warnings[0], /^Z is in a run the run index doesn't know/, 'another project\'s run is not this finding\'s run');
  const saved = await loadFindings(dataDir, 'example');
  assert.deepEqual(saved.findings.map(f => f.status), ['done', 'open', 'in-run']);
  const again = await reconcileAndSave({ dataDir, project: 'example', mainDir: shas.dir, profile, git, at: AT });
  assert.equal(again.changed, false);
  assert.deepEqual(again.changes, []);
  await assert.rejects(reconcileAndSave({ dataDir, project: '../x', mainDir: shas.dir, profile, git }), e => e.status === 400);
});
