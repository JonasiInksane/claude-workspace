// Tests for sprite assets in the Assets view (assets.mjs, the asset routes and /asset-file) over
// real HTTP, with a throwaway workspace that has a sprite project (tools/sprite.mjs) next to a 3D
// one (tools/asset.mjs); and for the clip fallbacks of ui/sprite-viewer.js, which need no
// browser. Run: node tools/run-tests.mjs workspace-app
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.mjs';
import { clipFor, DIRECTIONS } from './ui/sprite-viewer.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const TOKEN = 'sprite-token-1';
const DOC = 'projects/Pix/assets/hd2d/characters/Doc';
let root, server, port, cookie;

function put(rel, data) {
  const f = join(root, ...rel.split('/'));
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
}

function call(method, path, { body, auth = true, headers = {} } = {}) {
  const h = { Host: `127.0.0.1:${port}`, ...headers };
  if (auth && cookie) h.Cookie = cookie;
  if (method === 'POST') Object.assign(h, { Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1', 'Content-Type': 'application/json' }, headers);
  return new Promise((resolveP, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolveP({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ws-sprites-'));
  // A sprite project: tools/sprite.mjs and one character with everything the pipeline writes
  // (no emissive sheet).
  put('projects/Pix/tools/sprite.mjs', '// sprite pipeline');
  put(`${DOC}/asset.json`, JSON.stringify({
    name: 'Doc', style: 'hd2d', category: 'characters', kind: 'sprite', class: 'char-field', source: 'pixellab', status: 'review',
    sprite: { emissive: [], mirror: true }, provenance: { from: 'PixelLab API v2, character abc', model: 'create-character-v3', license: 'yours', date: '2026-10-22' },
  }, null, 2));
  put(`${DOC}/brief.md`, '# Sprite brief: Doc\n\n## Log\n- 2026-10-22 brief created\n');
  put(`${DOC}/review/check-final.json`, JSON.stringify({
    checkedAt: '2026-10-22T10:00:00Z', summary: { pass: 5, warn: 1, fail: 0 }, heightPx: 31, widthPx: 17, colors: 24, frames: 110,
    checks: [{ id: 'colors', status: 'pass', message: '24 colours' }, { id: 'baseline', status: 'warn', message: 'walk south moves 2 px' }],
  }));
  for (const f of ['thumb', 'turnaround', 'palette', 'lineup', 'anim_walk', 'anim_idle']) put(`${DOC}/review/${f}.png`, PNG);
  put(`${DOC}/export/SPR_Doc.png`, PNG);
  put(`${DOC}/export/SPR_Doc_N.png`, PNG);
  put(`${DOC}/export/SPR_Doc.json`, JSON.stringify({ frames: [], meta: { sprite: { name: 'Doc' } } }));
  put(`${DOC}/gen/record.json`, JSON.stringify({ provider: 'pixellab', characterId: 'abc', model: 'create-character-v3', usd: 0.21, generations: null, finishedAt: '2026-10-22T09:00:00Z' }));
  put(`${DOC}/concept/front.png`, PNG);
  // A 3D project next to it, and a project with the sprite tool but no assets/ folder.
  put('projects/Game/tools/asset.mjs', '// pipeline');
  put('projects/Game/assets/demo/props/Box/asset.json', JSON.stringify({ name: 'Box', style: 'demo', category: 'props', class: 'prop-small', source: 'procedural', status: 'brief' }));
  put('projects/Game/assets/demo/props/Box/brief.md', '# Box\n\n## Log\n');
  put('projects/Empty/tools/sprite.mjs', '// no assets yet');

  const none = async () => {};
  const actions = { tools: {}, startClaude: none, startAgent: none, openFolder: none, openEditor: none, openNavigator: none, openWindow: none };
  server = createServer(createApp({ root, token: TOKEN, actions, workspaceTag: 'tag', getPort: () => port, dataDir: join(root, '.data') }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const signIn = await call('GET', `/?t=${TOKEN}`, { auth: false });
  cookie = String(signIn.headers['set-cookie'][0]).split(';')[0];
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test('sprite projects are listed next to 3D ones; a sprite card has its kind and thumbnail', async () => {
  const state = (await call('GET', '/api/state')).json;
  assert.deepEqual(state.assets.map(p => p.project).sort(), ['Game', 'Pix']);
  const doc = state.assets.find(p => p.project === 'Pix').assets[0];
  assert.equal(doc.kind, 'sprite');
  assert.equal(doc.thumb, 'hd2d/characters/Doc/review/thumb.png');
  assert.deepEqual([doc.final.pass, doc.final.warn, doc.final.fail], [5, 1, 0]);
  assert.equal(state.assets.find(p => p.project === 'Game').assets[0].kind, 'model');
});

test('sprite detail: sheet files, review images in reading order, check facts, the PixelLab record', async () => {
  const r = await call('GET', '/api/asset?project=Pix&id=hd2d/characters/Doc');
  assert.equal(r.status, 200, r.buf.toString());
  const d = r.json;
  assert.equal(d.kind, 'sprite');
  const base = 'hd2d/characters/Doc';
  assert.deepEqual(d.sprite, { sheet: `${base}/export/SPR_Doc.png`, json: `${base}/export/SPR_Doc.json`, normal: `${base}/export/SPR_Doc_N.png`, emissive: '' });
  assert.deepEqual(d.models, { final: '', raw: '' });
  assert.deepEqual(d.renders.final, ['turnaround', 'anim_idle', 'anim_walk', 'lineup', 'palette'].map(n => `${base}/review/${n}.png`));
  assert.deepEqual(d.renders.raw, []);
  assert.deepEqual([d.checks.final.heightPx, d.checks.final.widthPx, d.checks.final.colors, d.checks.final.frames], [31, 17, 24, 110]);
  assert.deepEqual(d.checks.final.checks.map(c => c.status), ['warn', 'pass']);
  assert.equal(d.checks.raw, null);
  assert.deepEqual(d.generation, { task: 'abc', provider: 'pixellab', model: 'create-character-v3', credits: null, usd: 0.21, generations: null, finishedAt: '2026-10-22T09:00:00Z' });
  assert.deepEqual(d.concept, [`${base}/concept/front.png`]);
  // A 3D asset keeps its shape (no sprite block).
  const box = (await call('GET', '/api/asset?project=Game&id=demo/props/Box')).json;
  assert.equal(box.kind, 'model');
  assert.equal(box.sprite, undefined);
  assert.equal((await call('GET', '/api/asset?project=Empty&id=hd2d/characters/Doc')).status, 404);
});

test('sprite files: the sheet, its JSON and the normal map are served sandboxed; nothing else', async () => {
  const json = await call('GET', '/asset-file?project=Pix&path=hd2d/characters/Doc/export/SPR_Doc.json');
  assert.equal(json.status, 200);
  assert.match(json.headers['content-type'], /^application\/json/);
  assert.match(json.headers['content-security-policy'], /sandbox/);
  assert.equal(json.json.meta.sprite.name, 'Doc');
  const normal = await call('GET', '/asset-file?project=Pix&path=hd2d/characters/Doc/export/SPR_Doc_N.png');
  assert.equal(normal.headers['content-type'], 'image/png');
  for (const path of ['hd2d/characters/Doc/brief.md', '../tools/sprite.mjs', 'hd2d/characters/Doc/export/SPR_Doc_E.png']) {
    assert.equal((await call('GET', `/asset-file?project=Pix&path=${encodeURIComponent(path)}`)).status, 404, path);
  }
});

test('a verdict on a sprite sets its status and logs a line in its brief', async () => {
  const r = await call('POST', '/api/asset-verdict', { body: { project: 'Pix', id: 'hd2d/characters/Doc', verdict: 'approve', notes: 'eyes glow nicely' } });
  assert.equal(r.status, 200, r.buf.toString());
  const dir = join(root, ...DOC.split('/'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'asset.json'), 'utf8')).status, 'approved');
  assert.match(readFileSync(join(dir, 'brief.md'), 'utf8'), /\n- \d{4}-\d{2}-\d{2} user verdict \(workspace app\): approve\. Notes:\n {2}eyes glow nicely\n$/);
});

test('sprite viewer clips: mirrored opposites, nearest direction, then the stand pose', () => {
  const frames = Array.from({ length: 12 }, (_, i) => ({ x: i * 32, y: 0, w: 32, h: 48, duration: 100 }));
  const tags = new Map(DIRECTIONS.map((d, i) => [`stand_${d}`, [frames[i]]]));
  tags.set('walk_south', [frames[8], frames[9]]);
  tags.set('walk_east', [frames[10]]);
  tags.set('attack_west', [frames[11]]);
  const sprite = { tags, frames, stand: 'stand' };
  assert.deepEqual(DIRECTIONS, ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']);
  assert.deepEqual(clipFor(sprite, 'walk', 'south'), { frames: [frames[8], frames[9]], flip: false, dir: 'south' });
  assert.deepEqual(clipFor(sprite, 'walk', 'west'), { frames: [frames[10]], flip: true, dir: 'west' });
  assert.deepEqual(clipFor(sprite, 'attack', 'east'), { frames: [frames[11]], flip: true, dir: 'east' });
  // north has no walk and no mirror: the nearest direction that has one (east, two steps away)
  assert.deepEqual(clipFor(sprite, 'walk', 'north'), { frames: [frames[10]], flip: false, dir: 'east' });
  // an animation the sheet doesn't have: the stand pose of that direction
  assert.deepEqual(clipFor(sprite, 'cast', 'north-west'), { frames: [frames[5]], flip: false, dir: 'north-west' });
});
