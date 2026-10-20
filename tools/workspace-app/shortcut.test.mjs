// Tests for make-icon.mjs (a valid multi-size ICO) and make-shortcut.mjs (the PowerShell it
// runs). Nothing is written to the Desktop here. Run: node --test "tools/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { crc32, encodePng, icoPath, makeIco, renderIcon, SIZES } from './make-icon.mjs';
import { shortcutScript } from './make-shortcut.mjs';
import { encodePs } from './launch.mjs';
import { spawnSync } from 'node:child_process';

test('a failing shortcut script reports one plain line, not CLIXML (writes nothing)', { skip: process.platform !== 'win32' }, () => {
  // GetFolderPath('NoSuchFolder') throws before any shortcut is touched.
  const script = shortcutScript({ action: 'create', folders: ['NoSuchFolder'], startApp: 'x', icon: 'y', workdir: 'z' });
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /CLIXML|<Objs/);
  assert.match(r.stderr, /^Cannot convert argument "folder", with value: "NoSuchFolder"/);
});

test('crc32 matches the PNG reference value', () => {
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
});

test('encodePng writes a valid PNG whose pixels decode back', () => {
  const rgba = renderIcon(16);
  const png = encodePng(16, 16, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  // Walk the chunks and check every CRC, then inflate IDAT and compare the pixels.
  let off = 8;
  let idat = Buffer.alloc(0);
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('latin1');
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), type);
    if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    off += 12 + len;
  }
  const raw = inflateSync(idat);
  for (let y = 0; y < 16; y++) {
    assert.equal(raw[y * 65], 0); // filter: none
    assert.deepEqual(raw.subarray(y * 65 + 1, (y + 1) * 65), rgba.subarray(y * 64, (y + 1) * 64));
  }
});

test('the icon is the accent square with white tiles and transparent corners', () => {
  const px = renderIcon(64);
  const at = (x, y) => [...px.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.equal(at(0, 0)[3], 0); // rounded corner
  assert.deepEqual(at(6, 32), [0xc2, 0x41, 0x0c, 255]); // accent
  assert.deepEqual(at(20, 20), [255, 255, 255, 255]); // white tile
});

test('the committed icon.ico has every size, as PNG entries', () => {
  for (const ico of [makeIco(), readFileSync(icoPath)]) {
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), SIZES.length);
    SIZES.forEach((size, i) => {
      const e = 6 + i * 16;
      assert.equal(ico[e] || 256, size);
      const offset = ico.readUInt32LE(e + 12);
      assert.equal(ico.readUInt32BE(offset + 1), 0x504e470d); // "PNG\r"
      assert.equal(ico.readUInt32BE(offset + 16), size);
    });
  }
});

test('shortcutScript creates a hidden, minimized launcher and keeps foreign shortcuts', () => {
  const s = shortcutScript({
    action: 'create', folders: ['Desktop', 'Programs'],
    startApp: "C:\\o'neil ws\\tools\\workspace-app\\start-app.ps1", icon: 'C:\\ws\\icon.ico', workdir: "C:\\o'neil ws",
  });
  assert.match(s, /foreach \(\$folder in @\('Desktop', 'Programs'\)\)/);
  assert.match(s, /-WindowStyle Hidden -File "C:\\o''neil ws\\tools\\workspace-app\\start-app\.ps1"/);
  assert.match(s, /\$s\.WorkingDirectory = 'C:\\o''neil ws'/);
  assert.match(s, /\$s\.IconLocation = 'C:\\ws\\icon\.ico,0'/);
  assert.match(s, /\$s\.WindowStyle = 7/);
  assert.match(s, /\$force = \$false/);
  // Ours only when it starts this workspace's start-app.ps1 (full path, not just the name).
  assert.match(s, /\$mine = 'C:\\o''neil ws\\tools\\workspace-app\\start-app\.ps1'/);
  assert.match(s, /Arguments\.IndexOf\(\$mine, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(s, /kept \$path \(it does not start the app of this workspace/);
  assert.match(s, /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);

  const rm = shortcutScript({ action: 'remove', folders: ['Desktop'], startApp: 'x', icon: 'y', workdir: 'z', force: true });
  assert.match(rm, /\} catch \{\n  \[Console\]::Error\.WriteLine/);
  assert.match(rm, /Remove-Item -LiteralPath \$path/);
  assert.match(rm, /\$force = \$true/);
  assert.doesNotMatch(rm, /\$s\.Save\(\)/);
});
