// Contract compatibility: the names other programs depend on must not disappear. Part of G0.
//
// Three kinds of names count, all from the profile's `contract` section:
// - procedures: the keys of every router file (`contract.routerFiles`), as "<module>.<key>",
//   where the module is the folder above router.ts. A key is a line like `list: someProcedure`.
// - legacy: the keys of the legacy router (`contract.legacyRouter`), which old app builds call.
// - queues: job queue names, from a TypeScript enum ({file, enum}: the string values, or the
//   member names when a member has no string value) or a regex ({file, regex}: group 1).
//
// compareContract() decides per pipeline: a refactor may remove nothing; a feature, fix or debug
// run may remove a name only when its plan lists the file that defined it (then it warns); for
// the read-only pipelines a removal is information. Added names are always information.
// The file readers are injected, so the same code reads the base commit (git) and the tree (fs).
import { normPath, READ_ONLY_PIPELINES } from './fences.mjs';

export const ROUTER_KEY_RE = /^\s*([A-Za-z0-9_]+)\s*:\s*(\w+Procedure)\b/gm;
const PLAN_REMOVAL_PIPELINES = ['feature', 'fix', 'debug'];
const KINDS = [['procedures', 'procedure'], ['legacy', 'legacy'], ['queues', 'queue']];

// Router keys in a source text: [{key, builder, line}].
export function routerKeys(text) {
  const src = String(text ?? '');
  const out = [];
  for (const m of src.matchAll(ROUTER_KEY_RE)) {
    const line = src.slice(0, m.index + m[0].length - m[0].trimStart().length).split('\n').length;
    out.push({ key: m[1], builder: m[2], line });
  }
  return out;
}

// The folder above router.ts: "apps/api/src/modules/billing/router.ts" -> "billing".
export function moduleOf(path) {
  const parts = normPath(path).split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '(root)';
}

function stripComments(text) {
  return String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// The members of `enum <name> { ... }`: string values where given, otherwise member names.
// null when the text has no such enum.
export function enumMembers(text, name) {
  const re = new RegExp(`\\benum\\s+${String(name).replace(/[^\w$]/g, '')}\\s*\\{([^}]*)\\}`);
  const m = stripComments(text).match(re);
  if (!m) return null;
  const out = [];
  for (const part of m[1].split(',')) {
    const mm = part.trim().match(/^(['"]?)([\w$-]+)\1\s*(?:=\s*(['"`])([^'"`]*)\3)?/);
    if (mm) out.push(mm[4] !== undefined ? mm[4] : mm[2]);
  }
  return out;
}

// Group 1 (or the whole match) of every match of a profile regex.
function regexNames(text, pattern) {
  const re = new RegExp(pattern, 'gm');
  return [...String(text ?? '').matchAll(re)].map(m => (m[1] !== undefined ? m[1] : m[0]));
}

// Reads the contract names. read(path) gives a file's text or null; list(globs) gives the paths
// matching the router globs. Both may be async.
// Returns {procedures: ['<module>.<key>'], legacy: [key], queues: [name], sources, problems}:
// `sources` maps "<kind>:<name>" to the file that defines it; `problems` lists files or enums
// that weren't found. Lists are sorted and keep duplicates (two routers can share a key name).
export async function extractContract(profile, { read, list }) {
  const c = profile?.contract;
  const out = { procedures: [], legacy: [], queues: [], sources: {}, problems: [] };
  if (!c) return out;
  const note = (kind, name, file) => { if (!out.sources[`${kind}:${name}`]) out.sources[`${kind}:${name}`] = file; };
  const files = [...new Set(((await list(c.routerFiles || [])) || []).map(normPath))].sort();
  for (const file of files) {
    const text = await read(file);
    if (text === null || text === undefined) continue;
    for (const k of routerKeys(text)) {
      const name = `${moduleOf(file)}.${k.key}`;
      out.procedures.push(name);
      note('procedure', name, file);
    }
  }
  if (c.legacyRouter) {
    const file = normPath(c.legacyRouter);
    const text = await read(file);
    if (text === null || text === undefined) out.problems.push(`${file} was not found.`);
    else for (const k of routerKeys(text)) { out.legacy.push(k.key); note('legacy', k.key, file); }
  }
  for (const q of c.queues || []) {
    const file = normPath(q.file);
    const text = await read(file);
    if (text === null || text === undefined) { out.problems.push(`${file} was not found.`); continue; }
    let names = [];
    if (q.enum) {
      names = enumMembers(text, q.enum);
      if (!names) { out.problems.push(`${file} has no enum ${q.enum}.`); names = []; }
    } else if (q.regex) names = regexNames(text, q.regex);
    for (const n of names) { out.queues.push(n); note('queue', n, file); }
  }
  for (const k of ['procedures', 'legacy', 'queues']) out[k].sort();
  return out;
}

// a minus b, counting duplicates.
function multisetMinus(a, b) {
  const left = new Map();
  for (const x of b || []) left.set(x, (left.get(x) || 0) + 1);
  const out = [];
  for (const x of a || []) {
    const n = left.get(x) || 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

// Compares base and head contracts.
// Returns {ok, status: pass|warn|fail, removed, added, messages}; removed and added are
// [{kind: procedure|legacy|queue, name, file}].
export function compareContract(base, head, { pipeline = '', plan = null, planFiles = null } = {}) {
  const planned = new Set((planFiles || plan?.files || []).map(p => normPath(typeof p === 'string' ? p : p?.path).toLowerCase()));
  const removed = [], added = [];
  for (const [key, kind] of KINDS) {
    for (const name of multisetMinus(base?.[key], head?.[key])) removed.push({ kind, name, file: base?.sources?.[`${kind}:${name}`] || null });
    for (const name of multisetMinus(head?.[key], base?.[key])) added.push({ kind, name, file: head?.sources?.[`${kind}:${name}`] || null });
  }
  let status = 'pass';
  const messages = [];
  if (removed.length) {
    const names = removed.map(r => `${r.kind} ${r.name}`).join(', ');
    if (READ_ONLY_PIPELINES.includes(pipeline)) {
      status = 'warn';
      messages.push(`Removed (information): ${names}.`);
    } else if (PLAN_REMOVAL_PIPELINES.includes(pipeline) && removed.every(r => r.file && planned.has(r.file.toLowerCase()))) {
      status = 'warn';
      messages.push(`Removed, and the plan lists the files: ${names}. Check every caller.`);
    } else {
      status = 'fail';
      messages.push(pipeline === 'refactor'
        ? `A refactor may not remove contract names: ${names}.`
        : `Removed without the plan listing the file: ${names}.`);
    }
  }
  if (added.length) messages.push(`Added (information): ${added.map(a => `${a.kind} ${a.name}`).join(', ')}.`);
  return { ok: status !== 'fail', status, removed, added, messages };
}
