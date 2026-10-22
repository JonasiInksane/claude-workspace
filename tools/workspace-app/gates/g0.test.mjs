// Tests for gates/g0.mjs: every G0 row on a temporary git repo of the synthetic "example" project
// (test/fixtures/g0/profile.json), with fakes for the injected parts:
// - git: the core/git functions G0 uses (git, fileAt, lsFilesAt, changedFiles, diffText), run as
//   real git commands in the temporary repo;
// - probes.scan: a small scanner with the probe kinds G0 asks for, honouring `only` and
//   `readFile` like probes/scan.mjs;
// - runCommand: canned results per command id.
// Secret-shaped strings are built at runtime. Everything is written under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { matchAny } from '../core/glob.mjs';
import { G0_ROWS, checkRev, expandBraces, formatGlobMatches, runG0, writeTextAtomic } from './g0.mjs';
import { commitAll, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';

const fixture = name => readFileSync(new URL(`../test/fixtures/g0/${name}`, import.meta.url), 'utf8');
const PROFILE = JSON.parse(fixture('profile.json'));
const ROUTER = 'apps/api/src/routes/invoices/router.mjs';
const TEAMS = 'apps/api/src/routes/teams/router.mjs';
const QUEUES = 'apps/api/src/queues.mjs';
const MATH_TEST = 'apps/api/src/math.test.mjs';
const PANEL = 'apps/web/src/features/alpha/Panel.mjs';
const CART = 'apps/web/src/cart.mjs';
const j = (...parts) => parts.join('');
const STRIPE_KEY = j('sk', '_live_', 'Z'.repeat(24));

const BASE_FILES = {
  'package.json': '{ "name": "example" }\n',
  'docs/README.md': '# Records\n',
  [ROUTER]: fixture('router-base.txt'),
  [TEAMS]: 'export const teamsRouter = router({\n  invite: memberProcedure.mutation(() => null),\n  roster: openProcedure.query(() => []),\n});\n',
  'apps/api/src/legacy/router.mjs': 'export const oldRouter = router({\n  syncV1: signedInProcedure.query(() => []),\n});\n',
  [QUEUES]: fixture('queues.txt'),
  'apps/api/src/billing/charge.mjs': 'export const charge = cents => cents;\n',
  'apps/api/src/lookup.mjs': 'export const one = (db, input) => db.find({ where: { id: input.id } });\n',
  [MATH_TEST]: "test('adds', () => {});\ntest('subtracts', () => {});\ntest('multiplies', () => {});\n",
  'apps/api/src/billing.contract.test.mjs': "test('contract', () => {});\n",
  'apps/api/src/types.ts': 'export type Id = string;\n',
  'apps/api/migrations/001_init.sql': 'create table a (id int);\n',
  [CART]: 'export const total = items => items.length;\n',
  [PANEL]: "import { helper } from '@/features/beta/public';\nexport const panel = helper;\n",
  'apps/web/src/features/beta/public.mjs': "export { helper } from './internal/helper.mjs';\n",
  'apps/web/src/features/beta/internal/helper.mjs': 'export const helper = 1;\n',
};

// ---------------------------------------------------------------- fakes

function execGit(dir, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const out = { code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
      if (okCodes.includes(code)) resolve(out);
      else reject(Object.assign(new Error(`git ${args[0]} failed: ${out.stderr.trim()}`), out));
    });
  });
}

const splitZ = s => s.split('\0').filter(Boolean);
const excludeSpecs = globs => (globs.length ? [':(top)', ...globs.flatMap(g => expandBraces(g)).map(g => `:(top,exclude,glob,icase)${g}`)] : []);

// The core/git functions G0 uses, as real git commands in the temporary repo.
function fakeGit() {
  const calls = [];
  const note = (name, args) => calls.push({ name, args });
  return {
    calls,
    async git(dir, args, { okCodes = [0], full = false } = {}) {
      note('git', args);
      const r = await execGit(dir, args, okCodes);
      return full ? r : r.stdout;
    },
    async fileAt(dir, sha, path) {
      note('fileAt', [sha, path]);
      const r = await execGit(dir, ['cat-file', 'blob', `${sha}:${path}`], [0, 128]);
      return r.code === 0 ? r.stdout : null;
    },
    async lsFilesAt(dir, sha) {
      note('lsFilesAt', [sha]);
      return splitZ((await execGit(dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha])).stdout);
    },
    async changedFiles(dir, base, { includeUntracked = true, head = null } = {}) {
      note('changedFiles', [base, head]);
      const t = splitZ((await execGit(dir, ['diff', '--name-status', '-M', '-z', base, ...(head ? [head] : []), '--'])).stdout);
      const out = [];
      for (let i = 0; i < t.length; i++) {
        if (t[i][0] === 'R') { const oldPath = t[++i]; out.push({ path: t[++i], status: 'R', oldPath }); } else out.push({ path: t[++i], status: t[i - 1][0] });
      }
      if (includeUntracked && !head) for (const p of splitZ((await execGit(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout)) out.push({ path: p, status: 'A' });
      return out;
    },
    async diffText(dir, base, { includeUntracked = true, head = null, exclude = [] } = {}) {
      note('diffText', [base, head, ...exclude]);
      const specs = excludeSpecs(exclude);
      let text = (await execGit(dir, ['diff', '--binary', '-M', base, ...(head ? [head] : []), '--', ...specs])).stdout;
      if (includeUntracked && !head) {
        for (const p of splitZ((await execGit(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs])).stdout)) {
          text += (await execGit(dir, ['diff', '--no-index', '--binary', '--', '/dev/null', p], [0, 1])).stdout;
        }
      }
      return text;
    },
  };
}

const ROUTER_KEY = /^\s*(\w+)\s*:\s*(\w+Procedure)\b/;
const moduleOf = path => path.split('/').slice(-2)[0];

function fakeInScope(probe, path) {
  if (probe.kind === 'deepImports') return path.startsWith(`${probe.featuresDir}/`);
  return matchAny(probe.files || [], path) && !matchAny(probe.exclude || [], path);
}

// The items one probe kind finds in one file: [{id?, cls?, line, text}].
function fakeItems(probe, profile, path, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (probe.kind === 'routerKeys' || probe.kind === 'missingAssert') {
      const m = ROUTER_KEY.exec(line);
      if (!m) return;
      const id = `${moduleOf(path)}.${m[1]}`;
      const cls = profile.builders?.[m[2]] || 'unknown';
      if (probe.kind === 'routerKeys') {
        const f = probe.filter;
        if (f && ((f.class && f.class !== cls) || (f.bodyRegex && !new RegExp(f.bodyRegex).test(line)))) return;
      } else if (cls !== 'shop' || (profile.assertingBuilders || []).includes(m[2]) || new RegExp(profile.assertPattern).test(line)) return;
      out.push({ id, cls, line: i + 1, text: `${id}: ${m[2]}` });
    } else if (probe.kind === 'regexCount') {
      if (new RegExp(probe.regex).test(line)) out.push({ line: i + 1, text: line.trim() });
    } else if (probe.kind === 'deepImports') {
      const m = /from\s+['"]@\/features\/([^/'"]+)\/?([^'"]*)['"]/.exec(line);
      const from = path.slice(probe.featuresDir.length + 1).split('/')[0];
      if (m && m[1] !== from && !(probe.publicEntries || []).includes(m[2])) out.push({ line: i + 1, text: line.trim() });
    }
  });
  return out;
}

// probes.scan with the kinds G0 uses. File kinds need `only` (G0 always passes it); `readFile`
// replaces the disk read unless ignoreReader is set (a scanner that would compare head with head).
function fakeProbes({ cycles = null, ignoreReader = false, fail = {} } = {}) {
  const calls = [];
  async function scan({ profile, tree, only = null, ids = null, readFile = null }) {
    calls.push({ only: only ? [...only] : null, ids: ids ? [...ids] : null, reader: Boolean(readFile) });
    const disk = rel => readFileAsync(join(tree, ...rel.split('/')), 'utf8').catch(() => null);
    const read = readFile && !ignoreReader ? readFile : disk;
    const values = {}, details = {}, errors = {};
    for (const probe of (profile.probes || []).filter(p => !ids || ids.includes(p.id))) {
      try {
        if (fail[probe.id]) throw new Error(fail[probe.id]);
        if (probe.kind === 'cycles') {
          if (cycles === null) throw new Error('madge is not installed in this tree');
          values[probe.id] = { ...cycles };
          details[probe.id] = [];
          continue;
        }
        if (!only) throw new Error('the fake scanner needs `only` for file probes');
        const items = [];
        for (const f of only.filter(p => fakeInScope(probe, p))) {
          const text = await read(f);
          if (text !== null && text !== undefined) items.push(...fakeItems(probe, profile, f, String(text)).map(x => ({ ...x, path: f })));
        }
        values[probe.id] = { value: items.length, display: String(items.length) };
        if (probe.kind === 'routerKeys') Object.assign(values[probe.id], { nonShop: [...new Set(items.filter(x => x.cls !== 'shop').map(x => x.id))].sort(), filtered: Boolean(probe.filter) });
        details[probe.id] = items.map(x => ({ path: x.path, line: x.line, text: x.text }));
      } catch (e) {
        errors[probe.id] = e.message;
      }
    }
    return { at: new Date().toISOString(), sha: null, values, details, errors, missing: [], durationMs: 1 };
  }
  return { scan, calls };
}

// runCommand with canned results: results[commandId] is a result object or a function of opts.
// The default result names its log from checkId like gates/commands.mjs does (logName).
const logNameOf = id => `${String(id).replace(/[^A-Za-z0-9._-]+/g, '-')}.log`;
function fakeRun(results = {}) {
  const calls = [];
  const fn = async opts => {
    calls.push({ id: opts.commandId, checkId: opts.checkId, files: [...(opts.files || [])] });
    const r = results[opts.commandId];
    if (typeof r === 'function') return r(opts);
    return r || { status: 'pass', exitCode: 0, durationMs: 3, log: logNameOf(opts.checkId || opts.commandId), errors: [] };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- setup

async function setup(t, { files = BASE_FILES } = {}) {
  const dir = tempDir('g0-repo-', t);
  const base = await makeRepo(dir, { files });
  return { dir, base, gateDir: join(tempDir('g0-gate-', t), 'gates', '06-checks') };
}

function rm(dir, rel) {
  rmSync(join(dir, ...rel.split('/')), { force: true });
}

// runG0 with the fakes and the change list git reports for the working tree.
async function g0(env, extra = {}) {
  const git = extra.git || fakeGit();
  const changed = extra.changed || await git.changedFiles(env.dir, env.base, { includeUntracked: true });
  const diff = 'diff' in extra ? extra.diff : await git.diffText(env.dir, env.base, { includeUntracked: true, exclude: ['**/.env', '**/.env.*', '**/.npmrc', '**/.sentryclirc'] });
  const runCommand = extra.runCommand || fakeRun();
  const probes = extra.probes || fakeProbes();
  git.calls.length = 0;
  const rowsSeen = [];
  const r = await runG0({
    profile: PROFILE, tree: env.dir, baseSha: env.base, changed, diff, plan: { files: [CART] }, ticked: [], allowances: [],
    pipeline: 'refactor', gateDir: env.gateDir, git, runCommand, probes, onRow: row => rowsSeen.push(row.id),
    ...extra, ...(extra.profile ? { profile: extra.profile } : {}),
  });
  return { ...r, row: id => r.rows.find(x => x.id === id), git, runCommand, probes, rowsSeen };
}

const statusOf = r => Object.fromEntries(r.rows.map(x => [x.id, x.status]));
const rowOf = (r, id) => r.rows.find(x => x.id === id);

function gateText(gateDir) {
  let text = '';
  for (const name of readdirSync(gateDir)) text += readFileSync(join(gateDir, name), 'utf8');
  return text;
}

// ---------------------------------------------------------------- tests

test('a clean change: the rows that apply pass, the rest skip with a reason, and g0.json is written', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [CART]: 'export const total = items => items.length + 0;\n' });
  const statusBefore = await runGit(env.dir, ['status', '--porcelain']);
  const r = await g0(env);
  assert.deepEqual(r.rows.map(x => x.id), G0_ROWS.map(x => x.id));
  assert.deepEqual(statusOf(r), {
    'g0.diffcheck': 'pass', 'g0.format': 'pass', 'g0.lint': 'pass', 'g0.secrets': 'pass', 'g0.fences': 'pass',
    'g0.ratchets.tests': 'skip', 'g0.ratchets.allowlist': 'skip', 'g0.ratchets.metrics': 'skip', 'g0.contract': 'skip', 'g0.tenant': 'skip',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
  assert.equal(r.secretsFound, 0);
  for (const row of r.rows) {
    assert.equal(row.group, 'G0');
    if (row.status === 'skip') assert.match(row.reason, /^Not run: /, row.id);
  }
  assert.equal(r.rowsSeen.length, 10);
  // G0's own check ids name the logs, so G2's lint:web check can't overwrite them in the same gate folder.
  assert.deepEqual(r.runCommand.calls, [{ id: 'format:changed', checkId: 'g0.format', files: [CART] }, { id: 'lint:web', checkId: 'g0.lint.lint:web', files: [CART] }]);
  assert.equal(r.row('g0.format').log, 'g0.format.log');
  assert.equal(r.row('g0.lint').log, 'g0.lint.lint-web.log');
  const doc = JSON.parse(readFileSync(join(env.gateDir, 'g0.json'), 'utf8'));
  assert.equal(doc.ok, true);
  assert.equal(doc.rows.length, 10);
  // G0 writes nothing into the tree.
  assert.equal(await runGit(env.dir, ['status', '--porcelain']), statusBefore);
});

test('g0.diffcheck: tracked and untracked whitespace problems fail; secret files are never looked at', async t => {
  const env = await setup(t);
  writeFiles(env.dir, {
    [CART]: 'export const total = items => items.length;   \n',
    'apps/web/src/new.mjs': 'export const a = 1;\t\n\n',
    'apps/web/.env.local': 'PLAIN=1   \n',
  });
  const r = await g0(env, { plan: { files: [CART, 'apps/web/src/new.mjs'] } });
  const row = r.row('g0.diffcheck');
  assert.equal(row.status, 'fail');
  const problems = row.details.problems.map(p => `${p.path}:${p.line} ${p.problem}`);
  assert.deepEqual(problems.sort(), [`${CART}:1 trailing whitespace`, 'apps/web/src/new.mjs:1 trailing whitespace', 'apps/web/src/new.mjs:2 new blank line at EOF'].sort());
  assert.match(row.reason, /^3 whitespace problems: /);
  assert.equal(row.command, `git diff --check ${env.base.slice(0, 7)}`);
  const call = r.git.calls.find(c => c.name === 'git' && c.args.includes('--check'));
  assert.ok(call.args.includes(':(top,exclude,glob,icase)**/.env.*'), call.args.join(' '));
  assert.ok(!problems.some(p => p.includes('.env')));
  assert.match(readFileSync(join(env.gateDir, 'g0.diffcheck.log'), 'utf8'), /trailing whitespace/);
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes('g0.diffcheck'));
});

test('g0.diffcheck: a staged new file that git checks is reported once, not again by the untracked-file rules', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { 'apps/web/src/staged.mjs': 'export const x = 1;\n\n\n' });
  await runGit(env.dir, ['add', 'apps/web/src/staged.mjs']);
  const r = await g0(env, { plan: { files: ['apps/web/src/staged.mjs'] } });
  const problems = r.row('g0.diffcheck').details.problems.map(p => `${p.path}:${p.line} ${p.problem}`);
  assert.deepEqual(problems, ['apps/web/src/staged.mjs:2 new blank line at EOF']);
  assert.match(r.row('g0.diffcheck').reason, /^1 whitespace problem: /);
});

test('g0.format and g0.lint: changed files in scope only, failures, errors, and redacted lint messages', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [CART]: 'export const total = 2;\n', 'apps/api/src/billing/charge.mjs': 'export const charge = c => c * 2;\n', 'docs/README.md': '# Records!\n', 'apps/web/.env.local': 'A=1\n' });
  rm(env.dir, 'apps/api/src/lookup.mjs');
  const runCommand = fakeRun({
    'format:changed': { status: 'fail', exitCode: 1, log: 'format-changed.log', errors: [{ id: `${CART}::format`, file: CART, message: 'not formatted' }] },
    'lint:api': { status: 'fail', exitCode: 1, log: 'lint-api.log', errors: [{ id: `apps/api/src/billing/charge.mjs::no-secrets::found ${STRIPE_KEY}` }] },
    'lint:web': { status: 'error', exitCode: 2, reason: 'ESLint did not finish (exit code 2)' },
  });
  const r = await g0(env, { runCommand, plan: { files: [CART, 'apps/api/src/billing/charge.mjs', 'apps/api/src/lookup.mjs'] } });
  const calls = Object.fromEntries(runCommand.calls.map(c => [c.id, c.files]));
  // The formatter gets every changed file matching *.{mjs,md}, never a deleted or secret file.
  assert.deepEqual(calls['format:changed'].sort(), ['apps/api/src/billing/charge.mjs', CART, 'docs/README.md'].sort());
  assert.deepEqual(calls['lint:api'], ['apps/api/src/billing/charge.mjs']);
  assert.deepEqual(calls['lint:web'], [CART]);
  assert.equal(r.row('g0.format').status, 'fail');
  assert.match(r.row('g0.format').reason, /1 file is not formatted: apps\/web\/src\/cart\.mjs/);
  const lint = r.row('g0.lint');
  assert.equal(lint.status, 'error');
  assert.match(lint.reason, /lint:web did not finish \(ESLint did not finish/);
  assert.match(lint.reason, /lint:api: 1 error in 1 file/);
  assert.ok(!JSON.stringify(r.rows).includes(STRIPE_KEY), 'the lint message is redacted');
  assert.ok(!gateText(env.gateDir).includes(STRIPE_KEY));

  const none = await g0(env, { changed: [{ path: 'apps/api/migrations/001_init.sql', status: 'M' }], runCommand: fakeRun() });
  assert.equal(none.row('g0.format').status, 'skip');
  assert.match(none.row('g0.format').reason, /no changed file matches \*\.\{mjs,md\}/);
  assert.equal(none.row('g0.lint').status, 'skip');
});

test('g0.secrets: a key in an added line fails and is redacted everywhere; removed lines and allowed values pass', async t => {
  const env = await setup(t, { files: { ...BASE_FILES, 'apps/api/src/old.mjs': `export const k = "${STRIPE_KEY}";\n` } });
  writeFiles(env.dir, { [CART]: `export const key = "${STRIPE_KEY}";\n` });
  const r = await g0(env);
  const row = r.row('g0.secrets');
  assert.equal(row.status, 'fail');
  assert.equal(r.secretsFound, 1);
  assert.match(row.reason, /1 secret-shaped value in the change: stripe in apps\/web\/src\/cart\.mjs:1/);
  assert.equal(row.details.found[0].preview, `export const key = "${STRIPE_KEY.slice(0, 4)}…[redacted ${STRIPE_KEY.length - 4}]";`);
  assert.ok(!JSON.stringify(r).includes(STRIPE_KEY));
  assert.ok(!gateText(env.gateDir).includes(STRIPE_KEY), 'logs and g0.json hold no key');
  assert.equal(r.ok, false);

  // Taking a key out of the code is fine.
  writeFiles(env.dir, { [CART]: BASE_FILES[CART] });
  rm(env.dir, 'apps/api/src/old.mjs');
  assert.equal((await g0(env, { plan: { files: ['apps/api/src/old.mjs'] } })).row('g0.secrets').status, 'pass');

  // A value the profile allows passes.
  writeFiles(env.dir, { [CART]: `export const key = "${STRIPE_KEY}";\n` });
  const allowed = await g0(env, { profile: { ...PROFILE, secrets: { ...PROFILE.secrets, allowValues: [STRIPE_KEY] } } });
  assert.equal(allowed.row('g0.secrets').status, 'pass');
});

test('g0.secrets: an added secret-shaped file fails even though the diff leaves it out, and is never read', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { 'apps/web/.env.local': `TOKEN=${STRIPE_KEY}\n` });
  const r = await g0(env);
  const row = r.row('g0.secrets');
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.details.found.map(f => [f.pattern, f.path, f.line]), [['secret-file', 'apps/web/.env.local', 0]]);
  assert.ok(!r.git.calls.some(c => c.name === 'fileAt' && c.args[1].includes('.env')));
  assert.equal(r.row('g0.fences').status, 'fail');                       // **/.env.* is forbidden
  assert.ok(!JSON.stringify(r).includes(STRIPE_KEY));
});

test("the profile's denyReadGlobs: such files are never read, linted or formatted, and adding one fails", async t => {
  const env = await setup(t);
  const profile = { ...PROFILE, secrets: { ...PROFILE.secrets, denyReadGlobs: [...PROFILE.secrets.denyReadGlobs, '**/private/**'] } };
  writeFiles(env.dir, { 'apps/web/src/private/keys.mjs': 'export const k = 1;   \n', [CART]: 'export const total = 7;\n' });
  const r = await g0(env, { profile, plan: { files: [CART, 'apps/web/src/private/keys.mjs'] } });
  assert.deepEqual(r.runCommand.calls.map(c => c.files), [[CART], [CART]]);
  assert.equal(r.row('g0.diffcheck').status, 'pass');                     // its trailing space is not looked at
  assert.ok(r.git.calls.find(c => c.args.includes('--check')).args.includes(':(top,exclude,glob,icase)**/private/**'));
  assert.deepEqual(r.row('g0.secrets').details.found.map(f => [f.pattern, f.path]), [['secret-file', 'apps/web/src/private/keys.mjs']]);
});

test('g0.fences: files outside the plan wait for you, allowances pass, forbidden fails, read-only is information', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [CART]: 'export const total = 3;\n', 'apps/api/src/billing/charge.mjs': 'export const charge = c => c + 1;\n' });
  const outside = await g0(env);
  assert.equal(outside.row('g0.fences').status, 'warn');
  assert.equal(outside.fence.needsYou, true);
  assert.deepEqual(outside.fence.outsidePlan.map(e => e.path), ['apps/api/src/billing/charge.mjs']);
  assert.equal(outside.ok, false);
  assert.deepEqual(outside.failed, []);
  assert.match(outside.row('g0.fences').reason, /1 file outside the plan needs your OK/);

  const allowed = await g0(env, { allowances: [{ path: 'apps/api/src/billing/charge.mjs', reason: 'allowed at the fence gate' }] });
  assert.equal(allowed.fence.needsYou, false);
  assert.equal(allowed.ok, true);
  assert.match(allowed.row('g0.fences').reason, /Pass, 1 allowed by you/);

  writeFiles(env.dir, { 'vendor/lib.mjs': 'export {};\n' });
  const forbidden = await g0(env, { allowances: ['apps/api/src/billing/charge.mjs', 'vendor/lib.mjs'] });
  assert.equal(forbidden.row('g0.fences').status, 'fail');
  assert.ok(forbidden.failed.includes('g0.fences'));

  const review = await g0(env, { pipeline: 'review', plan: null });
  assert.equal(review.row('g0.fences').status, 'warn');
  assert.match(review.row('g0.fences').reason, /^Information: 1 forbidden file changed/);
  assert.equal(review.fence.readOnly, true);
});

test('g0.ratchets.tests: a lost test or a new .only fails; a renamed test file with the same tests passes', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [MATH_TEST]: "test('adds', () => {});\ntest('subtracts', () => {});\n" });
  const lost = await g0(env, { plan: { files: [MATH_TEST] } });
  assert.equal(lost.row('g0.ratchets.tests').status, 'fail');
  assert.match(lost.row('g0.ratchets.tests').reason, /apps\/api\/src\/math\.test\.mjs lost 1 test \(3 to 2\)/);

  writeFiles(env.dir, { [MATH_TEST]: BASE_FILES[MATH_TEST].replace("test('adds'", "test.only('adds'") });
  const only = await g0(env, { plan: { files: [MATH_TEST] } });
  assert.match(only.row('g0.ratchets.tests').reason, /new only in apps\/api\/src\/math\.test\.mjs:1/);

  writeFiles(env.dir, { [MATH_TEST]: BASE_FILES[MATH_TEST] });
  await runGit(env.dir, ['mv', MATH_TEST, 'apps/api/src/arith.test.mjs']);
  const moved = await g0(env, { plan: { files: [MATH_TEST, 'apps/api/src/arith.test.mjs'] } });
  assert.equal(moved.row('g0.ratchets.tests').status, 'pass');
  assert.deepEqual(moved.row('g0.ratchets.tests').details.files, [{ path: 'apps/api/src/arith.test.mjs', before: 3, after: 3 }]);
});

test('g0.contract: a refactor may remove nothing; a feature may when the plan lists the file; queues count', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [ROUTER]: fixture('router-head.txt') });
  const refactor = await g0(env, { plan: { files: [ROUTER] } });
  const row = refactor.row('g0.contract');
  assert.equal(row.status, 'fail');
  assert.match(row.reason, /A refactor may not remove contract names: procedure invoices\.list, procedure invoices\.pay/);
  assert.deepEqual(row.details.added.map(a => a.name), ['invoices.refund']);

  const feature = await g0(env, { pipeline: 'feature', plan: { files: [ROUTER] } });
  assert.equal(feature.row('g0.contract').status, 'warn');

  writeFiles(env.dir, { [ROUTER]: BASE_FILES[ROUTER], [QUEUES]: fixture('queues.txt').replace("'send-mail'", "'send-email'") });
  const queue = await g0(env, { pipeline: 'feature', plan: { files: [ROUTER] } });
  assert.equal(queue.row('g0.contract').status, 'fail');
  assert.match(queue.row('g0.contract').reason, /queue send-mail/);
});

test('g0.tenant: new raw procedures and missing asserts fail, new lookups warn, moved code is not new', async t => {
  const env = await setup(t);
  writeFiles(env.dir, {
    'apps/api/src/billing/charge.mjs': 'export const charge = cents => rawBuilder(cents);\n',
    [TEAMS]: BASE_FILES[TEAMS].replace('  roster:', '  kick: memberProcedure.mutation(() => null),\n  ban: memberProcedure.mutation(() => ensureAdmin(1)),\n  roster:'),
  });
  writeFiles(env.dir, { 'apps/api/src/db/find.mjs': 'export const two = (db, input) => db.find({ where: { id: input.teamId } });\n' });
  await runGit(env.dir, ['mv', 'apps/api/src/lookup.mjs', 'apps/api/src/db/lookup.mjs']);
  const r = await g0(env);
  const row = r.row('g0.tenant');
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.details.new.rawProcedure, ['apps/api/src/billing/charge.mjs::export const charge = cents => rawBuilder(cents);']);
  assert.deepEqual(row.details.new.missingAssert, [`${TEAMS}::teams.kick: memberProcedure`]);
  assert.deepEqual(row.details.new.unscopedLookups, ['apps/api/src/db/find.mjs::export const two = (db, input) => db.find({ where: { id: input.teamId } });']);
  assert.equal(row.details.new.procedures, undefined, 'no new unguarded procedure');
  assert.match(row.reason, /Raw procedure builders/);
  // Base copies came through the reader, never from a copy in the tree.
  assert.ok(r.probes.calls.every(c => c.reader));
  assert.ok(r.git.calls.some(c => c.name === 'fileAt' && c.args[1] === 'apps/api/src/lookup.mjs'));
});

test('g0.tenant: code moved into a new file without a git rename is not new', async t => {
  const RAW = 'export const charge = cents => rawBuilder(cents);';
  const LOOKUP = 'export const one = (db, input) => db.find({ where: { id: input.id } });';
  const env = await setup(t, { files: {
    ...BASE_FILES,
    'apps/api/src/billing/charge.mjs': `${RAW}\nexport const fee = 1;\nexport const tax = 2;\n`,
    'apps/api/src/lookup.mjs': `${LOOKUP}\nexport const keep = 3;\n`,
  } });
  // Both source files stay (modified), and the lines land in new files, so git sees no rename.
  writeFiles(env.dir, {
    'apps/api/src/billing/charge.mjs': 'export const fee = 1;\nexport const tax = 2;\n',
    'apps/api/src/billing/raw.mjs': `${RAW}\n`,
    'apps/api/src/lookup.mjs': 'export const keep = 3;\n',
    'apps/api/src/db/queries.mjs': `// moved here\n${LOOKUP}\n`,
  });
  const changed = await fakeGit().changedFiles(env.dir, env.base, { includeUntracked: true });
  assert.ok(!changed.some(c => c.status === 'R'), 'no rename was detected');
  const r = await g0(env, { plan: { files: changed.map(c => c.path) } });
  const row = r.row('g0.tenant');
  assert.equal(row.status, 'pass', row.reason);
  assert.deepEqual(row.details.new, {});
  // A second copy of the same line is new: one more than at base.
  writeFiles(env.dir, { 'apps/api/src/billing/charge.mjs': `${RAW}\nexport const fee = 1;\n` });
  const copied = await g0(env, { plan: { files: [...changed.map(c => c.path)] } });
  assert.equal(copied.row('g0.tenant').status, 'fail');
  assert.equal(copied.row('g0.tenant').details.new.rawProcedure.length, 1);
});

test('g0.tenant: a new open procedure fails unless the allowlist has it', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [TEAMS]: BASE_FILES[TEAMS].replace('  roster:', '  byTeam: openProcedure.input(teamId).query(() => []),\n  roster:') });
  const strict = await g0(env, { plan: { files: [TEAMS] } });
  const row = strict.row('g0.tenant');
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.details.new.procedures, ['teams.byTeam']);
  assert.match(row.reason, /G0 was not given the allowlist/);
  assert.deepEqual(row.details.new.publicShopId, [`${TEAMS}::teams.byTeam: openProcedure`]);

  const listed = await g0(env, { plan: { files: [TEAMS] }, allowlist: { version: 1, list: ['teams.byTeam', 'teams.roster', 'invoices.me', 'invoices.publicSummary'] } });
  assert.equal(listed.row('g0.tenant').status, 'warn');                   // publicShopId still warns
  assert.equal(listed.row('g0.tenant').details.new.procedures, undefined);
  assert.equal(listed.ok, true);
});

test('g0.ratchets.allowlist: read from the data folder; new off-list procedures fail, old ones warn', async t => {
  const env = await setup(t);
  const dataDir = tempDir('g0-data-', t);
  writeFiles(env.dir, { [TEAMS]: BASE_FILES[TEAMS].replace('  roster:', '  status: openProcedure.query(() => 1),\n  roster:') });
  const notSetUp = await g0(env, { plan: { files: [TEAMS] }, dataDir });
  assert.equal(notSetUp.row('g0.ratchets.allowlist').status, 'skip');
  assert.match(notSetUp.row('g0.ratchets.allowlist').reason, /not set up yet/);
  assert.match(notSetUp.row('g0.tenant').reason, /no allowlist is set up yet/);

  writeFiles(dataDir, { 'profiles/example.allowlist.json': { version: 1, project: 'example', list: ['invoices.me', 'invoices.publicSummary', 'gone.route'] } });
  const r = await g0(env, { plan: { files: [TEAMS] }, dataDir });
  const row = r.row('g0.ratchets.allowlist');
  assert.equal(row.status, 'fail');
  assert.deepEqual(row.details.addedNew, ['teams.status']);
  assert.deepEqual(row.details.addedOld, ['teams.roster']);
  assert.deepEqual(row.details.removed, ['gone.route']);
  assert.match(row.reason, /1 new procedure is not on the allowlist: teams\.status; 1 procedure was already off the allowlist at base; .*the allowlist can shrink by 1/);
  // The whole-tree list came from the head files in the probe's scope.
  const whole = r.probes.calls.find(c => c.ids.length === 1 && c.ids[0] === 'procedures');
  assert.deepEqual(whole.only, [ROUTER, TEAMS]);

  writeFiles(env.dir, { [TEAMS]: BASE_FILES[TEAMS].replace('roster: openProcedure', 'roster: memberProcedure') + '\n' });
  writeFiles(dataDir, { 'profiles/example.allowlist.json': { version: 1, list: ['invoices.me'] } });
  const old = await g0(env, { plan: { files: [TEAMS] }, dataDir });
  assert.equal(old.row('g0.ratchets.allowlist').status, 'warn');

  writeFiles(dataDir, { 'profiles/example.allowlist.json': '{ broken' });
  assert.equal((await g0(env, { plan: { files: [TEAMS] }, dataDir })).row('g0.ratchets.allowlist').status, 'error');
});

test('g0.ratchets.metrics: more deep imports fail; cycles compare with the base scan, or warn without one', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [PANEL]: `${BASE_FILES[PANEL]}import { helper as h } from '@/features/beta/internal/helper';\n` });
  const deep = await g0(env, { plan: { files: [PANEL] } });
  const row = deep.row('g0.ratchets.metrics');
  assert.equal(row.status, 'fail');
  assert.match(row.reason, /deepImports went up from 0 to 1/);

  writeFiles(env.dir, { [PANEL]: BASE_FILES[PANEL], 'apps/api/src/types.ts': 'export type Id = number;\n' });
  const probes = () => fakeProbes({ cycles: { value: 3, largestModuleCycle: 5, rule: 'r1' } });
  const noBase = await g0(env, { plan: { files: ['apps/api/src/types.ts'] }, probes: probes() });
  assert.equal(noBase.row('g0.ratchets.metrics').status, 'warn');
  assert.match(noBase.row('g0.ratchets.metrics').reason, /serverCycles not compared \(no scan at the base commit yet/);
  assert.equal(noBase.ok, true);

  const worse = await g0(env, { plan: { files: ['apps/api/src/types.ts'] }, probes: probes(), baseScan: { values: { serverCycles: { value: 3, largestModuleCycle: 4, rule: 'r1' } } } });
  assert.equal(worse.row('g0.ratchets.metrics').status, 'fail');
  assert.match(worse.row('g0.ratchets.metrics').reason, /serverCycles\.largestModuleCycle went up from 4 to 5/);

  const dataDir = tempDir('g0-data-', t);
  writeFiles(dataDir, { 'metrics/example.json': { version: 1, project: 'example', scans: [
    { id: 's-1', sha: env.base.slice(0, 12), values: { serverCycles: { value: 4, largestModuleCycle: 6, rule: 'r1' } } },
    { id: 's-2', sha: 'f'.repeat(40), values: { serverCycles: { value: 1, largestModuleCycle: 1, rule: 'r1' } } },
  ] } });
  const better = await g0(env, { plan: { files: ['apps/api/src/types.ts'] }, probes: probes(), dataDir });
  assert.equal(better.row('g0.ratchets.metrics').status, 'pass');
  assert.deepEqual(better.row('g0.ratchets.metrics').details.rows.map(x => x.status), ['better', 'better']);

  const changedRule = await g0(env, { plan: { files: ['apps/api/src/types.ts'] }, probes: probes(), baseScan: { serverCycles: { value: 1, rule: 'old' } } });
  assert.match(changedRule.row('g0.ratchets.metrics').reason, /the probe changed since the base scan/);

  const broken = await g0(env, { plan: { files: ['apps/api/src/types.ts'] }, probes: fakeProbes() });
  assert.match(broken.row('g0.ratchets.metrics').reason, /the probe failed \(madge is not installed/);
});

test('bare paths and no diff: G0 asks git for the statuses and builds the diff itself', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [CART]: `export const k = "${STRIPE_KEY}";\n`, 'apps/web/src/cart.test.mjs': "test('new', () => {});\n" });
  await runGit(env.dir, ['mv', MATH_TEST, 'apps/api/src/arith.test.mjs']);
  const git = fakeGit();
  const r = await runG0({
    profile: PROFILE, tree: env.dir, baseSha: env.base, changed: [CART, 'apps/web/src/cart.test.mjs', 'apps/api/src/arith.test.mjs'],
    plan: { files: [CART, MATH_TEST, 'apps/api/src/arith.test.mjs'] }, pipeline: 'refactor', gateDir: env.gateDir, git, runCommand: fakeRun(), probes: fakeProbes(),
  });
  assert.ok(git.calls.some(c => c.name === 'changedFiles'));
  assert.ok(git.calls.some(c => c.name === 'diffText' && c.args.includes('**/.env.*')));
  assert.equal(rowOf(r, 'g0.secrets').status, 'fail');
  assert.equal(r.secretsFound, 1);
  // The new test file is new, and the rename keeps its old path, so nothing is an existing test change.
  assert.equal(rowOf(r, 'g0.fences').status, 'pass', rowOf(r, 'g0.fences').reason);
  assert.equal(rowOf(r, 'g0.ratchets.tests').status, 'pass');
  assert.deepEqual(rowOf(r, 'g0.ratchets.tests').details.files.map(f => f.path).sort(), ['apps/api/src/arith.test.mjs', 'apps/web/src/cart.test.mjs']);
});

test('fail closed: a scanner that ignores the base reader, a throwing command, or no git is an error row', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { 'apps/api/src/billing/charge.mjs': 'export const charge = cents => rawBuilder(cents);\n', [CART]: 'export const total = 1;\n' });
  const r = await g0(env, {
    probes: fakeProbes({ ignoreReader: true }),
    runCommand: fakeRun({ 'format:changed': () => { throw new Error('the formatter crashed'); } }),
    plan: { files: ['apps/api/src/billing/charge.mjs', CART] },
  });
  assert.equal(r.row('g0.tenant').status, 'error');
  assert.match(r.row('g0.tenant').reason, /did not read the files through G0/);
  assert.equal(r.row('g0.format').status, 'error');
  assert.match(r.row('g0.format').reason, /the formatter crashed/);
  assert.equal(r.row('g0.lint').status, 'pass');                          // the next row still ran
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.sort(), ['g0.format', 'g0.tenant']);

  const noGit = await runG0({ profile: PROFILE, tree: env.dir, baseSha: env.base, changed: [{ path: CART, status: 'M' }], diff: '', plan: { files: [CART] }, pipeline: 'refactor', runCommand: fakeRun(), probes: fakeProbes() });
  const byId = Object.fromEntries(noGit.rows.map(x => [x.id, x]));
  assert.equal(byId['g0.diffcheck'].status, 'error');
  assert.match(byId['g0.diffcheck'].reason, /without git/);
  assert.equal(noGit.ok, false);
});

test('a probe that fails: a failing-policy probe is an error, a warning-policy probe a warning', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { 'apps/api/src/billing/charge.mjs': 'export const charge = cents => cents + 1;\n' });
  const policyError = await g0(env, { probes: fakeProbes({ fail: { rawProcedure: 'bad regex' } }), plan: { files: ['apps/api/src/billing/charge.mjs'] } });
  assert.equal(policyError.row('g0.tenant').status, 'error');
  assert.match(policyError.row('g0.tenant').reason, /Raw procedure builders: the probe failed \(bad regex\)/);
  assert.equal(policyError.ok, false);
  // unscopedLookups only ever warns, so when it can't run G0 warns that it was not checked.
  const policyWarn = await g0(env, { probes: fakeProbes({ fail: { unscopedLookups: 'bad regex' } }), plan: { files: ['apps/api/src/billing/charge.mjs'] } });
  assert.equal(policyWarn.row('g0.tenant').status, 'warn');
  assert.match(policyWarn.row('g0.tenant').reason, /Lookups by input id: the probe failed \(bad regex\); not checked/);
  assert.ok(!policyWarn.failed.includes('g0.tenant'));
  assert.equal(policyWarn.ok, true);
  // Both broken: the failing-policy one decides.
  const both = await g0(env, { probes: fakeProbes({ fail: { rawProcedure: 'x', unscopedLookups: 'y' } }), plan: { files: ['apps/api/src/billing/charge.mjs'] } });
  assert.equal(both.row('g0.tenant').status, 'error');
});

test('writeTextAtomic retries a refused rename, and removes its temporary file when it gives up', async t => {
  const dir = tempDir('g0-write-', t);
  const file = join(dir, 'gate', 'g0.lint.log');
  const real = await import('node:fs/promises');
  const pauses = [];
  let refusals = 2;
  const flaky = { ...real, rename: async (a, b) => { if (refusals-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real.rename(a, b); } };
  await writeTextAtomic(file, 'hello\n', { fs: flaky, sleep: async ms => { pauses.push(ms); } });
  assert.equal(readFileSync(file, 'utf8'), 'hello\n');
  assert.deepEqual(pauses, [50, 100]);
  const stuck = { ...real, rename: async () => { throw Object.assign(new Error('held'), { code: 'EPERM' }); } };
  await assert.rejects(writeTextAtomic(join(dir, 'gate', 'other.log'), 'x', { fs: stuck, sleep: async () => {} }), /held/);
  assert.deepEqual(readdirSync(join(dir, 'gate')).sort(), ['g0.lint.log']);
  // Other errors are not retried.
  const denied = { ...real, rename: async () => { throw Object.assign(new Error('no such folder'), { code: 'ENOENT' }); } };
  const before = pauses.length;
  await assert.rejects(writeTextAtomic(join(dir, 'gate', 'third.log'), 'x', { fs: denied, sleep: async ms => { pauses.push(ms); } }), /no such folder/);
  assert.equal(pauses.length, before);
  assert.deepEqual(readdirSync(join(dir, 'gate')).sort(), ['g0.lint.log']);
});

test('cancelled before the start: every row is skipped and G0 is not ok', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [CART]: 'export const total = 5;\n' });
  const controller = new AbortController();
  controller.abort();
  const r = await g0(env, { signal: controller.signal });
  assert.ok(r.rows.every(x => x.status === 'skip' && x.reason === 'Not run: cancelled.'));
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.equal(r.runCommand.calls.length, 0);
});

test('bad inputs: a missing tree or base throws; an option-shaped base never reaches git; an unknown base errors', async t => {
  const env = await setup(t);
  await assert.rejects(runG0({ tree: env.dir }), /needs the tree folder and the base commit/);
  const git = fakeGit();
  const r = await runG0({ profile: PROFILE, tree: env.dir, baseSha: '--output=x', changed: [], diff: '', git, runCommand: fakeRun(), probes: fakeProbes() });
  assert.equal(git.calls.length, 0);
  assert.ok(r.rows.every(x => x.status === 'error'));
  assert.match(r.rows[0].reason, /G0 could not start: "--output=x" is not a valid base commit/);
  assert.equal(r.ok, false);

  const missing = await runG0({ profile: PROFILE, tree: join(env.dir, 'nope'), baseSha: env.base, changed: [], diff: '', git: fakeGit(), runCommand: fakeRun(), probes: fakeProbes() });
  assert.match(missing.rows[0].reason, /does not exist/);

  writeFiles(env.dir, { [CART]: 'export const total = 6;\n' });
  const unknown = await g0(env, { baseSha: 'b'.repeat(40) });
  assert.equal(unknown.row('g0.diffcheck').status, 'error');
  assert.equal(unknown.ok, false);
  assert.equal(checkRev('HEAD~2'), 'HEAD~2');
  assert.throws(() => checkRev('a..b'), /not a valid commit/);
});

test('head commit: a review of base..head reads git, not the folder, and skips the folder-only rows', async t => {
  const env = await setup(t);
  writeFiles(env.dir, { [ROUTER]: fixture('router-head.txt'), [CART]: `export const total = 1;   \n` });
  const head = await commitAll(env.dir, 'head');
  await runGit(env.dir, ['checkout', '-q', env.base]);                    // the folder is back at base
  const git = fakeGit();
  const r = await runG0({
    profile: PROFILE, tree: env.dir, baseSha: env.base, head, changed: await git.changedFiles(env.dir, env.base, { head }),
    pipeline: 'review', gateDir: env.gateDir, git, runCommand: fakeRun(), probes: fakeProbes(),
  });
  assert.equal(rowOf(r, 'g0.contract').status, 'warn');                      // removals are information in a review
  assert.match(rowOf(r, 'g0.contract').reason, /Removed \(information\): procedure invoices\.list, procedure invoices\.pay/);
  assert.equal(rowOf(r, 'g0.diffcheck').status, 'fail');
  assert.equal(rowOf(r, 'g0.diffcheck').command, `git diff --check ${env.base.slice(0, 7)} ${head.slice(0, 7)}`);
  assert.equal(rowOf(r, 'g0.format').status, 'skip');
  assert.equal(rowOf(r, 'g0.lint').status, 'skip');
  assert.ok(git.calls.some(c => c.name === 'diffText' && c.args[1] === head));
  assert.ok(git.calls.some(c => c.name === 'fileAt' && c.args[0] === head && c.args[1] === ROUTER));
});

test('formatGlobMatches follows lint-staged: no slash matches the file name, a slash the path', () => {
  assert.equal(formatGlobMatches('*.{ts,tsx,md}', 'apps/web/src/a.tsx'), true);
  assert.equal(formatGlobMatches('*.{ts,tsx,md}', 'apps/web/src/a.mjs'), false);
  assert.equal(formatGlobMatches('apps/**/*.md', 'apps/web/README.md'), true);
  assert.equal(formatGlobMatches('apps/**/*.md', 'docs/README.md'), false);
  assert.equal(formatGlobMatches('', 'a.md'), false);
  assert.deepEqual(expandBraces('**/*.{a,b}'), ['**/*.a', '**/*.b']);
});
