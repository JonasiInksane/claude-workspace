// Fun features: small rewards computed from run folders, the findings board, metrics and git.
// They cost no tokens and never call Claude.
//
//   todaySummary   "2 slices · 1 finding closed · health +3 · 0 new failures" (Today so far)
//   streak         days with a committed slice; days off freeze it (off by default)
//   bossBar        the phase boss: each open high or critical finding in the phase is 1 HP
//   achievements   profile-defined badges tied to real numbers, appended to the wins log
//   weeklyLog      this week's commits on the integration branch that touch the records folder
//   handoffNote    the end-of-day handoff Markdown, written by code from the facts above
//   saveHandoff    writes it to the hub's git-ignored inbox/handoffs/, never over an older note
//
// Inputs (all in the private data folder): runs/index.jsonl, findings/<p>.json,
// metrics/<p>.json, checks/<p>/history.jsonl and wins/<p>.jsonl. Missing files mean "nothing yet".
// Git is only read, through the injected git(dir, args) function (core/git.mjs).
// Only work counts: a finding is "closed today" when a run committed it or a merge made it done
// (history by 'run' or 'merged'), and a decision is yours (by 'user'). The history an import
// writes (by 'import') is the audit's past, not today's work.
// A bad project name or date is the caller's mistake, so it throws with status 400.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { appendJsonl, projectPaths, readJson, readJsonl } from '../core/datadir.mjs';
import { checkRef, gitText } from '../findings/import.mjs';
import { PROJECT_RE, findingsFile, nextUp as pickNextUp, phaseBars } from '../findings/store.mjs';
import { redact } from '../gates/secrets.mjs';
import { PIPELINE_LABELS } from '../runs/report.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const WAITING_LABELS = {
  plan: 'plan gate', spec: 'spec gate', hypothesis: 'hypothesis gate', fence: 'fence gate',
  review: 'review gate', commit: 'commit gate', triage: 'triage', decide: 'decision',
};
const STOPPED = ['failed', 'gates-red', 'capped', 'interrupted', 'paused-limit', 'parked'];
const STATUS_LABELS = {
  running: 'running', waiting: 'needs you', 'in-terminal': 'in terminal', passed: 'passed', committed: 'committed',
  failed: 'failed', 'gates-red': 'checks red', capped: 'cap reached', 'paused-limit': 'paused: usage limit',
  interrupted: 'interrupted', parked: 'parked', cancelled: 'cancelled',
};
// Setting up the run worktree is housekeeping, not work: it never counts as a run here.
const NOT_WORK = new Set(['setup-worktree']);
// Who made a history entry count as a closed finding, and as a decision.
const CLOSED_BY = new Set(['run', 'merged']);
const DECIDED_BY = 'user';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkProject(project) {
  if (!PROJECT_RE.test(String(project || ''))) throw httpError(400, `"${project}" is not a valid project name.`);
  return project;
}

function checkDay(date) {
  if (!DAY_RE.test(String(date))) throw httpError(400, `"${date}" is not a date (YYYY-MM-DD).`);
  return date;
}

// A history entry that closed a finding through work: a commit on a branch or a merge.
const closedByWork = h => !!h && (h.to === 'done' || h.to === 'on-branch') && CLOSED_BY.has(h.by);

const pad = n => String(n).padStart(2, '0');

// The local calendar day (YYYY-MM-DD) of an ISO time or Date; '' when it isn't a date.
export function localDay(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(day, n) {
  const d = dayStart(day);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneLine = (text, max = 120) => {
  const s = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};
const shortSha = c => {
  const sha = typeof c === 'string' ? c : c && typeof c.sha === 'string' ? c.sha : '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : '';
};
const isoNoMs = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function rowsOf(file) {
  try {
    return (await readJsonl(file)).rows || [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Facts per run of one project from runs/index.jsonl: Map id -> {id, row (last line),
// startedAt, committedAt, commit}. Index lines carry createdAt and endedAt, so the facts survive
// the index compaction that keeps only the last line per run; older lines without them fall back
// to the time of the first line and of the first "committed" line.
export async function runFacts(dataDir, project) {
  checkProject(project);
  const facts = new Map();
  for (const row of await rowsOf(projectPaths(dataDir, project).runsIndex)) {
    if (!row || row.project !== project || !row.id || NOT_WORK.has(row.pipeline)) continue;
    let f = facts.get(row.id);
    if (!f) {
      f = { id: row.id, row, startedAt: row.createdAt || row.at, committedAt: null, commit: null };
      facts.set(row.id, f);
    }
    f.row = row;
    if (row.createdAt) f.startedAt = row.createdAt;
    if (row.status === 'committed') {
      if (!f.committedAt) f.committedAt = row.endedAt || row.at;
      if (row.commit) f.commit = row.commit;
    }
  }
  return facts;
}

// The latest index row of every run of `project` that started, finished or changed on `date`.
export async function dayRuns({ dataDir, project, date = localDay(new Date()) }) {
  const facts = await runFacts(dataDir, project);
  const out = [];
  for (const f of facts.values()) {
    const touched = localDay(f.startedAt) === date || localDay(f.row.at) === date || (f.committedAt && localDay(f.committedAt) === date);
    if (touched) out.push({ ...f.row, startedAt: f.startedAt, committedAt: f.committedAt });
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export function winText(w) {
  if (!w) return '';
  if (w.kind === 'achievement') return `Achievement: ${oneLine(w.label || w.id, 80)}`;
  const via = w.via || {};
  const how = shortSha(via.sha) ? ` via ${shortSha(via.sha)}` : via.branch ? ` via ${oneLine(via.branch, 60)}` : '';
  return `${oneLine(w.label || w.metric, 80)} ${w.from} → ${w.to}${how}`;
}

function healthDeltaOn(metrics, date) {
  const scans = (Array.isArray(metrics?.scans) ? metrics.scans : [])
    .filter(s => s && typeof s.score === 'number' && localDay(s.at))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const start = dayStart(date);
  const today = scans.filter(s => localDay(s.at) === date);
  if (!today.length) return null;
  const before = scans.filter(s => new Date(s.at) < start).pop();
  return today[today.length - 1].score - (before ? before.score : today[0].score);
}

// Commits on any local branch on `date` that touch the records folder: the slices you shipped
// from interactive sessions. A Set of short SHAs.
async function recordCommitsOn({ git, mainDir, recordsDir, date }) {
  const start = dayStart(date);
  const end = dayStart(addDays(date, 1));
  const out = await gitText(git, mainDir, ['log', '--branches', '--no-merges', `--since=${isoNoMs(start)}`, `--until=${isoNoMs(end)}`,
    '--format=%H', '--', recordsDir.replace(/\\/g, '/')]);
  return new Set(out.split(/\r?\n/).map(shortSha).filter(Boolean));
}

// Today so far, for one project and one local day. Returns
//   { date, slicesCommitted, runs, findingsClosed, healthDelta, newFailures, lastWin, commits,
//     text, warnings }
// slicesCommitted counts commit-gate commits from the run index plus commits that touch the
// records folder (interactive slices), each SHA once. healthDelta and newFailures are null when
// there was no scan or no check that day. findingsClosed counts findings a run committed (on
// branch) or a merge made done that day; an import's history never counts.
export async function todaySummary({ dataDir, project, mainDir, git, date = localDay(new Date()), profile }) {
  checkProject(project);
  checkDay(date);
  const paths = projectPaths(dataDir, project);
  const warnings = [];
  const facts = [...(await runFacts(dataDir, project)).values()];
  const runs = facts.filter(f => localDay(f.startedAt) === date).length;
  const committed = facts.filter(f => f.committedAt && localDay(f.committedAt) === date);
  const commits = new Set(committed.map(f => shortSha(f.commit)).filter(Boolean));
  const withoutSha = committed.filter(f => !shortSha(f.commit)).length;

  let prof = profile;
  if (!prof) prof = await readJson(paths.profile, null).catch(() => null);
  const recordsDir = prof?.docs?.recordsDir;
  if (git && mainDir && recordsDir) {
    try {
      for (const sha of await recordCommitsOn({ git, mainDir, recordsDir, date })) commits.add(sha);
    } catch (e) {
      warnings.push(`git log failed, so interactive slices were not counted: ${oneLine(e.stderr || e.message, 160)}`);
    }
  }

  const doc = await readJson(findingsFile(dataDir, project), null);
  const closed = new Set();
  for (const f of doc?.findings || []) {
    for (const h of f.history || []) if (closedByWork(h) && localDay(h.at) === date) closed.add(f.id);
  }

  const metrics = await readJson(paths.metrics, null);
  const healthDelta = healthDeltaOn(metrics, date);

  const checks = (await rowsOf(paths.checksHistory))
    .filter(r => r && localDay(r.at) === date).sort((a, b) => new Date(a.at) - new Date(b.at));
  const lastCheck = checks[checks.length - 1];
  const newFailures = lastCheck && typeof lastCheck.counts?.new === 'number' ? lastCheck.counts.new : null;

  const wins = await rowsOf(paths.wins);
  const last = wins.filter(w => w && (w.kind === 'ratchet' || w.kind === 'achievement')).pop() || null;
  const lastWin = last ? { ...last, text: winText(last) } : null;

  const slicesCommitted = commits.size + withoutSha;
  const parts = [plural(slicesCommitted, 'slice'), `${plural(closed.size, 'finding')} closed`];
  if (healthDelta !== null) parts.push(`health ${healthDelta > 0 ? '+' : healthDelta < 0 ? '−' : '±'}${Math.abs(healthDelta)}`);
  parts.push(newFailures === null ? 'no checks yet' : `${newFailures} new failure${newFailures === 1 ? '' : 's'}`);
  return {
    date, slicesCommitted, runs, findingsClosed: closed.size, healthDelta, newFailures, lastWin,
    commits: [...commits], text: parts.join(' · '), warnings,
  };
}

// Per-day activity for the streak: [{date, runs, commits}] for the days that had any, from the
// run index (runs started that day; commit-gate commits made that day).
export async function activityDays({ dataDir, project, today = localDay(new Date()), days = 60 }) {
  const from = addDays(today, -(days - 1));
  const per = new Map();
  const bump = (day, key) => {
    if (!day || day < from || day > today) return;
    const d = per.get(day) || { date: day, runs: 0, commits: 0 };
    d[key]++;
    per.set(day, d);
  };
  for (const f of (await runFacts(dataDir, project)).values()) {
    bump(localDay(f.startedAt), 'runs');
    if (f.committedAt) bump(localDay(f.committedAt), 'commits');
  }
  return [...per.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The streak (the mockup: "counts days with a reviewed, committed slice; days off freeze it
// instead of breaking it; starting runs does not count"). A work day is a day with at least one
// run started. A day with a commit-gate commit adds one (also when its run started the day
// before), a work day without one breaks the streak, and a day with no runs freezes it. Today is
// not over, so a run without a commit yet doesn't break anything. Off by default.
//   days: [{date, runs, commits}] (activityDays). Returns
//   { enabled, current, best, frozen, lastFrozen, pendingToday, text }
export function streak(days, { enabled = false, today = localDay(new Date()) } = {}) {
  if (!enabled) return { enabled: false, current: 0, best: 0, frozen: 0, lastFrozen: null, pendingToday: false, text: 'Streak is off.' };
  const per = new Map();
  for (const d of Array.isArray(days) ? days : []) {
    if (!d || !DAY_RE.test(String(d.date))) continue;
    const x = per.get(d.date) || { runs: 0, commits: 0 };
    x.runs += Number(d.runs) || 0;
    x.commits += Number(d.commits) || 0;
    per.set(d.date, x);
  }
  const dates = [...per.keys()].sort();
  let current = 0;
  let best = 0;
  let frozen = 0;
  let lastFrozen = null;
  let pendingToday = false;
  if (dates.length) {
    const end = today && today > dates[dates.length - 1] ? today : dates[dates.length - 1];
    for (let day = dates[0]; day <= end; day = addDays(day, 1)) {
      const x = per.get(day) || { runs: 0, commits: 0 };
      if (x.commits > 0) {
        current++;
        best = Math.max(best, current);
      } else if (x.runs > 0) {
        if (day === today) pendingToday = true;
        else {
          current = 0;
          lastFrozen = null;
        }
      } else if (day !== today) {
        frozen++;
        if (current > 0) lastFrozen = day;
      }
    }
  }
  let text = `Streak: ${plural(current, 'day')}`;
  if (lastFrozen) text += ` (${dayStart(lastFrozen).toLocaleDateString('en-US', { weekday: 'long' })} was frozen)`;
  if (pendingToday) text += '; commit a reviewed slice today to keep it going';
  return { enabled: true, current, best, frozen, lastFrozen, pendingToday, text: `${text}.` };
}

// The phase boss. Each high or critical finding in the phase is a hit point; it is knocked off
// when the fix is committed (on branch), merged (done) or dismissed. Returns
//   { phase, label, hp, total, ids, defeated, pct, text }  (ids: the findings still standing)
export function bossBar(doc, phase) {
  const id = String(phase ?? '');
  const p = (doc?.phases || []).find(x => String(x.id) === id);
  const bosses = (doc?.findings || []).filter(f => String(f.phase) === id &&
    (f.severity === 'high' || f.severity === 'critical') && f.status !== 'proposed');
  const standing = bosses.filter(f => f.status === 'open' || f.status === 'in-run');
  const hp = standing.length;
  const total = bosses.length;
  let text = `${hp} HP left`;
  if (!total) text = 'No high or critical findings in this phase';
  else if (!hp) text = 'Defeated';
  return {
    phase: id, label: p ? p.label : `Phase ${id}`, hp, total, ids: standing.map(f => f.id),
    defeated: total > 0 && hp === 0, pct: total ? Math.round((hp / total) * 100) : 0, text,
  };
}

// The boss to show: the first phase from `startPhase` on (profile fun.bossPhase) that still has
// hit points. Defeated phases before it become trophies. Returns bossBar(...) plus { trophies }.
export function currentBoss(doc, startPhase) {
  const phases = (doc?.phases || []).map(p => String(p.id));
  let i = phases.indexOf(String(startPhase ?? ''));
  if (i < 0) i = 0;
  const trophies = [];
  let lastWithBosses = null;
  for (; i < phases.length; i++) {
    const b = bossBar(doc, phases[i]);
    if (!b.total) continue;
    lastWithBosses = b;
    if (!b.defeated) return { ...b, trophies };
    trophies.push({ phase: b.phase, label: b.label });
  }
  const shown = lastWithBosses || bossBar(doc, startPhase ?? phases[0] ?? '');
  return { ...shown, trophies };
}

// ---- achievements ----

const OPS = {
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '==': (a, b) => a === b, '=': (a, b) => a === b, '!=': (a, b) => a !== b,
};

function latestValues(metrics) {
  if (!metrics || typeof metrics !== 'object') return {};
  if (Array.isArray(metrics.scans)) return metrics.scans[metrics.scans.length - 1]?.values || {};
  if (metrics.values && typeof metrics.values === 'object') return metrics.values;
  return metrics;
}

// A metric by path: "deepImports" is values.deepImports.value (or a plain number),
// "serverCycles.largestModuleCycle" is values.serverCycles.largestModuleCycle. null if missing.
export function metricValue(values, path) {
  const [head, ...rest] = String(path || '').split('.');
  let v = values ? values[head] : undefined;
  if (rest.length) {
    for (const k of rest) v = v && typeof v === 'object' ? v[k] : undefined;
  } else if (v && typeof v === 'object') v = v.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const OP_WORDS = { '<': 'under', '<=': 'at most', '>': 'over', '>=': 'at least', '==': 'exactly', '=': 'exactly', '!=': 'not' };
const SUB_WORDS = { largestModuleCycle: 'largest module cycle', max: 'worst locale', min: 'best locale', modules: 'modules' };

// The words for a metric path: the probe's label from the profile, plus the sub-metric.
export function metricName(profile, path) {
  if (path === 'knownFailures') return 'known test failures';
  const [id, ...rest] = String(path || '').split('.');
  const probe = (Array.isArray(profile?.probes) ? profile.probes : []).find(p => p && p.id === id);
  const base = oneLine(probe?.label || id, 60);
  const sub = rest.map(k => SUB_WORDS[k] || k).join(', ');
  return sub ? `${base}, ${sub}` : base;
}

function evaluate(a, values, bars, profile) {
  const w = a.when || {};
  if (w.phaseClosed !== undefined) {
    const bar = bars.find(b => b.id === String(w.phaseClosed));
    const met = !!bar && bar.total > 0 && bar.left === 0;
    return { met, need: `every finding in Phase ${w.phaseClosed} closed`, now: bar ? `${bar.left} left` : null };
  }
  const op = OPS[w.op];
  const now = metricValue(values, w.metric);
  if (!op || typeof w.value !== 'number') return { met: false, need: 'a rule this app does not understand', now: null };
  return { met: now !== null && op(now, w.value), need: `${metricName(profile, w.metric)} ${OP_WORDS[w.op]} ${w.value}`, now };
}

function earnedMap(earned) {
  const map = new Map();
  for (const e of Array.isArray(earned) ? earned : []) {
    if (typeof e === 'string') map.set(e, null);
    else if (e && e.id) map.set(e.id, e.at || null);
  }
  return map;
}

// Every achievement of the profile with its state, for the Achievements card:
//   [{ id, label, earned, at, met, text }]
//   text: "Earned · 2026-10-22" or "Locked · Web deep imports under 100 (now 163)"
//   values: extra metric values that are not in the scan, for example { knownFailures: 61 }.
export function achievementList({ profile, metrics, findings, earned, values }) {
  const vals = { ...latestValues(metrics), ...(values || {}) };
  const got = earnedMap(earned);
  const bars = findings ? phaseBars(findings) : [];
  return (Array.isArray(profile?.achievements) ? profile.achievements : [])
    .filter(a => a && typeof a.id === 'string' && a.when)
    .map(a => {
      const check = evaluate(a, vals, bars, profile);
      const isEarned = got.has(a.id);
      const at = got.get(a.id) || null;
      const text = isEarned
        ? `Earned${at ? ` · ${localDay(at)}` : ''}`
        : `Locked · ${check.need}${check.now !== null && check.now !== undefined ? ` (now ${check.now})` : ''}`;
      return { id: a.id, label: String(a.label || a.id), earned: isEarned, at, met: check.met, text };
    });
}

// The achievements earned now that were not earned before: [{at, kind: 'achievement', id, label}].
// `earned` is a list of ids or of earlier wins-log lines. The caller appends them to the wins log
// (or uses recordAchievements, which does both).
export function achievements({ profile, metrics, findings, earned, values, at = new Date().toISOString() }) {
  return achievementList({ profile, metrics, findings, earned, values })
    .filter(a => !a.earned && a.met)
    .map(a => ({ at, kind: 'achievement', id: a.id, label: a.label }));
}

const winQueues = new Map();
// Checks the achievements and appends the new ones to wins/<project>.jsonl, once each, one check
// at a time per project. Returns the new ones.
export function recordAchievements({ dataDir, project, profile, metrics, findings, values, at = new Date().toISOString() }) {
  checkProject(project);
  const file = projectPaths(dataDir, project).wins;
  const prev = winQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const earned = (await rowsOf(file)).filter(r => r && r.kind === 'achievement');
    const fresh = achievements({ profile, metrics, findings, earned, values, at });
    for (const w of fresh) await appendJsonl(file, w);
    return fresh;
  });
  winQueues.set(file, next);
  next.finally(() => { if (winQueues.get(file) === next) winQueues.delete(file); }).catch(() => {});
  return next;
}

// ---- weekly ship log ----

// Commits on the integration branch in the last `days` days that touch the records folder:
//   [{ sha, short, at, subject, records: [record name] }], newest first.
export async function weeklyLog({ git, mainDir, profile, now = new Date(), days = 7 }) {
  const integration = profile?.git?.integrationBranch;
  const recordsDir = String(profile?.docs?.recordsDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!integration || !recordsDir) return [];
  checkRef(integration, 'git.integrationBranch');
  const since = new Date(now.getTime() - days * DAY_MS);
  const out = await gitText(git, mainDir, ['log', integration, '--no-merges', `--since=${isoNoMs(since)}`,
    '--format=%x1e%H%x1f%cI%x1f%s', '--name-only', '--', recordsDir]);
  const entries = [];
  for (const chunk of out.split('\x1e')) {
    const [head, ...files] = chunk.split(/\r?\n/).filter(Boolean);
    if (!head) continue;
    const [sha, at, subject = ''] = head.split('\x1f');
    const records = files.map(f => f.trim())
      .filter(f => f.startsWith(`${recordsDir}/`) && /\.md$/i.test(f) && !/^readme\.md$/i.test(posix.basename(f)))
      .map(f => posix.basename(f).replace(/\.md$/i, ''));
    entries.push({ sha, short: sha.slice(0, 7), at, subject: oneLine(subject, 200), records });
  }
  return entries;
}

// ---- handoff ----

function runLine(r) {
  const label = PIPELINE_LABELS[r.pipeline] || r.pipeline || 'Run';
  return `${oneLine(r.title || r.id)} (${label})`;
}

// Index rows carry the waiting kind as a string; run.json carries { kind, since, detail }.
const waitKind = r => (typeof r?.waiting === 'string' ? r.waiting : r?.waiting?.kind);

// The end-of-day handoff note that "Write handoff" saves to inbox/handoffs/. Written by code from
// the day's facts (no Claude), with the sections Goal, Done, Decisions, Open and Next, and the
// header lines of the /write-handoff skill so /day-recap reads both alike. Run titles are your own
// words, so the note is redacted like everything else the app writes.
//   summary: todaySummary(...); runs: the day's run rows (dayRuns); findings: the board document.
//   Optional: project, label (display name), boss (currentBoss), nextUp (store.nextUp),
//   allow (profile secrets.allowValues).
export function handoffNote({ summary, runs, findings, date, project = '', label = '', boss = null, nextUp = undefined, allow = [] }) {
  const day = date || summary?.date || localDay(new Date());
  const name = oneLine(label || project || findings?.project || 'the project', 60);
  const list = Array.isArray(runs) ? runs : [];
  const all = Array.isArray(findings?.findings) ? findings.findings : [];
  const next = nextUp === undefined ? pickNextUp(findings || {}) : nextUp;
  const todayEntries = all.flatMap(f => (f.history || []).filter(h => localDay(h.at) === day).map(h => ({ f, h })));
  const where = PROJECT_RE.test(project) ? `projects/${project}` : name;
  const out = [`# Handoff: ${name}, end of day`, '', `Date: ${day}`, `Where: ${where}`, 'Branch: n/a (each run has its own app/ branch)',
    'Written by the workspace app from run folders, findings and git (no Claude).', ''];

  out.push('## Goal');
  if (boss && boss.total && !boss.defeated) {
    out.push(`- Close ${oneLine(boss.label, 80)}: ${plural(boss.hp, 'high or critical finding')} left (${boss.ids.join(', ')}).`);
  } else {
    out.push(`- Work through the open findings of ${name}, one small reviewed slice at a time.`);
  }
  if (summary?.text) out.push(`- Today so far: ${summary.text}.`);
  out.push('');

  out.push('## Done');
  const done = [];
  for (const r of list.filter(x => x.status === 'committed')) {
    const sha = shortSha(r.commit);
    done.push(`- Committed: ${runLine(r)}${sha ? `, ${sha}` : ''}${r.branch ? ` on ${oneLine(r.branch, 80)}` : ''}. Not pushed.`);
  }
  for (const r of list.filter(x => x.status === 'passed')) done.push(`- Passed: ${runLine(r)}.`);
  const closed = todayEntries.filter(e => closedByWork(e.h));
  for (const { f, h } of closed) done.push(`- ${f.id} ${h.to === 'done' ? 'done' : 'committed on a branch'}: ${oneLine(f.title, 80)}.`);
  if (summary?.lastWin?.text && localDay(summary.lastWin.at) === day) done.push(`- Win: ${summary.lastWin.text}.`);
  out.push(...(done.length ? done : ['- Nothing finished today.']), '');

  out.push('## Decisions');
  const decisions = [];
  const yours = todayEntries.filter(e => e.h.by === DECIDED_BY);
  for (const { f, h } of yours.filter(e => e.h.to === 'dismissed')) decisions.push(`- Dismissed ${f.id}: ${oneLine(h.reason, 200) || 'no reason given'}.`);
  for (const { f } of yours.filter(e => e.h.to === 'open' && e.h.from === 'proposed')) decisions.push(`- Accepted ${f.id} as a finding.`);
  if (findings?.source?.confirmedAt && localDay(findings.source.confirmedAt) === day) decisions.push('- Confirmed the findings import.');
  out.push(...(decisions.length ? decisions : ['- No decisions recorded today.']), '');

  out.push('## Open');
  const open = [];
  for (const r of list.filter(x => x.status === 'waiting')) open.push(`- Waiting for you: ${runLine(r)} at the ${WAITING_LABELS[waitKind(r)] || 'next gate'}.`);
  for (const r of list.filter(x => x.status === 'running' || x.status === 'in-terminal')) open.push(`- ${r.status === 'running' ? 'Running' : 'In terminal'}: ${runLine(r)}${r.stage ? `, stage ${oneLine(r.stage, 40)}` : ''}.`);
  for (const r of list.filter(x => STOPPED.includes(x.status))) open.push(`- Stopped (${STATUS_LABELS[r.status]}): ${runLine(r)}.`);
  for (const f of all.filter(x => x.status === 'on-branch')) open.push(`- ${f.id} is on ${oneLine(f.branch || 'a branch', 80)}, not merged yet.`);
  for (const f of all.filter(x => x.status === 'in-run')) open.push(`- ${f.id} is in a run${f.runId ? ` (${f.runId})` : ''}.`);
  out.push(...(open.length ? open : ['- Nothing open.']), '');

  out.push('## Next');
  const steps = [];
  for (const r of list.filter(x => x.status === 'waiting')) steps.push(`Answer the ${WAITING_LABELS[waitKind(r)] || 'gate'} of ${oneLine(r.title || r.id)}.`);
  for (const r of list.filter(x => STOPPED.includes(x.status))) steps.push(`Look at ${oneLine(r.title || r.id)} (${STATUS_LABELS[r.status]}): retry, resume or stop it.`);
  const branches = [...new Set(all.filter(x => x.status === 'on-branch' && x.branch).map(x => x.branch))];
  for (const b of branches) steps.push(`Review and merge ${oneLine(b, 80)} in GitKraken when you are ready; the app never merges.`);
  if (next) steps.push(`Start Fix for ${next.id}: ${oneLine(next.title, 80)}${next.meta ? ` (${next.meta})` : ''}.`);
  if (!steps.length) steps.push('Pick the next finding on the board, or run Check my work.');
  steps.slice(0, 6).forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  return redact(out.join('\n'), { allow });
}

// Saves a handoff note as inbox/handoffs/<date>-<project>-day.md in the hub (then -day-2, -day-3:
// an earlier handoff is never overwritten). The inbox is git-ignored, so the note never reaches
// the public repo. Returns { path (hub-relative, forward slashes), file }. A bad project or date
// is a 400, an unknown hub folder a 500 and a full day of handoffs a 409.
export async function saveHandoff({ root, project, date, text }) {
  checkProject(project);
  checkDay(date);
  if (!root) throw httpError(500, 'The hub folder is unknown, so the handoff cannot be saved.');
  const dir = join(root, 'inbox', 'handoffs');
  await mkdir(dir, { recursive: true });
  for (let n = 1; n <= 50; n++) {
    const name = `${date}-${project}-day${n === 1 ? '' : `-${n}`}.md`;
    try {
      await writeFile(join(dir, name), String(text ?? ''), { encoding: 'utf8', flag: 'wx' });
      return { path: `inbox/handoffs/${name}`, file: join(dir, name) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw httpError(409, `There are already 50 handoffs for ${project} on ${date}.`);
}
