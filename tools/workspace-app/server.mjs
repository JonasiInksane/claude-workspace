// The workspace app: a small local web app that opens in its own Edge window.
//
// Usage:
//   node tools/workspace-app/server.mjs [--port 4317] [--no-open]
//
// - Listens on 127.0.0.1 only: port 4317, or a free one when that is taken or reserved by
//   Windows (Hyper-V/WSL excluded port ranges).
// - Opens an Edge app window (msedge --app=...) with a sign-in link that is valid while this app
//   runs; without Edge it opens the default browser. --no-open only prints the link.
// - Only one app runs per workspace: a second start opens another window on the running one.
// - Stops by itself a few minutes after the last app window closes (the page sends a heartbeat
//   every 15 s; sleep and hibernate don't count as idle time).
// - --log <file> also appends its messages to that file (start-app.ps1 runs it hidden and uses
//   %TEMP%\claude-workspace\app.log; a log over 1 MB is renamed to app.log.old first).
// - --root <dir> uses another workspace root, --idle <seconds> a shorter idle time (for tests),
//   --data-dir <dir> another private data folder (default %LOCALAPPDATA%\claude-workspace).
// - Never stops for idleness while the app reports work in progress (handler.isBusy(): a run
//   stage, a check or a click being applied). Runs that only wait for you don't count.
// - Runs: before it listens, the run engine starts and recovers what a previous app left behind
//   (runs/manager.mjs recover: leftover processes stopped, those runs marked interrupted, locks
//   kept or released). Before every exit (Ctrl+C, closing the console, idle, a crash) the engine
//   stops its runs: Claude and check processes tree-killed and their runs marked interrupted
//   (spike A11), for at most a few seconds.
// - --fake-claude [fixture] is for tests and UI work only (refused unless WS_APP_TEST=1): Claude
//   stages run test/fake-claude.mjs, which replays a recorded stream ("auto", the default, picks
//   the success fixture of each stage's schema).
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
// app.mjs and launch.mjs are imported further down, after --log is set up, so that even an
// error while loading them ends up in the log of a hidden run.

const DEFAULT_PORT = 4317;
const IDLE_AFTER_PING_MS = 5 * 60_000; // no heartbeat for 5 minutes: every window is closed
const IDLE_NEVER_OPENED_MS = 5 * 60_000; // nobody ever opened the window
const TICK_MS = 5000;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, open: true, root: '', idle: 0, log: '', dataDir: '', fakeClaude: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--fake-claude') {
      // An optional fixture name may follow; a word starting with -- is the next option.
      out.fakeClaude = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'auto';
      if (process.env.WS_APP_TEST !== '1') {
        console.error('workspace-app: --fake-claude is for tests and UI work only. Set WS_APP_TEST=1 to use it.');
        process.exit(1);
      }
    }
    else if (a === '--log') out.log = argv[++i] || '';
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--root') out.root = argv[++i] || '';
    else if (a === '--data-dir') out.dataDir = argv[++i] || '';
    else if (a === '--idle') out.idle = Number(argv[++i]) * 1000; // seconds; for tests
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node tools/workspace-app/server.mjs [--port 4317] [--no-open]');
      process.exit(0);
    } else {
      console.error(`workspace-app: unknown argument ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    console.error('workspace-app: --port must be a number between 0 and 65535');
    process.exit(1);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

// Hidden runs have no console: copy every message into the log file too.
if (opts.log) {
  try {
    mkdirSync(dirname(opts.log), { recursive: true });
    if (statSync(opts.log, { throwIfNoEntry: false })?.size > 1024 * 1024) renameSync(opts.log, `${opts.log}.old`);
  } catch { /* logging is best effort */ }
  const tee = original => (...parts) => {
    original(...parts);
    try { appendFileSync(opts.log, `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}\n`); } catch { /* ignore */ }
  };
  console.log = tee(console.log);
  console.error = tee(console.error);
}

// Set once they exist; exitApp() works at any point of the startup.
let engine = null; // the run manager (runs/wiring.mjs)
let server = null;
let exiting = null;
let stopEngine = async () => ({ skipped: true });
let removeStateFile = () => {};

// Every exit after startup comes here: the state file goes, the server stops taking requests,
// the run engine stops its runs (capped, so this can't hang), then the process exits. A second
// call returns the first one's promise.
function exitApp(reason, code = 0) {
  if (exiting) return exiting;
  // Whatever happens below, the process ends shortly after the engine's cap.
  setTimeout(() => process.exit(code), 12_000);
  exiting = (async () => {
    try { removeStateFile(); } catch { /* already gone */ }
    if (reason) console.log(`workspace-app: stopping (${reason})`);
    try { if (server) server.close(); } catch { /* not listening */ }
    if (engine) {
      const r = await stopEngine(engine);
      if (r.timedOut) console.error('workspace-app: the run engine did not stop in time; leftover processes are cleaned up at the next start.');
      else if (r.error) console.error(`workspace-app: stopping the runs failed: ${r.error}`);
      else if (r.interrupted && r.interrupted.length) console.log(`workspace-app: ${r.interrupted.length} running run(s) marked interrupted.`);
    }
    process.exit(code);
  })();
  return exiting;
}
const crash = e => { console.error(`workspace-app: crashed: ${(e && e.stack) || e}`); exitApp('crash', 1); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
// SIGINT: Ctrl+C. SIGBREAK: Ctrl+Break. SIGHUP: the console window was closed (Windows).
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGTERM']) process.on(sig, () => exitApp(sig));

let createApp, realActions, recoverySummary;
try {
  ({ createApp } = await import('./app.mjs'));
  ({ realActions } = await import('./launch.mjs'));
  ({ stopEngine, recoverySummary } = await import('./runs/wiring.mjs'));
} catch (e) {
  console.error(`workspace-app: could not load the app code: ${(e && e.stack) || e}`);
  process.exit(1);
}
const root = resolve(opts.root || join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const stateDir = join(tmpdir(), 'claude-workspace');
const rootTag = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8);
const stateFile = join(stateDir, `app-${rootTag}.json`);
const actions = realActions({ root });
const wait = ms => new Promise(r => setTimeout(r, ms));

const linkFor = (port, token) => `http://127.0.0.1:${port}/?t=${token}`;

async function openWindow(url) {
  if (!opts.open) return;
  try {
    await actions.openWindow({ url });
  } catch (e) {
    console.error(`workspace-app: could not open a window (${e.message}). Open this link yourself: ${url}`);
  }
}

// Is an app for THIS workspace answering on `port`?
async function oursOn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json();
    return body.app === 'claude-workspace-app' && body.workspace === rootTag;
  } catch { return false; }
}

// A running app for this workspace? Then open a window on it and report true.
async function reuseRunning() {
  let saved;
  try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return false; }
  if (!(await oursOn(saved.port))) return false;
  const url = linkFor(saved.port, saved.token);
  console.log(`The workspace app is already running: ${url}`);
  await openWindow(url);
  return true;
}

function listen(server, port) {
  return new Promise((resolveP, reject) => {
    const onError = e => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolveP(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

if (await reuseRunning()) process.exit(0);

const token = randomBytes(24).toString('base64url');
let port = 0;
let lastPing = 0;
const started = Date.now();
const app = createApp({
  root, token, actions, workspaceTag: rootTag, getPort: () => port, onPing: () => { lastPing = Date.now(); },
  ...(opts.dataDir ? { dataDir: resolve(opts.dataDir) } : {}),
  ...(opts.fakeClaude ? { engineOptions: { fakeClaude: { fixture: opts.fakeClaude } } } : {}),
});

// The run engine starts and cleans up after a previous app before any request can arrive. If it
// can't start, the rest of the app still works and the runs routes say why.
try {
  engine = await app.getEngine();
  const line = recoverySummary(await engine.recover());
  if (line) console.log(`workspace-app: ${line}`);
  if (opts.fakeClaude) console.log(`workspace-app: Claude stages use the fake Claude (fixture ${opts.fakeClaude}).`);
} catch (e) {
  console.error(`workspace-app: the run engine could not start, so runs are not available: ${(e && e.message) || e}`);
}
server = createServer(app);

try {
  port = await listen(server, opts.port);
} catch (e) {
  if (opts.port === 0 || (e.code !== 'EADDRINUSE' && e.code !== 'EACCES')) {
    console.error(`workspace-app: could not listen on 127.0.0.1:${opts.port} (${e.code || e.message})`);
    await exitApp('', 1);
  }
  // Another start of this workspace's app may be just coming up: give it a moment.
  if (e.code === 'EADDRINUSE' && (await oursOn(opts.port))) {
    for (let i = 0; i < 10; i++) {
      if (await reuseRunning()) await exitApp('', 0);
      await wait(300);
    }
  }
  console.log(`workspace-app: port ${opts.port} is ${e.code === 'EACCES' ? 'reserved by Windows' : 'in use'}; using a free port.`);
  port = await listen(server, 0);
}

mkdirSync(stateDir, { recursive: true });
writeFileSync(stateFile, JSON.stringify({ port, token, pid: process.pid, root }), 'utf8');
removeStateFile = () => {
  try {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (saved.pid === process.pid) unlinkSync(stateFile);
  } catch { /* already gone */ }
};
const shutdown = reason => exitApp(reason);

const idleAfterPing = opts.idle || IDLE_AFTER_PING_MS;
const idleNeverOpened = opts.idle || IDLE_NEVER_OPENED_MS;
const tick = Math.min(TICK_MS, Math.max(250, idleAfterPing / 4));
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  // A long gap between ticks means the PC slept: don't count that as idle time.
  if (now - lastTick > tick * 6 && lastPing) lastPing = now;
  lastTick = now;
  // Work in progress counts as activity: the idle time starts again once it is done.
  if (app.isBusy()) { lastPing = now; return; }
  if (lastPing && now - lastPing > idleAfterPing) shutdown('no app window open');
  if (!lastPing && now - started > idleNeverOpened) shutdown('the window was never opened');
}, tick).unref();

const url = linkFor(port, token);
console.log(`Workspace app running at http://127.0.0.1:${port}/ (workspace ${root})`);
console.log(`Sign-in link (valid while this app runs): ${url}`);
await openWindow(url);
