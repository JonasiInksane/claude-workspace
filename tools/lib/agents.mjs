// Project agents: one agent file per role inside a project, each with its own memory folder and
// its own image folder in the workspace inbox. Shared by new-agent, agent-session and the app.
//
//   projects/<project>/.claude/agents/<agent>.md        definition (memory: project)
//   projects/<project>/.claude/agents-archived/<agent>.md   archived: not loaded, memory and images kept
//   projects/<project>/.claude/agent-memory/<agent>/    that agent's memory (MEMORY.md + topic files)
//   inbox/attachments/<project>/<agent>/YYYY-MM-DD/     that agent's reference images
//   inbox/attachments/<project>/_shared/YYYY-MM-DD/     images for every agent of the project
//
// Isolation (verified with Claude Code 2.1.305, see knowledge/claude-code/agent-memory.md):
// `claude --agent <name>` loads the agent's MEMORY.md but ALSO the project's normal auto memory.
// sessionSettings() points autoMemoryDirectory at the agent's own folder, so an agent session
// sees only its own memory, and grants read access to its two image folders.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHARED_DIR = '_shared';
export const HUB_DIR = '_hub';
// Built-in agent types and Windows device names. A project agent with a built-in's name would
// shadow it in that project.
const RESERVED = new Set([
  'explore', 'plan', 'general-purpose', 'statusline-setup', 'claude-code-guide', 'claude', 'fork',
  'con', 'prn', 'aux', 'nul',
]);

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function projectDir(root, project) { return join(root, 'projects', project); }
export function agentsDir(root, project) { return join(projectDir(root, project), '.claude', 'agents'); }
export function agentFile(root, project, agent) { return join(agentsDir(root, project), `${agent}.md`); }
// The folder Claude Code uses for each `memory:` scope (named by the frontmatter name).
export function memoryDir(root, project, agent, scope = 'project') {
  if (scope === 'user') return join(homedir(), '.claude', 'agent-memory', agent);
  const sub = scope === 'local' ? 'agent-memory-local' : 'agent-memory';
  return join(projectDir(root, project), '.claude', sub, agent);
}
export function imagesDir(root, project, agent) { return join(root, 'inbox', 'attachments', project, agent); }
export function sharedImagesDir(root, project) { return join(root, 'inbox', 'attachments', project, SHARED_DIR); }

// Finds the project folder for a name the user typed. Returns { name, error }: `name` is the
// folder's real spelling (Windows paths ignore case, folder names in the inbox should not).
export function resolveProject(root, input) {
  if (!input) return { name: '', error: 'a project name is required' };
  if (/[\\/:]/.test(input) || input.startsWith('.') || input.startsWith('_')) {
    return { name: '', error: `"${input}" is not a project folder name` };
  }
  // Linked folders (symlinks, junctions) count; isDir below follows the link.
  const dirs = listDir(join(root, 'projects')).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
  const name = dirs.find(n => n === input) || dirs.find(n => n.toLowerCase() === input.toLowerCase());
  if (!name || !isDir(projectDir(root, name))) return { name: '', error: `projects/${input} was not found` };
  return { name, error: '' };
}

// Returns an error message, or '' when <project> is an existing folder under projects/.
export function checkProject(root, project) {
  return resolveProject(root, project).error;
}

// Returns an error message, or '' when <agent> is a usable new agent name.
export function checkAgentName(agent, { taken = [] } = {}) {
  if (!agent) return 'an agent name is required';
  if (!NAME_RE.test(agent)) return `"${agent}" is not kebab-case. Use lowercase letters, digits and dashes, for example asset-builder.`;
  if (/^(com|lpt)\d$/.test(agent) || RESERVED.has(agent)) return `"${agent}" is a reserved name. Pick another name.`;
  if (taken.includes(agent)) return `an agent named "${agent}" already exists. Pick another name.`;
  return '';
}

// Top-level "key: value" pairs of a frontmatter block. Enough for name/description/memory/model;
// lists and block scalars come back as raw text.
export function readFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    let v = km[2].trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1).replace(/''/g, "'");
    } else {
      v = v.replace(/\s+#.*$/, ''); // trailing comment on a plain value
    }
    data[km[1]] = v;
  }
  return data;
}

function walkMd(dir, out = []) {
  for (const e of listDir(dir)) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out;
}

// Every agent defined in the project's .claude/agents/ (scanned recursively, like Claude Code).
// `isolated` is true when the agent has memory of its own in this project (memory: project or
// local), which is what agent-session.mjs can start. `valid` is
// false for names that are not safe as folder names (path-like, reserved); never build paths
// from those.
export function listAgents(root, project) {
  const out = [];
  for (const file of walkMd(agentsDir(root, project))) {
    let fm = null;
    try { fm = readFrontmatter(readFileSync(file, 'utf8')); } catch { /* unreadable: skip */ }
    if (!fm || !fm.name) continue;
    const valid = checkAgentName(fm.name) === '';
    out.push({
      name: fm.name,
      description: fm.description || '',
      memory: fm.memory || '',
      model: fm.model || '',
      isolated: fm.memory === 'project' || fm.memory === 'local',
      valid,
      file,
      rel: relative(agentsDir(root, project), file).split(sep).join('/'), // art.md, team/art.md
      memoryDir: valid ? memoryDir(root, project, fm.name, fm.memory) : '',
      imagesDir: valid ? imagesDir(root, project, fm.name) : '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

// Names defined by more than one file. Claude Code then loads only one of them, and both
// would share one memory folder.
export function duplicateNames(agents) {
  const seen = new Map();
  for (const a of agents) seen.set(a.name, [...(seen.get(a.name) || []), a.file]);
  return [...seen].filter(([, files]) => files.length > 1).map(([name, files]) => ({ name, files }));
}

// ---- Editing and archiving (the workspace app uses these) ----

export const MAX_AGENT_BYTES = 60 * 1024;
export const textHash = text => createHash('sha1').update(text).digest('hex');

// Checks new text for the file of the existing agent `name`. Returns { error, warnings }.
export function checkAgentText(text, name) {
  if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_BYTES) return { error: 'the file is larger than 60 KB', warnings: [] };
  const fm = readFrontmatter(text);
  if (!fm) return { error: 'the file must start with a frontmatter block between two --- lines', warnings: [] };
  if (fm.name !== name) {
    return { error: `name must stay "${name}": a new name would leave its memory folder behind. Archive it and create a new agent instead.`, warnings: [] };
  }
  if (!fm.description) return { error: 'description is required: it tells Claude when to hand work to this agent', warnings: [] };
  const warnings = [];
  if (fm.memory !== 'project' && fm.memory !== 'local') {
    warnings.push(`Without "memory: project" ${name} has no memory of its own and can't be started isolated.`);
  }
  return { error: '', warnings };
}

// Saves an agent's file, unless it changed on disk since the text with `baseHash` was read.
// Keeps the file's line endings. Returns { error, conflict, warnings, hash }.
export function saveAgentText(agent, text, baseHash) {
  const current = readFileSync(agent.file, 'utf8');
  if (textHash(current) !== baseHash) {
    return { error: 'the file changed on disk since you opened it. Close it and open it again.', conflict: true, warnings: [] };
  }
  const check = checkAgentText(text, agent.name);
  if (check.error) return check;
  const out = current.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
  writeFileSync(agent.file, out, 'utf8');
  return { error: '', warnings: check.warnings, hash: textHash(out) };
}

// Archived agent files live outside .claude/agents/, so Claude Code no longer loads them. Their
// memory and image folders stay where they are, so restoring brings the agent back whole.
export function archivedAgentsDir(root, project) { return join(projectDir(root, project), '.claude', 'agents-archived'); }

// Moves an agent's file to .claude/agents-archived/<name>.md (<name>--2.md ... when taken).
// Returns the new path.
export function archiveAgent(root, project, agent) {
  const dir = archivedAgentsDir(root, project);
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i < 100; i++) {
    const target = join(dir, i === 1 ? `${agent.name}.md` : `${agent.name}--${i}.md`);
    if (existsSync(target)) continue;
    renameSync(agent.file, target);
    return target;
  }
  throw new Error(`too many archived copies of ${agent.name}`);
}

export function listArchivedAgents(root, project) {
  const dir = archivedAgentsDir(root, project);
  const out = [];
  for (const e of listDir(dir)) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const file = join(dir, e.name);
    let fm = null;
    try { fm = readFrontmatter(readFileSync(file, 'utf8')); } catch { /* unreadable: no name */ }
    const name = (fm && fm.name) || '';
    out.push({ archivedAs: e.name, file, name, description: (fm && fm.description) || '', valid: checkAgentName(name) === '' });
  }
  return out.sort((a, b) => a.archivedAs.localeCompare(b.archivedAs));
}

// Moves an archived file back to .claude/agents/<name>.md. Returns { error, name }.
export function restoreAgent(root, project, archivedAs) {
  const entry = listArchivedAgents(root, project).find(a => a.archivedAs === archivedAs);
  if (!entry) return { error: `there is no archived agent file "${archivedAs}"`, name: '' };
  if (!entry.valid) return { error: `${archivedAs} has no usable name in its frontmatter`, name: '' };
  if (listAgents(root, project).some(a => a.name === entry.name) || existsSync(agentFile(root, project, entry.name))) {
    return { error: `an agent named "${entry.name}" already exists. Archive that one first.`, name: '' };
  }
  mkdirSync(agentsDir(root, project), { recursive: true });
  renameSync(entry.file, agentFile(root, project, entry.name));
  return { error: '', name: entry.name };
}

// Names of the global library agents (installed to ~/.claude/agents). A project agent with the
// same name would replace the library one in that project.
export function libraryAgentNames(root) {
  const names = [];
  for (const file of walkMd(join(root, 'library', 'agents'))) {
    try {
      const fm = readFrontmatter(readFileSync(file, 'utf8'));
      if (fm && fm.name) names.push(fm.name);
    } catch { /* skip */ }
  }
  return names;
}

// The --settings content for an isolated agent session. Absolute paths: relative entries
// resolve against the session's working directory, not the settings file. --settings outranks
// project settings, so autoMemoryEnabled here keeps agent memory on even if the project turns it off.
export function sessionSettings(root, project, agent, scope = 'project') {
  return {
    autoMemoryEnabled: true,
    autoMemoryDirectory: resolve(memoryDir(root, project, agent, scope)),
    permissions: {
      additionalDirectories: [resolve(imagesDir(root, project, agent)), resolve(sharedImagesDir(root, project))],
    },
  };
}

// The claude executable: PATH first, then the native installer's location. Returns
// { path, shim }: `path` is '' when no runnable claude was found; `shim` is an npm claude.cmd
// found on PATH instead (Node cannot spawn .cmd files without a shell, so it is not used).
export function resolveClaude(env = process.env) {
  const win = process.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  let shim = '';
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) continue;
    if (existsSync(join(d, exe))) return { path: join(d, exe), shim: '' };
    if (win && !shim && existsSync(join(d, 'claude.cmd'))) shim = join(d, 'claude.cmd');
  }
  const local = join(homedir(), '.local', 'bin', exe);
  return { path: existsSync(local) ? local : '', shim };
}
