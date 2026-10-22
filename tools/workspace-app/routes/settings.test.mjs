// Tests for routes/settings.mjs: GET /api/settings fills in the defaults, POST /api/settings saves
// a checked patch into the data folder's settings.json and refuses a bad one (400, nothing
// written). The data folder is a temporary one.
// Run: node --test tools/workspace-app/routes/settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSettings } from '../core/settings.mjs';
import { tempDir } from '../test/helpers.mjs';
import { call } from '../test/fixtures/routes/hub.mjs';
import { routes } from './settings.mjs';

function setup(t) {
  const dataDir = tempDir('ws-rt-settings-', t);
  return { dataDir, api: routes({ root: dataDir, dataDir, actions: {}, getPort: () => 0, workspaceTag: '' }) };
}

test('GET /api/settings answers with the defaults before anything is saved', async t => {
  const { api, dataDir } = setup(t);
  const r = await call(api, 'GET /api/settings');
  assert.deepEqual(r, { status: 200, body: { ok: true, settings: defaultSettings() } });
  assert.ok(!existsSync(join(dataDir, 'settings.json')), 'reading writes nothing');
});

test('POST /api/settings merges a patch, saves it and answers with the full settings', async t => {
  const { api, dataDir } = setup(t);
  const r = await call(api, 'POST /api/settings', { body: { fun: { streak: true }, isolation: { example: 'branch' }, models: { 'refactor.scope': { model: 'sonnet', effort: 'high' } } } });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.settings.fun.streak, true);
  assert.equal(r.body.settings.fun.celebration, true, 'other values keep their defaults');
  assert.deepEqual(r.body.settings.isolation, { example: 'branch' });
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk, r.body.settings);
  const second = await call(api, 'POST /api/settings', { body: { isolation: { example: null }, shortcuts: { singleKey: false } } });
  assert.deepEqual(second.body.settings.isolation, {});
  assert.equal(second.body.settings.shortcuts.singleKey, false);
  assert.equal((await call(api, 'GET /api/settings')).body.settings.fun.streak, true);
});

test('POST /api/settings refuses a bad patch with 400 and writes nothing', async t => {
  const { api, dataDir } = setup(t);
  for (const [body, re] of [
    [{ nope: {} }, /"nope" is not a setting/],
    [{ fun: { streak: 'yes' } }, /fun\.streak must be true or false/],
    [{ isolation: { '../x': 'branch' } }, /is not a project name/],
    [{ isolation: { example: 'main' } }, /must be worktree or branch/],
    [{ models: { scope: { model: 'opus' } } }, /is not a pipeline stage/],
    [[1, 2], /must be sent as an object/],
    ['{not json', /invalid JSON/],
  ]) {
    const r = await call(api, 'POST /api/settings', { body });
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.body.error}`);
    assert.match(r.body.error, re);
  }
  assert.ok(!existsSync(join(dataDir, 'settings.json')));
});

test('route keys follow the app\'s pattern', () => {
  for (const key of Object.keys(routes({ root: '.', dataDir: '.' }))) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
