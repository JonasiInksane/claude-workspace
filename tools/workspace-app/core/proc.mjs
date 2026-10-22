// Child processes for the run engine: spawning with logs, capturing output, and stopping process
// trees safely on Windows.
//
// Why this exists: Windows reuses process ids quickly, and Claude's Git Bash children outlive the
// app when it exits (spike A11). So the engine never kills a bare pid. It keeps a record
// { pid, image, startedAt } from spawn time, and before any kill it looks the pid up again
// (Get-CimInstance Win32_Process through powershell.exe) and checks that the program name and the
// start time still match (`sameProcess`). Only then does `taskkill /T /F` stop the whole tree.
//
// - spawnLogged: stdout and stderr go straight to files (the child writes them itself, so a busy
//   app loses nothing); optional stdin text is written as UTF-8 and then closed; a timeout or an
//   AbortSignal stops the tree.
// - runCapture: the same, with the output collected in memory (capped).
// - procInfo / procInfoMany / listProcesses: one powershell.exe call each (about 0.5 s).
// - safeKill: the guarded kill. findOrphans: processes whose command line names one of our run
//   paths and whose parent is gone (the cwd is not visible in Win32_Process, spike A11).
//
// Every spawn uses an argument array and windowsHide. Nothing here uses a shell, and .cmd/.bat
// files are refused, because cmd.exe re-parses their arguments.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export const KILLABLE_IMAGES = ['claude.exe', 'node.exe'];
// Programs an orphan scan may stop: Claude, Node, and the Git Bash shells Claude's Bash tool runs.
export const ORPHAN_IMAGES = ['claude.exe', 'node.exe', 'bash.exe', 'sh.exe'];
export const START_TOLERANCE_MS = 2000;
const PROC_INFO_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 20_000;
const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const PIDS_PER_QUERY = 40;
const MIN_NEEDLE = 6;

const isWindows = process.platform === 'win32';
const systemRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';

// System programs by absolute path, so a folder early on PATH can't stand in for them.
function systemExe(...parts) {
  const full = join(systemRoot(), ...parts);
  return existsSync(full) ? full : parts[parts.length - 1];
}
const taskkillExe = () => systemExe('System32', 'taskkill.exe');
const powershellExe = () => systemExe('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Spawn times by child, so startRecord() reports the moment of spawn even when called later.
const spawnTimes = new WeakMap();

// The file name of a program as Windows lists it: "node.exe", "claude.exe" ("git" -> "git.exe").
export function imageName(command) {
  const name = basename(String(command || ''));
  return isWindows && name && !extname(name) ? `${name}.exe` : name;
}

function checkCommand(command, args) {
  if (typeof command !== 'string' || !command) throw new Error('A program to start is required.');
  if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error(`${basename(command)} is a .cmd or .bat file; the app never starts those (cmd.exe re-parses their arguments).`);
  }
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('Program arguments must be a list of strings.');
}

const validPid = pid => Number.isInteger(pid) && pid > 0;
const alive = child => child.exitCode === null && child.signalCode === null;

// Stops a child this module started. The handle is still open, so the pid can't have been reused.
function stopOwnChild(child) {
  if (!child.pid || !alive(child)) return;
  if (isWindows) treeKill(child.pid).catch(() => {});
  else { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Timeout and AbortSignal handling shared by spawnLogged and runCapture. Returns the flags object
// and a cleanup function.
function watchChild(child, { timeoutMs, signal }) {
  const state = { timedOut: false, cancelled: false };
  let timer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => { state.timedOut = true; stopOwnChild(child); }, timeoutMs);
    timer.unref?.();
  }
  const onAbort = () => { state.cancelled = true; stopOwnChild(child); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return { state, cleanup };
}

function openLog(file) {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'a');
}

function writeStdin(child, stdinText) {
  if (stdinText === undefined || stdinText === null || !child.stdin) return;
  child.stdin.on('error', () => {}); // the child may exit before reading everything (EPIPE)
  child.stdin.end(String(stdinText), 'utf8');
}

const cancelledBeforeStart = () => {
  const now = Date.now();
  return { code: null, signal: null, error: null, timedOut: false, cancelled: true, startedAt: now, endedAt: now, durationMs: 0 };
};

// Starts a program with stdout and stderr going to files.
// - stdoutFile and stderrFile may be the same file (one combined log); either may be left out.
//   Files are opened for appending, and their folders are created.
// - stdinText is written as UTF-8 and stdin is then closed; without it stdin is empty.
// - timeoutMs and signal stop the whole process tree.
// Returns { child, pid, record, done }. `done` never rejects; it resolves to
// { code, signal (the exit signal name), error, timedOut, cancelled, startedAt, endedAt, durationMs }.
// When the `signal` option is already aborted nothing starts: child and pid are null and done
// reports cancelled. On a program that can't start, done reports `error` and a null code.
export function spawnLogged({ command, args = [], cwd, env, stdinText, stdoutFile, stderrFile, timeoutMs, signal } = {}) {
  checkCommand(command, args);
  if (signal?.aborted) return { child: null, pid: null, record: null, done: Promise.resolve(cancelledBeforeStart()) };
  const fds = [];
  const open = file => { const fd = openLog(file); fds.push(fd); return fd; };
  let child;
  try {
    const outFd = stdoutFile ? open(stdoutFile) : 'ignore';
    const errFd = stderrFile ? (stderrFile === stdoutFile ? outFd : open(stderrFile)) : 'ignore';
    const stdinMode = stdinText === undefined || stdinText === null ? 'ignore' : 'pipe';
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: [stdinMode, outFd, errFd] });
  } finally {
    // The child has its own copies of the handles; ours can close at once.
    for (const fd of fds) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  const startedAt = Date.now();
  spawnTimes.set(child, startedAt);
  writeStdin(child, stdinText);
  const { state, cleanup } = watchChild(child, { timeoutMs, signal });
  const done = new Promise(resolveP => {
    let error = null;
    child.once('error', err => {
      error = new Error(`Could not start ${basename(command)}: ${err.message}`);
      if (!child.pid) finish(null, null); // it never started, so no exit event follows
    });
    child.once('exit', (code, exitSignal) => finish(code, exitSignal));
    function finish(code, exitSignal) {
      cleanup();
      const endedAt = Date.now();
      resolveP({ code, signal: exitSignal, error, ...state, startedAt, endedAt, durationMs: endedAt - startedAt });
    }
  });
  return { child, pid: child.pid ?? null, record: child.pid ? startRecord(child) : null, done };
}

// Runs a program and collects its output in memory (each stream capped at maxBytes).
// Resolves to { code, stdout, stderr, truncated, error, timedOut, cancelled, durationMs }; never
// rejects.
export function runCapture({ command, args = [], cwd, env, stdinText, timeoutMs, signal, maxBytes = CAPTURE_MAX_BYTES } = {}) {
  checkCommand(command, args);
  if (signal?.aborted) return Promise.resolve({ ...cancelledBeforeStart(), stdout: '', stderr: '', truncated: false });
  const stdinMode = stdinText === undefined || stdinText === null ? 'ignore' : 'pipe';
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: [stdinMode, 'pipe', 'pipe'] });
  const startedAt = Date.now();
  spawnTimes.set(child, startedAt);
  writeStdin(child, stdinText);
  const { state, cleanup } = watchChild(child, { timeoutMs, signal });
  const out = { stdout: [], stderr: [], size: { stdout: 0, stderr: 0 }, truncated: false };
  const collect = name => chunk => {
    const room = maxBytes - out.size[name];
    if (room <= 0) { out.truncated = true; return; }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) out.truncated = true;
    out[name].push(part);
    out.size[name] += part.length;
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  return new Promise(resolveP => {
    let error = null;
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = name => Buffer.concat(out[name]).toString('utf8');
      resolveP({ code, stdout: text('stdout'), stderr: text('stderr'), truncated: out.truncated, error, ...state, durationMs: Date.now() - startedAt });
    };
    child.once('error', err => {
      error = new Error(`Could not start ${basename(command)}: ${err.message}`);
      if (!child.pid) finish(null);
    });
    // 'close' waits for both pipes to drain, so no output is lost.
    child.once('close', code => finish(code));
  });
}

// Stops a process and all its children: taskkill /T /F /PID. A process that is already gone is
// not an error. Resolves to { ok, gone, code, message }; never rejects. This is the raw kill:
// callers outside this module go through safeKill, which checks the record first.
export async function treeKill(pid) {
  if (!validPid(pid)) return { ok: false, gone: false, code: null, message: `${pid} is not a process id.` };
  if (!isWindows) {
    try { process.kill(pid, 'SIGKILL'); return { ok: true, gone: false, code: 0, message: '' }; } catch (err) {
      return err.code === 'ESRCH' ? { ok: true, gone: true, code: 0, message: '' } : { ok: false, gone: false, code: null, message: err.message };
    }
  }
  const r = await runCapture({ command: taskkillExe(), args: ['/T', '/F', '/PID', String(pid)], timeoutMs: 15_000 });
  // 128: "The process ... not found." It ended on its own, which is what we wanted.
  if (r.code === 128) return { ok: true, gone: true, code: 128, message: '' };
  const message = (r.error && r.error.message) || `${r.stdout}${r.stderr}`.trim();
  return { ok: r.code === 0, gone: false, code: r.code, message: r.code === 0 ? '' : message || `taskkill exited with ${r.code}.` };
}

// powershell.exe -EncodedCommand takes the script as base64 UTF-16LE, so no quoting can break.
const encodePs = script => Buffer.from(script, 'utf16le').toString('base64');

function cimScript(filter) {
  const where = filter ? ` -Filter "${filter}"` : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    `$rows = @(Get-CimInstance Win32_Process${where} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,` +
      "@{n='Start';e={ if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }})",
    'ConvertTo-Json -InputObject $rows -Compress -Depth 2',
  ].join('\n');
}

function toInfo(row) {
  const exe = row.ExecutablePath || '';
  return {
    alive: true,
    pid: row.ProcessId,
    image: exe ? basename(exe) : String(row.Name || ''),
    startedAt: Number(row.Start) || 0,
    commandLine: row.CommandLine || '',
    parentPid: row.ParentProcessId ?? null,
  };
}

// One Win32_Process query. Resolves to { rows, error }: rows are procInfo objects.
async function cimQuery(filter, timeoutMs) {
  if (!isWindows) return { rows: [], error: 'Process lookups work on Windows only.' };
  const r = await runCapture({
    command: powershellExe(),
    // No -ExecutionPolicy: it doesn't apply to -EncodedCommand, and with it the line looks like
    // malware to virus scanners.
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(cimScript(filter))],
    timeoutMs,
  });
  if (r.timedOut) return { rows: [], error: `The process lookup took longer than ${Math.round(timeoutMs / 1000)} s.` };
  if (r.error || r.code !== 0) {
    const detail = (r.error && r.error.message) || r.stderr.replace(/#< CLIXML[\s\S]*$/, '').trim() || `exit code ${r.code}`;
    return { rows: [], error: `The process lookup failed: ${detail}` };
  }
  try {
    const parsed = JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim() || '[]');
    return { rows: (Array.isArray(parsed) ? parsed : [parsed]).map(toInfo), error: '' };
  } catch (err) {
    return { rows: [], error: `The process lookup returned unreadable output: ${err.message}` };
  }
}

// What Windows knows about one pid: { alive: true, pid, image, startedAt, commandLine, parentPid },
// { alive: false } when no such process exists, or { alive: null, error } when the lookup itself
// failed (then nobody may assume the process is gone or that it is ours).
export async function procInfo(pid) {
  if (!validPid(pid)) return { alive: false };
  const { rows, error } = await cimQuery(`ProcessId=${pid}`, PROC_INFO_TIMEOUT_MS);
  if (error) return { alive: null, error };
  return rows[0] || { alive: false };
}

// procInfo for many pids with one powershell.exe call per 40 pids (SPEC A25). Returns a Map from
// pid to the same objects procInfo gives.
export async function procInfoMany(pids) {
  const unique = [...new Set(pids)].filter(validPid);
  const out = new Map();
  for (let i = 0; i < unique.length; i += PIDS_PER_QUERY) {
    const chunk = unique.slice(i, i + PIDS_PER_QUERY);
    const { rows, error } = await cimQuery(chunk.map(p => `ProcessId=${p}`).join(' OR '), PROC_INFO_TIMEOUT_MS);
    for (const pid of chunk) out.set(pid, error ? { alive: null, error } : rows.find(r => r.pid === pid) || { alive: false });
  }
  return out;
}

// Every process on the machine, for the orphan scan. Resolves to { rows, error }.
export function listProcesses() {
  return cimQuery('', LIST_TIMEOUT_MS);
}

// The record kept for a child at spawn time: { pid, image, startedAt }.
export function startRecord(child) {
  return { pid: child.pid, image: imageName(child.spawnfile), startedAt: spawnTimes.get(child) ?? Date.now() };
}

// The record of the running app itself (the lock holder).
export function selfRecord() {
  return { pid: process.pid, image: imageName(process.execPath), startedAt: Math.round(performance.timeOrigin) };
}

// True when `info` (from procInfo) is the process `rec` describes: alive, the same program name
// (case-insensitive) and a start time within 2 s.
export function matchRecord(rec, info) {
  if (!rec || !info || info.alive !== true || !validPid(rec.pid) || info.pid !== rec.pid) return false;
  if (String(info.image).toLowerCase() !== String(rec.image || '').toLowerCase()) return false;
  return Number.isFinite(rec.startedAt) && Math.abs(info.startedAt - rec.startedAt) <= START_TOLERANCE_MS;
}

// 'same' (the recorded process still runs), 'gone' (it ended, or its pid now belongs to another
// program) or 'unknown' (the lookup failed). `info` can be passed when it was already fetched.
export async function processState(rec, { info } = {}) {
  if (!rec || !validPid(rec.pid)) return 'gone';
  const found = info || await procInfo(rec.pid);
  if (found.alive === null || found.alive === undefined) return 'unknown';
  return matchRecord(rec, found) ? 'same' : 'gone';
}

// True only when the recorded process is still the same running program.
export async function sameProcess(rec, opts) {
  return (await processState(rec, opts)) === 'same';
}

const lowerImages = images => new Set(images.map(i => String(i).toLowerCase()));

// The only kill other modules use. It refuses records of programs outside `images`, the app's own
// process, and any pid that is gone or now belongs to another program; then it stops the tree.
// Resolves to { killed, gone, reason }. `info` (from procInfoMany) saves a lookup.
export async function safeKill(rec, images = KILLABLE_IMAGES, { info } = {}) {
  if (!rec || !validPid(rec.pid)) return { killed: false, gone: false, reason: 'There is no process record to stop.' };
  if (rec.pid === process.pid) return { killed: false, gone: false, reason: 'The app does not stop itself.' };
  if (!lowerImages(images).has(String(rec.image || '').toLowerCase())) {
    return { killed: false, gone: false, reason: `${rec.image || 'That program'} is not a program the app may stop.` };
  }
  const found = info || await procInfo(rec.pid);
  if (found.alive === null || found.alive === undefined) {
    return { killed: false, gone: false, reason: `Could not check process ${rec.pid}, so it was left running: ${found.error || 'no answer'}` };
  }
  if (found.alive === false) return { killed: false, gone: true, reason: `Process ${rec.pid} has already ended.` };
  if (!matchRecord(rec, found)) {
    return { killed: false, gone: true, reason: `Process ${rec.pid} is now a different program (${found.image}); it was left alone.` };
  }
  const r = await treeKill(rec.pid);
  if (r.ok) return { killed: !r.gone, gone: r.gone, reason: r.gone ? `Process ${rec.pid} ended on its own.` : '' };
  return { killed: false, gone: false, reason: `Could not stop process ${rec.pid}: ${r.message}` };
}

// The spellings a path can have in a command line: as given, with forward slashes, with
// backslashes, and the Git Bash form (/c/Users/...). Lowercased, since Windows paths ignore case.
export function needleForms(needle) {
  const s = String(needle || '').trim().toLowerCase();
  if (s.length < MIN_NEEDLE) return [];
  const forms = new Set([s, s.replace(/\\/g, '/'), s.replace(/\//g, '\\')]);
  const m = s.replace(/\\/g, '/').match(/^([a-z]):(\/.*)$/);
  if (m) forms.add(`/${m[1]}${m[2]}`);
  return [...forms];
}

// What may follow a needle in a command line: the end, a path separator, a quote, a space or a
// shell operator. More name characters mean another folder or run (tg-run-old, <run id>-2).
const NEEDLE_END_RE = /[\\/"'\s;&|<>),]/;

// True when `form` (lowercase, from needleForms) occurs in `line` (lowercase) as a whole name,
// so C:\dev\tg-run matches C:\dev\tg-run\apps but not C:\dev\tg-run-old or C:\dev\tg-run2.
// A form that ends with a separator is whole already.
export function lineHasForm(line, form) {
  if (!form) return false;
  const whole = /[\\/]$/.test(form);
  for (let i = line.indexOf(form); i !== -1; i = line.indexOf(form, i + 1)) {
    const next = line[i + form.length];
    if (whole || next === undefined || NEEDLE_END_RE.test(next)) return true;
  }
  return false;
}

// Processes whose command line contains one of `needles` (run folder paths, run ids, the run
// tree). Each comes back as { pid, image, startedAt, commandLine, parentPid, parentAlive,
// killable, needle }:
// - parentAlive is false when the parent pid is gone or now belongs to a process started after
//   this one (a reused pid), which is what makes it an orphan;
// - killable is true when its program is in `images`.
// A needle counts only as a whole name (lineHasForm), so a sibling folder or run that shares
// its prefix never matches. Nothing is stopped here. Needles shorter than 6 characters are
// ignored, so a stray empty value can never match every process. Resolves to { orphans, error }.
export async function findOrphans({ needles = [], images = ORPHAN_IMAGES } = {}) {
  const forms = needles.flatMap(n => needleForms(n).map(f => ({ form: f, needle: n })));
  if (!forms.length) return { orphans: [], error: '' };
  const { rows, error } = await listProcesses();
  if (error) return { orphans: [], error };
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const allowed = lowerImages(images);
  const orphans = [];
  for (const p of rows) {
    if (p.pid === process.pid || !p.commandLine) continue;
    const line = p.commandLine.toLowerCase();
    const hit = forms.find(f => lineHasForm(line, f.form));
    if (!hit) continue;
    const parent = byPid.get(p.parentPid);
    const parentAlive = Boolean(parent && parent.startedAt <= p.startedAt + 1000);
    orphans.push({ ...p, parentAlive, killable: allowed.has(p.image.toLowerCase()), needle: hit.needle });
  }
  return { orphans, error: '' };
}
