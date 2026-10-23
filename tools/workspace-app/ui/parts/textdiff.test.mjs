// Tests for parts/textdiff.js: splitting a text into lines (CRLF, a final line break, empty), the
// LCS line diff (same, inserted, removed and replaced lines, line numbers on both sides, the
// shared start and end cut first, the cap that turns a huge middle into removed-then-added),
// folding unchanged runs around the changes, the summary words, and the view in a stand-in DOM
// (test/dom.mjs): one text span per line with its sign, the folds, and no markup from the text.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const { diffHunks, diffSummary, lineDiff, splitLines, textDiffView } = await import('./textdiff.js');

const kinds = d => d.rows.map(r => `${r.kind[0]}:${r.text}`);

test('splitLines: CRLF and CR are line breaks; a final break ends the last line; empty has none', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(splitLines('a\n\n'), ['a', ''], 'only the last break is dropped');
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitLines(undefined), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('lineDiff: identical texts are all the same, with both line numbers', () => {
  const d = lineDiff('a\nb\n', 'a\r\nb');
  assert.deepEqual(kinds(d), ['s:a', 's:b']);
  assert.deepEqual(d.rows.map(r => [r.oldNo, r.newNo]), [[1, 1], [2, 2]]);
  assert.deepEqual([d.added, d.removed, d.approximate], [0, 0, false]);
});

test('lineDiff: inserted, removed and replaced lines, numbered on their own side', () => {
  const ins = lineDiff('a\nc', 'a\nb\nc');
  assert.deepEqual(kinds(ins), ['s:a', 'a:b', 's:c']);
  assert.deepEqual(ins.rows.map(r => [r.oldNo, r.newNo]), [[1, 1], [null, 2], [2, 3]]);
  const del = lineDiff('a\nb\nc', 'a\nc');
  assert.deepEqual(kinds(del), ['s:a', 'd:b', 's:c']);
  assert.deepEqual(del.rows[1], { kind: 'del', text: 'b', oldNo: 2, newNo: null });
  // A replaced line shows its removal before its addition.
  const rep = lineDiff('- Money in euros.\n- Tests first.', '- Money in cents.\n- Tests first.');
  assert.deepEqual(kinds(rep), ['d:- Money in euros.', 'a:- Money in cents.', 's:- Tests first.']);
  assert.deepEqual([rep.added, rep.removed], [1, 1]);
});

test('lineDiff: the longest common subsequence keeps moved-around lines that still line up', () => {
  const d = lineDiff('a\nb\nc\nd\ne', 'a\nc\nx\nd\ne\nf');
  assert.deepEqual(kinds(d), ['s:a', 'd:b', 's:c', 'a:x', 's:d', 's:e', 'a:f']);
  assert.equal(d.rows.filter(r => r.kind === 'same').length, 4, 'a, c, d and e stay');
  // Repeated lines: the middle is diffed after the shared start and end are cut.
  const r = lineDiff('x\nx\nx', 'x\ny\nx\nx');
  assert.deepEqual([r.added, r.removed], [1, 0]);
});

test('lineDiff: from or to an empty text', () => {
  assert.deepEqual(kinds(lineDiff('', 'a\nb')), ['a:a', 'a:b']);
  assert.deepEqual(kinds(lineDiff('a\nb', '')), ['d:a', 'd:b']);
  assert.deepEqual(lineDiff('', '').rows, []);
  assert.equal(lineDiff('', 'a').approximate, false, 'only adds is an exact answer');
});

test('lineDiff: over the cap, the middle is shown as removed then added, marked approximate', () => {
  const before = ['keep', 'a1', 'a2', 'a3', 'end'].join('\n');
  const after = ['keep', 'b1', 'b2', 'end'].join('\n');
  const d = lineDiff(before, after, { maxCells: 4 });
  assert.equal(d.approximate, true);
  assert.deepEqual(kinds(d), ['s:keep', 'd:a1', 'd:a2', 'd:a3', 'a:b1', 'a:b2', 's:end']);
  assert.deepEqual(d.rows[6], { kind: 'same', text: 'end', oldNo: 5, newNo: 4 });
  assert.equal(lineDiff(before, after).approximate, false, 'the default cap diffs it line by line');
  // A large but similar pair stays exact: only the middle counts.
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const changed = [...big];
  changed[1500] = 'changed';
  const exact = lineDiff(big.join('\n'), changed.join('\n'));
  assert.deepEqual([exact.added, exact.removed, exact.approximate], [1, 1, false]);
});

test('diffHunks: changes with three lines of context; longer unchanged runs fold; no change gives nothing', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const after = [...before];
  after[9] = 'changed';
  const items = diffHunks(lineDiff(before.join('\n'), after.join('\n')).rows);
  assert.deepEqual(items.map(r => (r.kind === 'skip' ? `skip ${r.count}` : `${r.kind[0]}:${r.text}`)),
    ['skip 6', 's:l7', 's:l8', 's:l9', 'd:l10', 'a:changed', 's:l11', 's:l12', 's:l13', 'skip 7']);
  assert.deepEqual(diffHunks(lineDiff('a\nb', 'a\nb').rows), []);
  assert.deepEqual(diffHunks(null), []);
  // A fold of a single line is shown instead.
  const one = diffHunks(lineDiff('a\nb\nc\nd\ne', 'x\nb\nc\nd\ne').rows, 3);
  assert.deepEqual(one.map(r => r.kind), ['del', 'add', 'same', 'same', 'same', 'same']);
});

test('diffSummary says what changed in words', () => {
  assert.equal(diffSummary(lineDiff('a', 'a\nb\nc')), '2 lines added');
  assert.equal(diffSummary(lineDiff('a\nb', 'c')), '1 line added, 2 removed');
  assert.equal(diffSummary(lineDiff('a\nb', 'a')), '1 line removed');
  assert.equal(diffSummary(lineDiff('a', 'a')), 'No line changed');
  assert.equal(diffSummary(null), '');
});

test('textDiffView: one span per line with its sign and numbers; folds as text; markup stays text', () => {
  const pre = textDiffView(lineDiff('<b>old</b>\nsame', '<img src=x onerror=alert(1)>\nsame'), { label: 'Rules: v1 to v2' });
  assert.equal(pre.tagName, 'PRE');
  assert.equal(pre.getAttribute('aria-label'), 'Rules: v1 to v2');
  assert.equal(pre.getAttribute('tabindex'), '0', 'a long diff can be scrolled with the keyboard');
  const lines = pre.children;
  assert.deepEqual(lines.map(s => s.className), ['del', 'add', 'same']);
  assert.equal(lines[0].childNodes[1].data, '- <b>old</b>', 'the text is a text node, never parsed');
  assert.equal(lines[1].childNodes[1].data, '+ <img src=x onerror=alert(1)>');
  assert.equal(pre.querySelectorAll('img').length, 0);
  assert.equal(lines[0].querySelector('.ln').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(lines[2].querySelector('.ln').children.map(s => s.textContent), ['2', '2'], 'old and new line number');
  assert.deepEqual(lines[0].querySelector('.ln').children.map(s => s.textContent), ['1', ''], 'a removed line has no new number');
  const long = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
  const folded = textDiffView(lineDiff(long, `${long}\nnew`));
  assert.equal(folded.children[0].className, 'skip');
  assert.equal(folded.children[0].textContent, '… 9 unchanged lines', 'l0 to l8 fold; l9 to l11 are the context');
  assert.match(textOf(folded), /\+ new$/);
  assert.equal(textDiffView(lineDiff('a', 'a')).children.length, 0, 'no change: an empty view (the caller says so)');
});
