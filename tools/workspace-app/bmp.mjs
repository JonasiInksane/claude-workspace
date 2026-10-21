// BMP to PNG, so every uploaded image is in a format Claude Code's Read tool shows as an image
// (PNG, JPEG, GIF, WebP; BMP is not on that list). No dependencies: the PNG side is
// make-icon.mjs's encoder.
//
// Handles the BMPs Windows tools write: BITMAPINFOHEADER or later (V4, V5), uncompressed 1, 4, 8,
// 24 or 32 bits per pixel, 32-bit with bit-field masks, bottom-up or top-down rows. Anything else
// (RLE compression, 16-bit, the old OS/2 header) is refused with a plain message.
import { encodePng } from './make-icon.mjs';

const MAX_SIDE = 16384;
const MAX_PIXELS = 40_000_000;

const refuse = message => Object.assign(new Error(message), { status: 415 });

// The lowest set bit and the width of a colour mask, to read one channel out of a 32-bit pixel.
function maskInfo(mask) {
  if (!mask) return null;
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  let bits = 0;
  while ((mask >>> (shift + bits)) & 1) bits++;
  return { mask, shift, max: 2 ** bits - 1 };
}
const channel = (px, m, fallback) => (m ? Math.round((((px & m.mask) >>> m.shift) / m.max) * 255) : fallback);

export function bmpToPng(buf) {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') throw refuse('not a BMP file');
  const dataOffset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  if (dibSize < 40) throw refuse('this BMP uses the old OS/2 header; save it as PNG');
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (width <= 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw refuse('this BMP is too large or has an invalid size');
  }
  const bitfields = compression === 3 || compression === 6;
  if (!(compression === 0 || (bitfields && bpp === 32))) throw refuse('this BMP is compressed; save it as PNG');
  if (![1, 4, 8, 24, 32].includes(bpp)) throw refuse(`${bpp}-bit BMPs can't be converted; save it as PNG`);

  // Masks follow the 40-byte header (BI_BITFIELDS) or sit inside a V4/V5 header, at the same offset.
  let masks = null;
  if (bitfields) {
    if (buf.length < 66) throw refuse('this BMP is cut off');
    const alpha = compression === 6 || dibSize >= 56 ? buf.readUInt32LE(66) : 0;
    masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), alpha].map(maskInfo);
  }
  let palette = null;
  if (bpp <= 8) {
    const count = buf.readUInt32LE(46) || 2 ** bpp;
    const start = 14 + dibSize;
    if (count > 256 || start + count * 4 > buf.length) throw refuse('this BMP has a broken colour table');
    palette = [];
    for (let i = 0; i < count; i++) palette.push([buf[start + i * 4 + 2], buf[start + i * 4 + 1], buf[start + i * 4]]);
  }

  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + stride * height > buf.length) throw refuse('this BMP is cut off');
  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (bpp === 24) {
        [b, g, r] = [buf[row + x * 3], buf[row + x * 3 + 1], buf[row + x * 3 + 2]];
      } else if (bpp === 32) {
        const px = buf.readUInt32LE(row + x * 4);
        if (masks) {
          [r, g, b] = [channel(px, masks[0], 0), channel(px, masks[1], 0), channel(px, masks[2], 0)];
          a = channel(px, masks[3], 255);
        } else {
          [b, g, r, a] = [px & 0xff, (px >>> 8) & 0xff, (px >>> 16) & 0xff, px >>> 24];
        }
        if (a) anyAlpha = true;
      } else {
        const bit = x * bpp;
        const index = (buf[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & (2 ** bpp - 1);
        [r, g, b] = palette[index] || [0, 0, 0];
      }
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  // Plain 32-bit BMPs usually leave the fourth byte at 0: that means "no alpha", not "invisible".
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return encodePng(width, height, rgba);
}
