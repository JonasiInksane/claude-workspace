// Project types (hub spec plan A1): what kind of project a folder in projects/ is, and so which
// tabs its page in the app shows (#project/<name>/<tab>, ui/views/project.js). The registry is
// ordered: projectTypeOf() returns the first type whose matches() is true, and `generic` matches
// every project, so it stays last.
//
//   code     the project has a private profile (<dataDir>/profiles/<name>.json), so runs, checks,
//            findings and the architecture probes work for it
//   assets   the project has an asset pipeline (assets.mjs assetProjects(): tools/asset.mjs or
//            tools/sprite.mjs plus an assets/ folder), like game-dev
//   generic  everything else
//
// A type is { id, label, tabs, matches(ctx) } with ctx = { root, dataDir, name } and, optionally,
// assetProjects (the list assetProjects(root) returned; state.mjs passes the one it already read,
// so the folders are scanned once per state build). `tabs` are the ids of the page's tab modules,
// in order; the first one is the tab a link without a tab opens.
//
// Adding a type is one entry here (before `generic`) plus, for every tab no type had before, a
// module ui/views/project/<tab>.js listed in ui/views/project/tabs.js. project-types.test.mjs
// checks that every tab named here has its module.
import { existsSync } from 'node:fs';
import { assetProjects } from './assets.mjs';
import { PROJECT_RE, projectPaths } from './core/datadir.mjs';

// True when the data folder holds a profile for this project (a name the data folder accepts).
export function hasProfile(dataDir, name) {
  if (!dataDir || !PROJECT_RE.test(String(name ?? ''))) return false;
  try { return existsSync(projectPaths(dataDir, name).profile); } catch { return false; }
}

// True when the project's folder has an asset pipeline. Folder names match as spelled.
export function hasAssetPipeline({ root, name, assetProjects: list = null }) {
  if (typeof name !== 'string' || !name) return false;
  const projects = Array.isArray(list) ? list : root ? assetProjects(root) : [];
  return projects.includes(name);
}

const type = (id, label, tabs, matches) => Object.freeze({ id, label, tabs: Object.freeze([...tabs]), matches });

export const PROJECT_TYPES = Object.freeze([
  type('code', 'Code project', ['overview', 'tasks', 'findings', 'changes', 'checks', 'architecture', 'assets', 'settings'],
    ctx => hasProfile(ctx.dataDir, ctx.name)),
  type('assets', 'Asset pipeline', ['overview', 'assets', 'agents', 'settings'], ctx => hasAssetPipeline(ctx)),
  type('generic', 'Plain project', ['overview', 'agents', 'assets', 'settings'], () => true),
]);

export const typeById = id => PROJECT_TYPES.find(t => t.id === id) || null;

// The first type that matches; `generic` when none does (or the context is unusable).
export function projectTypeOf(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  for (const t of PROJECT_TYPES) {
    let yes = false;
    try { yes = !!t.matches(c); } catch { yes = false; }
    if (yes) return t;
  }
  return PROJECT_TYPES[PROJECT_TYPES.length - 1];
}

// What /api/state sends about a project's type: { type: { id, label }, tabs: [ids] }.
export function typeFields(t) {
  return { type: { id: t.id, label: t.label }, tabs: [...t.tabs] };
}
