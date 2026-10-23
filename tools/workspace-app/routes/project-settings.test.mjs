// Tests for routes/project-settings.mjs with the routes harness (test/fixtures/routes/hub.mjs): a
// temporary hub with the synthetic "example" project and a temporary data folder. The handlers
// are called directly; nothing starts a server, a terminal or claude.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_MODULES } from '../app.mjs';
import { call, routeHub } from '../test/fixtures/routes/hub.mjs';
import { createAsset } from '../asset-library.mjs';
import { settingsDir } from '../project-settings.mjs';
import * as projectSettingRoutes from './project-settings.mjs';
import { MAX_SAVE_BYTES, routes } from './project-settings.mjs';

async function setup(t) {
  const h = await routeHub(t);
  return { ...h, api: routes(h.ctx), dir: settingsDir(h.dataDir, 'example') };
}
const save = (h, body) => call(h.api, 'POST /api/project-settings', { body: { project: 'example', ...body } });
const get = (h, project = 'example') => call(h.api, 'GET /api/project-settings', { query: { project } });
// shared:style-guide in the hub's asset library; resolves with the asset.
const styleGuide = async h => (await createAsset(h.root, { scope: 'shared', title: 'Style guide', originalName: 'style.md' }, Buffer.from('# Style\n'))).asset;

test('GET answers with no settings, the limits and the choices, and writes nothing', async t => {
  const h = await setup(t);
  const r = await get(h);
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body, {
    ok: true, project: 'example', current: null, versions: [],
    limits: { rules: 20000, assets: 50, allowedTools: 20 },
    choices: { defaults: ['model', 'effort', 'permissionMode'], effort: ['low', 'medium', 'high', 'xhigh', 'max'], permissionMode: ['manual', 'plan', 'acceptEdits', 'auto'] },
  });
  assert.ok(!existsSync(join(h.dataDir, 'projects')));
});

test('POST saves numbered versions; GET lists them newest first; one version can be read back', async t => {
  const h = await setup(t);
  await styleGuide(h);
  const first = await save(h, { basedOn: 0, rules: '- Money is in cents.', defaults: { model: 'sonnet' }, allowedTools: 'Read, Grep', assets: [{ ref: 'shared:style-guide', pin: null }] });
  assert.equal(first.status, 200, first.body.error);
  assert.deepEqual(Object.keys(first.body), ['ok', 'project', 'version', 'sha256', 'unchanged', 'message']);
  assert.deepEqual([first.body.version, first.body.unchanged, first.body.message], [1, false, 'Saved the settings of example as v1']);
  assert.match(first.body.sha256, /^[0-9a-f]{64}$/);
  const same = await save(h, { basedOn: 1, rules: '- Money is in cents.\n' });
  assert.deepEqual([same.status, same.body.version, same.body.unchanged, same.body.message], [200, 1, true, 'Nothing changed: v1 is current']);
  const second = await save(h, { basedOn: 1, rules: '- Money is in cents.\n- No floats.' });
  assert.deepEqual([second.body.version, second.body.unchanged], [2, false]);
  const listed = await get(h);
  assert.equal(listed.body.current.version, 2);
  assert.equal(listed.body.current.rules, '- Money is in cents.\n- No floats.');
  assert.deepEqual(listed.body.current.assets, [{ ref: 'shared:style-guide', pin: null }], 'left-out fields keep their values');
  assert.deepEqual(listed.body.versions.map(v => [v.version, v.basedOn, v.sha256]), [[2, 1, second.body.sha256], [1, null, first.body.sha256]]);
  const v1 = await call(h.api, 'GET /api/project-settings/version', { query: { project: 'example', v: '1' } });
  assert.equal(v1.status, 200, v1.body.error);
  assert.deepEqual([v1.body.project, v1.body.settings.version, v1.body.settings.rules, v1.body.settings.sha256], ['example', 1, '- Money is in cents.', first.body.sha256]);
  // Private data: the versions live in the data folder, never in the hub.
  assert.deepEqual(readdirSync(h.dir).sort(), ['v1.json', 'v2.json']);
  assert.ok(!existsSync(join(h.root, 'projects', 'example', 'settings')));
  assert.ok(!existsSync(join(h.root, 'projects', 'example', '.claude', 'settings')));
});

test('POST refuses a stale save with 409 and invalid settings with a 400 that lists every problem', async t => {
  const h = await setup(t);
  await save(h, { basedOn: 0, rules: 'One' });
  await save(h, { basedOn: 1, rules: 'Two' });
  const stale = await save(h, { basedOn: 1, rules: 'Mine' });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you opened them: v2 is current now, not v1\. Reload them, then save again\./);
  const invalid = await save(h, { basedOn: 2, defaults: { effort: 'huge' }, allowedTools: 'Read(', assets: [{ ref: 'other:logo' }] });
  assert.equal(invalid.status, 400);
  for (const re of [/defaults\.effort must be/, /"Read\(" is not a tool rule/, /assets\[0\]\.ref other:logo belongs to another project/]) assert.match(invalid.body.error, re);
  for (const [body, re] of [
    [{ rules: 'x' }, /basedOn is missing/],
    [{ basedOn: '2', rules: 'x' }, /basedOn must be/],
    [{ basedOn: 2, rules: 'x', version: 3 }, /"version" is not a project setting/],
    [{ basedOn: 2, sha256: 'x' }, /"sha256" is not a project setting/],
  ]) {
    const r = await save(h, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.deepEqual(readdirSync(h.dir).sort(), ['v1.json', 'v2.json'], 'nothing else was written');
});

test('POST refuses settings every session would refuse (400 with the reason) and writes nothing', async t => {
  const h = await setup(t);
  const style = await styleGuide(h);
  const v1 = await save(h, { basedOn: 0, rules: 'Short rules.', assets: [{ ref: 'shared:style-guide', pin: null }] });
  assert.equal(v1.status, 200, v1.body.error);
  for (const [body, re] of [
    [{ assets: [{ ref: 'shared:missing', pin: null }] }, /shared:missing is not in the asset library/],
    [{ assets: [{ ref: 'shared:style-guide', pin: 4 }] }, /shared:style-guide has no version 4/],
    // The rules alone fit; with the list of the attached assets after them, the system prompt doesn't.
    [{ rules: 'x'.repeat(19990) }, /the rules of example and the list of its 1 attached assets come to \d+ characters for the system prompt, more than 20000/],
    // Every quote takes two characters on a Windows command line.
    [{ rules: '"'.repeat(15001), assets: [] }, /too long for one Windows command line: 30004 characters once quoted, at most 30000/],
  ]) {
    const r = await save(h, { basedOn: 1, ...body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.body.error, /^The settings were not saved: /);
    assert.match(r.body.error, re);
  }
  // A version file changed by hand is refused too; detaching the asset is a save that works.
  writeFileSync(join(h.root, 'inbox', 'attachments', '_assets', 'style-guide', style.versions[0].file), 'edited by hand');
  const changed = await save(h, { basedOn: 1, rules: 'Other rules.' });
  assert.deepEqual([changed.status, /no longer matches the SHA-256 the library recorded/.test(changed.body.error)], [400, true]);
  assert.deepEqual(readdirSync(h.dir), ['v1.json'], 'nothing was written');
  const detached = await save(h, { basedOn: 1, rules: 'Other rules.', assets: [] });
  assert.deepEqual([detached.status, detached.body.version], [200, 2]);
});

test('the project must be a folder in projects/ with a name the data folder can hold', async t => {
  const h = await setup(t);
  mkdirSync(join(h.root, 'projects', 'Odd_Name'));
  const upper = await get(h, 'EXAMPLE');
  assert.deepEqual([upper.status, upper.body.project], [200, 'example'], 'names match without case, like everywhere in the app');
  for (const [project, code, re] of [
    ['nope', 404, /projects\/nope was not found/],
    ['../example', 404, /not a project folder name/],
    ['Odd_Name', 400, /projects\/Odd_Name can't have settings in the app/],
    ['', 400, /name the project/],
  ]) {
    const r = await get(h, project);
    assert.deepEqual([r.status, r.body.ok], [code, false], project);
    assert.match(r.body.error, re);
    const p = await call(h.api, 'POST /api/project-settings', { body: { project, basedOn: 0, rules: 'x' } });
    assert.equal(p.status, code, `POST ${project}`);
    const v = await call(h.api, 'GET /api/project-settings/version', { query: { project, v: '1' } });
    assert.equal(v.status, code, `GET version ${project}`);
  }
  const noName = await call(h.api, 'GET /api/project-settings');
  assert.equal(noName.status, 400);
  const notText = await call(h.api, 'POST /api/project-settings', { body: { project: ['example'], basedOn: 0 } });
  assert.equal(notText.status, 400);
  assert.ok(!existsSync(join(h.dataDir, 'projects')));
});

test('POST takes the largest valid save, more than the 64 KB of other requests, and refuses far larger bodies', async t => {
  const h = await setup(t);
  // 20,000 characters of rules (the most a session's system prompt takes), written as JSON
  // escapes of 6 bytes each, as a client may send them: about 120 KB.
  const rules = '料'.repeat(20000);
  const body = `{"project":"example","basedOn":0,"rules":"${'\\u6599'.repeat(20000)}"}`;
  assert.ok(Buffer.byteLength(body) > 64 * 1024);
  const r = await call(h.api, 'POST /api/project-settings', { body });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.version, 1);
  assert.equal((await get(h)).body.current.rules, rules);
  const huge = await save(h, { basedOn: 1, rules: 'x'.repeat(MAX_SAVE_BYTES) });
  assert.deepEqual([huge.status, huge.body.error], [413, 'request is larger than 256 KB']);
  assert.deepEqual(readdirSync(h.dir), ['v1.json']);
});

test('POST refuses a body that is not a settings object', async t => {
  const h = await setup(t);
  for (const [body, re] of [['{not json', /invalid JSON/], [[1, 2], /send the settings as an object/], ['"text"', /send the settings as an object/]]) {
    const r = await call(h.api, 'POST /api/project-settings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  const empty = await call(h.api, 'POST /api/project-settings', { body: '' });
  assert.deepEqual([empty.status, empty.body.error], [400, 'name the project (project=<name>)']);
});

test('GET version: 400 for a number that is not a version, 404 for one that is not there', async t => {
  const h = await setup(t);
  await save(h, { basedOn: 0, rules: 'One' });
  for (const v of ['0', '-1', '1.5', 'abc', '', '01', '1e3', '9999999999']) {
    const r = await call(h.api, 'GET /api/project-settings/version', { query: { project: 'example', v } });
    assert.equal(r.status, 400, v);
    assert.match(r.body.error, /v must be a settings version/);
  }
  const missing = await call(h.api, 'GET /api/project-settings/version', { query: { project: 'example', v: '2' } });
  assert.deepEqual([missing.status, missing.body.error], [404, 'example has no settings v2']);
});

test('settings that can not be read are a 500 that names the file', async t => {
  const h = await setup(t);
  await save(h, { basedOn: 0, rules: 'One' });
  writeFileSync(join(h.dir, 'v1.json'), '{ damaged');
  for (const r of [await get(h), await save(h, { basedOn: 1, rules: 'Two' })]) {
    assert.equal(r.status, 500);
    assert.match(r.body.error, /The settings v1 of example can't be used: it is not valid JSON/);
    assert.ok(r.body.error.includes(join(h.dir, 'v1.json')));
  }
});

test('the routes are registered in the app and follow its key pattern', () => {
  assert.ok(ROUTE_MODULES.includes(projectSettingRoutes));
  const keys = Object.keys(routes({ root: '.', dataDir: '.' }));
  assert.deepEqual(keys, ['GET /api/project-settings', 'GET /api/project-settings/version', 'POST /api/project-settings']);
  for (const key of keys) assert.match(key, /^(GET|POST) \/api\/[a-z0-9/-]+$/);
});
