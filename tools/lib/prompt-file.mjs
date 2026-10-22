// A first prompt for a new Claude session, handed over in a temp file.
//
// The workspace app writes the file; tools/workspace-app/claude-prompt.mjs or
// tools/agent-session.mjs --prompt-file reads it, deletes it, and passes the prompt to claude as
// an argument from Node. Why not on the command line: Windows PowerShell 5.1 mangles double
// quotes inside arguments it passes to programs, and a prompt can contain anything.
//
// File content (JSON):
//   { "prompt": "...", "readDirs": ["C:\\abs\\folder"], "launch": { ... } }
// readDirs are folders outside the session's working folder that it may read without asking
// (for example a flow's reference images); they go into the session's --settings.
// launch (optional): { permissionMode, model, effort, allowedTools: [rule, ...], sessionId,
// resume, settingsFile }. permissionMode, model and effort become --permission-mode, --model and
// --effort; allowedTools goes into the settings' permissions.allow (--allowedTools takes every
// following argument, so it would swallow the prompt). sessionId becomes --session-id (a new
// session with a known id, so the app can find it again), resume becomes --resume (an existing
// session) and settingsFile becomes --settings; with readDirs or allowedTools as well, that file
// is merged with them into one settings file (promptSessionArgs), since claude reads one.
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

export const promptDir = () => join(tmpdir(), 'claude-workspace', 'prompts');

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

// The claude flags for a checked launch (allowedTools is not a flag; see above), in this order:
// --resume or --session-id, --permission-mode, --model, --effort, --settings.
export function launchArgs(launch = {}) {
  const args = [];
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

// The claude arguments for a session started from a prompt file (takePromptFile's result):
// { args, settings, settingsPath }. When readDirs (permissions.additionalDirectories) or
// allowedTools (permissions.allow) need a settings file, `settings` is its JSON text and
// `settingsPath` where the caller writes it (in args after --settings); the launch's
// settingsFile, when there is one, is merged in: its own values win and its arrays add up.
// Otherwise settings is null and a settingsFile is passed as it is. The prompt comes last.
export function promptSessionArgs({ prompt, readDirs = [], launch = {} }) {
  const { settingsFile, ...flags } = launch;
  const args = launchArgs(flags);
  const permissions = {};
  if (readDirs.length) permissions.additionalDirectories = readDirs;
  if (flags.allowedTools && flags.allowedTools.length) permissions.allow = flags.allowedTools;
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
  args.push(...promptArgs(prompt));
  return { args, settings, settingsPath };
}

export function writePromptFile({ prompt, readDirs = [], launch = {} }) {
  mkdirSync(promptDir(), { recursive: true });
  const file = join(promptDir(), `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ prompt, readDirs, launch }), 'utf8');
  return file;
}

// Reads the file and, when it is valid and in promptDir(), deletes it (a prompt is used once;
// a file named by mistake, such as a settings file, is never deleted). Throws with a plain
// message when it is missing or malformed.
export function takePromptFile(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`could not read the prompt file: ${e.message}`); }
  const prompt = data && typeof data.prompt === 'string' ? data.prompt : '';
  if (!prompt.trim()) throw new Error('the prompt is empty');
  const readDirs = Array.isArray(data.readDirs) ? data.readDirs : [];
  if (!readDirs.every(d => typeof d === 'string' && isAbsolute(d))) throw new Error('readDirs must be absolute folder paths');
  const { error, launch } = checkLaunch(data.launch || {});
  if (error) throw new Error(`launch: ${error}`);
  const rel = relative(promptDir(), resolve(file));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
  return { prompt, readDirs, launch };
}

// The prompt as claude's last argument. "--" ends the options, so a prompt that starts with
// "-" stays a prompt.
export const promptArgs = prompt => (prompt.startsWith('-') ? ['--', prompt] : [prompt]);
