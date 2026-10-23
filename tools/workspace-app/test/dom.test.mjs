// Tests for the stand-in DOM the page's tests render into (test/dom.mjs): elements, attributes,
// dataset and classes, the selectors the page uses, events that bubble, focus that a removed node
// takes with it, the visible text, the fake fetch, and that uninstall() puts the globals back.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, textOf } from './dom.mjs';

test('elements: attributes, dataset, classes, children and text', () => {
  const dom = installDom();
  try {
    const d = dom.document;
    const el = d.createElement('div');
    el.className = 'card audit';
    el.dataset.key = 'k1';
    el.dataset.fixedLabel = '1';
    el.setAttribute('aria-label', 'Board');
    assert.equal(el.getAttribute('data-key'), 'k1');
    assert.equal(el.getAttribute('data-fixed-label'), '1');
    assert.equal(el.dataset.fixedLabel, '1');
    el.classList.add('x');
    el.classList.toggle('audit');
    assert.equal(el.className, 'card x');
    assert.equal(el.classList.contains('x'), true);
    el.append('Hello ', d.createElement('b'), 42);
    el.childNodes[1].textContent = 'world';
    assert.equal(el.textContent, 'Hello world42');
    assert.equal(el.children.length, 1);
    el.replaceChildren();
    assert.equal(el.childNodes.length, 0);
    const input = d.createElement('input');
    input.setAttribute('value', 'start');
    assert.equal(input.value, 'start');
    input.value = 'typed';
    assert.equal(input.value, 'typed');
    assert.equal(d.createElement('button').disabled, false, 'booleans start false');
  } finally { dom.uninstall(); }
});

test('selectors: tag, #id, .class, [attr], [attr="v"], lists and descendants', () => {
  const dom = installDom();
  try {
    const d = dom.document;
    const root = d.createElement('section');
    const list = d.createElement('div');
    list.setAttribute('role', 'tablist');
    for (const id of ['a', 'b']) {
      const b = d.createElement('button');
      b.id = `t-${id}`;
      b.setAttribute('role', 'tab');
      b.dataset.key = id;
      list.append(b);
    }
    const details = d.createElement('details');
    details.className = 'menu';
    details.open = true;
    root.append(list, details);
    d.body.append(root);
    assert.equal(root.querySelectorAll('[role="tab"]').length, 2);
    assert.equal(root.querySelector('#t-b').dataset.key, 'b');
    assert.equal(d.querySelector('#t-a').id, 't-a');
    assert.equal(root.querySelectorAll('[role=tablist] button').length, 2, 'descendants');
    assert.equal(root.querySelectorAll('details.menu[open]').length, 1, 'an open property counts as the attribute');
    assert.equal(root.querySelectorAll('span, button').length, 2);
    assert.equal(root.querySelector('[data-key="a"]').closest('section'), root);
    assert.equal(root.querySelector('.nope'), null);
    assert.equal(d.getElementById('t-a'), root.querySelector('#t-a'));
  } finally { dom.uninstall(); }
});

test('events bubble to the parents; focus goes with a removed node; text reads like a page', () => {
  const dom = installDom();
  try {
    const d = dom.document;
    const outer = d.createElement('div');
    const btn = d.createElement('button');
    outer.append(btn);
    d.body.append(outer);
    const seen = [];
    outer.addEventListener('keydown', e => seen.push(['outer', e.key, e.target === btn]));
    btn.addEventListener('keydown', e => seen.push(['btn', e.key]));
    const e = dom.key(btn, 'ArrowRight');
    assert.deepEqual(seen, [['btn', 'ArrowRight'], ['outer', 'ArrowRight', true]]);
    assert.equal(e.defaultPrevented, false);
    const stop = fakeEvent('keydown', { key: 'x' });
    btn.addEventListener('keydown', ev => ev.stopPropagation());
    btn.dispatchEvent(stop);
    assert.equal(seen.length, 3, 'stopPropagation keeps it from the parents');
    btn.focus();
    assert.equal(d.activeElement, btn);
    outer.remove();
    assert.equal(d.activeElement, d.body, 'a removed node takes the focus with it');
    const p = d.createElement('p');
    const code = d.createElement('code');
    code.append('abc1234');
    p.append('Base ', code, ': 2 → 1.');
    const box = d.createElement('div');
    const h3 = d.createElement('h3');
    h3.append('Title');
    box.append(h3, p);
    assert.equal(textOf(box), 'Title Base abc1234: 2 → 1.');
  } finally { dom.uninstall(); }
});

test('fakeFetch answers JSON or another status and keeps every call; uninstall puts the globals back', async () => {
  const had = typeof globalThis.document;
  const dom = installDom();
  const calls = fakeFetch(path => (path === '/x' ? { ok: true, n: 1 } : reply(404, { ok: false, error: 'no' })));
  const a = await fetch('/x');
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { ok: true, n: 1 });
  const b = await fetch('/y', { method: 'POST', body: JSON.stringify({ q: 1 }) });
  assert.equal(b.ok, false);
  assert.equal(b.status, 404);
  assert.equal(b.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(calls, [{ path: '/x', method: 'GET', body: undefined }, { path: '/y', method: 'POST', body: { q: 1 } }]);
  let fired = false;
  setTimeout(() => { fired = true; }, 20);
  dom.uninstall();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(fired, false, 'uninstall clears the timers the page made');
  assert.equal(typeof globalThis.document, had);
  assert.equal(typeof globalThis.location, 'undefined');
});
