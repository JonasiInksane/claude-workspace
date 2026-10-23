// Tests for parts/library.js, the asset library on the page: the version file's URL, a ref's place,
// the words for pins and kinds, an attachment's badges from resolve, the version numbers of an
// asset, the place and tag choices and the filters of a listing, the checks of a file before it is
// sent (kind by name or type, SVG, size limits, a version of another kind), the title of a pasted
// image, the calls and the queries they send (with a stand-in fetch, test/dom.mjs), and the text
// preview (first lines only, read once per version, never parsed).
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, reply } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch((path, { method }) => (method === 'POST' && path.startsWith('/api/library/meta') ? reply(409, { ok: false, error: 'shared:x has 3 versions now, not 2' }) : { ok: true, assets: [], items: [] }));
const lib = await import('./library.js');

const MB = 1024 * 1024;
const asset = (over = {}) => ({
  ref: 'shared:style', id: 'style', scope: 'shared', project: null, title: 'Style guide', kind: 'text', tags: ['docs'], description: 'How we write',
  archived: false, latest: { n: 3, sha256: 'a'.repeat(64), bytes: 10, type: 'text/markdown' }, versionCount: 3, ...over,
});

test('fileUrl, refPlace, isSharedRef, pinWords and kindWord', () => {
  assert.equal(lib.fileUrl('shared:style', 2), '/library-file?ref=shared%3Astyle&v=2');
  assert.equal(lib.fileUrl('example:logo', 1, { download: true }), '/library-file?ref=example%3Alogo&v=1&download=1');
  assert.deepEqual(['shared:a', 'example:b', 'nothing', ':x'].map(lib.refPlace), ['shared', 'example', '', '']);
  assert.deepEqual(['shared:a', 'SHARED:a', 'example:b'].map(lib.isSharedRef), [true, true, false]);
  assert.deepEqual([lib.pinWords(null, 3), lib.pinWords(null), lib.pinWords(2, 3), lib.pinWords(0, 3)], ['Latest (v3)', 'Latest', 'v2', 'Latest (v3)']);
  assert.deepEqual(['image', 'text', 'pdf', 'svg'].map(lib.kindWord), ['Image', 'Text', 'PDF', 'Unknown kind']);
  assert.deepEqual(['image', 'pdf'].map(lib.kindPlural), ['Images', 'PDFs']);
});

test('attachmentBadges: missing (asset or version), unreadable, archived', () => {
  assert.deepEqual(lib.attachmentBadges(null), []);
  assert.deepEqual(lib.attachmentBadges({ ref: 'shared:a', version: 2, kind: 'text' }), []);
  assert.deepEqual(lib.attachmentBadges({ ref: 'shared:gone', missing: true, kind: null }).map(b => b.text), ['Missing']);
  assert.deepEqual(lib.attachmentBadges({ ref: 'shared:a', missing: true, kind: 'text', version: 7 }).map(b => b.text), ['v7 missing']);
  assert.deepEqual(lib.attachmentBadges({ ref: 'shared:a', missing: true, kind: null, error: 'asset.json is broken' }).map(b => [b.text, b.cls]), [['Unreadable', 'red']]);
  assert.deepEqual(lib.attachmentBadges({ ref: 'shared:a', version: 1, kind: 'image', archived: true }).map(b => [b.text, b.cls]), [['Archived', 'amber']]);
});

test('versionNumbers: 1..n from a listing without gaps, the real list from a full asset, null otherwise', () => {
  assert.deepEqual(lib.versionNumbers(asset()), [3, 2, 1]);
  assert.equal(lib.versionNumbers(asset({ versionCount: 2 })), null, 'gaps: ask for the asset');
  assert.deepEqual(lib.versionNumbers({ versions: [{ n: 1 }, { n: 4 }, { n: 2 }] }), [4, 2, 1]);
  assert.equal(lib.versionNumbers(null), null);
  assert.equal(lib.versionNumbers({ latest: null, versionCount: 0 }), null);
});

test('placeChoices, tagsOf and filterAssets', () => {
  const list = [
    asset(),
    asset({ ref: 'example:logo', scope: 'project', project: 'example', title: 'Logo', kind: 'image', tags: ['brand'], description: '' }),
    asset({ ref: 'shared:old', title: 'Old palette', kind: 'image', tags: ['brand', 'colours'], archived: true }),
    asset({ ref: 'other:spec', scope: 'project', project: 'other', title: 'Spec', kind: 'pdf', tags: [], description: '' }),
  ];
  assert.deepEqual(lib.placeChoices(list, [{ name: 'notes' }, { name: 'example' }]).map(p => p.value), ['shared', 'project:example', 'project:notes', 'project:other']);
  assert.deepEqual(lib.tagsOf(list), ['brand', 'colours', 'docs']);
  const refs = f => lib.filterAssets(list, f).map(a => a.ref);
  assert.deepEqual(refs({}), ['shared:style', 'example:logo', 'other:spec'], 'archived ones are left out');
  assert.deepEqual(refs({ archived: true }).length, 4);
  assert.deepEqual(refs({ place: 'shared' }), ['shared:style']);
  assert.deepEqual(refs({ place: 'project:example' }), ['example:logo']);
  assert.deepEqual(refs({ kind: 'image', archived: true }), ['example:logo', 'shared:old']);
  assert.deepEqual(refs({ tag: 'brand' }), ['example:logo']);
  assert.deepEqual(refs({ q: 'HOW write' }), ['shared:style'], 'every word, in the description too, any case');
  assert.deepEqual(refs({ q: 'other:spec' }), ['other:spec'], 'the ref counts');
  assert.deepEqual(refs({ q: 'nothing like it' }), []);
  assert.deepEqual(lib.filterAssets(null, {}), []);
});

test('fileKind and fileProblem: what a file claims, and why it can not go in before it is sent', () => {
  const f = (name, size, type = '') => ({ name, size, type });
  assert.deepEqual([f('a.PNG', 1), f('b.md', 1), f('c.json', 1), f('d.pdf', 1), f('e.svg', 1), f('f.exe', 1), f('', 1, 'image/webp'), f('', 1, 'image/svg+xml'), f('noext', 1)].map(lib.fileKind),
    ['image', 'text', 'text', 'pdf', 'svg', '', 'image', 'svg', '']);
  assert.equal(lib.fileProblem(f('a.png', 10)), '');
  assert.match(lib.fileProblem(f('a.png', 0)), /is empty/);
  assert.match(lib.fileProblem(f('logo.svg', 10)), /SVG is not accepted/);
  assert.match(lib.fileProblem(f('page.html', 10)), /takes images .* and PDF/);
  assert.match(lib.fileProblem(f('big.md', 2 * MB + 1)), /larger than 2 MB, the limit for text files/);
  assert.equal(lib.fileProblem(f('big.png', 2 * MB + 1)), '', 'images may be larger');
  assert.match(lib.fileProblem(f('huge.pdf', 25 * MB + 1)), /larger than 25 MB, the limit for PDFs/);
  assert.match(lib.fileProblem(f('a.png', 10), 'text'), /a\.png is an image; this asset is a text file/);
  assert.equal(lib.fileProblem(f('notes.txt', 10), 'text'), '');
  assert.equal(lib.fileProblem(null), 'No file.');
});

test('pastedTitle and titleFromName', () => {
  assert.equal(lib.pastedTitle(new Date(2026, 9, 23, 9, 5)), 'Pasted image 2026-10-23 09:05');
  assert.deepEqual(['C:\\x\\Brand colours.png', 'notes.v2.md', 'README', ''].map(lib.titleFromName), ['Brand colours', 'notes.v2', 'README', '']);
});

test('the calls: listing, one asset, uploads (query and raw body), meta with expect, archive, resolve', async () => {
  const sent = [];
  const base = globalThis.fetch;
  // Raw bodies are files: keep them aside, and let the stand-in fetch see no body.
  globalThis.fetch = (path, opts = {}) => {
    if (opts.body && typeof opts.body !== 'string') { sent.push({ path, body: opts.body, type: opts.headers['Content-Type'] }); return base(path, { ...opts, body: undefined }); }
    return base(path, opts);
  };
  try {
    await lib.listLibrary({ project: 'example' });
    await lib.listLibrary({ archived: false });
    await lib.getAsset('shared:style');
    const file = { name: 'guide.md', size: 5, type: 'text/markdown' };
    await lib.uploadNew(file, { scope: 'project', project: 'example', title: 'Guide', tags: 'docs, ui', note: 'first' });
    await lib.uploadNew({ name: 'image.png', size: 5, type: 'image/png' }, { scope: 'shared', project: 'example', title: 'Pasted image', pasted: true });
    await lib.uploadVersion('shared:style', file, { expect: 3, note: 'tighter' });
    await assert.rejects(lib.saveMeta('shared:x', { title: 'X', description: '', tags: 'a' }, 2), err => err.status === 409 && /3 versions now/.test(err.message));
    await lib.setArchived('shared:x', true);
    await lib.resolveAttachments('example', [{ ref: 'shared:x', pin: null }]);
  } finally { globalThis.fetch = base; }
  const paths = calls.map(c => `${c.method} ${c.path}`);
  assert.deepEqual(paths.slice(0, 3), ['GET /api/library?project=example&archived=1', 'GET /api/library', 'GET /api/library/asset?ref=shared%3Astyle']);
  assert.equal(sent[0].path, '/api/library/upload?scope=project&project=example&title=Guide&tags=docs%2C+ui&note=first&name=guide.md');
  assert.equal(sent[0].type, 'text/markdown');
  assert.equal(sent[1].path, '/api/library/upload?scope=shared&title=Pasted+image', 'a shared asset takes no project; a pasted file sends no name');
  assert.equal(sent[2].path, '/api/library/upload?ref=shared%3Astyle&expect=3&note=tighter&name=guide.md');
  assert.deepEqual(calls.find(c => c.path === '/api/library/meta').body, { ref: 'shared:x', title: 'X', description: '', tags: 'a', expect: 2 });
  assert.deepEqual(calls.find(c => c.path === '/api/library/archive').body, { ref: 'shared:x', archived: true });
  assert.deepEqual(calls.find(c => c.path === '/api/library/resolve').body, { project: 'example', attachments: [{ ref: 'shared:x', pin: null }] });
});

test('textPreview: the first lines, read once per version as text; a failure is tried again', async () => {
  const base = globalThis.fetch;
  const reads = [];
  let fail = true;
  globalThis.fetch = async path => {
    reads.push(path);
    if (fail) return { ok: false, status: 404, text: async () => 'gone' };
    return { ok: true, status: 200, text: async () => '\uFEFF<script>alert(1)</script>\r\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n\n' };
  };
  try {
    await assert.rejects(lib.textPreview('shared:style', 3), /could not be read \(404\)/);
    fail = false;
    const p = await lib.textPreview('shared:style', 3);
    assert.deepEqual(p, { lines: ['<script>alert(1)</script>', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'], more: true });
    const again = await lib.textPreview('shared:style', 3, { lines: 40 });
    assert.equal(again.lines.length, 7);
    assert.equal(again.more, false, 'blank lines at the end are not more');
    assert.deepEqual(reads, ['/library-file?ref=shared%3Astyle&v=3', '/library-file?ref=shared%3Astyle&v=3'], 'read again after the failure, then once');
  } finally { globalThis.fetch = base; }
  assert.deepEqual(lib.firstLines('a'.repeat(700), 6, 600), { lines: ['a'.repeat(600)], more: true }, 'a long line is cut');
  assert.deepEqual(lib.firstLines('', 6), { lines: [], more: false });
  assert.deepEqual(lib.firstLines('a\n\n\nb', 2), { lines: ['a'], more: true });
});
