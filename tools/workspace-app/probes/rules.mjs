// Probe kinds for the architecture scan: each kind turns files in a project tree into one number.
//
// KINDS[kind](probe, ctx) returns { value, display, extra, details }:
//   value    the number tiles, the health score and the ratchets use
//   display  the short text a tile shows ("2 of 34", "589–781 per locale")
//   extra    more fields saved next to value in metrics.json (counts per class, min and max, ...)
//   details  [{ path, line, text }]: the items behind the number (lens lists, new candidates)
// `probe` is one entry of the profile's `probes` list: { id, kind, label, measures, ...params }.
// `ctx` is built by probes/scan.mjs:
//   { tree, profile, only, readFile(rel), walk(globs, exclude, { all }), listDir(rel), isFile(rel),
//     isDir(rel), run({ command, args, cwd, timeoutMs }), resolveArgv(argv, cwd) }
// Paths are posix and relative to the tree root. readFile gives null for a missing file.
//
// The probes are heuristics: they read text with regexes and never run project code, except the
// `cycles` kind, which runs madge from the tree's own node_modules (through core/proc.mjs).
// `only` (a list of paths, used by the G0 gates on changed files) limits the file kinds
// (FILE_KINDS) to those files; the folder kinds always look at the whole tree.
// A probe that can't run throws an Error with a plain message; scan.mjs records it for that probe.
// A probe with nothing to read (a folder that moved, madge printing an empty graph) throws too:
// a 0 from an empty input would look like progress to the tiles, the wins and the G0 ratchet.
import { posix } from 'node:path';
import { cyclesOf, moduleGraph } from './graph.mjs';

export const FILE_KINDS = ['routerKeys', 'missingAssert', 'regexCount', 'windowRegex', 'deepImports'];
export const CLASSES = ['shop', 'protected', 'public', 'unknown'];
const TEXT_CAP = 200;
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const PUBLIC_FILE_RE = /^public\.(?:[cm]?[jt]sx?)$/;
const GRAPH_SAMPLE = 5;
// The module specifier of an import, export-from, dynamic import() or require().
const SPEC_RE = /\b(?:from|import|require)\s*\(?\s*(['"])([^'"\r\n]+)\1/g;
const KEY_RE = /^(\s*)([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\b/;
const NESTED_ROUTER_RE = /^(\s*)([A-Za-z_$][\w$]*)\s*:\s*(?:[\w$]+\.)?router\s*\(/;

// ---------------------------------------------------------------- small helpers

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const trimSlashes = p => String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

function needList(probe, key) {
  const v = probe[key];
  if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !x)) {
    throw new Error(`probe "${probe.id}" needs "${key}", a list of globs.`);
  }
  return v;
}

function needString(probe, key) {
  const v = probe[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`probe "${probe.id}" needs "${key}".`);
  return v;
}

function excludes(probe) {
  const v = probe.exclude;
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`probe "${probe.id}": "exclude" must be a list of globs.`);
  return v;
}

// Extra regex flags a probe may ask for: i (ignore case), s (dot matches newlines), u (unicode).
function extraFlags(probe) {
  const f = String(probe.flags || '');
  if (!/^[isu]*$/.test(f)) throw new Error(`probe "${probe.id}": "flags" may only hold i, s and u.`);
  return f;
}

function compile(probe, key, source, flags) {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`probe "${probe.id}": "${key}" is not a valid regex (${err.message}).`);
  }
}

// One line of source as a detail text: trimmed, whitespace collapsed, at most 200 characters.
export function snippet(line) {
  const s = String(line).replace(/\s+/g, ' ').trim();
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP - 1)}…` : s;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

// The 0-based line holding character `index` (binary search over the line starts).
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The text of lines first..last (0-based, inclusive), without the final line break.
function linesText(text, starts, first, last) {
  const end = last + 1 < starts.length ? starts[last + 1] : text.length;
  return text.slice(starts[first], end).replace(/\r?\n$/, '');
}

// Every non-empty match of a global regex, as { line (1-based), text, groups }. `text` is the
// line the match starts on, or all the lines it covers when it spans several.
function matchLines(re, text) {
  const starts = lineStarts(text);
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const first = lineAt(starts, m.index);
    const last = lineAt(starts, m.index + m[0].length - 1);
    out.push({ line: first + 1, text: snippet(linesText(text, starts, first, last)), groups: m });
  }
  return out;
}

function countBy(list, keyOf) {
  const out = {};
  for (const item of list) {
    const k = keyOf(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// The folder a probe reads, or an error when the tree has no such folder (a typo in the profile,
// or a refactor moved it). Counting a missing folder as empty would record a real-looking 0.
async function needDir(ctx, dir) {
  if (!(await ctx.isDir(dir))) throw new Error(`${dir} is not a folder in this tree.`);
  return dir;
}

async function readAll(ctx, files, fn) {
  for (const file of files) {
    const text = await ctx.readFile(file);
    if (text !== null && text !== undefined) fn(file, text);
  }
}

// ---------------------------------------------------------------- router keys

const isBuilder = (name, builders) => Object.prototype.hasOwnProperty.call(builders, name) || /Procedure$/.test(name);
const indentOf = line => line.length - line.trimStart().length;

// The body of the key on line i: that line plus the lines after it that are indented deeper,
// so it ends at the next key at the same indent (or the bracket that closes the router).
function bodyOf(lines, i, indent) {
  let j = i + 1;
  for (; j < lines.length; j++) {
    if (lines[j].trim() && indentOf(lines[j]) <= indent) break;
  }
  return lines.slice(i, j).join('\n');
}

// The procedure keys in one router file: [{ id, key, builder, cls, file, line, body }].
// `id` is "<module>.<nested router>.<key>", where the module is the folder holding router.ts and
// nested routers are `name: router({` blocks. A key counts when its value starts with a builder
// named in the profile's `builders` or any name ending in "Procedure" (an unknown builder gets the
// class "unknown"). A key pointing at another router (`billing: billingRouter`) is not a procedure.
export function routerKeysIn(text, file, builders = {}) {
  const lines = String(text).split(/\r?\n/);
  const module = posix.basename(posix.dirname(trimSlashes(file))) || '.';
  const nest = [];
  const popTo = indent => { while (nest.length && nest[nest.length - 1].indent >= indent) nest.pop(); };
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const r = NESTED_ROUTER_RE.exec(lines[i]);
    if (r) {
      popTo(r[1].length);
      nest.push({ indent: r[1].length, name: r[2] });
      continue;
    }
    const m = KEY_RE.exec(lines[i]);
    if (!m || !isBuilder(m[3], builders)) continue;
    const indent = m[1].length;
    popTo(indent);
    found.push({
      id: [module, ...nest.map(n => n.name), m[2]].join('.'),
      key: m[2],
      builder: m[3],
      cls: CLASSES.includes(builders[m[3]]) ? builders[m[3]] : 'unknown',
      file,
      line: i + 1,
      body: bodyOf(lines, i, indent),
    });
  }
  return found;
}

async function routerKeyList(probe, ctx) {
  const builders = (ctx.profile && ctx.profile.builders) || {};
  const files = await ctx.walk(needList(probe, 'files'), excludes(probe));
  const keys = [];
  await readAll(ctx, files, (file, text) => keys.push(...routerKeysIn(text, file, builders)));
  return keys;
}

const keyDetail = k => ({ path: k.file, line: k.line, text: `${k.id}: ${k.builder}` });

// Counts router keys per class (shop, protected, public, unknown) and lists the non-shop ones.
// `filter: { class, builder, bodyRegex }` keeps only the keys that match all of the given parts.
async function routerKeys(probe, ctx) {
  const f = probe.filter || null;
  if (f !== null && (typeof f !== 'object' || Array.isArray(f))) throw new Error(`probe "${probe.id}": "filter" must be an object.`);
  if (f && f.class !== undefined && !CLASSES.includes(f.class)) {
    throw new Error(`probe "${probe.id}": filter.class must be one of ${CLASSES.join(', ')}.`);
  }
  const bodyRe = f && f.bodyRegex ? compile(probe, 'filter.bodyRegex', f.bodyRegex, extraFlags(probe)) : null;
  const keys = (await routerKeyList(probe, ctx)).filter(k =>
    (!f || f.class === undefined || k.cls === f.class) &&
    (!f || f.builder === undefined || k.builder === f.builder) &&
    (!bodyRe || bodyRe.test(k.body)));
  const byClass = countBy(keys, k => k.cls);
  const parts = CLASSES.filter(c => byClass[c]).map(c => `${byClass[c]} ${c}`);
  const display = f ? String(keys.length) : `${plural(keys.length, 'key')}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
  return {
    value: keys.length,
    display,
    extra: {
      byClass,
      byBuilder: countBy(keys, k => k.builder),
      nonShop: [...new Set(keys.filter(k => k.cls !== 'shop').map(k => k.id))].sort(),
      filtered: !!f,
    },
    details: keys.map(keyDetail),
  };
}

// Shop-class keys whose body has no `assertPattern` call, except keys built with one of the
// `assertingBuilders` (builders that run the check themselves).
async function missingAssert(probe, ctx) {
  const profile = ctx.profile || {};
  const pattern = probe.assertPattern || profile.assertPattern;
  if (!pattern) throw new Error('the profile has no assertPattern.');
  const assertRe = compile(probe, 'assertPattern', pattern, '');
  const asserting = new Set(probe.assertingBuilders || profile.assertingBuilders || []);
  const checked = (await routerKeyList(probe, ctx)).filter(k => k.cls === 'shop' && !asserting.has(k.builder));
  const flagged = checked.filter(k => !assertRe.test(k.body));
  return {
    value: flagged.length,
    display: String(flagged.length),
    extra: { checked: checked.length },
    details: flagged.map(keyDetail),
  };
}

// ---------------------------------------------------------------- regex kinds

// Matches of `regex` in the files (all matches), or with `perFile: true` the files that match.
async function regexCount(probe, ctx) {
  const re = compile(probe, 'regex', needString(probe, 'regex'), `gm${extraFlags(probe)}`);
  const files = await ctx.walk(needList(probe, 'files'), excludes(probe));
  let matches = 0;
  let filesWithHits = 0;
  const details = [];
  await readAll(ctx, files, (file, text) => {
    const hits = matchLines(re, text);
    if (!hits.length) return;
    filesWithHits++;
    matches += hits.length;
    for (const h of probe.perFile ? hits.slice(0, 1) : hits) details.push({ path: file, line: h.line, text: h.text });
  });
  const value = probe.perFile ? filesWithHits : matches;
  return {
    value,
    display: probe.perFile ? plural(value, 'file') : String(value),
    extra: { files: files.length, filesWithHits, matches },
    details,
  };
}

// Each `start` match counts once when `regex` matches on that line or within `within` lines after.
async function windowRegex(probe, ctx) {
  const flags = extraFlags(probe);
  const start = compile(probe, 'start', needString(probe, 'start'), `gm${flags}`);
  const hit = compile(probe, 'regex', needString(probe, 'regex'), flags.replace('s', ''));
  const within = probe.within === undefined ? 20 : Number(probe.within);
  if (!Number.isInteger(within) || within < 0) throw new Error(`probe "${probe.id}": "within" must be a whole number of lines.`);
  const files = await ctx.walk(needList(probe, 'files'), excludes(probe));
  let starts = 0;
  const details = [];
  await readAll(ctx, files, (file, text) => {
    const lines = text.split(/\r?\n/);
    for (const s of matchLines(start, text)) {
      starts++;
      const first = s.line - 1;
      const last = Math.min(first + within, lines.length - 1);
      for (let j = first; j <= last; j++) {
        if (hit.test(lines[j])) {
          details.push({ path: file, line: j + 1, text: snippet(lines[j]) });
          break;
        }
      }
    }
  });
  return { value: details.length, display: String(details.length), extra: { starts }, details };
}

// ---------------------------------------------------------------- web feature kinds

async function featureNames(ctx, dir) {
  return (await ctx.listDir(dir)).filter(e => e.dir).map(e => e.name);
}

// Where an import specifier points inside the features folder, or null for anything else
// (packages, other folders, specifiers the alias doesn't cover).
function resolveSpecifier(spec, file, dir, alias) {
  let p;
  if (alias && spec.startsWith(alias)) p = `${dir}/${spec.slice(alias.length)}`;
  else if (spec.startsWith('./') || spec.startsWith('../')) p = posix.join(posix.dirname(file), spec);
  else return null;
  p = posix.normalize(p);
  return p.startsWith(`${dir}/`) ? p : null;
}

// True when the part after the feature name is one of the feature's public entries. The feature
// folder itself ("@/features/x") resolves to its index file.
function isPublicEntry(sub, entries) {
  let s = sub.replace(/\/+$/, '');
  if (!s) return entries.has('index');
  if (entries.has(s)) return true;
  s = s.replace(CODE_FILE_RE, '');
  if (entries.has(s)) return true;
  if (s === 'index') return false;
  s = s.replace(/\/index$/, '');
  return s !== sub && entries.has(s);
}

// Imports in one feature's files that reach into another feature, other than through one of its
// `publicEntries` (by the alias, "@/features/x/...", or by a relative path).
async function deepImports(probe, ctx) {
  const dir = await needDir(ctx, trimSlashes(needString(probe, 'featuresDir')));
  const alias = typeof probe.alias === 'string' && probe.alias ? probe.alias : null;
  const entries = new Set(Array.isArray(probe.publicEntries) ? probe.publicEntries : ['public', 'index']);
  const features = new Set(await featureNames(ctx, dir));
  const files = (await ctx.walk([`${dir}/**/*`], excludes(probe))).filter(f => CODE_FILE_RE.test(f));
  const targets = {};
  const details = [];
  await readAll(ctx, files, (file, text) => {
    const from = file.slice(dir.length + 1).split('/')[0];
    if (!features.has(from) || !file.slice(dir.length + 1).includes('/')) return;
    for (const m of matchLines(new RegExp(SPEC_RE.source, 'g'), text)) {
      const spec = m.groups[2];
      const target = resolveSpecifier(spec, file, dir, alias);
      if (!target) continue;
      const rest = target.slice(dir.length + 1);
      const to = rest.split('/')[0];
      if (to === from || !features.has(to)) continue;
      if (isPublicEntry(rest.slice(to.length + 1), entries)) continue;
      targets[to] = (targets[to] || 0) + 1;
      details.push({ path: file, line: m.line, text: spec });
    }
  });
  const sorted = Object.fromEntries(Object.entries(targets).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return { value: details.length, display: String(details.length), extra: { targets: sorted, files: files.length }, details };
}

// The public entry file of one feature folder: `probe.file` when the profile names one, else the
// first file called "public" with a code extension (public.ts, public.tsx, public.mjs, ...).
async function publicEntryOf(ctx, featureDir, file) {
  if (file) return (await ctx.isFile(`${featureDir}/${file}`)) ? file : null;
  const hit = (await ctx.listDir(featureDir)).find(e => !e.dir && PUBLIC_FILE_RE.test(e.name));
  return hit ? hit.name : null;
}

// Features that have a public.ts (`value`) out of all features (`of`). `withBoundaryTest` counts
// the ones that also hold a file matching `boundaryTestRegex`.
async function publicTs(probe, ctx) {
  const dir = await needDir(ctx, trimSlashes(needString(probe, 'featuresDir')));
  const entryFile = typeof probe.file === 'string' && probe.file ? probe.file : '';
  const testRe = probe.boundaryTestRegex ? compile(probe, 'boundaryTestRegex', probe.boundaryTestRegex, '') : null;
  const features = await featureNames(ctx, dir);
  const withEntry = [];
  const details = [];
  let withBoundaryTest = 0;
  for (const f of features) {
    const entry = await publicEntryOf(ctx, `${dir}/${f}`, entryFile);
    if (!entry) continue;
    withEntry.push(f);
    const tested = testRe ? (await ctx.walk([`${dir}/${f}/**/*`], [], { all: true })).some(p => testRe.test(p)) : false;
    if (tested) withBoundaryTest++;
    details.push({ path: `${dir}/${f}/${entry}`, line: 0, text: tested || !testRe ? f : `${f} (no boundary test)` });
  }
  return {
    value: withEntry.length,
    display: `${withEntry.length} of ${features.length}`,
    extra: { of: features.length, withBoundaryTest, higherIsBetter: true },
    details,
  };
}

// ---------------------------------------------------------------- locales

function flattenKeys(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out);
    else out.add(key);
  }
  return out;
}

function parseObject(text) {
  try {
    const data = JSON.parse(String(text).replace(/^﻿/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// The flattened keys of one locale. Folder layout: <dir>/<locale>/<namespace>.json, keys
// "<namespace>.<a.b>". File layout: <dir>/<locale>.json, keys "<a.b>". A file that isn't a JSON
// object is listed in `bad` and contributes no keys.
async function localeKeys(ctx, dir, layout, locale) {
  const keys = new Set();
  const bad = [];
  const files = layout === 'folders'
    ? (await ctx.listDir(`${dir}/${locale}`)).filter(e => !e.dir && e.name.endsWith('.json')).map(e => e.name)
    : [`${locale}.json`];
  for (const name of files) {
    const rel = layout === 'folders' ? `${dir}/${locale}/${name}` : `${dir}/${name}`;
    const data = parseObject(await ctx.readFile(rel));
    if (!data) { bad.push(rel); continue; }
    flattenKeys(data, layout === 'folders' ? name.slice(0, -'.json'.length) : '', keys);
  }
  return { keys, bad };
}

// Keys of the `source` locale missing in each other locale; `value` is the worst locale.
async function localeParity(probe, ctx) {
  const dir = await needDir(ctx, trimSlashes(needString(probe, 'dir')));
  const source = needString(probe, 'source');
  const entries = await ctx.listDir(dir);
  let layout;
  let locales;
  if (entries.some(e => e.dir && e.name === source)) {
    layout = 'folders';
    locales = entries.filter(e => e.dir && e.name !== source).map(e => e.name);
  } else if (entries.some(e => !e.dir && e.name === `${source}.json`)) {
    layout = 'files';
    locales = entries.filter(e => !e.dir && e.name.endsWith('.json') && e.name !== `${source}.json`).map(e => e.name.slice(0, -5));
  } else {
    throw new Error(`${dir} has no ${source} messages.`);
  }
  const src = await localeKeys(ctx, dir, layout, source);
  if (src.bad.length) throw new Error(`${src.bad[0]} is not a valid JSON object.`);
  const perLocale = {};
  const badFiles = [];
  const details = [];
  for (const locale of locales) {
    const { keys, bad } = await localeKeys(ctx, dir, layout, locale);
    badFiles.push(...bad);
    const missing = [...src.keys].filter(k => !keys.has(k));
    perLocale[locale] = missing.length;
    for (const k of missing) {
      const path = layout === 'folders' ? `${dir}/${locale}/${k.split('.')[0]}.json` : `${dir}/${locale}.json`;
      details.push({ path, line: 0, text: `${locale}: ${k}` });
    }
  }
  const counts = Object.values(perLocale);
  const min = counts.length ? Math.min(...counts) : 0;
  const max = counts.length ? Math.max(...counts) : 0;
  const display = !counts.length ? 'no other locales' : min === max ? `${max} per locale` : `${min}–${max} per locale`;
  const extra = { min, max, perLocale, sourceKeys: src.keys.size, locales: locales.length };
  if (badFiles.length) extra.badFiles = badFiles;
  return { value: max, display, extra, details };
}

// ---------------------------------------------------------------- Expo parity

// The share of web features (folders in expo.webFeatures) with an Expo module: the folder named
// by expo.map[feature], or a module with the same name. A heuristic, so read it as a direction.
async function expoParity(probe, ctx) {
  const cfg = { ...((ctx.profile && ctx.profile.expo) || {}) };
  for (const k of ['webFeatures', 'expoModules', 'map']) if (probe[k] !== undefined) cfg[k] = probe[k];
  if (typeof cfg.webFeatures !== 'string' || typeof cfg.expoModules !== 'string') {
    throw new Error('the profile has no expo section with webFeatures and expoModules.');
  }
  const webDir = await needDir(ctx, trimSlashes(cfg.webFeatures));
  const features = await featureNames(ctx, webDir);
  const modules = new Set(await featureNames(ctx, await needDir(ctx, trimSlashes(cfg.expoModules))));
  const map = cfg.map && typeof cfg.map === 'object' ? cfg.map : {};
  const missing = features.filter(f => !modules.has(typeof map[f] === 'string' ? map[f] : f));
  const matched = features.length - missing.length;
  const value = features.length ? Math.round((100 * matched) / features.length) : 0;
  return {
    value,
    display: `${value}%`,
    extra: { matched, total: features.length, missing, higherIsBetter: true },
    details: missing.map(f => ({ path: `${webDir}/${f}`, line: 0, text: `${f} has no Expo module` })),
  };
}

// ---------------------------------------------------------------- cycles

// The package an argv runs ("madge" for "{pkg:madge/bin/cli.js}"), for error messages.
export function toolName(argv) {
  for (const a of argv || []) {
    const m = /^\{pkg:((?:@[^/]+\/)?[^/}]+)/.exec(String(a));
    if (m) return m[1];
  }
  return 'the tool';
}

function parseGraph(stdout, tool) {
  const text = String(stdout || '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let data = null;
  if (a !== -1 && b > a) {
    try { data = JSON.parse(text.slice(a, b + 1)); } catch { data = null; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${tool} printed no JSON graph.`);
  const graph = {};
  for (const [file, deps] of Object.entries(data)) {
    graph[file.replace(/\\/g, '/')] = Array.isArray(deps)
      ? deps.filter(d => typeof d === 'string').map(d => d.replace(/\\/g, '/'))
      : [];
  }
  return graph;
}

const firstLine = text => String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';

// A path that stays below its folder ("src", "./src/" and "." give "src", "src" and ''), or null
// for an absolute path, one that climbs out with "..", a flag or a placeholder.
function plainRel(p) {
  const a = String(p).replace(/\\/g, '/');
  if (!a || a.startsWith('-') || a.includes('{') || /^[A-Za-z]:/.test(a) || a.startsWith('/')) return null;
  const n = posix.normalize(a).replace(/\/+$/, '');
  if (n === '.' || n === '') return '';
  return n.split('/').includes('..') ? null : n;
}

// madge prints paths relative to its base folder: --basedir when given, else the common folder of
// the source paths ("src" when the argv ends in "src"). This finds that folder by trying the
// probe cwd and each folder named in the argv until a sample of graph paths exists there, so the
// graph can be read relative to the probe cwd (which is what `moduleRegex` is written against).
// Returns the folder relative to the cwd ('' for the cwd itself), or null when nothing fits.
async function graphBase(graph, probe, cwd, ctx) {
  const sample = Object.keys(graph).filter(k => plainRel(k)).sort().slice(0, GRAPH_SAMPLE);
  if (!sample.length || typeof ctx.isFile !== 'function') return '';
  const candidates = ['', ...probe.argv.slice(1).map(plainRel).filter(f => f !== null)];
  for (const base of [...new Set(candidates)]) {
    let fits = true;
    for (const key of sample) {
      if (!(await ctx.isFile(posix.join(cwd, base, key)))) { fits = false; break; }
    }
    if (fits) return base;
  }
  return null;
}

// The graph with every path made relative to the probe cwd.
function rebaseGraph(graph, base) {
  if (!base) return graph;
  const move = p => posix.normalize(posix.join(base, p));
  const out = {};
  for (const [file, deps] of Object.entries(graph)) out[move(file)] = deps.map(move);
  return out;
}

// Runs madge (argv from the profile, resolved by ctx.resolveArgv) and reads its --json graph.
// value = file-level import cycles (strongly connected components of two or more files);
// largestModuleCycle = the size of the biggest cycle between modules (`moduleRegex` picks the
// module from a path relative to the probe cwd), modules = how many modules the graph has.
// `partial` counts imports whose target is missing from the graph, and the tile says so. madge's
// --json output leaves unresolved imports out without a trace, so a graph that lost imports to a
// broken path alias can't always be told apart; the files count in `extra` helps spot that.
// Detail paths are relative to the tree root, like every other probe's.
// The probe fails, rather than recording 0, when the graph has no files, and (with moduleRegex)
// when the graph paths can't be placed in the tree or no path gives a module: then the module
// numbers would be 0 because nothing was read, not because there is no cycle.
async function cycles(probe, ctx) {
  if (!Array.isArray(probe.argv) || !probe.argv.length) throw new Error(`probe "${probe.id}" needs "argv".`);
  const tool = toolName(probe.argv);
  const cwd = typeof probe.cwd === 'string' && probe.cwd ? trimSlashes(probe.cwd) || '.' : '.';
  // Checked before madge runs, so a bad regex doesn't wait for a run of several minutes.
  const moduleRe = probe.moduleRegex ? compile(probe, 'moduleRegex', probe.moduleRegex, '') : null;
  const argv = await ctx.resolveArgv(probe.argv, cwd);
  const seconds = Number(probe.timeoutSec) > 0 ? Number(probe.timeoutSec) : 300;
  const r = await ctx.run({ command: argv[0], args: argv.slice(1), cwd, timeoutMs: seconds * 1000 });
  if (r.timedOut) throw new Error(`${tool} did not finish within ${seconds} s.`);
  if (r.error) throw new Error(`${tool} did not start: ${snippet(r.error.message || r.error)}`);
  if (r.truncated) throw new Error(`${tool} printed more output than the app reads; the graph is incomplete.`);
  if (r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    throw new Error(`${tool} exited with code ${r.code}${why ? `: ${snippet(why)}` : '.'}`);
  }
  const raw = parseGraph(r.stdout, tool);
  if (!Object.keys(raw).length) throw new Error(`${tool} found no files; check the probe's cwd and source folder.`);
  const base = await graphBase(raw, probe, cwd, ctx);
  if (moduleRe && base === null) {
    throw new Error(`The ${tool} graph paths were not found under ${cwd}, so its modules can't be read. Pass --basedir to set the base folder.`);
  }
  const graph = rebaseGraph(raw, base || '');
  const inTree = p => (cwd === '.' ? p : posix.normalize(posix.join(cwd, p)));
  const files = Object.keys(graph);
  const known = new Set(files);
  let partial = 0;
  for (const f of files) for (const d of graph[f]) if (!known.has(d)) partial++;
  const fileCycles = cyclesOf(graph);
  let largest = [];
  let modules = 0;
  if (moduleRe) {
    const mg = moduleGraph(graph, moduleRe);
    modules = Object.keys(mg).length;
    if (!modules) {
      throw new Error(`moduleRegex matched no file in the ${tool} graph. Paths are read relative to ${cwd}, for example ${files.slice().sort()[0]}.`);
    }
    largest = cyclesOf(mg)[0] || [];
  }
  const extra = {
    largestModuleCycle: largest.length,
    modules,
    files: files.length,
    filesInCycles: fileCycles.reduce((n, c) => n + c.length, 0),
    largestModules: largest.slice(0, 100),
  };
  if (partial) extra.partial = partial;
  // Without moduleRegex the file cycle count stands on its own; only the detail paths may be off.
  if (base === null) {
    extra.warning = `The ${tool} graph paths were not found under ${cwd}, so the cycle paths may be wrong. Pass --basedir to set the base folder.`;
  }
  return {
    value: fileCycles.length,
    display: probe.moduleRegex ? `${largest.length} of ${modules} modules` : plural(fileCycles.length, 'file cycle'),
    extra,
    details: fileCycles.map(c => ({
      path: inTree(c[0]),
      line: 0,
      text: `cycle of ${c.length} files: ${c.slice(0, 6).join(', ')}${c.length > 6 ? ', …' : ''}`,
    })),
  };
}

export const KINDS = {
  routerKeys,
  missingAssert,
  regexCount,
  windowRegex,
  cycles,
  deepImports,
  publicTs,
  localeParity,
  expoParity,
};
