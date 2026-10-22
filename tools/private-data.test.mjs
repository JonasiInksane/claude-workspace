// Tests for tools/lib/private-data.mjs and the private-project-data check in
// tools/check-workspace.mjs. Run: node tools/run-tests.mjs
// Profiles live in a temporary LOCALAPPDATA and the checked workspace is a throwaway git repo in
// the temp folder; the markers are synthetic (project "example"), never real profile values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, findPrivateData, matchMarkers, privateMarkers, readPrivateProfiles } from './lib/private-data.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
// Built at runtime, so this file itself never matches the synthetic markers it tests.
const MARK_A = ['zebra', 'Procedure'].join('');
const MARK_B = ['GLASS', '_', 'HOUSE'].join('');

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-private-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const profile = (project, privacy) => JSON.stringify({ version: 1, project, label: project, privacy });

// A LOCALAPPDATA with an "example" profile that marks the hub public.
function localAppData(dir, privacy = { hubPublic: true, markers: [MARK_A, `${MARK_B}_[0-9]+`], knownExposed: ['reports/old/report.md'] }) {
  const local = join(dir, 'local');
  put(join(local, 'claude-workspace', 'profiles', 'example.json'), profile('example', privacy));
  return local;
}

test('privateMarkers reads every profile in the private data folder and skips what it cannot use', t => {
  const dir = scratch(t);
  const local = localAppData(dir);
  const profiles = join(local, 'claude-workspace', 'profiles');
  put(join(profiles, 'quiet.json'), profile('quiet', { hubPublic: false, markers: ['x'], knownExposed: [] }));
  put(join(profiles, 'broken.json'), '{ not json');
  put(join(profiles, 'odd.json'), profile('odd', { hubPublic: true, markers: ['(unclosed', 'fine'], knownExposed: ['.\\a\\b.md'] }));
  put(join(profiles, 'example.allowlist.json'), '{"procedures": []}'); // not a profile
  put(join(profiles, 'notes.txt'), 'x');
  const env = { LOCALAPPDATA: local };
  assert.equal(defaultDataDir(env), join(local, 'claude-workspace'));
  const list = privateMarkers(env);
  assert.deepEqual(list.map(p => [p.project, p.hubPublic, p.markers.map(m => m.source)]), [
    ['example', true, [MARK_A, `${MARK_B}_[0-9]+`]],
    ['odd', true, ['fine']],
    ['quiet', false, ['x']],
  ]);
  assert.ok(list[0].knownExposed.has('reports/old/report.md'));
  assert.ok(list[1].knownExposed.has('a/b.md'), 'hub paths are posix and relative');
  const { problems } = readPrivateProfiles(env);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /broken\.json could not be read/);
  assert.match(problems[1], /odd\.json has a marker that is not a valid regular expression/);
  // No data folder at all: nothing, no error.
  assert.deepEqual(privateMarkers({ LOCALAPPDATA: join(dir, 'nowhere') }), []);
});

test('matchMarkers and findPrivateData report the file, the marker and the line; projects/, big and binary files are skipped', t => {
  const dir = scratch(t);
  const [p] = privateMarkers({ LOCALAPPDATA: localAppData(dir) });
  assert.deepEqual(matchMarkers(`a\nb\nuses ${MARK_A}\n${MARK_B}_7`, p.markers), [{ marker: MARK_A, line: 3 }, { marker: `${MARK_B}_[0-9]+`, line: 4 }]);
  const root = join(dir, 'hub');
  put(join(root, 'docs', 'leak.md'), `# Notes\n\nCall ${MARK_A} here.\n`);
  put(join(root, 'reports', 'old', 'report.md'), `${MARK_B}_12`);
  put(join(root, 'docs', 'clean.md'), 'nothing private');
  put(join(root, 'projects', 'repos.json'), MARK_A);
  put(join(root, 'big.txt'), `${MARK_A}\n${'x'.repeat(1024 * 1024)}`);
  writeFileSync(join(root, 'image.png'), Buffer.concat([Buffer.from([0x89, 0, 0, 0]), Buffer.from(MARK_A)]));
  put(join(root, 'draft.md'), MARK_A);
  const hits = findPrivateData(root, {
    tracked: ['docs/leak.md', 'reports/old/report.md', 'docs/clean.md', 'projects/repos.json', 'big.txt', 'image.png', 'gone.md'],
    untracked: ['draft.md'], profiles: [p],
  });
  assert.deepEqual(hits.map(h => [h.file, h.project, h.matches, h.exposed, h.tracked]), [
    ['docs/leak.md', 'example', [{ marker: MARK_A, line: 3 }], false, true],
    ['reports/old/report.md', 'example', [{ marker: `${MARK_B}_[0-9]+`, line: 1 }], true, true],
    ['draft.md', 'example', [{ marker: MARK_A, line: 1 }], false, false],
  ]);
  // A profile that doesn't mark the hub public is not used.
  assert.deepEqual(findPrivateData(root, { tracked: ['docs/leak.md'], profiles: [{ ...p, hubPublic: false }] }), []);
});

test('check-workspace: a marker in a tracked file is an error, a known-exposed file and an untracked file warn', t => {
  const dir = scratch(t);
  const local = localAppData(dir);
  const root = join(dir, 'hub');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  mkdirSync(root, { recursive: true });
  git('init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 't'], ['user.email', 't@t']]) git('config', k, v);
  put(join(root, 'docs', 'leak.md'), `# Notes\n\nCall ${MARK_A} here.\n`);
  put(join(root, 'reports', 'old', 'report.md'), `${MARK_B}_12\n`);
  put(join(root, 'docs', 'clean.md'), 'nothing private\n');
  git('add', '-A');
  put(join(root, 'draft.md'), `${MARK_A}\n`); // not added: untracked
  put(join(root, '.gitignore'), 'secret-notes.md\n');
  put(join(root, 'secret-notes.md'), `${MARK_A}\n`); // ignored: never published, not reported

  const run = env => spawnSync(process.execPath, [join(toolsDir, 'check-workspace.mjs'), '--root', root], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  const r = run({ LOCALAPPDATA: local });
  const out = r.stdout;
  assert.match(out, /✖ private-project-data \(\d+ files\), 1 error, 2 warnings: markers of example/);
  assert.match(out, new RegExp(`error: docs/leak\\.md: matches private example markers /${MARK_A}/ \\(line 3\\)\\. Remove that text`));
  assert.match(out, /warn: {2}reports\/old\/report\.md: matches private example markers .*already public, see S0/);
  assert.match(out, /warn: {2}draft\.md: untracked, but matches private example markers .*committing it would publish them/);
  assert.doesNotMatch(out, /secret-notes|docs\/clean/);
  assert.equal(r.status, 1, 'an error fails the check');

  // Only known-exposed text left: warnings, exit 0 from this check.
  rmSync(join(root, 'docs', 'leak.md'));
  rmSync(join(root, 'draft.md'));
  git('add', '-A');
  const clean = run({ LOCALAPPDATA: local });
  assert.match(clean.stdout, /✔ private-project-data \(\d+ files\), 1 warning: markers of example/);
  assert.equal(clean.status, 0, clean.stdout);

  // No profiles on this PC: the check says so and passes.
  const none = run({ LOCALAPPDATA: join(dir, 'empty') });
  assert.match(none.stdout, /✔ private-project-data \(0 files\): no private project profiles on this PC/);
  // A root that is not a git repository: a warning, not a crash.
  const notGit = join(dir, 'plain');
  mkdirSync(notGit);
  const ng = spawnSync(process.execPath, [join(toolsDir, 'check-workspace.mjs'), '--root', notGit], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: local }, windowsHide: true });
  assert.match(ng.stdout, /private-project-data .*\n\s+warn: {2}git ls-files failed here/);
  // Unknown arguments are refused.
  assert.equal(spawnSync(process.execPath, [join(toolsDir, 'check-workspace.mjs'), '--bogus'], { encoding: 'utf8', windowsHide: true }).status, 2);
});
