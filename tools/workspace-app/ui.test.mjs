// Tests for the page's module layout (tools/workspace-app/ui/): hash routing helpers, and the
// view registry contract, checked from the source because the views need a browser to run.
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFor, parseHash } from './ui/store.js';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const read = rel => readFileSync(join(uiDir, ...rel.split('/')), 'utf8');

test('hash routes: #<view> and #<view>/<sub>, encoded both ways', () => {
  assert.deepEqual(parseHash('#flows'), { id: 'flows', sub: '' });
  assert.deepEqual(parseHash('#flows/hero-sprite'), { id: 'flows', sub: 'hero-sprite' });
  assert.deepEqual(parseHash('#projects/game-dev/findings'), { id: 'projects', sub: 'game-dev/findings' });
  assert.deepEqual(parseHash(''), { id: '', sub: '' });
  assert.deepEqual(parseHash('#flows/%E0%A4%A'), { id: 'flows', sub: '' }); // broken encoding
  assert.equal(hashFor('home'), '#home');
  assert.equal(hashFor('flows', 'a b/c'), '#flows/a%20b/c');
  assert.deepEqual(parseHash(hashFor('runs', 'x y#1')), { id: 'runs', sub: 'x y#1' });
});

test('views: every ui/views/<id>.js is registered in main.js, says its id, and its CSS is linked', () => {
  const main = read('main.js');
  const index = read('index.html');
  const registry = main.match(/const VIEWS = \[([^\]]*)\]/)[1].split(',').map(s => s.trim()).filter(Boolean);
  const views = readdirSync(join(uiDir, 'views')).filter(n => n.endsWith('.js')).map(n => n.slice(0, -3));
  assert.deepEqual([...views].sort(), [...registry].sort(), 'VIEWS in main.js lists exactly the files in ui/views/');
  for (const id of views) {
    assert.match(main, new RegExp(`import ${id} from './views/${id}\\.js';`), `main.js imports views/${id}.js as ${id}`);
    const src = read(`views/${id}.js`);
    assert.match(src, /export default \{/, `${id}: default export`);
    assert.match(src, new RegExp(`\\n  id: '${id}',`), `${id}: id matches the file name`);
    for (const key of ['label', 'icon', 'render']) assert.match(src, new RegExp(`\\n  ${key}[,:]`), `${id}: ${key}`);
  }
  for (const css of readdirSync(join(uiDir, 'css'))) {
    assert.ok(index.includes(`<link rel="stylesheet" href="/css/${css}">`), `index.html links css/${css}`);
  }
  assert.ok(existsSync(join(uiDir, 'app.css')) && index.indexOf('/app.css') < index.indexOf('/css/'), 'app.css comes first');
});
