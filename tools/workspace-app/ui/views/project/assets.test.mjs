// Tests for the project page's Assets tab (views/project/assets.js), rendered in a stand-in DOM
// (test/dom.mjs): a project with an asset pipeline shows its assets as the Assets view does, and
// every project gets the note that project assets arrive with the asset library, with a way to
// Inbox images. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const store = await import('../../store.js');
const { pipelineAssets, default: assets } = await import('./assets.js');

const crate = { id: 'lowpoly/props/Crate', kind: 'model', name: 'Crate', style: 'lowpoly', category: 'props', cls: '', source: 'procedural', status: 'review', final: null, raw: null, thumb: '' };
const ctx = p => ({ state: store.state, project: p, rest: '', go: store.go, refresh: () => {} });

test('pipelineAssets: the state.assets entry of a project, or null', () => {
  const list = [{ project: 'sample-art', assets: [crate] }];
  assert.equal(pipelineAssets('sample-art', list).assets.length, 1);
  assert.equal(pipelineAssets('notes', list), null);
  assert.equal(pipelineAssets('sample-art', null), null);
  assert.equal(pipelineAssets('sample-art', [null]), null);
});

test('the tab: an asset pipeline shows its assets; every project gets the asset library note', () => {
  const art = { name: 'sample-art', type: { id: 'assets', label: 'Asset pipeline' }, tabs: ['overview', 'assets'], realPath: 'C:\\x' };
  const notes = { name: 'notes', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'assets'], realPath: 'C:\\y' };
  store.setState({ root: 'C:\\ws', tools: {}, projects: [art, notes], assets: [{ project: 'sample-art', assets: [crate] }] });
  const el = dom.document.createElement('div');
  assets.render(el, ctx(art));
  assert.match(textOf(el), /sample-art 1 asset/);
  assert.match(textOf(el), /Crate/);
  assert.match(textOf(el), /Project assets arrive with the asset library/);
  assets.render(el, ctx(notes));
  assert.doesNotMatch(textOf(el), /Crate/, 'a plain project has no pipeline card');
  assert.match(textOf(el), /Project assets arrive with the asset library/);
  dom.click(el.querySelector('[data-key="as:images"]'));
  assert.equal(dom.location.hash, '#images', 'Inbox images opens the image upload');
});
