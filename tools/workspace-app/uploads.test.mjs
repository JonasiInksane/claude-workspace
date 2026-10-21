// Tests for tools/workspace-app/uploads.mjs. Run: node --test "tools/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectImageType, isInside, listImages, resolveTarget, safeStem, saveImage } from './uploads.mjs';

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-uploads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    const f = join(root, ...rel.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  };
  put('projects/Tattoo/.claude/agents/art.md', '---\nname: art\ndescription: a\nmemory: project\n---\n');
  put('projects/Tattoo/.claude/agents/bad.md', '---\nname: ../../x\ndescription: b\nmemory: project\n---\n');
  return root;
}

test('detectImageType reads magic bytes, not names', () => {
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(JPG), 'jpg');
  assert.equal(detectImageType(Buffer.from('GIF89a\0\0\0\0\0\0')), 'gif');
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  const bmp = Buffer.alloc(54);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(40, 14);
  assert.equal(detectImageType(bmp), 'bmp');
  assert.equal(detectImageType(Buffer.from('BMW owners club notes, not an image')), '');
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), '');
  assert.equal(detectImageType(Buffer.from('<html><body>hi</body></html>')), '');
  assert.equal(detectImageType(Buffer.alloc(3)), '');
});

test('safeStem keeps names readable and safe', () => {
  assert.equal(safeStem('Screen Shot 2026-10-21 at 10.15.png', 'x'), 'Screen-Shot-2026-10-21-at-10.15');
  assert.equal(safeStem('../../evil.png', 'x'), 'evil');
  assert.equal(safeStem('..\\..\\evil', 'x'), 'evil');
  assert.equal(safeStem('.hidden.png', 'x'), 'hidden');
  assert.equal(safeStem('con.png', 'x'), 'con-image');
  assert.equal(safeStem('', 'image-101500'), 'image-101500');
  assert.equal(safeStem('a'.repeat(200), 'x').length, 60);
});

test('isInside rejects the folder itself, parents and other drives', () => {
  assert.ok(isInside('C:\\ws\\inbox', 'C:\\ws\\inbox\\a\\b.png'));
  assert.ok(!isInside('C:\\ws\\inbox', 'C:\\ws\\inbox'));
  assert.ok(!isInside('C:\\ws\\inbox', 'C:\\ws\\inbox\\..\\secret.png'));
  assert.ok(!isInside('C:\\ws\\inbox', 'D:\\ws\\inbox\\a.png'));
  assert.ok(isInside('C:\\ws\\inbox', 'C:\\ws\\inbox\\..foo\\a.png'));
});

test('resolveTarget accepts the hub, shared and real agents only', t => {
  const root = fixture(t);
  assert.equal(resolveTarget(root, { hub: '1' }).dir, join(root, 'inbox', 'attachments', '_hub'));
  assert.equal(resolveTarget(root, {}).target.kind, 'hub');
  const art = resolveTarget(root, { project: 'tattoo', agent: 'art' });
  assert.equal(art.dir, join(root, 'inbox', 'attachments', 'Tattoo', 'art'));
  assert.equal(art.label, 'Tattoo / art');
  assert.equal(resolveTarget(root, { project: 'Tattoo', agent: '_shared' }).dir, join(root, 'inbox', 'attachments', 'Tattoo', '_shared'));
  for (const bad of [
    { project: 'Tattoo', agent: 'ghost' }, { project: 'Tattoo', agent: '../../x' }, { project: 'Tattoo', agent: '' },
    { project: '../Tattoo', agent: 'art' }, { project: 'nope', agent: 'art' },
  ]) assert.ok(resolveTarget(root, bad).error, JSON.stringify(bad));
});

test('saveImage writes into a dated folder and never overwrites', t => {
  const root = fixture(t);
  const dir = join(root, 'inbox', 'attachments', '_hub');
  const a = saveImage(dir, PNG, { name: 'shot.png', date: '2026-10-21' });
  const b = saveImage(dir, PNG, { name: 'shot.png', date: '2026-10-21' });
  assert.equal(a, join(dir, '2026-10-21', 'shot.png'));
  assert.equal(b, join(dir, '2026-10-21', 'shot-2.png'));
  // The extension follows the real type, not the name.
  assert.equal(saveImage(dir, JPG, { name: 'photo.png', date: '2026-10-21' }), join(dir, '2026-10-21', 'photo.jpg'));
  const unnamed = saveImage(dir, PNG, { date: '2026-10-21', now: new Date(2026, 9, 21, 9, 5, 7) });
  assert.equal(unnamed, join(dir, '2026-10-21', 'image-090507.png'));
  assert.deepEqual(readFileSync(a), PNG);
  assert.throws(() => saveImage(dir, Buffer.from('<svg/>'.padEnd(20)), { name: 'x.svg' }), e => e.status === 415);
});

test('listImages lists images newest first with workspace-relative paths', t => {
  const root = fixture(t);
  const dir = join(root, 'inbox', 'attachments', '_hub');
  saveImage(dir, PNG, { name: 'one', date: '2026-10-20' });
  saveImage(dir, PNG, { name: 'two', date: '2026-10-21' });
  writeFileSync(join(dir, '2026-10-21', 'notes.txt'), 'not an image');
  const list = listImages(root, dir);
  assert.deepEqual(list.map(i => i.path).sort(), ['inbox/attachments/_hub/2026-10-20/one.png', 'inbox/attachments/_hub/2026-10-21/two.png']);
  assert.equal(list.find(i => i.name === 'two.png').date, '2026-10-21');
  assert.deepEqual(listImages(root, join(root, 'missing')), []);
});
