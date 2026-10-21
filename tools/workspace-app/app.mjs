// HTTP handler for the workspace app. server.mjs owns the listening socket and the window;
// this file owns routing, access checks and the JSON API, so tests can drive it with a fake
// `actions` object (see app.test.mjs).
//
// Access: the app only answers on 127.0.0.1/localhost with the right port (Host check). The
// launch URL carries a sign-in token (/?t=...) that is new for every run of the server; it
// becomes an HttpOnly SameSite=Strict cookie, and every request except /health and the sign-in
// itself needs that cookie. POST requests also need a same-origin Origin header and the
// X-Workspace-App header, which other web pages cannot send without a CORS preflight that this
// server never approves.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { checkAgentName, listAgents, projectDir, resolveProject, SHARED_DIR } from '../lib/agents.mjs';
import { projectNameMap, scanInbox } from '../lib/inbox.mjs';
import { detectProjectType, typeLabel } from '../lib/project-type.mjs';
import {
  contentTypeFor, isInside, listImages, localDate, MAX_UPLOAD_BYTES, resolveTarget, saveImage,
} from './uploads.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(appDir, '..'); // the CLI tools this app runs (new-agent.mjs ...)
const MAX_JSON_BYTES = 64 * 1024;
// Folder names the app will start terminals in. Others still show, with a hint to use a terminal.
const LAUNCHABLE = /^[\w .()-]+$/;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const base = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

// Reads the body up to `limit` bytes. Over the limit it rejects with 413 at once and keeps
// draining (not destroying) the request, so the client still gets the 413 response.
function readBody(req, limit) {
  return new Promise((resolveP, reject) => {
    const limitText = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MB` : `${Math.round(limit / 1024)} KB`;
    const tooBig = () => new HttpError(413, `request is larger than ${limitText}`);
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(tooBig()); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolveP(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function readReports(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, 'reports', 'reports.json'), 'utf8').trimStart());
    return (Array.isArray(data.reports) ? data.reports : []).filter(r => r && typeof r === 'object');
  } catch { return []; }
}

function countMd(dir) {
  try { return readdirSync(dir).filter(n => n.toLowerCase().endsWith('.md')).length; } catch { return 0; }
}

// Everything the UI shows, in one call.
export function buildState(root, tools) {
  let inbox = { items: [], libraries: [], processed: 0, truncated: false, exists: false };
  let inboxError = '';
  try { inbox = scanInbox(root); } catch (e) { inboxError = e.message; }
  const libCount = new Map(inbox.libraries.map(l => [`${l.project}/${l.agent.toLowerCase()}`, l.files]));

  const projects = [...projectNameMap(root).values()].sort((a, b) => a.localeCompare(b)).map(name => {
    const dir = projectDir(root, name);
    let label = 'Other';
    try { label = typeLabel(detectProjectType(dir)); } catch { /* keep Other */ }
    const agents = listAgents(root, name).map(a => ({
      name: a.name,
      description: a.description,
      memory: a.memory,
      isolated: a.isolated,
      valid: a.valid,
      images: libCount.get(`${name}/${a.name.toLowerCase()}`) || 0,
      memoryFiles: a.valid ? countMd(a.memoryDir) : 0,
    }));
    return {
      name,
      label,
      hasClaudeMd: existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, '.claude', 'CLAUDE.md')),
      launchable: LAUNCHABLE.test(name),
      sharedImages: libCount.get(`${name}/${SHARED_DIR}`) || 0,
      agents,
    };
  });

  const reports = readReports(root)
    .filter(r => r.status === 'active')
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
    .map(r => ({ id: String(r.id || ''), title: String(r.title || r.id || 'Untitled'), type: String(r.type || ''), project: r.project ? String(r.project) : '', updated: String(r.updated || '') }));

  return {
    root,
    today: localDate(),
    tools: { wt: !!tools.wt, claude: !!tools.claude, edge: !!tools.edge, editor: tools.editor ? tools.editor.name : '' },
    inbox: {
      error: inboxError,
      total: inbox.items.length,
      truncated: inbox.truncated,
      processed: inbox.processed,
      items: inbox.items.slice(0, 40).map(i => ({
        path: i.path, name: i.parts[i.parts.length - 1], size: i.size,
        mtime: new Date(i.mtimeMs).toISOString(), isImage: !!contentTypeFor(i.path),
      })),
      libraries: inbox.libraries.map(l => ({ project: l.project, agent: l.agent, files: l.files, known: l.known, path: l.path })),
    },
    reports,
    projects,
  };
}

// The agent a request names, checked: existing project and a valid agent name. With
// `isolated`, the agent must also have memory of its own (memory: project or local).
function findAgent(root, projectName, agentName, { isolated = false } = {}) {
  const { name: project, error } = resolveProject(root, projectName);
  if (error) throw new HttpError(404, error);
  const agent = listAgents(root, project).find(a => a.name === agentName);
  if (!agent || !agent.valid) throw new HttpError(404, `projects/${project} has no usable agent "${agentName}"`);
  if (isolated && !agent.isolated) throw new HttpError(400, `${agent.name} has no "memory: project", so it has no memory of its own`);
  return { project, agent };
}

function findProject(root, projectName) {
  const { name, error } = resolveProject(root, projectName);
  if (error) throw new HttpError(404, error);
  return name;
}

function targetOrThrow(root, query) {
  const t = resolveTarget(root, query);
  if (t.error) throw new HttpError(404, t.error);
  return t;
}

function memoryView(root, project, agent) {
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

// workspaceTag: a short hash of the root that /health reports, so a second start of the app
// can tell its own workspace's server from another one.
export function createApp({ root, token, actions, getPort, workspaceTag = '', onPing = () => {}, uiDir = join(appDir, 'ui') }) {
  root = resolve(root);
  const cookieName = () => `wsapp_${getPort()}`;
  const allowedHosts = () => [`127.0.0.1:${getPort()}`, `localhost:${getPort()}`];

  async function api(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/state':
        return json(res, 200, { ok: true, ...buildState(root, actions.tools || {}) });

      case 'POST /api/ping':
        onPing();
        return json(res, 200, { ok: true });

      case 'GET /api/images': {
        const t = targetOrThrow(root, q);
        return json(res, 200, { ok: true, label: t.label, dir: t.dir, images: listImages(root, t.dir) });
      }

      case 'GET /api/memory': {
        const { project, agent } = findAgent(root, q.project, q.agent, { isolated: true });
        return json(res, 200, { ok: true, ...memoryView(root, project, agent) });
      }

      case 'POST /api/upload': {
        const t = targetOrThrow(root, q);
        const buf = await readBody(req, MAX_UPLOAD_BYTES + 1);
        const file = saveImage(t.dir, buf, { name: q.name || '' });
        return json(res, 200, { ok: true, label: t.label, abs: file, path: file.slice(root.length + 1).split(sep).join('/') });
      }

      case 'POST /api/launch': {
        const b = await readJson(req);
        if (b.kind === 'hub') {
          await actions.startClaude({ dir: root, title: 'Workspace hub', continueLast: !!b.continueLast });
          return json(res, 200, { ok: true, message: b.continueLast ? 'Continuing the last hub session' : 'Started Claude in the hub' });
        }
        if (b.kind === 'project') {
          const project = findProject(root, b.project);
          if (!LAUNCHABLE.test(project)) throw new HttpError(400, `start ${project} from a terminal (its folder name has unusual characters)`);
          await actions.startClaude({ dir: projectDir(root, project), title: project, continueLast: !!b.continueLast });
          return json(res, 200, { ok: true, message: `${b.continueLast ? 'Continuing' : 'Started'} Claude in ${project}` });
        }
        if (b.kind === 'agent') {
          const { project, agent } = findAgent(root, b.project, b.agent);
          if (!agent.isolated) throw new HttpError(400, `${agent.name} has no "memory: project", so it can't run isolated`);
          if (!LAUNCHABLE.test(project)) throw new HttpError(400, `start ${project} from a terminal (its folder name has unusual characters)`);
          await actions.startAgent({ project, agent: agent.name, title: `${project}: ${agent.name}` });
          return json(res, 200, { ok: true, message: `Started ${agent.name} in ${project}` });
        }
        throw new HttpError(400, 'kind must be hub, project or agent');
      }

      case 'POST /api/open': {
        const b = await readJson(req);
        let dir;
        if (b.place === 'hub') dir = root;
        else if (b.place === 'inbox') dir = join(root, 'inbox');
        else if (b.place === 'project') dir = projectDir(root, findProject(root, b.project));
        else if (b.place === 'images') { dir = targetOrThrow(root, b).dir; mkdirSync(dir, { recursive: true }); }
        else if (b.place === 'memory') { dir = findAgent(root, b.project, b.agent, { isolated: true }).agent.memoryDir; mkdirSync(dir, { recursive: true }); }
        else if (b.place === 'report') {
          const r = readReports(root).find(x => x.id === b.report);
          if (!r) throw new HttpError(404, 'report not found');
          dir = resolve(root, String(r.folder || `reports/${r.id}`));
          if (!isInside(join(root, 'reports'), dir) || !isDir(dir)) throw new HttpError(404, 'report folder not found');
        } else if (b.place === 'navigator') {
          await actions.openNavigator();
          return json(res, 200, { ok: true, message: 'Rebuilt and opened the navigator' });
        } else throw new HttpError(400, 'unknown place');
        if (b.with === 'editor') {
          if (b.place !== 'hub' && b.place !== 'project') throw new HttpError(400, 'only the hub or a project opens in the editor');
          await actions.openEditor({ dir });
          return json(res, 200, { ok: true, message: 'Opened in the editor' });
        }
        await actions.openFolder({ dir });
        return json(res, 200, { ok: true, message: 'Opened in Explorer' });
      }

      case 'POST /api/agents': {
        const b = await readJson(req);
        const project = findProject(root, b.project);
        // Check here too: a name like "--help" would otherwise reach new-agent as an option.
        const nameError = checkAgentName(String(b.agent || ''));
        if (nameError) throw new HttpError(400, nameError);
        if (project.startsWith('-')) throw new HttpError(400, `create agents for ${project} from a terminal`);
        const args = [join(toolsDir, 'new-agent.mjs'), project, String(b.agent), '--root', root];
        if (b.role && String(b.role).trim()) args.push('--role', String(b.role).slice(0, 500));
        if (b.description && String(b.description).trim()) args.push('--description', String(b.description).slice(0, 500));
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        if (r.status !== 0) throw new HttpError(400, String(r.stderr || r.error || 'new-agent failed').replace(/^new-agent:\s*/, '').trim());
        return json(res, 200, { ok: true, message: `Created ${b.agent} in ${project}`, output: r.stdout });
      }

      default:
        throw new HttpError(404, 'not found');
    }
  }

  return async function handler(req, res) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts().includes(host)) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url, `http://${host}`);

      // Lets a second start find this server (server.mjs). Says nothing about the workspace.
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, app: 'claude-workspace-app', workspace: workspaceTag });
      }

      // Token exchange: the launch URL sets the cookie, then redirects to a clean URL.
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, 'This link has expired. Start the app again.');
        return send(res, 302, '', {
          Location: '/',
          'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!sameToken(cookies(req)[cookieName()], token)) {
        return send(res, 403, 'Not signed in. Start the app with "Workspace App.cmd" or node tools/workspace-app/server.mjs.',
          { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      if (req.method === 'POST') {
        const origin = String(req.headers.origin || '').toLowerCase();
        if (!allowedHosts().map(h => `http://${h}`).includes(origin) || req.headers['x-workspace-app'] !== '1') {
          return send(res, 403, 'Forbidden origin');
        }
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const headers = { 'Content-Type': type };
        if (file === 'index.html') headers['Content-Security-Policy'] = PAGE_CSP;
        return send(res, 200, readFileSync(join(uiDir, file)), headers);
      }

      if (req.method === 'GET' && url.pathname === '/img') {
        const rel = String(url.searchParams.get('path') || '');
        const full = resolve(root, rel);
        const type = contentTypeFor(full);
        if (!type || !isInside(join(root, 'inbox'), full) || !isFile(full)) throw new HttpError(404, 'image not found');
        return send(res, 200, readFileSync(full), {
          'Content-Type': type,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'private, max-age=300',
        });
      }

      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return send(res, 404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError || e.status ? e.status : 500;
      if (!res.headersSent) json(res, status, { ok: false, error: e.message || String(e) });
      else res.end();
    }
  };
}
