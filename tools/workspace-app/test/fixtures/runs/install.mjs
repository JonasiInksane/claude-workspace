// Loads the run fixtures (example/<run id>/, made by make.mjs) into a data folder, so the run
// views can be built and checked against every run status without running anything:
//
//   node tools/workspace-app/test/fixtures/runs/install.mjs <data folder>
//   $env:WS_APP_TEST = '1'
//   node tools/workspace-app/server.mjs --data-dir <data folder> --fake-claude
//
// It copies each fixture run to <data folder>/runs/example/<run id>/, adds its line to
// runs/index.jsonl, and writes profiles/example.json from the tracked example profile when there
// is none. It never overwrites a run that is already there, and refuses a folder inside the
// workspace (the fixtures are tracked; the data folder is not).
//
// The fixtures: 261022-100001 to -100015, one per run status (running, waiting at the plan,
// fence, review and triage gates, in-terminal, passed, failed, gates-red, capped, parked,
// cancelled, interrupted, paused-limit, committed). A server start runs recovery, which turns
// the "running" fixture into "interrupted" (its process is gone); start a run with
// `--fake-claude hang` to see a live one.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, writeJsonAtomic } from '../../../core/datadir.mjs';
import { exampleProfile } from '../../../profile/profile.mjs';
import { indexLine } from '../../../runs/store.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HUB = fileURLToPath(new URL('../../../../../', import.meta.url));
export const FIXTURES_DIR = join(HERE, 'example');
export const PROJECT = 'example';

// The fixture runs (run.json of each), oldest first.
export function fixtureRuns() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    .map(id => JSON.parse(readFileSync(join(FIXTURES_DIR, id, 'run.json'), 'utf8')));
}

// Copies every fixture run into `dataDir`; returns the run ids. `profile` false skips the profile.
export async function installRunFixtures(dataDir, { profile = true } = {}) {
  const dir = resolve(dataDir);
  const rel = relative(HUB, dir);
  if (!rel || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))) throw new Error(`${dir} is inside the workspace; use a data folder outside it.`);
  const ids = [];
  for (const run of fixtureRuns()) {
    const to = join(dir, 'runs', PROJECT, run.id);
    if (existsSync(to)) throw new Error(`${to} already exists; the fixtures were installed before.`);
    mkdirSync(to, { recursive: true });
    cpSync(join(FIXTURES_DIR, run.id), to, { recursive: true });
    await appendJsonl(join(dir, 'runs', 'index.jsonl'), indexLine(run, run.updatedAt || run.createdAt));
    ids.push(run.id);
  }
  const profileFile = join(dir, 'profiles', `${PROJECT}.json`);
  if (profile && !existsSync(profileFile)) await writeJsonAtomic(profileFile, exampleProfile());
  return ids;
}

const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node tools/workspace-app/test/fixtures/runs/install.mjs <data folder>');
    process.exit(1);
  }
  installRunFixtures(target).then(
    ids => console.log(`Installed ${ids.length} fixture runs into ${resolve(target)}.`),
    err => { console.error(`install.mjs: ${err.message}`); process.exit(1); },
  );
}
