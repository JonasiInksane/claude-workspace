// The findings board (SPEC 4; the cockpit's Audit progress card, SPEC 5.3, and Next up):
//   GET  /api/findings                 the board: the document, the four columns, one bar per
//                                      phase, Next up, a pending import and the phase boss
//   POST /api/findings/import          reads the audit, the records and git, and keeps a proposal
//                                      (nothing on the board changes yet)
//   POST /api/findings/import/apply    applies the proposal you confirmed (by its hash)
//   POST /api/findings/status          your click: dismiss with a reason, reopen, accept a proposal
//   POST /api/findings/reconcile       moves findings along what git and the run index show
//   POST /api/findings/propose         "Make finding" from a review or architecture run's item
//
// The board lives in the private data folder (findings/store.mjs); every write goes through
// store.updateFindings, so a run moving a finding and a click can't lose each other's change, and
// the transition table applies to every move ("done" never comes from a click). The audit path
// comes from the private profile, never from the page. Text taken from a run's output is redacted
// before it reaches the board.
import { join } from 'node:path';
import { readJson as readJsonFile } from '../core/datadir.mjs';
import * as coreGit from '../core/git.mjs';
import { applyPendingImport, prepareImport } from '../findings/import.mjs';
import { reconcileAndSave } from '../findings/reconcile.mjs';
import {
  columns, loadFindings, loadPendingImport, nextUp, phaseBars, proposeFinding, runMedians, setStatus, STATUSES, updateFindings,
} from '../findings/store.mjs';
import { currentBoss } from '../fun/fun.mjs';
import { redact } from '../gates/secrets.mjs';
import { HttpError, readJson } from '../http.mjs';
import { metricLabel } from '../probes/metrics.mjs';
import { listRuns, loadRun, runDir, RUN_ID_RE } from '../runs/store.mjs';
import { profileFor, profileOrThrow, projectOrThrow } from './cockpit.mjs';

const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// Item refs in a run: F1.. (review findings) and C1.. (architecture candidates).
const ITEM_REF_RE = /^[A-Z]{1,2}\d{1,3}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_IDS = 1000;
const REASON_MAX = 300;

const strip = f => {
  const { history, ...rest } = f;
  return rest;
};

// Index rows with durationMs (createdAt to endedAt), for the medians behind "about N min".
export function withDurations(rows) {
  return rows.map(r => {
    const ms = Date.parse(r.endedAt) - Date.parse(r.createdAt);
    return { ...r, durationMs: Number.isFinite(ms) && ms > 0 ? ms : null };
  });
}

// A valid profile, or null (the board works without one; some parts then show less).
async function profileOrNull(ctx, p) {
  const info = await profileFor(ctx, p);
  return info.exists && info.valid ? info.profile : null;
}

// What a pending import shows: when it was made, its counts and hash, and the proposal itself so
// the dialog can open again after a reload.
function pendingView(pending) {
  if (!pending || !pending.proposal) return null;
  const pr = pending.proposal;
  return { createdAt: pending.createdAt || null, hash: pr.hash, counts: pr.counts || null, warnings: pr.warnings || [], proposal: pr };
}

// The finding a review or architecture run proposes for one of its items, or a 404/400.
async function proposedItem(ctx, run, ref, profile) {
  const allow = (profile && profile.secrets && profile.secrets.allowValues) || [];
  const clean = text => redact(String(text || ''), { allow });
  if (run.pipeline === 'review') {
    const f = ((run.outputs && run.outputs.review && run.outputs.review.findings) || []).find(x => x && x.id === ref);
    if (!f) throw new HttpError(404, `The review ${run.id} has no finding ${ref}.`);
    const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '';
    return {
      title: clean(f.claim), severity: f.severity, area: clean(where), ref,
      evidence: clean([f.evidence, f.suggestion ? `Suggestion: ${f.suggestion}` : ''].filter(Boolean).join(' ')),
    };
  }
  if (run.pipeline === 'architecture') {
    const list = await readJsonFile(join(runDir(ctx.dataDir, run), 'inputs', 'candidates.json'), []).catch(() => []);
    const c = (Array.isArray(list) ? list : []).find(x => x && x.ref === ref);
    if (!c) throw new HttpError(404, `The architecture check ${run.id} has no candidate ${ref}.`);
    const t = ((run.outputs && run.outputs.triage && run.outputs.triage.items) || []).find(x => x && x.ref === ref);
    const where = `${c.path || ''}${c.line ? `:${c.line}` : ''}`;
    return {
      title: clean(`${metricLabel(profile, c.probe || '')}: ${where}`), severity: 'medium', area: clean(c.path || ''), ref,
      evidence: clean([c.text, t && t.reason ? `Triage: ${t.reason}` : ''].filter(Boolean).join(' · ')),
    };
  }
  throw new HttpError(400, 'Only review and architecture runs propose findings.');
}

export function routes(ctx) {
  return {
    // ?project=: { doc, columns, phases, nextUp, importPending, boss }.
    'GET /api/findings': async (req, res, url) => {
      const p = projectOrThrow(ctx, url.searchParams.get('project'));
      const [profile, doc, runs, pending] = await Promise.all([
        profileOrNull(ctx, p), loadFindings(ctx.dataDir, p.name), listRuns(ctx.dataDir, { project: p.name, limit: 500 }),
        loadPendingImport(ctx.dataDir, p.name).catch(() => null),
      ]);
      const boss = currentBoss(doc, profile && profile.fun ? profile.fun.bossPhase : undefined);
      return {
        ok: true, doc, columns: columns(doc), phases: phaseBars(doc),
        nextUp: nextUp(doc, { medians: runMedians(withDurations(runs)) }),
        importPending: pendingView(pending), boss,
      };
    },

    // { project }: builds and keeps an import proposal from the profile's audit file, the records
    // and git. 400 when the profile names no audit or it can't be read.
    'POST /api/findings/import': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const profile = profileOrThrow(await profileFor(ctx, p), p.name);
      let proposal;
      try {
        proposal = await prepareImport({ dataDir: ctx.dataDir, project: p.name, profile, mainDir: p.mainDir, git: coreGit.git });
      } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, proposal };
    },

    // { project, hash, accept: 'all' | [id], overrides: { id: status } }: applies the pending
    // proposal with that hash. 409 when it or the board changed since.
    'POST /api/findings/import/apply': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (typeof b.hash !== 'string' || !HASH_RE.test(b.hash)) throw new HttpError(400, 'Send the hash of the proposal you looked at.');
      const accept = b.accept === undefined ? 'all' : b.accept;
      if (accept !== 'all' && !(Array.isArray(accept) && accept.length <= MAX_IDS && accept.every(id => typeof id === 'string' && FINDING_ID_RE.test(id)))) {
        throw new HttpError(400, 'accept must be "all" or a list of finding ids.');
      }
      const overrides = b.overrides === undefined ? {} : b.overrides;
      const plain = overrides && typeof overrides === 'object' && !Array.isArray(overrides);
      if (!plain || Object.keys(overrides).length > MAX_IDS
        || Object.entries(overrides).some(([id, s]) => !FINDING_ID_RE.test(id) || typeof s !== 'string')) {
        throw new HttpError(400, 'overrides must map finding ids to statuses.');
      }
      let r;
      try { r = await applyPendingImport({ dataDir: ctx.dataDir, project: p.name, hash: b.hash, accept, overrides }); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, message: r.message };
    },

    // { project, id, status, reason }: your move of one finding (dismiss needs a reason; done is
    // never set by a click). 400 for a move the table doesn't allow, 404 for an unknown id.
    'POST /api/findings/status': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (typeof b.id !== 'string' || !FINDING_ID_RE.test(b.id)) throw new HttpError(400, `"${String(b.id ?? '').slice(0, 40)}" is not a finding id.`);
      if (!STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}.`);
      if (b.reason !== undefined && typeof b.reason !== 'string') throw new HttpError(400, 'The reason must be text.');
      if (String(b.reason || '').length > REASON_MAX) throw new HttpError(400, `A reason can be at most ${REASON_MAX} characters.`);
      let r;
      try {
        r = await updateFindings(ctx.dataDir, p.name, doc => setStatus(doc, b.id, b.status, { by: 'user', reason: b.reason || '' }));
      } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      const f = r.finding ? strip(r.finding) : null;
      return { ok: true, finding: f, message: r.changed ? `${b.id} is now ${b.status}.` : `${b.id} was already ${b.status}.` };
    },

    // { project }: on-branch to done for merged branches, in-run back to open (or on to
    // on-branch) for runs that ended. { changes: [{id, from, to, reason}], warnings }.
    'POST /api/findings/reconcile': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const profile = await profileOrNull(ctx, p);
      let r;
      try {
        r = await reconcileAndSave({ dataDir: ctx.dataDir, project: p.name, mainDir: p.mainDir, profile, git: coreGit.git });
      } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      const n = (r.changes || []).length;
      return { ok: true, changes: r.changes || [], warnings: r.warnings || [], message: n ? `Moved ${n} finding${n === 1 ? '' : 's'}.` : 'Nothing to move.' };
    },

    // { project, runId, ref }: a proposed finding (AP-<n>, waiting in Open) from item `ref` of a
    // review (F1, F2, ...) or architecture check (C1, C2, ...) of this project. The same run and
    // ref give the same finding again.
    'POST /api/findings/propose': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (typeof b.runId !== 'string' || !RUN_ID_RE.test(b.runId)) throw new HttpError(400, 'That is not a run id.');
      if (typeof b.ref !== 'string' || !ITEM_REF_RE.test(b.ref)) throw new HttpError(400, `"${String(b.ref ?? '').slice(0, 20)}" is not an item of a run.`);
      const run = await loadRun(ctx.dataDir, p.name, b.runId).catch(() => null);
      if (!run) throw new HttpError(404, `${p.name} has no run ${b.runId}.`);
      const profile = await profileOrNull(ctx, p);
      const item = await proposedItem(ctx, run, b.ref, profile);
      let r;
      try { r = await updateFindings(ctx.dataDir, p.name, doc => proposeFinding(doc, item, { runId: run.id })); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, id: r.id, created: !!r.created, message: r.created ? `Proposed ${r.id}. Accept or dismiss it on the board.` : `${b.ref} is already ${r.id}.` };
    },
  };
}
