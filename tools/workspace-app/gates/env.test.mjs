// Tests for gates/env.mjs: the scrubbed check environment (SPEC R9) and the preset rules the
// profile relies on. Secret-shaped values are built at runtime; the profile is the synthetic
// example from pipelines/app/profiles/example.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeProfile } from '../test/helpers.mjs';
import { SYSTEM_VARS, checkEnv, presetProblems } from './env.mjs';

const lowerKeys = env => Object.keys(env).map(k => k.toLowerCase());
const get = (env, name) => {
  const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : env[k];
};

// A fake parent environment: the system variables plus tokens a check must never see.
function fakeSource() {
  return {
    Path: 'C:\\Windows\\system32;C:\\tools',
    PATHEXT: '.COM;.EXE',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    TEMP: 'C:\\Users\\user\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\user\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\user',
    APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ANTHROPIC_API_KEY: `sk-${'ant-'}${'a'.repeat(30)}`,
    GITHUB_TOKEN: `gh${'p'}_${'b'.repeat(36)}`,
    NPM_TOKEN: 'c'.repeat(36),
    MESHY_API_KEY: 'd'.repeat(32),
    AWS_SECRET_ACCESS_KEY: 'e'.repeat(40),
    NODE_OPTIONS: '--require C:\\evil.js',
    NODE_TEST_CONTEXT: 'child-v8',
    EXAMPLE_IT_DB_URL: 'postgresql://real:real@db.example.invalid:5432/prod',
  };
}

test('only system variables come from the parent environment', () => {
  const env = checkEnv(fakeProfile(), { source: fakeSource() });
  const allowed = new Set([...SYSTEM_VARS, ...Object.keys(fakeProfile().env.preset), 'NO_COLOR', 'FORCE_COLOR'].map(k => k.toLowerCase()));
  for (const k of lowerKeys(env)) assert.ok(allowed.has(k), `${k} must not reach a check`);
  for (const name of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MESHY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_TEST_CONTEXT']) {
    assert.equal(get(env, name), undefined, name);
  }
  assert.equal(get(env, 'PATH'), 'C:\\Windows\\system32;C:\\tools');
  assert.equal(get(env, 'ProgramFiles(x86)'), 'C:\\Program Files (x86)');
});

test('the real process environment is scrubbed the same way', () => {
  const canary = `WP4_CANARY_${process.pid}`;
  process.env[canary] = 'not-a-real-secret';
  try {
    const env = checkEnv(fakeProfile());
    const allowed = new Set([...SYSTEM_VARS, ...Object.keys(fakeProfile().env.preset), 'NO_COLOR', 'FORCE_COLOR'].map(k => k.toLowerCase()));
    for (const k of lowerKeys(env)) assert.ok(allowed.has(k), `${k} leaked from process.env`);
    assert.equal(get(env, canary), undefined);
  } finally {
    delete process.env[canary];
  }
});

test('names are matched without case and appear once', () => {
  const profile = fakeProfile({ env: { preset: { path: 'C:\\only' } } });
  const env = checkEnv(profile, { source: fakeSource() });
  assert.equal(lowerKeys(env).filter(k => k === 'path').length, 1);
  assert.equal(get(env, 'PATH'), 'C:\\only');
});

test('preset, then command env, then extra; colours are always off', () => {
  const profile = fakeProfile({ env: { preset: { FORCE_COLOR: '3', EXAMPLE_TEST_MODE: 'true', LAYER: 'preset' } } });
  const command = { env: { LAYER: 'command', CMD_ONLY: 'yes' } };
  const env = checkEnv(profile, { command, extra: { LAYER: 'extra', TEMP: 'C:\\run\\tmp\\06-checks', TMP: 'C:\\run\\tmp\\06-checks' }, source: fakeSource() });
  assert.equal(env.LAYER, 'extra');
  assert.equal(env.CMD_ONLY, 'yes');
  assert.equal(env.EXAMPLE_TEST_MODE, 'true');
  assert.equal(env.EXAMPLE_DB_URL, 'postgresql://test:test@127.0.0.1:1/example_test');
  assert.equal(get(env, 'TEMP'), 'C:\\run\\tmp\\06-checks');
  assert.equal(get(env, 'TMP'), 'C:\\run\\tmp\\06-checks');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(get(env, 'FORCE_COLOR'), '0');
});

test('NODE_OPTIONS is set only for commands with heapMb', () => {
  const profile = fakeProfile({ env: { preset: { NODE_OPTIONS: '--inspect' } } });
  const plain = checkEnv(profile, { command: { env: { NODE_OPTIONS: '--require x' } }, source: fakeSource() });
  assert.equal(get(plain, 'NODE_OPTIONS'), undefined);
  const heavy = checkEnv(profile, { command: { heapMb: 6144 }, source: fakeSource() });
  assert.equal(heavy.NODE_OPTIONS, '--max-old-space-size=6144');
  const fromProfile = checkEnv(profile, { command: { heapMb: true }, source: fakeSource() });
  assert.equal(fromProfile.NODE_OPTIONS, `--max-old-space-size=${profile.env.heapMb}`);
  const bad = checkEnv(profile, { command: { heapMb: -1 }, source: fakeSource() });
  assert.equal(get(bad, 'NODE_OPTIONS'), undefined);
});

test('neverSet names are absent unless an integration command sets them itself', () => {
  const profile = fakeProfile({ env: { preset: { EXAMPLE_IT_DB_URL: 'postgresql://test:test@127.0.0.1:1/x' } } });
  const unit = checkEnv(profile, {
    command: profile.commands['test:api'], extra: { EXAMPLE_IT_DB_URL: 'postgresql://x@127.0.0.1:1/y' }, source: fakeSource(),
  });
  assert.equal(get(unit, 'EXAMPLE_IT_DB_URL'), undefined);
  const sneaky = checkEnv(profile, { command: { env: { EXAMPLE_IT_DB_URL: 'postgresql://x@127.0.0.1:1/y' } }, source: fakeSource() });
  assert.equal(get(sneaky, 'example_it_db_url'), undefined);
  const it = checkEnv(fakeProfile(), { command: fakeProfile().commands['integration:api'], source: fakeSource() });
  assert.equal(it.EXAMPLE_IT_DB_URL, 'postgresql://test:test@127.0.0.1:55001/example_it');
});

test('comment keys are never set', () => {
  const profile = fakeProfile({ env: { preset: { _note: 'a comment' } } });
  const env = checkEnv(profile, { command: { env: { _why: 'x' } }, source: fakeSource() });
  assert.equal(env._note, undefined);
  assert.equal(env._why, undefined);
});

test('the example preset has no problems', () => {
  assert.deepEqual(presetProblems(fakeProfile()), []);
});

test('preset problems: closed endpoint, empty values, busy ports, neverSet overlap', () => {
  const cases = [
    [{ EXAMPLE_CACHE_PORT: '6379' }, /EXAMPLE_CACHE_PORT is 6379; it must be the closed port 1/],
    [{ EXAMPLE_DB_URL: 'postgresql://test:test@127.0.0.1:5432/example_test' }, /uses port 5432; it must use the closed port 1/],
    [{ EXAMPLE_QUEUE_URL: 'redis://127.0.0.1/15' }, /has no port/],
    [{ EXAMPLE_QUEUE_URL: 'redis://localhost:1/15' }, /points at localhost/],
    [{ EXAMPLE_QUEUE_URL: 'not a url' }, /is not a URL/],
    [{ EXAMPLE_CACHE_HOST: 'localhost' }, /must be the closed host 127\.0\.0\.1/],
    [{ EXAMPLE_TEST_MODE: '' }, /EXAMPLE_TEST_MODE is empty/],
    [{ EXAMPLE_TEST_MODE: '   ' }, /EXAMPLE_TEST_MODE is empty/],
    [{ EXAMPLE_PAYMENT_KEY: 'host:8080' }, /uses port 8080, which a local service or dev server uses/],
    [{ EXAMPLE_IT_DB_URL: 'postgresql://test:test@127.0.0.1:1/x' }, /also in env\.neverSet/],
    [{ 'BAD-NAME': 'x' }, /invalid variable name/],
    [{ NODE_OPTIONS: '--inspect' }, /NODE_OPTIONS is set by the app only/],
  ];
  for (const [preset, re] of cases) {
    const problems = presetProblems(fakeProfile({ env: { preset } }));
    assert.ok(problems.some(p => re.test(p)), `${JSON.stringify(preset)} gave ${JSON.stringify(problems)}`);
  }
});

test('preset problems: a missing closed endpoint and a preset that is not an object', () => {
  assert.match(presetProblems(fakeProfile({ ports: { closed: null } })).join('\n'), /ports\.closed must be/);
  assert.deepEqual(presetProblems({ env: { preset: [] } }), ['env.preset must be an object of NAME: value.']);
  assert.deepEqual(presetProblems({}), ['env.preset must be an object of NAME: value.']);
});
