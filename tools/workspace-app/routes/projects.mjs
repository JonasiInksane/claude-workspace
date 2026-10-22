// Projects and repositories: create a project from a template (tools/new-project.mjs in a
// terminal), clone a listed repo or a checked URL (tools/projects.mjs clone in a terminal), list
// a project folder in projects/repos.json by its origin remote, and link or unlink an existing
// checkout that lives outside the hub (a junction in projects/; tools/lib/projects.mjs does the
// checks and never deletes a folder).
import { existsSync } from 'node:fs';
import { projectDir, resolveProject } from '../../lib/agents.mjs';
import { linkProject, unlinkProject } from '../../lib/projects.mjs';
import { addRepo, GIT_URL, NAME_RE as REPO_NAME_RE, nameFromUrl, originOfAsync, readRepos, REQUIREMENTS } from '../../lib/repos.mjs';
import { PROJECT_TYPES } from '../catalog.mjs';
import { HttpError, readJson } from '../http.mjs';
import { findProject } from '../lookup.mjs';

const PROJECT_NAME = REPO_NAME_RE; // what tools/new-project.mjs and tools/projects.mjs accept
const URL_ERROR = 'the git URL must start with https:// or git@ and contain no spaces or quotes';
const pickRequirements = list => (Array.isArray(list) ? list : []).map(String).filter(r => REQUIREMENTS.includes(r));
// The HTTP status for each refusal kind of linkProject and unlinkProject.
const LINK_STATUS = { invalid: 400, 'not-listed': 404, exists: 409, 'not-link': 400, missing: 404, failed: 500 };
const linkFailure = e => new HttpError(LINK_STATUS[e.code] || 500, e.message);

export function routes({ root, actions }) {
  return {
    // Clone a listed repo ({ name }) or any repo ({ url, name?, add?, requires? }), in a
    // terminal through tools/projects.mjs: plain git clone, no template files.
    'POST /api/repos/clone': async req => {
      const b = await readJson(req);
      let name;
      let args;
      if (b.url) {
        const url = String(b.url).trim();
        if (url.length > 500 || !GIT_URL.test(url)) throw new HttpError(400, URL_ERROR);
        name = String(b.name || '').trim() || nameFromUrl(url);
        if (!REPO_NAME_RE.test(name)) throw new HttpError(400, `"${name}" is not a kebab-case folder name. Use lowercase letters, digits and dashes.`);
        if (existsSync(projectDir(root, name)) || !resolveProject(root, name).error) throw new HttpError(400, `projects/${name} already exists`);
        if (b.add) {
          const r = addRepo(root, { name, url, requires: pickRequirements(b.requires) });
          if (r.error) throw new HttpError(400, r.error);
          args = ['clone', name];
        } else args = ['clone', '--url', url, '--name', name];
      } else {
        const entry = readRepos(root).repos.find(r => r.name === String(b.name || ''));
        if (!entry) throw new HttpError(404, `${b.name} is not in projects/repos.json`);
        name = entry.name;
        if (existsSync(projectDir(root, name))) throw new HttpError(400, `projects/${name} already exists`);
        args = ['clone', name];
      }
      await actions.cloneProject({ project: name, args });
      return { ok: true, message: `Cloning ${name} in a terminal${b.url && b.add ? ' (listed in projects/repos.json)' : ''}` };
    },

    // List a project folder in projects/repos.json by its origin remote.
    'POST /api/repos/add': async req => {
      const b = await readJson(req);
      const name = findProject(root, b.name);
      if (!REPO_NAME_RE.test(name)) throw new HttpError(400, `"${name}" is not a kebab-case folder name, so it can't be listed`);
      const url = await originOfAsync(projectDir(root, name));
      if (!url) throw new HttpError(400, `projects/${name} has no origin remote; push it to GitHub first`);
      const r = addRepo(root, { name, url, requires: pickRequirements(b.requires) });
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, message: `Listed ${name}. Commit and push the workspace so other PCs get it.` };
    },

    // { name, type, from? }: checked here, then made by tools/new-project.mjs in a terminal.
    'POST /api/projects': async req => {
      const b = await readJson(req);
      const name = String(b.name || '').trim();
      const type = String(b.type || '');
      const from = String(b.from || '').trim();
      if (!PROJECT_NAME.test(name)) throw new HttpError(400, `"${name}" is not kebab-case. Use lowercase letters, digits and dashes, for example my-app.`);
      if (!PROJECT_TYPES.includes(type)) throw new HttpError(400, `type must be ${PROJECT_TYPES.join(' or ')}`);
      if (from && (from.length > 500 || !GIT_URL.test(from))) throw new HttpError(400, URL_ERROR);
      if (existsSync(projectDir(root, name)) || !resolveProject(root, name).error) throw new HttpError(400, `projects/${name} already exists`);
      await actions.newProject({ project: name, type, from });
      return { ok: true, message: `${from ? 'Cloning' : 'Creating'} ${name} in a terminal` };
    },

    // { name, path }: links the checkout at `path` (absolute, local, outside the hub, the top of a
    // git checkout whose origin matches repos.json) as projects/<name>.
    'POST /api/projects/link': async req => {
      const b = await readJson(req);
      if (typeof b.name !== 'string' || typeof b.path !== 'string') throw new HttpError(400, 'send the project name and the folder path');
      let linked;
      try { linked = await linkProject(root, b.name.trim(), b.path); } catch (e) { throw linkFailure(e); }
      const name = b.name.trim();
      return {
        ok: true, message: `Linked projects/${name} to ${linked.realPath}. Your checkout stays where it is.`,
        project: { name, realPath: linked.realPath },
      };
    },

    // { name }: removes the link projects/<name> only; the checkout is not touched.
    'POST /api/projects/unlink': async req => {
      const b = await readJson(req);
      if (typeof b.name !== 'string') throw new HttpError(400, 'send the project name');
      try { unlinkProject(root, b.name.trim()); } catch (e) { throw linkFailure(e); }
      return { ok: true, message: `Removed the link projects/${b.name.trim()}. Your checkout was not touched.` };
    },
  };
}
