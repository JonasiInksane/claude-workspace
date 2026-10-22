// The real run engine for the app: the run manager (runs/manager.mjs) with the executor
// (runs/executor.mjs) and every real module behind it, built once per app by createEngine().
//
// app.mjs calls it lazily through ctx.getEngine(), so creating an app (and every route test)
// never starts an engine; server.mjs calls it at startup, runs manager.recover() before the
// server listens, and stopEngine() before every exit (spike A11: claude.exe dies with the app,
// but the shells and Node processes it started would live on).
//
// Where Claude comes from (claudeCommand, the program and its first arguments):
// - normally [actions.tools.claude]: the claude.exe the launcher found (PATH or
//   %USERPROFILE%\.local\bin; tools/lib/agents.mjs resolveClaude never returns a .cmd shim);
// - engineOptions.fakeClaude (tests and UI work only, refused unless WS_APP_TEST=1):
//   [node, test/fake-claude.mjs, --fixture <name>, ...], which replays a recorded stream;
// - engineOptions.claudeCommand: a list, or (tests only) a function (stageOptions) => list, so
//   an end-to-end test can give each stage its own fake output. The function is called with the
//   options runClaudeStage gets (stage, attempt, spec, schemaName, resumeSessionId, ...); its list
//   still goes through runClaudeStage's own checks.
// The launcher's startClaude and runTool (ctx.actions) become the executor's LAUNCH_DEPS, used
// for Take over and Save as report.
import { fileURLToPath } from 'node:url';
import { createManager } from './manager.mjs';
import { createExecutor, defaultDeps } from './executor.mjs';

export const FAKE_CLAUDE = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url));
// How long an exit waits for the engine to stop its runs before it gives up (A11).
export const STOP_CAP_MS = 8000;
const FIXTURE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_CLAUDE = 'Claude Code was not found (PATH or %USERPROFILE%\\.local\\bin), so Claude stages cannot run.';

// The fake claude command for tests and UI work. `fixture` is a fixture name from
// test/fixtures/stream ('auto' picks the success fixture of the stage's schema).
export function fakeClaudeCommand({ fixture = 'auto', delayMs = 30, env = process.env } = {}) {
  if (env.WS_APP_TEST !== '1') throw new Error('The fake Claude is for tests only; set WS_APP_TEST=1 to use it.');
  if (!FIXTURE_RE.test(String(fixture))) throw new Error(`"${String(fixture).slice(0, 40)}" is not a fixture name.`);
  return [process.execPath, FAKE_CLAUDE, '--fixture', String(fixture), '--delay-ms', String(Math.max(0, Number(delayMs) || 0))];
}

// The claudeCommand the executor gets: a list, or a function of the stage options.
export function claudeCommandFor({ actions = {}, engineOptions = {} } = {}) {
  if (engineOptions.fakeClaude) {
    const o = engineOptions.fakeClaude === true ? {} : engineOptions.fakeClaude;
    return fakeClaudeCommand(o);
  }
  const given = engineOptions.claudeCommand;
  if (typeof given === 'function') return given;
  if (Array.isArray(given) && given.length) return given.map(String);
  const exe = actions && actions.tools && actions.tools.claude;
  return typeof exe === 'string' && exe ? [exe] : null;
}

// The Claude stage module with the command filled in per stage: a function command is asked for
// each stage's list, and a missing claude.exe fails the stage with a plain sentence.
function claudeStageFor(claudeStage, command) {
  if (Array.isArray(command)) return claudeStage;
  return {
    ...claudeStage,
    async runClaudeStage(opts = {}) {
      if (!command) throw new Error(NO_CLAUDE);
      return claudeStage.runClaudeStage({ ...opts, claudeCommand: command(opts) });
    },
  };
}

// The launcher functions the executor needs (LAUNCH_DEPS), bound to `actions`.
function launchDeps(actions = {}) {
  const out = {};
  for (const name of ['startClaude', 'runTool']) {
    if (actions && typeof actions[name] === 'function') out[name] = actions[name].bind(actions);
  }
  return out;
}

// Builds the engine. Resolves to the manager (preview, start, action, cancel, recover, isBusy,
// signals, shutdown, settled, actionsFor, pipeline, ...).
// engineOptions: { fakeClaude, claudeCommand, limits: { claude, checks }, timing (Claude stage
// timer overrides, tests), deps (more overrides of defaultDeps, tests) }.
export async function createEngine({ root, dataDir, actions = {}, engineOptions = {} } = {}) {
  if (!root) throw new Error('createEngine needs the workspace root.');
  if (!dataDir) throw new Error('createEngine needs the data folder (dataDir).');
  const opts = engineOptions || {};
  const command = claudeCommandFor({ actions, engineOptions: opts });
  const deps = await defaultDeps({ hubRoot: root, dataDir, ...launchDeps(actions), ...(opts.deps || {}) });
  deps.claudeStage = claudeStageFor(deps.claudeStage, command);
  if (Array.isArray(command)) deps.claudeCommand = command;
  if (opts.timing) deps.timing = opts.timing;
  return createManager({ root, dataDir, deps: { ...deps, createExecutor }, limits: opts.limits || {} });
}

// Stops the engine before the app exits: manager.shutdown() (stage aborts, tree kills, runs
// marked interrupted), but never longer than `capMs`, so an exit can't hang. Resolves to the
// shutdown report, or { timedOut: true } / { error } when it did not finish.
export async function stopEngine(manager, { capMs = STOP_CAP_MS } = {}) {
  if (!manager || typeof manager.shutdown !== 'function') return { skipped: true };
  let timer;
  const cap = new Promise(r => { timer = setTimeout(() => r({ timedOut: true }), capMs); });
  try {
    return await Promise.race([Promise.resolve().then(() => manager.shutdown()).catch(err => ({ error: err.message || String(err) })), cap]);
  } finally {
    clearTimeout(timer);
  }
}

// One short line about a recovery report, for the server log ('' when nothing happened).
export function recoverySummary(report = {}) {
  const n = k => (Array.isArray(report[k]) ? report[k].length : 0);
  const parts = [];
  if (n('interrupted')) parts.push(`${n('interrupted')} interrupted`);
  if (n('killed')) parts.push(`${n('killed')} leftover process${n('killed') === 1 ? '' : 'es'} stopped`);
  if (n('adopted')) parts.push(`${n('adopted')} lock${n('adopted') === 1 ? '' : 's'} kept`);
  if (n('released')) parts.push(`${n('released')} lock${n('released') === 1 ? '' : 's'} released`);
  if (n('skipped')) parts.push(`${n('skipped')} left to another app`);
  if (n('errors')) parts.push(`${n('errors')} problem${n('errors') === 1 ? '' : 's'}: ${report.errors[0]}`);
  return parts.length ? `runs recovered: ${parts.join(', ')}` : '';
}
