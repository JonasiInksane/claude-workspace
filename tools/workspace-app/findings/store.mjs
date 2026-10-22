// Findings store: the audit board of one project, kept in the private data folder.
//
//   <dataDir>/findings/<project>.json          the findings (SPEC 2.11)
//   <dataDir>/findings/<project>.import.json   an import proposal waiting for your Apply
//
// The file never lives in the hub, because finding titles and evidence are project security
// detail. Every write is atomic (core/datadir.mjs) and carries a content hash; a save with a stale
// hash is refused with 409, so a page that loaded an old board can't overwrite a newer one.
// Statuses move only along the transitions in TRANSITIONS: runs move findings into and out of a
// run, a merged branch makes them done, and you can only dismiss or reopen. "done" is never set
// by a user call: it comes from records and git. A save also refuses anything that isn't a board
// (no findings list, a duplicate id, an unknown status), so a wrong value can't wipe the board.
import { rename } from 'node:fs/promises';
import { PROJECT_RE, jsonHash, projectPaths, readJson, writeJsonAtomic } from '../core/datadir.mjs';

export { PROJECT_RE };

export const STATUSES = ['proposed', 'open', 'in-run', 'on-branch', 'done', 'dismissed'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const BLASTS = ['small', 'medium', 'large'];
export const STATUS_SOURCES = ['audit', 'record', 'git', 'merged', 'run', 'user'];
export const REASON_MAX = 300;

// The board's four columns, in order. Proposed findings wait in Open until you accept or
// dismiss them; dismissed findings leave the board.
export const COLUMNS = [
  { id: 'open', label: 'Open', statuses: ['proposed', 'open'] },
  { id: 'in-run', label: 'In run', statuses: ['in-run'] },
  { id: 'on-branch', label: 'On branch', statuses: ['on-branch'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
];

// Allowed moves: [from ('*' = any), to, who may make it]. SPEC 3 WP7.
export const TRANSITIONS = [
  ['open', 'in-run', 'run'],          // a run starts on the finding
  ['in-run', 'open', 'run'],          // the run was cancelled or ended without a commit
  ['in-run', 'on-branch', 'run'],     // the commit gate committed the fix on an app branch
  ['on-branch', 'done', 'merged'],    // that branch is merged into the integration branch
  ['*', 'dismissed', 'user'],         // you dismiss it (a reason is required)
  ['dismissed', 'open', 'user'],      // you reopen it
  ['proposed', 'open', 'user'],       // you accept a proposed finding
];

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const BLAST_RANK = { small: 0, medium: 1, large: 2 };
const SOURCE_OF = { run: 'run', merged: 'merged', user: 'user' };
const PIPELINE_LABELS = { fix: 'Fix', refactor: 'Refactor', debug: 'Debug', feature: 'Feature' };

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkProject(project) {
  if (!PROJECT_RE.test(String(project || ''))) throw httpError(400, `"${project}" is not a valid project name.`);
  return project;
}

export const findingsFile = (dataDir, project) => projectPaths(dataDir, checkProject(project)).findings;
export const importFile = (dataDir, project) => projectPaths(dataDir, checkProject(project)).findingsImport;

// "sha256:<hex>" of the document without its own hash field, with keys sorted, so the same
// content always gives the same hash.
export function hashDoc(doc) {
  const { hash, ...rest } = doc || {};
  return jsonHash(rest);
}

export function emptyDoc(project) {
  return { version: 1, project, hash: null, source: null, phases: [], findings: [] };
}

function normalize(doc, project) {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : emptyDoc(project);
  return {
    ...d,
    version: 1,
    project: d.project || project,
    phases: Array.isArray(d.phases) ? d.phases : [],
    findings: Array.isArray(d.findings) ? d.findings : [],
  };
}

// The project's findings, or an empty board (hash null) when there is no file yet. `hash` is
// computed from the content, so a hand edit of the file can't leave a stale hash behind.
export async function loadFindings(dataDir, project) {
  const raw = await readJson(findingsFile(dataDir, project), null);
  if (!raw) return emptyDoc(project);
  const doc = normalize(raw, project);
  return { ...doc, hash: hashDoc(doc) };
}

// '' when `doc` is a board that can be saved, otherwise the reason it can't. A save never turns a
// wrong value (say { doc, finding } by mistake) into an empty board.
export function docProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.findings)) {
    return 'The findings document has no findings list, so nothing was saved.';
  }
  const seen = new Set();
  for (const f of doc.findings) {
    if (!f || typeof f.id !== 'string' || !f.id) return 'A finding without an id cannot be saved.';
    if (seen.has(f.id)) return `The finding ${f.id} appears twice, so nothing was saved.`;
    seen.add(f.id);
    if (!STATUSES.includes(f.status)) return `${f.id} has the status "${f.status}", which is not a finding status.`;
  }
  return '';
}

// Saves the board. `baseHash` is the hash the caller loaded: a different hash on disk means
// someone changed the board in between, and the save is refused with 409. Leave `baseHash` out
// (undefined) only for an internal read-modify-write that already holds the latest copy (see
// updateFindings); null or '' means "there must be no file yet". Returns the saved document.
export async function saveFindings(dataDir, project, doc, { baseHash } = {}) {
  const file = findingsFile(dataDir, project);
  const problem = docProblem(doc);
  if (problem) throw httpError(400, problem);
  if (baseHash !== undefined) {
    const raw = await readJson(file, null);
    const onDisk = raw ? hashDoc(normalize(raw, project)) : null;
    if ((onDisk || null) !== (baseHash || null)) {
      throw httpError(409, 'The findings changed since you loaded them. Reload the board and try again.');
    }
  }
  const clean = normalize(doc, project);
  clean.project = project;
  const saved = { ...clean, hash: hashDoc(clean) };
  await writeJsonAtomic(file, saved);
  return saved;
}

// One read-modify-write at a time per board inside this process, so a run moving a finding and a
// click on the page can't lose each other's change. `fn(doc)` returns the new document, or
// { doc, ...extra } (setStatus, proposeFinding, reconcile); the saved document, `changed` and the
// extras come back. Returning nothing leaves the board as it was.
const queues = new Map();
export function updateFindings(dataDir, project, fn) {
  const file = findingsFile(dataDir, project);
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const doc = await loadFindings(dataDir, project);
    const out = await fn(doc);
    const result = out && out.doc ? out : { doc: out };
    if (!result.doc) return { ...result, doc, changed: false };
    if (hashDoc(normalize(result.doc, project)) === doc.hash) return { ...result, doc, changed: false };
    const saved = await saveFindings(dataDir, project, result.doc, { baseHash: doc.hash });
    return { ...result, doc: saved, changed: true };
  });
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}

// '' when `by` may move a finding from `from` to `to`, otherwise the reason it can't.
export function transitionProblem(from, to, by) {
  if (!STATUSES.includes(to)) return `"${to}" is not a finding status.`;
  if (to === 'done' && by !== 'merged') return 'Done comes from a merged branch, not from a click.';
  const ok = TRANSITIONS.some(([f, t, who]) => (f === '*' || f === from) && t === to && who === by);
  if (ok) return '';
  return `A finding can't move from ${from} to ${to} that way.`;
}

const strip = f => {
  const { history, ...rest } = f;
  return rest;
};

// Moves one finding to `to`. Returns { doc, finding, changed } and never changes `doc` itself;
// `doc` is the same object when the finding already has that status. Return the whole result
// from an updateFindings callback, or save result.doc (saveFindings refuses the wrapper itself).
// Throws (400) on a move the table doesn't allow, and (404) on an unknown id.
//   opts: { by: 'run'|'merged'|'user', reason, at, runId, branch, commit }
export function setStatus(doc, id, to, { by = 'user', reason = '', at = new Date().toISOString(), runId, branch, commit } = {}) {
  const findings = Array.isArray(doc?.findings) ? doc.findings : [];
  const i = findings.findIndex(f => f.id === id);
  if (i < 0) throw httpError(404, `There is no finding "${id}".`);
  const cur = findings[i];
  const why = String(reason || '').replace(/\s+/g, ' ').trim();
  if (cur.status === to) return { doc, finding: cur, changed: false };
  const problem = transitionProblem(cur.status, to, by);
  if (problem) throw httpError(400, `${id} is ${cur.status}. ${problem}`);
  if (to === 'dismissed' && !why) throw httpError(400, `Say why you dismiss ${id}.`);
  if (why.length > REASON_MAX) throw httpError(400, `A reason can be at most ${REASON_MAX} characters.`);
  const next = { ...cur, status: to, statusSource: SOURCE_OF[by] || 'user' };
  const entry = { at, from: cur.status, to, by, reason: why };
  if (runId) entry.runId = runId;
  if (branch) entry.branch = branch;
  if (commit) entry.commit = commit;
  if (to === 'in-run') next.runId = runId || null;
  if (to === 'open' && cur.status === 'in-run') next.runId = null;
  if (to === 'on-branch') {
    if (branch) next.branch = branch;
    if (runId) next.runId = runId;
  }
  if (commit && !SHA_RE.test(String(commit))) throw httpError(400, `"${String(commit).slice(0, 60)}" is not a commit SHA.`);
  if (commit) next.commits = [...new Set([...(cur.commits || []), String(commit).toLowerCase()])];
  next.history = [...(cur.history || []), entry];
  const out = findings.slice();
  out[i] = next;
  return { doc: { ...doc, findings: out }, finding: next, changed: true };
}

// Sort is stable, so findings of the same severity keep their audit order.
const bySeverity = (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);

// The board: [{id, label, count, items}] for Open, In run, On branch and Done. Items are the
// findings without their history, highest severity first (audit order within a severity).
export function columns(doc) {
  const findings = Array.isArray(doc?.findings) ? doc.findings : [];
  return COLUMNS.map(c => {
    const items = findings.filter(f => c.statuses.includes(f.status)).map(strip);
    items.sort(bySeverity);
    return { id: c.id, label: c.label, count: items.length, items };
  });
}

function phaseIndex(doc) {
  const order = new Map();
  (doc?.phases || []).forEach((p, i) => order.set(String(p.id), i));
  return id => (id === null || id === undefined ? 999 : order.has(String(id)) ? order.get(String(id)) : 998);
}

// Open findings in the order Next up picks them: highest severity, then smallest blast radius,
// then earliest phase, then audit order. Findings waiting on an owner decision come last.
export function rankOpen(doc) {
  const findings = Array.isArray(doc?.findings) ? doc.findings : [];
  const phaseAt = phaseIndex(doc);
  return findings
    .map((f, order) => ({ f, order }))
    .filter(x => x.f.status === 'open')
    .sort((a, b) => (a.f.ownerDecision ? 1 : 0) - (b.f.ownerDecision ? 1 : 0) ||
      (SEVERITY_RANK[a.f.severity] ?? 9) - (SEVERITY_RANK[b.f.severity] ?? 9) ||
      (BLAST_RANK[a.f.blast] ?? 1) - (BLAST_RANK[b.f.blast] ?? 1) ||
      phaseAt(a.f.phase) - phaseAt(b.f.phase) || a.order - b.order)
    .map(x => strip(x.f));
}

// Median minutes per pipeline from run rows ({pipeline, status, durationMs}); only runs that got
// somewhere (committed or passed) count. { fix: 45, refactor: 80 }.
export function runMedians(runs) {
  const per = {};
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !['committed', 'passed'].includes(r.status) || !(r.durationMs > 0)) continue;
    (per[r.pipeline] ||= []).push(r.durationMs);
  }
  const out = {};
  for (const [p, list] of Object.entries(per)) {
    list.sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    const ms = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
    out[p] = Math.max(1, Math.round(ms / 60000));
  }
  return out;
}

// The one finding to start next: the highest-severity open finding with the smallest blast
// radius that isn't waiting on an owner decision. null when there is none.
//   medians: { fix: minutes } from runMedians, used for "about 45 min (your median for Fix)".
export function nextUp(doc, { medians = {}, pipeline = 'fix' } = {}) {
  const top = rankOpen(doc).find(f => !f.ownerDecision);
  if (!top) return null;
  const phase = (doc.phases || []).find(p => String(p.id) === String(top.phase));
  const median = typeof medians[pipeline] === 'number' ? medians[pipeline] : medians[pipeline]?.minutes;
  let estimateMin = null;
  let estimateText = '';
  if (typeof top.estimateMin === 'number' && top.estimateMin > 0) {
    estimateMin = top.estimateMin;
    estimateText = `about ${estimateMin} min`;
  } else if (typeof median === 'number' && median > 0) {
    estimateMin = median;
    estimateText = `about ${median} min (your median for ${PIPELINE_LABELS[pipeline] || pipeline})`;
  }
  const meta = [phase ? `Phase ${phase.id}` : '', top.blast ? `${top.blast} blast radius` : '', estimateText].filter(Boolean).join(' · ');
  return { ...top, phaseLabel: phase ? phase.label : '', estimateMin, estimateText, meta };
}

// One bar per phase: [{id, label, total, closed, left, pct, text, leftIds}]. Proposed findings
// don't count yet; done and dismissed count as closed.
export function phaseBars(doc) {
  const findings = (Array.isArray(doc?.findings) ? doc.findings : []).filter(f => f.status !== 'proposed');
  return (doc?.phases || []).map(p => {
    const inPhase = findings.filter(f => String(f.phase) === String(p.id));
    const closed = inPhase.filter(f => f.status === 'done' || f.status === 'dismissed').length;
    const total = inPhase.length;
    const left = total - closed;
    return {
      id: String(p.id), label: p.label, total, closed, left,
      pct: total ? Math.round((closed / total) * 100) : 0,
      text: total ? `${closed} of ${total} closed · ${left} left` : 'No findings in this phase',
      leftIds: inPhase.filter(f => f.status !== 'done' && f.status !== 'dismissed').map(f => f.id),
    };
  });
}

// A finding proposed by a review or architecture run ("Make finding"). It gets the next free
// AP-<n> id and status proposed, so it waits for you in Open. The same run and ref give the same
// finding again. Returns { doc, id, created }.
export function proposeFinding(doc, item, { runId = null, at = new Date().toISOString() } = {}) {
  const findings = Array.isArray(doc?.findings) ? doc.findings : [];
  const ref = String(item?.ref || '').slice(0, 120);
  const same = ref && runId ? findings.find(f => f.runId === runId && f.ref === ref) : null;
  if (same) return { doc, id: same.id, created: false };
  const title = String(item?.title || item?.claim || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) throw httpError(400, 'A proposed finding needs a title.');
  const severity = SEVERITIES.includes(item?.severity) ? item.severity : 'medium';
  let n = 0;
  for (const f of findings) {
    const m = /^AP-(\d+)$/.exec(f.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const id = `AP-${n + 1}`;
  const finding = {
    id, title, severity, phase: item?.phase ?? null, area: String(item?.area || ''),
    status: 'proposed', statusSource: 'run', blast: BLASTS.includes(item?.blast) ? item.blast : 'medium',
    ownerDecision: false, estimateMin: null, records: [], commits: [], branch: null, runId, ref,
    evidence: String(item?.evidence || '').slice(0, 600), notes: '',
    history: [{ at, from: null, to: 'proposed', by: 'run', reason: runId ? `proposed by run ${runId}` : 'proposed by a run' }],
  };
  return { doc: { ...doc, findings: [...findings, finding] }, id, created: true };
}

// ---- pending import ----

// Keeps an import proposal until you apply it. `baseHash` is the board's hash when the proposal
// was made, so applying it later can't overwrite changes made in between.
export async function savePendingImport(dataDir, project, proposal, { baseHash = null, at = new Date().toISOString() } = {}) {
  const file = importFile(dataDir, project);
  const pending = { version: 1, project, createdAt: at, baseHash, proposal };
  await writeJsonAtomic(file, pending);
  return pending;
}

export async function loadPendingImport(dataDir, project) {
  return readJson(importFile(dataDir, project), null);
}

// Moves the pending proposal aside to <project>.import.applied.json (the last applied one is kept
// for reference; nothing is deleted).
export async function clearPendingImport(dataDir, project) {
  const file = importFile(dataDir, project);
  try {
    await rename(file, file.replace(/\.import\.json$/, '.import.applied.json'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
