// Tests for tools/lib/inbox.mjs: what counts as a triage item vs an agent image library.
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify, projectNameMap, scanInbox } from './lib/inbox.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-inbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, rel, content = 'x', mtimeSec) {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeSec) utimesSync(file, mtimeSec, mtimeSec);
}

test('classify: only attachments/<existing project>/... is a library', () => {
  const projects = new Map([['tattoogenda', 'Tattoogenda']]);
  const c = p => classify(p.split('/'), projects);
  const lib = (folder, agent) => ({ kind: 'library', project: 'Tattoogenda', folder, agent });
  assert.deepEqual(c('attachments/Tattoogenda/art/2026-10-21/a.png'), lib('Tattoogenda', 'art'));
  assert.deepEqual(c('attachments/tattoogenda/_shared/a.png'), lib('tattoogenda', '_shared'));
  assert.deepEqual(c('attachments/Tattoogenda/a.png'), lib('Tattoogenda', ''));
  for (const item of ['attachments/_hub/2026-10-21/a.png', 'attachments/2026-10-21/a.png', 'attachments/gone/art/a.png',
    'a.md', 'handoffs/h.md', 'attachments/a.png', 'notes/Tattoogenda/art/a.png']) {
    assert.deepEqual(c(item), { kind: 'item' }, item);
  }
});

test('projectNameMap ignores dot and underscore folders', t => {
  const root = fixture(t);
  for (const d of ['Demo', '_hub', '.hidden']) mkdirSync(join(root, 'projects', d), { recursive: true });
  writeFileSync(join(root, 'projects', 'README.md'), '');
  assert.deepEqual([...projectNameMap(root)], [['demo', 'Demo']]);
});

test('scanInbox separates triage items, libraries and the archive', t => {
  const root = fixture(t);
  put(root, 'projects/demo/.claude/agents/art.md', '---\nname: art\ndescription: a\nmemory: project\n---\n');
  put(root, 'inbox/README.md');
  put(root, 'inbox/attachments/.gitkeep');
  put(root, 'inbox/Thumbs.db');
  put(root, 'inbox/node_modules/x.js');
  put(root, 'inbox/old.md', 'x', 1_700_000_000);
  put(root, 'inbox/handoffs/h.md', 'x', 1_700_000_500);
  put(root, 'inbox/attachments/_hub/2026-10-21/shot.png', 'x', 1_700_001_000);
  put(root, 'inbox/attachments/gone/art/orphan.png', 'x', 1_700_000_200);
  put(root, 'inbox/attachments/demo/art/2026-10-21/a.png');
  put(root, 'inbox/attachments/demo/art/2026-10-21/b.png');
  put(root, 'inbox/attachments/demo/_shared/c.png');
  put(root, 'inbox/attachments/demo/sound/d.png');
  put(root, 'inbox/attachments/demo/loose.png');
  put(root, 'inbox/_processed/2026-10-20/done.md');
  put(root, 'inbox/_processed/2026-10-20/deep/done2.md');
  put(root, 'inbox/notes/_processed/ignored.md');

  const ib = scanInbox(root);
  assert.equal(ib.exists, true);
  assert.deepEqual(ib.items.map(i => i.path), [
    'inbox/attachments/_hub/2026-10-21/shot.png', 'inbox/handoffs/h.md',
    'inbox/attachments/gone/art/orphan.png', 'inbox/old.md',
  ]);
  assert.equal(ib.processed, 2);
  assert.deepEqual(ib.libraries.map(l => [l.path, l.files, l.known]), [
    ['inbox/attachments/demo', 1, false],
    ['inbox/attachments/demo/_shared', 1, true],
    ['inbox/attachments/demo/art', 2, true],
    ['inbox/attachments/demo/sound', 1, false],
  ]);
  assert.equal(ib.truncated, false);
});

test('a large image library never hides triage items; limits set truncated', t => {
  const root = fixture(t);
  put(root, 'projects/demo/.claude/agents/art.md', '---\nname: art\ndescription: a\nmemory: project\n---\n');
  for (let i = 0; i < 6; i++) put(root, `inbox/attachments/demo/art/img${i}.png`);
  put(root, 'inbox/notes.md');
  put(root, 'inbox/zz/a/b/c/deep.md');

  const ib = scanInbox(root, { maxItems: 5, maxLibraryFiles: 4, maxDepth: 3 });
  assert.deepEqual(ib.items.map(i => i.path), ['inbox/notes.md']);
  assert.equal(ib.libraries[0].files, 4);
  assert.equal(ib.truncated, true);

  const wide = scanInbox(root, { maxItems: 5, maxLibraryFiles: 100, maxDepth: 8 });
  assert.equal(wide.truncated, false);
  assert.deepEqual(wide.items.map(i => i.path).sort(), ['inbox/notes.md', 'inbox/zz/a/b/c/deep.md']);
  assert.equal(scanInbox(root, { maxItems: 1 }).truncated, true);
});

test('scanInbox matches project, agent and _shared folders in any letter case', t => {
  const root = fixture(t);
  put(root, 'projects/Tattoo/.claude/agents/artist.md', '---\nname: artist\ndescription: a\nmemory: project\n---\n');
  put(root, 'inbox/attachments/tattoo/Artist/a.png');
  put(root, 'inbox/attachments/TATTOO/artist/b.png');
  put(root, 'inbox/attachments/tattoo/_Shared/c.png');
  const ib = scanInbox(root);
  assert.deepEqual(ib.items, []);
  const got = ib.libraries.map(l => [l.project, l.agent.toLowerCase(), l.files, l.known]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(got, [['Tattoo', '_shared', 1, true], ['Tattoo', 'artist', 2, true]]);
  // Paths keep the on-disk spelling, so the navigator can link them.
  assert.ok(ib.libraries.some(l => l.path === 'inbox/attachments/tattoo/_Shared'));
});

test('scanInbox skips build-output folders and counts linked project folders', t => {
  const root = fixture(t);
  put(root, 'inbox/build/out.js');
  put(root, 'inbox/dist/out.js');
  put(root, 'elsewhere/real/.claude/agents/art.md', '---\nname: art\ndescription: a\nmemory: project\n---\n');
  mkdirSync(join(root, 'projects'), { recursive: true });
  symlinkSync(join(root, 'elsewhere', 'real'), join(root, 'projects', 'linked'), 'junction');
  put(root, 'inbox/attachments/linked/art/a.png');
  const ib = scanInbox(root);
  assert.deepEqual(ib.items, []);
  assert.deepEqual(ib.libraries.map(l => [l.project, l.agent, l.known]), [['linked', 'art', true]]);
});

test('scanInbox reports a missing inbox without throwing', t => {
  const root = fixture(t);
  assert.deepEqual(scanInbox(root), { exists: false, items: [], libraries: [], flowImages: 0, processed: 0, truncated: false });
});

test('flow images are counted on their own, never as triage items', t => {
  const root = fixture(t);
  put(root, 'inbox/attachments/_flows/sprite-pass/ref.png');
  put(root, 'inbox/attachments/_FLOWS/loose.png');
  put(root, 'inbox/attachments/_hub/2026-10-21/shot.png');
  assert.deepEqual(classify(['attachments', '_flows', 'x', 'a.png'], new Map()), { kind: 'flow' });
  const s = scanInbox(root);
  assert.deepEqual(s.items.map(i => i.path), ['inbox/attachments/_hub/2026-10-21/shot.png']);
  assert.equal(s.flowImages, 2);
  assert.deepEqual(s.libraries, []);
});
