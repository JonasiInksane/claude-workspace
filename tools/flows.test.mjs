// Tests for tools/lib/flows.mjs and tools/lib/prompt-file.mjs.
// Run: node tools/run-tests.mjs
// Each test builds a throwaway workspace root in the temp folder; the real workspace is not touched
// (the last test only reads the workspace's own Tattoogenda flows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  archiveFlow, checkFlow, checkRunNotes, flowFile, flowImages, flowImagesDir, getFlow, listArchivedFlows, listFlows, parseFlow,
  readCaptions, renderFlow, restoreFlow, runPrompt, saveFlow, setCaption, skippedFlowImages, slugify,
} from './lib/flows.mjs';
import { checkLaunch, launchArgs, promptArgs, splitToolRules, takePromptFile, writePromptFile } from './lib/prompt-file.mjs';

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
  const f = {
    title: 'A "title": #1', description: 'd: e', target: 'agent', project: 'Game', agent: 'artist', prompt: 'Line 1\n\n---\nLine "2"',
    permissionMode: 'plan', model: 'opus', effort: 'high', allowedTools: 'Read, Bash(npm test:*)',
    ask: 'What: "this" #2?', askRequired: true,
  };
  assert.deepEqual(parseFlow(renderFlow(f)), f);
  assert.match(renderFlow(f), /\nask: "What: \\"this\\" #2\?"\naskRequired: true\n---/);
  const plain = { ...f, target: 'hub', permissionMode: '', model: '', effort: '', allowedTools: '', ask: '', askRequired: false };
  assert.deepEqual(parseFlow(renderFlow(plain)), { ...plain, project: '', agent: '' });
  assert.doesNotMatch(renderFlow(plain), /permissionMode|model|effort|allowedTools|ask/);
  // An optional question: no askRequired line.
  const optional = { ...plain, ask: 'Anything else?' };
  assert.doesNotMatch(renderFlow(optional), /askRequired/);
  assert.deepEqual(parseFlow(renderFlow(optional)), { ...optional, project: '', agent: '' });
  // Hand-written values: "false" reads as false; anything else is kept so checkFlow can refuse it.
  assert.equal(parseFlow('---\ntitle: "x"\nask: "q"\naskRequired: false\n---\np').askRequired, false);
  assert.equal(parseFlow('---\ntitle: "x"\nask: "q"\naskRequired: "TRUE"\n---\np').askRequired, true);
  assert.equal(parseFlow('---\ntitle: "x"\nask: "q"\naskRequired: maybe\n---\np').askRequired, 'maybe');
});

test('checkFlow checks the question: at most 120 characters, required only with a question, true or false', t => {
  const root = fixture(t);
  const ok = checkFlow(root, { ...base, ask: '  What do you\n want  to refactor? ', askRequired: true });
  assert.equal(ok.error, '');
  assert.deepEqual([ok.flow.ask, ok.flow.askRequired], ['What do you want to refactor?', true]);
  assert.equal(checkFlow(root, { ...base, ask: 'x'.repeat(120) }).error, '');
  assert.match(checkFlow(root, { ...base, ask: 'x'.repeat(121) }).error, /longer than 120/);
  assert.match(checkFlow(root, { ...base, askRequired: true }).error, /needs a question/);
  assert.match(checkFlow(root, { ...base, ask: 'q', askRequired: 'maybe' }).error, /true or false/);
  assert.match(checkFlow(root, { ...base, ask: 'q', askRequired: 1 }).error, /true or false/);
  // The form sends booleans; a file sends text. Both work; empty means not required.
  assert.equal(checkFlow(root, { ...base, ask: 'q', askRequired: 'true' }).flow.askRequired, true);
  assert.equal(checkFlow(root, { ...base, ask: 'q', askRequired: '' }).flow.askRequired, false);
  assert.deepEqual([checkFlow(root, base).flow.ask, checkFlow(root, base).flow.askRequired], ['', false]);
  // Saved and read back.
  const saved = saveFlow(root, { ...base, title: 'Asks', ask: 'Which part?', askRequired: true });
  assert.equal(saved.error, '');
  const back = getFlow(root, saved.slug);
  assert.deepEqual([back.ask, back.askRequired], ['Which part?', true]);
  assert.equal(listFlows(root).find(f => f.slug === saved.slug).error, '');
});

test('runPrompt puts the answer under the flow\'s question; checkRunNotes refuses an empty required answer', () => {
  const flow = { prompt: 'Refactor it.', ask: 'What do you want to refactor?', askRequired: true };
  assert.equal(runPrompt(flow, [], '  The money module  '), 'Refactor it.\n\nWhat do you want to refactor?\nThe money module');
  assert.equal(runPrompt(flow, [], ''), 'Refactor it.');
  assert.equal(runPrompt({ prompt: 'p', ask: '' }, [], 'n'), 'p\n\nNotes for this run:\nn');
  assert.equal(checkRunNotes(flow, ' \n '), '"What do you want to refactor?" needs an answer');
  assert.equal(checkRunNotes(flow, 'x'), '');
  assert.equal(checkRunNotes({ ...flow, askRequired: false }, ''), '');
  assert.equal(checkRunNotes({ prompt: 'p' }, ''), '');
  // A required flag without a question (a hand-edited file) can't block a run.
  assert.equal(checkRunNotes({ prompt: 'p', ask: '', askRequired: true }, ''), '');
});

test('the four Tattoogenda flows: plan mode, high effort, a required question, no finding ids or paths', () => {
  const flowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'flows');
  const expected = {
    'tattoogenda-refactor': 'What do you want to refactor?',
    'tattoogenda-fix-finding': 'Which finding, and anything I should know?',
    'tattoogenda-debug': 'What is wrong, and how do I reproduce it?',
    'tattoogenda-review': 'What should I review?',
  };
  for (const [slug, ask] of Object.entries(expected)) {
    const text = readFileSync(join(flowsDir, `${slug}.md`), 'utf8');
    const f = parseFlow(text);
    assert.deepEqual([f.target, f.project, f.permissionMode, f.effort, f.ask, f.askRequired], ['project', 'tattoogenda', 'plan', 'high', ask, true], slug);
    assert.ok(f.title.endsWith('(interactive)'), slug);
    assert.match(f.prompt, /CLAUDE\.md and AGENTS\.md/, slug);
    // No file paths and nothing shaped like an audit finding id (made-up examples: X-H9, Q7, ZZ-99).
    assert.doesNotMatch(text, /[\\/]/, `${slug} has a path`);
    assert.doesNotMatch(text, /\b[A-Z]{1,2}-?[A-Z]{0,2}\d{1,3}\b/, `${slug} has a finding id`);
    assert.ok(f.prompt.length < 2000, slug);
  }
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

test('flowImages lists runnable images oldest first; BMP is listed as skipped', t => {
  const root = fixture(t);
  const second = put(root, 'inbox/attachments/_flows/demo/b.png');
  const first = put(root, 'inbox/attachments/_flows/demo/a.jpg');
  put(root, 'inbox/attachments/_flows/demo/notes.txt');
  put(root, 'inbox/attachments/_flows/demo/old.BMP');
  utimesSync(first, new Date(2026, 0, 1), new Date(2026, 0, 1));
  assert.deepEqual(flowImages(root, 'demo'), [first, second]);
  assert.deepEqual(skippedFlowImages(root, 'demo'), ['old.BMP']);
  assert.equal(flowImagesDir(root, 'demo'), dirname(first));
  // Same time: by name, so the numbering is stable.
  const same = new Date(2026, 1, 1);
  utimesSync(first, same, same);
  utimesSync(second, same, same);
  assert.deepEqual(flowImages(root, 'demo'), [first, second]);
});

test('runPrompt puts labeled images first, then the prompt, then the notes', () => {
  assert.equal(runPrompt({ prompt: 'Do it.' }, [], ''), 'Do it.');
  const a = 'C:\\imgs\\a.jpg';
  const b = 'C:\\imgs\\b.png';
  assert.equal(runPrompt({ prompt: 'Compare Image 1 with Image 2.' }, [a, b], ' hero only ', { 'a.jpg': 'the sketch', 'b.png': '  ' }),
    'Reference images for this task. Read each one before you start:\n' +
    `- Image 1: ${a}\n  What it shows: the sketch\n- Image 2: ${b}\n\n` +
    'Compare Image 1 with Image 2.\n\nNotes for this run:\nhero only');
});

test('captions are kept per image name and only for images the flow passes', t => {
  const root = fixture(t);
  put(root, 'inbox/attachments/_flows/demo/a.png');
  put(root, 'inbox/attachments/_flows/demo/b.png');
  assert.equal(setCaption(root, 'demo', 'a.png', '  the\nsketch  ').error, '');
  assert.equal(setCaption(root, 'demo', 'b.png', 'palette').error, '');
  assert.deepEqual(readCaptions(root, 'demo'), { 'a.png': 'the sketch', 'b.png': 'palette' });
  assert.match(setCaption(root, 'demo', '../x.png', 'x').error, /no image/);
  assert.match(setCaption(root, 'demo', 'a.png', 'x'.repeat(201)).error, /at most 200/);
  // Removing a caption, and an image that is gone, both drop the entry.
  rmSync(join(flowImagesDir(root, 'demo'), 'b.png'));
  assert.equal(setCaption(root, 'demo', 'a.png', '').error, '');
  assert.deepEqual(readCaptions(root, 'demo'), {});
  // A broken captions file reads as no captions.
  put(root, 'inbox/attachments/_flows/demo/captions.json', '[1,2');
  assert.deepEqual(readCaptions(root, 'demo'), {});
  // captions.json is not an image.
  assert.equal(flowImages(root, 'demo').length, 1);
});

test('launch settings are checked, split and turned into flags', t => {
  const root = fixture(t);
  assert.deepEqual(splitToolRules('Read, Grep\nBash(git log *)  mcp__gh__issues'), ['Read', 'Grep', 'Bash(git log *)', 'mcp__gh__issues']);
  assert.deepEqual(checkLaunch({ permissionMode: 'plan', model: 'claude-opus-5-5', effort: 'max', allowedTools: 'Read, Bash(npm test:*)' }), {
    error: '', launch: { permissionMode: 'plan', model: 'claude-opus-5-5', effort: 'max', allowedTools: ['Read', 'Bash(npm test:*)'] },
  });
  assert.deepEqual(checkLaunch({}), { error: '', launch: {} });
  for (const bad of [{ permissionMode: 'bypassPermissions' }, { permissionMode: 'dontAsk' }, { effort: 'huge' }, { model: '--dangerously' },
    { model: 'opus "x"' }, { allowedTools: 'Bash(rm -rf "/")' }, { allowedTools: 'Read; calc' }, { allowedTools: Array(21).fill('Read').join(',') }]) {
    assert.notEqual(checkLaunch(bad).error, '', JSON.stringify(bad));
  }
  assert.deepEqual(launchArgs({ permissionMode: 'plan', model: 'opus', effort: 'high', allowedTools: ['Read'] }),
    ['--permission-mode', 'plan', '--model', 'opus', '--effort', 'high']);
  assert.match(checkFlow(root, { ...base, effort: 'huge' }).error, /effort/);
  const saved = saveFlow(root, { ...base, permissionMode: 'plan', allowedTools: 'Read Grep' });
  const back = getFlow(root, saved.slug);
  assert.deepEqual([back.permissionMode, back.allowedTools, back.model], ['plan', 'Read, Grep', '']);
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
  assert.deepEqual(takePromptFile(file), { prompt: 'Say "hi"\nnow', readDirs: ['C:\\imgs'], launch: {} });
  const launched = writePromptFile({ prompt: 'p', launch: { permissionMode: 'plan', allowedTools: ['Read'] } });
  assert.deepEqual(takePromptFile(launched).launch, { permissionMode: 'plan', allowedTools: ['Read'] });
  const unsafe = writePromptFile({ prompt: 'p', launch: { permissionMode: 'bypassPermissions' } });
  assert.throws(() => takePromptFile(unsafe), /launch: permission mode/);
  assert.ok(!existsSync(file));
  assert.throws(() => takePromptFile(file), /could not read/);
  const bad = writePromptFile({ prompt: 'x', readDirs: ['relative\\dir'] });
  assert.throws(() => takePromptFile(bad), /absolute/);
  const empty = writePromptFile({ prompt: '  ' });
  assert.throws(() => takePromptFile(empty), /empty/);
  for (const refused of [unsafe, bad, empty]) rmSync(refused, { force: true }); // refused files are kept; clean up
  const badSession = writePromptFile({ prompt: 'p', launch: { sessionId: 'nope' } });
  assert.throws(() => takePromptFile(badSession), /launch: sessionId/);
  rmSync(badSession, { force: true });
  const outside = join(mkdtempSync(join(tmpdir(), 'ws-prompt-')), 'p.json');
  writeFileSync(outside, JSON.stringify({ prompt: 'keep me' }));
  assert.equal(takePromptFile(outside).prompt, 'keep me');
  assert.ok(existsSync(outside), 'only files in the prompt folder are deleted');
  rmSync(dirname(outside), { recursive: true, force: true });
  assert.deepEqual(promptArgs('-rf'), ['--', '-rf']);
  assert.deepEqual(promptArgs('/inbox-triage'), ['/inbox-triage']);
});
