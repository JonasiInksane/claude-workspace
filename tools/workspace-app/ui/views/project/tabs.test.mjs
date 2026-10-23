// Tests for the project page's tab registry (views/project/tabs.js): every module keeps the tab
// contract (id = its file name, a label, render, and onShow with onHide or neither), ids are
// unique, every tab a project type names (project-types.mjs) has a module, and the lookups refuse
// what they don't know. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch, installDom } from '../../../test/dom.mjs';
import { PROJECT_TYPES } from '../../../project-types.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const { TABS, tabLabel, tabModule } = await import('./tabs.js');
const here = dirname(fileURLToPath(import.meta.url));

test('every tab module keeps the contract, and every file in the folder is listed', () => {
  const files = readdirSync(here).filter(n => n.endsWith('.js') && n !== 'tabs.js').map(n => n.slice(0, -3)).sort();
  assert.deepEqual(TABS.map(t => t.id).sort(), files, 'tabs.js lists exactly the tab modules in this folder');
  assert.equal(new Set(TABS.map(t => t.id)).size, TABS.length, 'no id twice');
  for (const t of TABS) {
    assert.ok(t.label && typeof t.label === 'string', `${t.id}: a label`);
    assert.equal(typeof t.render, 'function', `${t.id}: render`);
    assert.equal(typeof t.onShow === 'function', typeof t.onHide === 'function', `${t.id}: onShow and onHide come as a pair`);
  }
});

test('every tab of every project type has its module', () => {
  for (const type of PROJECT_TYPES) {
    for (const id of type.tabs) assert.ok(tabModule(id), `${type.id}: ${id}`);
  }
});

test('tabModule and tabLabel: known ids only, no prototype lookups', () => {
  assert.equal(tabModule('findings').label, 'Findings');
  assert.equal(tabLabel('architecture'), 'Architecture');
  assert.equal(tabModule('nope'), null);
  assert.equal(tabModule('constructor'), null);
  assert.equal(tabModule(undefined), null);
  assert.equal(tabLabel('nope'), 'nope');
  assert.equal(tabLabel(undefined), '');
});
