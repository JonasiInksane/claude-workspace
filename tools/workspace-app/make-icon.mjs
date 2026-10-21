// Draws the app icon (same design as ui/icon.svg) and writes ui/icon.ico for the Windows
// shortcut, which can't use an SVG. Built-ins only: shapes are rasterized with 4x4
// supersampling, encoded as PNG (node:zlib), and packed into one ICO with several sizes.
//
// Usage: node tools/workspace-app/make-icon.mjs   (rewrites ui/icon.ico)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const SIZES = [16, 24, 32, 48, 64, 256];
const ACCENT = [0xc2, 0x41, 0x0c];
const WHITE = [0xff, 0xff, 0xff];
// [x, y, w, h, radius, color, opacity] on a 64x64 canvas, as in ui/icon.svg.
const SHAPES = [
  [0, 0, 64, 64, 14, ACCENT, 1],
  [13, 13, 17, 21, 4, WHITE, 1],
  [34, 13, 17, 12, 4, WHITE, 0.85],
  [34, 29, 17, 22, 4, WHITE, 1],
  [13, 38, 17, 13, 4, WHITE, 0.85],
];

function inRoundedRect(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

// RGBA pixels (straight alpha) of the icon at size x size.
export function renderIcon(size) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ((i + (sx + 0.5) / ss) / size) * 64;
          const py = ((j + (sy + 0.5) / ss) / size) * 64;
          // Composite the shapes in order ("over"), premultiplied.
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const s of SHAPES) {
            if (!inRoundedRect(px, py, s)) continue;
            const [sr, sg, sb] = s[5];
            const op = s[6];
            cr = sr * op + cr * (1 - op);
            cg = sg * op + cg * (1 - op);
            cb = sb * op + cb * (1 - op);
            ca = op + ca * (1 - op);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = ss * ss;
      const k = (j * size + i) * 4;
      const alpha = a / n;
      out[k] = alpha ? Math.round(r / n / alpha) : 0;
      out[k + 1] = alpha ? Math.round(g / n / alpha) : 0;
      out[k + 2] = alpha ? Math.round(b / n / alpha) : 0;
      out[k + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An ICO file holding one PNG per size (supported since Windows Vista).
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

export function makeIco(sizes = SIZES) {
  return buildIco(sizes.map(size => ({ size, png: encodePng(size, size, renderIcon(size)) })));
}

export const icoPath = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'icon.ico');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(icoPath, makeIco());
  console.log(`Wrote ${icoPath}`);
}
