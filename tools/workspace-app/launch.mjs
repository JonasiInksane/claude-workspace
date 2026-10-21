// Starting things from the workspace app: Claude sessions, agent sessions, Explorer, the editor,
// the navigator and the app window itself. Command building is pure (tested in launch.test.mjs);
// `realActions` does the spawning. Nothing goes through a shell string: every program gets an
// argument list, and PowerShell gets its command base64-encoded (-EncodedCommand).
import { existsSync, lstatSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveClaude } from '../lib/agents.mjs';
import { writePromptFile } from '../lib/prompt-file.mjs';

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

// The PowerShell command a new terminal runs: go to the folder, then run the program.
export function psCommand(dir, program, args = []) {
  return [`Set-Location -LiteralPath ${psq(dir)}`, `& ${[program, ...args].map(psq).join(' ')}`].join('; ');
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
export function realActions({ root, tools = findTools(), windowStyle } = {}) {
  const node = process.execPath;
  const terminal = (dir, title, command) => {
    const t = terminalCommand({ wt: tools.wt, dir, title, command, windowStyle });
    return run(t.command, t.args, { hidden: t.hidden, wait: t.wait });
  };
  const explorer = target => run('explorer.exe', explorerArgs(target), { verbatim: true });
  return {
    tools,
    // With `prompt`: it goes through a prompt file (tools/lib/prompt-file.mjs explains why), with
    // `readDirs` the session may read without asking.
    startClaude({ dir, title, continueLast, prompt, readDirs = [], launch = {} }) {
      if (!tools.claude) throw new Error('Claude Code was not found (PATH or %USERPROFILE%\\.local\\bin).');
      if (!prompt) return terminal(dir, title, psCommand(dir, tools.claude, continueLast ? ['-c'] : []));
      const file = writePromptFile({ prompt, readDirs, launch });
      return terminal(dir, title, psCommand(dir, node, [join(appDir, 'claude-prompt.mjs'), file]));
    },
    newProject({ project, type, from }) {
      const args = [join(toolsDir, 'new-project.mjs'), project, '--type', type, ...(from ? ['--from', from] : [])];
      return terminal(root, `New project: ${project}`, psCommand(root, node, args));
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
          if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
          else child.kill();
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
    startAgent({ project, agent, title, prompt, readDirs = [], launch = {} }) {
      const args = [join(toolsDir, 'agent-session.mjs'), project, agent, '--root', root];
      if (prompt) args.push('--prompt-file', writePromptFile({ prompt, readDirs, launch }));
      return terminal(root, title, psCommand(root, node, args));
    },
    openFolder({ dir }) {
      return explorer(dir);
    },
    // A folder or a single file.
    openEditor({ path }) {
      if (!tools.editor) throw new Error('No editor found (VS Code or Cursor).');
      return run(tools.editor.path, [path]);
    },
    openNavigator() {
      spawnSync(node, [join(toolsDir, 'build-index.mjs'), '--quiet'], { stdio: 'ignore', windowsHide: true });
      return explorer(join(root, 'index.html'));
    },
    openWindow({ url }) {
      if (tools.edge) return run(tools.edge, [`--app=${url}`]);
      return explorer(url);
    },
  };
}
