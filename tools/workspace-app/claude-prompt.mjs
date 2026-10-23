// Starts an interactive Claude session from a prompt file (tools/lib/prompt-file.mjs explains the
// file and why it exists): with a first prompt, with the project's rules, or both.
//
// Usage (the workspace app runs this in a new terminal; not meant to be typed):
//   node tools/workspace-app/claude-prompt.mjs <prompt-file> [--print]
//
// - Runs `claude [-c] [--resume id | --session-id id] [--permission-mode m] [--model x]
//   [--effort e] [--settings <file>] [--append-system-prompt <rules>] [<prompt>]` in the current
//   folder. The app gives every new session its own id (--session-id), so it can find the session
//   again. A file without a prompt starts the session without a first prompt.
// - The prompt and the rules are arguments of this Node spawn, never part of a PowerShell
//   command, so their quotes and line breaks arrive as they were written.
// - A settings file is added when the prompt file lists readDirs (the session may read those
//   folders) or pre-approved tools (permissions.allow). When the launch names a settings file as
//   well, both are merged into one file (promptSessionArgs), because claude reads one.
// - --print prints { command, args, settingsPath } as JSON instead of starting claude (for
//   tests). It still takes (deletes) the prompt file and writes the settings file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveClaude } from '../lib/agents.mjs';
import { promptDir, promptSessionArgs, takePromptFile } from '../lib/prompt-file.mjs';

function fail(msg) {
  console.error(`claude-prompt: ${msg}`);
  process.exit(1);
}

const [file, ...rest] = process.argv.slice(2);
const print = rest.length === 1 && rest[0] === '--print';
if (!file || file.startsWith('--') || (rest.length && !print)) fail('usage: node tools/workspace-app/claude-prompt.mjs <prompt-file> [--print]');
let handed;
try { handed = takePromptFile(file); } catch (e) { fail(e.message); }

const claude = resolveClaude();
if (!claude.path) fail('claude was not found on PATH or in %USERPROFILE%\\.local\\bin.');
let built;
try { built = promptSessionArgs(handed); } catch (e) { fail(e.message); }
if (built.settings) {
  mkdirSync(promptDir(), { recursive: true });
  writeFileSync(built.settingsPath, built.settings, 'utf8');
}
if (print) {
  console.log(JSON.stringify({ command: claude.path, args: built.args, settingsPath: built.settingsPath }, null, 2));
  process.exit(0);
}
// Interactive: claude shares this terminal's console (stdio inherit), so there is no window to
// hide; windowsHide is left off so it starts exactly like a claude typed in this terminal.
const r = spawnSync(claude.path, built.args, { stdio: 'inherit' });
if (r.error) fail(`could not start claude: ${r.error.message}`);
process.exit(r.status ?? 0);
