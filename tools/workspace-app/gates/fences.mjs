// Fences: which changed files a run may touch. Part of G0, and the reason the fence gate stops.
//
// The app, not Claude, decides whether a change stays inside its approved plan. Every changed path
// lands in exactly one bucket, checked in this order:
//
//   forbidden            matches fences.forbidden, or fences.forbiddenExisting and existed at base
//                        (an existing migration). Always fails; nobody can allow it.
//   mustTick             matches fences.mustTick, or fences.mustTickNew and is new, and was not
//                        ticked at the plan gate. Fails: "tick it at the plan gate".
//   pinnedChanged        an existing fences.pinned file (contract tests) that plan.files doesn't
//                        list. Fails; pinned tests stay byte-identical. Only plan.files counts
//                        here: you see those at the plan gate and can remove them, while a
//                        slice's `tests` list is Claude's and can't be edited there.
//   existingTestChanged  an existing test (fences.testPattern) the plan doesn't list (its files
//                        or its slice tests, which the plan prompts call "the test files it adds
//                        or changes"). Fails, and the review gate shows it in red.
//   outsidePlan          anything else not in the plan, not ticked, not always allowed, not
//                        allowed by you earlier and not a new test file. The only bucket the fence
//                        gate can allow, by your click.
//
// A rename counts twice: the old path as an existing file that changed, the new path as a new one.
// For the read-only pipelines (review, check) only forbidden and mustTick are reported, as
// information. Path matching ignores case, like Windows does, so `.ENV` is still `.env`.
import { firstMatch, toPosix } from '../core/glob.mjs';

export const BUCKETS = ['forbidden', 'mustTick', 'pinnedChanged', 'existingTestChanged', 'outsidePlan'];
export const HARD_BUCKETS = ['forbidden', 'mustTick', 'pinnedChanged', 'existingTestChanged'];
export const READ_ONLY_PIPELINES = ['review', 'check'];
// Claude Code refuses edits here under --restricted, even with acceptEdits (ADDENDUM A6).
const STAGE_PROTECTED_RE = /(?:^|\/)\.(?:claude|git|husky|vscode)(?:\/|$)|(?:^|\/)\.mcp\.json$/i;
export const TAKEOVER_NOTE = 'Claude Code protects this path in headless stages: edit it in Take over.';
const NOCASE = { nocase: true };

// "a\b\c" or "./a/b" -> "a/b/c".
export function normPath(p) {
  return toPosix(String(p ?? '').trim());
}

// A RegExp from a profile pattern (a string or a RegExp), without the g or y flag, so test() has
// no state between calls.
export function toRegExp(pattern, what = 'pattern') {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  if (typeof pattern !== 'string' || !pattern) return null;
  try { return new RegExp(pattern); } catch (e) { throw new Error(`The ${what} "${pattern}" is not a valid regular expression: ${e.message}`); }
}

// The change list in one shape: [{path, status: 'A'|'M'|'D'|'R', oldPath}] with clean paths.
// Git's other letters map like core/git does: C (copy) and ? (untracked) are new files, T and U
// are modifications. A bare path (or an entry without a status) becomes {path, status: 'M',
// unknown: true}: checkFences then asks existsAtBase whether it is new.
export function normalizeChanged(changed) {
  const out = [];
  for (const raw of Array.isArray(changed) ? changed : []) {
    const c = typeof raw === 'string' ? { path: raw } : raw;
    if (!c || !c.path) continue;
    const unknown = !c.status;
    const letter = String(c.status || 'M').trim().toUpperCase()[0] || 'M';
    const status = letter === 'R' ? 'R' : letter === 'A' || letter === 'C' || letter === '?' ? 'A' : letter === 'D' ? 'D' : 'M';
    const entry = { path: normPath(c.path), status };
    if (c.oldPath) entry.oldPath = normPath(c.oldPath);
    if (unknown) entry.unknown = true;
    out.push(entry);
  }
  return out;
}

// Each path a change touches: [{path, status, isNew, deleted, unknown?}]. A rename gives its old
// path (deleted, existed) and its new path (new). A copy's source is unchanged, so only the copy
// counts.
export function touchedPaths(changed) {
  const out = [];
  for (const c of normalizeChanged(changed)) {
    if (c.status === 'R') {
      if (c.oldPath) out.push({ path: c.oldPath, status: 'R', isNew: false, deleted: true });
      out.push({ path: c.path, status: 'R', isNew: true, deleted: false });
    } else {
      const t = { path: c.path, status: c.status, isNew: c.status === 'A', deleted: c.status === 'D' };
      if (c.unknown) t.unknown = true;
      out.push(t);
    }
  }
  return out;
}

// A case-insensitive path set.
function pathSet(list) {
  const set = new Set();
  for (const p of list || []) {
    const s = typeof p === 'string' ? p : p && p.path;
    if (s) set.add(normPath(s).toLowerCase());
  }
  return set;
}

const has = (set, p) => set.has(p.toLowerCase());

// existsAtBase may be a function (path) => boolean, a Set or an array of paths. The function
// must answer at once: a Promise is always truthy, so it would make every new file look old.
function existsFn(existsAtBase) {
  if (typeof existsAtBase === 'function') {
    return p => {
      const r = existsAtBase(p);
      if (r && typeof r.then === 'function') {
        Promise.resolve(r).catch(() => {});
        throw new Error('existsAtBase must answer at once; pass a Set or an array of the base paths, or a function that returns true or false.');
      }
      return Boolean(r);
    };
  }
  if (existsAtBase && (existsAtBase instanceof Set || Array.isArray(existsAtBase))) {
    const set = pathSet([...existsAtBase]);
    return p => has(set, p);
  }
  return () => false;
}

function planSet(plan, lists) {
  if (!plan) return new Set();
  const removed = pathSet(plan.removedFiles);
  const all = lists.flatMap(l => plan[l] || []).map(p => (typeof p === 'string' ? p : p && p.path)).filter(Boolean);
  return pathSet(all.filter(p => !has(removed, normPath(p))));
}

// The paths the approved plan covers: its files and tests, minus the files you removed from it.
export function planPaths(plan) {
  return planSet(plan, ['files', 'tests']);
}

// Only the plan's files, minus removed ones: the list you saw and could edit at the plan gate.
export function planFilePaths(plan) {
  return planSet(plan, ['files']);
}

// True when Claude Code lets a headless stage edit the path (ADDENDUM A6).
export function editableInStage(path) {
  return !STAGE_PROTECTED_RE.test(normPath(path));
}

// Each of `paths` (strings or {path, status}) as {path, existed}: true or false when known, null
// when there is no status and no existsAtBase. M, D, R and T mean the file was there; a new one
// (A, C, ?) is still checked against existsAtBase when given, like checkFences does.
function planGateItems(paths, existsAtBase) {
  const exists = existsAtBase ? existsFn(existsAtBase) : null;
  const out = [];
  for (const item of paths || []) {
    const path = normPath(typeof item === 'string' ? item : item && item.path);
    if (!path) continue;
    const letter = typeof item === 'string' ? '' : String(item?.status || '').trim().toUpperCase()[0] || '';
    const isNew = ['A', 'C', '?'].includes(letter);
    const existed = letter && !isNew ? true : exists ? exists(path) : isNew ? false : null;
    out.push({ path, existed });
  }
  return out;
}

// The forbidden glob a path hits, or null: fences.forbidden, or fences.forbiddenExisting when the
// file existed at base (existed === true).
function forbiddenGlob(f, path, existed) {
  const forb = firstMatch(f.forbidden, path, NOCASE);
  if (forb) return { glob: forb };
  const old = existed === true ? firstMatch(f.forbiddenExisting, path, NOCASE) : null;
  return old ? { glob: old, existing: true } : null;
}

// The files among `paths` that must be ticked at the plan gate. `paths` are strings or
// {path, status}. Pass {existsAtBase} (a Set or an array of the base paths, or a sync function)
// so a string path that already exists is not treated as new; without it a string may be new,
// so mustTickNew applies to it too. A file that is forbidden anyway (an existing migration, a
// vendored file) is never offered: ticking it can't help. forbiddenFiles() lists those.
export function mustTickFiles(profile, paths, { existsAtBase = null } = {}) {
  const f = profile?.fences || {};
  const out = new Set();
  for (const { path, existed } of planGateItems(paths, existsAtBase)) {
    if (forbiddenGlob(f, path, existed)) continue;
    const isNew = existed !== true;
    if (firstMatch(f.mustTick, path, NOCASE) || (isNew && firstMatch(f.mustTickNew, path, NOCASE))) out.add(path);
  }
  return [...out].sort();
}

// The files among `paths` a run may never change, for the plan gate to flag before anyone
// approves: [{path, glob, reason}], sorted. Same inputs as mustTickFiles; forbiddenExisting counts
// only for files known to exist at base.
export function forbiddenFiles(profile, paths, { existsAtBase = null } = {}) {
  const f = profile?.fences || {};
  const seen = new Set();
  const out = [];
  for (const { path, existed } of planGateItems(paths, existsAtBase)) {
    const hit = forbiddenGlob(f, path, existed);
    if (!hit || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    out.push({ path, glob: hit.glob, reason: reasonFor('forbidden', path, hit) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function reasonFor(bucket, path, glob) {
  switch (bucket) {
    case 'forbidden': return glob.existing
      ? `${path} existed at base and may never change in a run (${glob.glob}).`
      : `${path} is forbidden in a run (${glob.glob}).`;
    case 'mustTick': return `${path} is a config or risk file that was not ticked (${glob.glob}); tick it at the plan gate.`;
    case 'pinnedChanged': return `${path} is a pinned test the plan's files don't list; it must stay byte-identical.`;
    case 'existingTestChanged': return `${path} is an existing test the plan doesn't list; existing tests change only when the plan names them.`;
    default: return `${path} is outside the approved plan; allow it at the fence gate or send it back.`;
  }
}

// Sorts one touched path into its bucket. Returns {bucket, glob} or {bucket: null, why}, where
// `why` says how the path is covered (plan, ticked, alwaysAllowed, newTest, allowedByYou).
function classify(t, ctx) {
  const { f, existed, readOnly, plan, planFiles, ticked, allowed, testRe } = ctx;
  const p = t.path;
  const forb = forbiddenGlob(f, p, existed);
  if (forb) return { bucket: 'forbidden', glob: forb };
  const tick = firstMatch(f.mustTick, p, NOCASE) || (t.isNew ? firstMatch(f.mustTickNew, p, NOCASE) : null);
  if (tick && !has(ticked, p)) return { bucket: 'mustTick', glob: { glob: tick } };
  if (readOnly) return { bucket: null, why: 'info' };
  const inPlan = has(plan, p);
  const isTest = Boolean(testRe && testRe.test(p));
  if (existed && !has(planFiles, p) && firstMatch(f.pinned, p, NOCASE)) return { bucket: 'pinnedChanged', glob: {} };
  if (existed && isTest && !inPlan) return { bucket: 'existingTestChanged', glob: {} };
  if (inPlan) return { bucket: null, why: 'plan' };
  if (has(ticked, p)) return { bucket: null, why: 'ticked' };
  if (firstMatch(f.alwaysAllowed, p, NOCASE)) return { bucket: null, why: 'alwaysAllowed' };
  if (t.isNew && !existed && isTest) return { bucket: null, why: 'newTest' };
  if (has(allowed, p)) return { bucket: null, why: 'allowedByYou' };
  return { bucket: 'outsidePlan', glob: {} };
}

// Sorts every changed path into a bucket.
// Returns {ok, hardFail, needsYou, readOnly, forbidden, mustTick, pinnedChanged,
//          existingTestChanged, outsidePlan, allowedByUser, scope: {inPlan, total,
//          allowedByUser, outside}, messages}. Bucket entries are {path, status, glob?, reason}.
// `ok` is true when nothing fails and nothing waits for you; read-only pipelines are always ok.
export function checkFences({ profile, changed, plan = null, ticked = [], allowances = [], existsAtBase = null, pipeline = '' } = {}) {
  const f = profile?.fences || {};
  const readOnly = READ_ONLY_PIPELINES.includes(pipeline);
  const exists = existsFn(existsAtBase);
  const ctx = {
    f, readOnly,
    plan: planPaths(plan),
    planFiles: planFilePaths(plan),
    ticked: pathSet([...(ticked || []), ...(plan?.ticked || [])]),
    allowed: pathSet(allowances),
    testRe: toRegExp(f.testPattern, 'fences.testPattern'),
  };
  const out = { forbidden: [], mustTick: [], pinnedChanged: [], existingTestChanged: [], outsidePlan: [] };
  const allowedByUser = [];
  const seen = new Set();
  let inPlan = 0;
  for (const touched of touchedPaths(changed)) {
    const key = touched.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A path without a status existed unless existsAtBase says otherwise (the stricter reading).
    const existed = touched.unknown ? (existsAtBase ? exists(touched.path) : true) : (!touched.isNew || exists(touched.path));
    const t = touched.unknown ? { ...touched, isNew: !existed } : touched;
    const r = classify(t, { ...ctx, existed });
    if (r.bucket) {
      const entry = { path: t.path, status: t.status, reason: reasonFor(r.bucket, t.path, r.glob) };
      if (r.glob.glob) entry.glob = r.glob.glob;
      out[r.bucket].push(entry);
    } else {
      if (r.why === 'allowedByYou') allowedByUser.push(t.path);
      else if (r.why !== 'info') inPlan++;
    }
  }
  const hardFail = !readOnly && HARD_BUCKETS.some(b => out[b].length);
  const needsYou = !readOnly && out.outsidePlan.length > 0;
  const messages = BUCKETS.flatMap(b => out[b].map(e => e.reason));
  return {
    ok: readOnly || (!hardFail && !needsYou),
    hardFail,
    needsYou,
    readOnly,
    ...out,
    allowedByUser,
    scope: { inPlan, total: seen.size, allowedByUser, outside: out.outsidePlan.map(e => e.path) },
    messages,
  };
}

// One line for the G0 row: "Pass", "Pass, 1 allowed by you", "2 files outside the plan need
// your OK", or the failing buckets.
export function fenceSummary(fence) {
  if (!fence) return '';
  const n = (k, one, many) => `${fence[k].length} ${fence[k].length === 1 ? one : many}`;
  if (fence.readOnly) {
    const parts = [];
    if (fence.forbidden.length) parts.push(n('forbidden', 'forbidden file', 'forbidden files'));
    if (fence.mustTick.length) parts.push(n('mustTick', 'config or risk file', 'config or risk files'));
    return parts.length ? `Information: ${parts.join(', ')} changed` : 'Pass';
  }
  const parts = [];
  if (fence.forbidden.length) parts.push(n('forbidden', 'forbidden file', 'forbidden files'));
  if (fence.mustTick.length) parts.push(n('mustTick', 'unticked config or risk file', 'unticked config or risk files'));
  if (fence.pinnedChanged.length) parts.push(n('pinnedChanged', 'pinned test changed', 'pinned tests changed'));
  if (fence.existingTestChanged.length) parts.push(n('existingTestChanged', 'existing test changed', 'existing tests changed'));
  if (parts.length) return parts.join(', ');
  if (fence.outsidePlan.length) return `${n('outsidePlan', 'file outside the plan needs', 'files outside the plan need')} your OK`;
  return fence.allowedByUser.length ? `Pass, ${fence.allowedByUser.length} allowed by you` : 'Pass';
}
