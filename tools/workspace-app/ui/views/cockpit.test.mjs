// Tests for the pure helpers of the cockpit and health views (UI-COCKPIT): the findings board's
// card text and column split (parts/kanban.js), the facts bar badges, the quick row's disabled
// reasons and the check results (views/cockpit.js), and the health tiles' words (views/health.js).
// The views need a browser to render, so only these functions are tested here. dialog.js looks
// up #dialog when it loads, so a minimal `document` stands in for it before the views load.
// Run: node --test tools/workspace-app/ui/views/cockpit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAction, cardMeta, moreText, recordText, severityClass, splitColumn } from '../parts/kanban.js';

globalThis.document = { querySelector: () => ({ addEventListener() {} }) };
const { ageText, checkResult, factsBadges, quickRow } = await import('./cockpit.js');
const { badgeClass, changeView, needsYou, sparkLabel, trendText, verdictBadge } = await import('./health.js');

const finding = over => ({ id: 'EX-1', title: 'A thing', severity: 'high', phase: '1', area: '', status: 'open', ownerDecision: false,
  records: [], commits: [], branch: null, runId: null, ...over });

test('kanban: card text says severity, phase and a tag per column, in words', () => {
  assert.equal(cardMeta(finding(), 'open', { nextUpId: 'EX-1' }), 'High · Phase 1 · next up');
  assert.equal(cardMeta(finding({ status: 'proposed', phase: null }), 'open'), 'High · proposed');
  assert.equal(cardMeta(finding({ ownerDecision: true }), 'open'), 'High · Phase 1 · owner decision');
  assert.equal(cardMeta(finding({ area: 'members', severity: 'medium' }), 'open'), 'Medium · Phase 1 · members');
  const runs = new Map([['r1', { id: 'r1', pipeline: 'refactor', status: 'waiting' }]]);
  assert.equal(cardMeta(finding({ status: 'in-run', runId: 'r1' }), 'in-run', { runs }), 'High · Phase 1 · Refactor: Needs you');
  assert.equal(cardMeta(finding({ status: 'in-run', runId: 'gone' }), 'in-run', { runs }), 'High · Phase 1 · in a run');
  assert.equal(cardMeta(finding({ status: 'on-branch', branch: 'app/1021-x' }), 'on-branch'), 'High · Phase 1 · app/1021-x');
  assert.equal(cardMeta(finding({ status: 'done', severity: 'critical', commits: ['0123456789abcdef'] }), 'done'), 'Critical · Phase 1 · 0123456');
  assert.equal(cardMeta(finding({ status: 'done', records: ['REC-ONE'] }), 'done'), 'High · Phase 1 · REC-ONE');
});

test('kanban: a click does what its column says; border classes follow severity', () => {
  assert.equal(cardAction('open', finding()).kind, 'fix');
  assert.equal(cardAction('open', finding({ status: 'proposed' })).kind, 'proposed');
  assert.equal(cardAction('in-run', finding({ runId: 'r1' })).kind, 'run');
  assert.equal(cardAction('in-run', finding()).kind, 'record');
  assert.equal(cardAction('on-branch', finding()).kind, 'review');
  assert.equal(cardAction('done', finding()).kind, 'record');
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(severity => severityClass({ severity }, 'open')), ['high', 'high', 'med', 'low']);
  assert.equal(severityClass({ severity: 'low' }, 'done'), 'done');
});

test('kanban: long columns show the first cards and say what they hide', () => {
  const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => ({ id }));
  assert.deepEqual(splitColumn(items, 5).shown.map(f => f.id), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(splitColumn(items, 5).hidden.map(f => f.id), ['F', 'G']);
  assert.deepEqual(splitColumn(items, 5, true).hidden, []);
  assert.deepEqual(splitColumn(undefined, 5), { shown: [], hidden: [] });
  assert.equal(moreText([{ id: 'F' }, { id: 'G' }, { id: 'H' }]), '+ 3 more, including F and G');
  assert.equal(moreText([{ id: 'F' }]), '+ 1 more: F');
  assert.equal(moreText([]), '');
  assert.equal(recordText(finding({ status: 'done', records: ['REC-ONE'], commits: ['0123456789'] })), 'EX-1: record REC-ONE · commit 0123456');
  assert.equal(recordText(finding({ status: 'done' })), 'EX-1 is done; no record or commit is recorded.');
});

const project = over => ({
  project: { label: 'Example', present: true },
  git: { branch: 'main', sha: 'abcdef1234', detached: false, changed: 2, ahead: 0, behind: 0, upstream: 'origin/main', stashes: { total: 20, onBranch: 3 } },
  isolation: { mode: 'worktree', worktree: { name: 'run-tree', state: 'ready' } },
  trust: { state: 'trusted' },
  lock: { held: true, runId: 'r1', title: 'Refactor: totals' },
  node: { active: '24.11.1', pin: '20.15.1', matches: false },
  warnings: [{ id: 'services.running', text: 'Local services are running on port 5432.' }, { id: 'lock.waiting', text: 'waited 3 days' }],
  ...over,
});

test('cockpit: facts bar badges say every fact in words', () => {
  const b = factsBadges(project());
  assert.deepEqual(b.map(x => x.text), [
    'main', '2 changed', 'Even with origin/main', '20 stashes · 3 on this branch · untouched', 'Trusted',
    'run-tree busy: Refactor: totals', 'Checks use Node 24.11.1 · Example pins 20.15.1', 'Local services are running on port 5432.',
  ]);
  assert.equal(b.find(x => x.text.startsWith('Checks use')).cls, 'amber', 'a Node that differs from the pin is amber');
  assert.ok(!b.some(x => x.text === 'waited 3 days'), 'the lock warning gets its own note');
  const other = factsBadges(project({
    git: { branch: null, sha: 'abcdef1234', detached: true, changed: 0, ahead: 2, behind: 1, upstream: 'origin/main', stashes: { total: 1, onBranch: 0 } },
    isolation: { mode: 'branch' }, trust: { state: 'not-trusted' }, lock: { held: false }, node: { active: '20.15.1', pin: '20.15.1', matches: true }, warnings: [],
  })).map(x => x.text);
  assert.deepEqual(other, ['Detached at abcdef1', 'Clean', '2 ahead, 1 behind of origin/main', '1 stash · 0 on this branch · untouched',
    'Branch mode', 'Not trusted', 'No lock', 'Checks use Node 20.15.1 · Example pins 20.15.1']);
  assert.deepEqual(factsBadges(project({ git: { error: 'not a git repository' }, lock: { error: 'x' }, node: null, warnings: [] })).map(x => x.text),
    ['Git could not read the checkout', 'Trusted']);
  assert.deepEqual(factsBadges({ git: null, trust: { state: 'unknown' }, lock: { held: false } }).map(x => x.text), ['No lock'],
    'no trust badge before the checkout is linked');
});

test('cockpit: the quick row disables editing pipelines until the run worktree is ready', () => {
  const list = ['explain', 'check', 'fix', 'refactor', 'review', 'architecture', 'debug', 'feature'].map(id => ({
    id, label: id, disabledReason: '', isolation: ['fix', 'refactor', 'debug', 'feature'].includes(id) ? 'tree' : 'none',
  }));
  const ready = quickRow(list, project());
  assert.deepEqual(ready.map(q => q.pipeline), ['fix', 'refactor', 'debug', 'feature', 'review', 'architecture', 'explain', 'check']);
  assert.ok(ready.every(q => !q.disabledReason));
  const notReady = quickRow(list, project({ isolation: { mode: 'worktree', worktree: { name: 'run-tree', state: 'none' } } }));
  assert.deepEqual(notReady.filter(q => q.disabledReason).map(q => [q.pipeline, q.disabledReason]),
    ['fix', 'refactor', 'debug', 'feature'].map(id => [id, 'needs run-tree: Set up first']));
  assert.ok(quickRow(list, project({ isolation: { mode: 'branch', worktree: { state: 'none' } } })).every(q => !q.disabledReason), 'branch mode needs no worktree');
  const noProfile = quickRow(list.map(p => ({ ...p, disabledReason: 'No profile yet.' })), null);
  assert.ok(noProfile.every(q => q.disabledReason === 'No profile yet.'));
  assert.deepEqual(quickRow([], project()), []);
});

test('cockpit: check results and lock ages as text', () => {
  assert.deepEqual(checkResult(null), { cls: 'skip', text: 'Not run yet', icon: '' });
  assert.equal(checkResult({ result: 'pass', chip: '0 new · 61 known' }).text, 'Pass · 0 new · 61 known');
  assert.equal(checkResult({ result: 'fail', chip: '1 new' }).cls, 'fail');
  assert.equal(checkResult({ result: 'refused' }).text, 'Refused');
  assert.equal(checkResult({ result: 'odd' }).text, 'odd');
  assert.deepEqual([ageText(30), ageText(700), ageText(5 * 3600), ageText(3 * 86400 + 5), ageText(null), ageText(-1)],
    ['1 min', '12 min', '5 h', '3 days', '', '']);
});

test('health: tiles, lenses and candidates in words', () => {
  assert.equal(trendText({ value: 3, trend: 'better' }), 'Better');
  assert.equal(trendText({ value: null, trend: 'same' }), '', 'no trend word without a value');
  assert.equal(sparkLabel({ id: 'deepImports', label: 'Deep imports', summary: '11, down 1 this week', spark: [14, 12, 11] }),
    'Deep imports: 11, down 1 this week. Last 3 scans: 14 to 11.');
  assert.equal(sparkLabel({ id: 'knownFailures', label: 'Known failures', summary: '3', spark: [3] }), 'Known failures: 3. Last 1 check: 3 to 3.');
  assert.equal(sparkLabel({ id: 'x', label: 'X', display: 'No scan yet', spark: [] }), 'X: No scan yet.');
  assert.deepEqual(changeView({ delta: 1, change: '+1' }), { cls: 'res warn', text: '+1 new' });
  assert.deepEqual(changeView({ delta: -2, change: '−2' }), { cls: 'res pass', text: '−2' });
  assert.deepEqual(changeView({ delta: 0, change: 'same' }), { cls: 'muted', text: 'same' });
  assert.deepEqual(changeView({ delta: null, change: '', error: 'probe failed' }), { cls: 'muted', text: '' });
  assert.deepEqual(['issue', 'owner-decision', 'noise', null].map(v => verdictBadge(v).text), ['Issue', 'You decide', 'Noise', 'Not triaged']);
  assert.deepEqual(['Within allowlist', 'At goal', 'Probe failed', '2 outside the allowlist', 'Partial graph'].map(badgeClass), ['ok', 'ok', 'red', 'red', 'amber']);
  assert.equal(needsYou([{ verdict: 'issue' }, { verdict: 'owner-decision', decision: { decision: 'keep' } }, { verdict: 'noise' }, { verdict: 'owner-decision' }]), 2);
});
