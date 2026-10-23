// Tests for gates/history.mjs: one line per finished check level, the last line per level, and a
// torn line costing only itself. Data folders are temporary folders under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '../test/helpers.mjs';
import { LEVELS, appendHistory, historyFile, historyLine, lastPerLevel, readHistory } from './history.mjs';

const summary = (level, result, extra = {}) => ({
  version: 1, level, role: 'head', treeMode: 'run', tree: 'C:\\dev\\example-run', baseSha: 'a'.repeat(40), node: '24.11.1',
  startedAt: '2026-10-22T10:00:00.000Z', endedAt: '2026-10-22T10:10:00.000Z', durationMs: 600000,
  result, chip: '0 new · 2 known', counts: { new: 0, known: 2, flaky: 0, canShrink: 0, notRun: 1 }, checks: [], ...extra,
});

test('historyFile is checks/<project>/history.jsonl and checks the project name', t => {
  const dir = tempDir('wp4-hist-', t);
  assert.equal(historyFile(dir, 'example'), join(dir, 'checks', 'example', 'history.jsonl'));
  assert.throws(() => historyFile(dir, '../x'), /not a project name/);
  assert.throws(() => historyFile(dir, 'Example'), /not a project name/);
});

test('historyLine keeps the fields of spec 2.10', () => {
  const line = historyLine(summary('standard', 'pass'), { runId: '261022-100000-check-my-work' });
  assert.deepEqual(line, {
    at: '2026-10-22T10:10:00.000Z', runId: '261022-100000-check-my-work', level: 'standard', treeMode: 'run', baseSha: 'a'.repeat(40),
    node: '24.11.1', result: 'pass', chip: '0 new · 2 known', durationMs: 600000, counts: { new: 0, known: 2, flaky: 0, notRun: 1 },
  });
  assert.equal(historyLine({}).chip, '');
  assert.deepEqual(historyLine({}).counts, { new: 0, known: 0, flaky: 0 });
});

test('historyLine sums the passed, failed and skipped tests of the test commands, plus the checks not run', () => {
  const checks = [
    { id: 'g0', group: 'G0', status: 'pass' },
    { id: 'test:api', status: 'fail', counts: { pass: 40, fail: 3, skip: 1, todo: 1 } },
    { id: 'types:api', status: 'pass' },
    { id: 'test:web', status: 'pass', counts: { pass: 12, fail: 0, skip: 0, todo: 0 } },
    { id: 'lint', status: 'skip' },
  ];
  const line = historyLine(summary('standard', 'fail', { checks, counts: { new: 1, known: 2, flaky: 0, canShrink: 0, notRun: 1 } }));
  assert.deepEqual(line.counts, { new: 1, known: 2, flaky: 0, pass: 52, fail: 3, skip: 2, notRun: 1 }, 'a todo test counts as skipped');
  // No test command ran: no test totals rather than zeros. A summary without notRun gives none.
  const types = historyLine(summary('quick', 'pass', { checks: [{ id: 'types:api', status: 'pass' }], counts: { new: 0, known: 0, flaky: 0 } }));
  assert.deepEqual(types.counts, { new: 0, known: 0, flaky: 0 });
  // An odd number on a row counts as nothing instead of breaking the sum.
  const odd = historyLine(summary('quick', 'pass', { checks: [{ counts: { pass: '3', fail: -1, skip: Number.NaN } }, { counts: { pass: 2 } }] }));
  assert.deepEqual([odd.counts.pass, odd.counts.fail, odd.counts.skip], [2, 0, 0]);
});

test('a line written before the test totals reads back as it was, with no zeros added', async t => {
  const dir = tempDir('wp4-hist-', t);
  const file = historyFile(dir, 'example');
  mkdirSync(dirname(file), { recursive: true });
  const old = { at: '2026-10-20T10:00:00.000Z', level: 'quick', result: 'pass', runId: 'old', counts: { new: 0, known: 2, flaky: 0 } };
  appendFileSync(file, `${JSON.stringify(old)}\n`);
  const checks = [{ id: 'test:api', counts: { pass: 5, fail: 0, skip: 0, todo: 0 } }];
  await appendHistory(dir, 'example', historyLine(summary('standard', 'pass', { checks }), { runId: 'new' }));
  const last = await lastPerLevel(dir, 'example');
  assert.deepEqual(last.quick.counts, { new: 0, known: 2, flaky: 0 });
  assert.deepEqual(last.standard.counts, { new: 0, known: 2, flaky: 0, pass: 5, fail: 0, skip: 0, notRun: 1 });
  assert.deepEqual((await readHistory(dir, 'example')).map(r => r.runId), ['new', 'old']);
});

test('appendHistory writes one JSON line per call', async t => {
  const dir = tempDir('wp4-hist-', t);
  const row = await appendHistory(dir, 'example', historyLine(summary('quick', 'fail'), { runId: 'r1' }));
  await appendHistory(dir, 'example', { level: 'paranoid', result: 'pass' });
  const lines = readFileSync(historyFile(dir, 'example'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), row);
  const second = JSON.parse(lines[1]);
  assert.equal(second.level, 'paranoid');
  assert.match(second.at, /^\d{4}-\d\d-\d\dT/);
});

test('lastPerLevel gives the newest line of each level, or null', async t => {
  const dir = tempDir('wp4-hist-', t);
  assert.deepEqual(await lastPerLevel(dir, 'example'), { quick: null, standard: null, paranoid: null });
  await appendHistory(dir, 'example', { level: 'quick', result: 'fail', runId: 'a' });
  await appendHistory(dir, 'example', { level: 'standard', result: 'pass', runId: 'b' });
  await appendHistory(dir, 'example', { level: 'quick', result: 'pass', runId: 'c' });
  await appendHistory(dir, 'example', { level: 'weird', result: 'pass', runId: 'd' });
  const last = await lastPerLevel(dir, 'example');
  assert.deepEqual(Object.keys(last), LEVELS);
  assert.equal(last.quick.runId, 'c');
  assert.equal(last.standard.runId, 'b');
  assert.equal(last.paranoid, null);
});

test('readHistory lists the newest first, up to the limit', async t => {
  const dir = tempDir('wp4-hist-', t);
  for (let i = 1; i <= 25; i++) await appendHistory(dir, 'example', { level: 'quick', result: 'pass', runId: `r${i}` });
  const rows = await readHistory(dir, 'example');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].runId, 'r25');
  assert.equal((await readHistory(dir, 'example', { limit: 3 })).map(r => r.runId).join(','), 'r25,r24,r23');
  assert.deepEqual(await readHistory(dir, 'other'), []);
});

test('a torn line is skipped and the next append starts on a fresh line', async t => {
  const dir = tempDir('wp4-hist-', t);
  const file = historyFile(dir, 'example');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ level: 'quick', result: 'pass', runId: 'ok1' })}\n{"level":"standard","res`);
  await appendHistory(dir, 'example', { level: 'standard', result: 'fail', runId: 'ok2' });
  const last = await lastPerLevel(dir, 'example');
  assert.equal(last.quick.runId, 'ok1');
  assert.equal(last.standard.runId, 'ok2');
  assert.equal((await readHistory(dir, 'example')).length, 2);
});
