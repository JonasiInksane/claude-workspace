// Project agents: read and save an agent file, view an agent's memory, create an agent (through
// tools/new-agent.mjs), archive and restore. Agents are found by name in their own folders
// (lookup.mjs), never by a path from the page.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { archiveAgent, checkAgentName, listArchivedAgents, restoreAgent, saveAgentText, textHash } from '../../lib/agents.mjs';
import { HttpError, readJson } from '../http.mjs';
import { findAgent, findProject } from '../lookup.mjs';

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEW_AGENT_TIMEOUT_MS = 30_000;

// The agent's memory files, MEMORY.md first, each cut at 100 KB.
function memoryView(project, agent) {
  const dir = agent.memoryDir;
  const files = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* no memory yet */ }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const full = join(dir, e.name);
    let content = '';
    let size = 0;
    try {
      size = statSync(full).size;
      content = readFileSync(full, 'utf8').slice(0, 100_000);
    } catch { /* unreadable */ }
    files.push({ name: e.name, size, content, truncated: size > 100_000 });
  }
  files.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
  return { project, agent: agent.name, dir, files: files.slice(0, 60) };
}

// Runs a Node script without blocking the server: { status, stdout, stderr, error }.
function runNode(args, timeoutMs) {
  return new Promise(resolveP => {
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawn(process.execPath, args, { windowsHide: true }); } catch (error) { resolveP({ status: null, stdout, stderr, error }); return; }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.once('error', error => { clearTimeout(timer); resolveP({ status: null, stdout, stderr, error }); });
    child.once('close', code => { clearTimeout(timer); resolveP({ status: code, stdout, stderr, error: null }); });
  });
}

export function routes({ root }) {
  return {
    'GET /api/memory': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      const { project, agent } = findAgent(root, q.project, q.agent, { isolated: true });
      return { ok: true, ...memoryView(project, agent) };
    },

    'GET /api/agent-file': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      const { project, agent } = findAgent(root, q.project, q.agent, { file: q.file });
      const text = readFileSync(agent.file, 'utf8');
      const path = agent.file.slice(root.length + 1).split(sep).join('/');
      return { ok: true, project, agent: agent.name, file: agent.rel, path, text, hash: textHash(text) };
    },

    // Refuses a rename and a save over newer changes (409).
    'POST /api/agent-file': async req => {
      const b = await readJson(req);
      const { agent } = findAgent(root, b.project, b.agent, { file: String(b.file || '') });
      const r = saveAgentText(agent, String(b.text ?? ''), String(b.hash || ''));
      if (r.error) throw new HttpError(r.conflict ? 409 : 400, r.error);
      return { ok: true, message: `Saved ${agent.name}`, warnings: r.warnings, hash: r.hash };
    },

    'POST /api/agents/archive': async req => {
      const b = await readJson(req);
      const { project, agent } = findAgent(root, b.project, b.agent, { file: String(b.file || '') });
      archiveAgent(root, project, agent);
      return { ok: true, message: `Archived ${agent.name}. Its memory and images stay; Restore brings it back.` };
    },

    'POST /api/agents/restore': async req => {
      const b = await readJson(req);
      const project = findProject(root, b.project);
      const r = restoreAgent(root, project, String(b.archivedAs || ''));
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, message: `Restored ${r.name} in ${project}` };
    },

    'POST /api/agents': async req => {
      const b = await readJson(req);
      const project = findProject(root, b.project);
      // Check here too: a name like "--help" would otherwise reach new-agent as an option.
      const nameError = checkAgentName(String(b.agent || ''));
      if (nameError) throw new HttpError(400, nameError);
      if (project.startsWith('-')) throw new HttpError(400, `create agents for ${project} from a terminal`);
      // Its memory folder still exists, so a new agent would quietly inherit that memory.
      if (listArchivedAgents(root, project).some(a => a.name === b.agent)) {
        throw new HttpError(400, `an archived agent is named "${b.agent}". Restore it, or pick another name.`);
      }
      const args = [join(toolsDir, 'new-agent.mjs'), project, String(b.agent), '--root', root];
      if (b.role && String(b.role).trim()) args.push('--role', String(b.role).slice(0, 500));
      if (b.description && String(b.description).trim()) args.push('--description', String(b.description).slice(0, 500));
      const r = await runNode(args, NEW_AGENT_TIMEOUT_MS);
      if (r.status !== 0) throw new HttpError(400, String(r.stderr || r.error || 'new-agent failed').replace(/^new-agent:\s*/, '').trim());
      return { ok: true, message: `Created ${b.agent} in ${project}`, output: r.stdout };
    },
  };
}
