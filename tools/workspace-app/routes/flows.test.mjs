// Tests for routes/flows.mjs: the flow question (ask, askRequired: saving and reading it, the run
// prompt with the answer under the question, a 400 when a required question has no answer while
// the preview still works), where a run starts (a flow for any project needs a known, launchable
// project; a fixed project refuses another one), and the launch record with the flow's version
// (flow-runs.jsonl, GET /api/flow-runs). The route module is called directly with a fake request
// and an `actions` recorder, so no terminal opens.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { flowRunsFile, flowVersion } from '../flow-versions.mjs';
import { createAsset, setArchived } from '../asset-library.mjs';
import { saveSettings } from '../project-settings.mjs';
import { sha256Text } from '../core/datadir.mjs';
import * as flowRoutes from './flows.mjs';

function postReq(body) {
  const buf = Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
}

// A workspace with the projects "example" and "notes", plus "we;ird" (its name can't start a
// terminal) and the agent "artist" in example. `failLaunch` makes every start throw, as when
// claude is missing.
function setup(t, { failLaunch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ws-flow-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const p of ['example', 'notes', 'we;ird']) mkdirSync(join(root, 'projects', p), { recursive: true });
  const agent = join(root, 'projects', 'example', '.claude', 'agents', 'artist.md');
  mkdirSync(dirname(agent), { recursive: true });
  writeFileSync(agent, '---\nname: artist\ndescription: Draws.\nmemory: project\n---\n');
  const dataDir = join(root, '.data');
  const calls = [];
  const rec = name => async args => {
    if (failLaunch) throw new Error('Claude Code was not found');
    calls.push({ name, ...args });
    return { sessionId: `session-${calls.length}` };
  };
  const api = flowRoutes.routes({ root, actions: { startClaude: rec('startClaude'), startAgent: rec('startAgent') }, getPort: () => 0, workspaceTag: '', dataDir });
  const call = async (key, body) => {
    try { return { status: 200, body: await api[key](postReq(body)) }; } catch (e) { return { status: e.status || 500, body: { ok: false, error: e.message } }; }
  };
  const get = async slug => api['GET /api/flow'](null, null, new URL(`http://127.0.0.1/api/flow?slug=${slug}`));
  const runs = async flow => {
    try { return { status: 200, body: await api['GET /api/flow-runs'](null, null, new URL(`http://127.0.0.1/api/flow-runs?flow=${encodeURIComponent(flow)}`)) }; } catch (e) { return { status: e.status || 500, body: { ok: false, error: e.message } }; }
  };
  const records = () => (existsSync(flowRunsFile(dataDir)) ? readFileSync(flowRunsFile(dataDir), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { root, dataDir, calls, call, get, runs, records };
}

const refactor = {
  title: 'Refactor (interactive)', target: 'project', project: 'example', prompt: 'Refactor what I describe.',
  permissionMode: 'plan', effort: 'high', ask: 'What do you want to refactor?', askRequired: true,
};

test('a flow saves its question and reads it back', async t => {
  const { call, get } = setup(t);
  const saved = await call('POST /api/flows', refactor);
  assert.equal(saved.status, 200, saved.body.error);
  const f = await get(saved.body.slug);
  assert.deepEqual([f.ask, f.askRequired, f.permissionMode, f.effort], ['What do you want to refactor?', true, 'plan', 'high']);
  // Saving it without the question turns Required off too, or is refused when Required stays.
  assert.equal((await call('POST /api/flows', { ...refactor, slug: saved.body.slug, hash: f.hash, ask: '' })).status, 400);
  const off = await call('POST /api/flows', { ...refactor, slug: saved.body.slug, hash: f.hash, ask: '', askRequired: false });
  assert.equal(off.status, 200, off.body.error);
  assert.deepEqual([(await get(saved.body.slug)).ask, (await get(saved.body.slug)).askRequired], ['', false]);
  assert.equal((await call('POST /api/flows', { ...refactor, title: 'Long', ask: 'x'.repeat(121) })).status, 400);
});

test('saving without the ask keys (an editor that predates them) keeps the stored question', async t => {
  const { call, get } = setup(t);
  const { ask, askRequired, ...older } = refactor;
  const saved = await call('POST /api/flows', refactor);
  const first = await get(saved.body.slug);
  const resaved = await call('POST /api/flows', { ...older, prompt: 'Refactor this instead.', slug: saved.body.slug, hash: first.hash });
  assert.equal(resaved.status, 200, resaved.body.error);
  const after = await get(saved.body.slug);
  assert.deepEqual([after.prompt, after.ask, after.askRequired], ['Refactor this instead.', ask, askRequired]);
  // One key sent, the other kept: a new question stays required.
  const asked = await call('POST /api/flows', { ...older, slug: saved.body.slug, hash: after.hash, ask: 'Which module?' });
  assert.equal(asked.status, 200, asked.body.error);
  assert.deepEqual([(await get(saved.body.slug)).ask, (await get(saved.body.slug)).askRequired], ['Which module?', true]);
  // A stale hash is still a conflict, and an unknown slug still a 400.
  assert.equal((await call('POST /api/flows', { ...older, slug: saved.body.slug, hash: first.hash })).status, 409);
  assert.equal((await call('POST /api/flows', { ...older, slug: 'no-such-flow', hash: 'x' })).status, 400);
  // A new flow without the keys has no question.
  const fresh = await call('POST /api/flows', { ...older, title: 'Plain' });
  assert.deepEqual([(await get(fresh.body.slug)).ask, (await get(fresh.body.slug)).askRequired], ['', false]);
});

test('a run without an answer to a required question is refused with 400; the preview shows the ask block', async t => {
  const { root, calls, call } = setup(t);
  const { body: { slug } } = await call('POST /api/flows', refactor);
  const empty = await call('POST /api/flows/run', { slug, notes: '  ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, '"What do you want to refactor?" needs an answer');
  assert.equal(calls.length, 0, 'nothing started');

  const preview = await call('POST /api/flows/run', { slug, preview: true });
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.body.prompt, preview.body.notesError], ['Refactor what I describe.', '"What do you want to refactor?" needs an answer']);
  const filled = await call('POST /api/flows/run', { slug, notes: 'The money module', preview: true });
  assert.equal(filled.body.prompt, 'Refactor what I describe.\n\nWhat do you want to refactor?\nThe money module');
  assert.equal(filled.body.notesError, '');
  assert.deepEqual(filled.body.launch, { permissionMode: 'plan', effort: 'high' });

  const run = await call('POST /api/flows/run', { slug, notes: 'The money module' });
  assert.equal(run.status, 200, run.body.error);
  assert.deepEqual(calls.map(c => [c.name, c.dir, c.prompt, c.launch, c.kind, c.project]), [[
    'startClaude', join(root, 'projects', 'example'), 'Refactor what I describe.\n\nWhat do you want to refactor?\nThe money module',
    { permissionMode: 'plan', effort: 'high' }, 'flow', 'example',
  ]]);
});

test('an optional question does not block a run; a hand-edited askRequired that is not true or false does', async t => {
  const { root, calls, call } = setup(t);
  const { body: { slug } } = await call('POST /api/flows', { ...refactor, title: 'Optional', askRequired: false });
  assert.equal((await call('POST /api/flows/run', { slug })).status, 200);
  assert.equal(calls[0].prompt, 'Refactor what I describe.');
  const file = join(root, 'flows', 'odd.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\ntitle: "Odd"\ntarget: hub\nask: "Why?"\naskRequired: maybe\n---\n\nGo.\n');
  const odd = await call('POST /api/flows/run', { slug: 'odd', notes: 'because' });
  assert.equal(odd.status, 400);
  assert.match(odd.body.error, /askRequired must be true or false/);
  assert.equal(calls.length, 1);
});

const anyReview = { title: 'Review anything', target: 'project', project: '*', prompt: 'Review what changed.', permissionMode: 'plan' };

test('a flow for any project runs in the project the run names, and both launches carry the same flow hash', async t => {
  const { root, calls, call, get, records } = setup(t);
  const saved = await call('POST /api/flows', anyReview);
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal((await get(saved.body.slug)).project, '*');
  const slug = saved.body.slug;

  const one = await call('POST /api/flows/run', { slug, project: 'example' });
  assert.equal(one.status, 200, one.body.error);
  assert.deepEqual([one.body.message, one.body.project, one.body.sessionId, one.body.recorded], ['Started Review anything in example', 'example', 'session-1', true]);
  // Names match without case; the folder's real spelling is what starts and what is recorded.
  const two = await call('POST /api/flows/run', { slug, project: ' NOTES ' });
  assert.equal(two.status, 200, two.body.error);
  assert.deepEqual(calls.map(c => [c.name, c.dir, c.project, c.kind, c.launch]), [
    ['startClaude', join(root, 'projects', 'example'), 'example', 'flow', { permissionMode: 'plan' }],
    ['startClaude', join(root, 'projects', 'notes'), 'notes', 'flow', { permissionMode: 'plan' }],
  ]);
  assert.equal(calls[0].prompt, 'Review what changed.');

  const [a, b] = records();
  assert.deepEqual([a.flow, a.target, a.project, a.agent, a.sessionId], [slug, 'project', 'example', '', 'session-1']);
  assert.deepEqual([b.project, b.sessionId], ['notes', 'session-2']);
  assert.match(a.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(a.version.sha256, b.version.sha256);
  assert.deepEqual(a.version, await flowVersion(root, slug));
  // The preview needs no project: the prompt is the same everywhere.
  const preview = await call('POST /api/flows/run', { slug, preview: true });
  assert.deepEqual([preview.status, preview.body.prompt], [200, 'Review what changed.']);
});

test('a flow for any project refuses a run without a project, or with one the app can\'t start in; nothing is recorded', async t => {
  const { calls, call, records } = setup(t);
  const { body: { slug } } = await call('POST /api/flows', anyReview);
  const cases = [
    [{ slug }, 400, /runs in any project: choose the project/],
    [{ slug, project: '  ' }, 400, /choose the project/],
    [{ slug, project: 'missing' }, 404, /projects\/missing was not found/],
    [{ slug, project: '*' }, 404, /not found/],
    [{ slug, project: '../example' }, 404, /not a project folder name/],
    [{ slug, project: '.data' }, 404, /not a project folder name/],
    [{ slug, project: 'we;ird' }, 400, /from a terminal/],
    [{ slug, project: ['example'] }, 400, /project must be a project name/],
  ];
  for (const [body, status, error] of cases) {
    const r = await call('POST /api/flows/run', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, error, JSON.stringify(body));
  }
  assert.deepEqual([calls.length, records()], [0, []]);
});

test('a fixed project, the hub and an agent refuse another project; their own one (any case) is fine', async t => {
  const { root, calls, call, records } = setup(t);
  const fixed = (await call('POST /api/flows', { ...anyReview, title: 'Fixed', project: 'example' })).body.slug;
  const hub = (await call('POST /api/flows', { ...anyReview, title: 'Hub', target: 'hub' })).body.slug;
  const agent = (await call('POST /api/flows', { ...anyReview, title: 'Agent', target: 'agent', project: 'example', agent: 'artist' })).body.slug;
  assert.equal((await call('POST /api/flows', { ...anyReview, title: 'Agent anywhere', target: 'agent', agent: 'artist' })).status, 400);

  const refused = [
    [{ slug: fixed, project: 'notes' }, /Fixed runs in example, not in notes/],
    [{ slug: hub, project: 'example' }, /Hub runs in the hub, not in example/],
    [{ slug: agent, project: 'notes' }, /Agent runs in example, not in notes/],
  ];
  for (const [body, error] of refused) {
    const r = await call('POST /api/flows/run', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, error);
  }
  assert.equal(calls.length, 0);

  for (const body of [{ slug: fixed }, { slug: fixed, project: 'EXAMPLE' }, { slug: hub, project: '' }, { slug: agent, project: 'example' }]) {
    const r = await call('POST /api/flows/run', body);
    assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.body.error}`);
    assert.doesNotMatch(r.body.message, / in /, 'only a flow for any project says where it started');
  }
  assert.deepEqual(calls.map(c => [c.name, c.dir || '', c.project || '', c.agent || '']), [
    ['startClaude', join(root, 'projects', 'example'), 'example', ''],
    ['startClaude', join(root, 'projects', 'example'), 'example', ''],
    ['startClaude', root, '', ''],
    ['startAgent', '', 'example', 'artist'],
  ]);
  assert.deepEqual(records().map(r => [r.flow, r.target, r.project, r.agent, r.sessionId]), [
    [fixed, 'project', 'example', '', 'session-1'],
    [fixed, 'project', 'example', '', 'session-2'],
    [hub, 'hub', '', '', 'session-3'],
    [agent, 'agent', 'example', 'artist', 'session-4'],
  ]);
});

test('a flow for any project starts a linked project in its checkout\'s real folder; a broken link is refused', async t => {
  const { root, calls, call, records } = setup(t);
  const checkout = mkdtempSync(join(tmpdir(), 'ws-flow-checkout-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  symlinkSync(checkout, join(root, 'projects', 'linked'), 'junction');
  const { body: { slug } } = await call('POST /api/flows', anyReview);
  const r = await call('POST /api/flows/run', { slug, project: 'linked' });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([calls[0].dir, calls[0].project], [realpathSync.native(checkout), 'linked']);
  assert.equal(records()[0].project, 'linked');
  rmSync(checkout, { recursive: true, force: true });
  const broken = await call('POST /api/flows/run', { slug, project: 'linked' });
  assert.equal(broken.status, 404);
  assert.deepEqual([calls.length, records().length], [1, 1]);
});

test('a launch that fails writes no record; a record that can\'t be written doesn\'t fail the launch', async t => {
  const failing = setup(t, { failLaunch: true });
  const { body: { slug } } = await failing.call('POST /api/flows', anyReview);
  const r = await failing.call('POST /api/flows/run', { slug, project: 'example' });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /Claude Code was not found/);
  assert.deepEqual(failing.records(), []);

  // The data folder path is a file: the session still started, and the answer says so.
  const ok = setup(t);
  writeFileSync(ok.dataDir, 'not a folder');
  const made = (await ok.call('POST /api/flows', anyReview)).body.slug;
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  let run;
  try { run = await ok.call('POST /api/flows/run', { slug: made, project: 'example' }); } finally { console.error = original; }
  assert.equal(run.status, 200, run.body.error);
  assert.deepEqual([run.body.recorded, ok.calls.length], [false, 1]);
  assert.match(logged.join('\n'), /could not record the run of flow review-anything/);
  // The answer (the page's toast) says so too.
  assert.equal(run.body.message, "Started Review anything in example; its version could not be recorded (the app's log says why)");
});

test('GET /api/flow-runs: the newest runs first, what changed since each, and refusals', async t => {
  const { root, call, get, runs } = setup(t);
  const { body: { slug } } = await call('POST /api/flows', anyReview);
  assert.deepEqual((await runs(slug)).body.runs, []);
  await call('POST /api/flows/run', { slug, project: 'example' });
  // Edit the prompt, then run again in another project.
  const f = await get(slug);
  assert.equal((await call('POST /api/flows', { ...anyReview, slug, hash: f.hash, prompt: 'Review it twice.' })).status, 200);
  await call('POST /api/flows/run', { slug, project: 'notes' });

  const answer = (await runs(slug)).body;
  assert.equal(answer.ok, true);
  assert.equal(answer.flow, slug);
  assert.deepEqual(answer.current, await flowVersion(root, slug));
  assert.deepEqual(answer.runs.map(r => [r.project, r.sessionId, r.changes]), [['notes', 'session-2', []], ['example', 'session-1', ['prompt']]]);
  assert.notEqual(answer.runs[0].version.sha256, answer.runs[1].version.sha256);
  // An image added since changes the images of both.
  mkdirSync(join(root, 'inbox', 'attachments', '_flows', slug), { recursive: true });
  writeFileSync(join(root, 'inbox', 'attachments', '_flows', slug, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.deepEqual((await runs(slug)).body.runs.map(r => r.changes), [['images'], ['prompt', 'images']]);

  // Once the file is archived there is no current version, and the records stay.
  assert.equal((await call('POST /api/flows/archive', { slug })).status, 200);
  const archived = (await runs(slug)).body;
  assert.deepEqual([archived.current, archived.runs.length, archived.runs[0].changes], [null, 2, []]);
  for (const bad of ['', '../x', 'Bad Name', 'a/b']) assert.equal((await runs(bad)).status, 400, bad);
  assert.deepEqual((await runs('never-ran')).body, { ok: true, flow: 'never-ran', current: null, runs: [] });
});

// ---------------------------------------------------------------- attached assets

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// The library of the workspace: a shared style guide, a shared logo and example's palette.
async function withLibrary(ws) {
  const style = await createAsset(ws.root, { scope: 'shared', title: 'Style guide', originalName: 'style.md' }, Buffer.from('# Style\nUse teal.\n'));
  const logo = await createAsset(ws.root, { scope: 'shared', title: 'Logo', originalName: 'logo.png' }, PNG);
  const palette = await createAsset(ws.root, { scope: 'project', project: 'example', title: 'Palette', originalName: 'palette.png' }, PNG);
  return { style: style.asset, logo: logo.asset, palette: palette.asset };
}
const fileOf = (root, rel) => join(root, ...rel.split('/'));

test('a flow saves its attached assets, reads them back as text and a list, and keeps them when a save leaves them out', async t => {
  const { call, get } = setup(t);
  const saved = await call('POST /api/flows', { ...refactor, assets: 'shared:style-guide, EXAMPLE:palette@2' });
  assert.equal(saved.status, 200, saved.body.error);
  const f = await get(saved.body.slug);
  assert.equal(f.assets, 'shared:style-guide, example:palette@2');
  assert.deepEqual(f.assetList, [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:palette', pin: 2 }]);
  // An editor that doesn't know the field keeps it; one that sends '' removes it.
  const { assets, ...older } = { ...refactor, assets: undefined };
  const kept = await call('POST /api/flows', { ...older, slug: saved.body.slug, hash: f.hash, prompt: 'Changed.' });
  assert.equal(kept.status, 200, kept.body.error);
  const g = await get(saved.body.slug);
  assert.equal(g.assets, 'shared:style-guide, example:palette@2');
  assert.equal((await call('POST /api/flows', { ...refactor, slug: saved.body.slug, hash: g.hash, assets: '' })).status, 200);
  assert.deepEqual((await get(saved.body.slug)).assetList, []);
  // Refusals: another project's asset, a malformed ref, a list that is not text.
  for (const [body, re] of [
    [{ ...refactor, title: 'Other', assets: 'notes:map' }, /notes:map belongs to projects\/notes; a flow for example can attach shared assets and example's own/],
    [{ ...refactor, title: 'Hub', target: 'hub', assets: 'example:palette' }, /a hub flow can attach shared assets only/],
    [{ ...refactor, title: 'Bad', assets: 'style guide' }, /is not an asset/],
    [{ ...refactor, title: 'List', assets: ['shared:style-guide'] }, /assets must be text/],
  ]) {
    const r = await call('POST /api/flows', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
});

test('a run lists the flow\'s and the project\'s assets after the images, may read their folders, and records their versions', async t => {
  const ws = setup(t);
  const { style, logo, palette } = await withLibrary(ws);
  await saveSettings(ws.dataDir, 'example', { rules: 'Cents only.', assets: [{ ref: 'example:palette', pin: null }, { ref: 'shared:style-guide', pin: null }] }, { basedOn: 0 });
  const { body: { slug } } = await ws.call('POST /api/flows', { ...refactor, askRequired: false, assets: 'shared:logo, shared:style-guide@1' });
  mkdirSync(join(ws.root, 'inbox', 'attachments', '_flows', slug), { recursive: true });
  writeFileSync(join(ws.root, 'inbox', 'attachments', '_flows', slug, 'shot.png'), PNG);
  const r = await ws.call('POST /api/flows/run', { slug });
  assert.equal(r.status, 200, r.body.error);
  const c = ws.calls[0];
  const shot = join(ws.root, 'inbox', 'attachments', '_flows', slug, 'shot.png');
  const logoFile = fileOf(ws.root, `inbox/attachments/_assets/logo/${logo.versions[0].file}`);
  const styleFile = fileOf(ws.root, `inbox/attachments/_assets/style-guide/${style.versions[0].file}`);
  const paletteFile = fileOf(ws.root, `inbox/attachments/example/_assets/palette/${palette.versions[0].file}`);
  assert.equal(c.prompt, [
    `Reference images for this task. Read each one before you start:\n- Image 1: ${shot}`,
    "Assets for this task, from the workspace app's asset library. Read each one before you start:",
  ].join('\n\n') + `\n- Asset 1: Logo (shared:logo v1, image) at ${logoFile}` +
    `\n- Asset 2: Style guide (shared:style-guide v1, text) at ${styleFile}` +
    `\n- Asset 3: Palette (example:palette v1, image) at ${paletteFile}\n\nRefactor what I describe.`);
  // The flow's own pin (style guide v1) wins over the project's attachment of the same asset.
  assert.deepEqual(c.assets.map(a => [a.ref, a.version]), [['shared:logo', 1], ['shared:style-guide', 1], ['example:palette', 1]]);
  // The image folder only: launch.mjs adds the assets' folders from `assets`, read-only.
  assert.deepEqual(c.readDirs, [join(ws.root, 'inbox', 'attachments', '_flows', slug)]);
  assert.equal(c.settings.version, 1, 'the settings the assets came from go along');
  const [line] = ws.records();
  assert.deepEqual(line.assets, [
    { ref: 'shared:logo', version: 1, sha256: sha256Text(PNG) },
    { ref: 'shared:style-guide', version: 1, sha256: sha256Text(Buffer.from('# Style\nUse teal.\n')) },
    { ref: 'example:palette', version: 1, sha256: sha256Text(PNG) },
  ]);
});

test('a flow for any project gets the chosen project\'s assets; a hub flow its shared ones only', async t => {
  const ws = setup(t);
  await withLibrary(ws);
  await saveSettings(ws.dataDir, 'example', { assets: [{ ref: 'example:palette', pin: null }] }, { basedOn: 0 });
  const any = (await ws.call('POST /api/flows', { ...anyReview, assets: 'shared:logo' })).body.slug;
  assert.equal((await ws.call('POST /api/flows/run', { slug: any, project: 'example' })).status, 200);
  assert.equal((await ws.call('POST /api/flows/run', { slug: any, project: 'notes' })).status, 200);
  assert.deepEqual(ws.calls.map(c => c.assets.map(a => a.ref)), [['shared:logo', 'example:palette'], ['shared:logo']]);
  const hub = (await ws.call('POST /api/flows', { ...anyReview, title: 'Hub', target: 'hub', assets: 'shared:logo' })).body.slug;
  assert.equal((await ws.call('POST /api/flows/run', { slug: hub })).status, 200);
  assert.deepEqual([ws.calls[2].assets.map(a => a.ref), ws.calls[2].settings], [['shared:logo'], undefined]);
  assert.deepEqual(ws.records().map(r => r.assets.map(a => a.ref)), [['shared:logo', 'example:palette'], ['shared:logo'], ['shared:logo']]);
});

test('an asset or version that is gone refuses a run (400), a file changed by hand too (409); nothing starts or is recorded', async t => {
  const ws = setup(t);
  const { style } = await withLibrary(ws);
  const pinned = (await ws.call('POST /api/flows', { ...anyReview, title: 'Pinned', assets: 'shared:style-guide@3' })).body.slug;
  const r = await ws.call('POST /api/flows/run', { slug: pinned, project: 'example' });
  assert.deepEqual([r.status, r.body.error], [400, "Pinned can't start: shared:style-guide has no version 3"]);
  const gone = (await ws.call('POST /api/flows', { ...anyReview, title: 'Gone', assets: 'shared:missing' })).body.slug;
  assert.match((await ws.call('POST /api/flows/run', { slug: gone, project: 'example' })).body.error, /shared:missing is not in the asset library/);
  await saveSettings(ws.dataDir, 'notes', { assets: [{ ref: 'shared:missing', pin: null }] }, { basedOn: 0 });
  const plain = (await ws.call('POST /api/flows', { ...anyReview, title: 'Plain' })).body.slug;
  assert.match((await ws.call('POST /api/flows/run', { slug: plain, project: 'notes' })).body.error, /^Plain can't start: shared:missing is not in the asset library$/, 'the project\'s own attachments too');
  writeFileSync(fileOf(ws.root, `inbox/attachments/_assets/style-guide/${style.versions[0].file}`), 'edited by hand');
  const ok = (await ws.call('POST /api/flows', { ...anyReview, title: 'Edited', assets: 'shared:style-guide' })).body.slug;
  const changed = await ws.call('POST /api/flows/run', { slug: ok, project: 'example' });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /the file of shared:style-guide v1 no longer matches the SHA-256 the library recorded for it/);
  assert.deepEqual([ws.calls.length, ws.records()], [0, []]);
});

test('the preview shows the effective launch, the assets with what a run would refuse, and the project part once one is chosen', async t => {
  const ws = setup(t);
  await withLibrary(ws);
  await setArchived(ws.root, 'shared:logo', true);
  const v1 = await saveSettings(ws.dataDir, 'example', {
    rules: 'Cents only.', defaults: { model: 'opus', effort: 'max' }, allowedTools: 'Read, Grep', assets: [{ ref: 'example:palette', pin: null }],
  }, { basedOn: 0 });
  const { body: { slug } } = await ws.call('POST /api/flows', { ...refactor, askRequired: false, assets: 'shared:logo, shared:style-guide@4' });
  const p = (await ws.call('POST /api/flows/run', { slug, preview: true })).body;
  // The flow's own effort wins; the project's model, tools and rules are added.
  assert.deepEqual(p.launch, { permissionMode: 'plan', effort: 'high', model: 'opus', allowedTools: ['Read', 'Grep'], appendSystemPrompt: 'Cents only.' });
  assert.deepEqual([p.project, p.projectSettings], ['example', { version: 1, sha256: v1.sha256 }]);
  assert.deepEqual(p.assets.map(a => [a.ref, a.version, a.archived, a.missing]), [['shared:logo', 1, true, false], ['shared:style-guide', 4, false, true], ['example:palette', 1, false, false]]);
  assert.deepEqual(p.problems, ['shared:style-guide has no version 4']);
  assert.match(p.prompt, /- Asset 1: Logo \(shared:logo v1, image\) at .*\n- Asset 2: Palette \(example:palette v1, image\) at /, 'a missing one is left out of the prompt');
  assert.equal(ws.calls.length, 0, 'a preview starts nothing');
  // A flow for any project: nothing of a project until one is chosen.
  const any = (await ws.call('POST /api/flows', { ...anyReview, title: 'Any', assets: 'shared:logo' })).body.slug;
  const none = (await ws.call('POST /api/flows/run', { slug: any, preview: true })).body;
  assert.deepEqual([none.project, none.projectSettings, none.launch, none.note], ['', null, { permissionMode: 'plan' }, 'Choose a project to see its settings and attached assets.']);
  assert.deepEqual(none.assets.map(a => a.ref), ['shared:logo']);
  const chosen = (await ws.call('POST /api/flows/run', { slug: any, preview: true, project: 'example' })).body;
  assert.deepEqual([chosen.project, chosen.launch.appendSystemPrompt, chosen.assets.map(a => a.ref), chosen.note], ['example', 'Cents only.', ['shared:logo', 'example:palette'], '']);
});
