// A small GLB viewer for the Assets view: WebGL2, no libraries. It draws glTF 2.0 binary files
// (meshes with POSITION, NORMAL, TEXCOORD_0 and indices; base colour, metallic-roughness and
// normal textures) under a fixed studio light with a soft fake sky, so metal reads as metal.
// Drag to turn, scroll to zoom, Shift+drag or right-drag to pan, double-click to reset.
// Not supported (it says so): Draco or meshopt compression, morph targets, skins.

const GL_FLOAT = 5126;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

// ---------------------------------------------------------------- small matrix maths (column-major)

const mat4 = {
  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  fromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
    const [x, y, z, w] = q;
    return new Float32Array([
      (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
      (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
      (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ]);
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, target, up) {
    let z = norm(sub(eye, target));
    let x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  },
  // The inverse transpose of the upper 3x3, for normals (as a mat3).
  normalMatrix(m) {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1;
    return new Float32Array([
      A / det, B / det, C / det,
      -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
      (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
    ]);
  },
  transformPoint(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  },
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------------------------------------------------------- GLB parsing

function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is supported');
  let json = null;
  let bin = null;
  for (let at = 12; at + 8 <= dv.byteLength;) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, at + 8, len)));
    else if (type === 0x004e4942) bin = buf.slice(at + 8, at + 8 + len);
    at += 8 + len;
  }
  if (!json) throw new Error('the GLB has no JSON chunk');
  const unsupported = (json.extensionsRequired || []).filter(e => !['KHR_materials_emissive_strength', 'KHR_texture_transform'].includes(e));
  if (unsupported.length) throw new Error(`this model needs ${unsupported.join(', ')}, which the viewer can't read`);
  return { json, bin };
}

// An accessor as a tightly packed typed array (strided data copied out).
function readAccessor(gltf, index) {
  const { json, bin } = gltf;
  const acc = json.accessors[index];
  const n = COMPONENTS[acc.type];
  const Arr = ARRAYS[acc.componentType];
  if (!n || !Arr) throw new Error(`unsupported accessor ${acc.type}/${acc.componentType}`);
  const out = new Arr(acc.count * n);
  if (acc.bufferView === undefined) return out; // all zeros
  const bv = json.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const size = Arr.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || n * size;
  const dv = new DataView(bin);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
  if (stride === n * size && (offset % size) === 0) return new Arr(bin, offset, acc.count * n).slice();
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[get](offset + i * stride + k * size, true);
  return out;
}

function normalized(gltf, index) {
  const acc = gltf.json.accessors[index];
  const data = readAccessor(gltf, index);
  if (acc.componentType === GL_FLOAT || !acc.normalized) return Float32Array.from(data);
  const max = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType];
  return Float32Array.from(data, v => Math.max(v / max, -1));
}

// Each mesh primitive with its node's world matrix.
function drawList(json) {
  const out = [];
  const visit = (i, parent) => {
    const node = json.nodes[i];
    const local = node.matrix ? new Float32Array(node.matrix) : mat4.fromTRS(node.translation, node.rotation, node.scale);
    const world = mat4.multiply(parent, local);
    if (node.mesh !== undefined) for (const prim of json.meshes[node.mesh].primitives) out.push({ prim, world });
    for (const c of node.children || []) visit(c, world);
  };
  const scene = json.scenes ? json.scenes[json.scene || 0] : { nodes: (json.nodes || []).map((_, i) => i) };
  for (const i of scene.nodes || []) visit(i, mat4.identity());
  return out;
}

async function decodeImages(gltf) {
  const { json, bin } = gltf;
  return Promise.all((json.images || []).map(async img => {
    if (img.bufferView === undefined) return null; // external files are not loaded
    const bv = json.bufferViews[img.bufferView];
    const blob = new Blob([new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength)], { type: img.mimeType || 'image/png' });
    try { return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch { return null; }
  }));
}

// ---------------------------------------------------------------- shaders

const VERT = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aUv;
uniform mat4 uModel, uView, uProj; uniform mat3 uNormalMat;
out vec3 vPos; out vec3 vNormal; out vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vPos = w.xyz; vNormal = normalize(uNormalMat * aNormal); vUv = aUv;
  gl_Position = uProj * uView * w;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal; in vec2 vUv;
uniform vec3 uEye; uniform vec4 uBase; uniform float uMetal, uRough; uniform vec3 uEmissive;
uniform sampler2D uBaseTex, uMrTex, uNormalTex; uniform bool uHasBase, uHasMr, uHasNormal, uWire;
out vec4 color;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
// A soft studio: dark floor, light sky, and two big soft boxes that metal can reflect.
vec3 env(vec3 d, float rough) {
  vec3 floorC = vec3(0.10, 0.10, 0.11), sky = vec3(0.55, 0.57, 0.62);
  vec3 c = mix(floorC, sky, smoothstep(-0.25, 0.35, d.y));
  float spread = mix(28.0, 3.0, rough);
  c += vec3(2.6) * pow(max(dot(d, normalize(vec3(0.6, 0.7, 0.5))), 0.0), spread);
  c += vec3(1.2, 1.25, 1.35) * pow(max(dot(d, normalize(vec3(-0.7, 0.35, 0.4))), 0.0), spread);
  c += vec3(0.8) * pow(max(dot(d, normalize(vec3(0.0, 0.3, -0.9))), 0.0), spread);
  return mix(c, vec3(0.42), rough * rough * 0.6);
}
// Normal mapping without tangents: a frame from the screen-space derivatives.
vec3 perturb(vec3 n, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p); vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
  vec3 t = dp2perp * du1.x + dp1perp * du2.x, b = dp2perp * du1.y + dp1perp * du2.y;
  float inv = inversesqrt(max(dot(t, t), dot(b, b)));
  vec3 m = texture(uNormalTex, uv).xyz * 2.0 - 1.0;
  return normalize(mat3(t * inv, b * inv, n) * m);
}
void main() {
  if (uWire) { color = vec4(0.95, 0.55, 0.30, 1.0); return; }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  if (uHasNormal) n = perturb(n, vPos, vUv);
  vec4 base = uBase;
  if (uHasBase) { vec4 t = texture(uBaseTex, vUv); base *= vec4(toLinear(t.rgb), t.a); }
  float metal = uMetal, rough = uRough;
  if (uHasMr) { vec4 mr = texture(uMrTex, vUv); rough *= mr.g; metal *= mr.b; }
  rough = clamp(rough, 0.04, 1.0);
  vec3 v = normalize(uEye - vPos);
  vec3 f0 = mix(vec3(0.04), base.rgb, metal);
  float nv = max(dot(n, v), 0.0);
  vec3 fres = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0) * (1.0 - rough);
  vec3 diffuse = base.rgb * (1.0 - metal);
  vec3 c = diffuse * mix(vec3(0.16, 0.16, 0.17), vec3(0.48, 0.49, 0.52), n.y * 0.5 + 0.5);
  float shin = 2.0 / max(rough * rough * rough * rough, 0.0005) - 2.0;
  vec3 lights[2] = vec3[2](normalize(vec3(0.6, 0.8, 0.6)), normalize(vec3(-0.7, 0.3, -0.5)));
  vec3 power[2] = vec3[2](vec3(1.9, 1.85, 1.75), vec3(0.55, 0.6, 0.7));
  for (int i = 0; i < 2; i++) {
    float nl = max(dot(n, lights[i]), 0.0);
    vec3 hv = normalize(lights[i] + v);
    float spec = pow(max(dot(n, hv), 0.0), shin) * (shin + 8.0) / 25.0;
    c += power[i] * nl * (diffuse / 3.14159 * 2.4 + fres * spec * 0.25);
  }
  c += env(reflect(-v, n), rough) * fres;
  c += uEmissive;
  c = c / (c + vec3(0.8)) * 1.35;            // soft tone map
  color = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

// ---------------------------------------------------------------- the viewer

export function createViewer(canvas, { onInfo = () => {} } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) throw new Error('this window has no WebGL2, so the 3D view is off');
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`shader: ${gl.getProgramInfoLog(prog)}`);
  const loc = name => gl.getUniformLocation(prog, name);
  const U = Object.fromEntries(['uModel', 'uView', 'uProj', 'uNormalMat', 'uEye', 'uBase', 'uMetal', 'uRough', 'uEmissive',
    'uBaseTex', 'uMrTex', 'uNormalTex', 'uHasBase', 'uHasMr', 'uHasNormal', 'uWire'].map(n => [n, loc(n)]));
  const A = { aPos: gl.getAttribLocation(prog, 'aPos'), aNormal: gl.getAttribLocation(prog, 'aNormal'), aUv: gl.getAttribLocation(prog, 'aUv') };

  let parts = [];         // { vao, count, indexType, wire: { vao, count }, world, normalMat, mat }
  let resources = [];     // buffers, textures, VAOs to free
  let center = [0, 0, 0];
  let radius = 1;
  const cam = { yaw: 0.6, pitch: 0.15, dist: 3, target: [0, 0, 0] };
  let autoRotate = true;
  let wire = false;
  let alive = true;
  let dirty = true;
  let lastTime = 0;

  const track = r => { resources.push(r); return r; };
  function freeAll() {
    for (const r of resources) {
      if (r instanceof WebGLBuffer) gl.deleteBuffer(r);
      else if (r instanceof WebGLTexture) gl.deleteTexture(r);
      else if (r instanceof WebGLVertexArrayObject) gl.deleteVertexArray(r);
    }
    resources = [];
    parts = [];
  }

  function texture(bitmap, sampler) {
    const t = track(gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    const wrap = { 33071: gl.CLAMP_TO_EDGE, 33648: gl.MIRRORED_REPEAT, 10497: gl.REPEAT };
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap[sampler?.wrapS] || gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap[sampler?.wrapT] || gl.REPEAT);
    return t;
  }

  function attribute(data, size, at) {
    gl.bindBuffer(gl.ARRAY_BUFFER, track(gl.createBuffer()));
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0);
  }

  // Unique edges of the triangles, for the wireframe.
  function edgeIndices(idx) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i + 2 < idx.length; i += 3) {
      for (const [a, b] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
        const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        if (!seen.has(k)) { seen.add(k); out.push(a, b); }
      }
    }
    return Uint32Array.from(out);
  }

  async function load(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`could not load the model (${res.status})`);
    const gltf = parseGlb(await res.arrayBuffer());
    const { json } = gltf;
    const bitmaps = await decodeImages(gltf);
    if (!alive) return;
    freeAll();
    const texCache = new Map();
    const tex = info => {
      if (!info || json.textures?.[info.index] === undefined) return null;
      const t = json.textures[info.index];
      const bmp = bitmaps[t.source];
      if (!bmp) return null;
      if (!texCache.has(info.index)) texCache.set(info.index, texture(bmp, json.samplers?.[t.sampler]));
      return texCache.get(info.index);
    };
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    let triangles = 0;
    for (const { prim, world } of drawList(json)) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
      let pos = normalized(gltf, prim.attributes.POSITION);
      let nrm = prim.attributes.NORMAL !== undefined ? normalized(gltf, prim.attributes.NORMAL) : null;
      let uv = prim.attributes.TEXCOORD_0 !== undefined ? normalized(gltf, prim.attributes.TEXCOORD_0) : null;
      let idx = prim.indices !== undefined ? Uint32Array.from(readAccessor(gltf, prim.indices)) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      if (!nrm) {
        // Flat normals: one vertex per triangle corner.
        const p2 = new Float32Array(idx.length * 3), n2 = new Float32Array(idx.length * 3), u2 = uv ? new Float32Array(idx.length * 2) : null;
        for (let i = 0; i < idx.length; i += 3) {
          const v = [0, 1, 2].map(k => [pos[idx[i + k] * 3], pos[idx[i + k] * 3 + 1], pos[idx[i + k] * 3 + 2]]);
          const fn = norm(cross(sub(v[1], v[0]), sub(v[2], v[0])));
          for (let k = 0; k < 3; k++) {
            p2.set(v[k], (i + k) * 3); n2.set(fn, (i + k) * 3);
            if (u2) u2.set([uv[idx[i + k] * 2], uv[idx[i + k] * 2 + 1]], (i + k) * 2);
          }
        }
        pos = p2; nrm = n2; uv = u2; idx = Uint32Array.from({ length: idx.length }, (_, i) => i);
      }
      for (let i = 0; i < pos.length; i += 3) {
        const p = mat4.transformPoint(world, [pos[i], pos[i + 1], pos[i + 2]]);
        lo = lo.map((v, k) => Math.min(v, p[k]));
        hi = hi.map((v, k) => Math.max(v, p[k]));
      }
      triangles += idx.length / 3;
      const vao = track(gl.createVertexArray());
      gl.bindVertexArray(vao);
      attribute(pos, 3, A.aPos);
      attribute(nrm, 3, A.aNormal);
      if (uv && A.aUv >= 0) attribute(uv, 2, A.aUv);
      else if (A.aUv >= 0) { gl.disableVertexAttribArray(A.aUv); gl.vertexAttrib2f(A.aUv, 0, 0); }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, track(gl.createBuffer()));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      const edges = edgeIndices(idx);
      const wvao = track(gl.createVertexArray());
      gl.bindVertexArray(wvao);
      attribute(pos, 3, A.aPos);
      attribute(nrm, 3, A.aNormal);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, track(gl.createBuffer()));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const m = json.materials?.[prim.material] || {};
      const pbr = m.pbrMetallicRoughness || {};
      const emissiveStrength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
      parts.push({
        vao, count: idx.length, wire: { vao: wvao, count: edges.length }, world, normalMat: mat4.normalMatrix(world),
        mat: {
          base: pbr.baseColorFactor || [1, 1, 1, 1], metal: pbr.metallicFactor ?? 1, rough: pbr.roughnessFactor ?? 1,
          emissive: (m.emissiveFactor || [0, 0, 0]).map(v => v * emissiveStrength),
          baseTex: tex(pbr.baseColorTexture), mrTex: tex(pbr.metallicRoughnessTexture), normalTex: uv ? tex(m.normalTexture) : null,
          doubleSided: !!m.doubleSided,
        },
      });
    }
    if (!parts.length) throw new Error('the model has no triangles to show');
    center = scale(add(lo, hi), 0.5);
    radius = Math.max(Math.hypot(...sub(hi, lo)) / 2, 1e-6);
    reset();
    onInfo({ triangles, size: sub(hi, lo) });
  }

  function reset() {
    cam.yaw = 0.6; cam.pitch = 0.15; cam.target = [...center];
    cam.dist = radius / Math.sin((40 * Math.PI) / 360) * 1.15;
    dirty = true;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
  }

  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!parts.length) return;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    const eye = add(cam.target, [cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.dist * Math.sin(cam.pitch), cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)]);
    const view = mat4.lookAt(eye, cam.target, [0, 1, 0]);
    const proj = mat4.perspective((40 * Math.PI) / 180, canvas.width / canvas.height, Math.max(cam.dist - radius * 2, cam.dist * 0.01), cam.dist + radius * 4);
    gl.uniformMatrix4fv(U.uView, false, view);
    gl.uniformMatrix4fv(U.uProj, false, proj);
    gl.uniform3fv(U.uEye, eye);
    gl.uniform1i(U.uBaseTex, 0); gl.uniform1i(U.uMrTex, 1); gl.uniform1i(U.uNormalTex, 2);
    for (const p of parts) {
      const m = p.mat;
      gl.uniformMatrix4fv(U.uModel, false, p.world);
      gl.uniformMatrix3fv(U.uNormalMat, false, p.normalMat);
      gl.uniform4fv(U.uBase, m.base);
      gl.uniform1f(U.uMetal, m.metal);
      gl.uniform1f(U.uRough, m.rough);
      gl.uniform3fv(U.uEmissive, m.emissive);
      [[m.baseTex, U.uHasBase], [m.mrTex, U.uHasMr], [m.normalTex, U.uHasNormal]].forEach(([t, has], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(has, t ? 1 : 0);
      });
      gl.uniform1i(U.uWire, 0);
      if (m.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(p.vao);
      if (wire) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (wire) {
        gl.uniform1i(U.uWire, 1);
        gl.bindVertexArray(p.wire.vao);
        gl.drawElements(gl.LINES, p.wire.count, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  function frame(t) {
    if (!alive) return;
    if (!canvas.isConnected) { dispose(); return; }
    const dt = lastTime ? Math.min(t - lastTime, 100) : 16;
    lastTime = t;
    if (autoRotate && !drag) { cam.yaw += dt * 0.0004; dirty = true; }
    if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(frame);
  }

  // Input: drag turns, Shift or right drag pans, the wheel zooms, a double-click resets.
  let drag = null;
  const onDown = e => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
  };
  const onMove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const s = cam.dist * 0.0015;
      const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      const up = [-Math.sin(cam.pitch) * Math.sin(cam.yaw), Math.cos(cam.pitch), -Math.sin(cam.pitch) * Math.cos(cam.yaw)];
      cam.target = add(cam.target, add(scale(right, -dx * s), scale(up, dy * s)));
    } else {
      cam.yaw -= dx * 0.008;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.008));
    }
    dirty = true;
  };
  const onUp = () => { drag = null; };
  const onWheel = e => {
    e.preventDefault();
    cam.dist = Math.max(radius * 0.3, Math.min(radius * 20, cam.dist * Math.exp(e.deltaY * 0.0012)));
    dirty = true;
  };
  const onMenu = e => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', reset);
  canvas.addEventListener('contextmenu', onMenu);
  requestAnimationFrame(frame);

  function dispose() {
    if (!alive) return;
    alive = false;
    freeAll();
    gl.deleteProgram(prog);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', reset);
    canvas.removeEventListener('contextmenu', onMenu);
  }

  return {
    load,
    reset,
    dispose,
    setAutoRotate(on) { autoRotate = !!on; dirty = true; },
    setWire(on) { wire = !!on; dirty = true; },
  };
}
