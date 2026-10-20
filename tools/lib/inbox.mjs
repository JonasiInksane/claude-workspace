// Inbox scanning, shared by the session-start hook, build-index and check-workspace, so they
// all agree on what counts as an item waiting for /inbox-triage.
//
//   inbox/<anything>                          triage item (the drop zone)
//   inbox/attachments/_hub/YYYY-MM-DD/        triage item (images that belong to no project)
//   inbox/attachments/YYYY-MM-DD/             triage item (older layout, still supported)
//   inbox/attachments/<project>/<agent>/...   agent image library, NOT a triage item
//   inbox/attachments/<project>/_shared/...   project image library, NOT a triage item
//   inbox/_processed/...                      archive, only counted
//
// <project> must be an existing folder in projects/. When a project folder goes away, its
// images become triage items again, so they are never silently forgotten.
// Not items: README.md files, dotfiles and dot-folders (.gitkeep), OS clutter (Thumbs.db,
// desktop.ini, .DS_Store), node_modules/, dist/ and build/ folders, and _processed/ folders at
// any depth (only the top-level one is counted).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listAgents, SHARED_DIR } from './agents.mjs';

export const CLUTTER = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
// Same build-output names the navigator tree skips, so every listed item has a page there.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
export const LIMITS = { maxDepth: 8, maxItems: 5000, maxLibraryFiles: 100000 };

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Folder names in projects/ that can own attachments (lowercase -> real name). Linked folders
// (symlinks, junctions) count, like everywhere else in the workspace.
export function projectNameMap(root) {
  const map = new Map();
  const base = join(root, 'projects');
  for (const e of listDir(base) || []) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.isDirectory() || (e.isSymbolicLink() && isDir(join(base, e.name)))) map.set(e.name.toLowerCase(), e.name);
  }
  return map;
}

// What a file at inbox/<parts...> is. `parts` are the path segments below inbox/.
// Returns { kind: 'item' } or { kind: 'library', project, folder, agent }: `project` is the
// project's real name, `folder` the attachments folder as spelled on disk, `agent` '' for a
// file directly in attachments/<project>/.
export function classify(parts, projects) {
  if (parts.length >= 3 && parts[0].toLowerCase() === 'attachments') {
    const project = projects.get(parts[1].toLowerCase());
    if (project) return { kind: 'library', project, folder: parts[1], agent: parts.length >= 4 ? parts[2] : '' };
  }
  return { kind: 'item' };
}

// Walks inbox/. Returns:
//   exists     inbox/ is there
//   items      triage items: { path ('inbox/...'), parts, size, mtimeMs }, newest first
//   libraries  one entry per image library folder: { project, agent, files, latestMs, known, path }
//              known = the agent is defined in the project (always true for _shared);
//              path uses the folder names as spelled on disk
//   processed  number of files in inbox/_processed/
//   truncated  part of the inbox was not scanned (too deep, or over a limit)
// Library files have their own, larger limit, so a big image library can't hide triage items.
// Throws only when inbox/ exists but cannot be read.
export function scanInbox(root, limits = {}) {
  const { maxDepth, maxItems, maxLibraryFiles } = { ...LIMITS, ...limits };
  const base = join(root, 'inbox');
  const out = { exists: false, items: [], libraries: [], processed: 0, truncated: false };
  const top = listDir(base);
  if (top === null) {
    try { statSync(base); } catch { return out; } // no inbox/ folder
    throw new Error('inbox/ could not be read');
  }
  out.exists = true;
  const projects = projectNameMap(root);
  const libs = new Map();
  let libraryFiles = 0;

  const countProcessed = (dir, depth) => {
    for (const e of listDir(dir) || []) {
      if (e.name.startsWith('.') || CLUTTER.has(e.name.toLowerCase())) continue;
      if (e.isDirectory()) { if (depth < maxDepth) countProcessed(join(dir, e.name), depth + 1); }
      else if (e.isFile()) out.processed++;
    }
  };

  const visit = (dir, parts, entries) => {
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (e.name.startsWith('.') || CLUTTER.has(lower)) continue;
      const full = join(dir, e.name);
      const next = [...parts, e.name];
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(lower)) continue;
        if (lower === '_processed') { if (!parts.length) countProcessed(full, 0); continue; }
        if (next.length > maxDepth) { out.truncated = true; continue; }
        visit(full, next, listDir(full) || []);
        continue;
      }
      if (!e.isFile() || lower === 'readme.md') continue;
      const c = classify(next, projects);
      if (c.kind === 'library') {
        if (++libraryFiles > maxLibraryFiles) { out.truncated = true; continue; }
        let mtimeMs = 0;
        try { mtimeMs = statSync(full).mtimeMs; } catch { /* keep 0 */ }
        const key = `${c.folder.toLowerCase()}/${c.agent.toLowerCase()}`;
        const lib = libs.get(key) || { project: c.project, folder: c.folder, agent: c.agent, files: 0, latestMs: 0 };
        lib.files++;
        lib.latestMs = Math.max(lib.latestMs, mtimeMs);
        libs.set(key, lib);
        continue;
      }
      if (out.items.length >= maxItems) { out.truncated = true; continue; }
      let st = null;
      try { st = statSync(full); } catch { continue; }
      out.items.push({ path: ['inbox', ...next].join('/'), parts: next, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  visit(base, [], top);

  const agentsOf = new Map();
  for (const lib of libs.values()) {
    if (!agentsOf.has(lib.project)) {
      agentsOf.set(lib.project, new Set(listAgents(root, lib.project).map(a => a.name.toLowerCase())));
    }
    const agent = lib.agent.toLowerCase();
    lib.known = agent === SHARED_DIR || agentsOf.get(lib.project).has(agent);
    lib.path = ['inbox', 'attachments', lib.folder, lib.agent].filter(Boolean).join('/');
    delete lib.folder;
    out.libraries.push(lib);
  }
  out.libraries.sort((a, b) => a.project.localeCompare(b.project) || a.agent.localeCompare(b.agent));
  out.items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
