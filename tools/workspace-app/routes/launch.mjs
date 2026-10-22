// Starting Claude (hub, project, isolated agent) and opening places (Explorer or the editor).
// The real work is in `actions` (launch.mjs; tests pass a recorder). Every place is named, not
// passed as a path: the hub, the inbox, a project, an image target, an agent's memory or file,
// a report folder, or the navigator. A linked project starts in its checkout's real folder
// (tools/lib/projects.mjs realProjectDir).
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { duplicateNames, listAgents } from '../../lib/agents.mjs';
import { realProjectDir } from '../../lib/projects.mjs';
import { isInside } from '../uploads.mjs';
import { HttpError, readJson } from '../http.mjs';
import { findAgent, findProject, launchableOrThrow, targetOrThrow } from '../lookup.mjs';
import { readReports } from '../state.mjs';

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function routes({ root, actions }) {
  return {
    // { kind: 'hub' | 'project' | 'agent', project?, agent?, continueLast? }
    'POST /api/launch': async req => {
      const b = await readJson(req);
      if (b.kind === 'hub') {
        await actions.startClaude({ dir: root, title: 'Workspace hub', continueLast: !!b.continueLast, kind: 'hub' });
        return { ok: true, message: b.continueLast ? 'Continuing the last hub session' : 'Started Claude in the hub' };
      }
      if (b.kind === 'project') {
        const project = launchableOrThrow(findProject(root, b.project));
        await actions.startClaude({ dir: realProjectDir(root, project), title: project, continueLast: !!b.continueLast, kind: 'project', project });
        return { ok: true, message: `${b.continueLast ? 'Continuing' : 'Started'} Claude in ${project}` };
      }
      if (b.kind === 'agent') {
        const { project, agent } = findAgent(root, b.project, b.agent);
        if (!agent.isolated) throw new HttpError(400, `${agent.name} has no "memory: project", so it can't run isolated`);
        // agent-session.mjs refuses these too, but only inside the new terminal.
        if (duplicateNames(listAgents(root, project)).some(d => d.name === agent.name)) {
          throw new HttpError(400, `${agent.name} is defined by more than one agent file; rename one first`);
        }
        launchableOrThrow(project);
        await actions.startAgent({ project, agent: agent.name, title: `${project}: ${agent.name}` });
        return { ok: true, message: `Started ${agent.name} in ${project}` };
      }
      throw new HttpError(400, 'kind must be hub, project or agent');
    },

    // { place, with?: 'editor', ...what the place needs }
    'POST /api/open': async req => {
      const b = await readJson(req);
      let dir;
      if (b.place === 'hub') dir = root;
      else if (b.place === 'inbox') dir = join(root, 'inbox');
      else if (b.place === 'project') dir = realProjectDir(root, findProject(root, b.project));
      else if (b.place === 'images') { dir = targetOrThrow(root, b).dir; mkdirSync(dir, { recursive: true }); }
      else if (b.place === 'memory') { dir = findAgent(root, b.project, b.agent, { isolated: true }).agent.memoryDir; mkdirSync(dir, { recursive: true }); }
      else if (b.place === 'agent') {
        // The agent's file: in the editor it opens the file itself, in Explorer its folder.
        const { agent } = findAgent(root, b.project, b.agent, { file: String(b.file || '') });
        dir = b.with === 'editor' ? agent.file : dirname(agent.file);
      }
      else if (b.place === 'report') {
        const r = readReports(root).find(x => x.id === b.report);
        if (!r) throw new HttpError(404, 'report not found');
        dir = resolve(root, String(r.folder || `reports/${r.id}`));
        if (!isInside(join(root, 'reports'), dir) || !isDir(dir)) throw new HttpError(404, 'report folder not found');
      } else if (b.place === 'navigator') {
        await actions.openNavigator();
        return { ok: true, message: 'Rebuilt and opened the navigator' };
      } else throw new HttpError(400, 'unknown place');
      if (b.with === 'editor') {
        if (!['hub', 'project', 'agent'].includes(b.place)) throw new HttpError(400, 'only the hub, a project or an agent file opens in the editor');
        await actions.openEditor({ path: dir });
        return { ok: true, message: 'Opened in the editor' };
      }
      await actions.openFolder({ dir });
      return { ok: true, message: 'Opened in Explorer' };
    },
  };
}
