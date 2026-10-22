// Tests for findings/store.mjs: the board file, its 409 on a stale hash, the status transitions,
// the board columns, Next up, phase bars, proposed findings and the pending import file.
// Run: node --test tools/workspace-app/findings/store.test.mjs
// Everything is written under a temporary data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../test/helpers.mjs';
import {
  STATUSES, TRANSITIONS, clearPendingImport, columns, docProblem, emptyDoc, findingsFile, hashDoc, importFile, loadFindings,
  loadPendingImport, nextUp, phaseBars, proposeFinding, rankOpen, runMedians, saveFindings, savePendingImport, setStatus,
  transitionProblem, updateFindings,
} from './store.mjs';

const AT = '2026-01-20T10:00:00.000Z';

function finding(id, over = {}) {
  return {
    id, title: `Finding ${id}`, severity: 'medium', phase: null, area: '', status: 'open', statusSource: 'audit',
    blast: 'medium', ownerDecision: false, estimateMin: null, records: [], commits: [], branch: null, runId: null,
    evidence: '', notes: '', history: [{ at: AT, from: null, to: over.status || 'open', by: 'import', reason: 'audit' }],
    ...over,
  };
}

function board(findings, phases = [{ id: '0', label: 'Phase 0: security' }, { id: '1', label: 'Phase 1: money' }]) {
  return { ...emptyDoc('example'), phases, findings };
}

test('loadFindings gives an empty board with a null hash when there is no file', async t => {
  const dataDir = tempDir('ws-find-', t);
  const doc = await loadFindings(dataDir, 'example');
  assert.deepEqual(doc, emptyDoc('example'));
  assert.equal(doc.hash, null);
});

test('saveFindings writes the private file with a content hash, and loadFindings reads it back', async t => {
  const dataDir = tempDir('ws-find-', t);
  const saved = await saveFindings(dataDir, 'example', board([finding('EX-1')]), { baseHash: null });
  assert.equal(findingsFile(dataDir, 'example'), join(dataDir, 'findings', 'example.json'));
  assert.match(saved.hash, /^sha256:[0-9a-f]{64}$/);
  const onDisk = JSON.parse(readFileSync(findingsFile(dataDir, 'example'), 'utf8'));
  assert.equal(onDisk.hash, saved.hash);
  const loaded = await loadFindings(dataDir, 'example');
  assert.equal(loaded.hash, saved.hash);
  assert.equal(loaded.findings[0].id, 'EX-1');
  assert.equal(hashDoc(loaded), saved.hash, 'the hash ignores the hash field itself');
});

test('saveFindings refuses a stale hash with 409 and keeps the newer board', async t => {
  const dataDir = tempDir('ws-find-', t);
  const first = await saveFindings(dataDir, 'example', board([finding('EX-1')]), { baseHash: null });
  const second = await saveFindings(dataDir, 'example', board([finding('EX-1'), finding('EX-2')]), { baseHash: first.hash });
  await assert.rejects(saveFindings(dataDir, 'example', board([]), { baseHash: first.hash }), e => e.status === 409 && /changed since you loaded/.test(e.message));
  await assert.rejects(saveFindings(dataDir, 'example', board([]), { baseHash: null }), e => e.status === 409, 'null means "no file yet"');
  assert.equal((await loadFindings(dataDir, 'example')).hash, second.hash);
});

test('the hash on load is computed from the content, so a hand edit is noticed', async t => {
  const dataDir = tempDir('ws-find-', t);
  const saved = await saveFindings(dataDir, 'example', board([finding('EX-1')]), { baseHash: null });
  const file = findingsFile(dataDir, 'example');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.findings[0].title = 'edited by hand';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify(raw)); // the stored hash field is now stale
  await assert.rejects(saveFindings(dataDir, 'example', board([]), { baseHash: saved.hash }), e => e.status === 409);
  const loaded = await loadFindings(dataDir, 'example');
  assert.notEqual(loaded.hash, saved.hash);
  await saveFindings(dataDir, 'example', loaded, { baseHash: loaded.hash });
});

test('project names are checked before any path is built', async t => {
  const dataDir = tempDir('ws-find-', t);
  for (const bad of ['../x', 'Example', 'a/b', '', 'x..y']) {
    await assert.rejects(loadFindings(dataDir, bad), e => e.status === 400, bad);
  }
  assert.throws(() => importFile(dataDir, '..\\up'), e => e.status === 400);
});

test('updateFindings runs read-modify-writes one at a time, so concurrent changes are all kept', async t => {
  const dataDir = tempDir('ws-find-', t);
  await saveFindings(dataDir, 'example', board([finding('EX-1'), finding('EX-2'), finding('EX-3')]), { baseHash: null });
  await Promise.all([
    updateFindings(dataDir, 'example', d => setStatus(d, 'EX-1', 'in-run', { by: 'run', runId: 'r1', at: AT })),
    updateFindings(dataDir, 'example', d => setStatus(d, 'EX-2', 'dismissed', { by: 'user', reason: 'not real', at: AT })),
    updateFindings(dataDir, 'example', d => setStatus(d, 'EX-3', 'in-run', { by: 'run', runId: 'r3', at: AT })),
  ]);
  const doc = await loadFindings(dataDir, 'example');
  assert.deepEqual(doc.findings.map(f => f.status), ['in-run', 'dismissed', 'in-run']);
  const r = await updateFindings(dataDir, 'example', d => d);
  assert.equal(r.changed, false, 'an unchanged board is not rewritten');
  await assert.rejects(updateFindings(dataDir, 'example', d => setStatus(d, 'EX-1', 'done', { by: 'user' })), e => e.status === 400);
  const after = await updateFindings(dataDir, 'example', d => setStatus(d, 'EX-1', 'open', { by: 'run', at: AT }));
  assert.equal(after.changed, true, 'a failed update does not block the next one');
});

// Every (from, to, by) combination against the SPEC table.
const ALLOWED = new Set([
  'open>in-run>run', 'in-run>open>run', 'in-run>on-branch>run', 'on-branch>done>merged',
  ...STATUSES.filter(s => s !== 'dismissed').map(s => `${s}>dismissed>user`), 'dismissed>open>user', 'proposed>open>user',
]);

test('setStatus allows exactly the transitions in the SPEC table', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;
      for (const by of ['run', 'merged', 'user', 'import']) {
        const doc = board([finding('EX-1', { status: from })]);
        const key = `${from}>${to}>${by}`;
        if (ALLOWED.has(key)) {
          const r = setStatus(doc, 'EX-1', to, { by, reason: 'because', at: AT, runId: 'r1' });
          assert.equal(r.finding.status, to, key);
          assert.equal(doc.findings[0].status, from, 'the input document is not changed');
        } else {
          assert.throws(() => setStatus(doc, 'EX-1', to, { by, reason: 'because', at: AT }), e => e.status === 400, key);
        }
      }
    }
  }
  assert.equal(TRANSITIONS.length, 7);
});

test('done is never set by a user call, from any status', () => {
  for (const from of STATUSES.filter(s => s !== 'done')) {
    assert.throws(() => setStatus(board([finding('EX-1', { status: from })]), 'EX-1', 'done', { by: 'user', reason: 'x' }),
      e => e.status === 400 && /merged branch/.test(e.message), from);
  }
  assert.match(transitionProblem('on-branch', 'done', 'user'), /merged branch/);
  assert.equal(transitionProblem('on-branch', 'done', 'merged'), '');
});

test('dismissing needs a reason of at most 300 characters', () => {
  const doc = board([finding('EX-1')]);
  assert.throws(() => setStatus(doc, 'EX-1', 'dismissed', { by: 'user', reason: '  ' }), e => e.status === 400 && /Say why/.test(e.message));
  assert.throws(() => setStatus(doc, 'EX-1', 'dismissed', { by: 'user', reason: 'x'.repeat(301) }), e => e.status === 400);
  const r = setStatus(doc, 'EX-1', 'dismissed', { by: 'user', reason: 'duplicate of\nEX-2', at: AT });
  assert.equal(r.finding.statusSource, 'user');
  assert.deepEqual(r.finding.history.at(-1), { at: AT, from: 'open', to: 'dismissed', by: 'user', reason: 'duplicate of EX-2' });
});

test('setStatus records the run, branch and commit, and clears the run when a run gives a finding back', () => {
  let doc = board([finding('EX-1')]);
  doc = setStatus(doc, 'EX-1', 'in-run', { by: 'run', runId: '260120-100000-fix-ex-1', at: AT }).doc;
  assert.equal(doc.findings[0].runId, '260120-100000-fix-ex-1');
  assert.equal(doc.findings[0].statusSource, 'run');
  const back = setStatus(doc, 'EX-1', 'open', { by: 'run', reason: 'cancelled', at: AT }).doc;
  assert.equal(back.findings[0].runId, null);
  doc = setStatus(doc, 'EX-1', 'on-branch', { by: 'run', branch: 'app/0120-ex-1', commit: 'ABC1234', runId: '260120-100000-fix-ex-1', at: AT }).doc;
  assert.equal(doc.findings[0].branch, 'app/0120-ex-1');
  assert.deepEqual(doc.findings[0].commits, ['abc1234']);
  doc = setStatus(doc, 'EX-1', 'done', { by: 'merged', reason: 'app/0120-ex-1 is merged', at: AT }).doc;
  assert.equal(doc.findings[0].statusSource, 'merged');
  assert.deepEqual(doc.findings[0].history.map(h => h.to), ['open', 'in-run', 'on-branch', 'done']);
  const same = setStatus(doc, 'EX-1', 'done', { by: 'merged' });
  assert.equal(same.changed, false);
  assert.equal(same.doc, doc, 'an unchanged finding gives the same document back');
  assert.throws(() => setStatus(doc, 'EX-9', 'open', { by: 'user' }), e => e.status === 404);
  assert.throws(() => setStatus(board([finding('EX-1', { status: 'in-run' })]), 'EX-1', 'on-branch', { by: 'run', commit: 'not-a-sha' }),
    e => e.status === 400 && /not a commit SHA/.test(e.message));
});

// The run engine moves findings three ways: updateFindings + setStatus (runs/manager.mjs
// markFinding), updateFindings + setStatus(...).doc and load + setStatus + save(out.doc || out)
// (runs/executor.mjs moveFinding). All three must keep the board.
test('setStatus works the three ways the run engine calls it', async t => {
  const dataDir = tempDir('ws-find-', t);
  await saveFindings(dataDir, 'example', board([finding('EX-1'), finding('EX-2'), finding('EX-3')]), { baseHash: null });
  const r1 = await updateFindings(dataDir, 'example', d => setStatus(d, 'EX-1', 'in-run', { by: 'run', runId: 'r1', reason: 'run started', at: AT }));
  assert.equal(r1.changed, true);
  assert.equal(r1.finding.status, 'in-run', 'the extras come back');
  await updateFindings(dataDir, 'example', d => setStatus(d, 'EX-2', 'in-run', { by: 'run', runId: 'r2', at: AT }).doc);
  const doc = await loadFindings(dataDir, 'example');
  const out = setStatus(doc, 'EX-1', 'on-branch', { by: 'run', runId: 'r1', branch: 'app/0120-ex-1', commit: 'a'.repeat(40) });
  await saveFindings(dataDir, 'example', out.doc || out, { baseHash: doc.hash });
  const after = await loadFindings(dataDir, 'example');
  assert.deepEqual(after.findings.map(f => [f.id, f.status]), [['EX-1', 'on-branch'], ['EX-2', 'in-run'], ['EX-3', 'open']]);
  assert.equal(after.phases.length, 2, 'phases are kept');
});

test('saveFindings refuses anything that is not a board, so a wrong value never empties it', async t => {
  const dataDir = tempDir('ws-find-', t);
  const saved = await saveFindings(dataDir, 'example', board([finding('EX-1')]), { baseHash: null });
  const wrong = setStatus(saved, 'EX-1', 'in-run', { by: 'run', runId: 'r1' }); // { doc, finding, changed }
  for (const [bad, re] of [
    [wrong, /no findings list/], [null, /no findings list/], [[], /no findings list/], [{ findings: 'x' }, /no findings list/],
    [board([finding('EX-1'), finding('EX-1')]), /appears twice/], [board([finding('EX-1', { status: 'fixed' })]), /not a finding status/],
    [board([{ ...finding('EX-1'), id: '' }]), /without an id/],
  ]) {
    assert.match(docProblem(bad), re);
    await assert.rejects(saveFindings(dataDir, 'example', bad, { baseHash: saved.hash }), e => e.status === 400 && re.test(e.message));
  }
  assert.equal(docProblem(board([])), '');
  assert.equal((await loadFindings(dataDir, 'example')).findings.length, 1, 'the board on disk is unchanged');
  await assert.rejects(updateFindings(dataDir, 'example', () => ({ doc: {} })), e => e.status === 400);
});

test('columns returns the four board columns, proposed in Open, dismissed off the board, by severity', () => {
  const doc = board([
    finding('EX-1', { severity: 'low' }), finding('EX-2', { severity: 'critical' }), finding('EX-3', { status: 'proposed', severity: 'high' }),
    finding('EX-4', { status: 'in-run' }), finding('EX-5', { status: 'on-branch' }), finding('EX-6', { status: 'done' }),
    finding('EX-7', { status: 'dismissed' }), finding('EX-8', { severity: 'critical' }),
  ]);
  const cols = columns(doc);
  assert.deepEqual(cols.map(c => [c.id, c.label, c.count]), [['open', 'Open', 4], ['in-run', 'In run', 1], ['on-branch', 'On branch', 1], ['done', 'Done', 1]]);
  assert.deepEqual(cols[0].items.map(f => f.id), ['EX-2', 'EX-8', 'EX-3', 'EX-1'], 'severity first, audit order within one severity');
  assert.equal(cols[0].items[0].history, undefined, 'board items carry no history');
});

test('nextUp picks the highest severity, then the smallest blast radius, skipping owner decisions', () => {
  const doc = board([
    finding('EX-1', { severity: 'high', blast: 'large', phase: '0' }),
    finding('EX-2', { severity: 'critical', blast: 'small', phase: '0', ownerDecision: true }),
    finding('EX-3', { severity: 'high', blast: 'small', phase: '1' }),
    finding('EX-4', { severity: 'high', blast: 'small', phase: '0' }),
    finding('EX-5', { severity: 'critical', blast: 'small', status: 'in-run' }),
  ]);
  const top = nextUp(doc, { medians: { fix: 45 } });
  assert.equal(top.id, 'EX-4', 'phase 0 before phase 1 when severity and blast tie');
  assert.equal(top.estimateMin, 45);
  assert.equal(top.estimateText, 'about 45 min (your median for Fix)');
  assert.equal(top.meta, 'Phase 0 · small blast radius · about 45 min (your median for Fix)');
  assert.equal(top.phaseLabel, 'Phase 0: security');
  assert.deepEqual(rankOpen(doc).map(f => f.id), ['EX-4', 'EX-3', 'EX-1', 'EX-2'], 'owner decisions sort last');
  assert.equal(nextUp(board([finding('EX-1', { ownerDecision: true })])), null);
  assert.equal(nextUp(board([])), null);
  const own = nextUp(board([finding('EX-1', { estimateMin: 20 })]), { medians: { fix: 45 } });
  assert.equal(own.estimateText, 'about 20 min');
  assert.equal(nextUp(board([finding('EX-1')])).estimateMin, null, 'no median, no estimate');
});

test('runMedians gives median minutes per pipeline from runs that got somewhere', () => {
  const m = runMedians([
    { pipeline: 'fix', status: 'committed', durationMs: 30 * 60000 },
    { pipeline: 'fix', status: 'committed', durationMs: 50 * 60000 },
    { pipeline: 'fix', status: 'committed', durationMs: 90 * 60000 },
    { pipeline: 'fix', status: 'cancelled', durationMs: 1 * 60000 },
    { pipeline: 'explain', status: 'passed', durationMs: 3 * 60000 },
    { pipeline: 'explain', status: 'passed', durationMs: 4 * 60000 },
  ]);
  assert.deepEqual(m, { fix: 50, explain: 4 });
});

test('phaseBars counts done and dismissed as closed and leaves proposed out', () => {
  const doc = board([
    finding('EX-1', { phase: '0', status: 'done' }), finding('EX-2', { phase: '0', status: 'dismissed' }),
    finding('EX-3', { phase: '0' }), finding('EX-4', { phase: '0', status: 'on-branch' }),
    finding('EX-5', { phase: '0', status: 'proposed' }), finding('EX-6', { phase: '9' }),
  ]);
  const [p0, p1] = phaseBars(doc);
  assert.deepEqual(p0, { id: '0', label: 'Phase 0: security', total: 4, closed: 2, left: 2, pct: 50, text: '2 of 4 closed · 2 left', leftIds: ['EX-3', 'EX-4'] });
  assert.equal(p1.total, 0);
  assert.equal(p1.text, 'No findings in this phase');
});

test('proposeFinding adds AP-<n> findings as proposed, once per run and ref', () => {
  let doc = board([finding('AP-2'), finding('EX-1')]);
  const a = proposeFinding(doc, { title: 'Unscoped lookup in a route', severity: 'high', evidence: 'x'.repeat(700), ref: 'c3' }, { runId: 'r9', at: AT });
  assert.equal(a.id, 'AP-3');
  assert.equal(a.created, true);
  doc = a.doc;
  const f = doc.findings.find(x => x.id === 'AP-3');
  assert.equal(f.status, 'proposed');
  assert.equal(f.evidence.length, 600);
  assert.deepEqual(f.history[0], { at: AT, from: null, to: 'proposed', by: 'run', reason: 'proposed by run r9' });
  const again = proposeFinding(doc, { title: 'Same thing', ref: 'c3' }, { runId: 'r9' });
  assert.equal(again.id, 'AP-3');
  assert.equal(again.created, false);
  assert.equal(proposeFinding(doc, { title: 'Other', severity: 'bogus' }, { runId: 'r9' }).doc.findings.at(-1).severity, 'medium');
  assert.throws(() => proposeFinding(doc, { title: ' ' }), e => e.status === 400);
  const accepted = setStatus(doc, 'AP-3', 'open', { by: 'user', at: AT });
  assert.equal(accepted.finding.status, 'open');
});

test('the pending import is kept next to the board and moved aside once applied', async t => {
  const dataDir = tempDir('ws-find-', t);
  assert.equal(await loadPendingImport(dataDir, 'example'), null);
  await savePendingImport(dataDir, 'example', { rows: [], hash: 'sha256:x' }, { baseHash: 'sha256:b', at: AT });
  assert.equal(importFile(dataDir, 'example'), join(dataDir, 'findings', 'example.import.json'));
  const p = await loadPendingImport(dataDir, 'example');
  assert.deepEqual(p, { version: 1, project: 'example', createdAt: AT, baseHash: 'sha256:b', proposal: { rows: [], hash: 'sha256:x' } });
  await clearPendingImport(dataDir, 'example');
  assert.equal(await loadPendingImport(dataDir, 'example'), null);
  assert.ok(existsSync(join(dataDir, 'findings', 'example.import.applied.json')), 'kept for reference, not deleted');
  await clearPendingImport(dataDir, 'example'); // nothing pending: no error
});
