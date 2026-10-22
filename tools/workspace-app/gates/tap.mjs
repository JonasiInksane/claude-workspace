// TAP parser for `node --test --test-reporter=tap` output, so a check knows which tests failed,
// in which file, and why, with ids that stay the same from run to run.
//
// Two shapes reach it (SPEC A16, checked against real output on Node 24.11.1):
// - Node 20: every test file is a top-level subtest named by its absolute path, with that file's
//   tests one level deeper.
// - Node 24: no file wrapper. Failing tests carry a YAML `location` ('<file>:<line>:<col>');
//   passing tests carry none. A file that can't load is one top-level test named by its relative
//   path (location '<file>:1:1'), and its error text sits in `#` comment lines just before it.
//
// File identity, in this order: a top-level subtest whose name is one of `files` (or its own
// location file); otherwise a `location` in the subtree that is one of `files`; otherwise, when
// only one file ran, that file; otherwise '(unknown)' with a parse warning, so the runner falls
// back to one file per invocation. Without `files`, any location is taken as is.
//
// Test identity: testId(file, path) = '<posix path relative to cwd>::<names joined by " > ">'.
// A file-level failure uses the name '(file)'. Repeated names in one file get ' (2)', ' (3)'.
// That numbering needs every earlier test of the file, so a placed test whose names repeat an
// earlier '(unknown)' test (in Node 24 that may be a passing sibling from the same file) is
// '(unknown)' too: its number could differ from a one-file run, and a rerun must not mistake it
// for another test.
// Only real results become tests: leaves, plus parents that failed on their own (a broken hook,
// code after subtests). A parent failing only because a subtest failed is not counted twice.
// A file with no tests reports one passing result named by its path; that adds no test.
//
// failure.kind: assertion (ERR_ASSERTION or AssertionError in test code), timeout, hook, crash
// (a file that failed with no passing test, or whose error text names ERR_MODULE_NOT_FOUND,
// ERR_UNKNOWN_FILE_EXTENSION or SyntaxError; inside a test only the two module codes, because
// JSON.parse in a test reports name 'SyntaxError' too), or other. A file-level failure takes its
// message from the error line Node printed just before it (the file's stderr), when there is one.
//
// Messages, expected and actual values are redacted (gates/secrets.mjs when present) and capped
// at 2 KB.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNKNOWN_FILE = '(unknown)';
export const FILE_TEST = '(file)';
export const MESSAGE_CAP = 2048;

const RESULT_RE = /^(not ok|ok)\b\s*(\d+)?\s*(?:-\s?)?(.*)$/;
const SUMMARY_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)\s*$/;
const DIRECTIVE_RE = /^(skip|todo)\S*\s*(.*)$/i;
const JS_FILE_RE = /\.[cm]?[jt]sx?$/i;
const CRASH_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION']);
const CRASH_TEXT_RE = /\b(?:ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError)\b/;
const ERROR_LINE_RE = /^(?:[A-Z][A-Za-z]*)?Error\b.*:/;
const UNFINISHED = 'The output ended before this test finished.';

// Secret redaction comes from gates/secrets.mjs (WP5). While that file is missing, a local copy of
// the spec's secret patterns stands in, so a message never leaves the parser unredacted.
const FALLBACK_PATTERNS = [
  /\b(?:sk|rk|pk)_live_[0-9A-Za-z]{10,}/g, /\bwhsec_[0-9A-Za-z]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g, /_authToken\s*=\s*\S+/g,
  /\bsntr[ysu]_[A-Za-z0-9+/=_-]{20,}/g, /\b(?:live|test)_[A-Za-z0-9]{30,}\b/g, /\bxkeysib-[a-f0-9]{32,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, /\bsk-ant-[A-Za-z0-9_-]{20,}/g, /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g,
];
function fallbackRedact(text, { allow = [] } = {}) {
  let out = String(text);
  for (const re of FALLBACK_PATTERNS) {
    out = out.replace(re, m => (allow.includes(m) ? m : `${m.slice(0, 4)}…[redacted ${m.length - 4}]`));
  }
  return out;
}
let defaultRedact = fallbackRedact;
try {
  const mod = await import('./secrets.mjs');
  if (typeof mod.redact === 'function') defaultRedact = mod.redact;
} catch (err) {
  if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

// Redacts, then caps at `cap` characters. Used for every message the parser keeps; baseline.mjs
// uses it for error identities.
export function cleanMessage(text, { redact = defaultRedact, allow = [], cap = MESSAGE_CAP } = {}) {
  if (text === undefined || text === null) return '';
  const s = redact(typeof text === 'string' ? text : JSON.stringify(text), { allow });
  return s.length > cap ? `${s.slice(0, cap)}… (cut at ${cap} characters)` : s;
}

export function testId(file, path) {
  const names = Array.isArray(path) ? path : [path];
  return `${String(file).replace(/\\/g, '/')}::${names.join(' > ')}`;
}

// ---- paths ----------------------------------------------------------------------------------

const caseKey = p => (process.platform === 'win32' ? p.toLowerCase() : p);

function absPath(p, cwd) {
  let s = String(p);
  if (/^file:\/\//i.test(s)) {
    try { s = fileURLToPath(s); } catch { /* keep as written */ }
  }
  return resolve(cwd, s);
}

function relPosix(abs, cwd) {
  return (relative(cwd, abs) || '.').split(sep).join('/');
}

// The caller's file list, keyed for matching (absolute; case-insensitive on Windows).
function fileTable(files, cwd) {
  const byKey = new Map();
  for (const f of files || []) {
    const abs = absPath(f, cwd);
    if (!byKey.has(caseKey(abs))) byKey.set(caseKey(abs), relPosix(abs, cwd));
  }
  return byKey;
}

function parseLocation(value, cwd) {
  const m = /^(.*):(\d+):(\d+)$/.exec(String(value || ''));
  if (!m) return null;
  return { abs: absPath(m[1], cwd), line: Number(m[2]), column: Number(m[3]) };
}

// ---- TAP text -------------------------------------------------------------------------------

// Node escapes '\' and '#' in names and comments; other escapes (\n, \t) stay as written.
const unescapeTap = s => s.replace(/\\([\\#])/g, '$1');

// Splits "name # SKIP reason" at the first '#' that isn't escaped.
function splitDirective(rest) {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\') { i++; continue; }
    if (rest[i] === '#') {
      const m = DIRECTIVE_RE.exec(rest.slice(i + 1).trim());
      const directive = m ? { kind: m[1].toLowerCase(), reason: m[2].trim() } : null;
      return { name: unescapeTap(rest.slice(0, i).trimEnd()), directive };
    }
  }
  return { name: unescapeTap(rest.trimEnd()), directive: null };
}

const indentOf = line => line.length - line.trimStart().length;

// The tree of results: each node is {name, ok (true, false, or null when unfinished), directive,
// yaml, children, level, line}. Top-level nodes also get `output`, the comment lines printed
// since the previous top-level result (Node prints a test file's stderr there).
function readTree(text) {
  const lines = String(text).replace(/^﻿/, '').split('\n');
  const pending = [];   // pending[L]: finished results at level L waiting for their parent
  const started = [];   // started[L]: the '# Subtest:' name at level L still open
  const parseErrors = [];
  const summary = {};
  let output = [];
  let yaml = null;
  let last = null;
  let plan = null;
  let sawTap = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    if (yaml) {
      if (raw.trim() === '...' && indentOf(raw) === yaml.indent) {
        yaml.node.yaml = parseYaml(yaml.lines);
        yaml = null;
      } else {
        yaml.lines.push(raw.slice(Math.min(yaml.indent, indentOf(raw))));
      }
      continue;
    }
    const ind = indentOf(raw);
    const t = raw.slice(ind);
    if (!t) continue;
    if (t === '---' && last && ind === last.level * 4 + 2) {
      yaml = { node: last, indent: ind, lines: [], line: i + 1 };
      continue;
    }
    if (/^TAP version \d+/.test(t)) { sawTap = true; continue; }
    const level = Math.floor(ind / 4);
    const m = RESULT_RE.exec(t);
    if (m) {
      sawTap = true;
      if (ind % 4) parseErrors.push({ line: i + 1, message: `Line ${i + 1} is indented by ${ind} spaces, not a multiple of 4.` });
      const { name, directive } = splitDirective(m[3] || '');
      const node = { name, ok: m[1] === 'ok', directive, yaml: {}, children: pending[level + 1] || [], level, line: i + 1 };
      pending.length = level + 1;
      (pending[level] = pending[level] || []).push(node);
      started.length = level;
      if (level === 0) { node.output = output; output = []; }
      last = node;
      continue;
    }
    if (t.startsWith('# Subtest:')) {
      sawTap = true;
      started[level] = unescapeTap(t.slice('# Subtest:'.length).trim());
      continue;
    }
    if (/^1\.\.\d+/.test(t)) {
      if (level === 0) plan = Number(/^1\.\.(\d+)/.exec(t)[1]);
      continue;
    }
    if (/^Bail out!/i.test(t)) {
      parseErrors.push({ line: i + 1, message: `The test run bailed out: ${t.slice(9).trim() || 'no reason given'}.` });
      continue;
    }
    const s = ind === 0 ? SUMMARY_RE.exec(t) : null;
    if (s) { summary[s[1] === 'duration_ms' ? 'durationMs' : s[1]] = Number(s[2]); continue; }
    output.push(t.startsWith('#') ? unescapeTap(t.slice(1).trim()) : t);
  }

  if (yaml) {
    yaml.node.yaml = parseYaml(yaml.lines);
    parseErrors.push({ line: yaml.line, message: `The output ended inside the YAML block that starts on line ${yaml.line}.` });
  }
  closeUnfinished(pending, started, parseErrors, output);
  const roots = pending[0] || [];
  if (!sawTap) parseErrors.push({ line: null, message: 'There is no TAP output.' });
  else if (!Object.keys(summary).length) {
    parseErrors.push({ line: null, message: 'There is no summary at the end (# tests, # pass); the run may have stopped early.' });
  }
  if (plan !== null && plan !== roots.length) {
    parseErrors.push({ line: null, message: `The TAP plan says ${plan} top-level tests but ${roots.length} were reported.` });
  }
  return { roots, summary: Object.keys(summary).length ? summary : null, parseErrors };
}

// Tests that started but never reported (a killed or crashed run). Their finished subtests are
// kept under them, so those ids don't change; a leaf that never finished counts as failed.
function closeUnfinished(pending, started, parseErrors, output) {
  for (let level = started.length - 1; level >= 0; level--) {
    if (started[level] === undefined) continue;
    const node = { name: started[level], ok: null, directive: null, yaml: {}, children: pending[level + 1] || [], level, line: null };
    pending.length = level + 1;
    (pending[level] = pending[level] || []).push(node);
    if (level === 0) node.output = output;
    parseErrors.push({ line: null, message: `The output ended before "${started[level]}" finished.` });
  }
  for (let level = pending.length - 1; level >= 1; level--) {
    if (!pending[level] || !pending[level].length) continue;
    parseErrors.push({ line: null, message: `${pending[level].length} results at nesting level ${level} had no parent test.` });
    (pending[0] = pending[0] || []).push(...pending[level]);
    pending[level] = [];
  }
}

// ---- YAML blocks ----------------------------------------------------------------------------

// The YAML Node writes: one key per line; values are inspect()-quoted strings, numbers, ~, block
// scalars (|-) or nested maps (kept as raw text). Lines arrive with the block's indent removed.
function parseYaml(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_$][\w$]*):(?:\s(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const value = (m[2] || '').trim();
    const block = [];
    while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s/.test(lines[i + 1]))) block.push(lines[++i]);
    if (/^[|>][-+]?\d*$/.test(value)) out[m[1]] = blockText(block, value[0] === '>');
    else if (!value) out[m[1]] = block.length ? blockText(block, false) : null;
    else out[m[1]] = scalar(value);
  }
  return out;
}

function blockText(block, folded) {
  const indents = block.filter(l => l.trim()).map(indentOf);
  const cut = indents.length ? Math.min(...indents) : 0;
  const lines = block.map(l => (l.trim() ? l.slice(cut) : ''));
  return (folded ? lines.join(' ') : lines.join('\n')).replace(/\s+$/, '');
}

function scalar(v) {
  if (v === '~' || v === 'null') return null;
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)) return Number(v);
  const q = v[0];
  if ((q === "'" || q === '"' || q === '`') && v.length >= 2 && v[v.length - 1] === q) return unquote(v.slice(1, -1), q);
  return v;
}

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

// Undoes util.inspect() string quoting ('it\'s', "a\nb", '\x1B', 'é'); a YAML-style '' in a
// single-quoted string is one quote.
function unquote(body, q) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q === "'" && c === "'" && body[i + 1] === "'") { out += "'"; i++; continue; }
    if (c !== '\\' || i === body.length - 1) { out += c; continue; }
    const n = body[++i];
    const hex = (from, len) => body.slice(from, from + len);
    if (SIMPLE_ESCAPES[n] !== undefined) out += SIMPLE_ESCAPES[n];
    else if (n === 'x' && /^[0-9a-f]{2}$/i.test(hex(i + 1, 2))) { out += String.fromCharCode(parseInt(hex(i + 1, 2), 16)); i += 2; }
    else if (n === 'u' && body[i + 1] === '{' && body.indexOf('}', i) > i) {
      const end = body.indexOf('}', i);
      const cp = parseInt(body.slice(i + 2, end), 16);
      out += Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : body.slice(i - 1, end + 1);
      i = end;
    } else if (n === 'u' && /^[0-9a-f]{4}$/i.test(hex(i + 1, 4))) { out += String.fromCharCode(parseInt(hex(i + 1, 4), 16)); i += 4; }
    else out += n;
  }
  return out;
}

// ---- from the tree to tests -----------------------------------------------------------------

function ownFailure(node) {
  return node.ok === false && !node.directive && node.yaml.failureType !== 'subtestsFailed';
}

// The file a top-level node stands for, when it is a file wrapper (Node 20) or a file-level
// failure (Node 24); null otherwise.
function fileNodeOf(node, ctx) {
  const abs = absPath(node.name, ctx.cwd);
  const listed = ctx.files.get(caseKey(abs));
  if (listed) return listed;
  const loc = parseLocation(node.yaml.location, ctx.cwd);
  if (loc && caseKey(loc.abs) === caseKey(abs)) return relPosix(abs, ctx.cwd);
  if (!ctx.files.size && isAbsolute(node.name) && JS_FILE_RE.test(node.name)) return relPosix(abs, ctx.cwd);
  return null;
}

function locationsIn(node, cwd, out = []) {
  const loc = parseLocation(node.yaml.location, cwd);
  if (loc) out.push(loc.abs);
  for (const c of node.children) locationsIn(c, cwd, out);
  return out;
}

// The file of a top-level test that isn't a file node.
function fileOfTop(node, ctx) {
  const locs = locationsIn(node, ctx.cwd);
  if (ctx.files.size) {
    for (const abs of locs) {
      const listed = ctx.files.get(caseKey(abs));
      if (listed) return listed;
    }
    return ctx.files.size === 1 ? [...ctx.files.values()][0] : UNKNOWN_FILE;
  }
  return locs.length ? relPosix(locs[0], ctx.cwd) : UNKNOWN_FILE;
}

function statusOf(node) {
  if (node.directive) return node.directive.kind;
  if (node.ok === true) return 'pass';
  return 'fail';
}

// A leaf test always counts; a childless suite only when it failed or was skipped (describe.skip
// reports no children); a parent only when it failed on its own, not merely because a subtest
// failed.
function counts(node) {
  if (node.children.length) return ownFailure(node);
  if (node.yaml.type === 'suite') return node.ok === false || Boolean(node.directive);
  return true;
}

// Collects the results under `node` (children first, in TAP order) into ctx.raw.
function collect(node, parentPath, file, ctx) {
  const path = [...parentPath, node.name];
  for (const c of node.children) collect(c, path, file, ctx);
  if (!counts(node)) return;
  ctx.raw.push({ node, file, path, type: node.yaml.type === 'suite' ? 'suite' : 'test', fileLevel: false });
}

function failureKind(y, { fileLevel, filePasses, output }) {
  const ft = y.failureType || '';
  const text = [y.code, y.error, ...(output || [])].filter(Boolean).join('\n');
  if (fileLevel) return !filePasses || CRASH_TEXT_RE.test(text) ? 'crash' : 'other';
  if (ft === 'testTimeoutFailure') return 'timeout';
  if (ft === 'hookFailed' || ft === 'hookFailure') return 'hook';
  if (CRASH_CODES.has(y.code)) return 'crash';
  if ((y.code === 'ERR_ASSERTION' || y.name === 'AssertionError') && (!ft || ft === 'testCodeFailure')) return 'assertion';
  return 'other';
}

// An expected or actual value as text; YAML ~ is the value null.
const valueText = (v, ctx) => (v === null ? 'null' : cleanMessage(v, ctx.clean));

function failureOf(r, ctx, filePasses) {
  const y = r.node.yaml;
  if (r.node.ok === null) {
    return { kind: 'crash', failureType: 'unfinished', code: '', message: UNFINISHED, location: '' };
  }
  const output = r.fileLevel ? r.node.output : null;
  const kind = failureKind(y, { fileLevel: r.fileLevel, filePasses, output });
  let message = y.error;
  if (r.fileLevel) message = (output || []).find(l => ERROR_LINE_RE.test(l)) || message;
  const loc = parseLocation(y.location, ctx.cwd);
  const failure = {
    kind,
    failureType: y.failureType || '',
    code: y.code || '',
    message: cleanMessage(message || (r.fileLevel ? 'The test file failed.' : 'The test failed.'), ctx.clean),
    location: loc ? `${relPosix(loc.abs, ctx.cwd)}:${loc.line}:${loc.column}` : '',
  };
  if (y.name) failure.errorName = y.name;
  if (y.expected !== undefined) failure.expected = valueText(y.expected, ctx);
  if (y.actual !== undefined) failure.actual = valueText(y.actual, ctx);
  return failure;
}

const zeroCounts = () => ({ pass: 0, fail: 0, skip: 0, todo: 0 });

// Parses TAP text. Options: `files` (the files this invocation ran, relative to cwd or absolute),
// `cwd` (the command's working folder), and optionally `redact` and `allow` for messages.
// Returns {tests, files, counts, summary, parseErrors, unknownFileTests}:
// - tests: [{id, file, path, name, status: pass|fail|skip|todo, type: test|suite|file, durationMs,
//   reason?, dup?, failure?: {kind, failureType, code, message, location, errorName?, expected?,
//   actual?}}]
// - files: [{file, counts, durationMs, crashed}] in order of appearance
// - counts: {pass, fail, skip, todo} over `tests` (summary holds Node's own totals, or null)
export function parseTap(text, { files = [], cwd = process.cwd(), redact, allow } = {}) {
  const ctx = {
    cwd: resolve(cwd),
    files: fileTable(files, resolve(cwd)),
    clean: { redact: redact || defaultRedact, allow: allow || [] },
    raw: [],
    unsure: 0,
  };
  const { roots, summary, parseErrors } = readTree(text);
  const wrapperMs = new Map();
  for (const root of roots) {
    const file = fileNodeOf(root, ctx);
    if (file) {
      for (const c of root.children) collect(c, [], file, ctx);
      if (typeof root.yaml.duration_ms === 'number') wrapperMs.set(file, root.yaml.duration_ms);
      if (ownFailure(root) || (root.ok === null && !root.children.length)) {
        ctx.raw.push({ node: root, file, path: [FILE_TEST], type: 'file', fileLevel: true });
      }
    } else {
      collect(root, [], fileOfTop(root, ctx), ctx);
    }
  }
  const tests = buildTests(ctx);
  const unknownFileTests = tests.filter(t => t.file === UNKNOWN_FILE).length;
  const lost = unknownFileTests - ctx.unsure;
  if (lost) {
    parseErrors.push({
      line: null,
      message: `${lost} test${lost === 1 ? ' has' : 's have'} no file in the TAP output (Node 24 prints a location only for failures); run one file per invocation to identify ${lost === 1 ? 'it' : 'them'}.`,
    });
  }
  if (ctx.unsure) {
    const one = ctx.unsure === 1;
    parseErrors.push({
      line: null,
      message: `${ctx.unsure} test${one ? ' has' : 's have'} the name of an earlier test with no file in the TAP output, so ${one ? 'its' : 'their'} repeat number may differ from a one-file run; ${one ? 'it counts' : 'they count'} as having no file too, so run one file per invocation for a stable id.`,
    });
  }
  return { tests, files: fileSummaries(tests, roots, ctx, wrapperMs), counts: countOf(tests), summary, parseErrors, unknownFileTests };
}

// Moves to UNKNOWN_FILE every placed test whose names repeat an earlier unplaced test (in TAP
// order). In a one-file run that earlier test may sit in the same file and take the plain id,
// so this test's number isn't known. Tests whose repeats all come later keep their place: later
// tests never change an earlier test's number. Returns how many tests moved.
function unplaceUnsure(raw) {
  const unplaced = new Set();
  let moved = 0;
  for (const r of raw) {
    const names = JSON.stringify(r.path);
    if (r.file === UNKNOWN_FILE) unplaced.add(names);
    else if (!r.fileLevel && unplaced.has(names)) {
      r.file = UNKNOWN_FILE;
      moved++;
    }
  }
  return moved;
}

function buildTests(ctx) {
  const passes = new Map();
  for (const r of ctx.raw) {
    if (!r.fileLevel && r.node.ok === true && !r.node.directive) passes.set(r.file, (passes.get(r.file) || 0) + 1);
  }
  ctx.unsure = unplaceUnsure(ctx.raw);
  const seen = new Map();
  return ctx.raw.map(r => {
    const base = testId(r.file, r.path);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const t = {
      id: n === 1 ? base : `${base} (${n})`,
      file: r.file,
      path: r.path,
      name: r.path[r.path.length - 1],
      status: r.fileLevel ? 'fail' : statusOf(r.node),
      type: r.type,
      durationMs: typeof r.node.yaml.duration_ms === 'number' ? r.node.yaml.duration_ms : null,
    };
    if (n > 1) t.dup = n;
    if (r.node.directive && r.node.directive.reason) t.reason = r.node.directive.reason;
    if (t.status === 'fail') t.failure = failureOf(r, ctx, passes.get(r.file) || 0);
    return t;
  });
}

function countOf(tests) {
  const c = zeroCounts();
  for (const t of tests) c[t.status]++;
  return c;
}

function fileSummaries(tests, roots, ctx, wrapperMs) {
  const byFile = new Map();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, { file: t.file, counts: zeroCounts(), durationMs: 0, crashed: false });
    const f = byFile.get(t.file);
    f.counts[t.status]++;
    if (t.type === 'file' && t.failure && t.failure.kind === 'crash') f.crashed = true;
  }
  for (const root of roots) {
    const file = fileNodeOf(root, ctx) || fileOfTop(root, ctx);
    const f = byFile.get(file);
    if (f && !wrapperMs.has(file) && typeof root.yaml.duration_ms === 'number') f.durationMs += root.yaml.duration_ms;
  }
  for (const [file, ms] of wrapperMs) if (byFile.has(file)) byFile.get(file).durationMs = ms;
  for (const f of byFile.values()) f.durationMs = Math.round(f.durationMs * 1000) / 1000;
  return [...byFile.values()];
}
