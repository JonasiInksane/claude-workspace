// Tests for flow-versions.mjs: the version of a flow (text hash with CRLF as LF, the hub commit,
// whether the file is committed, its images and captions), the launch record in flow-runs.jsonl,
// reading it back newest first, and what changed since a launch.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFlow } from '../lib/flows.mjs';
import { commitAll, makeRepo, runGit, tempDir, writeFiles } from './test/helpers.mjs';
import {
  FLOW_RUNS_FILE, flowRunsFile, flowVersion, normalizeText, readFlowRuns, recordFlowRun, RECENT_RUNS, versionChanges,
} from './flow-versions.mjs';

// git must not find a repository above the temporary folders (one in the user's home, say).
process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());

const sha = text => createHash('sha256').update(text).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const flowText = (prompt = 'Review it.') => renderFlow({ title: 'Review', target: 'project', project: '*', prompt });

// A hub with one committed flow, flows/review.md (LF in the commit, like `* text=auto` stores it).
async function hubRepo(t, { prefix = '' } = {}) {
  const base = tempDir('ws-flow-version-', t);
  const root = prefix ? join(base, prefix) : base;
  const head = await makeRepo(base, { files: { [`${prefix ? `${prefix}/` : ''}flows/review.md`]: flowText() } });
  return { root, head };
}

test('the version hashes the text with CRLF as LF, so both kinds of checkout agree', async t => {
  const { root, head } = await hubRepo(t);
  const lf = await flowVersion(root, 'review');
  assert.equal(lf.sha256, sha(flowText()));
  assert.deepEqual([lf.hubCommit, lf.committed, lf.images, lf.captions], [head, true, [], '']);
  // The same flow checked out with CRLF (core.autocrlf=true): same hash, still committed.
  writeFileSync(join(root, 'flows', 'review.md'), flowText().replace(/\n/g, '\r\n'));
  const crlf = await flowVersion(root, 'review');
  assert.deepEqual(crlf, lf);
  assert.equal(normalizeText('a\r\nb\rc\n'), 'a\nb\rc\n');
});

test('committed is false for an edited or a new flow; hubCommit stays the HEAD', async t => {
  const { root, head } = await hubRepo(t);
  writeFileSync(join(root, 'flows', 'review.md'), flowText('Review it twice.'));
  const edited = await flowVersion(root, 'review');
  assert.deepEqual([edited.sha256, edited.hubCommit, edited.committed], [sha(flowText('Review it twice.')), head, false]);
  writeFiles(root, { 'flows/fresh.md': flowText('New.') });
  const fresh = await flowVersion(root, 'fresh');
  assert.deepEqual([fresh.hubCommit, fresh.committed], [head, false]);
  // After a commit it is committed, at the new HEAD.
  const next = await commitAll(root, 'flows');
  assert.deepEqual([(await flowVersion(root, 'fresh')).hubCommit, (await flowVersion(root, 'fresh')).committed], [next, true]);
});

test('a hub inside a bigger repository compares the file at its own path', async t => {
  for (const prefix of ['hub', 'my hub']) {
    const { root, head } = await hubRepo(t, { prefix });
    const v = await flowVersion(root, 'review');
    assert.deepEqual([v.hubCommit, v.committed], [head, true], prefix);
  }
});

test('without git: no repository, or one without a commit, gives "" and false', async t => {
  const plain = tempDir('ws-flow-nogit-', t);
  writeFiles(plain, { 'flows/review.md': flowText() });
  const v = await flowVersion(plain, 'review');
  assert.deepEqual([v.sha256, v.hubCommit, v.committed], [sha(flowText()), '', false]);
  const unborn = tempDir('ws-flow-unborn-', t);
  await runGit(unborn, ['init', '-q']);
  writeFiles(unborn, { 'flows/review.md': flowText() });
  assert.deepEqual([(await flowVersion(unborn, 'review')).hubCommit, (await flowVersion(unborn, 'review')).committed], ['', false]);
});

test('no version for a name that is not a flow, or a flow file that is missing', async t => {
  const root = tempDir('ws-flow-none-', t);
  writeFiles(root, { 'flows/review.md': flowText(), 'secret.md': 'x' });
  for (const bad of ['', '../secret', '..\\secret', 'Review', 'a/b', 'missing', null, undefined]) {
    assert.equal(await flowVersion(root, bad), null, String(bad));
  }
});

test('images: the ones a run passes, sorted by name, hashed by their bytes; captions hashed as used', async t => {
  const root = tempDir('ws-flow-images-', t);
  const dir = join(root, 'inbox', 'attachments', '_flows', 'review');
  writeFiles(root, {
    'flows/review.md': flowText(),
    'inbox/attachments/_flows/review/b.png': PNG,
    'inbox/attachments/_flows/review/a.jpg': Buffer.from('jpeg bytes'),
    'inbox/attachments/_flows/review/old.bmp': Buffer.from('BM'), // not passed to a run
    'inbox/attachments/_flows/review/notes.txt': 'not an image',
    'inbox/attachments/_flows/review/sub/deeper.png': PNG, // only the folder itself counts
  });
  // b.png is older, so a run calls it Image 1; the version lists by name all the same.
  utimesSync(join(dir, 'b.png'), new Date(2026, 0, 1), new Date(2026, 0, 1));
  const v = await flowVersion(root, 'review');
  assert.deepEqual(v.images, [{ file: 'a.jpg', sha256: sha(Buffer.from('jpeg bytes')) }, { file: 'b.png', sha256: sha(PNG) }]);
  assert.equal(v.captions, '');
  // Captions: trimmed, empty ones and ones of images a run doesn't pass left out.
  writeFileSync(join(dir, 'captions.json'), JSON.stringify({ 'b.png': '  the sketch ', 'a.jpg': ' ', 'old.bmp': 'x' }));
  const captioned = await flowVersion(root, 'review');
  assert.equal(captioned.captions, sha(JSON.stringify({ 'b.png': 'the sketch' })));
  assert.deepEqual(captioned.images, v.images);
  // A changed image changes its hash only.
  writeFileSync(join(dir, 'a.jpg'), 'other bytes');
  const changed = await flowVersion(root, 'review');
  assert.equal(changed.images[0].sha256, sha('other bytes'));
  assert.equal(changed.images[1].sha256, sha(PNG));
});

test('recordFlowRun appends one line per launch; readFlowRuns gives one flow\'s newest first', async t => {
  const dataDir = join(tempDir('ws-flow-runs-', t), 'data'); // made on first write
  assert.equal(flowRunsFile(dataDir), join(dataDir, FLOW_RUNS_FILE));
  assert.deepEqual(await readFlowRuns(dataDir, 'review'), []);
  const version = { sha256: sha('x'), hubCommit: 'a'.repeat(40), committed: true, images: [], captions: '' };
  await recordFlowRun(dataDir, { flow: 'review', version, target: 'project', project: 'example', sessionId: 'id-1' }, new Date('2026-10-23T10:00:00Z'));
  await recordFlowRun(dataDir, { flow: 'other', version, target: 'hub' }, new Date('2026-10-23T10:01:00Z'));
  await recordFlowRun(dataDir, { flow: 'review', version, target: 'project', project: 'notes', sessionId: 'id-2' }, new Date('2026-10-23T10:02:00Z'));
  const lines = readFileSync(flowRunsFile(dataDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines[0], {
    at: '2026-10-23T10:00:00.000Z', flow: 'review', version, target: 'project', project: 'example', agent: '', sessionId: 'id-1',
  });
  assert.deepEqual(lines[1], { at: '2026-10-23T10:01:00.000Z', flow: 'other', version, target: 'hub', project: '', agent: '', sessionId: '' });
  const runs = await readFlowRuns(dataDir, 'review');
  assert.deepEqual(runs.map(r => [r.project, r.sessionId]), [['notes', 'id-2'], ['example', 'id-1']]);
  assert.deepEqual(runs[0].version, version);
});

test('readFlowRuns keeps the newest 20, skips broken lines and cleans odd values', async t => {
  const dataDir = tempDir('ws-flow-runs-many-', t);
  const version = { sha256: sha('v'), hubCommit: '', committed: false, images: [], captions: '' };
  for (let i = 0; i < 25; i++) await recordFlowRun(dataDir, { flow: 'review', version, target: 'hub', sessionId: `s${i}` });
  const runs = await readFlowRuns(dataDir, 'review');
  assert.equal(runs.length, RECENT_RUNS);
  assert.deepEqual([runs[0].sessionId, runs[19].sessionId], ['s24', 's5']);
  assert.equal((await readFlowRuns(dataDir, 'review', { limit: 2 })).length, 2);
  assert.deepEqual(await readFlowRuns(dataDir, 'review', { limit: 0 }), []);
  // A torn line, a line that is no record and hand-edited values.
  appendFileSync(flowRunsFile(dataDir), '{"flow":"review","at":\n[1,2]\n"review"\n');
  appendFileSync(flowRunsFile(dataDir), `${JSON.stringify({
    at: 5, flow: 'review', target: 'project', project: { x: 1 }, sessionId: 'odd',
    version: { sha256: sha('w'), hubCommit: '--evil', committed: 'yes', images: [{ file: 'a.png', sha256: 'nope' }, { file: 'b.png', sha256: sha('b') }, null], captions: 7 },
  })}\n`);
  appendFileSync(flowRunsFile(dataDir), `${JSON.stringify({ flow: 'review', target: 'hub', version: { sha256: 'short' }, sessionId: 'no-version' })}\n`);
  // A time that is no timestamp, and "committed" without a commit to be committed in.
  appendFileSync(flowRunsFile(dataDir), `${JSON.stringify({
    at: 'yesterday', flow: 'review', target: 'hub', sessionId: 'no-commit',
    version: { sha256: sha('c'), hubCommit: 'not-a-sha', committed: true, images: [], captions: '' },
  })}\n`);
  const [noCommit, last, odd, newest] = await readFlowRuns(dataDir, 'review');
  assert.deepEqual([noCommit.at, noCommit.version.hubCommit, noCommit.version.committed], ['', '', false]);
  assert.deepEqual(last, { at: '', flow: 'review', version: null, target: 'hub', project: '', agent: '', sessionId: 'no-version' });
  assert.deepEqual(odd, {
    at: '', flow: 'review', target: 'project', project: '', agent: '', sessionId: 'odd',
    version: { sha256: sha('w'), hubCommit: '', committed: false, images: [{ file: 'b.png', sha256: sha('b') }], captions: '' },
  });
  // A real launch time stays as written.
  assert.equal(newest.sessionId, 's24');
  assert.match(newest.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // A data folder that doesn't exist yet has no runs.
  assert.deepEqual(await readFlowRuns(join(dataDir, 'nope'), 'review'), []);
});

test('versionChanges: the prompt, the images (or captions), nothing, or unknown', () => {
  const v = { sha256: sha('a'), hubCommit: 'b'.repeat(40), committed: true, images: [{ file: 'a.png', sha256: sha('1') }], captions: '' };
  assert.deepEqual(versionChanges(v, { ...v }), []);
  // Another commit or committing it is no change to the flow itself.
  assert.deepEqual(versionChanges(v, { ...v, hubCommit: 'c'.repeat(40), committed: false }), []);
  assert.deepEqual(versionChanges(v, { ...v, sha256: sha('b') }), ['prompt']);
  assert.deepEqual(versionChanges(v, { ...v, images: [] }), ['images']);
  assert.deepEqual(versionChanges(v, { ...v, images: [{ file: 'a.png', sha256: sha('2') }] }), ['images']);
  assert.deepEqual(versionChanges(v, { ...v, captions: sha('c') }), ['images']);
  assert.deepEqual(versionChanges(v, { ...v, sha256: sha('b'), images: [] }), ['prompt', 'images']);
  assert.deepEqual(versionChanges(null, v), ['unknown']);
  assert.deepEqual(versionChanges(v, null), []);
});

test('a flow removed from disk has no version, and its images folder alone gives none', async t => {
  const root = tempDir('ws-flow-gone-', t);
  writeFiles(root, { 'flows/review.md': flowText(), 'inbox/attachments/_flows/review/a.png': PNG });
  assert.ok(await flowVersion(root, 'review'));
  rmSync(join(root, 'flows', 'review.md'));
  assert.equal(await flowVersion(root, 'review'), null);
  mkdirSync(join(root, 'flows', 'folder.md'), { recursive: true }); // a folder with a flow's name
  assert.equal(await flowVersion(root, 'folder'), null);
});
