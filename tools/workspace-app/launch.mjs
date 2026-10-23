// Starting things from the workspace app: Claude sessions, agent sessions, programs in a terminal
// tab, Explorer, the editor, the navigator and the app window itself. Command building is pure
// (tested in launch.test.mjs); `realActions` does the spawning. Nothing goes through a shell
// string: every program gets an argument list, and PowerShell gets its command base64-encoded
// (-EncodedCommand).
//
// Sessions: every interactive Claude session the app starts gets its own id (--session-id, a new
// UUID) unless it resumes one (--resume <id>), and a line in <dataDir>\sessions.jsonl:
//   {"at":"…","sessionId":"<uuid>","kind":"hub|project|agent|flow|skill|takeover","project":"…","title":"…",
//    "projectSettings":{"version":3,"sha256":"…"}}
// so the app can find a session again (Take over, Continue). -c (continue the last session) has
// no id of its own and adds no line.
//
// Project settings (project-settings.mjs): a session started in a project (Start Claude here, a
// skill or a flow there, an agent) gets the project's current settings, applied here once for
// every route: the rules as --append-system-prompt, the defaults for what its own launch leaves
// empty, the pre-approved tools added to its own. Its sessions.jsonl line records the version
// (projectSettings; null when the project has none). A session with rules or pre-approved tools
// always starts through a prompt file (tools/lib/prompt-file.mjs, needsPromptFile): the rules
// never go into the PowerShell command, claude-prompt.mjs or agent-session.mjs hand them to
// claude as an argument of their own spawn, and the tools go into the settings file they write.
// Hub sessions and takeovers (a run's stage, which has the rules of its run's version) get none
// and record none. A continued or resumed session keeps the system prompt it started with until
// it is compacted (Claude Code's --system-prompt-snapshot, on by default in 2.1.309).
import { existsSync, lstatSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveClaude } from '../lib/agents.mjs';
import { checkLaunch, launchArgs, writePromptFile } from '../lib/prompt-file.mjs';
import { appendJsonl, defaultDataDir, PROJECT_RE } from './core/datadir.mjs';
import { currentSettings, launchWithSettings, settingsRef } from './project-settings.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(appDir, '..');
const MAX_OUTPUT = 400 * 1024;
const TOOL_TIMEOUT_MS = 3 * 60_000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// A PowerShell single-quoted string: nothing inside is expanded. PowerShell also treats the
// typographic quotes U+2018-U+201B as single quotes, so those are doubled too.
export const psq = s => `'${String(s).replace(/['‘’‚‛]/g, '$&$&')}'`;

// wt.exe treats ";" as a command separator even inside quotes (same rule as start.ps1).
export const wtArg = s => String(s).replace(/;/g, '\\;');
// A trailing backslash would escape wt's closing quote; keep "C:\." for a drive root.
export function wtPath(dir) {
  let d = String(dir).replace(/\\+$/, '');
  if (d.endsWith(':')) d += '\\.';
  return wtArg(d);
}

export const encodePs = command => Buffer.from(command, 'utf16le').toString('base64');

// An environment variable name PowerShell can take after $env: without quoting.
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The PowerShell command a new terminal runs: go to the folder, set `env` ($env:NAME='value'),
// then run the program. Names are checked (they can't be quoted); values are literals.
export function psCommand(dir, program, args = [], env = {}) {
  const sets = Object.entries(env || {}).map(([name, value]) => {
    if (!ENV_NAME_RE.test(name)) throw new Error(`"${name}" is not an environment variable name`);
    return `$env:${name}=${psq(value)}`;
  });
  return [`Set-Location -LiteralPath ${psq(dir)}`, ...sets, `& ${[program, ...args].map(psq).join(' ')}`].join('; ');
}

export const SESSION_KINDS = ['hub', 'project', 'agent', 'flow', 'skill', 'takeover'];
// Take over (a run's stage continued in a terminal) resumes the stage's session in one of these.
export const TAKEOVER_MODES = ['acceptEdits', 'manual'];
// startAgent's kinds: an agent started from Projects, or a flow. A takeover goes through
// startClaude, which checks its mode (R5), so it can't start as an agent session instead.
export const AGENT_KINDS = ['agent', 'flow'];
export const sessionsFile = dataDir => join(dataDir, 'sessions.jsonl');

// Appends one line to sessions.jsonl (core/datadir.mjs appendJsonl: the folder is made on first
// use, and a torn last line can't swallow this one). Best effort: a session that started stays
// started even when the line can't be written. `projectSettings` ({ version, sha256 } or null)
// goes in only when given: sessions in a project have it, hub sessions and takeovers don't.
export async function recordSession(dataDir, { sessionId, kind, project = '', title = '', projectSettings }, now = new Date()) {
  const line = { at: now.toISOString(), sessionId, kind, project, title, ...(projectSettings !== undefined ? { projectSettings } : {}) };
  try {
    await appendJsonl(sessionsFile(dataDir), line);
  } catch (e) {
    console.error(`workspace-app: could not record session ${sessionId}: ${e.message}`);
  }
}

// The checked launch for an interactive Claude session, with its session id: the one to resume,
// the one given, or a new one (none for -c, which becomes launch.continueLast). Throws with a
// plain message on a bad value.
export function sessionLaunch({ launch = {}, resume, sessionId, continueLast = false } = {}) {
  const checked = checkLaunch({
    ...launch, ...(resume ? { resume } : {}), ...(sessionId ? { sessionId } : {}), ...(continueLast ? { continueLast: true } : {}),
  });
  if (checked.error) throw new Error(`launch: ${checked.error}`);
  const l = checked.launch;
  if (!l.continueLast && !l.resume && !l.sessionId) l.sessionId = randomUUID();
  return { launch: l, id: l.resume || l.sessionId || '' };
}

// A checked launch with a project's settings applied (project-settings.mjs launchWithSettings),
// checked again: the tools together may be too many, the rules too long. Throws with a plain
// message; without settings the launch comes back as it is.
export function withProjectSettings(launch, settings) {
  if (!settings) return launch;
  const checked = checkLaunch(launchWithSettings(launch, settings));
  if (checked.error) throw new Error(`launch: ${checked.error}`);
  return checked.launch;
}

// True when a Claude session can't start with its flags straight on claude's command line, so
// it starts through a prompt file (claude-prompt.mjs) instead: launchArgs has no flag for a first
// prompt, the rules (appendSystemPrompt), pre-approved tools (they go into a settings file) or
// readable folders, and the rules must never go into a PowerShell command anyway.
export function needsPromptFile({ prompt = '', readDirs = [], launch = {} } = {}) {
  const has = v => (Array.isArray(v) ? v.length > 0 : !!v);
  return has(prompt) || has(readDirs) || has(launch.appendSystemPrompt) || has(launch.allowedTools);
}

// Programs a terminal tab may not start directly: .cmd and .bat need cmd.exe (a shell).
const SHELL_SCRIPT = /\.(cmd|bat)$/i;
// runInTerminal starts only a full path to an .exe: with a bare name ("npm") PowerShell's `&`
// searches PATH and may run npm.ps1 or npm.cmd, and a relative path depends on the folder.
const EXE_PATH = /^[A-Za-z]:[\\/].*\.exe$/i;

// Checks runInTerminal's program and arguments; throws with a plain message. Windows PowerShell
// 5.1 builds the program's command line itself: it drops an empty argument, doesn't escape a '"'
// inside one, and lets the trailing backslash of an argument with a space (which it quotes) eat
// the closing quote. Such arguments would arrive changed, so they are refused.
export function checkTerminalProgram(program, args) {
  if (typeof program !== 'string' || !program) throw new Error('runInTerminal needs a program');
  if (SHELL_SCRIPT.test(program)) throw new Error(`${program} is a .cmd or .bat script; run it through node instead`);
  if (!EXE_PATH.test(program)) throw new Error(`${program} is not a full path to an .exe, for example C:\\Program Files\\nodejs\\node.exe`);
  let isFile = false;
  try { isFile = statSync(program).isFile(); } catch { /* reported below */ }
  if (!isFile) throw new Error(`${program} was not found`);
  if (!Array.isArray(args)) throw new Error('runInTerminal needs its arguments as a list');
  for (const a of args.map(String)) {
    if (!a) throw new Error('an argument is empty, and PowerShell 5.1 would drop it');
    if (a.includes('"')) throw new Error(`the argument ${a} has a double quote, which PowerShell 5.1 would pass on changed`);
    if (/\s/.test(a) && a.endsWith('\\')) throw new Error(`the argument ${a} has a space and ends with a backslash, which PowerShell 5.1 would pass on changed`);
  }
}

// How to open a terminal tab (Windows Terminal) or, without it, a new console window.
// Without wt, a short-lived hidden PowerShell runs Start-Process, which gives the real session
// its own console (a detached spawn would get no console at all and exit at once).
// `windowStyle` is only for tests (Hidden), so they don't open windows.
export function terminalCommand({ wt, dir, title, command, windowStyle }) {
  const ps = ['-NoExit', '-EncodedCommand', encodePs(command)];
  if (wt) {
    return { command: wt, args: ['-w', '0', 'nt', '-d', wtPath(dir), '--title', wtArg(title), 'powershell', ...ps], hidden: false };
  }
  const start = `Start-Process -FilePath 'powershell.exe' -WorkingDirectory ${psq(dir)} -ArgumentList ${ps.map(psq).join(',')}` +
    (windowStyle ? ` -WindowStyle ${windowStyle}` : '');
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(start)], hidden: true, wait: true };
}

// lstat, not existsSync: wt.exe in WindowsApps is an app execution alias, which stat() can't
// open (EACCES) although it runs fine.
function present(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function findOnPath(names, env = process.env) {
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) continue;
    for (const n of names) if (present(join(d, n))) return join(d, n);
  }
  return '';
}

const firstExisting = paths => paths.find(p => p && existsSync(p)) || '';

export function findTools(env = process.env) {
  const local = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vscode = firstExisting([join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), join(pf, 'Microsoft VS Code', 'Code.exe')]);
  const cursor = firstExisting([join(local, 'Programs', 'cursor', 'Cursor.exe'), join(pf, 'cursor', 'Cursor.exe')]);
  return {
    wt: findOnPath(['wt.exe'], env),
    claude: resolveClaude(env).path,
    edge: firstExisting([join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
    editor: vscode ? { name: 'VS Code', path: vscode } : cursor ? { name: 'Cursor', path: cursor } : null,
  };
}

// Starts a program. GUI programs run detached and visible: windowsHide would put SW_HIDE in
// their startup info, and a cold-started Edge window would then stay invisible. `hidden` is
// only for the short-lived PowerShell helper, which the caller waits for (`wait`).
export function run(command, args, { hidden = false, wait = false, verbatim = false } = {}) {
  return new Promise((resolveP, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: !wait, stdio: 'ignore', windowsHide: hidden, windowsVerbatimArguments: verbatim,
      });
    } catch (e) { reject(e); return; }
    child.once('error', reject);
    if (wait) {
      child.once('exit', code => (code === 0 ? resolveP() : reject(new Error(`${command} exited with code ${code}`))));
    } else {
      child.once('spawn', () => { child.unref(); resolveP(); });
    }
  });
}

// explorer.exe splits its command line on commas, so the path goes in quotes, verbatim.
// Windows paths can't contain '"', so quoting is safe.
export const explorerArgs = target => [`"${String(target).replace(/"/g, '')}"`];

// The real side effects. The app gets this object; tests pass a recorder with the same methods.
//   dataDir  the private data folder for sessions.jsonl (default %LOCALAPPDATA%\claude-workspace)
//   runner   starts a program (default run); tests pass a recorder so no window opens
export function realActions({ root, tools = findTools(), windowStyle, dataDir = defaultDataDir(), runner = run } = {}) {
  const node = process.execPath;
  const terminal = (dir, title, command) => {
    const t = terminalCommand({ wt: tools.wt, dir, title, command, windowStyle });
    return runner(t.command, t.args, { hidden: t.hidden, wait: t.wait });
  };
  const explorer = target => runner('explorer.exe', explorerArgs(target), { verbatim: true });
  const kindOf = (kind, fallback) => {
    const k = kind || fallback;
    if (!SESSION_KINDS.includes(k)) throw new Error(`unknown session kind "${k}"`);
    return k;
  };
  // The project's current settings for a session of this kind (project-settings.mjs), or
  // undefined where they don't apply: the hub, and a takeover, which continues a run's stage that
  // already has the rules of its run's version. null when the project has none, or has a folder
  // name the data folder keeps no settings for. Settings that can't be read stop the start.
  const settingsFor = async (kind, project) => {
    if (!project || kind === 'hub' || kind === 'takeover') return undefined;
    if (!PROJECT_RE.test(project)) return null;
    try { return await currentSettings(dataDir, project); } catch (e) {
      throw new Error(`the settings of ${project} could not be read, so nothing was started: ${e.message}`);
    }
  };
  const refOf = settings => (settings === undefined ? undefined : settingsRef(settings));
  return {
    tools,
    // Starts claude in a terminal tab at `dir` and resolves with { sessionId } ('' for -c).
    // With only flags, they go straight on claude's command line (--resume <id> or
    // --session-id <id>, --settings <file>, --permission-mode <m>, ...). With `prompt`, project
    // rules, pre-approved tools or `readDirs` (folders the session may read without asking),
    // everything goes through a prompt file (needsPromptFile; tools/lib/prompt-file.mjs explains
    // why). `kind` and `project` are for sessions.jsonl and the project's settings (see the top of
    // this file); without a kind, a resume counts as a takeover (the only resume the app starts),
    // so it gets the takeover mode check too.
    async startClaude({ dir, title, continueLast = false, prompt, readDirs = [], launch = {}, resume, sessionId, kind, project = '' }) {
      if (!tools.claude) throw new Error('Claude Code was not found (PATH or %USERPROFILE%\\.local\\bin).');
      const s = sessionLaunch({ launch, resume, sessionId, continueLast });
      const k = kindOf(kind, s.launch.resume ? 'takeover' : project ? 'project' : 'hub');
      // R5: a takeover runs in acceptEdits or manual mode only. It resumes the stage's session, or
      // (the fallback when a resume can't work) starts a new one from a prompt that sums it up.
      if (k === 'takeover' && !TAKEOVER_MODES.includes(s.launch.permissionMode)) {
        throw new Error(`a takeover runs in ${TAKEOVER_MODES.join(' or ')} mode`);
      }
      if (k === 'takeover' && !s.launch.resume && !prompt) {
        throw new Error("a takeover resumes the stage's session, or starts from a prompt that sums the stage up");
      }
      const settings = await settingsFor(k, project);
      const l = withProjectSettings(s.launch, settings);
      const command = needsPromptFile({ prompt, readDirs, launch: l })
        ? psCommand(dir, node, [join(appDir, 'claude-prompt.mjs'), writePromptFile({ prompt, readDirs, launch: l })])
        : psCommand(dir, tools.claude, launchArgs(l));
      await terminal(dir, title, command);
      if (s.id) await recordSession(dataDir, { sessionId: s.id, kind: k, project, title, projectSettings: refOf(settings) });
      return { sessionId: s.id };
    },
    // Any program in a terminal tab at `dir`, with `env` set for it first (the cockpit's dev
    // servers). `program` is a full path to an existing .exe; see checkTerminalProgram.
    runInTerminal({ dir, title, program, args = [], env = {} }) {
      checkTerminalProgram(program, args);
      return terminal(dir, title, psCommand(dir, program, args.map(String), env));
    },
    newProject({ project, type, from }) {
      const args = [join(toolsDir, 'new-project.mjs'), project, '--type', type, ...(from ? ['--from', from] : [])];
      return terminal(root, `New project: ${project}`, psCommand(root, node, args));
    },
    // tools/projects.mjs in a terminal, so git's progress and any GitHub sign-in are visible.
    cloneProject({ project, args }) {
      return terminal(root, `Clone: ${project}`, psCommand(root, node, [join(toolsDir, 'projects.mjs'), ...args]));
    },
    // Runs a workspace tool and collects its output (stdout and stderr together).
    runTool({ args, cwd, timeoutMs = TOOL_TIMEOUT_MS }) {
      return new Promise((resolveP, reject) => {
        const child = spawn(node, args, { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
        let output = '';
        const add = chunk => { if (output.length < MAX_OUTPUT) output += chunk; };
        child.stdout.setEncoding('utf8').on('data', add);
        child.stderr.setEncoding('utf8').on('data', add);
        // The whole tree: run-tests' own `node --test` child holds the output pipe open too.
        const stop = () => {
          if (process.platform !== 'win32') { child.kill(); return; }
          const kill = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
          kill.once('error', () => child.kill());
        };
        const timer = setTimeout(() => { add(`\n(stopped: it ran longer than ${Math.round(timeoutMs / 1000)} seconds)`); stop(); }, timeoutMs);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', code => {
          clearTimeout(timer);
          if (output.length >= MAX_OUTPUT) output += '\n(output cut off)';
          resolveP({ status: code ?? 1, output: output.replace(ANSI, '') });
        });
      });
    },
    // An isolated agent session (tools/agent-session.mjs) with a new session id, or the one it
    // resumes (launch.resume, only with a prompt: agent-session takes launch settings from the
    // prompt file). The launch is checked here, so a bad value is refused before a terminal opens.
    // The project's settings are applied as in startClaude; agent-session.mjs gets them, and any
    // other launch setting, through a prompt file (one without a first prompt when there is none).
    // Resolves with { sessionId }.
    async startAgent({ project, agent, title, prompt, readDirs = [], launch = {}, sessionId, kind }) {
      const k = kindOf(kind, 'agent');
      if (!AGENT_KINDS.includes(k)) throw new Error(`an agent session starts as ${AGENT_KINDS.join(' or ')}, not as ${k}; a takeover goes through startClaude`);
      const s = sessionLaunch({ launch, sessionId });
      if (s.launch.resume && !prompt) throw new Error('an agent session resumes only together with a prompt');
      if (s.launch.continueLast) throw new Error("an agent session starts new or resumes one by id; it can't continue the last session");
      const settings = await settingsFor(k, project);
      const { sessionId: newId, ...rest } = withProjectSettings(s.launch, settings);
      const args = [join(toolsDir, 'agent-session.mjs'), project, agent, '--root', root];
      if (newId) args.push('--session-id', newId);
      if (prompt || Object.keys(rest).length) args.push('--prompt-file', writePromptFile({ prompt, readDirs, launch: rest }));
      await terminal(root, title, psCommand(root, node, args));
      await recordSession(dataDir, { sessionId: s.id, kind: k, project, title, projectSettings: refOf(settings) });
      return { sessionId: s.id };
    },
    openFolder({ dir }) {
      return explorer(dir);
    },
    // A folder or a single file.
    openEditor({ path }) {
      if (!tools.editor) throw new Error('No editor found (VS Code or Cursor).');
      return run(tools.editor.path, [path]);
    },
    // Rebuilds index.html first (without blocking the server), then opens it.
    async openNavigator() {
      await new Promise(resolveP => {
        const child = spawn(node, [join(toolsDir, 'build-index.mjs'), '--quiet'], { stdio: 'ignore', windowsHide: true });
        child.once('error', resolveP);
        child.once('exit', resolveP);
      });
      return explorer(join(root, 'index.html'));
    },
    openWindow({ url }) {
      if (tools.edge) return run(tools.edge, [`--app=${url}`]);
      return explorer(url);
    },
  };
}
