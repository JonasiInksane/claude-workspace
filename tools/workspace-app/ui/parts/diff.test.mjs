// Tests for the pure part of parts/diff.js: splitting one file's unified diff into typed lines
// with line numbers, finding a new-file line, and the summary words. The DOM helpers of the
// module (fileChips, diffView) need a browser and are checked there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, diffSummary, isCut, lineIndex, parseDiff, SHOW_LINES } from './diff.js';

const MODIFIED = [
  'diff --git a/src/cart/total.mjs b/src/cart/total.mjs',
  'index 1111111..2222222 100644',
  '--- a/src/cart/total.mjs',
  '+++ b/src/cart/total.mjs',
  '@@ -3,4 +3,5 @@ export function total(items) {',
  '   let sum = 0;',
  '-  for (const i of items) sum += i.price * 1;',
  '+  for (const i of items) sum += i.cents;',
  '+  // cents only',
  '   return sum;',
  '',
  '@@ -20,2 +21,2 @@',
  '-const a = 1;',
  '+const a = 2;',
  '\\ No newline at end of file',
  '',
].join('\n');

test('parseDiff types every line and counts hunks, adds and dels', () => {
  const p = parseDiff(MODIFIED);
  assert.deepEqual(p.lines.map(l => l.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'ctx', 'ctx', 'hunk', 'del', 'add', 'note']);
  assert.equal(p.hunks, 2);
  assert.equal(p.add, 3);
  assert.equal(p.del, 2);
  assert.equal(p.isNew, false);
  assert.equal(p.binary, false);
});

test('parseDiff numbers the old and new lines from the hunk headers', () => {
  const p = parseDiff(MODIFIED);
  const at = kind => p.lines.filter(l => l.kind === kind);
  assert.deepEqual(at('add').map(l => l.newNo), [4, 5, 21]);
  assert.deepEqual(at('del').map(l => l.oldNo), [4, 20]);
  const ctx = at('ctx');
  assert.deepEqual(ctx.map(l => [l.oldNo, l.newNo]), [[3, 3], [5, 6], [6, 7]], 'a blank context line (no leading space) still counts');
  assert.equal(p.lines[0].newNo, null);
});

test('lineIndex finds a new-file line, and -1 for lines outside the hunks or bad input', () => {
  const p = parseDiff(MODIFIED);
  assert.equal(p.lines[lineIndex(p, 5)].text, '+  // cents only');
  assert.equal(p.lines[lineIndex(p, 3)].text, '   let sum = 0;');
  assert.equal(lineIndex(p, 100), -1);
  assert.equal(lineIndex(p, 0), -1);
  assert.equal(lineIndex(p, 'x'), -1);
  assert.equal(lineIndex(null, 3), -1);
});

test('parseDiff marks new, deleted, renamed and binary files', () => {
  const added = parseDiff('diff --git a/n.md b/n.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+# N\n+text\n');
  assert.equal(added.isNew, true);
  assert.deepEqual(added.lines.filter(l => l.kind === 'add').map(l => l.newNo), [1, 2]);
  assert.equal(diffSummary(added), 'New file · 1 hunk · +2 −0');
  const gone = parseDiff('diff --git a/o.md b/o.md\ndeleted file mode 100644\n--- a/o.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n');
  assert.equal(gone.isDeleted, true);
  assert.equal(diffSummary(gone), 'Deleted file · 1 hunk · +0 −1');
  const bin = parseDiff('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n');
  assert.equal(bin.binary, true);
  assert.equal(bin.hunks, 0);
  assert.equal(diffSummary(bin), 'Binary file · +0 −0');
  const moved = parseDiff('diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to b.md\n');
  assert.equal(moved.renamedFrom, 'a.md');
  assert.match(diffSummary(moved), /^Renamed from a\.md/);
});

test('parseDiff keeps markup-looking text as plain line text and drops a trailing carriage return', () => {
  const p = parseDiff('@@ -1 +1 @@\r\n-<b>old</b>\r\n+<img src=x onerror=alert(1)>\r\n');
  assert.deepEqual(p.lines.map(l => l.text), ['@@ -1 +1 @@', '-<b>old</b>', '+<img src=x onerror=alert(1)>']);
  assert.deepEqual(parseDiff('').lines, []);
  assert.deepEqual(parseDiff(undefined).lines, []);
});

test('isCut says when the view leaves lines out, and baseName gives the chip name', () => {
  const long = parseDiff(`@@ -1,${SHOW_LINES + 5} +1,${SHOW_LINES + 5} @@\n${' x\n'.repeat(SHOW_LINES + 5)}`);
  assert.equal(isCut(long), true);
  assert.equal(isCut(long, true), false);
  assert.equal(isCut(parseDiff(MODIFIED)), false);
  assert.equal(baseName('apps/web/src/a.ts'), 'a.ts');
  assert.equal(baseName('README.md'), 'README.md');
});
