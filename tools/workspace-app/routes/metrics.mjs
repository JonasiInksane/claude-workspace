// Health and wins (SPEC 4; the Health view, SPEC 5.4, and the cockpit's tiles):
//   GET  /api/metrics     the last scan, the tiles, the score, the lens table, the new candidates
//                         of the last architecture check, ratchet wins, achievements, the phase
//                         boss, the streak, this week's ship log and the allowlist state
//   POST /api/allowlist   { project, preview, scanId? }: what a rebuilt non-shop allowlist would
//                         add and remove, or (without preview) saving it
//
// Everything comes from the private data folder (metrics, wins, check history, findings, runs)
// plus read-only git for the weekly log; nothing here runs a probe or Claude. The scan itself is
// the architecture pipeline (POST /api/runs). Each part that can fail on its own (git, a broken
// file) comes back as { error } so the other cards still show.
import { join } from 'node:path';
import { readJson as readJsonFile } from '../core/datadir.mjs';
import * as coreGit from '../core/git.mjs';
import { loadSettings } from '../core/settings.mjs';
import { loadFindings } from '../findings/store.mjs';
import { achievementList, activityDays, currentBoss, streak, weeklyLog, winText } from '../fun/fun.mjs';
import { HttpError, readJson } from '../http.mjs';
import { allowlistProposal, loadAllowlist, saveAllowlist } from '../probes/allowlist.mjs';
import { knownFailuresFrom, lensRows, loadMetrics, loadWins, metricLabel, scoreTrend, tiles } from '../probes/metrics.mjs';
import { listRuns, loadRun, runDir } from '../runs/store.mjs';
import { part, profileFor, projectOrThrow } from './cockpit.mjs';

const SCAN_ID_RE = /^s-\d{6}-\d{6}(?:-\d+)?$/;
const MAX_CANDIDATES = 30;

async function profileOrNull(ctx, p) {
  const info = await profileFor(ctx, p);
  return info.exists && info.valid ? info.profile : null;
}

const latestScan = metrics => (metrics.scans.length ? metrics.scans[metrics.scans.length - 1] : null);

// The new candidates of the project's last architecture check: its candidates.json (inputs) with
// the triage verdict and your decision per item. null before the first check.
async function candidatesPart(ctx, name, profile) {
  const [row] = await listRuns(ctx.dataDir, { project: name, pipeline: 'architecture', limit: 1 });
  if (!row) return null;
  const run = await loadRun(ctx.dataDir, name, row.id);
  if (!run) return null;
  const list = await readJsonFile(join(runDir(ctx.dataDir, run), 'inputs', 'candidates.json'), []).catch(() => []);
  const triage = (run.outputs && run.outputs.triage && Array.isArray(run.outputs.triage.items)) ? run.outputs.triage.items : [];
  const items = (Array.isArray(list) ? list : []).slice(0, MAX_CANDIDATES).filter(c => c && c.ref).map(c => {
    const t = triage.find(x => x && x.ref === c.ref) || null;
    return {
      ref: c.ref, probe: c.probe || '', label: metricLabel(profile, c.probe || ''), path: c.path || '', line: c.line ?? null, text: c.text || '',
      verdict: t ? t.verdict : null, reason: t ? t.reason || '' : '', suggestedSlice: t ? t.suggestedSlice || '' : '',
      decision: t && t.triage ? t.triage : null,
    };
  });
  return {
    runId: run.id, status: run.status, waiting: run.waiting ? run.waiting.kind : null, at: run.updatedAt || run.createdAt,
    scanId: run.outputs && run.outputs.scan ? run.outputs.scan.scanId || null : null, items,
  };
}

// The allowlist card: whether one is saved, and what a rebuild from the last scan would change.
async function allowlistPart(ctx, name, metrics) {
  const current = await loadAllowlist(ctx.dataDir, name);
  const out = { setUp: current !== null, count: current ? current.length : 0 };
  const scan = latestScan(metrics);
  if (!scan) return out;
  let proposal;
  try { proposal = allowlistProposal(scan, current); } catch { return out; }
  if (!out.setUp || proposal.add.length || proposal.remove.length) {
    out.proposal = { add: proposal.add, remove: proposal.remove, count: proposal.list.length, scanId: scan.id };
  }
  return out;
}

export function routes(ctx) {
  return {
    // ?project=: the Health view. Without a profile the parts that need one are empty.
    'GET /api/metrics': async (req, res, url) => {
      const p = projectOrThrow(ctx, url.searchParams.get('project'));
      const [profile, metrics, kf, allowlist, findings, wins] = await Promise.all([
        profileOrNull(ctx, p), loadMetrics(ctx.dataDir, p.name), knownFailuresFrom(ctx.dataDir, p.name).catch(() => null),
        loadAllowlist(ctx.dataDir, p.name).catch(() => null), loadFindings(ctx.dataDir, p.name), loadWins(ctx.dataDir, p.name, { limit: 200 }),
      ]);
      const settings = loadSettings(ctx.dataDir);
      const latest = latestScan(metrics);
      const values = kf ? { knownFailures: kf.value } : {};
      const [candidates, days, weekly, allowlistState] = await Promise.all([
        part(() => candidatesPart(ctx, p.name, profile)),
        part(() => activityDays({ dataDir: ctx.dataDir, project: p.name })),
        part(() => (p.present && profile ? weeklyLog({ git: coreGit.git, mainDir: p.mainDir, profile }) : [])),
        part(() => allowlistPart(ctx, p.name, metrics)),
      ]);
      return {
        ok: true,
        latest,
        tiles: profile ? tiles(profile, metrics, { knownFailures: kf, allowlist }) : [],
        score: scoreTrend(metrics),
        lenses: profile ? lensRows(profile, metrics) : [],
        candidates,
        wins: wins.filter(w => w && w.kind === 'ratchet').slice(0, 20).map(w => ({ ...w, text: winText(w) })),
        achievements: profile ? achievementList({ profile, metrics, findings, earned: wins.filter(w => w && w.kind === 'achievement'), values }) : [],
        boss: currentBoss(findings, profile && profile.fun ? profile.fun.bossPhase : undefined),
        streak: Array.isArray(days) ? streak(days, { enabled: settings.fun.streak }) : { ...streak([], { enabled: false }), error: days.error },
        weekly,
        allowlist: allowlistState,
        knownFailures: kf,
      };
    },

    // { project, preview, scanId }: with preview, the proposal from the last scan (add, remove,
    // list, scanId); without, it saves that list. A scanId that is not the last scan any more
    // (a new scan came in after the preview) is refused with 409.
    'POST /api/allowlist': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (b.scanId !== undefined && (typeof b.scanId !== 'string' || !SCAN_ID_RE.test(b.scanId))) throw new HttpError(400, 'That is not a scan id.');
      const metrics = await loadMetrics(ctx.dataDir, p.name);
      const scan = latestScan(metrics);
      if (!scan) throw new HttpError(400, 'There is no scan yet. Run the architecture check first.');
      const current = await loadAllowlist(ctx.dataDir, p.name);
      let proposal;
      try { proposal = allowlistProposal(scan, current); } catch (e) { throw new HttpError(400, e.message); }
      if (b.preview) return { ok: true, proposal: { ...proposal, scanId: scan.id, sha: scan.sha || null } };
      if (b.scanId && b.scanId !== scan.id) throw new HttpError(409, 'A newer scan came in since you looked at the proposal. Look at it again, then save.');
      const saved = await saveAllowlist(ctx.dataDir, p.name, proposal.list, { source: { scanId: scan.id, sha: scan.sha || null } });
      return { ok: true, count: saved.count, message: `Saved the allowlist: ${saved.count} procedure${saved.count === 1 ? '' : 's'} from scan ${scan.id}.` };
    },
  };
}
