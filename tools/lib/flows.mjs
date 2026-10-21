// Flows: a saved prompt plus reference images, started with one click from the workspace app.
//
//   flows/<flow>.md                       the flow: frontmatter + the prompt (tracked in git)
//   flows/_archived/<flow>.md             archived flows (files kept; Restore brings them back)
//   inbox/attachments/_flows/<flow>/      its reference images (gitignored, never triaged)
//
// Frontmatter: title, description, target (hub | project | agent), project, agent. Values are
// written as JSON strings, which are valid YAML, so ": " or "#" in a title can't break the file.
// A run starts Claude at the target with the prompt, optional notes for that run and the image
// paths; the session may read the image folder without asking.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { duplicateNames, listAgents, readFrontmatter, resolveProject, textHash } from './agents.mjs';

export const FLOW_TARGETS = ['hub', 'project', 'agent'];
export const FLOW_IMAGES_DIR = '_flows';
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIMITS = { title: 120, description: 300, prompt: 16000, notes: 2000, images: 40 };

export const flowsDir = root => join(root, 'flows');
export const archivedFlowsDir = root => join(flowsDir(root), '_archived');
export const flowFile = (root, slug) => join(flowsDir(root), `${slug}.md`);
export const flowImagesDir = (root, slug) => join(root, 'inbox', 'attachments', FLOW_IMAGES_DIR, slug);

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// A file name for a new flow: kebab-case from the title, at most 50 characters.
export function slugify(title) {
  const s = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return s || 'flow';
}

export function parseFlow(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const fm = readFrontmatter(src) || {};
  const m = src.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  const prompt = (m ? src.slice(m[0].length) : src).replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return {
    title: fm.title || '', description: fm.description || '', target: fm.target || '',
    project: fm.project || '', agent: fm.agent || '', prompt,
  };
}

export function renderFlow(f) {
  const lines = ['---', `title: ${JSON.stringify(f.title)}`];
  if (f.description) lines.push(`description: ${JSON.stringify(f.description)}`);
  lines.push(`target: ${f.target}`);
  if (f.target !== 'hub') lines.push(`project: ${JSON.stringify(f.project)}`);
  if (f.target === 'agent') lines.push(`agent: ${JSON.stringify(f.agent)}`);
  lines.push('---', '', f.prompt.trim(), '');
  return lines.join('\n');
}

// Checks a flow's fields. Returns { error, flow }: `flow` is cleaned up (trimmed, the project's
// real spelling, no project/agent where the target doesn't use them).
export function checkFlow(root, input) {
  const s = k => String(input[k] ?? '').trim();
  const flow = {
    title: s('title').replace(/\s+/g, ' '), description: s('description').replace(/\s+/g, ' '),
    target: s('target'), project: '', agent: '', prompt: String(input.prompt ?? '').replace(/\r\n/g, '\n').trim(),
  };
  const bad = error => ({ error, flow });
  if (!flow.title) return bad('a title is required');
  for (const k of ['title', 'description', 'prompt']) {
    if (flow[k].length > LIMITS[k]) return bad(`the ${k} is longer than ${LIMITS[k]} characters`);
  }
  if (!flow.prompt) return bad('the prompt is empty');
  if (!FLOW_TARGETS.includes(flow.target)) return bad('target must be hub, project or agent');
  if (flow.target === 'hub') return { error: '', flow };
  const { name, error } = resolveProject(root, s('project'));
  if (error) return bad(error);
  flow.project = name;
  if (flow.target === 'project') return { error: '', flow };
  const agents = listAgents(root, name);
  const agent = agents.find(a => a.name === s('agent'));
  if (!agent || !agent.valid) return bad(`projects/${name} has no usable agent "${s('agent')}"`);
  if (!agent.isolated) return bad(`${agent.name} has no "memory: project", so it can't run isolated`);
  if (duplicateNames(agents).some(d => d.name === agent.name)) return bad(`${agent.name} is defined by more than one agent file`);
  flow.agent = agent.name;
  return { error: '', flow };
}

function readFlow(file, slug) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  return { slug, file, hash: textHash(text), ...parseFlow(text) };
}

// Every flow in flows/ (README.md and folders left out), with `error` when it can't run now
// (for example its agent was archived).
export function listFlows(root) {
  const out = [];
  for (const e of listDir(flowsDir(root))) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.toLowerCase() === 'readme.md') continue;
    const slug = e.name.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    const f = readFlow(join(flowsDir(root), e.name), slug);
    if (!f) continue;
    f.error = checkFlow(root, f).error;
    out.push(f);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
}

export function getFlow(root, slug) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  return readFlow(flowFile(root, slug), slug);
}

// Creates a flow (no slug) or updates one (slug + the hash of the text it was read as).
// Returns { error, conflict, slug, hash }.
export function saveFlow(root, input, { slug = '', baseHash = '' } = {}) {
  const { error, flow } = checkFlow(root, input);
  if (error) return { error };
  let file;
  if (slug) {
    const current = getFlow(root, slug);
    if (!current) return { error: `there is no flow "${slug}"` };
    if (current.hash !== baseHash) return { error: 'the flow changed on disk since you opened it. Close it and open it again.', conflict: true };
    file = current.file;
  } else {
    const base = slugify(flow.title);
    mkdirSync(flowsDir(root), { recursive: true });
    for (let i = 1; i < 100 && !file; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      // Archived flows keep their name, and so does a leftover image folder, so images never
      // end up with another flow.
      const taken = existsSync(flowFile(root, candidate)) || existsSync(join(archivedFlowsDir(root), `${candidate}.md`)) ||
        existsSync(flowImagesDir(root, candidate));
      if (!taken) {
        slug = candidate;
        file = flowFile(root, candidate);
      }
    }
    if (!file) return { error: 'too many flows with this title' };
  }
  const text = renderFlow(flow);
  writeFileSync(file, text, { encoding: 'utf8', flag: slug && existsSync(file) ? 'w' : 'wx' });
  return { error: '', slug, hash: textHash(text) };
}

// Images directly in the flow's image folder, oldest first (the order they were added).
export function flowImages(root, slug) {
  const dir = flowImagesDir(root, slug);
  const out = [];
  for (const e of listDir(dir)) {
    if (!e.isFile() || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(e.name)) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(join(dir, e.name)).mtimeMs; } catch { continue; }
    out.push({ file: join(dir, e.name), mtimeMs });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs).map(x => x.file);
}

// The prompt a run starts with: the flow's prompt, the run's notes, then the image paths.
export function runPrompt(flow, images, notes = '') {
  const parts = [flow.prompt.trim()];
  const n = String(notes || '').trim();
  if (n) parts.push(`Notes for this run:\n${n}`);
  if (images.length) {
    parts.push(`Reference images for this flow (read them before you start):\n${images.map(p => `- ${p}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// Moves flows/<slug>.md to flows/_archived/ (<slug>--2.md ... when taken). Images stay.
export function archiveFlow(root, slug) {
  const f = getFlow(root, slug);
  if (!f) return { error: `there is no flow "${slug}"` };
  mkdirSync(archivedFlowsDir(root), { recursive: true });
  for (let i = 1; i < 100; i++) {
    const target = join(archivedFlowsDir(root), i === 1 ? `${slug}.md` : `${slug}--${i}.md`);
    if (existsSync(target)) continue;
    renameSync(f.file, target);
    return { error: '' };
  }
  return { error: `too many archived copies of ${slug}` };
}

export function listArchivedFlows(root) {
  const out = [];
  for (const e of listDir(archivedFlowsDir(root))) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3).replace(/--\d+$/, '');
    if (!SLUG_RE.test(slug)) continue;
    const f = readFlow(join(archivedFlowsDir(root), e.name), slug);
    if (f) out.push({ archivedAs: e.name, slug, title: f.title || slug });
  }
  return out.sort((a, b) => a.archivedAs.localeCompare(b.archivedAs));
}

// Moves an archived flow back to flows/<slug>.md. Returns { error, slug }.
export function restoreFlow(root, archivedAs) {
  const entry = listArchivedFlows(root).find(a => a.archivedAs === archivedAs);
  if (!entry) return { error: `there is no archived flow "${archivedAs}"` };
  if (existsSync(flowFile(root, entry.slug))) return { error: `a flow named "${entry.slug}" already exists. Archive that one first.` };
  renameSync(join(archivedFlowsDir(root), entry.archivedAs), flowFile(root, entry.slug));
  return { error: '', slug: entry.slug };
}
