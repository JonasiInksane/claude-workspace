// Tests for tools/workspace-app/bmp.mjs (and BMP uploads in uploads.mjs). Builds small BMPs of
// each supported kind, converts them, and decodes the PNG to compare pixels.
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { bmpToPng } from './bmp.mjs';
import { saveImage } from './uploads.mjs';

// A BMP from rows of pixel bytes (rows top to bottom; stored bottom-up unless topDown).
function makeBmp({ width, height, bpp, rows, topDown = false, compression = 0, dib = 40, palette = [], masks = [] }) {
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const header = Buffer.alloc(14 + dib + masks.length * 4 * (dib === 40 ? 1 : 0));
  const paletteBuf = Buffer.alloc(palette.length * 4);
  palette.forEach(([r, g, b], i) => { paletteBuf[i * 4] = b; paletteBuf[i * 4 + 1] = g; paletteBuf[i * 4 + 2] = r; });
  const offset = header.length + paletteBuf.length;
  const pixels = Buffer.alloc(stride * height);
  rows.forEach((row, y) => Buffer.from(row).copy(pixels, (topDown ? y : height - 1 - y) * stride));
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(offset + pixels.length, 2);
  header.writeUInt32LE(offset, 10);
  header.writeUInt32LE(dib, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(topDown ? -height : height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(bpp, 28);
  header.writeUInt32LE(compression, 30);
  header.writeUInt32LE(palette.length, 46);
  masks.forEach((m, i) => header.writeUInt32LE(m, 54 + i * 4));
  return Buffer.concat([header, paletteBuf, pixels]);
}

// Decodes the PNGs encodePng writes (RGBA, filter 0 on every row).
function decodePng(png) {
  let pos = 8;
  let width = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') width = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = [];
  for (let o = 0; o < raw.length; o += width * 4 + 1) {
    for (let x = 0; x < width; x++) px.push([...raw.subarray(o + 1 + x * 4, o + 5 + x * 4)]);
  }
  return px;
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

test('24-bit bottom-up BMP becomes the same pixels in PNG', () => {
  const bmp = makeBmp({ width: 2, height: 2, bpp: 24, rows: [[0, 0, 255, 0, 255, 0], [255, 0, 0, 255, 255, 255]] });
  assert.deepEqual(decodePng(bmpToPng(bmp)), [RED, GREEN, BLUE, WHITE]);
});

test('32-bit BMP: an all-zero alpha byte means opaque; bit-field masks keep real alpha', () => {
  const plain = makeBmp({ width: 2, height: 1, bpp: 32, topDown: true, rows: [[0, 0, 255, 0, 255, 0, 0, 0]] });
  assert.deepEqual(decodePng(bmpToPng(plain)), [RED, BLUE]);
  // V5 header with RGBA masks; the second pixel is half transparent.
  const masked = makeBmp({
    width: 2, height: 1, bpp: 32, dib: 124, compression: 3, topDown: true,
    masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000], rows: [[0, 255, 0, 255, 255, 0, 0, 128]],
  });
  assert.deepEqual(decodePng(bmpToPng(masked)), [GREEN, [0, 0, 255, 128]]);
});

test('8, 4 and 1-bit palette BMPs use their colour table', () => {
  const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0]];
  assert.deepEqual(decodePng(bmpToPng(makeBmp({ width: 3, height: 1, bpp: 8, palette, rows: [[1, 2, 0]] }))), [RED, GREEN, [0, 0, 0, 255]]);
  assert.deepEqual(decodePng(bmpToPng(makeBmp({ width: 3, height: 1, bpp: 4, palette, rows: [[0x12, 0x10]] }))), [RED, GREEN, RED]);
  const mono = makeBmp({ width: 9, height: 1, bpp: 1, palette: [[0, 0, 0], [255, 255, 255]], rows: [[0b10100000, 0b10000000]] });
  const px = decodePng(bmpToPng(mono));
  assert.deepEqual([px[0], px[1], px[2], px[8]], [WHITE, [0, 0, 0, 255], WHITE, WHITE]);
});

test('compressed, 16-bit, cut-off and oversized BMPs are refused with a plain message', () => {
  const ok = makeBmp({ width: 2, height: 2, bpp: 24, rows: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]] });
  const rle = Buffer.from(ok);
  rle.writeUInt32LE(1, 30);
  const sixteen = Buffer.from(ok);
  sixteen.writeUInt16LE(16, 28);
  const huge = Buffer.from(ok);
  huge.writeInt32LE(100000, 18);
  for (const [buf, msg] of [[rle, /compressed/], [sixteen, /16-bit/], [ok.subarray(0, 60), /cut off/], [huge, /too large/]]) {
    assert.throws(() => bmpToPng(buf), e => msg.test(e.message) && e.status === 415, String(msg));
  }
});

test('a BMP upload is saved as PNG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-bmp-'));
  try {
    const bmp = makeBmp({ width: 2, height: 2, bpp: 24, rows: [[0, 0, 255, 0, 255, 0], [255, 0, 0, 255, 255, 255]] });
    const file = saveImage(dir, bmp, { name: 'paint.bmp', date: '' });
    assert.equal(file, join(dir, 'paint.png'));
    assert.deepEqual(decodePng(readFileSync(file)), [RED, GREEN, BLUE, WHITE]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
