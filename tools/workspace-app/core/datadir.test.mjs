// Tests for core/datadir.mjs: data folder paths, atomic JSON writes with retries, JSON and JSONL
// reading (torn lines), file hashes and canonical JSON. Run: node tools/run-tests.mjs workspace-app
// Everything is written under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonl, canonicalJson, defaultDataDir, JSON_PARSE_CODE, jsonHash, PROJECT_RE, projectPaths, readJson, readJsonl, readJsonSync,
  RENAME_RETRIES, sha256File, sha256Text, writeJsonAtomic, writeJsonAtomicSync,
} from './datadir.mjs';
import { tempDir } from '../test/helpers.mjs';

const busy = code => Object.assign(new Error(`${code}: resource busy`), { code });

test('defaultDataDir uses LOCALAPPDATA, else ~/AppData/Local', () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: join('X:', 'Local') }), join('X:', 'Local', 'claude-workspace'));
  assert.equal(defaultDataDir({}), join(homedir(), 'AppData', 'Local', 'claude-workspace'));
});

test('projectPaths gives every SPEC 2.2 path and refuses bad project names', () => {
  const d = join('X:', 'data');
  const p = projectPaths(d, 'my-app');
  assert.equal(p.dataDir, join(d));
  assert.equal(p.settings, join(d, 'settings.json'));
  assert.equal(p.sessions, join(d, 'sessions.jsonl'));
  assert.equal(p.profile, join(d, 'profiles', 'my-app.json'));
  assert.equal(p.allowlist, join(d, 'profiles', 'my-app.allowlist.json'));
  assert.equal(p.runsIndex, join(d, 'runs', 'index.jsonl'));
  assert.equal(p.lock, join(d, 'runs', 'my-app.lock'));
  assert.equal(p.runs, join(d, 'runs', 'my-app'));
  assert.equal(p.baseline('0123456789ab-run-node24.11.1'), join(d, 'baselines', 'my-app', '0123456789ab-run-node24.11.1.json'));
  assert.equal(p.candidate('abc-run-node20.15.1'), join(d, 'baselines', 'my-app', 'abc-run-node20.15.1.candidate.json'));
  assert.equal(p.checksHistory, join(d, 'checks', 'my-app', 'history.jsonl'));
  assert.equal(p.findings, join(d, 'findings', 'my-app.json'));
  assert.equal(p.findingsImport, join(d, 'findings', 'my-app.import.json'));
  assert.equal(p.metrics, join(d, 'metrics', 'my-app.json'));
  assert.equal(p.metricsDetails('s-261022-100700'), join(d, 'metrics', 'my-app', 's-261022-100700.details.json'));
  assert.equal(p.wins, join(d, 'wins', 'my-app.jsonl'));
  assert.equal(p.reports, join(d, 'reports', 'my-app'));
  assert.equal(p.reportsIndex, join(d, 'reports', 'index.json'));
  assert.equal(p.worktree, join(d, 'worktrees', 'my-app.json'));
  assert.equal(p.worktreeLog, join(d, 'worktrees', 'my-app-setup.log'));
  for (const bad of ['', 'My-App', '../x', 'a--b', '-a', 'a-', 'a b', 'a/b', 'a\\b', null, undefined]) {
    assert.throws(() => projectPaths(d, bad), /is not a project name/, String(bad));
    assert.equal(PROJECT_RE.test(String(bad ?? '')), false);
  }
  for (const bad of ['../x', 'a/b', '', '..', 'x..y', '.hidden']) assert.throws(() => p.baseline(bad), /not a valid baseline key/);
  assert.throws(() => p.metricsDetails('..\\x'), /not a valid scan id/);
});

test('writeJsonAtomic writes pretty JSON with a final newline, creates folders, leaves no temp file', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'deep', 'er', 'x.json');
  await writeJsonAtomic(file, { b: 1, a: [1, 2] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  await writeJsonAtomic(file, { replaced: true });
  assert.deepEqual(await readJson(file), { replaced: true });
  assert.deepEqual(fs.readdirSync(join(dir, 'deep', 'er')), ['x.json']);
  await assert.rejects(writeJsonAtomic(join(dir, 'u.json'), undefined), /nothing to write/);
});

test('writeJsonAtomic retries a rename refused with EBUSY (50, then 100 ms) and then succeeds', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'x.json');
  let refusals = 2;
  const shim = { ...fsp, rename: async (a, b) => { if (refusals-- > 0) throw busy('EBUSY'); return fsp.rename(a, b); } };
  const waits = [];
  await writeJsonAtomic(file, { ok: 1 }, { fs: shim, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [50, 100]);
  assert.deepEqual(await readJson(file), { ok: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('writeJsonAtomic gives up after about 10 s of retries (50..800 ms, then 1 s each), removes the temp file and keeps the old file', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'x.json');
  await writeJsonAtomic(file, { old: true });
  const shim = { ...fsp, rename: async () => { throw busy('EPERM'); } };
  const waits = [];
  await assert.rejects(writeJsonAtomic(file, { new: true }, { fs: shim, sleep: async ms => { waits.push(ms); } }), { code: 'EPERM' });
  assert.deepEqual(waits, [50, 100, 200, 400, 800, ...Array(RENAME_RETRIES - 5).fill(1000)]);
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 10_000, 'long enough for a busy reader or a virus scanner');
  assert.deepEqual(await readJson(file), { old: true });
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('writeJsonAtomic does not retry other errors', async t => {
  const dir = tempDir('ws-datadir-', t);
  const shim = { ...fsp, rename: async () => { throw busy('EXDEV'); } };
  const waits = [];
  await assert.rejects(writeJsonAtomic(join(dir, 'x.json'), {}, { fs: shim, sleep: async ms => { waits.push(ms); } }), { code: 'EXDEV' });
  assert.deepEqual(waits, []);
});

test('writeJsonAtomicSync writes and retries EACCES the same way', t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'a', 's.json');
  let refusals = 1;
  const shim = { ...fs, renameSync: (a, b) => { if (refusals-- > 0) throw busy('EACCES'); return fs.renameSync(a, b); } };
  const waits = [];
  writeJsonAtomicSync(file, { s: 1 }, { fs: shim, sleep: ms => waits.push(ms) });
  assert.deepEqual(waits, [50]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "s": 1\n}\n');
  writeJsonAtomicSync(file, { s: 2 });
  assert.deepEqual(readJsonSync(file), { s: 2 });
});

test('readJson: missing gives the fallback, a BOM is fine, broken JSON names the file', async t => {
  const dir = tempDir('ws-datadir-', t);
  assert.equal(await readJson(join(dir, 'none.json')), null);
  assert.deepEqual(await readJson(join(dir, 'none.json'), { d: 1 }), { d: 1 });
  fs.writeFileSync(join(dir, 'bom.json'), '﻿{"a":1}');
  assert.deepEqual(await readJson(join(dir, 'bom.json')), { a: 1 });
  fs.writeFileSync(join(dir, 'bad.json'), '{"a":');
  await assert.rejects(readJson(join(dir, 'bad.json')), err => err.message.startsWith(`${join(dir, 'bad.json')} is not valid JSON: `));
  assert.throws(() => readJsonSync(join(dir, 'bad.json')), err => /is not valid JSON/.test(err.message) && err.code === JSON_PARSE_CODE);
  await assert.rejects(readJson(join(dir, 'bad.json')), err => err.code === 'EJSONPARSE', 'a parse error has its own code');
  await assert.rejects(readJson(dir), err => err.code === 'EISDIR' || err.code === 'EPERM' || err.code === 'EACCES');
});

test('appendJsonl and readJsonl: one object per line, paging with from/limit/next', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'runs', 'index.jsonl');
  assert.deepEqual(await readJsonl(file), { rows: [], next: 0, bad: 0 });
  for (let i = 1; i <= 5; i++) await appendJsonl(file, { i, text: 'line\nbreak' });
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 6);
  const all = await readJsonl(file);
  assert.deepEqual(all.rows.map(r => r.i), [1, 2, 3, 4, 5]);
  assert.equal(all.next, 5);
  const page = await readJsonl(file, { from: 1, limit: 2 });
  assert.deepEqual(page.rows.map(r => r.i), [2, 3]);
  assert.equal(page.next, 3);
  const rest = await readJsonl(file, { from: page.next });
  assert.deepEqual(rest.rows.map(r => r.i), [4, 5]);
  assert.deepEqual(await readJsonl(file, { from: 99 }), { rows: [], next: 99, bad: 0 });
  await assert.rejects(appendJsonl(file, undefined), /nothing to append/);
});

test('readJsonl skips malformed and blank lines and reads CRLF lines', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'x.jsonl');
  fs.writeFileSync(file, '{"a":1}\r\nnot json\n\n{"a":2}\n{"a":\n{"a":3}\n');
  const r = await readJsonl(file);
  assert.deepEqual(r.rows, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(r.bad, 2);
  assert.equal(r.next, 6);
});

test('a torn last line is left for later, and the next append starts on a fresh line', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'timeline.jsonl');
  fs.writeFileSync(file, '{"seq":1}\n{"seq":2}\n{"seq":3,"msg":"half');
  const first = await readJsonl(file);
  assert.deepEqual(first.rows, [{ seq: 1 }, { seq: 2 }]);
  assert.equal(first.bad, 0, 'an unterminated last line may still be being written');
  assert.equal(first.next, 2, 'next stays on the torn line');
  await appendJsonl(file, { seq: 4 });
  assert.match(fs.readFileSync(file, 'utf8'), /"half\n\{"seq":4\}\n$/);
  const second = await readJsonl(file, { from: first.next });
  assert.deepEqual(second.rows, [{ seq: 4 }]);
  assert.equal(second.bad, 1, 'now the torn line is complete and counted');
  // An unterminated line that is complete JSON is read.
  fs.writeFileSync(file, '{"seq":1}\n{"seq":2}');
  assert.deepEqual(await readJsonl(file), { rows: [{ seq: 1 }, { seq: 2 }], next: 2, bad: 0 });
});

test('sha256File and sha256Text give hex SHA-256', async t => {
  const dir = tempDir('ws-datadir-', t);
  const file = join(dir, 'big.bin');
  const data = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
  fs.writeFileSync(file, data);
  const want = createHash('sha256').update(data).digest('hex');
  assert.equal(await sha256File(file), want);
  assert.equal(sha256Text(data), want);
  assert.match(sha256Text('x'), /^[0-9a-f]{64}$/);
  await assert.rejects(sha256File(join(dir, 'none')), { code: 'ENOENT' });
});

test('canonicalJson sorts keys at every level and keeps array order', () => {
  const a = { b: 2, a: { d: [3, { z: 1, y: 2 }], c: 1 }, u: undefined };
  const b = { a: { c: 1, d: [3, { y: 2, z: 1 }] }, b: 2 };
  assert.equal(canonicalJson(a), '{"a":{"c":1,"d":[3,{"y":2,"z":1}]},"b":2}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ t: new Date(0) }), '{"t":"1970-01-01T00:00:00.000Z"}');
  assert.equal(canonicalJson([undefined]), '[null]');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(jsonHash(a), jsonHash(b));
  assert.match(jsonHash(a), /^sha256:[0-9a-f]{64}$/);
});

test('canonicalJson keeps an own __proto__ key, so different data never shares a hash', () => {
  const evil = JSON.parse('{"x":1,"__proto__":{"evil":1}}');
  assert.equal(canonicalJson(evil), '{"__proto__":{"evil":1},"x":1}');
  assert.notEqual(jsonHash(evil), jsonHash({ x: 1 }));
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
});
