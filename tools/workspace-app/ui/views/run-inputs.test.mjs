// Tests for the live run view's Inputs card (views/run.js, plan row A6): the helpers that read a
// run's input manifest (stage prompts with short hashes and a mark for a template that changed
// during the run, the attached assets with their library links, models, versions, the hub, the
// manifest's own check), and the card itself in the stand-in DOM (test/dom.mjs): every fact, the
// links (the project's Settings tab, each asset's version), Copy manifest, and a run from before
// manifests.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
const copied = [];
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async t => { copied.push(t); } } } });
after(() => {
  dom.uninstall();
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
});
const { assetRows, hubText, inputsCard, manifestCheck, modelText, promptRows, versionsText } = await import('./run.js');

const SHA = n => String(n).repeat(64).slice(0, 64);
const MANIFEST = {
  version: 1,
  stagePrompts: [
    { stage: 'scope', file: 'pipelines/app/refactor/scope.md', sha256: SHA('1a') },
    { stage: 'implement', file: 'pipelines/app/refactor/implement.md', sha256: SHA('2b') },
  ],
  profile: { sha256: SHA('3c') },
  projectSettings: { version: 3, sha256: SHA('4d') },
  assets: [
    { ref: 'shared:style-guide', pin: 2, version: 2, sha256: SHA('5e'), kind: 'text', title: 'Style guide', file: 'inputs/assets/shared-style-guide@v2.md' },
    { ref: 'example:palette', pin: null, version: 1, sha256: SHA('6f'), kind: 'image', title: 'Palette', file: 'inputs/assets/project-palette@v1.png', archived: true },
  ],
  models: { scope: 'opus', implement: 'opus' }, efforts: { scope: 'high', implement: 'xhigh' },
  versions: { node: '24.11.1', claudeCode: null },
  hub: { commit: 'abcdef1234567890abcdef1234567890abcdef12', pipelinesClean: true },
};
const RUN = {
  id: '261023-100000-refactor-cents', project: 'example', pipeline: 'refactor', status: 'waiting', manifest: MANIFEST, manifestSha256: SHA('9a'), manifestOk: true,
  versions: { node: '24.11.1', claudeCode: '2.1.309' },
  stages: [
    { id: 'preflight', label: 'Preflight' }, { id: 'scope', label: 'Scope', attempts: [{ k: 1 }] },
    { id: 'implement', label: 'Implement', attempts: [{ k: 1 }, { k: 2, templateChanged: true }] },
  ],
};

test('the manifest helpers: prompts, assets, models, versions, hub and the hash check', () => {
  assert.deepEqual(promptRows(RUN), [
    { stage: 'scope', label: 'Scope', file: 'pipelines/app/refactor/scope.md', sha: '1a1a1a1a', changed: false },
    { stage: 'implement', label: 'Implement', file: 'pipelines/app/refactor/implement.md', sha: '2b2b2b2b', changed: true },
  ]);
  assert.deepEqual(assetRows(RUN).map(a => [a.title, a.ref, a.version, a.pin, a.kind, a.sha, a.archived, a.href]), [
    ['Style guide', 'shared:style-guide', 2, 2, 'text', '5e5e5e5e', false, '/library-file?ref=shared%3Astyle-guide&v=2'],
    ['Palette', 'example:palette', 1, null, 'image', '6f6f6f6f', true, '/library-file?ref=example%3Apalette&v=1'],
  ]);
  assert.equal(modelText(RUN), 'Scope: opus/high · Implement: opus/xhigh');
  assert.equal(versionsText(RUN), 'Node 24.11.1 · Claude Code 2.1.309 (reported by the first Claude stage)');
  assert.equal(versionsText({ ...RUN, manifest: { ...MANIFEST, versions: { node: '20.15.1', claudeCode: '2.1.300' } } }), 'Node 20.15.1 · Claude Code 2.1.300');
  assert.equal(versionsText({ ...RUN, versions: {} }), 'Node 24.11.1 · Claude Code not known yet (the first Claude stage reports it)');
  assert.equal(hubText(RUN), 'commit abcdef1 · pipelines/app had no local changes');
  assert.equal(hubText({ manifest: { hub: { commit: 'abcdef1234', pipelinesClean: false } } }), 'commit abcdef1 · pipelines/app had local changes');
  assert.equal(hubText({ manifest: { hub: { commit: 'abcdef1234', pipelinesClean: null } } }), 'commit abcdef1 · whether pipelines/app had local changes is not known');
  assert.equal(hubText({ manifest: { hub: { commit: '', pipelinesClean: null } } }), 'not a git checkout (no commit recorded)');
  assert.deepEqual(manifestCheck(RUN), { text: 'matches its hash', bad: false });
  assert.deepEqual(manifestCheck({ ...RUN, manifestOk: false }), { text: 'does not match its hash: run.json was changed by hand', bad: true });
  assert.deepEqual(manifestCheck({ ...RUN, manifestOk: undefined }), { text: '', bad: false });
  // A run without a manifest has nothing to list.
  for (const fn of [promptRows, assetRows]) assert.deepEqual(fn({ stages: [] }), []);
  assert.equal(modelText({}), '');
});

test('the Inputs card shows every fact, links to the Settings tab and each asset version, and copies the manifest', async () => {
  const card = inputsCard(RUN);
  const text = textOf(card);
  for (const bit of [
    'Inputs recorded when the run started Copy manifest',
    'Stage prompts Scope pipelines/app/refactor/scope.md 1a1a1a1a',
    'Implement pipelines/app/refactor/implement.md 2b2b2b2b changed during the run',
    'Profile 3c3c3c3c', 'Project settings v3 4d4d4d4d',
    'Style guide shared:style-guide v2 pinned · text 5e5e5e5e', 'Palette example:palette v1 latest at the start · image 6f6f6f6f archived',
    'Models Scope: opus/high · Implement: opus/xhigh', 'Versions Node 24.11.1 · Claude Code 2.1.309 (reported by the first Claude stage)',
    'Hub commit abcdef1 · pipelines/app had no local changes', 'Manifest 9a9a9a9a matches its hash',
  ]) assert.ok(text.includes(bit), `${bit}\n in: ${text}`);
  const settings = card.querySelector('a[href="#project/example/settings"]');
  assert.ok(settings, 'the settings version links to the project\'s Settings tab');
  assert.equal(textOf(settings), 'v3');
  const links = card.querySelectorAll('a[target="_blank"]');
  assert.deepEqual(links.map(a => [textOf(a), a.getAttribute('href'), a.getAttribute('rel')]), [
    ['Style guide', '/library-file?ref=shared%3Astyle-guide&v=2', 'noopener'], ['Palette', '/library-file?ref=example%3Apalette&v=1', 'noopener'],
  ]);
  assert.equal(card.getAttribute('aria-labelledby'), 'run-inputs-h');
  const btn = card.querySelector('[data-key="in-copy"]');
  assert.equal(btn.getAttribute('aria-label'), 'Copy the input manifest as JSON');
  dom.click(btn);
  await settle(5);
  assert.deepEqual(JSON.parse(copied.at(-1)), MANIFEST);
  assert.match(textOf(dom.document.getElementById('toasts')), /Copied the input manifest \(JSON\)\./);
});

test('the Inputs card: a changed manifest is marked, empty parts say so, and a run from before manifests says it has none', () => {
  const bad = textOf(inputsCard({ ...RUN, manifestOk: false }));
  assert.match(bad, /Manifest 9a9a9a9a does not match its hash: run\.json was changed by hand/);
  const bare = inputsCard({ ...RUN, manifest: { ...MANIFEST, stagePrompts: [], profile: { sha256: null }, projectSettings: null, assets: [], models: {}, efforts: {} } });
  const t = textOf(bare);
  for (const bit of ['Stage prompts none (no Claude stage)', 'Profile none', 'Project settings none saved for this project', 'Attached assets none', 'Models none (no Claude stage)']) {
    assert.ok(t.includes(bit), bit);
  }
  assert.equal(bare.querySelector('a[href^="#project/"]'), null);
  const old = inputsCard({ id: '261022-100012-refactor-committed', project: 'example', stages: [] });
  assert.match(textOf(old), /^Inputs This run started before the app recorded the inputs of a run \(its stage prompts, settings, assets and models\), so there is no input manifest to show\.$/);
  assert.equal(old.querySelector('button'), null, 'nothing to copy');
});
