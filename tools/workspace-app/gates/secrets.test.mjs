// Tests for gates/secrets.mjs: each pattern, the assignment heuristic, allowValues, redaction
// length and private key blocks, and the diff scan (added lines only, line numbers, secret-shaped
// file names). Every key is built at runtime from pieces, so this file holds no literal secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entropy, findSecrets, isSecretFileName, PATTERNS, redact, redactDeep, scanDiff, scanText, walkDiff } from './secrets.mjs';

const j = (...parts) => parts.join('');
// One runtime-built sample per pattern.
const SAMPLES = {
  stripe: j('sk', '_live_', 'x'.repeat(24)),
  'stripe-webhook': j('whsec', '_', 'Ab1'.repeat(7)),
  aws: j('AKIA', 'ABCDEFGHIJKLMNOP'),
  'private-key': j('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'),
  npm: j('//registry.example.org/:', '_auth', 'Token=', 'n'.repeat(30)),
  sentry: j('sntr', 'ys_', 'S'.repeat(30)),
  mollie: j('live', '_', 'm'.repeat(32)),
  brevo: j('xkeysib', '-', 'a1'.repeat(16)),
  openai: j('sk', '-proj-', 'O'.repeat(24)),
  anthropic: j('sk', '-ant-', 'api03-', 'A'.repeat(24)),
  google: j('AIza', 'G'.repeat(35)),
  github: j('gh', 'p_', 'H'.repeat(36)),
  jwt: j('eyJ', 'h'.repeat(12), '.', 'eyJ', 'p'.repeat(12), '.', 's'.repeat(12)),
};
// 32 distinct characters: exactly 5 bits per character.
const HIGH_ENTROPY = j('abcdefghijklmnop', 'qrstuvwxyzABCDEF');

test('every named pattern has a runtime sample, and each sample is found under its own name', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(PATTERNS).sort());
  for (const [name, sample] of Object.entries(SAMPLES)) {
    const found = scanText(`const x = "${sample}";`);
    assert.equal(found.length, 1, `${name}: ${JSON.stringify(found)}`);
    assert.equal(found[0].pattern, name);
    assert.equal(found[0].line, 1);
  }
});

test('stripe also covers restricted and publishable live keys, but not test keys', () => {
  assert.equal(scanText(j('rk', '_live_', 'r'.repeat(12)))[0].pattern, 'stripe');
  assert.equal(scanText(j('pk', '_live_', 'p'.repeat(12)))[0].pattern, 'stripe');
  assert.deepEqual(scanText(j('sk', '_test_', 't'.repeat(40))), []);
  assert.deepEqual(scanText(j('sk', '_live_', 'short')), []);
});

test('npm: a literal token matches, an environment placeholder does not', () => {
  assert.equal(scanText(j('//registry.npmjs.org/:', '_auth', 'Token = ', 'abc123'.repeat(6)))[0]?.pattern, 'npm');
  assert.deepEqual(scanText(j('//registry.npmjs.org/:', '_auth', 'Token=', '${NPM_TOKEN}')), []);
});

test('redacting a diff hides the key and keeps every line of the diff', () => {
  const key = SAMPLES.stripe;
  const diff = ['@@ -1 +1,2 @@', ' const a = 1;', `+const k = "${key}";`, ''].join('\n');
  const out = redact(diff);
  assert.ok(!out.includes(key));
  assert.equal(out.split('\n').length, diff.split('\n').length);
  assert.equal(out.split('\n')[2], `+const k = "${key.slice(0, 4)}…[redacted ${key.length - 4}]";`);
});

test('sentry covers organisation and user tokens and the short prefixes', () => {
  for (const prefix of ['sntrys_', 'sntryu_', 'sntry_', 'sntru_']) {
    assert.equal(scanText(j(prefix.slice(0, 4), prefix.slice(4), 'T'.repeat(24)))[0]?.pattern, 'sentry', prefix);
  }
});

test('an Anthropic key is reported once, not also as an OpenAI key', () => {
  const found = findSecrets(`a ${SAMPLES.anthropic} b`);
  assert.deepEqual(found.map(f => f.pattern), ['anthropic']);
});

test('the other private key headers match, and line numbers are 1-based', () => {
  for (const kind of ['', 'EC ', 'OPENSSH ', 'DSA ']) {
    const header = j('-----BEGIN ', kind, 'PRIVATE KEY-----');
    assert.deepEqual(scanText(`first\nsecond\n${header}\n`).map(f => [f.pattern, f.line]), [['private-key', 3]]);
  }
});

test('assignment heuristic: a long high-entropy value under a secret-looking name', () => {
  assert.ok(entropy(HIGH_ENTROPY) >= 3.5);
  assert.equal(entropy('aaaa'), 0);
  assert.equal(Math.round(entropy(HIGH_ENTROPY)), 5);
  for (const line of [
    `const apiKey = '${HIGH_ENTROPY}';`,
    `client_secret: "${HIGH_ENTROPY}"`,
    `"accessToken": "${HIGH_ENTROPY}"`,
    `PASSWORD="${HIGH_ENTROPY}"`,
  ]) {
    const found = scanText(line);
    assert.deepEqual(found.map(f => f.pattern), ['assignment'], line);
  }
  // Low entropy, too short, or not a secret-looking name: nothing.
  assert.deepEqual(scanText(`token = "${'a'.repeat(30)}"`), []);
  assert.deepEqual(scanText(`token = "${HIGH_ENTROPY.slice(0, 12)}"`), []);
  assert.deepEqual(scanText(`label = "${HIGH_ENTROPY}"`), []);
});

test('allowValues: an allowed value is never reported or redacted; short entries only match exactly', () => {
  const allowed = j('sk', '_live_', 'allowedharness');
  assert.deepEqual(scanText(`KEY=${allowed}`, { allow: [allowed] }), []);
  assert.equal(redact(`KEY=${allowed}`, { allow: [allowed] }), `KEY=${allowed}`);
  // npm's pattern matches "_authToken=<value>"; an allowed value inside it covers the match.
  const npm = j('_auth', 'Token=', allowed);
  assert.deepEqual(scanText(npm, { allow: [allowed] }), []);
  // A one-character allow entry can't switch the scan off.
  assert.equal(scanText(SAMPLES.stripe, { allow: ['x'] }).length, 1);
  // An allowed assignment value.
  assert.deepEqual(scanText(`token: "${HIGH_ENTROPY}"`, { allow: [HIGH_ENTROPY] }), []);
});

test('redact keeps 4 characters and says how many were hidden', () => {
  const key = SAMPLES.stripe;
  const out = redact(`key ${key} end`);
  assert.equal(out, `key ${key.slice(0, 4)}…[redacted ${key.length - 4}] end`);
  assert.ok(!out.includes(key));
  // Two secrets on one line, of different kinds.
  const two = redact(`${SAMPLES.aws} and ${SAMPLES.github}`);
  assert.equal(two, `AKIA…[redacted 16] and ${SAMPLES.github.slice(0, 4)}…[redacted ${SAMPLES.github.length - 4}]`);
  // The assignment heuristic hides the value, not the name.
  const assigned = redact(`apiKey = '${HIGH_ENTROPY}'`);
  assert.equal(assigned, `apiKey = '${HIGH_ENTROPY.slice(0, 4)}…[redacted ${HIGH_ENTROPY.length - 4}]'`);
  // Text without secrets, and non-strings, come back unchanged.
  assert.equal(redact('nothing here'), 'nothing here');
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(''), '');
});

const BEGIN_KEY = j('-----BEGIN ', 'PRIVATE KEY-----');
const END_KEY = j('-----END ', 'PRIVATE KEY-----');
const KEY_LINE = n => j('MIIB', String.fromCharCode(97 + n).repeat(60));

test('redact hides a private key block line by line, and keeps every line', () => {
  const body = KEY_LINE(0);
  const out = redact(`before\n${BEGIN_KEY}\n${body}\n${END_KEY}\nafter`);
  assert.equal(out, `before\n----…[redacted ${BEGIN_KEY.length - 4}]\n…[redacted ${body.length}]\n…[redacted ${END_KEY.length}]\nafter`);
  assert.ok(!out.includes(body));
  // A one-line block (an escaped PEM string in code) is hidden up to its END header.
  const inline = redact(`const pem = "${BEGIN_KEY}\\n${body}\\n${END_KEY}";`);
  assert.ok(!inline.includes(body));
  assert.ok(inline.startsWith('const pem = "----…[redacted ') && inline.endsWith(']";'));
});

test('redact without an END header: the block stops at the next diff section, or after 100 lines', () => {
  const body = KEY_LINE(1);
  const open = redact(`x ${BEGIN_KEY}\n${body}\nmore`);
  assert.ok(!open.includes(body) && !open.includes('more'));
  assert.ok(open.startsWith('x ----…[redacted '));
  assert.equal(open.split('\n').length, 3);
  // A BEGIN line in a README hides the rest of its diff section only, not the next file.
  const diff = ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1,3 @@', ' # Keys',
    `+${BEGIN_KEY}`, `+${body}`, 'diff --git a/src/a.mjs b/src/a.mjs', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const red = redact(diff).split('\n');
  assert.equal(red.length, diff.split('\n').length);
  assert.equal(red[6], `+…[redacted ${body.length}]`);
  assert.deepEqual(red.slice(7), diff.split('\n').slice(7));
  // A text with no diff headers stops after the cap.
  const long = redact([BEGIN_KEY, ...Array.from({ length: 150 }, (_, i) => `line ${i}`)].join('\n')).split('\n');
  assert.equal(long.length, 151);
  assert.equal(long[100], '…[redacted 7]');
  assert.equal(long[101], 'line 100');
});

test('redacting a multi-line key in a diff keeps the line count and each diff marker, so hunks still parse', () => {
  const lines = [KEY_LINE(2), KEY_LINE(3), KEY_LINE(4)];
  const diff = [
    'diff --git a/certs/k.pem b/certs/k.pem', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/certs/k.pem',
    '@@ -0,0 +1,5 @@', `+${BEGIN_KEY}`, ...lines.map(l => `+${l}`), `+${END_KEY}`,
    'diff --git a/src/a.mjs b/src/a.mjs', 'index 2222222..3333333 100644', '--- a/src/a.mjs', '+++ b/src/a.mjs',
    '@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '',
  ].join('\r\n');
  const out = redact(diff);
  assert.equal(out.split('\n').length, diff.split('\n').length);
  for (const l of lines) assert.ok(!out.includes(l));
  const rows = out.split('\r\n');
  assert.equal(rows[6], `+----…[redacted ${BEGIN_KEY.length - 4}]`);
  assert.equal(rows[7], `+…[redacted ${lines[0].length}]`);
  assert.equal(rows[10], `+…[redacted ${END_KEY.length}]`);
  // A hunk-counting reader still finds the second file and its added line.
  const files = [], added = [];
  walkDiff(out, { onFile: f => files.push(f.path), onAdded: (f, n, text) => added.push([f.path, n, text]) });
  assert.deepEqual(files, ['certs/k.pem', 'src/a.mjs']);
  assert.deepEqual(added.filter(a => a[0] === 'src/a.mjs'), [['src/a.mjs', 2, 'const b = 3;']]);
  assert.equal(added.filter(a => a[0] === 'certs/k.pem').length, 5);
});

test('redactDeep redacts every string in an object', () => {
  const out = redactDeep({ a: SAMPLES.aws, b: [1, { c: `x ${SAMPLES.jwt}` }], d: true, e: null });
  assert.equal(out.a, 'AKIA…[redacted 16]');
  assert.ok(!JSON.stringify(out).includes(SAMPLES.jwt));
  assert.equal(out.b[0], 1);
  assert.equal(out.d, true);
  assert.equal(out.e, null);
});

test('scanText previews are redacted and capped', () => {
  const [hit] = scanText(`   const k = "${SAMPLES.google}"; ${'z'.repeat(400)}`);
  assert.ok(!hit.preview.includes(SAMPLES.google));
  assert.ok(hit.preview.startsWith('const k = "AIza…[redacted 35]"'));
  assert.ok(hit.preview.length <= 161);
});

test('isSecretFileName: .env* at any depth, .npmrc and .sentryclirc, ignoring case', () => {
  for (const p of ['.env', 'apps/web/.env.local', 'a\\b\\.ENV.production', '.npmrc', 'x/.sentryclirc', '.Npmrc']) assert.ok(isSecretFileName(p), p);
  for (const p of ['env.ts', 'docs/envoy.md', 'npmrc', 'src/environment.mjs', 'a/b.env.mjs']) assert.ok(!isSecretFileName(p), p);
});

const key = SAMPLES.stripe;
const DIFF = [
  'diff --git a/src/a.mjs b/src/a.mjs',
  'index 1111111..2222222 100644',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -10,4 +10,5 @@ export function f() {',
  ' const ok = 1;',
  `-const old = "${SAMPLES.aws}";`,
  `+const fresh = "${key}";`,
  '+++not a header, an added line that starts with ++',
  ' return ok;',
  ` // a context line that mentions ${SAMPLES.github}`,
  'diff --git a/apps/web/.env.local b/apps/web/.env.local',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/apps/web/.env.local',
  '@@ -0,0 +1 @@',
  '+PLAIN=1',
  'diff --git a/.env b/.env',
  'deleted file mode 100644',
  '--- a/.env',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-GONE=1',
  'diff --git a/config/x.txt b/config/.npmrc',
  'similarity index 100%',
  'rename from config/x.txt',
  'rename to config/.npmrc',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+line one',
  `+jwt ${SAMPLES.jwt}`,
  '',
].join('\n');

test('scanDiff scans added lines only, with new-file line numbers', () => {
  const found = scanDiff(DIFF);
  const hits = found.filter(f => f.pattern !== 'secret-file').map(f => [f.pattern, f.path, f.line]);
  assert.deepEqual(hits, [['jwt', 'new.txt', 2], ['stripe', 'src/a.mjs', 11]]);
  for (const f of found) assert.ok(!f.preview.includes(key) && !f.preview.includes(SAMPLES.jwt));
});

test('scanDiff flags added and renamed secret-shaped files, not deleted ones', () => {
  const files = scanDiff(DIFF).filter(f => f.pattern === 'secret-file').map(f => [f.path, f.line]);
  assert.deepEqual(files, [['apps/web/.env.local', 0], ['config/.npmrc', 0]]);
});

test('scanDiff reads untracked-file sections (git diff --no-index) and CRLF diffs', () => {
  const diff = [
    'diff --git a/tmp/notes.md b/tmp/notes.md',
    'new file mode 100644',
    'index 0000000..4444444',
    '--- /dev/null',
    '+++ b/tmp/notes.md',
    '@@ -0,0 +1,3 @@',
    '+one',
    '+two',
    `+three ${SAMPLES.sentry}`,
  ].join('\r\n');
  assert.deepEqual(scanDiff(diff).map(f => [f.pattern, f.path, f.line]), [['sentry', 'tmp/notes.md', 3]]);
});

test('walkDiff handles hunks without counts and quoted paths', () => {
  const seen = [];
  walkDiff([
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -3 +3 @@',
    '-a',
    '+b',
  ].join('\n'), { onAdded: (f, line, text) => seen.push([f.path, line, text]) });
  assert.deepEqual(seen, [['café.txt', 3, 'b']]);
});

test('scanDiff of an empty diff finds nothing', () => {
  assert.deepEqual(scanDiff(''), []);
  assert.deepEqual(scanDiff(undefined), []);
});
