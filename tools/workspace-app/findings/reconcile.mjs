// Findings reconcile: brings the board in line with git and the run index, without asking.
//
// Three moves, all through store.setStatus so the transition table still applies:
//   on-branch -> done      when `git for-each-ref --merged <integrationBranch>` lists the
//                          finding's branch, or a commit of its current fix is on the integration
//                          branch (the branch was merged and then deleted, or merged at a later
//                          commit). The current fix is the commit (or commits) recorded by the
//                          finding's latest move to on-branch. Older SHAs in f.commits (import
//                          evidence, earlier fixes) never count, so a partial fix already on main
//                          can't make a later, unmerged fix look done.
//                          "Done" comes from git, never from a click.
//   in-run    -> open      when the run that held it ended without a commit (passed, failed or
//                          cancelled).
//   in-run    -> on-branch when that run did commit (the run engine normally moves it already).
// Runs that can still continue (waiting, capped, interrupted, parked, gates-red, paused-limit,
// in-terminal) keep their finding in run. reconcile() writes nothing; reconcileAndSave() runs it
// inside store.updateFindings, so it can't overwrite a change made at the same moment.
import { readJsonl, projectPaths } from '../core/datadir.mjs';
import { branchNames, checkRef, gitText } from './import.mjs';
import { findingsFile, setStatus, updateFindings } from './store.mjs';

export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'cancelled', 'committed'];

const SHA_RE = /^[0-9a-f]{7,40}$/i;

// The last index row per run id (index rows are appended; readers take the last one).
export function lastPerRun(runsIndex) {
  if (runsIndex instanceof Map) return runsIndex;
  const map = new Map();
  for (const row of Array.isArray(runsIndex) ? runsIndex : []) if (row && row.id) map.set(row.id, row);
  return map;
}

async function isAncestor(git, dir, sha, ref) {
  if (!SHA_RE.test(String(sha || ''))) return false;
  try {
    await gitText(git, dir, ['merge-base', '--is-ancestor', sha, ref]);
    return true;
  } catch {
    return false;
  }
}

const shaOf = commit => (typeof commit === 'string' ? commit : commit && typeof commit.sha === 'string' ? commit.sha : '');

// The commits of the fix that put the finding on its branch: `commit` (setStatus, from the commit
// gate) and `commits` (applyImport, the SHAs found on the app branch) of its latest history entry
// that moved it to on-branch. [] when no entry records one.
export function currentFixCommits(f) {
  const history = Array.isArray(f?.history) ? f.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.to !== 'on-branch') continue;
    const shas = [h.commit, ...(Array.isArray(h.commits) ? h.commits : [])].map(shaOf).filter(s => SHA_RE.test(s));
    return [...new Set(shas)];
  }
  return [];
}

// Why an on-branch finding is now done, or ''.
async function mergedReason(f, { git, mainDir, integration, merged }) {
  if (f.branch && merged.has(f.branch)) return `${f.branch} is merged into ${integration}`;
  for (const sha of currentFixCommits(f)) {
    if (await isAncestor(git, mainDir, sha, integration)) return `commit ${sha.slice(0, 7)} is on ${integration}`;
  }
  return '';
}

// Returns { doc, changes: [{id, from, to, reason}], warnings }. `doc` is a new document when
// anything changed; the input is never modified.
//   runsIndex: the rows of runs/index.jsonl (or a Map id -> last row).
export async function reconcile({ doc, mainDir, profile, git, runsIndex, at = new Date().toISOString() }) {
  let out = doc;
  const changes = [];
  const warnings = [];
  const move = (id, from, to, opts) => {
    out = setStatus(out, id, to, { at, ...opts }).doc;
    changes.push({ id, from, to, reason: opts.reason });
  };

  const integration = profile?.git?.integrationBranch;
  const onBranch = (doc?.findings || []).filter(f => f.status === 'on-branch');
  if (onBranch.length && !integration) warnings.push('The profile has no git.integrationBranch, so merged branches were not checked.');
  if (onBranch.length && integration) {
    checkRef(integration, 'git.integrationBranch');
    const merged = new Set(await branchNames(git, mainDir, { mergedInto: integration }));
    for (const f of onBranch) {
      const reason = await mergedReason(f, { git, mainDir, integration, merged });
      if (reason) move(f.id, 'on-branch', 'done', { by: 'merged', reason, branch: f.branch || undefined });
    }
  }

  const runs = lastPerRun(runsIndex);
  for (const f of (out?.findings || []).filter(x => x.status === 'in-run')) {
    const run = f.runId ? runs.get(f.runId) : null;
    if (!run) {
      warnings.push(`${f.id} is in a run the run index doesn't know${f.runId ? ` (${f.runId})` : ''}; it stays in run.`);
      continue;
    }
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) continue;
    const sha = shaOf(run.commit);
    if (run.status === 'committed' && (run.branch || SHA_RE.test(sha))) {
      move(f.id, 'in-run', 'on-branch', {
        by: 'run', reason: `run ${run.id} committed${SHA_RE.test(sha) ? ` ${sha.slice(0, 7)}` : ''}`,
        runId: run.id, branch: run.branch || undefined, commit: SHA_RE.test(sha) ? sha : undefined,
      });
    } else if (run.status !== 'committed') {
      move(f.id, 'in-run', 'open', { by: 'run', reason: `run ${run.id} ended ${run.status} without a commit`, runId: run.id });
    } else {
      warnings.push(`${f.id}: run ${run.id} committed, but the index has no branch or commit, so it stays in run.`);
    }
  }
  return { doc: out, changes, warnings };
}

// Reads the run index, reconciles the project's board and saves it (one change at a time with
// other board writes). Returns { doc, changes, warnings, changed }.
export async function reconcileAndSave({ dataDir, project, mainDir, profile, git, at }) {
  findingsFile(dataDir, project); // checks the project name (400) before any path is built
  const { rows } = await readJsonl(projectPaths(dataDir, project).runsIndex);
  const runsIndex = rows.filter(r => r && r.project === project);
  return updateFindings(dataDir, project, doc => reconcile({ doc, mainDir, profile, git, runsIndex, at }));
}
