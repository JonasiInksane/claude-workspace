// Project agents: one agent file per role inside a project, each with its own memory folder and
// its own image folder in the workspace inbox. Shared by new-agent, agent-session and the app.
//
//   projects/<project>/.claude/agents/<agent>.md        definition (memory: project)
//   projects/<project>/.claude/agent-memory/<agent>/    that agent's memory (MEMORY.md + topic files)
//   inbox/attachments/<project>/<agent>/YYYY-MM-DD/     that agent's reference images
//   inbox/attachments/<project>/_shared/YYYY-MM-DD/     images for every agent of the project
//
// Isolation (verified with Claude Code 2.1.305, see knowledge/claude-code/agent-memory.md):
// `claude --agent <name>` loads the agent's MEMORY.md but ALSO the project's normal auto memory.
// sessionSettings() points autoMemoryDirectory at the agent's own folder, so an agent session
// sees only its own memory, and grants read access to its two image folders.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

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
