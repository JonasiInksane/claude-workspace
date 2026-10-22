// Request lookups shared by the route modules: the project, agent, flow, image target or asset
// project a request names, checked against the workspace, or an HttpError (404 or 400). Routes
// never take a path from the page; they pass names through these.
//
// LAUNCHABLE: the folder names the app will start terminals in. Others still show, with a hint
// to start them from a terminal; launchableOrThrow() is the one place that refuses them.
import { listAgents, resolveProject } from '../lib/agents.mjs';
import { getFlow } from '../lib/flows.mjs';
import { resolveTarget } from './uploads.mjs';
import { assetProjects } from './assets.mjs';
import { HttpError } from './http.mjs';

export const LAUNCHABLE = /^[\w .()-]+$/;
export const isLaunchable = name => LAUNCHABLE.test(String(name || ''));

// Throws unless the app may start a terminal in this project folder.
export function launchableOrThrow(project) {
  if (!isLaunchable(project)) throw new HttpError(400, `start ${project} from a terminal (its folder name has unusual characters)`);
  return project;
}

// The project folder's real spelling (names match without case).
export function findProject(root, projectName) {
  const { name, error } = resolveProject(root, projectName);
  if (error) throw new HttpError(404, error);
  return name;
}

// The agent a request names, checked: existing project and a valid agent name. With
// `isolated`, the agent must also have memory of its own (memory: project or local). `file`
// (its path inside .claude/agents/) picks one of two files that share a name.
export function findAgent(root, projectName, agentName, { isolated = false, file = '' } = {}) {
  const project = findProject(root, projectName);
  const agent = listAgents(root, project).find(a => a.name === agentName && (!file || a.rel === file));
  if (!agent || !agent.valid) throw new HttpError(404, `projects/${project} has no usable agent "${agentName}"`);
  if (isolated && !agent.isolated) throw new HttpError(400, `${agent.name} has no "memory: project", so it has no memory of its own`);
  return { project, agent };
}

export function flowOrThrow(root, slug) {
  const f = getFlow(root, String(slug || ''));
  if (!f) throw new HttpError(404, `there is no flow "${slug}"`);
  return f;
}

// An image target ({ hub }, { project, agent } or { flow }) with its folder; see uploads.mjs.
export function targetOrThrow(root, query) {
  const t = resolveTarget(root, query);
  if (t.error) throw new HttpError(404, t.error);
  return t;
}

// A project with the asset pipeline (projects/<p>/tools/asset.mjs and assets/), checked.
export function assetProjectOrThrow(root, projectName) {
  const name = findProject(root, projectName);
  if (!assetProjects(root).includes(name)) throw new HttpError(404, `projects/${name} has no asset pipeline`);
  return name;
}
