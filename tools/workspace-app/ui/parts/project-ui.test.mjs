// Tests for the project page's small builders (parts/project-ui.js) in a stand-in DOM
// (test/dom.mjs): a button with its data-key and the id of its visible reason, a card head
// without empty actions, an error note whose Try again loads the tab's data again, a state card,
// badges and results with their classes, pipeline labels and short commit ids; which names the
// data folder takes, and why Claude can't start in a project.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_RE } from '../../core/datadir.mjs';
import { fakeFetch, installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch(() => ({ ok: true }));
const { use } = await import('./project-data.js');
const { badgeEl, btn, cardHead, DATA_NAME_RE, errorNote, pipeLabel, resEl, short, startProblem, stateCard } = await import('./project-ui.js');

test('startProblem: why Claude can not start in a project, in words', () => {
  const p = { name: 'example', realPath: 'C:\\ws\\projects\\example', linked: false, launchable: true };
  assert.equal(startProblem(p, { claude: true }), '');
  assert.equal(startProblem(p, {}), 'Claude Code was not found.');
  assert.equal(startProblem(p), 'Claude Code was not found.', 'no tools: nothing to start with');
  assert.match(startProblem({ ...p, launchable: false }, { claude: true }), /unusual characters/, 'checked before Claude itself');
  assert.equal(startProblem({ ...p, realPath: '' }, { claude: true }), 'Link the checkout first.');
  assert.match(startProblem({ ...p, linked: true, realPath: '' }, { claude: true }), /linked folder is gone/);
  assert.equal(startProblem(null), 'Link the checkout first.');
});

test('DATA_NAME_RE takes the names the data folder takes, and no others', () => {
  for (const name of ['example', 'sample-art', 'a1', 'x-2-y']) assert.ok(DATA_NAME_RE.test(name) && PROJECT_RE.test(name), name);
  for (const name of ['Example', 'my app', 'a--b', '-a', 'a-', '', '..', 'a/b', 'café']) {
    assert.equal(DATA_NAME_RE.test(name), PROJECT_RE.test(name), `${name}: the same answer as core/datadir.mjs`);
    assert.equal(DATA_NAME_RE.test(name), false, name);
  }
});

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
  assert.equal(plain.getAttribute('aria-label'), null);
  assert.equal(btn('k3', 'Open', () => {}, { ariaLabel: 'Open the Quick check run' }).getAttribute('aria-label'), 'Open the Quick check run');
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
