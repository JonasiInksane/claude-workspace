// Tests for runs/manifest.mjs: the manifest's hash, the stage prompt hashes (one per Claude stage,
// the same for a CRLF and an LF checkout), the models per stage, the hub's state from git (clean,
// changed, untracked, no repository), the whole manifest and the shape check the store applies.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINES, pipelineById } from './catalog.mjs';
import { clearPromptCache, loadPrompt } from './prompts.mjs';
import {
  buildManifest, hubState, MANIFEST_VERSION, manifestAsset, manifestHash, manifestProblem, profileHash, promptOf, stageModels,
  stagePromptHashes, templateHash,
} from './manifest.mjs';
import { canonicalJson, sha256Text } from '../core/datadir.mjs';
import { commitAll, makeRepo, tempDir } from '../test/helpers.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const hubCopy = t => {
  const root = tempDir('ws-manifest-', t);
  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  return root;
};
const item = (over = {}) => ({
  ref: 'shared:style-guide', pin: null, version: 2, sha256: 'c'.repeat(64), bytes: 9, path: 'C:\\ws\\inbox\\attachments\\_assets\\style-guide\\v2.md',
  rel: 'inbox/attachments/_assets/style-guide/v2.md', type: 'text/markdown', kind: 'text', title: 'Style guide', ...over,
});

test('manifestHash is the SHA-256 of the canonical JSON: key order does not matter, content does', () => {
  const a = { version: 1, hub: { commit: 'x', pipelinesClean: true }, models: { b: 'opus', a: 'sonnet' } };
  const b = { models: { a: 'sonnet', b: 'opus' }, hub: { pipelinesClean: true, commit: 'x' }, version: 1 };
  assert.equal(manifestHash(a), manifestHash(b));
  assert.equal(manifestHash(a), sha256Text(canonicalJson(a)));
  assert.notEqual(manifestHash(a), manifestHash({ ...a, version: 2 }));
  assert.equal(profileHash(null), null);
  assert.equal(profileHash({ b: 1, a: [2] }), profileHash({ a: [2], b: 1 }));
  assert.match(profileHash({ a: 1 }), /^[0-9a-f]{64}$/);
});

test('stagePromptHashes: every Claude stage with its file and the hash of the text loadPrompt gives, CRLF read as LF', async t => {
  const root = hubCopy(t);
  for (const def of PIPELINES) {
    const list = await stagePromptHashes(root, def);
    const claude = def.stages.filter(s => s.kind === 'claude');
    assert.deepEqual(list.map(p => p.stage), claude.map(s => s.id), def.id);
    for (const p of list) {
      const { pipeline, stage } = promptOf(def.stages.find(s => s.id === p.stage));
      assert.equal(p.file, `pipelines/app/${pipeline}/${stage}.md`);
      assert.equal(p.sha256, templateHash(await loadPrompt(root, pipeline, stage)));
    }
  }
  // The same template with other line endings has the same hash (a CRLF and an LF checkout agree).
  const file = join(root, 'pipelines', 'app', 'explain', 'answer.md');
  const [before] = await stagePromptHashes(root, pipelineById('explain'));
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n'));
  clearPromptCache();
  assert.deepEqual(await stagePromptHashes(root, pipelineById('explain')), [before]);
  // A gate-only pipeline lists none; a missing template stops the manifest.
  assert.deepEqual(await stagePromptHashes(root, pipelineById('check')), []);
  writeFileSync(file, 'no fence');
  clearPromptCache();
  await assert.rejects(stagePromptHashes(root, pipelineById('explain')), /must start with the data-fence paragraph/);
  assert.deepEqual(await stagePromptHashes(root, { stages: [{ id: 'x', kind: 'claude' }] }), [], 'a stage without a prompt file is left out');
});

test('stageModels: the catalog choice per Claude stage, raised for risky runs', () => {
  assert.deepEqual(stageModels(pipelineById('explain')), { models: { answer: 'sonnet' }, efforts: { answer: 'high' } });
  const refactor = pipelineById('refactor');
  const calm = stageModels(refactor, { run: { level: 'standard', riskTags: [] } });
  assert.deepEqual([calm.models.scope, calm.models.prove, calm.efforts.review], ['opus', 'sonnet', 'high']);
  const risky = stageModels(refactor, { run: { level: 'paranoid', riskTags: ['money'] } });
  assert.deepEqual([risky.models.review, risky.efforts.review, risky.efforts.verify], ['opus', 'xhigh', 'xhigh']);
  // The app's settings win where the catalog lets them.
  assert.equal(stageModels(refactor, { settings: { models: { 'refactor.scope': { model: 'sonnet', effort: 'max' } } } }).efforts.scope, 'max');
});

test('hubState: the HEAD commit, and whether pipelines/app has local changes (untracked files count)', async t => {
  const root = tempDir('ws-manifest-hub-', t);
  const sha = await makeRepo(root, { files: { 'pipelines/app/explain/answer.md': 'x\n', 'README.md': 'hub\n' } });
  assert.deepEqual(await hubState(root), { commit: sha, pipelinesClean: true });
  writeFileSync(join(root, 'README.md'), 'changed outside pipelines/app\n');
  assert.deepEqual(await hubState(root), { commit: sha, pipelinesClean: true }, 'only pipelines/app counts');
  writeFileSync(join(root, 'pipelines', 'app', 'explain', 'answer.md'), 'edited\n');
  assert.deepEqual(await hubState(root), { commit: sha, pipelinesClean: false });
  const next = await commitAll(root, 'edit');
  mkdirSync(join(root, 'pipelines', 'app', 'new'), { recursive: true });
  writeFileSync(join(root, 'pipelines', 'app', 'new', 'stage.md'), 'untracked\n');
  assert.deepEqual(await hubState(root), { commit: next, pipelinesClean: false });
  // No repository, or git that fails: nothing is guessed.
  assert.deepEqual(await hubState(tempDir('ws-manifest-norepo-', t)), { commit: '', pipelinesClean: null });
  const flaky = async (dir, args) => { if (args[0] === 'status') throw new Error('index.lock'); return `${'b'.repeat(40)}\n`; };
  assert.deepEqual(await hubState(root, { git: flaky }), { commit: 'b'.repeat(40), pipelinesClean: null });
  assert.deepEqual(await hubState(root, { git: async () => 'not a sha' }), { commit: '', pipelinesClean: null });
});

test('buildManifest: every part, from the inputs a start has', async t => {
  const root = hubCopy(t);
  const profile = { project: 'example', checks: { test: 'npm test' } };
  const m = await buildManifest({
    root, def: pipelineById('refactor'), profile, settings: {}, run: { level: 'standard', riskTags: [], values: {} },
    projectSettings: { version: 3, sha256: 'a'.repeat(64), extra: 'dropped' },
    assets: [item(), item({ ref: 'example:palette', pin: 1, version: 1, kind: 'image', title: 'Palette', path: 'C:\\ws\\p\\v1.png', archived: true })],
    versions: { node: '24.11.1', claudeCode: null }, hub: async () => ({ commit: 'f'.repeat(40), pipelinesClean: false }),
  });
  assert.equal(m.version, MANIFEST_VERSION);
  assert.deepEqual(m.stagePrompts.map(p => p.stage), ['scope', 'prove', 'implement', 'review', 'verify']);
  assert.deepEqual(m.profile, { sha256: profileHash(profile) });
  assert.deepEqual(m.projectSettings, { version: 3, sha256: 'a'.repeat(64) });
  assert.deepEqual(m.assets, [
    { ref: 'shared:style-guide', pin: null, version: 2, sha256: 'c'.repeat(64), kind: 'text', title: 'Style guide', file: 'inputs/assets/shared-style-guide@v2.md' },
    { ref: 'example:palette', pin: 1, version: 1, sha256: 'c'.repeat(64), kind: 'image', title: 'Palette', file: 'inputs/assets/project-palette@v1.png', archived: true },
  ]);
  assert.equal(m.models.implement, 'opus');
  assert.deepEqual(m.versions, { node: '24.11.1', claudeCode: null });
  assert.deepEqual(m.hub, { commit: 'f'.repeat(40), pipelinesClean: false });
  assert.equal(manifestProblem(m), '');
  // No settings, no profile, no assets: still a whole manifest.
  const bare = await buildManifest({ root, def: pipelineById('check'), hub: async () => ({ commit: '', pipelinesClean: null }) });
  assert.deepEqual([bare.stagePrompts, bare.profile, bare.projectSettings, bare.assets, bare.models], [[], { sha256: null }, null, [], {}]);
  assert.equal(manifestProblem(bare), '');
});

test('manifestAsset refuses an item whose file can not become a run input', () => {
  assert.throws(() => manifestAsset(item({ path: 'C:\\x\\v2.svg' })), /can't be copied into a run/);
  assert.throws(() => manifestAsset(item({ path: 'C:\\x\\v2' })), /without an extension/);
});

test('manifestProblem refuses what the page could not show', () => {
  const good = {
    version: 1, stagePrompts: [], profile: { sha256: null }, projectSettings: null, assets: [], models: {}, efforts: {},
    versions: { node: '20.15.1', claudeCode: null }, hub: { commit: '', pipelinesClean: null },
  };
  assert.equal(manifestProblem(good), '');
  for (const [bad, re] of [
    [null, /must be an object/], [[], /must be an object/], [{ ...good, version: '1' }, /has version 1/],
    [{ ...good, stagePrompts: [{ stage: 'x', file: 'pipelines/app/x/y.md', sha256: 'short' }] }, /stage prompt/],
    [{ ...good, profile: { sha256: 'nope' } }, /profile hash/],
    [{ ...good, projectSettings: { version: 1, sha256: 'x' } }, /project settings/],
    [{ ...good, assets: [{ ref: 'shared:x', version: 1, sha256: 'a'.repeat(64), file: 'inputs/assets/team-x@v1.md' }] }, /asset without/],
    [{ ...good, assets: [{ ref: 'shared:x', version: '1', sha256: 'a'.repeat(64), file: 'inputs/assets/shared-x@v1.md' }] }, /asset without/],
    [{ ...good, models: null }, /no models, versions or hub/],
  ]) assert.match(manifestProblem(bad), re, JSON.stringify(bad));
});
