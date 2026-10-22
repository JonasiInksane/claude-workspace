// Ratchets: numbers a change may keep or improve, never make worse. Part of G0.
//
// - Tests: no changed test file ends with fewer tests than it had at base, and no added line
//   skips, focuses or postpones a test (.skip, .only, .todo, { skip: true }, t.skip(), ...).
//   A deleted test file loses all of its tests. Counting is a regex heuristic applied the same
//   way to base and head, so the comparison is fair even where the count itself is rough.
// - Metrics: architecture counts such as import cycles and deep imports don't go up. Lower is
//   better unless the metric is listed in `higherIsBetter`.
// - Allowlist: every procedure outside the guarded builders is on the allowlist you approved.
//   Without an allowlist the ratchet reports `notSetUp` and passes.
//
// "Added lines" are found without a diff: a head line is added when no identical line (ignoring
// indentation) is left over at base, so moved lines don't count and the result doesn't depend on
// how a diff tool aligns hunks.
import { normalizeChanged, toRegExp } from './fences.mjs';

// test( and it(, with .skip/.only/.todo (the spec's counting rule).
const TEST_CALL_RE = /\b(?:test|it)(?:\.(skip|only|todo))?\s*\(/g;
// Options that skip, focus or postpone: { skip: true }, { only: true }, { todo: 'later' }.
const OPTION_RE = /\b(skip|only|todo)\s*:\s*(?:true\b|['"`])/g;
// What makes an added line a new skip: the calls above plus describe/suite variants and t.skip().
const SKIP_LINE_RES = [
  [/\b(?:test|it|describe|suite)\.(skip|only|todo)\s*\(/g, 1],
  [/\bt\.(skip|todo)\s*\(/g, 1],
  [OPTION_RE, 1],
];

// Counts tests in a source text: {tests, skip, only, todo}. `tests` counts every test( or it(
// call, skipped or not; the other three count the calls and options of that kind.
export function countTests(src) {
  const text = String(src ?? '');
  const out = { tests: 0, skip: 0, only: 0, todo: 0 };
  for (const m of text.matchAll(TEST_CALL_RE)) {
    out.tests++;
    if (m[1]) out[m[1]]++;
  }
  for (const m of text.matchAll(OPTION_RE)) out[m[1]]++;
  return out;
}

// The kinds of skip on one line: ['skip', 'only', ...] (empty for a normal line).
export function skipKinds(line) {
  const kinds = [];
  for (const [re, group] of SKIP_LINE_RES) {
    for (const m of String(line).matchAll(re)) kinds.push(m[group]);
  }
  return kinds;
}

// Lines of `after` that are not in `before`: [{line (1-based), text}].
export function addedLines(before, after) {
  const left = new Map();
  for (const l of String(before ?? '').split(/\r?\n/)) {
    const k = l.trim();
    left.set(k, (left.get(k) || 0) + 1);
  }
  const out = [];
  String(after ?? '').split(/\r?\n/).forEach((l, i) => {
    const k = l.trim();
    const n = left.get(k) || 0;
    if (n > 0) left.set(k, n - 1);
    else out.push({ line: i + 1, text: l });
  });
  return out;
}

// Checks every changed test file. readAtBase(path) and readAtHead(path) return the text or null
// (sync or async). Returns {ok, lost: [{path, before, after}], newSkips: [{path, kind, line}],
// files: [{path, before, after}]}.
export async function testRatchet({ changed, readAtBase, readAtHead, testPattern }) {
  const re = toRegExp(testPattern, 'fences.testPattern');
  if (!re) throw new Error('The profile has no fences.testPattern, so test files cannot be recognised.');
  const lost = [], newSkips = [], files = [];
  for (const c of normalizeChanged(changed)) {
    const headPath = c.status === 'D' ? null : c.path;
    const basePath = c.status === 'A' ? null : (c.status === 'R' ? c.oldPath : c.path) || null;
    if (!(headPath && re.test(headPath)) && !(basePath && re.test(basePath))) continue;
    const before = basePath ? await readAtBase(basePath) : null;
    const after = headPath ? await readAtHead(headPath) : null;
    const b = countTests(before), a = countTests(after);
    const path = headPath || basePath;
    files.push({ path, before: b.tests, after: a.tests });
    if (before !== null && before !== undefined && a.tests < b.tests) lost.push({ path, before: b.tests, after: a.tests });
    for (const { line, text } of addedLines(before, after)) {
      for (const kind of skipKinds(text)) newSkips.push({ path, kind, line });
    }
  }
  return { ok: !lost.length && !newSkips.length, lost, newSkips, files };
}

// A metric value from a values object: "deepImports" reads values.deepImports.value (or a plain
// number), "serverCycles.largestModuleCycle" reads that field. null when missing.
export function metricValue(values, metric) {
  const [id, ...rest] = String(metric).split('.');
  let v = values ? values[id] : undefined;
  if (rest.length) v = v && typeof v === 'object' ? v[rest.join('.')] : undefined;
  else if (v && typeof v === 'object') v = v.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Compares metrics between base and head values.
// Returns {ok, rows: [{metric, before, after, change, status: better|same|worse|missing}],
// worse: [rows], missing: [metric]}. A metric missing on either side can't be compared; it is
// reported and doesn't fail.
export function metricRatchet({ base, head, metrics = ['serverCycles', 'deepImports'], higherIsBetter = [] }) {
  const up = new Set(higherIsBetter);
  const rows = [];
  for (const metric of metrics) {
    const before = metricValue(base, metric), after = metricValue(head, metric);
    if (before === null || after === null) { rows.push({ metric, before, after, change: null, status: 'missing' }); continue; }
    const change = after - before;
    const worse = up.has(metric) || up.has(metric.split('.')[0]) ? change < 0 : change > 0;
    rows.push({ metric, before, after, change, status: change === 0 ? 'same' : worse ? 'worse' : 'better' });
  }
  const worse = rows.filter(r => r.status === 'worse');
  return { ok: !worse.length, rows, worse, missing: rows.filter(r => r.status === 'missing').map(r => r.metric) };
}

// A comparable key for a probe item: a string as is, an object by its id, "<module>.<key>",
// its name, or "<path>::<text>".
export function itemKey(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item);
  if (item.id) return String(item.id);
  if (item.module && item.key) return `${item.module}.${item.key}`;
  if (item.name) return String(item.name);
  if (item.key) return String(item.key);
  return `${item.path ?? ''}::${String(item.text ?? '').trim()}`;
}

// The list inside an allowlist: an array, or a file object with `list` (or `procedures`).
export function allowlistItems(allowlist) {
  if (Array.isArray(allowlist)) return allowlist;
  if (allowlist && typeof allowlist === 'object') {
    for (const k of ['list', 'procedures', 'items']) if (Array.isArray(allowlist[k])) return allowlist[k];
  }
  return null;
}

// Compares today's unguarded procedures with the approved allowlist.
// Returns {ok, added, removed, notSetUp}: `added` are not on the list (fail), `removed` are on
// the list but gone (the list can shrink; information only).
export function allowlistRatchet({ nonShopNow, allowlist }) {
  const list = allowlistItems(allowlist);
  if (!list) return { ok: true, added: [], removed: [], notSetUp: true };
  const now = [...new Set((nonShopNow || []).map(itemKey))].sort();
  const allowed = new Set(list.map(itemKey));
  const nowSet = new Set(now);
  const added = now.filter(k => !allowed.has(k));
  const removed = [...allowed].filter(k => !nowSet.has(k)).sort();
  return { ok: !added.length, added, removed, notSetUp: false };
}
