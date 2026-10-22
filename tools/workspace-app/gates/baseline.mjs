// Baselines: the failures a project already has at one base commit, so a check can tell a new
// failure (red) from a known one, and notice when a known one starts passing.
//
//   dataDir/baselines/<project>/<key>.json             the accepted baseline (SPEC 2.10)
//   dataDir/baselines/<project>/<key>.candidate.json   a proposed replacement, waiting for a click
//
// The key is '<sha12>-<treeMode>-node<version>' (baselineKey). A baseline changes in two ways
// only (SPEC R15):
// - saveBaseline ('first-run') writes it when none exists, or adds the entry of a command it has
//   no entry for yet (a check level that runs more commands). An existing entry never changes.
//   gates/check.mjs (role 'base') runs only the commands the baseline lacks and saves them this
//   way, and the executor's preflight counts on it (SPEC WP11: "missing entries are computed by
//   runChecks({role: 'base'})"). A passing command is recorded like this too; candidateFrom
//   never adds a command, and writeCandidate refuses a candidate that only adds passing ones.
// - acceptCandidate replaces it when the user accepts a candidate whose hash matches what they
//   were shown, and the baseline is still the one the candidate was made from.
//
// A command entry (in a baseline, and in the `current` and `reruns` objects compare() reads):
//   tests:          {kind?:'test', status, exitCode, counts, failures:[{id, kind, message}],
//                    durationMs, passed:[id] (current only: positive proof a test passed)}
//   types and lint: {kind?, status, exitCode, errors:[id], warnings?, durationMs,
//                    partial?, files?:[path] (current only: the run checked just these files)}
// `kind` may be left out: an entry with `errors` and no `failures` is an error list. commandEntry()
// builds an entry from a check result; gates/check.mjs builds the same shape itself.
//
// Error ids carry no line or column ('file::TSxxxx::message', 'file::ruleId::message'), so moving
// code doesn't change them. Repeats of one id are numbered (' (2)', ' (3)') wherever ids are
// compared, so one more of the same error still shows as new. A command that failed without any
// parsed id fails as '<cmd>::(command failed)'.
//
// Ids are relative to each command's cwd, so two commands can share one ('src/x.test.ts::a' from
// test:api and test:web). A failure is therefore always a command plus an id: lists that cover
// several commands (compare's top-level lists, knownList, diffBaselines) hold one entry per
// command and id, so their lengths match the per-command rows and knownCount.
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { PROJECT_RE, jsonHash, projectPaths, readJson, writeJsonAtomic } from '../core/datadir.mjs';
import { cleanMessage } from './tap.mjs';

export const KEY_RE = /^[0-9a-f]{12}-[a-z]+-node\d+\.\d+\.\d+$/;
export const COMMAND_FAILED = '(command failed)';
const SHA_RE = /^[0-9a-f]{12,64}$/;
const TREE_MODE_RE = /^[a-z]+$/;
const NODE_RE = /^v?(\d+\.\d+\.\d+)$/;
const ERROR_MESSAGE_CAP = 500;
// Messages are compared on their first 300 characters: gates/check.mjs stores 300.
const COMPARE_MESSAGE_CAP = 300;
const CANDIDATE_FIELDS = ['reason', 'from', 'to', 'leaving', 'entering', 'byCommand', 'madeAt', 'fromHash', 'hash'];
const STORED_FIELDS = ['kind', 'status', 'exitCode', 'counts', 'failures', 'errors', 'warnings', 'durationMs'];
const CATEGORIES = ['new', 'known', 'flaky', 'canShrink', 'messageChanged'];
// Statuses that mean a command failed; 'warn' (lint warnings only) and 'skip' don't.
const FAILED_STATUSES = new Set(['fail', 'error', 'cancelled', 'timeout']);
// Statuses of a run that finished, so the errors it didn't report are really gone.
const RAN_STATUSES = new Set(['pass', 'fail', 'warn']);

// An Error with an HTTP-style status, which routes pass on as is.
function failWith(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---- keys and paths -------------------------------------------------------------------------

export function baselineKey({ baseSha, treeMode, node } = {}) {
  const sha = String(baseSha || '').toLowerCase();
  if (!SHA_RE.test(sha)) throw failWith(400, `"${baseSha}" is not a commit SHA (12 to 64 hex characters).`);
  if (!TREE_MODE_RE.test(String(treeMode || ''))) throw failWith(400, `"${treeMode}" is not a tree mode such as run or main.`);
  const m = NODE_RE.exec(String(node || ''));
  if (!m) throw failWith(400, `"${node}" is not a Node version such as 24.11.1.`);
  return `${sha.slice(0, 12)}-${treeMode}-node${m[1]}`;
}

function projectDir(dataDir, project) {
  if (!PROJECT_RE.test(String(project ?? ''))) {
    throw failWith(400, `"${project}" is not a project name. Use lowercase letters, digits and single hyphens.`);
  }
  return projectPaths(dataDir, project);
}

// The two files of one key. The key is checked here, before any path is built from it.
function pathsFor(dataDir, project, key) {
  const p = projectDir(dataDir, project);
  if (!KEY_RE.test(String(key ?? ''))) throw failWith(400, `"${key}" is not a baseline key such as 0123456789ab-run-node24.11.1.`);
  return { baseline: p.baseline(key), candidate: p.candidate(key) };
}

// ---- error identities -----------------------------------------------------------------------

// A file as an id part: posix, relative to `cwd` when it is absolute and `cwd` is given.
function idFile(file, cwd, missing) {
  let f = String(file || missing);
  if (cwd && isAbsolute(f)) f = relative(resolve(cwd), f) || f;
  return f.replace(/\\/g, '/');
}

const oneLine = text => cleanMessage(String(text || '').replace(/\s+/g, ' ').trim(), { cap: ERROR_MESSAGE_CAP });

// 'file::TSxxxx::message' for a tsc error ({file, code, message}; line and column are ignored).
// An error without a file (a tsconfig problem) uses '(project)', as gates/commands.mjs does.
export function typeErrorId({ file, code, message } = {}, { cwd } = {}) {
  return `${idFile(file, cwd, '(project)')}::${code || 'TS'}::${oneLine(message)}`;
}

// 'file::ruleId::message' for an ESLint message ({file, ruleId, message}); a parse error has no
// rule and uses 'parse', as gates/commands.mjs does.
export function lintErrorId({ file, ruleId, message } = {}, { cwd } = {}) {
  return `${idFile(file, cwd, '(no file)')}::${ruleId || 'parse'}::${oneLine(message)}`;
}

// Numbers repeats: ['a', 'a', 'b'] gives ['a', 'a (2)', 'b']. A list without repeats is unchanged,
// so numbering twice is harmless.
export function numberDuplicates(ids) {
  const seen = new Map();
  return ids.map(id => {
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id} (${n})`;
  });
}

const idOf = e => (isObject(e) && e.id !== undefined ? String(e.id) : String(e));

// ---- command entries ------------------------------------------------------------------------

// A command entry from a check result: {status, exitCode, durationMs, tap?, errors?, warnings?}.
// `tap` is parseTap output; `errors` are ids or {file, code|ruleId, message} objects. Pass `files`
// when a types or lint run checked only some files, so only those can count as fixed.
export function commandEntry(kind, result = {}, { cwd, files } = {}) {
  const entry = { kind, status: result.status || 'error', exitCode: result.exitCode ?? null, durationMs: result.durationMs ?? null };
  if (kind === 'test') {
    const tests = (result.tap && result.tap.tests) || [];
    entry.counts = { pass: 0, fail: 0, skip: 0, todo: 0, ...((result.tap && result.tap.counts) || {}) };
    entry.failures = tests.filter(t => t.status === 'fail')
      .map(t => ({ id: t.id, kind: (t.failure && t.failure.kind) || 'other', message: (t.failure && t.failure.message) || '' }));
    entry.passed = tests.filter(t => t.status === 'pass').map(t => t.id);
    return entry;
  }
  const makeId = kind === 'lint' ? lintErrorId : typeErrorId;
  const ids = (result.errors || []).map(e => (typeof e === 'string' ? e : makeId(e, { cwd })));
  entry.errors = numberDuplicates(ids.sort()).sort();
  if (kind === 'lint') entry.warnings = Number(result.warnings) || 0;
  if (files) {
    entry.partial = true;
    entry.files = files.map(f => idFile(f, cwd, ''));
  }
  return entry;
}

// True for an entry whose failures are an error list (types, lint, format), not tests.
function isErrorList(entry) {
  if (entry.kind) return entry.kind !== 'test';
  return Array.isArray(entry.errors) && !Array.isArray(entry.failures);
}

// The failing ids of one command entry, as a Map id -> {kind, message}. Repeats are numbered.
function failingOf(cmd, entry) {
  const out = new Map();
  const failures = (entry && Array.isArray(entry.failures)) ? entry.failures : [];
  const failureIds = numberDuplicates(failures.map(idOf));
  failures.forEach((f, i) => out.set(failureIds[i], { kind: (f && f.kind) || 'other', message: (f && f.message) || '' }));
  const errors = (entry && Array.isArray(entry.errors)) ? entry.errors : [];
  for (const id of numberDuplicates(errors.map(idOf))) out.set(id, { kind: 'error', message: '' });
  if (!out.size && entry && FAILED_STATUSES.has(entry.status)) {
    out.set(`${cmd}::${COMMAND_FAILED}`, { kind: 'command', message: `exit code ${entry.exitCode ?? 'unknown'}` });
  }
  return out;
}

// The known failure ids of a baseline as a Set: those of command `cmd`, or without `cmd` every id
// known in any command. An id two commands share is one member of that Set, so use knownList or
// knownCount to count or list failures.
export function knownIds(baseline, cmd) {
  const commands = (baseline && baseline.commands) || {};
  const ids = new Set();
  for (const [c, entry] of Object.entries(commands)) {
    if (cmd && c !== cmd) continue;
    for (const id of failingOf(c, entry).keys()) ids.add(id);
  }
  return ids;
}

// Every known failure of a baseline, one id per command and failure, sorted. Its length is
// knownCount, also when two commands know the same id.
export function knownList(baseline) {
  const out = [];
  for (const [c, entry] of Object.entries((baseline && baseline.commands) || {})) out.push(...failingOf(c, entry).keys());
  return out.sort();
}

export function knownCount(baseline) {
  let n = 0;
  for (const [c, entry] of Object.entries((baseline && baseline.commands) || {})) n += failingOf(c, entry).size;
  return n;
}

// What a baseline file keeps of an entry: no pass lists or file lists, messages redacted and capped.
function storedEntry(entry) {
  const out = {};
  for (const k of STORED_FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
  if (Array.isArray(out.failures)) {
    out.failures = out.failures.map(f => ({ id: idOf(f), kind: (f && f.kind) || 'other', message: cleanMessage((f && f.message) || '') }));
  }
  if (Array.isArray(out.errors)) out.errors = out.errors.map(idOf);
  return out;
}

function storedCommands(commands) {
  const out = {};
  for (const [cmd, entry] of Object.entries(commands || {})) out[cmd] = storedEntry(entry || {});
  return out;
}

// ---- reading and writing --------------------------------------------------------------------

export async function loadBaseline(dataDir, project, key) {
  const { baseline } = pathsFor(dataDir, project, key);
  const doc = await readJson(baseline, null);
  if (doc && (!isObject(doc.commands) || doc.key !== key)) throw new Error(`${baseline} is not a baseline for ${key}.`);
  return doc;
}

// Saves what a first run measured (source 'first-run' only). With no baseline for the key, this
// writes it. With one, it adds only the commands that baseline has no entry for; existing entries
// stay exactly as they are, and with nothing to add it refuses (409). Returns the saved baseline.
export async function saveBaseline(dataDir, project, key, data, { source = 'first-run' } = {}) {
  const paths = pathsFor(dataDir, project, key);
  if (source !== 'first-run') {
    throw failWith(400, 'A baseline is saved directly only on its first run; after that it changes by accepting a candidate.');
  }
  if (!data || !isObject(data.commands)) throw failWith(400, 'The baseline data has no commands.');
  if (!Object.keys(data.commands).length) throw failWith(400, 'The baseline data has no command results to save.');
  const dataKey = baselineKey(data);
  if (dataKey !== key) throw failWith(400, `The key ${key} does not match the data, which is for ${dataKey}.`);
  const stored = await loadBaseline(dataDir, project, key);
  const now = new Date().toISOString();
  if (!stored) {
    const commands = storedCommands(data.commands);
    const doc = {
      version: 1, project, key, baseSha: String(data.baseSha).toLowerCase(), treeMode: data.treeMode,
      node: NODE_RE.exec(data.node)[1], createdAt: now, acceptedAt: null, source, commands,
      history: [{ at: now, action: 'first-run', commands: Object.keys(commands).sort(), known: knownCount({ commands }) }],
    };
    await writeJsonAtomic(paths.baseline, doc);
    return doc;
  }
  const added = Object.keys(data.commands).filter(cmd => !Object.prototype.hasOwnProperty.call(stored.commands, cmd)).sort();
  if (!added.length) {
    const has = Object.keys(data.commands).sort().join(', ');
    throw failWith(409, `A baseline for ${key} already exists and has ${has}. It changes only when you accept a candidate.`);
  }
  const fresh = storedCommands(Object.fromEntries(added.map(cmd => [cmd, data.commands[cmd]])));
  const doc = {
    ...stored,
    commands: { ...stored.commands, ...fresh },
    history: [...(stored.history || []), { at: now, action: 'first-run', commands: added, known: knownCount({ commands: fresh }) }],
  };
  await writeJsonAtomic(paths.baseline, doc);
  return doc;
}

// The baselines of a project, newest first: [{key, updatedAt, hasCandidate}].
export async function listBaselines(dataDir, project) {
  const dir = projectDir(dataDir, project).baselines;
  let names = [];
  try { names = await readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const keys = names.filter(n => n.endsWith('.json') && !n.endsWith('.candidate.json')).map(n => n.slice(0, -5)).filter(k => KEY_RE.test(k));
  const out = [];
  for (const key of keys) {
    const s = await stat(resolve(dir, `${key}.json`));
    out.push({ key, updatedAt: s.mtime.toISOString(), hasCandidate: names.includes(`${key}.candidate.json`) });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}

// ---- comparing ------------------------------------------------------------------------------

function sameSha(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

// Both sides go through the same redaction first: a baseline stores messages redacted without
// the profile's allow list, while parseTap keeps allowed values, so a known failure whose message
// holds one would otherwise look changed on every run.
const normMessage = m => cleanMessage(String(m || '')).replace(/\d+(?:\.\d+)?\s?ms\b/g, 'Nms').replace(/\s+/g, ' ').trim().slice(0, COMPARE_MESSAGE_CAP);

function messageChanged(was, now) {
  if (was.kind !== now.kind) return true;
  return Boolean(was.message && now.message) && normMessage(was.message) !== normMessage(now.message);
}

// True when the current run proves a known failure is gone: a test id passed, or an error id is
// absent from a types or lint run that ran (and, when it checked only some files, covered that
// file).
function provenFixed(cmd, id, entry, passed) {
  if (id === `${cmd}::${COMMAND_FAILED}`) return entry.status === 'pass';
  if (passed.has(id)) return true;
  if (!isErrorList(entry) || !RAN_STATUSES.has(entry.status)) return false;
  if (!entry.partial && !Array.isArray(entry.files)) return true;
  return (entry.files || []).includes(id.split('::')[0]);
}

function commandsOf(obj, what) {
  if (!obj) return {};
  if (!isObject(obj.commands)) throw new Error(`compare needs ${what}.commands, a map of command results.`);
  return obj.commands;
}

// Reruns come as {commands: {cmd: entry}} or as a plain map {cmd: value}.
function rerunsOf(reruns) {
  if (!reruns) return {};
  if (!isObject(reruns)) throw new Error('compare needs reruns as a map of command results.');
  return isObject(reruns.commands) ? reruns.commands : reruns;
}

// The ids that passed on a rerun. A value is an entry with a `passed` list, a list of passed ids,
// or a map {testId: 'pass'|'fail'} (what gates/check.mjs builds). Only a positive pass counts:
// an entry without a pass list proves nothing, so a real failure is never called flaky by mistake.
function rerunPassed(value) {
  if (Array.isArray(value)) return new Set(value.map(String));
  if (!isObject(value)) return new Set();
  if (Array.isArray(value.passed)) return new Set(value.passed.map(String));
  return new Set(Object.keys(value).filter(id => id.includes('::') && (value[id] === 'pass' || value[id] === true)));
}

// Whether known failures may be proposed for removal: there is a baseline, current.baseSha (when
// given) is the baseline's SHA, and current.dirty isn't true. A caller that leaves baseSha out
// loaded the baseline by the key of its own base, so the SHA is the same.
function canShrinkFrom(baseline, current) {
  if (!baseline || current.dirty === true) return false;
  if (current.baseSha === undefined || current.baseSha === null || current.baseSha === '') return true;
  return sameSha(baseline.baseSha, current.baseSha);
}

// Sorts the current failures into the categories of SPEC 2.10:
// - known: in the baseline and failing now (messageChanged lists those whose kind or message moved);
// - flaky: not in the baseline, failing now, but passed on the rerun;
// - new: not in the baseline and still failing (also when no rerun ran);
// - canShrink: a baseline failure proven fixed now, at the baseline's SHA (canShrinkFrom);
// - missingCommands: commands the baseline has no entry for (their failures count as new).
// `current` is {baseSha?, dirty?, commands: {cmd: entry}}; `reruns` is described at rerunsOf.
// The top-level lists join the perCommand lists, sorted: an id that fails in two commands is
// listed twice, so the counts match the rows.
export function compare({ baseline = null, current, reruns = null } = {}) {
  if (!current) throw new Error('compare needs current, the results of this check.');
  const cur = commandsOf(current, 'current');
  const rr = rerunsOf(reruns);
  const base = (baseline && isObject(baseline.commands)) ? baseline.commands : {};
  const shrinkable = canShrinkFrom(baseline, current);
  const out = { new: [], known: [], flaky: [], canShrink: [], messageChanged: [], missingCommands: [], perCommand: {} };
  for (const cmd of Object.keys(cur).sort()) {
    const entry = cur[cmd] || {};
    const b = base[cmd];
    const pc = { new: [], known: [], flaky: [], canShrink: [], messageChanged: [], changes: [], missing: !b };
    if (!b) out.missingCommands.push(cmd);
    const now = failingOf(cmd, entry);
    const was = b ? failingOf(cmd, b) : new Map();
    const passedOnRerun = rerunPassed(rr[cmd]);
    for (const [id, f] of now) {
      if (was.has(id)) {
        pc.known.push(id);
        if (messageChanged(was.get(id), f)) {
          pc.messageChanged.push(id);
          pc.changes.push({ id, was: was.get(id), now: f });
        }
      } else if (passedOnRerun.has(id)) pc.flaky.push(id);
      else pc.new.push(id);
    }
    if (shrinkable) {
      const passed = new Set(Array.isArray(entry.passed) ? entry.passed.map(String) : []);
      for (const id of was.keys()) if (!now.has(id) && provenFixed(cmd, id, entry, passed)) pc.canShrink.push(id);
    }
    for (const k of CATEGORIES) {
      pc[k].sort();
      out[k].push(...pc[k]);
    }
    out.perCommand[cmd] = pc;
  }
  for (const k of CATEGORIES) out[k].sort();
  return out;
}

// "0 new · 61 known · 1 flaky", plus "· 3 now pass" when the baseline can shrink.
export function chip(cmp) {
  const n = v => (Array.isArray(v) ? v.length : Number(v) || 0);
  const parts = [`${n(cmp && cmp.new)} new`, `${n(cmp && cmp.known)} known`];
  if (n(cmp && cmp.flaky)) parts.push(`${n(cmp.flaky)} flaky`);
  if (n(cmp && cmp.canShrink)) parts.push(`${n(cmp.canShrink)} now pass`);
  return parts.join(' · ');
}

// ---- candidates -----------------------------------------------------------------------------

// The failures leaving and entering when `to` replaces `from` (both baseline-shaped), compared
// command by command: {leaving: [id], entering: [id], byCommand: {cmd: {leaving, entering}}}.
// leaving and entering join the byCommand lists, sorted, so a fix in one of two commands that
// share an id still leaves; byCommand lists only commands that changed.
export function diffBaselines(from, to) {
  const was = (from && from.commands) || {};
  const now = (to && to.commands) || {};
  const out = { leaving: [], entering: [], byCommand: {} };
  for (const cmd of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    const a = was[cmd] ? failingOf(cmd, was[cmd]) : new Map();
    const b = now[cmd] ? failingOf(cmd, now[cmd]) : new Map();
    const leaving = [...a.keys()].filter(id => !b.has(id)).sort();
    const entering = [...b.keys()].filter(id => !a.has(id)).sort();
    if (!leaving.length && !entering.length) continue;
    out.byCommand[cmd] = { leaving, entering };
    out.leaving.push(...leaving);
    out.entering.push(...entering);
  }
  out.leaving.sort();
  out.entering.sort();
  return out;
}

// An entry without the ids in `drop`. Ids are matched after numbering repeats, and what stays is
// stored numbered, so dropping 'x (3)' of three 'x' keeps 'x' and 'x (2)'.
function shrinkEntry(entry, drop) {
  const out = { ...entry };
  if (Array.isArray(entry.failures)) {
    const ids = numberDuplicates(entry.failures.map(idOf));
    const kept = entry.failures.map((f, i) => ({ ...f, id: ids[i] })).filter(f => !drop.has(f.id));
    const gone = entry.failures.length - kept.length;
    out.failures = kept;
    if (entry.counts) out.counts = { ...entry.counts, fail: Math.max(0, (entry.counts.fail || 0) - gone), pass: (entry.counts.pass || 0) + gone };
  }
  if (Array.isArray(entry.errors)) out.errors = numberDuplicates(entry.errors.map(idOf)).filter(id => !drop.has(id));
  if (!(out.failures || []).length && !(out.errors || []).length) {
    out.status = 'pass';
    out.exitCode = 0;
  }
  return out;
}

// A smaller baseline without the failures `current` proves fixed, or null when none are.
// The result is the candidate shape of SPEC 2.10 without its hash (writeCandidate adds it).
export function candidateFrom(baseline, current, { reason, now = new Date().toISOString() } = {}) {
  if (!baseline) return null;
  const cmp = compare({ baseline, current });
  if (!cmp.canShrink.length) return null;
  const commands = {};
  for (const [cmd, entry] of Object.entries(baseline.commands)) {
    const drop = new Set((cmp.perCommand[cmd] && cmp.perCommand[cmd].canShrink) || []);
    commands[cmd] = drop.size ? shrinkEntry(entry, drop) : entry;
  }
  const n = cmp.canShrink.length;
  const sha7 = String(current.baseSha || baseline.baseSha).slice(0, 7);
  const out = { ...baseline, commands };
  for (const k of CANDIDATE_FIELDS) delete out[k];
  return {
    ...out,
    reason: reason || `${plural(n, 'known failure')} passed in a check at ${sha7}.`,
    from: knownCount(baseline), to: knownCount({ commands }), ...diffBaselines(baseline, { commands }), madeAt: now,
  };
}

// Saves a candidate for `key`, tied to the baseline on disk now (fromHash) and sealed with a hash
// of everything else. from, to, leaving and entering are recomputed against that baseline.
export async function writeCandidate(dataDir, project, key, candidate) {
  const paths = pathsFor(dataDir, project, key);
  const baseline = await loadBaseline(dataDir, project, key);
  if (!baseline) throw failWith(404, `There is no baseline ${key} to replace.`);
  if (!candidate || !isObject(candidate.commands)) throw failWith(400, 'The candidate has no commands.');
  if (candidate.key && candidate.key !== key) throw failWith(400, `The candidate is for ${candidate.key}, not ${key}.`);
  const commands = storedCommands(candidate.commands);
  const body = {
    ...candidate, version: 1, project, key, baseSha: baseline.baseSha, treeMode: baseline.treeMode, node: baseline.node, commands,
    reason: candidate.reason || 'A recomputed baseline.', from: knownCount(baseline), to: knownCount({ commands }),
    ...diffBaselines(baseline, { commands }), madeAt: candidate.madeAt || new Date().toISOString(), fromHash: jsonHash(baseline),
  };
  delete body.hash;
  if (!body.leaving.length && !body.entering.length) {
    const added = Object.keys(commands).filter(cmd => !Object.prototype.hasOwnProperty.call(baseline.commands, cmd));
    const more = added.length
      ? ` A command the baseline has no entry for (${added.sort().join(', ')}) is added by a first run of the base checks, not by a candidate.`
      : '';
    throw failWith(400, `The candidate has the same known failures as the baseline, so there is nothing to accept.${more}`);
  }
  body.hash = jsonHash(body);
  await writeJsonAtomic(paths.candidate, body);
  return body;
}

export async function loadCandidate(dataDir, project, key) {
  return readJson(pathsFor(dataDir, project, key).candidate, null);
}

// Replaces the baseline with its candidate, only when `hash` is the hash the user was shown, the
// candidate file is intact and the baseline hasn't changed since the candidate was made (a later
// first run that added a command also counts as a change). Returns {baseline, message}.
// Throws with status 404 (no candidate) or 409 (anything stale).
export async function acceptCandidate(dataDir, project, key, hash) {
  const paths = pathsFor(dataDir, project, key);
  const cand = await loadCandidate(dataDir, project, key);
  if (!cand) throw failWith(404, `There is no candidate baseline for ${key}; it may have been accepted already.`);
  const { hash: sealed, ...rest } = cand;
  if (jsonHash(rest) !== sealed) throw failWith(409, 'The candidate file was changed after it was made. Run the check again for a new one.');
  if (String(hash || '') !== sealed) throw failWith(409, 'The candidate changed since you looked at it. Reload it and review it again.');
  const baseline = await loadBaseline(dataDir, project, key);
  if (!baseline || jsonHash(baseline) !== cand.fromHash) {
    throw failWith(409, 'The baseline changed since this candidate was made. Run the check again for a new candidate.');
  }
  const at = new Date().toISOString();
  const leaving = cand.leaving || [];
  const entering = cand.entering || [];
  const next = {
    version: 1, project, key, baseSha: baseline.baseSha, treeMode: baseline.treeMode, node: baseline.node,
    createdAt: baseline.createdAt, acceptedAt: at, source: 'accepted', commands: storedCommands(cand.commands),
    history: [...(baseline.history || []), { at, action: 'accept', fromKnown: cand.from, toKnown: cand.to, leaving, entering, hash: sealed }],
  };
  await writeJsonAtomic(paths.baseline, next);
  await rm(paths.candidate, { force: true });
  const moved = entering.length ? `${leaving.length} left, ${entering.length} came in` : `${leaving.length} left`;
  return { baseline: next, message: `Baseline ${key} now has ${plural(cand.to, 'known failure')} (was ${cand.from}; ${moved}).` };
}
