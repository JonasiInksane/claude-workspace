// Starts Claude as one project agent, with only that agent's memory and image folders.
//
// Usage:
//   node tools/agent-session.mjs <project> <agent> [--print] [--session-id <uuid>]
//
// - Runs `claude --agent <agent> --settings <file>` inside projects/<project> (for a linked
//   project, in the checkout's real folder: tools/lib/projects.mjs). The settings file
//   (in the temp folder, rewritten on every start) points auto memory at the agent's own folder,
//   so the project's shared auto memory does not load, and lets the session read
//   inbox/attachments/<project>/<agent>/ and inbox/attachments/<project>/_shared/ without prompts.
// - Only agents with `memory: project` (or `local`) can be isolated; `user` memory is shared by
//   every project, so the tool refuses it.
// - --print prints {cwd, command, args, settingsFile} as JSON instead of starting Claude. It
//   still writes the settings file and creates the folders. For scripts and checks; the
//   workspace app runs this tool itself in a terminal tab.
// - --root <dir> uses another workspace root (the workspace app passes it; also for tests).
// - --prompt-file <file> starts with a first prompt (tools/lib/prompt-file.mjs; the workspace
//   app's flows use it). Its readDirs are added to the folders the session may read, its launch
//   settings become --permission-mode / --model / --effort, and its pre-approved tools go into
//   the settings' permissions.allow. A settings file named in its launch is merged into the
//   agent's settings file (its values win, its lists add up).
// - --session-id <uuid> gives the new session that id (the workspace app records it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  checkAgentName, duplicateNames, imagesDir, listAgents, resolveClaude, resolveProject,
  sessionSettings, sharedImagesDir,
} from './lib/agents.mjs';
import { launchArgs, mergeSettings, promptArgs, takePromptFile, UUID_RE } from './lib/prompt-file.mjs';
import { realProjectDir } from './lib/projects.mjs';

const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`agent-session: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log('Usage: node tools/agent-session.mjs <project> <agent> [--print] [--prompt-file <file>] [--session-id <uuid>]');
}

function parseArgs(argv) {
  const out = { positional: [], print: false, root: undefined, promptFile: undefined, sessionId: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--print') out.print = true;
    else if (a === '--root' || a.startsWith('--root=')) {
      out.root = a.includes('=') ? a.slice(7) : argv[++i];
      if (!out.root) fail('--root needs a value');
    } else if (a === '--prompt-file') {
      out.promptFile = argv[++i];
      if (!out.promptFile) fail('--prompt-file needs a value');
    } else if (a === '--session-id') {
      out.sessionId = String(argv[++i] || '').toLowerCase();
      if (!UUID_RE.test(out.sessionId)) fail('--session-id needs a session id (a UUID)');
    } else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else out.positional.push(a);
  }
  if (out.positional.length > 2) fail(`unexpected argument "${out.positional[2]}"`);
  [out.project, out.agent] = out.positional;
  return out;
}

// ---- main ----
const opts = parseArgs(process.argv.slice(2));
const root = opts.root ? resolve(opts.root) : toolsRoot;
if (!opts.project || !opts.agent) { usage(); fail('a project and an agent name are required'); }

// The name becomes part of folder and file paths, so check it before building any.
const nameErr = checkAgentName(opts.agent);
if (nameErr) fail(nameErr);
const { name: project, error: projectErr } = resolveProject(root, opts.project);
if (projectErr) fail(projectErr);
const agents = listAgents(root, project);
const dup = duplicateNames(agents).find(d => d.name === opts.agent);
if (dup) {
  const files = dup.files.map(f => relative(root, f).split('\\').join('/')).join(', ');
  fail(`"${opts.agent}" is defined by more than one file (${files}). Rename one; they would share one memory folder.`);
}
const agent = agents.find(a => a.name === opts.agent);
if (!agent) {
  const names = agents.map(a => a.name).join(', ') || 'none yet';
  fail(`projects/${project} has no agent "${opts.agent}" (agents: ${names}). Create it with: node tools/new-agent.mjs ${project} ${opts.agent}`);
}
if (agent.memory !== 'project' && agent.memory !== 'local') {
  const why = agent.memory === 'user'
    ? '"memory: user" is shared by every project with an agent of this name'
    : `it has no memory scope ("memory: ${agent.memory || '(none)'}")`;
  fail(`${opts.agent} can't run isolated: ${why}. Set "memory: project" in ${relative(root, agent.file).split('\\').join('/')}.`);
}

const claude = resolveClaude();
if (!claude.path) {
  fail(claude.shim
    ? `found only the npm shim ${claude.shim}, which this tool can't start. Install the native build (see knowledge/claude-code/windows-setup.md).`
    : 'claude was not found on PATH or in %USERPROFILE%\\.local\\bin. Run Setup.ps1 or see knowledge/claude-code/windows-setup.md.');
}

for (const dir of [agent.memoryDir, imagesDir(root, project, opts.agent), sharedImagesDir(root, project)]) {
  mkdirSync(dir, { recursive: true });
}
const settingsDir = join(tmpdir(), 'claude-workspace', 'agent-sessions');
mkdirSync(settingsDir, { recursive: true });
// The root hash keeps two workspace copies from sharing a settings file.
const rootTag = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8);
let handed = null;
if (opts.promptFile) {
  try { handed = takePromptFile(opts.promptFile); } catch (e) { fail(e.message); }
}
let settings = sessionSettings(root, project, opts.agent, agent.memory);
// Extra readable folders, pre-approved tools and a launch settings file get their own settings
// file, so the plain one stays the same.
const extra = handed ? handed.readDirs.map(d => resolve(d)) : [];
settings.permissions.additionalDirectories.push(...extra);
const allow = handed && handed.launch.allowedTools ? handed.launch.allowedTools : [];
if (allow.length) settings.permissions.allow = allow;
const launchSettings = handed && handed.launch.settingsFile ? handed.launch.settingsFile : '';
if (launchSettings) {
  try { settings = mergeSettings(settings, JSON.parse(readFileSync(launchSettings, 'utf8').replace(/^﻿/, ''))); } catch (e) {
    fail(`the settings file ${launchSettings} could not be read: ${e.message}`);
  }
}
const extraKey = [...extra, ...allow.map(r => `allow:${r}`), ...(launchSettings ? [`settings:${launchSettings}`] : [])].join('\n');
const extraTag = extraKey ? `--${createHash('sha1').update(extraKey).digest('hex').slice(0, 8)}` : '';
const settingsFile = join(settingsDir, `${project}--${opts.agent}--${rootTag}${extraTag}.json`);
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');

// A linked project runs in the checkout's real folder (transcripts and trust follow the folder).
let cwd;
try { cwd = realProjectDir(root, project); } catch (e) { fail(e.message); }
const args = ['--agent', opts.agent, '--settings', settingsFile];
const sessionId = opts.sessionId || (handed && handed.launch.sessionId) || '';
if (handed) {
  const { settingsFile: _merged, sessionId: _id, ...flags } = handed.launch;
  args.push(...launchArgs(flags));
}
if (sessionId && !(handed && handed.launch.resume)) args.push('--session-id', sessionId);
if (handed) args.push(...promptArgs(handed.prompt));

if (opts.print) {
  console.log(JSON.stringify({ cwd, command: claude.path, args, settingsFile }, null, 2));
  process.exit(0);
}

console.log(`Starting ${opts.agent} in projects/${project} (own memory: ${relative(cwd, agent.memoryDir).split('\\').join('/')}/)`);
const r = spawnSync(claude.path, args, { cwd, stdio: 'inherit' });
if (r.error) fail(`could not start claude: ${r.error.message}`);
process.exit(r.status ?? 0);
