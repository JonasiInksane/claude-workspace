// HTTP plumbing for the workspace app: the error type routes throw, response helpers, body
// readers, the sign-in cookie helpers and the page's static files. No routes and no workspace
// knowledge live here (app.mjs and routes/*.mjs have those).
//
// Static files: listUiFiles() scans ui/ once at startup. It serves index.html at "/" and the
// .js, .css, .svg and .ico files in ui/ and its subfolders at their own paths (ui/views/home.js
// at /views/home.js). Dotfiles, symlinks, other file types and odd names are never served, and
// a request path is looked up as-is (no decoding), so "..", "%2e%2e" or a backslash can't
// reach another file. A file added to ui/ needs a restart of the app; an edited one doesn't.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export const MAX_JSON_BYTES = 64 * 1024;
export const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

// What a route throws for a refusal: app.mjs answers { ok: false, error: message } with `status`.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Constant-time comparison of two tokens; an empty token never matches.
export function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Every response gets these headers; `headers` adds to or overrides them.
export function send(res, status, body, headers = {}) {
  const base = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}
export const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

// Reads the body up to `limit` bytes. Over the limit it rejects with 413 at once and keeps
// draining (not destroying) the request, so the client still gets the 413 response.
export function readBody(req, limit) {
  return new Promise((resolveP, reject) => {
    const limitText = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MB` : `${Math.round(limit / 1024)} KB`;
    const tooBig = () => new HttpError(413, `request is larger than ${limitText}`);
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(tooBig()); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolveP(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// A JSON body of at most 64 KB; an empty body is {}.
export async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// ---------------------------------------------------------------- static files

export const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const SAFE_NAME = /^[A-Za-z0-9_-][\w.-]*$/; // no dotfiles, no spaces, no "%" or "\"
const MAX_DEPTH = 4;

// Map of URL path -> { file, type } for the page: "/" is index.html, the rest keep their path.
export function listUiFiles(uiDir) {
  const files = new Map([['/', { file: join(uiDir, 'index.html'), type: 'text/html; charset=utf-8' }]]);
  const walk = (dir, urlDir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!SAFE_NAME.test(e.name)) continue;
      // Dirent.isFile() and isDirectory() are false for symlinks and junctions: those are skipped.
      if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(join(dir, e.name), `${urlDir}${e.name}/`, depth + 1); continue; }
      const type = STATIC_TYPES[extname(e.name).toLowerCase()];
      if (e.isFile() && type) files.set(`${urlDir}${e.name}`, { file: join(dir, e.name), type });
    }
  };
  walk(uiDir, '/', 0);
  return files;
}

// Sends one entry of listUiFiles(); the page itself gets the strict CSP.
export function sendStatic(res, { file, type }) {
  const headers = { 'Content-Type': type };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
  send(res, 200, readFileSync(file), headers);
}
