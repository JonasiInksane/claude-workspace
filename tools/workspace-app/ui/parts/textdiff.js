// A line diff of two texts, for the project Settings tab's Compare (the rules of two settings
// versions). The page has no libraries, so it is written here: lineDiff() cuts the lines both
// texts share at the start and at the end, finds the longest common subsequence (LCS) of the
// lines in between, and walks it into rows that are the same, removed or added. diffHunks() folds
// long runs of unchanged lines around the changes, and textDiffView() shows the result as one
// text span per line with "+ " or "- " in front, so the colour never carries the meaning alone.
// Nothing in the texts is ever parsed as HTML (lib.js h() adds every line as text).
//
// The LCS table grows with the product of the two middles' line counts. Above MAX_CELLS (about
// 2,000 differing lines on each side) lineDiff gives up on a line-by-line answer for the middle
// and shows it as removed, then added, with `approximate: true`, so a huge paste can't freeze the
// page. Rules are at most 20,000 characters, so real edits stay far below that.
//
// The functions above the DOM section are pure; parts/textdiff.test.mjs tests them and the view.
import { h, plural } from '../lib.js';

export const MAX_CELLS = 4_000_000;
export const CONTEXT = 3;

// A text as its lines: CRLF and CR become LF, and a final line break ends the last line instead
// of starting an empty one. '' (and null) has no lines.
export function splitLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The rows between the shared start and end: LCS by a table of suffix lengths, walked from the
// top so a change shows its removed lines before its added ones. `base` is the number of lines
// before the middle (for the line numbers).
function middleRows(a, b, base) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = Math.min(n, m) < 65535 ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: 'same', text: a[i], oldNo: base + i + 1, newNo: base + j + 1 }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { rows.push({ kind: 'del', text: a[i], oldNo: base + i + 1, newNo: null }); i++; }
    else { rows.push({ kind: 'add', text: b[j], oldNo: null, newNo: base + j + 1 }); j++; }
  }
  for (; i < n; i++) rows.push({ kind: 'del', text: a[i], oldNo: base + i + 1, newNo: null });
  for (; j < m; j++) rows.push({ kind: 'add', text: b[j], oldNo: null, newNo: base + j + 1 });
  return rows;
}

// The line diff of `before` and `after`: { rows: [{ kind: 'same' | 'del' | 'add', text, oldNo,
// newNo }], added, removed, approximate }. oldNo and newNo count from 1 (null where a side has no
// line). `maxCells` caps the LCS table (MAX_CELLS; tests pass a small one).
export function lineDiff(before, after, { maxCells = MAX_CELLS } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const rows = [];
  for (let i = 0; i < start; i++) rows.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let approximate = false;
  if (midA.length && midB.length && (midA.length + 1) * (midB.length + 1) <= maxCells) {
    rows.push(...middleRows(midA, midB, start));
  } else {
    approximate = midA.length > 0 && midB.length > 0;
    midA.forEach((text, k) => rows.push({ kind: 'del', text, oldNo: start + k + 1, newNo: null }));
    midB.forEach((text, k) => rows.push({ kind: 'add', text, oldNo: null, newNo: start + k + 1 }));
  }
  for (let k = 0; endA + k < a.length; k++) rows.push({ kind: 'same', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  const added = rows.filter(r => r.kind === 'add').length;
  const removed = rows.filter(r => r.kind === 'del').length;
  return { rows, added, removed, approximate };
}

// The rows to show: every change with `context` unchanged lines around it; a longer run of
// unchanged lines becomes { kind: 'skip', count }. A run of one line is shown rather than folded.
// No changes at all gives [].
export function diffHunks(rows, context = CONTEXT) {
  const list = Array.isArray(rows) ? rows : [];
  const changed = list.map(r => r.kind !== 'same');
  if (!changed.some(Boolean)) return [];
  const keep = list.map(() => false);
  changed.forEach((c, i) => {
    if (!c) return;
    for (let k = Math.max(0, i - context); k <= Math.min(list.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  for (let i = 0; i < list.length;) {
    if (keep[i]) { out.push(list[i]); i++; continue; }
    let j = i;
    while (j < list.length && !keep[j]) j++;
    if (j - i === 1) out.push(list[i]);
    else out.push({ kind: 'skip', count: j - i });
    i = j;
  }
  return out;
}

// "3 lines added, 1 removed", "1 line removed", or "No line changed".
export function diffSummary(diff) {
  if (!diff) return '';
  const parts = [];
  if (diff.added) parts.push(`${plural(diff.added, 'line')} added`);
  if (diff.removed) parts.push(parts.length ? `${diff.removed} removed` : `${plural(diff.removed, 'line')} removed`);
  return parts.length ? parts.join(', ') : 'No line changed';
}

// ---------------------------------------------------------------- DOM

const SIGN = { same: '  ', del: '- ', add: '+ ' };

// The diff as <pre class="textdiff">: one block span per line (class same, del or add) with a
// gutter of the old and new line numbers (hidden from screen readers; the sign says what
// changed), and "… 12 unchanged lines" (class skip) where diffHunks folded a run.
export function textDiffView(diff, { context = CONTEXT, label = 'Changed lines' } = {}) {
  const pre = h('pre', { class: 'textdiff', tabindex: '0', 'aria-label': label });
  for (const r of diffHunks(diff ? diff.rows : [], context)) {
    if (r.kind === 'skip') {
      pre.append(h('span', { class: 'skip' }, `… ${plural(r.count, 'unchanged line')}`));
      continue;
    }
    pre.append(h('span', { class: r.kind },
      h('span', { class: 'ln', 'aria-hidden': 'true' }, h('span', {}, String(r.oldNo ?? '')), h('span', {}, String(r.newNo ?? ''))),
      `${SIGN[r.kind]}${r.text}`));
  }
  return pre;
}
