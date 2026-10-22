// Tests for the launcher's pure helpers (ui/views/launcher.js): drafts from the intent box,
// the values sent to POST /api/runs, fields shown only for some choices, the Options summary,
// the finding picker's order (the same as Next up), the image picker's choices, and why Start
// is off. The view itself needs a browser; these helpers don't touch the DOM.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftValues, fieldShown, imageChoices, isLevelField, isMissing, missingText, optionsSummary, rankOpenFindings,
  startBlock, textTarget, valuesToSend, whatField, whereSentence,
} from './launcher.js';
import { pipelineForUi, pipelinesForUi, checkValues } from '../../runs/catalog.mjs';
import { nextUp } from '../../findings/store.mjs';

// The page's view of the catalog, as GET /api/pipelines sends it (with a small profile).
const profile = { lenses: ['missingAssert', 'todoCount'], findings: { idPattern: '\\bEX-\\d{1,3}\\b' } };
const def = id => pipelineForUi(id, { profile });

test('every catalog field kind is one the launcher renders', () => {
  const known = new Set(['textarea', 'text', 'path', 'select', 'multi', 'bool', 'finding', 'image']);
  for (const p of pipelinesForUi({ profile })) {
    for (const f of p.fields) assert.ok(known.has(f.kind), `${p.id}.${f.key}: kind ${f.kind}`);
    assert.ok(p.fields.length > 0, `${p.id} has a first field (the big question)`);
  }
});

test('drafts: the text goes to `what`, else the notes, else it is shown as unused', () => {
  assert.deepEqual(draftValues(def('refactor'), { what: '  Split the cart  ' }).values.what, 'Split the cart');
  const fix = draftValues(def('fix'), { what: 'fix EX-3', findingId: 'EX-3' });
  assert.equal(fix.values.finding, 'EX-3');
  assert.equal(fix.values.notes, '', '"fix EX-3" says nothing more than the finding');
  assert.equal(draftValues(def('fix'), { what: 'fix EX-3: mind the rounding', findingId: 'EX-3' }).values.notes, 'fix EX-3: mind the rounding');
  assert.equal(draftValues(def('fix'), { what: 'the login thing' }).values.notes, 'the login thing');
  const review = draftValues(def('review'), { what: 'review my changes' });
  assert.equal(review.unused, 'review my changes');
  assert.equal(review.values.target, 'uncommitted', 'defaults stay');
  assert.deepEqual(draftValues(def('check'), { what: '' }), { values: { what: 'uncommitted', level: 'quick' }, unused: '' });
  assert.equal(textTarget(def('review')), null);
  assert.equal(whatField(def('fix')), null, 'Fix has no free-text request');
  assert.equal(textTarget(def('fix')).key, 'notes');
});

test('conditional fields: shown only when their choice is made, and sent empty otherwise', () => {
  assert.equal(fieldShown('review', 'n', { target: 'uncommitted' }), false);
  assert.equal(fieldShown('review', 'n', { target: 'last' }), true);
  assert.equal(fieldShown('review', 'branch', { target: 'app' }), true);
  assert.equal(fieldShown('architecture', 'commit', { compare: 'last' }), false);
  assert.equal(fieldShown('refactor', 'where', {}), true);
  const d = def('review');
  const sent = valuesToSend(d, { target: 'uncommitted', n: '123', branch: 'nope', focus: ['money'], depth: 'deep' });
  assert.deepEqual(sent, { target: 'uncommitted', n: '', branch: '', focus: ['money'], depth: 'deep' });
  // What the page sends passes the server's own check (a hidden over-long n would not).
  assert.equal(checkValues('review', sent, { profile }).error, '');
  assert.match(checkValues('review', { target: 'uncommitted', n: '123' }, { profile }).error, /longer than 2/);
});

test('the level cards are the selects whose options are the three levels', () => {
  assert.ok(isLevelField(def('refactor').fields.find(f => f.key === 'care')));
  assert.ok(isLevelField(def('check').fields.find(f => f.key === 'level')));
  assert.ok(!isLevelField(def('review').fields.find(f => f.key === 'depth')));
  assert.ok(!isLevelField(def('debug').fields.find(f => f.key === 'seen')));
});

test('Options summary: the advanced fields in one line', () => {
  const d = def('refactor');
  const values = draftValues(d, { what: 'x' }).values;
  assert.equal(optionsSummary(d, values), 'Where: Claude finds it · Kind: Auto · Standard · Keep the same: 4 of 4 · Keep out: not set');
  const long = 'apps/web/src/features/a-very-long-folder-name/and/a/file.mjs';
  Object.assign(values, { where: long, care: 'paranoid', keep: ['trpc'] });
  assert.equal(optionsSummary(d, values), `Where: ${long.slice(0, 39)}… · Kind: Auto · Paranoid · Keep the same: 1 of 4 · Keep out: not set`);
  assert.equal(optionsSummary(def('explain'), {}), '', 'no advanced fields, no summary');
});

test('missing question: required and empty, with its sentence', () => {
  const what = def('explain').fields[0];
  assert.ok(isMissing(what, '  '));
  assert.ok(!isMissing(what, 'why?'));
  assert.ok(!isMissing(def('explain').fields[1], ''), 'optional fields are never missing');
  assert.equal(missingText(what), 'Say what you want first.');
  assert.equal(missingText(def('fix').fields[0]), 'Pick a finding first.');
});

test('the finding picker lists open findings in the order Next up picks them', () => {
  const F = (id, severity, extra = {}) => ({ id, title: id, severity, status: 'open', phase: 0, blast: 'small', ownerDecision: false, ...extra });
  const doc = {
    phases: [{ id: 0, label: 'P0' }, { id: 1, label: 'P1' }],
    findings: [
      F('EX-1', 'high'), F('EX-2', 'critical', { blast: 'large' }), F('EX-3', 'medium', { status: 'in-run' }),
      F('EX-4', 'high', { ownerDecision: true }), F('EX-5', 'high', { phase: 1, blast: 'medium' }), F('EX-6', 'low', { status: 'done' }),
      F('EX-7', 'high', { phase: 1 }), F('EX-8', 'low', { status: 'proposed' }),
    ],
  };
  const order = rankOpenFindings(doc).map(f => f.id);
  assert.deepEqual(order, ['EX-2', 'EX-1', 'EX-7', 'EX-5', 'EX-4']);
  assert.equal(order[0], nextUp(doc).id, 'the first one is the server\'s Next up');
  assert.deepEqual(rankOpenFindings(null), []);
});

test('image choices: images under inbox/attachments a run accepts, newest first, at most 40', () => {
  const img = (path, mtime) => ({ path, name: path.split('/').pop(), mtime });
  const list = imageChoices([
    [img('inbox/attachments/_hub/2026-10-22/a.png', '2026-10-22T10:00:00Z'), img('inbox/attachments/_hub/2026-10-22/b.webp', '2026-10-22T11:00:00Z')],
    [img('inbox/attachments/_hub/2026-10-22/a.png', '2026-10-22T10:00:00Z'), img('inbox/note.png', '2026-10-22T12:00:00Z'),
      img('inbox/attachments/x/bad|name.png', '2026-10-22T12:00:00Z'), img('inbox/attachments/notes.md', '2026-10-22T12:00:00Z')],
  ]);
  assert.deepEqual(list.map(i => i.value), ['_hub/2026-10-22/b.webp', '_hub/2026-10-22/a.png']);
  assert.equal(list[0].path, 'inbox/attachments/_hub/2026-10-22/b.webp');
  const many = Array.from({ length: 50 }, (_, i) => img(`inbox/attachments/_hub/d/${i}.png`, `2026-10-22T10:${String(i).padStart(2, '0')}:00Z`));
  const top = imageChoices([many]);
  assert.equal(top.length, 40);
  assert.equal(top[0].value, '_hub/d/49.png');
  // Every value passes the server's check of the screenshot field.
  for (const c of list) assert.equal(checkValues('debug', { what: 'x', screenshot: c.value }, { profile, inboxExists: () => true }).error, '');
});

test('Start is off with a reason, in order of what to fix first', () => {
  const d = { disabledReason: '' };
  const ok = { refusals: [], error: '' };
  assert.equal(startBlock({ project: '', def: d }), 'Pick a project first.');
  assert.equal(startBlock({ project: 'p', def: null }), 'Pick a pipeline first.');
  assert.equal(startBlock({ project: 'p', def: { disabledReason: 'No profile.' }, preview: ok }), 'No profile.');
  assert.equal(startBlock({ project: 'p', def: d, preview: ok, missing: 'Say what you want first.' }), 'Say what you want first.');
  assert.equal(startBlock({ project: 'p', def: d, preview: null }), 'waiting for the preview…');
  assert.match(startBlock({ project: 'p', def: d, preview: null, previewError: 'boom' }), /could not be loaded/);
  assert.equal(startBlock({ project: 'p', def: d, preview: { ...ok, error: 'Where must be a path.' } }), 'Where must be a path.');
  assert.equal(startBlock({ project: 'p', def: d, preview: { ...ok, refusals: ['Busy.'] } }), 'see the note above.');
  assert.equal(startBlock({ project: 'p', def: d, preview: { ...ok, refusals: ['a', 'b'] } }), '2 problems, listed above.');
  assert.equal(startBlock({ project: 'p', def: d, preview: ok }), '');
  assert.equal(startBlock({ project: 'p', def: d, preview: ok, starting: true }), 'Starting the run…');
  // Values changed since the preview shown: its problems may be gone, so it says it is updating.
  assert.equal(startBlock({ project: 'p', def: d, preview: { ...ok, error: 'Question needs an answer.' }, stale: true }), 'updating the preview…');
  assert.equal(startBlock({ project: 'p', def: d, preview: { ...ok, refusals: ['Busy.'] }, stale: true }), 'updating the preview…');
  assert.equal(startBlock({ project: 'p', def: d, preview: ok, stale: true }), '', 'a clean preview keeps Start on; a click waits for the new one');
});

test('where sentence: no doubled full stop', () => {
  assert.equal(whereSentence('read-only in the main checkout, no lock needed'), 'Where: read-only in the main checkout, no lock needed.');
  assert.equal(whereSentence('the run worktree, on a new branch app/1022-…'), 'Where: the run worktree, on a new branch app/1022-…');
});
