// Tests for the flow question (ask, askRequired) in routes/flows.mjs: saving and reading it, the
// run prompt with the answer under the question, and a 400 when a required question has no
// answer (the preview still works and says what a run would refuse). The route module is called
// directly with a fake request and an `actions` recorder, so no terminal opens.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as flowRoutes from './flows.mjs';

function postReq(body) {
  const buf = Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([buf]), { headers: { 'content-length': String(buf.length) } });
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-flow-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projects', 'example'), { recursive: true });
  const calls = [];
  const rec = name => async args => { calls.push({ name, ...args }); return { sessionId: '' }; };
  const api = flowRoutes.routes({ root, actions: { startClaude: rec('startClaude'), startAgent: rec('startAgent') }, getPort: () => 0, workspaceTag: '', dataDir: join(root, '.data') });
  const call = async (key, body) => {
    try { return { status: 200, body: await api[key](postReq(body)) }; } catch (e) { return { status: e.status || 500, body: { ok: false, error: e.message } }; }
  };
  const get = async slug => api['GET /api/flow'](null, null, new URL(`http://127.0.0.1/api/flow?slug=${slug}`));
  return { root, calls, call, get };
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
