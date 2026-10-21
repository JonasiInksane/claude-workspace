// Starts an interactive Claude session with a first prompt from a prompt file
// (tools/lib/prompt-file.mjs explains the file and why it exists).
//
// Usage (the workspace app runs this in a new terminal; not meant to be typed):
//   node tools/workspace-app/claude-prompt.mjs <prompt-file>
//
// - Runs `claude [--permission-mode m] [--model x] [--effort e] [--settings <file>] <prompt>` in
//   the current folder. The settings file is only added when the prompt file lists readDirs (the
//   session may read those folders) or pre-approved tools (permissions.allow).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveClaude } from '../lib/agents.mjs';
import { launchArgs, promptArgs, promptDir, takePromptFile } from '../lib/prompt-file.mjs';

function fail(msg) {
  console.error(`claude-prompt: ${msg}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file || process.argv.length > 3) fail('usage: node tools/workspace-app/claude-prompt.mjs <prompt-file>');
let handed;
try { handed = takePromptFile(file); } catch (e) { fail(e.message); }

const claude = resolveClaude();
if (!claude.path) fail('claude was not found on PATH or in %USERPROFILE%\\.local\\bin.');
const args = launchArgs(handed.launch);
const permissions = {};
if (handed.readDirs.length) permissions.additionalDirectories = handed.readDirs;
if (handed.launch.allowedTools) permissions.allow = handed.launch.allowedTools;
if (Object.keys(permissions).length) {
  // Named by its content, so starting the same flow again reuses the file.
  const settings = JSON.stringify({ permissions }, null, 2) + '\n';
  const settingsFile = join(promptDir(), `read-dirs-${createHash('sha1').update(settings).digest('hex').slice(0, 12)}.json`);
  mkdirSync(promptDir(), { recursive: true });
  writeFileSync(settingsFile, settings, 'utf8');
  args.push('--settings', settingsFile);
}
args.push(...promptArgs(handed.prompt));
const r = spawnSync(claude.path, args, { stdio: 'inherit' });
if (r.error) fail(`could not start claude: ${r.error.message}`);
process.exit(r.status ?? 0);
