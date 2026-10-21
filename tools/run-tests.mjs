// Runs the tool tests: every *.test.mjs under tools/, with Node's built-in test runner.
//
// Usage:
//   node tools/run-tests.mjs [filter]
//
// - Finds the test files itself, so it works on any Node version. `node --test "tools/**/..."`
//   needs Node 21 or later to expand the glob, and this PC runs Node 20 (Tattoogenda's pin).
// - [filter] runs only the files whose path contains that text, for example `workspace-app`.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, '..');

function fail(msg) {
  console.error(`run-tests: ${msg}`);
  process.exit(1);
}

function findTests(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) findTests(full, out);
    else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: node tools/run-tests.mjs [filter]');
  process.exit(0);
}
if (args.length > 1) fail(`unexpected argument "${args[1]}"`);
const filter = args[0] || '';

const files = findTests(toolsDir)
  .map(f => relative(root, f).split(sep).join('/'))
  .filter(f => f.includes(filter))
  .sort();
if (!files.length) fail(`no test files${filter ? ` matching "${filter}"` : ''} under tools/`);

// spec: the readable report, also when the output is piped (the workspace app shows it).
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit' });
if (r.error) fail(`could not start node: ${r.error.message}`);
process.exit(r.status ?? 1);
