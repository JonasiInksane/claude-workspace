// Tests for the attached assets in the Flows view (views/flows.js): the pure helpers (which
// project's own assets a target may attach, the status of an attached asset, the picker's
// choices, the saved text, a recorded run's assets, the run dialog's session line and notes), the
// editor's asset picker in the stand-in DOM (test/dom.mjs): statuses, Attach, a pinned version,
// Remove (the focus goes to the picker), another target reloads the library, Save sends the list,
// and the run dialog's preview following the chosen project.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, fakeFetch, installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
// The two parts of a <select> the editor's target picker uses that the stand-in DOM leaves out,
// added for this file only: its options, and prepend.
Object.defineProperty(FakeElement.prototype, 'options', { configurable: true, get() { return this.querySelectorAll('option'); } });
FakeElement.prototype.prepend = function prepend(node) { this.insertBefore(node, this.firstChild); };
after(() => { delete FakeElement.prototype.options; delete FakeElement.prototype.prepend; });

const LIBRARY = [
  { ref: 'shared:style-guide', scope: 'shared', title: 'Style guide', kind: 'text', archived: false, latest: { n: 2 } },
  { ref: 'shared:logo', scope: 'shared', title: 'Logo', kind: 'image', archived: true, latest: { n: 1 } },
  { ref: 'example:palette', scope: 'project', project: 'example', title: 'Palette', kind: 'image', archived: false, latest: { n: 3 } },
  { ref: 'shared:broken', scope: 'shared', title: 'broken', kind: '', archived: false, latest: null, error: 'asset.json is not a JSON object' },
];
const FLOW = {
  ok: true, slug: 'demo', title: 'Demo', description: '', target: 'project', project: 'example', agent: '', prompt: 'Use the assets.', hash: 'h1',
  permissionMode: '', model: '', effort: '', allowedTools: '', ask: '', askRequired: false, images: [], skipped: [],
  assets: 'shared:style-guide@1, example:gone', assetList: [{ ref: 'shared:style-guide', pin: 1 }, { ref: 'example:gone', pin: null }],
};
let preview = { ok: true, prompt: 'P', launch: {}, notesError: '', project: '', projectSettings: null, assets: [], problems: [], note: '' };
const ANY = { ...FLOW, slug: 'any', title: 'Any', project: '*', assets: '', assetList: [] };
const calls = fakeFetch((path, { method, body }) => {
  if (path === '/api/flow?slug=any') return ANY;
  if (path.startsWith('/api/flow?')) return FLOW;
  if (path.startsWith('/api/library?')) return { ok: true, assets: LIBRARY };
  if (path.startsWith('/api/flow-runs?')) return { ok: true, flow: 'demo', current: null, runs: [] };
  if (path === '/api/flows' && method === 'POST') return { ok: true, slug: 'demo', hash: 'h2', message: 'Flow saved' };
  if (path === '/api/flows/run' && body && body.preview) return preview;
  return { ok: true, projects: [], flows: [], archivedFlows: [], tools: {} };
});
const store = await import('../store.js');
const flows = await import('./flows.js');
const {
  assetChoices, assetProject, assetRefusal, assetStatus, formatAssets, previewNotes, runAssetsText, runFlowDialog, sessionLine,
} = flows;

test('which assets a target may attach, and the text a list saves as', () => {
  assert.deepEqual(['hub', 'project:*', 'project:example', 'agent:example/artist'].map(assetProject), ['', '', 'example', 'example']);
  assert.equal(assetRefusal('shared:x', 'hub'), '');
  assert.equal(assetRefusal('SHARED:x', 'project:*'), '');
  assert.equal(assetRefusal('example:x', 'project:example'), '');
  assert.equal(assetRefusal('Example:x', 'agent:example/artist'), '', 'project names match without case');
  assert.equal(assetRefusal('example:x', 'hub'), 'belongs to example; this flow can attach shared assets only');
  assert.equal(assetRefusal('notes:x', 'project:example'), "belongs to notes; this flow can attach shared assets and example's own");
  assert.equal(formatAssets([{ ref: 'shared:a', pin: null }, { ref: 'example:b', pin: 2 }]), 'shared:a, example:b@2');
  assert.equal(formatAssets(undefined), '');
});

test('an attached asset\'s status: its version, archived, gone, unreadable or not allowed', () => {
  const s = (a, v = 'project:example') => assetStatus(a, LIBRARY, v);
  assert.deepEqual(s({ ref: 'shared:style-guide', pin: null }), { text: 'The latest, now v2', cls: '' });
  assert.deepEqual(s({ ref: 'shared:style-guide', pin: 1 }), { text: 'Pinned to v1 (the latest is v2)', cls: '' });
  assert.deepEqual(s({ ref: 'shared:style-guide', pin: 2 }), { text: 'Pinned to v2', cls: '' });
  assert.deepEqual(s({ ref: 'shared:style-guide', pin: 5 }), { text: 'Has no version 5: a run would refuse it', cls: 'red' });
  assert.deepEqual(s({ ref: 'shared:logo', pin: null }), { text: 'The latest, now v1 · archived, still used (archiving only hides it)', cls: 'amber' });
  assert.deepEqual(s({ ref: 'example:gone', pin: null }), { text: 'Not in the library: a run would refuse it', cls: 'red' });
  assert.deepEqual(s({ ref: 'shared:broken', pin: null }), { text: "Can't be read: asset.json is not a JSON object", cls: 'red' });
  assert.deepEqual(s({ ref: 'example:palette', pin: null }, 'hub'), { text: 'Not allowed here: belongs to example; this flow can attach shared assets only', cls: 'red' });
  // The picker offers what is allowed, readable, not archived and not attached yet.
  assert.deepEqual(assetChoices(LIBRARY, [{ ref: 'shared:style-guide' }], 'project:example').map(e => e.ref), ['example:palette']);
  assert.deepEqual(assetChoices(LIBRARY, [], 'hub').map(e => e.ref), ['shared:style-guide']);
  assert.deepEqual(assetChoices(null, [], 'hub'), []);
});

test('a recorded run\'s assets, the run dialog\'s session line and its notes', () => {
  assert.equal(runAssetsText({ assets: [{ ref: 'shared:a', version: 2 }, { ref: 'example:b', version: 1 }] }), 'with shared:a v2, example:b v1');
  assert.equal(runAssetsText({ assets: [] }), '');
  assert.equal(runAssetsText({}), '');
  assert.equal(sessionLine({ launch: { permissionMode: 'plan', model: 'opus', allowedTools: ['Read'], appendSystemPrompt: 'Rules.' }, project: 'example', projectSettings: { version: 2 } }),
    'Session: plan mode · model opus · pre-approved: Read. The rules of example (settings v2) go into the system prompt.');
  assert.equal(sessionLine({ launch: { effort: 'low' }, project: 'example', projectSettings: { version: 1 } }), "Session: effort low. example's settings v1 apply.");
  assert.equal(sessionLine({ launch: {} }), 'Session: your default mode, model and effort.');
  assert.deepEqual(previewNotes({ problems: ['shared:x has no version 3'], note: 'Choose a project to see its settings and attached assets.',
    assets: [{ ref: 'shared:logo', archived: true }, { ref: 'shared:gone', archived: true, missing: true }] }), [
    { text: 'A run would be refused: shared:x has no version 3', problem: true },
    { text: 'Choose a project to see its settings and attached assets.', problem: false },
    { text: 'Archived, still used: shared:logo.', problem: false },
  ]);
  assert.deepEqual(previewNotes({}), []);
});

const dialogEl = () => dom.document.getElementById('dialog');
const rowsOf = () => dialogEl().querySelectorAll('.flow-asset-list li');

test('the editor\'s asset picker: statuses, Attach, a version, Remove, another target, and Save sends the list', async () => {
  store.setState({
    root: 'C:\\ws', tools: { claude: true }, archivedFlows: [], assets: [],
    projects: [{ name: 'example', launchable: true, agents: [] }, { name: 'notes', launchable: true, agents: [] }],
    flows: [{ slug: 'demo', title: 'Demo', description: '', target: 'project', project: 'example', agent: '', images: 0, launch: {}, error: '' }],
  });
  const el = dom.document.createElement('section');
  dom.document.body.append(el);
  flows.default.render(el, { state: store.state, sub: '' });
  dom.click(el.querySelector('[data-key="flow-demo-edit"]'));
  await settle(10);
  assert.ok(calls.some(c => c.path === '/api/library?archived=1&project=example'), 'the target project\'s library, archived ones included');
  assert.deepEqual(rowsOf().map(li => textOf(li.querySelector('.main'))), [
    'Style guide shared:style-guide · text Pinned to v1 (the latest is v2)',
    'example:gone example:gone Not in the library: a run would refuse it',
  ]);
  assert.ok(rowsOf()[1].querySelector('.asset-status.is-red'), 'a status that stops a run reads red');
  const pick = dialogEl().querySelector('#flowAssetPick');
  assert.equal(pick.getAttribute('aria-label'), 'Asset to attach');
  assert.deepEqual(pick.querySelectorAll('option').map(o => [o.getAttribute('value'), textOf(o)]), [['', 'Choose an asset…'], ['example:palette', 'Palette (example:palette, image)']]);
  // The version of the style guide: v1 is pinned; choosing Latest follows the newest.
  const version = rowsOf()[0].querySelector('select');
  assert.equal(version.getAttribute('aria-label'), 'Version of Style guide');
  assert.deepEqual(version.querySelectorAll('option').map(o => o.getAttribute('value')), ['', '2', '1']);
  assert.equal(version.value, '1');
  version.value = '';
  version.dispatchEvent({ type: 'change', bubbles: true, target: version, preventDefault() {}, stopPropagation() {} });
  assert.match(textOf(rowsOf()[0]), /The latest, now v2/);
  // Attach the palette; remove the gone one (the focus goes back to the picker).
  pick.value = 'example:palette';
  dom.click(dialogEl().querySelector('.flow-asset-add button'));
  assert.deepEqual(rowsOf().map(li => li.dataset.key), ['asset:shared:style-guide', 'asset:example:gone', 'asset:example:palette']);
  assert.equal(dom.document.activeElement, dialogEl().querySelector('#flowAssetPick'));
  const remove = rowsOf()[1].querySelector('button');
  assert.equal(remove.getAttribute('aria-label'), 'Remove example:gone');
  dom.click(remove);
  assert.equal(rowsOf().length, 2);
  assert.equal(dom.document.activeElement, dialogEl().querySelector('#flowAssetPick'));
  assert.match(textOf(dialogEl().querySelector('#flowAssetPick')), /No other asset can be attached/);
  // Another target reads the library again; the project asset is not allowed in the hub.
  const target = dialogEl().querySelector('.flow-form select');
  target.value = 'hub';
  target.dispatchEvent({ type: 'change', bubbles: true, target, preventDefault() {}, stopPropagation() {} });
  await settle(10);
  assert.ok(calls.some(c => c.path === '/api/library?archived=1'), 'the hub: no project');
  assert.match(textOf(rowsOf()[1]), /Not allowed here: belongs to example; this flow can attach shared assets only/);
  target.value = 'project:example';
  target.dispatchEvent({ type: 'change', bubbles: true, target, preventDefault() {}, stopPropagation() {} });
  await settle(10);
  // Save sends the list as text, in the order shown.
  const save = dialogEl().querySelectorAll('.dialog-actions button').find(b => textOf(b) === 'Save');
  dom.click(save);
  await settle(10);
  const sent = calls.filter(c => c.path === '/api/flows' && c.method === 'POST').at(-1);
  assert.equal(sent.body.assets, 'shared:style-guide, example:palette');
  dialogEl().close();
});

test('the run dialog previews with the chosen project and shows the effective launch and what a run would refuse', async () => {
  store.setState({ projects: [{ name: 'example', launchable: true, agents: [] }], flows: [] });
  preview = { ok: true, prompt: 'Review what changed.', launch: { permissionMode: 'plan' }, notesError: '', project: '', projectSettings: null, assets: [],
    problems: [], note: 'Choose a project to see its settings and attached assets.' };
  const before = calls.length;
  await runFlowDialog({ slug: 'any', title: 'Any', target: 'project', project: '*' });
  await settle(10);
  const previews = () => calls.slice(before).filter(c => c.path === '/api/flows/run' && c.body.preview);
  assert.equal(previews()[0].body.project, undefined, 'no project chosen yet');
  assert.match(textOf(dialogEl()), /Session: plan mode\. Choose a project to see its settings and attached assets\./);
  preview = { ok: true, prompt: 'Review what changed.', launch: { permissionMode: 'plan', model: 'opus', appendSystemPrompt: 'Cents only.' }, notesError: '',
    project: 'example', projectSettings: { version: 2, sha256: 'a'.repeat(64) }, assets: [{ ref: 'shared:logo', archived: true }], problems: ['shared:x has no version 3'], note: '' };
  const pick = dialogEl().querySelector('#flowProject');
  pick.value = 'example';
  pick.dispatchEvent({ type: 'change', bubbles: true, target: pick, preventDefault() {}, stopPropagation() {} });
  await settle(10);
  assert.equal(previews().at(-1).body.project, 'example');
  const text = textOf(dialogEl());
  assert.match(text, /Session: plan mode · model opus\. The rules of example \(settings v2\) go into the system prompt\./);
  assert.match(text, /A run would be refused: shared:x has no version 3/);
  assert.match(text, /Archived, still used: shared:logo\./);
  dialogEl().close();
});
