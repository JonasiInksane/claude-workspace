// Tests for the project page's Assets tab (views/project/assets.js) in a stand-in DOM with a fake
// server (test/dom.mjs): the attached assets (shared, its own and a missing one, with their pins)
// and its own unattached assets; Attach, Detach and Attach shared… saving the settings with
// basedOn and only the attached assets, a 409 that says so and loads them again; a card's details
// with Attach or Detach; New asset…, a drop on the card and Ctrl+V opening the upload for the
// project; the game assets of a pipeline project; a folder name that can't have settings.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, settle, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());

const entry = (ref, title, kind, over = {}) => {
  const [place, id] = ref.split(':');
  return {
    ref, id, scope: place === 'shared' ? 'shared' : 'project', project: place === 'shared' ? null : place, title, kind, tags: [], description: '',
    archived: false, latest: { n: 2, sha256: 'a'.repeat(64), bytes: 300, type: 'image/png' }, versionCount: 2, ...over,
  };
};
const library = [
  entry('shared:guide', 'Guide', 'text'),
  entry('shared:brand', 'Brand colours', 'image'),
  entry('example:logo', 'Logo', 'image'),
  entry('example:schema', 'Order schema', 'text'),
  entry('example:old', 'Old sketch', 'image', { archived: true }),
  entry('notes:list', 'Reading list', 'text'),
];
let current = { version: 3, savedAt: new Date().toISOString(), rules: '- Keep me.', defaults: { model: '', effort: '', permissionMode: '' }, allowedTools: '', assets: [{ ref: 'shared:guide', pin: null }, { ref: 'example:logo', pin: 1 }, { ref: 'shared:gone', pin: null }], sha256: 'b'.repeat(64) };
let conflict = false;
const calls = fakeFetch((path, { method, body }) => {
  const url = new URL(path, 'http://x');
  const project = url.searchParams.get('project');
  if (method === 'GET' && url.pathname === '/api/library') return { ok: true, assets: library.filter(a => a.scope === 'shared' || a.project === project) };
  if (method === 'GET' && url.pathname === '/api/project-settings') {
    return { ok: true, project, current: project === 'example' ? current : null, versions: [], limits: { rules: 20000, assets: 50, allowedTools: 20 }, choices: {} };
  }
  if (method === 'POST' && url.pathname === '/api/project-settings') {
    if (conflict) { conflict = false; current = { ...current, version: current.version + 1 }; return reply(409, { ok: false, error: 'The settings of example changed since you opened them.' }); }
    if (body.basedOn !== current.version) return reply(409, { ok: false, error: 'stale' });
    current = { ...current, version: current.version + 1, assets: body.assets };
    return { ok: true, project: 'example', version: current.version, sha256: 'c'.repeat(64), unchanged: false, message: `Saved the settings of example as v${current.version}` };
  }
  if (method === 'GET' && url.pathname === '/api/library/asset') {
    const a = library.find(x => x.ref === url.searchParams.get('ref'));
    return { ok: true, asset: { ...a, createdAt: '', versions: [{ n: 1, file: 'v1.png', sha256: 'd'.repeat(64), bytes: 1, type: 'image/png', addedAt: '', note: '', originalName: '' }, { n: 2, file: 'v2.png', sha256: 'e'.repeat(64), bytes: 1, type: 'image/png', addedAt: '', note: '', originalName: '' }] } };
  }
  return { ok: true };
});
globalThis.confirm = () => true;

const store = await import('../../store.js');
const { attachedEntries, pinBadge, pipelineAssets, default: assets } = await import('./assets.js');
const dialog = dom.document.querySelector('#dialog');
const toasts = () => dom.document.querySelector('#toasts').textContent;
const byKey = (root, key) => root.querySelectorAll('[data-key]').find(n => n.dataset.key === key);

const crate = { id: 'lowpoly/props/Crate', kind: 'model', name: 'Crate', style: 'lowpoly', category: 'props', cls: '', source: 'procedural', status: 'review', final: null, raw: null, thumb: '' };
const ctx = p => ({ state: store.state, project: p, rest: '', go: store.go, refresh: () => {} });
const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'assets'], realPath: 'C:\\x' };
const art = { name: 'sample-art', type: { id: 'assets', label: 'Asset pipeline' }, tabs: ['overview', 'assets'], realPath: 'C:\\y' };
store.setState({ root: 'C:\\ws', tools: {}, projects: [example, art], assets: [{ project: 'sample-art', assets: [crate] }] });

async function open(p) {
  const el = dom.document.createElement('div');
  dom.document.body.append(el);
  assets.onShow(ctx(p));
  assets.render(el, ctx(p));
  await settle(5);
  assets.render(el, ctx(p));
  return el;
}
const grids = el => el.querySelectorAll('.pa-library .lib-grid');
const titles = grid => grid.querySelectorAll('.lib-title').map(t => t.textContent);

test('pure helpers: pipelineAssets, attachedEntries and pinBadge', () => {
  const list = [{ project: 'sample-art', assets: [crate] }];
  assert.equal(pipelineAssets('sample-art', list).assets.length, 1);
  assert.equal(pipelineAssets('notes', list), null);
  assert.equal(pipelineAssets('sample-art', null), null);
  assert.equal(pipelineAssets('sample-art', [null]), null);
  assert.deepEqual(attachedEntries(current, library).map(e => [e.ref, e.pin, e.asset && e.asset.title]),
    [['shared:guide', null, 'Guide'], ['example:logo', 1, 'Logo'], ['shared:gone', null, null]]);
  assert.deepEqual(attachedEntries(null, library), []);
  assert.deepEqual(pinBadge(null, library[0]), { text: 'Follows the latest (v2)', cls: 'ok' });
  assert.deepEqual(pinBadge(1, library[0]), { text: 'Pinned to v1', cls: 'blue' });
  assert.equal(pinBadge(7, library[0]).text, 'v7 missing');
  assert.equal(pinBadge(null, null).text, 'Follows the latest');
});

test('the attached assets and its own: pins, a missing one, archived ones only on request', async () => {
  const el = await open(example);
  const [attached, own] = grids(el);
  assert.deepEqual(titles(attached), ['Guide', 'Logo', 'shared:gone']);
  assert.match(textOf(attached.querySelectorAll('.lib-card')[0]), /Follows the latest \(v2\)/);
  assert.match(textOf(attached.querySelectorAll('.lib-card')[1]), /Pinned to v1/);
  const gone = attached.querySelectorAll('.lib-card')[2];
  assert.equal(gone.querySelector('.lib-meta').textContent, 'Not in the library any more');
  assert.equal(gone.querySelector('.badge.red').textContent, 'Missing');
  assert.ok(byKey(gone, 'pa:detach:shared:gone'), 'a missing one can still be detached');
  assert.deepEqual(titles(own), ['Order schema'], 'attached ones are not listed twice; archived ones wait');
  assert.match(textOf(el), /Attached in its settings \(3\)/);
  assert.match(textOf(el), /Show archived \(1\)/);
  const box = el.querySelector('.pa-library .card-head input[type="checkbox"]');
  box.checked = true;
  box.dispatchEvent(fakeEvent('change'));
  await settle(5);
  assets.render(el, ctx(example));
  assert.deepEqual(titles(grids(el)[1]), ['Order schema', 'Old sketch']);
  box.checked = false;
  box.dispatchEvent(fakeEvent('change'));
  await settle(5);
  assets.onHide();
});

test('Attach and Detach save the settings with basedOn and only the attached assets; a 409 loads them again', async () => {
  const el = await open(example);
  dom.click(byKey(el, 'pa:attach:example:schema'));
  await settle(5);
  let post = calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop();
  assert.deepEqual(post.body, { project: 'example', basedOn: 3, assets: [{ ref: 'shared:guide', pin: null }, { ref: 'example:logo', pin: 1 }, { ref: 'shared:gone', pin: null }, { ref: 'example:schema', pin: null }] });
  assert.match(toasts(), /Attached Order schema to example \(settings v4\)/);
  assets.render(el, ctx(example));
  assert.deepEqual(titles(grids(el)[0]), ['Guide', 'Logo', 'shared:gone', 'Order schema']);
  dom.click(byKey(el, 'pa:detach:shared:gone'));
  await settle(5);
  post = calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop();
  assert.deepEqual(post.body.assets.map(a => a.ref), ['shared:guide', 'example:logo', 'example:schema']);
  assert.equal(post.body.basedOn, 4);
  assert.equal('rules' in post.body, false, 'the rules and the rest stay as they are on the server');
  // Saved elsewhere meanwhile: says so, and the settings load again.
  conflict = true;
  assets.render(el, ctx(example));
  const before = calls.length;
  dom.click(byKey(el, 'pa:detach:example:schema'));
  await settle(5);
  assert.match(toasts(), /changed elsewhere meanwhile\. They are loaded again: try once more/);
  assert.ok(calls.slice(before).some(c => c.path === '/api/project-settings?project=example'), 'loaded again');
  assets.onHide();
});

test('Attach shared… offers shared assets only; a card opens its details with Attach or Detach', async () => {
  const el = await open(example);
  dom.click(byKey(el, 'pa:attach-shared:example'));
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.querySelectorAll('.lib-pick .title').map(t => t.textContent), ['Guide', 'Brand colours']);
  const box = dialog.querySelectorAll('.lib-pick input')[1];
  box.checked = true;
  box.dispatchEvent(fakeEvent('change'));
  dom.click(dialog.querySelector('[data-key="pk:attach"]'));
  await settle(5);
  assert.equal(dialog.open, false);
  const post = calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop();
  assert.ok(post.body.assets.some(a => a.ref === 'shared:brand'));
  assets.render(el, ctx(example));
  dom.click(byKey(el, 'pa:open:shared:brand'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('[data-key="ad:attach"]').textContent, 'Detach from example');
  dom.click(dialog.querySelector('[data-key="ad:attach"]'));
  await settle(5);
  assert.equal(dialog.querySelector('[data-key="ad:attach"]').textContent, 'Attach to example');
  assert.ok(!calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop().body.assets.some(a => a.ref === 'shared:brand'));
  dialog.close();
  assets.onHide();
});

test('New asset…, a drop on the card and Ctrl+V open the upload for this project', async () => {
  const el = await open(example);
  dom.click(byKey(el, 'pa:new:example'));
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /For example only/);
  dialog.close();
  const card = el.querySelector('.pa-library');
  card.dispatchEvent(fakeEvent('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'sketch.png', size: 5, type: 'image/png' }], items: [] } }));
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('#libNewTitle').value, 'sketch');
  dialog.close();
  // Ctrl+V with a file on the tab; text pasted into a text box stays text; an open dialog takes its own.
  const paste = (props = {}) => dom.document.dispatchEvent(fakeEvent('paste', { clipboardData: { files: [{ name: 'image.png', size: 5, type: 'image/png' }], types: ['Files'] }, target: dom.document.body, ...props }));
  paste();
  assert.equal(dialog.open, true);
  assert.match(dialog.querySelector('#libNewTitle').value, /^Pasted image /);
  paste();
  assert.equal(dialog.querySelectorAll('.lib-files li').length, 1, 'with the dialog open, main.js hands it the files instead');
  dialog.close();
  const input = dom.document.createElement('input');
  paste({ target: input, clipboardData: { files: [{ name: 'image.png', size: 5, type: 'image/png' }], types: ['text/plain', 'Files'] } });
  assert.equal(dialog.open, false, 'text into a text box');
  assets.onHide();
  paste();
  assert.equal(dialog.open, false, 'only while the tab is on show');
});

test('a pipeline project shows its game assets below; a folder name without settings can not attach', async () => {
  const el = await open(art);
  assert.match(textOf(el), /Game assets from the asset pipeline/);
  assert.match(textOf(el), /sample-art 1 asset/);
  assert.match(textOf(el), /Crate/);
  assert.match(textOf(el), /No assets of its own yet/);
  assert.match(textOf(el), /Nothing attached yet\. Attach a shared asset, or one of the project's own below: runs, sessions and flows started here get what is attached\./);
  assets.onHide();
  const upper = { name: 'BigApp', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'assets'], realPath: 'C:\\z' };
  const n = calls.length;
  const el2 = await open(upper);
  assert.match(textOf(el2), /Assets can be attached only to a project whose folder name is lowercase/);
  assert.equal(byKey(el2, 'pa:attach-shared:BigApp').disabled, true);
  assert.equal(byKey(el2, 'pa:attach-shared:BigApp').getAttribute('aria-describedby'), 'pa-why-BigApp');
  assert.ok(!calls.slice(n).some(c => c.path.startsWith('/api/project-settings')), 'no settings are asked for');
  assert.ok(calls.slice(n).some(c => c.path === '/api/library?project=BigApp&archived=1'), 'its own assets are');
  assets.onHide();
});
