// Claude Code's stream-json output, turned into timeline rows, plus the checks on what a run
// reported about itself (the init event, usage limits, login problems).
//
// `claude -p --output-format stream-json --verbose` writes one JSON event per line. The events
// seen on 2.1.307 (spike A14):
//   system/init               the session's real setup; checked by checkInit before any work
//   system/session_title_changed  comes before init when -n is passed, so init isn't line 1
//   system/thinking_tokens, assistant thinking blocks   counted, no row
//   system/task_started       "Background task started"
//   system/permission_denied  some denials only; hook and Read-rule denials show up as
//                             tool_result_meta permission_decision "reject" instead
//   system/api_retry          an info row
//   assistant                 text and tool_use blocks
//   user                      tool_result blocks (ok = !is_error) and synthetic text, such as
//                             the [structured-output-enforce] reminder
//   rate_limit_event          kept as state.rateLimit, no row (A12); rateLimitSummary words it
//   result                    success, error_max_turns, error_max_budget_usd ...
//   tool_progress             no row, only activity
// Anything else is counted in state.unknown and ignored.
//
// Turns: num_turns equals 1 per process plus one per user event that carries a tool_result or
// text (checked against every spike fixture). Unique assistant message ids undercount, because
// parallel tool calls share one id, so they are kept for information only.
//
// Every row text goes through `redact` before it is cut to size, so a secret Claude printed
// never reaches the timeline (R16).
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEADLESS_PROFILES } from './argv.mjs';

export const ALWAYS_PRESENT_TOOLS = Object.freeze([]);
export const STRUCTURED_TOOL = 'StructuredOutput';
export const MODEL_FAMILY_RE = /^claude-(opus|sonnet|haiku)-/;
export const MSG_MAX = 300;
export const TARGET_MAX = 120;
export const ENFORCE_MARK = '[structured-output-enforce]';
export const MAX_DENIALS = 50;
const REDACT_WINDOW = 4000;
const USAGE_RE = /usage limit|rate limit|\b429\b/i;
const LOGIN_RE = /not logged in|please run \/login|invalid api key|oauth/i;

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Two paths name the same folder: resolved, case-insensitive on Windows, then by real path.
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const norm = p => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  if (norm(a) === norm(b)) return true;
  try { return norm(realpathSync.native(a)) === norm(realpathSync.native(b)); } catch { return false; }
}

// A path made relative to the working folder when it lies inside it, with forward slashes.
function relativeTo(value, cwd) {
  const v = String(value);
  if (!cwd) return v;
  const base = String(cwd).replace(/[\\/]+$/, '');
  const head = v.slice(0, base.length + 1);
  const sepOk = /[\\/]/.test(head.slice(-1));
  const same = process.platform === 'win32' ? head.slice(0, -1).toLowerCase() === base.toLowerCase() : head.slice(0, -1) === base;
  return same && sepOk ? v.slice(base.length + 1).replace(/\\/g, '/') : v;
}

// What a tool call works on, for the row text: file_path, path, pattern or command (a Grep with
// both shows "pattern in path"), relative to the working folder, at most TARGET_MAX characters.
export function toolTarget(input, cwd, redact = s => s) {
  if (!isObj(input)) return '';
  let t = '';
  if (typeof input.file_path === 'string') t = relativeTo(input.file_path, cwd);
  else if (typeof input.pattern === 'string' && typeof input.path === 'string') t = `${input.pattern} in ${relativeTo(input.path, cwd)}`;
  else if (typeof input.path === 'string') t = relativeTo(input.path, cwd);
  else if (typeof input.pattern === 'string') t = input.pattern;
  else if (typeof input.command === 'string') t = input.command;
  return cut(oneLine(redact(t.slice(0, REDACT_WINDOW))), TARGET_MAX);
}

// The parts of a run's init that go into the stage result.
export function summarizeInit(init) {
  if (!isObj(init)) return { model: null, permissionMode: null, tools: [], cwd: null, ccVersion: null };
  return {
    model: init.model ?? null, permissionMode: init.permissionMode ?? null,
    tools: Array.isArray(init.tools) ? [...init.tools] : [], cwd: init.cwd ?? null, ccVersion: init.claude_code_version ?? null,
  };
}

// What a stage's init must show, from its spec (argv.mjs).
export function expectedInitFor(spec) {
  const p = HEADLESS_PROFILES[spec.profile];
  return { mode: p.mode, model: spec.model, tools: [...p.tools], cwd: spec.cwd, schema: !!spec.schema, addDirs: [...(spec.addDirs || [])] };
}

// The family of a resolved model id (claude-opus-5-5 -> opus); '' for anything else (A4).
const familyOf = model => {
  const m = MODEL_FAMILY_RE.exec(String(model ?? '').toLowerCase());
  return m ? m[1] : '';
};
const bare = model => String(model ?? '').toLowerCase().replace(/\[[^\]]*\]$/, '');

// The model check: an alias (opus, sonnet, haiku) is compared by family, a full id exactly.
function modelProblem(want, got) {
  const w = bare(want);
  if (!got) return `asked for ${want}, got no model`;
  if (w.startsWith('claude-')) return bare(got) === w ? '' : `asked for ${want}, got ${got}`;
  const fam = familyOf(got);
  return fam === w ? '' : `asked for ${want}, got ${fam || got}`;
}

// Compares a run's init event with what the stage asked for. Returns { ok, problems }, where each
// problem reads like "asked for opus, got sonnet".
// expected: { mode, model, tools, cwd, schema: bool, addDirs }
export function checkInit(init, expected) {
  if (!isObj(init)) return { ok: false, problems: ['Claude did not report its setup'] };
  const problems = [];
  const wantMode = expected.mode === 'manual' ? 'default' : expected.mode;
  if (init.permissionMode !== wantMode) {
    const got = init.permissionMode === 'default' ? 'manual' : init.permissionMode;
    problems.push(`asked for ${expected.mode} mode, got ${got || 'no mode'}`);
  }
  const m = modelProblem(expected.model, init.model);
  if (m) problems.push(m);
  const want = new Set([...expected.tools, ...(expected.schema ? [STRUCTURED_TOOL] : []), ...ALWAYS_PRESENT_TOOLS]);
  const got = Array.isArray(init.tools) ? init.tools.map(String) : [];
  const missing = [...want].filter(t => !got.includes(t));
  const mcpTools = got.filter(t => t.startsWith('mcp__'));
  const extra = got.filter(t => !want.has(t) && !t.startsWith('mcp__'));
  if (missing.length) problems.push(`missing tools ${missing.join(', ')}`);
  if (mcpTools.length) problems.push(`${mcpTools.length} MCP tool${mcpTools.length === 1 ? ' is' : 's are'} loaded (${mcpTools[0]}${mcpTools.length > 1 ? ' …' : ''})`);
  if (extra.length) problems.push(`unexpected tools ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`);
  if (Array.isArray(init.mcp_servers) && init.mcp_servers.length) {
    problems.push(`MCP servers are connected (${init.mcp_servers.map(s => (isObj(s) ? s.name : String(s))).join(', ')})`);
  }
  if (!samePath(init.cwd, expected.cwd)) problems.push(`working folder is ${init.cwd || 'unknown'}, not ${expected.cwd}`);
  const gotDirs = Array.isArray(init.additional_directories) ? init.additional_directories : [];
  const wantDirs = expected.addDirs || [];
  const extraDirs = gotDirs.filter(d => !wantDirs.some(w => samePath(d, w)));
  const missingDirs = wantDirs.filter(w => !gotDirs.some(d => samePath(d, w)));
  if (extraDirs.length) problems.push(`unexpected extra folders ${extraDirs.join(', ')}`);
  if (missingDirs.length) problems.push(`missing extra folders ${missingDirs.join(', ')}`);
  // --restricted fingerprints (spike E2): no project memory, the default output style.
  const mem = init.memory_paths;
  if (mem && (Array.isArray(mem) ? mem.length : isObj(mem) ? Object.keys(mem).length : true)) {
    problems.push('project memory is on, so --restricted did not take effect');
  }
  if (init.output_style !== undefined && init.output_style !== 'default') {
    problems.push(`output style is ${init.output_style}, so project settings were loaded`);
  }
  return { ok: problems.length === 0, problems };
}

// The error text of a result event: its errors list, and its result text when it is an error.
export function resultErrorText(result) {
  if (!isObj(result)) return '';
  const parts = [];
  if (Array.isArray(result.errors)) parts.push(...result.errors.map(String));
  if (result.is_error && typeof result.result === 'string') parts.push(result.result);
  return parts.join('\n');
}

const succeeded = r => isObj(r) && r.subtype === 'success' && !r.is_error;
// Result subtypes that say why the run ended: never a usage limit or a login problem.
const SELF_EXPLAINED = new Set(['error_max_turns', 'error_max_budget_usd']);
// Result subtypes Claude Code reports; an error result of one of these carries its cause in its
// own text (a usage limit comes back as subtype success, is_error true).
const KNOWN_SUBTYPES = new Set(['success', ...SELF_EXPLAINED]);
const selfExplained = r => isObj(r) && SELF_EXPLAINED.has(r.subtype);
// Whether API-retry rows, error rows and stderr may speak for the run: only when there is no
// result, or it is an error of a kind that doesn't say why. A 429 that Claude Code retried and
// got past still leaves its retry row behind, and stderr can mention anything.
const sideChannelsCount = r => !isObj(r) || !KNOWN_SUBTYPES.has(r.subtype);

// A usage or rate limit stopped the run (A12). Only error text counts (the result's errors, and
// when the result doesn't say why: error rows, API-retry rows and stderr), never Claude's own
// words: a review of rate-limit code must not pause a run. A result that ended on its own cap
// (error_max_turns, error_max_budget_usd) is never a usage limit.
// opts: { stderr, rateLimit } (the normalizer's state.rateLimit).
export function isUsageLimit(result, rows = [], { stderr = '', rateLimit = null } = {}) {
  if (succeeded(result) || selfExplained(result)) return false;
  if (isObj(result) && Number(result.api_error_status) === 429) return true;
  if (isObj(rateLimit) && rateLimit.status === 'rejected') return true;
  const texts = [resultErrorText(result)];
  if (sideChannelsCount(result)) {
    texts.push(String(stderr || ''));
    for (const r of rows || []) if (r && (r.kind === 'error' || r.src === 'api_retry')) texts.push(String(r.msg || ''));
  }
  return texts.some(t => USAGE_RE.test(t));
}

// Claude could not log in: the result's error text says so, or stderr does when the result
// doesn't say why the run ended (or there is none).
export function isLoginProblem(result, stderr = '') {
  if (succeeded(result) || selfExplained(result)) return false;
  if (LOGIN_RE.test(resultErrorText(result))) return true;
  return sideChannelsCount(result) && LOGIN_RE.test(String(stderr || ''));
}

// The line the run meters and Today show for the latest rate_limit_event (A12), such as
// "Usage, 5-hour window: 42% (resets 14:00)". '' when nothing was reported. resetsAt is in
// seconds since 1970 (as Claude Code sends it); the time is shown in this PC's time zone.
export function rateLimitSummary(rateLimit) {
  if (!isObj(rateLimit) || typeof rateLimit.utilization !== 'number' || !Number.isFinite(rateLimit.utilization)) return '';
  const pct = Math.round(Math.max(0, rateLimit.utilization) * 100);
  const at = Number(rateLimit.resetsAt);
  let resets = '';
  if (Number.isFinite(at) && at > 0) {
    const d = new Date(at < 1e11 ? at * 1000 : at);
    resets = ` (resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
  }
  const limited = rateLimit.status === 'rejected' ? ', limit reached' : '';
  return `Usage, 5-hour window: ${pct}%${resets}${limited}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

// A normalizer for one stage attempt. push(line) takes one stdout line and returns the timeline
// rows it produces; `state` is the running summary:
//   { init, inits, sessionId, title, messageIds: Set, turns, procTurns, result, results, denials,
//     unknown: {type: n}, lastActivityAt, lastType, rateLimit, toolUses, thinking }
// turns counts across processes (a resume adds one), procTurns only since the last init.
export function createNormalizer({ stage = '', attempt = 1, redact = s => s, now = () => Date.now() } = {}) {
  const state = {
    init: null, inits: 0, sessionId: null, title: '', messageIds: new Set(), turns: 0, procTurns: 0,
    result: null, results: [], denials: [], unknown: {}, lastActivityAt: null, lastType: '', rateLimit: null,
    toolUses: 0, thinking: 0,
  };
  const tools = new Map();
  const deniedIds = new Set();
  const clean = (s, max = MSG_MAX) => cut(oneLine(redact(String(s ?? '').slice(0, REDACT_WINDOW))), max);
  const row = (kind, msg, extra = {}) => ({
    t: new Date(now()).toISOString(), kind, stage, attempt, turn: state.turns, msg: clean(msg), ...extra,
  });
  const count = type => { state.unknown[type] = (state.unknown[type] || 0) + 1; };
  const cwd = () => (state.init && state.init.cwd) || '';

  function addDenial(id, name, input) {
    if (state.denials.some(d => d.id && d.id === id)) return;
    if (state.denials.length >= MAX_DENIALS) return;
    const safe = {};
    if (isObj(input)) for (const [k, v] of Object.entries(input)) if (typeof v === 'string') safe[k] = clean(v);
    state.denials.push({ tool: String(name || '?'), input: safe, id: id || '' });
  }

  function onSystem(ev) {
    switch (ev.subtype) {
      case 'init': {
        state.init = ev;
        state.inits += 1;
        state.sessionId = ev.session_id || state.sessionId;
        state.turns += 1;
        state.procTurns = 1;
        const toolList = Array.isArray(ev.tools) ? ev.tools.join(', ') : '';
        const mode = ev.permissionMode === 'default' ? 'manual' : ev.permissionMode;
        return [row('info', `Claude started: ${ev.model || 'unknown model'}, ${mode || 'unknown'} mode, tools ${toolList || 'none'} (Claude Code ${ev.claude_code_version || '?'})`)];
      }
      case 'session_title_changed':
        state.title = String(ev.title || '');
        return [];
      case 'thinking_tokens':
        return [];
      case 'task_started': {
        const what = ev.description ? `: ${ev.description}` : '';
        return [row('info', `${ev.is_backgrounded === false ? 'Task' : 'Background task'} started${what}`)];
      }
      case 'permission_denied': {
        const known = tools.get(ev.tool_use_id) || { name: ev.tool_name, target: '', input: null };
        deniedIds.add(ev.tool_use_id);
        addDenial(ev.tool_use_id, known.name || ev.tool_name, known.input);
        const why = ev.decision_reason_type ? ` (${ev.decision_reason_type})` : '';
        return [row('deny', `Denied: ${known.name || ev.tool_name || 'a tool'} ${known.target}${why}`, {
          tool: { name: known.name || ev.tool_name || '', target: known.target, id: ev.tool_use_id || '', phase: 'end' }, ok: false,
        })];
      }
      case 'api_retry': {
        const n = ev.attempt ? ` ${ev.attempt}${ev.max_retries ? ` of ${ev.max_retries}` : ''}` : '';
        const err = ev.error_status || ev.error ? `: ${[ev.error_status, typeof ev.error === 'string' ? ev.error : ''].filter(Boolean).join(' ')}` : '';
        return [row('info', `Claude's API call failed; retry${n}${err}`, { src: 'api_retry' })];
      }
      default:
        count(`system/${ev.subtype}`);
        return [];
    }
  }

  function onAssistant(ev) {
    const msg = isObj(ev.message) ? ev.message : {};
    if (msg.id) state.messageIds.add(msg.id);
    const rows = [];
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(block)) continue;
      if (block.type === 'text') {
        const text = clean(block.text, MSG_MAX - 2);
        if (text) rows.push(row('text', `"${text}"`));
      } else if (block.type === 'tool_use') {
        state.toolUses += 1;
        const name = String(block.name || '?');
        const target = name === 'StructuredOutput' ? '' : toolTarget(block.input, cwd(), redact);
        tools.set(block.id, { name, target, input: block.input });
        const label = name === 'StructuredOutput' ? 'StructuredOutput (the stage result)' : `${name} ${target}`;
        rows.push(row('tool', label, { tool: { name, target, id: String(block.id || ''), phase: 'start' }, ok: null }));
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        state.thinking += 1;
      } else {
        count(`assistant/${block.type}`);
      }
    }
    return rows;
  }

  function onUser(ev) {
    const content = isObj(ev.message) ? ev.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const metas = Array.isArray(ev.tool_result_meta) ? ev.tool_result_meta : [];
    const rows = [];
    let turn = false;
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'tool_result') {
        turn = true;
        const id = block.tool_use_id;
        const known = tools.get(id) || { name: '?', target: '', input: null };
        const meta = metas.find(m => isObj(m) && m.id === id);
        const decision = meta && isObj(meta.permission_decision) ? meta.permission_decision : null;
        const tool = { name: known.name, target: known.target, id: String(id || ''), phase: 'end' };
        if (decision && decision.decision === 'reject') {
          addDenial(id, known.name, known.input);
          if (!deniedIds.has(id)) {
            deniedIds.add(id);
            const by = decision.source === 'hook' ? ' (guard hook)' : decision.reason_type ? ` (${decision.reason_type})` : '';
            rows.push(row('deny', `Denied: ${known.name} ${known.target}${by}`, { tool, ok: false }));
          }
        } else {
          const ok = !block.is_error;
          const detail = ok ? '' : `: ${textOf(block.content).split('\n')[0]}`;
          rows.push(row('tool', `${known.name} ${known.target}${ok ? '' : ' failed'}${detail}`, { tool, ok }));
        }
      } else if (block.type === 'text') {
        turn = true;
        if (String(block.text || '').startsWith(ENFORCE_MARK)) rows.push(row('info', 'Claude Code reminded Claude to return the structured result'));
      }
    }
    if (turn) {
      state.turns += 1;
      state.procTurns += 1;
    }
    return rows;
  }

  function onResult(ev) {
    state.result = ev;
    state.results.push(ev);
    for (const d of Array.isArray(ev.permission_denials) ? ev.permission_denials : []) {
      if (isObj(d)) addDenial(d.tool_use_id, d.tool_name, d.tool_input);
    }
    const turns = Number.isFinite(ev.num_turns) ? `${ev.num_turns} turn${ev.num_turns === 1 ? '' : 's'}` : 'unknown turns';
    const cost = typeof ev.total_cost_usd === 'number' ? `, ≈$${ev.total_cost_usd.toFixed(2)} API-equiv.` : '';
    let msg;
    if (succeeded(ev)) msg = `Finished: ${turns}${cost}`;
    else if (ev.subtype === 'error_max_turns') msg = `Stopped at the turn limit: ${turns}${cost}`;
    else if (ev.subtype === 'error_max_budget_usd') msg = `Stopped by the budget backstop: ${turns}${cost}`;
    // Claude Code ends some API errors (a bad key, the usage limit) with subtype "success" and
    // is_error: that reads as an error, not a success.
    else if (ev.is_error) msg = `Ended with an error${ev.subtype && ev.subtype !== 'success' ? ` (${ev.subtype})` : ''}: ${resultErrorText(ev) || turns}`;
    else msg = `Ended with ${ev.subtype || 'no subtype'}: ${resultErrorText(ev) || turns}`;
    return [row('result', msg, { subtype: ev.subtype || '', ok: succeeded(ev) })];
  }

  function onRateLimit(ev) {
    const info = isObj(ev.rate_limit_info) ? ev.rate_limit_info : {};
    const five = isObj(info.unifiedWindows) && isObj(info.unifiedWindows.five_hour) ? info.unifiedWindows.five_hour : {};
    const seven = isObj(info.unifiedWindows) && isObj(info.unifiedWindows.seven_day) ? info.unifiedWindows.seven_day : {};
    state.rateLimit = {
      status: info.status ?? null, type: info.rateLimitType ?? null,
      utilization: typeof five.utilization === 'number' ? five.utilization : null,
      resetsAt: five.resetsAt ?? info.resetsAt ?? null,
      sevenDayUtilization: typeof seven.utilization === 'number' ? seven.utilization : null,
    };
  }

  function push(line) {
    const text = typeof line === 'string' ? line.trim() : '';
    if (!text) return [];
    let ev;
    try { ev = JSON.parse(text); } catch { ev = null; }
    if (!isObj(ev)) {
      count('(unparsed)');
      state.lastType = '(unparsed)';
      return [];
    }
    state.lastActivityAt = now();
    state.lastType = ev.type === 'system' ? `system/${ev.subtype}` : String(ev.type);
    switch (ev.type) {
      case 'system': return onSystem(ev);
      case 'assistant': return onAssistant(ev);
      case 'user': return onUser(ev);
      case 'result': return onResult(ev);
      case 'rate_limit_event': onRateLimit(ev); return [];
      case 'tool_progress': return [];
      default: count(String(ev.type)); return [];
    }
  }

  return { push, state };
}
