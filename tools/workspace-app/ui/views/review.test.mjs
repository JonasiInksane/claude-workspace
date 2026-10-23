// Tests for the review gate view (views/review.js) in the stand-in DOM (test/dom.mjs): the header's
// Ask button (parts/ask-panel.js) shows once the run is loaded, opens the Ask panel labelled for the
// review gate, stays in step when the view rebuilds its header after a live signal (the panel lives
// outside the view, so it stays open), and gets the focus back when the panel closes.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, settle } from '../../test/dom.mjs';

const ID = '261022-100010-refactor-review-gate';
const dom = installDom({ hash: `#review/${ID}` });
after(() => dom.uninstall());
let updatedAt = '2026-10-22T08:18:44.935Z';
fakeFetch(path => {
  if (path.startsWith('/api/run?')) {
    return { ok: true, rows: [], next: 0, more: false, run: {
      id: ID, project: 'example', pipeline: 'refactor', title: 'Refactor: Move cart totals into a cents helper', status: 'waiting', waiting: { kind: 'review' },
      updatedAt, stages: [{ id: 'review', status: 'done', attempts: [] }, { id: 'review-gate', status: 'waiting' }], actions: [],
    } };
  }
  if (path.startsWith('/api/run-review?')) {
    return { ok: true, verdict: 'ship', findings: [], notProven: [], verified: false, proof: null, checks: null, gate: null, files: [], diffTruncated: false };
  }
  return { ok: true };
});
const store = await import('../store.js');
const { default: review } = await import('./review.js');

test('review: Ask in the header opens the Ask panel for this run, and stays in step when the header is rebuilt', async () => {
  const section = dom.document.createElement('section');
  section.id = 'view-review';
  dom.document.body.append(section);
  review.render(section, { sub: ID });
  assert.equal(section.querySelector('.ask-open-btn'), null, 'no Ask before the run is loaded');
  review.onShow({ sub: ID });
  await settle(10);
  const askBtn = section.querySelector('.view-head .ask-open-btn');
  assert.ok(askBtn, 'the header has an Ask button');
  assert.equal(askBtn.getAttribute('aria-label'), 'Ask about this review gate');
  dom.click(askBtn);
  const panel = dom.document.getElementById('ask-panel');
  assert.equal(panel.querySelector('.ask-title').textContent, 'Ask about this review gate');
  assert.equal(panel.querySelector('.ask-chip').textContent, 'Review gate · Refactor: Move cart totals into a cents helper');
  assert.equal(dom.document.activeElement, dom.document.getElementById('ask-input'));

  updatedAt = '2026-10-22T09:00:00.000Z';
  store.emitSignal({ run: ID, project: 'example', seq: null, status: 'waiting' });
  await settle(10);
  const fresh = section.querySelector('.view-head .ask-open-btn');
  assert.notEqual(fresh, askBtn, 'the header was rebuilt');
  assert.equal(panel.hidden, false, 'the panel stays open');
  assert.equal(fresh.getAttribute('aria-expanded'), 'true', 'the new Ask button says the panel is open');
  dom.key(dom.document.getElementById('ask-input'), 'Escape');
  assert.equal(panel.hidden, true);
  assert.equal(fresh.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.document.activeElement, fresh, 'the focus goes to the Ask button on screen now');
  review.onHide();
});
