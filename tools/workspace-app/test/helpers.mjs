// Shared helpers for the workspace app's tests: temporary folders and git repos, a fake profile
// built from the synthetic example, and TAP text like Node's test runner prints.
//
// Every package's tests use this file, so its API stays as SPEC section 3 (WP2) lists it:
//   tempDir(prefix), writeFiles(dir, files), makeRepo(dir, { files, commit }), commitAll(dir, msg),
//   fakeProfile(overrides), tapLines(tests), waitFor(fn, ms)
// plus three extras: removeTree(dir), runGit(dir, args) and exampleRepoFiles().
//
// Rules the helpers keep: everything is written under os.tmpdir(); git runs as an argument list
// with windowsHide; temporary repos set core.autocrlf=false, user.name=t, user.email=t@t (and
// commit.gpgsign=false so a global signing setup can't hang a test). Removing a temporary folder
// never follows a junction or symlink inside it, so a test that links a scratch target can't
// delete the target.
import { execFile } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { exampleProfile } from '../profile/profile.mjs';

const created = new Set();
let exitHook = false;

function unlinkLink(path) {
  try {
    rmdirSync(path); // a junction or directory symlink: removes the link only
  } catch {
    unlinkSync(path);
  }
}

function removeFile(path) {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    if (!err || err.code !== 'EPERM') throw err;
    chmodSync(path, 0o666); // git makes object files read-only
    rmSync(path, { force: true });
  }
}

// Deletes a folder tree. Links (junctions, symlinks) inside it are removed as links; their
// targets are never entered.
export function removeTree(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return unlinkLink(path);
  if (!st.isDirectory()) return removeFile(path);
  for (const name of readdirSync(path)) removeTree(join(path, name));
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

// A new empty folder under os.tmpdir(), as its real long path. Pass the test context `t` to remove
// it when the test ends; otherwise it is removed when the process exits. KEEP_TEMP=1 keeps them.
export function tempDir(prefix = 'ws-test-', t = null) {
  const safe = String(prefix || 'ws-test-').replace(/[^A-Za-z0-9._-]/g, '-');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), safe)));
  if (t && typeof t.after === 'function') {
    t.after(() => { if (!process.env.KEEP_TEMP) removeTree(dir); });
    return dir;
  }
  created.add(dir);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      if (process.env.KEEP_TEMP) return;
      for (const d of created) {
        try { removeTree(d); } catch { /* leave it for the OS */ }
      }
    });
  }
  return dir;
}

// Writes files under `dir`. Keys are posix relative paths; values are text, a Buffer, or an
// object (written as pretty JSON). Paths that leave `dir` throw. Returns `dir`.
export function writeFiles(dir, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    if (!rel || rel.includes('\\') || /^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`writeFiles: "${rel}" must be a posix path inside the folder.`);
    }
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    const data = Buffer.isBuffer(content) || typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(file, data);
  }
  return dir;
}

// Runs git in `dir` and returns its stdout with the final newline trimmed.
export function runGit(dir, args, { env } = {}) {
  return new Promise((resolveP, reject) => {
    execFile('git', ['-C', dir, ...args], {
      windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `git ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`;
        reject(err);
      } else resolveP(String(stdout).replace(/\r?\n$/, ''));
    });
  });
}

// Stages everything and commits (an empty commit is allowed). Returns the new HEAD SHA.
export async function commitAll(dir, msg = 'update') {
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-q', '--allow-empty', '-m', msg]);
  return runGit(dir, ['rev-parse', 'HEAD']);
}

// A new git repo in `dir` (created if needed) on branch `main`, with `files` committed.
// Returns the commit SHA.
export async function makeRepo(dir, { files = {}, commit = 'init', branch = 'main' } = {}) {
  mkdirSync(dir, { recursive: true });
  await runGit(dir, ['init', '-q', '-b', branch]);
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    await runGit(dir, ['config', k, v]);
  }
  writeFiles(dir, files);
  return commitAll(dir, commit);
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

// Objects merge key by key; arrays and other values replace; null removes the key; undefined is
// ignored.
function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete target[k];
    else if (isPlain(v) && isPlain(target[k])) mergeInto(target[k], v);
    else target[k] = isPlain(v) || Array.isArray(v) ? structuredClone(v) : v;
  }
  return target;
}

let example = null;

// A fresh copy of pipelines/app/profiles/example.json with `overrides` merged in, for example
// fakeProfile({ env: { preset: { EXAMPLE_CACHE_PORT: '6379' } }, mainCheckoutGuard: null }).
export function fakeProfile(overrides = {}) {
  if (!example) example = exampleProfile();
  return mergeInto(structuredClone(example), overrides || {});
}

// Files for a repo that matches the example profile: two workspaces with passing node:test files,
// money and tenant paths, a router, locales, package.json with the lint-staged key that equals
// format.glob, and .nvmrc equal to node.pin.
export function exampleRepoFiles() {
  const test = (name, imp, call, want) => [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    imp,
    '',
    `test('${name}', () => {`,
    `  assert.equal(${call}, ${want});`,
    '});',
    '',
  ].join('\n');
  return {
    'package.json': { name: 'example', private: true, workspaces: ['apps/*'], 'lint-staged': { '*.{mjs,md}': 'node -e 0' } },
    'package-lock.json': { name: 'example', lockfileVersion: 3, requires: true, packages: {} },
    '.nvmrc': 'v20.15.1\n',
    '.gitignore': '.env\nnode_modules/\n',
    'CLAUDE.md': '# Example\n\nA synthetic project for the workspace app tests.\n',
    'AGENTS.md': '# Agents\n\n## Review rules\n\n- Findings as [severity] path:line.\n',
    'docs/definition-of-done.md': '# Definition of done\n\n- Tests pass.\n',
    'docs/README.md': '# Records\n',
    'scripts/tool.mjs': 'export const double = n => n * 2;\n',
    'scripts/tool.test.mjs': test('double', "import { double } from './tool.mjs';", 'double(2)', 4),
    'apps/api/package.json': { name: 'api', private: true },
    'apps/api/schema.sql': 'create table item (id int primary key);\n',
    'apps/api/src/env.mjs': "export const testMode = process.env.EXAMPLE_TEST_MODE === 'true';\n",
    'apps/api/src/billing/charge.mjs': 'export const charge = cents => Math.round(cents * 1.21);\n',
    'apps/api/src/billing/charge.test.mjs': test('charge adds tax', "import { charge } from './charge.mjs';", 'charge(100)', 121),
    'apps/api/src/auth/session.mjs': 'export const isMember = (user, team) => user.teams.includes(team);\n',
    'apps/api/src/auth/session.test.mjs': test('isMember', "import { isMember } from './session.mjs';", "isMember({ teams: ['a'] }, 'a')", true),
    'apps/api/src/db.integration.mjs': test('database round trip', "import { charge } from './billing/charge.mjs';", 'charge(0)', 0),
    'apps/api/src/routes/items/router.mjs': [
      'export const router = {',
      '  list: openProcedure.query(() => []),',
      '  create: memberProcedure.mutation(({ input }) => {',
      '    ensureMember(input);',
      '    return input;',
      '  }),',
      '  remove: memberProcedure.mutation(({ input }) => input),',
      '};',
      '',
    ].join('\n'),
    'apps/api/src/queues.mjs': "export const QUEUE_NAME = 'example-jobs';\n",
    'apps/web/package.json': { name: 'web', private: true },
    'apps/web/src/features/cart/public.mjs': "export { total } from './total.mjs';\n",
    'apps/web/src/features/cart/total.mjs': 'export const total = items => items.reduce((s, i) => s + i, 0);\n',
    'apps/web/src/features/cart/total.test.mjs': test('total sums', "import { total } from './total.mjs';", 'total([1, 2])', 3),
    'apps/web/messages/en.json': { cart: { title: 'Cart', empty: 'Empty' } },
    'apps/web/messages/nl.json': { cart: { title: 'Winkelwagen' } },
  };
}

// ---------------------------------------------------------------------------------------------
// TAP text in the shape Node's built-in runner prints with --test-reporter=tap.
//
// tests: [{ name, ok = true, skip, todo, durationMs = 1, type, location, failureType, error, code,
//           errorName, expected, actual, children: [...] }]
// - skip / todo: true or a reason; the line gets "# SKIP <reason>" or "# TODO <reason>".
// - children: nested subtests (4 spaces deeper). A parent without `ok` fails when a child fails.
// - For the Node 20 file-wrapped shape, make each file a top-level test named by its path with
//   the file's tests as children; for the Node 24 shape, give each test a `location`.
// Options: { summary = true } adds the "# tests ..." footer.
//
// Escaping follows Node's TAP reporter: a one-line YAML string is util.inspect()-quoted (so a
// Windows location prints as 'C:\\x\\a.test.mjs:3:1' with doubled backslashes, and a string with
// a ' switches to "..." or `...`), a string with line breaks becomes a |- block, and a test name
// gets \b \f \t \n \r \v written as escapes, then every backslash doubled and # escaped.

const yamlText = s => inspect(String(s), { colors: false, breakLength: Infinity });
const TAP_CONTROL = { '\b': 'b', '\f': 'f', '\t': 't', '\n': 'n', '\r': 'r', '\v': 'v' };
const tapName = s => String(s).replace(/[\b\f\t\n\r\v]/g, c => `\\${TAP_CONTROL[c]}`).replace(/\\/g, '\\\\').replace(/#/g, '\\#');

function yamlLines(pad, entries) {
  const out = [`${pad}---`];
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out.push(`${pad}${k}: ${v}`);
    else if (/\r?\n/.test(String(v))) {
      out.push(`${pad}${k}: |-`);
      for (const line of String(v).split(/\r?\n/)) out.push(`${pad}  ${line}`);
    } else out.push(`${pad}${k}: ${yamlText(v)}`);
  }
  out.push(`${pad}...`);
  return out;
}

function passed(t) {
  if (t.ok !== undefined) return !!t.ok;
  const kids = t.children || [];
  return kids.every(k => k.skip || k.todo || passed(k));
}

export function tapLines(tests, { summary = true } = {}) {
  const lines = ['TAP version 13'];
  const counts = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let total = 0;
  const emit = (list, depth) => {
    const pad = '    '.repeat(depth);
    list.forEach((t, i) => {
      const kids = Array.isArray(t.children) ? t.children : [];
      lines.push(`${pad}# Subtest: ${tapName(t.name)}`);
      if (kids.length) emit(kids, depth + 1);
      const ok = passed(t);
      const suite = kids.length > 0 && t.type === 'suite';
      if (suite) counts.suites++;
      else {
        counts.tests++;
        if (t.skip) counts.skipped++;
        else if (t.todo) counts.todo++;
        else if (ok) counts.pass++;
        else counts.fail++;
      }
      const reason = v => (v === true ? '' : ` ${v}`);
      const directive = t.skip ? ` # SKIP${reason(t.skip)}` : t.todo ? ` # TODO${reason(t.todo)}` : '';
      lines.push(`${pad}${ok ? 'ok' : 'not ok'} ${i + 1} - ${tapName(t.name)}${directive}`);
      const failed = !ok && !t.todo;
      const subFailed = kids.filter(k => !k.skip && !k.todo && !passed(k)).length;
      const ms = t.durationMs ?? 1;
      total += depth === 0 ? ms : 0;
      lines.push(...yamlLines(`${pad}  `, [
        ['duration_ms', ms],
        ['type', t.type || (kids.length ? 'suite' : 'test')],
        ['location', t.location],
        ['failureType', failed ? (t.failureType || (subFailed ? 'subtestsFailed' : 'testCodeFailure')) : undefined],
        ['error', failed ? (t.error ?? (subFailed ? `${subFailed} subtest${subFailed === 1 ? '' : 's'} failed` : 'failed')) : undefined],
        ['code', failed ? (t.code || (subFailed ? 'ERR_TEST_FAILURE' : 'ERR_ASSERTION')) : undefined],
        ['name', failed && !subFailed ? (t.errorName || 'AssertionError') : undefined],
        ['expected', failed ? t.expected : undefined],
        ['actual', failed ? t.actual : undefined],
      ]));
    });
    lines.push(`${pad}1..${list.length}`);
  };
  emit(tests || [], 0);
  if (summary) {
    for (const k of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) lines.push(`# ${k} ${counts[k]}`);
    lines.push(`# duration_ms ${total}`);
  }
  return `${lines.join('\n')}\n`;
}

// Calls fn (sync or async) every `interval` ms until it returns something truthy, and returns
// that. Throws "waitFor timed out after <ms> ms" when time runs out; an error thrown by fn is
// kept and its message added.
export async function waitFor(fn, ms = 2000, { interval = 20 } = {}) {
  const end = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= end) throw new Error(`waitFor timed out after ${ms} ms${last ? `: ${last.message}` : ''}`);
    await new Promise(r => setTimeout(r, interval));
  }
}
