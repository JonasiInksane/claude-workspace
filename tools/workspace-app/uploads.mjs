// Image targets and uploads for the workspace app. Pure helpers plus one writer; no HTTP here.
//
// A target is where images go:
//   { kind: 'hub' }                                inbox/attachments/_hub/
//   { kind: 'agent', project, agent }              inbox/attachments/<project>/<agent>/   (agent = '_shared' allowed)
//   { kind: 'flow', flow }                         inbox/attachments/_flows/<flow>/      (no dated subfolders)
// Uploads land in a dated subfolder (YYYY-MM-DD), except for flows, and never overwrite an
// existing file.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HUB_DIR, SHARED_DIR, imagesDir, listAgents, resolveProject, sharedImagesDir } from '../lib/agents.mjs';
import { flowImagesDir, getFlow } from '../lib/flows.mjs';
import { bmpToPng } from './bmp.mjs';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// SVG is left out on purpose: it can carry scripts.
export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};
const EXT_TYPES = { ...IMAGE_TYPES, jpeg: 'image/jpeg' };

export const attachmentsRoot = root => join(root, 'inbox', 'attachments');

export function contentTypeFor(file) {
  return EXT_TYPES[extname(file).slice(1).toLowerCase()] || '';
}

// The image type from the first bytes, or '' when the data is not a supported image.
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return '';
  const b = i => buf[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  // BMP: "BM" plus a known DIB header size at offset 14 (two letters alone match too much text).
  if (head.startsWith('BM') && buf.length >= 26 && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return 'bmp';
  return '';
}

// A safe file name stem: letters, digits, dot, dash and underscore; no leading dots; max 60.
export function safeStem(name, fallback) {
  let stem = String(name || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  stem = stem.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `${stem}-image`;
  return (stem || fallback).slice(0, 60);
}

export function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// True when child is strictly inside parent (relative() gives an absolute path across drives).
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Turns { project, agent }, { flow } or { hub: true } from a request into a checked target with
// its folder. Returns { target, dir, label, flat } or { error }; `flat`: no dated subfolders.
export function resolveTarget(root, query) {
  if (query.flow) {
    const flow = getFlow(root, String(query.flow));
    if (!flow) return { error: `there is no flow "${query.flow}"` };
    return { target: { kind: 'flow', flow: flow.slug }, dir: flowImagesDir(root, flow.slug), label: `flow ${flow.title || flow.slug}`, flat: true };
  }
  if (query.hub === '1' || query.hub === true || (!query.project && !query.agent)) {
    return { target: { kind: 'hub' }, dir: join(attachmentsRoot(root), HUB_DIR), label: 'Hub' };
  }
  const { name: project, error } = resolveProject(root, query.project);
  if (error) return { error };
  const agent = String(query.agent || '');
  let dir;
  if (agent === SHARED_DIR) {
    dir = sharedImagesDir(root, project);
  } else {
    const found = listAgents(root, project).find(a => a.name === agent && a.valid);
    if (!found) return { error: `projects/${project} has no agent "${agent}"` };
    dir = imagesDir(root, project, found.name);
  }
  if (!isInside(attachmentsRoot(root), resolve(dir))) return { error: 'target is outside inbox/attachments' };
  return { target: { kind: 'agent', project, agent }, dir, label: `${project} / ${agent === SHARED_DIR ? 'shared' : agent}` };
}

// Writes the image into <dir>/<date>/<stem>.<ext> (date '' : straight into <dir>), adding
// -2, -3 ... instead of overwriting. A BMP is saved as PNG (bmp.mjs says why). Returns the
// absolute path.
export function saveImage(dir, buf, { name = '', date = localDate(), now = new Date() } = {}) {
  let type = detectImageType(buf);
  if (!type) throw Object.assign(new Error('not a PNG, JPEG, GIF, WebP or BMP image'), { status: 415 });
  if (buf.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('image is larger than 25 MB'), { status: 413 });
  if (type === 'bmp') {
    buf = bmpToPng(buf);
    type = 'png';
  }
  const p = n => String(n).padStart(2, '0');
  const stem = safeStem(name, `image-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`);
  const dayDir = date ? join(dir, date) : dir;
  mkdirSync(dayDir, { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const file = join(dayDir, `${stem}${i === 1 ? '' : `-${i}`}.${type}`);
    try {
      writeFileSync(file, buf, { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('too many files with this name');
}

// Images in a target folder (directly or one dated level down), newest first. `flat`: only
// directly in it (flows: a run passes only those).
export function listImages(root, dir, limit = 500, { flat = false } = {}) {
  const out = [];
  const add = (folder, date) => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(folder, e.name);
      if (e.isDirectory()) { if (date === null && !flat) add(full, e.name); continue; }
      if (!e.isFile() || !contentTypeFor(e.name)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      out.push({
        name: e.name,
        date: date || '',
        size: st.size,
        mtime: st.mtime.toISOString(),
        path: relative(root, full).split(sep).join('/'),
        abs: full,
      });
    }
  };
  add(dir, null);
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, limit);
}
