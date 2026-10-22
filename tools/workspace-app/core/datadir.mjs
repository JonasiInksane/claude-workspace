// The private data folder (%LOCALAPPDATA%\claude-workspace, the app's `dataDir`) and safe ways to
// read and write it.
//
// The folder holds per-PC settings, project profiles, runs, baselines, findings, metrics and
// reports. None of it is versioned, and some of it is private (the hub repo is public), so it never
// lives in the hub. Nothing creates the folder up front: every write here creates the folders it
// needs on first use.
//
// Writes are atomic: JSON goes to `<file>.<pid>.<random>.tmp` first and is then renamed over the
// real file, so a reader never sees half a file. Windows can refuse that rename for a moment while
// a virus scanner or the indexer holds the file open (EPERM, EBUSY, EACCES), so the rename is
// retried with a growing pause (50, 100, 200, 400, 800 ms).
//
// JSONL files (one JSON object per line) are append-only logs. A crash can leave a torn last line;
// readers skip malformed lines, and the next append starts on a fresh line so a torn line never
// swallows a good one.
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// A project name: lowercase words joined by single hyphens ("example", "my-app").
export const PROJECT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A name used as a file name inside a project folder (a baseline key, a scan id, a report slug).
const FILE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKOFF_MS = [50, 100, 200, 400, 800];

// %LOCALAPPDATA%\claude-workspace, or ~/AppData/Local/claude-workspace when the variable is unset.
export function defaultDataDir(env = process.env) {
  return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-workspace');
}

function checkProject(project) {
  if (!PROJECT_RE.test(String(project ?? ''))) {
    throw new Error(`"${project}" is not a project name. Use lowercase letters, digits and single hyphens.`);
  }
  return project;
}

function checkKey(key, what) {
  const k = String(key ?? '');
  if (!FILE_KEY_RE.test(k) || k.includes('..')) throw new Error(`"${key}" is not a valid ${what}.`);
  return k;
}

// Every path of one project in the data folder (SPEC 2.2). Plain strings, except the few that
// need a name (a baseline key, a scan id), which are functions that check the name first.
export function projectPaths(dataDir, project) {
  checkProject(project);
  const d = resolve(dataDir);
  const p = project;
  return {
    dataDir: d,
    settings: join(d, 'settings.json'),
    sessions: join(d, 'sessions.jsonl'),
    profilesDir: join(d, 'profiles'),
    profile: join(d, 'profiles', `${p}.json`),
    allowlist: join(d, 'profiles', `${p}.allowlist.json`),
    runsRoot: join(d, 'runs'),
    runsIndex: join(d, 'runs', 'index.jsonl'),
    lock: join(d, 'runs', `${p}.lock`),
    runs: join(d, 'runs', p),
    baselines: join(d, 'baselines', p),
    baseline: key => join(d, 'baselines', p, `${checkKey(key, 'baseline key')}.json`),
    candidate: key => join(d, 'baselines', p, `${checkKey(key, 'baseline key')}.candidate.json`),
    checks: join(d, 'checks', p),
    checksHistory: join(d, 'checks', p, 'history.jsonl'),
    findings: join(d, 'findings', `${p}.json`),
    findingsImport: join(d, 'findings', `${p}.import.json`),
    metrics: join(d, 'metrics', `${p}.json`),
    metricsDetailsDir: join(d, 'metrics', p),
    metricsDetails: scanId => join(d, 'metrics', p, `${checkKey(scanId, 'scan id')}.details.json`),
    wins: join(d, 'wins', `${p}.jsonl`),
    reports: join(d, 'reports', p),
    reportsIndex: join(d, 'reports', 'index.json'),
    worktree: join(d, 'worktrees', `${p}.json`),
    worktreeLog: join(d, 'worktrees', `${p}-setup.log`),
  };
}

function jsonText(data) {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined) throw new Error('There is nothing to write: the value is not JSON.');
  return `${text}\n`;
}

const tmpName = file => `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Writes JSON (pretty, with a final newline) through a temporary file and a rename.
// `fs` and `sleep` can be replaced in tests; `retries` is how many times a refused rename is tried
// again.
export async function writeJsonAtomic(file, data, { retries = 5, fs: io = fsp, sleep: pause = sleep } = {}) {
  const text = jsonText(data);
  await io.mkdir(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await io.writeFile(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(tmp, file);
      return file;
    } catch (err) {
      if (!RETRY_CODES.has(err && err.code) || attempt >= retries) {
        await io.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await pause(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
}

// A blocking pause for the sync writer (Atomics.wait is allowed on Node's main thread).
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The same as writeJsonAtomic, for callers that can't await (startup, small settings writes).
export function writeJsonAtomicSync(file, data, { retries = 5, fs: io = fs, sleep: pause = sleepSync } = {}) {
  const text = jsonText(data);
  io.mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  io.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      io.renameSync(tmp, file);
      return file;
    } catch (err) {
      if (!RETRY_CODES.has(err && err.code) || attempt >= retries) {
        try { io.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      pause(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
}

// The code on the error for a file that isn't valid JSON, so a caller can tell it from a read
// error such as EBUSY (which keeps the fs code).
export const JSON_PARSE_CODE = 'EJSONPARSE';

function parseJsonText(file, text) {
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    const e = new Error(`${file} is not valid JSON: ${err.message}`);
    e.code = JSON_PARSE_CODE;
    throw e;
  }
}

// Reads a JSON file. A missing file gives `fallback`; a broken one throws
// "<file> is not valid JSON: ..." with code EJSONPARSE; other read errors are rethrown as they
// are. A byte order mark (Notepad, PowerShell 5.1) is ignored.
export async function readJson(file, fallback = null) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  return parseJsonText(file, text);
}

// The sync twin of readJson, for the few callers that run at startup.
export function readJsonSync(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  return parseJsonText(file, text);
}

// True when the file exists, isn't empty and doesn't end with a newline (a torn last line).
async function endsMidLine(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (!size) return false;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

// Appends one object as one line. If the file ends mid-line (a torn write), the new line starts
// on a fresh line, so only the torn line is lost.
export async function appendJsonl(file, obj) {
  const line = JSON.stringify(obj);
  if (line === undefined) throw new Error('There is nothing to append: the value is not JSON.');
  await fsp.mkdir(dirname(file), { recursive: true });
  const lead = (await endsMidLine(file)) ? '\n' : '';
  await fsp.appendFile(file, `${lead}${line}\n`);
}

// Reads JSONL rows. `from` is a 0-based line index; `next` is where the following read should
// start, so a poller can call readJsonl(file, { from: next }) again.
// - Malformed complete lines are skipped and counted in `bad`.
// - A malformed last line without a newline may be a write still in progress: it is not counted
//   and `next` stays on it, so a later read picks it up once it is complete.
// - Blank lines are skipped silently.
export async function readJsonl(file, { from = 0, limit = Infinity } = {}) {
  const start = Number.isInteger(from) && from > 0 ? from : 0;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { rows: [], next: start, bad: 0 };
    throw err;
  }
  const lines = text.replace(/^﻿/, '').split('\n');
  const terminated = text.endsWith('\n');
  // With a final newline, split() leaves one empty string after it; that isn't a line.
  const count = terminated ? lines.length - 1 : lines.length;
  const rows = [];
  let bad = 0;
  let i = start;
  for (; i < count && rows.length < limit; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      if (i === count - 1 && !terminated) break;
      bad++;
    }
  }
  return { rows, next: i, bad };
}

// The SHA-256 of a file's bytes, as 64 lowercase hex characters (streamed, so big files are fine).
export function sha256File(file) {
  return new Promise((resolveP, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolveP(hash.digest('hex')));
  });
}

// The SHA-256 of a string or Buffer, as hex.
export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(v => (v === undefined || typeof v === 'function' ? null : sortKeys(v)));
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return sortKeys(value.toJSON()); // Date, Buffer
    // No prototype, so an own "__proto__" key (JSON.parse makes one) is kept as a key instead of
    // setting the prototype; otherwise different data could get the same hash.
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined || typeof value[k] === 'function') continue;
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}

// JSON with object keys sorted at every level and no whitespace, so equal data always gives the
// same text (and the same hash). Arrays keep their order.
export function canonicalJson(obj) {
  return JSON.stringify(sortKeys(obj));
}

// "sha256:<hex>" of canonicalJson(obj): the hash format run.json, baselines and findings use.
export function jsonHash(obj) {
  return `sha256:${sha256Text(canonicalJson(obj))}`;
}
