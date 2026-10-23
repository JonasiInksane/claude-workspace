// The check runner: runs a check level on a tree and compares the result with the baseline of
// its base commit. It serves you ("Check my work"), the gate stages, and Claude through the
// tg-check shim (gates/shim.mjs). Also a CLI:
//
//   node gates/check.mjs --project <p> --level <l> [--tree <dir>] [--what uncommitted|branch|everything] [--json] [--data-dir <dir>]
//   node gates/check.mjs --in-stage <stageDir> test <paths...> | types <workspace> | lint <files...>
//
// - The main checkout is refused when it has a .env file and the profile's guard (a pattern in a
//   file at the base commit, for example the env loader skipping .env under tests) doesn't match:
//   a check would otherwise load real secrets. A .env file is only looked for by name, never opened.
// - role 'base' measures a tree and saves what it measured as a first run: the whole baseline when
//   the key has none, else only the commands it has no entry for. Existing entries are never run
//   again or changed here; they change only when you accept a candidate (SPEC R15).
// - role 'head' adds G0 (runG0, injected), reruns each failing test file the baseline doesn't
//   know once, sorts failures into new, known and flaky (gates/baseline.mjs compare), and on a
//   clean tree at the base commit writes a smaller baseline candidate when known failures pass.
//   It appends a history line (gates/history.mjs).
// - In a stage, tg-check is off while a must-tick file differs from base without a tick, and it
//   runs only test files that existed at base, are in the plan, or are new tests next to a plan
//   file. It still runs test code Claude wrote: edit stages are code execution (plan section 9).
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realGit from '../core/git.mjs';
import * as realPorts from '../core/ports.mjs';
import { defaultDataDir, writeJsonAtomic } from '../core/datadir.mjs';
import { matchAny } from '../core/glob.mjs';
import { loadProfile } from '../profile/profile.mjs';
import {
  baselineKey, candidateFrom, chip, commandEntry, compare, knownCount, knownIds, loadBaseline, saveBaseline, writeCandidate,
} from './baseline.mjs';
import {
  cleanRel, commandOf, expandFiles, keyedErrors, levelGroups, ownerOf, planChecks, rerunFiles, runCommand, tapRows,
  treeRelOf, UNKNOWN_FILE,
} from './commands.mjs';
import { appendHistory, historyLine } from './history.mjs';
import { redact } from './secrets.mjs';

const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NOCASE = { nocase: true };
const PROJECT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const WHATS = ['uncommitted', 'branch', 'everything'];
const STAGE_SUBS = ['test', 'types', 'lint'];
const MAX_STAGE_ARGS = 200;
const PROOF_RERUN_FILES = 20;
// .env and its variants (.env.local, .env.test, ...), but not the usual example files.
const ENV_FILE_RE = /^\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i;

export const NO_GUARD_MESSAGE = 'This checkout has a .env file and the profile defines no main-checkout guard, '
  + 'so checks could load real secrets. Run checks in the run worktree instead.';
export const STAGE_USAGE = 'Usage: tg-check test <test files...> | tg-check types <workspace> | tg-check lint <files...>. '
  + 'Paths are relative to the repository root.';

const iso = ms => new Date(ms).toISOString();
const cap = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}...` : String(s));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const unique = list => [...new Set(list)];

// Windows paths compare without case; "/c/x" (Git Bash) is the same as "C:\x".
function fromMsys(p) {
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(String(p || ''));
  return m ? `${m[1]}:/${m[2] || ''}` : String(p || '');
}
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => resolve(fromMsys(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// ---------------------------------------------------------------------------------------------
// Main-checkout refusal

// The folders a .env file is looked for in: the tree root and each workspace folder.
const envDirs = profile => new Set(['', ...(profile?.workspaces || []).map(ws => cleanRel(ws.dir ?? '.')).filter(d => d !== null)]);
const envNames = (d, names) => names.filter(n => ENV_FILE_RE.test(n)).map(n => (d ? `${d}/${n}` : n));

// The .env files at the tree root and in each workspace folder (names only; nothing is opened).
export function envFilesIn(profile, tree) {
  const found = [];
  for (const d of envDirs(profile)) {
    try { found.push(...envNames(d, readdirSync(join(tree, d)))); } catch { /* no such folder */ }
  }
  return found;
}

// The same list without blocking, for request paths.
export async function envFilesInAsync(profile, tree) {
  const found = [];
  for (const d of envDirs(profile)) {
    try { found.push(...envNames(d, await readdir(join(tree, d)))); } catch { /* no such folder */ }
  }
  return found;
}

// The refusal for a tree that has a .env file: '' when the guard matches its file's text at the
// base commit (`guardContent`, null when the file is missing there), else why checks may not run.
function guardRefusal(profile, guardContent) {
  const guard = profile?.mainCheckoutGuard;
  if (!guard) return NO_GUARD_MESSAGE;
  const message = guard.message || `${guard.label || 'The main-checkout guard'} is not on the base commit.`;
  let re;
  try { re = new RegExp(guard.pattern); } catch { return message; }
  if (guardContent === null || guardContent === undefined || !re.test(String(guardContent))) return message;
  return '';
}

// '' when checks may run in this tree, else the reason they may not.
export function mainCheckoutRefusal({ profile, tree, treeMode, guardContent }) {
  if (treeMode !== 'main') return '';
  if (!envFilesIn(profile, tree).length) return '';
  return guardRefusal(profile, guardContent);
}

// The same check without blocking, reading the guard file at the base commit through git when
// it is needed (runChecks, tg-check, and routes that preview a check).
export async function refusalFor({ profile, tree, treeMode, baseSha, guardContent, git = realGit }) {
  if (treeMode !== 'main' || !(await envFilesInAsync(profile, tree)).length) return '';
  let content = guardContent;
  const guard = profile?.mainCheckoutGuard;
  if (content === undefined && guard?.file) {
    try {
      const t = await git.fileAt(tree, baseSha, guard.file);
      content = t === null || t === undefined ? null : String(t);
    } catch { content = null; }
  }
  return guardRefusal(profile, content);
}

// ---------------------------------------------------------------------------------------------
// runChecks: rows

// The ports a level's groups need that answer now, asked of core/ports only when some group needs
// one. opts = {profile, level?, listening?, ports?}; an explicit `listening` list wins. The
// executor asks once and hands the answer to both planChecks and runChecks, so a baseline plans
// and runs the same commands.
export async function listeningPorts(opts, groups = levelGroups(opts.profile, opts.level)) {
  if (Array.isArray(opts.listening)) return opts.listening;
  const { profile } = opts;
  const need = new Set();
  for (const gid of groups) {
    const g = profile.groups?.[gid];
    for (const p of g?.requiresPorts || []) need.add(p);
    for (const c of g?.commands || []) for (const p of profile.commands?.[c]?.requiresPorts || []) need.add(p);
  }
  if (!need.size) return [];
  const ports = opts.ports || realPorts;
  try { return (await ports.anyListening([...need])) || []; } catch { return []; }
}

// A row's one-line text for the run timeline: "Types: api: fail, 2 new".
function rowMsg(row) {
  const what = row.label || row.id;
  if (row.status === 'running') return `${what}: running`;
  return `${what}: ${row.status}${row.reason ? `, ${row.reason}` : ''}`;
}

function finalRow(row) {
  const out = { ...row, msg: rowMsg(row) };
  if (row.status === 'pass' || row.status === 'warn') out.ok = true;
  else if (row.status === 'fail' || row.status === 'error') out.ok = false;
  return out;
}

const rowFor = item => ({ id: item.id, group: item.group, label: item.label, command: '', status: 'skip', reason: '', durationMs: 0, log: '' });

// The baseline-shaped entry for a command result (gates/baseline.mjs commandEntry). A lint run on
// some files names them, relative to the command's cwd, so only those can count as fixed.
function entryOf(cmd, r, item) {
  const kind = cmd.kind;
  const result = { status: r.status, exitCode: r.exitCode, durationMs: r.durationMs };
  if (kind === 'test') return commandEntry('test', { ...result, tap: r.tap });
  const opts = {};
  if (item.files && kind === 'lint') {
    const cwd = cleanRel(cmd.cwd ?? '.') || '';
    opts.files = (r.files || []).map(f => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f));
  }
  return commandEntry(kind, { ...result, errors: (r.errors || []).map(e => e.id), warnings: r.warnings }, opts);
}

// Details for a row: the new failures with their messages, capped.
function rowDetails(pc, r, cmd) {
  const fresh = new Set(pc.new);
  const details = { new: pc.new.slice(0, 50), flaky: pc.flaky.slice(0, 50), known: pc.known.length, canShrink: pc.canShrink.length };
  if (pc.missing) details.notInBaseline = true;
  if (cmd.kind === 'test') {
    details.failures = tapRows(r.tap).filter(t => t.status === 'fail' && fresh.has(t.id)).slice(0, 20)
      .map(t => ({ id: t.id, kind: t.kind, message: cap(t.message, 600) }));
  } else {
    details.errors = keyedErrors(r.errors).filter(e => fresh.has(e.key)).slice(0, 50)
      .map(({ key, ...e }) => ({ ...e, id: key }));
  }
  return details;
}

function headReason(pc, r) {
  const parts = [];
  if (pc.new.length) parts.push(`${pc.new.length} new`);
  if (pc.known.length) parts.push(`${pc.known.length} known`);
  if (pc.flaky.length) parts.push(`${pc.flaky.length} flaky`);
  if (pc.canShrink.length) parts.push(`${pc.canShrink.length} known now pass`);
  if (pc.missing && pc.new.length) parts.push('no baseline entry, so every failure counts as new');
  return parts.length ? parts.join(' · ') : (r.reason || '');
}

// ---------------------------------------------------------------------------------------------
// runChecks: G0

// G0 rows through the injected runG0 (gates/g0.mjs). runChecks passes what it owns; the caller
// binds changed (with statuses), diff, plan, ticked, allowances, pipeline, git and probes in its
// closure, so they are not overwritten here.
async function runG0Rows(opts, runHere, emit) {
  if (typeof opts.runG0 !== 'function') {
    return { rows: [{ id: 'g0', group: 'G0', label: 'Static checks', status: 'skip', reason: 'Not run: no G0 runner was given' }], g0: null };
  }
  const streamed = new Set();
  const onRow = row => { if (row?.id) { streamed.add(row.id); emit({ group: 'G0', ...row }); } };
  try {
    const g0 = await opts.runG0({
      profile: opts.profile, tree: opts.tree, baseSha: opts.baseSha, gateDir: opts.gateDir, signal: opts.signal, proc: opts.proc,
      runCommand: runHere, onRow,
    });
    const rows = (g0?.rows || []).filter(Boolean).map(r => ({ group: 'G0', ...r }));
    for (const r of rows) if (!streamed.has(r.id)) emit(r);
    return { rows, g0 };
  } catch (e) {
    const row = { id: 'g0', group: 'G0', label: 'Static checks', status: 'error', reason: `G0 could not run: ${e.message}` };
    emit(row);
    return { rows: [row], g0: null };
  }
}

// ---------------------------------------------------------------------------------------------
// runChecks: head

// True when the tree differs from the base commit. Unknown counts as changed: then no known
// failure is ever taken out of the baseline.
async function treeDirty(opts, git) {
  if (typeof opts.dirty === 'boolean') return opts.dirty;
  if ((opts.changed || []).length) return true;
  try { return (await git.changedFiles(opts.tree, opts.baseSha, { includeUntracked: true })).length > 0; } catch { return true; }
}

// Test failures the baseline doesn't know are rerun once, each file on its own. Returns the
// rerun's entry (its `passed` ids make a failure flaky), or null.
async function rerunFresh(ctx, item, cmd, r, row) {
  const known = knownIds(ctx.baseline, item.commandId);
  const fresh = tapRows(r.tap).filter(t => t.status === 'fail' && !known.has(t.id) && t.file !== UNKNOWN_FILE);
  const files = unique(fresh.map(t => treeRelOf(cmd, t.file)).filter(Boolean));
  if (!files.length || ctx.signal?.aborted) return null;
  const rr = await rerunFiles({ ...ctx.runArgs, profile: ctx.profile, commandId: item.commandId, tree: ctx.tree, files, checkId: item.id });
  row.rerunLogs = rr.logs;
  return commandEntry('test', { status: rr.status, exitCode: rr.exitCode, durationMs: rr.durationMs, tap: rr.tap });
}

// On a clean tree at the base commit a known failure that is gone may be fixed. Node 24's TAP
// names no file for passing tests in a multi-file run, so the files of such failures are run on
// their own once to prove it (at most 20 files). Adds the proven ids to entry.passed.
async function proveVanished(ctx, item, cmd, r, entry) {
  if (!ctx.baseline || ctx.dirty || ctx.signal?.aborted || cmd.kind !== 'test') return;
  if (!tapRows(r.tap).some(t => t.file === UNKNOWN_FILE)) return;
  const failingNow = new Set(entry.failures.map(f => f.id));
  const passed = new Set(entry.passed);
  const ranFiles = new Set((r.files || []).map(f => f.toLowerCase()));
  const vanished = [...knownIds(ctx.baseline, item.commandId)].filter(id => !failingNow.has(id) && !passed.has(id) && id.includes('::'));
  const files = unique(vanished.map(id => treeRelOf(cmd, id.split('::')[0])).filter(f => f && ranFiles.has(f.toLowerCase())))
    .slice(0, PROOF_RERUN_FILES);
  if (!files.length) return;
  const rr = await rerunFiles({ ...ctx.runArgs, profile: ctx.profile, commandId: item.commandId, tree: ctx.tree, files, checkId: item.id, round: 'proof' });
  for (const t of tapRows(rr.tap)) if (t.status === 'pass' && !passed.has(t.id)) entry.passed.push(t.id);
}

// Runs one planned check at head and turns it into its final row. Returns the entries for the
// summary-wide comparison.
async function headItem(ctx, item, r, row) {
  const cmd = commandOf(ctx.profile, item.commandId);
  if (r.status !== 'pass' && r.status !== 'fail') return null;
  const entry = entryOf(cmd, r, item);
  const rerun = cmd.kind === 'test' && r.status === 'fail' ? await rerunFresh(ctx, item, cmd, r, row) : null;
  await proveVanished(ctx, item, cmd, r, entry);
  const cmp = compare({
    baseline: ctx.baseline,
    current: { baseSha: ctx.baseSha, dirty: ctx.dirty, commands: { [item.commandId]: entry } },
    reruns: { commands: rerun ? { [item.commandId]: rerun } : {} },
  });
  const pc = cmp.perCommand[item.commandId];
  row.status = pc.new.length ? 'fail' : pc.flaky.length ? 'warn' : 'pass';
  row.reason = headReason(pc, r);
  row.details = rowDetails(pc, r, cmd);
  return { entry, rerun };
}

// The summary-wide comparison, the chip and a candidate when known failures were proven fixed.
async function finishHead(ctx, summary, current, reruns) {
  const cmp = compare({ baseline: ctx.baseline, current: { baseSha: ctx.baseSha, dirty: ctx.dirty, commands: current }, reruns: { commands: reruns } });
  summary.tests = { new: cmp.new, flaky: cmp.flaky, known: cmp.known, canShrink: cmp.canShrink, messageChanged: cmp.messageChanged };
  Object.assign(summary.counts, { new: cmp.new.length, known: cmp.known.length, flaky: cmp.flaky.length, canShrink: cmp.canShrink.length });
  summary.chip = chip(cmp);
  if (!ctx.baseline) summary.baselineMissing = true;
  if (cmp.missingCommands.length) summary.notInBaseline = cmp.missingCommands;
  if (!ctx.baseline || !cmp.canShrink.length || ctx.signal?.aborted) return;
  try {
    const candidate = candidateFrom(ctx.baseline, { baseSha: ctx.baseSha, dirty: ctx.dirty, commands: current });
    if (!candidate) return;
    const written = await writeCandidate(ctx.dataDir, ctx.project, summary.baselineKey, candidate);
    summary.candidate = { written: true, hash: written.hash, from: written.from, to: written.to, leaving: written.leaving.length };
  } catch (e) {
    summary.candidate = { written: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------------------------
// runChecks: base

function baseReason(cmd, r) {
  if (r.status !== 'fail') return r.reason || '';
  return `${r.reason} at base, recorded as known`;
}

// Saves what the base run measured (gates/baseline.mjs saveBaseline, source first-run): the whole
// baseline when none exists, else only the commands it has no entry for. Planned commands that
// already have an entry were not run, so an existing entry never changes here.
async function recordBase(ctx, summary, entries) {
  const ids = Object.keys(entries);
  if (!ids.length) {
    summary.counts.known = knownCount(ctx.baseline);
    summary.tests.known = [...knownIds(ctx.baseline)].sort();
    summary.baselineSaved = [];
    summary.chip = ctx.baseline ? `${summary.counts.known} known in the baseline; nothing new to measure` : 'nothing measured';
    return;
  }
  const doc = await saveBaseline(ctx.dataDir, ctx.project, summary.baselineKey,
    { baseSha: ctx.baseSha, treeMode: ctx.treeMode, node: summary.node, commands: entries }, { source: 'first-run' });
  summary.baselineSaved = ids;
  summary.counts.known = knownCount(doc);
  summary.tests.known = [...knownIds(doc)].sort();
  const added = knownCount({ commands: entries });
  summary.chip = ctx.baseline
    ? `${summary.counts.known} known in the baseline (${added} from ${plural(ids.length, 'added command')})`
    : `${summary.counts.known} known in the new baseline`;
}

// ---------------------------------------------------------------------------------------------
// runChecks

function newSummary(opts, role, key, started) {
  return {
    version: 1, level: opts.level, role, treeMode: opts.treeMode, tree: opts.tree, baseSha: opts.baseSha,
    node: process.versions.node, startedAt: iso(started), endedAt: null, durationMs: 0,
    result: 'pass', refusal: '', chip: '',
    counts: { new: 0, known: 0, flaky: 0, canShrink: 0, notRun: 0 },
    checks: [],
    tests: { new: [], flaky: [], known: [], canShrink: [], messageChanged: [] },
    baselineKey: key,
  };
}

function overallResult(summary, signal, role) {
  if (signal?.aborted) return 'cancelled';
  if (summary.error) return 'error';
  if (role === 'base') return summary.checks.some(c => c.status === 'error') ? 'error' : 'pass';
  if (summary.checks.some(c => c.status === 'fail') || summary.counts.new > 0) return 'fail';
  if (summary.checks.some(c => c.status === 'error')) return 'error';
  return 'pass';
}

function checkOpts(opts, role) {
  if (!opts || typeof opts !== 'object') throw new Error('runChecks needs its options.');
  if (!opts.gateDir) throw new Error('runChecks needs a gate folder for its logs and summary.');
  if (role !== 'base' && role !== 'head') throw new Error(`runChecks role must be "base" or "head", not "${role}".`);
  if (!PROJECT_RE.test(String(opts.project || ''))) throw new Error(`"${opts.project}" is not a valid project name.`);
  if (!opts.profile) throw new Error('runChecks needs the project profile.');
  if (!opts.tree) throw new Error('runChecks needs the tree folder.');
  if (!opts.dataDir) throw new Error('runChecks needs the data folder.');
}

// Runs a check level and returns the summary (spec 2.10), also written to <gateDir>/summary.json.
// opts = {profile, project, dataDir, tree, treeMode, baseSha, changed, level, what, role, gateDir,
//         signal, onRow, runG0, proc, baselineKey,
//         and optional: git (core/git), ports (core/ports), listening, guardContent, dirty, runId}.
// - changed: paths or core/git changedFiles rows; it picks the checks (planChecks).
// - onRow(row) gets each check as it starts (status 'running') and once with its final status;
//   rows carry {id, group, label, command, status, reason, durationMs, log, details?, msg, ok?}.
// - runG0({profile, tree, baseSha, gateDir, signal, proc, runCommand, onRow}) is called for role
//   head when the level has G0; the caller's closure adds the rest (see runG0Rows).
// Checks run one at a time; the caller holds the check slot.
export async function runChecks(opts) {
  const role = opts?.role || 'head';
  checkOpts(opts, role);
  const { profile, project, dataDir, tree, level, what = 'uncommitted', gateDir, signal, treeMode, baseSha } = opts;
  const groups = levelGroups(profile, level);
  await mkdir(gateDir, { recursive: true });
  const started = Date.now();
  const key = opts.baselineKey || baselineKey({ baseSha, treeMode, node: process.versions.node });
  const summary = newSummary(opts, role, key, started);
  const emit = row => { try { opts.onRow?.(finalRow(row)); } catch { /* a display callback never stops checks */ } };
  const git = opts.git || realGit;

  const finish = async () => {
    summary.endedAt = iso(Date.now());
    summary.durationMs = Date.now() - started;
    summary.counts.notRun = summary.checks.filter(c => c.status === 'skip').length;
    await writeJsonAtomic(join(gateDir, 'summary.json'), summary);
    if (role === 'head' && ['pass', 'fail', 'error'].includes(summary.result)) {
      try { await appendHistory(dataDir, project, historyLine(summary, { runId: opts.runId ?? null })); } catch (e) {
        summary.historyError = e.message;
      }
    }
    return summary;
  };

  summary.refusal = await refusalFor({ profile, tree, treeMode, baseSha, guardContent: opts.guardContent, git });
  if (summary.refusal) { summary.result = 'refused'; return finish(); }

  const plan = planChecks({ profile, level, changed: opts.changed || [], what, listening: await listeningPorts(opts, groups) });
  let baseline = null;
  try { baseline = await loadBaseline(dataDir, project, key); } catch (e) {
    summary.error = `The baseline ${key} could not be read: ${e.message}`;
    summary.result = 'error';
    return finish();
  }
  const runArgs = { proc: opts.proc, signal, treeMode, base: baseSha, gateDir };
  const runHere = args => runCommand({ ...runArgs, ...args });
  const ctx = { profile, project, dataDir, tree, treeMode, baseSha, baseline, signal, runArgs, dirty: true };

  if (role === 'head' && groups.includes('G0') && !signal?.aborted) {
    const { rows, g0 } = await runG0Rows(opts, runHere, emit);
    summary.checks.push(...rows);
    if (g0) summary.g0 = { ok: g0.ok, secretsFound: g0.secretsFound, failed: g0.failed || [] };
  }
  // Only a baseline can shrink, so without one the tree's state doesn't matter.
  if (role === 'head' && baseline) ctx.dirty = await treeDirty(opts, git);

  const current = {};
  const reruns = {};
  for (const item of plan) {
    const row = rowFor(item);
    if (signal?.aborted) row.reason = 'Cancelled';
    else if (item.skipReason) row.reason = item.skipReason;
    else if (role === 'base' && baseline?.commands?.[item.commandId]) row.reason = 'Already in the baseline';
    else {
      emit({ ...row, status: 'running' });
      const cmd = commandOf(profile, item.commandId);
      const files = (item.files || item.folders)
        ? await expandFiles(cmd, { tree, only: item.files, folders: item.folders })
        : undefined;
      const r = await runHere({ profile, commandId: item.commandId, tree, files, checkId: item.id });
      Object.assign(row, { command: r.command, status: r.status, reason: r.reason, durationMs: r.durationMs, log: r.log });
      if (r.counts) row.counts = r.counts;
      if (r.stderrTail) row.stderrTail = r.stderrTail;
      if (role === 'head') {
        const got = await headItem(ctx, item, r, row);
        if (got) {
          current[item.commandId] = got.entry;
          if (got.rerun) reruns[item.commandId] = got.rerun;
        }
      } else {
        if (r.status === 'pass' || r.status === 'fail') current[item.commandId] = entryOf(cmd, r, item);
        row.reason = baseReason(cmd, r);
      }
    }
    summary.checks.push(row);
    emit(row);
  }

  try {
    if (role === 'base') { if (!signal?.aborted) await recordBase(ctx, summary, current); }
    else await finishHead(ctx, summary, current, reruns);
  } catch (e) {
    summary.error = e.message;
  }
  summary.result = overallResult(summary, signal, role);
  return finish();
}

// ---------------------------------------------------------------------------------------------
// tg-check inside a stage

async function readJsonStrict(file, label) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { throw new Error(`${label} is missing.`); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(`${label} is not valid JSON.`); }
}

// '' when the stage that owns stageDir is running, else why tg-check is off.
export function stageNotRunning(run, ctx, stageDir) {
  if (ctx.project && run.project && run.project !== ctx.project) return 'this stage belongs to another project.';
  if (run.isolation?.tree && !samePath(run.isolation.tree, ctx.tree)) return 'the stage names another tree than its run.';
  if (run.status !== 'running') return `tg-check works only while its stage runs; the run is ${run.status || 'not running'}.`;
  for (const st of run.stages || []) {
    const attempts = st.attempts || [];
    const at = attempts.findIndex(a => a?.folder && samePath(resolve(ctx.runDir, a.folder), stageDir));
    if (at < 0) continue;
    if (st.status !== 'running' || at !== attempts.length - 1 || attempts[at].endedAt) {
      return `tg-check works only while its stage runs; ${st.id} is ${st.status}.`;
    }
    return '';
  }
  return 'tg-check works only inside a running stage of this run.';
}

// The first changed must-tick file that was not ticked, or ''. `mustTickNew` globs count for
// added files only. Case is ignored, as in gates/fences.mjs: Windows opens PACKAGE.JSON as
// package.json, so a different spelling must not slip past R8.
export function mustTickBlocked({ ticked, mustTick, mustTickNew }, changed) {
  const tick = new Set((ticked || []).map(cleanRel).filter(Boolean).map(p => p.toLowerCase()));
  for (const c of changed || []) {
    const e = typeof c === 'string' ? { path: c } : (c || {});
    const added = e.status === 'A' || e.status === '?';
    for (const p of [e.path, e.oldPath]) {
      const r = p ? cleanRel(p) : '';
      if (!r || tick.has(r.toLowerCase())) continue;
      if (matchAny(mustTick || [], r, NOCASE)) return r;
      if (added && p === e.path && matchAny(mustTickNew || [], r, NOCASE)) return r;
    }
  }
  return '';
}

// A path Claude passed, as tree-relative posix, or null when it leaves the tree.
export function stagePath(tree, raw) {
  const s = fromMsys(String(raw || '').replace(/\\/g, '/'));
  if (/^[A-Za-z]:\//.test(s)) {
    const rel = relative(tree, s);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return cleanRel(rel) || null;
  }
  return cleanRel(s) || null;
}

async function isFile(abs) {
  try { return (await stat(abs)).isFile(); } catch { return false; }
}

async function existsAtBase(git, tree, sha, p) {
  try { return Boolean(await git.existsAt(tree, sha, p)); } catch { return false; }
}

// The first `kind` command of the path's workspace whose file list covers the path.
async function commandCovering(profile, tree, p, kind) {
  const ws = ownerOf(profile, p);
  for (const commandId of ws?.[kind] || []) {
    const cmd = commandOf(profile, commandId);
    if ((await expandFiles(cmd, { tree, only: [p] })).includes(p)) return commandId;
  }
  return '';
}

// The data folder: check-context.json may name it; otherwise the run folder sits at
// <dataDir>/runs/<project>/<runId>.
function dataDirOf(ctx) {
  if (ctx.dataDir) return ctx.dataDir;
  const projectDir = dirname(resolve(ctx.runDir));
  if (basename(projectDir) === ctx.project && basename(dirname(projectDir)).toLowerCase() === 'runs') return dirname(dirname(projectDir));
  throw new Error('check-context.json has no dataDir, and its run folder is not under <dataDir>/runs/<project>.');
}

async function stageProfile(ctx) {
  const loaded = await loadProfile(dataDirOf(ctx), ctx.project, { mainDir: '' });
  if (!loaded?.exists) throw new Error(`there is no profile for ${ctx.project}.`);
  if (!loaded.profile || loaded.errors?.length) throw new Error(`the profile for ${ctx.project} has errors: ${loaded.errors?.[0] || 'unreadable'}`);
  return loaded.profile;
}

// <stageDir>/tg-check/NNN-<sub>, a fresh folder per call for its logs.
async function invocationDir(stageDir, sub) {
  const root = join(stageDir, 'tg-check');
  await mkdir(root, { recursive: true });
  const start = (await readdir(root)).length + 1;
  for (let i = start; i < start + 100; i++) {
    const name = `${String(i).padStart(3, '0')}-${sub}`;
    const dir = join(root, name);
    try { await mkdir(dir); return { dir, name }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not create a log folder for this tg-check run.');
}

// "src/a.test.ts::adds" (cwd-relative) -> "apps/api/src/a.test.ts::adds" for Claude.
function displayTestId(cmd, t) {
  if (t.file === UNKNOWN_FILE || !t.id.startsWith(`${t.file}::`)) return t.id;
  return `${treeRelOf(cmd, t.file)}::${t.id.slice(t.file.length + 2)}`;
}

const indent = (text, n = 4) => String(text).split(/\r?\n/).slice(0, 30).map(l => `${' '.repeat(n)}${l}`).join('\n');

function resultProblem(r, commandId) {
  if (r.status === 'error' || r.status === 'cancelled' || r.status === 'skip') {
    const tail = r.stderrTail ? `\n${indent(cap(r.stderrTail, 1500))}` : '';
    return `${commandId}: ${r.status}${r.reason ? `, ${r.reason}` : ''}${tail}`;
  }
  return '';
}

function testReport(runs) {
  const lines = [];
  let pass = 0; let fail = 0; let skip = 0; let files = 0;
  for (const { commandId, cmd, r } of runs) {
    files += r.fileCount || 0;
    const rows = tapRows(r.tap);
    pass += rows.filter(t => t.status === 'pass').length;
    skip += rows.filter(t => t.status === 'skip' || t.status === 'todo').length;
    const failed = rows.filter(t => t.status === 'fail');
    fail += failed.length;
    for (const t of failed.slice(0, 30)) {
      lines.push(`not ok - ${displayTestId(cmd, t)} [${t.kind || 'failure'}]`);
      if (t.message) lines.push(indent(cap(t.message, 1500)));
    }
    const problem = resultProblem(r, commandId);
    if (problem) lines.push(problem);
  }
  const head = `tg-check test: ${plural(pass + fail, 'test')} in ${plural(files, 'file')}, ${pass} passed, ${fail} failed, ${skip} skipped`;
  return [head, ...lines].join('\n');
}

function errorReport(sub, label, runs) {
  const lines = [];
  let total = 0;
  for (const { commandId, r } of runs) {
    total += (r.errors || []).length;
    for (const e of (r.errors || []).slice(0, 50)) {
      const where = e.line ? `${e.file}(${e.line},${e.col})` : e.file;
      lines.push(`  ${where}: ${e.code || e.rule || ''} ${e.message}`.trimEnd());
    }
    if ((r.errors || []).length > 50) lines.push(`  ... and ${r.errors.length - 50} more`);
    const problem = resultProblem(r, commandId);
    if (problem) lines.push(problem);
  }
  const noun = sub === 'types' ? 'type error' : 'lint error';
  return [`tg-check ${sub} ${label}: ${plural(total, noun)}`, ...lines].join('\n');
}

const allOk = runs => runs.length > 0 && runs.every(({ r }) => r.status === 'pass');

function refuse(message) {
  return { code: 1, text: `tg-check: ${message}\n` };
}

// Groups paths by the `kind` command that covers them; `accept(p)` may refuse a path first.
async function byCommand(ctx, profile, args, kind, accept) {
  const problems = [];
  const groups = new Map();
  for (const raw of args) {
    const p = stagePath(ctx.tree, raw);
    if (!p) { problems.push(`${raw} is not a path inside the repository`); continue; }
    if (!(await isFile(join(ctx.tree, p)))) { problems.push(`${p} does not exist`); continue; }
    const why = accept ? await accept(p) : '';
    if (why) { problems.push(why); continue; }
    const commandId = await commandCovering(profile, ctx.tree, p, kind);
    if (!commandId) { problems.push(kind === 'test' ? `${p} is not a test file of any workspace's test command` : `no lint command covers ${p}`); continue; }
    if (!groups.has(commandId)) groups.set(commandId, []);
    groups.get(commandId).push(p);
  }
  return { problems, groups };
}

async function stageTest(ctx, profile, args, git, common) {
  if (!args.length) return refuse(`tg-check test needs at least one test file. ${STAGE_USAGE}`);
  const planFiles = new Set((ctx.planFiles || []).map(cleanRel).filter(Boolean));
  const planned = new Set((ctx.plannedTests || []).map(cleanRel).filter(Boolean));
  const folderOf = p => cleanRel(p.split('/').slice(0, -1).join('/')) ?? '';
  const planDirs = new Set([...planFiles].map(folderOf));
  const testRe = ctx.testPattern ? new RegExp(ctx.testPattern) : (profile.fences?.testPattern ? new RegExp(profile.fences.testPattern) : null);
  const accept = async p => {
    if (planned.has(p) || planFiles.has(p)) return '';
    if (await existsAtBase(git, ctx.tree, ctx.baseSha, p)) return '';
    if (testRe?.test(p) && planDirs.has(folderOf(p))) return '';
    return `${p} is not a test that existed at base, a planned test, or a new test next to a plan file`;
  };
  const { problems, groups } = await byCommand(ctx, profile, args, 'test', accept);
  if (problems.length) return refuse(`tg-check test refused: ${problems.join('; ')}.`);
  const runs = [];
  for (const [commandId, files] of groups) {
    runs.push({ commandId, cmd: commandOf(profile, commandId), r: await runCommand({ ...common, commandId, files }) });
  }
  return { code: allOk(runs) ? 0 : 1, text: `${testReport(runs)}\n` };
}

async function stageTypes(ctx, profile, args, common) {
  if (!args.length) return refuse(`tg-check types needs a workspace. ${STAGE_USAGE}`);
  const withTypes = (profile.workspaces || []).filter(ws => (ws.types || []).length);
  const runs = [];
  for (const id of args) {
    const ws = withTypes.find(w => w.id === id);
    if (!ws) return refuse(`"${id}" is not a workspace with a type check. Workspaces: ${withTypes.map(w => w.id).join(', ') || 'none'}.`);
  }
  for (const id of unique(args)) {
    for (const commandId of withTypes.find(w => w.id === id).types) runs.push({ commandId, r: await runCommand({ ...common, commandId }) });
  }
  return { code: allOk(runs) ? 0 : 1, text: `${errorReport('types', unique(args).join(' '), runs)}\n` };
}

async function stageLint(ctx, profile, args, common) {
  if (!args.length) return refuse(`tg-check lint needs at least one file. ${STAGE_USAGE}`);
  const { problems, groups } = await byCommand(ctx, profile, args, 'lint', null);
  if (problems.length) return refuse(`tg-check lint refused: ${problems.join('; ')}.`);
  const runs = [];
  for (const [commandId, files] of groups) runs.push({ commandId, r: await runCommand({ ...common, commandId, files }) });
  return { code: allOk(runs) ? 0 : 1, text: `${errorReport('lint', plural(args.length, 'file'), runs)}\n` };
}

function checkContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return 'check-context.json is not an object.';
  if (!ctx.runDir || !isAbsolute(String(ctx.runDir)) || !ctx.tree || !isAbsolute(String(ctx.tree))) {
    return 'check-context.json needs absolute runDir and tree paths.';
  }
  if (!PROJECT_RE.test(String(ctx.project || ''))) return 'check-context.json has no valid project.';
  if (!SHA_RE.test(String(ctx.baseSha || ''))) return 'check-context.json has no valid baseSha.';
  return '';
}

async function inStageWork(stageDir, argv, deps) {
  const ctx = await readJsonStrict(join(stageDir, 'check-context.json'), 'check-context.json');
  const bad = checkContext(ctx);
  if (bad) return refuse(bad);
  const run = await readJsonStrict(join(ctx.runDir, 'run.json'), 'run.json');
  const off = stageNotRunning(run, ctx, stageDir);
  if (off) return refuse(off);
  const [sub, ...args] = argv;
  if (!STAGE_SUBS.includes(sub)) return refuse(STAGE_USAGE);
  if (!(ctx.allowed || STAGE_SUBS).includes(sub)) return refuse(`tg-check ${sub} is not allowed in this stage.`);
  if (args.length > MAX_STAGE_ARGS) return refuse(`tg-check takes at most ${MAX_STAGE_ARGS} paths at a time.`);
  const git = deps.git || realGit;
  const profile = await stageProfile(ctx);
  const treeMode = run.isolation?.treeMode || (run.isolation?.mainDir && samePath(run.isolation.mainDir, ctx.tree) ? 'main' : 'run');
  const refusal = await refusalFor({ profile, tree: ctx.tree, treeMode, baseSha: ctx.baseSha, git });
  if (refusal) return refuse(refusal);
  const changed = await git.changedFiles(ctx.tree, ctx.baseSha, { includeUntracked: true });
  const blocked = mustTickBlocked({
    ticked: ctx.ticked, mustTick: ctx.mustTick || profile.fences?.mustTick, mustTickNew: ctx.mustTickNew || profile.fences?.mustTickNew,
  }, changed);
  if (blocked) return refuse(`tg-check is off while ${blocked} differs from base; it was not ticked in the plan.`);
  const { dir, name } = await invocationDir(stageDir, sub);
  const common = {
    profile, tree: ctx.tree, gateDir: dir, signal: deps.signal, proc: deps.proc, base: ctx.baseSha, treeMode,
    tmpDir: join(ctx.runDir, 'tmp', basename(stageDir), `tg-check-${name}`),
  };
  if (sub === 'test') return stageTest(ctx, profile, args, git, common);
  if (sub === 'types') return stageTypes(ctx, profile, args, common);
  return stageLint(ctx, profile, args, common);
}

// tg-check's entry point. Returns {code, text}: code 0 when everything ran and passed, else 1.
// deps (optional): {git, proc, signal}.
export async function inStage(stageDir, argv, deps = {}) {
  try {
    const out = await inStageWork(resolve(fromMsys(stageDir)), Array.isArray(argv) ? argv.map(String) : [], deps);
    return { code: out.code, text: redact(out.text) };
  } catch (e) {
    return refuse(redact(e.message));
  }
}

// ---------------------------------------------------------------------------------------------
// CLI

function parseCliArgs(argv) {
  const out = { what: 'uncommitted', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === '--project') out.project = value();
    else if (a === '--level') out.level = value();
    else if (a === '--tree') out.tree = value();
    else if (a === '--what') out.what = value();
    else if (a === '--data-dir') out.dataDir = value();
    else if (a === '--json') out.json = true;
    else throw new Error(`Unknown argument "${a}".`);
  }
  if (!PROJECT_RE.test(String(out.project || ''))) throw new Error('--project <name> is required (lowercase letters, digits and dashes).');
  if (!out.level) throw new Error('--level <quick|standard|paranoid> is required.');
  if (!WHATS.includes(out.what)) throw new Error(`--what must be one of ${WHATS.join(', ')}.`);
  return out;
}

async function gitText(git, dir, args) {
  const r = await git.git(dir, args);
  return String(typeof r === 'string' ? r : (r?.stdout ?? '')).trim();
}

const secs = ms => `${(ms / 1000).toFixed(1)} s`;

// The summary as plain text for the terminal.
export function summaryText(s, gateDir) {
  const lines = [`Check ${s.level} on ${s.tree} (${s.treeMode}), base ${String(s.baseSha || '').slice(0, 7)}, Node ${s.node}: ${s.result}`];
  if (s.refusal) lines.push(`Refused: ${s.refusal}`);
  if (s.error) lines.push(`Error: ${s.error}`);
  if (s.chip) lines.push(s.chip);
  if (s.baselineMissing) lines.push('No baseline for this base commit yet, so every failure counts as new.');
  for (const c of s.checks) {
    const time = c.durationMs ? ` (${secs(c.durationMs)})` : '';
    lines.push(`  ${String(c.status).padEnd(8)}${String(c.group || '').padEnd(4)}${String(c.label || c.id).padEnd(36)} ${c.reason || ''}${time}`.trimEnd());
  }
  if (s.tests?.new?.length) {
    lines.push('New failures:');
    for (const id of s.tests.new.slice(0, 30)) lines.push(`  ${id}`);
  }
  if (s.candidate?.written) lines.push(`A baseline candidate was written (${s.candidate.from} -> ${s.candidate.to} known); accept it on the project's Checks tab.`);
  if (gateDir) lines.push(`Logs: ${gateDir}`);
  return `${redact(lines.join('\n'))}\n`;
}

// The G0 runner the CLI uses: gates/g0.mjs with the diff, no plan, and probes/scan.mjs.
function cliRunG0({ git, tree, baseSha, changed, profile }) {
  return async g0Args => {
    const { runG0 } = await import('./g0.mjs');
    const probes = await import('../probes/scan.mjs');
    const diff = await git.diffText(tree, baseSha, { includeUntracked: true, exclude: profile.secrets?.denyReadGlobs || [] });
    return runG0({ ...g0Args, changed, diff, plan: null, ticked: [], allowances: [], pipeline: 'check', git, probes });
  };
}

// The CLI as a function, for tests. Returns {code, text}.
// deps: {git, proc, ports, runG0, signal, env, gateDir, hubRoot}.
export async function cliMain(argv, deps = {}) {
  if (argv[0] === '--in-stage') return inStage(argv[1], argv.slice(2), deps);
  let args;
  try { args = parseCliArgs(argv); } catch (e) {
    return { code: 2, text: `check: ${e.message}\nUsage: node gates/check.mjs --project <p> --level <l> [--tree <dir>] [--what uncommitted|branch|everything] [--json] [--data-dir <dir>]\n` };
  }
  try {
    const dataDir = args.dataDir ? resolve(args.dataDir) : defaultDataDir(deps.env || process.env);
    const loaded = await loadProfile(dataDir, args.project);
    if (!loaded?.exists) return { code: 1, text: `check: there is no profile for ${args.project} in ${join(dataDir, 'profiles')}. Create one from the example on the project's Settings tab.\n` };
    if (!loaded.profile || loaded.errors?.length) return { code: 1, text: `check: the profile for ${args.project} has errors:\n${(loaded.errors || []).map(e => `- ${e}`).join('\n')}\n` };
    const profile = loaded.profile;
    if (!profile.levels?.[args.level]) return { code: 1, text: `check: unknown level "${args.level}". Levels: ${Object.keys(profile.levels || {}).join(', ')}.\n` };
    const tree = args.tree ? resolve(args.tree) : await realpath(join(deps.hubRoot || HUB_ROOT, 'projects', args.project)).catch(() => '');
    if (!tree) return { code: 1, text: `check: projects/${args.project} does not exist; pass --tree <dir>.\n` };
    const worktree = profile.isolation?.worktreePath;
    const treeMode = worktree && samePath(tree, worktree) ? 'run' : 'main';
    const git = deps.git || realGit;
    let baseSha = await gitText(git, tree, ['rev-parse', 'HEAD']);
    if (args.what === 'branch') baseSha = await gitText(git, tree, ['merge-base', 'HEAD', profile.git?.integrationBranch || 'HEAD']);
    const changed = await git.changedFiles(tree, baseSha, { includeUntracked: true });
    const gateDir = deps.gateDir || await mkdtemp(join(tmpdir(), `tg-check-${args.project}-`));
    const runG0 = deps.runG0 || cliRunG0({ git, tree, baseSha, changed, profile });
    const summary = await runChecks({
      profile, project: args.project, dataDir, tree, treeMode, baseSha, changed: args.what === 'everything' ? [] : changed,
      dirty: changed.length > 0, level: args.level, what: args.what, role: 'head', gateDir, signal: deps.signal, runG0,
      proc: deps.proc, git, ports: deps.ports, runId: 'cli',
    });
    // Redaction only shortens secret-shaped words and adds no quotes, so the JSON stays valid.
    const text = args.json ? `${redact(JSON.stringify(summary, null, 2))}\n` : summaryText(summary, gateDir);
    return { code: summary.result === 'pass' ? 0 : 1, text };
  } catch (e) {
    return { code: 1, text: `check: ${redact(e.message)}\n` };
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? arg.toLowerCase() === me.toLowerCase() : arg === me;
}

if (isMainModule()) {
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
  cliMain(process.argv.slice(2), { signal: ac.signal }).then(
    r => { process.stdout.write(r.text); process.exitCode = r.code; },
    e => { process.stderr.write(`check: ${e.message}\n`); process.exitCode = 1; },
  );
}
