// Stage gates: what the tests Claude wrote in the prove stage must show before anyone edits code.
//
// - Gate B, pins (Refactor): every characterization test Claude listed exists, is new or in the
//   plan, ran on the unchanged source (the prove stage changed test files only), shows up in the
//   TAP output as executed, and passes. Each test file's sha256 is recorded, so the checks after
//   the edit can prove the pins stayed byte-identical (pinsIntact) and green.
// - Gate B, red (Fix, Debug, Feature acceptance tests): every listed test fails on the unchanged
//   source with an assertion failure (not a crash, timeout or import error), and its id is not a
//   known failure in the baseline. After the edit, redNowPasses() proves they pass.
// - Denial test (tenant paths): when a change touches tenant risk paths, at least one changed test
//   file must check a denial and that nothing happened. A heuristic, labelled as one.
//
// TAP results are parseTap() output (gates/tap.mjs): {tests: [{id, file, status, failure}], counts}.
// A test id is "<file relative to the command's cwd>::<names joined by ' > '>", so a listed test
// {path, name} is found by its file (suffix match, as the TAP file is relative to the workspace)
// and its name (the full name, its last part, or a trailing part of it). When two entries match
// equally well, the test is "ambiguous" and fails its gate rather than borrowing another result.
import { createHash } from 'node:crypto';
import { normalizeChanged, normPath, planPaths, toRegExp } from './fences.mjs';

export const DENIAL_RE = /(FORBIDDEN|UNAUTHORIZED|NOT_A_MEMBER|denied|rejects)/;
export const NO_SIDE_EFFECT_RE = /(not called|toHaveBeenCalledTimes\(0\)|calls\.length,\s*0|unchanged)/;
const DEFAULT_TEST_RE = /\.(?:test|spec|integration)\.[cm]?[jt]sx?$/;
const SEP = ' > ';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// "sha256:ABC" and "abc" compare equal.
const normHash = h => String(h ?? '').replace(/^sha256:/i, '').toLowerCase();

// The listed tests of a tests.v1 output (or a plain array): [{path, name, proves}].
function listedTests(tests) {
  const list = Array.isArray(tests) ? tests : Array.isArray(tests?.tests) ? tests.tests : [];
  return list.filter(t => t && t.path && t.name).map(t => ({ path: normPath(t.path), name: String(t.name).trim(), proves: t.proves || '' }));
}

// The tests of a TAP result as an array.
export function tapTests(tap) {
  const t = tap?.tests;
  if (Array.isArray(t)) return t;
  if (t && typeof t === 'object') return Object.entries(t).map(([id, v]) => ({ id, ...v }));
  return [];
}

function tapFile(t) {
  if (t.file) return normPath(t.file);
  const id = String(t.id || '');
  return id.includes('::') ? normPath(id.slice(0, id.indexOf('::'))) : '';
}

function tapName(t) {
  const id = String(t.id || '');
  if (id.includes('::')) return id.slice(id.indexOf('::') + 2);
  if (Array.isArray(t.path)) return t.path.join(SEP);
  return String(t.name || '');
}

// One path ends with the other at a folder boundary ("src/a.test.ts" and "apps/web/src/a.test.ts").
function samePathish(a, b) {
  const x = normPath(a).toLowerCase(), y = normPath(b).toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// Looks a listed test up in the TAP result: {hit, ambiguous}. A file with the exact path wins over
// a suffix match, and an exact full name over a trailing part of it, over its last part. When
// more than one entry matches at the first level that has a match (two workspaces with the same
// cwd-relative file and test name, or two describe blocks ending in the same name), the test
// can't be told apart: hit is null and `ambiguous` lists the ids, so no gate judges a pin by
// another test's result.
export function lookupTest(tap, path, name) {
  const want = String(name || '').trim();
  const all = tapTests(tap);
  const exact = all.filter(t => normPath(tapFile(t)).toLowerCase() === normPath(path).toLowerCase());
  const full = t => tapName(t).trim();
  const tiers = [t => full(t) === want, t => full(t).endsWith(`${SEP}${want}`), t => full(t).split(SEP).pop() === want];
  for (const inFile of [exact, all.filter(t => samePathish(tapFile(t), path))]) {
    for (const tier of tiers) {
      const hits = inFile.filter(tier);
      if (hits.length === 1) return { hit: hits[0], ambiguous: null };
      if (hits.length > 1) return { hit: null, ambiguous: hits.map(t => String(t.id || `${tapFile(t)}::${tapName(t)}`)) };
    }
  }
  return { hit: null, ambiguous: null };
}

// The TAP entry for a listed test, or null when it is missing or ambiguous (see lookupTest).
export function findTest(tap, path, name) {
  return lookupTest(tap, path, name).hit;
}

// The status of a listed test in a TAP result: testStatus of its entry, or 'ambiguous'.
function listedStatus(tap, path, name) {
  const r = lookupTest(tap, path, name);
  return r.ambiguous ? 'ambiguous' : testStatus(r.hit);
}

// pass | fail | skip | todo | unknown.
export function testStatus(t) {
  if (!t) return 'missing';
  const s = String(t.status || '').toLowerCase();
  if (['pass', 'fail', 'skip', 'todo'].includes(s)) return s;
  const d = String(t.directive || '').toLowerCase();
  if (t.skip || d === 'skip') return 'skip';
  if (t.todo || d === 'todo') return 'todo';
  if (t.ok === true) return 'pass';
  if (t.ok === false) return 'fail';
  return 'unknown';
}

function failureKind(t) {
  return String(t?.failure?.kind || t?.kind || t?.failureKind || 'other');
}

// Every failure id the baseline knows (all commands).
export function baselineIds(baseline) {
  const ids = new Set();
  if (!baseline) return ids;
  if (baseline instanceof Set || Array.isArray(baseline)) {
    for (const x of baseline) ids.add(String(typeof x === 'string' ? x : x?.id).toLowerCase());
    return ids;
  }
  for (const cmd of Object.values(baseline.commands || {})) {
    for (const f of cmd?.failures || []) if (f?.id) ids.add(String(f.id).toLowerCase());
  }
  return ids;
}

async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

// Gate B. Required: kind, tests (tests.v1), runFiles(paths) -> TAP result, readAtBase(path) ->
// text or null, sha256(path) -> hash or null. Also used when given (the spec signature leaves
// them out, so without them those checks are listed in `notChecked`):
//   changed      the tree's changes against base, to prove the source is unchanged;
//   plan         run.plan, for "existing tests must be in the plan";
//   testPattern  fences.testPattern, to tell test files from source files.
// Returns {ok, kind, problems, notChecked, perTest: [{path, name, status, failureKind, ok,
// reason}], pins | redTests, counts}.
export async function gateB({ kind, tests, runFiles, baseline = null, readAtBase, sha256, changed = null, plan = null, testPattern = null } = {}) {
  if (kind !== 'pins' && kind !== 'red') throw new Error(`Gate B needs kind "pins" or "red", not "${kind}".`);
  const list = listedTests(tests);
  const problems = [], notChecked = [];
  if (!list.length) problems.push('The prove stage listed no tests.');

  const testRe = toRegExp(testPattern, 'fences.testPattern') || (changed ? DEFAULT_TEST_RE : null);
  if (changed) {
    // A rename counts as a source change when either side is not a test file.
    const source = normalizeChanged(changed).filter(c => !testRe.test(c.path) || (c.status === 'R' && c.oldPath && !testRe.test(c.oldPath)));
    if (source.length) problems.push(`The prove stage changed files that are not tests: ${source.map(c => c.path).join(', ')}. Tests must run on the unchanged source.`);
  } else notChecked.push('that only test files changed (no change list was given)');

  const planned = planPaths(plan);
  const files = [...new Set(list.map(t => t.path))];
  const hashes = {};
  for (const p of files) {
    const h = await safe(() => sha256(p));
    if (!h) { problems.push(`${p} does not exist in the tree.`); continue; }
    hashes[p] = normHash(h);
    const atBase = await safe(() => readAtBase(p));
    if (atBase === null || atBase === undefined) continue;          // a new file
    if (plan) { if (!planned.has(p.toLowerCase())) problems.push(`${p} existed at base and is not in the plan.`); }
    else notChecked.push(`that ${p} is in the plan (no plan was given)`);
  }

  const tap = files.length ? await runFiles(files) : { tests: [] };
  const ids = baselineIds(baseline);
  const perTest = list.map(t => judge(kind, t, lookupTest(tap, t.path, t.name), ids));
  for (const r of perTest) if (!r.ok) problems.push(r.reason);

  const result = { ok: !problems.length, kind, problems, notChecked, perTest, counts: tap?.counts || null };
  if (kind === 'pins') {
    result.pins = files.filter(p => hashes[p]).map(p => ({ path: p, sha256: hashes[p], tests: list.filter(t => t.path === p).map(t => t.name) }));
  } else {
    result.redTests = list.map(t => ({ path: t.path, name: t.name, baseKind: 'assertion' }));
  }
  return result;
}

// The verdict for one listed test against its TAP lookup ({hit, ambiguous}).
function judge(kind, t, { hit, ambiguous }, ids) {
  const base = { path: t.path, name: t.name };
  if (ambiguous) {
    return { ...base, status: 'ambiguous', ok: false, ambiguous,
      reason: `${t.path}: "${t.name}" matches ${ambiguous.length} tests in the TAP output (${ambiguous.slice(0, 3).join('; ')}), so its result can't be told apart; give it a unique name.` };
  }
  if (!hit) return { ...base, status: 'missing', ok: false, reason: `${t.path}: "${t.name}" did not run (it is not in the TAP output).` };
  const status = testStatus(hit);
  const out = { ...base, id: hit.id || null, status };
  if (status === 'skip' || status === 'todo') return { ...out, ok: false, reason: `${t.path}: "${t.name}" was marked ${status}, so it never ran.` };
  if (kind === 'pins') {
    return status === 'pass'
      ? { ...out, ok: true, reason: '' }
      : { ...out, ok: false, reason: `${t.path}: "${t.name}" fails on the unchanged code; a pin must pass before the edit.` };
  }
  if (status === 'pass') return { ...out, ok: false, reason: `${t.path}: "${t.name}" passes on the unchanged code; a red test must fail first.` };
  const fk = failureKind(hit);
  out.failureKind = fk;
  if (fk !== 'assertion') return { ...out, ok: false, reason: `${t.path}: "${t.name}" fails with a ${fk} failure, not an assertion; it must fail for the reason it tests.` };
  if (hit.id && ids.has(String(hit.id).toLowerCase())) return { ...out, ok: false, reason: `${t.path}: "${t.name}" is already a known failure in the baseline.` };
  return { ...out, ok: true, reason: '' };
}

// After the edit: every pinned file is byte-identical and every pinned test passes.
// readBytes(path) returns a Buffer or string (or null when gone). Returns {ok, changed:
// [{path, before, after}], failed: [{path, name, status}]}.
export async function pinsIntact({ pins, readBytes, tap }) {
  const changed = [], failed = [];
  for (const pin of pins || []) {
    const bytes = await safe(() => readBytes(pin.path));
    const after = bytes === null || bytes === undefined ? null : sha256Hex(bytes);
    if (after !== normHash(pin.sha256)) changed.push({ path: pin.path, before: normHash(pin.sha256), after });
    for (const name of pin.tests || []) {
      const status = tap ? listedStatus(tap, pin.path, name) : 'not run';
      if (status !== 'pass') failed.push({ path: pin.path, name, status });
    }
  }
  return { ok: !changed.length && !failed.length, changed, failed };
}

// After the edit: every red test now passes. Returns {ok, stillFailing: [{path, name, status}],
// failed} (`failed` is the same list, the name the executor reads).
export function redNowPasses({ redTests, tap }) {
  const stillFailing = [];
  for (const t of redTests || []) {
    const status = tap ? listedStatus(tap, t.path, t.name) : 'not run';
    if (status !== 'pass') stillFailing.push({ path: t.path, name: t.name, status });
  }
  return { ok: !stillFailing.length, stillFailing, failed: stillFailing };
}

// Tenant paths changed, so a changed or added test must show a denial with no side effect.
// riskHits: profile.riskTags(...).hits ([{path, tag, glob}]) or the whole riskTags result.
// readAtHead(path) returns the text or null. Returns {ok, required, files, heuristic: true, reason}.
export async function denialTestPresent({ changed, readAtHead, riskHits, testPattern = null }) {
  const hits = Array.isArray(riskHits) ? riskHits : Array.isArray(riskHits?.hits) ? riskHits.hits : [];
  const tenant = hits.filter(h => h && h.tag === 'tenant');
  if (!tenant.length) return { ok: true, required: false, files: [], heuristic: true, reason: 'No tenant paths changed.' };
  const re = toRegExp(testPattern, 'fences.testPattern') || DEFAULT_TEST_RE;
  const files = [];
  for (const c of normalizeChanged(changed)) {
    if (c.status === 'D' || !re.test(c.path)) continue;
    const text = await safe(() => readAtHead(c.path));
    if (typeof text === 'string' && DENIAL_RE.test(text) && NO_SIDE_EFFECT_RE.test(text)) files.push(c.path);
  }
  const ok = files.length > 0;
  return {
    ok, required: true, files, heuristic: true,
    reason: ok
      ? `Denial test found in ${files.join(', ')} (heuristic).`
      : `Tenant paths changed (${tenant.map(h => h.path).slice(0, 3).join(', ')}), but no changed test checks a denial and that nothing happened (heuristic: a test file needs a denial word such as FORBIDDEN or UNAUTHORIZED, and an assertion such as "not called" or toHaveBeenCalledTimes(0)).`,
  };
}
