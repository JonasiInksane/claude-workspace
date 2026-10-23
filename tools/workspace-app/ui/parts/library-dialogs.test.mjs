// Tests for parts/library-dialogs.js in a stand-in DOM with a fake server (test/dom.mjs): the
// details dialog (facts, every version with Open and Download, Save details with the revision it
// saw and a 409 that keeps what was typed, the guard on typed details, a new version through the
// dialog's upload with its checks, Archive after a question and a 409 that loads the asset again,
// Attach or Detach for a project), the
// New asset dialog (titles from file names or a pasted image, several files, a file it can't
// take, a partial failure, the place), and the picker (shared and the project's own, attached
// ones fixed, search and kind, the limit, a refusal shown in it).
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());

const SHA = c => c.repeat(64);
let asset = null; // the asset GET /api/library/asset answers
let metaReply = null;
let uploadReply = null;
const uploads = []; // { path, name }
function version(n, over = {}) {
  return { n, file: `v${n}.md`, sha256: SHA(String(n)), bytes: 100 * n, type: 'text/markdown', addedAt: new Date(Date.now() - n * 60_000).toISOString(), note: '', originalName: 'guide.md', ...over };
}
function guide(count = 2, over = {}) {
  const versions = Array.from({ length: count }, (_, i) => version(i + 1));
  return {
    ref: 'shared:guide', id: 'guide', scope: 'shared', project: null, title: 'Guide', kind: 'text', tags: ['docs'], description: 'How we write',
    archived: false, latest: versions[count - 1], versionCount: count, createdAt: versions[0].addedAt, versions, revision: `rev-${count}`, ...over,
  };
}
// Every change gives the asset a new revision, as the server does.
let revisions = 0;
const nextRevision = () => `rev-changed-${++revisions}`;
let fakeArchiveConflict = false; // the next archive call answers 409
const calls = fakeFetch((path, { method, body }) => {
  const url = new URL(path, 'http://x');
  if (method === 'GET' && url.pathname === '/api/library/asset') return asset ? { ok: true, asset } : reply(404, { ok: false, error: 'there is no asset' });
  if (method === 'POST' && url.pathname === '/api/library/meta') {
    if (metaReply) { const r = metaReply; metaReply = null; return r; }
    asset = { ...asset, title: body.title.trim(), description: body.description, tags: body.tags.split(',').map(t => t.trim()).filter(Boolean), revision: nextRevision() };
    return { ok: true, asset };
  }
  if (method === 'POST' && url.pathname === '/api/library/archive') {
    if (fakeArchiveConflict) { fakeArchiveConflict = false; return reply(409, { ok: false, error: 'shared:guide changed since you opened it. Reload it and try again.' }); }
    asset = { ...asset, archived: body.archived, revision: nextRevision() };
    return { ok: true, asset };
  }
  if (method === 'POST' && url.pathname === '/api/library/upload') {
    // A function answers some uploads (null: the usual answer) until a test clears it.
    if (uploadReply) {
      const r = typeof uploadReply === 'function' ? uploadReply(url) : uploadReply;
      if (typeof uploadReply !== 'function') uploadReply = null;
      if (r) return r;
    }
    if (url.searchParams.get('ref')) {
      const n = asset.versions.length + 1;
      asset = { ...asset, versions: [...asset.versions, version(n)], versionCount: n };
      return { ok: true, ref: asset.ref, version: n, added: true, asset };
    }
    const title = url.searchParams.get('title');
    const scope = url.searchParams.get('scope');
    const ref = `${scope === 'shared' ? 'shared' : url.searchParams.get('project')}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return { ok: true, ref, version: 1, added: true, asset: { ...guide(1), ref, title } };
  }
  return { ok: true };
});
// Uploads send the file itself as the body: keep it aside and give the fake no body.
const fake = globalThis.fetch;
globalThis.fetch = (path, opts = {}) => {
  if (opts.body && typeof opts.body !== 'string') { uploads.push({ path, name: opts.body.name }); return fake(path, { ...opts, body: undefined }); }
  return fake(path, opts);
};
// The large preview of a text asset.
const realFetch = globalThis.fetch;
globalThis.fetch = (path, opts) => (String(path).startsWith('/library-file') ? Promise.resolve({ ok: true, status: 200, text: async () => '# Guide\n- Short.\n' }) : realFetch(path, opts));

const { assetPicker, newAssetDialog, openAssetDialog } = await import('./library-dialogs.js');
const { closeDialog } = await import('../dialog.js');
const dialog = dom.document.querySelector('#dialog');
const toasts = () => dom.document.querySelector('#toasts').textContent;
const byKey = key => dialog.querySelectorAll('[data-key]').find(n => n.dataset.key === key);
function type(control, value) {
  control.value = value;
  control.dispatchEvent(fakeEvent('input'));
}
const file = (name, size = 10, typ = '') => ({ name, size, type: typ });
let answer = true;
globalThis.confirm = () => answer;

test('details: the facts, the preview and every version newest first, with Open and Download', async () => {
  asset = guide(2, { versions: [version(1, { note: 'First draft' }), version(2)] });
  let changed = 0;
  const d = await openAssetDialog('shared:guide', { onChange: () => { changed++; } });
  assert.ok(d);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#dialogTitle').textContent, 'Guide');
  assert.ok(dialog.classList.contains('lib-dialog'));
  const text = textOf(dialog);
  assert.match(text, /Ref shared:guide Kind Text Where Shared: any project can attach it Versions 2 versions, latest v2 \(200 B\)/);
  assert.match(text, /Versions \(2\), newest first/);
  const rows = dialog.querySelectorAll('.lib-versions li');
  assert.deepEqual(rows.map(r => r.querySelector('.title').textContent), ['v2 latest', 'v1']);
  assert.match(textOf(rows[1]), /First draft/);
  assert.deepEqual(byKey('ad:dl:2').getAttribute('href'), '/library-file?ref=shared%3Aguide&v=2&download=1');
  assert.ok(byKey('ad:dl:2').hasAttribute('download'));
  assert.equal(byKey('ad:open:1').getAttribute('target'), '_blank');
  assert.equal(byKey('ad:open:1').getAttribute('rel'), 'noopener');
  await settle(5);
  assert.equal(dialog.querySelector('.lib-text').textContent, '# Guide\n- Short.');
  assert.equal(changed, 0);
  dialog.close();
  // A PDF has Download only; a missing asset is a toast, no dialog.
  asset = { ...guide(1), kind: 'pdf', versions: [version(1, { file: 'v1.pdf', type: 'application/pdf' })] };
  await openAssetDialog('shared:guide');
  assert.equal(byKey('ad:open:1'), undefined);
  assert.ok(byKey('ad:dl:1'));
  dialog.close();
  asset = null;
  assert.equal(await openAssetDialog('shared:gone'), null);
  assert.equal(dialog.open, false);
  assert.match(toasts(), /there is no asset/);
});

test('details: Save details sends what changed with the revision it saw; a 409 keeps what you typed', async () => {
  asset = guide(2);
  let changed = 0;
  await openAssetDialog('shared:guide', { onChange: () => { changed++; } });
  const save = byKey('ad:save');
  assert.equal(save.disabled, true, 'nothing typed yet');
  type(dialog.querySelector('#libTitle'), 'House style');
  type(dialog.querySelector('#libTags'), 'docs, brand');
  assert.equal(save.disabled, false);
  dom.click(save);
  await settle(5);
  assert.deepEqual(calls.filter(c => c.path === '/api/library/meta').pop().body, { ref: 'shared:guide', title: 'House style', description: 'How we write', tags: 'docs, brand', expect: 'rev-2' });
  assert.equal(dialog.querySelector('#dialogTitle').textContent, 'House style');
  assert.equal(changed, 1);
  assert.equal(save.disabled, true, 'saved: nothing pending');
  // Someone changed it meanwhile: 409, the asset loads again, the typed title stays.
  type(dialog.querySelector('#libTitle'), 'House style guide');
  metaReply = reply(409, { ok: false, error: 'shared:guide changed since you opened it. Reload it and try again.' });
  asset = guide(3, { title: 'House style' });
  dom.click(save);
  await settle(5);
  assert.match(textOf(dialog.querySelector('.lib-meta-form .form-error')), /changed since you opened it.*what you typed is still here/);
  assert.equal(dialog.querySelector('#libTitle').value, 'House style guide');
  assert.match(textOf(dialog), /Versions \(3\)/);
  dom.click(save);
  await settle(5);
  assert.equal(calls.filter(c => c.path === '/api/library/meta').pop().body.expect, 'rev-3', 'the next save uses the new revision');
  dialog.close();
});

test('details: typed details are guarded; Close asks and keeps the dialog on Cancel', async () => {
  asset = guide(2);
  await openAssetDialog('shared:guide');
  type(dialog.querySelector('#libDescription'), 'Changed');
  answer = false;
  closeDialog();
  assert.equal(dialog.open, true);
  answer = true;
  closeDialog();
  assert.equal(dialog.open, false);
});

test('details: a new version through the upload, checked first; the same bytes add nothing; archived takes none', async () => {
  asset = guide(2);
  let changed = 0;
  await openAssetDialog('shared:guide', { onChange: () => { changed++; } });
  const upload = dialog.querySelector('.lib-add-version .drop');
  assert.ok(upload);
  // The dialog's upload (main.js hands it pasted and dropped files): an image is refused here.
  dom.click(upload);
  const zoneDrop = files => upload.dispatchEvent(fakeEvent('drop', { dataTransfer: { types: ['Files'], items: files.map(f => ({ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => null })) } }));
  zoneDrop([file('photo.png', 10, 'image/png')]);
  await settle(5);
  assert.match(textOf(dialog.querySelector('.lib-add-version .form-error')), /photo\.png is an image; this asset is a text file/);
  assert.equal(uploads.length, 0, 'nothing was sent');
  type(dialog.querySelector('#libNote'), 'Tighter');
  zoneDrop([file('guide.md', 10, 'text/markdown')]);
  await settle(5);
  assert.equal(uploads.pop().path, '/api/library/upload?ref=shared%3Aguide&expect=2&note=Tighter&name=guide.md');
  assert.match(toasts(), /Added v3 of Guide/);
  assert.match(textOf(dialog), /Versions \(3\)/);
  assert.equal(dialog.querySelector('#libNote').value, '', 'the note went with it');
  assert.equal(changed, 1);
  uploadReply = { ok: true, ref: 'shared:guide', version: 3, added: false, asset };
  zoneDrop([file('guide.md', 10)]);
  await settle(5);
  assert.match(toasts(), /The same as v3: nothing was added/);
  // A stale count: the server says 409 and the dialog loads the asset again.
  uploadReply = reply(409, { ok: false, error: 'shared:guide has 4 versions now, not 3' });
  asset = guide(4);
  zoneDrop([file('guide.md', 10)]);
  await settle(5);
  assert.match(textOf(dialog.querySelector('.lib-add-version .form-error')), /has 4 versions now/);
  assert.match(textOf(dialog), /Versions \(4\)/);
  dialog.close();
});

test('details: Archive asks first; Restore does not; Attach and Detach for a project', async () => {
  asset = guide(2);
  let attached = false;
  const toggles = [];
  await openAssetDialog('shared:guide', { attach: { project: 'example', attached: () => attached, toggle: async () => { toggles.push(attached); attached = !attached; } } });
  const archive = byKey('ad:archive');
  assert.equal(archive.textContent, 'Archive…');
  dom.click(archive);
  await settle();
  const confirmBox = dom.document.body.querySelectorAll('dialog.confirm').pop();
  assert.match(textOf(confirmBox), /Archive Guide\? It leaves the lists and takes no new versions/);
  dom.click(confirmBox.querySelector('.btn.primary'));
  await settle(5);
  assert.deepEqual(calls.filter(c => c.path === '/api/library/archive').pop().body, { ref: 'shared:guide', archived: true, expect: 'rev-2' });
  assert.equal(archive.textContent, 'Restore');
  assert.equal(dialog.querySelector('.lib-add-version .lib-drop-wrap').hidden, true, 'an archived asset takes no new versions');
  assert.match(textOf(dialog), /Archived: it takes no new versions until you restore it/);
  const afterArchive = asset.revision;
  dom.click(archive);
  await settle(5);
  assert.deepEqual(calls.filter(c => c.path === '/api/library/archive').pop().body, { ref: 'shared:guide', archived: false, expect: afterArchive });
  // A stale dialog (renamed in another tab): the 409 says so and the asset loads again, with the
  // revision the next archive sends.
  asset = guide(2, { title: 'Renamed elsewhere', revision: 'rev-elsewhere' });
  fakeArchiveConflict = true;
  const confirmArchive = async () => {
    dom.click(archive);
    await settle();
    dom.click(dom.document.body.querySelectorAll('dialog.confirm').pop().querySelector('.btn.primary'));
    await settle(5);
  };
  await confirmArchive();
  assert.match(toasts(), /changed since you opened it/);
  assert.equal(dialog.querySelector('#dialogTitle').textContent, 'Renamed elsewhere', 'loaded again');
  await confirmArchive();
  assert.deepEqual(calls.filter(c => c.path === '/api/library/archive').pop().body, { ref: 'shared:guide', archived: true, expect: 'rev-elsewhere' });
  dom.click(archive); // restore again for the attach part below
  await settle(5);
  const attach = byKey('ad:attach');
  assert.equal(attach.textContent, 'Attach to example');
  dom.click(attach);
  await settle(5);
  assert.equal(attach.textContent, 'Detach from example');
  dom.click(attach);
  await settle(5);
  assert.deepEqual(toggles, [false, true]);
  dialog.close();
});

test('New asset: a title from the file name, several files titled by their names, a file it can not take', async () => {
  const created = [];
  const places = [{ value: 'shared', label: 'Shared' }, { value: 'project:example', label: 'example' }];
  newAssetDialog({ place: 'project:example', places, files: [file('Brand colours.png', 10, 'image/png')], onCreated: r => created.push(...r) });
  assert.equal(dialog.querySelector('#dialogTitle').textContent, 'New asset');
  assert.equal(dialog.querySelector('#libPlace').value, 'project:example');
  assert.equal(dialog.querySelector('#libNewTitle').value, 'Brand colours');
  assert.equal(byKey('na:submit').disabled, false);
  type(dialog.querySelector('#libNewTags'), 'brand');
  dom.click(byKey('na:submit'));
  await settle(5);
  assert.equal(uploads.pop().path, '/api/library/upload?scope=project&project=example&title=Brand+colours&tags=brand&name=Brand+colours.png');
  assert.equal(dialog.open, false);
  assert.match(toasts(), /Added Brand colours \(example:brand-colours\)/);
  assert.equal(created.length, 1);
  // Several files: one asset each, titled by their names; an SVG blocks Upload until removed.
  newAssetDialog({ places });
  assert.equal(dialog.querySelector('#libPlace').value, 'shared');
  const d = dialog.querySelector('.lib-new .drop');
  d.dispatchEvent(fakeEvent('drop', { dataTransfer: { types: ['Files'], files: [file('a.md', 5), file('logo.svg', 5), file('b.pdf', 5)], items: [] } }));
  assert.equal(dialog.querySelectorAll('.lib-files li').length, 3);
  assert.equal(dialog.querySelector('#libNewTitle').disabled, true);
  assert.match(textOf(dialog), /Each file becomes its own asset, titled by its file name/);
  assert.match(textOf(dialog.querySelectorAll('.lib-files li')[1]), /SVG is not accepted/);
  assert.equal(byKey('na:submit').disabled, true);
  dom.click(byKey('na:rm:1'));
  assert.equal(byKey('na:submit').textContent, 'Upload 2 assets');
  // The second one fails on the server: it stays, with the reason; the first is added.
  uploadReply = url => (url.searchParams.get('name') === 'b.pdf' ? reply(415, { ok: false, error: 'this file is not an image, a PDF or UTF-8 text' }) : null);
  dom.click(byKey('na:submit'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.querySelectorAll('.lib-files li .title').map(t => t.textContent), ['b.pdf']);
  assert.match(textOf(dialog), /this file is not an image, a PDF or UTF-8 text/);
  assert.match(textOf(dialog), /Some files were not added; each says why/);
  uploadReply = null;
  answer = true;
  closeDialog();
  assert.equal(dialog.open, false);
});

test('New asset: a pasted image gets a dated title; a locked place says where; an empty dialog closes without asking', () => {
  newAssetDialog({ place: 'project:example', places: [{ value: 'project:example', label: 'example' }], lockPlace: true, files: [file('image.png', 10, 'image/png')], pasted: true });
  assert.match(dialog.querySelector('#libNewTitle').value, /^Pasted image \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.match(textOf(dialog), /For example only/);
  assert.equal(dialog.querySelector('#libPlace'), null);
  assert.equal(dialog.querySelector('.lib-files .title').textContent, 'Pasted image');
  answer = false;
  closeDialog();
  assert.equal(dialog.open, true, 'a chosen file is guarded');
  answer = true;
  closeDialog();
  newAssetDialog({});
  answer = false;
  closeDialog();
  assert.equal(dialog.open, false, 'nothing chosen, nothing to lose');
  answer = true;
});

test('the picker: shared and the project\'s own, attached ones fixed, search, kind, the limit, a refusal', async () => {
  const listing = [
    { ref: 'shared:guide', scope: 'shared', project: null, title: 'Guide', kind: 'text', tags: ['docs'], archived: false, latest: { n: 2, bytes: 10 }, versionCount: 2 },
    { ref: 'shared:brand', scope: 'shared', project: null, title: 'Brand', kind: 'image', tags: ['brand'], archived: false, latest: { n: 1, bytes: 10 }, versionCount: 1 },
    { ref: 'shared:old', scope: 'shared', project: null, title: 'Old', kind: 'image', tags: [], archived: true, latest: { n: 1, bytes: 10 }, versionCount: 1 },
    { ref: 'example:logo', scope: 'project', project: 'example', title: 'Logo', kind: 'image', tags: [], archived: false, latest: { n: 1, bytes: 10 }, versionCount: 1 },
    { ref: 'shared:bad', scope: 'shared', project: null, title: 'bad', kind: '', tags: [], archived: false, latest: null, versionCount: 0, error: 'broken' },
  ];
  let attachedRefs = null;
  let fail = true;
  assetPicker({
    project: 'example', assets: listing, attached: ['shared:guide'], limit: 2,
    onAttach: async refs => { if (fail) throw new Error('The settings of example changed elsewhere meanwhile.'); attachedRefs = refs; },
  });
  const titles = () => dialog.querySelectorAll('.lib-pick .title').map(t => t.textContent);
  assert.deepEqual(titles(), ['Guide', 'Brand', 'Logo'], 'archived and unreadable ones are left out');
  const boxes = () => dialog.querySelectorAll('.lib-pick input');
  assert.deepEqual(boxes().map(b => [b.checked, b.disabled]), [[true, true], [false, false], [false, false]]);
  assert.equal(dom.document.activeElement, dialog.querySelector('#libPickSearch'));
  const pick = i => { const b = boxes()[i]; b.checked = true; b.dispatchEvent(fakeEvent('change')); };
  pick(1);
  pick(2);
  assert.equal(byKey('pk:attach').disabled, true, 'only one more fits');
  assert.match(textOf(dialog), /At most 2 can be attached; 1 more fit/);
  const unpick = boxes()[2];
  unpick.checked = false;
  unpick.dispatchEvent(fakeEvent('change'));
  assert.equal(byKey('pk:attach').textContent, 'Attach 1');
  type(dialog.querySelector('#libPickSearch'), 'logo');
  assert.deepEqual(titles(), ['Logo']);
  type(dialog.querySelector('#libPickSearch'), '');
  const kind = dialog.querySelector('select');
  kind.value = 'image';
  kind.dispatchEvent(fakeEvent('change'));
  assert.deepEqual(titles(), ['Brand', 'Logo']);
  assert.equal(boxes()[0].checked, true, 'a choice survives the filter');
  dom.click(byKey('pk:attach'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /changed elsewhere meanwhile/);
  fail = false;
  dom.click(byKey('pk:attach'));
  await settle(5);
  assert.deepEqual(attachedRefs, ['shared:brand']);
  assert.equal(dialog.open, false);
  // Shared only (the project tab's Attach shared…), and nothing to attach.
  assetPicker({ project: 'example', assets: listing, only: 'shared', onAttach: async () => {} });
  assert.deepEqual(titles(), ['Guide', 'Brand']);
  dialog.close();
  assetPicker({ project: 'example', assets: [], onAttach: async () => {} });
  assert.match(textOf(dialog), /There are no assets to attach yet/);
  dialog.close();
});
