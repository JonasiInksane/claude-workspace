// Tests for parts/library-ui.js in a stand-in DOM (test/dom.mjs): an asset's preview (an image's
// thumbnail from /library-file, a text's first lines as text only, a PDF's icon, an unreadable
// one), the card (one open button named in words, the badges, tags and actions, the archived
// look), and the drop zone and drop target (click, Enter and Space choose files; a drop hands the
// files over and stops there; folders are skipped; a drag without files is left alone).
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
// The text previews: plain text answers of /library-file.
globalThis.fetch = async path => ({ ok: true, status: 200, text: async () => (path.includes('v=2') ? '# Guide\n<img src=x onerror=alert(1)>\nline 3\n' : '') });
const { assetCard, assetMeta, assetPreview, dropTarget, dropZone, droppedFiles, placeWord } = await import('./library-ui.js');

const text = { ref: 'shared:guide', id: 'guide', scope: 'shared', project: null, title: 'Guide', kind: 'text', tags: ['docs', 'ui'], archived: false, latest: { n: 2, bytes: 2048 }, versionCount: 2 };
const image = { ...text, ref: 'example:logo', scope: 'project', project: 'example', title: 'Logo', kind: 'image', tags: [], latest: { n: 1, bytes: 512 }, versionCount: 1 };
const pdf = { ...text, ref: 'shared:spec', title: 'Spec', kind: 'pdf', tags: [], latest: { n: 1, bytes: 300 }, versionCount: 1, archived: true };
const broken = { ref: 'shared:bad', id: 'bad', scope: 'shared', project: null, title: 'bad', kind: '', tags: [], archived: false, latest: null, versionCount: 0, error: 'asset.json is not a JSON object' };

test('previews: an image thumbnail, the first lines of a text as text, a PDF icon, an unreadable record', async () => {
  const img = assetPreview(image);
  assert.equal(img.querySelector('img').getAttribute('src'), '/library-file?ref=example%3Alogo&v=1');
  assert.equal(img.querySelector('img').getAttribute('alt'), '', 'decorative: the card names it');
  assert.equal(img.getAttribute('aria-hidden'), 'true');
  const t = assetPreview(text);
  assert.equal(textOf(t), 'Loading…');
  await settle(5);
  assert.equal(t.querySelector('.lib-text').textContent, '# Guide\n<img src=x onerror=alert(1)>\nline 3');
  assert.equal(t.querySelectorAll('img').length, 0, 'the text is never parsed');
  const empty = assetPreview({ ...text, ref: 'shared:empty', latest: { n: 1 } });
  await settle(5);
  assert.equal(empty.querySelector('.lib-text').textContent, '(empty)');
  assert.match(textOf(assetPreview(pdf)), /PDF/);
  assert.match(textOf(assetPreview(pdf, { large: true })), /download it to read it/);
  assert.match(textOf(assetPreview(broken)), /Can't be read/);
  assert.match(textOf(assetPreview({ ...text, latest: null, error: undefined })), /No version/);
});

test('assetMeta and placeWord', () => {
  assert.equal(assetMeta(text), '2 versions · 2 KB');
  assert.equal(assetMeta(broken), 'asset.json is not a JSON object');
  assert.deepEqual([placeWord(text), placeWord(image), placeWord(null)], ['Shared', 'example', '']);
});

test('the card: one open button named in words, then badges, tags and actions', () => {
  let opened = null;
  const extra = dom.document.createElement('button');
  const card = assetCard(text, { onOpen: a => { opened = a.ref; }, badges: [{ text: 'Follows the latest (v2)', cls: 'ok' }], actions: [extra] });
  const open = card.querySelector('.lib-open');
  assert.equal(open.getAttribute('type'), 'button');
  assert.equal(open.getAttribute('aria-label'), 'Guide, Text, 2 versions · 2 KB. Open its details');
  assert.equal(open.dataset.key, 'lib:open:shared:guide');
  dom.click(open);
  assert.equal(opened, 'shared:guide');
  assert.deepEqual(card.querySelectorAll('.badge').map(b => b.textContent), ['Text', 'Shared', 'Follows the latest (v2)']);
  assert.deepEqual(card.querySelectorAll('.lib-tag').map(b => b.textContent), ['docs', 'ui']);
  assert.ok(card.querySelector('.lib-actions').contains(extra));
  const old = assetCard(pdf, { keyPrefix: 'pa' });
  assert.ok(old.classList.contains('archived'));
  assert.ok(old.querySelectorAll('.badge').some(b => b.textContent === 'Archived'));
  assert.equal(old.querySelector('.lib-open').dataset.key, 'pa:open:shared:spec');
  assert.match(old.querySelector('.lib-open').getAttribute('aria-label'), /archived\. Open its details$/);
  assert.equal(old.querySelector('.lib-actions'), null);
  assert.ok(assetCard(broken).classList.contains('broken'));
});

// A drag's dataTransfer: files as items (with folders), or only `files`.
const transfer = (files, { folders = 0, onlyFiles = false } = {}) => ({
  types: ['Files'],
  files,
  items: onlyFiles ? [] : [
    ...files.map(f => ({ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: false }) })),
    ...Array.from({ length: folders }, () => ({ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) })),
    { kind: 'string', getAsFile: () => null },
  ],
});

test('the drop zone: click, Enter and Space choose; a drop hands the files over and stops there', () => {
  const got = [];
  const wrap = dropZone({ key: 'z', label: 'Drop here', hint: 'Images or text', onFiles: (files, pasted) => got.push([files.map(f => f.name), pasted]) });
  const zone = wrap.querySelector('.drop');
  const input = wrap.querySelector('input');
  assert.equal(zone.getAttribute('role'), 'button');
  assert.equal(zone.getAttribute('tabindex'), '0');
  assert.equal(zone.getAttribute('aria-label'), 'Drop here. Images or text');
  assert.equal(input.hidden, true);
  let chosen = 0;
  input.click = () => { chosen++; };
  dom.click(zone);
  dom.key(zone, 'Enter');
  dom.key(zone, ' ');
  dom.key(zone, 'a');
  assert.equal(chosen, 3);
  // Chosen files.
  input.files = [{ name: 'a.md' }];
  input.dispatchEvent(fakeEvent('change'));
  assert.deepEqual(got.pop(), [['a.md'], false]);
  // A drop: highlighted while over, then handed over, not passed on to the page.
  const over = fakeEvent('dragover', { dataTransfer: transfer([]) });
  zone.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.ok(zone.classList.contains('over'));
  let reachedPage = false;
  dom.document.body.append(wrap);
  dom.document.addEventListener('drop', () => { reachedPage = true; });
  const drop = fakeEvent('drop', { dataTransfer: transfer([{ name: 'b.png' }, { name: 'c.pdf' }], { folders: 1 }) });
  zone.dispatchEvent(drop);
  assert.deepEqual(got.pop(), [['b.png', 'c.pdf'], false]);
  assert.equal(drop.stopped, true);
  assert.equal(reachedPage, false, 'main.js never sees it');
  assert.equal(zone.classList.contains('over'), false);
  assert.match(dom.document.querySelector('#toasts').textContent, /1 folder skipped/);
  // A drag of text (no files) is left alone.
  const textDrag = fakeEvent('drop', { dataTransfer: { types: ['text/plain'], items: [] } });
  zone.dispatchEvent(textDrag);
  assert.equal(textDrag.defaultPrevented, false);
  assert.equal(got.length, 0);
});

test('a single-file zone keeps the first file; a card can be a drop target for its zone', () => {
  const got = [];
  const wrap = dropZone({ key: 'one', label: 'One file', multiple: false, onFiles: files => got.push(files.map(f => f.name)) });
  wrap.querySelector('.drop').dispatchEvent(fakeEvent('drop', { dataTransfer: transfer([{ name: 'a.md' }, { name: 'b.md' }]) }));
  assert.deepEqual(got.pop(), ['a.md']);
  const card = dom.document.createElement('div');
  const zone = dom.document.createElement('div');
  card.append(zone);
  dropTarget(card, { zone, onFiles: files => got.push(files.map(f => f.name)) });
  card.dispatchEvent(fakeEvent('dragover', { dataTransfer: transfer([]) }));
  assert.ok(zone.classList.contains('over'), 'the zone lights up for a drag over the card');
  card.dispatchEvent(fakeEvent('dragleave', { relatedTarget: null }));
  assert.equal(zone.classList.contains('over'), false);
  card.dispatchEvent(fakeEvent('drop', { dataTransfer: transfer([{ name: 'c.png' }], { onlyFiles: true }) }));
  assert.deepEqual(got.pop(), ['c.png'], 'without items, the files list is used');
  assert.deepEqual(droppedFiles(null), []);
});
