// Tests for runs/settings.mjs: the per-stage settings template (R3, R6), the take-over copy and
// the guard config. The template is pinned in full for each profile (the plan's "a unit test
// checks the template's output"), so any change to a rule shows up here.
// Run: node --test tools/workspace-app/runs/settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASH_DENIES, CHECK_PROGRAMS_IN_TREE, GUARD_FILE, GUARD_SCRIPT, HOOK_TIMEOUT_SEC, PROTECTED_IN_TREE, TG_CHECK_ALLOW,
  absRule, guardConfig, isInside, rulePath, sameDir, stageSettings, takeoverSettings, writeStageFiles,
} from './settings.mjs';
import { tempDir } from '../test/helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const DATA = 'C:\\Data\\claude-workspace';
const RUN = `${DATA}\\runs\\example\\261022-104212-x`;
const STAGE = `${RUN}\\stages\\01-scope`;
const base = (over = {}) => ({
  hubRoot: 'C:\\hub', dataDir: DATA, runDir: RUN, stageDir: STAGE, tree: 'D:\\work\\tree', mainDir: 'D:\\work\\main',
  profileDoc: { secrets: { trackedSecretFiles: ['config/secret.json'], denyReadGlobs: ['keys/**'] } }, nodePath: NODE, ...over,
});

// The pinned deny list for the base() paths, in order.
const SECRET_DENIES = [
  'Read(//**/.env*)', 'Edit(//**/.env*)', 'Write(//**/.env*)',
  'Read(//**/.npmrc)', 'Edit(//**/.npmrc)', 'Write(//**/.npmrc)',
  'Read(//**/.sentryclirc)', 'Edit(//**/.sentryclirc)', 'Write(//**/.sentryclirc)',
];
const PRIVATE_DENIES = [
  'Read(//c/Data/claude-workspace/profiles/**)', 'Read(//c/Data/claude-workspace/baselines/**)',
  'Read(//c/Data/claude-workspace/findings/**)', 'Read(//c/Data/claude-workspace/metrics/**)',
  'Read(//c/Data/claude-workspace/wins/**)', 'Read(//c/Data/claude-workspace/reports/**)',
  'Read(//c/Data/claude-workspace/checks/**)', 'Read(//c/Data/claude-workspace/worktrees/**)',
  'Read(//c/Data/claude-workspace/settings.json)', 'Read(//c/Data/claude-workspace/sessions.jsonl)',
];
const PROFILE_SECRET_DENIES = [
  'Read(//d/work/tree/config/secret.json)', 'Read(//d/work/tree/keys/**)',
  'Read(//d/work/main/config/secret.json)', 'Read(//d/work/main/keys/**)',
  'Edit(//d/work/tree/config/secret.json)', 'Write(//d/work/tree/config/secret.json)',
  'Edit(//d/work/tree/keys/**)', 'Write(//d/work/tree/keys/**)',
];
const NO_EDIT_DENIES = [
  'Edit(//c/Data/claude-workspace/**)', 'Write(//c/Data/claude-workspace/**)',
  'Edit(//c/hub/**)', 'Write(//c/hub/**)',
  'Edit(//d/work/main/**)', 'Write(//d/work/main/**)',
];
const EDIT_PROTECTED = [
  'Edit(//d/work/tree/CLAUDE.md)', 'Write(//d/work/tree/CLAUDE.md)',
  'Edit(//d/work/tree/AGENTS.md)', 'Write(//d/work/tree/AGENTS.md)',
  'Edit(//d/work/tree/.github/**)', 'Write(//d/work/tree/.github/**)',
  'Edit(//d/work/tree/.gitignore)', 'Write(//d/work/tree/.gitignore)',
  'Edit(//d/work/tree/node_modules/**)', 'Write(//d/work/tree/node_modules/**)',
  'Edit(//d/work/tree/**/node_modules/**)', 'Write(//d/work/tree/**/node_modules/**)',
];
const SHELL_DENIES = [
  'Bash(git push *)', 'Bash(git commit *)', 'Bash(git stash *)', 'Bash(git reset *)', 'Bash(git checkout *)',
  'Bash(git switch *)', 'Bash(git rebase *)', 'Bash(git merge *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(uv *)',
  'Bash(eas *)', 'Bash(curl *)', 'Bash(wget *)',
];
const HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{
    type: 'command', command: NODE,
    args: [join(HERE, 'guard.mjs'), `${STAGE}\\guard.json`],
    timeout: 10,
  }] }],
};

test('the READ template, pinned in full: no allow rule and no hook', () => {
  assert.deepEqual(stageSettings({ ...base(), profile: 'READ' }), {
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: [...SECRET_DENIES, ...PRIVATE_DENIES, ...PROFILE_SECRET_DENIES, ...NO_EDIT_DENIES, ...SHELL_DENIES],
    },
  });
});

test('the CHECK template, pinned in full: tg-check allowed, the guard hook on Bash', () => {
  assert.deepEqual(stageSettings({ ...base(), profile: 'CHECK' }), {
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      allow: ['Bash(tg-check *)'],
      deny: [...SECRET_DENIES, ...PRIVATE_DENIES, ...PROFILE_SECRET_DENIES, ...NO_EDIT_DENIES, ...SHELL_DENIES],
    },
    hooks: HOOKS,
  });
});

test('the EDIT template, pinned in full: also denies CLAUDE.md, AGENTS.md, .github, .gitignore (A6) and node_modules', () => {
  assert.deepEqual(stageSettings({ ...base(), profile: 'EDIT' }), {
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      allow: ['Bash(tg-check *)'],
      deny: [...SECRET_DENIES, ...PRIVATE_DENIES, ...PROFILE_SECRET_DENIES, ...NO_EDIT_DENIES, ...EDIT_PROTECTED, ...SHELL_DENIES],
    },
    hooks: HOOKS,
  });
  assert.deepEqual([...PROTECTED_IN_TREE], ['CLAUDE.md', 'AGENTS.md', '.github/**', '.gitignore']);
  assert.deepEqual([...CHECK_PROGRAMS_IN_TREE], ['node_modules/**', '**/node_modules/**']);
});

test('R6: every profile keeps memory off, blocks outside reads and has the required denies', () => {
  for (const profile of ['READ', 'CHECK', 'EDIT']) {
    const s = stageSettings({ ...base(), profile });
    const deny = s.permissions.deny;
    assert.equal(s.autoMemoryEnabled, false);
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
    for (const rule of ['Read(//**/.env*)', 'Read(//**/.npmrc)', 'Read(//**/.sentryclirc)', 'Edit(//**/.env*)',
      'Edit(//c/Data/claude-workspace/**)', 'Edit(//c/hub/**)', 'Read(//c/Data/claude-workspace/profiles/**)',
      'Bash(git push *)', 'Bash(git commit *)', 'Bash(git stash *)', 'Bash(npm *)', 'Bash(npx *)']) {
      assert.ok(deny.includes(rule), `${profile} lacks ${rule}`);
    }
    assert.equal(new Set(deny).size, deny.length, 'no duplicate rules');
    assert.ok(deny.every(r => /^(Read|Edit|Write|Bash)\([^()]+\)$/.test(r)), 'every rule is well formed');
    if (profile === 'READ') {
      assert.equal(s.permissions.allow, undefined, 'R3: READ has no Bash allow rule');
      assert.equal(s.hooks, undefined);
    } else {
      assert.deepEqual(s.permissions.allow, [TG_CHECK_ALLOW]);
      const hook = s.hooks.PreToolUse[0];
      assert.equal(hook.matcher, 'Bash');
      assert.deepEqual(hook.hooks[0], { type: 'command', command: NODE, args: [GUARD_SCRIPT, join(STAGE, GUARD_FILE)], timeout: HOOK_TIMEOUT_SEC });
    }
  }
  assert.deepEqual([...BASH_DENIES], SHELL_DENIES);
});

test('the guard hook runs this folder\'s guard.mjs, which exists', () => {
  assert.equal(GUARD_SCRIPT.toLowerCase(), join(HERE, 'guard.mjs').toLowerCase());
  assert.ok(existsSync(GUARD_SCRIPT));
  assert.equal(HOOK_TIMEOUT_SEC, 10);
});

test('the main checkout gets an edit deny only when the stage works in another tree', () => {
  const same = stageSettings({ ...base({ mainDir: 'D:\\work\\tree' }), profile: 'EDIT' }).permissions.deny;
  assert.ok(!same.some(r => /^(Edit|Write)\(\/\/d\/work\/tree\/\*\*\)$/.test(r)), 'the tree itself stays editable');
  assert.ok(same.includes('Edit(//d/work/tree/**/node_modules/**)'), 'only its node_modules folders are not');
  assert.ok(!same.some(r => r.includes('//d/work/main')));
  const noMain = stageSettings({ ...base({ mainDir: undefined }), profile: 'EDIT' }).permissions.deny;
  assert.deepEqual(noMain, same, 'mainDir defaults to the tree');
  const caseOnly = stageSettings({ ...base({ mainDir: 'd:/WORK/tree/' }), profile: 'EDIT' }).permissions.deny;
  assert.ok(!caseOnly.some(r => /^(Edit|Write)\(\/\/d\/work\/tree\/\*\*\)$/i.test(r)), 'paths compare without case');
});

test('a run folder outside the data folder gets its own edit deny', () => {
  const deny = stageSettings({ ...base({ runDir: 'E:\\runs\\r1', stageDir: 'E:\\runs\\r1\\stages\\01-scope' }), profile: 'CHECK' }).permissions.deny;
  assert.ok(deny.includes('Edit(//e/runs/r1/**)') && deny.includes('Write(//e/runs/r1/**)'));
  const inside = stageSettings({ ...base(), profile: 'CHECK' }).permissions.deny;
  assert.ok(!inside.some(r => r.includes('runs/example/261022')), 'covered by the data folder deny');
});

test('a profile without secrets adds no extra rules; bad secret entries throw', () => {
  const plain = stageSettings({ ...base({ profileDoc: null }), profile: 'READ' }).permissions.deny;
  assert.ok(!plain.some(r => r.includes('secret.json') || r.includes('keys/')));
  for (const bad of ['../outside.json', 'C:\\abs.json', '/abs.json', 'a(b).json', '']) {
    assert.throws(() => stageSettings({ ...base({ profileDoc: { secrets: { trackedSecretFiles: [bad] } } }), profile: 'READ' }),
      /must be a relative path inside the project/, bad);
  }
  assert.throws(() => stageSettings({ ...base({ profileDoc: { secrets: { denyReadGlobs: ['x/../../y'] } } }), profile: 'READ' }), /relative path/);
});

test('stageSettings refuses unknown profiles and relative folders', () => {
  assert.throws(() => stageSettings({ ...base(), profile: 'ADMIN' }), /"ADMIN" is not a stage profile/);
  assert.throws(() => stageSettings({ ...base(), profile: 'constructor' }), /not a stage profile/);
  for (const key of ['hubRoot', 'dataDir', 'runDir', 'stageDir', 'tree', 'nodePath']) {
    assert.throws(() => stageSettings({ ...base({ [key]: 'relative\\path' }), profile: 'READ' }), new RegExp(`needs an absolute ${key}`));
  }
});

test('rulePath and absRule give the //c/... form with a lowercase drive letter', () => {
  assert.equal(rulePath('C:\\Users\\X\\Folder\\'), '//c/Users/X/Folder');
  assert.equal(rulePath('c:/a//b/./c'), '//c/a/b/c');
  assert.equal(rulePath('D:\\x\\**'), '//d/x/**');
  assert.equal(rulePath('/tmp/run'), '//tmp/run');
  assert.equal(absRule('Read', 'C:\\Data\\x.json'), 'Read(//c/Data/x.json)');
  assert.throws(() => rulePath('relative\\x'), /is not an absolute path/);
  assert.throws(() => rulePath(''), /An empty path is not an absolute path/);
  assert.throws(() => rulePath('C:\\Program Files (x86)\\x'), /parentheses/);
  assert.ok(sameDir('C:\\A\\b', 'c:/a/B/'));
  assert.ok(!sameDir('C:\\A\\b', 'C:\\A\\bc'));
  assert.ok(isInside('C:\\A', 'c:\\a\\b\\c'));
  assert.ok(isInside('C:\\A', 'C:\\A'));
  assert.ok(!isInside('C:\\A', 'C:\\AB'));
  assert.ok(!isInside('relative', 'C:\\A'));
});

test('takeoverSettings is the same object without hooks and leaves the input alone', () => {
  const s = stageSettings({ ...base(), profile: 'EDIT' });
  const before = JSON.stringify(s);
  const t = takeoverSettings(s);
  assert.equal(t.hooks, undefined);
  assert.deepEqual(t, { autoMemoryEnabled: false, permissions: s.permissions });
  assert.equal(JSON.stringify(s), before);
  t.permissions.deny.push('x');
  assert.equal(JSON.stringify(s), before, 'a deep copy');
});

test('guardConfig lists the roots and names a tg-check command may never contain', () => {
  assert.deepEqual(guardConfig({ ...base(), secretFiles: ['config/secret.json'] }), {
    version: 1, tree: 'D:\\work\\tree',
    forbiddenRoots: [RUN, 'C:\\hub', DATA, 'D:\\work\\main'],
    forbiddenNames: ['.env', '.npmrc', '.sentryclirc', 'config/secret.json', 'secret.json'],
    subcommands: ['test', 'types', 'lint'],
  });
  const same = guardConfig({ ...base({ mainDir: 'D:\\work\\tree' }) });
  assert.deepEqual(same.forbiddenRoots, [RUN, 'C:\\hub', DATA]);
  assert.throws(() => guardConfig({ ...base({ tree: 'tree' }) }), /needs an absolute tree/);
  assert.throws(() => guardConfig({ ...base(), secretFiles: ['../x'] }), /relative path/);
});

test('writeStageFiles writes settings.json, and guard.json only for CHECK and EDIT', async t => {
  const root = tempDir('wp9-settings-', t);
  for (const profile of ['READ', 'CHECK', 'EDIT']) {
    const stageDir = join(root, 'runs', 'r1', 'stages', `01-${profile.toLowerCase()}`);
    const opts = { ...base({ dataDir: root, runDir: join(root, 'runs', 'r1'), stageDir, tree: join(root, 'tree'), mainDir: join(root, 'tree') }), profile };
    const out = await writeStageFiles(opts);
    assert.equal(out.settingsFile, join(stageDir, 'settings.json'));
    assert.deepEqual(JSON.parse(readFileSync(out.settingsFile, 'utf8')), stageSettings(opts));
    if (profile === 'READ') {
      assert.equal(out.guardFile, '');
      assert.ok(!existsSync(join(stageDir, 'guard.json')));
    } else {
      assert.equal(out.guardFile, join(stageDir, 'guard.json'));
      const cfg = JSON.parse(readFileSync(out.guardFile, 'utf8'));
      assert.deepEqual(cfg.forbiddenNames, ['.env', '.npmrc', '.sentryclirc', 'config/secret.json', 'secret.json']);
      assert.equal(cfg.tree, join(root, 'tree'));
    }
  }
});
