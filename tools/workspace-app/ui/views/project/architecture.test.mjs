// Tests for the project page's Architecture tab (views/project/architecture.js, the old Health and
// wins screen): the tiles', lenses' and candidates' words (moved from the cockpit's tests), and the
// tab in a stand-in DOM (test/dom.mjs): the head with Run architecture check, a first scan's empty
// state, and the cards once the metrics are in. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { badgeClass, changeView, needsYou, sparkLabel, trendText, verdictBadge, default: architecture } = await import('./architecture.js');

test('tiles, lenses and candidates in words', () => {
  assert.equal(trendText({ value: 3, trend: 'better' }), 'Better');
  assert.equal(trendText({ value: null, trend: 'same' }), '', 'no trend word without a value');
  assert.equal(trendText(null), '');
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
  assert.equal(needsYou(undefined), 0);
});

const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'architecture'], realPath: 'C:\\x' };
const ctx = () => ({ state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });

test('the tab: loading, then a project with no scan yet', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  const el = dom.document.createElement('div');
  architecture.render(el, ctx());
  assert.match(textOf(el), /Architecture health and wins/);
  assert.match(textOf(el), /Loading…/);
  slot('example').metrics = { data: { score: { value: null }, latest: null, tiles: [], lenses: [], candidates: null, boss: {}, wins: [], achievements: [], weekly: [] } };
  architecture.render(el, ctx());
  const text = textOf(el);
  assert.match(text, /No scan yet/);
  assert.equal(el.querySelector('[data-key="rebuild"]').disabled, true, 'Rebuild allowlist needs a scan first');
  assert.match(el.querySelector('#hl-rebuild-why').textContent, /Needs a scan first/);
  dom.click(el.querySelector('[data-key="arch"]'));
  assert.equal(dom.location.hash, '#launcher/architecture', 'Run architecture check opens the launcher');
});

test('the tab: the score, a tile with its trend in words, lenses and a candidate that needs you', () => {
  slot('example').metrics = { data: {
    score: { value: 72, delta: 3, trend: 'better', spark: [69, 72] }, latest: { id: 's1', at: new Date().toISOString() },
    tiles: [{ id: 'deepImports', label: 'Deep imports', display: '11', value: 11, trend: 'better', spark: [12, 11], summary: '11', badge: 'Within allowlist' }],
    lenses: [{ label: 'Cycles', now: 2, delta: 1, change: '+1' }],
    candidates: { runId: 'r9', status: 'waiting', waiting: 'decide', items: [{ ref: 'c1', label: 'Raw SQL', path: 'src/a.ts', line: 3, verdict: 'owner-decision' }] },
    boss: { phase: 1, total: 4, hp: 2, pct: 50, text: '2 HP left', ids: ['EX-1', 'EX-2'] }, wins: [], achievements: [], weekly: [],
  } };
  const el = dom.document.createElement('div');
  architecture.render(el, ctx());
  const text = textOf(el);
  assert.match(text, /Health score 72/);
  assert.match(text, /\+3 this week/);
  assert.match(text, /Deep imports\s*Better/);
  assert.match(text, /Within allowlist/);
  assert.match(text, /Cycles 2 \+1 new/);
  assert.match(text, /1 needs you/);
  assert.equal(el.querySelector('[data-key="cand:decide:c1"]').disabled, false, 'the check waits for decisions: Decide is on');
  assert.match(text, /Phase 1 boss/);
});
