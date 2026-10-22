// Flows (flows/<slug>.md, read and written by tools/lib/flows.mjs): read one with its images,
// create or save one (with a hash against stale saves), caption an image, preview or run it,
// archive and restore. A run is checked again at run time, not trusted from the page's list; a
// flow with a required question (askRequired) does not start without an answer, and a linked
// project starts in its checkout's real folder.
import { basename, sep } from 'node:path';
import {
  archiveFlow, checkFlow, checkRunNotes, flowImages, flowImagesDir, flowLaunch, getFlow, LIMITS as FLOW_LIMITS, readCaptions,
  restoreFlow, runPrompt, saveFlow, setCaption, skippedFlowImages,
} from '../../lib/flows.mjs';
import { realProjectDir } from '../../lib/projects.mjs';
import { HttpError, readJson } from '../http.mjs';
import { flowOrThrow, launchableOrThrow } from '../lookup.mjs';

export function routes({ root, actions }) {
  return {
    // The flow, plus its images in run order (Image 1 first) with their captions.
    'GET /api/flow': async (req, res, url) => {
      const f = flowOrThrow(root, Object.fromEntries(url.searchParams).slug);
      const { file, ...flow } = f;
      const captions = readCaptions(root, f.slug);
      const images = flowImages(root, f.slug).map(abs => ({
        name: basename(abs), path: abs.slice(root.length + 1).split(sep).join('/'), caption: captions[basename(abs)] || '',
      }));
      return {
        ok: true, ...flow, path: `flows/${f.slug}.md`, imageDir: flowImagesDir(root, f.slug), images, skipped: skippedFlowImages(root, f.slug),
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
    // `ask` or `askRequired` keeps the stored value: an editor that doesn't know the question
    // (older than it) must not quietly remove it. A stale hash is still refused by saveFlow.
    'POST /api/flows': async req => {
      const b = await readJson(req);
      const fields = {
        title: b.title, description: b.description, target: b.target, project: b.project, agent: b.agent, prompt: b.prompt,
        permissionMode: b.permissionMode, model: b.model, effort: b.effort, allowedTools: b.allowedTools,
        ask: b.ask, askRequired: b.askRequired,
      };
      const stored = b.slug ? getFlow(root, String(b.slug)) : null; // none: saveFlow says so (400)
      if (stored && !('ask' in b)) fields.ask = stored.ask;
      if (stored && !('askRequired' in b)) fields.askRequired = stored.askRequired;
      const r = saveFlow(root, fields, { slug: b.slug ? String(b.slug) : '', baseHash: String(b.hash || '') });
      if (r.error) throw new HttpError(r.conflict ? 409 : 400, r.error);
      return { ok: true, slug: r.slug, hash: r.hash, message: b.slug ? 'Flow saved' : 'Flow created' };
    },

    // preview: true only returns the prompt the run would start with (also before the question is
    // answered; notesError then says what a real run would refuse).
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
      const prompt = runPrompt(f, images, notes, readCaptions(root, f.slug));
      const launch = flowLaunch(f);
      const notesError = checkRunNotes(f, notes);
      if (b.preview === true) return { ok: true, prompt, launch, notesError };
      if (notesError) throw new HttpError(400, notesError);
      const readDirs = images.length ? [flowImagesDir(root, f.slug)] : [];
      const title = `Flow: ${f.title || f.slug}`;
      if (f.target === 'hub') await actions.startClaude({ dir: root, title, prompt, readDirs, launch, kind: 'flow' });
      else if (f.target === 'project') {
        launchableOrThrow(f.project);
        await actions.startClaude({ dir: realProjectDir(root, f.project), title, prompt, readDirs, launch, kind: 'flow', project: f.project });
      } else {
        launchableOrThrow(f.project);
        await actions.startAgent({ project: f.project, agent: f.agent, title, prompt, readDirs, launch, kind: 'flow' });
      }
      return { ok: true, message: `Started ${f.title || f.slug}` };
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
