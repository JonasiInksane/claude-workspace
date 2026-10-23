// Tests for the project page's Findings tab (views/project/findings.js, the cockpit's Audit
// progress card shown full width): status words, and the tab in a stand-in DOM (test/dom.mjs):
// loading and errors, the empty board, the phase bar, a waiting import, the four columns, a card
// that starts Fix, and Import findings sending the project's name. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, reply, settle, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch((path, { method }) => {
  if (method === 'POST' && path === '/api/findings/import') return reply(400, { ok: false, error: 'The profile names no audit.' });
  return { ok: true, pipelines: [], routes: [] };
});
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { statusWord, default: findings } = await import('./findings.js');

test('status words', () => {
  assert.deepEqual(['proposed', 'open', 'in-run', 'on-branch', 'done', 'dismissed'].map(statusWord), ['Proposed', 'Open', 'In run', 'On branch', 'Done', 'Dismissed']);
  assert.equal(statusWord(''), 'New');
  assert.equal(statusWord(undefined), 'New');
  assert.equal(statusWord('odd'), 'odd');
  assert.equal(statusWord('constructor'), 'constructor', 'no prototype lookups');
});

const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'findings'], realPath: 'C:\\x' };
const ctx = () => ({ state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
const col = (id, items) => ({ id, label: id, count: items.length, items });

test('the tab: loading, a failed load, and a board with no findings yet', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  const el = dom.document.createElement('div');
  findings.render(el, ctx());
  assert.match(textOf(el), /Audit progress.*Loading…/);
  slot('example').findings = { data: undefined, error: 'Could not reach the app server', status: undefined };
  findings.render(el, ctx());
  assert.match(textOf(el), /Could not reach the app server/);
  slot('example').findings = { data: { columns: [col('open', []), col('in-run', []), col('on-branch', []), col('done', [])], phases: [] } };
  findings.render(el, ctx());
  assert.match(textOf(el), /No findings yet/);
});

test('the tab: the phase bar, a waiting import, and a card that starts Fix in this project', () => {
  const open = [{ id: 'EX-3', title: 'Totals in floats', severity: 'high', phase: '1', status: 'open', records: [], commits: [] }];
  slot('example').findings = { data: {
    columns: [col('open', open), col('in-run', []), col('on-branch', []), col('done', [])],
    phases: [{ id: '1', total: 4, left: 3, pct: 25, text: '1 of 4 done' }],
    importPending: { counts: { changed: 2 }, proposal: { rows: [], hash: 'h' } }, nextUp: { id: 'EX-3' },
  } };
  const el = dom.document.createElement('div');
  findings.render(el, ctx());
  const text = textOf(el);
  assert.match(text, /Phase 1/);
  assert.match(text, /1 of 4 done/);
  assert.match(text, /An import is waiting for you: 2 findings would change\./);
  const card = el.querySelectorAll('button').find(b => /EX-3/.test(b.textContent));
  assert.ok(card, 'the open finding is a button');
  dom.click(card);
  assert.equal(dom.location.hash, '#launcher/fix', 'an open finding opens Fix');
  assert.equal(store.launchDraft.findingId, 'EX-3');
  assert.equal(store.launchDraft.project, 'example');
});

test('the tab: Import findings asks the server for this project and shows its refusal', async () => {
  const el = dom.document.createElement('div');
  findings.render(el, ctx());
  dom.click(el.querySelector('[data-key="import"]'));
  await settle(5);
  const call = calls.find(c => c.path === '/api/findings/import');
  assert.deepEqual(call && call.body, { project: 'example' });
  assert.match(dom.document.querySelector('#toasts').textContent, /The profile names no audit\./, 'a refusal shows as an error toast');
});
