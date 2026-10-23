// Per-project settings and rules from the app, kept as numbered versions in the private data
// folder (never in the public hub repo):
//
//   <dataDir>/projects/<project>/settings/v<N>.json      N = 1, 2, 3 ...; the highest is current
//
//   { "format": 1, "project": "example", "version": 3, "basedOn": 2, "savedAt": "<ISO>",
//     "rules": "<Markdown, at most 20000 characters>",
//     "defaults": { "model": "", "effort": "", "permissionMode": "" },
//     "allowedTools": "Read, Grep",
//     "assets": [ { "ref": "shared:style-guide", "pin": null } ],
//     "sha256": "<hex SHA-256 of the canonical JSON of rules, defaults, allowedTools and assets>" }
//
// - A version is written once and never changed. A save writes the next number through a
//   temporary file and a hard link, which fails when that name exists: two saves can't both write
//   v4, and a reader never sees half a file (writeOnce).
// - A save names the version it started from (basedOn; 0 or null for "none yet") and is refused
//   with 409 when that is no longer the current one; invalid settings are a 400 that lists every
//   problem; a save that changes nothing writes nothing. A field the save leaves out keeps its
//   current value, so an editor that doesn't know a field (an older page) can't wipe it.
// - Every version read is checked (format, project, number, fields, hash). A damaged or
//   hand-edited version is never used: the error names its file.
//
// Who uses them:
//   runs/store.mjs     a new run records { version, sha256 } of the current settings (settingsRef)
//   runs/executor.mjs  every Claude stage of that run gets that version's rules as a
//                      <project_instructions source="workspace-rules@v<N>"> block (rulesBlock)
//   launch.mjs         every session the app starts in a project gets the current settings
//                      (launchWithSettings): the rules as --append-system-prompt, followed by the
//                      list of its attached assets when it has no prompt of its own to list them
//                      in, the defaults where its launch leaves a value empty, the pre-approved
//                      tools added to its own
//   routes/project-settings.mjs   the API behind the Settings tab
// Attached assets are checked for their shape only here; attached-assets.mjs resolves them
// through the asset library (a module of its own) for runs and sessions.
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { EFFORTS, MAX_APPEND_SYSTEM_PROMPT, MAX_TOOL_RULES, MODEL_RE, PERMISSION_MODES, splitToolRules, TOOL_RULE_RE } from '../lib/prompt-file.mjs';
import { assetsSystemText } from './attached-assets.mjs';
import { canonicalJson, PROJECT_RE, sha256Text } from './core/datadir.mjs';
import { HttpError } from './http.mjs';
import { escapeInstructionTags } from './runs/prompts.mjs';

export const SETTINGS_FORMAT = 1;
export const SETTINGS_LIMITS = Object.freeze({ rules: 20000, assets: 50, assetRef: 200, problems: 20 });
export const DEFAULT_KEYS = Object.freeze(['model', 'effort', 'permissionMode']);
export const SETTINGS_FIELDS = Object.freeze(['rules', 'defaults', 'allowedTools', 'assets']);
// "shared:<asset>" or "<project>:<asset>", both in kebab-case.
export const ASSET_REF_RE = /^(shared|[a-z0-9]+(?:-[a-z0-9]+)*):[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_FILE_RE = /^v([1-9][0-9]{0,8})\.json$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Control characters other than tab and newline: no editor types them, and a NUL can't go into a
// program's arguments at all.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const emptyDefaults = () => ({ model: '', effort: '', permissionMode: '' });
const emptyFields = () => ({ rules: '', defaults: emptyDefaults(), allowedTools: '', assets: [] });
const fieldsOf = s => ({ rules: s.rules, defaults: s.defaults, allowedTools: s.allowedTools, assets: s.assets });

function checkProject(project) {
  if (!PROJECT_RE.test(String(project ?? ''))) {
    throw new HttpError(400, `"${String(project ?? '').slice(0, 80)}" can't have project settings: a project name is lowercase letters, digits and single hyphens`);
  }
  return project;
}

// The folder that holds one project's settings versions.
export function settingsDir(dataDir, project) {
  return join(resolve(dataDir), 'projects', checkProject(project), 'settings');
}
const versionFile = (dataDir, project, n) => join(settingsDir(dataDir, project), `v${n}.json`);

// What a version's hash covers: the canonical JSON (core/datadir.mjs) of its four fields.
export function settingsHash(settings) {
  return sha256Text(canonicalJson(fieldsOf(settings)));
}

// { version, sha256 } of saved settings, or null: what runs and sessions record.
export const settingsRef = settings => (settings ? { version: settings.version, sha256: settings.sha256 } : null);

// True for null or a { version, sha256 } a run can record.
export const isSettingsRef = ref => ref === null ||
  (isPlain(ref) && Number.isSafeInteger(ref.version) && ref.version >= 1 && SHA256_RE.test(String(ref.sha256)));

// ---------------------------------------------------------------- checking the fields

function rulesField(raw, problems) {
  if (raw === null) return '';
  if (typeof raw !== 'string') { problems.push('rules must be text'); return ''; }
  // trimEnd, not /\s+$/: that pattern backtracks over every long run of spaces inside the text.
  const text = raw.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (text.length > SETTINGS_LIMITS.rules) problems.push(`the rules are longer than ${SETTINGS_LIMITS.rules} characters (${text.length})`);
  const bad = CONTROL_RE.exec(text);
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    problems.push(`the rules have a control character (U+${code}) on line ${text.slice(0, bad.index).split('\n').length}; remove it`);
  }
  return text;
}

// A key the save leaves out keeps its value from `base`.
function defaultsField(raw, base, problems) {
  if (raw === null) return emptyDefaults();
  const out = { ...base };
  if (!isPlain(raw)) { problems.push('defaults must be an object with model, effort and permissionMode'); return out; }
  for (const k of Object.keys(raw)) if (!DEFAULT_KEYS.includes(k)) problems.push(`defaults.${k.slice(0, 60)} is not a setting (use ${DEFAULT_KEYS.join(', ')})`);
  for (const k of DEFAULT_KEYS) {
    if (raw[k] === undefined) continue;
    if (raw[k] !== null && typeof raw[k] !== 'string') { problems.push(`defaults.${k} must be text`); continue; }
    out[k] = String(raw[k] ?? '').trim();
  }
  if (out.model && !MODEL_RE.test(out.model)) problems.push('defaults.model must be empty, an alias such as opus or sonnet, or a full model name');
  if (out.effort && !EFFORTS.includes(out.effort)) problems.push(`defaults.effort must be empty or one of ${EFFORTS.join(', ')}`);
  if (out.permissionMode && !PERMISSION_MODES.includes(out.permissionMode)) {
    problems.push(`defaults.permissionMode must be empty or one of ${PERMISSION_MODES.join(', ')} (bypassPermissions and dontAsk are never used)`);
  }
  return out;
}

// The same rules as a flow's pre-approved tools (tools/lib/prompt-file.mjs), each kept once and
// stored as "Read, Grep".
function toolsField(raw, problems) {
  if (raw === null) return '';
  let rules;
  if (typeof raw === 'string') rules = splitToolRules(raw);
  else if (Array.isArray(raw) && raw.every(r => typeof r === 'string')) rules = raw.flatMap(r => splitToolRules(r));
  else { problems.push('allowedTools must be text such as "Read, Grep", or a list of rules'); return ''; }
  rules = [...new Set(rules)];
  if (rules.length > MAX_TOOL_RULES) problems.push(`allowedTools has ${rules.length} rules; at most ${MAX_TOOL_RULES}`);
  for (const r of rules.filter(x => !TOOL_RULE_RE.test(x))) {
    problems.push(`allowedTools: "${r.slice(0, 80)}" is not a tool rule. Use names like Read or Bash(npm test:*)`);
  }
  return rules.join(', ');
}

// Attached assets, by shape only: { ref: "shared:<id>" | "<this project>:<id>", pin: null | N }.
function assetsField(raw, project, problems) {
  if (raw === null) return [];
  if (!Array.isArray(raw)) { problems.push('assets must be a list'); return []; }
  if (raw.length > SETTINGS_LIMITS.assets) problems.push(`assets has ${raw.length} entries; at most ${SETTINGS_LIMITS.assets}`);
  const out = [];
  const seen = new Set();
  raw.forEach((a, i) => {
    const at = `assets[${i}]`;
    if (!isPlain(a)) { problems.push(`${at} must be an object with ref and pin`); return; }
    for (const k of Object.keys(a)) if (k !== 'ref' && k !== 'pin') problems.push(`${at}.${k.slice(0, 60)} is not an asset field (use ref and pin)`);
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    const m = ref.length <= SETTINGS_LIMITS.assetRef ? ASSET_REF_RE.exec(ref) : null;
    if (!m) problems.push(`${at}.ref must look like shared:<asset> or ${project}:<asset> (lowercase words joined by hyphens)`);
    else if (m[1] !== 'shared' && m[1] !== project) problems.push(`${at}.ref ${ref} belongs to another project; attach shared assets or ${project}'s own`);
    else if (seen.has(ref)) problems.push(`${at}.ref ${ref} is attached twice`);
    seen.add(ref);
    const pin = a.pin === undefined ? null : a.pin;
    if (pin !== null && !(Number.isSafeInteger(pin) && pin >= 1)) problems.push(`${at}.pin must be null (the latest version) or a version number from 1`);
    out.push({ ref, pin });
  });
  return out;
}

// Checks the fields of a save and fills in the ones it leaves out from `base` (the current
// settings, or null for the empty ones). Returns { value: { rules, defaults, allowedTools,
// assets }, problems: [sentence, ...] }.
export function checkSettingsInput(input, project, base = null) {
  checkProject(project);
  if (!isPlain(input)) return { value: null, problems: ['the settings must be sent as an object'] };
  const problems = [];
  for (const k of Object.keys(input)) if (!SETTINGS_FIELDS.includes(k)) problems.push(`"${k.slice(0, 60)}" is not a project setting (use ${SETTINGS_FIELDS.join(', ')})`);
  const b = base ? fieldsOf(base) : emptyFields();
  const value = {
    rules: input.rules === undefined ? b.rules : rulesField(input.rules, problems),
    defaults: input.defaults === undefined ? { ...b.defaults } : defaultsField(input.defaults, b.defaults, problems),
    allowedTools: input.allowedTools === undefined ? b.allowedTools : toolsField(input.allowedTools, problems),
    assets: input.assets === undefined ? b.assets.map(a => ({ ...a })) : assetsField(input.assets, project, problems),
  };
  return { value, problems };
}

function problemText(problems) {
  const max = SETTINGS_LIMITS.problems;
  const more = problems.length > max ? `; and ${problems.length - max} more` : '';
  return `The settings were not saved: ${problems.slice(0, max).join('; ')}${more}.`;
}

// ---------------------------------------------------------------- reading

// Why a stored version can't be used, or ''. A file passes only as the app writes it: the right
// format, project and number, fields that pass the checks unchanged, and a matching hash.
function storedProblem(data, project, n) {
  if (!isPlain(data)) return 'it is not a settings object';
  if (data.format !== SETTINGS_FORMAT) {
    return typeof data.format === 'number' && data.format > SETTINGS_FORMAT ? `it was saved by a newer version of the app (format ${data.format})` : 'it has no known format';
  }
  if (data.project !== project) return `it belongs to "${String(data.project).slice(0, 60)}"`;
  if (data.version !== n) return `it says it is v${String(data.version).slice(0, 12)}`;
  if (!(data.basedOn === null || (Number.isSafeInteger(data.basedOn) && data.basedOn >= 1 && data.basedOn < n))) return 'its basedOn is not an earlier version';
  if (typeof data.savedAt !== 'string' || Number.isNaN(Date.parse(data.savedAt))) return 'it has no save time';
  if (!SETTINGS_FIELDS.every(k => k in data)) return 'a field is missing';
  const { value, problems } = checkSettingsInput(fieldsOf(data), project);
  if (problems.length) return problems[0];
  if (canonicalJson(value) !== canonicalJson(fieldsOf(data))) return 'its fields are not in the form the app saves';
  if (data.sha256 !== settingsHash(data)) return 'its content does not match its hash (it was changed after it was saved)';
  return '';
}

function unusable(project, n, file, why) {
  return Object.assign(new Error(`The settings v${n} of ${project} can't be used: ${why}. The file is ${file}; move it out of that folder to go back to the version before it.`),
    { code: 'ESETTINGS' });
}

// One version as the app saved it (only the known keys), or null when the file isn't there.
// Throws when it is there but can't be used.
async function readVersion(dataDir, project, n) {
  const file = versionFile(dataDir, project, n);
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let data;
  // A byte order mark (Notepad, PowerShell 5.1) is dropped first.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try { data = JSON.parse(body); } catch (e) { throw unusable(project, n, file, `it is not valid JSON (${e.message})`); }
  const problem = storedProblem(data, project, n);
  if (problem) throw unusable(project, n, file, problem);
  const { format, version, basedOn, savedAt, rules, defaults, allowedTools, assets, sha256 } = data;
  return { format, project, version, basedOn, savedAt, rules, defaults: { ...defaults }, allowedTools, assets: assets.map(a => ({ ...a })), sha256 };
}

// The version numbers on disk, newest first.
async function versionNumbers(dataDir, project) {
  let names;
  try { names = await fsp.readdir(settingsDir(dataDir, project)); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  return names.map(name => VERSION_FILE_RE.exec(name)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => b - a);
}

const summary = s => ({ version: s.version, savedAt: s.savedAt, sha256: s.sha256, basedOn: s.basedOn });

// The current settings (the highest version), or null when the project has none. Throws when the
// current version can't be used: nothing may fall back to older rules without anyone noticing.
export async function currentSettings(dataDir, project) {
  for (const n of await versionNumbers(dataDir, project)) {
    const s = await readVersion(dataDir, project, n);
    if (s) return s; // null: the file went away since the folder was listed
  }
  return null;
}

// { current, versions: [{ version, savedAt, sha256, basedOn }] } newest first. An older version
// that can't be used is listed with `problem` (and null values) instead of failing the list.
export async function readSettings(dataDir, project) {
  let current = null;
  const versions = [];
  for (const n of await versionNumbers(dataDir, project)) {
    if (!current) {
      current = await readVersion(dataDir, project, n);
      if (current) versions.push(summary(current));
      continue;
    }
    try {
      const s = await readVersion(dataDir, project, n);
      if (s) versions.push(summary(s));
    } catch (e) {
      versions.push({ version: n, savedAt: null, sha256: null, basedOn: null, problem: e.message });
    }
  }
  return { current, versions };
}

// One version: 400 for a bad number, 404 when the project has no such version.
export async function getSettingsVersion(dataDir, project, n) {
  checkProject(project);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'a settings version is a number from 1');
  const s = await readVersion(dataDir, project, n);
  if (!s) throw new HttpError(404, `${project} has no settings v${n}`);
  return s;
}

// ---------------------------------------------------------------- saving

// Writes a file that must not exist yet, whole or not at all: the text goes to a temporary file
// next to it, which is then hard-linked to the final name. The link fails with EEXIST when the
// name is taken, so nothing is ever overwritten, and the name appears with the whole text at once.
// On a drive without hard links (FAT) the file is created exclusively ('wx') and written instead.
// The temporary file is removed either way. `fs` can be replaced in tests.
export async function writeOnce(file, text, { fs: io = fsp } = {}) {
  await io.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await io.writeFile(tmp, text, { flag: 'wx' });
    try {
      await io.link(tmp, file);
    } catch (e) {
      if (!e || e.code === 'EEXIST') throw e;
      await io.writeFile(file, text, { flag: 'wx' });
    }
  } finally {
    await io.rm(tmp, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
  return file;
}

// One save at a time per settings folder in this process (the hard link guards against others).
const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

function baseVersion(basedOn) {
  if (basedOn === null || basedOn === 0) return 0;
  if (Number.isSafeInteger(basedOn) && basedOn >= 1) return basedOn;
  if (basedOn === undefined) throw new HttpError(400, 'basedOn is missing: send the version you opened (0 or null when there were none)');
  throw new HttpError(400, 'basedOn must be the version you opened (a number from 1), or 0 or null when there were none');
}

function staleText(project, have, want) {
  if (!have) return `${project} has no saved settings, so there is no v${want} to build on. Reload them, then save again.`;
  return `The settings of ${project} changed since you opened them: v${have} is current now${want ? `, not v${want}` : ''}. Reload them, then save again.`;
}

// Saves `input` ({ rules, defaults, allowedTools, assets }; a field left out keeps its current
// value) as the next version and returns it. `basedOn` is the version the editor opened (0 or
// null: none). 409 when that is not the current one any more, 400 listing every problem, and
// the current settings unchanged (nothing written) when the save changes nothing. `check`
// (optional) runs on the settings a save would write ({ project, ...fields }) and returns the
// problems that refuse it with a 400 ([] for none): routes/project-settings.mjs passes
// launch.mjs settingsLaunchProblems, so a save can't write settings every session would refuse.
export async function saveSettings(dataDir, project, input, { basedOn, now = Date.now, check } = {}) {
  checkProject(project);
  const want = baseVersion(basedOn);
  const dir = settingsDir(dataDir, project);
  return serial(process.platform === 'win32' ? dir.toLowerCase() : dir, async () => {
    const current = await currentSettings(dataDir, project);
    const have = current ? current.version : 0;
    if (want !== have) throw new HttpError(409, staleText(project, have, want));
    const { value, problems } = checkSettingsInput(input, project, current);
    if (problems.length) throw new HttpError(400, problemText(problems));
    const sha256 = settingsHash(value);
    if (current && current.sha256 === sha256) return current;
    const refused = check ? await check({ project, ...value }) : [];
    if (refused.length) throw new HttpError(400, problemText(refused));
    const version = have + 1;
    const settings = {
      format: SETTINGS_FORMAT, project, version, basedOn: have || null, savedAt: new Date(now()).toISOString(), ...value, sha256,
    };
    try {
      await writeOnce(versionFile(dataDir, project, version), `${JSON.stringify(settings, null, 2)}\n`);
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new HttpError(409, `Another save of the settings of ${project} came first (v${version}). Reload them, then save again.`);
      throw e;
    }
    return settings;
  });
}

// ---------------------------------------------------------------- using them

// The rules of saved settings as one <project_instructions> block for a stage prompt, after
// CLAUDE.md and AGENTS.md (runs/prompts.mjs projectInstructions), or '' when there are none.
// The tags inside are escaped the way prompts.mjs escapes them, so the rules can neither close
// the block nor open one with another source.
export function rulesBlock(settings) {
  const rules = settings && typeof settings.rules === 'string' ? settings.rules.replace(/\r\n?/g, '\n') : '';
  if (!rules.trim()) return '';
  const v = settings.version;
  if (!Number.isSafeInteger(v) || v < 1) throw new Error('rulesBlock needs saved settings (with a version number).');
  return `<project_instructions source="workspace-rules@v${v}">\n${escapeInstructionTags(rules)}\n</project_instructions>`;
}

// A session's launch (tools/lib/prompt-file.mjs) with the project's settings applied: a default
// fills in only a model, effort or permission mode the launch leaves empty (a flow's own settings
// win), the project's pre-approved tools come after the launch's own (each once), and the rules
// become appendSystemPrompt. `assets` are the project's attached assets, resolved
// (attached-assets.mjs), for a session without a prompt of its own to list them in: their list
// follows the rules (assetsSystemText). Without settings or assets it is an unchanged copy. Throws
// when the tools come to more than MAX_TOOL_RULES together, or the rules and the asset list to
// more than the system prompt takes. The result still goes through checkLaunch.
export function launchWithSettings(launch = {}, settings = null, assets = []) {
  const out = { ...(launch || {}) };
  const list = Array.isArray(assets) ? assets : [];
  if (!settings && !list.length) return out;
  const project = (settings && settings.project) || 'the project';
  if (settings) {
    const d = settings.defaults || {};
    for (const k of DEFAULT_KEYS) if (!out[k] && d[k]) out[k] = d[k];
    const own = [...new Set(Array.isArray(out.allowedTools) ? out.allowedTools.map(String) : splitToolRules(out.allowedTools))];
    const theirs = [...new Set(splitToolRules(settings.allowedTools))];
    const tools = [...new Set([...own, ...theirs])];
    if (tools.length > MAX_TOOL_RULES) {
      throw new Error(`this session's own pre-approved tools (${own.length}) and those of ${project} (${theirs.length}) ` +
        `make ${tools.length} without duplicates, more than ${MAX_TOOL_RULES}. Remove some from the flow or from the project settings.`);
    }
    if (tools.length) out.allowedTools = tools;
  }
  const rules = settings && typeof settings.rules === 'string' && settings.rules.trim() ? settings.rules : '';
  const listed = assetsSystemText(list);
  const text = [out.appendSystemPrompt, rules, listed].filter(s => typeof s === 'string' && s.trim()).join('\n\n');
  if (listed && text.length > MAX_APPEND_SYSTEM_PROMPT) {
    throw new Error(`the rules of ${project} and the list of its ${list.length} attached assets come to ${text.length} characters for the system prompt, ` +
      `more than ${MAX_APPEND_SYSTEM_PROMPT}. Shorten the rules or attach fewer assets.`);
  }
  if (text) out.appendSystemPrompt = text;
  return out;
}
