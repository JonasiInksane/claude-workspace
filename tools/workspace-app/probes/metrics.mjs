// Scan history and health numbers for one project: the metrics file, tiles, score and ratchet wins.
//
//   <dataDir>/metrics/<project>.json                    { version, project, scans: [...] } (last 200)
//   <dataDir>/metrics/<project>/<scanId>.details.json   { probeId: [{path, line, text}] } (last 20
//                                                       scans, at most 500 items per probe)
//   <dataDir>/wins/<project>.jsonl                      ratchet wins; fun/fun.mjs adds achievements
// Everything lives in the private data folder, never in the hub (the hub repo is public).
//
// A metric is named by a path into a scan's values: "deepImports" is values.deepImports.value,
// "serverCycles.largestModuleCycle" is values.serverCycles.largestModuleCycle. Two names are
// special: "knownFailures" is the known-failure count of the checks (passed in by the caller, or
// read from checks/<project>/history.jsonl by knownFailuresFrom), and
// "<probe>.nonShopVsAllowlist" compares a router-keys probe's non-shop list with the allowlist.
// Lower is better unless the profile's score entry (or the probe kind) says higherIsBetter.
// Wins and trends compare like with like: a changed probe definition (`rule`), a partial import
// graph or a probe warning on one side is not counted as progress, and a scan is compared only
// with a scan of an ancestor commit (so a branch switch is not a win).
import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, projectPaths, readJson, readJsonl, writeJsonAtomic } from '../core/datadir.mjs';

export const MAX_SCANS = 200;
export const DETAIL_SCANS = 20;
export const DETAILS_CAP = 500;
const SPARK_POINTS = 10;
const DAY_MS = 24 * 3600 * 1000;
const WIN_REPEAT_DAYS = 30;
const DETAILS_FILE_RE = /^(s-\d{6}-\d{6}(?:-\d+)?)\.details\.json$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
// How many earlier commits recordScan asks git about when it looks for the scan to compare with.
const ANCESTOR_TRIES = 10;
const SUB_LABELS = {
  largestModuleCycle: 'largest module cycle', modules: 'modules', max: 'worst locale', min: 'best locale',
  withBoundaryTest: 'with a boundary test', filesInCycles: 'files in cycles',
};

// ---------------------------------------------------------------- one writer per file

const queues = new Map();

// Runs fn after the previous write to the same file has finished, so two scans recorded at the
// same moment can't drop each other's line.
function serialize(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

// ---------------------------------------------------------------- reading values

const probeById = (profile, id) => ((profile && Array.isArray(profile.probes) ? profile.probes : []).find(p => p && p.id === id) || null);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// The number behind a metric path in a scan's values, or null.
export function metricValue(values, path) {
  if (!values || typeof path !== 'string' || !path) return null;
  const [id, ...rest] = path.split('.');
  let v = values[id];
  if (v === null || v === undefined) return null;
  if (isNum(v)) return rest.length ? null : v;
  if (!rest.length) return isNum(v.value) ? v.value : null;
  for (const k of rest) v = v && typeof v === 'object' ? v[k] : undefined;
  return isNum(v) ? v : null;
}

// The human name of a metric path: the probe label, plus the part for a sub-metric.
export function metricLabel(profile, path) {
  if (path === 'knownFailures') return 'Known test failures';
  const [id, ...rest] = String(path).split('.');
  const probe = probeById(profile, id);
  const base = (probe && probe.label) || id;
  const sub = rest.join('.');
  if (!sub) return base;
  if (sub === 'nonShopVsAllowlist') return 'Non-shop procedures';
  return `${base} (${SUB_LABELS[sub] || sub})`;
}

function measuresOf(profile, path) {
  if (path === 'knownFailures') return 'test failures already failing at the base commit (the check baseline)';
  const [id, sub] = String(path).split('.');
  if (sub === 'nonShopVsAllowlist') return 'router keys whose builder is not shop-scoped, compared with the allowlist';
  const probe = probeById(profile, id);
  return (probe && probe.measures) || '';
}

function higherIsBetter(profile, path, entry) {
  const cfg = profile && profile.score && profile.score[path];
  if (cfg && typeof cfg.higherIsBetter === 'boolean') return cfg.higherIsBetter;
  return !String(path).includes('.') && !!(entry && entry.higherIsBetter);
}

// ---------------------------------------------------------------- score

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

// One metric's share of the score: 1 at the target, 0 at the reference point (or beyond it).
export function partScore(now, target, ref, higher = false) {
  if (ref === target) return (higher ? now >= target : now <= target) ? 1 : 0;
  return clamp01(higher ? (now - ref) / (target - ref) : (ref - now) / (ref - target));
}

// 0-100 from the profile's `score` entries { weight, target, ref, higherIsBetter }:
// round(100 × Σ weight·part / Σ weight) over the metrics that have a value. Null when none has.
// opts.fallback(path) can give a value for a metric that has none in `values` (recordScan passes
// the last stored value of a probe that failed in this scan, so a broken probe can't raise the
// score by dropping out of it).
export function healthScore(profile, values, { fallback = null } = {}) {
  const cfgs = profile && profile.score && typeof profile.score === 'object' ? profile.score : {};
  let weights = 0;
  let sum = 0;
  for (const [path, cfg] of Object.entries(cfgs)) {
    if (path.startsWith('_') || !cfg || typeof cfg !== 'object') continue;
    const weight = cfg.weight === undefined ? 1 : Number(cfg.weight);
    const target = Number(cfg.target);
    const ref = Number(cfg.ref);
    let now = metricValue(values, path);
    if (now === null && typeof fallback === 'function') {
      const carried = fallback(path);
      now = isNum(carried) ? carried : null;
    }
    if (!(weight > 0) || !Number.isFinite(target) || !Number.isFinite(ref) || now === null) continue;
    sum += weight * partScore(now, target, ref, cfg.higherIsBetter === true);
    weights += weight;
  }
  return weights ? Math.round((100 * sum) / weights) : null;
}

// ---------------------------------------------------------------- wins

// The metrics a profile tracks (tiles, score and lenses); without a profile, every probe id.
function trackedMetrics(profile, values) {
  if (!profile) return Object.keys(values);
  const list = [...(profile.tiles || []), ...Object.keys(profile.score || {}), ...(profile.lenses || [])]
    .filter(p => typeof p === 'string' && !p.startsWith('_') && !p.endsWith('.nonShopVsAllowlist'));
  return list.length ? [...new Set(list)] : Object.keys(values);
}

// Metrics that improved from `prevValues` to `nextValues`, as wins-log lines:
// { at, kind: 'ratchet', metric, label, from, to, via }.
// A sub-metric that moved exactly like its probe's main value ("localeWeb.max" next to
// "localeWeb") is one win, not two.
export function detectWins(prevValues, nextValues, via = null, { profile = null, at = null } = {}) {
  if (!prevValues || !nextValues) return [];
  const when = at || new Date().toISOString();
  const wins = [];
  const logged = new Set();
  const paths = trackedMetrics(profile, nextValues).sort((a, b) => a.split('.').length - b.split('.').length);
  for (const path of paths) {
    const from = metricValue(prevValues, path);
    const to = metricValue(nextValues, path);
    if (from === null || to === null || from === to) continue;
    const id = path.split('.')[0];
    const a = prevValues[id] || {};
    const b = nextValues[id] || {};
    if (a.rule && b.rule && a.rule !== b.rule) continue;
    if (!!a.partial !== !!b.partial) continue;
    // A probe that warned about its own input (graph paths it couldn't place) proves nothing.
    if (a.warning || b.warning) continue;
    const better = higherIsBetter(profile, path, b) ? to > from : to < from;
    const key = `${id}|${from}|${to}`;
    if (!better || logged.has(key)) continue;
    logged.add(key);
    wins.push({ at: when, kind: 'ratchet', metric: path, label: metricLabel(profile, path), from, to, via: via || null });
  }
  return wins;
}

const winKey = w => (w.kind === 'ratchet' ? `ratchet|${w.metric}|${w.from}|${w.to}` : `${w.kind}|${w.id || ''}`);

// Appends wins to the wins log and returns the ones written. A ratchet win already logged with the
// same metric, from and to in the last 30 days is skipped (a commit and the scan after it would
// otherwise log the same win twice); other kinds (achievements) are logged once per id.
export async function appendWins(dataDir, project, wins) {
  const { wins: file } = projectPaths(dataDir, project);
  const list = (wins || []).filter(w => w && typeof w === 'object' && typeof w.kind === 'string');
  if (!list.length) return [];
  return serialize(file, async () => {
    const { rows } = await readJsonl(file);
    const since = Date.now() - WIN_REPEAT_DAYS * DAY_MS;
    const seen = new Set(rows
      .filter(r => r && (r.kind !== 'ratchet' || !(Date.parse(r.at) < since)))
      .map(winKey));
    const added = [];
    for (const w of list) {
      const k = winKey(w);
      if (seen.has(k)) continue;
      seen.add(k);
      await appendJsonl(file, w);
      added.push(w);
    }
    return added;
  });
}

// The latest wins-log lines, newest first.
export async function loadWins(dataDir, project, { limit = 50 } = {}) {
  const { rows } = await readJsonl(projectPaths(dataDir, project).wins);
  return rows.filter(r => r && typeof r === 'object').slice(-limit).reverse();
}

// ---------------------------------------------------------------- the metrics file

export async function loadMetrics(dataDir, project) {
  const { metrics } = projectPaths(dataDir, project);
  const doc = await readJson(metrics, null);
  if (!doc) return { version: 1, project, scans: [] };
  if (!Array.isArray(doc.scans)) throw new Error(`${metrics} has no scans list.`);
  return { ...doc, version: 1, project, scans: doc.scans.filter(s => s && typeof s === 'object' && s.values) };
}

// The details of one stored scan, or null when they were pruned (only the last 20 are kept).
export async function loadDetails(dataDir, project, scanId) {
  return readJson(projectPaths(dataDir, project).metricsDetails(scanId), null);
}

// "s-YYMMDD-HHMMSS" in local time, with "-2", "-3" ... when that second is taken already.
function scanIdFor(at, taken) {
  const t = Date.parse(at);
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = n => String(n).padStart(2, '0');
  const base = `s-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function capDetails(details) {
  const out = {};
  for (const [id, list] of Object.entries(details || {})) if (Array.isArray(list)) out[id] = list.slice(0, DETAILS_CAP);
  return out;
}

async function pruneDetails(dir, keepIds) {
  const keep = new Set(keepIds);
  let names = [];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names) {
    const m = DETAILS_FILE_RE.exec(name);
    if (m && !keep.has(m[1])) await rm(join(dir, name), { force: true });
  }
}

const knownFailureCount = kf => (isNum(kf) ? kf : kf && isNum(kf.value) ? kf.value : null);
const KNOWN_LEVELS = ['standard', 'paranoid', 'quick'];

// The known-failure count from the check history (checks/<project>/history.jsonl, one line per
// finished check level, written by gates/history.mjs), for the knownFailures tile and the score:
// { value, spark: [last 10], weekAgo, level, at }, or null before the first finished check.
// One level is used so the series compares like with like: standard when it has run, else
// paranoid, else quick. Refused, cancelled and broken runs don't count.
export async function knownFailuresFrom(dataDir, project) {
  const { rows } = await readJsonl(projectPaths(dataDir, project).checksHistory);
  const done = rows.filter(r => r && typeof r === 'object' && (r.result === 'pass' || r.result === 'fail')
    && r.counts && isNum(r.counts.known) && Number.isFinite(Date.parse(r.at)));
  if (!done.length) return null;
  const level = KNOWN_LEVELS.find(l => done.some(r => r.level === l)) || done[done.length - 1].level;
  const series = done.filter(r => r.level === level).map(r => ({ at: r.at, value: r.counts.known }));
  const last = series[series.length - 1];
  const { delta } = weekChange(series, false);
  return { value: last.value, spark: series.slice(-SPARK_POINTS).map(p => p.value), weekAgo: last.value - delta, level, at: last.at };
}

// The project's profile from the data folder, for callers of recordScan that don't pass one.
// Best effort: without a readable profile the scan is still saved, just without a score.
async function storedProfile(dataDir, project) {
  try {
    const { loadProfile } = await import('../profile/profile.mjs');
    const r = await loadProfile(dataDir, project);
    return r && r.exists && r.profile && typeof r.profile === 'object' ? r.profile : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the scan to compare with

// True when commit `older` is an ancestor of `newer` in the git checkout at `tree`, false when it
// is not, and null when git can't tell (not a checkout, or a commit this clone doesn't have).
export function gitIsAncestor(tree, older, newer) {
  if (typeof tree !== 'string' || !tree || !SHA_RE.test(String(older)) || !SHA_RE.test(String(newer))) return Promise.resolve(null);
  return new Promise(done => {
    execFile('git', ['-C', tree, 'merge-base', '--is-ancestor', older, newer], { windowsHide: true, timeout: 10000 },
      err => done(!err ? true : err.code === 1 ? false : null));
  });
}

// The earlier scan a new scan is compared with for wins, or null. With a way to ask git, it is
// the latest scan of an ancestor commit (at most ANCESTOR_TRIES commits are asked about), so
// switching branches or checking out an older commit never counts as progress. Without one, it
// is the latest scan that knows its commit, unless the two scans name different branches. Either
// way a commit that was scanned before logs no wins: it was compared the first time.
async function compareBase(earlier, entry, isAncestor) {
  if (!entry.sha) return null;
  const withSha = earlier.filter(s => s.sha).reverse();
  if (!isAncestor) {
    const prev = withSha[0];
    if (!prev || prev.sha === entry.sha) return null;
    return prev.branch && entry.branch && prev.branch !== entry.branch ? null : prev;
  }
  const asked = new Set();
  for (const s of withSha) {
    if (s.sha === entry.sha) return null;
    if (asked.has(s.sha)) continue;
    if (asked.size >= ANCESTOR_TRIES) return null;
    asked.add(s.sha);
    if ((await isAncestor(s.sha, entry.sha)) === true) return s;
  }
  return null;
}

// The value a scored metric had in the latest earlier scan, used for the score when its probe
// failed in this scan. `carried` collects the metrics that were filled in this way.
function carryFailed(earlier, errors, carried) {
  return path => {
    if (!errors[path.split('.')[0]]) return null;
    for (let i = earlier.length - 1; i >= 0; i--) {
      const v = metricValue(earlier[i].values, path);
      if (v !== null) { carried.push(path); return v; }
    }
    return null;
  };
}

// Saves a scan result (from scan()) as the newest entry of metrics/<project>.json, writes its
// details, and logs the wins against the scan it compares with (see compareBase).
// Only full scans are saved: a result limited by `ids` or `only` (`subset`) is refused, since
// its missing probes would read as "no value" on the tiles and in the G0 base lookup.
// The score of a scan where a scored probe failed uses that metric's last stored value (listed
// in the entry's `scoreCarried`), so a broken probe neither raises nor lowers the score.
// opts:
//   profile        for the score, labels and directions; left out, the profile in the data folder
//                  is used (null: none)
//   knownFailures  a number (or { value }) stored with the scan and counted in the score; left
//                  out, the latest count from the check history (null: none)
//   via            what the wins are credited to (default: this scan)
//   isAncestor     async (olderSha, newerSha) => true | false | null; left out, git is asked in
//                  the scan's `tree` (scan() gives it), and without a tree the branch rule applies
// Returns { scanId, wins, score }; `wins` are the lines actually appended to the wins log.
export async function recordScan(dataDir, project, result, { profile, knownFailures, via = null, isAncestor } = {}) {
  const paths = projectPaths(dataDir, project);
  if (!result || !result.values || typeof result.values !== 'object') throw new Error('The scan result has no values.');
  if (result.subset) throw new Error('Only full scans are saved; this scan ran only some probes or files.');
  if (profile === undefined) profile = await storedProfile(dataDir, project);
  if (knownFailures === undefined) knownFailures = await knownFailuresFrom(dataDir, project).catch(() => null);
  const pending = await serialize(paths.metrics, async () => {
    const doc = await loadMetrics(dataDir, project);
    const earlier = doc.scans.slice();
    const scanId = scanIdFor(result.at, new Set(doc.scans.map(s => s.id)));
    const values = { ...result.values };
    const kf = knownFailureCount(knownFailures);
    if (kf !== null) values.knownFailures = { value: kf, display: String(kf) };
    const errors = result.errors && typeof result.errors === 'object' ? result.errors : {};
    const carried = [];
    const entry = {
      id: scanId,
      at: result.at || new Date().toISOString(),
      sha: result.sha || null,
      branch: result.branch || null,
      durationMs: isNum(result.durationMs) ? result.durationMs : null,
      node: result.node || process.versions.node,
      values,
      errors,
      score: profile ? healthScore(profile, values, { fallback: carryFailed(earlier, errors, carried) }) : null,
    };
    if (carried.length) entry.scoreCarried = carried;
    doc.scans.push(entry);
    if (doc.scans.length > MAX_SCANS) doc.scans = doc.scans.slice(-MAX_SCANS);
    await writeJsonAtomic(paths.metricsDetails(scanId), capDetails(result.details));
    await writeJsonAtomic(paths.metrics, doc);
    await pruneDetails(paths.metricsDetailsDir, doc.scans.slice(-DETAIL_SCANS).map(s => s.id));
    return { entry, earlier };
  });
  // Git is asked after the file is written, so a slow git never holds up another scan's save.
  const { entry, earlier } = pending;
  const tree = typeof result.tree === 'string' && result.tree ? result.tree : null;
  const ask = typeof isAncestor === 'function' ? isAncestor : tree ? (a, b) => gitIsAncestor(tree, a, b) : null;
  const prev = await compareBase(earlier, entry, ask);
  const found = prev
    ? detectWins(prev.values, entry.values, via || { kind: 'scan', scanId: entry.id, sha: entry.sha, branch: entry.branch }, { profile, at: entry.at })
    : [];
  const wins = await appendWins(dataDir, project, found);
  return { scanId: entry.id, wins, score: entry.score };
}

// ---------------------------------------------------------------- tiles

function seriesOf(scans, path, valueOf = s => metricValue(s.values, path)) {
  const out = [];
  for (const s of scans) {
    const v = valueOf(s);
    if (v !== null) out.push({ at: s.at, value: v });
  }
  return out;
}

// Change since the oldest point within the 7 days before the latest one.
function weekChange(series, higher) {
  if (!series.length) return { delta: 0, trend: 'same' };
  const last = series[series.length - 1];
  const from = Date.parse(last.at) - 7 * DAY_MS;
  const ref = series.find(p => !(Date.parse(p.at) < from)) || last;
  const delta = last.value - ref.value;
  const trend = delta === 0 ? 'same' : (higher ? delta > 0 : delta < 0) ? 'better' : 'worse';
  return { delta, trend };
}

function summaryText(now, delta) {
  if (delta === 0) return `${now}, no change this week`;
  return `${now}, ${delta < 0 ? 'down' : 'up'} ${Math.abs(delta)} this week`;
}

function displayOf(entry, sub, now) {
  if (!sub) return (entry && entry.display) || String(now);
  if (sub === 'largestModuleCycle' && entry && entry.modules) return `${now} of ${entry.modules} modules`;
  return String(now);
}

function noteOf(entry) {
  if (!entry) return '';
  if (entry.warning) return entry.warning;
  if (entry.partial) return `Partial graph: ${entry.partial} imports did not resolve, so the number may be low.`;
  if (Array.isArray(entry.badFiles) && entry.badFiles.length) return `${entry.badFiles.length} locale files are not valid JSON and count as missing.`;
  return '';
}

// { pipeline, what } plus `finding` (a finding id for the Fix pipeline) when given; else null.
function validAction(a) {
  if (!a || typeof a !== 'object' || typeof a.pipeline !== 'string' || typeof a.what !== 'string') return null;
  const out = { pipeline: a.pipeline, what: a.what };
  if (typeof a.finding === 'string' && a.finding) out.finding = a.finding;
  return out;
}

// What "Start a slice" on a tile starts, by metric family. Overrides, strongest first: the
// caller's `actions[path]` (tiles() option; null hides the button), then a probe's own `action`
// (or `action: null`) in the profile. Known failures go to Fix; with `knownFailures.finding` (the
// finding that tracks them, which only the private findings file knows) the Fix run starts on it.
function actionFor(profile, path, entry, opts = {}) {
  const overrides = opts.actions && typeof opts.actions === 'object' ? opts.actions : {};
  if (Object.prototype.hasOwnProperty.call(overrides, path)) return validAction(overrides[path]);
  if (path === 'knownFailures') {
    const finding = opts.knownFailures && typeof opts.knownFailures.finding === 'string' ? opts.knownFailures.finding : '';
    return validAction({ pipeline: 'fix', what: finding ? `Fix ${finding}: the known test failures` : 'Fix the known test failures', finding });
  }
  const probe = probeById(profile, path.split('.')[0]);
  if (probe && Object.prototype.hasOwnProperty.call(probe, 'action')) return validAction(probe.action);
  const label = (probe && probe.label) || path;
  switch (probe && probe.kind) {
    case 'deepImports':
    case 'publicTs':
      return { pipeline: 'refactor', what: 'Add a public.ts boundary to one web feature' };
    case 'localeParity':
      return { pipeline: 'feature', what: 'Fill the missing i18n keys for one locale' };
    case 'cycles': {
      const names = (entry && entry.largestModules) || [];
      return { pipeline: 'refactor', what: names.length ? `Untangle the module cycle around ${names.slice(0, 4).join(', ')}` : 'Untangle the largest module cycle' };
    }
    case 'expoParity': {
      const next = entry && Array.isArray(entry.missing) && entry.missing[0];
      return { pipeline: 'feature', what: next ? `Expo parity: add a module for ${next}` : 'Expo parity: add the next missing module' };
    }
    case 'regexCount':
      return { pipeline: 'refactor', what: `Reduce "${label}" in one feature` };
    default:
      return null;
  }
}

function atGoal(profile, path, now, higher) {
  const cfg = profile && profile.score && profile.score[path];
  if (!cfg || !Number.isFinite(Number(cfg.target))) return false;
  return higher ? now >= Number(cfg.target) : now <= Number(cfg.target);
}

function emptyTile(profile, path) {
  return {
    id: path, label: metricLabel(profile, path), measures: measuresOf(profile, path), value: null,
    display: 'No scan yet', trend: 'same', delta: 0, spark: [], summary: 'No scan yet', note: '', action: null, badge: null,
  };
}

// knownFailures: a number, or { value, spark: [...], weekAgo, finding? } (knownFailuresFrom gives
// this shape from the check history).
function knownFailuresTile(tile, profile, opts) {
  const kf = opts.knownFailures;
  const now = knownFailureCount(kf);
  if (now === null) return { ...tile, display: 'No baseline yet', summary: 'No baseline yet' };
  const spark = kf && Array.isArray(kf.spark) ? kf.spark.filter(isNum).slice(-SPARK_POINTS) : [now];
  const delta = kf && isNum(kf.weekAgo) ? now - kf.weekAgo : 0;
  const trend = delta === 0 ? 'same' : delta < 0 ? 'better' : 'worse';
  const done = atGoal(profile, 'knownFailures', now, false) || now === 0;
  return {
    ...tile, value: now, display: String(now), trend, delta, spark, summary: summaryText(now, delta),
    action: done ? null : actionFor(profile, 'knownFailures', null, opts), badge: done ? 'At goal' : null,
  };
}

// The non-shop procedures of a router-keys probe against the allowlist (a list, or null when
// none was saved yet). value = how many non-shop keys there are; `outside` = how many of them the
// allowlist doesn't hold.
function nonShopTile(tile, profile, scans, id, allowlist) {
  const latest = scans[scans.length - 1];
  if (!latest) return tile;
  const countOf = s => (s.values && s.values[id] && Array.isArray(s.values[id].nonShop) ? s.values[id].nonShop.length : null);
  const series = seriesOf(scans, null, countOf);
  const spark = series.slice(-SPARK_POINTS).map(p => p.value);
  const err = latest.errors && latest.errors[id];
  const entry = latest.values && latest.values[id];
  if (err || !entry || !Array.isArray(entry.nonShop)) {
    const why = err ? `probe failed: ${err}` : 'This scan has no procedure list.';
    return { ...tile, display: '—', spark, note: why, summary: why, badge: err ? 'Probe failed' : null };
  }
  const now = entry.nonShop.length;
  const { delta, trend } = weekChange(series, false);
  if (!Array.isArray(allowlist)) {
    return {
      ...tile, value: now, display: `${now} non-shop`, trend, delta, spark, summary: summaryText(now, delta),
      note: 'No allowlist yet. Rebuild the allowlist to set it up from the last scan.', badge: 'No allowlist',
    };
  }
  const allowed = new Set(allowlist);
  const outside = entry.nonShop.filter(k => !allowed.has(k));
  return {
    ...tile, value: now, outside: outside.length, display: `${now - outside.length} of ${now} allowed`, trend, delta, spark,
    summary: summaryText(now, delta),
    note: outside.length ? `Not on the allowlist: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}` : '',
    badge: outside.length ? `${outside.length} outside the allowlist` : 'Within allowlist',
  };
}

function tileFor(profile, scans, path, opts) {
  const tile = emptyTile(profile, path);
  const [id, ...rest] = path.split('.');
  const sub = rest.join('.');
  if (path === 'knownFailures') return knownFailuresTile(tile, profile, opts);
  if (sub === 'nonShopVsAllowlist') return nonShopTile(tile, profile, scans, id, opts.allowlist);
  const latest = scans[scans.length - 1];
  if (!latest) return tile;
  const series = seriesOf(scans, path);
  const spark = series.slice(-SPARK_POINTS).map(p => p.value);
  const err = latest.errors && latest.errors[id];
  if (err) return { ...tile, display: '—', spark, note: `probe failed: ${err}`, summary: `probe failed: ${err}`, badge: 'Probe failed' };
  const entry = latest.values && latest.values[id];
  const now = metricValue(latest.values, path);
  if (now === null) return { ...tile, display: '—', spark, note: 'The last scan has no value for this.', summary: 'No value in the last scan' };
  const higher = higherIsBetter(profile, path, entry);
  const { delta, trend } = weekChange(series, higher);
  // A value the probe warned about is shown with the warning, never as a goal reached.
  const goal = !(entry && entry.warning) && atGoal(profile, path, now, higher);
  return {
    ...tile, value: now, display: displayOf(entry, sub, now), trend, delta, spark, summary: summaryText(now, delta),
    note: noteOf(entry), action: goal ? null : actionFor(profile, path, entry, opts),
    badge: goal ? 'At goal' : entry && entry.partial ? 'Partial graph' : null,
  };
}

// The health tiles of profile.tiles, from the scan history in `metrics` (loadMetrics).
// opts:
//   knownFailures  a number or { value, spark, weekAgo, finding? } (see knownFailuresFrom)
//   allowlist      the saved allowlist (a list, see allowlist.mjs loadAllowlist) or null
//   actions        { <metric>: {pipeline, what, finding?} | null } to replace a tile's action
// Each tile: { id, label, measures, value, display, trend: 'better'|'same'|'worse', delta,
// spark: [last 10 values], summary ("41, down 3 this week"), note, action: {pipeline, what,
// finding?} | null, badge }. A tile whose probe failed in the last scan keeps its spark and says
// "probe failed: <why>" in note and summary.
export function tiles(profile, metrics, { knownFailures = null, allowlist = null, actions = null } = {}) {
  const scans = (metrics && Array.isArray(metrics.scans) ? metrics.scans : []);
  const list = profile && Array.isArray(profile.tiles) ? profile.tiles : [];
  return list.filter(p => typeof p === 'string' && p).map(path => tileFor(profile, scans, path, { knownFailures, allowlist, actions }));
}

// The score row: { value, delta, trend, spark } from the scores stored with each scan.
export function scoreTrend(metrics) {
  const scans = (metrics && Array.isArray(metrics.scans) ? metrics.scans : []);
  const series = seriesOf(scans, null, s => (isNum(s.score) ? s.score : null));
  if (!series.length) return { value: null, delta: 0, trend: 'same', spark: [] };
  const { delta, trend } = weekChange(series, true);
  return { value: series[series.length - 1].value, delta, trend, spark: series.slice(-SPARK_POINTS).map(p => p.value) };
}

// The lens table: each profile lens with its value now and the change since the scan before.
export function lensRows(profile, metrics) {
  const scans = (metrics && Array.isArray(metrics.scans) ? metrics.scans : []);
  const latest = scans[scans.length - 1];
  const prev = scans[scans.length - 2];
  return (profile && Array.isArray(profile.lenses) ? profile.lenses : []).map(path => {
    const id = String(path).split('.')[0];
    const error = (latest && latest.errors && latest.errors[id]) || '';
    const now = latest && !error ? metricValue(latest.values, path) : null;
    const before = prev ? metricValue(prev.values, path) : null;
    const delta = now !== null && before !== null ? now - before : null;
    const change = delta === null ? (now === null ? '' : 'first scan') : delta === 0 ? 'same' : delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
    return { id: path, label: metricLabel(profile, path), measures: measuresOf(profile, path), now, change, delta, error };
  });
}

const detailKey = d => `${d.path}::${d.text}`;

// The part of one probe's next details that can be compared with the stored previous details.
// Both sides are cut at DETAILS_CAP, the way recordScan stores them. When the stored list was
// full, items after the last one that still matches may come from the part that was cut off,
// so they are left out instead of being reported as new.
function comparableNext(prevList, nextList, seen) {
  const next = nextList.slice(0, DETAILS_CAP);
  if (prevList.length < DETAILS_CAP) return next;
  let last = -1;
  next.forEach((d, i) => { if (seen.has(detailKey(d))) last = i; });
  return next.slice(0, last + 1);
}

// Lens items in `nextDetails` that weren't in `prevDetails`, matched by "path::text" (line numbers
// move when code above changes, so they don't count). Only probes present in both scans are
// compared, so a new or previously failing probe doesn't flood the list; with no previous details
// at all the result is empty. The probes are opts.ids (lens metric paths or probe ids), or
// opts.profile's lenses; one of the two is required, so a caller can't compare every probe by
// mistake. opts.max caps the list (default 30). Each item: { probe, path, line, text }.
export function newCandidates(prevDetails, nextDetails, { max = 30, ids, profile = null } = {}) {
  const lenses = Array.isArray(ids) ? ids : profile && Array.isArray(profile.lenses) ? profile.lenses : null;
  if (!lenses) throw new Error('newCandidates needs the lens ids (opts.ids) or the profile (opts.profile).');
  if (!prevDetails || !nextDetails) return [];
  const probeIds = [...new Set(lenses.filter(p => typeof p === 'string' && p).map(p => p.split('.')[0]))];
  const out = [];
  for (const id of probeIds) {
    if (!Array.isArray(prevDetails[id]) || !Array.isArray(nextDetails[id])) continue;
    const prevList = prevDetails[id].slice(0, DETAILS_CAP);
    const seen = new Set(prevList.map(detailKey));
    for (const d of comparableNext(prevList, nextDetails[id], seen)) {
      if (out.length >= max) return out;
      const key = detailKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ probe: id, path: d.path, line: d.line, text: d.text });
    }
  }
  return out;
}
