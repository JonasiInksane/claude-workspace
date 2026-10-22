// Secret scan and redaction: the G0 secrets row, and the filter for everything the page shows.
//
// A change can carry a key that Claude copied from a log, a test printed, or a config file held.
// G0 fails a change whose added lines contain one (`scanDiff`), and every text the app shows or
// saves (diffs, timeline rows, result text, report text, check logs) goes through `redact` first,
// so a key never reaches the page, a report or the hub.
//
// - PATTERNS: named regexes for well-known key formats. They are matched in this order, and a
//   match that overlaps an earlier one on the same text is dropped (so an Anthropic key is not
//   also reported as an OpenAI key).
// - The `assignment` heuristic: a secret-looking name assigned a quoted value of 20 or more
//   characters whose Shannon entropy is at least 3.5 bits per character.
// - `allow`: literal values the profile says are fine (test-only keys, `secrets.allowValues`).
//   They are never reported and never redacted.
// - Redaction keeps the first 4 characters of a match and replaces the rest with
//   `…[redacted N]`, where N is the number of characters hidden. A private key block is hidden
//   from its BEGIN header to its END header line by line: every line break stays, and in a diff
//   each line keeps its leading +, - or space, so hunk line counts still add up. Without an END
//   header the block stops at the next diff section or hunk header, or after 100 lines.
//
// The tests build every key at runtime, so neither this file nor its test holds a literal secret.

export const PATTERNS = Object.freeze({
  stripe: /\b(?:sk|rk|pk)_live_[0-9A-Za-z]{10,}/,
  'stripe-webhook': /\bwhsec_[0-9A-Za-z]{16,}/,
  aws: /\bAKIA[0-9A-Z]{16}\b/,
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/,
  // "_authToken=${NPM_TOKEN}" reads the token from the environment, so it is not a secret.
  npm: /_authToken\s*=\s*(?!\$\{)\S+/,
  // Real Sentry tokens start sntrys_ (organisation) or sntryu_ (user); the spec's sntr[ysu]_
  // missed those, so one or two of y, s, u are accepted.
  sentry: /\bsntr[ysu]{1,2}_[A-Za-z0-9+/=_-]{20,}/,
  mollie: /\b(?:live|test)_[A-Za-z0-9]{30,}\b/,
  brevo: /\bxkeysib-[a-f0-9]{32,}/,
  // Before openai: every Anthropic key also matches the OpenAI pattern.
  anthropic: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  openai: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  google: /\bAIza[0-9A-Za-z_-]{35}\b/,
  github: /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  jwt: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/,
});

// The name, optionally more name characters and a closing quote (JSON keys), then : or =, then a
// quoted value. The value (group 1) is what gets reported and redacted, not the name.
export const ASSIGNMENT_RE = /(?:secret|token|password|passwd|api[_-]?key|client[_-]?secret)[\w-]*['"]?\s*[:=]\s*['"]([^'"\s]{20,})['"]/i;
export const MIN_ENTROPY = 3.5;
export const SECRET_FILE_PATTERN = 'secret-file';

const PRIVATE_KEY_BEGIN_RE = /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY)-----/;
// Where an unterminated key block ends at the latest: a new diff section or hunk, or this many lines.
const BLOCK_STOP_RE = /^(?:diff --git |@@ )/;
export const KEY_BLOCK_MAX_LINES = 100;
const DIFF_MARKERS = '+- \\';
const KEEP = 4;
const PREVIEW_MAX = 160;
const ALLOW_SUBSTRING_MIN = 8;

// Shannon entropy of a string, in bits per character.
export function entropy(text) {
  const s = String(text ?? '');
  if (!s.length) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function allowList(allow) {
  return (Array.isArray(allow) ? allow : []).map(v => String(v ?? '')).filter(Boolean);
}

// An allowed value covers a match when they are equal, or when the match contains it (for
// example `_authToken=<allowed>`). Short allowed values only count as exact matches, so an
// entry like "x" can't switch the scan off.
function isAllowed(value, allow) {
  return allow.some(a => value === a || (a.length >= ALLOW_SUBSTRING_MIN && value.includes(a)));
}

function globalCopy(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

// Every secret-shaped span in `text`: [{pattern, start, end, value}], sorted, never overlapping.
export function findSecrets(text, { allow } = {}) {
  const s = String(text ?? '');
  const allowed = allowList(allow);
  const spans = [];
  const overlaps = (start, end) => spans.some(x => start < x.end && end > x.start);
  for (const [name, re] of Object.entries(PATTERNS)) {
    for (const m of s.matchAll(globalCopy(re))) {
      const start = m.index, end = m.index + m[0].length;
      if (isAllowed(m[0], allowed) || overlaps(start, end)) continue;
      spans.push({ pattern: name, start, end, value: m[0] });
    }
  }
  for (const m of s.matchAll(globalCopy(ASSIGNMENT_RE))) {
    const value = m[1];
    const end = m.index + m[0].length - 1;             // the closing quote follows the value
    const start = end - value.length;
    if (entropy(value) < MIN_ENTROPY || isAllowed(value, allowed) || overlaps(start, end)) continue;
    spans.push({ pattern: 'assignment', start, end, value });
  }
  return spans.sort((a, b) => a.start - b.start);
}

function mask(value) {
  return `${value.slice(0, KEEP)}…[redacted ${Math.max(0, value.length - KEEP)}]`;
}

// A whole line of a key block, nothing kept (an empty line stays empty).
const maskAll = value => (value ? `…[redacted ${value.length}]` : '');

// Hides private key blocks line by line. `open` tracks a block whose END header has not been
// seen: {end, diff, left}. In a diff (the BEGIN line starts with a diff marker before the header)
// each later line keeps its first character, so the diff keeps its shape.
function hideKeyBlocks(text) {
  if (!text.includes('-----BEGIN ')) return text;
  const lines = text.split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    let rest = cr ? lines[i].slice(0, -1) : lines[i];
    let out = '';
    if (open && (open.left <= 0 || BLOCK_STOP_RE.test(rest))) open = null;
    if (open) {
      open.left--;
      const marker = open.diff && rest && DIFF_MARKERS.includes(rest[0]) ? rest[0] : '';
      const body = rest.slice(marker.length);
      const at = body.indexOf(open.end);
      if (at === -1) { lines[i] = marker + maskAll(body) + cr; continue; }
      out = marker + maskAll(body.slice(0, at + open.end.length));
      rest = body.slice(at + open.end.length);
      open = null;
    }
    // BEGIN headers on the rest of this line; a one-line block (an escaped PEM string) closes here.
    let m;
    while ((m = PRIVATE_KEY_BEGIN_RE.exec(rest))) {
      const end = `-----END ${m[1]}-----`;
      const at = rest.indexOf(end, m.index + m[0].length);
      if (at !== -1) {
        out += rest.slice(0, m.index) + mask(rest.slice(m.index, at + end.length));
        rest = rest.slice(at + end.length);
        continue;
      }
      const diff = !out && m.index > 0 && DIFF_MARKERS.includes(rest[0]);
      out += rest.slice(0, m.index) + mask(rest.slice(m.index));
      rest = '';
      open = { end, diff, left: KEY_BLOCK_MAX_LINES };
    }
    lines[i] = out + rest + cr;
  }
  return lines.join('\n');
}

// The text with every secret hidden, with the same number of lines. Non-strings come back
// unchanged.
export function redact(text, { allow } = {}) {
  if (typeof text !== 'string' || !text) return text;
  const blocks = hideKeyBlocks(text);
  const spans = findSecrets(blocks, { allow });
  if (!spans.length) return blocks;
  let out = '', at = 0;
  for (const sp of spans) {
    out += blocks.slice(at, sp.start) + mask(sp.value);
    at = sp.end;
  }
  return out + blocks.slice(at);
}

// redact() applied to every string inside an object or array (for result.json and outputs).
export function redactDeep(value, opts = {}) {
  if (typeof value === 'string') return redact(value, opts);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out;
  }
  return value;
}

function preview(line, allow) {
  const r = redact(line.trim(), { allow });
  return r.length > PREVIEW_MAX ? `${r.slice(0, PREVIEW_MAX)}…` : r;
}

// Secrets in a text, line by line: [{pattern, line (1-based), preview (redacted)}].
export function scanText(text, { allow } = {}) {
  const out = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    for (const sp of findSecrets(line, { allow })) out.push({ pattern: sp.pattern, line: i + 1, preview: preview(line, allow) });
  });
  return out;
}

// True for file names that hold secrets by convention: .env and .env.* at any depth, .npmrc,
// .sentryclirc.
export function isSecretFileName(path) {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return base.startsWith('.env') || base === '.npmrc' || base === '.sentryclirc';
}

// Git quotes unusual paths in diff headers: "a/x\303\251.ts". This undoes that.
function unquote(p) {
  const s = String(p ?? '').trim();
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = body[i + 1];
    if (/[0-7]/.test(next || '')) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p) {
  const s = unquote(p);
  return s === '/dev/null' ? null : s.replace(/^[ab]\//, '');
}

// Walks a unified diff (git diff output, including `--no-index` sections for untracked files).
// Calls onFile(file) once per file section and onAdded(file, lineNo, text) for each added line.
// Hunk line counts decide where content ends, so an added line that starts with "+++" is content.
export function walkDiff(diff, { onFile = () => {}, onAdded = () => {} } = {}) {
  const lines = String(diff ?? '').split('\n');
  let file = null, oldLeft = 0, newLeft = 0, newLine = 0;
  const finish = () => { if (file) onFile(file); };
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '+') { onAdded(file, newLine, line.slice(1)); newLine++; newLeft--; continue; }
      if (c === '-') { oldLeft--; continue; }
      if (c === ' ' || line === '') { newLine++; newLeft--; oldLeft--; continue; }
      if (c === '\\') continue;                       // "\ No newline at end of file"
      oldLeft = newLeft = 0;                          // malformed: fall through to headers
    }
    if (line.startsWith('diff --git ')) {
      finish();
      const m = line.match(/^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/);
      file = { path: m ? stripPrefix(m[2]) : null, oldPath: m ? stripPrefix(m[1]) : null, added: false, deleted: false, renamed: false, copied: false };
      continue;
    }
    // A plain unified diff (no "diff --git" lines): each "--- " after a hunk starts a new file.
    if (line.startsWith('--- ') && (!file || file.hunks)) {
      finish();
      file = { path: null, oldPath: null, added: false, deleted: false, renamed: false, copied: false };
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.added = true;
    else if (line.startsWith('deleted file mode')) file.deleted = true;
    else if (line.startsWith('rename to ')) { file.renamed = true; file.path = unquote(line.slice(10)); }
    else if (line.startsWith('rename from ')) file.oldPath = unquote(line.slice(12));
    else if (line.startsWith('copy to ')) { file.copied = true; file.path = unquote(line.slice(8)); }
    else if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
      if (p === null) file.added = true; else file.oldPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
      if (p === null) file.deleted = true; else file.path = p;
    } else {
      const h = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h) {
        file.hunks = (file.hunks || 0) + 1;
        oldLeft = h[1] === undefined ? 1 : Number(h[1]);
        newLine = Number(h[2]);
        newLeft = h[3] === undefined ? 1 : Number(h[3]);
      }
    }
  }
  finish();
}

// Secrets in the added lines of a diff: [{pattern, path, line, preview}]. An added, renamed or
// copied file with a secret-shaped name (.env*, .npmrc, .sentryclirc) is reported as
// `secret-file` with line 0, whatever its content.
export function scanDiff(diff, { allow } = {}) {
  const out = [];
  walkDiff(diff, {
    onAdded(file, line, text) {
      for (const sp of findSecrets(text, { allow })) {
        out.push({ pattern: sp.pattern, path: file?.path || file?.oldPath || '(unknown)', line, preview: preview(text, allow) });
      }
    },
    onFile(file) {
      const path = file.path || file.oldPath;
      if (!file.deleted && (file.added || file.renamed || file.copied) && isSecretFileName(path)) {
        out.push({ pattern: SECRET_FILE_PATTERN, path, line: 0, preview: 'a file with a secret-shaped name was added' });
      }
    },
  });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
