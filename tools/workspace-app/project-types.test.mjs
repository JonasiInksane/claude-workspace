// Tests for project-types.mjs: the registry's order and tabs, which type a project gets (a profile
// wins over an asset pipeline, a bad name or a missing data folder is never `code`), the fields
// /api/state sends, and that every tab a type names has its module in ui/views/project/.
// Everything is written under os.tmpdir(). Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasAssetPipeline, hasProfile, PROJECT_TYPES, projectTypeOf, typeById, typeFields } from './project-types.mjs';
import { tempDir, writeFiles } from './test/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the registry: code, assets, then generic last; each type lists its tabs, Overview first', () => {
  assert.deepEqual(PROJECT_TYPES.map(t => t.id), ['code', 'assets', 'generic']);
  assert.deepEqual(typeById('code').tabs, ['overview', 'tasks', 'findings', 'changes', 'checks', 'architecture', 'assets', 'settings']);
  assert.deepEqual(typeById('assets').tabs, ['overview', 'assets', 'agents', 'settings']);
  assert.deepEqual(typeById('generic').tabs, ['overview', 'agents', 'assets', 'settings']);
  for (const t of PROJECT_TYPES) {
    assert.ok(t.label && typeof t.label === 'string', `${t.id} has a label`);
    assert.equal(new Set(t.tabs).size, t.tabs.length, `${t.id}: no tab twice`);
    assert.equal(t.tabs[0], 'overview', `${t.id}: Overview is the default tab`);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.tabs), `${t.id} can't be changed by a caller`);
  }
  assert.equal(typeById('nope'), null);
  assert.equal(typeById('constructor'), null);
});

test('projectTypeOf: a profile makes it code, an asset pipeline assets, everything else generic', () => {
  const root = tempDir('ws-types-root-');
  const dataDir = tempDir('ws-types-data-');
  writeFiles(join(root, 'projects'), {
    'app/package.json': '{}',
    'art/tools/asset.mjs': '// stub\n',
    'art/assets/lowpoly/props/Crate/asset.json': { name: 'Crate' },
    'sprites/tools/sprite.mjs': '// stub\n',
    'sprites/assets/readme.txt': 'x',
    'half/tools/asset.mjs': '// no assets folder\n',
    'both/tools/asset.mjs': '// stub\n',
    'both/assets/readme.txt': 'x',
    'notes/CLAUDE.md': '# Notes\n',
  });
  writeFiles(join(dataDir, 'profiles'), { 'app.json': {}, 'both.json': {} });
  const of = name => projectTypeOf({ root, dataDir, name }).id;
  assert.equal(of('app'), 'code');
  assert.equal(of('art'), 'assets');
  assert.equal(of('sprites'), 'assets', 'the sprite pipeline counts too');
  assert.equal(of('half'), 'generic', 'a pipeline script without an assets/ folder is not a pipeline');
  assert.equal(of('both'), 'code', 'the first match wins: a profile beats an asset pipeline');
  assert.equal(of('notes'), 'generic');
  assert.equal(of('missing'), 'generic', 'an unknown folder is still a plain project');
});

test('projectTypeOf: bad names, a missing data folder and odd input never make a code project', () => {
  const root = tempDir('ws-types-root-');
  const dataDir = tempDir('ws-types-data-');
  // On Windows bigapp.json is also BigApp.json: the name check comes first, not the file system.
  writeFiles(join(dataDir, 'profiles'), { 'bigapp.json': {}, '..json': {} });
  writeFiles(join(root, 'projects'), { 'BigApp/CLAUDE.md': '# B\n' });
  assert.equal(projectTypeOf({ root, dataDir, name: 'BigApp' }).id, 'generic', 'the data folder only holds lowercase names');
  assert.equal(projectTypeOf({ root, dataDir, name: '.' }).id, 'generic');
  assert.equal(projectTypeOf({ root, dataDir, name: '../profiles/x' }).id, 'generic');
  assert.equal(projectTypeOf({ root, name: 'bigapp' }).id, 'generic', 'no data folder: no profile');
  assert.equal(projectTypeOf().id, 'generic');
  assert.equal(projectTypeOf(null).id, 'generic');
  assert.equal(projectTypeOf('code').id, 'generic');
  assert.equal(hasProfile('', 'app'), false);
  assert.equal(hasProfile(dataDir, null), false);
  assert.equal(hasProfile(dataDir, 'BigApp'), false);
  assert.equal(hasProfile(dataDir, 'bigapp'), true);
});

test('hasAssetPipeline: a list from the caller is used instead of scanning projects/', () => {
  assert.equal(hasAssetPipeline({ name: 'art', assetProjects: ['art'] }), true);
  assert.equal(hasAssetPipeline({ name: 'Art', assetProjects: ['art'] }), false, 'folder names match as spelled');
  assert.equal(hasAssetPipeline({ name: 'art', assetProjects: [] }), false);
  assert.equal(hasAssetPipeline({ name: '', assetProjects: [''] }), false);
  assert.equal(hasAssetPipeline({ name: 'art' }), false, 'no root and no list: nothing to look at');
  const root = tempDir('ws-types-root-');
  assert.equal(projectTypeOf({ root, name: 'ghost', assetProjects: ['ghost'] }).id, 'assets', 'the given list wins');
});

test('typeFields: what /api/state sends, as copies the caller may change', () => {
  const t = typeById('assets');
  const f = typeFields(t);
  assert.deepEqual(f, { type: { id: 'assets', label: 'Asset pipeline' }, tabs: ['overview', 'assets', 'agents', 'settings'] });
  f.tabs.push('extra');
  assert.deepEqual(typeById('assets').tabs, ['overview', 'assets', 'agents', 'settings']);
});

test('every tab a type names has its module in ui/views/project/ and is listed in tabs.js', () => {
  const dir = join(here, 'ui', 'views', 'project');
  const list = readFileSync(join(dir, 'tabs.js'), 'utf8');
  for (const id of new Set(PROJECT_TYPES.flatMap(t => t.tabs))) {
    assert.ok(existsSync(join(dir, `${id}.js`)), `ui/views/project/${id}.js exists`);
    assert.match(list, new RegExp(`import \\w+ from '\\./${id}\\.js';`), `tabs.js imports ${id}.js`);
  }
});
