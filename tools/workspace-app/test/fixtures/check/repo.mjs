// Shared setup for the check runner tests (gates/commands.test.mjs, gates/check.test.mjs): a
// temporary git repo shaped like the synthetic example project, with fake tsc, ESLint and
// Prettier installed under node_modules (ignored by git, like real packages), and a profile whose
// type, lint and format commands use them through {pkg:...}. Everything is written under
// os.tmpdir(). Test files are real node:test files, so the runner parses real TAP.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleRepoFiles, fakeProfile, makeRepo, tempDir, writeFiles } from '../../helpers.mjs';

const here = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
export const FAKE_TOOLS = { 'fake-tsc': 'fake-tsc.mjs', 'fake-eslint': 'fake-eslint.mjs', 'fake-prettier': 'fake-prettier.mjs' };

// The example profile with the fake tools in place of the `node -e` stand-ins.
export function checkProfile(overrides = {}) {
  const base = fakeProfile({
    commands: {
      'types:api': { argv: ['{node}', '{pkg:fake-tsc/cli.mjs}'] },
      'types:web': { argv: ['{node}', '{pkg:fake-tsc/cli.mjs}'] },
      'lint:web': { argv: ['{node}', '{pkg:fake-eslint/cli.mjs}', '--format', 'json', '{files}'] },
      'format:changed': { argv: ['{node}', '{pkg:fake-prettier/cli.mjs}', '--check', '{files}'] },
    },
  });
  return mergeOver(base, overrides);
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function mergeOver(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v === null) delete target[k];
    else if (isPlain(v) && isPlain(target[k])) mergeOver(target[k], v);
    else target[k] = structuredClone(v);
  }
  return target;
}

// Copies the fake tools into <dir>/node_modules/<name>/cli.mjs.
export function installFakeTools(dir) {
  for (const [name, file] of Object.entries(FAKE_TOOLS)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    copyFileSync(here(file), join(dir, 'node_modules', name, 'cli.mjs'));
  }
}

// Source of a node:test file. `body` is the test function's body.
export function testFile(cases) {
  const lines = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
  ];
  for (const [name, body] of Object.entries(cases)) lines.push(`test(${JSON.stringify(name)}, () => {`, `  ${body}`, '});', '');
  return lines.join('\n');
}
export const passing = name => testFile({ [name]: 'assert.equal(1, 1);' });
export const failing = (name, message = 'expected one to be two') => testFile({ [name]: `assert.equal(1, 2, ${JSON.stringify(message)});` });
// Fails while `toggle` (an absolute path outside the repo) exists.
export const toggled = (name, toggle) => testFile({ [name]: `assert.equal(existsSync(${JSON.stringify(toggle)}), false, 'the toggle file exists');` });
// Fails the first time it runs in a TEMP folder and passes after that (a flaky test).
export const flakyOnce = (name, marker = 'flaky.marker') => testFile({
  [name]: `const m = join(process.env.TEMP, ${JSON.stringify(marker)}); if (!existsSync(m)) { writeFileSync(m, 'x'); assert.fail('fails the first time'); }`,
});

// A temporary example repo with the fake tools; returns {dir, sha, toggleDir}. `files` are
// added to (or, with null, removed from) the example files before the first commit.
export async function exampleCheckRepo(t, { files = {}, prefix = 'wp4-repo-' } = {}) {
  const dir = tempDir(prefix, t);
  const toggleDir = tempDir(`${prefix}toggle-`, t);
  const all = { ...exampleRepoFiles() };
  for (const [k, v] of Object.entries(files)) {
    if (v === null) delete all[k];
    else all[k] = v;
  }
  const sha = await makeRepo(dir, { files: all });
  installFakeTools(dir);
  return { dir, sha, toggleDir };
}

export function setFile(dir, rel, text) {
  writeFiles(dir, { [rel]: text });
}

export function removeFile(dir, rel) {
  rmSync(join(dir, ...rel.split('/')), { force: true });
}

export function touch(file, text = 'x') {
  writeFileSync(file, text);
}
