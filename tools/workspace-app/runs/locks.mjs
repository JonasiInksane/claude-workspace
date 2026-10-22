// The editing lock: one editing run per project at a time (R20), as the file runs/<project>.lock:
//
//   { "runId": "...", "project": "...", "since": "<ISO>", "holder": { "pid", "image", "startedAt" } }
//
// The holder is the app process that owns the run. A lock whose holder is no longer that same
// process (core/proc.mjs `processState`: the pid ended, or Windows reused it for another program)
// is stale, and `acquire` replaces it. A lock whose holder can't be checked (the lookup failed) is
// treated as held, never as stale. A lock held by this app itself is recognised without any
// process lookup.
//
// - The file is created with the `wx` flag, so two writers can't both create it.
// - Calls for the same project run one at a time inside this process.
// - Every change to a lock file that was read first (replacing a stale or broken lock,
//   refreshing, releasing, adopting) happens while holding `<lock>.claim`, also made with `wx`,
//   and only if the file still is the lock that was read. So two apps on one data folder can't
//   both replace the same stale lock and both think they hold it. A claim older than 10 s was
//   left by a crash and is cleared.
// - `release` removes the lock only for the run that holds it.
// - `adopt` rewrites the holder after a restart (startup recovery keeps the locks of runs that
//   wait for you).
// - An unreadable lock file is left alone for 10 s (it may be mid-write), then counts as stale.
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_RE, projectPaths, writeJsonAtomic } from '../core/datadir.mjs';
import * as realProc from '../core/proc.mjs';

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
const BROKEN_GRACE_MS = 10_000;
const CLAIM_STALE_MS = 10_000;
const CLAIM_TRIES = 20;
const CLAIM_WAIT_MS = 50;
const CLAIM_BUSY = Symbol('claim busy');
const CLAIM_BUSY_TEXT = 'Another app is changing the lock; try again in a moment.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

export const lockFile = (dataDir, project) => projectPaths(dataDir, project).lock;

function checkRunId(runId) {
  if (!RUN_ID_RE.test(String(runId ?? ''))) throw new Error(`"${runId}" is not a run id.`);
  return runId;
}

function checkHolder(holder) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0 || typeof holder.image !== 'string' || !Number.isFinite(holder.startedAt)) {
    throw new Error('A lock holder needs a pid, an image name and a start time.');
  }
  return { pid: holder.pid, image: holder.image, startedAt: holder.startedAt };
}

// { lock, broken, mtimeMs } or null when there is no lock file.
async function readLock(file) {
  let text;
  let mtimeMs = 0;
  try {
    text = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const lock = JSON.parse(text.replace(/^﻿/, ''));
    if (lock && typeof lock === 'object' && RUN_ID_RE.test(String(lock.runId))) return { lock, broken: false, mtimeMs };
  } catch { /* fall through: unreadable */ }
  return { lock: null, broken: true, mtimeMs };
}

async function createExclusive(file, lock) {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

async function removeQuietly(file) {
  try { await unlink(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

export const claimFile = file => `${file}.claim`;

// The age of a file in ms by the real clock, or null when it is gone.
async function ageOf(file) {
  try { return Date.now() - (await stat(file)).mtimeMs; } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Runs fn while holding the lock's claim file (see the header). Waits up to about a second for
// another app's claim, then resolves to CLAIM_BUSY without running fn.
async function withClaim(file, fn) {
  const claim = claimFile(file);
  for (let i = 0; ; i++) {
    if (await createExclusive(claim, { pid: process.pid, at: new Date().toISOString() })) break;
    const age = await ageOf(claim);
    if (age !== null && age > CLAIM_STALE_MS) await removeQuietly(claim); // left by a crash
    else if (i >= CLAIM_TRIES) return CLAIM_BUSY;
    else if (age !== null) await sleep(CLAIM_WAIT_MS);
  }
  try { return await fn(); } finally { await removeQuietly(claim); }
}

// True when two locks are the same claim: same run, same start and same holder.
function sameLock(a, b) {
  const key = l => JSON.stringify([l.runId, l.since ?? null, l.holder?.pid ?? null, l.holder?.image ?? null, l.holder?.startedAt ?? null]);
  return !!a && !!b && key(a) === key(b);
}

// Re-reads the lock inside the claim and runs fn(cur) only while it still matches `expected`
// ({ lock } for a readable lock, { broken: mtimeMs } for an unreadable one, null for none).
// Resolves to fn's result, false when the lock changed in between, or CLAIM_BUSY.
function ifUnchanged(file, expected, fn) {
  return withClaim(file, async () => {
    const cur = await readLock(file);
    const same = !expected ? !cur
      : 'broken' in expected ? !!cur && cur.broken && cur.mtimeMs === expected.broken
        : !!cur && !cur.broken && sameLock(cur.lock, expected.lock);
    return same ? fn(cur) : false;
  });
}

// 'same', 'gone' or 'unknown' for a lock holder; this app itself needs no lookup. `proc` needs
// processState, or at least sameProcess (then a failed lookup counts as 'gone').
async function holderState(holder, proc) {
  const self = realProc.selfRecord();
  if (holder && holder.pid === self.pid && String(holder.image).toLowerCase() === self.image.toLowerCase()
    && Math.abs(holder.startedAt - self.startedAt) <= realProc.START_TOLERANCE_MS) return 'same';
  if (typeof proc.processState === 'function') return proc.processState(holder);
  return (await proc.sameProcess(holder)) ? 'same' : 'gone';
}

// A refusal: `reason` is the sentence to show; `error` repeats it for callers that read that name.
const refused = (lock, reason) => ({ ok: false, lock, reason, error: reason });

// Takes the project's lock for `runId`. Resolves to { ok: true, lock, replaced } (replaced: the
// stale lock it took over, or null) or { ok: false, lock, reason, error } where `lock` is the one
// that is held (null when unreadable). Taking it again for the same run just updates the holder.
// `proc` and `now` can be replaced in tests.
export function acquire(dataDir, project, { runId, holder, proc = realProc, now = Date.now } = {}) {
  checkRunId(runId);
  const who = checkHolder(holder);
  const file = lockFile(dataDir, project);
  return serial(file, async () => {
    const lock = { runId, project, since: new Date(now()).toISOString(), holder: who };
    let replaced = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await createExclusive(file, lock)) return { ok: true, lock, replaced };
      const cur = await readLock(file);
      if (!cur) continue; // released in between: try again
      if (cur.broken) {
        if (now() - cur.mtimeMs < BROKEN_GRACE_MS) return refused(null, 'The lock file is being written; try again in a moment.');
        const r = await ifUnchanged(file, { broken: cur.mtimeMs }, () => removeQuietly(file));
        if (r === CLAIM_BUSY) return refused(null, CLAIM_BUSY_TEXT);
        continue;
      }
      if (cur.lock.runId === runId) {
        const again = { ...cur.lock, holder: who };
        const r = await ifUnchanged(file, { lock: cur.lock }, async () => { await writeJsonAtomic(file, again); return true; });
        if (r === CLAIM_BUSY) return refused(cur.lock, CLAIM_BUSY_TEXT);
        if (r) return { ok: true, lock: again, replaced: null };
        continue;
      }
      const state = await holderState(cur.lock.holder, proc);
      if (state === 'gone') {
        // The lookup takes a while, and another app may have replaced the stale lock meanwhile:
        // it is removed only if it still is the one that was checked.
        const r = await ifUnchanged(file, { lock: cur.lock }, async () => { await removeQuietly(file); return true; });
        if (r === CLAIM_BUSY) return refused(cur.lock, CLAIM_BUSY_TEXT);
        if (r) replaced = cur.lock;
        continue;
      }
      const reason = state === 'unknown'
        ? `Could not check whether the app that holds the lock for run ${cur.lock.runId} still runs.`
        : `Run ${cur.lock.runId} holds the lock.`;
      return refused(cur.lock, reason);
    }
    return refused(null, 'Could not take the lock; try again.');
  });
}

// Removes the lock, but only when `runId` holds it. Resolves to { released, reason }.
export function release(dataDir, project, runId) {
  const file = lockFile(dataDir, project);
  return serial(file, async () => {
    const r = await withClaim(file, async () => {
      const cur = await readLock(file);
      if (!cur) return { released: false, reason: 'No lock is held.' };
      if (cur.broken) return { released: false, reason: 'The lock file is unreadable, so it was left alone.' };
      if (cur.lock.runId !== runId) return { released: false, reason: `Run ${cur.lock.runId} holds the lock, not ${runId}.` };
      await removeQuietly(file);
      return { released: true, reason: '' };
    });
    return r === CLAIM_BUSY ? { released: false, reason: CLAIM_BUSY_TEXT } : r;
  });
}

// What the lock looks like: { held, runId, since, ageSec, holderAlive, holder, broken }.
// holderAlive is true, false, or null when it couldn't be checked.
export async function inspect(dataDir, project, { proc = realProc, now = Date.now } = {}) {
  const cur = await readLock(lockFile(dataDir, project));
  if (!cur) return { held: false, runId: null, since: null, ageSec: null, holderAlive: null, holder: null, broken: false };
  if (cur.broken) {
    return { held: true, runId: null, since: null, ageSec: Math.round((now() - cur.mtimeMs) / 1000), holderAlive: null, holder: null, broken: true };
  }
  const { runId, since, holder } = cur.lock;
  const state = await holderState(holder, proc);
  const sinceMs = Date.parse(since);
  return {
    held: true, runId, since: since ?? null,
    ageSec: Number.isFinite(sinceMs) ? Math.max(0, Math.round((now() - sinceMs) / 1000)) : null,
    holderAlive: state === 'same' ? true : state === 'gone' ? false : null, holder: holder ?? null, broken: false,
  };
}

// Makes `holder` the holder of `runId`'s lock (startup recovery). Creates the lock when there is
// none; refuses when another run holds it. Resolves to { ok, lock, reason }.
export function adopt(dataDir, project, runId, holder, { now = Date.now } = {}) {
  checkRunId(runId);
  const who = checkHolder(holder);
  const file = lockFile(dataDir, project);
  return serial(file, async () => {
    const r = await withClaim(file, async () => {
      const cur = await readLock(file);
      if (cur && !cur.broken && cur.lock.runId !== runId) return refused(cur.lock, `Run ${cur.lock.runId} holds the lock, not ${runId}.`);
      const lock = cur && !cur.broken ? { ...cur.lock, holder: who } : { runId, project, since: new Date(now()).toISOString(), holder: who };
      await writeJsonAtomic(file, lock);
      return { ok: true, lock, reason: '' };
    });
    return r === CLAIM_BUSY ? refused(null, CLAIM_BUSY_TEXT) : r;
  });
}

// Every lock file in dataDir/runs: [{ project, lock, broken }].
export async function listLocks(dataDir) {
  const dir = join(resolve(dataDir), 'runs');
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  for (const name of names) {
    const project = name.endsWith('.lock') ? name.slice(0, -5) : '';
    if (!PROJECT_RE.test(project)) continue;
    const cur = await readLock(join(dir, name));
    if (cur) out.push({ project, lock: cur.lock, broken: cur.broken });
  }
  return out;
}
