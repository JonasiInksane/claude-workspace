// Project settings and rules over HTTP; project-settings.mjs keeps them as numbered, immutable
// versions in the private data folder. The Settings tab of a project page uses these routes:
//
//   GET  /api/project-settings?project=<name>            { ok, project, current, versions, limits, choices }
//   GET  /api/project-settings/version?project=<name>&v=<n>   { ok, project, settings }
//   POST /api/project-settings  { project, basedOn, rules?, defaults?, allowedTools?, assets? }
//                                                        { ok, project, version, sha256, unchanged, message }
//
// The project must be a folder in projects/ (lookup.mjs; 404 otherwise) whose name the data
// folder can hold (PROJECT_RE; 400 otherwise). A save names the version it was opened at
// (basedOn; 0 or null when there were none): 409 when that is not the current one any more, 400
// listing every problem when a value is invalid. A field left out keeps its current value; a save
// that changes nothing writes nothing (unchanged: true). Settings that can't be read are a 500
// whose message names the file. A save may be larger than the 64 KB of other requests (see
// MAX_SAVE_BYTES).
import { EFFORTS, MAX_TOOL_RULES, PERMISSION_MODES } from '../../lib/prompt-file.mjs';
import { PROJECT_RE } from '../core/datadir.mjs';
import { HttpError, readBody } from '../http.mjs';
import { findProject } from '../lookup.mjs';
import {
  DEFAULT_KEYS, getSettingsVersion, readSettings, saveSettings, SETTINGS_FIELDS, SETTINGS_LIMITS,
} from '../project-settings.mjs';

const BODY_KEYS = ['project', 'basedOn', ...SETTINGS_FIELDS];
const VERSION_RE = /^[1-9][0-9]{0,8}$/;
// The body of the largest valid save, with room to spare: 20,000 characters of rules take up to
// 60,000 bytes in UTF-8 (more with JSON escapes), plus the tools and 50 asset refs. readJson's
// 64 KB would refuse some valid saves.
export const MAX_SAVE_BYTES = 256 * 1024;

async function readSave(req) {
  const buf = await readBody(req, MAX_SAVE_BYTES);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// The project a request names, by its folder's real spelling.
function settingsProject(root, name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name the project (project=<name>)');
  const project = findProject(root, name.trim());
  if (!PROJECT_RE.test(project)) {
    throw new HttpError(400, `projects/${project} can't have settings in the app: its folder name must be lowercase letters, digits and single hyphens`);
  }
  return project;
}

function versionOf(v) {
  if (!VERSION_RE.test(String(v ?? ''))) throw new HttpError(400, 'v must be a settings version, a number from 1');
  return Number(v);
}

export function routes({ root, dataDir }) {
  return {
    // The current settings (null when there are none) and every version, newest first; plus the
    // limits and choices the editor shows.
    'GET /api/project-settings': async (req, res, url) => {
      const project = settingsProject(root, url.searchParams.get('project'));
      const { current, versions } = await readSettings(dataDir, project);
      return {
        ok: true, project, current, versions,
        limits: { rules: SETTINGS_LIMITS.rules, assets: SETTINGS_LIMITS.assets, allowedTools: MAX_TOOL_RULES },
        choices: { defaults: [...DEFAULT_KEYS], effort: [...EFFORTS], permissionMode: [...PERMISSION_MODES] },
      };
    },

    // One version, for the history and the diff between two versions.
    'GET /api/project-settings/version': async (req, res, url) => {
      const project = settingsProject(root, url.searchParams.get('project'));
      return { ok: true, project, settings: await getSettingsVersion(dataDir, project, versionOf(url.searchParams.get('v'))) };
    },

    'POST /api/project-settings': async req => {
      const b = await readSave(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'send the settings as an object');
      const unknown = Object.keys(b).filter(k => !BODY_KEYS.includes(k));
      if (unknown.length) throw new HttpError(400, `"${unknown[0].slice(0, 60)}" is not a project setting (send ${BODY_KEYS.join(', ')})`);
      const project = settingsProject(root, b.project);
      const input = Object.fromEntries(SETTINGS_FIELDS.filter(k => k in b).map(k => [k, b[k]]));
      const saved = await saveSettings(dataDir, project, input, { basedOn: b.basedOn });
      const unchanged = saved.version === (b.basedOn || 0);
      return {
        ok: true, project, version: saved.version, sha256: saved.sha256, unchanged,
        message: unchanged ? `Nothing changed: v${saved.version} is current` : `Saved the settings of ${project} as v${saved.version}`,
      };
    },
  };
}
