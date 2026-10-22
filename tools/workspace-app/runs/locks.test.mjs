// Tests for runs/locks.mjs: one editing run per project (R20), stale locks of dead apps, adoption
// after a restart, and releases by the wrong run. Process lookups use a fake `proc`, except one
// Windows test that checks a real dead pid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, adopt, inspect, listLocks, lockFile, release } from './locks.mjs';
import * as realProc from '../core/proc.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-locks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const appA = { pid: 4101, image: 'node.exe', startedAt: 1_000_000 };
const appB = { pid: 4102, image: 'node.exe', startedAt: 2_000_000 };

// A stand-in for core/proc.mjs: `states` maps a pid to 'same', 'gone' or 'unknown'.
function fakeProc(states = {}) {
  const calls = [];
  return {
    calls,
    async processState(rec) { calls.push(rec.pid); return states[rec.pid] || 'gone'; },
  };
}

const readLockFile = (dataDir, project) => JSON.parse(readFileSync(lockFile(dataDir, project), 'utf8'));

test('acquire creates runs/<project>.lock with the run, project, time and holder', async t => {
  const dataDir = temp(t);
  const r = await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc(), now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, null);
  assert.equal(lockFile(dataDir, 'example'), join(dataDir, 'runs', 'example.lock'));
  assert.deepEqual(readLockFile(dataDir, 'example'), { runId: 'r-1', project: 'example', since: '2026-10-22T10:00:00.000Z', holder: appA });
});

test('a second run is refused while the holder app still runs (R20)', async t => {
  const dataDir = temp(t);
  const proc = fakeProc({ [appA.pid]: 'same' });
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc });
  const r = await acquire(dataDir, 'example', { runId: 'r-2', holder: appA, proc });
  assert.equal(r.ok, false);
  assert.equal(r.lock.runId, 'r-1');
  assert.equal(r.reason, 'Run r-1 holds the lock.');
  assert.equal(r.error, r.reason, 'error repeats the reason for callers that read that name');
  assert.equal(readLockFile(dataDir, 'example').runId, 'r-1');
});

test('a lock whose holder died (or whose pid was reused) is stale and gets replaced', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'example', { runId: 'r-old', holder: appA, proc: fakeProc() });
  const proc = fakeProc({ [appA.pid]: 'gone' });
  const r = await acquire(dataDir, 'example', { runId: 'r-new', holder: appB, proc, now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.replaced.runId, 'r-old');
  assert.deepEqual(proc.calls, [appA.pid]);
  assert.deepEqual(readLockFile(dataDir, 'example').holder, appB);
});

test('a holder that cannot be checked counts as alive, never as stale', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc() });
  const r = await acquire(dataDir, 'example', { runId: 'r-2', holder: appB, proc: fakeProc({ [appA.pid]: 'unknown' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Could not check whether the app that holds the lock for run r-1 still runs/);
});

test('acquiring again for the same run only updates the holder', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc(), now: () => NOW });
  const r = await acquire(dataDir, 'example', { runId: 'r-1', holder: appB, proc: fakeProc({ [appA.pid]: 'same' }), now: () => NOW + 5000 });
  assert.equal(r.ok, true);
  const lock = readLockFile(dataDir, 'example');
  assert.deepEqual(lock.holder, appB);
  assert.equal(lock.since, '2026-10-22T10:00:00.000Z', 'the lock keeps its start time');
});

test('two runs racing for a free lock: exactly one wins', async t => {
  const dataDir = temp(t);
  const proc = fakeProc({ [appA.pid]: 'same', [appB.pid]: 'same' });
  const results = await Promise.all([
    acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc }),
    acquire(dataDir, 'example', { runId: 'r-2', holder: appB, proc }),
    acquire(dataDir, 'other', { runId: 'r-3', holder: appB, proc }),
  ]);
  assert.equal(results.slice(0, 2).filter(r => r.ok).length, 1);
  assert.equal(results[2].ok, true, 'locks are per project');
});

test('release removes the lock only for the run that holds it', async t => {
  const dataDir = temp(t);
  assert.deepEqual(await release(dataDir, 'example', 'r-1'), { released: false, reason: 'No lock is held.' });
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc() });
  const wrong = await release(dataDir, 'example', 'r-2');
  assert.equal(wrong.released, false);
  assert.equal(wrong.reason, 'Run r-1 holds the lock, not r-2.');
  assert.ok(existsSync(lockFile(dataDir, 'example')));
  assert.deepEqual(await release(dataDir, 'example', 'r-1'), { released: true, reason: '' });
  assert.ok(!existsSync(lockFile(dataDir, 'example')));
});

test('adopt rewrites the holder after a restart, creates a missing lock, and refuses another run', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc(), now: () => NOW });
  const r = await adopt(dataDir, 'example', 'r-1', appB);
  assert.equal(r.ok, true);
  assert.deepEqual(readLockFile(dataDir, 'example'), { runId: 'r-1', project: 'example', since: '2026-10-22T10:00:00.000Z', holder: appB });
  const refused = await adopt(dataDir, 'example', 'r-2', appB);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Run r-1 holds the lock, not r-2/);
  const created = await adopt(dataDir, 'fresh', 'r-9', appB, { now: () => NOW });
  assert.equal(created.ok, true);
  assert.equal(readLockFile(dataDir, 'fresh').since, '2026-10-22T10:00:00.000Z');
});

test('inspect reports held, runId, since, ageSec and holderAlive (true, false or null)', async t => {
  const dataDir = temp(t);
  assert.deepEqual(await inspect(dataDir, 'example', { proc: fakeProc() }),
    { held: false, runId: null, since: null, ageSec: null, holderAlive: null, holder: null, broken: false });
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc(), now: () => NOW });
  const alive = await inspect(dataDir, 'example', { proc: fakeProc({ [appA.pid]: 'same' }), now: () => NOW + 90_000 });
  assert.deepEqual(alive, { held: true, runId: 'r-1', since: '2026-10-22T10:00:00.000Z', ageSec: 90, holderAlive: true, holder: appA, broken: false });
  assert.equal((await inspect(dataDir, 'example', { proc: fakeProc({ [appA.pid]: 'gone' }) })).holderAlive, false);
  assert.equal((await inspect(dataDir, 'example', { proc: fakeProc({ [appA.pid]: 'unknown' }) })).holderAlive, null);
});

test('this app itself is recognised as the holder without any process lookup', async t => {
  const dataDir = temp(t);
  const self = realProc.selfRecord();
  const noLookups = { processState: () => { throw new Error('no lookup expected'); }, sameProcess: () => { throw new Error('no lookup expected'); } };
  await acquire(dataDir, 'example', { runId: 'r-1', holder: self, proc: noLookups });
  assert.equal((await inspect(dataDir, 'example', { proc: noLookups })).holderAlive, true);
  const r = await acquire(dataDir, 'example', { runId: 'r-2', holder: self, proc: noLookups });
  assert.equal(r.ok, false, 'the app does not steal its own lock from another run');
});

test('a proc with only sameProcess also works (a failed lookup then counts as gone)', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'example', { runId: 'r-1', holder: appA, proc: fakeProc() });
  const onlySame = alive => ({ sameProcess: async () => alive });
  assert.equal((await acquire(dataDir, 'example', { runId: 'r-2', holder: appB, proc: onlySame(true) })).ok, false);
  assert.equal((await acquire(dataDir, 'example', { runId: 'r-2', holder: appB, proc: onlySame(false) })).ok, true);
});

test('an unreadable lock file is left alone for 10 s, then counts as stale', async t => {
  const dataDir = temp(t);
  const file = lockFile(dataDir, 'example');
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(file, '{ "runId": "r-1", "pro');
  const mtime = Date.now();
  const soon = await acquire(dataDir, 'example', { runId: 'r-2', holder: appA, proc: fakeProc(), now: () => mtime + 2000 });
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /being written/);
  assert.equal((await inspect(dataDir, 'example', { proc: fakeProc() })).broken, true);
  assert.equal((await release(dataDir, 'example', 'r-1')).released, false, 'an unreadable lock is never released');
  utimesSync(file, new Date(mtime - 60_000), new Date(mtime - 60_000));
  const later = await acquire(dataDir, 'example', { runId: 'r-2', holder: appA, proc: fakeProc(), now: () => mtime });
  assert.equal(later.ok, true);
  assert.equal(readLockFile(dataDir, 'example').runId, 'r-2');
});

test('listLocks lists every project lock and skips other files', async t => {
  const dataDir = temp(t);
  await acquire(dataDir, 'alpha', { runId: 'r-1', holder: appA, proc: fakeProc() });
  await acquire(dataDir, 'beta', { runId: 'r-2', holder: appA, proc: fakeProc() });
  writeFileSync(join(dataDir, 'runs', 'index.jsonl'), '');
  writeFileSync(join(dataDir, 'runs', 'Bad Name.lock'), '{}');
  writeFileSync(join(dataDir, 'runs', 'gamma.lock'), 'broken');
  const list = await listLocks(dataDir);
  assert.deepEqual(list.map(l => [l.project, l.lock && l.lock.runId, l.broken]).sort(),
    [['alpha', 'r-1', false], ['beta', 'r-2', false], ['gamma', null, true]]);
  assert.deepEqual(await listLocks(join(dataDir, 'none')), []);
});

test('bad run ids, holders and project names are refused', async t => {
  const dataDir = temp(t);
  assert.throws(() => acquire(dataDir, 'example', { runId: '../x', holder: appA }), /not a run id/);
  assert.throws(() => acquire(dataDir, 'example', { runId: 'r-1', holder: { pid: 'x' } }), /needs a pid/);
  assert.throws(() => acquire(dataDir, '../up', { runId: 'r-1', holder: appA }), /not a project name/);
  assert.throws(() => adopt(dataDir, 'example', 'r-1', { pid: 1, image: 'node.exe' }), /start time/);
});

test('a lock held by a process that has really ended is replaced (real lookup)', { skip: process.platform !== 'win32' }, async t => {
  const dataDir = temp(t);
  const h = realProc.spawnLogged({ command: process.execPath, args: ['-e', ''] });
  const dead = h.record;
  await h.done;
  await acquire(dataDir, 'example', { runId: 'r-old', holder: dead, proc: fakeProc() });
  assert.equal((await inspect(dataDir, 'example')).holderAlive, false);
  const r = await acquire(dataDir, 'example', { runId: 'r-new', holder: realProc.selfRecord() });
  assert.equal(r.ok, true);
  assert.equal(r.replaced.runId, 'r-old');
});
