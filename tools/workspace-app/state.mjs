// Everything the page shows, in one object: GET /api/state answers with buildState().
//
// It must not block the server: the slow parts (git remotes, git lfs) run as async child
// processes through tools/lib/repos.mjs, which caches each project's origin for a few seconds.
// The rest is small synchronous file reads. Requests that arrive while a build is running share
// that build; invalidateState() (app.mjs calls it after every POST) makes the next request start
// a fresh one, so a refresh right after a change always sees it.
//
// Runs (SPEC 4): each project gets linked and realPath (a junction to a checkout elsewhere, and
// where Claude and git run), hasProfile (dataDir/profiles/<name>.json exists), profileLabel (that
// profile's label, the only field read from it) and its counts of
// waiting and running runs; the top level gets runs: { waiting, running, atReviewGate }. The
// counts come from the runs index (runs/store.mjs listRuns) through a summary cached for 2 s per
// data folder, so a page that polls state doesn't reread the index on every call.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { duplicateNames, listAgents, listArchivedAgents, projectDir, SHARED_DIR } from '../lib/agents.mjs';
import { projectNameMap, scanInbox } from '../lib/inbox.mjs';
import { detectProjectType, typeLabel } from '../lib/project-type.mjs';
import { readRepos, repoStatusAsync, requirementStatusAsync, unlistedProjectsAsync } from '../lib/repos.mjs';
import { flowImages, flowLaunch, listArchivedFlows, listFlows } from '../lib/flows.mjs';
import { catalogForUi } from './catalog.mjs';
import { contentTypeFor, localDate } from './uploads.mjs';
import { assetProjects, listAssets } from './assets.mjs';
import { isLaunchable } from './lookup.mjs';
import { isLinked, realProjectDir } from '../lib/projects.mjs';
import { defaultDataDir, PROJECT_RE } from './core/datadir.mjs';
import { listRuns } from './runs/store.mjs';

export const RUNS_CACHE_MS = 2000;
// Waiting kinds shown as their own nav items under Runs (at most 3).
const REVIEW_KINDS = ['review', 'commit'];
const MAX_REVIEW_ITEMS = 3;

// The entries of reports/reports.json ([] when it is missing or broken).
export function readReports(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, 'reports', 'reports.json'), 'utf8').trimStart());
    return (Array.isArray(data.reports) ? data.reports : []).filter(r => r && typeof r === 'object');
  } catch { return []; }
}

function countMd(dir) {
  try { return readdirSync(dir).filter(n => n.toLowerCase().endsWith('.md')).length; } catch { return 0; }
}

// The latest index line of every waiting or running run, summed up:
// { waiting, running, byProject: { <project>: { waiting, running } }, atReviewGate: [...] }.
async function readRunSummary(dataDir) {
  const out = { waiting: 0, running: 0, byProject: {}, atReviewGate: [] };
  let rows = [];
  try { rows = await listRuns(dataDir, { status: ['waiting', 'running'], limit: 500 }); } catch { rows = []; }
  for (const r of rows) {
    const key = r.status === 'waiting' ? 'waiting' : 'running';
    out[key]++;
    const p = out.byProject[r.project] || (out.byProject[r.project] = { waiting: 0, running: 0 });
    p[key]++;
    if (key === 'waiting' && REVIEW_KINDS.includes(r.waiting) && out.atReviewGate.length < MAX_REVIEW_ITEMS) {
      out.atReviewGate.push({ id: r.id, project: r.project, title: String(r.title || r.id), waiting: r.waiting });
    }
  }
  return out;
}

// readRunSummary, cached for RUNS_CACHE_MS per data folder; callers at the same time share it.
const runSummaries = new Map();
export function runSummary(dataDir, now = Date.now()) {
  const key = resolve(dataDir);
  const hit = runSummaries.get(key);
  if (hit && now - hit.at < RUNS_CACHE_MS) return hit.promise;
  const promise = readRunSummary(key);
  runSummaries.set(key, { at: now, promise });
  return promise;
}

// Where a project's checkout really is: { linked, realPath }. A link whose target is gone has
// realPath ''.
function placeOf(root, name, dir) {
  if (!isLinked(root, name)) return { linked: false, realPath: dir };
  try { return { linked: true, realPath: realProjectDir(root, name) }; } catch { return { linked: true, realPath: '' }; }
}

// The label a project's profile gives it ("Example"), or '' without a readable profile. Only that
// one field is read; the profile itself stays private.
function profileLabel(dataDir, name) {
  if (!PROJECT_RE.test(name)) return '';
  try {
    const label = JSON.parse(readFileSync(join(dataDir, 'profiles', `${name}.json`), 'utf8').replace(/^﻿/, '')).label;
    return typeof label === 'string' ? label.slice(0, 80) : '';
  } catch { return ''; }
}

function projectsState(root, libCount, dataDir, runs) {
  return [...projectNameMap(root).values()].sort((a, b) => a.localeCompare(b)).map(name => {
    const dir = projectDir(root, name);
    let label = 'Other';
    try { label = typeLabel(detectProjectType(dir)); } catch { /* keep Other */ }
    const all = listAgents(root, name);
    const dupes = new Set(duplicateNames(all).map(d => d.name));
    const agents = all.map(a => ({
      name: a.name,
      description: a.description,
      memory: a.memory,
      isolated: a.isolated,
      valid: a.valid,
      duplicate: dupes.has(a.name),
      file: a.rel,
      images: libCount.get(`${name}/${a.name.toLowerCase()}`) || 0,
      memoryFiles: a.valid ? countMd(a.memoryDir) : 0,
    }));
    const counts = runs.byProject[name] || { waiting: 0, running: 0 };
    return {
      name,
      label,
      ...placeOf(root, name, dir),
      hasProfile: PROJECT_RE.test(name) && existsSync(join(dataDir, 'profiles', `${name}.json`)),
      profileLabel: profileLabel(dataDir, name),
      waiting: counts.waiting,
      running: counts.running,
      hasClaudeMd: existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, '.claude', 'CLAUDE.md')),
      launchable: isLaunchable(name),
      sharedImages: libCount.get(`${name}/${SHARED_DIR}`) || 0,
      agents,
      archived: listArchivedAgents(root, name).map(a => ({ archivedAs: a.archivedAs, name: a.name, description: a.description, valid: a.valid })),
    };
  });
}

async function build(root, tools, dataDir) {
  // Started first, so git runs while the files below are read.
  const reposPending = Promise.all([repoStatusAsync(root), unlistedProjectsAsync(root), requirementStatusAsync()]);
  reposPending.catch(() => {}); // awaited below; this only keeps an early throw from leaving it unhandled
  const runs = await runSummary(dataDir);

  let inbox = { items: [], libraries: [], processed: 0, truncated: false, exists: false };
  let inboxError = '';
  try { inbox = scanInbox(root); } catch (e) { inboxError = e.message; }
  const libCount = new Map(inbox.libraries.map(l => [`${l.project}/${l.agent.toLowerCase()}`, l.files]));
  const projects = projectsState(root, libCount, dataDir, runs);

  const reports = readReports(root)
    .filter(r => r.status === 'active')
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
    .map(r => ({ id: String(r.id || ''), title: String(r.title || r.id || 'Untitled'), type: String(r.type || ''), project: r.project ? String(r.project) : '', updated: String(r.updated || '') }));

  const flows = listFlows(root).map(f => ({
    slug: f.slug, title: f.title, description: f.description, target: f.target, project: f.project, agent: f.agent,
    ask: f.ask || '', askRequired: !!f.askRequired,
    error: f.error, images: flowImages(root, f.slug).length, launch: f.error ? {} : flowLaunch(f),
  }));
  const archivedFlows = listArchivedFlows(root).map(f => ({ archivedAs: f.archivedAs, title: f.title }));
  const assets = assetProjects(root).map(project => ({ project, assets: listAssets(root, project) }));
  const [list, unlisted, have] = await reposPending;

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
    flows,
    archivedFlows,
    // linked: a junction for it exists, even when its target is gone (the page shows "link broken").
    repos: { error: readRepos(root).error, list: list.map(r => ({ ...r, linked: isLinked(root, r.name) })), unlisted, have },
    catalog: catalogForUi(),
    assets,
    runs: { waiting: runs.waiting, running: runs.running, atReviewGate: runs.atReviewGate },
  };
}

// The build in progress per workspace root; requests that come in meanwhile share it.
const running = new Map();

// Everything the UI shows. `tools` is actions.tools (which programs were found); `dataDir` is
// the private data folder the run counts and profiles come from.
export function buildState(root, tools = {}, { dataDir = defaultDataDir() } = {}) {
  root = resolve(root);
  if (!running.has(root)) {
    const p = build(root, tools, resolve(dataDir)).finally(() => { if (running.get(root) === p) running.delete(root); });
    running.set(root, p);
  }
  return running.get(root);
}

// The next buildState() starts fresh instead of joining a build that began before a change, and
// rereads the run counts.
export function invalidateState(root) {
  running.delete(resolve(root));
  runSummaries.clear();
}
