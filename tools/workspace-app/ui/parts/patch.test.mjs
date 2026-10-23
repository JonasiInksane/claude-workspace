// Tests for parts/patch.js in a stand-in DOM (test/dom.mjs): patch() keeps the nodes that stay
// (and so the focus inside them), removes stale ones, puts new ones in order, skips nulls and
// flattens one level of lists; createMemo() hands back the same node while its deps are the same;
// createBlocks() keeps one container per key. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../../test/dom.mjs';
import { createBlocks, createMemo, patch } from './patch.js';

const dom = installDom();
after(() => dom.uninstall());
const el = (tag, text = '') => { const e = dom.document.createElement(tag); if (text) e.textContent = text; return e; };

test('patch: exactly the given nodes, in order; nodes that stay are not moved out and back', () => {
  const parent = el('div');
  dom.document.body.append(parent);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(t => el('p', t));
  patch(parent, [a, b, c]);
  assert.deepEqual(parent.childNodes, [a, b, c]);
  const input = el('input');
  b.append(input);
  input.focus();
  patch(parent, [b, null, [d, c]]);
  assert.deepEqual(parent.childNodes, [b, d, c], 'a is gone, d came in, a nested list is flattened, null skipped');
  assert.equal(a.parentNode, null);
  assert.equal(dom.document.activeElement, input, 'the focus inside a node that stays is kept');
  patch(parent, [c]);
  assert.deepEqual(parent.childNodes, [c]);
  assert.notEqual(dom.document.activeElement, input, 'a removed node takes the focus with it');
  assert.equal(patch(parent, []), parent);
  assert.deepEqual(parent.childNodes, []);
});

test('createMemo: the same node while the deps are the same, a new one when they change', () => {
  const memo = createMemo();
  let builds = 0;
  const build = () => { builds++; return el('div', String(builds)); };
  const one = memo('k', [1, { a: 2 }], build);
  assert.equal(memo('k', [1, { a: 2 }], build), one);
  assert.equal(builds, 1);
  const two = memo('k', [1, { a: 3 }], build);
  assert.notEqual(two, one);
  assert.equal(memo('other', [1, { a: 3 }], build).textContent, '3', 'keys are separate');
  assert.equal(memo('none', undefined, build), memo('none', undefined, build), 'no deps: built once');
});

test('createBlocks: one container per key, patched with the nodes it gets', () => {
  const block = createBlocks(cls => { const d = el('div'); d.className = cls; return d; });
  const x = el('p', 'x');
  const first = block('k', 'grid2', [x]);
  assert.equal(first.className, 'grid2');
  assert.deepEqual(first.childNodes, [x]);
  const y = el('p', 'y');
  assert.equal(block('k', 'grid2', [y, x]), first, 'the same container');
  assert.deepEqual(first.childNodes, [y, x]);
  assert.notEqual(block('j', 'grid3', []), first);
});
