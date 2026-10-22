// Tests for the pure helpers of the Today view (views/today.js): the heading line, change and
// trend texts, the Node line of a health card, the waiting-list keys and announcements, the Try
// chips, the running row's meta line and the action hrefs it follows. The view itself needs a
// browser; it loads in Node because nothing in it touches the DOM until it renders.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chipsFor, deltaText, headline, nodeText, routeOfHref, runningMeta, shorten, trendText, waitingAnnouncement, waitKey,
} from './today.js';

test('today: the heading line counts what waits and what runs', () => {
  assert.equal(headline(9, 1), '9 things wait for you · 1 running');
  assert.equal(headline(1, 0), '1 thing waits for you · nothing running');
  assert.equal(headline(0, 2), 'Nothing waits for you · 2 running');
});

test('today: changes and trends read as text, with a real minus sign', () => {
  assert.equal(deltaText(3), '+3');
  assert.equal(deltaText(-2), '−2');
  assert.equal(deltaText(0), '±0');
  assert.equal(deltaText(null), '');
  assert.equal(deltaText(Number.NaN), '');
  assert.equal(trendText({ value: 72, delta: 3, trend: 'better' }), '+3 this week');
  assert.equal(trendText({ value: 70, delta: -1, trend: 'worse' }), '−1 this week');
  assert.equal(trendText({ value: 70, delta: 0, trend: 'same' }), 'same as last week');
  assert.equal(trendText({ value: null, delta: 0 }), '');
  assert.equal(trendText(undefined), '');
});

test('today: the Node line says whether checks use the pinned version', () => {
  assert.equal(nodeText({ active: '20.15.1', pin: '20.15.1', matches: true }), '20.15.1 (pinned)');
  assert.equal(nodeText({ active: '24.11.1', pin: '20.15.1', matches: false }), '24.11.1 (project pins 20.15.1)');
  assert.equal(nodeText({ active: '24.11.1', pin: null, matches: null }), '24.11.1');
  assert.equal(nodeText(null), 'not known');
});

test('today: waiting keys tell runs, gates and other items apart', () => {
  assert.equal(waitKey({ kind: 'run', runId: 'r1', status: 'waiting', waiting: 'plan' }), 'run:r1:waiting:plan');
  assert.notEqual(waitKey({ kind: 'run', runId: 'r1', status: 'waiting', waiting: 'plan' }), waitKey({ kind: 'run', runId: 'r1', status: 'waiting', waiting: 'review' }));
  assert.equal(waitKey({ kind: 'baseline', project: 'example', key: 'standard' }), 'baseline:example:standard');
  assert.equal(waitKey({ kind: 'import', project: 'example' }), 'import:example:');
  assert.equal(waitKey(null), '');
});

test('today: announcements cover what main.js does not (stopped runs, baselines, imports)', () => {
  const map = items => new Map(items.map(w => [waitKey(w), w]));
  const gate = { kind: 'run', runId: 'a', status: 'waiting', waiting: 'plan', title: 'Plan run', badge: 'Approve plan' };
  const red = { kind: 'run', runId: 'b', status: 'gates-red', title: 'Cart refactor', badge: 'Checks red' };
  const base = { kind: 'baseline', project: 'example', key: 'standard', title: 'Smaller baseline available', badge: 'Accept?' };
  // A run that starts waiting at a gate: main.js announces it, so Today stays quiet.
  assert.equal(waitingAnnouncement(map([]), map([gate])), '');
  assert.equal(waitingAnnouncement(map([gate]), map([])), '');
  assert.equal(waitingAnnouncement(map([gate]), map([gate])), '');
  // One new stopped run or baseline: its title, its badge and the count.
  assert.equal(waitingAnnouncement(map([gate]), map([gate, red])), 'Cart refactor: Checks red. 2 things waiting for you.');
  assert.equal(waitingAnnouncement(map([]), map([base])), 'Smaller baseline available: Accept?. 1 thing waiting for you.');
  // Several at once, or something went away: just the count.
  assert.equal(waitingAnnouncement(map([]), map([red, base])), '2 things waiting for you.');
  assert.equal(waitingAnnouncement(map([red]), map([])), 'Nothing waits for you now.');
});

test('today: Try chips are generic, with examples from Next up and the latest run', () => {
  const generic = chipsFor(null).map(c => c.label);
  assert.deepEqual(generic, ['Refactor something', 'Fix a finding', 'Why does … fail?', 'Explain …']);
  const chips = chipsFor({
    nextUp: { id: 'F-12', title: 'Totals drift by a cent' },
    recent: [{ runId: 'x', title: 'Explain: How do sessions work?' }],
  });
  assert.deepEqual(chips.slice(4), [
    { label: 'Fix F-12', text: 'Fix F-12: Totals drift by a cent' },
    { label: 'Explain: How do sessions work?', text: 'Explain: How do sessions work?' },
  ]);
  // A failed part gives no example; a long title is shortened on the chip only.
  assert.equal(chipsFor({ nextUp: { error: 'boom' }, recent: { error: 'boom' } }).length, 4);
  const long = chipsFor({ recent: [{ runId: 'y', title: 'Refactor: '.padEnd(80, 'x') }] })[4];
  assert.equal(long.label.length, 40);
  assert.ok(long.label.endsWith('…'));
  assert.equal(long.text.length, 80);
  assert.equal(shorten('short', 40), 'short');
});

test('today: a running row shows stage, round, turns, minutes, tree and branch', () => {
  assert.deepEqual(runningMeta({ stageLabel: 'Implement', round: 1, turns: 23, maxTurns: 60, minutes: 11, tree: 'example-run', branch: 'app/1022-x' }),
    { bits: ['Implement', 'turns 23/60', '11 min', 'example-run'], branch: 'app/1022-x' });
  assert.deepEqual(runningMeta({ stageLabel: 'Fix', round: 2, turns: 4, maxTurns: null, minutes: 0, tree: 'main checkout', branch: null }),
    { bits: ['Fix', 'round 2', 'turns 4', '0 min', 'main checkout'], branch: '' });
  assert.deepEqual(runningMeta({ label: 'Example', stage: 'answer', minutes: 2 }, { withProject: true }), { bits: ['Example', 'answer', '2 min'], branch: '' });
  // An older answer without the fields: the server's own line.
  assert.deepEqual(runningMeta({ sub: 'Explain · 2 min' }), { bits: ['Explain · 2 min'], branch: '' });
});

test('today: only hash routes of the app are followed', () => {
  assert.deepEqual(routeOfHref('#run/261022-100005-explain-running'), { id: 'run', sub: '261022-100005-explain-running' });
  assert.deepEqual(routeOfHref('#cockpit/example'), { id: 'cockpit', sub: 'example' });
  assert.deepEqual(routeOfHref('#launcher'), { id: 'launcher', sub: '' });
  for (const bad of ['https://example.com/#run/x', 'javascript:alert(1)', '#', '#Run/x', '', null, 42]) assert.equal(routeOfHref(bad), null, String(bad));
});
