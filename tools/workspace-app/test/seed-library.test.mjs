// Tests for test/seed-library.mjs (the --seed module for screenshots): on a temporary workspace
// with the three synthetic projects it makes the library the screens show (shared and project
// assets of every kind, versions, one archived) and two settings versions of "example", all
// readable by the app's own modules. Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getAsset, listLibrary } from '../asset-library.mjs';
import { readSettings } from '../project-settings.mjs';
import { tempDir, writeFiles } from './helpers.mjs';
import seed from './seed-library.mjs';

test('the seed makes shared and project assets with versions, and two settings versions of example', async t => {
  const base = tempDir('ws-seed-', t);
  const root = join(base, 'ws');
  const dataDir = join(base, 'data');
  writeFiles(root, { 'projects/example/README.md': '# example\n', 'projects/sample-art/CLAUDE.md': '# art\n', 'projects/notes/CLAUDE.md': '# notes\n' });
  await seed({ root, dataDir });
  const all = await listLibrary(root, { includeArchived: true });
  assert.deepEqual(all.map(a => a.ref), [
    'shared:api-conventions', 'shared:brand-colours', 'shared:old-logo', 'shared:release-checklist', 'shared:writing-style',
    'example:checkout-wireframe', 'example:order-schema', 'notes:reading-list', 'sample-art:crate-reference',
  ]);
  assert.deepEqual([...new Set(all.map(a => a.kind))].sort(), ['image', 'pdf', 'text']);
  assert.ok(all.every(a => !a.error), 'every record can be read');
  assert.deepEqual(all.filter(a => a.archived).map(a => a.ref), ['shared:old-logo']);
  assert.equal((await getAsset(root, 'shared:writing-style')).versions.length, 3);
  assert.equal((await getAsset(root, 'example:checkout-wireframe')).versions.length, 2);
  const { current, versions } = await readSettings(dataDir, 'example');
  assert.deepEqual(versions.map(v => v.version), [2, 1]);
  assert.equal(current.defaults.permissionMode, 'plan');
  assert.deepEqual(current.assets.map(a => [a.ref, a.pin]), [
    ['shared:writing-style', null], ['shared:brand-colours', 1], ['example:checkout-wireframe', null], ['shared:retired-guide', null],
  ]);
  assert.ok(Date.parse(versions[1].savedAt) < Date.parse(versions[0].savedAt), 'v1 is older');
});
