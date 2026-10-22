// The diff of one changed file and the row of file chips above it (SPEC 5.7 "Changes", mockup
// .filechips and pre.diff). GET /api/run-diff answers one file's part of the run's unified diff
// as plain text; parseDiff() splits it into typed lines and diffView() shows them as one text
// span per line with an add, del, hunk or meta class. Nothing from the diff is ever parsed as
// HTML: every line is a text node, and the +/- at its start says what the colour shows.
//
// parseDiff and the small helpers above the DOM section are pure, so Node tests can import this
// module (parts/diff.test.mjs); lib.js touches the DOM only when its functions run.
import { h, plural } from '../lib.js';

// How many lines diffView shows before it offers "Show all" (a 2 MB diff is about 40 000 lines).
export const SHOW_LINES = 3000;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// One file's unified diff -> { lines: [{ kind, text, oldNo, newNo }], hunks, add, del, isNew,
// isDeleted, binary, renamedFrom }. kind is 'meta' (the header lines: diff --git, index, ---,
// +++, modes, renames, "Binary files ... differ"), 'hunk' (@@ lines), 'add', 'del', 'ctx', or
// 'note' ("\ No newline at end of file"). oldNo/newNo are the line numbers in the old and new
// file (null where a side has no line). A trailing carriage return is dropped from each line.
export function parseDiff(text) {
  const out = { lines: [], hunks: 0, add: 0, del: 0, isNew: false, isDeleted: false, binary: false, renamedFrom: '' };
  const raw = String(text || '').split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line0 of raw) {
    const line = line0.endsWith('\r') ? line0.slice(0, -1) : line0;
    const m = HUNK_RE.exec(line);
    if (m) {
      inHunk = true;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      out.hunks++;
      out.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('diff --git ')) inHunk = false;
    if (!inHunk) {
      if (/^new file mode/.test(line)) out.isNew = true;
      else if (/^deleted file mode/.test(line)) out.isDeleted = true;
      else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') out.binary = true;
      else if (line.startsWith('rename from ')) out.renamedFrom = line.slice(12);
      out.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      continue;
    }
    const c = line[0];
    if (c === '+') { out.add++; out.lines.push({ kind: 'add', text: line, oldNo: null, newNo: newNo++ }); }
    else if (c === '-') { out.del++; out.lines.push({ kind: 'del', text: line, oldNo: oldNo++, newNo: null }); }
    else if (c === '\\') out.lines.push({ kind: 'note', text: line, oldNo: null, newNo: null });
    else out.lines.push({ kind: 'ctx', text: line, oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

// The index of the line that shows new-file line `n` (an added or context line), or -1. A
// finding's path:line uses the new file's numbering.
export function lineIndex(parsed, n) {
  const want = Number(n);
  if (!parsed || !Number.isInteger(want) || want < 1) return -1;
  return parsed.lines.findIndex(l => l.newNo === want);
}

// "apps/web/src/a.ts" -> "a.ts" (the chip's short name; the full path is its title and the
// heading above the diff).
export const baseName = path => String(path || '').split('/').pop() || String(path || '');

// The words for a parsed file: "New file · 2 hunks · +48 −0".
export function diffSummary(parsed) {
  if (!parsed) return '';
  const kind = parsed.binary ? 'Binary file' : parsed.isNew ? 'New file' : parsed.isDeleted ? 'Deleted file' : parsed.renamedFrom ? `Renamed from ${parsed.renamedFrom}` : '';
  return [kind, parsed.hunks ? plural(parsed.hunks, 'hunk') : '', `+${parsed.add} −${parsed.del}`].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- DOM

// fileChips(files, { selected, onSelect }) -> the role=group row of toggle buttons.
// files: [{ path, add, del, tags: [text], flag: text }] where `tags` are shown as text on the
// chip (risk tags, "Pin", "Allowed by you") and `flag`, when set, gives the chip a red border
// and says why in screen-reader text (the visible tags say it too).
export function fileChips(files, { selected = '', onSelect = () => {}, label = 'Changed files' } = {}) {
  return h('div', { class: 'filechips', role: 'group', 'aria-label': label },
    files.map(f => h('button', {
      type: 'button', class: f.flag ? 'filechip flag' : 'filechip', title: f.path,
      'aria-pressed': f.path === selected ? 'true' : 'false', dataset: { key: `file:${f.path}` },
      on: { click: () => onSelect(f.path) },
    },
    h('span', { class: 'fname' }, baseName(f.path)),
    h('span', { class: 'plus' }, `+${Number(f.add) || 0}`),
    Number(f.del) ? h('span', { class: 'minus' }, `−${Number(f.del)}`) : null,
    (f.tags || []).map(t => h('span', { class: 'ftag' }, t)),
    f.flag ? h('span', { class: 'sr-only' }, ` (${f.flag})`) : null)));
}

// diffView(parsed, { path, all, mark }) -> the <pre class="diff"> with one span per line. Long
// diffs stop at SHOW_LINES unless `all` (isCut() tells the caller to offer "Show all lines"
// outside the pre). `mark` is the index of a line to highlight (a finding's line), or -1.
export function diffView(parsed, { path = '', all = false, mark = -1 } = {}) {
  const lines = parsed ? parsed.lines : [];
  const shown = all ? lines : lines.slice(0, SHOW_LINES);
  const pre = h('pre', { class: 'diff', tabindex: '0', 'aria-label': path ? `Diff of ${path}` : 'Diff of the selected file' });
  const spans = shown.map((l, i) => {
    const cls = [l.kind === 'ctx' ? '' : l.kind, i === mark ? 'mark' : ''].filter(Boolean).join(' ');
    return h('span', { class: cls || null }, l.text === '' ? ' ' : l.text);
  });
  if (!lines.length) spans.push(h('span', { class: 'meta' }, 'No changes in this file.'));
  pre.append(...spans);
  return pre;
}

// True when diffView(parsed) leaves lines out.
export const isCut = (parsed, all = false) => !all && !!parsed && parsed.lines.length > SHOW_LINES;
