// Check my work and the test baseline (SPEC 4; the cockpit's Checks card, SPEC 5.3):
//   POST /api/checks              { project, what, level, preview? }. The preview lists what the
//                                 level would run, where (the run worktree or the main checkout)
//                                 and why it would be refused; without preview it starts a
//                                 "check" run in the run engine
//   GET  /api/checks              the last result per level and the last 20 history lines
//   GET  /api/baseline            one baseline (the newest, or ?key=) with its candidate and the
//                                 failures that would leave or enter
//   POST /api/baseline/accept     replaces a baseline with its candidate, only for the hash you
//                                 were shown (R15)
//   POST /api/baseline/recompute  starts a "check" run of everything (see the route)
//
// Nothing here runs a check on the request: starts go through the run engine, which takes the
// check slot and, in the run worktree, the project lock (409 while another run holds it). The
// preview only reads git, the profile and the worktree state, and it never opens a .env file: the
// main-checkout refusal (R10) looks for .env files by name only (gates/check.mjs refusalFor).
import * as coreGit from '../core/git.mjs';
import { loadSettings } from '../core/settings.mjs';
import { acceptCandidate, KEY_RE, knownCount, listBaselines, loadBaseline, loadCandidate } from '../gates/baseline.mjs';
import { listeningPorts, refusalFor } from '../gates/check.mjs';
import { displayCommand, levelGroups, planChecks } from '../gates/commands.mjs';
import { lastPerLevel, LEVELS, readHistory } from '../gates/history.mjs';
import { HttpError, readJson } from '../http.mjs';
import { inspect as inspectLock } from '../runs/locks.mjs';
import { findRun, TERMINAL_STATUSES } from '../runs/store.mjs';
import { worktreeStatus } from '../runs/worktree.mjs';
import {
  candidateSummary, engineOf, isolationModeOf, profileFor, profileProblem, projectOrThrow,
} from './cockpit.mjs';

export const WHATS = ['uncommitted', 'branch', 'everything'];
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
// The G0 row of a preview: those checks are planned at run time from the diff (gates/g0.mjs).
const G0_ROW = {
  id: 'g0', group: 'G0', label: 'Static checks: whitespace, format, lint, secrets, fences, ratchets', kind: 'g0',
  workspace: null, files: null, folders: null, skipReason: '', command: '',
};

// A choice from a list, with a default for a missing value; 400 for anything else.
function pick(value, list, fallback, what) {
  const v = value === undefined || value === null || value === '' ? fallback : value;
  if (!list.includes(v)) throw new HttpError(400, `${what} must be one of ${list.join(', ')}.`);
  return v;
}

async function commitOf(dir, rev) {
  const out = await coreGit.git(dir, ['rev-parse', '-q', '--verify', `${coreGit.assertRev(rev)}^{commit}`], { okCodes: [0, 1] });
  return out.trim() || null;
}

// The preview row of one planned command.
function commandRow(profile, c) {
  const cmd = (profile.commands || {})[c.commandId] || {};
  const files = Array.isArray(c.files) ? c.files.length : null;
  const folders = Array.isArray(c.folders) ? c.folders.length : null;
  let command = displayCommand(cmd, { fileCount: files || 0 });
  // Full runs expand their files at run time; focused tests add the tests next to changed files.
  if (files === null) command = command.replace(/\(0 files\)/, '(all matching files)');
  else if (folders) command = command.replace(/\((\d+) files?\)/, (_, n) => `(${n === '0' ? '' : `${n} changed test files plus `}the tests next to the changed files)`);
  return {
    id: c.id, group: c.group, label: c.label, kind: c.kind, workspace: c.workspace || null, files, folders,
    skipReason: c.skipReason || '', command,
  };
}

// '' or why a check in the run worktree would have to wait: another live run holds the lock.
// The engine decides for real at the start (409); this is the hint for the preview.
async function lockBusy(ctx, name) {
  const info = await inspectLock(ctx.dataDir, name);
  if (!info.held || info.holderAlive === false || !info.runId) return '';
  const run = await findRun(ctx.dataDir, info.runId).catch(() => null);
  if (run && TERMINAL_STATUSES.includes(run.status)) return '';
  return `The run worktree is busy with ${run ? run.title : `run ${info.runId}`}. Park it or wait.`;
}

// What "Check my work" would do, like the check pipeline's preflight (runs/executor.mjs): the
// run worktree when it is ready, otherwise the main checkout, refused there while it has a .env
// file and the profile's guard is not on the base commit.
async function previewChecks(ctx, deps, p, { what, level }) {
  const empty = { commands: [], treeMode: null, tree: null, base: null, changed: 0, busy: '', notes: [], what, level };
  const info = await profileFor(ctx, p);
  const problem = profileProblem(info, p.name);
  if (problem) return { ...empty, refusal: problem };
  const profile = info.profile;
  if (!profile.levels || !profile.levels[level]) return { ...empty, refusal: `The profile has no check level "${level}".` };
  const notes = [];
  let treeMode = 'main';
  let tree = p.mainDir;
  if (isolationModeOf(loadSettings(ctx.dataDir), p.name, profile) === 'worktree') {
    const wt = await worktreeStatus({ profile, mainDir: p.mainDir, dataDir: ctx.dataDir }).catch(e => ({ state: 'failed', text: e.message }));
    if (wt.state === 'ready') { treeMode = 'run'; tree = wt.path; } else notes.push(`${wt.text} The checks run in your main checkout.`);
  }
  if (treeMode === 'main') notes.push('In the main checkout there is no baseline, so every failure counts as new.');
  const head = await commitOf(p.mainDir, 'HEAD').catch(() => null);
  if (!head) return { ...empty, treeMode, tree, notes, refusal: 'The checkout has no commits yet.' };
  let base = head;
  if (what === 'branch') {
    const integration = profile.git.integrationBranch;
    const out = await coreGit.git(p.mainDir, ['merge-base', coreGit.assertRev(integration, 'branch'), head], { okCodes: [0, 1] }).catch(() => '');
    if (!out.trim()) return { ...empty, treeMode, tree, notes, refusal: `${integration} has no commit in common with HEAD, so "This branch vs base" can't be checked.` };
    base = out.trim();
  }
  let changed = [];
  if (what !== 'everything') {
    // In the run worktree a branch check sees the commits only; in the main checkout it also
    // sees your uncommitted changes (the executor's checkRun does the same).
    changed = await coreGit.changedFiles(p.mainDir, base, treeMode === 'run' && what === 'branch' ? { head } : {});
  }
  const listening = await listeningPorts({ profile, level, ports: deps.ports });
  const commands = [];
  if (levelGroups(profile, level).includes('G0')) commands.push({ ...G0_ROW });
  for (const c of planChecks({ profile, level, changed, what, listening })) commands.push(commandRow(profile, c));
  const refusal = treeMode === 'main' ? await refusalFor({ profile, tree: p.mainDir, treeMode, baseSha: base }) : '';
  const busy = treeMode === 'run' ? await lockBusy(ctx, p.name) : '';
  return {
    commands, treeMode, refusal, busy, tree, notes, what, level,
    base: { sha: base, short: base.slice(0, 7) }, changed: changed.length,
  };
}

export function routes(ctx, deps = {}) {
  return {
    // { project, what = 'uncommitted', level = 'quick', preview }: the preview, or a new check
    // run ({ ok, runId }). The engine refuses with 400 (a refusal) or 409 (the lock).
    'POST /api/checks': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const what = pick(b.what, WHATS, 'uncommitted', 'what');
      const level = pick(b.level, LEVELS, 'quick', 'level');
      if (b.preview) return { ok: true, preview: true, ...(await previewChecks(ctx, deps, p, { what, level })) };
      const engine = await engineOf(ctx);
      const r = await engine.start({ project: p.name, pipeline: 'check', values: { what, level } });
      return { ok: true, runId: r.runId, message: 'Checking your work. Follow it in the run view.' };
    },

    // ?project=: { last: { quick, standard, paranoid }, history: [last 20, newest first] }.
    'GET /api/checks': async (req, res, url) => {
      const p = projectOrThrow(ctx, url.searchParams.get('project'));
      const [last, history] = await Promise.all([lastPerLevel(ctx.dataDir, p.name), readHistory(ctx.dataDir, p.name, { limit: 20 })]);
      return { ok: true, last, history };
    },

    // ?project=&key=: the baseline (the newest without a key) with `known`, its candidate (no
    // command results, but the hash to accept it with) and the diff between them.
    'GET /api/baseline': async (req, res, url) => {
      const p = projectOrThrow(ctx, url.searchParams.get('project'));
      const keys = await listBaselines(ctx.dataDir, p.name);
      const raw = url.searchParams.get('key');
      let key;
      if (raw) {
        if (!KEY_RE.test(raw)) throw new HttpError(400, `"${raw.slice(0, 60)}" is not a baseline key such as 0123456789ab-run-node24.11.1.`);
        key = raw;
      } else {
        if (!keys.length) throw new HttpError(404, `${p.name} has no baseline yet. The first check in the run worktree makes one.`);
        key = keys[0].key;
      }
      const baseline = await loadBaseline(ctx.dataDir, p.name, key);
      if (!baseline) throw new HttpError(404, `There is no baseline ${key}.`);
      const candidate = await loadCandidate(ctx.dataDir, p.name, key);
      return {
        ok: true, key,
        baseline: { ...baseline, known: knownCount(baseline) },
        candidate: candidate ? candidateSummary(candidate) : null,
        diff: { leaving: candidate ? candidate.leaving || [] : [], entering: candidate ? candidate.entering || [] : [] },
        keys,
      };
    },

    // { project, key, hash }: accepts the candidate you were shown. 409 when it or the baseline
    // changed since; 404 when there is no candidate (any more).
    'POST /api/baseline/accept': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project);
      if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) throw new HttpError(400, 'Send the key of the baseline to replace.');
      if (typeof b.hash !== 'string' || !HASH_RE.test(b.hash)) throw new HttpError(400, 'Send the hash of the candidate you looked at.');
      let r;
      try { r = await acceptCandidate(ctx.dataDir, p.name, b.key, b.hash); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, message: r.message, known: knownCount(r.baseline) };
    },

    // { project, level = 'standard' }: a check run of everything. Its preflight measures what the
    // baseline of the base commit lacks (a first run); the run then checks the whole tree, and
    // when known failures pass on a clean tree a smaller candidate is proposed. The saved baseline
    // itself still changes only when you accept a candidate (R15).
    'POST /api/baseline/recompute': async req => {
      const b = await readJson(req);
      const p = projectOrThrow(ctx, b.project, { present: true });
      const level = pick(b.level, LEVELS, 'standard', 'level');
      const engine = await engineOf(ctx);
      const r = await engine.start({ project: p.name, pipeline: 'check', values: { what: 'everything', level } });
      return { ok: true, runId: r.runId, message: 'Checking everything against the baseline. Nothing changes until you accept a smaller one.' };
    },
  };
}
