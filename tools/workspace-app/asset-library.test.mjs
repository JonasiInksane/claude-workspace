// Tests for asset-library.mjs: the record format, ids and refs, the content checks per kind,
// versions (expect, the same content, stray files), archive, meta, listing, the sandboxed file
// lookup, resolveAttachments and one-at-a-time changes. Every hub is a temporary folder with the
// synthetic projects "example" and "other".
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addVersion, assetFile, assetIdFor, createAsset, getAsset, listLibrary, parseRef, resolveAttachments, setArchived,
  sharedAssetsDir, updateMeta,
} from './asset-library.mjs';
import { detectImageType } from './uploads.mjs';
import { tempDir, writeFiles } from './test/helpers.mjs';

const MB = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00;', 'latin1');
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 ', 'latin1');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const sha = buf => createHash('sha256').update(buf).digest('hex');

// A 1x1 BMP (24 bits per pixel, bottom-up), the kind Windows tools write.
function bmp1x1([r, g, b]) {
  const buf = Buffer.alloc(54 + 4);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(1, 18);
  buf.writeInt32LE(1, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf[54] = b;
  buf[55] = g;
  buf[56] = r;
  return buf;
}

function hub(t, extra = {}) {
  const root = tempDir('ws-lib-', t);
  writeFiles(root, { 'projects/example/README.md': '# example\n', 'projects/other/README.md': '# other\n', ...extra });
  return root;
}

// Awaits a refusal with this status (and a message matching `re`).
async function refused(promise, status, re) {
  await assert.rejects(promise, e => {
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

const shared = (root, title, buf, more = {}) => createAsset(root, { scope: 'shared', title, ...more }, buf);

test('a new shared asset: asset.json in format 1, the first version stored as it came, the ref from the title', async t => {
  const root = hub(t);
  const body = Buffer.from('# Style guide\n\nShort sentences.\n');
  const r = await createAsset(root, {
    scope: 'shared', title: '  Style   guide ', description: 'How we write\r\nand draw', tags: ['Brand', 'UI kit', 'brand'],
    note: 'first draft', originalName: 'C:\\Users\\someone\\guide.md',
  }, body);
  assert.deepEqual([r.ref, r.version, r.added], ['shared:style-guide', 1, true]);
  const dir = join(root, 'inbox', 'attachments', '_assets', 'style-guide');
  const rec = JSON.parse(readFileSync(join(dir, 'asset.json'), 'utf8'));
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert.match(rec.createdAt, iso);
  assert.match(rec.versions[0].addedAt, iso);
  assert.deepEqual(rec, {
    format: 1, id: 'style-guide', scope: 'shared', project: null, title: 'Style guide', kind: 'text',
    description: 'How we write\nand draw', tags: ['brand', 'ui-kit'], createdAt: rec.createdAt, archived: false,
    versions: [{
      n: 1, file: 'v1.md', sha256: sha(body), bytes: body.length, type: 'text/markdown', addedAt: rec.versions[0].addedAt,
      note: 'first draft', originalName: 'guide.md',
    }],
  });
  assert.deepEqual(Object.keys(rec), ['format', 'id', 'scope', 'project', 'title', 'kind', 'description', 'tags', 'createdAt', 'archived', 'versions']);
  assert.deepEqual(Object.keys(rec.versions[0]), ['n', 'file', 'sha256', 'bytes', 'type', 'addedAt', 'note', 'originalName']);
  assert.deepEqual(readFileSync(join(dir, 'v1.md')), body);
  assert.deepEqual(readdirSync(dir).sort(), ['asset.json', 'v1.md'], 'no temporary file is left behind');
  assert.deepEqual(r.asset, await getAsset(root, 'shared:style-guide'));
  // Without a title, the file name (without its extension) is the title.
  assert.equal((await createAsset(root, { scope: 'shared', originalName: 'Brand Book.pdf' }, PDF)).ref, 'shared:brand-book');
});

test('ids: kebab-case from the title, -2 and -3 when taken, at most 60 characters, never a device name', async t => {
  const root = hub(t);
  const make = title => shared(root, title, Buffer.from(`${title}\n`)).then(r => r.ref);
  assert.equal(await make('Logo'), 'shared:logo');
  assert.equal(await make('LOGO!'), 'shared:logo-2');
  assert.equal(await make('logo'), 'shared:logo-3');
  assert.equal(await make('Café crème'), 'shared:cafe-creme');
  assert.equal(await make('日本語'), 'shared:asset');
  assert.equal(await make('CON'), 'shared:con-asset');
  const long = 'A very long title that goes on and on, well past the sixty character limit';
  const [first, second] = [await make(long), await make(long)];
  for (const ref of [first, second]) assert.ok(ref.length - 'shared:'.length <= 60, ref);
  assert.match(second, /^shared:a-very-long-.*-2$/);
  assert.equal(assetIdFor('  --Hello,   World--  '), 'hello-world');
  assert.equal(assetIdFor('lpt1'), 'lpt1-asset');
  // A folder in the way (made by hand) is never taken over.
  mkdirSync(join(sharedAssetsDir(root), 'notes'));
  assert.equal(await make('Notes'), 'shared:notes-2');
});

test('a project asset lives in that project\'s inbox folder; the project must exist, and one named "shared" has none', async t => {
  const root = hub(t, { 'projects/shared/README.md': '# shared\n' });
  const r = await createAsset(root, { scope: 'project', project: 'EXAMPLE', title: 'Palette' }, PNG);
  assert.deepEqual([r.ref, r.asset.scope, r.asset.project], ['example:palette', 'project', 'example']);
  assert.ok(existsSync(join(root, 'inbox', 'attachments', 'example', '_assets', 'palette', 'v1.png')));
  assert.equal(JSON.parse(readFileSync(join(root, 'inbox', 'attachments', 'example', '_assets', 'palette', 'asset.json'), 'utf8')).project, 'example');
  // Without a scope, a project means a project asset; a shared asset ignores the project.
  assert.equal((await createAsset(root, { project: 'other', title: 'Map' }, PNG)).ref, 'other:map');
  assert.equal((await createAsset(root, { scope: 'shared', project: 'example', title: 'Brand' }, PNG)).ref, 'shared:brand');
  await refused(createAsset(root, { scope: 'project', project: 'ghost', title: 'x' }, PNG), 404, /was not found/);
  await refused(createAsset(root, { scope: 'project', project: '../example', title: 'x' }, PNG), 404);
  await refused(createAsset(root, { scope: 'project', project: 'example/../other', title: 'x' }, PNG), 404);
  await refused(createAsset(root, { scope: 'project', project: '_assets', title: 'x' }, PNG), 404);
  await refused(createAsset(root, { scope: 'project', title: 'x' }, PNG), 400, /needs a project/);
  await refused(createAsset(root, { scope: 'team', title: 'x' }, PNG), 400, /scope must be/);
  await refused(createAsset(root, { scope: 'project', project: 'shared', title: 'x' }, PNG), 400, /shared library/);
  assert.ok(!existsSync(join(root, 'inbox', 'attachments', 'shared')));
});

test('the content decides the kind: images (a BMP is stored as PNG), Markdown, text, JSON and PDF', async t => {
  const root = hub(t);
  const cases = [
    ['Png', PNG, {}, 'image', 'v1.png', 'image/png'],
    ['Jpeg', JPG, { originalName: 'photo.JPEG' }, 'image', 'v1.jpg', 'image/jpeg'],
    ['Gif', GIF, {}, 'image', 'v1.gif', 'image/gif'],
    ['Webp', WEBP, { originalName: 'x.webp', kind: 'image' }, 'image', 'v1.webp', 'image/webp'],
    // The format inside a kind follows the bytes, as uploads do: a JPEG named .png is a JPEG.
    ['Misnamed', JPG, { originalName: 'shot.png' }, 'image', 'v1.jpg', 'image/jpeg'],
    ['Readme', Buffer.from('# Hi\n'), { originalName: 'README.MD' }, 'text', 'v1.md', 'text/markdown'],
    ['Notes', Buffer.from('plain'), { originalName: 'notes.txt', kind: 'text' }, 'text', 'v1.txt', 'text/plain'],
    ['Unnamed', Buffer.from('no name'), {}, 'text', 'v1.txt', 'text/plain'],
    ['Release', Buffer.from('notes'), { originalName: 'Release 1.2' }, 'text', 'v1.txt', 'text/plain'],
    ['Data', Buffer.from('\ufeff{"a": [1, 2]}'), { originalName: 'data.json' }, 'text', 'v1.json', 'application/json'],
    ['Manual', PDF, { originalName: 'manual.pdf', kind: 'pdf' }, 'pdf', 'v1.pdf', 'application/pdf'],
  ];
  for (const [title, buf, more, kind, file, type] of cases) {
    const { asset } = await shared(root, title, buf, more);
    assert.deepEqual([asset.kind, asset.versions[0].file, asset.versions[0].type], [kind, file, type], title);
  }
  const { asset: bmp } = await shared(root, 'Pixel', bmp1x1([255, 0, 0]), { originalName: 'pixel.bmp' });
  assert.deepEqual([bmp.kind, bmp.versions[0].file, bmp.versions[0].type, bmp.versions[0].originalName], ['image', 'v1.png', 'image/png', 'pixel.bmp']);
  const stored = readFileSync(join(sharedAssetsDir(root), 'pixel', 'v1.png'));
  assert.equal(detectImageType(stored), 'png');
  assert.equal(bmp.versions[0].sha256, sha(stored), 'the hash is of the stored PNG');
  assert.equal(bmp.versions[0].bytes, stored.length);
});

test('content that is not what it claims is refused (415), bad fields are a 400, and nothing is written', async t => {
  const root = hub(t);
  const svg = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  // A BMP with the old OS/2 header: an image by its bytes, but one bmp.mjs can't convert.
  const os2 = Buffer.alloc(60);
  os2.write('BM', 0, 'latin1');
  os2.writeUInt32LE(12, 14);
  const cases = [
    [{ originalName: 'old.bmp' }, os2, /OS\/2 header/],
    [{ originalName: 'logo.svg' }, PNG, /SVG/],
    [{ originalName: 'logo.SVGZ' }, PNG, /SVG/],
    [{}, svg, /SVG/],
    [{ originalName: 'logo.txt' }, svg, /SVG/],
    [{ originalName: 'notes.md' }, PNG, /named \.md, but it is an image/],
    [{ originalName: 'manual.pdf' }, Buffer.from('not a pdf'), /named \.pdf, but it is a text file/],
    [{ originalName: 'photo.png' }, Buffer.from('just text'), /named \.png, but it is a text file/],
    [{ originalName: 'page.html' }, Buffer.from('<p>hi</p>'), /\.html files are not accepted/],
    [{ originalName: 'tool.exe' }, Buffer.from('MZ\x90\x00\x03', 'latin1'), /\.exe files are not accepted/],
    [{}, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]), /not an image .*a PDF or UTF-8 text/],
    [{}, Buffer.from([0xc3, 0x28, 0x41, 0x42]), /not an image/],
    [{}, Buffer.from('text with a \0 in it'), /not an image/],
    [{}, Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), /UTF-16/],
    [{ originalName: 'data.json' }, Buffer.from('{"a": }'), /not valid JSON/],
    [{ kind: 'image' }, Buffer.from('text'), /this file is a text file, not an image/],
    [{ kind: 'pdf' }, PNG, /this file is an image, not a PDF/],
  ];
  for (const [more, buf, re] of cases) await refused(shared(root, 'Bad', buf, more), 415, re);
  await refused(shared(root, 'Bad', PNG, { kind: 'video' }), 400, /kind must be/);
  await refused(shared(root, 'Bad', Buffer.alloc(0)), 400, /empty/);
  await refused(createAsset(root, { scope: 'shared' }, PNG), 400, /title is required/);
  await refused(shared(root, '  \t ', PNG), 400, /title is required/);
  await refused(shared(root, 'x'.repeat(121), PNG), 400, /title is longer/);
  await refused(shared(root, 'x', PNG, { tags: ['ok', 'not ok!'] }), 400, /not a tag/);
  await refused(shared(root, 'x', PNG, { description: 'd'.repeat(2001) }), 400, /description is longer/);
  await refused(shared(root, 'x', PNG, { note: 'n'.repeat(501) }), 400, /note is longer/);
  assert.ok(!existsSync(sharedAssetsDir(root)), 'a refused upload creates no folder');
});

test('an SVG document is refused whatever comes before its root element; text that only mentions <svg> is fine', async t => {
  const root = hub(t);
  const ns = 'xmlns="http://www.w3.org/2000/svg"';
  const svgs = [
    `<svg ${ns}/>`,
    `${String.fromCharCode(0xfeff)}  <SVG ${ns}></SVG>`,
    `<?xml version="1.0"?>\n<?xml-stylesheet href="a.css"?>\n<svg ${ns}><script>alert(1)</script></svg>`,
    `<?xml version="1.0"?>\n<!DOCTYPE svg [\n  <!ENTITY x "y">\n]>\n<svg ${ns}/>`,
    `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- by hand -->\n<svg ${ns}/>`,
    '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>',
    `<!--${'x'.repeat(5000)}-->\n<svg ${ns}/>`,
  ];
  for (const [i, text] of svgs.entries()) {
    await refused(shared(root, `Svg ${i}`, Buffer.from(text), { originalName: 'logo.txt' }), 415, /SVG is not accepted/);
  }
  const mentions = [
    '# Icons\n\nInline them:\n\n```html\n<svg viewBox="0 0 1 1"></svg>\n```\n',
    '<!doctype html>\n<html><body><svg></svg></body></html>',
    '<svgicon/>',
    'svg files are not accepted',
  ];
  for (const [i, text] of mentions.entries()) assert.equal((await shared(root, `Text ${i}`, Buffer.from(text))).asset.kind, 'text', text);
  // A prolog that never ends costs no more than reading it once.
  const started = Date.now();
  assert.equal((await shared(root, 'Odd', Buffer.from(`<!doctype ${'[]'.repeat(30000)}`))).asset.kind, 'text');
  assert.ok(Date.now() - started < 2000, 'the SVG check runs in linear time');
});

test('size limits: images and PDFs at most 25 MB, text at most 2 MB (413); a text of exactly 2 MB is fine', async t => {
  const root = hub(t);
  const big = (head, size) => Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]);
  await refused(shared(root, 'Huge', big(PNG, 25 * MB + 1)), 413, /images can be at most 25 MB/);
  await refused(shared(root, 'Huge', big(Buffer.from('%PDF-1.7\n'), 25 * MB + 1)), 413, /PDFs can be at most 25 MB/);
  await refused(shared(root, 'Long', Buffer.alloc(2 * MB + 1, 0x61), { originalName: 'long.md' }), 413, /2 MB/);
  assert.equal((await shared(root, 'Edge', Buffer.alloc(2 * MB, 0x61))).asset.latest.bytes, 2 * MB);
});

test('a new version needs the count the caller saw (409 otherwise); the latest content again adds nothing; older content comes back as a new version', async t => {
  const root = hub(t);
  const { ref } = await shared(root, 'Guide', Buffer.from('one'), { originalName: 'guide.md' });
  const two = await addVersion(root, ref, Buffer.from('two'), { expectVersions: 1, note: 'second', originalName: 'guide-v2.md' });
  assert.deepEqual([two.ref, two.version, two.added, two.asset.versionCount, two.asset.latest.n], [ref, 2, true, 2, 2]);
  assert.deepEqual([two.asset.versions[1].note, two.asset.versions[1].originalName], ['second', 'guide-v2.md']);
  const again = await addVersion(root, ref, Buffer.from('two'), { expectVersions: 1 });
  assert.deepEqual([again.version, again.added, again.asset.versionCount], [2, false, 2], 'a repeated upload is harmless, also with an old count');
  const back = await addVersion(root, ref, Buffer.from('one'), { expectVersions: '2' });
  assert.deepEqual([back.version, back.added], [3, true]);
  assert.equal(back.asset.versions[2].sha256, back.asset.versions[0].sha256);
  await refused(addVersion(root, ref, Buffer.from('four'), { expectVersions: 2 }), 409, /has 3 versions now, not 2/);
  for (const expectVersions of [undefined, '', 'x', 0, -1, 1.5, '1e3', null]) {
    await refused(addVersion(root, ref, Buffer.from('four'), { expectVersions }), 400, /expect/);
  }
  const dir = join(sharedAssetsDir(root), 'guide');
  assert.deepEqual(readdirSync(dir).sort(), ['asset.json', 'v1.md', 'v2.md', 'v3.md']);
  assert.equal(readFileSync(join(dir, 'v1.md'), 'utf8'), 'one', 'a version never changes');
  await refused(addVersion(root, 'shared:nope', Buffer.from('x'), { expectVersions: 1 }), 404, /there is no asset shared:nope/);
});

test('a new version must be of the asset\'s kind; text without a file name keeps the latest version\'s format', async t => {
  const root = hub(t);
  const { ref } = await shared(root, 'Config', Buffer.from('{"a":1}'), { originalName: 'config.json' });
  assert.equal((await addVersion(root, ref, Buffer.from('{"a":2}'), { expectVersions: 1 })).asset.latest.type, 'application/json');
  await refused(addVersion(root, ref, Buffer.from('{"a":'), { expectVersions: 2 }), 415, /JSON/);
  await refused(addVersion(root, ref, PNG, { expectVersions: 2 }), 415, /shared:config is a text file; this file is an image/);
  await refused(addVersion(root, ref, Buffer.from('{}'), { expectVersions: 2, kind: 'pdf' }), 415);
  const md = await addVersion(root, ref, Buffer.from('# now prose'), { expectVersions: 2, originalName: 'config.md' });
  assert.equal(md.asset.latest.type, 'text/markdown');
  const icon = (await shared(root, 'Icon', PNG)).ref;
  const jpg = await addVersion(root, icon, JPG, { expectVersions: 1, originalName: 'icon.jpg' });
  assert.deepEqual(jpg.asset.versions.map(v => v.file), ['v1.png', 'v2.jpg']);
  await refused(addVersion(root, icon, PDF, { expectVersions: 2 }), 415, /is an image; this file is a PDF/);
});

test('versions are never overwritten: a stray v<N> file is skipped and stays as it is', async t => {
  const root = hub(t);
  const { ref } = await shared(root, 'Notes', Buffer.from('one'));
  const dir = join(sharedAssetsDir(root), 'notes');
  writeFileSync(join(dir, 'v2.txt'), 'left by a crash');
  writeFileSync(join(dir, 'v3.png'), 'put there by hand');
  const r = await addVersion(root, ref, Buffer.from('two'), { expectVersions: 1 });
  assert.deepEqual(r.asset.versions.map(v => [v.n, v.file]), [[1, 'v1.txt'], [4, 'v4.txt']]);
  assert.equal(readFileSync(join(dir, 'v2.txt'), 'utf8'), 'left by a crash');
  assert.equal(r.asset.versionCount, 2, 'expect counts versions, not numbers');
  await refused(assetFile(root, ref, 2), 404, /has no version 2/);
  assert.equal((await addVersion(root, ref, Buffer.from('three'), { expectVersions: 2 })).version, 5);
  // A stray file with the highest number a version can have: no version is written past it, so
  // the asset stays readable.
  writeFileSync(join(dir, 'v999999999.md'), 'put there by hand');
  await refused(addVersion(root, ref, Buffer.from('four'), { expectVersions: 3 }), 409, /no version number left/);
  assert.deepEqual((await getAsset(root, ref)).versions.map(v => v.n), [1, 4, 5]);
  assert.ok(!readdirSync(dir).some(f => f.startsWith('v1000000000')), 'nothing was written past the highest number');
});

test('archived assets leave the list (unless asked for), take no new versions, and are still served and resolved', async t => {
  const root = hub(t);
  const { ref } = await shared(root, 'Old logo', PNG);
  assert.equal((await setArchived(root, ref, true)).archived, true);
  assert.deepEqual(await listLibrary(root), []);
  assert.deepEqual((await listLibrary(root, { includeArchived: true })).map(a => [a.ref, a.archived]), [[ref, true]]);
  await refused(addVersion(root, ref, JPG, { expectVersions: 1 }), 409, /archived/);
  assert.equal((await addVersion(root, ref, PNG, { expectVersions: 1 })).added, false, 'the same bytes are still fine');
  assert.equal((await assetFile(root, ref, 1)).type, 'image/png');
  const [item] = await resolveAttachments(root, '', [{ ref, pin: null }]);
  assert.deepEqual([item.version, item.archived, item.missing], [1, true, undefined]);
  for (const v of ['yes', 1, null, undefined]) await refused(setArchived(root, ref, v), 400, /true or false/);
  assert.equal((await setArchived(root, ref, false)).archived, false);
  assert.equal((await setArchived(root, ref, false)).archived, false, 'restoring twice changes nothing');
  assert.equal((await addVersion(root, ref, JPG, { expectVersions: 1 })).version, 2);
});

test('setArchived with the revision the caller saw: a stale page gets a 409 and changes nothing', async t => {
  const root = hub(t);
  const { ref, asset } = await shared(root, 'Logo', PNG);
  const renamed = await updateMeta(root, ref, { title: 'New logo', expect: asset.revision }); // another tab
  await refused(setArchived(root, ref, true, { expect: asset.revision }), 409, /changed since you opened it/);
  assert.equal((await getAsset(root, ref)).archived, false);
  const archived = await setArchived(root, ref, true, { expect: renamed.revision });
  assert.deepEqual([archived.archived, archived.title], [true, 'New logo']);
  await refused(setArchived(root, ref, false, { expect: renamed.revision }), 409); // archiving made a new revision
  assert.equal((await setArchived(root, ref, false, { expect: archived.revision })).archived, false);
  for (const expect of [null, '', 3, 'x']) await refused(setArchived(root, ref, true, { expect }), 400, /expect \(the revision/);
});

test('updateMeta changes the fields it is given (never the id), needs the revision the caller saw, and refuses bad values', async t => {
  const root = hub(t);
  const { ref, asset } = await shared(root, 'Guide', Buffer.from('x'), { description: 'old', tags: 'a, b' });
  assert.equal(asset.revision, (await getAsset(root, ref)).revision, 'a change answers with the revision a read gives');
  const a = await updateMeta(root, ref, { title: 'House style', expect: asset.revision });
  assert.deepEqual([a.ref, a.id, a.title, a.description, a.tags], [ref, 'guide', 'House style', 'old', ['a', 'b']]);
  assert.notEqual(a.revision, asset.revision);
  const b = await updateMeta(root, ref, { description: '  new\r\ntext ', tags: ['C', 'c'], expect: ` ${a.revision} ` });
  assert.deepEqual([b.title, b.description, b.tags], ['House style', 'new\ntext', ['c']]);
  const c = await updateMeta(root, ref, { tags: null, expect: b.revision });
  assert.deepEqual([c.tags, c.revision], [[], (await getAsset(root, ref)).revision]);
  // A stale page: the version count still matches, the revision doesn't (another tab renamed it).
  await refused(updateMeta(root, ref, { title: 'Stale', expect: b.revision }), 409, /changed since you opened it/);
  const added = (await addVersion(root, ref, Buffer.from('y'), { expectVersions: 1 })).asset;
  await refused(updateMeta(root, ref, { title: 'Stale', expect: c.revision }), 409, /changed since you opened it/);
  const r = added.revision;
  await refused(updateMeta(root, ref, { expect: r }), 400, /nothing to change/);
  await refused(updateMeta(root, ref, { title: '', expect: r }), 400, /title is required/);
  for (const expect of [undefined, 2, '2', 'zz'.repeat(8)]) await refused(updateMeta(root, ref, { title: 'ok', expect }), 400, /expect \(the revision/);
  await refused(updateMeta(root, ref, { tags: 5, expect: r }), 400, /list of words/);
  await refused(updateMeta(root, ref, { tags: [1], expect: r }), 400, /list of words/);
  await refused(updateMeta(root, ref, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`), expect: r }), 400, /at most 20 tags/);
  await refused(updateMeta(root, ref, { tags: ['x'.repeat(41)], expect: r }), 400, /not a tag/);
  await refused(updateMeta(root, 'shared:nope', { title: 'x', expect: r }), 404);
  const now = await getAsset(root, ref);
  assert.deepEqual([now.title, now.tags, now.versionCount, now.revision], ['House style', [], 2, r], 'refused changes wrote nothing');
});

test('the revision: a hand edit of asset.json changes it, and an asset.json from before revisions has one', async t => {
  const root = hub(t);
  const { ref, asset } = await shared(root, 'Guide', Buffer.from('x'));
  const file = join(sharedAssetsDir(root), 'guide', 'asset.json');
  // A record as an older app wrote it: no revision is stored anywhere, so it reads as it always did.
  assert.ok(!('revision' in JSON.parse(readFileSync(file, 'utf8'))));
  assert.match(asset.revision, /^[0-9a-f]{16}$/);
  assert.deepEqual((await listLibrary(root)).map(a => a.revision), [asset.revision]);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...rec, description: 'edited by hand' }));
  const edited = await getAsset(root, ref);
  assert.notEqual(edited.revision, asset.revision);
  await refused(setArchived(root, ref, true, { expect: asset.revision }), 409, /changed since you opened it/);
  await refused(updateMeta(root, ref, { title: 'x', expect: asset.revision }), 409);
  assert.equal((await updateMeta(root, ref, { title: 'Guide 2', expect: edited.revision })).description, 'edited by hand');
});

test('listLibrary: shared assets plus one project\'s or every project\'s, sorted; broken records are listed with their error', async t => {
  const root = hub(t);
  await shared(root, 'Zebra', PNG, { tags: 'z' });
  await shared(root, 'apple', Buffer.from('a'));
  await createAsset(root, { scope: 'project', project: 'example', title: 'Board' }, PDF);
  await createAsset(root, { scope: 'project', project: 'other', title: 'Map' }, PNG);
  assert.deepEqual((await listLibrary(root, { project: 'Example' })).map(a => a.ref), ['shared:apple', 'shared:zebra', 'example:board']);
  assert.deepEqual((await listLibrary(root)).map(a => a.ref), ['shared:apple', 'shared:zebra', 'example:board', 'other:map']);
  const zebra = (await listLibrary(root)).find(a => a.id === 'zebra');
  assert.deepEqual(Object.keys(zebra), ['ref', 'id', 'scope', 'project', 'title', 'kind', 'tags', 'description', 'archived', 'latest', 'versionCount', 'revision']);
  assert.deepEqual(Object.keys(zebra.latest), ['n', 'sha256', 'bytes', 'type', 'addedAt']);
  assert.deepEqual([zebra.kind, zebra.tags, zebra.versionCount, zebra.latest.type, zebra.latest.sha256], ['image', ['z'], 1, 'image/png', sha(PNG)]);
  await refused(listLibrary(root, { project: 'ghost' }), 404);
  await refused(listLibrary(root, { project: '../example' }), 404);
  // Not assets: a folder without asset.json, a file, a folder whose name is not an id.
  const base = sharedAssetsDir(root);
  mkdirSync(join(base, 'half-made'));
  writeFileSync(join(base, 'loose.txt'), 'x');
  writeFiles(base, { 'Not_An_Id/asset.json': '{}' });
  // Broken: listed with its error, so it doesn't vanish from the page.
  writeFiles(base, { 'torn/asset.json': '{"format": 1, "id": "torn"' });
  const list = await listLibrary(root, { project: 'example' });
  assert.deepEqual(list.map(a => a.ref), ['shared:apple', 'shared:torn', 'shared:zebra', 'example:board']);
  const torn = list.find(a => a.id === 'torn');
  assert.match(torn.error, /shared:torn: asset\.json can't be read/);
  assert.deepEqual([torn.title, torn.latest, torn.versionCount], ['torn', null, 0]);
  await refused(getAsset(root, 'shared:torn'), 500);
});

test('a tampered asset.json is refused, so no file but the asset\'s own versions is ever served', async t => {
  const root = hub(t);
  writeFiles(root, { 'secret.md': 'secret' });
  const { ref } = await shared(root, 'Doc', Buffer.from('doc'));
  const file = join(sharedAssetsDir(root), 'doc', 'asset.json');
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const tampered = async (change, re) => {
    const rec = structuredClone(good);
    change(rec);
    writeFileSync(file, JSON.stringify(rec));
    await refused(assetFile(root, ref, 1), 500, re);
    await refused(getAsset(root, ref), 500, re);
  };
  await tampered(r => { r.versions[0].file = '../../../../secret.md'; }, /bad version entry/);
  await tampered(r => { r.versions[0].file = 'v1.html'; }, /bad version entry/);
  await tampered(r => { r.versions[0].file = 'v2.txt'; }, /bad version entry/);
  await tampered(r => { r.versions[0].n = '1'; }, /bad version entry/);
  await tampered(r => { r.versions.push({ ...r.versions[0] }); }, /bad version entry/);
  await tampered(r => { r.versions[0].file = 'v1.png'; }, /not a text file/);
  await tampered(r => { r.versions[0].sha256 = 'abc'; }, /SHA-256/);
  await tampered(r => { r.versions = []; }, /no versions/);
  await tampered(r => { r.id = 'secret'; }, /names the id/);
  await tampered(r => { r.scope = 'project'; }, /says scope/);
  await tampered(r => { r.kind = 'html'; }, /unknown kind/);
  await tampered(r => { r.format = 2; }, /format 2/);
  // A version's type in the file is not trusted: it comes from the file name's extension.
  writeFileSync(file, JSON.stringify({ ...good, versions: [{ ...good.versions[0], type: 'text/html' }] }));
  assert.equal((await assetFile(root, ref, 1)).type, 'text/plain; charset=utf-8');
  assert.equal((await getAsset(root, ref)).versions[0].type, 'text/plain');
});

test('a link where an asset folder should be is not an asset', async t => {
  const root = hub(t);
  const outside = tempDir('ws-lib-out-', t);
  writeFiles(outside, {
    'asset.json': {
      format: 1, id: 'linked', scope: 'shared', project: null, title: 'Linked', kind: 'text', description: '', tags: [],
      createdAt: '', archived: false,
      versions: [{ n: 1, file: 'v1.md', sha256: sha('outside'), bytes: 7, type: 'text/markdown', addedAt: '', note: '', originalName: '' }],
    },
    'v1.md': 'outside',
  });
  mkdirSync(sharedAssetsDir(root), { recursive: true });
  symlinkSync(outside, join(sharedAssetsDir(root), 'linked'), 'junction');
  await refused(getAsset(root, 'shared:linked'), 404);
  await refused(assetFile(root, 'shared:linked', 1), 404);
  assert.deepEqual(await listLibrary(root), []);
});

test('refs are shared:<id> or <project>:<id>; a malformed one is a 400, an unknown project a 404', async t => {
  const root = hub(t);
  await shared(root, 'Guide', Buffer.from('g'));
  await createAsset(root, { scope: 'project', project: 'example', title: 'Logo' }, PNG);
  assert.equal((await getAsset(root, 'SHARED:guide')).ref, 'shared:guide');
  assert.equal((await getAsset(root, 'Example:logo')).ref, 'example:logo');
  assert.deepEqual(parseRef(root, 'example:logo'), {
    ref: 'example:logo', scope: 'project', project: 'example', id: 'logo', dir: join(root, 'inbox', 'attachments', 'example', '_assets', 'logo'),
  });
  for (const ref of ['', 'guide', ':guide', 'shared:', 'shared:Guide', 'shared:../guide', 'shared:..', 'shared:a/b', 'shared:a\\b',
    'shared:guide/../../x', 'example:logo:x', `shared:${'a'.repeat(61)}`, 'shared: guide', 'shared:guide ', 'C:\\x:logo',
    `${'p'.repeat(200)}:x`, null, 42, { ref: 'shared:guide' }]) {
    await refused(getAsset(root, ref), 400, /not an asset ref/);
  }
  for (const ref of ['../example:logo', 'example/..:logo', '..\\example:logo', '..:logo', '.git:x', '_hub:x', '_assets:x', 'ghost:logo']) {
    await refused(getAsset(root, ref), 404);
  }
  await refused(getAsset(root, 'shared:missing'), 404, /there is no asset shared:missing/);
  await refused(getAsset(root, 'other:logo'), 404, /there is no asset other:logo/);
});

test('assetFile: only versions asset.json lists, as a regular file in the asset\'s folder; every text kind is served as text/plain', async t => {
  const root = hub(t);
  const md = (await shared(root, 'Guide', Buffer.from('# g'), { originalName: 'g.md' })).ref;
  const json = (await shared(root, 'Data', Buffer.from('{}'), { originalName: 'd.json' })).ref;
  const png = (await shared(root, 'Logo', PNG)).ref;
  const pdf = (await shared(root, 'Manual', PDF)).ref;
  const f = await assetFile(root, md, '1');
  assert.deepEqual([f.path, f.type, f.kind, f.downloadName, f.version.n], [join(sharedAssetsDir(root), 'guide', 'v1.md'), 'text/plain; charset=utf-8', 'text', 'guide-v1.md', 1]);
  assert.equal((await assetFile(root, json, 1)).type, 'text/plain; charset=utf-8');
  assert.equal((await assetFile(root, png, 1)).type, 'image/png');
  assert.equal((await assetFile(root, pdf, 1)).type, 'application/pdf');
  for (const n of ['0', '-1', '1.5', 'abc', '1e0', ' ', '01', '..', 1.5, {}]) await refused(assetFile(root, md, n), 400, /version number/);
  for (const n of ['', null, undefined]) await refused(assetFile(root, md, n), 400, /is required/);
  await refused(assetFile(root, md, 2), 404, /no version 2/);
  rmSync(join(sharedAssetsDir(root), 'guide', 'v1.md'));
  await refused(assetFile(root, md, 1), 404, /missing/);
});

test('resolveAttachments: shared and own assets, latest or pinned, missing and archived marked; another project\'s ref is refused', async t => {
  const root = hub(t);
  const guide = (await shared(root, 'Guide', Buffer.from('one'), { originalName: 'guide.md' })).ref;
  await addVersion(root, guide, Buffer.from('two'), { expectVersions: 1 });
  const logo = (await createAsset(root, { scope: 'project', project: 'example', title: 'Logo' }, PNG)).ref;
  await setArchived(root, logo, true);
  const map = (await createAsset(root, { scope: 'project', project: 'other', title: 'Map' }, PNG)).ref;
  const items = await resolveAttachments(root, 'Example', [
    { ref: guide, pin: null }, { ref: guide, pin: 1 }, { ref: guide }, { ref: 'example:logo', pin: '1' },
    { ref: 'shared:gone', pin: null }, { ref: guide, pin: 7 },
  ]);
  const dir = join(sharedAssetsDir(root), 'guide');
  assert.deepEqual(items[0], {
    ref: guide, pin: null, version: 2, sha256: sha('two'), bytes: 3, path: join(dir, 'v2.md'),
    rel: 'inbox/attachments/_assets/guide/v2.md', type: 'text/markdown', kind: 'text', title: 'Guide',
  });
  assert.deepEqual([items[1].pin, items[1].version, items[1].sha256, items[1].path], [1, 1, sha('one'), join(dir, 'v1.md')]);
  assert.deepEqual([items[2].pin, items[2].version], [null, 2], 'no pin follows the latest');
  assert.deepEqual([items[3].ref, items[3].pin, items[3].version, items[3].type, items[3].archived, items[3].missing], [logo, 1, 1, 'image/png', true, undefined]);
  assert.deepEqual(items[4], {
    ref: 'shared:gone', pin: null, version: null, sha256: null, bytes: null, path: null, rel: null, type: null, kind: null, title: null, missing: true,
  });
  assert.deepEqual([items[5].version, items[5].missing, items[5].path, items[5].title], [7, true, null, 'Guide']);
  rmSync(join(dir, 'v1.md'));
  const [gone] = await resolveAttachments(root, 'example', [{ ref: guide, pin: 1 }]);
  assert.deepEqual([gone.missing, gone.sha256], [true, sha('one')], 'a version whose file is gone is missing');
  // Another project's asset, or a project asset where only shared ones go: the whole list is refused.
  await refused(resolveAttachments(root, 'example', [{ ref: guide }, { ref: map }]), 400,
    /other:map belongs to projects\/other; example can attach shared assets and its own/);
  await refused(resolveAttachments(root, '', [{ ref: logo }]), 400, /only shared assets/);
  assert.equal((await resolveAttachments(root, null, [{ ref: guide }]))[0].version, 2);
  await refused(resolveAttachments(root, 'ghost', []), 404);
  await refused(resolveAttachments(root, 5, []), 404, /projects\/5 was not found/);
  for (const list of [null, {}, 'shared:guide', [null], [['shared:guide']], [{ ref: 'shared:../x' }], [{ ref: guide, pin: 0 }],
    [{ ref: guide, pin: 'latest' }], [{ ref: guide, pin: '' }], Array.from({ length: 101 }, () => ({ ref: guide }))]) {
    await refused(resolveAttachments(root, 'example', list), 400);
  }
  assert.deepEqual(await resolveAttachments(root, 'example', []), []);
});

test('changes to one asset run one at a time: two uploads with one count give one version and a 409, and a title change never drops a version', async t => {
  const root = hub(t);
  const { ref } = await shared(root, 'Busy', Buffer.from('v1'));
  const [a, b] = await Promise.allSettled([
    addVersion(root, ref, Buffer.from('a'), { expectVersions: 1 }),
    addVersion(root, ref, Buffer.from('b'), { expectVersions: 1 }),
  ]);
  assert.deepEqual([a.status, b.status, b.reason && b.reason.status], ['fulfilled', 'rejected', 409]);
  const seen = (await getAsset(root, ref)).revision;
  const [meta, upload] = await Promise.allSettled([
    updateMeta(root, ref, { title: 'Busy bee', expect: seen }),
    addVersion(root, ref, Buffer.from('c'), { expectVersions: 2 }),
  ]);
  assert.deepEqual([meta.status, upload.status], ['fulfilled', 'fulfilled']);
  const now = await getAsset(root, ref);
  assert.deepEqual([now.title, now.versionCount], ['Busy bee', 3]);
  const [late, stalePage] = await Promise.allSettled([
    addVersion(root, ref, Buffer.from('d'), { expectVersions: 3 }),
    updateMeta(root, ref, { title: 'Stale page', expect: now.revision }),
  ]);
  assert.deepEqual([late.status, stalePage.status, stalePage.reason && stalePage.reason.status], ['fulfilled', 'rejected', 409]);
  assert.deepEqual((await getAsset(root, ref)).versions.map(v => v.n), [1, 2, 3, 4]);
  // Three new assets with one title at the same time get three folders.
  const refs = await Promise.all([1, 2, 3].map(i => shared(root, 'Twin', Buffer.from(`twin ${i}`)).then(r => r.ref)));
  assert.deepEqual(refs.sort(), ['shared:twin', 'shared:twin-2', 'shared:twin-3']);
  const files = readdirSync(join(sharedAssetsDir(root), 'busy')).sort();
  assert.deepEqual(files, ['asset.json', 'v1.txt', 'v2.txt', 'v3.txt', 'v4.txt'], 'no temporary files are left behind');
});
