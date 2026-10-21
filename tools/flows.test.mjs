// Tests for tools/lib/flows.mjs and tools/lib/prompt-file.mjs.
// Run: node tools/run-tests.mjs
// Each test builds a throwaway workspace root in the temp folder; the real workspace is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  archiveFlow, checkFlow, flowFile, flowImages, flowImagesDir, getFlow, listArchivedFlows, listFlows, parseFlow,
  renderFlow, restoreFlow, runPrompt, saveFlow, slugify,
} from './lib/flows.mjs';
import { promptArgs, takePromptFile, writePromptFile } from './lib/prompt-file.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-flows-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'projects/Game/.claude/agents/artist.md', '---\nname: artist\ndescription: Draws.\nmemory: project\n---\n');
  put(root, 'projects/Game/.claude/agents/plain.md', '---\nname: plain\ndescription: No memory.\n---\n');
  return root;
}

function put(root, rel, content = 'x') {
  const f = join(root, ...rel.split('/'));
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}

const base = { title: 'Sprite pass', description: 'From a sketch', target: 'hub', prompt: 'Draw it.' };

test('slugify makes kebab-case file names', () => {
  assert.equal(slugify('Sprite: hero "walk" cycle!'), 'sprite-hero-walk-cycle');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('!!!'), 'flow');
  assert.ok(slugify('x'.repeat(80)).length <= 50);
});

test('renderFlow and parseFlow round-trip, also with quotes, colons and #', () => {
  const f = { title: 'A "title": #1', description: 'd: e', target: 'agent', project: 'Game', agent: 'artist', prompt: 'Line 1\n\n---\nLine "2"' };
  assert.deepEqual(parseFlow(renderFlow(f)), f);
  assert.deepEqual(parseFlow(renderFlow({ ...f, target: 'hub' })), { ...f, target: 'hub', project: '', agent: '' });
});

test('checkFlow needs a title, a prompt and a target that can run', t => {
  const root = fixture(t);
  assert.equal(checkFlow(root, base).error, '');
  assert.match(checkFlow(root, { ...base, title: ' ' }).error, /title/);
  assert.match(checkFlow(root, { ...base, prompt: '\n' }).error, /prompt is empty/);
  assert.match(checkFlow(root, { ...base, prompt: 'x'.repeat(16001) }).error, /longer/);
  assert.match(checkFlow(root, { ...base, target: 'shell' }).error, /target/);
  assert.match(checkFlow(root, { ...base, target: 'project', project: 'nope' }).error, /not found/);
  assert.equal(checkFlow(root, { ...base, target: 'project', project: 'game' }).flow.project, 'Game');
  assert.equal(checkFlow(root, { ...base, target: 'agent', project: 'Game', agent: 'artist' }).error, '');
  assert.match(checkFlow(root, { ...base, target: 'agent', project: 'Game', agent: 'plain' }).error, /memory: project/);
  assert.match(checkFlow(root, { ...base, target: 'agent', project: 'Game', agent: '../x' }).error, /no usable agent/);
  // Hub flows drop a project they don't use.
  assert.equal(checkFlow(root, { ...base, project: 'Game', agent: 'artist' }).flow.project, '');
});

test('saveFlow creates unique files, updates only with the right hash, and listFlows shows run errors', t => {
  const root = fixture(t);
  const a = saveFlow(root, base);
  const b = saveFlow(root, base);
  assert.deepEqual([a.slug, b.slug], ['sprite-pass', 'sprite-pass-2']);
  assert.equal(getFlow(root, 'sprite-pass').prompt, 'Draw it.');
  assert.equal(saveFlow(root, { ...base, prompt: 'New' }, { slug: 'sprite-pass', baseHash: 'old' }).conflict, true);
  const u = saveFlow(root, { ...base, prompt: 'New' }, { slug: 'sprite-pass', baseHash: a.hash });
  assert.equal(u.error, '');
  assert.equal(getFlow(root, 'sprite-pass').prompt, 'New');
  assert.match(saveFlow(root, base, { slug: '../evil', baseHash: '' }).error, /no flow/);
  assert.equal(getFlow(root, '..\\x'), null);

  saveFlow(root, { ...base, title: 'Agent run', target: 'agent', project: 'Game', agent: 'artist' });
  rmSync(join(root, 'projects', 'Game', '.claude', 'agents', 'artist.md'));
  put(root, 'flows/README.md', '# Flows');
  const list = listFlows(root);
  assert.deepEqual(list.map(f => f.slug), ['agent-run', 'sprite-pass', 'sprite-pass-2']);
  assert.match(list[0].error, /no usable agent/);
  assert.equal(list[1].error, '');
});

test('flowImages lists images oldest first; runPrompt adds notes and paths', t => {
  const root = fixture(t);
  const second = put(root, 'inbox/attachments/_flows/demo/b.png');
  const first = put(root, 'inbox/attachments/_flows/demo/a.jpg');
  put(root, 'inbox/attachments/_flows/demo/notes.txt');
  utimesSync(first, new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.deepEqual(flowImages(root, 'demo'), [first, second]);
  assert.equal(flowImagesDir(root, 'demo'), dirname(first));
  assert.equal(runPrompt({ prompt: 'Do it.' }, [], ''), 'Do it.');
  assert.equal(runPrompt({ prompt: 'Do it.' }, [first], ' hero only '),
    `Do it.\n\nNotes for this run:\nhero only\n\nReference images for this flow (read them before you start):\n- ${first}`);
});

test('archiveFlow and restoreFlow move the file and keep the name taken', t => {
  const root = fixture(t);
  saveFlow(root, base);
  assert.equal(archiveFlow(root, 'sprite-pass').error, '');
  assert.ok(!existsSync(flowFile(root, 'sprite-pass')));
  assert.deepEqual(listArchivedFlows(root).map(f => [f.archivedAs, f.slug, f.title]), [['sprite-pass.md', 'sprite-pass', 'Sprite pass']]);
  // A new flow with the same title gets another name, so the archived one's images stay its own.
  assert.equal(saveFlow(root, base).slug, 'sprite-pass-2');
  // Same for a leftover image folder whose flow file is gone.
  put(root, 'inbox/attachments/_flows/old-pass/x.png');
  assert.equal(saveFlow(root, { ...base, title: 'Old pass' }).slug, 'old-pass-2');
  assert.equal(restoreFlow(root, 'sprite-pass.md').slug, 'sprite-pass');
  assert.match(restoreFlow(root, 'sprite-pass.md').error, /no archived flow/);
  assert.match(archiveFlow(root, 'nope').error, /no flow/);
});

test('prompt files carry the prompt and readable folders once, then disappear', () => {
  const file = writePromptFile({ prompt: 'Say "hi"\nnow', readDirs: ['C:\\imgs'] });
  assert.deepEqual(takePromptFile(file), { prompt: 'Say "hi"\nnow', readDirs: ['C:\\imgs'] });
  assert.ok(!existsSync(file));
  assert.throws(() => takePromptFile(file), /could not read/);
  const bad = writePromptFile({ prompt: 'x', readDirs: ['relative\\dir'] });
  assert.throws(() => takePromptFile(bad), /absolute/);
  const empty = writePromptFile({ prompt: '  ' });
  assert.throws(() => takePromptFile(empty), /empty/);
  const outside = join(mkdtempSync(join(tmpdir(), 'ws-prompt-')), 'p.json');
  writeFileSync(outside, JSON.stringify({ prompt: 'keep me' }));
  assert.equal(takePromptFile(outside).prompt, 'keep me');
  assert.ok(existsSync(outside), 'only files in the prompt folder are deleted');
  rmSync(dirname(outside), { recursive: true, force: true });
  assert.deepEqual(promptArgs('-rf'), ['--', '-rf']);
  assert.deepEqual(promptArgs('/inbox-triage'), ['/inbox-triage']);
});
