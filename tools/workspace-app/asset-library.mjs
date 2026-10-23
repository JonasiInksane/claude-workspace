// The asset library: shared assets that any project can attach, and assets that belong to one
// project. An asset is a list of immutable versions, each with its SHA-256, so a run or a flow
// launch can record exactly which content it used. routes/library.mjs is the HTTP side, and
// app.mjs serves the version files at /library-file (sandboxed). The game assets of an asset
// pipeline are a different thing (assets.mjs).
//
//   inbox/attachments/_assets/<id>/              a shared asset
//   inbox/attachments/<project>/_assets/<id>/    an asset of projects/<project> (which must exist)
//     asset.json                                 the record (format 1, below)
//     v1.md, v2.md, ...                          the versions; a file is never overwritten
//
// Both are in the private inbox (gitignored), and tools/lib/inbox.mjs keeps them out of triage.
// A ref names an asset everywhere: shared:<id> or <project>:<id> (the project folder's own
// spelling). The id is kebab-case from the title, at most 60 characters, with -2, -3 when it is
// taken, and it never changes, not even with the title. A project folder named "shared" can't
// have assets of its own: "shared:" always means the shared library.
//
// asset.json, format 1:
//   { format: 1, id, scope: "shared" | "project", project: null | "<name>", title, kind,
//     description, tags, createdAt, archived,
//     versions: [{ n, file: "v<n>.<ext>", sha256, bytes, type, addedAt, note, originalName }] }
//
// The content decides the kind; a file name extension or a declared kind that disagrees is
// refused:
//   image  PNG, JPEG, GIF or WebP by its first bytes (detectImageType in uploads.mjs), at most
//          25 MB; a BMP is stored as PNG (bmp.mjs, as uploads do); never SVG (it can carry scripts)
//   text   .md, .txt or .json: valid UTF-8 without NUL bytes, at most 2 MB; JSON must parse; an
//          SVG document is refused here too, whatever its prolog (isSvgDocument)
//   pdf    starts with %PDF-, at most 25 MB
//
// Writes: a version file is created exclusively (flag 'wx'), and asset.json goes to a temporary
// file that is then renamed over the old one (core/datadir.mjs). Changes to one asset run one at
// a time (an in-process queue; one app serves a workspace), and every update says how many
// versions its caller saw (expect): another count is a 409, so a stale page can't undo a newer
// change. A new version with the same SHA-256 as the latest adds nothing and returns the latest.
//
// Every export that touches the disk is async. Refusals are HttpErrors that the routes pass on:
// 400 bad input, 404 not found, 409 changed meanwhile (or archived), 413 too large, 415 content
// not accepted, 500 an asset.json that can't be used.
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { resolveProject } from '../lib/agents.mjs';
import { ASSET_LIBRARY_DIR, projectNameMap } from '../lib/inbox.mjs';
import { bmpToPng } from './bmp.mjs';
import { readJson, sha256Text, writeJsonAtomic } from './core/datadir.mjs';
import { HttpError } from './http.mjs';
import { attachmentsRoot, detectImageType, isInside } from './uploads.mjs';

export const ASSET_FORMAT = 1;
export const KINDS = ['image', 'text', 'pdf'];
const MB = 1024 * 1024;
export const LIMITS = {
  imageBytes: 25 * MB, pdfBytes: 25 * MB, textBytes: 2 * MB,
  id: 60, title: 120, description: 2000, note: 500, originalName: 200, tags: 20, tag: 40, attachments: 100,
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Windows device names can't be folder names; an id like that gets "-asset".
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
// What a stored version file may be called, and the kind and type its extension stands for.
const VERSION_FILE = /^v([1-9]\d{0,8})\.(png|jpg|gif|webp|md|txt|json|pdf)$/;
// The highest number VERSION_FILE takes. A version is never written past it, or the record that
// lists it could no longer be read.
const MAX_VERSION = 999_999_999;
const STORED = {
  png: { kind: 'image', type: 'image/png' }, jpg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' }, webp: { kind: 'image', type: 'image/webp' },
  md: { kind: 'text', type: 'text/markdown' }, txt: { kind: 'text', type: 'text/plain' },
  json: { kind: 'text', type: 'application/json' }, pdf: { kind: 'pdf', type: 'application/pdf' },
};
// The kind an upload's file name extension claims.
const NAMED_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  md: 'text', txt: 'text', json: 'text', pdf: 'pdf',
};
const KIND_WORDS = { image: 'an image', text: 'a text file', pdf: 'a PDF' };
// What may come before an XML document's first element: white space, then an XML declaration or
// another processing instruction, a comment, or a doctype (with or without an internal subset).
// Sticky, so isSvgDocument can step through them; no part can match in more than one way.
const PROLOG_PART = /\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype(?:[^>[]|\[[^\]]*\])*>)/iy;
// An SVG root element, plain or with a namespace prefix (<svg:svg>).
const SVG_ROOT = /\s*<(?:[\w.-]+:)?svg[\s/>]/iy;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const bad = message => new HttpError(400, message);
const tooLarge = message => new HttpError(413, message);
const unsupported = message => new HttpError(415, message);
const clip = (v, n = 80) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}...` : s; };
const isId = id => typeof id === 'string' && id.length <= LIMITS.id && ID_RE.test(id);
const recordFile = dir => join(dir, 'asset.json');
const isRegularFile = p => lstat(p).then(s => s.isFile(), () => false);
const posixRel = (root, p) => relative(root, p).split(sep).join('/');

export const sharedAssetsDir = root => join(attachmentsRoot(root), ASSET_LIBRARY_DIR);
export const projectAssetsDir = (root, project) => join(attachmentsRoot(root), project, ASSET_LIBRARY_DIR);
export const assetRef = (scope, project, id) => (scope === 'shared' ? `shared:${id}` : `${project}:${id}`);

// ---------------------------------------------------------------- names and refs

// The real spelling of an existing project folder, or a 404. A name with a path in it never
// resolves: resolveProject refuses / \ : and a leading . or _.
function existingProject(root, name) {
  const { name: real, error } = resolveProject(root, String(name ?? ''));
  if (error) throw new HttpError(404, error);
  return real;
}

// Where a ref points: { ref, scope, project, id, dir }, with the ref spelled the way listings
// spell it ("SHARED:x" is shared:x, "Example:x" is example:x for projects/example). A malformed
// ref is a 400, a project that doesn't exist a 404. Nothing is read.
export function parseRef(root, ref) {
  const text = typeof ref === 'string' ? ref : '';
  const at = text.indexOf(':');
  const id = text.slice(at + 1);
  if (at < 1 || text.length > 200 || !isId(id)) throw bad(`"${clip(ref)}" is not an asset ref: use shared:<id> or <project>:<id>`);
  const left = text.slice(0, at);
  const scope = left.toLowerCase() === 'shared' ? 'shared' : 'project';
  const project = scope === 'shared' ? null : existingProject(root, left);
  const dir = join(scope === 'shared' ? sharedAssetsDir(root) : projectAssetsDir(root, project), id);
  if (!isInside(attachmentsRoot(root), dir)) throw bad(`"${clip(ref)}" is not an asset ref`);
  return { ref: assetRef(scope, project, id), scope, project, id, dir };
}

// The id a title gives: kebab-case without accents, at most 60 characters, never a Windows
// device name, "asset" when nothing is left.
export function assetIdFor(title) {
  let id = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.id).replace(/-+$/, '');
  if (!id) id = 'asset';
  return DEVICE_NAME.test(id) ? `${id}-asset` : id;
}

// The n-th candidate for an id: the id itself, then id-2, id-3 ..., cut to fit 60 characters.
function candidateId(id, n) {
  if (n === 1) return id;
  const suffix = `-${n}`;
  return `${id.slice(0, LIMITS.id - suffix.length).replace(/-+$/, '')}${suffix}`;
}

// Claims the folder of a new asset in `base` by creating it (mkdir fails when it exists, so
// two uploads with the same title never share a folder). Returns the id.
async function claimFolder(base, title) {
  await mkdir(base, { recursive: true });
  const stem = assetIdFor(title);
  for (let n = 1; n < 1000; n++) {
    const id = candidateId(stem, n);
    try {
      await mkdir(join(base, id));
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new HttpError(409, `there are too many assets named like "${clip(title)}"`);
}

// Where a new asset goes: { scope, project, base }. Without a scope, a project means a project
// asset; a shared asset ignores the project.
function placeFor(root, scope, project) {
  const s = scope === undefined || scope === null || scope === '' ? (project ? 'project' : 'shared') : String(scope);
  if (s === 'shared') return { scope: 'shared', project: null, base: sharedAssetsDir(root) };
  if (s !== 'project') throw bad('scope must be shared or project');
  if (!project) throw bad('a project asset needs a project');
  const name = existingProject(root, project);
  if (name.toLowerCase() === 'shared') {
    throw bad(`projects/${name} can't have assets of its own: "shared:" refs always name the shared library`);
  }
  return { scope: 'project', project: name, base: projectAssetsDir(root, name) };
}

// ---------------------------------------------------------------- field values

// One line of text: control characters and runs of white space become one space.
const oneLine = v => String(v ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

function cleanTitle(v) {
  const title = oneLine(v);
  if (!title) throw bad('a title is required');
  if (title.length > LIMITS.title) throw bad(`the title is longer than ${LIMITS.title} characters`);
  return title;
}

function cleanDescription(v) {
  const text = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length > LIMITS.description) throw bad(`the description is longer than ${LIMITS.description} characters`);
  return text;
}

function cleanNote(v) {
  const note = oneLine(v);
  if (note.length > LIMITS.note) throw bad(`the note is longer than ${LIMITS.note} characters`);
  return note;
}

// The name the file was uploaded with, without any folder part. Only kept to show it.
const cleanName = v => oneLine(String(v ?? '').split(/[\\/]/).pop()).slice(0, LIMITS.originalName);

function cleanKind(v) {
  const kind = String(v ?? '').trim();
  if (kind && !KINDS.includes(kind)) throw bad('kind must be image, text or pdf');
  return kind;
}

// Tags from a list or a comma-separated text: lowercase words with hyphens ("UI kit" is ui-kit),
// each at most 40 characters, at most 20, no repeats.
function cleanTags(v) {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) throw bad('tags must be a list of words');
  const tags = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw bad('tags must be a list of words');
    const tag = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag) continue;
    if (tag.length > LIMITS.tag || !ID_RE.test(tag)) {
      throw bad(`"${clip(raw, 40)}" is not a tag: use letters, digits and hyphens, at most ${LIMITS.tag} characters`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > LIMITS.tags) throw bad(`an asset can have at most ${LIMITS.tags} tags`);
  return tags;
}

// The number of versions a caller saw (expect): a whole number of at least 1, also as text.
function expectedCount(v) {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw bad('expect (the number of versions you saw) is required');
  return Number(s);
}

// A version number from a request: a whole number of at least 1, also as text.
function versionNumber(v) {
  if (v === undefined || v === null || v === '') throw bad('a version number is required');
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^[1-9]\d{0,8}$/.test(s)) throw bad(`"${clip(v, 20)}" is not a version number`);
  return Number(s);
}

// ---------------------------------------------------------------- content

// The extension of an upload's file name, lowercase; '' when it has none (a name like
// "Release 1.2" has none either).
function extOf(name) {
  const ext = extname(String(name || '')).slice(1).toLowerCase();
  return /^\d*$/.test(ext) ? '' : ext;
}

// The kind of some bytes: image (with its format), pdf, text (with the decoded text) or ''.
function sniff(buf) {
  const image = detectImageType(buf);
  if (image) return { kind: 'image', image };
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return { kind: 'pdf' };
  if (!buf.includes(0)) {
    try { return { kind: 'text', text: utf8.decode(buf) }; } catch { /* not UTF-8 */ }
  }
  return { kind: '' };
}

function notAccepted(buf) {
  const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  return utf16 ? 'this is UTF-16 text; save it as UTF-8 and upload it again'
    : 'this file is not an image (PNG, JPEG, GIF, WebP, BMP), a PDF or UTF-8 text';
}

function imageContent(buf, image) {
  if (buf.length > LIMITS.imageBytes) throw tooLarge('images can be at most 25 MB');
  if (image !== 'bmp') return { kind: 'image', ext: image, type: STORED[image].type, data: buf };
  let png;
  try { png = bmpToPng(buf); } catch (e) { throw e.status === 415 ? unsupported(e.message) : e; }
  if (png.length > LIMITS.imageBytes) throw tooLarge('this BMP is larger than 25 MB as a PNG');
  return { kind: 'image', ext: 'png', type: STORED.png.type, data: png };
}

function pdfContent(buf) {
  if (buf.length > LIMITS.pdfBytes) throw tooLarge('PDFs can be at most 25 MB');
  return { kind: 'pdf', ext: 'pdf', type: STORED.pdf.type, data: buf };
}

// True when a text is an SVG document: its first element, after the prolog (PROLOG_PART), is
// <svg>. Only the first 64 KB are looked at; both regexes run in linear time.
function isSvgDocument(text) {
  const head = text.slice(0, 64 * 1024);
  let at = 0;
  PROLOG_PART.lastIndex = 0;
  while (PROLOG_PART.exec(head)) at = PROLOG_PART.lastIndex;
  SVG_ROOT.lastIndex = at;
  return SVG_ROOT.test(head);
}

function textContent(buf, text, ext) {
  if (buf.length > LIMITS.textBytes) throw tooLarge('text files can be at most 2 MB');
  if (isSvgDocument(text)) throw unsupported('SVG is not accepted, not even as text: it can carry scripts');
  if (ext === 'json') {
    try { JSON.parse(text); } catch (e) { throw unsupported(`this is not valid JSON (${e.message})`); }
  }
  return { kind: 'text', ext, type: STORED[ext].type, data: buf };
}

// What an upload is, decided by its bytes: { kind, ext, type, data }, where `data` is what gets
// stored (a BMP becomes a PNG). `name` is the original file name: an extension that claims
// another kind is refused, and for text it picks .md, .txt or .json (`textExt` when it has
// none). `declared` is the kind the caller expects ('' for any). Throws 400, 413 or 415.
export function checkContent(buf, { name = '', declared = '', textExt = 'txt' } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('the file is empty');
  const ext = extOf(name);
  if (ext === 'svg' || ext === 'svgz') throw unsupported('SVG files are not accepted: they can carry scripts. Save it as PNG.');
  const named = ext ? NAMED_KIND[ext] : '';
  if (ext && !named) {
    throw unsupported(`.${clip(ext, 20)} files are not accepted. The library takes images (PNG, JPEG, GIF, WebP, BMP), .md, .txt and .json text, and PDF.`);
  }
  const found = sniff(buf);
  if (!found.kind) throw unsupported(notAccepted(buf));
  if (named && named !== found.kind) throw unsupported(`the file is named .${ext}, but it is ${KIND_WORDS[found.kind]}`);
  if (declared && declared !== found.kind) throw unsupported(`this file is ${KIND_WORDS[found.kind]}, not ${KIND_WORDS[declared]}`);
  if (found.kind === 'image') return imageContent(buf, found.image);
  if (found.kind === 'pdf') return pdfContent(buf);
  const textExtOk = e => !!STORED[e] && STORED[e].kind === 'text';
  return textContent(buf, found.text, textExtOk(ext) ? ext : textExtOk(textExt) ? textExt : 'txt');
}

// ---------------------------------------------------------------- the record

// Why a parsed asset.json can't be used ('' when it can). The version entries are checked
// strictly, since /library-file serves the files they name.
function recordProblem(rec, loc) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'is not a JSON object';
  if (rec.format !== ASSET_FORMAT) return `has format ${clip(JSON.stringify(rec.format), 20)}; this app reads format ${ASSET_FORMAT}`;
  if (rec.id !== loc.id) return `names the id "${clip(rec.id)}", not its folder's "${loc.id}"`;
  if (rec.scope !== loc.scope) return `says scope "${clip(rec.scope)}", but it is in the ${loc.scope === 'shared' ? 'shared library' : `folder of ${loc.project}`}`;
  if (loc.scope === 'project' && String(rec.project ?? '').toLowerCase() !== loc.project.toLowerCase()) {
    return `names the project "${clip(rec.project)}", but it is in the folder of ${loc.project}`;
  }
  if (!KINDS.includes(rec.kind)) return `has an unknown kind "${clip(rec.kind)}"`;
  if (!Array.isArray(rec.versions) || !rec.versions.length) return 'lists no versions';
  let last = 0;
  for (const v of rec.versions) {
    const m = v && typeof v.file === 'string' ? VERSION_FILE.exec(v.file) : null;
    if (!m || v.n !== Number(m[1]) || v.n <= last) return `has a bad version entry ${clip(JSON.stringify(v), 60)}`;
    if (STORED[m[2]].kind !== rec.kind) return `lists ${v.file}, which is not ${KIND_WORDS[rec.kind]}`;
    if (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return `has no SHA-256 for ${v.file}`;
    last = v.n;
  }
  return '';
}

const text = v => (typeof v === 'string' ? v : '');

// The record in format 1 with every field in place. The kind and type of a version come from its
// file's extension, never from what the file says, and the project is spelled as on disk.
function cleanRecord(rec, loc) {
  return {
    format: ASSET_FORMAT, id: loc.id, scope: loc.scope, project: loc.project,
    title: oneLine(rec.title) || loc.id, kind: rec.kind, description: text(rec.description),
    tags: Array.isArray(rec.tags) ? rec.tags.filter(t => typeof t === 'string') : [],
    createdAt: text(rec.createdAt), archived: rec.archived === true,
    versions: rec.versions.map(v => ({
      n: v.n, file: v.file, sha256: v.sha256, bytes: Number.isInteger(v.bytes) && v.bytes >= 0 ? v.bytes : 0,
      type: STORED[VERSION_FILE.exec(v.file)[2]].type, addedAt: text(v.addedAt), note: text(v.note), originalName: text(v.originalName),
    })),
  };
}

// Reads the record of the asset at `loc` (from parseRef). Throws 404 when there is none (no
// folder, a link where the folder should be, no asset.json yet) and 500 when it can't be used.
async function readRecord(loc) {
  const none = () => new HttpError(404, `there is no asset ${loc.ref}`);
  let st;
  try { st = await lstat(loc.dir); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw none();
    throw e;
  }
  if (!st.isDirectory()) throw none();
  let rec;
  try { rec = await readJson(recordFile(loc.dir), null); } catch (e) {
    throw new HttpError(500, `${loc.ref}: asset.json can't be read (${e.message})`);
  }
  if (rec === null) throw none();
  const problem = recordProblem(rec, loc);
  if (problem) throw new HttpError(500, `${loc.ref}: asset.json ${problem}`);
  return cleanRecord(rec, loc);
}

// What listings show of an asset.
function summaryOf(rec) {
  const last = rec.versions[rec.versions.length - 1];
  return {
    ref: assetRef(rec.scope, rec.project, rec.id), id: rec.id, scope: rec.scope, project: rec.project,
    title: rec.title, kind: rec.kind, tags: [...rec.tags], description: rec.description, archived: rec.archived,
    latest: { n: last.n, sha256: last.sha256, bytes: last.bytes, type: last.type, addedAt: last.addedAt },
    versionCount: rec.versions.length,
  };
}

// One asset with every version: what getAsset and every change answer with.
function detailOf(rec) {
  return { ...summaryOf(rec), createdAt: rec.createdAt, versions: rec.versions.map(v => ({ ...v })) };
}

// A listing entry for an asset folder whose asset.json can't be used, so it doesn't vanish.
function brokenOf(loc, error) {
  return {
    ref: loc.ref, id: loc.id, scope: loc.scope, project: loc.project, title: loc.id, kind: '', tags: [],
    description: '', archived: false, latest: null, versionCount: 0, error,
  };
}

// ---------------------------------------------------------------- writing

const queues = new Map();

// Runs fn() once every earlier change to the same asset has finished (keyed by its folder), so
// two requests never read the same asset.json and then write it back over each other.
function oneAtATime(dir, fn) {
  const key = dir.toLowerCase();
  const run = (queues.get(key) || Promise.resolve()).then(fn);
  const done = run.then(() => {}, () => {});
  queues.set(key, done);
  done.then(() => { if (queues.get(key) === done) queues.delete(key); });
  return run;
}

// The next version number: one more than every listed version and every v<N>.* file already in
// the folder, so a file left behind by a crash is skipped, never overwritten.
async function nextNumber(dir, versions) {
  let n = versions.reduce((max, v) => Math.max(max, v.n), 0);
  for (const name of await readdir(dir).catch(() => [])) {
    const m = /^v([1-9]\d{0,8})\./.exec(name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}

// Writes the bytes as v<n>.<ext> with an exclusive create (the next number when that name is
// taken) and returns the version entry. Never past MAX_VERSION: a stray file with the highest
// number would otherwise lead to a record this module refuses to read.
async function writeVersion(dir, n, content, sha256, { note, originalName }) {
  for (let k = n; k < n + 100; k++) {
    if (k > MAX_VERSION) throw new HttpError(409, `this asset folder has no version number left (a stray file v${MAX_VERSION}.* is in it)`);
    const file = `v${k}.${content.ext}`;
    try {
      await writeFile(join(dir, file), content.data, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      await rm(join(dir, file), { force: true }).catch(() => {}); // a part-written file of our own
      throw e;
    }
    return {
      n: k, file, sha256, bytes: content.data.length, type: content.type, addedAt: new Date().toISOString(), note, originalName,
    };
  }
  throw new HttpError(409, 'this asset folder has too many stray version files');
}

// ---------------------------------------------------------------- the API

// The library: shared assets plus that project's (every project's without one), sorted by
// place and title. Archived assets only with includeArchived. An asset folder whose asset.json
// can't be used is listed with `error`; a folder without asset.json is not an asset (yet).
export async function listLibrary(root, { project = '', includeArchived = false } = {}) {
  const projects = project ? [existingProject(root, project)] : [...projectNameMap(root).values()].sort();
  const places = [{ scope: 'shared', project: null, base: sharedAssetsDir(root) }];
  for (const p of projects) {
    if (p.toLowerCase() !== 'shared') places.push({ scope: 'project', project: p, base: projectAssetsDir(root, p) });
  }
  const out = [];
  for (const place of places) {
    let entries = [];
    try { entries = await readdir(place.base, { withFileTypes: true }); } catch { continue; }
    // Dirent.isDirectory() is false for links and junctions: those are not assets.
    for (const e of entries.filter(d => d.isDirectory() && isId(d.name))) {
      const loc = { ref: assetRef(place.scope, place.project, e.name), scope: place.scope, project: place.project, id: e.name, dir: join(place.base, e.name) };
      try {
        const rec = await readRecord(loc);
        if (!rec.archived || includeArchived) out.push(summaryOf(rec));
      } catch (err) {
        if (err.status !== 404) out.push(brokenOf(loc, err.message));
      }
    }
  }
  const rank = a => (a.scope === 'shared' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || String(a.project || '').localeCompare(String(b.project || ''))
    || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

// One asset with every version, by ref.
export async function getAsset(root, ref) {
  return detailOf(await readRecord(parseRef(root, ref)));
}

// A new asset from its first version. Options: scope ('shared' or 'project'), project, title
// (the file name without its extension when empty), kind (optional, must match the content),
// description, tags, note (about this version) and originalName. Everything is checked before
// anything is written. Returns { ref, version: 1, added: true, asset }.
export async function createAsset(root, opts, buf) {
  const o = opts || {};
  const place = placeFor(root, o.scope, o.project);
  const originalName = cleanName(o.originalName);
  const title = cleanTitle(oneLine(o.title) || originalName.replace(/\.[^.]*$/, ''));
  const description = cleanDescription(o.description);
  const tags = cleanTags(o.tags);
  const note = cleanNote(o.note);
  const content = checkContent(buf, { name: originalName, declared: cleanKind(o.kind) });
  const sha256 = sha256Text(content.data);
  const id = await claimFolder(place.base, title);
  const dir = join(place.base, id);
  try {
    const version = await writeVersion(dir, 1, content, sha256, { note, originalName });
    const rec = {
      format: ASSET_FORMAT, id, scope: place.scope, project: place.project, title, kind: content.kind, description, tags,
      createdAt: version.addedAt, archived: false, versions: [version],
    };
    await writeJsonAtomic(recordFile(dir), rec);
    return { ref: assetRef(place.scope, place.project, id), version: version.n, added: true, asset: detailOf(rec) };
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // the folder this call made
    throw e;
  }
}

// A new version of an asset. expectVersions is the number of versions the caller saw. The
// content must be of the asset's kind; text without a file name keeps the latest version's
// format. The same bytes as the latest version add nothing (added: false), also when the caller's
// count is out of date, so a repeated upload is harmless. Returns { ref, version, added, asset }.
export async function addVersion(root, ref, buf, { originalName = '', note = '', expectVersions, kind = '' } = {}) {
  const loc = parseRef(root, ref);
  const expect = expectedCount(expectVersions);
  const name = cleanName(originalName);
  const versionNote = cleanNote(note);
  const declared = cleanKind(kind);
  return oneAtATime(loc.dir, async () => {
    const rec = await readRecord(loc);
    const latest = rec.versions[rec.versions.length - 1];
    const content = checkContent(buf, { name, declared, textExt: VERSION_FILE.exec(latest.file)[2] });
    if (content.kind !== rec.kind) throw unsupported(`${loc.ref} is ${KIND_WORDS[rec.kind]}; this file is ${KIND_WORDS[content.kind]}`);
    const sha256 = sha256Text(content.data);
    if (sha256 === latest.sha256) return { ref: loc.ref, version: latest.n, added: false, asset: detailOf(rec) };
    if (rec.archived) throw new HttpError(409, `${loc.ref} is archived. Restore it before adding a version.`);
    if (rec.versions.length !== expect) throw stale(loc, rec, expect);
    const version = await writeVersion(loc.dir, await nextNumber(loc.dir, rec.versions), content, sha256, { note: versionNote, originalName: name });
    const next = { ...rec, versions: [...rec.versions, version] };
    try {
      await writeJsonAtomic(recordFile(loc.dir), next);
    } catch (e) {
      await rm(join(loc.dir, version.file), { force: true }).catch(() => {}); // not listed, so not kept
      throw e;
    }
    return { ref: loc.ref, version: version.n, added: true, asset: detailOf(next) };
  });
}

function stale(loc, rec, expect) {
  const n = rec.versions.length;
  return new HttpError(409, `${loc.ref} has ${n} version${n === 1 ? '' : 's'} now, not ${expect}: it changed since you opened it. Reload it and try again.`);
}

// Changes the title, description or tags (the fields given; the id stays). `expect` is the
// number of versions the caller saw. Returns the asset.
export async function updateMeta(root, ref, { title, description, tags, expect } = {}) {
  const loc = parseRef(root, ref);
  const count = expectedCount(expect);
  const patch = {};
  if (title !== undefined) patch.title = cleanTitle(title);
  if (description !== undefined) patch.description = cleanDescription(description);
  if (tags !== undefined) patch.tags = cleanTags(tags);
  if (!Object.keys(patch).length) throw bad('there is nothing to change: send a title, description or tags');
  return oneAtATime(loc.dir, async () => {
    const rec = await readRecord(loc);
    if (rec.versions.length !== count) throw stale(loc, rec, count);
    const next = { ...rec, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(rec)) await writeJsonAtomic(recordFile(loc.dir), next);
    return detailOf(next);
  });
}

// Archives (true) or restores (false) an asset. An archived asset leaves the default listing and
// takes no new versions; its files stay and are still served and resolved. Returns the asset.
export async function setArchived(root, ref, archived) {
  const loc = parseRef(root, ref);
  if (typeof archived !== 'boolean') throw bad('archived must be true or false');
  return oneAtATime(loc.dir, async () => {
    const rec = await readRecord(loc);
    if (rec.archived === archived) return detailOf(rec);
    const next = { ...rec, archived };
    await writeJsonAtomic(recordFile(loc.dir), next);
    return detailOf(next);
  });
}

// The file of one version, for /library-file: { path, type, version, kind, downloadName }. Only a
// version that asset.json lists, by its own v<n>.<ext> name inside the asset's folder, and only a
// regular file (no link). `type` is what to serve: images and PDFs as stored, every text kind as
// text/plain; charset=utf-8, so Markdown or JSON never renders as a page. Throws 400 or 404.
export async function assetFile(root, ref, n) {
  const loc = parseRef(root, ref);
  const num = versionNumber(n);
  const rec = await readRecord(loc);
  const v = rec.versions.find(x => x.n === num);
  if (!v) throw new HttpError(404, `${loc.ref} has no version ${num}`);
  const path = join(loc.dir, v.file);
  if (!isInside(loc.dir, path) || !(await isRegularFile(path))) throw new HttpError(404, `the file of ${loc.ref} version ${num} is missing`);
  const type = rec.kind === 'text' ? 'text/plain; charset=utf-8' : v.type;
  return { path, type, version: { ...v }, kind: rec.kind, downloadName: `${loc.id}-${v.file}` };
}

// What a list of attachments points to, for runs and flows. `attachments` is a list of
// { ref, pin }: pin null (or left out) follows the latest version, a number pins that version.
// `project` may attach shared assets and its own ('' or null: shared assets only); a ref of
// another project is refused (400), and the whole list is checked before anything is read.
// Each item: { ref, pin, version, sha256, bytes, path (absolute), rel (from the workspace root),
// type, kind, title }, plus missing: true (no such asset or version, or its file is gone; then
// the fields it can't know are null) and archived: true where that applies.
export async function resolveAttachments(root, project, attachments) {
  const own = project ? existingProject(root, project) : null;
  if (!Array.isArray(attachments)) throw bad('attachments must be a list of { ref, pin }');
  if (attachments.length > LIMITS.attachments) throw bad(`at most ${LIMITS.attachments} attachments`);
  const wanted = attachments.map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('each attachment is { ref, pin }');
    const loc = parseRef(root, a.ref);
    if (loc.scope === 'project' && (!own || loc.project.toLowerCase() !== own.toLowerCase())) {
      throw bad(`${loc.ref} belongs to projects/${loc.project}; ${own ? `${own} can attach shared assets and its own` : 'only shared assets can be attached here'}`);
    }
    return { loc, pin: a.pin === null || a.pin === undefined ? null : versionNumber(a.pin) };
  });
  const out = [];
  for (const w of wanted) out.push(await resolveOne(root, w));
  return out;
}

async function resolveOne(root, { loc, pin }) {
  const item = { ref: loc.ref, pin, version: pin, sha256: null, bytes: null, path: null, rel: null, type: null, kind: null, title: null };
  let rec;
  try { rec = await readRecord(loc); } catch (e) {
    return e.status === 404 ? { ...item, missing: true } : { ...item, missing: true, error: e.message };
  }
  const known = { ...item, kind: rec.kind, title: rec.title, ...(rec.archived ? { archived: true } : {}) };
  const v = pin === null ? rec.versions[rec.versions.length - 1] : rec.versions.find(x => x.n === pin);
  if (!v) return { ...known, missing: true };
  const path = join(loc.dir, v.file);
  const found = { ...known, version: v.n, sha256: v.sha256, bytes: v.bytes, path, rel: posixRel(root, path), type: v.type };
  return (await isRegularFile(path)) ? found : { ...found, missing: true };
}
