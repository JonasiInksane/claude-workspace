// PreToolUse hook for headless CHECK and EDIT stages: Bash may run tg-check and nothing else.
//
//   node guard.mjs <stageDir>\guard.json      (exec form, from the stage settings' hooks)
//
// Claude Code sends the hook input as JSON on stdin. A tool other than Bash is allowed with no
// output. A Bash command is denied unless it is a plain `tg-check <args>` with safe characters
// only, a known subcommand, no shell operators, no secret file names, no `..` segments, no
// absolute path outside the tree and no path of the run folder, the main checkout, the hub or
// the data folder. Deny rules are no barrier for Bash (spike A8: grep -r, `cat .en?` and
// git grep printed a canary), so this is a strict allowlist.
//
// A denial prints permissionDecision "deny" as JSON and exits 0 (spike A7: that beats an allow
// rule, and unlike exit 2 it doesn't echo the hook's command line to Claude). Every failure
// inside the guard (bad input, missing or broken guard.json, a stuck stdin) also denies.
// Each decision is logged to guard.log.jsonl next to guard.json, which proves the hook ran.
// This file imports only node: built-ins on purpose: if the hook can't start, Claude Code treats
// that as a non-blocking error and the command would run, so nothing here may fail to load.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DENY_REASON = 'Only tg-check runs here: tg-check test <path> | types <workspace> | lint <files>.';
export const BACKGROUND_REASON = 'tg-check runs in the foreground here; run it again without run_in_background.';
export const COMMAND_RE = /^tg-check(?: [A-Za-z0-9_./:@=,+-]+)*$/;
export const META = Object.freeze([';', '&', '|', '`', '$(', '>', '<', '\n', '\r']);
export const MAX_COMMAND_CHARS = 4000;
export const LOG_FILE = 'guard.log.jsonl';
const STDIN_TIMEOUT_MS = 5000;

const deny = (reason = DENY_REASON) => ({ decision: 'deny', reason });
const ALLOW = Object.freeze({ decision: 'allow', reason: '' });

// A path in lowercase forward-slash form with a c:/ drive, so C:\x, c:/x and /c/x compare equal.
export function pathKey(p) {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const posixDrive = /^\/([a-z])(\/|$)/.exec(s);
  if (posixDrive) s = `${posixDrive[1]}:/${s.slice(3)}`.replace(/\/$/, '');
  return s;
}

const isAbsArg = a => /^[A-Za-z]:/.test(a) || a.startsWith('/');
const inside = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);

// The spellings of a folder a command could contain: c:/x/y and /c/x/y.
function spellings(dir) {
  const k = pathKey(dir);
  const m = /^([a-z]):(\/.*)?$/.exec(k);
  return m ? [k, `/${m[1]}${m[2] || ''}`] : [k];
}

function validConfig(cfg) {
  return cfg && cfg.version === 1 && typeof cfg.tree === 'string' && cfg.tree
    && Array.isArray(cfg.forbiddenRoots) && Array.isArray(cfg.forbiddenNames) && Array.isArray(cfg.subcommands);
}

// The decision for one hook input: { decision: 'allow' | 'deny', reason }.
export function decide(input, cfg) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') return deny();
  if (input.tool_name !== 'Bash') return ALLOW;
  if (!validConfig(cfg)) return deny();
  const ti = input.tool_input || {};
  if (typeof ti.command !== 'string') return deny();
  if (ti.run_in_background) return deny(BACKGROUND_REASON);
  const command = ti.command.replace(/^ +| +$/g, '');
  if (command.length > MAX_COMMAND_CHARS) return deny();
  if (META.some(m => command.includes(m))) return deny();
  if (!COMMAND_RE.test(command)) return deny();
  const args = command.split(' ').slice(1);
  if (args.length && !cfg.subcommands.includes(args[0])) return deny();
  const lower = command.toLowerCase();
  if (cfg.forbiddenNames.some(n => typeof n === 'string' && n && lower.includes(n.toLowerCase()))) return deny();
  for (const root of cfg.forbiddenRoots) {
    if (spellings(root).some(s => s.length > 3 && lower.includes(s))) return deny();
  }
  const tree = pathKey(cfg.tree);
  for (const a of args.slice(1)) {
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    for (const v of [a, value]) {
      if (v.split('/').includes('..')) return deny();
      if (isAbsArg(v) && !inside(tree, pathKey(v))) return deny();
    }
  }
  return ALLOW;
}

export function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function readStdin(ms) {
  return new Promise(done => {
    let text = '';
    const timer = setTimeout(() => done(null), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { text += d; });
    process.stdin.on('end', () => { clearTimeout(timer); done(text); });
    process.stdin.on('error', () => { clearTimeout(timer); done(null); });
  });
}

function readConfig(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function log(cfgFile, input, result) {
  try {
    const row = {
      at: new Date().toISOString(),
      session: String(input?.session_id ?? '').slice(0, 64),
      toolUseId: String(input?.tool_use_id ?? '').slice(0, 64),
      tool: String(input?.tool_name ?? '').slice(0, 40),
      decision: result.decision,
      command: String(input?.tool_input?.command ?? '').slice(0, 300),
    };
    appendFileSync(join(dirname(cfgFile), LOG_FILE), JSON.stringify(row) + '\n');
  } catch { /* logging never changes the decision */ }
}

async function main() {
  const cfgFile = process.argv[2] ? resolve(process.argv[2]) : '';
  let input = null;
  let result = deny();
  try {
    const raw = await readStdin(STDIN_TIMEOUT_MS);
    try { input = raw === null ? null : JSON.parse(raw); } catch { input = null; }
    result = decide(input, cfgFile ? readConfig(cfgFile) : null);
  } catch {
    result = deny();
  }
  if (cfgFile) log(cfgFile, input, result);
  if (result.decision === 'deny') process.stdout.write(denyOutput(result.reason), () => process.exit(0));
  else process.exit(0);
}

// Run as the hook (not imported by a test). Both sides are compared as real paths, so a hub
// reached through a junction still runs main(): a guard that silently did nothing would let
// every command through.
const realOrSelf = p => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const self = realOrSelf(fileURLToPath(import.meta.url)).toLowerCase();
if (process.argv[1] && realOrSelf(resolve(process.argv[1])).toLowerCase() === self) main();
