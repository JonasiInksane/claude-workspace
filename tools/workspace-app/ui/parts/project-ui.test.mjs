// Tests for the project page's small builders (parts/project-ui.js) in a stand-in DOM
// (test/dom.mjs): a button with its data-key and the id of its visible reason, a card head
// without empty actions, an error note whose Try again loads the tab's data again, a state card,
// badges and results with their classes, pipeline labels and short commit ids.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch(() => ({ ok: true }));
const { use } = await import('./project-data.js');
const { badgeEl, btn, cardHead, errorNote, pipeLabel, resEl, short, stateCard } = await import('./project-ui.js');

test('btn: a typed button with its key, its reason and its handler', () => {
  let clicks = 0;
  const b = btn('k1', 'Go', () => { clicks++; }, { cls: 'btn primary', disabled: true, describedBy: 'why-1', title: 'Goes' });
  assert.equal(b.tagName, 'BUTTON');
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(b.dataset.key, 'k1');
  assert.equal(b.getAttribute('aria-describedby'), 'why-1');
  assert.equal(b.getAttribute('title'), 'Goes');
  assert.equal(b.disabled, true);
  assert.equal(b.className, 'btn primary');
  dom.click(b);
  assert.equal(clicks, 1);
  const plain = btn('k2', 'Plain', () => {});
  assert.equal(plain.className, 'btn small');
  assert.equal(plain.getAttribute('aria-describedby'), null, 'no reason: no aria-describedby');
});

test('cardHead leaves out empty actions; stateCard and the badges say everything in words', () => {
  assert.equal(cardHead('Checks', null, false).querySelector('.row-actions'), null);
  assert.equal(cardHead('Checks', btn('a', 'A', () => {}), [null, btn('b', 'B', () => {})]).querySelector('.row-actions').children.length, 2);
  assert.equal(textOf(stateCard('No project named x', 'Pick another.')), 'No project named xPick another.');
  assert.equal(badgeEl({ text: 'Clean', cls: 'ok' }).className, 'badge ok');
  assert.equal(badgeEl({ text: 'A long warning', cls: 'amber', wrap: true }).className, 'badge amber wrap');
  assert.equal(badgeEl({ text: 'main', cls: '', icon: 'branch' }).querySelector('svg').tagName, 'SVG');
  assert.equal(resEl({ cls: 'pass', text: 'Pass', icon: 'pass' }).className, 'res pass');
  assert.equal(resEl({ cls: 'skip', text: 'Not run yet', icon: '' }).querySelector('svg'), null);
});

test('errorNote: Try again loads the data in use again', async () => {
  const release = use('example', ['checks']);
  await settle(5);
  const before = calls.filter(c => c.path === '/api/checks?project=example').length;
  const note = errorNote('Could not load.', 'checks');
  assert.match(textOf(note), /Could not load\. Try again/);
  const again = note.querySelector('[data-key="retry:checks"]');
  dom.click(again);
  await settle(5);
  assert.equal(calls.filter(c => c.path === '/api/checks?project=example').length, before + 1);
  release();
});

test('pipelineLabel and short', () => {
  assert.equal(pipeLabel('refactor'), 'Refactor', 'before the catalog loads: the id with a capital');
  assert.equal(pipeLabel(''), 'Run');
  assert.equal(short('0123456789abcdef'), '0123456');
  assert.equal(short(null), '');
});
