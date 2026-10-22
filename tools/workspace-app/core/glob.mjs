// Glob matching and a folder walk that work the same on Node 20 and 24.
//
// Node 24 has path.matchesGlob and fs.glob; Node 20.15.1 (the other PC, and a common project pin)
// doesn't, so profiles, fences, probes and the check runner all use this module instead.
//
// Globs are posix and match a whole relative path ("apps/web/src/a.ts"), never a part of it:
//   *       any characters inside one folder name (not "/")
//   ?       one character, not "/"
//   **      as a whole path segment: zero or more folders. "**/x" matches "x" and "a/b/x";
//           "a/**" matches "a" and everything under it. Elsewhere ("a**b") it acts like "*".
//   {a,b}   either alternative; alternatives may hold globs and may nest
//   \x      the character x itself
// Names starting with a dot match like any other name, so "**/*.json" also finds ".eslintrc.json".
// Matching is case-sensitive unless { nocase: true } is passed (git paths are case-sensitive; Windows
// file names are not, so a fence guarding a file Windows would open can ask for nocase).
//
// walk() lists files under a folder without following symlinks or junctions, so a junction loop
// (or a linked checkout under projects/) can't make it run forever or wander out of the tree.
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_SKIP_DIRS = ['node_modules', '.git', '.turbo', '.next'];
const MAX_DEPTH = 64;
const cache = new Map();

// "a\b/./c" -> "a/b/./c" with no leading "./" or "/"; the form globs are matched against.
export function toPosix(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

function tokenize(glob) {
  const out = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { out.push({ t: 'lit', v: glob[++i] }); continue; }
    if (c === '*') {
      let j = i;
      while (glob[j + 1] === '*') j++;
      out.push({ t: j > i ? 'globstar' : 'star' });
      i = j;
      continue;
    }
    if (c === '?') out.push({ t: 'any' });
    else if (c === '/') out.push({ t: 'sep' });
    else if (c === '{' || c === '}' || c === ',') out.push({ t: c });
    else out.push({ t: 'lit', v: c });
  }
  return markBraces(out);
}

// Braces count only in matched pairs, and commas only inside a pair; the rest are plain text.
function markBraces(toks) {
  const open = [];
  for (const tok of toks) {
    if (tok.t === '{') open.push(tok);
    else if (tok.t === '}' && open.length) { open.pop().pair = true; tok.pair = true; }
  }
  let depth = 0;
  for (const tok of toks) {
    if (tok.t === '{' || tok.t === '}') {
      if (!tok.pair) { tok.v = tok.t; tok.t = 'lit'; continue; }
      depth += tok.t === '{' ? 1 : -1;
    } else if (tok.t === ',' && depth === 0) {
      tok.t = 'lit';
      tok.v = ',';
    }
  }
  return toks;
}

const startsSegment = tok => !tok || tok.t === 'sep' || tok.t === '{' || tok.t === ',';
const endsSegment = tok => !tok || tok.t === 'sep' || tok.t === '}' || tok.t === ',';
const escapeRe = ch => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function toSource(toks) {
  let src = '';
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const next = toks[k + 1];
    switch (tok.t) {
      case 'globstar':
        if (!startsSegment(toks[k - 1]) || !endsSegment(next)) src += '[^/]*';
        else if (next && next.t === 'sep') { src += '(?:.*/)?'; k++; }
        else src += '.*';
        break;
      case 'sep': {
        // "a/**" at the end (of the glob or of an alternative): "a" itself or anything below it.
        const after = toks[k + 2];
        if (next && next.t === 'globstar' && endsSegment(after) && !(after && after.t === 'sep')) {
          src += '(?:/.*)?';
          k++;
        } else src += '/';
        break;
      }
      case 'star': src += '[^/]*'; break;
      case 'any': src += '[^/]'; break;
      case '{': src += '(?:'; break;
      case '}': src += ')'; break;
      case ',': src += '|'; break;
      default: src += escapeRe(tok.v);
    }
  }
  return src;
}

// An anchored RegExp for one glob.
export function globToRegExp(glob, { nocase = false } = {}) {
  if (typeof glob !== 'string') throw new Error('A glob must be a string.');
  const key = `${nocase ? 'i' : '-'}${glob}`;
  let re = cache.get(key);
  if (!re) {
    // Only "./" and "/" are trimmed: a backslash in a glob is an escape, not a separator.
    const trimmed = glob.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    re = new RegExp(`^${toSource(tokenize(trimmed))}$`, nocase ? 'i' : '');
    if (cache.size > 2000) cache.clear();
    cache.set(key, re);
  }
  return re;
}

// The first glob that matches the path, or null.
export function firstMatch(globs, path, opts = {}) {
  const p = toPosix(path);
  for (const g of globs || []) if (globToRegExp(g, opts).test(p)) return g;
  return null;
}

// True when any of the globs matches the path.
export function matchAny(globs, path, opts = {}) {
  return firstMatch(globs, path, opts) !== null;
}

function abortError() {
  const err = new Error('The folder walk was cancelled.');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

async function listDir(abs, isRoot) {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (isRoot && err && err.code !== 'ENOENT') throw err;
    return []; // a missing root, or a subfolder that vanished or can't be read
  }
}

// Some Node versions report a junction as a plain directory in readdir; lstat tells the truth.
async function isRealDir(abs) {
  try {
    const st = await lstat(abs);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// Lists the files under `dir` as sorted posix paths relative to it.
// - pattern: a RegExp tested against each relative path (files only).
// - exclude: globs on relative paths; a matching folder is not entered.
// - skipDirs: names skipped at any depth (files or folders).
// Symlinks and junctions are skipped, never followed. A missing `dir` gives [].
export async function walk(dir, { pattern = null, exclude = [], skipDirs = DEFAULT_SKIP_DIRS, signal = null } = {}) {
  const root = resolve(dir);
  const skip = new Set(skipDirs);
  const re = pattern ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : null;
  const out = [];
  let level = [''];
  for (let depth = 0; level.length && depth <= MAX_DEPTH; depth++) {
    if (signal && signal.aborted) throw abortError();
    const found = await Promise.all(level.map(async rel => {
      const dirs = [];
      for (const e of await listDir(join(root, rel), rel === '')) {
        if (skip.has(e.name) || e.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (exclude.length && matchAny(exclude, childRel)) continue;
        if (e.isDirectory()) {
          if (await isRealDir(join(root, childRel))) dirs.push(childRel);
        } else if (e.isFile() && (!re || re.test(childRel))) {
          out.push(childRel);
        }
      }
      return dirs;
    }));
    level = found.flat();
  }
  return out.sort();
}
