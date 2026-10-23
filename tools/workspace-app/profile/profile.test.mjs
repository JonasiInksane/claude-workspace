// Tests for profile/profile.mjs: the validator (SPEC 2.4, including the closed-endpoint rule),
// argv placeholders, risk tags, workspaces, drift, loading and "Create from the example".
// Everything uses the synthetic example project; nothing reads a real profile.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  affectedWorkspaces, argvProblems, closedEndpointProblems, createFromExample, EXAMPLE_PROFILE, exampleProfile, HUB_ROOT,
  loadProfile, portsIn, profileDrift, resolveArgv, resolvePkg, riskTags, runCli, validateProfile, workspaceOf,
} from './profile.mjs';
import { presetProblems } from '../gates/env.mjs';
import { fakeProfile, exampleRepoFiles, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';

const errorsOf = p => validateProfile(p).errors;
const hasError = (p, re) => errorsOf(p).some(e => re.test(e));
const withPreset = preset => fakeProfile({ env: { preset } });

test('the example profile validates with no errors or warnings', () => {
  const r = validateProfile(exampleProfile(), { project: 'example', hubRoot: HUB_ROOT });
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('the example profile does not match its own privacy markers', () => {
  const text = readFileSync(join(HUB_ROOT, ...EXAMPLE_PROFILE.split('/')), 'utf8');
  for (const m of exampleProfile().privacy.markers) assert.equal(new RegExp(m).test(text), false, m);
});

test('missing required keys and wrong types are errors; unknown keys are warnings; _ keys are comments', () => {
  const p = fakeProfile({ version: 2, label: 7, _comment: 'fine', surprise: true, node: { pin: '20', _why: 'x' }, ports: { dev: 'x' } });
  delete p.fences;
  const r = validateProfile(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('version: must be 1'));
  assert.ok(r.errors.includes('label: must be a non-empty string'));
  assert.ok(r.errors.includes('fences: is required'));
  assert.ok(r.errors.includes('node.pin: must be a version such as 20.15.1'));
  assert.ok(r.errors.includes('ports.dev: must be a list'));
  assert.deepEqual(r.warnings, ['surprise: is not a known key']);
  assert.deepEqual(validateProfile(null).errors, ['A profile must be a JSON object.']);
  assert.deepEqual(validateProfile([]).errors, ['A profile must be a JSON object.']);
  assert.ok(validateProfile(fakeProfile({ commands: { 'test:api': { extra: 1 } } })).warnings.includes('commands.test:api.extra: is not a known key'));
});

test('ports lists of the wrong type are errors, never a crash', async t => {
  for (const ports of [{ dev: {} }, { dev: true }, { localServices: {} }, { localServices: false }]) {
    const key = Object.keys(ports)[0];
    let r;
    assert.doesNotThrow(() => { r = validateProfile(fakeProfile({ ports })); }, JSON.stringify(ports));
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes(`ports.${key}: must be a list`), JSON.stringify(r.errors));
    assert.ok(!r.errors.some(e => /could not be checked/.test(e)), 'the runner failing on the same ports is not reported again');
  }
  const dataDir = tempDir('ws-profile-', t);
  mkdirSync(join(dataDir, 'profiles'), { recursive: true });
  writeFileSync(join(dataDir, 'profiles', 'example.json'), JSON.stringify(fakeProfile({ ports: { dev: {} } })));
  const loaded = await loadProfile(dataDir, 'example');
  assert.equal(loaded.exists, true);
  assert.equal(loaded.valid, false);
  assert.ok(loaded.errors.includes('ports.dev: must be a list'));
});

test('mainCheckoutGuard.pattern must not match empty text', () => {
  for (const pattern of ['.*', '^', 'x?', '(?:)']) {
    assert.ok(hasError(fakeProfile({ mainCheckoutGuard: { pattern } }), /mainCheckoutGuard\.pattern: matches empty text, so the guard would always pass/), pattern);
  }
  assert.ok(hasError(fakeProfile({ mainCheckoutGuard: { pattern: '(' } }), /mainCheckoutGuard\.pattern: is not a valid regular expression/));
  assert.ok(hasError(fakeProfile({ mainCheckoutGuard: { pattern: '' } }), /mainCheckoutGuard\.pattern: must be a regular expression/));
  assert.deepEqual(errorsOf(fakeProfile()), [], 'the example guard is fine');
});

test('project must be a valid name and equal the file name', () => {
  assert.ok(hasError(fakeProfile({ project: 'Example App' }), /^project: must be lowercase/));
  assert.match(validateProfile(fakeProfile(), { project: 'other' }).errors.join('\n'), /project: is "example" but the file is other\.json/);
});

test('closed endpoint: an empty preset value fails', () => {
  assert.ok(hasError(withPreset({ EXAMPLE_DB_URL: '' }), /env\.preset\.EXAMPLE_DB_URL: must not be empty/));
  assert.ok(hasError(withPreset({ EXAMPLE_TEST_MODE: '  ' }), /env\.preset\.EXAMPLE_TEST_MODE: must not be empty/));
  assert.ok(hasError(withPreset({ EXAMPLE_FLAG: 1 }), /env\.preset\.EXAMPLE_FLAG: must be a string/));
});

test('closed endpoint: a cache port preset on the local service port 6379 fails', () => {
  const p = withPreset({ EXAMPLE_CACHE_PORT: '6379' });
  assert.ok(hasError(p, /env\.preset\.EXAMPLE_CACHE_PORT: must be port 1 .*not "6379"/));
  assert.ok(closedEndpointProblems(p).some(e => e.startsWith('env.preset.EXAMPLE_CACHE_PORT:')));
});

test('closed endpoint: a database URL on 5432 fails, and so does one with no port', () => {
  assert.ok(hasError(withPreset({ EXAMPLE_DB_URL: 'postgresql://test:test@127.0.0.1:5432/x' }), /EXAMPLE_DB_URL: uses port 5432/));
  assert.ok(hasError(withPreset({ EXAMPLE_DB_URL: 'postgresql://test:test@127.0.0.1/x' }), /EXAMPLE_DB_URL: names no port, so it would use the default port 5432/));
  assert.ok(hasError(withPreset({ EXAMPLE_QUEUE_URL: 'redis://localhost:1/0' }), /EXAMPLE_QUEUE_URL: points at localhost/));
  assert.ok(hasError(withPreset({ EXAMPLE_QUEUE_URL: 'not a url' }), /EXAMPLE_QUEUE_URL: must be a URL/));
});

test('closed endpoint: hosts must be 127.0.0.1, and no value may use a local service or dev port', () => {
  assert.ok(hasError(withPreset({ EXAMPLE_CACHE_HOST: 'localhost' }), /EXAMPLE_CACHE_HOST: must be 127\.0\.0\.1/));
  assert.ok(hasError(withPreset({ EXAMPLE_CACHE_HOST: '' }), /EXAMPLE_CACHE_HOST: must not be empty/));
  assert.ok(hasError(withPreset({ EXAMPLE_CONN: '127.0.0.1:6379' }), /EXAMPLE_CONN: uses port 6379, which is a local service or dev port/));
  assert.ok(hasError(withPreset({ EXAMPLE_API: 'http://127.0.0.1:5173/api' }), /EXAMPLE_API: uses port 5173/));
  assert.ok(hasError(withPreset({ EXAMPLE_DB: 'postgres://u:p@127.0.0.1/db' }), /EXAMPLE_DB: uses port 5432/), 'a default port counts');
  assert.equal(errorsOf(withPreset({ EXAMPLE_NOTE: 'build 6144 ok', EXAMPLE_URL: 'http://127.0.0.1:1' })).length, 0);
  assert.deepEqual(closedEndpointProblems(exampleProfile()), []);
});

test('closed endpoint: names match in any case, because Windows env names ignore case', () => {
  assert.ok(hasError(withPreset({ example_cache_host: 'localhost' }), /env\.preset\.example_cache_host: must be 127\.0\.0\.1/));
  assert.ok(hasError(withPreset({ Example_Cache_Port: '2' }), /env\.preset\.Example_Cache_Port: must be port 1/));
  assert.ok(hasError(withPreset({ example_db_url: 'postgresql://t:t@127.0.0.1/x' }), /example_db_url: names no port/));
  assert.ok(hasError(withPreset({ example_cache_port: '1' }), /env\.preset\.example_cache_port: is the same variable as EXAMPLE_CACHE_PORT on Windows/));
  const cmd = fakeProfile({ commands: { 'types:api': { env: { A_FLAG: 'x', a_flag: 'y' } } } });
  assert.ok(hasError(cmd, /commands\.types:api\.env\.a_flag: is the same variable as A_FLAG/));
});

test('closed endpoint: a keyword DSN with port= on a local service port fails', () => {
  assert.ok(hasError(withPreset({ EXAMPLE_CONN: 'host=127.0.0.1 port=5432 dbname=x' }), /EXAMPLE_CONN: uses port 5432, which is a local service or dev port/));
  assert.deepEqual(portsIn('host=127.0.0.1 PORT = 6379'), [6379]);
  assert.deepEqual(portsIn(' 6379 '), [6379]);
});

// Beyond SPEC 2.4's _URL, _HOST and _PORT: libpq reads PGHOST and PGPORT, and _URI, _DSN and
// _ADDR names reach a service just as well.
test('closed endpoint: PGHOST, PGPORT and names ending in _URI, _DSN or _ADDR must be the closed endpoint', () => {
  const bad = [
    [{ PGHOST: 'localhost' }, /env\.preset\.PGHOST: must be 127\.0\.0\.1/],
    [{ pghostaddr: '::1' }, /env\.preset\.pghostaddr: must be 127\.0\.0\.1/],
    [{ PGPORT: '5433' }, /env\.preset\.PGPORT: must be port 1/],
    [{ EXAMPLE_DB_URI: 'mongodb://127.0.0.1/x' }, /EXAMPLE_DB_URI: names no port, so it would use the default port 27017/],
    [{ EXAMPLE_DB_URI: 'not a url' }, /EXAMPLE_DB_URI: must be a URL/],
    [{ EXAMPLE_DB_DSN: 'host=localhost port=1 dbname=x' }, /EXAMPLE_DB_DSN: points at localhost/],
    [{ EXAMPLE_DB_DSN: 'host=127.0.0.1 dbname=x' }, /EXAMPLE_DB_DSN: names no port/],
    [{ EXAMPLE_DB_DSN: 'host=127.0.0.1 port=7000' }, /EXAMPLE_DB_DSN: uses port 7000/],
    [{ EXAMPLE_CACHE_ADDR: 'localhost' }, /EXAMPLE_CACHE_ADDR: must be a URL, a "host=\.\.\. port=\.\.\." DSN or host:port/],
    [{ EXAMPLE_CACHE_ADDR: '127.0.0.1:7000' }, /EXAMPLE_CACHE_ADDR: uses port 7000/],
  ];
  for (const [preset, re] of bad) assert.ok(hasError(withPreset(preset), re), JSON.stringify(preset));
  const good = {
    PGHOST: '127.0.0.1', PGPORT: '1', EXAMPLE_DB_URI: 'mongodb://127.0.0.1:1/x', EXAMPLE_DB_DSN: "host=127.0.0.1 port='1' dbname=x",
    EXAMPLE_CACHE_ADDR: '127.0.0.1:1', EXAMPLE_QUEUE_DSN: 'redis://127.0.0.1:1/0',
  };
  assert.deepEqual(errorsOf(withPreset(good)), []);
});

test('closed endpoint: a URL, DSN or host:port on this PC under any other name must be the closed endpoint', () => {
  const bad = [
    [{ EXAMPLE_API: 'http://localhost:9000/v1' }, /env\.preset\.EXAMPLE_API: points at localhost:9000 on this PC/],
    [{ EXAMPLE_API: 'http://127.0.0.1/v1' }, /EXAMPLE_API: points at 127\.0\.0\.1:80 on this PC/],
    [{ EXAMPLE_CONN: '[::1]:7000' }, /EXAMPLE_CONN: points at \[::1\]:7000 on this PC/],
    [{ EXAMPLE_CONN: '0.0.0.0:7000' }, /EXAMPLE_CONN: points at 0\.0\.0\.0:7000/],
    [{ EXAMPLE_CONN: 'host=localhost dbname=x' }, /EXAMPLE_CONN: points at localhost on this PC/],
  ];
  for (const [preset, re] of bad) assert.ok(hasError(withPreset(preset), re), JSON.stringify(preset));
  const good = {
    EXAMPLE_API: 'http://127.0.0.1:1/v1', EXAMPLE_REMOTE: 'https://api.example.com/v1', EXAMPLE_NOTE: 'localhost is fine as text',
    EXAMPLE_LIST: 'localhost,127.0.0.1', EXAMPLE_BIND: '127.0.0.1',
  };
  assert.deepEqual(errorsOf(withPreset(good)), []);
  const cmd = fakeProfile({ commands: { 'integration:api': { env: { EXAMPLE_IT_SVC: 'http://localhost:55001' } } } });
  assert.deepEqual(errorsOf(cmd), [], 'a command may use its requiresPorts on loopback');
  const other = fakeProfile({ commands: { 'integration:api': { env: { EXAMPLE_IT_SVC: 'http://localhost:55002' } } } });
  assert.ok(hasError(other, /integration:api\.env\.EXAMPLE_IT_SVC: points at localhost:55002 on this PC/));
});

test('a preset the check runner (gates/env.mjs presetProblems) refuses never validates', () => {
  const presets = [
    { EXAMPLE_DB_URL: '' }, { EXAMPLE_CACHE_PORT: '6379' }, { EXAMPLE_CACHE_HOST: 'localhost' },
    { EXAMPLE_DB_URL: 'postgresql://test:test@127.0.0.1:5432/x' }, { EXAMPLE_DB_URL: 'postgresql://test:test@127.0.0.1/x' },
    { EXAMPLE_QUEUE_URL: 'redis://10.0.0.5:1/0' }, { EXAMPLE_QUEUE_URL: 'nope' }, { EXAMPLE_API: 'http://127.0.0.1:8080' },
    { EXAMPLE_DSN: 'host=127.0.0.1 port=6379' }, { EXAMPLE_IT_DB_URL: 'postgresql://t:t@127.0.0.1:1/x' }, { 'BAD NAME': 'x' },
    { EXAMPLE_FLAG: 7 }, { EXAMPLE_PORTLESS: '5173' },
  ];
  for (const preset of presets) {
    const p = withPreset(preset);
    const runner = presetProblems(p);
    assert.ok(runner.length > 0, `the runner refuses ${JSON.stringify(preset)}`);
    const r = validateProfile(p);
    assert.equal(r.ok, false, JSON.stringify(preset));
    for (const msg of runner) {
      const name = (/^env\.preset\.([A-Za-z0-9_]+)/.exec(msg) || [])[1];
      if (name) assert.ok(r.errors.some(e => e.startsWith(`env.preset.${name}:`) || (e.startsWith('env.neverSet:') && e.includes(name))), `${msg} is reported`);
    }
  }
  assert.deepEqual(presetProblems(fakeProfile()), [], 'the runner accepts the example preset');
  const r = validateProfile(withPreset({ EXAMPLE_CACHE_PORT: '6379' }));
  assert.equal(r.errors.filter(e => e.startsWith('env.preset.EXAMPLE_CACHE_PORT:')).length, 1, 'a problem is reported once');
});

test('closed endpoint: the closed port itself must not be a dev or local service port', () => {
  assert.ok(hasError(fakeProfile({ ports: { closed: { port: 5432 } } }), /ports\.closed\.port: must not be a dev or local service port/));
  assert.ok(hasError(fakeProfile({ ports: { closed: { host: 'localhost' } } }), /ports\.closed\.host: must be 127\.0\.0\.1/));
});

test('neverSet names are never in the preset, and only integration commands may set them', () => {
  assert.ok(hasError(withPreset({ EXAMPLE_IT_DB_URL: 'postgresql://t:t@127.0.0.1:1/x' }), /env\.neverSet: EXAMPLE_IT_DB_URL is also in env\.preset/));
  const p = fakeProfile({ commands: { 'test:api': { env: { EXAMPLE_IT_DB_URL: 'postgresql://t:t@127.0.0.1:1/x' } } } });
  assert.ok(hasError(p, /commands\.test:api\.env\.EXAMPLE_IT_DB_URL: is a neverSet name/));
  assert.equal(errorsOf(fakeProfile()).length, 0, 'integration:api sets it with requiresPorts');
});

test('command env may use its requiresPorts on loopback, nothing else', () => {
  const ok = fakeProfile({ commands: { 'integration:api': { env: { EXAMPLE_IT_HOST: 'localhost', EXAMPLE_IT_PORT: '55001' } } } });
  assert.deepEqual(errorsOf(ok), []);
  const bad = fakeProfile({ commands: { 'integration:api': { env: { EXAMPLE_IT_DB_URL: 'postgresql://t:t@127.0.0.1:55002/x' } } } });
  assert.ok(hasError(bad, /integration:api\.env\.EXAMPLE_IT_DB_URL: uses port 55002/));
  const remote = fakeProfile({ commands: { 'integration:api': { env: { EXAMPLE_IT_DB_URL: 'postgresql://t:t@db.example.com:55001/x' } } } });
  assert.ok(hasError(remote, /points at db\.example\.com/));
  const noPorts = fakeProfile({ commands: { 'test:api': { env: { EXAMPLE_SVC_URL: 'http://127.0.0.1:55001' } } } });
  assert.ok(hasError(noPorts, /test:api\.env\.EXAMPLE_SVC_URL: uses port 55001/));
});

test('NODE_OPTIONS is set only by the app (heapMb)', () => {
  assert.ok(hasError(withPreset({ NODE_OPTIONS: '--max-old-space-size=1' }), /env\.preset\.NODE_OPTIONS: is set by the app only/));
  assert.ok(hasError(fakeProfile({ commands: { 'types:api': { env: { node_options: '--inspect' } } } }), /node_options: is set by the app only/));
});

test('argv: an unknown placeholder fails', () => {
  const p = fakeProfile({ commands: { 'types:api': { argv: ['{node}', '{nodeDir}/x.js'] } } });
  assert.ok(hasError(p, /commands\.types:api\.argv: \{nodeDir\} is not a placeholder/));
});

test('argv: {files} twice fails, and so do {files} inside an argument and a stray brace', () => {
  assert.ok(hasError(fakeProfile({ commands: { 'test:api': { argv: ['{node}', '--test', '{files}', '{files}'] } } }), /test:api\.argv: \{files\} may appear only once/));
  assert.ok(hasError(fakeProfile({ commands: { 'test:api': { argv: ['{node}', '--files={files}'] } } }), /\{files\} must be a whole argument/));
  assert.ok(hasError(fakeProfile({ commands: { 'types:api': { argv: ['{node}', '-e', 'a{b'] } } }), /argument 3 has a "\{" or "\}" that is not part of a placeholder/));
  assert.ok(hasError(fakeProfile({ commands: { 'types:api': { argv: ['{node}', '-e', 'if(1){}'] } } }), /\{\} is not a placeholder/));
  assert.ok(hasError(fakeProfile({ commands: { 'types:api': { argv: ['npm.cmd', 'test'] } } }), /must start with "\{node\}"/));
  assert.ok(hasError(fakeProfile({ commands: { 'types:api': { argv: ['{node}', '{pkg:../x.js}'] } } }), /\{pkg:\.\.\/x\.js\}: the package path must not contain/));
  assert.deepEqual(argvProblems(['{node}', '{npmCli}', 'ci', '{tree}', '--base={base}', '{pkg:tsx/dist/cli.mjs}', '{files}']), []);
  assert.deepEqual(argvProblems(['{node}', '{files}'], { files: false }), ['{files} is not allowed here']);
  assert.ok(hasError(fakeProfile({ runTg: [{ id: 'x', label: 'X', cwd: '.', argv: ['{node}', '{files}'], warn: 'w' }] }), /runTg\[0\]\.argv: \{files\} is not allowed here/));
});

test('cross references: commands, kinds, workspaces, groups and levels must line up', () => {
  assert.ok(hasError(fakeProfile({ workspaces: [{ id: 'api', dir: 'apps/api', label: 'API', test: ['types:api'] }] }), /workspaces\[0\]\.test\[0\]: command "types:api" is of kind types, not test/));
  assert.ok(hasError(fakeProfile({ workspaces: [{ id: 'api', dir: 'apps/api', label: 'API', test: ['nope'] }] }), /there is no command "nope"/));
  assert.ok(hasError(fakeProfile({ commands: { 'test:api': { workspace: 'mobile' } } }), /commands\.test:api\.workspace: there is no workspace "mobile"/));
  assert.ok(hasError(fakeProfile({ commands: { 'test:api': { kind: 'unit' } } }), /commands\.test:api\.kind: must be one of/));
  assert.ok(hasError(fakeProfile({ commands: { 'test:api': { timeoutSec: 0 } } }), /commands\.test:api\.timeoutSec: must be a whole number/));
  assert.ok(hasError(fakeProfile({ format: { cmd: 'types:api' } }), /format\.cmd: command "types:api" is of kind types, not format/));
  assert.ok(hasError(fakeProfile({ groups: { G0: { label: 'x', perWorkspace: 'types' } } }), /groups\.G0: G0 is built in/));
  assert.ok(hasError(fakeProfile({ levels: { quick: { groups: ['G0', 'G7'] } } }), /levels\.quick\.groups\[1\]: there is no group "G7"/));
  assert.ok(hasError(fakeProfile({ groups: { G3: { commands: ['nope'] } } }), /groups\.G3\.commands\[0\]: there is no command "nope"/));
  assert.ok(hasError(fakeProfile({ groups: { G2: { serverFocused: 'mobile' } } }), /groups\.G2\.serverFocused: there is no workspace/));
  const dup = fakeProfile();
  dup.workspaces.push({ id: 'api', dir: 'apps/api2', label: 'again' });
  assert.ok(hasError(dup, /workspaces\[3\]\.id: "api" is used twice/));
  assert.ok(hasError(fakeProfile({ workspaces: [{ id: 'api', dir: 'apps\\api', label: 'API' }] }), /workspaces\[0\]\.dir: must use forward slashes/));
  assert.ok(hasError(fakeProfile({ workspaces: [{ id: 'api', dir: '../api', label: 'API' }] }), /must not contain "\.\."/));
  assert.ok(hasError(fakeProfile({ isolation: { setup: ['install', 'seed'] } }), /isolation\.setup\[1\]: must be install or generate/));
});

test('isolation.worktreePath: absolute, short, not a drive root, outside the hub and the main checkout', () => {
  const wt = path => validateProfile(fakeProfile({ isolation: { worktreePath: path } }), { hubRoot: 'C:\\dev\\hub', mainDir: 'D:\\code\\example' }).errors;
  assert.deepEqual(wt('C:\\dev\\example-run'), []);
  assert.match(wt('dev\\run').join(), /must be an absolute Windows path/);
  assert.match(wt('\\\\server\\share\\run').join(), /must be an absolute Windows path/);
  assert.match(wt('C:\\').join(), /must not be a drive root/);
  assert.match(wt(`C:\\${'x'.repeat(60)}`).join(), /must be short/);
  assert.match(wt('C:\\dev\\HUB\\run').join(), /must not be inside the workspace hub/);
  assert.match(wt('d:\\code\\example\\run').join(), /must not be the main checkout or inside it/);
  assert.match(wt('D:\\code').join(), /must not be the main checkout or inside it/);
});

test('git prefixes are fixed, fences and read denies must cover the secret files', () => {
  assert.ok(hasError(fakeProfile({ git: { branchPrefix: 'feature/' } }), /git\.branchPrefix: must be "app\/"/));
  assert.ok(hasError(fakeProfile({ git: { archivePrefix: 'old/' } }), /git\.archivePrefix/));
  const fences = fakeProfile({ fences: { forbidden: ['vendor/**', '**/.npmrc'] } });
  assert.match(errorsOf(fences).join('\n'), /fences\.forbidden: must cover \.env, apps\/x\/\.env, \.env\.local, apps\/x\/\.env\.production, \.sentryclirc, \.claude\/settings\.json/);
  assert.ok(hasError(fakeProfile({ secrets: { denyReadGlobs: ['**/.env'] } }), /secrets\.denyReadGlobs: must cover \.env\.local/));
  assert.ok(hasError(fakeProfile({ risk: { money: ['apps\\api\\**'] } }), /risk\.money\[0\]: must use forward slashes/));
  assert.ok(hasError(fakeProfile({ fences: { testPattern: '(' } }), /fences\.testPattern: is not a valid regular expression/));
  const liveKey = 'sk_' + 'live_' + 'x'.repeat(24);
  assert.ok(hasError(fakeProfile({ secrets: { allowValues: [liveKey] } }), /secrets\.allowValues\[0\]: looks like a live key/));
  assert.ok(hasError(fakeProfile({ privacy: { markers: ['.*'] } }), /privacy\.markers\[0\]: matches empty text/));
});

test('probes, scores and achievements are checked', () => {
  assert.ok(hasError(fakeProfile({ probes: [{ id: 'x', kind: 'magic', label: 'X', measures: 'm' }] }), /probes\[0\]\.kind: must be one of/));
  assert.ok(hasError(fakeProfile({ probes: [{ id: 'x', kind: 'regexCount', label: 'X', measures: 'm', files: ['**/*.mjs'] }] }), /probes\[0\]\.regex: is required for a regexCount probe/));
  assert.ok(hasError(fakeProfile({ probes: [{ id: 'x', kind: 'regexCount', label: 'X', measures: 'm', files: ['**/*.mjs'], regex: '[' }] }), /probes\[0\]\.regex: is not a valid regular expression/));
  assert.ok(hasError(fakeProfile({ builders: null }), /builders: is required by the routerKeys probe "procedures"/));
  assert.ok(hasError(fakeProfile({ probes: [{ id: 'e', kind: 'expoParity', label: 'E', measures: 'm' }] }), /an expoParity probe needs the expo section/));
  assert.ok(hasError(fakeProfile({ score: { todoCount: { weight: 1, target: 3, ref: 3 } } }), /score\.todoCount: ref and target must differ/));
  assert.ok(hasError(fakeProfile({ score: { todoCount: { weight: 0, target: 0, ref: 3 } } }), /score\.todoCount\.weight: must be more than 0/));
  assert.ok(validateProfile(fakeProfile({ tiles: ['nope.value'] })).warnings.includes('tiles[0]: "nope.value" is not a probe id or knownFailures'));
  assert.ok(hasError(fakeProfile({ achievements: [{ id: 'a', label: 'A', when: { metric: 'todoCount', op: '!=', value: 1 } }] }), /achievements\[0\]\.when\.op: must be one of/));
  assert.ok(hasError(fakeProfile({ models: { 'refactor.scope': { effort: 'ultra' } } }), /models\.refactor\.scope\.effort: must be one of/));
  assert.ok(hasError(fakeProfile({ caps: { read: { maxTurns: 0 } } }), /caps\.read\.maxTurns: must be a whole number from 1 to 200/));
  assert.ok(hasError(fakeProfile({ caps: { edit: { budgetUsd: 100 } } }), /caps\.edit\.budgetUsd: must be from 0\.5 to 50/));
  assert.ok(hasError(fakeProfile({ caps: { edit: { minutes: 0 } } }), /caps\.edit\.minutes: must be more than 0/));
  const capWarn = validateProfile(fakeProfile({ caps: { read: { turns: 5 }, review: {} } }));
  assert.deepEqual(capWarn.warnings, ['caps.review: is not a known key', 'caps.read.turns: is not a known key']);
  assert.deepEqual(errorsOf(fakeProfile({ caps: { read: { maxTurns: 60, minutes: 30, budgetUsd: 5 } }, models: { scope: { model: 'opus' }, 'refactor.implement': { effort: 'max' } } })), [], 'both models key forms');
  assert.ok(hasError(fakeProfile({ models: { 'Refactor Scope': { model: 'opus' } } }), /models\.Refactor Scope: must be "<pipeline>\.<stage>" or a stage id/));
  const probe = extra => fakeProfile({ probes: [{ id: 'x', kind: 'regexCount', label: 'X', measures: 'm', files: ['**/*.mjs'], regex: 'x', ...extra }] });
  assert.deepEqual(validateProfile(probe({ flags: 'i', file: 'public.mjs', assertPattern: 'ensure', assertingBuilders: ['a'], action: null })).errors, []);
  assert.deepEqual(validateProfile(probe({ action: { pipeline: 'refactor', what: 'Shrink it' } })).warnings.filter(w => w.startsWith('probes')), [], 'probe options are known keys');
  assert.ok(hasError(probe({ flags: 'g' }), /probes\[0\]\.flags: may only hold i, s and u/));
  assert.ok(hasError(probe({ file: 'a/b.ts' }), /probes\[0\]\.file: must be a file name/));
  assert.ok(hasError(probe({ action: { pipeline: 'refactor' } }), /probes\[0\]\.action: must be null or \{pipeline, what\}/));
  assert.deepEqual(errorsOf(fakeProfile({ commands: { 'types:web': { heapMb: true } } })), [], 'heapMb: true uses env.heapMb');
  assert.ok(hasError(fakeProfile({ env: { heapMb: null }, commands: { 'types:web': { heapMb: true } } }), /types:web\.heapMb: is true, so env\.heapMb must be set/));
  assert.ok(hasError(fakeProfile({ contract: { queues: [{ file: 'a.mjs' }] } }), /contract\.queues\[0\]: needs either enum or regex/));
  assert.ok(hasError(fakeProfile({ findings: { audit: 'reports/audit.md' } }), /findings\.audit: must be an absolute Windows path/));
});

test('portsIn finds numbers, URL ports, default ports and host:port pairs', () => {
  assert.deepEqual(portsIn('6379'), [6379]);
  assert.deepEqual(portsIn('redis://127.0.0.1:1/15'), [1]);
  assert.deepEqual(portsIn('postgresql://u:p@127.0.0.1/x'), [5432]);
  assert.deepEqual(portsIn('a:8080,b:9090').sort(), [8080, 9090]);
  assert.deepEqual(portsIn('true'), []);
});

test('resolveArgv fills placeholders; {files} are relative to the cwd with forward slashes', t => {
  const tree = tempDir('ws-argv-', t);
  writeFiles(tree, { 'node_modules/tool/cli.mjs': '', 'apps/api/node_modules/near/x.js': '' });
  const cwd = join(tree, 'apps', 'api');
  const node = join('C:', 'Node', 'node.exe');
  const argv = resolveArgv(['{node}', '{npmCli}', '{pkg:tool/cli.mjs}', '{pkg:near/x.js}', '--root={tree}', '{base}', '{files}'], {
    node, tree, cwd, base: 'abc123', files: ['apps/api/src/a.test.mjs', join(tree, 'apps', 'api', 'src', 'b.test.mjs'), 'scripts/c.mjs'],
  });
  assert.deepEqual(argv, [
    node, join('C:', 'Node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(tree, 'node_modules', 'tool', 'cli.mjs'),
    join(cwd, 'node_modules', 'near', 'x.js'), `--root=${tree}`, 'abc123', 'src/a.test.mjs', 'src/b.test.mjs', '../../scripts/c.mjs',
  ]);
  assert.equal(resolveArgv(['{node}'], {})[0], process.execPath);
  assert.throws(() => resolveArgv(['{node}', '{pkg:missing/bin.js}'], { tree, cwd }), /^Error: missing\/bin\.js is not installed in this tree$/);
  assert.throws(() => resolveArgv(['{node}', '{files}'], { tree, files: [] }), /has no files to run/);
  assert.throws(() => resolveArgv(['{node}', '{files}'], { tree }), /needs a file list/);
  assert.throws(() => resolveArgv(['{node}', '{tree}'], {}), /needs a tree/);
  assert.throws(() => resolveArgv(['{node}', '{base}'], { tree }), /needs the base commit/);
  assert.throws(() => resolveArgv(['{node}', '{nope}'], { tree }), /\{nope\} is not a placeholder/);
});

test('resolveArgv: a relative cwd (as profile commands store it) is relative to the tree', t => {
  const tree = tempDir('ws-argv-', t);
  writeFiles(tree, { 'apps/api/node_modules/near/x.js': '' });
  const argv = resolveArgv(['{node}', '{pkg:near/x.js}', '{files}'], { tree, cwd: 'apps/api', files: ['apps/api/src/a.test.mjs'] });
  assert.deepEqual(argv.slice(1), [join(tree, 'apps', 'api', 'node_modules', 'near', 'x.js'), 'src/a.test.mjs']);
  const abs = resolveArgv(['{node}', '{files}'], { tree, cwd: join(tree, 'apps', 'api'), files: ['apps/api/src/a.test.mjs'] });
  assert.deepEqual(abs.slice(1), ['src/a.test.mjs'], 'an absolute cwd is used as it is');
});

test('resolvePkg searches from the cwd up to the tree root and never above it', t => {
  const outer = tempDir('ws-pkg-', t);
  const tree = join(outer, 'tree');
  writeFiles(outer, { 'node_modules/above/x.js': '', 'tree/node_modules/root/x.js': '', 'tree/apps/web/node_modules/root/x.js': '' });
  mkdirSync(join(tree, 'apps', 'web', 'src'), { recursive: true });
  assert.equal(resolvePkg('root/x.js', join(tree, 'apps', 'web', 'src'), tree), join(tree, 'apps', 'web', 'node_modules', 'root', 'x.js'));
  assert.equal(resolvePkg('root/x.js', join(tree, 'apps'), tree), join(tree, 'node_modules', 'root', 'x.js'));
  assert.equal(resolvePkg('above/x.js', join(tree, 'apps'), tree), null, 'never looks above the tree');
  assert.throws(() => resolvePkg('root/x.js', outer, tree), /is outside the tree/);
  assert.throws(() => resolvePkg('../x.js', tree, tree), /is not a package path/);
});

test('riskTags tags synthetic money and tenant paths, with case and renames', () => {
  const p = fakeProfile();
  const r = riskTags(p, ['apps/api/src/billing/charge.mjs', 'apps/web/src/x.mjs', 'apps\\api\\src\\auth\\session.mjs']);
  assert.deepEqual(r.tags, ['money', 'tenant']);
  assert.deepEqual(r.hits, [
    { path: 'apps/api/src/billing/charge.mjs', tag: 'money', glob: 'apps/api/src/billing/**' },
    { path: 'apps/api/src/auth/session.mjs', tag: 'tenant', glob: 'apps/api/src/auth/**' },
  ]);
  assert.deepEqual(riskTags(p, ['APPS/API/SRC/BILLING/X.MJS']).tags, ['money']);
  assert.deepEqual(riskTags(p, [{ path: 'apps/api/src/moved.mjs', status: 'R', oldPath: 'apps/api/src/auth/old.mjs' }]).tags, ['tenant']);
  assert.deepEqual(riskTags(p, ['apps/api/src/routes/items/router.mjs']).tags, ['contract']);
  assert.deepEqual(riskTags(p, []), { tags: [], hits: [] });
  assert.deepEqual(riskTags({}, ['x']).tags, []);
});

test('workspaceOf picks the longest dir; affectedWorkspaces adds affectedBy and filters by kind', () => {
  const p = fakeProfile();
  assert.equal(workspaceOf(p, 'apps/api/src/x.mjs').id, 'api');
  assert.equal(workspaceOf(p, 'apps/apix/y.mjs').id, 'root');
  assert.equal(workspaceOf(p, 'scripts/tool.mjs').id, 'root');
  assert.equal(workspaceOf({ workspaces: [{ id: 'a', dir: 'apps/a' }] }, 'b'), null);
  const ids = (paths, kind) => affectedWorkspaces(p, paths, kind).map(ws => ws.id);
  assert.deepEqual(ids(['apps/web/src/x.mjs']), ['web']);
  assert.deepEqual(ids(['apps/api/src/routes/items/router.mjs']), ['api', 'web'], 'web is affectedBy api routes');
  assert.deepEqual(ids(['packages/shared/a.mjs']), ['root', 'api', 'web'], 'root owns it; api and web are affectedBy it');
  assert.deepEqual(ids(['packages/shared/a.mjs'], 'types'), ['api', 'web']);
  assert.deepEqual(ids(['apps/api/src/x.mjs'], 'lint'), []);
  assert.deepEqual(ids(['apps/web/src/x.mjs'], 'lint'), ['web']);
  assert.deepEqual(ids([{ path: 'apps/web/a.mjs', oldPath: 'apps/api/a.mjs' }]), ['api', 'web']);
  assert.deepEqual(ids([]), []);
});

async function exampleRepo(t, extra = {}) {
  const dir = tempDir('ws-drift-', t);
  const sha = await makeRepo(dir, { files: { ...exampleRepoFiles(), ...extra } });
  const readAtBase = async rel => {
    try {
      return await runGit(dir, ['show', `${sha}:${rel}`]);
    } catch {
      return null;
    }
  };
  const listAtBase = async rel => (await runGit(dir, ['ls-tree', '-r', '--name-only', sha, '--', rel === '.' ? '.' : rel])).split('\n').filter(Boolean);
  return { dir, sha, readAtBase, listAtBase };
}

test('profileDrift: an example repo matches the example profile', async t => {
  const { dir, readAtBase, listAtBase } = await exampleRepo(t);
  assert.deepEqual(await profileDrift(fakeProfile(), readAtBase, { listAtBase }), []);
  assert.deepEqual(await profileDrift(fakeProfile(), readAtBase, { tree: dir }), [], 'the example needs no packages');
});

test('profileDrift warns about lint-staged, .nvmrc, missing packages and empty test roots', async t => {
  const { dir, readAtBase, listAtBase } = await exampleRepo(t, {
    'package.json': { name: 'example', 'lint-staged': { '*.{js,md}': 'x' } }, '.nvmrc': 'v24.11.1\n',
  });
  const p = fakeProfile({
    commands: {
      'types:api': { argv: ['{node}', '{pkg:typescript/bin/tsc}'] },
      'test:web': { files: { roots: ['src', 'missing'] } },
      'test:root': { files: { list: ['scripts/tool.test.mjs', 'scripts/gone.test.mjs'] } },
    },
  });
  const drift = await profileDrift(p, readAtBase, { tree: dir, listAtBase });
  const ids = drift.map(d => d.id);
  assert.deepEqual(ids, ['drift.format', 'drift.node', 'drift.pkg:typescript/bin/tsc', 'drift.tests:test:root', 'drift.tests:test:web']);
  assert.match(drift[0].text, /format\.glob is "\*\.\{mjs,md\}" but lint-staged in package\.json uses "\*\.\{js,md\}"/);
  assert.match(drift[1].text, /node\.pin is 20\.15\.1 but \.nvmrc says 24\.11\.1/);
  assert.match(drift[2].text, /typescript\/bin\/tsc is not installed in this tree \(needed by command types:api\)/);
  assert.match(drift[3].text, /scripts\/gone\.test\.mjs was not found at base/);
  assert.match(drift[4].text, /apps\/web\/missing has no files matching/);
  // Without listAtBase the disk is walked instead.
  const disk = await profileDrift(p, readAtBase, { tree: dir });
  assert.ok(disk.some(d => d.id === 'drift.tests:test:web'));
  // A reader that fails is a warning, never a throw.
  const broken = await profileDrift(fakeProfile(), async () => { throw new Error('boom'); });
  assert.ok(broken.some(d => d.id === 'drift.format' && /could not be read at base \(boom\)/.test(d.text)));
});

test('loadProfile: missing, broken JSON, valid, and a project that differs from the file name', async t => {
  const dataDir = tempDir('ws-profile-', t);
  const file = join(dataDir, 'profiles', 'example.json');
  assert.deepEqual(await loadProfile(dataDir, 'example'), { exists: false, valid: false, path: file, profile: null, errors: [], warnings: [] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"version":');
  const broken = await loadProfile(dataDir, 'example');
  assert.equal(broken.exists, true);
  assert.equal(broken.valid, false);
  assert.match(broken.errors[0], /is not valid JSON/);
  writeFileSync(file, JSON.stringify(exampleProfile()));
  const ok = await loadProfile(dataDir, 'example');
  assert.equal(ok.valid, true);
  assert.equal(ok.profile.project, 'example');
  writeFileSync(join(dataDir, 'profiles', 'other.json'), JSON.stringify(exampleProfile()));
  const other = await loadProfile(dataDir, 'other');
  assert.equal(other.valid, false);
  assert.match(other.errors.join(), /is "example" but the file is other\.json/);
  await assert.rejects(loadProfile(dataDir, '../x'), /is not a project name/);
});

test('createFromExample writes a valid profile for the project and never overwrites', async t => {
  const dataDir = tempDir('ws-profile-', t);
  const { path, profile } = createFromExample(HUB_ROOT, dataDir, 'my-app');
  assert.equal(path, join(dataDir, 'profiles', 'my-app.json'));
  assert.equal(profile.project, 'my-app');
  assert.equal(profile.isolation.worktreePath, 'C:\\dev\\my-app-run');
  const loaded = await loadProfile(dataDir, 'my-app');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.valid, true);
  writeFileSync(path, '{"keep": "me"}');
  assert.throws(() => createFromExample(HUB_ROOT, dataDir, 'my-app'), err => err.status === 409 && /already exists; the app never overwrites a profile/.test(err.message));
  assert.equal(readFileSync(path, 'utf8'), '{"keep": "me"}');
  assert.throws(() => createFromExample(HUB_ROOT, dataDir, 'Bad Name'), /is not a project name/);
  assert.throws(() => exampleProfile(dataDir), /could not be read/);
});

test('runCli --check: valid, missing, invalid and bad arguments', async t => {
  const dataDir = tempDir('ws-profile-cli-', t);
  const run = async argv => {
    const lines = [];
    const code = await runCli(argv, { log: s => lines.push(s), env: {} });
    return { code, text: lines.join('\n') };
  };
  const missing = await run(['--check', 'example', '--data-dir', dataDir]);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /There is no profile there\. Use "Create from the example" on the project's Settings tab in the app/);
  writeFiles(dataDir, { 'profiles/example.json': exampleProfile() });
  const ok = await run(['--check', 'example', '--data-dir', dataDir]);
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /Valid, with 0 warnings\./);
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({ env: { preset: { EXAMPLE_CACHE_PORT: '6379' } }, surprise: 1 }) });
  const bad = await run(['--check', 'example', '--data-dir', dataDir]);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /error: env\.preset\.EXAMPLE_CACHE_PORT: must be port 1/);
  assert.match(bad.text, /warning: surprise: is not a known key/);
  assert.match(bad.text, /Not valid: 1 error, 1 warning\./);
  assert.equal((await run(['--check', '../x'])).code, 2);
  assert.equal((await run(['--wat'])).code, 2);
  assert.equal((await run(['--help'])).code, 0);
});

test('profile.mjs runs as a command line', async t => {
  const dataDir = tempDir('ws-profile-cli-', t);
  writeFiles(dataDir, { 'profiles/example.json': exampleProfile() });
  const file = join(HUB_ROOT, 'tools', 'workspace-app', 'profile', 'profile.mjs');
  const r = await new Promise(res => execFile(process.execPath, [file, '--check', 'example', '--data-dir', dataDir], { windowsHide: true }, (err, stdout) => res({ code: err ? err.code : 0, stdout: String(stdout) })));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Valid, with 0 warnings/);
});

test('createFromExample keeps the worktree path short for a long project name', async t => {
  const dataDir = tempDir('ws-profile-', t);
  const name = `${'a'.repeat(38)}-bcdef`;
  const { profile } = createFromExample(HUB_ROOT, dataDir, name);
  assert.equal(profile.isolation.worktreePath, `C:\\dev\\${'a'.repeat(38)}-run`, 'cut to fit, with the trailing hyphen dropped');
  assert.ok(profile.isolation.worktreePath.length <= 50);
  assert.equal((await loadProfile(dataDir, name)).valid, true);
});
