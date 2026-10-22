// Environment for check processes: the Windows system variables a process needs, then the
// profile's preset, then the command's own env. Nothing else from the app's environment reaches a
// check, so API keys and tokens in the user's env stay away from test code Claude may have written.
//
// - Connection settings in the preset point at a closed endpoint (profile ports.closed, for
//   example 127.0.0.1 port 1), never at an empty value: some code falls back to localhost when a
//   value is empty, and this PC runs local Postgres and Redis. presetProblems() checks that.
// - NODE_OPTIONS is set only for commands with heapMb (type-checks); a NODE_OPTIONS from anywhere
//   else is dropped.
// - Names in env.neverSet never come from the system, the preset or the caller's extras. Only a
//   command that needs running containers (it has requiresPorts) may set one in its own env, the
//   way an integration command points at its test database; the profile validator allows exactly
//   that and nothing more.
// - Keys starting with "_" are comments in profiles and are never set.
// - Windows env names ignore case, so every lookup and override here does too, and the result has
//   one key per name (two spellings of PATH would leave the child's PATH undefined).

export const SYSTEM_VARS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

// Preset names that are connection settings and must point at ports.closed.
const ENDPOINT_RE = /(_URL|_HOST|_PORT)$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isComment = name => String(name).startsWith('_');

// An env object built case-insensitively: setting "Path" replaces "PATH".
function envBag() {
  const map = new Map();
  return {
    set(name, value) { map.set(String(name).toLowerCase(), [String(name), String(value)]); },
    delete(name) { map.delete(String(name).toLowerCase()); },
    toObject() { return Object.fromEntries(map.values()); },
  };
}

// Reads a name from an env object whatever its spelling there ("Path", "PATH").
function lookup(source, name) {
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(source)) if (k.toLowerCase() === lower) return source[k];
  return undefined;
}

// The heap size for NODE_OPTIONS: a number on the command, or `heapMb: true` for the profile's
// env.heapMb. Anything else means no NODE_OPTIONS.
function heapMbOf(profile, command) {
  const h = command?.heapMb === true ? profile?.env?.heapMb : command?.heapMb;
  return Number.isInteger(h) && h > 0 ? h : 0;
}

// Copies NAME: value pairs into the bag, skipping comments, NODE_OPTIONS and names `blocked` says no to.
function setAll(env, pairs, blocked) {
  for (const [k, v] of Object.entries(pairs || {})) {
    if (isComment(k) || v === undefined || v === null) continue;
    if (k.toUpperCase() === 'NODE_OPTIONS' || blocked(k)) continue;
    env.set(k, v);
  }
}

// The env for one check command. `extra` comes from the caller (TEMP and TMP for the check's own
// temp folder, for example) and is applied after command.env. `source` is the env the system
// variables are copied from; tests pass a fake one.
export function checkEnv(profile, { command = {}, extra = {}, source = process.env } = {}) {
  const env = envBag();
  const never = new Set((profile?.env?.neverSet || []).map(n => String(n).toLowerCase()));
  const isNever = name => never.has(String(name).toLowerCase());
  for (const name of SYSTEM_VARS) {
    const v = lookup(source || {}, name);
    if (v !== undefined && v !== '' && !isNever(name)) env.set(name, v);
  }
  setAll(env, profile?.env?.preset, isNever);
  const mayUseNever = Array.isArray(command?.requiresPorts) && command.requiresPorts.length > 0;
  setAll(env, command?.env, name => isNever(name) && !mayUseNever);
  setAll(env, extra, isNever);
  env.set('NO_COLOR', '1');
  env.set('FORCE_COLOR', '0');
  env.delete('NODE_OPTIONS');
  const heap = heapMbOf(profile, command);
  if (heap) env.set('NODE_OPTIONS', `--max-old-space-size=${heap}`);
  return env.toObject();
}

// Ports named in a value: "host:5432/db", "port=5432", or a bare "5432".
function portsIn(value) {
  const out = [];
  for (const m of value.matchAll(/:(\d{1,5})(?=[/?#,;\s]|$)/g)) out.push(Number(m[1]));
  for (const m of value.matchAll(/\bport\s*=\s*(\d{1,5})\b/gi)) out.push(Number(m[1]));
  if (/^\d{1,5}$/.test(value.trim())) out.push(Number(value.trim()));
  return out;
}

// Problems with a connection setting: it must name exactly ports.closed.
function endpointProblem(name, value, closed) {
  const want = `${closed.host}:${closed.port}`;
  if (name.endsWith('_HOST')) {
    return value === closed.host ? '' : `env.preset.${name} is "${value}"; it must be the closed host ${closed.host}.`;
  }
  if (name.endsWith('_PORT')) {
    return value === String(closed.port) ? '' : `env.preset.${name} is ${value}; it must be the closed port ${closed.port}.`;
  }
  let url;
  try { url = new URL(value); } catch {
    return `env.preset.${name} is not a URL; it must point at ${want}.`;
  }
  if (url.hostname !== closed.host) return `env.preset.${name} points at ${url.hostname || 'no host'}; it must point at ${want}.`;
  if (!url.port) return `env.preset.${name} has no port; it must use the closed port ${closed.port}.`;
  if (Number(url.port) !== closed.port) return `env.preset.${name} uses port ${url.port}; it must use the closed port ${closed.port}.`;
  return '';
}

// Checks the profile's env preset. Returns a list of plain-English problems (empty when fine):
// - every *_URL, *_HOST and *_PORT name resolves to ports.closed;
// - no value is empty;
// - no value uses a port of a local service or a dev server (ports.localServices, ports.dev);
// - no preset name is also in env.neverSet.
export function presetProblems(profile) {
  const problems = [];
  const env = profile?.env || {};
  const preset = env.preset;
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return ['env.preset must be an object of NAME: value.'];
  const closed = profile?.ports?.closed;
  const closedOk = closed && typeof closed.host === 'string' && Number.isInteger(closed.port);
  if (!closedOk) problems.push('ports.closed must be {host, port}, the endpoint that connection settings point at.');
  const busy = new Set([...(profile?.ports?.localServices || []), ...(profile?.ports?.dev || [])]);
  const never = new Set((env.neverSet || []).map(n => String(n).toLowerCase()));
  for (const [name, value] of Object.entries(preset)) {
    if (isComment(name)) continue;
    if (!ENV_NAME_RE.test(name)) { problems.push(`env.preset has an invalid variable name "${name}".`); continue; }
    if (typeof value !== 'string') { problems.push(`env.preset.${name} must be a string.`); continue; }
    if (!value.trim()) { problems.push(`env.preset.${name} is empty; point it at the closed endpoint instead.`); continue; }
    if (never.has(name.toLowerCase())) problems.push(`env.preset.${name} is also in env.neverSet; it can't be both.`);
    if (name.toUpperCase() === 'NODE_OPTIONS') problems.push('env.preset.NODE_OPTIONS is set by the app only, from heapMb.');
    if (ENDPOINT_RE.test(name) && closedOk) {
      const p = endpointProblem(name, value, closed);
      if (p) problems.push(p);
    }
    for (const port of new Set(portsIn(value))) {
      if (busy.has(port)) problems.push(`env.preset.${name} uses port ${port}, which a local service or dev server uses on this PC.`);
    }
  }
  return problems;
}
