// Today (SPEC 4 and 5.2): the landing view, across every project with a profile.
//   GET  /api/today           what waits for you (runs at a gate or stopped, a smaller baseline,
//                             an import to apply), what runs, Next up, health per project, the
//                             inbox, recent results, Today so far and the last win
//   POST /api/today/handoff   { project }: the end-of-day handoff note, written by code from run
//                             folders, findings and git (no Claude), saved as
//                             inbox/handoffs/<date>-<project>-day[-n].md in the hub
//
// Everything is read from the private data folder, the hub's inbox and read-only git. The handoff
// is the only file this module writes, and fun/fun.mjs saveHandoff never overwrites an earlier
// note (it adds -2, -3, ...). The inbox is git-ignored, so the note never reaches the public repo.
// "The focus project" (Today so far, Next up first) is the profiled project with the latest run.
// Action hrefs open the project's page at the tab that shows the thing (#project/<name>/checks
// for a smaller baseline, /findings for an import, /architecture for health and decisions).
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { scanInbox } from '../../lib/inbox.mjs';
import { PROJECT_RE } from '../core/datadir.mjs';
import * as coreGit from '../core/git.mjs';
import { loadFindings, loadPendingImport, nextUp, runMedians } from '../findings/store.mjs';
import { currentBoss, dayRuns, handoffNote, localDay, saveHandoff, todaySummary, winText } from '../fun/fun.mjs';
import { listBaselines, loadCandidate } from '../gates/baseline.mjs';
import { readHistory } from '../gates/history.mjs';
import { HttpError, readJson } from '../http.mjs';
import { knownFailuresFrom, loadMetrics, loadWins, scoreTrend } from '../probes/metrics.mjs';
import { pipelineById } from '../runs/catalog.mjs';
import { PIPELINE_LABELS } from '../runs/report.mjs';
import { findRun, listRuns } from '../runs/store.mjs';
import { candidateSummary, part, profileFor, projectOrThrow } from './cockpit.mjs';
import { withDurations } from './findings.mjs';

const RUN_LIMIT = 500;
const RECENT_MAX = 8;
const RUNNING_MAX = 10;
// A run waiting at a gate: what the row calls it and the badge.
const GATES = {
  plan: ['plan gate', 'Approve plan'], spec: ['spec gate', 'Approve spec'], hypothesis: ['hypothesis gate', 'Pick hypothesis'],
  fence: ['fence gate', 'Allow files?'], review: ['review gate', 'Review'], commit: ['commit gate', 'Commit'],
  triage: ['triage', 'Triage'], decide: ['decision', 'Decide'],
};
// Runs that stopped and wait for Retry, Resume or Stop (they keep the lock).
const STOPPED = { 'gates-red': 'Checks red', capped: 'Cap reached', interrupted: 'Interrupted', 'paused-limit': 'Paused: usage limit' };
const RECENT = { passed: 'Passed', committed: 'Committed', failed: 'Failed', cancelled: 'Cancelled', parked: 'Parked' };
// Inbox file kinds, in the order the group text lists them.
const KINDS = [
  [/\.(png|jpe?g|gif|webp|bmp)$/i, 'screenshot', 'screenshots'], [/\.pdf$/i, 'PDF', 'PDFs'],
  [/\.(url|webloc|link)$/i, 'link', 'links'], [/\.(md|txt)$/i, 'note', 'notes'], [/./, 'file', 'files'],
];

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const pipelineLabel = id => PIPELINE_LABELS[id] || id || 'Run';
const whenOf = r => r.endedAt || r.at || r.createdAt || '';

// Every project with a profile in the data folder, with its lookup and checked profile.
async function profiledProjects(ctx) {
  let names = [];
  try {
    names = (await readdir(join(ctx.dataDir, 'profiles')))
      .filter(n => n.endsWith('.json') && !n.endsWith('.allowlist.json')).map(n => n.slice(0, -5)).filter(n => PROJECT_RE.test(n));
  } catch { /* no profiles yet */ }
  const out = [];
  for (const name of names.sort()) {
    let p;
    try { p = projectOrThrow(ctx, name); } catch { continue; }
    const info = await profileFor(ctx, p);
    out.push({ ...p, info, profile: info.valid ? info.profile : null, label: (info.profile && info.profile.label) || name });
  }
  return out;
}

function labelOf(projects, name) {
  const pr = projects.find(x => x.name === name);
  return pr ? pr.label : name;
}

// ---------------------------------------------------------------- waiting

function runWaitingRow(r, projects) {
  const where = labelOf(projects, r.project);
  if (r.status === 'waiting') {
    const [what, badge] = GATES[r.waiting] || ['next gate', 'Needs you'];
    const href = r.waiting === 'review' || r.waiting === 'commit' ? `#review/${r.id}` : r.waiting === 'decide' ? `#project/${r.project}/architecture` : `#run/${r.id}`;
    return {
      kind: 'run', project: r.project, runId: r.id, title: r.title || r.id, status: r.status, waiting: r.waiting || null, since: r.at || null,
      sub: `${pipelineLabel(r.pipeline)} · ${where} · waiting at the ${what}`, badge, action: { label: 'Open', href },
    };
  }
  return {
    kind: 'run', project: r.project, runId: r.id, title: r.title || r.id, status: r.status, waiting: null, since: r.at || null,
    sub: `${pipelineLabel(r.pipeline)} · ${where} · ${STOPPED[r.status].toLowerCase()}; retry, resume or stop it`,
    badge: STOPPED[r.status], action: { label: 'Open', href: `#run/${r.id}` },
  };
}

// A smaller baseline or a findings import that waits for your click, per profiled project.
async function projectWaiting(ctx, pr) {
  const out = [];
  for (const b of (await listBaselines(ctx.dataDir, pr.name)).filter(x => x.hasCandidate).slice(0, 3)) {
    const c = await loadCandidate(ctx.dataDir, pr.name, b.key).catch(() => null);
    if (!c) continue;
    const s = candidateSummary(c);
    out.push({
      kind: 'baseline', project: pr.name, key: b.key, title: `Smaller baseline available: ${s.from} → ${s.to} known failures`,
      sub: `${pr.label} · ${plural(s.leaving.length, 'known failure')} now pass · nothing changes until you accept it`, since: s.madeAt,
      badge: 'Accept?', action: { label: 'Review difference', href: `#project/${pr.name}/checks` },
    });
  }
  const pending = await loadPendingImport(ctx.dataDir, pr.name).catch(() => null);
  if (pending && pending.proposal) {
    const counts = pending.proposal.counts || {};
    out.push({
      kind: 'import', project: pr.name, title: 'Findings import waiting for you',
      sub: `${pr.label} · ${plural(counts.changed || 0, 'change')} proposed · nothing is written until you apply it`, since: pending.createdAt || null,
      badge: 'Apply?', action: { label: 'Open', href: `#project/${pr.name}/findings` },
    });
  }
  return out;
}

// ---------------------------------------------------------------- running and recent

async function runningRow(ctx, r, projects) {
  const run = await findRun(ctx.dataDir, r.id).catch(() => null);
  const cur = run && run.current ? run.current : null;
  const stage = run && cur ? (run.stages || []).find(s => s.id === cur.stage) : null;
  const attempt = stage && Array.isArray(stage.attempts) && stage.attempts.length ? stage.attempts[stage.attempts.length - 1] : null;
  const def = pipelineById(r.pipeline);
  const stageDef = def && cur ? def.stages.find(s => s.id === cur.stage) : null;
  const iso = run && run.isolation;
  const tree = iso && iso.tree ? (iso.treeMode === 'run' ? basename(iso.tree) : 'main checkout') : null;
  const started = Date.parse(r.createdAt || (run && run.createdAt));
  const minutes = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 60000)) : null;
  const turns = attempt && Number.isFinite(attempt.turns) ? attempt.turns : null;
  const maxTurns = attempt && Number.isFinite(attempt.maxTurns) ? attempt.maxTurns : null;
  const round = cur && Number.isInteger(cur.round) ? cur.round : null;
  const stageLabel = stageDef ? stageDef.label : (cur && cur.stage) || '';
  const bits = [stageLabel || pipelineLabel(r.pipeline)];
  if (round && round > 1) bits.push(`round ${round}`);
  if (turns !== null) bits.push(`turns ${turns}${maxTurns ? `/${maxTurns}` : ''}`);
  if (minutes !== null) bits.push(`${minutes} min`);
  if (tree) bits.push(tree);
  if (run && run.branch) bits.push(run.branch);
  return {
    kind: 'run', project: r.project, label: labelOf(projects, r.project), runId: r.id, title: r.title || r.id, status: r.status,
    pipeline: r.pipeline, stage: cur ? cur.stage : r.stage || null, stageLabel, round, turns, maxTurns, minutes, tree,
    branch: run ? run.branch : r.branch || null, level: r.level || null, sub: bits.join(' · '),
    badge: r.status === 'in-terminal' ? 'In terminal' : 'Running', action: { label: 'Open', href: `#run/${r.id}` },
  };
}

function recentRow(r, chips) {
  const bits = [pipelineLabel(r.pipeline)];
  if (r.commit) bits.push(`committed ${String(r.commit).slice(0, 7)}`);
  if (r.branch) bits.push(`on ${r.branch}`);
  if (chips.has(r.id)) bits.push(chips.get(r.id));
  return {
    project: r.project, runId: r.id, title: r.title || r.id, status: r.status, badge: RECENT[r.status], sub: bits.join(' · '),
    at: whenOf(r) || null, commit: r.commit || null, branch: r.branch || null, action: { label: 'Open', href: `#run/${r.id}` },
  };
}

// ---------------------------------------------------------------- health, inbox, wins

async function healthOf(ctx, pr) {
  const [metrics, kf, hist] = await Promise.all([
    loadMetrics(ctx.dataDir, pr.name).catch(() => ({ scans: [] })), knownFailuresFrom(ctx.dataDir, pr.name).catch(() => null),
    readHistory(ctx.dataDir, pr.name, { limit: 1 }).catch(() => []),
  ]);
  const pin = pr.profile && pr.profile.node ? pr.profile.node.pin || null : null;
  const active = process.versions.node;
  const last = metrics.scans[metrics.scans.length - 1];
  return {
    project: pr.name, label: pr.label, linked: pr.present, valid: pr.info.valid, score: scoreTrend(metrics),
    knownFailures: kf ? { value: kf.value, new: hist[0] && hist[0].counts ? hist[0].counts.new ?? null : null, level: kf.level } : null,
    lastCheck: hist[0] || null, lastScanAt: last ? last.at : null, node: { active, pin, matches: pin ? pin === active : null },
    action: { label: 'Open Architecture', href: `#project/${pr.name}/architecture` },
  };
}

function kindsText(kinds) {
  return KINDS.map(([, one, many]) => (kinds[one] ? plural(kinds[one], one, many) : '')).filter(Boolean).join(', ');
}

// The inbox card: { total, truncated, groups: [{ folder, count, text, newest }] }, newest group
// first; a group is the top folder under inbox/ ("2 screenshots", "1 PDF, 1 link").
function inboxPart(root) {
  const scan = scanInbox(root);
  const groups = new Map();
  for (const it of scan.items) {
    const folder = it.parts.length > 1 ? `inbox/${it.parts[0]}` : 'inbox';
    const g = groups.get(folder) || { folder, count: 0, kinds: {}, newest: 0 };
    const kind = KINDS.find(([re]) => re.test(it.path))[1];
    g.count++;
    g.kinds[kind] = (g.kinds[kind] || 0) + 1;
    g.newest = Math.max(g.newest, it.mtimeMs || 0);
    groups.set(folder, g);
  }
  return {
    total: scan.items.length, truncated: scan.truncated,
    groups: [...groups.values()].sort((a, b) => b.newest - a.newest)
      .map(g => ({ folder: g.folder, count: g.count, text: kindsText(g.kinds), newest: g.newest ? new Date(g.newest).toISOString() : null })),
  };
}

async function lastWinOf(ctx, projects) {
  let best = null;
  for (const pr of projects) {
    const [w] = await loadWins(ctx.dataDir, pr.name, { limit: 1 }).catch(() => []);
    if (w && (!best || String(w.at) > String(best.at))) best = { ...w, project: pr.name, text: winText(w) };
  }
  return best;
}

// The profiled projects in focus order: the one with the latest run first, then by name.
function focusOrder(projects, runs) {
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.project) || String(r.at) > String(latest.get(r.project))) latest.set(r.project, r.at);
  return [...projects].sort((a, b) => String(latest.get(b.name) || '').localeCompare(String(latest.get(a.name) || '')) || a.name.localeCompare(b.name));
}

async function nextUpAcross(ctx, ordered, runs) {
  for (const pr of ordered) {
    const doc = await loadFindings(ctx.dataDir, pr.name).catch(() => null);
    if (!doc) continue;
    const n = nextUp(doc, { medians: runMedians(withDurations(runs.filter(r => r.project === pr.name))) });
    if (n) return { ...n, project: pr.name, label: pr.label, pipeline: 'fix', action: { label: 'Start fix', href: '#launcher/fix' } };
  }
  return null;
}

export function routes(ctx) {
  return {
    'GET /api/today': async () => {
      const date = localDay(new Date());
      const [projects, runs] = await Promise.all([profiledProjects(ctx), listRuns(ctx.dataDir, { limit: RUN_LIMIT })]);
      const ordered = focusOrder(projects, runs);
      const focus = ordered[0] || null;

      const waiting = runs.filter(r => r.status === 'waiting' || STOPPED[r.status]).sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .map(r => runWaitingRow(r, projects));
      for (const pr of ordered) {
        const more = await part(() => projectWaiting(ctx, pr));
        if (Array.isArray(more)) waiting.push(...more);
      }
      const running = await Promise.all(runs.filter(r => r.status === 'running' || r.status === 'in-terminal').slice(0, RUNNING_MAX)
        .map(r => runningRow(ctx, r, projects)));

      const chips = new Map();
      for (const pr of projects) {
        for (const h of await readHistory(ctx.dataDir, pr.name, { limit: 20 }).catch(() => [])) if (h.runId && h.chip) chips.set(h.runId, h.chip);
      }
      const recent = runs.filter(r => RECENT[r.status]).sort((a, b) => String(whenOf(b)).localeCompare(String(whenOf(a))))
        .slice(0, RECENT_MAX).map(r => recentRow(r, chips));

      const [next, health, inbox, todaySoFar, lastWin] = await Promise.all([
        part(() => nextUpAcross(ctx, ordered, runs)),
        // A project whose health can't be read still names itself, so its card has a title.
        Promise.all(projects.map(async pr => {
          const h = await part(() => healthOf(ctx, pr));
          return h && h.error ? { project: pr.name, label: pr.label, ...h } : h;
        })),
        part(() => inboxPart(ctx.root)),
        part(async () => {
          if (!focus) return null;
          const s = await todaySummary({ dataDir: ctx.dataDir, project: focus.name, mainDir: focus.mainDir, git: focus.present ? coreGit.git : null, date, profile: focus.profile || undefined });
          return { project: focus.name, label: focus.label, ...s };
        }),
        part(() => lastWinOf(ctx, projects)),
      ]);
      return {
        ok: true, date,
        projects: projects.map(pr => ({ name: pr.name, label: pr.label, present: pr.present, linked: pr.linked, valid: pr.info.valid })),
        waiting, running, nextUp: next, health, inbox, recent, todaySoFar, lastWin,
      };
    },

    // { project }: { path } of the saved note, hub-relative ("inbox/handoffs/...").
    'POST /api/today/handoff': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      const info = await profileFor(ctx, p);
      const profile = info.exists && info.valid ? info.profile : null;
      const date = localDay(new Date());
      const [summary, runs, findings] = await Promise.all([
        todaySummary({ dataDir: ctx.dataDir, project: p.name, mainDir: p.mainDir, git: p.present ? coreGit.git : null, date, profile: profile || undefined }),
        dayRuns({ dataDir: ctx.dataDir, project: p.name, date }),
        loadFindings(ctx.dataDir, p.name),
      ]);
      const boss = currentBoss(findings, profile && profile.fun ? profile.fun.bossPhase : undefined);
      const text = handoffNote({
        summary, runs, findings, date, project: p.name, label: (profile && profile.label) || p.name, boss,
        allow: (profile && profile.secrets && profile.secrets.allowValues) || [],
      });
      let saved;
      try { saved = await saveHandoff({ root: ctx.root, project: p.name, date, text }); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, path: saved.path, message: `Saved the handoff to ${saved.path}.` };
    },
  };
}
