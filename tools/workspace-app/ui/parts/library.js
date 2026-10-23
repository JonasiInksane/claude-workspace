// The asset library on the page (asset-library.mjs and routes/library.mjs on the server): the
// calls the screens make, and the helpers they share: a version file's URL, the words for a
// kind, a pin and an attachment's state, filtering a listing, the checks of a file before it is
// sent (kind by name or type, the size limits, never SVG; the server checks the bytes again), the
// title of a pasted image, and the first lines of a text asset for its preview. A text asset is
// untrusted: it is fetched as text and only ever shown as text, never parsed.
//
// The pure helpers are exported for parts/library.test.mjs; the calls go through lib.js api(),
// except the text preview (plain fetch: the answer is text/plain, not JSON).
import { api, qs } from '../lib.js';

export const KINDS = Object.freeze(['image', 'text', 'pdf']);
export const KIND_WORDS = Object.freeze({ image: 'Image', text: 'Text', pdf: 'PDF' });
const KIND_PLURAL = { image: 'Images', text: 'Text', pdf: 'PDFs' };
const MB = 1024 * 1024;
// The library's limits (asset-library.mjs LIMITS): images and PDFs 25 MB, text 2 MB.
export const SIZE_LIMITS = Object.freeze({ image: 25 * MB, text: 2 * MB, pdf: 25 * MB });
export const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 600;

export const kindWord = kind => KIND_WORDS[kind] || 'Unknown kind';
export const kindPlural = kind => KIND_PLURAL[kind] || kindWord(kind);

// One version's file (app.mjs /library-file): shown in the page, or saved (`download`).
export const fileUrl = (ref, n, { download = false } = {}) => `/library-file?${qs({ ref, v: n, download: download ? '1' : undefined })}`;

// "shared" or the project of a ref ("example:logo" -> "example").
export const refPlace = ref => {
  const s = String(ref || '');
  const at = s.indexOf(':');
  return at > 0 ? s.slice(0, at) : '';
};
export const isSharedRef = ref => refPlace(ref).toLowerCase() === 'shared';

// "Latest (v3)" or "v2" for an attachment's pin; `latest` is the newest version number when known.
export function pinWords(pin, latest = null) {
  if (Number.isSafeInteger(pin) && pin >= 1) return `v${pin}`;
  return Number.isSafeInteger(latest) ? `Latest (v${latest})` : 'Latest';
}

// The state of one resolved attachment (POST /api/library/resolve item) as badges:
// [{ text, cls, title }]. Missing and an unreadable record are red, archived is amber.
export function attachmentBadges(item) {
  if (!item) return [];
  const out = [];
  if (item.error) out.push({ text: 'Unreadable', cls: 'red', title: String(item.error) });
  else if (item.missing && item.kind === null) out.push({ text: 'Missing', cls: 'red', title: 'There is no such asset any more.' });
  else if (item.missing) out.push({ text: `v${item.version ?? '?'} missing`, cls: 'red', title: 'That version, or its file, is not there.' });
  if (item.archived) out.push({ text: 'Archived', cls: 'amber', title: 'Archived: hidden from the lists, still attached.' });
  return out;
}

// The version numbers of an asset, newest first, from a listing entry (versions are numbered from
// 1 and strictly rising, so a count equal to the latest number means 1..n), or from a full asset
// (GET /api/library/asset). null when a listing entry has gaps (then ask for the asset).
export function versionNumbers(a) {
  if (!a) return null;
  if (Array.isArray(a.versions)) return a.versions.map(v => v.n).filter(Number.isSafeInteger).sort((x, y) => y - x);
  const n = a.latest && a.latest.n;
  if (!Number.isSafeInteger(n) || a.versionCount !== n) return null;
  return Array.from({ length: n }, (_, i) => n - i);
}

// The places of a listing to filter by: { value, label } for every place ('shared' first, then
// 'project:<name>' for each project), from the projects in the state plus any the listing names.
export function placeChoices(list, projects = []) {
  const names = new Set((Array.isArray(projects) ? projects : []).map(p => (p && p.name) || p).filter(n => typeof n === 'string' && n));
  for (const a of Array.isArray(list) ? list : []) if (a && a.scope === 'project' && a.project) names.add(a.project);
  return [{ value: 'shared', label: 'Shared' }, ...[...names].sort((x, y) => x.localeCompare(y)).map(n => ({ value: `project:${n}`, label: n }))];
}

// Every tag in a listing, sorted.
export const tagsOf = list => [...new Set((Array.isArray(list) ? list : []).flatMap(a => (a && Array.isArray(a.tags) ? a.tags : [])))].sort();

// A listing narrowed by the filters: place ('' every place, 'shared', 'project:<name>'), kind,
// tag, a search in the title, ref, description and tags (case-insensitive), and archived (false:
// archived assets are left out).
export function filterAssets(list, { place = '', kind = '', tag = '', q = '', archived = false } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (Array.isArray(list) ? list : []).filter(a => {
    if (!a) return false;
    if (!archived && a.archived) return false;
    if (place === 'shared' && a.scope !== 'shared') return false;
    if (place.startsWith('project:') && !(a.scope === 'project' && a.project === place.slice(8))) return false;
    if (kind && a.kind !== kind) return false;
    if (tag && !(a.tags || []).includes(tag)) return false;
    if (!words.length) return true;
    const hay = [a.title, a.ref, a.description, ...(a.tags || [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// ---------------------------------------------------------------- files before they are sent

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  md: 'text', markdown: 'text', txt: 'text', json: 'text', pdf: 'pdf',
};
const KIND_A = { image: 'an image', text: 'a text file', pdf: 'a PDF' };
const LIMIT_WORDS = { image: 'images', text: 'text files', pdf: 'PDFs' };
const extOf = name => ((/\.([A-Za-z0-9]+)$/.exec(String(name || '')) || [])[1] || '').toLowerCase();

// The kind a file claims by its name, else by its type: 'image', 'text', 'pdf', 'svg' or ''.
export function fileKind(file) {
  const ext = extOf(file && file.name);
  const type = String((file && file.type) || '').toLowerCase();
  if (ext === 'svg' || ext === 'svgz' || type === 'image/svg+xml') return 'svg';
  if (ext) return EXT_KIND[ext] || '';
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/plain' || type === 'text/markdown' || type === 'application/json') return 'text';
  return '';
}

// Why a file can't go into the library, or '' (the server decides by the bytes in the end).
// `kind` is the asset's kind for a new version.
export function fileProblem(file, kind = '') {
  if (!file) return 'No file.';
  const name = String(file.name || 'The file');
  const k = fileKind(file);
  if (!file.size) return `${name} is empty.`;
  if (k === 'svg') return `${name}: SVG is not accepted (it can carry scripts). Save it as PNG.`;
  if (!k) return `${name}: the library takes images (PNG, JPEG, GIF, WebP, BMP), .md, .txt and .json text, and PDF.`;
  if (kind && KIND_A[kind] && k !== kind) return `${name} is ${KIND_A[k]}; this asset is ${KIND_A[kind]}.`;
  if (file.size > SIZE_LIMITS[k]) return `${name} is larger than ${SIZE_LIMITS[k] / MB} MB, the limit for ${LIMIT_WORDS[k]}.`;
  return '';
}

// The title of a pasted image (it has no name of its own): "Pasted image 2026-10-23 10:42".
export function pastedTitle(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `Pasted image ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

// The title a file gives: its name without the extension.
export const titleFromName = name => String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').trim();

// ---------------------------------------------------------------- calls

export function listLibrary({ project = '', archived = true } = {}) {
  const q = qs({ project: project || undefined, archived: archived ? '1' : undefined });
  return api(`/api/library${q ? `?${q}` : ''}`);
}

export const getAsset = ref => api(`/api/library/asset?${qs({ ref })}`);

// A new asset from one file: { scope, project, title, description, tags, note }. A pasted file
// has no useful name, so only its title goes along.
export function uploadNew(file, { scope = 'shared', project = '', title = '', description = '', tags = '', note = '', pasted = false } = {}) {
  const q = {
    scope, project: scope === 'project' ? project : undefined, title: title || undefined, description: description || undefined,
    tags: tags || undefined, note: note || undefined, name: pasted ? undefined : file.name || undefined,
  };
  return api(`/api/library/upload?${qs(q)}`, { method: 'POST', raw: file, contentType: file.type || 'application/octet-stream' });
}

// A new version of an asset; `expect` is the number of versions the page saw.
export function uploadVersion(ref, file, { expect, note = '', pasted = false } = {}) {
  const q = { ref, expect: String(expect), note: note || undefined, name: pasted ? undefined : file.name || undefined };
  return api(`/api/library/upload?${qs(q)}`, { method: 'POST', raw: file, contentType: file.type || 'application/octet-stream' });
}

// The details, and archive or restore: `expect` is the asset's `revision` the page saw, so a page
// opened before another change gets a 409 instead of undoing it.
export const saveMeta = (ref, { title, description, tags }, expect) =>
  api('/api/library/meta', { method: 'POST', body: { ref, title, description, tags, expect } });

export const setArchived = (ref, archived, expect) => api('/api/library/archive', { method: 'POST', body: { ref, archived, expect } });

export const resolveAttachments = (project, attachments) =>
  api('/api/library/resolve', { method: 'POST', body: { project, attachments } });

// ---------------------------------------------------------------- the text preview

// The start of each text version read so far: "<ref>@<n>" -> Promise of its first 64 KB (a
// version never changes, so it is read once).
const texts = new Map();
const TEXT_KEEP = 64 * 1024;

// The first lines of one version of a text asset: { lines: [text], more }, at most `chars`
// characters in all. Rejects when the file can't be read.
export function textPreview(ref, n, { lines = PREVIEW_LINES, chars = PREVIEW_CHARS } = {}) {
  const key = `${ref}@${n}`;
  if (!texts.has(key)) {
    const p = fetch(fileUrl(ref, n), { credentials: 'same-origin' }).then(async res => {
      if (!res.ok) throw new Error(`The preview could not be read (${res.status}).`);
      return (await res.text()).slice(0, TEXT_KEEP);
    });
    p.catch(() => texts.delete(key)); // a failure may be tried again
    texts.set(key, p);
  }
  return texts.get(key).then(text => firstLines(text, lines, chars));
}

// The first `count` lines of a text, at most `chars` characters in all: { lines, more }, where
// `more` says the text goes on (blank lines at the end don't count).
export function firstLines(text, count = PREVIEW_LINES, chars = PREVIEW_CHARS) {
  const all = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let used = 0;
  let i = 0;
  let cut = false;
  for (; i < Math.min(count, all.length) && used < chars; i++) {
    const part = all[i].slice(0, chars - used);
    if (part.length < all[i].length) cut = true;
    out.push(part);
    used += part.length;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { lines: out, more: cut || all.slice(i).some(l => l.trim() !== '') };
}
