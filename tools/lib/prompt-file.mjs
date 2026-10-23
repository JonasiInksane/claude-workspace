// A first prompt for a new Claude session, handed over in a temp file.
//
// The workspace app writes the file; tools/workspace-app/claude-prompt.mjs or
// tools/agent-session.mjs --prompt-file reads it, deletes it, and passes the prompt to claude as
// an argument from Node. Why not on the command line: Windows PowerShell 5.1 mangles double
// quotes inside arguments it passes to programs, and a prompt can contain anything. A project's
// rules (appendSystemPrompt) can too, so a session with rules always starts through this file,
// even one without a first prompt.
//
// File content (JSON):
//   { "prompt": "...", "readDirs": ["C:\\abs\\folder"], "readOnlyDirs": ["C:\\abs\\folder"], "launch": { ... } }
// The prompt may be empty only when the launch sets something: the session then starts without a
// first prompt. readDirs are folders outside the session's working folder that it may read
// without asking (for example a flow's reference images); they go into the session's --settings
// as permissions.additionalDirectories. readOnlyDirs (attached assets' folders, whose files must
// keep their recorded hashes) go there too, plus an Edit deny rule each (editDenyRule): an
// additional directory is a working directory, where acceptEdits and auto mode edit freely.
// launch (optional): { permissionMode, model, effort, allowedTools: [rule, ...], sessionId,
// resume, continueLast, settingsFile, appendSystemPrompt }. permissionMode, model and effort
// become --permission-mode, --model and --effort; allowedTools goes into the settings'
// permissions.allow (--allowedTools takes every following argument, so it would swallow the
// prompt). sessionId becomes --session-id (a new session with a known id, so the app can find it
// again), resume becomes --resume (an existing session), continueLast becomes -c (the folder's
// last session) and settingsFile becomes --settings; with readDirs or allowedTools as well, that
// file is merged with them into one settings file (promptSessionArgs), since claude reads one.
// appendSystemPrompt (at most 20,000 characters) becomes --append-system-prompt <text>. It is
// never part of launchArgs: that text only goes on a command line Node spawns
// (promptSessionArgs here, agent-session.mjs), never into a PowerShell command.
//
// Windows refuses a command line of 32,767 characters or more (spawn fails with ENAMETOOLONG), so
// writePromptFile refuses a prompt and system prompt text that would not fit together once quoted
// (COMMAND_TEXT_BUDGET).
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// Claude Code 2.1.307 (`claude --help`). bypassPermissions and dontAsk are left out on purpose:
// one skips every check, the other refuses everything not pre-approved in an interactive session.
export const PERMISSION_MODES = ['manual', 'plan', 'acceptEdits', 'auto'];
// A session id: claude --session-id needs a valid UUID.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIN = process.platform === 'win32';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// An alias (opus, sonnet, haiku, fable) or a full model name such as claude-opus-5-5 or sonnet[1m].
export const MODEL_RE = /^[A-Za-z0-9][\w.:\-[\]]{0,79}$/;
// A permission rule: Read, mcp__server__tool, Bash(npm test:*), WebFetch(domain:example.com).
export const TOOL_RULE_RE = /^[A-Za-z][\w-]*(\([^()\r\n"]{1,200}\))?$/;
export const MAX_TOOL_RULES = 20;
// --append-system-prompt text: a project's rules (workspace-app/project-settings.mjs).
export const MAX_APPEND_SYSTEM_PROMPT = 20000;
// What the prompt and the system prompt text may take together, quoted as Node quotes them, of a
// Windows command line (which must stay under 32,767 characters); the rest is room for claude's
// path, the flags and the settings file.
export const COMMAND_TEXT_BUDGET = 30000;

export const promptDir = () => join(tmpdir(), 'claude-workspace', 'prompts');

// How many characters `arg` takes on a Windows command line as Node (libuv's quote_cmd_arg)
// writes it: as it is without spaces, tabs or quotes; otherwise in quotes, with a backslash
// before every '"' and every backslash doubled that comes right before a '"' or the end.
export function quotedLength(arg) {
  const s = String(arg);
  if (!s) return 2;
  if (!/[ \t"]/.test(s)) return s.length;
  let n = s.length + 2;
  let beforeQuote = true; // the closing quote
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === '"') { n += 1; beforeQuote = true; } else if (s[i] === '\\') { if (beforeQuote) n += 1; } else beforeQuote = false;
  }
  return n;
}

// Splits "Read, Grep Bash(git log *)" into rules: commas, spaces and newlines separate rules,
// except inside parentheses.
export function splitToolRules(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,\s]/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Checks launch options. Returns { error, launch } with empty values left out.
export function checkLaunch(input = {}) {
  const launch = {};
  const s = k => String((input && input[k]) ?? '').trim();
  if (s('permissionMode')) {
    if (!PERMISSION_MODES.includes(s('permissionMode'))) return { error: `permission mode must be one of ${PERMISSION_MODES.join(', ')}`, launch };
    launch.permissionMode = s('permissionMode');
  }
  if (s('model')) {
    if (!MODEL_RE.test(s('model'))) return { error: 'model must be an alias such as opus or sonnet, or a full model name', launch };
    launch.model = s('model');
  }
  if (s('effort')) {
    if (!EFFORTS.includes(s('effort'))) return { error: `effort must be one of ${EFFORTS.join(', ')}`, launch };
    launch.effort = s('effort');
  }
  const rules = Array.isArray(input && input.allowedTools) ? input.allowedTools.map(String) : splitToolRules(s('allowedTools'));
  if (rules.length > MAX_TOOL_RULES) return { error: `at most ${MAX_TOOL_RULES} pre-approved tools`, launch };
  const bad = rules.find(r => !TOOL_RULE_RE.test(r));
  if (bad) return { error: `"${bad}" is not a tool rule. Use names like Read or Bash(npm test:*)`, launch };
  if (rules.length) launch.allowedTools = rules;
  for (const k of ['sessionId', 'resume']) {
    if (!s(k)) continue;
    if (!UUID_RE.test(s(k))) return { error: `${k} must be a session id (a UUID such as 8c1e0a52-...)`, launch };
    launch[k] = s(k).toLowerCase();
  }
  // claude refuses --session-id together with --resume (unless it forks the session).
  if (launch.sessionId && launch.resume) return { error: 'start a new session (sessionId) or resume one (resume), not both', launch };
  const cont = input && input.continueLast;
  if (cont !== undefined && cont !== null && cont !== false) {
    if (cont !== true) return { error: 'continueLast must be true or false', launch };
    if (launch.sessionId || launch.resume) return { error: 'continue the last session or name one, not both', launch };
    launch.continueLast = true;
  }
  const extra = input && input.appendSystemPrompt;
  if (extra !== undefined && extra !== null && extra !== '') {
    if (typeof extra !== 'string') return { error: 'appendSystemPrompt must be text', launch };
    if (extra.length > MAX_APPEND_SYSTEM_PROMPT) return { error: `appendSystemPrompt is longer than ${MAX_APPEND_SYSTEM_PROMPT} characters`, launch };
    if (extra.includes('\0')) return { error: 'appendSystemPrompt has a NUL character, which no program can take as an argument', launch };
    if (extra.trim()) launch.appendSystemPrompt = extra;
  }
  if (s('settingsFile')) {
    const f = s('settingsFile');
    const absolute = WIN ? /^[A-Za-z]:[\\/]/.test(f) : isAbsolute(f);
    if (!absolute || !/\.json$/i.test(f) || /[\0-\x1f"]/.test(f)) return { error: 'settingsFile must be the full path of a .json file on a local drive', launch };
    if (!isFile(f)) return { error: `the settings file ${f} does not exist`, launch };
    launch.settingsFile = f;
  }
  return { error: '', launch };
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// The claude flags for a checked launch, in this order: -c, --resume or --session-id,
// --permission-mode, --model, --effort, --settings. allowedTools is not a flag (see above), and
// appendSystemPrompt is left out on purpose: its text may only go on a command line that Node
// spawns (promptSessionArgs, agent-session.mjs), never into a PowerShell command.
export function launchArgs(launch = {}) {
  const args = [];
  if (launch.continueLast) args.push('-c');
  if (launch.resume) args.push('--resume', launch.resume);
  if (launch.sessionId) args.push('--session-id', launch.sessionId);
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
  if (launch.model) args.push('--model', launch.model);
  if (launch.effort) args.push('--effort', launch.effort);
  if (launch.settingsFile) args.push('--settings', launch.settingsFile);
  return args;
}

// Merges settings objects into a new one: objects merge key by key, arrays keep every entry of
// every layer once (so deny rules and readable folders add up), and for plain values the later
// layer wins.
export function mergeSettings(...layers) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b].map(x => JSON.stringify(x)))].map(x => JSON.parse(x));
    if (isObj(a) && isObj(b)) {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    }
    return b === undefined ? a : b;
  };
  return layers.filter(isObj).reduce((acc, l) => merge(acc, l), {});
}

// The permission rule that keeps a session from changing anything inside the absolute folder
// `dir`: "Edit(//c/ws/inbox/attachments/_assets/logo/**)". Claude Code 2.1.309, checked against
// https://code.claude.com/docs/en/permissions ("Read and Edit"): Read and Edit rules are
// gitignore patterns, "//path" is absolute from the filesystem root, and on Windows a path is
// normalized to POSIX form before matching ("C:\Users\alice becomes /c/Users/alice"). An Edit
// rule covers every built-in tool that edits files (a Write(path) rule never matches anything),
// and a deny rule holds in every permission mode. It does not stop a script that writes files
// itself; verifyFiles still catches a changed file at the next start. The pattern characters
// * ? [ ] and \ in a folder name are escaped so the rule names that folder only; parentheses need
// no escaping. Throws for a Windows path without a drive letter (a network share): the docs give
// no form for it, and such a folder can't be a working directory anyway.
export function editDenyRule(dir, platform = process.platform) {
  const d = String(dir ?? '');
  let path;
  if (platform === 'win32') {
    const m = /^([A-Za-z]):[\\/]/.exec(d);
    if (!m) throw new Error(`${d} is not a folder on a drive letter, so a session can't be kept from editing it`);
    path = `${m[1].toLowerCase()}/${win32.normalize(d).slice(3).replace(/\\/g, '/')}`;
  } else {
    if (!d.startsWith('/')) throw new Error(`${d} is not an absolute folder path`);
    path = posix.normalize(d).slice(1);
  }
  return `Edit(//${path.replace(/\/+$/, '').replace(/[\\*?[\]]/g, '\\$&')}/**)`;
}

// The claude arguments for a session started from a prompt file (takePromptFile's result):
// { args, settings, settingsPath }. When readDirs and readOnlyDirs
// (permissions.additionalDirectories, plus permissions.deny for the read-only ones) or
// allowedTools (permissions.allow) need a settings file, `settings` is its JSON text and
// `settingsPath` where the caller writes it (in args after --settings); the launch's
// settingsFile, when there is one, is merged in: its own values win and its arrays add up.
// Otherwise settings is null and a settingsFile is passed as it is. --append-system-prompt and
// its text follow; the prompt, when there is one, comes last.
export function promptSessionArgs({ prompt = '', readDirs = [], readOnlyDirs = [], launch = {} }) {
  const { settingsFile, appendSystemPrompt, ...flags } = launch;
  const args = launchArgs(flags);
  const permissions = {};
  const dirs = [...new Set([...readDirs, ...readOnlyDirs])];
  if (dirs.length) permissions.additionalDirectories = dirs;
  if (flags.allowedTools && flags.allowedTools.length) permissions.allow = flags.allowedTools;
  if (readOnlyDirs.length) permissions.deny = readOnlyDirs.map(d => editDenyRule(d));
  let settings = null;
  let settingsPath = '';
  if (Object.keys(permissions).length) {
    let fromFile = {};
    if (settingsFile) {
      try { fromFile = JSON.parse(readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')); } catch (e) {
        throw new Error(`the settings file ${settingsFile} could not be read: ${e.message}`);
      }
    }
    settings = JSON.stringify(mergeSettings({ permissions }, fromFile), null, 2) + '\n';
    // Named by its content, so starting the same flow again reuses the file.
    settingsPath = join(promptDir(), `read-dirs-${createHash('sha1').update(settings).digest('hex').slice(0, 12)}.json`);
    args.push('--settings', settingsPath);
  } else if (settingsFile) args.push('--settings', settingsFile);
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (prompt) args.push(...promptArgs(prompt));
  return { args, settings, settingsPath };
}

// True when a launch sets anything (a prompt file without a prompt needs that).
const setsSomething = launch => Object.values(launch || {}).some(v => v !== undefined && v !== null && v !== '' && v !== false &&
  !(Array.isArray(v) && !v.length));

// The problem with handing this prompt and launch to claude on one Windows command line, or ''.
export function commandTextProblem(prompt, launch = {}) {
  const text = typeof prompt === 'string' && prompt.trim() ? prompt : '';
  const extra = launch && typeof launch.appendSystemPrompt === 'string' ? launch.appendSystemPrompt : '';
  const used = (text ? quotedLength(text) : 0) + (extra ? quotedLength(extra) : 0);
  if (used <= COMMAND_TEXT_BUDGET) return '';
  return `the prompt and the project rules are too long for one Windows command line: ${used} characters once quoted, ` +
    `at most ${COMMAND_TEXT_BUDGET}. Shorten the prompt or the project rules`;
}

// Writes the file and returns its path. Throws, before writing, when the prompt and the rules
// would not fit on one Windows command line (commandTextProblem), or a read-only folder can't
// get its deny rule (editDenyRule).
export function writePromptFile({ prompt = '', readDirs = [], readOnlyDirs = [], launch = {} }) {
  const problem = commandTextProblem(prompt, launch);
  if (problem) throw new Error(problem);
  for (const d of readOnlyDirs) editDenyRule(d);
  mkdirSync(promptDir(), { recursive: true });
  const file = join(promptDir(), `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ prompt, readDirs, readOnlyDirs, launch }), 'utf8');
  return file;
}

// Reads the file and, when it is valid and in promptDir(), deletes it (a prompt is used once;
// a file named by mistake, such as a settings file, is never deleted). Throws with a plain
// message when it is missing or malformed. An empty prompt comes back as '' (no first prompt),
// which is valid only when the launch sets something.
export function takePromptFile(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`could not read the prompt file: ${e.message}`); }
  const given = data && typeof data.prompt === 'string' ? data.prompt : '';
  const prompt = given.trim() ? given : '';
  const dirList = k => (data && Array.isArray(data[k]) ? data[k] : []);
  const readDirs = dirList('readDirs');
  const readOnlyDirs = dirList('readOnlyDirs');
  for (const [k, list] of [['readDirs', readDirs], ['readOnlyDirs', readOnlyDirs]]) {
    if (!list.every(d => typeof d === 'string' && isAbsolute(d))) throw new Error(`${k} must be absolute folder paths`);
  }
  for (const d of readOnlyDirs) editDenyRule(d);
  const { error, launch } = checkLaunch((data && data.launch) || {});
  if (error) throw new Error(`launch: ${error}`);
  if (!prompt && !setsSomething(launch)) throw new Error('the prompt is empty');
  const rel = relative(promptDir(), resolve(file));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
  return { prompt, readDirs, readOnlyDirs, launch };
}

// The prompt as claude's last argument. "--" ends the options, so a prompt that starts with
// "-" stays a prompt.
export const promptArgs = prompt => (prompt.startsWith('-') ? ['--', prompt] : [prompt]);
