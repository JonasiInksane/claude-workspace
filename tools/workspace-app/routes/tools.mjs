// The Tools (Library) view's API: start a skill in a new terminal, or run a workspace tool here
// and return its output. The page sends only an id, form values and (for a skill) how the session
// starts; catalog.mjs builds every prompt and command line and checks each value.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realProjectDir } from '../../lib/projects.mjs';
import { commandArgs, skillLaunch } from '../catalog.mjs';
import { readJson } from '../http.mjs';
import { launchableOrThrow } from '../lookup.mjs';

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // the CLI tools this app runs
const asObject = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function routes({ root, actions }) {
  return {
    // { id, values, launch? }: starts Claude with /<id> <values> in the hub or the chosen project
    // (a linked project in its real folder). launch: { permissionMode, model, effort } overrides
    // the skill's defaults.
    'POST /api/skill': async req => {
      const b = await readJson(req);
      const s = skillLaunch(root, String(b.id || ''), asObject(b.values), asObject(b.launch));
      if (s.skill.where === 'project') {
        launchableOrThrow(s.project);
        await actions.startClaude({
          dir: realProjectDir(root, s.project), title: `${s.project}: /${s.skill.id}`, prompt: s.prompt, launch: s.launch,
          kind: 'skill', project: s.project,
        });
        return { ok: true, message: `Started /${s.skill.id} in ${s.project}` };
      }
      await actions.startClaude({ dir: root, title: `Hub: /${s.skill.id}`, prompt: s.prompt, launch: s.launch, kind: 'skill' });
      return { ok: true, message: `Started /${s.skill.id} in the hub` };
    },

    // { id, preview?, confirm? }: runs a COMMANDS entry and returns { status, output }.
    // (Called /api/run before the runs API took that name.)
    'POST /api/command': async req => {
      const b = await readJson(req);
      const { cmd, args } = commandArgs(String(b.id || ''), { preview: b.preview === true, confirm: b.confirm === true });
      const r = await actions.runTool({ args: [join(toolsDir, args[0]), ...args.slice(1)], cwd: root });
      return { ok: true, label: cmd.label, status: r.status, output: r.output };
    },
  };
}
