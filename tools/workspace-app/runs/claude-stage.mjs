// Runs one headless Claude stage: spawn `claude -p`, follow its stream-json output, enforce the
// caps, and turn the end of the run into a stage result (result.json) for the executor.
//
// Steps (SPEC WP9, with the spike corrections):
//   1. Write prompt.md (and settings.json / guard.json when the caller passes them).
//   2. Spawn claudeCommand with the argv from argv.mjs, cwd = spec.cwd, a scrubbed env (claudeEnv),
//      stdout into events.jsonl and stderr into stderr.log, through core/proc.mjs.
//   3. The prompt goes to stdin as UTF-8 and stdin is closed (A1). It is never in argv (R26).
//   4. events.jsonl is read every 250 ms through the normalizer; rows go to onRow one at a time.
//   5. The first init event is checked (checkInit). On a mismatch the process is killed and no
//      later row is passed on, so no tool row is ever accepted (R12).
//   6. Caps: the live turn count (1 + user tool_result/text events) may not pass maxTurns + 2
//      (--max-turns is the real cap); a wall clock on a 5 s tick that skips gaps over 30 s
//      (sleep); a result followed by 30 s of nothing ends the process (A10); `signal` cancels.
//   7. The last result decides. A success without a valid structured_output gets ONE automatic
//      resume asking for it (A15); if that fails too, the stage fails. Output paths are checked
//      against the tree and the ones outside it or missing are listed in paths.unknown.
//   8. result.json and proc.json are written.
// Status mapping: success -> done; error_max_turns, the turn cap and the time cap -> capped;
// error_max_budget_usd -> capped ("budget backstop"); a usage limit -> paused-limit; a login
// problem, an init mismatch or a missing/invalid result -> failed; cancel -> cancelled (also
// between a process and its automatic resume). The caps and the result's own turn and budget
// subtypes are checked before any usage-limit or login sign; a cap that fires after the result
// arrived doesn't throw that result away.
//
// A kill goes to our own live child through proc.treeKill. While the child hasn't exited, Node
// holds its process handle, so Windows can't reuse the pid; the image and start-time check
// (sameProcess) is for pids read back from disk, which is recovery's job (core/proc.mjs).
// Invalid input (a bad spec, a missing settings file, an unknown schema) throws; everything that
// goes wrong at run time comes back as a stage result.
import { access, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, delimiter, join, posix, win32 } from 'node:path';
import { headlessArgs, resumeArgs, stdinFor } from './argv.mjs';
import { capStrings, validate } from './schema-check.mjs';
import { outputPaths, schemaFor } from './schemas.mjs';
import { checkInit, createNormalizer, expectedInitFor, isLoginProblem, isUsageLimit, resultErrorText, summarizeInit } from './stream-json.mjs';

// The variables Claude may see: the check runner's SYSTEM_VARS (gates/env.mjs), kept as a copy
// here so claudeEnv stays synchronous; claude-stage.test.mjs compares the two lists. Nothing
// else reaches Claude (R11): no npm, GitHub, cloud or ANTHROPIC names. The subscription login
// works with this env (spike A9).
export const CLAUDE_ENV_VARS = Object.freeze(['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);
export const RESUME_PROMPT = 'Return your result now by calling the StructuredOutput tool with the required schema.';
export const TIMING = Object.freeze({ tailMs: 250, tickMs: 5000, sleepGapMs: 30000, initMs: 120000, lingerMs: 30000, killWaitMs: 4000 });
export const DEFAULT_WALL_MS = 15 * 60 * 1000;
export const RESULT_TEXT_MAX = 4096;
export const STDERR_TAIL = 64 * 1024;
export const STAGE_DIR_RE = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-a(\d+))?$/;
const READ_CHUNK = 4 * 1024 * 1024;

// The scrubbed environment for claude: CLAUDE_ENV_VARS from `base` (names matched without case,
// as Windows does), the Git Bash path when known, the background-wait ceiling (A10), the stage's
// own TEMP/TMP (A9: Claude's Bash commands carry them, which tags orphans) and the shim folder
// first on PATH, so `tg-check` resolves.
export function claudeEnv({ shimDir = '', gitBash = '', tmpDir = '', base = process.env } = {}) {
  const lower = new Map(Object.entries(base || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const env = {};
  for (const name of CLAUDE_ENV_VARS) {
    const v = lower.get(name.toLowerCase());
    if (v !== undefined && v !== '') env[name] = String(v);
  }
  const bash = gitBash || lower.get('claude_code_git_bash_path') || '';
  if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = String(bash);
  env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
  if (tmpDir) {
    env.TEMP = tmpDir;
    env.TMP = tmpDir;
  }
  if (shimDir) env.PATH = env.PATH ? `${shimDir}${delimiter}${env.PATH}` : shimDir;
  return env;
}

// <runDir>\tmp\<stage folder name>, the stage's TEMP (A9).
export function stageTmpDir(runDir, stageDir) {
  return join(runDir, 'tmp', basename(stageDir));
}

// "05-implement-a2" -> { index: 5, id: 'implement', attempt: 2 }; attempt 1 without a suffix.
export function parseStageDir(stageDir) {
  const m = STAGE_DIR_RE.exec(basename(String(stageDir || '')));
  if (!m) return { index: null, id: basename(String(stageDir || '')), attempt: 1 };
  return { index: Number(m[1]), id: m[2], attempt: m[3] ? Number(m[3]) : 1 };
}

// One wall-clock tick: adds the time since the last tick unless the gap was longer than
// sleepGapMs (the PC slept). Returns the updated { last, counted }.
export function wallTick(w, now, sleepGapMs = TIMING.sleepGapMs) {
  const gap = now - w.last;
  return { last: now, counted: w.counted + (gap > 0 && gap <= sleepGapMs ? gap : 0) };
}

const isWinAbs = p => /^[A-Za-z]:[\\/]/.test(p);

// A path from Claude's output as a tree-relative posix path, or null when it leaves the tree.
export function inTreePath(p, tree) {
  const s = String(p ?? '').trim();
  if (!s) return null;
  if (isWinAbs(s) || s.startsWith('/') || s.startsWith('\\')) {
    const norm = x => (isWinAbs(x) ? win32.normalize(x).replace(/\\/g, '/') : posix.normalize(x.replace(/\\/g, '/')));
    const base = norm(tree).replace(/\/+$/, '');
    const full = norm(s);
    const lc = process.platform === 'win32' || isWinAbs(s);
    const [b, f] = lc ? [base.toLowerCase(), full.toLowerCase()] : [base, full];
    if (f === b) return '';
    return f.startsWith(`${b}/`) ? full.slice(base.length + 1) : null;
  }
  const rel = posix.normalize(s.replace(/\\/g, '/'));
  if (rel === '..' || rel.startsWith('../')) return null;
  return rel.replace(/^\.\//, '');
}

// Paths from the output that are outside the tree or don't exist in it.
export async function checkOutputPaths(paths, tree) {
  const unknown = [];
  const outside = [];
  for (const p of paths) {
    const rel = inTreePath(p, tree);
    if (rel === null) {
      outside.push(p);
      unknown.push(p);
      continue;
    }
    try { await access(join(tree, rel)); } catch { unknown.push(p); }
  }
  return { unknown, outside };
}

async function loadRedact() {
  try {
    const m = await import('../gates/secrets.mjs');
    if (typeof m.redact === 'function') return text => m.redact(text);
  } catch { /* reported below */ }
  throw new Error('gates/secrets.mjs is not available, so Claude output could not be redacted; the stage did not start.');
}

async function loadProc() {
  try {
    const m = await import('../core/proc.mjs');
    if (typeof m.spawnLogged === 'function' && typeof m.treeKill === 'function') return m;
  } catch { /* reported below */ }
  throw new Error('core/proc.mjs is not available, so the Claude stage could not start.');
}

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  for (let i = 0; ; i++) {
    try { return await rename(tmp, file); } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 50 * 2 ** i));
    }
  }
}

async function readTail(file, max) {
  try {
    const buf = await readFile(file);
    return buf.subarray(Math.max(0, buf.length - max)).toString('utf8');
  } catch { return ''; }
}

// Reads a growing file from where it left off and hands over complete lines (split on \n bytes,
// so a UTF-8 character is never cut in half).
function lineTail(file, onLine) {
  let pos = 0;
  let rest = Buffer.alloc(0);
  async function feed(chunk) {
    let data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let i;
    while ((i = data.indexOf(0x0a)) >= 0) {
      const line = data.subarray(0, i).toString('utf8');
      data = data.subarray(i + 1);
      await onLine(line);
    }
    rest = Buffer.from(data);
  }
  async function read() {
    let fh;
    try { fh = await open(file, 'r'); } catch { return; }
    try {
      for (;;) {
        const { size } = await fh.stat();
        if (size <= pos) break;
        const len = Math.min(size - pos, READ_CHUNK);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        await feed(buf.subarray(0, bytesRead));
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }
  async function flush() {
    if (!rest.length) return;
    const line = rest.toString('utf8');
    rest = Buffer.alloc(0);
    await onLine(line);
  }
  return { read, flush };
}

const WORK_EVENTS = new Set(['assistant', 'user', 'result']);

// Runs one claude process to its end. Returns what happened; classify() turns it into a status.
async function runProcess(ctx, args, stdinText, names) {
  const { spec, stageDir, env, claudeCommand, procApi, norm, emit, now, timing, caps, signal, expected, procLog } = ctx;
  const run = {
    args, events: names.events, exitCode: null, exitSignal: null, killedFor: '', startError: '',
    initCheck: null, result: null, procTurns: 0, cappedAt: 0, record: null, stderr: '', wallMs: 0,
    killedAfterResult: false, signalFrom: ctx.signalRows.length,
  };
  if (signal && signal.aborted) {
    run.killedFor = 'cancel';
    return run;
  }
  const eventsFile = join(stageDir, names.events);
  const stderrFile = join(stageDir, names.stderr);
  let spawned;
  try {
    spawned = await procApi.spawnLogged({
      command: claudeCommand[0], args: [...claudeCommand.slice(1), ...args], cwd: spec.cwd, env,
      stdinText, stdoutFile: eventsFile, stderrFile,
    });
  } catch (e) {
    run.startError = e && e.message ? e.message : String(e);
    return run;
  }
  if (!spawned || !spawned.child || !spawned.done) {
    run.startError = 'the process could not be created';
    return run;
  }
  const { child, pid } = spawned;
  let exited = false;
  let initSeen = false;
  let stopRows = false;
  let lastResultAt = null;
  let killTimer = null;
  let w = { last: now(), counted: 0 };

  const kill = reason => {
    if (run.killedFor) return;
    run.killedFor = reason;
    run.killedAfterResult = !!run.result;
    if (exited) return;
    if (pid) Promise.resolve().then(() => procApi.treeKill(pid)).catch(() => {});
    killTimer = setTimeout(() => { if (!exited) try { child.kill(); } catch { /* gone */ } }, timing.killWaitMs);
  };
  const onAbort = () => kill('cancel');
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  async function onLine(line) {
    if (stopRows) return;
    const inits = norm.state.inits;
    const rows = norm.push(line);
    if (norm.state.inits > inits) {
      initSeen = true;
      run.initCheck = checkInit(norm.state.init, expected);
      if (!run.initCheck.ok) {
        stopRows = true;
        await emit({ kind: 'error', msg: `Stopped before any work: ${run.initCheck.problems.join('; ')}.` });
        kill('init');
        return;
      }
    } else if (!initSeen && WORK_EVENTS.has(norm.state.lastType)) {
      stopRows = true;
      run.initCheck = { ok: false, problems: ['Claude did not report its setup before working'] };
      await emit({ kind: 'error', msg: `Stopped before any work: ${run.initCheck.problems[0]}.` });
      kill('init');
      return;
    }
    for (const r of rows) await emit(r);
    if (norm.state.lastType === 'result') {
      run.result = norm.state.result;
      lastResultAt = w.counted;
    }
    run.procTurns = norm.state.procTurns;
    if (initSeen && !run.killedFor && norm.state.procTurns > caps.maxTurns + 2) {
      run.cappedAt = norm.state.procTurns;
      kill('turns');
    }
  }

  const tail = lineTail(eventsFile, onLine);
  let pumping = null;
  const pump = () => {
    if (!pumping) pumping = tail.read().catch(() => {}).finally(() => { pumping = null; });
    return pumping;
  };
  const tailTimer = setInterval(pump, timing.tailMs);
  const tickTimer = setInterval(() => {
    w = wallTick(w, now(), timing.sleepGapMs);
    if (!initSeen && w.counted > timing.initMs) kill('no-init');
    if (ctx.wallUsed + w.counted > caps.wallMs) kill('wall');
    if (run.result && lastResultAt !== null && w.counted - lastResultAt > timing.lingerMs) kill('linger');
  }, timing.tickMs);

  run.record = await processRecord(procApi, spawned, claudeCommand[0], now);
  procLog.push({ ...(run.record || { pid: null }), args, events: names.events, startedIso: new Date(now()).toISOString() });
  await writeJson(join(stageDir, 'proc.json'), { version: 1, processes: procLog }).catch(() => {});
  // Only a process that really started is handed on: recovery and isBusy key on its pid.
  if (run.record) {
    try { await ctx.onProc?.(run.record, { event: 'start' }); } catch { /* the caller's problem */ }
  }

  const end = await Promise.resolve(spawned.done).catch(e => ({ code: null, signal: null, error: e }));
  exited = true;
  clearInterval(tailTimer);
  clearInterval(tickTimer);
  if (killTimer) clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (pumping) await pumping;
  await tail.read().catch(() => {});
  await tail.flush().catch(() => {});
  w = wallTick(w, now(), timing.sleepGapMs);
  run.wallMs = w.counted;
  run.exitCode = end && Number.isInteger(end.code) ? end.code : end && Number.isInteger(end.exitCode) ? end.exitCode : null;
  run.exitSignal = end ? end.signal ?? null : null;
  if (end && end.error && !run.startError && !initSeen) run.startError = end.error.message || String(end.error);
  run.stderr = await readTail(stderrFile, STDERR_TAIL);
  Object.assign(procLog[procLog.length - 1], { exitCode: run.exitCode, signal: run.exitSignal, killedFor: run.killedFor, endedIso: new Date(now()).toISOString() });
  await writeJson(join(stageDir, 'proc.json'), { version: 1, processes: procLog }).catch(() => {});
  if (run.record) {
    try { await ctx.onProc?.(run.record, { event: 'exit', exitCode: run.exitCode }); } catch { /* the caller's problem */ }
  }
  return run;
}

// The { pid, image, startedAt } record of a spawned claude: the one core/proc.mjs made at spawn
// time, else startRecord(child), else one built here. null when no process started (no pid).
async function processRecord(procApi, spawned, command, now) {
  if (!spawned || !Number.isInteger(spawned.pid) || spawned.pid <= 0) return null;
  if (spawned.record && spawned.record.pid === spawned.pid) return { ...spawned.record };
  try {
    const rec = typeof procApi.startRecord === 'function' ? await procApi.startRecord(spawned.child) : null;
    if (rec && rec.pid === spawned.pid) return rec;
  } catch { /* fall through */ }
  return { pid: spawned.pid, image: basename(String(command)), startedAt: now() };
}

const firstLine = s => String(s || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
const minutes = ms => {
  const n = Math.round(ms / 60000);
  return `${n} minute${n === 1 ? '' : 's'}`;
};
const seconds = ms => {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
};

// The status of one finished process. `retry` marks the cases that get the automatic resume.
// The definite ends come first (our own kills, then the result's turn and budget subtypes), so
// a retried 429 or a word in stderr can't turn a capped stage into a usage limit or a login
// problem. A turn or time cap that fired after Claude had already reported only ended a
// lingering process (A10): the result decides, as it does after the linger kill.
function classify(run, ctx) {
  const r = run.result;
  const out = { subtype: r ? r.subtype ?? null : null, isError: r ? !!r.is_error : true, output: null, outputErrors: [], retry: false };
  const said = text => ctx.redact(text).slice(0, 400);
  const capKill = (run.killedFor === 'turns' || run.killedFor === 'wall') && !run.killedAfterResult;
  if (run.killedFor === 'cancel') return { ...out, status: 'cancelled', reason: 'Cancelled.' };
  if (run.startError) return { ...out, status: 'failed', reason: said(`Claude could not start: ${run.startError}`) };
  if (run.killedFor === 'init') return { ...out, status: 'failed', reason: `Stopped before any work: ${run.initCheck.problems.join('; ')}.` };
  if (run.killedFor === 'no-init') return { ...out, status: 'failed', reason: `Claude did not report its setup within ${seconds(ctx.timing.initMs)}.` };
  if (capKill && run.killedFor === 'turns') {
    return { ...out, status: 'capped', reason: `Stopped at the app's turn cap: ${run.cappedAt || run.procTurns} turns, with --max-turns ${ctx.spec.maxTurns}.` };
  }
  if (capKill) return { ...out, status: 'capped', reason: `Stopped at the time cap of ${ctx.caps.wallMs >= 60000 ? minutes(ctx.caps.wallMs) : seconds(ctx.caps.wallMs)}.` };
  if (r && r.subtype === 'error_max_turns') return { ...out, status: 'capped', reason: `Stopped at the turn limit (--max-turns ${ctx.spec.maxTurns}).` };
  if (r && r.subtype === 'error_max_budget_usd') return { ...out, status: 'capped', reason: 'Stopped by the budget backstop (--max-budget-usd).' };
  if (isUsageLimit(r, ctx.signalRows.slice(run.signalFrom), { stderr: run.stderr, rateLimit: ctx.norm.state.rateLimit })) {
    return { ...out, status: 'paused-limit', reason: 'Claude\'s usage limit was reached; resume the stage later.' };
  }
  if (isLoginProblem(r, run.stderr)) return { ...out, status: 'failed', reason: 'Claude login needed: run claude in a terminal' };
  if (!r) {
    const why = firstLine(run.stderr);
    return { ...out, status: 'failed', reason: said(`Claude stopped without a result (exit ${run.exitCode ?? 'unknown'})${why ? `: ${why}` : '.'}`) };
  }
  if (r.subtype !== 'success' || r.is_error) {
    return { ...out, status: 'failed', reason: said(`Claude ended with an error: ${firstLine(resultErrorText(r)) || r.subtype || 'no details'}`) };
  }
  if (r.structured_output === undefined || r.structured_output === null) {
    return { ...out, status: 'failed', reason: 'Claude returned no structured result', retry: true };
  }
  const errors = validate(ctx.schema, r.structured_output);
  if (errors.length) {
    return { ...out, status: 'failed', reason: `Claude's structured result does not match ${ctx.schemaLabel}: ${errors.slice(0, 3).join('; ')}`, outputErrors: errors, retry: true };
  }
  return { ...out, status: 'done', reason: '', output: capStrings(r.structured_output, ctx.schema) };
}

function resumePrompt(outcome) {
  if (!outcome.outputErrors.length) return RESUME_PROMPT;
  return `${RESUME_PROMPT}\nThe last result was rejected for these reasons:\n${outcome.outputErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}`;
}

// What the init event must show: derived from the spec (expectedInitFor), with the caller's
// expectedInit on top. A caller that leaves a key out (the executor passes no addDirs) still
// gets it checked against the spec, so an --add-dir folder is never reported as unexpected.
export function expectedFor(spec, expectedInit) {
  const out = expectedInitFor(spec);
  for (const [k, v] of Object.entries(expectedInit || {})) if (v !== undefined) out[k] = v;
  return out;
}

async function prepare({ stageDir, prompt, spec, settings, guard, env }) {
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, 'prompt.md'), prompt, 'utf8');
  if (settings) await writeJson(spec.settingsFile, settings);
  if (guard) await writeJson(join(stageDir, 'guard.json'), guard);
  try { await access(spec.settingsFile); } catch {
    throw new Error(`The stage settings file is missing: ${spec.settingsFile}`);
  }
  if (env && env.TEMP) await mkdir(env.TEMP, { recursive: true });
}

// Runs a stage and returns its stageResult (also written to <stageDir>\result.json):
//   { version, stage, attempt, status, reason, subtype, isError, sessionId, numTurns, turnsCounted,
//     durationMs, estUsd, denials: [{tool, input, id}], init: {model, permissionMode, tools, cwd,
//     ccVersion, check: 'ok' | 'mismatch' | 'missing' (no init seen), problems: [text]}, output,
//     outputErrors, paths: {unknown, outside}, resultText, exitCode, killedFor, autoResumed,
//     rateLimit, terminalReason, processes }
// onProc(record, { event: 'start' | 'exit', exitCode }) is called for each claude process.
// Options beyond the SPEC signature: settings and guard (objects written before the spawn),
// redact (defaults to gates/secrets.mjs), stage and attempt (default: from the folder name) and
// timing (test overrides of TIMING).
export async function runClaudeStage({
  spec, prompt, stageDir, env, claudeCommand, caps = {}, schemaName, expectedInit, onRow, onProc, signal,
  clock, proc, resumeSessionId, settings, guard, redact, stage, attempt, timing,
}) {
  if (!spec || typeof spec !== 'object') throw new Error('runClaudeStage needs a stage spec.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('The stage prompt is empty.');
  if (!Array.isArray(claudeCommand) || !claudeCommand.length || !claudeCommand.every(a => typeof a === 'string' && a)) {
    throw new Error('claudeCommand must be a list such as [path to claude.exe].');
  }
  if (typeof stageDir !== 'string' || !stageDir) throw new Error('runClaudeStage needs the stage folder.');
  const schema = spec.schema || (schemaName ? schemaFor(schemaName) : null);
  const fullSpec = { ...spec, schema };
  const firstArgs = resumeSessionId ? resumeArgs(fullSpec, resumeSessionId) : headlessArgs(fullSpec);
  const now = clock && typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
  const startedAt = now();
  const redactFn = typeof redact === 'function' ? redact : await loadRedact();
  const procApi = proc || await loadProc();
  const where = parseStageDir(stageDir);
  const stageEnv = env || claudeEnv({});
  await prepare({ stageDir, prompt, spec: fullSpec, settings, guard, env: stageEnv });

  const norm = createNormalizer({ stage: stage || where.id, attempt: attempt || where.attempt, redact: redactFn, now });
  const signalRows = [];
  const ctx = {
    spec: fullSpec, stageDir, env: stageEnv, claudeCommand, procApi, norm, now, signal, onProc, redact: redactFn,
    timing: { ...TIMING, ...(timing || {}) },
    caps: { maxTurns: caps.maxTurns || fullSpec.maxTurns, wallMs: caps.wallMs || DEFAULT_WALL_MS },
    expected: expectedFor(fullSpec, expectedInit),
    schema, schemaLabel: schemaName || 'the output schema', signalRows, wallUsed: 0, procLog: [],
    emit: async r => {
      const full = r.t ? r : { t: new Date(now()).toISOString(), stage: stage || where.id, attempt: attempt || where.attempt, turn: norm.state.turns, ...r, msg: redactFn(String(r.msg || '')).slice(0, 300) };
      if (full.kind === 'error' || full.src === 'api_retry') signalRows.push(full);
      if (onRow) try { await onRow(full); } catch { /* a failed timeline write never stops the stage */ }
    },
  };

  const runs = [];
  let run = await runProcess(ctx, firstArgs, stdinFor(prompt, fullSpec.inputFormat), { events: 'events.jsonl', stderr: 'stderr.log' });
  runs.push(run);
  ctx.wallUsed += run.wallMs;
  let outcome = classify(run, ctx);
  let autoResumed = false;
  const sid = norm.state.sessionId || resumeSessionId || fullSpec.sessionId;
  if (outcome.retry && signal && signal.aborted) {
    // Cancelled between the process and its automatic resume: the cancel is what happened.
    outcome = { ...outcome, status: 'cancelled', reason: 'Cancelled.', retry: false };
  } else if (outcome.retry) {
    autoResumed = true;
    await ctx.emit({ kind: 'info', msg: `${outcome.reason}; asking Claude once more to return it.` });
    run = await runProcess(ctx, resumeArgs(fullSpec, sid), stdinFor(resumePrompt(outcome), fullSpec.inputFormat), { events: 'events-resume.jsonl', stderr: 'stderr-resume.log' });
    runs.push(run);
    ctx.wallUsed += run.wallMs;
    outcome = classify(run, ctx);
    if (outcome.retry) outcome.reason = `${outcome.reason}, even after one reminder`;
  }
  // The init check already wrote its own "Stopped before any work" row.
  if (outcome.status !== 'done' && outcome.status !== 'cancelled' && outcome.reason && run.killedFor !== 'init') {
    await ctx.emit({ kind: 'error', msg: outcome.reason });
  }

  const results = runs.map(x => x.result).filter(Boolean);
  const sum = key => (results.length ? results.reduce((n, x) => n + (Number.isFinite(x[key]) ? x[key] : 0), 0) : null);
  const last = run.result;
  const paths = outcome.status === 'done' && schemaName
    ? await checkOutputPaths(outputPaths(schemaName, outcome.output), fullSpec.cwd)
    : { unknown: [], outside: [] };
  // A failed init check of either process is the one to report.
  const checked = runs.find(x => x.initCheck && !x.initCheck.ok) || runs.find(x => x.initCheck);
  const initCheck = checked ? checked.initCheck : null;
  const resultText = last ? String(typeof last.result === 'string' ? last.result : resultErrorText(last)) : '';
  const stageResult = {
    version: 1,
    stage: stage || where.id,
    attempt: attempt || where.attempt,
    status: outcome.status,
    reason: outcome.reason,
    subtype: outcome.subtype,
    isError: outcome.isError,
    sessionId: sid,
    numTurns: sum('num_turns'),
    turnsCounted: norm.state.turns,
    durationMs: now() - startedAt,
    estUsd: sum('total_cost_usd'),
    denials: norm.state.denials.map(d => ({ ...d })),
    init: {
      ...summarizeInit(norm.state.init),
      check: initCheck ? (initCheck.ok ? 'ok' : 'mismatch') : 'missing',
      problems: initCheck ? [...initCheck.problems] : [],
    },
    output: outcome.output,
    outputErrors: outcome.outputErrors,
    paths,
    resultText: redactFn(resultText.slice(0, RESULT_TEXT_MAX * 2)).slice(0, RESULT_TEXT_MAX),
    exitCode: run.exitCode,
    killedFor: run.killedFor,
    autoResumed,
    rateLimit: norm.state.rateLimit,
    terminalReason: last ? last.terminal_reason ?? null : null,
    processes: runs.length,
  };
  await writeJson(join(stageDir, 'result.json'), stageResult);
  return stageResult;
}
