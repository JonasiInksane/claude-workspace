// The sprite views of the Assets view: an HD-2D diorama (WebGL2, no libraries) and a flat pixel
// view (2D canvas). Both play a sheet from a sprite pipeline (projects/<p>/tools/sprite.mjs):
// export/SPR_<Name>.png with SPR_<Name>.json (Aseprite "array" frames and frameTags named
// <anim>_<direction>, plus a meta.sprite block: cell, pivot, pixels per metre, animations), and
// optional normal-map and emissive sheets with the same layout.
//
// The diorama presents the sprite the way HD-2D games do: a billboard standing in a small 3D
// scene with pixel-art textures, lit by a sun with real shadows (the sprite casts its silhouette),
// a flickering torch and the sky, with normal-mapped light on the sprite and glowing emissive
// pixels; then tilt-shift depth of field, bloom, a vignette and a gentle colour grade. Drag to
// orbit, scroll to zoom, double-click to reset.

export const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const MIRROR = { east: 'west', west: 'east', 'south-east': 'south-west', 'south-west': 'south-east', 'north-east': 'north-west', 'north-west': 'north-east' };
const HOLD_MS = 700; // a one-shot animation (attack, hurt) holds its last frame this long, then plays again
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// ---------------------------------------------------------------- loading and playback

async function fetchBitmap(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`could not load a sprite image (${res.status})`);
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// The sheet, its frames by tag, and the sprite facts both views need. urls: { json, sheet,
// normal?, emissive? }; a missing or broken normal or emissive sheet is left out.
export async function loadSprite({ json, sheet, normal = '', emissive = '' }) {
  const res = await fetch(json, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`could not load the sprite sheet's JSON (${res.status})`);
  const data = await res.json();
  const meta = data.meta || {};
  const info = meta.sprite || {};
  const list = Array.isArray(data.frames) ? data.frames : Object.entries(data.frames || {}).map(([filename, f]) => ({ filename, ...f }));
  const frames = list.filter(f => f && f.frame).map(f => ({
    x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, duration: Number(f.duration) > 0 ? Number(f.duration) : 100,
  }));
  if (!frames.length) throw new Error('the sprite sheet has no frames');
  const tags = new Map();
  for (const t of meta.frameTags || []) {
    const from = Math.max(0, t.from | 0);
    const to = Math.min(frames.length - 1, t.to | 0);
    if (to >= from) tags.set(String(t.name), frames.slice(from, to + 1));
  }
  const [image, normalMap, emissiveMap] = await Promise.all([
    fetchBitmap(sheet),
    normal ? fetchBitmap(normal).catch(() => null) : null,
    emissive ? fetchBitmap(emissive).catch(() => null) : null,
  ]);
  const cell = info.cell && info.cell.w > 0 ? { w: info.cell.w, h: info.cell.h } : { w: frames[0].w, h: frames[0].h };
  const pivot = info.pivot && Number.isFinite(info.pivot.x) ? { x: info.pivot.x, y: info.pivot.y } : { x: cell.w / 2, y: cell.h };
  const stand = String(info.stand || 'stand');
  // Animation names: the stand poses first, then meta.sprite.animations, then any other tag.
  const names = new Set(tags.has(`${stand}_south`) || [...tags.keys()].some(k => k.startsWith(`${stand}_`)) ? [stand] : []);
  for (const name of Object.keys(info.animations || {})) names.add(name);
  for (const name of tags.keys()) { const i = name.lastIndexOf('_'); if (i > 0) names.add(name.slice(0, i)); }
  const ppm = Number(info.pixelsPerMeter) > 0 ? Number(info.pixelsPerMeter) : 18;
  return {
    name: String(info.name || ''), image, normalMap, emissiveMap, frames, tags, cell, pivot, stand, ppm,
    heightPx: Number(info.heightPx) > 0 ? Number(info.heightPx) : Math.round(pivot.y * 0.8),
    animations: info.animations && typeof info.animations === 'object' ? info.animations : {},
    names: [...names].filter(n => [...tags.keys()].some(k => k.startsWith(`${n}_`))),
    palette: Array.isArray(info.palette) ? info.palette.map(String) : [],
  };
}

// The frames for an animation and a direction. A missing direction is the mirror of its
// opposite (east <-> west) when that exists, else the nearest direction the animation has, else
// the stand pose.
export function clipFor(sprite, anim, dir) {
  const get = d => sprite.tags.get(`${anim}_${d}`);
  if (get(dir)) return { frames: get(dir), flip: false, dir };
  if (MIRROR[dir] && get(MIRROR[dir])) return { frames: get(MIRROR[dir]), flip: true, dir };
  const i = Math.max(0, DIRECTIONS.indexOf(dir));
  for (let k = 1; k <= 4; k++) {
    for (const j of [i + k, i - k]) {
      const d = DIRECTIONS[(j + 8) % 8];
      if (get(d)) return { frames: get(d), flip: false, dir: d };
    }
  }
  if (anim !== sprite.stand && [...sprite.tags.keys()].some(k => k.startsWith(`${sprite.stand}_`))) return clipFor(sprite, sprite.stand, dir);
  return { frames: sprite.frames.slice(0, 1), flip: false, dir };
}

// Plays one clip with the sheet's per-frame durations. onChange runs when the frame shown changes.
function createPlayer(onChange) {
  const p = { sprite: null, anim: '', dir: 'south', clip: null, index: 0, t: 0, playing: true, loop: true };
  p.set = (anim, dir, keepPhase = false) => {
    if (!p.sprite || (anim === p.anim && dir === p.dir && p.clip)) return;
    const was = p.index;
    p.anim = anim;
    p.dir = dir;
    p.clip = clipFor(p.sprite, anim, dir);
    p.loop = anim === p.sprite.stand || p.sprite.animations[anim]?.loop !== false;
    p.index = keepPhase ? was % p.clip.frames.length : 0;
    if (!keepPhase) p.t = 0;
    onChange();
  };
  p.tick = dt => {
    if (!p.playing || !p.clip || p.clip.frames.length < 2) return;
    p.t += dt;
    for (let guard = 0; guard < 64; guard++) {
      const last = p.index === p.clip.frames.length - 1;
      const dur = p.clip.frames[p.index].duration + (last && !p.loop ? HOLD_MS : 0);
      if (p.t < dur) return;
      p.t -= dur;
      p.index = (p.index + 1) % p.clip.frames.length;
      onChange();
    }
    p.t = 0;
  };
  p.step = delta => {
    if (!p.clip) return;
    const n = p.clip.frames.length;
    p.index = (((p.index + delta) % n) + n) % n;
    p.t = 0;
    onChange();
  };
  p.frame = () => (p.clip ? p.clip.frames[p.index] : null);
  return p;
}

const defaultAnim = sprite => (sprite.names.includes('idle') ? 'idle' : sprite.names.includes(sprite.stand) ? sprite.stand : sprite.names[0] || sprite.stand);

// ---------------------------------------------------------------- the pixel view

// The sprite's pixels at an integer zoom on a checkerboard, with the ground line and pivot.
// onFrame({ index, count, anim, dir, duration, playing }) runs when the frame changes.
export function createPixelView(canvas, { onFrame = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  let sprite = null;
  let zoom = 4;
  let alive = true;
  let dirty = true;
  let last = 0;
  const player = createPlayer(() => { dirty = true; report(); });

  function report() {
    if (!player.clip) return;
    onFrame({ index: player.index, count: player.clip.frames.length, anim: player.anim, dir: player.clip.dir,
      duration: player.frame()?.duration || 0, playing: player.playing });
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const s = Math.max(4, Math.round(8 * dpr));
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        ctx.fillStyle = ((x / s + y / s) & 1) ? '#c3bfb6' : '#d5d2ca';
        ctx.fillRect(x, y, s, s);
      }
    }
    const f = player.frame();
    if (!sprite || !f) return;
    const z = Math.max(1, Math.round(zoom * dpr));
    const dw = f.w * z;
    const dh = f.h * z;
    const dx = Math.round((w - dw) / 2);
    const dy = Math.round((h - dh) / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    if (player.clip.flip) { ctx.translate(dx + dw, dy); ctx.scale(-1, 1); ctx.drawImage(sprite.image, f.x, f.y, f.w, f.h, 0, 0, dw, dh); }
    else ctx.drawImage(sprite.image, f.x, f.y, f.w, f.h, dx, dy, dw, dh);
    ctx.restore();
    // The ground line under the feet, and a tick at the pivot.
    const line = Math.max(1, Math.round(dpr));
    const px = player.clip.flip ? f.w - sprite.pivot.x : sprite.pivot.x;
    ctx.fillStyle = 'rgba(194, 65, 12, 0.55)';
    ctx.fillRect(dx - z * 2, dy + Math.round(sprite.pivot.y * z), dw + z * 4, line);
    ctx.fillRect(dx + Math.round(px * z), dy + Math.round(sprite.pivot.y * z) - z, line, z * 2);
  }

  function frame(t) {
    if (!alive) return;
    if (!canvas.isConnected) { dispose(); return; }
    const dt = last ? Math.min(t - last, 100) : 16;
    last = t;
    player.tick(dt);
    if (dirty || canvas.width !== Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2))) { draw(); dirty = false; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function dispose() { alive = false; }

  return {
    async load(spriteOrUrls) {
      sprite = spriteOrUrls.json ? await loadSprite(spriteOrUrls) : spriteOrUrls;
      player.sprite = sprite;
      player.clip = null;
      player.set(defaultAnim(sprite), 'south');
      dirty = true;
      return sprite;
    },
    setAnimation(name) { player.set(name, player.dir); },
    setDirection(dir) { player.set(player.anim, dir); },
    setZoom(n) { zoom = Math.max(1, Math.min(8, Math.round(n))); dirty = true; },
    play() { player.playing = true; report(); },
    pause() { player.playing = false; report(); },
    toggle() { player.playing = !player.playing; report(); },
    step(delta = 1) { player.playing = false; player.step(delta); },
    get playing() { return player.playing; },
    dispose,
  };
}

// ---------------------------------------------------------------- small maths (column-major)

const M = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  ortho(l, r, b, t, n, f) {
    return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
      -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
  },
  lookAt(eye, target, up) {
    const z = norm(sub(eye, target));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  },
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rad = deg => (deg * Math.PI) / 180;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));

// ---------------------------------------------------------------- pixel-art textures for the diorama

function pixmap(w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  const at = (x, y, wrap) => {
    if (wrap) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; } else if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return (y * w + x) * 4;
  };
  return {
    img,
    set(x, y, c, wrap = false) { const i = at(x, y, wrap); if (i >= 0) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; } },
    on(x, y) { const i = at(x, y, false); return i >= 0 && d[i + 3] > 0; },
  };
}

// Smooth value noise that tiles over `size` pixels (cell must divide size).
function tilingNoise(size, cell, rand) {
  const n = size / cell;
  const g = Float32Array.from({ length: n * n }, () => rand());
  const at = (i, j) => g[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
  return (x, y) => {
    const fx = x / cell; const fy = y / cell;
    const i = Math.floor(fx); const j = Math.floor(fy);
    let u = fx - i; let v = fy - j;
    u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

// 12 m of ground in 480 px (40 px per metre): dithered grass, blades and flowers, and a
// cobblestone path running north-south through the middle. Tiles in both directions.
const GROUND_TILE_M = 12;
function groundPixels(seed) {
  const S = 480;
  const pm = pixmap(S, S);
  const rand = rng(seed);
  const G = ['#2d4f25', '#3a602d', '#467034', '#557f3c', '#689048'].map(hex);
  const nA = tilingNoise(S, 40, rand);
  const nB = tilingNoise(S, 12, rand);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = nA(x, y) * 0.62 + nB(x, y) * 0.38 + (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.47) * 0.26;
    pm.set(x, y, G[clamp(Math.floor(v * 5), 0, 4)]);
  }
  for (let i = 0; i < 2800; i++) {
    const x = (rand() * S) | 0; const y = (rand() * S) | 0; const c = G[rand() < 0.62 ? 4 : 0];
    pm.set(x, y, c, true); pm.set(x, y - 1, c, true);
    if (rand() < 0.5) pm.set(x + (rand() < 0.5 ? -1 : 1), y - 2, c, true);
  }
  const F = ['#efd36a', '#f2efe4', '#d98cae', '#9fc6ef'].map(hex);
  for (let i = 0; i < 240; i++) {
    const x = (rand() * S) | 0; const y = (rand() * S) | 0;
    pm.set(x, y, F[(rand() * F.length) | 0], true); pm.set(x, y + 1, G[0], true);
  }
  const DIRT = ['#4b3b2b', '#5c4935', '#6d5840'].map(hex);
  const STONE = ['#8a8375', '#968e80', '#a2998a'].map(hex);
  const HI = hex('#bdb4a3');
  const LO = hex('#6a6358');
  const edge = (y, side) => Math.round((side ? 288 : 192) + 3 * Math.sin((y / S) * Math.PI * 4 + side * 1.3) + 2 * Math.sin((y / S) * Math.PI * 10 + side * 0.4));
  const ROW = 12;
  for (let r = 0; r < S / ROW; r++) {
    const spans = [];
    for (let x = 184 + (r % 2 ? 6 : 0) - ((rand() * 4) | 0); x < 300;) {
      const w = 9 + ((rand() * 7) | 0);
      spans.push([x, x + w, STONE[(rand() * 3) | 0]]);
      x += w + 1;
    }
    for (let yy = 0; yy < ROW; yy++) {
      const y = r * ROW + yy;
      const L = edge(y, 0); const R = edge(y, 1);
      for (let px = L - 2; px <= R + 2; px++) {
        if (px < L || px > R) { if (rand() < 0.5) pm.set(px, y, DIRT[(rand() * 3) | 0]); continue; }
        const s = spans.find(sp => px >= sp[0] && px < sp[1]);
        if (!s || yy === 0) { pm.set(px, y, DIRT[(rand() * 2) | 0]); continue; }
        const lx = px - s[0]; const w = s[1] - s[0];
        if ((lx === 0 || lx === w - 1) && (yy === 1 || yy === ROW - 1)) { pm.set(px, y, DIRT[1]); continue; }
        let c = s[2];
        if (yy === 1 || lx === 0) c = HI;
        else if (yy === ROW - 1 || lx === w - 1) c = LO;
        else if (rand() < 0.06) c = LO;
        pm.set(px, y, c);
      }
    }
  }
  return pm.img;
}

// A crate face, 48 px: planks, a diagonal brace, a frame and nails.
function cratePixels() {
  const S = 48;
  const pm = pixmap(S, S);
  const plank = ['#8a5a30', '#94643a', '#7c512b'].map(hex);
  const seam = hex('#47301f'); const frame = hex('#5b3a21'); const frameHi = hex('#a3733f');
  const brace = hex('#6d4726'); const braceHi = hex('#a87a45'); const nail = hex('#2a2521'); const nailHi = hex('#d0c7b5');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const p = Math.floor((y - 4) / 13);
    let c = plank[((p % 3) + 3) % 3];
    if ((((y - 4) % 13) + 13) % 13 === 12 || (x * 7 + y * 3) % 23 === 0) c = seam;
    pm.set(x, y, c);
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = x - (S - 1 - y);
    if (Math.abs(d) <= 3) pm.set(x, y, Math.abs(d) === 3 ? (d < 0 ? braceHi : seam) : brace);
  }
  for (let i = 0; i < S; i++) for (let k = 0; k < 4; k++) {
    const c = k === 3 ? seam : k === 0 ? frame : frameHi;
    pm.set(i, k, k === 1 ? frameHi : c); pm.set(i, S - 1 - k, k === 3 ? frameHi : frame);
    pm.set(k, i, k === 1 ? frameHi : c); pm.set(S - 1 - k, i, k === 3 ? frameHi : frame);
  }
  for (const [x, y] of [[6, 6], [41, 6], [6, 41], [41, 41]]) { pm.set(x, y, nail); pm.set(x + 1, y, nail); pm.set(x, y + 1, nail); pm.set(x, y, nailHi); }
  return pm.img;
}

// Stone blocks, 64 px per metre, tiling: staggered bricks with mortar, edge light and moss.
function stonePixels(seed) {
  const S = 64;
  const pm = pixmap(S, S);
  const rand = rng(seed);
  const B = ['#7e7a72', '#8a867d', '#959189'].map(hex);
  const mortar = hex('#4b4842'); const hi = hex('#aaa69c'); const lo = hex('#67645d'); const moss = ['#4e6c36', '#5e7f3f'].map(hex);
  const BW = 16; const BH = 8;
  for (let row = 0; row < S / BH; row++) {
    const off = row % 2 ? BW / 2 : 0;
    for (let bx = -1; bx < S / BW; bx++) {
      const tone = B[(rand() * 3) | 0];
      for (let yy = 0; yy < BH; yy++) for (let xx = 0; xx < BW; xx++) {
        let c = tone;
        if (yy === BH - 1 || xx === BW - 1) c = mortar;
        else if (yy === 0 || xx === 0) c = hi;
        else if (yy === BH - 2 || xx === BW - 2 || rand() < 0.08) c = lo;
        pm.set(bx * BW + off + xx, row * BH + yy, c, true);
      }
    }
  }
  for (let i = 0; i < 80; i++) pm.set((rand() * S) | 0, S - 1 - ((rand() * rand() * 30) | 0), moss[(rand() * 2) | 0], true);
  return pm.img;
}

// Outlines a pixmap's shape with its darkest colour (as pixel-art foliage is drawn).
function outline(pm, w, h, color) {
  const edge = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (pm.on(x, y) && (!pm.on(x - 1, y) || !pm.on(x + 1, y) || !pm.on(x, y - 1) || !pm.on(x, y + 1))) edge.push([x, y]);
  }
  for (const [x, y] of edge) pm.set(x, y, color);
}

// A round tree, 80 x 112 px (drawn at the sprites' pixel density): a trunk and a canopy of
// discs, lit from the upper left with dithered steps.
function treePixels(seed) {
  const W = 80; const H = 112;
  const pm = pixmap(W, H);
  const rand = rng(seed);
  const LEAF = ['#1d371f', '#2a4d29', '#386332', '#4a7a3a', '#629448', '#7fad58'].map(hex);
  const BARK = ['#2d2118', '#4a3425', '#5e432f', '#7a593f'].map(hex);
  for (let y = 56; y < H - 1; y++) {
    const half = 4 + (y > H - 12 ? Math.round((y - (H - 12)) * 0.7) : 0);
    for (let x = 40 - half; x <= 40 + half; x++) {
      const t = (x - (40 - half)) / (2 * half);
      pm.set(x, y, rand() < 0.07 ? BARK[1] : t < 0.3 ? BARK[3] : t < 0.7 ? BARK[2] : BARK[1]);
    }
  }
  const discs = [[40, 36, 28], [21, 50, 18], [59, 48, 19], [40, 15, 15], [29, 62, 14], [52, 63, 13]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = -9;
    for (const [cx, cy, r] of discs) {
      const dx = (x - cx) / r; const dy = (y - cy) / r; const d2 = dx * dx + dy * dy;
      if (d2 <= 1) best = Math.max(best, -dx * 0.55 - dy * 0.65 + Math.sqrt(1 - d2) * 0.5);
    }
    if (best < -8) continue;
    const v = best + (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.35 + (rand() - 0.5) * 0.18;
    pm.set(x, y, LEAF[clamp(Math.floor((v + 0.55) * 3.3), 1, 5)]);
  }
  outline(pm, W, H, LEAF[0]);
  return pm.img;
}

// A pine, 64 x 120 px: stacked tiers, lighter on the left.
function pinePixels(seed) {
  const W = 64; const H = 120;
  const pm = pixmap(W, H);
  const rand = rng(seed);
  const LEAF = ['#18301f', '#21402a', '#2d5534', '#3c6b40', '#55874f'].map(hex);
  for (let y = 96; y < H - 1; y++) for (let x = 29; x <= 35; x++) pm.set(x, y, hex(x < 31 ? '#76553c' : x < 34 ? '#5c412e' : '#432f22'));
  for (let k = 0; k < 5; k++) {
    const top = 4 + k * 17; const bottom = top + 30; const halfMax = 9 + k * 5;
    for (let y = top; y < Math.min(bottom, 100); y++) {
      const half = Math.round(((y - top) / (bottom - top)) * halfMax);
      for (let x = 32 - half; x <= 32 + half; x++) {
        const t = (x - (32 - half)) / Math.max(1, 2 * half);
        const v = 1 - t + (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.4 + (rand() - 0.5) * 0.15 - (y - top) / (bottom - top) * 0.35;
        pm.set(x, y, LEAF[clamp(Math.floor(v * 3.2), 1, 4)]);
      }
    }
  }
  outline(pm, W, H, LEAF[0]);
  return pm.img;
}

// A grass tuft, 16 x 10 px.
function tuftPixels(seed) {
  const pm = pixmap(16, 10);
  const rand = rng(seed);
  const G = ['#2c4f24', '#4b7a34', '#6f9f48', '#8dbb5c'].map(hex);
  for (let b = 0; b < 6; b++) {
    const x0 = 2 + b * 2 + ((rand() * 2) | 0); const tall = 4 + ((rand() * 5) | 0); const lean = rand() < 0.5 ? -1 : 1;
    for (let k = 0; k < tall; k++) pm.set(x0 + (k > tall / 2 ? lean : 0), 9 - k, G[k === 0 ? 0 : k > tall - 2 ? 3 : 1 + (b % 2)]);
  }
  return pm.img;
}

// ---------------------------------------------------------------- shaders

const LIGHT = `
uniform vec3 uSunDir, uSunColor, uSky, uGround, uTorchPos, uTorchColor, uFogColor, uEye;
uniform float uFogDensity, uShadowOn;
uniform sampler2DShadow uShadow;
float shadowAt(vec4 lp) {
  vec3 p = lp.xyz / lp.w * 0.5 + 0.5;
  if (uShadowOn < 0.5 || p.z >= 1.0 || p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0) return 1.0;
  vec2 texel = 1.0 / vec2(textureSize(uShadow, 0));
  float s = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += texture(uShadow, vec3(p.xy + vec2(x, y) * texel * 1.5, p.z - 0.0006));
  return s / 9.0;
}
// wrap > 0 softens the terminator, so sprites and foliage stay readable from every side.
vec3 shade(vec3 albedo, vec3 n, vec3 pos, float sh, float wrap) {
  vec3 c = albedo * uSunColor * clamp((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0, 1.0) * sh;
  c += albedo * mix(uGround, uSky, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 tl = uTorchPos - pos;
  float d = max(length(tl), 0.05);
  float att = smoothstep(8.5, 2.0, d) / (1.0 + 0.55 * d * d);
  c += albedo * uTorchColor * att * clamp((dot(n, tl / d) + wrap) / (1.0 + wrap), 0.0, 1.0);
  return c;
}
vec3 fogged(vec3 c, vec3 pos) {
  float f = 1.0 - exp(-uFogDensity * max(distance(pos, uEye) - 16.0, 0.0));
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
`;

const HEAD = '#version 300 es\nprecision highp float;\nprecision highp sampler2DShadow;\n';

const MESH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj, uLightVP;
out vec3 vPos; out vec3 vNormal; out vec2 vUv; out vec4 vLight;
void main() {
  vPos = aPos; vNormal = aNormal; vUv = aUv;
  vLight = uLightVP * vec4(aPos + aNormal * 0.03, 1.0);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const MESH_FS = `${HEAD}
in vec3 vPos; in vec3 vNormal; in vec2 vUv; in vec4 vLight;
uniform sampler2D uTex;
${LIGHT}
out vec4 color;
void main() {
  vec3 albedo = toLinear(texture(uTex, vUv).rgb);
  color = vec4(fogged(shade(albedo, normalize(vNormal), vPos, shadowAt(vLight), 0.0), vPos), 1.0);
}`;

// A billboard standing on its pivot: corners (0,0) top-left to (1,1) bottom-right of the cell.
const BOARD_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj, uLightVP;
uniform vec3 uOrigin, uRight, uSunDir;
uniform vec2 uSize, uPivot;
uniform vec4 uUvRect;
uniform float uFlip, uRecv;
out vec2 vUv; out vec3 vPos; out vec4 vLight;
void main() {
  vec3 pos = uOrigin + uRight * ((aCorner.x - uPivot.x) * uSize.x) + vec3(0.0, (uPivot.y - aCorner.y) * uSize.y, 0.0);
  float u = uFlip > 0.5 ? 1.0 - aCorner.x : aCorner.x;
  vUv = vec2(mix(uUvRect.x, uUvRect.z, u), mix(uUvRect.y, uUvRect.w, aCorner.y));
  vPos = pos;
  // Moved toward the sun, so a sprite isn't shadowed by its own (sun-facing) shadow caster.
  vLight = uLightVP * vec4(pos + uSunDir * uRecv, 1.0);
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

const BOARD_FS = `${HEAD}
in vec2 vUv; in vec3 vPos; in vec4 vLight;
uniform sampler2D uSheet, uNormalSheet, uEmissiveSheet;
uniform vec3 uRight, uToward;
uniform float uFlip, uUseNormal, uUseEmissive, uEmissive, uWrap, uLift;
${LIGHT}
out vec4 color;
void main() {
  vec4 t = texture(uSheet, vUv);
  if (t.a < 0.5) discard;
  vec3 albedo = toLinear(t.rgb);
  vec3 n = normalize(uToward + vec3(0.0, uLift, 0.0));
  if (uUseNormal > 0.5) {
    vec3 m = texture(uNormalSheet, vUv).xyz * 2.0 - 1.0;
    if (uFlip > 0.5) m.x = -m.x;
    n = normalize(uRight * m.x + vec3(0.0, 1.0, 0.0) * (m.y + uLift * 0.3) + uToward * max(m.z, 0.05));
  }
  vec3 c = shade(albedo, n, vPos, shadowAt(vLight), uWrap);
  if (uUseEmissive > 0.5) c += albedo * texture(uEmissiveSheet, vUv).r * uEmissive;
  color = vec4(fogged(c, vPos), 1.0);
}`;

const DEPTH_MESH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uLightVP;
void main() { gl_Position = uLightVP * vec4(aPos, 1.0); }`;

const DEPTH_FS = '#version 300 es\nprecision mediump float;\nvoid main() {}';

const DEPTH_BOARD_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSheet;
void main() { if (texture(uSheet, vUv).a < 0.5) discard; }`;

// The soft contact shadow under the feet: a dark ellipse on the ground.
const BLOB_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec2 uRadius;
out vec2 vQ;
void main() {
  vQ = aCorner * 2.0 - 1.0;
  gl_Position = uViewProj * vec4(uCenter + vec3(vQ.x * uRadius.x, 0.0, vQ.y * uRadius.y), 1.0);
}`;

const BLOB_FS = `#version 300 es
precision mediump float;
in vec2 vQ;
uniform float uStrength;
out vec4 color;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  color = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(0.1, 1.0, r)) * uStrength);
}`;

// The torch flame: chunky pixels, flickering, bright enough to bloom.
const FLAME_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime, uGlow;
out vec4 color;
void main() {
  vec2 q = (floor(vUv * vec2(7.0, 11.0)) + 0.5) / vec2(7.0, 11.0);
  float x = (q.x - 0.5) * 2.0, y = 1.0 - q.y;
  float wob = sin(uTime * 9.0 + y * 6.0) * 0.18 * y;
  float w = (1.0 - y) * (0.9 + 0.1 * sin(uTime * 13.0)) - 0.05;
  if (abs(x - wob) > w || y > 0.94) discard;
  float core = 1.0 - abs(x - wob) / max(w, 0.01);
  color = vec4(mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.86, 0.48), core * (1.0 - y)) * uGlow, 1.0);
}`;

const SCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Depth of field: how blurred a pixel is (0 sharp .. 1 fully), from its distance to the focus.
const COC = `
uniform sampler2D uDepth;
uniform vec4 uFocus; // focus distance, sharp band, far range, near range (metres)
uniform vec2 uClip;  // near, far
float cocAt(vec2 uv) {
  float d = texture(uDepth, uv).r * 2.0 - 1.0;
  float z = 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - d * (uClip.y - uClip.x));
  float dz = z - uFocus.x;
  return clamp(dz > 0.0 ? (dz - uFocus.y) / uFocus.z : (-dz - uFocus.y) / uFocus.w, 0.0, 1.0);
}`;

const PREP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
${COC}
out vec4 color;
void main() { color = vec4(texture(uScene, vUv).rgb, cocAt(vUv)); }`;

// A 9-tap Gaussian along uStep. With uCocWeight, samples count by their blur amount, so sharp
// pixels (the character) don't bleed into the blurred background; alpha carries the amount on.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uCocWeight;
out vec4 color;
void main() {
  float W[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec4 c0 = texture(uSrc, vUv);
  float w0 = W[0] * (mix(1.0, c0.a, uCocWeight) + 0.001);
  vec3 sum = c0.rgb * w0;
  float wsum = w0;
  for (int i = 1; i < 5; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec4 c = texture(uSrc, vUv + uStep * float(i * s));
      float w = W[i] * (mix(1.0, c.a, uCocWeight) + 0.001);
      sum += c.rgb * w;
      wsum += w;
    }
  }
  color = vec4(sum / wsum, c0.a);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 color;
void main() { color = texture(uSrc, vUv); }`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
out vec4 color;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  color = vec4(c * (max(soft, l - uThreshold) / max(l, 1e-4)), 1.0);
}`;

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uDofHalf, uDofQuarter, uBloomA, uBloomB;
uniform float uDof, uBloom, uBloomStrength, uExposure, uVignette, uNight;
${COC}
out vec4 color;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  if (uDof > 0.5) {
    float k = cocAt(vUv);
    c = mix(c, texture(uDofHalf, vUv).rgb, smoothstep(0.0, 0.45, k));
    c = mix(c, texture(uDofQuarter, vUv).rgb, smoothstep(0.4, 1.0, k));
  }
  if (uBloom > 0.5) c += (texture(uBloomA, vUv).rgb * 0.6 + texture(uBloomB, vUv).rgb * 0.8) * uBloomStrength;
  c = aces(c * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, 1.1), 0.0);
  // Cool shadows and warm highlights by day; blue night with warm lamplight.
  vec3 lowTint = mix(vec3(0.95, 0.99, 1.07), vec3(0.86, 0.94, 1.16), uNight);
  vec3 highTint = mix(vec3(1.06, 1.0, 0.91), vec3(1.04, 0.98, 0.94), uNight);
  c *= mix(lowTint, highTint, smoothstep(0.05, 0.7, l));
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.15, 0.7, dot(d, d) * 2.0);
  color = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

// ---------------------------------------------------------------- the diorama

// Light presets (linear colours); night blends in over about a second.
const DAY = {
  sunDir: norm([-0.55, 0.78, 0.32]), sun: [2.25, 2.05, 1.72], sky: [0.22, 0.28, 0.4], ground: [0.12, 0.11, 0.07],
  torch: [2.2, 1.15, 0.44], fog: [0.52, 0.64, 0.82], fogDensity: 0.018, emissive: 2.4, bloom: 0.45, threshold: 1.0,
  exposure: 0.95, vignette: 0.42, blob: 0.34, flame: 5,
};
const NIGHT = {
  sunDir: norm([0.4, 0.8, -0.25]), sun: [0.17, 0.23, 0.44], sky: [0.035, 0.05, 0.11], ground: [0.015, 0.02, 0.035],
  torch: [7.5, 3.6, 1.2], fog: [0.025, 0.04, 0.09], fogDensity: 0.04, emissive: 3.6, bloom: 0.9, threshold: 0.6,
  exposure: 1.25, vignette: 0.6, blob: 0.22, flame: 9,
};
const FOV = rad(28);
const NEAR = 0.5;
const FAR = 90;
const SHADOW_SIZE = 2048;
const START = [0, 0, 0.6];
const VIEW = { yaw: 0, pitch: rad(32), dist: 14 };
const TORCH = [-2.4, 2.36, -1.6];
const WALK = { rx: 1.7, rz: 1.2, z: START[2] - 1.2, speed: 1.25 }; // a loop through START (at its angle 0)

// opts: onInfo({ anim, dir, frame, frames, walking }) when the sprite's frame or clip changes;
// onError(message) for a GL error (checked once a second).
export function createSpriteViewer(canvas, { onInfo = () => {}, onError = () => {} } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error('this window has no WebGL2, so the HD-2D view is off');
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const owned = []; // [delete function, object] for everything made here
  const own = (del, o) => { owned.push([del, o]); return o; };

  function program(vs, fs) {
    const p = own('deleteProgram', gl.createProgram());
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`shader: ${gl.getProgramInfoLog(p)}`);
    const locs = new Map();
    return { p, u: name => { if (!locs.has(name)) locs.set(name, gl.getUniformLocation(p, name)); return locs.get(name); } };
  }
  const P = {
    mesh: program(MESH_VS, MESH_FS), board: program(BOARD_VS, BOARD_FS), depthMesh: program(DEPTH_MESH_VS, DEPTH_FS),
    depthBoard: program(BOARD_VS, DEPTH_BOARD_FS), blob: program(BLOB_VS, BLOB_FS), flame: program(BOARD_VS, FLAME_FS),
    prep: program(SCREEN_VS, PREP_FS), blur: program(SCREEN_VS, BLUR_FS), copy: program(SCREEN_VS, COPY_FS),
    bright: program(SCREEN_VS, BRIGHT_FS), final: program(SCREEN_VS, FINAL_FS),
  };

  // Uniforms by value type: numbers, vec2-4 and mat4. Samplers go through tex().
  function set(prog, values) {
    for (const [k, v] of Object.entries(values)) {
      const l = prog.u(k);
      if (l === null) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (v.length === 2) gl.uniform2fv(l, v);
      else if (v.length === 3) gl.uniform3fv(l, v);
      else if (v.length === 4) gl.uniform4fv(l, v);
      else gl.uniformMatrix4fv(l, false, v);
    }
  }
  function tex(prog, name, unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    const l = prog.u(name);
    if (l !== null) gl.uniform1i(l, unit);
  }

  // A texture from an ImageData or ImageBitmap. Pixel art: nearest when magnified.
  function texture(src, { repeat = false, mip = false } = {}) {
    const t = own('deleteTexture', gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (mip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    return t;
  }
  const flatNormal = texture(new ImageData(new Uint8ClampedArray([128, 128, 255, 255]), 1, 1));
  const black = texture(new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1));

  // ---------------------------------------------------------------- the scene

  const quadVao = own('deleteVertexArray', gl.createVertexArray());
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, own('deleteBuffer', gl.createBuffer()));
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const screenVao = own('deleteVertexArray', gl.createVertexArray());
  gl.bindVertexArray(null);

  // Meshes: interleaved position, normal, uv. One per texture.
  function mesh(map, build, casts = true) {
    const v = [];
    const quad = (p, n, uv) => { for (const i of [0, 1, 2, 0, 2, 3]) v.push(...p[i], ...n, ...uv[i]); };
    build(quad);
    const vao = own('deleteVertexArray', gl.createVertexArray());
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, own('deleteBuffer', gl.createBuffer()));
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    for (const [loc, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 32, offset);
    }
    gl.bindVertexArray(null);
    return { vao, count: v.length / 8, map, casts };
  }
  // A box's five visible faces (no bottom). Each face shows the whole texture, or with `tile` the
  // texture repeats every `tile` metres in world units, so bricks line up across faces.
  // A face's uv runs left to right as seen from outside, and top to bottom.
  function box(quad, [x0, y0, z0], [x1, y1, z1], tile = 0) {
    const uv = (a0, a1, b0, b1) => (tile
      ? [[a0 / tile, b0 / tile], [a1 / tile, b0 / tile], [a1 / tile, b1 / tile], [a0 / tile, b1 / tile]]
      : [[0, 0], [1, 0], [1, 1], [0, 1]]);
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]], [0, 0, 1], uv(x0, x1, -y1, -y0));
    quad([[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]], [0, 0, -1], uv(-x1, -x0, -y1, -y0));
    quad([[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], [1, 0, 0], uv(-z1, -z0, -y1, -y0));
    quad([[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]], [-1, 0, 0], uv(z0, z1, -y1, -y0));
    quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], uv(x0, x1, z0, z1));
  }

  const groundTex = texture(groundPixels(7), { repeat: true, mip: true });
  const crateTex = texture(cratePixels(), { mip: true });
  const stoneTex = texture(stonePixels(3), { repeat: true, mip: true });
  const meshes = [
    mesh(groundTex, quad => {
      const R = 60; const u = x => x / GROUND_TILE_M + 0.5;
      quad([[-R, 0, -R], [R, 0, -R], [R, 0, R], [-R, 0, R]], [0, 1, 0], [[u(-R), u(-R)], [u(R), u(-R)], [u(R), u(R)], [u(-R), u(R)]]);
    }, false),
    mesh(crateTex, quad => {
      box(quad, [2.6, 0, -0.85], [3.4, 0.8, -0.05]);
      box(quad, [3.05, 0, 0.4], [3.7, 0.65, 1.05]);
      box(quad, [2.75, 0.8, -0.72], [3.25, 1.3, -0.22]);
    }),
    mesh(stoneTex, quad => {
      box(quad, [-2.7, 0, -1.9], [-2.1, 2.0, -1.3], 1);
      box(quad, [-2.78, 2.0, -1.98], [-2.02, 2.14, -1.22], 1);
      box(quad, [-5.6, 0, -3.65], [-1.6, 1.05, -3.2], 1);
      box(quad, [1.6, 0, -3.65], [5.6, 1.05, -3.2], 1);
    }),
  ];

  // Billboard scenery drawn like the sprite: trees at the sprites' pixel density, grass tufts at
  // the ground's.
  const treeTex = [texture(treePixels(11)), texture(pinePixels(5))];
  const tuftTex = texture(tuftPixels(9));
  const scenery = [];
  for (const [x, z, kind] of [[-4.3, -5.2, 0], [3.9, -5.9, 0], [-0.9, -7.6, 1], [6.9, -2.6, 1], [-7.6, -2.2, 0], [1.9, -9.6, 1], [-5.6, -9.1, 1], [7.4, -7.5, 0]]) {
    scenery.push({ tex: treeTex[kind], pos: [x, 0, z], w: kind ? 64 : 80, h: kind ? 120 : 112, ppm: 18, casts: true, lift: 0.7 });
  }
  const rand = rng(42);
  for (let i = 0; i < 34; i++) {
    const x = (rand() * 2 - 1) * 5.5; const z = -2.9 + rand() * 6.8;
    if (Math.abs(x) < 1.45 || (x > 2.3 && x < 3.9 && z > -1 && z < 1.3) || (x < -1.9 && x > -3 && z < -1 && z > -2.2)) continue;
    scenery.push({ tex: tuftTex, pos: [x, 0, z], w: 16, h: 10, ppm: 40, casts: false, lift: 0.9 });
  }

  // ---------------------------------------------------------------- render targets

  const shadow = { tex: own('deleteTexture', gl.createTexture()), fb: own('deleteFramebuffer', gl.createFramebuffer()) };
  gl.bindTexture(gl.TEXTURE_2D, shadow.tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE], [gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadow.tex, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Colour targets: half-float when the GPU can render to it (real HDR for the bloom), else 8-bit.
  let targets = null;
  function target(w, h, withDepth = false) {
    const t = { w, h, color: gl.createTexture(), fb: gl.createFramebuffer(), depth: null };
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, floatTargets ? gl.RGBA16F : gl.RGBA8, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.color, 0);
    if (withDepth) {
      t.depth = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t.depth);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t.depth, 0);
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('could not set up the HD-2D render targets');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }
  function freeTargets() {
    if (!targets) return;
    for (const t of Object.values(targets)) {
      if (!t || !t.fb) continue;
      gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.color);
      if (t.depth) gl.deleteTexture(t.depth);
    }
    targets = null;
  }
  function makeTargets(w, h) {
    const hw = Math.max(1, w >> 1); const hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2); const qh = Math.max(1, h >> 2);
    const ew = Math.max(1, w >> 3); const eh = Math.max(1, h >> 3);
    return {
      w, h, scene: target(w, h, true), h1: target(hw, hh), h2: target(hw, hh), q1: target(qw, qh), q2: target(qw, qh),
      q3: target(qw, qh), q4: target(qw, qh), e1: target(ew, eh), e2: target(ew, eh),
    };
  }

  // ---------------------------------------------------------------- state

  const opts = { night: false, torch: true, shadows: true, normals: true, dof: true, bloom: true };
  const cam = { ...VIEW, target: [START[0], 0.9, START[2]] };
  let sprite = null;
  let spriteTex = null;
  let pos = [...START];
  let selected = { anim: '', dir: 'south' };
  let nightT = 0;
  let time = 0;
  let last = 0;
  let alive = true;
  let errorCheck = 0;
  const walk = { on: false, theta: 0, left: 6, pause: 0, rand: rng(17), dir: 'south' };
  const player = createPlayer(() => report());

  function report() {
    if (!player.clip) return;
    onInfo({ anim: player.anim, dir: player.clip.dir, frame: player.index, frames: player.clip.frames.length, walking: walk.on });
  }
  const has = name => sprite && sprite.names.includes(name);
  const walkAnim = () => (has('walk') ? 'walk' : has('run') ? 'run' : sprite.stand);
  const idleAnim = () => (has('idle') ? 'idle' : sprite.stand);

  // The view the camera has now, with its slow sway.
  function camera(aspect) {
    const yaw = cam.yaw + Math.sin((time * Math.PI * 2) / 11) * 0.014;
    const pitch = cam.pitch + Math.sin((time * Math.PI * 2) / 7.3) * 0.01;
    const dist = cam.dist * (1 + Math.sin((time * Math.PI * 2) / 13) * 0.012);
    const eye = [cam.target[0] + dist * Math.cos(pitch) * Math.sin(yaw), cam.target[1] + dist * Math.sin(pitch), cam.target[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
    const view = M.lookAt(eye, cam.target, [0, 1, 0]);
    const fwd = norm(sub(cam.target, eye));
    const right = norm([-fwd[2], 0, fwd[0]]);
    const toward = norm([-fwd[0], 0, -fwd[2]]);
    return { eye, fwd, right, toward, viewProj: M.mul(M.perspective(FOV, aspect, NEAR, FAR), view) };
  }

  // Facing from a movement on the ground, relative to the camera: away = north, right = east.
  function facing(v) {
    const fwd = [-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)];
    const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
    const a = Math.atan2(dot(v, right), dot(v, fwd));
    return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  }

  function stepWalk(s) {
    if (walk.pause > 0) {
      walk.pause -= s;
      player.set(idleAnim(), walk.dir);
      if (walk.pause <= 0) walk.left = 5 + walk.rand() * 4;
      return;
    }
    const dx = WALK.rx * Math.cos(walk.theta); const dz = -WALK.rz * Math.sin(walk.theta);
    const len = Math.hypot(dx, dz) || 1;
    walk.theta += (WALK.speed * s) / len;
    pos = [WALK.rx * Math.sin(walk.theta), 0, WALK.rz * Math.cos(walk.theta) + WALK.z];
    walk.dir = facing([dx / len, 0, dz / len]);
    player.set(walkAnim(), walk.dir, true);
    walk.left -= s;
    if (walk.left <= 0) walk.pause = 1.6 + walk.rand() * 1.6;
  }

  function update(dt) {
    const s = dt / 1000;
    time += s;
    const goal = opts.night ? 1 : 0;
    nightT += Math.sign(goal - nightT) * Math.min(Math.abs(goal - nightT), s * 1.4);
    if (!sprite) return;
    if (walk.on) stepWalk(s);
    player.tick(dt);
    const goalTarget = [pos[0], (sprite.heightPx / sprite.ppm) * 0.55, pos[2]];
    const k = Math.min(1, s * 3.5);
    for (let i = 0; i < 3; i++) cam.target[i] += (goalTarget[i] - cam.target[i]) * k;
  }

  // ---------------------------------------------------------------- drawing

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w < 16 || h < 16) return false;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (!targets || targets.w !== w || targets.h !== h) { freeTargets(); targets = makeTargets(w, h); }
    return true;
  }

  // The sprite's current frame as a billboard; right is the direction the quad spans.
  function drawSprite(prog, right) {
    const f = player.frame();
    if (!f) return;
    const iw = sprite.image.width; const ih = sprite.image.height; const e = 1e-4;
    const flip = player.clip.flip;
    set(prog, {
      uOrigin: pos, uRight: right, uSize: [f.w / sprite.ppm, f.h / sprite.ppm],
      uPivot: [(flip ? f.w - sprite.pivot.x : sprite.pivot.x) / f.w, sprite.pivot.y / f.h],
      uUvRect: [f.x / iw + e, f.y / ih + e, (f.x + f.w) / iw - e, (f.y + f.h) / ih - e], uFlip: flip ? 1 : 0,
    });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function drawScenery(prog, item, right) {
    set(prog, { uOrigin: item.pos, uRight: right, uSize: [item.w / item.ppm, item.h / item.ppm], uPivot: [0.5, 1], uUvRect: [0, 0, 1, 1], uFlip: 0 });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function screenPass(prog, dest, samplers, values = {}) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dest ? dest.fb : null);
    gl.viewport(0, 0, dest ? dest.w : canvas.width, dest ? dest.h : canvas.height);
    gl.useProgram(prog.p);
    samplers.forEach(([name, t], unit) => tex(prog, name, unit, t));
    set(prog, values);
    gl.bindVertexArray(screenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const blur = (src, dest, step, cocWeight) => screenPass(P.blur, dest, [['uSrc', src.color]], { uStep: step, uCocWeight: cocWeight });

  function render() {
    if (!resize()) return;
    const W = canvas.width; const H = canvas.height;
    const L = Object.fromEntries(Object.keys(DAY).map(k => [k, mix(DAY[k], NIGHT[k], nightT)]));
    const sunDir = norm(L.sunDir);
    const view = camera(W / H);
    const flicker = 1 + 0.08 * Math.sin(time * 13.1) + 0.05 * Math.sin(time * 7.3 + 1.7) + 0.03 * Math.sin(time * 23);
    const torch = L.torch.map(v => v * (opts.torch ? flicker : 0));
    const lightVP = M.mul(M.ortho(-10, 10, -10, 10, 1, 60), M.lookAt([sunDir[0] * 25, sunDir[1] * 25, sunDir[2] * 25 - 1], [0, 0, -1], [0, 1, 0]));
    const sunRight = norm([sunDir[2], 0, -sunDir[0]]);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // 1. The sun's shadow map: props, trees and the sprite (turned to face the sun).
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.fb);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    if (opts.shadows) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 3);
      gl.useProgram(P.depthMesh.p);
      set(P.depthMesh, { uLightVP: lightVP });
      for (const m of meshes) if (m.casts) { gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.count); }
      gl.useProgram(P.depthBoard.p);
      set(P.depthBoard, { uViewProj: lightVP, uLightVP: lightVP, uSunDir: sunDir, uRecv: 0 });
      gl.bindVertexArray(quadVao);
      for (const item of scenery) if (item.casts) { tex(P.depthBoard, 'uSheet', 0, item.tex); drawScenery(P.depthBoard, item, sunRight); }
      if (sprite) { tex(P.depthBoard, 'uSheet', 0, spriteTex.sheet); drawSprite(P.depthBoard, sunRight); }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // 2. The scene, in linear HDR.
    const T = targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(L.fog[0], L.fog[1], L.fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const lights = {
      uViewProj: view.viewProj, uLightVP: lightVP, uSunDir: sunDir, uSunColor: L.sun, uSky: L.sky, uGround: L.ground,
      uTorchPos: TORCH, uTorchColor: torch, uFogColor: L.fog, uEye: view.eye, uFogDensity: L.fogDensity, uShadowOn: opts.shadows ? 1 : 0,
    };
    gl.useProgram(P.mesh.p);
    set(P.mesh, lights);
    tex(P.mesh, 'uShadow', 3, shadow.tex);
    for (const m of meshes) { tex(P.mesh, 'uTex', 0, m.map); gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.count); }

    if (sprite) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(P.blob.p);
      const halfW = Math.max(0.25, ((sprite.cell.w * 0.45) / sprite.ppm));
      set(P.blob, { uViewProj: view.viewProj, uCenter: [pos[0], 0.01, pos[2]], uRadius: [halfW, halfW * 0.5], uStrength: L.blob });
      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    gl.useProgram(P.board.p);
    set(P.board, { ...lights, uToward: view.toward, uRecv: 0.3, uUseNormal: 0, uUseEmissive: 0, uEmissive: 0, uWrap: 0.5 });
    tex(P.board, 'uNormalSheet', 1, flatNormal);
    tex(P.board, 'uEmissiveSheet', 2, black);
    tex(P.board, 'uShadow', 3, shadow.tex);
    gl.bindVertexArray(quadVao);
    for (const item of scenery) { set(P.board, { uLift: item.lift }); tex(P.board, 'uSheet', 0, item.tex); drawScenery(P.board, item, view.right); }
    if (sprite) {
      const useNormal = opts.normals && spriteTex.normal;
      set(P.board, { uRecv: 0.45, uLift: 0.12, uWrap: 0.55, uUseNormal: useNormal ? 1 : 0, uUseEmissive: spriteTex.emissive ? 1 : 0, uEmissive: L.emissive });
      tex(P.board, 'uSheet', 0, spriteTex.sheet);
      tex(P.board, 'uNormalSheet', 1, spriteTex.normal || flatNormal);
      tex(P.board, 'uEmissiveSheet', 2, spriteTex.emissive || black);
      drawSprite(P.board, view.right);
    }
    if (opts.torch) {
      gl.useProgram(P.flame.p);
      set(P.flame, { uViewProj: view.viewProj, uLightVP: lightVP, uOrigin: [TORCH[0], 2.14, TORCH[2]], uRight: view.right, uSunDir: sunDir,
        uSize: [0.26, 0.4], uPivot: [0.5, 1], uUvRect: [0, 0, 1, 1], uFlip: 0, uRecv: 0, uTime: time, uGlow: L.flame * flicker });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 3. Depth of field and bloom at lower resolutions, then the composite to the screen.
    gl.disable(gl.DEPTH_TEST);
    const focus = sprite ? dot(sub([pos[0], (sprite.heightPx / sprite.ppm) * 0.5, pos[2]], view.eye), view.fwd) : cam.dist;
    // A sharp band around the character; the ground in front blurs sooner than the distance does,
    // which gives the miniature (tilt-shift) look.
    const coc = { uFocus: [focus, focus * 0.09, focus * 0.3, focus * 0.13], uClip: [NEAR, FAR] };
    if (opts.dof) {
      screenPass(P.prep, T.h1, [['uScene', T.scene.color], ['uDepth', T.scene.depth]], coc);
      blur(T.h1, T.h2, [1 / T.h1.w, 0], 1);
      blur(T.h2, T.h1, [0, 1 / T.h1.h], 1);
      screenPass(P.copy, T.q3, [['uSrc', T.h1.color]]);
      blur(T.q3, T.q4, [1.6 / T.q3.w, 0], 1);
      blur(T.q4, T.q3, [0, 1.6 / T.q3.h], 1);
    }
    if (opts.bloom) {
      screenPass(P.bright, T.q1, [['uScene', T.scene.color]], { uThreshold: floatTargets ? L.threshold : Math.min(L.threshold, 0.8) });
      blur(T.q1, T.q2, [1.2 / T.q1.w, 0], 0);
      blur(T.q2, T.q1, [0, 1.2 / T.q1.h], 0);
      screenPass(P.copy, T.e1, [['uSrc', T.q1.color]]);
      blur(T.e1, T.e2, [1.5 / T.e1.w, 0], 0);
      blur(T.e2, T.e1, [0, 1.5 / T.e1.h], 0);
    }
    screenPass(P.final, null, [['uScene', T.scene.color], ['uDepth', T.scene.depth], ['uDofHalf', T.h1.color], ['uDofQuarter', T.q3.color],
      ['uBloomA', T.q1.color], ['uBloomB', T.e1.color]], {
      ...coc, uDof: opts.dof ? 1 : 0, uBloom: opts.bloom ? 1 : 0, uBloomStrength: L.bloom, uExposure: L.exposure, uVignette: L.vignette, uNight: nightT,
    });
    gl.bindVertexArray(null);
  }

  function frame(t) {
    if (!alive) return;
    if (!canvas.isConnected) { dispose(); return; }
    const dt = last ? Math.min(t - last, 100) : 16;
    last = t;
    update(dt);
    try { render(); } catch (e) { onError(e.message); dispose(); return; }
    errorCheck += dt;
    if (errorCheck > 1000) {
      errorCheck = 0;
      const err = gl.getError();
      if (err !== gl.NO_ERROR) onError(`WebGL error 0x${err.toString(16)}`);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- input

  let drag = null;
  const onDown = e => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; };
  const onMove = e => {
    if (!drag) return;
    cam.yaw = clamp(cam.yaw - (e.clientX - drag.x) * 0.006, -1.1, 1.1);
    cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.004, rad(12), rad(65));
    drag = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { drag = null; };
  const onWheel = e => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 5, 26); };
  const resetView = () => { Object.assign(cam, { yaw: VIEW.yaw, pitch: VIEW.pitch, dist: VIEW.dist }); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', resetView);

  function dispose() {
    if (!alive) return;
    alive = false;
    freeTargets();
    for (const [del, o] of owned) gl[del](o);
    owned.length = 0;
    // Browsers keep only a few WebGL contexts alive; give this one back now, not at GC.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', resetView);
  }

  return {
    // A sprite from loadSprite(), or its URLs ({ json, sheet, normal, emissive }).
    async load(spriteOrUrls) {
      const next = spriteOrUrls.json ? await loadSprite(spriteOrUrls) : spriteOrUrls;
      if (!alive) return next;
      sprite = next;
      spriteTex = {
        sheet: texture(sprite.image), normal: sprite.normalMap ? texture(sprite.normalMap) : null,
        emissive: sprite.emissiveMap ? texture(sprite.emissiveMap) : null,
      };
      player.sprite = sprite;
      player.clip = null;
      selected = { anim: defaultAnim(sprite), dir: 'south' };
      pos = [...START];
      cam.target = [pos[0], (sprite.heightPx / sprite.ppm) * 0.55, pos[2]];
      player.set(selected.anim, selected.dir);
      return sprite;
    },
    setAnimation(name) { selected.anim = name; if (!walk.on) player.set(name, selected.dir); },
    setDirection(dir) { selected.dir = dir; if (!walk.on) player.set(selected.anim, dir); },
    setWalk(on) {
      walk.on = !!on;
      if (!walk.on && sprite) { player.set(selected.anim, walk.dir || selected.dir); selected.dir = player.dir; }
      else { walk.pause = 0; walk.left = 6; walk.theta = Math.atan2(pos[0] / WALK.rx, (pos[2] - WALK.z) / WALK.rz); }
      report();
    },
    setOption(key, on) { if (key in opts) opts[key] = !!on; },
    reset() {
      resetView();
      if (!walk.on) pos = [...START];
    },
    dispose,
    get state() { return { anim: player.anim, dir: player.clip ? player.clip.dir : player.dir, walking: walk.on, options: { ...opts } }; },
  };
}
