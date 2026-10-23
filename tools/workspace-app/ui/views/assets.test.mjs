// Tests for the Assets view (views/assets.js) in a stand-in DOM with a fake server (test/dom.mjs):
// the Library first (loading, an error with Try again, no assets yet, the cards), its filters by
// place, kind, tag, search and archived with the count, the filter bar kept across repaints, a
// card opening the details, New asset… starting in the place the filter shows, pasted or dropped
// files opening it, and the game assets section and Inbox images after it.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());

const entry = (ref, title, kind, tags = [], over = {}) => {
  const [place, id] = ref.split(':');
  return {
    ref, id, scope: place === 'shared' ? 'shared' : 'project', project: place === 'shared' ? null : place, title, kind, tags, description: '',
    archived: false, latest: { n: 1, sha256: 'a'.repeat(64), bytes: 300, type: 'image/png' }, versionCount: 1, ...over,
  };
};
let library = [
  entry('shared:guide', 'Writing style', 'text', ['docs']),
  entry('shared:brand', 'Brand colours', 'image', ['brand']),
  entry('shared:old', 'Old logo', 'image', ['brand'], { archived: true }),
  entry('example:wire', 'Checkout wireframe', 'image', ['ux'], { description: 'The cart page' }),
  entry('notes:list', 'Reading list', 'text', []),
];
let fail = false;
const calls = fakeFetch((path, { method }) => {
  const url = new URL(path, 'http://x');
  if (method === 'GET' && url.pathname === '/api/library') return fail ? reply(500, { ok: false, error: 'the inbox can not be read' }) : { ok: true, assets: library };
  if (method === 'GET' && url.pathname === '/api/library/asset') {
    const a = library.find(x => x.ref === url.searchParams.get('ref'));
    return { ok: true, asset: { ...a, createdAt: '', versions: [{ n: 1, file: 'v1.png', sha256: 'b'.repeat(64), bytes: 1, type: 'image/png', addedAt: '', note: '', originalName: '' }] } };
  }
  return { ok: true };
});
const base = globalThis.fetch;
globalThis.fetch = (path, opts) => (String(path).startsWith('/library-file') ? Promise.resolve({ ok: true, status: 200, text: async () => '# Text\n' }) : base(path, opts));
globalThis.confirm = () => true;

const store = await import('../store.js');
const { countText, placeForNew, default: view } = await import('./assets.js');
const dialog = dom.document.querySelector('#dialog');
const crate = { id: 'lowpoly/props/Crate', kind: 'model', name: 'Crate', style: 'lowpoly', category: 'props', cls: '', source: 'procedural', status: 'review', final: null, raw: null, thumb: '' };
store.setState({ root: 'C:\\ws', tools: {}, projects: [{ name: 'example' }, { name: 'notes' }, { name: 'sample-art' }], assets: [{ project: 'sample-art', assets: [crate] }] });

const el = dom.document.createElement('section');
dom.document.body.append(el);
const paint = () => view.render(el, { state: store.state, sub: '' });
const cards = () => el.querySelectorAll('.lib-results .lib-card .lib-title').map(t => t.textContent);
const choose = (id, value) => { const s = el.querySelector(`#${id}`); s.value = value; s.dispatchEvent(fakeEvent('change')); };

test('countText and placeForNew', () => {
  assert.equal(countText(4, library), '4 assets');
  assert.equal(countText(2, library), '2 of 4 assets');
  assert.equal(countText(5, library, true), '5 assets');
  assert.equal(countText(0, []), '0 assets');
  assert.deepEqual(['project:example', 'shared', '', null].map(placeForNew), ['project:example', 'shared', 'shared', 'shared']);
});

test('the Library first: loading, then the cards; the game assets and Inbox images after it', async () => {
  paint();
  assert.match(textOf(el), /^Assets .* New asset…\s*Inbox images Library .* Loading the library… Game assets sample-art 1 asset/);
  // The first load fails: the reason, with Try again.
  fail = true;
  view.onShow();
  await settle(5);
  assert.match(textOf(el), /The library could not be read: the inbox can not be read Try again/);
  fail = false;
  dom.click(el.querySelector('[data-key="lib:retry"]'));
  await settle(5);
  view.onHide();
  view.onShow();
  await settle(5);
  assert.deepEqual(cards(), ['Writing style', 'Brand colours', 'Checkout wireframe', 'Reading list'], 'archived ones wait for Show archived');
  assert.equal(textOf(el.querySelector('.lib-count')), '4 assets');
  assert.ok(calls.some(c => c.path === '/api/library?archived=1'));
  assert.deepEqual(el.querySelectorAll('#libPlaceFilter option').map(o => o.textContent), ['Everywhere', 'Shared', 'example', 'notes', 'sample-art']);
  assert.deepEqual(el.querySelectorAll('#libTagFilter option').map(o => o.textContent), ['Every tag', 'brand', 'docs', 'ux']);
  dom.click(el.querySelector('[data-key="inbox-images"]'));
  assert.equal(dom.location.hash, '#images');
});

test('filters: place, kind, tag, search and archived narrow the cards; the bar survives a repaint', async () => {
  const bar = el.querySelector('.lib-filters');
  choose('libPlaceFilter', 'shared');
  assert.deepEqual(cards(), ['Writing style', 'Brand colours']);
  assert.equal(textOf(el.querySelector('.lib-count')), '2 of 4 assets');
  choose('libKindFilter', 'image');
  assert.deepEqual(cards(), ['Brand colours']);
  const archived = el.querySelector('.lib-filters .check input');
  archived.checked = true;
  archived.dispatchEvent(fakeEvent('change'));
  assert.deepEqual(cards(), ['Brand colours', 'Old logo']);
  choose('libTagFilter', 'brand');
  assert.deepEqual(cards(), ['Brand colours', 'Old logo']);
  paint();
  assert.equal(el.querySelector('.lib-filters'), bar, 'kept, so a select stays open and the caret stays');
  assert.equal(el.querySelector('#libKindFilter').value, 'image');
  choose('libPlaceFilter', '');
  choose('libKindFilter', '');
  choose('libTagFilter', '');
  const search = el.querySelector('#libSearch');
  search.value = 'cart page';
  search.dispatchEvent(fakeEvent('input'));
  await settle(150);
  assert.deepEqual(cards(), ['Checkout wireframe'], 'the description counts');
  search.value = 'nothing like it';
  search.dispatchEvent(fakeEvent('input'));
  await settle(150);
  assert.match(textOf(el), /Nothing matches these filters/);
  dom.click(el.querySelector('[data-key="lib:clear"]'));
  assert.deepEqual(cards().length, 4);
  assert.equal(search.value, '');
  assert.equal(dom.document.activeElement, search);
});

test('a card opens the details; New asset… starts in the place the filter shows; dropped files open it', async () => {
  dom.click(el.querySelector('[data-key="lib:open:shared:brand"]'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#dialogTitle').textContent, 'Brand colours');
  dialog.close();
  choose('libPlaceFilter', 'project:notes');
  dom.click(el.querySelector('[data-key="lib:new"]'));
  assert.equal(dialog.querySelector('#libPlace').value, 'project:notes');
  dialog.close();
  choose('libPlaceFilter', '');
  view.onFiles([{ name: 'diagram.png', size: 5, type: 'image/png' }], false);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#libPlace').value, 'shared');
  assert.equal(dialog.querySelector('#libNewTitle').value, 'diagram');
  dialog.close();
  view.onFiles([{ name: 'image.png', size: 5, type: 'image/png' }], true);
  assert.match(dialog.querySelector('#libNewTitle').value, /^Pasted image /);
  dialog.close();
});

test('an error says so with Try again; an empty library says what it is for; no pipeline says so too', async () => {
  fail = true;
  view.onShow();
  await settle(5);
  assert.deepEqual(cards().length, 4, 'the last answer stays while a refresh fails');
  view.onHide();
  fail = false;
  library = [];
  dom.window.dispatchEvent(fakeEvent('focus', { bubbles: false }));
  view.onShow();
  await settle(5);
  assert.match(textOf(el), /No library assets yet/);
  assert.ok(el.querySelector('[data-key="lib:new-empty"]'));
  store.setState({ ...store.state, assets: [] });
  paint();
  assert.match(textOf(el), /No asset pipeline found/);
  view.onHide();
});
