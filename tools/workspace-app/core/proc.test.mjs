// Tests for core/proc.mjs with real child processes (`node -e ...`, never claude): spawning with
// logs, capture, timeouts, process lookups through powershell.exe, the guarded kill (R19) and the
// orphan scan. Every child exits by itself within a minute, so a failed test leaves nothing
// behind for long. Lookups need Windows; those tests are skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  KILLABLE_IMAGES, ORPHAN_IMAGES, START_TOLERANCE_MS, findOrphans, imageName, lineHasForm, listProcesses, matchRecord, needleForms, procInfo,
  procInfoMany, processState, runCapture, safeKill, sameProcess, selfRecord, spawnLogged, startRecord, treeKill,
} from './proc.mjs';

const onWindows = process.platform === 'win32';
const winOnly = { skip: !onWindows && 'process lookups need Windows' };
const node = process.execPath;
// A child that idles, then ends by itself after 60 s.
const IDLE = 'setTimeout(() => {}, 60000)';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-proc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(fn, ms = 10_000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, step));
  }
}

// Starts an idle node child and makes sure it is gone after the test.
function idleChild(t, extraArgs = []) {
  const h = spawnLogged({ command: node, args: ['-e', IDLE, ...extraArgs] });
  t.after(async () => { if (h.pid) await treeKill(h.pid); });
  return h;
}

// ---------- pure helpers

test('imageName gives the program file name as Windows lists it', () => {
  assert.equal(imageName('C:\\Program Files\\nodejs\\node.exe'), 'node.exe');
  assert.equal(imageName('/c/x/claude.exe'), 'claude.exe');
  assert.equal(imageName('git'), onWindows ? 'git.exe' : 'git');
  assert.equal(imageName(''), '');
});

test('matchRecord needs the same pid, program name (any case) and a start time within 2 s', () => {
  const rec = { pid: 10, image: 'claude.exe', startedAt: 50_000 };
  const info = { alive: true, pid: 10, image: 'Claude.EXE', startedAt: 50_000 + START_TOLERANCE_MS };
  assert.equal(matchRecord(rec, info), true);
  assert.equal(matchRecord(rec, { ...info, startedAt: 50_000 + START_TOLERANCE_MS + 1 }), false, 'a later start: the pid was reused');
  assert.equal(matchRecord(rec, { ...info, startedAt: 50_000 - START_TOLERANCE_MS - 1 }), false);
  assert.equal(matchRecord(rec, { ...info, image: 'node.exe' }), false);
  assert.equal(matchRecord(rec, { ...info, pid: 11 }), false);
  assert.equal(matchRecord(rec, { alive: false }), false);
  assert.equal(matchRecord(rec, { ...info, alive: null }), false);
  assert.equal(matchRecord({ ...rec, startedAt: undefined }, info), false);
  assert.equal(matchRecord(null, info), false);
});

test('needleForms lists the spellings a path has in a command line, lowercased', () => {
  const forms = needleForms('C:\\Users\\U\\AppData\\Local\\claude-workspace\\runs\\example\\r-1\\tmp');
  assert.ok(forms.includes('c:\\users\\u\\appdata\\local\\claude-workspace\\runs\\example\\r-1\\tmp'));
  assert.ok(forms.includes('c:/users/u/appdata/local/claude-workspace/runs/example/r-1/tmp'));
  assert.ok(forms.includes('/c/users/u/appdata/local/claude-workspace/runs/example/r-1/tmp'), 'the Git Bash form');
  assert.deepEqual(needleForms('261022-104212-explain'), ['261022-104212-explain']);
  assert.deepEqual(needleForms('abc'), [], 'short needles are ignored so nothing matches everything');
  assert.deepEqual(needleForms(''), []);
  assert.deepEqual(needleForms(null), []);
});

test('lineHasForm matches a needle only as a whole name, never a sibling folder or run that shares its prefix', () => {
  const tree = 'c:\\dev\\tg-run';
  assert.equal(lineHasForm('"c:\\program files\\nodejs\\node.exe" c:\\dev\\tg-run\\node_modules\\x.js', tree), true);
  assert.equal(lineHasForm('bash -c "cd c:\\dev\\tg-run && npm test"', tree), true, 'followed by a space');
  assert.equal(lineHasForm('node c:\\dev\\tg-run', tree), true, 'at the end of the line');
  assert.equal(lineHasForm('bash -c "cd c:\\dev\\tg-run;ls"', tree), true, 'followed by a shell operator');
  assert.equal(lineHasForm("node 'c:\\dev\\tg-run'", tree), true, 'followed by a quote');
  assert.equal(lineHasForm('node c:\\dev\\tg-run-old\\server.js', tree), false, 'a sibling folder with a longer name');
  assert.equal(lineHasForm('node c:\\dev\\tg-run2\\server.js', tree), false);
  assert.equal(lineHasForm('node c:\\dev\\tg-run.bak\\server.js', tree), false);
  assert.equal(lineHasForm('node c:\\dev\\tg-run-old\\a.js c:\\dev\\tg-run\\b.js', tree), true, 'a later whole match still counts');
  const id = '261022-104212-refactor-saletab';
  assert.equal(lineHasForm(`node x\\runs\\example\\${id}\\tmp\\01-scope\\a.js`, id), true);
  assert.equal(lineHasForm(`node x\\runs\\example\\${id}-2\\tmp\\a.js`, id), false, 'the run id never matches its "-2" sibling');
  assert.equal(lineHasForm('node c:\\dev\\tg-run\\apps', 'c:\\dev\\'), true, 'a form that ends with a separator is whole already');
  assert.equal(lineHasForm('anything', ''), false);
});

test('findOrphans with only short or empty needles looks nothing up and finds nothing', async () => {
  assert.deepEqual(await findOrphans({ needles: ['', 'a', '   x '] }), { orphans: [], error: '' });
  assert.deepEqual(await findOrphans(), { orphans: [], error: '' });
});

// ---------- spawning

test('spawnLogged refuses .cmd and .bat files, a missing program and non-string arguments', () => {
  assert.throws(() => spawnLogged({ command: 'C:\\nodejs\\npm.cmd', args: ['ci'] }), /\.cmd or \.bat file/);
  assert.throws(() => spawnLogged({ command: 'C:\\x\\setup.BAT' }), /\.cmd or \.bat file/);
  assert.throws(() => runCapture({ command: 'tool.cmd' }), /\.cmd or \.bat file/);
  assert.throws(() => spawnLogged({ args: [] }), /program to start is required/);
  assert.throws(() => spawnLogged({ command: node, args: ['-e', 1] }), /list of strings/);
  assert.throws(() => runCapture({ command: node, args: '-v' }), /list of strings/);
});

test('spawnLogged writes stdout and stderr to their files and sends stdin as UTF-8', async t => {
  const dir = temp(t);
  const out = join(dir, 'logs', 'events.jsonl');
  const err = join(dir, 'logs', 'stderr.log');
  const script = "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);" +
    "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({got:d})+'\\n');process.stderr.write('warned\\n');process.exit(3);})";
  const h = spawnLogged({ command: node, args: ['-e', script], stdinText: 'héllo ✓ prompt', stdoutFile: out, stderrFile: err, cwd: dir });
  assert.ok(Number.isInteger(h.pid) && h.pid > 0);
  assert.equal(h.record.pid, h.pid);
  assert.equal(h.record.image, imageName(node));
  const r = await h.done;
  assert.equal(r.code, 3);
  assert.equal(r.error, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.cancelled, false);
  assert.ok(r.durationMs >= 0 && r.endedAt >= r.startedAt);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { got: 'héllo ✓ prompt' });
  assert.equal(readFileSync(err, 'utf8'), 'warned\n');
});

test('spawnLogged can write both streams to one combined log, and appends', async t => {
  const dir = temp(t);
  const log = join(dir, 'check.log');
  for (let i = 0; i < 2; i++) {
    const h = spawnLogged({ command: node, args: ['-e', `console.log('out${i}');console.error('err${i}')`], stdoutFile: log, stderrFile: log });
    await h.done;
  }
  const text = readFileSync(log, 'utf8');
  for (const s of ['out0', 'err0', 'out1', 'err1']) assert.ok(text.includes(s), s);
});

test('spawnLogged with a signal that is already aborted starts nothing', async () => {
  const c = new AbortController();
  c.abort();
  const h = spawnLogged({ command: node, args: ['-e', IDLE], signal: c.signal });
  assert.equal(h.child, null);
  assert.equal(h.pid, null);
  assert.equal(h.record, null);
  const r = await h.done;
  assert.equal(r.cancelled, true);
  assert.equal(r.code, null);
});

test('spawnLogged reports a program that cannot start instead of throwing later', async t => {
  const dir = temp(t);
  const h = spawnLogged({ command: join(dir, 'no-such-program.exe'), args: [] });
  const r = await h.done;
  assert.equal(r.code, null);
  assert.match(r.error.message, /Could not start no-such-program\.exe/);
  assert.equal(h.record, null);
});

test('a timeout stops the process tree and is reported', async t => {
  const h = spawnLogged({ command: node, args: ['-e', IDLE], timeoutMs: 300 });
  t.after(() => treeKill(h.pid));
  const started = Date.now();
  const r = await h.done;
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 10_000);
});

test('aborting the signal stops a running process and is reported as cancelled', async t => {
  const c = new AbortController();
  const h = spawnLogged({ command: node, args: ['-e', IDLE], signal: c.signal });
  t.after(() => treeKill(h.pid));
  setTimeout(() => c.abort(), 200);
  const r = await h.done;
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
});

test('runCapture collects output, caps it, and never rejects', async t => {
  const r = await runCapture({ command: node, args: ['-e', "process.stdout.write('é'.repeat(3));process.stderr.write('E');process.exit(2)"] });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, 'ééé');
  assert.equal(r.stderr, 'E');
  assert.equal(r.truncated, false);
  const big = await runCapture({ command: node, args: ['-e', "process.stdout.write('x'.repeat(50000))"], maxBytes: 100 });
  assert.equal(big.stdout.length, 100);
  assert.equal(big.truncated, true);
  const echo = await runCapture({ command: node, args: ['-e', "process.stdin.pipe(process.stdout)"], stdinText: 'piped ✓' });
  assert.equal(echo.stdout, 'piped ✓');
  const slow = await runCapture({ command: node, args: ['-e', IDLE], timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  const dir = temp(t);
  const missing = await runCapture({ command: join(dir, 'missing.exe') });
  assert.match(missing.error.message, /Could not start missing\.exe/);
  const c = new AbortController();
  c.abort();
  const pre = await runCapture({ command: node, args: ['-e', IDLE], signal: c.signal });
  assert.equal(pre.cancelled, true);
});

test('startRecord reports the spawn time, not the time it was asked', async t => {
  const h = idleChild(t);
  await new Promise(r => setTimeout(r, 300));
  const rec = startRecord(h.child);
  assert.deepEqual(rec, h.record);
  assert.ok(Date.now() - rec.startedAt >= 250);
});

// ---------- lookups and the guarded kill (R19)

test('procInfo matches a spawned child: alive, image, start time, command line and parent', winOnly, async t => {
  const marker = `proc-info-${randomBytes(4).toString('hex')}`;
  const h = idleChild(t, [marker]);
  const info = await procInfo(h.pid);
  assert.equal(info.alive, true);
  assert.equal(info.pid, h.pid);
  assert.equal(info.image.toLowerCase(), 'node.exe');
  assert.ok(Math.abs(info.startedAt - h.record.startedAt) <= START_TOLERANCE_MS, `start ${info.startedAt} vs ${h.record.startedAt}`);
  assert.ok(info.commandLine.includes(marker));
  assert.equal(info.parentPid, process.pid);
  assert.equal(await sameProcess(h.record), true);
  assert.equal(await processState(h.record), 'same');
  assert.deepEqual(await procInfo(0), { alive: false });
  assert.deepEqual(await procInfo(999_999_996), { alive: false });
});

test('selfRecord describes this process the way a lookup sees it', winOnly, async () => {
  const self = selfRecord();
  assert.equal(self.pid, process.pid);
  assert.equal(await sameProcess(self), true);
});

test('procInfoMany looks up several pids in one go', winOnly, async t => {
  const a = idleChild(t);
  const b = idleChild(t);
  // A lookup that takes longer than its 10 s (PowerShell starting on a PC busy with the whole
  // suite) answers alive: null, "unknown"; that is the designed answer, so it is asked once more.
  const ask = () => procInfoMany([a.pid, b.pid, a.pid, 999_999_996, -1]);
  let m = await ask();
  if (m.get(a.pid).alive === null) m = await ask();
  assert.deepEqual([...m.keys()].sort(), [a.pid, b.pid, 999_999_996].sort());
  assert.equal(m.get(a.pid).alive, true);
  assert.equal(m.get(b.pid).alive, true);
  assert.equal(m.get(999_999_996).alive, false);
  const all = await listProcesses();
  assert.equal(all.error, '');
  assert.ok(all.rows.some(r => r.pid === process.pid));
});

test('safeKill stops a process whose record matches, and sameProcess is false afterwards', winOnly, async t => {
  const h = idleChild(t);
  assert.equal(await sameProcess(h.record), true);
  const r = await safeKill(h.record);
  assert.deepEqual(r, { killed: true, gone: false, reason: '' });
  await h.done;
  assert.equal(await sameProcess(h.record), false);
  assert.equal(await processState(h.record), 'gone');
  const again = await safeKill(h.record);
  assert.equal(again.killed, false);
  assert.equal(again.gone, true);
});

test('safeKill leaves a process alone when its start time differs: the pid was reused (R19)', winOnly, async t => {
  const h = idleChild(t);
  const reused = { ...h.record, startedAt: h.record.startedAt - 60_000 };
  const r = await safeKill(reused);
  assert.equal(r.killed, false);
  assert.match(r.reason, /now a different program/);
  assert.equal((await procInfo(h.pid)).alive, true, 'still running');
  assert.equal(await sameProcess(reused), false);
});

test('safeKill leaves a process alone when the program name differs (R19)', winOnly, async t => {
  const h = idleChild(t);
  const r = await safeKill({ ...h.record, image: 'claude.exe' });
  assert.equal(r.killed, false);
  assert.equal((await procInfo(h.pid)).alive, true);
});

test('safeKill refuses programs outside the allowed list and the app itself, without killing', winOnly, async t => {
  const h = idleChild(t);
  const notAllowed = await safeKill({ ...h.record, image: 'explorer.exe' });
  assert.equal(notAllowed.killed, false);
  assert.match(notAllowed.reason, /explorer\.exe is not a program the app may stop/);
  const narrow = await safeKill(h.record, ['claude.exe']);
  assert.match(narrow.reason, /not a program the app may stop/);
  assert.equal((await procInfo(h.pid)).alive, true);
  const self = await safeKill(selfRecord());
  assert.equal(self.killed, false);
  assert.match(self.reason, /does not stop itself/);
  assert.deepEqual(KILLABLE_IMAGES, ['claude.exe', 'node.exe']);
  assert.equal((await safeKill(null)).killed, false);
});

test('safeKill with a failed lookup leaves the process running', async () => {
  const r = await safeKill({ pid: 4242, image: 'node.exe', startedAt: 1 }, KILLABLE_IMAGES, { info: { alive: null, error: 'lookup failed' } });
  assert.equal(r.killed, false);
  assert.equal(r.gone, false);
  assert.match(r.reason, /Could not check process 4242, so it was left running/);
});

test('treeKill stops a process and its children; a missing pid is not an error', winOnly, async t => {
  const dir = temp(t);
  const out = join(dir, 'pid.txt');
  const script = "const {spawn}=require('child_process');" +
    "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',windowsHide:true});" +
    "require('fs').writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>{},60000)";
  const h = spawnLogged({ command: node, args: ['-e', script, out] });
  t.after(() => treeKill(h.pid));
  const childPid = Number(await waitFor(() => existsSync(out) && readFileSync(out, 'utf8')));
  t.after(() => treeKill(childPid));
  assert.equal((await procInfo(childPid)).alive, true);
  const r = await treeKill(h.pid);
  assert.equal(r.ok, true);
  await h.done;
  await waitFor(async () => (await procInfo(childPid)).alive === false);
  assert.deepEqual(await treeKill(999_999_996), { ok: true, gone: true, code: 128, message: '' });
  assert.equal((await treeKill(-5)).ok, false);
});

// ---------- the orphan scan

test('findOrphans finds a leftover whose parent is gone and tells it from a child with a live parent', winOnly, async t => {
  const dir = temp(t);
  const needle = `C:\\ws-orphan-test\\${randomBytes(6).toString('hex')}\\tmp`;
  const out = join(dir, 'orphan.txt');
  // A starts B detached (as Git Bash outlives claude.exe) and exits at once.
  const script = "const {spawn}=require('child_process');" +
    "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)',process.argv[2]],{detached:true,stdio:'ignore',windowsHide:true});" +
    "c.unref();require('fs').writeFileSync(process.argv[1],String(c.pid))";
  const a = spawnLogged({ command: node, args: ['-e', script, out, needle] });
  await a.done;
  const orphanPid = Number(await waitFor(() => existsSync(out) && readFileSync(out, 'utf8')));
  t.after(() => treeKill(orphanPid));
  const live = idleChild(t, [needle.replace(/\\/g, '/')]); // same needle, forward slashes, parent alive (us)
  const sibling = idleChild(t, [`${needle}-old\\x.js`]); // a folder that only shares the prefix

  const { orphans, error } = await findOrphans({ needles: [needle, 'abc'] });
  assert.equal(error, '');
  const left = orphans.find(o => o.pid === orphanPid);
  const kid = orphans.find(o => o.pid === live.pid);
  assert.ok(left, 'the leftover was found');
  assert.equal(left.parentAlive, false);
  assert.equal(left.killable, true);
  assert.equal(left.needle, needle);
  assert.ok(Math.abs(left.startedAt - Date.now()) < 120_000);
  assert.ok(kid, 'the live child was found');
  assert.equal(kid.parentAlive, true);
  assert.ok(!orphans.some(o => o.pid === process.pid), 'the app itself is never listed');
  assert.ok(!orphans.some(o => o.pid === sibling.pid), 'a process under <needle>-old is not listed');

  const narrow = await findOrphans({ needles: [needle], images: ['claude.exe'] });
  assert.equal(narrow.orphans.find(o => o.pid === orphanPid).killable, false, 'only allowed programs are killable');

  const r = await safeKill(left, ORPHAN_IMAGES, { info: left });
  assert.equal(r.killed, true);
  await waitFor(async () => (await procInfo(orphanPid)).alive === false);
});
