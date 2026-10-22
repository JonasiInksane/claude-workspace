// A stand-in for claude.exe in tests: replays a recorded stream-json fixture to stdout.
//
//   node fake-claude.mjs --fixture <name> [fake options] <claude flags ...>
//
// claudeCommand in tests is [process.execPath, <this file>, '--fixture', '<name>', ...], and the
// stage's real claude flags follow. Fake options:
//   --fixture <name>          test/fixtures/stream/<name>.jsonl; "auto" picks success-<schema>
//                             from the --json-schema flag (plan.v1 -> success-plan)
//   --fixture-dir <dir>       look for fixtures in another folder
//   --resume-fixture <name>   replayed instead when the claude flags include --resume
//   --structured-file <file>  JSON that replaces the structured output (StructuredOutput tool
//                             calls and successful results), for any schema a test needs
//   --writes-file <file>      JSON {"relative/path": "text"} written into the cwd before the first
//                             result, standing in for an edit stage's changes
//   --delay-ms <n>            pause between lines (default 5)
// It reads stdin to the end first and reports stdinBytes, stdinHead (200 characters), fakeArgv
// and fakeEnvNames in the init event, so tests can prove the prompt came on stdin and not in argv,
// and that the environment was scrubbed. With -n it first prints session_title_changed, as the
// real claude does.
// The init is rewritten to match the claude flags: session_id (--session-id or --resume), cwd,
// model (an alias becomes claude-<alias>-5-5), permissionMode (manual shows as "default"), tools
// (sorted, plus StructuredOutput with --json-schema), mcp_servers ([] with --strict-mcp-config)
// and additional_directories (--add-dir). A fixture keeps recorded values with
// "_fake": {"keep": ["model", ...]} on its init line; that is how the mismatch fixtures work.
// The fixture's recorded cwd is replaced by the real cwd in every string, so tool paths land in
// the test's tree. Lines {"_fake": {...}} are instructions, never printed:
//   {"_fake": {"sleepMs": 200}}                     pause
//   {"_fake": {"stderr": "text"}}                   write to stderr
//   {"_fake": {"exit": 1}}                          exit code (default: 1 when the last result is
//                                                   an error or there is none, else 0)
//   {"_fake": {"hang": true, "spawnChild": true}}   run until killed; spawnChild first starts a node
//                                                   grandchild and prints "fake-claude child pid <n>"
// <name>.stderr.txt next to a fixture is written to stderr before anything else.
//
// Fixtures (test/fixtures/stream/): recorded with Claude Code 2.1.307 in the S6 spike, then
// redacted (user folder C:\Users\user, the canary value "<placeholder>", synthetic rate-limit
// numbers). Recorded: init-default, init-manual-read, init-acceptedits-sonnet,
// init-restricted-mcp, init-restricted-strict-notools, success-structured, missing-structured,
// max-turns, budget-stop, cancelled-partial, denials-read-rules, denials-bash-check,
// bash-read-bypass, denials-hook, denials-edit-protected, denials-outside-dirs, resume,
// stream-json-input, no-verbose. Built from recorded lines with small edits: success-plan,
// success-{answer,findings,tests,change,diagnosis,triage,spec}, init-mismatch-model,
// init-mcp-tools, hang, denials, usage-limit, login-needed, bg-results.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMAS, SCHEMA_NAMES } from '../runs/schemas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_FLAGS = new Set(['--fixture', '--fixture-dir', '--resume-fixture', '--structured-file', '--writes-file', '--delay-ms']);
const VALUE_FLAGS = new Set(['--output-format', '--session-id', '-n', '--permission-mode', '--permission-prompts', '--tools',
  '--settings', '--max-turns', '--max-budget-usd', '--json-schema', '--append-system-prompt', '--model', '--effort', '--add-dir',
  '--resume', '--input-format']);
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => {
  process.stderr.write(`fake-claude: ${msg}\n`);
  process.exit(2);
};

export function parseArgs(argv) {
  const fake = {};
  const flags = { addDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FAKE_FLAGS.has(a)) { fake[a.slice(2)] = argv[++i]; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (a === '--add-dir') flags.addDirs.push(v);
      else flags[a.replace(/^-+/, '')] = v;
      continue;
    }
    flags[a.replace(/^-+/, '')] = true;
  }
  return { fake, flags };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

function loadFixture(dir, name) {
  if (!NAME_RE.test(String(name || ''))) fail(`"${name}" is not a fixture name`);
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) fail(`no fixture ${file}`);
  const lines = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
  const errFile = join(dir, `${name}.stderr.txt`);
  return { lines, stderr: existsSync(errFile) ? readFileSync(errFile, 'utf8') : '' };
}

// --fixture auto: the success fixture of the schema passed with --json-schema (plan.v1 ->
// success-plan ...), so one claudeCommand serves every stage of a pipeline in end-to-end tests.
export function autoFixture(schemaJson) {
  let schema = null;
  try { schema = JSON.parse(String(schemaJson || '')); } catch { /* reported below */ }
  const text = JSON.stringify(schema);
  const match = schema && SCHEMA_NAMES.find(n => JSON.stringify(SCHEMAS[n]) === text);
  return match ? `success-${match.split('.')[0]}` : '';
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function deepStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => deepStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepStrings(x, fn)]));
  return v;
}

function modelFor(m) {
  const s = String(m || '');
  if (!s) return undefined;
  return s.startsWith('claude-') ? s : `claude-${s.replace(/\[[^\]]*\]$/, '')}-5-5`;
}

// The init event as the flags would make it, keeping the fields the fixture asks to keep.
export function rewriteInit(init, flags, extra) {
  const keep = new Set((init._fake && init._fake.keep) || []);
  const out = { ...init };
  delete out._fake;
  const set = (k, v) => { if (!keep.has(k) && v !== undefined) out[k] = v; };
  set('session_id', flags['session-id'] || (typeof flags.resume === 'string' ? flags.resume : undefined));
  set('cwd', process.cwd());
  set('original_cwd', process.cwd());
  set('model', modelFor(flags.model));
  if (typeof flags['permission-mode'] === 'string') set('permissionMode', flags['permission-mode'] === 'manual' ? 'default' : flags['permission-mode']);
  if (typeof flags.tools === 'string') {
    const tools = flags.tools.split(',').map(t => t.trim()).filter(Boolean);
    if (flags['json-schema']) tools.push('StructuredOutput');
    set('tools', tools.sort());
  }
  if (flags['strict-mcp-config']) set('mcp_servers', []);
  set('additional_directories', flags.addDirs.map(d => resolve(d)));
  return { ...out, ...extra };
}

function writeFiles(map) {
  for (const [rel, text] of Object.entries(map || {})) {
    const target = resolve(process.cwd(), rel);
    const r = relative(process.cwd(), target);
    if (!r || r.startsWith('..') || isAbsolute(r) || isAbsolute(rel)) fail(`--writes-file path "${rel}" leaves the working folder`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(text));
  }
}

function emit(obj) {
  return new Promise(r => process.stdout.write(JSON.stringify(obj) + '\n', r));
}

async function main() {
  const { fake, flags } = parseArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const dir = fake['fixture-dir'] ? resolve(fake['fixture-dir']) : join(HERE, 'fixtures', 'stream');
  let name = flags.resume && fake['resume-fixture'] ? fake['resume-fixture'] : fake.fixture;
  if (!name) fail('--fixture is required');
  if (name === 'auto') name = autoFixture(flags['json-schema']) || fail('--fixture auto needs --json-schema with one of the pipeline schemas');
  const { lines, stderr } = loadFixture(dir, name);
  if (stderr) process.stderr.write(stderr);
  const structured = fake['structured-file'] ? JSON.parse(readFileSync(fake['structured-file'], 'utf8')) : undefined;
  const writes = fake['writes-file'] ? JSON.parse(readFileSync(fake['writes-file'], 'utf8')) : null;
  const delay = fake['delay-ms'] === undefined ? 5 : Number(fake['delay-ms']);
  const init = lines.find(l => l.type === 'system' && l.subtype === 'init');
  const recordedCwd = init && typeof init.cwd === 'string' ? normalize(init.cwd) : '';
  const cwdRe = recordedCwd ? new RegExp(escapeRe(recordedCwd), 'gi') : null;
  const cwdReSlash = recordedCwd ? new RegExp(escapeRe(recordedCwd.replace(/\\/g, '/')), 'gi') : null;
  const fixPaths = s => (cwdRe ? s.replace(cwdRe, process.cwd()).replace(cwdReSlash, process.cwd().replace(/\\/g, '/')) : s);
  const sid = flags['session-id'] || (typeof flags.resume === 'string' ? flags.resume : '');
  const extra = {
    stdinBytes: stdin.length, stdinHead: stdin.toString('utf8').slice(0, 200), fakeArgv: process.argv.slice(2),
    fakeEnvNames: Object.keys(process.env).sort(),
  };
  let exitCode = null;
  let lastResult = null;
  let wrote = false;

  // Real claude announces the -n title before init (spike E11), so tests never see init first.
  const hasTitle = lines.some(l => l.type === 'system' && l.subtype === 'session_title_changed');
  if (typeof flags.n === 'string' && !hasTitle && init) {
    await emit({ type: 'system', subtype: 'session_title_changed', title: flags.n, session_id: sid || init.session_id });
  }

  for (const raw of lines) {
    if (raw._fake && raw.type === undefined) {
      const f = raw._fake;
      if (f.sleepMs) await sleep(Number(f.sleepMs));
      if (f.stderr) process.stderr.write(String(f.stderr));
      if (f.exit !== undefined) exitCode = Number(f.exit);
      if (f.hang) {
        if (f.spawnChild) {
          const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
          process.stderr.write(`fake-claude child pid ${kid.pid}\n`);
        }
        setInterval(() => {}, 60000);
        return;
      }
      continue;
    }
    let ev = deepStrings(raw, fixPaths);
    const isInit = ev.type === 'system' && ev.subtype === 'init';
    if (isInit) ev = rewriteInit({ ...ev, _fake: raw._fake }, flags, extra);
    delete ev._fake;
    if (sid && typeof ev.session_id === 'string' && !isInit) ev.session_id = sid;
    if (structured !== undefined) ev = applyStructured(ev, structured);
    if (ev.type === 'result') {
      if (writes && !wrote) { writeFiles(writes); wrote = true; }
      lastResult = ev;
    }
    await emit(ev);
    if (delay > 0) await sleep(delay);
  }
  if (exitCode === null) exitCode = !lastResult || lastResult.is_error ? 1 : 0;
  process.exitCode = exitCode;
}

function applyStructured(ev, payload) {
  if (ev.type === 'result' && ev.subtype === 'success' && !ev.is_error) {
    return { ...ev, structured_output: payload, result: JSON.stringify(payload) };
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const content = ev.message.content.map(b => (b && b.type === 'tool_use' && b.name === 'StructuredOutput' ? { ...b, input: payload } : b));
    return { ...ev, message: { ...ev.message, content } };
  }
  return ev;
}

// Run as a program (not imported by a test); real paths, so a hub behind a junction works too.
const realOrSelf = p => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const self = realOrSelf(fileURLToPath(import.meta.url)).toLowerCase();
if (process.argv[1] && realOrSelf(resolve(process.argv[1])).toLowerCase() === self) {
  main().catch(e => fail(e && e.stack ? e.stack : String(e)));
}
