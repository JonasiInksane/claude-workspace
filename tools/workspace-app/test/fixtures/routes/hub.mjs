// Test fixture for the W3 route modules (routes/{cockpit,checks,findings,metrics,settings,today}):
// a temporary hub with the synthetic "example" project as a git repo in projects/example, a data
// folder with its profile (pipelines/app/profiles/example.json plus overrides), a recorder for
// `actions` and a fake run engine. Handlers are called directly, as GUIDE.md shows: no server, no
// terminal, no claude. Everything lives under os.tmpdir() and is removed when the test ends.
//
//   const h = await routeHub(t, { profile: { ... } });
//   const api = routes(h.ctx, deps);
//   const r = await call(api, 'POST /api/checks', { body: { project: 'example' } });  // { status, body }
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../../http.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, runGit, tempDir, writeFiles } from '../../helpers.mjs';

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
export const EXAMPLE_URL = 'https://github.com/example-org/example.git';
export const EXAMPLE_PROFILE_TEXT = readFileSync(join(hubRoot, 'pipelines', 'app', 'profiles', 'example.json'), 'utf8');

// Git must not find a repo above the temp folder (this PC has a stray C:\.git).
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// A POST request as the handlers read it: a stream with a content-length header.
export function postReq(body) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
  return Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
}

// Calls a route like app.mjs does: { status, body }. A thrown HttpError (or an error with a
// status) becomes its status and { ok: false, error }; anything else is a 500.
export async function call(api, key, { body, query } = {}) {
  const [method, path] = key.split(' ');
  const handler = api[key];
  if (typeof handler !== 'function') throw new Error(`No route ${key}`);
  const url = new URL(`http://127.0.0.1${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  try {
    return { status: 200, body: await handler(method === 'POST' ? postReq(body) : null, null, url) };
  } catch (e) {
    return { status: e.status || 500, body: { ok: false, error: e.message } };
  }
}

// A stand-in for the run manager: records start() requests and answers with a run id, or throws
// `engine.fail` when a test sets it (an HttpError like the real manager's 400 and 409).
export function fakeEngine() {
  const engine = {
    starts: [],
    fail: null,
    async start(req) {
      engine.starts.push(structuredClone(req));
      if (engine.fail) throw engine.fail;
      return { runId: `261022-120000-${req.pipeline}-${engine.starts.length}`, run: { id: 'x' } };
    },
  };
  return engine;
}

export const busy409 = () => new HttpError(409, 'example-run is busy with Refactor: something. Park it or wait.');

// The hub: { root, dataDir, mainDir, ctx, calls, engine, git(args) }.
//   profile   overrides merged into the example profile (null: no profile file)
//   present   false: no projects/example folder (only listed in repos.json)
//   files     extra repo files committed with the first commit
export async function routeHub(t, { profile = {}, present = true, files = {} } = {}) {
  const base = tempDir('ws-rt-', t);
  const root = join(base, 'hub');
  const dataDir = join(base, 'data');
  writeFiles(root, {
    'projects/repos.json': { repos: [{ name: 'example', url: EXAMPLE_URL, requires: [] }] },
    'pipelines/app/profiles/example.json': EXAMPLE_PROFILE_TEXT,
  });
  const mainDir = join(root, 'projects', 'example');
  if (present) {
    await makeRepo(mainDir, { files: { ...exampleRepoFiles(), ...files } });
    await runGit(mainDir, ['remote', 'add', 'origin', EXAMPLE_URL]);
  }
  if (profile !== null) writeFiles(dataDir, { 'profiles/example.json': fakeProfile(profile) });
  const calls = [];
  const rec = name => async args => { calls.push({ name, ...args }); return {}; };
  const actions = { runInTerminal: rec('runInTerminal'), startClaude: rec('startClaude'), openFolder: rec('openFolder') };
  const engine = fakeEngine();
  const ctx = { root, dataDir, actions, getPort: () => 0, workspaceTag: '', getEngine: async () => engine };
  return { base, root, dataDir, mainDir, ctx, calls, engine, git: args => runGit(mainDir, args) };
}

// Deps for routes that probe ports and trust: nothing listens, the folder is trusted.
export const quietDeps = {
  ports: { anyListening: async () => [] },
  trustState: async path => ({ state: 'trusted', command: `cd '${path}'; claude` }),
};
