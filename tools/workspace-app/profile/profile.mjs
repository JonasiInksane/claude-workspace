// Project profiles: what the app knows about one project's checks, risk paths, fences and probes.
//
//   dataDir/profiles/<project>.json             a real profile (private, per PC, copied by hand)
//   pipelines/app/profiles/example.json         the synthetic example (tracked; project "example")
//
// A real profile is a map of a project's security-relevant code, and the hub repo is public, so
// real profiles live only in the data folder. "Create from the example" copies the example there.
//
// validateProfile follows SPEC 2.4: a missing required key or a wrong type is an error, an unknown
// key is a warning, and keys starting with "_" are comments. It also enforces the closed-endpoint
// rule: every preset name ending in _URL, _HOST or _PORT must point at ports.closed (127.0.0.1 port
// 1), and no value may use a local service or dev port. Some project code falls back to localhost
// when a value is empty, and this PC runs Postgres and Redis containers, so a check that slipped
// through could otherwise enqueue real jobs. The rule is a little stricter than SPEC 2.4: names
// ending in _URI, _DSN or _ADDR and libpq's PGHOST, PGHOSTADDR and PGPORT count as endpoint names
// too, and a URL or host:port on this PC under any other name must also be the closed endpoint.
//
// Windows env names ignore case, so "example_cache_port" sets the same variable as
// "EXAMPLE_CACHE_PORT": the endpoint rule matches names case-insensitively, and two preset names
// that differ only by case are an error. The check runner's own preset check (gates/env.mjs
// presetProblems) is applied too, so a profile the runner would refuse never validates.
//
// The rest are the lookups other modules need: argv placeholders ({node}, {npmCli}, {tree},
// {pkg:<rel>}, {files}, {base}), risk tags, which workspace owns a path, and drift between the
// profile and the project at its base commit.
//
// Command line, to check a profile copied by hand (it only reads):
//   node tools/workspace-app/profile/profile.mjs --check <project> [--data-dir <dir>]
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, MODEL_RE } from '../../lib/prompt-file.mjs';
import { defaultDataDir, PROJECT_RE, projectPaths, readJson } from '../core/datadir.mjs';
import { firstMatch, globToRegExp, toPosix, walk } from '../core/glob.mjs';
import { MODEL_KEY_RE } from '../core/settings.mjs';
import { presetProblems } from '../gates/env.mjs';

export { PROJECT_RE };
export const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EXAMPLE_PROFILE = 'pipelines/app/profiles/example.json';
export const COMMAND_KINDS = ['test', 'types', 'lint', 'format', 'generate', 'install'];
export const WORKSPACE_KINDS = ['types', 'lint', 'test'];
export const PROBE_KINDS = ['routerKeys', 'missingAssert', 'regexCount', 'windowRegex', 'cycles', 'deepImports', 'publicTs', 'localeParity', 'expoParity'];
export const RISK_TAGS = ['money', 'tenant', 'contract'];
export const BUILDER_CLASSES = ['shop', 'protected', 'public'];
export const PLACEHOLDERS = ['node', 'npmCli', 'tree', 'files', 'base'];
// Names that must point at the closed endpoint (any case: Windows env names ignore it). SPEC 2.4
// lists _URL, _HOST and _PORT; the others reach a service just as well.
export const ENDPOINT_NAME_RE = /(?:_(?:URL|URI|DSN|ADDR|HOST|PORT)|^PG(?:HOST|HOSTADDR|PORT))$/i;
const PORT_NAME_RE = /(?:_PORT|^PGPORT)$/i;
const HOST_NAME_RE = /(?:_HOST|^PGHOST|^PGHOSTADDR)$/i;
const URL_NAME_RE = /_(?:URL|URI)$/i;
// An address on this PC: localhost, 127.x.x.x, 0.0.0.0 and the IPv6 forms (::1, [::1], ::).
const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1?\]?)$/i;
export const MAX_WORKTREE_PATH = 50;

const CMD_ID_RE = /^[a-z0-9][a-z0-9:_-]*$/;
const STAGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WS_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const OPS = ['<', '<=', '>', '>=', '==', '='];
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];
// The port a URL uses when it names none.
const DEFAULT_PORTS = {
  'postgres:': 5432, 'postgresql:': 5432, 'redis:': 6379, 'rediss:': 6379, 'mysql:': 3306, 'mariadb:': 3306,
  'mongodb:': 27017, 'amqp:': 5672, 'amqps:': 5671, 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'nats:': 4222,
};
// Files every profile must fence off and deny reading (sample paths the globs must cover).
const SECRET_SAMPLES = ['.env', 'apps/x/.env', '.env.local', 'apps/x/.env.production', '.npmrc', 'apps/x/.npmrc', '.sentryclirc'];
const FORBIDDEN_SAMPLES = [...SECRET_SAMPLES, '.claude/settings.json'];

const TOP_REQUIRED = ['version', 'project', 'label', 'privacy', 'node', 'git', 'docs', 'isolation', 'ports', 'env',
  'workspaces', 'commands', 'groups', 'levels', 'risk', 'fences', 'format', 'secrets'];
const TOP_OPTIONAL = ['mainCheckoutGuard', 'probes', 'tiles', 'lenses', 'score', 'achievements', 'fun', 'contract',
  'builders', 'assertingBuilders', 'assertPattern', 'findings', 'runTg', 'models', 'caps', 'expo'];
// Probe keys, including the options probes/rules.mjs and probes/metrics.mjs read beyond SPEC 2.6
// (flags, file, a per-probe assertPattern and assertingBuilders, and a tile action override).
const PROBE_KEYS = ['id', 'kind', 'label', 'measures', 'files', 'exclude', 'regex', 'start', 'within', 'filter', 'perFile',
  'cwd', 'argv', 'moduleRegex', 'timeoutSec', 'featuresDir', 'alias', 'publicEntries', 'boundaryTestRegex', 'dir', 'source',
  'flags', 'file', 'assertPattern', 'assertingBuilders', 'action'];
const PROBE_NEEDS = {
  routerKeys: ['files'], missingAssert: ['files'], regexCount: ['files', 'regex'], windowRegex: ['files', 'start', 'within', 'regex'],
  cycles: ['cwd', 'argv'], deepImports: ['featuresDir'], publicTs: ['featuresDir'], localeParity: ['dir', 'source'], expoParity: [],
};

// ---------------------------------------------------------------------------------------------
// Small value checks. Each returns '' or the problem, worded to follow "<key path>: ".

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const isPort = v => Number.isInteger(v) && v >= 1 && v <= 65535;
const at = (path, key) => (path ? `${path}.${key}` : key);

export function relPathProblem(v) {
  if (typeof v !== 'string' || !v) return 'must be a path relative to the project root';
  if (v.includes('\\')) return 'must use forward slashes';
  if (/^[A-Za-z]:/.test(v) || v.startsWith('/')) return 'must be relative to the project root, not absolute';
  const parts = v.split('/');
  if (parts.some((s, i) => s === '..' || (s === '' && i !== parts.length - 1))) return 'must not contain ".." or empty parts';
  return '';
}

export function regexProblem(v) {
  if (typeof v !== 'string' || !v) return 'must be a regular expression';
  try {
    new RegExp(v);
    return '';
  } catch (err) {
    return `is not a valid regular expression (${err.message})`;
  }
}

export function globProblem(v) {
  if (typeof v !== 'string' || !v) return 'must be a glob';
  if (v.includes('\\')) return 'must use forward slashes';
  if (/^[A-Za-z]:/.test(v) || v.startsWith('/')) return 'must be relative to the project root';
  try {
    globToRegExp(v);
    return '';
  } catch (err) {
    return `is not a valid glob (${err.message})`;
  }
}

function winAbsProblem(v) {
  if (typeof v !== 'string' || !/^[A-Za-z]:[\\/]/.test(v)) return 'must be an absolute Windows path such as C:\\dev\\x';
  return '';
}

// True when `child` is `parent` or inside it (Windows rules: case-insensitive, either slash).
function underWin(parent, child) {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
}

// Problems with a command line: argv[0] is {node} (the app never spawns .cmd or .bat files), only
// known placeholders, and {files} at most once and as a whole argument.
export function argvProblems(argv, { files = true } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) return ['must be a non-empty list of strings'];
  const out = [];
  if (argv[0] !== '{node}') out.push('must start with "{node}"; the app runs only Node scripts');
  let filesSeen = 0;
  argv.forEach((arg, i) => {
    if (/[{}]/.test(arg.replace(/\{[^{}]*\}/g, ''))) out.push(`argument ${i + 1} has a "{" or "}" that is not part of a placeholder`);
    for (const m of arg.matchAll(/\{([^{}]*)\}/g)) {
      const name = m[1];
      if (name === 'files') {
        filesSeen++;
        if (!files) out.push('{files} is not allowed here');
        else if (arg !== '{files}') out.push('{files} must be a whole argument');
      } else if (name.startsWith('pkg:')) {
        const problem = relPathProblem(name.slice(4));
        if (problem) out.push(`{${name}}: the package path ${problem}`);
      } else if (!PLACEHOLDERS.includes(name)) {
        out.push(`{${name}} is not a placeholder; use {node}, {npmCli}, {tree}, {pkg:<path>}, {files} or {base}`);
      }
    }
  });
  if (filesSeen > 1) out.push('{files} may appear only once');
  return out;
}

function parseUrl(v) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

// Every port a value points at: the value itself when it is a number, a URL's port (or its
// scheme's default), any ":<port>" in it, and "port=<n>" as in a keyword DSN
// ("host=127.0.0.1 port=5432 dbname=x").
export function portsIn(value) {
  const v = String(value);
  const ports = new Set();
  if (/^\d{1,5}$/.test(v.trim())) ports.add(Number(v.trim()));
  const u = parseUrl(v);
  if (u) ports.add(u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol.toLowerCase()]);
  for (const m of v.matchAll(/:(\d{1,5})(?!\d)/g)) ports.add(Number(m[1]));
  for (const m of v.matchAll(/\bport\s*=\s*(\d{1,5})(?!\d)/gi)) ports.add(Number(m[1]));
  return [...ports].filter(isPort);
}

// Where a value points: a URL, a keyword DSN ("host=127.0.0.1 port=1 dbname=x") or host:port.
// Returns { host, port, fallback } (port is null when the value names none, and a URL then uses
// its scheme's default port, `fallback`), or null when the value is none of these.
export function addressOf(value) {
  const v = String(value).trim();
  const u = parseUrl(v);
  if (u) return { host: u.hostname, port: u.port ? Number(u.port) : null, fallback: DEFAULT_PORTS[u.protocol.toLowerCase()] };
  const host = /(?:^|\s)host(?:addr)?\s*=\s*(\S+)/i.exec(v);
  if (host) {
    const port = /(?:^|\s)port\s*=\s*'?(\d{1,5})(?!\d)/i.exec(v);
    return { host: host[1].replace(/^'|'$/g, ''), port: port ? Number(port[1]) : null };
  }
  const pair = /^(\[[^\]]*\]|[^\s:/]+):(\d{1,5})$/.exec(v);
  return pair ? { host: pair[1], port: Number(pair[2]) } : null;
}

const listOf = v => (Array.isArray(v) ? v : []);

// The closed-endpoint rule for one env value. `extraPorts` are loopback ports a command may use
// (its requiresPorts); preset values get none, so they must use ports.closed exactly. A ports
// section of the wrong shape gives no problems here; checkPorts reports it.
export function endpointProblems(name, value, ports, extraPorts = []) {
  const closed = ports && ports.closed;
  if (!closed || !isText(closed.host) || !isPort(closed.port)) return [];
  const v = String(value);
  const allowed = new Set([closed.port, ...extraPorts]);
  const target = extraPorts.length
    ? `the closed endpoint ${closed.host}:${closed.port} or one of the command's requiresPorts`
    : `the closed endpoint ${closed.host}:${closed.port}`;
  const hostOk = h => h === closed.host || (extraPorts.length > 0 && LOOPBACK.includes(h));
  const out = [];
  if (PORT_NAME_RE.test(name)) {
    if (!/^\d{1,5}$/.test(v) || !allowed.has(Number(v))) out.push(`must be port ${closed.port} (${target}), not "${v}"`);
  } else if (HOST_NAME_RE.test(name)) {
    if (!hostOk(v)) out.push(`must be ${closed.host} (${target}), not "${v}"`);
  } else if (ENDPOINT_NAME_RE.test(name)) {
    // _URL and _URI hold a URL; _DSN and _ADDR may also be a keyword DSN or host:port.
    const urlOnly = URL_NAME_RE.test(name);
    const a = urlOnly && !parseUrl(v) ? null : addressOf(v);
    if (!a) out.push(urlOnly ? `must be a URL pointing at ${target}` : `must be a URL, a "host=... port=..." DSN or host:port pointing at ${target}`);
    else {
      if (!hostOk(a.host)) out.push(`points at ${a.host}; use ${target}`);
      if (a.port === null) out.push(`names no port, so it would use ${a.fallback ? `the default port ${a.fallback}` : 'a default port'}; use ${target}`);
      else if (!allowed.has(a.port)) out.push(`uses port ${a.port}; use ${target}`);
    }
  }
  if (!out.length) {
    const blocked = new Set([...listOf(ports.dev), ...listOf(ports.localServices)]);
    const hit = portsIn(v).find(p => blocked.has(p));
    if (hit) out.push(`uses port ${hit}, which is a local service or dev port`);
    else if (!ENDPOINT_NAME_RE.test(name)) {
      // Any other name: a URL, DSN or host:port on this PC must still be the closed endpoint.
      const a = addressOf(v);
      if (a && LOCAL_HOST_RE.test(a.host) && !(hostOk(a.host) && a.port !== null && allowed.has(a.port))) {
        const port = a.port !== null ? a.port : a.fallback;
        out.push(`points at ${a.host}${port ? `:${port}` : ''} on this PC; use ${target}`);
      }
    }
  }
  return out;
}

// Every closed-endpoint problem in a profile's env.preset, as "env.preset.<NAME>: <problem>".
// (gates/env.mjs can build its presetProblems on this.)
export function closedEndpointProblems(profile) {
  const out = [];
  const preset = profile && profile.env && profile.env.preset;
  if (!isPlain(preset)) return out;
  for (const [name, value] of Object.entries(preset)) {
    if (name.startsWith('_')) continue;
    if (typeof value !== 'string' || !value.trim()) {
      out.push(`env.preset.${name}: must not be empty; point it at the closed endpoint instead`);
      continue;
    }
    for (const p of endpointProblems(name, value, profile.ports)) out.push(`env.preset.${name}: ${p}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The validator.

class Checker {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  err(path, msg) { this.errors.push(`${path}: ${msg}`); }

  warn(path, msg) { this.warnings.push(`${path}: ${msg}`); }

  // An object with its required keys present; unknown keys (not starting with "_") are warnings.
  object(obj, path, required = [], optional = [], { open = false } = {}) {
    if (!isPlain(obj)) {
      this.err(path, 'must be an object');
      return false;
    }
    for (const k of required) if (obj[k] === undefined) this.err(at(path, k), 'is required');
    if (!open) {
      for (const k of Object.keys(obj)) {
        if (!k.startsWith('_') && !required.includes(k) && !optional.includes(k)) this.warn(at(path, k), 'is not a known key');
      }
    }
    return true;
  }

  text(v, path) {
    if (v !== undefined && !isText(v)) this.err(path, 'must be a non-empty string');
  }

  bool(v, path) {
    if (v !== undefined && typeof v !== 'boolean') this.err(path, 'must be true or false');
  }

  int(v, path, min, max) {
    if (v !== undefined && !(Number.isInteger(v) && v >= min && v <= max)) this.err(path, `must be a whole number from ${min} to ${max}`);
  }

  number(v, path) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) this.err(path, 'must be a number');
  }

  // A list whose items pass `each` (returns '' or a problem). Returns the list or [].
  list(v, path, each = null) {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.err(path, 'must be a list');
      return [];
    }
    v.forEach((item, i) => {
      const problem = each ? each(item) : (isText(item) ? '' : 'must be a non-empty string');
      if (problem) this.err(`${path}[${i}]`, problem);
    });
    return v;
  }

  ports(v, path) {
    return this.list(v, path, p => (isPort(p) ? '' : 'must be a port number from 1 to 65535'));
  }

  regex(v, path) {
    if (v === undefined) return;
    const problem = regexProblem(v);
    if (problem) this.err(path, problem);
  }

  rel(v, path) {
    if (v === undefined) return;
    const problem = relPathProblem(v);
    if (problem) this.err(path, problem);
  }

  argv(v, path, opts) {
    if (v === undefined) return;
    for (const p of argvProblems(v, opts)) this.err(path, p);
  }
}

const textProblem = v => (isText(v) ? '' : 'must be a non-empty string');

function checkPrivacy(c, p) {
  if (!c.object(p, 'privacy', ['hubPublic', 'markers', 'knownExposed'])) return;
  c.bool(p.hubPublic, 'privacy.hubPublic');
  c.list(p.markers, 'privacy.markers', v => regexProblem(v) || (new RegExp(v).test('') ? 'matches empty text, so it would match every file' : ''));
  c.list(p.knownExposed, 'privacy.knownExposed', relPathProblem);
}

function checkNode(c, n) {
  if (!c.object(n, 'node', ['pin'], ['pinFile'])) return;
  if (n.pin !== undefined && !(typeof n.pin === 'string' && /^\d+\.\d+\.\d+$/.test(n.pin))) c.err('node.pin', 'must be a version such as 20.15.1');
  c.rel(n.pinFile, 'node.pinFile');
}

function checkGit(c, g) {
  if (!c.object(g, 'git', ['integrationBranch', 'remote', 'branchPrefix', 'archivePrefix'], ['auditBaseline'])) return;
  const ref = v => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v) && !v.includes('..') ? '' : 'must be a branch name');
  if (g.integrationBranch !== undefined && ref(g.integrationBranch)) c.err('git.integrationBranch', ref(g.integrationBranch));
  if (g.remote !== undefined && !(typeof g.remote === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(g.remote))) c.err('git.remote', 'must be a remote name such as origin');
  if (g.branchPrefix !== undefined && g.branchPrefix !== 'app/') c.err('git.branchPrefix', 'must be "app/" (the app only creates and archives app/ branches)');
  if (g.archivePrefix !== undefined && g.archivePrefix !== 'archive/app/') c.err('git.archivePrefix', 'must be "archive/app/"');
  if (g.auditBaseline !== undefined && !(typeof g.auditBaseline === 'string' && SHA_RE.test(g.auditBaseline))) c.err('git.auditBaseline', 'must be a commit SHA (7 to 40 hex characters)');
}

function checkDocs(c, d) {
  if (!c.object(d, 'docs', ['readFirst', 'reviewRules', 'recordsDir', 'recordsIndex', 'recordNameRe'], ['refactorPrompts'])) return;
  c.list(d.readFirst, 'docs.readFirst', relPathProblem);
  c.text(d.reviewRules, 'docs.reviewRules');
  c.rel(d.refactorPrompts, 'docs.refactorPrompts');
  c.rel(d.recordsDir, 'docs.recordsDir');
  c.rel(d.recordsIndex, 'docs.recordsIndex');
  c.regex(d.recordNameRe, 'docs.recordNameRe');
}

function checkIsolation(c, iso, profile, { hubRoot, mainDir }) {
  if (!c.object(iso, 'isolation', ['mode', 'worktreePath', 'lockfile', 'schemaFiles', 'setup', 'refresh'])) return;
  if (iso.mode !== undefined && !['worktree', 'branch'].includes(iso.mode)) c.err('isolation.mode', 'must be worktree or branch');
  const wt = iso.worktreePath;
  if (wt !== undefined) {
    const problem = winAbsProblem(wt);
    if (problem) c.err('isolation.worktreePath', problem);
    else {
      const norm = win32.resolve(wt);
      if (win32.parse(norm).root === norm) c.err('isolation.worktreePath', 'must not be a drive root');
      if (norm.length > MAX_WORKTREE_PATH) c.err('isolation.worktreePath', `must be short (at most ${MAX_WORKTREE_PATH} characters) so node_modules paths stay under the Windows path limit`);
      if (hubRoot && underWin(hubRoot, norm)) c.err('isolation.worktreePath', 'must not be inside the workspace hub');
      if (mainDir && (underWin(mainDir, norm) || underWin(norm, mainDir))) c.err('isolation.worktreePath', 'must not be the main checkout or inside it');
    }
  }
  c.rel(iso.lockfile, 'isolation.lockfile');
  c.list(iso.schemaFiles, 'isolation.schemaFiles', relPathProblem);
  const kinds = new Set(Object.values(isPlain(profile.commands) ? profile.commands : {}).map(cmd => cmd && cmd.kind));
  const step = v => (v !== 'install' && v !== 'generate' ? 'must be install or generate'
    : kinds.has(v) ? '' : `needs a command of kind "${v}"`);
  c.list(iso.setup, 'isolation.setup', step);
  if (c.object(iso.refresh, 'isolation.refresh', ['onLockfile', 'onSchema'])) {
    c.list(iso.refresh.onLockfile, 'isolation.refresh.onLockfile', step);
    c.list(iso.refresh.onSchema, 'isolation.refresh.onSchema', step);
  }
}

function checkPorts(c, ports) {
  if (!c.object(ports, 'ports', ['dev', 'localServices', 'closed'])) return;
  const dev = c.ports(ports.dev, 'ports.dev');
  const local = c.ports(ports.localServices, 'ports.localServices');
  if (c.object(ports.closed, 'ports.closed', ['host', 'port'])) {
    if (ports.closed.host !== undefined && ports.closed.host !== '127.0.0.1') c.err('ports.closed.host', 'must be 127.0.0.1');
    if (ports.closed.port !== undefined) {
      if (!isPort(ports.closed.port)) c.err('ports.closed.port', 'must be a port number from 1 to 65535');
      else if ([...dev, ...local].includes(ports.closed.port)) c.err('ports.closed.port', 'must not be a dev or local service port; it has to be a port nothing listens on');
    }
  }
}

function checkGuard(c, g) {
  if (g === undefined) return;
  if (!c.object(g, 'mainCheckoutGuard', ['label', 'file', 'pattern', 'message'])) return;
  c.text(g.label, 'mainCheckoutGuard.label');
  c.rel(g.file, 'mainCheckoutGuard.file');
  // A pattern that matches empty text would pass for any guard file, so checks would run in a
  // main checkout with a real .env (R10).
  if (g.pattern !== undefined) {
    const problem = regexProblem(g.pattern) || (new RegExp(g.pattern).test('') ? 'matches empty text, so the guard would always pass' : '');
    if (problem) c.err('mainCheckoutGuard.pattern', problem);
  }
  c.text(g.message, 'mainCheckoutGuard.message');
}

// Plain env checks shared by the preset, command env and runTg env.
function checkEnvNames(c, env, path) {
  const seen = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('_')) continue;
    if (!ENV_NAME_RE.test(name)) c.err(`${path}.${name}`, 'is not an environment variable name');
    const upper = name.toUpperCase();
    if (seen.has(upper)) c.err(`${path}.${name}`, `is the same variable as ${seen.get(upper)} on Windows (names ignore case); keep one`);
    else seen.set(upper, name);
    if (typeof value !== 'string') c.err(`${path}.${name}`, 'must be a string');
    else if (!value.trim()) c.err(`${path}.${name}`, 'must not be empty; point it at the closed endpoint instead');
    if (upper === 'NODE_OPTIONS') c.err(`${path}.${name}`, 'is set by the app only, from heapMb');
  }
}

// The check runner (gates/env.mjs) checks the preset again with presetProblems when it builds a
// check's env. Its problems are added here for every name the rules above passed, so a profile
// the runner would refuse never validates; a problem already reported isn't repeated.
function crossCheckPreset(c, profile) {
  let problems;
  try {
    problems = presetProblems(profile);
  } catch (err) {
    // A ports section of the wrong shape can make the runner's check throw; that error is
    // already reported, so only an unexplained failure is added.
    if (!c.errors.some(e => e.startsWith('ports'))) c.err('env.preset', `could not be checked with the check runner's rules (${err.message})`);
    return;
  }
  for (const msg of Array.isArray(problems) ? problems : []) {
    const m = /^env\.preset\.([A-Za-z0-9_]+)/.exec(String(msg));
    const name = m ? m[1] : '';
    if (name.startsWith('_')) continue; // a comment key
    const path = name ? `env.preset.${name}` : 'env.preset';
    const reported = name
      ? c.errors.some(e => e.startsWith(`${path}:`) || (e.startsWith('env.neverSet:') && e.includes(` ${name} `)))
      : c.errors.some(e => /^(env\.preset|env\.neverSet|ports)/.test(e));
    if (!reported) c.err(path, String(msg).replace(/^env\.preset(\.[A-Za-z0-9_]+)?\s*/, '').replace(/\.$/, ''));
  }
}

function checkEnv(c, env, profile) {
  if (!c.object(env, 'env', ['preset', 'heapMb', 'neverSet'])) return;
  if (env.preset !== undefined) {
    if (!isPlain(env.preset)) c.err('env.preset', 'must be an object of NAME: value');
    else {
      checkEnvNames(c, env.preset, 'env.preset');
      for (const [name, value] of Object.entries(env.preset)) {
        if (name.startsWith('_') || typeof value !== 'string' || !value.trim()) continue;
        for (const p of endpointProblems(name, value, profile.ports)) c.err(`env.preset.${name}`, p);
        if (['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT'].includes(name.toUpperCase())) c.warn(`env.preset.${name}`, 'replaces a system variable the checks need');
      }
    }
  }
  c.int(env.heapMb, 'env.heapMb', 256, 65536);
  const never = c.list(env.neverSet, 'env.neverSet', v => (typeof v === 'string' && ENV_NAME_RE.test(v) ? '' : 'must be an environment variable name'));
  const presetNames = new Set(Object.keys(isPlain(env.preset) ? env.preset : {}).map(n => n.toUpperCase()));
  for (const name of never) if (typeof name === 'string' && presetNames.has(name.toUpperCase())) c.err(`env.neverSet`, `${name} is also in env.preset; a neverSet name is never set`);
  if (isPlain(env.preset)) crossCheckPreset(c, profile);
}

function checkWorkspaces(c, list, commands) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.length) {
    c.err('workspaces', 'must be a non-empty list');
    return [];
  }
  const ids = new Set();
  list.forEach((ws, i) => {
    const path = `workspaces[${i}]`;
    if (!c.object(ws, path, ['id', 'dir', 'label'], ['types', 'lint', 'test', 'affectedBy'])) return;
    if (ws.id !== undefined) {
      if (typeof ws.id !== 'string' || !WS_ID_RE.test(ws.id)) c.err(`${path}.id`, 'must be lowercase letters, digits and hyphens');
      else if (ids.has(ws.id)) c.err(`${path}.id`, `"${ws.id}" is used twice`);
      ids.add(ws.id);
    }
    if (ws.dir !== undefined) {
      const problem = ws.dir === '.' ? '' : relPathProblem(ws.dir);
      if (problem) c.err(`${path}.dir`, problem);
      else if (ws.dir.endsWith('/')) c.err(`${path}.dir`, 'must not end with "/"');
    }
    c.text(ws.label, `${path}.label`);
    for (const kind of WORKSPACE_KINDS) {
      c.list(ws[kind], `${path}.${kind}`, id => {
        const cmd = isPlain(commands) ? commands[id] : undefined;
        if (!cmd) return `there is no command "${id}"`;
        if (cmd.kind !== kind) return `command "${id}" is of kind ${cmd.kind}, not ${kind}`;
        if (cmd.workspace !== ws.id) return `command "${id}" belongs to workspace ${cmd.workspace}`;
        return '';
      });
    }
    c.list(ws.affectedBy, `${path}.affectedBy`, v => relPathProblem(v) || (v.endsWith('/') ? '' : 'must end with "/" (it is a folder prefix)'));
  });
  return list.filter(ws => isPlain(ws) && typeof ws.id === 'string');
}

function checkCommands(c, commands, profile, workspaces) {
  if (!c.object(commands, 'commands', [], [], { open: true })) return;
  const wsById = new Map(workspaces.map(ws => [ws.id, ws]));
  const never = new Set((Array.isArray(profile.env && profile.env.neverSet) ? profile.env.neverSet : []).map(n => String(n).toUpperCase()));
  for (const [id, cmd] of Object.entries(commands)) {
    if (id.startsWith('_')) continue;
    const path = `commands.${id}`;
    if (!CMD_ID_RE.test(id)) c.err(path, 'the id must be lowercase letters, digits, ":", "_" and "-"');
    if (!c.object(cmd, path, ['kind', 'workspace', 'cwd', 'argv', 'timeoutSec'], ['files', 'env', 'heapMb', 'requiresPorts', 'concurrency', 'onlyTree'])) continue;
    if (cmd.kind !== undefined && !COMMAND_KINDS.includes(cmd.kind)) c.err(`${path}.kind`, `must be one of ${COMMAND_KINDS.join(', ')}`);
    const ws = wsById.get(cmd.workspace);
    if (cmd.workspace !== undefined && !ws) c.err(`${path}.workspace`, `there is no workspace "${cmd.workspace}"`);
    if (cmd.cwd !== undefined) {
      const problem = cmd.cwd === '.' ? '' : relPathProblem(cmd.cwd);
      if (problem) c.err(`${path}.cwd`, problem);
      else if (ws && typeof ws.dir === 'string' && ws.dir !== '.' && cmd.cwd !== ws.dir && !cmd.cwd.startsWith(`${ws.dir}/`)) {
        c.warn(`${path}.cwd`, `is outside its workspace folder ${ws.dir}`);
      }
    }
    c.argv(cmd.argv, `${path}.argv`);
    if (cmd.files !== undefined && c.object(cmd.files, `${path}.files`, [], ['roots', 'pattern', 'list'])) {
      c.list(cmd.files.roots, `${path}.files.roots`, v => (v === '.' ? '' : relPathProblem(v)));
      c.regex(cmd.files.pattern, `${path}.files.pattern`);
      c.list(cmd.files.list, `${path}.files.list`, relPathProblem);
      if (cmd.files.roots && cmd.files.pattern === undefined) c.err(`${path}.files.pattern`, 'is required with roots');
      if (Array.isArray(cmd.argv) && !cmd.argv.includes('{files}')) c.warn(`${path}.files`, 'is set but argv has no {files}');
    }
    const requires = c.ports(cmd.requiresPorts, `${path}.requiresPorts`);
    if (cmd.env !== undefined) {
      if (!isPlain(cmd.env)) c.err(`${path}.env`, 'must be an object of NAME: value');
      else {
        checkEnvNames(c, cmd.env, `${path}.env`);
        for (const [name, value] of Object.entries(cmd.env)) {
          if (name.startsWith('_') || typeof value !== 'string' || !value.trim()) continue;
          for (const p of endpointProblems(name, value, profile.ports, requires.filter(isPort))) c.err(`${path}.env.${name}`, p);
          if (never.has(name.toUpperCase()) && !requires.length) c.err(`${path}.env.${name}`, 'is a neverSet name; only an integration command with requiresPorts may set it');
        }
      }
    }
    // heapMb: a size in MB, or true for env.heapMb (gates/env.mjs reads both).
    if (cmd.heapMb === true) {
      if (!(profile.env && Number.isInteger(profile.env.heapMb))) c.err(`${path}.heapMb`, 'is true, so env.heapMb must be set');
    } else c.int(cmd.heapMb, `${path}.heapMb`, 256, 65536);
    c.int(cmd.concurrency, `${path}.concurrency`, 1, 16);
    c.int(cmd.timeoutSec, `${path}.timeoutSec`, 1, 86400);
    if (cmd.onlyTree !== undefined && cmd.onlyTree !== 'run') c.err(`${path}.onlyTree`, 'must be "run"');
    if ((cmd.kind === 'install' || cmd.kind === 'generate') && cmd.onlyTree !== 'run') c.warn(`${path}.onlyTree`, `a ${cmd.kind} command should have onlyTree: "run" so it never runs in the main checkout`);
  }
}

function checkGroups(c, groups, commands, workspaces) {
  if (!c.object(groups, 'groups', [], [], { open: true })) return new Set();
  const ids = new Set();
  const wsIds = new Set(workspaces.map(ws => ws.id));
  for (const [id, g] of Object.entries(groups)) {
    if (id.startsWith('_')) continue;
    const path = `groups.${id}`;
    if (id === 'G0') { c.err(path, 'G0 is built in (diff check, format, secrets, fences, ratchets); leave it out'); continue; }
    if (!/^G[1-9]$/.test(id)) { c.err(path, 'group ids are G1 to G9'); continue; }
    ids.add(id);
    if (!c.object(g, path, ['label'], ['perWorkspace', 'commands', 'when', 'requiresPorts', 'serverFocused'])) continue;
    c.text(g.label, `${path}.label`);
    if (g.perWorkspace === undefined && g.commands === undefined) c.err(path, 'needs perWorkspace or commands');
    if (g.perWorkspace !== undefined) {
      const kinds = Array.isArray(g.perWorkspace) ? g.perWorkspace : [g.perWorkspace];
      if (!kinds.length || kinds.some(k => !WORKSPACE_KINDS.includes(k))) c.err(`${path}.perWorkspace`, 'must be types, lint or test, or a list of them');
    }
    c.list(g.commands, `${path}.commands`, v => (isPlain(commands) && isPlain(commands[v]) ? '' : `there is no command "${v}"`));
    c.list(g.when, `${path}.when`, v => relPathProblem(v));
    c.ports(g.requiresPorts, `${path}.requiresPorts`);
    if (g.serverFocused !== undefined && !wsIds.has(g.serverFocused)) c.err(`${path}.serverFocused`, `there is no workspace "${g.serverFocused}"`);
  }
  return ids;
}

function checkLevels(c, levels, groupIds) {
  if (!c.object(levels, 'levels', ['quick', 'standard', 'paranoid'])) return;
  for (const name of ['quick', 'standard', 'paranoid']) {
    const lv = levels[name];
    if (lv === undefined || !c.object(lv, `levels.${name}`, ['groups'], ['verify'])) continue;
    c.list(lv.groups, `levels.${name}.groups`, g => (g === 'G0' || groupIds.has(g) ? '' : `there is no group "${g}"`));
    c.bool(lv.verify, `levels.${name}.verify`);
  }
}

// The sample paths that none of the globs match.
const uncovered = (globs, samples) => samples.filter(s => !firstMatch(globs.filter(g => !globProblem(g)), s, { nocase: true }));

function checkRiskAndFences(c, profile) {
  if (c.object(profile.risk, 'risk', RISK_TAGS)) {
    for (const tag of RISK_TAGS) c.list(profile.risk[tag], `risk.${tag}`, globProblem);
  }
  const f = profile.fences;
  const keys = ['forbidden', 'forbiddenExisting', 'mustTick', 'mustTickNew', 'alwaysAllowed', 'pinned'];
  if (c.object(f, 'fences', [...keys, 'testPattern'])) {
    for (const k of keys) c.list(f[k], `fences.${k}`, globProblem);
    c.regex(f.testPattern, 'fences.testPattern');
    if (Array.isArray(f.forbidden)) {
      const missing = uncovered(f.forbidden, FORBIDDEN_SAMPLES);
      if (missing.length) c.err('fences.forbidden', `must cover ${missing.join(', ')} (for example **/.env, **/.env.*, **/.npmrc, **/.sentryclirc, .claude/**)`);
    }
  }
  const s = profile.secrets;
  if (c.object(s, 'secrets', ['trackedSecretFiles', 'denyReadGlobs', 'allowValues'])) {
    c.list(s.trackedSecretFiles, 'secrets.trackedSecretFiles', relPathProblem);
    c.list(s.denyReadGlobs, 'secrets.denyReadGlobs', globProblem);
    if (Array.isArray(s.denyReadGlobs)) {
      const missing = uncovered(s.denyReadGlobs, SECRET_SAMPLES);
      if (missing.length) c.err('secrets.denyReadGlobs', `must cover ${missing.join(', ')}`);
    }
    c.list(s.allowValues, 'secrets.allowValues', v => (!isText(v) ? 'must be a non-empty string'
      : /_live_|^live_/i.test(v) ? 'looks like a live key; only test values may be allowed' : ''));
  }
}

function checkFormat(c, fmt, commands) {
  if (!c.object(fmt, 'format', ['cmd', 'glob'])) return;
  if (fmt.cmd !== undefined) {
    const cmd = isPlain(commands) ? commands[fmt.cmd] : undefined;
    if (!cmd) c.err('format.cmd', `there is no command "${fmt.cmd}"`);
    else if (cmd.kind !== 'format') c.err('format.cmd', `command "${fmt.cmd}" is of kind ${cmd.kind}, not format`);
  }
  if (fmt.glob !== undefined) {
    const problem = globProblem(fmt.glob);
    if (problem) c.err('format.glob', problem);
  }
}

function checkProbes(c, profile) {
  const ids = new Set();
  const probes = c.list(profile.probes, 'probes', p => (isPlain(p) ? '' : 'must be an object'));
  probes.forEach((p, i) => {
    if (!isPlain(p)) return;
    const path = `probes[${i}]`;
    c.object(p, path, ['id', 'kind', 'label', 'measures'], PROBE_KEYS);
    if (p.id !== undefined) {
      if (typeof p.id !== 'string' || !ID_RE.test(p.id)) c.err(`${path}.id`, 'must start with a letter and use letters, digits, "_" or "-"');
      else if (ids.has(p.id)) c.err(`${path}.id`, `"${p.id}" is used twice`);
      ids.add(p.id);
    }
    if (p.kind !== undefined && !PROBE_KINDS.includes(p.kind)) c.err(`${path}.kind`, `must be one of ${PROBE_KINDS.join(', ')}`);
    c.text(p.label, `${path}.label`);
    c.text(p.measures, `${path}.measures`);
    for (const need of PROBE_NEEDS[p.kind] || []) if (p[need] === undefined) c.err(`${path}.${need}`, `is required for a ${p.kind} probe`);
    c.list(p.files, `${path}.files`, globProblem);
    c.list(p.exclude, `${path}.exclude`, globProblem);
    for (const k of ['regex', 'start', 'moduleRegex', 'boundaryTestRegex', 'assertPattern']) c.regex(p[k], `${path}.${k}`);
    if (p.flags !== undefined && !(typeof p.flags === 'string' && /^[isu]*$/.test(p.flags))) c.err(`${path}.flags`, 'may only hold i, s and u');
    if (p.file !== undefined && !(isText(p.file) && !/[\\/]/.test(p.file))) c.err(`${path}.file`, 'must be a file name such as public.ts');
    c.list(p.assertingBuilders, `${path}.assertingBuilders`);
    if (p.action !== undefined && p.action !== null && !(isPlain(p.action) && isText(p.action.pipeline) && isText(p.action.what))) {
      c.err(`${path}.action`, 'must be null or {pipeline, what}');
    }
    c.int(p.within, `${path}.within`, 1, 10000);
    c.int(p.timeoutSec, `${path}.timeoutSec`, 1, 86400);
    c.bool(p.perFile, `${path}.perFile`);
    for (const k of ['cwd', 'featuresDir', 'dir']) c.rel(p[k], `${path}.${k}`);
    c.argv(p.argv, `${path}.argv`, { files: false });
    c.text(p.alias, `${path}.alias`);
    c.text(p.source, `${path}.source`);
    c.list(p.publicEntries, `${path}.publicEntries`);
    if (p.filter !== undefined && c.object(p.filter, `${path}.filter`, [], ['class', 'bodyRegex'])) {
      if (p.filter.class !== undefined && !BUILDER_CLASSES.includes(p.filter.class)) c.err(`${path}.filter.class`, `must be one of ${BUILDER_CLASSES.join(', ')}`);
      c.regex(p.filter.bodyRegex, `${path}.filter.bodyRegex`);
    }
    if (p.kind === 'expoParity' && profile.expo === undefined) c.err(path, 'an expoParity probe needs the expo section');
    if ((p.kind === 'routerKeys' || p.kind === 'missingAssert') && profile.builders === undefined) c.err('builders', `is required by the ${p.kind} probe "${p.id}"`);
    if (p.kind === 'missingAssert' && profile.assertPattern === undefined) c.err('assertPattern', `is required by the missingAssert probe "${p.id}"`);
  });
  return ids;
}

// A metric name: a probe id, "<probe id>.<field>" or knownFailures (from the baseline).
function metricProblem(name, probeIds) {
  if (!isText(name)) return 'must be a metric name';
  const id = name.split('.')[0];
  return id === 'knownFailures' || probeIds.has(id) ? '' : `"${name}" is not a probe id or knownFailures`;
}

function checkScoreboard(c, profile, probeIds) {
  for (const key of ['tiles', 'lenses']) {
    const list = c.list(profile[key], key);
    list.forEach((v, i) => {
      const problem = isText(v) ? (key === 'lenses' ? (probeIds.has(v) ? '' : `"${v}" is not a probe id`) : metricProblem(v, probeIds)) : '';
      if (problem) c.warn(`${key}[${i}]`, problem);
    });
  }
  if (profile.score !== undefined && c.object(profile.score, 'score', [], [], { open: true })) {
    for (const [name, s] of Object.entries(profile.score)) {
      if (name.startsWith('_')) continue;
      const path = `score.${name}`;
      const problem = metricProblem(name, probeIds);
      if (problem) c.warn(path, problem);
      if (!c.object(s, path, ['weight', 'target', 'ref'], ['higherIsBetter'])) continue;
      c.number(s.weight, `${path}.weight`);
      if (typeof s.weight === 'number' && s.weight <= 0) c.err(`${path}.weight`, 'must be more than 0');
      c.number(s.target, `${path}.target`);
      c.number(s.ref, `${path}.ref`);
      if (typeof s.ref === 'number' && s.ref === s.target) c.err(path, 'ref and target must differ');
      c.bool(s.higherIsBetter, `${path}.higherIsBetter`);
    }
  }
  const achievements = c.list(profile.achievements, 'achievements', a => (isPlain(a) ? '' : 'must be an object'));
  achievements.forEach((a, i) => {
    if (!isPlain(a)) return;
    const path = `achievements[${i}]`;
    if (!c.object(a, path, ['id', 'label', 'when'])) return;
    c.text(a.id, `${path}.id`);
    c.text(a.label, `${path}.label`);
    if (!isPlain(a.when)) { c.err(`${path}.when`, 'must be an object'); return; }
    if (a.when.phaseClosed !== undefined) {
      c.object(a.when, `${path}.when`, ['phaseClosed']);
      c.text(a.when.phaseClosed, `${path}.when.phaseClosed`);
    } else if (c.object(a.when, `${path}.when`, ['metric', 'op', 'value'])) {
      const problem = a.when.metric === undefined ? '' : metricProblem(a.when.metric, probeIds);
      if (problem) c.warn(`${path}.when.metric`, problem);
      if (a.when.op !== undefined && !OPS.includes(a.when.op)) c.err(`${path}.when.op`, `must be one of ${OPS.join(' ')}`);
      c.number(a.when.value, `${path}.when.value`);
    }
  });
  if (profile.fun !== undefined && c.object(profile.fun, 'fun', [], ['bossPhase'])) c.text(profile.fun.bossPhase, 'fun.bossPhase');
}

function checkContractAndBuilders(c, profile) {
  const ct = profile.contract;
  if (ct !== undefined && c.object(ct, 'contract', ['routerFiles'], ['legacyRouter', 'queues'])) {
    c.list(ct.routerFiles, 'contract.routerFiles', globProblem);
    c.rel(ct.legacyRouter, 'contract.legacyRouter');
    c.list(ct.queues, 'contract.queues', q => {
      if (!isPlain(q)) return 'must be an object';
      const problem = relPathProblem(q.file);
      if (problem) return `file ${problem}`;
      if (isText(q.enum) === (q.regex !== undefined)) return 'needs either enum or regex';
      return q.regex !== undefined ? (regexProblem(q.regex) ? `regex ${regexProblem(q.regex)}` : '') : '';
    });
  }
  const b = profile.builders;
  if (b !== undefined && c.object(b, 'builders', [], [], { open: true })) {
    for (const [name, cls] of Object.entries(b)) {
      if (name.startsWith('_')) continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) c.err(`builders.${name}`, 'is not an identifier');
      if (!BUILDER_CLASSES.includes(cls)) c.err(`builders.${name}`, `must be one of ${BUILDER_CLASSES.join(', ')}`);
    }
  }
  const asserting = c.list(profile.assertingBuilders, 'assertingBuilders');
  asserting.forEach((n, i) => { if (isText(n) && !(isPlain(b) && b[n])) c.warn(`assertingBuilders[${i}]`, `"${n}" is not in builders`); });
  c.regex(profile.assertPattern, 'assertPattern');
}

function checkExtras(c, profile) {
  const fd = profile.findings;
  if (fd !== undefined && c.object(fd, 'findings', ['audit', 'idPattern'], ['auditBaseline'])) {
    if (fd.audit !== undefined && winAbsProblem(fd.audit)) c.err('findings.audit', winAbsProblem(fd.audit));
    if (fd.auditBaseline !== undefined && !(typeof fd.auditBaseline === 'string' && SHA_RE.test(fd.auditBaseline))) c.err('findings.auditBaseline', 'must be a commit SHA');
    c.regex(fd.idPattern, 'findings.idPattern');
  }
  const ids = new Set();
  const runTg = c.list(profile.runTg, 'runTg', r => (isPlain(r) ? '' : 'must be an object'));
  runTg.forEach((r, i) => {
    if (!isPlain(r)) return;
    const path = `runTg[${i}]`;
    if (!c.object(r, path, ['id', 'label', 'cwd', 'argv', 'warn'], ['env'])) return;
    if (r.id !== undefined) {
      if (typeof r.id !== 'string' || !WS_ID_RE.test(r.id)) c.err(`${path}.id`, 'must be lowercase letters, digits and hyphens');
      else if (ids.has(r.id)) c.err(`${path}.id`, `"${r.id}" is used twice`);
      ids.add(r.id);
    }
    c.text(r.label, `${path}.label`);
    if (r.cwd !== undefined && r.cwd !== '.') c.rel(r.cwd, `${path}.cwd`);
    c.argv(r.argv, `${path}.argv`, { files: false });
    c.text(r.warn, `${path}.warn`);
    if (r.env !== undefined) {
      if (!isPlain(r.env)) c.err(`${path}.env`, 'must be an object of NAME: value');
      else checkEnvNames(c, r.env, `${path}.env`);
    }
  });
  // models: "<pipeline>.<stage>" or a bare stage id (runs/catalog.mjs reads both).
  if (profile.models !== undefined && c.object(profile.models, 'models', [], [], { open: true })) {
    for (const [key, m] of Object.entries(profile.models)) {
      if (key.startsWith('_')) continue;
      const path = `models.${key}`;
      if (!MODEL_KEY_RE.test(key) && !STAGE_ID_RE.test(key)) c.err(path, 'must be "<pipeline>.<stage>" or a stage id, for example refactor.scope or scope');
      if (!c.object(m, path, [], ['model', 'effort'])) continue;
      if (m.model === undefined && m.effort === undefined) c.err(path, 'needs a model or an effort');
      if (m.model !== undefined && !(typeof m.model === 'string' && MODEL_RE.test(m.model))) c.err(`${path}.model`, 'must be an alias such as opus or sonnet, or a full model name');
      if (m.effort !== undefined && !EFFORTS.includes(m.effort)) c.err(`${path}.effort`, `must be one of ${EFFORTS.join(', ')}`);
    }
  }
  // caps: { read, edit } stage limits, as runs/catalog.mjs stageCaps reads them. The budget range
  // is the one the headless argv check accepts.
  if (profile.caps !== undefined && c.object(profile.caps, 'caps', [], ['read', 'edit'])) {
    for (const kind of ['read', 'edit']) {
      const cap = profile.caps[kind];
      if (cap === undefined || !c.object(cap, `caps.${kind}`, [], ['maxTurns', 'minutes', 'budgetUsd'])) continue;
      c.int(cap.maxTurns, `caps.${kind}.maxTurns`, 1, 200);
      c.number(cap.minutes, `caps.${kind}.minutes`);
      if (typeof cap.minutes === 'number' && !(cap.minutes > 0 && cap.minutes <= 600)) c.err(`caps.${kind}.minutes`, 'must be more than 0 and at most 600');
      c.number(cap.budgetUsd, `caps.${kind}.budgetUsd`);
      if (typeof cap.budgetUsd === 'number' && !(cap.budgetUsd >= 0.5 && cap.budgetUsd <= 50)) c.err(`caps.${kind}.budgetUsd`, 'must be from 0.5 to 50');
    }
  }
  const ex = profile.expo;
  if (ex !== undefined && c.object(ex, 'expo', ['webFeatures', 'expoModules', 'map'])) {
    c.rel(ex.webFeatures, 'expo.webFeatures');
    c.rel(ex.expoModules, 'expo.expoModules');
    if (ex.map !== undefined) {
      if (!isPlain(ex.map)) c.err('expo.map', 'must be an object of web feature: Expo module');
      else for (const [k, v] of Object.entries(ex.map)) if (!isText(v)) c.err(`expo.map.${k}`, 'must be a non-empty string');
    }
  }
}

// Checks a profile object. Returns { ok, errors, warnings } (plain-English strings starting with
// the key path). Options: `project` (the file name the profile must match), and `hubRoot` and
// `mainDir` (the worktree must be outside both).
export function validateProfile(obj, { project, hubRoot, mainDir } = {}) {
  const c = new Checker();
  if (!c.object(obj, 'profile', TOP_REQUIRED, TOP_OPTIONAL)) return { ok: false, errors: ['A profile must be a JSON object.'], warnings: [] };
  // Top-level messages read "version: is required", not "profile.version: ...".
  c.errors = c.errors.map(e => e.replace(/^profile\./, ''));
  c.warnings = c.warnings.map(w => w.replace(/^profile\./, ''));
  if (obj.version !== undefined && obj.version !== 1) c.err('version', 'must be 1');
  if (obj.project !== undefined) {
    if (typeof obj.project !== 'string' || !PROJECT_RE.test(obj.project)) c.err('project', 'must be lowercase letters, digits and single hyphens');
    else if (project && obj.project !== project) c.err('project', `is "${obj.project}" but the file is ${project}.json`);
  }
  c.text(obj.label, 'label');
  checkPrivacy(c, obj.privacy);
  checkNode(c, obj.node);
  checkGit(c, obj.git);
  checkDocs(c, obj.docs);
  checkPorts(c, obj.ports);
  checkIsolation(c, obj.isolation, obj, { hubRoot, mainDir });
  checkGuard(c, obj.mainCheckoutGuard);
  checkEnv(c, obj.env, obj);
  const workspaces = checkWorkspaces(c, obj.workspaces, obj.commands);
  checkCommands(c, obj.commands, obj, workspaces);
  const groupIds = checkGroups(c, obj.groups, obj.commands, workspaces);
  checkLevels(c, obj.levels, groupIds);
  checkRiskAndFences(c, obj);
  checkFormat(c, obj.format, obj.commands);
  const probeIds = checkProbes(c, obj);
  checkScoreboard(c, obj, probeIds);
  checkContractAndBuilders(c, obj);
  checkExtras(c, obj);
  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings };
}

// ---------------------------------------------------------------------------------------------
// Loading and creating profiles.

// The realpath of projects/<project> in the hub, when it exists (the main checkout of a linked
// project), so the worktree check can compare against it.
function hubProjectDir(hubRoot, project) {
  try {
    return realpathSync(join(hubRoot, 'projects', project));
  } catch {
    return '';
  }
}

// Reads and checks dataDir/profiles/<project>.json. Returns
// { exists, valid, path, profile, errors, warnings }; `profile` is null when the file is missing
// or isn't JSON. Throws only for a project name that isn't valid.
export async function loadProfile(dataDir, project, { hubRoot = HUB_ROOT, mainDir } = {}) {
  const path = projectPaths(dataDir, project).profile;
  const MISSING = Symbol('missing');
  let profile;
  try {
    profile = await readJson(path, MISSING);
  } catch (err) {
    return { exists: true, valid: false, path, profile: null, errors: [err.message], warnings: [] };
  }
  if (profile === MISSING) return { exists: false, valid: false, path, profile: null, errors: [], warnings: [] };
  const main = mainDir === undefined ? hubProjectDir(hubRoot, project) : mainDir;
  let checked;
  try {
    checked = validateProfile(profile, { project, hubRoot, mainDir: main || undefined });
  } catch (err) {
    // A validator bug on an odd hand-edited value must not turn into a crash or a 500.
    checked = { errors: [`The profile could not be checked: ${err && err.message ? err.message : err}`], warnings: [] };
  }
  const { errors, warnings } = checked;
  return { exists: true, valid: errors.length === 0, path, profile, errors, warnings };
}

// The tracked synthetic example profile, parsed.
export function exampleProfile(root = HUB_ROOT) {
  const file = join(root, ...EXAMPLE_PROFILE.split('/'));
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`The example profile ${EXAMPLE_PROFILE} could not be read: ${err.message}`);
  }
}

// "Create from the example": copies the example to dataDir/profiles/<project>.json with the
// project name filled in. Never overwrites: an existing profile throws an Error with status 409.
// Returns { path, profile }.
export function createFromExample(root, dataDir, project) {
  const { profile: path } = projectPaths(dataDir, project);
  const profile = {
    ...exampleProfile(root),
    _note: `Private. Created from the example on ${new Date().toISOString().slice(0, 10)}. Replace the synthetic values with this project's own.`,
    project,
    label: project,
  };
  // C:\dev\<project>-run, with the name cut so the path stays within MAX_WORKTREE_PATH.
  const short = project.slice(0, MAX_WORKTREE_PATH - 'C:\\dev\\-run'.length).replace(/-+$/, '');
  profile.isolation = { ...profile.isolation, worktreePath: `C:\\dev\\${short}-run` };
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const e = new Error(`profiles/${project}.json already exists; the app never overwrites a profile.`);
      e.status = 409;
      throw e;
    }
    throw err;
  }
  return { path, profile };
}

// ---------------------------------------------------------------------------------------------
// Argv placeholders.

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The first <dir>/node_modules/<rel> that exists, from cwdAbs up to treeAbs (npm's .bin lookup),
// or null. Throws when cwdAbs is outside the tree or rel isn't a plain relative path.
export function resolvePkg(rel, cwdAbs, treeAbs) {
  const problem = relPathProblem(rel);
  if (problem) throw new Error(`"${rel}" is not a package path: it ${problem}.`);
  const tree = resolve(treeAbs);
  let dir = resolve(cwdAbs || tree);
  if (!inside(tree, dir)) throw new Error(`${dir} is outside the tree ${tree}.`);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...rel.split('/'));
    if (existsSync(candidate)) return candidate;
    if (relative(tree, dir) === '') return null;
    dir = dirname(dir);
  }
}

// A file for {files}: relative to the command's cwd, with forward slashes. Input paths are
// tree-relative (as git lists them) or absolute.
function fileArg(file, tree, cwd) {
  const abs = isAbsolute(file) ? file : tree ? join(tree, ...toPosix(file).split('/')) : resolve(cwd, file);
  return relative(cwd, abs).split('\\').join('/');
}

// Fills in a command's placeholders. vars = { node = process.execPath, npmCli, tree, cwd = tree,
// files: [tree-relative or absolute paths], base }. A relative cwd (as profile commands, runTg
// rows and probes store it, "apps/web") is relative to the tree. Throws a plain message when a
// placeholder has no value, a {pkg:...} target is missing, or {files} would be empty (an empty
// list would make most tools check everything).
export function resolveArgv(argv, vars = {}) {
  if (!Array.isArray(argv)) throw new Error('argv must be a list.');
  const node = vars.node || process.execPath;
  const tree = vars.tree ? resolve(vars.tree) : '';
  const cwd = vars.cwd ? resolve(tree || process.cwd(), vars.cwd) : tree || process.cwd();
  const value = name => {
    if (name === 'node') return node;
    if (name === 'npmCli') return vars.npmCli || join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (name === 'tree') {
      if (!tree) throw new Error('This command needs a tree ({tree}).');
      return tree;
    }
    if (name === 'base') {
      if (!vars.base) throw new Error('This command needs the base commit ({base}).');
      return vars.base;
    }
    if (name === 'files') throw new Error('{files} must be a whole argument.');
    if (name.startsWith('pkg:')) {
      if (!tree) throw new Error(`{${name}} needs a tree to look in.`);
      const rel = name.slice(4);
      const found = resolvePkg(rel, cwd, tree);
      if (!found) throw new Error(`${rel} is not installed in this tree`);
      return found;
    }
    throw new Error(`{${name}} is not a placeholder.`);
  };
  const out = [];
  for (const arg of argv) {
    if (arg === '{files}') {
      if (!Array.isArray(vars.files)) throw new Error('This command needs a file list ({files}).');
      if (!vars.files.length) throw new Error('This command has no files to run.');
      out.push(...vars.files.map(f => fileArg(f, tree, cwd)));
    } else {
      out.push(String(arg).replace(/\{([^{}]*)\}/g, (_, name) => value(name)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths: risk tags and workspaces. `paths` may be strings or changed-file rows {path, oldPath}.

function pathsOf(paths) {
  const out = [];
  for (const p of paths || []) {
    if (typeof p === 'string') out.push(toPosix(p));
    else if (p && typeof p.path === 'string') {
      out.push(toPosix(p.path));
      if (typeof p.oldPath === 'string' && p.oldPath) out.push(toPosix(p.oldPath));
    }
  }
  return out;
}

// Which risk areas (money, tenant, contract) the paths touch. Matching ignores case, so a path
// spelled differently still counts. Returns { tags, hits: [{ path, tag, glob }] }.
export function riskTags(profile, paths) {
  const hits = [];
  const tags = new Set();
  const risk = (profile && profile.risk) || {};
  for (const path of pathsOf(paths)) {
    for (const tag of RISK_TAGS) {
      const glob = firstMatch(Array.isArray(risk[tag]) ? risk[tag] : [], path, { nocase: true });
      if (glob) {
        hits.push({ path, tag, glob });
        tags.add(tag);
      }
    }
  }
  return { tags: RISK_TAGS.filter(t => tags.has(t)), hits };
}

const within = (dir, path) => dir === '.' || path === dir || path.startsWith(`${dir}/`);

// The workspace that owns a path: the one with the longest matching dir ("." owns the rest).
// Returns the workspace object, or null.
export function workspaceOf(profile, path) {
  const p = toPosix(path);
  let best = null;
  for (const ws of (profile && profile.workspaces) || []) {
    if (!ws || typeof ws.dir !== 'string' || !within(ws.dir, p)) continue;
    const len = ws.dir === '.' ? 0 : ws.dir.length;
    if (!best || len > best.len) best = { ws, len };
  }
  return best ? best.ws : null;
}

// The workspaces a change affects, in profile order: those owning a changed path, plus those whose
// affectedBy prefixes match one. With `kind` (types, lint or test), only workspaces that have
// commands of that kind.
export function affectedWorkspaces(profile, paths, kind) {
  const list = pathsOf(paths);
  const owners = new Set(list.map(p => workspaceOf(profile, p)).filter(Boolean).map(ws => ws.id));
  return ((profile && profile.workspaces) || []).filter(ws => {
    if (!ws) return false;
    if (kind && !(Array.isArray(ws[kind]) && ws[kind].length)) return false;
    return owners.has(ws.id) || list.some(p => (ws.affectedBy || []).some(prefix => p.startsWith(prefix)));
  });
}

// ---------------------------------------------------------------------------------------------
// Drift between the profile and the project at its base commit (SPEC 2.4.2). Warnings only.

async function safeRead(readAtBase, rel) {
  try {
    const text = await readAtBase(rel);
    return { text: text === undefined || text === null ? null : String(text) };
  } catch (err) {
    return { text: null, error: err && err.message ? err.message : String(err) };
  }
}

function pkgTargets(profile) {
  const out = [];
  const add = (owner, cwd, argv) => {
    for (const arg of Array.isArray(argv) ? argv : []) {
      for (const m of String(arg).matchAll(/\{pkg:([^{}]+)\}/g)) out.push({ owner, cwd: cwd || '.', rel: m[1] });
    }
  };
  for (const [id, cmd] of Object.entries((profile && profile.commands) || {})) if (isPlain(cmd)) add(`command ${id}`, cmd.cwd, cmd.argv);
  for (const r of (profile && profile.runTg) || []) if (isPlain(r)) add(`Run ${r.id}`, r.cwd, r.argv);
  for (const p of (profile && profile.probes) || []) if (isPlain(p) && p.argv) add(`probe ${p.id}`, p.cwd, p.argv);
  return out;
}

// Returns [{ id, text }]. readAtBase(rel) gives a file's text at the base commit, or null when it
// doesn't exist there. Options: `tree` (a checkout on disk, for {pkg:...} targets and test roots)
// and `listAtBase(dirRel)` (tree-relative file paths under a folder at base; preferred over the
// disk for test roots).
export async function profileDrift(profile, readAtBase, { tree = '', listAtBase = null } = {}) {
  const out = [];
  const fmt = profile && profile.format;
  if (fmt && typeof fmt.glob === 'string') {
    const { text, error } = await safeRead(readAtBase, 'package.json');
    let staged = null;
    try { staged = text ? JSON.parse(text)['lint-staged'] : null; } catch { /* reported below */ }
    if (error || text === null) out.push({ id: 'drift.format', text: `package.json could not be read at base${error ? ` (${error})` : ''}, so format.glob was not compared.` });
    else if (!isPlain(staged)) out.push({ id: 'drift.format', text: 'package.json has no lint-staged section at base, so format.glob was not compared.' });
    else if (!Object.keys(staged).includes(fmt.glob)) {
      out.push({ id: 'drift.format', text: `format.glob is "${fmt.glob}" but lint-staged in package.json uses ${Object.keys(staged).map(k => `"${k}"`).join(', ')}.` });
    }
  }
  const node = profile && profile.node;
  if (node && typeof node.pin === 'string') {
    const pinFile = node.pinFile || '.nvmrc';
    const { text } = await safeRead(readAtBase, pinFile);
    if (text === null) out.push({ id: 'drift.node', text: `${pinFile} was not found at base, so node.pin ${node.pin} was not compared.` });
    else {
      const pinned = text.trim().replace(/^v/i, '');
      if (pinned !== node.pin) out.push({ id: 'drift.node', text: `node.pin is ${node.pin} but ${pinFile} says ${pinned}.` });
    }
  }
  if (tree) {
    const seen = new Set();
    for (const t of pkgTargets(profile)) {
      const key = `${t.cwd}|${t.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let found = null;
      try { found = resolvePkg(t.rel, join(tree, ...t.cwd.split('/')), tree); } catch { /* reported as missing */ }
      if (!found) out.push({ id: `drift.pkg:${t.rel}`, text: `${t.rel} is not installed in this tree (needed by ${t.owner}).` });
    }
  }
  for (const [id, cmd] of Object.entries((profile && profile.commands) || {})) {
    if (!isPlain(cmd) || cmd.kind !== 'test' || !isPlain(cmd.files)) continue;
    const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : '.';
    for (const file of Array.isArray(cmd.files.list) ? cmd.files.list : []) {
      const rel = cwd === '.' ? file : `${cwd}/${file}`;
      const { text } = await safeRead(readAtBase, rel);
      if (text === null) out.push({ id: `drift.tests:${id}`, text: `${id}: the listed test file ${rel} was not found at base.` });
    }
    if (!Array.isArray(cmd.files.roots) || typeof cmd.files.pattern !== 'string' || regexProblem(cmd.files.pattern)) continue;
    const re = new RegExp(cmd.files.pattern);
    for (const root of cmd.files.roots) {
      const rel = [cwd, root].filter(s => s && s !== '.').join('/') || '.';
      let files = null;
      if (listAtBase) {
        try { files = await listAtBase(rel); } catch { files = null; }
      } else if (tree) {
        files = await walk(join(tree, ...rel.split('/')), { pattern: re });
      }
      if (files && !files.some(f => re.test(f))) out.push({ id: `drift.tests:${id}`, text: `${id}: ${rel} has no files matching ${cmd.files.pattern}.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Command line.

const USAGE = 'Usage: node tools/workspace-app/profile/profile.mjs --check <project> [--data-dir <dir>]';

function parseCli(argv) {
  const out = { project: '', dataDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.project = argv[++i] || '';
    else if (a === '--data-dir') out.dataDir = argv[++i] || '';
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `"${a}" is not an option. ${USAGE}` };
  }
  if (out.help) return out;
  if (!PROJECT_RE.test(out.project)) return { error: `--check needs a project name (lowercase letters, digits and hyphens). ${USAGE}` };
  return out;
}

// Prints what is wrong with dataDir/profiles/<project>.json and returns the exit code: 0 when it
// is valid (warnings allowed), 1 when it is missing or has errors, 2 for bad arguments.
export async function runCli(argv, { log = console.log, env = process.env } = {}) {
  const args = parseCli(argv);
  if (args.error) { log(args.error); return 2; }
  if (args.help) { log(USAGE); return 0; }
  const r = await loadProfile(args.dataDir ? resolve(args.dataDir) : defaultDataDir(env), args.project);
  log(`Profile: ${r.path}`);
  if (!r.exists) {
    log('There is no profile there. Use "Create from the example" on the project\'s Settings tab in the app, or copy one from your other PC.');
    return 1;
  }
  for (const e of r.errors) log(`  error: ${e}`);
  for (const w of r.warnings) log(`  warning: ${w}`);
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  log(r.valid ? `Valid, with ${n(r.warnings.length, 'warning')}.` : `Not valid: ${n(r.errors.length, 'error')}, ${n(r.warnings.length, 'warning')}.`);
  return r.valid ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
