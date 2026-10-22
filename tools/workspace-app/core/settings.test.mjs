// Tests for core/settings.mjs: defaults, cleaning a hand-edited file, merging patches, and
// refusing bad values. Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSettings, defaultSettings, loadSettings, saveSettings, settingsFile, settingsPatchError } from './settings.mjs';
import { tempDir } from '../test/helpers.mjs';

const DEFAULTS = {
  version: 1, shortcuts: { singleKey: true }, notify: { web: true }, fun: { celebration: true, streak: false }, isolation: {}, models: {},
};

test('loadSettings gives the defaults when there is no file, and never creates one', t => {
  const dir = tempDir('ws-settings-', t);
  assert.deepEqual(loadSettings(dir), DEFAULTS);
  assert.deepEqual(defaultSettings(), DEFAULTS);
  assert.equal(existsSync(settingsFile(dir)), false);
  defaultSettings().fun.streak = true;
  assert.equal(defaultSettings().fun.streak, false, 'defaults are a fresh copy');
});

test('loadSettings keeps valid values from a hand-edited file and drops the rest', t => {
  const dir = tempDir('ws-settings-', t);
  writeFileSync(settingsFile(dir), JSON.stringify({
    version: 1, theme: 'dark', shortcuts: { singleKey: 'yes' }, notify: { web: false }, fun: { streak: true, extra: 1 },
    isolation: { 'my-app': 'branch', Bad: 'worktree', other: 'stash' },
    models: { 'refactor.scope': { model: 'opus', effort: 'high' }, 'fix.review': { effort: 'nope' }, 'bad key': { model: 'opus' }, 'explain.answer': { model: 'sonnet' } },
  }));
  assert.deepEqual(loadSettings(dir), {
    version: 1, shortcuts: { singleKey: true }, notify: { web: false }, fun: { celebration: true, streak: true },
    isolation: { 'my-app': 'branch' },
    models: { 'refactor.scope': { model: 'opus', effort: 'high' }, 'explain.answer': { model: 'sonnet' } },
  });
});

test('loadSettings survives a broken file', t => {
  const dir = tempDir('ws-settings-', t);
  writeFileSync(settingsFile(dir), '{"fun":');
  assert.deepEqual(loadSettings(dir), DEFAULTS);
  assert.deepEqual(cleanSettings(null), DEFAULTS);
  assert.deepEqual(cleanSettings([1]), DEFAULTS);
});

test('saveSettings merges a patch, writes atomically and returns the full settings', t => {
  const dir = tempDir('ws-settings-', t);
  const s1 = saveSettings(dir, { fun: { streak: true } });
  assert.equal(s1.fun.streak, true);
  assert.equal(s1.fun.celebration, true);
  const s2 = saveSettings(dir, { isolation: { 'my-app': 'branch' }, models: { 'refactor.scope': { model: 'opus', effort: 'high' } } });
  assert.equal(s2.fun.streak, true, 'earlier values stay');
  assert.deepEqual(s2.isolation, { 'my-app': 'branch' });
  const s3 = saveSettings(dir, { models: { 'refactor.scope': { effort: 'xhigh' } } });
  assert.deepEqual(s3.models['refactor.scope'], { model: 'opus', effort: 'xhigh' }, 'a models entry merges field by field');
  const s4 = saveSettings(dir, { models: { 'refactor.scope': { model: null } }, isolation: { 'my-app': null } });
  assert.deepEqual(s4.models['refactor.scope'], { effort: 'xhigh' });
  assert.deepEqual(s4.isolation, {}, 'null removes an isolation entry');
  const s5 = saveSettings(dir, { models: { 'refactor.scope': { effort: null } } });
  assert.deepEqual(s5.models, {}, 'an emptied entry is removed');
  saveSettings(dir, { models: { 'fix.review': { model: 'opus' } } });
  assert.deepEqual(saveSettings(dir, { models: { 'fix.review': null } }).models, {});
  assert.deepEqual(JSON.parse(readFileSync(settingsFile(dir), 'utf8')), loadSettings(dir));
  assert.ok(readFileSync(settingsFile(dir), 'utf8').endsWith('}\n'));
  assert.deepEqual(saveSettings(dir, {}), loadSettings(dir), 'an empty patch changes nothing');
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});

test('saveSettings refuses bad patches with status 400 and writes nothing', t => {
  const dir = tempDir('ws-settings-', t);
  saveSettings(dir, { notify: { web: false } });
  const before = readFileSync(settingsFile(dir), 'utf8');
  const bad = [
    [null, /must be sent as an object/],
    [[], /must be sent as an object/],
    [{ theme: 'dark' }, /"theme" is not a setting/],
    [{ version: 2 }, /version must be 1/],
    [{ fun: true }, /fun must be an object/],
    [{ fun: { streak: 'yes' } }, /fun\.streak must be true or false/],
    [{ shortcuts: { other: true } }, /"shortcuts\.other" is not a setting/],
    [{ isolation: { 'Not A Project': 'worktree' } }, /is not a project name/],
    [{ isolation: { x: 'stash' } }, /must be worktree or branch/],
    [JSON.parse('{"isolation":{"__proto__":"worktree"}}'), /"__proto__" is not a project name/],
    [JSON.parse('{"__proto__":{"x":1}}'), /"__proto__" is not a setting/],
    [{ models: { scope: { model: 'opus' } } }, /is not a pipeline stage/],
    [{ models: { 'refactor.scope': { model: 'opus; rm -rf' } } }, /model must be an alias/],
    [{ models: { 'refactor.scope': { effort: 'ultra' } } }, /effort must be one of low, medium, high, xhigh, max/],
    [{ models: { 'refactor.scope': { temperature: 1 } } }, /is not a setting/],
    [{ models: { 'refactor.scope': 'opus' } }, /must be an object with model and effort/],
  ];
  for (const [patch, re] of bad) {
    assert.match(settingsPatchError(patch), re, JSON.stringify(patch));
    assert.throws(() => saveSettings(dir, patch), err => err.status === 400 && re.test(err.message), JSON.stringify(patch));
  }
  assert.equal(readFileSync(settingsFile(dir), 'utf8'), before);
  assert.equal(settingsPatchError({ version: 1, fun: { celebration: false } }), '');
});

test('saveSettings keeps a broken settings.json aside before writing a new one', t => {
  const dir = tempDir('ws-settings-', t);
  writeFileSync(settingsFile(dir), '{"oops"');
  const s = saveSettings(dir, { fun: { celebration: false } });
  assert.equal(s.fun.celebration, false);
  const names = readdirSync(dir).sort();
  assert.equal(names.length, 2);
  assert.ok(names.includes('settings.json'));
  const bad = names.find(n => n !== 'settings.json');
  assert.match(bad, /^settings\..+\.bad\.json$/);
  assert.equal(readFileSync(join(dir, bad), 'utf8'), '{"oops"');
});

// A read error is not a broken file: a scanner holding settings.json for a moment (EBUSY) must not
// make a save replace the user's choices with the defaults. A folder named settings.json gives a
// real read error (EISDIR) without an fs shim.
test('saveSettings writes nothing when settings.json cannot be read, and loadSettings falls back to the defaults', t => {
  const dir = tempDir('ws-settings-', t);
  mkdirSync(settingsFile(dir));
  assert.throws(() => saveSettings(dir, { fun: { streak: true } }), err => err.status === 503 && /^settings\.json could not be read \(E[A-Z]+\); nothing was saved\./.test(err.message));
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'nothing was renamed aside or written');
  assert.deepEqual(readdirSync(settingsFile(dir)), []);
  assert.deepEqual(loadSettings(dir), DEFAULTS);
});
