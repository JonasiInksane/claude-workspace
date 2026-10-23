// Flows (flows/<slug>.md, read and written by tools/lib/flows.mjs): read one with its images,
// create or save one (with a hash against stale saves), caption an image, preview or run it,
// archive and restore, and list its recent launches. A run is checked again at run time, not
// trusted from the page's list; a flow with a required question (askRequired) does not start
// without an answer, and a linked project starts in its checkout's real folder.
//
// Where a run starts: a flow for any project (project "*") needs the request's `project`, a
// known project the app can start in; a flow with a fixed project (or the hub) refuses another
// one. Every launch that started appends its record, with the flow's version and the exact asset
// versions it got, to <dataDir>/flow-runs.jsonl (flow-versions.mjs); a refused or failed launch
// writes nothing.
//
// Assets: a run gets the flow's own attached assets (its `assets` field) and, in a project, the
// ones the project's settings attach, resolved to exact versions (attached-assets.mjs). They are
// listed in the prompt after the images ('Asset 1: <ref> v<n> (<kind>) at <path>, titled "<title>"'), and
// the session may read their folders, as it reads the image folder, but not edit them (launch.mjs
// sessionDirs). An asset, version or file
// that is gone refuses the run (400), and so does a file that no longer matches its recorded
// SHA-256 (409). The preview shows the effective launch: the project's defaults, tools and rules
// added (launch.mjs withProjectSettings), and the assets with what a run would refuse.
import { basename, sep } from 'node:path';
import {
  archiveFlow, checkFlow, checkRunNotes, flowImages, flowImagesDir, flowLaunch, getFlow, isAnyProject, LIMITS as FLOW_LIMITS,
  parseFlowAssets, readCaptions, restoreFlow, runPrompt, saveFlow, setCaption, skippedFlowImages, SLUG_RE,
} from '../../lib/flows.mjs';
import { realProjectDir } from '../../lib/projects.mjs';
import { assetLine, assetProblems, assetRecords, resolveAssets, verifyFiles } from '../attached-assets.mjs';
import { allDone } from '../core/git.mjs';
import { flowVersion, readFlowRuns, recordFlowRun, versionChanges } from '../flow-versions.mjs';
import { HttpError, readJson } from '../http.mjs';
import { sessionSettings, withProjectSettings } from '../launch.mjs';
import { findProject, flowOrThrow, launchableOrThrow } from '../lookup.mjs';
import { settingsRef } from '../project-settings.mjs';

// The project a run of the checked flow `f` starts in ('' for the hub). `requested` is the
// request's project: required for a flow for any project (a known project, its real spelling),
// otherwise only allowed when it names the flow's own project (folder names match without case,
// like everywhere in the workspace). Whether the app may start a terminal there is checked by
// the caller, for every target.
export function runProject(root, f, requested) {
  if (requested != null && typeof requested !== 'string') throw new HttpError(400, 'project must be a project name');
  const name = f.title || f.slug;
  const asked = String(requested ?? '').trim();
  if (isAnyProject(f)) {
    if (!asked) throw new HttpError(400, `${name} runs in any project: choose the project to run it in`);
    return findProject(root, asked);
  }
  if (!asked) return f.project;
  if (f.target === 'hub') throw new HttpError(400, `${name} runs in the hub, not in ${asked}`);
  if (asked.toLowerCase() !== f.project.toLowerCase()) throw new HttpError(400, `${name} runs in ${f.project}, not in ${asked}`);
  return f.project;
}

export function routes({ root, actions, dataDir }) {
  // The assets a run of the checked flow `f` in `project` ('' for the hub) gets: the flow's own,
  // then those its project's settings attach, each ref once (the flow's pin wins), resolved.
  const resolveRunAssets = (f, project, settings) => resolveAssets(root, f.target === 'hub' ? '' : project,
    [...parseFlowAssets(f.assets).list, ...((settings && Array.isArray(settings.assets)) ? settings.assets : [])]);

  // What a run of `f` gets of its project: the settings (undefined for the hub, null for none)
  // and the resolved assets, every file checked against its recorded SHA-256. Throws 400 for
  // settings that can't be read or an asset that is gone, 409 for a file that changed.
  async function runInputs(f, project) {
    const name = f.title || f.slug;
    let settings;
    try { settings = await sessionSettings(dataDir, 'flow', f.target === 'hub' ? '' : project); } catch (e) {
      throw new HttpError(400, `${name} can't start: ${e.message}`);
    }
    const assets = await resolveRunAssets(f, project, settings);
    const gone = assetProblems(assets);
    if (gone.length) throw new HttpError(400, `${name} can't start: ${gone.join('; ')}`);
    const changed = await verifyFiles(assets);
    if (changed.length) throw new HttpError(409, `${name} can't start: ${changed.join('; ')}`);
    return { settings, assets };
  }

  // The preview of a run (POST /api/flows/run with preview): the prompt with the assets a run
  // would list, the effective launch (the project's defaults, tools and rules added), and in
  // `problems` what a run would refuse. A flow for any project shows its project's part once
  // `requested` names one. Nothing is started or written.
  async function previewRun(f, { images, captions, notes, notesError, launch, requested }) {
    const out = { ok: true, notesError, launch, prompt: '', project: '', projectSettings: null, assets: [], problems: [], note: '' };
    let project = '';
    if (f.target !== 'hub') {
      if (isAnyProject(f) && !String(requested ?? '').trim()) out.note = 'Choose a project to see its settings and attached assets.';
      else project = runProject(root, f, requested);
    }
    let settings;
    try { settings = await sessionSettings(dataDir, 'flow', project); } catch (e) { out.problems.push(e.message); }
    let items = [];
    try { items = await resolveRunAssets(f, project, settings); } catch (e) { out.problems.push(e.message); }
    out.problems.push(...assetProblems(items));
    const usable = items.filter(i => !i.missing);
    out.prompt = runPrompt(f, images, notes, captions, usable.map((a, i) => assetLine(a, i)));
    try { out.launch = withProjectSettings(launch, settings); } catch (e) { out.problems.push(e.message); }
    out.project = project;
    out.projectSettings = settings ? settingsRef(settings) : null;
    out.assets = items.map(i => ({ ref: i.ref, pin: i.pin, version: i.version, kind: i.kind, title: i.title, archived: !!i.archived, missing: !!i.missing }));
    return out;
  }

  return {
    // The flow, plus its images in run order (Image 1 first) with their captions, and its attached
    // assets as a list (assetList: [{ ref, pin }]).
    'GET /api/flow': async (req, res, url) => {
      const f = flowOrThrow(root, Object.fromEntries(url.searchParams).slug);
      const { file, ...flow } = f;
      const captions = readCaptions(root, f.slug);
      const images = flowImages(root, f.slug).map(abs => ({
        name: basename(abs), path: abs.slice(root.length + 1).split(sep).join('/'), caption: captions[basename(abs)] || '',
      }));
      return {
        ok: true, ...flow, path: `flows/${f.slug}.md`, imageDir: flowImagesDir(root, f.slug), images, skipped: skippedFlowImages(root, f.slug),
        assetList: parseFlowAssets(f.assets).list,
      };
    },

    'POST /api/flows/caption': async req => {
      const b = await readJson(req);
      const f = flowOrThrow(root, b.slug);
      const r = setCaption(root, f.slug, String(b.image || ''), b.caption);
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, message: 'Caption saved' };
    },

    // Creates a flow (no slug) or saves one (slug + the hash it was opened with). Saving without
    // `ask`, `askRequired` or `assets` keeps the stored value: an editor that doesn't know the
    // field (older than it) must not quietly remove it. A stale hash is still refused by saveFlow.
    'POST /api/flows': async req => {
      const b = await readJson(req);
      const fields = {
        title: b.title, description: b.description, target: b.target, project: b.project, agent: b.agent, prompt: b.prompt,
        permissionMode: b.permissionMode, model: b.model, effort: b.effort, allowedTools: b.allowedTools,
        ask: b.ask, askRequired: b.askRequired, assets: b.assets,
      };
      if (fields.assets !== undefined && fields.assets !== null && typeof fields.assets !== 'string') throw new HttpError(400, 'assets must be text such as "shared:style-guide, example:palette@2"');
      const stored = b.slug ? getFlow(root, String(b.slug)) : null; // none: saveFlow says so (400)
      if (stored && !('ask' in b)) fields.ask = stored.ask;
      if (stored && !('askRequired' in b)) fields.askRequired = stored.askRequired;
      if (stored && !('assets' in b)) fields.assets = stored.assets;
      const r = saveFlow(root, fields, { slug: b.slug ? String(b.slug) : '', baseHash: String(b.hash || '') });
      if (r.error) throw new HttpError(r.conflict ? 409 : 400, r.error);
      return { ok: true, slug: r.slug, hash: r.hash, message: b.slug ? 'Flow saved' : 'Flow created' };
    },

    // preview: true only returns what the run would start with (previewRun), also before the
    // question is answered (notesError then says what a real run would refuse). A flow for any
    // project previews without a project until the request names one. A run takes `project`
    // (see runProject).
    'POST /api/flows/run': async req => {
      const b = await readJson(req);
      const stored = flowOrThrow(root, b.slug);
      // Checked now, not trusted from the list the page loaded: the agent may be archived
      // since, and the file may be edited by hand. `f` has the checked project and agent.
      const { error: runError, flow: f } = checkFlow(root, stored);
      if (runError) throw new HttpError(400, `${stored.title || stored.slug} can't run: ${runError}`);
      f.slug = stored.slug;
      const notes = String(b.notes || '').trim();
      if (notes.length > FLOW_LIMITS.notes) throw new HttpError(400, `the notes are longer than ${FLOW_LIMITS.notes} characters`);
      const images = flowImages(root, f.slug);
      if (images.length > FLOW_LIMITS.images) throw new HttpError(400, `a flow can pass at most ${FLOW_LIMITS.images} images; it has ${images.length}`);
      const captions = readCaptions(root, f.slug);
      const launch = flowLaunch(f);
      const notesError = checkRunNotes(f, notes);
      if (b.preview === true) return previewRun(f, { images, captions, notes, notesError, launch, requested: b.project });
      if (notesError) throw new HttpError(400, notesError);
      const project = runProject(root, f, b.project);
      if (f.target !== 'hub') launchableOrThrow(project);
      // A linked project starts in its checkout's real folder (404 when the link is broken).
      const dir = f.target === 'project' ? realProjectDir(root, project) : root;
      const { settings, assets } = await runInputs(f, project);
      const prompt = runPrompt(f, images, notes, captions, assets.map((a, i) => assetLine(a, i)));
      // The assets' folders are added by launch.mjs from `assets`, read-only (sessionDirs).
      const readDirs = images.length ? [flowImagesDir(root, f.slug)] : [];
      const title = `Flow: ${f.title || f.slug}`;
      // The version of the files this prompt was built from, taken before the terminal opens.
      const version = await flowVersion(root, f.slug);
      // The session lists no assets a second time; it records them, with the settings they came from.
      const session = { title, prompt, readDirs, launch, kind: 'flow', assets, settings };
      let started;
      if (f.target === 'hub') started = await actions.startClaude({ dir, ...session });
      else if (f.target === 'project') started = await actions.startClaude({ dir, ...session, project });
      else started = await actions.startAgent({ project, agent: f.agent, ...session });
      const sessionId = started && typeof started.sessionId === 'string' ? started.sessionId : '';
      let recorded = true;
      try {
        await recordFlowRun(dataDir, { flow: f.slug, version, target: f.target, project, agent: f.agent, sessionId, assets: assetRecords(assets) });
      } catch (e) {
        // Best effort, like sessions.jsonl: the session started, so the run still counts as started;
        // the message says that its version wasn't recorded.
        recorded = false;
        console.error(`workspace-app: could not record the run of flow ${f.slug}: ${e.message}`);
      }
      const where = isAnyProject(f) ? ` in ${project}` : '';
      const note = recorded ? '' : "; its version could not be recorded (the app's log says why)";
      return { ok: true, message: `Started ${f.title || f.slug}${where}${note}`, project, sessionId, recorded };
    },

    // The newest launches of one flow (at most 20, newest first), each with `changes`: what is
    // different in the flow now ([] for nothing; see flow-versions.mjs versionChanges). `current`
    // is the flow's version now, null once its file is gone (archived); its records stay.
    'GET /api/flow-runs': async (req, res, url) => {
      const slug = String(url.searchParams.get('flow') || '');
      if (!SLUG_RE.test(slug)) throw new HttpError(400, `"${slug.slice(0, 80)}" is not a flow name`);
      // allDone: a failed read still waits for flowVersion's git calls to finish.
      const [current, runs] = await allDone([flowVersion(root, slug), readFlowRuns(dataDir, slug)]);
      return { ok: true, flow: slug, current, runs: runs.map(r => ({ ...r, changes: versionChanges(r.version, current) })) };
    },

    'POST /api/flows/archive': async req => {
      const b = await readJson(req);
      const f = flowOrThrow(root, b.slug);
      const r = archiveFlow(root, f.slug);
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, message: `Archived ${f.title || f.slug}. Its images stay; Restore brings it back.` };
    },

    'POST /api/flows/restore': async req => {
      const b = await readJson(req);
      const r = restoreFlow(root, String(b.archivedAs || ''));
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, message: 'Flow restored' };
    },
  };
}
