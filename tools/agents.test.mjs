// Tests for tools/lib/agents.mjs, new-agent.mjs and agent-session.mjs.
// Run: node tools/run-tests.mjs
// Each test builds a throwaway workspace root in the temp folder; the real workspace is not touched.
// Child tools get that root as TEMP and a fake claude.exe on PATH, so nothing machine-wide is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  archiveAgent, checkAgentName, checkAgentText, checkProject, duplicateNames, listAgents, listArchivedAgents, readFrontmatter,
  resolveClaude, resolveProject, restoreAgent, saveAgentText, sessionSettings, textHash,
} from './lib/agents.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-agents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projects', 'demo'), { recursive: true });
  mkdirSync(join(root, 'library', 'agents'), { recursive: true });
  writeFileSync(join(root, 'library', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews.\n---\nBody\n');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', WIN ? 'claude.exe' : 'claude'), '');
  return root;
}

function run(tool, args, root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  Object.assign(env, { PATH: join(root, 'bin'), TEMP: root, TMP: root, TMPDIR: root });
  const r = spawnSync(process.execPath, [join(toolsDir, tool), ...args, '--root', root], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function addAgentFile(root, rel, frontmatter) {
  const file = join(root, 'projects', 'demo', '.claude', 'agents', rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\nBody\n`);
}

// Every file and folder under dir, relative and with forward slashes.
function tree(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    out.push(full.slice(base.length + 1).split('\\').join('/'));
    if (e.isDirectory()) tree(full, base, out);
  }
  return out;
}

test('checkAgentName accepts kebab-case and rejects reserved, taken and odd names', () => {
  assert.equal(checkAgentName('asset-builder'), '');
  for (const bad of ['Asset', 'asset_builder', '-x', 'a--b', '', 'explore', 'plan', 'con', 'com1', '../x', 'a/b']) {
    assert.notEqual(checkAgentName(bad), '', bad);
  }
  assert.match(checkAgentName('art', { taken: ['art'] }), /already exists/);
});

test('resolveProject returns the folder\'s real spelling and rejects non-folders', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'projects', 'Tattoogenda'));
  assert.deepEqual(resolveProject(root, 'tattoogenda'), { name: 'Tattoogenda', error: '' });
  assert.deepEqual(resolveProject(root, 'demo'), { name: 'demo', error: '' });
  assert.equal(checkProject(root, 'demo'), '');
  for (const bad of ['missing', '../demo', 'demo/x', '.git', '_hub', 'C:', '']) assert.notEqual(checkProject(root, bad), '', bad);
});

test('readFrontmatter reads plain, single- and double-quoted values', () => {
  const fm = readFrontmatter('\uFEFF---\r\nname: a\r\ndescription: "Use when: x \\"y\\""\r\nmodel: \'it\'\'s\'\r\nmemory: project # note\r\n---\r\nbody');
  assert.deepEqual(fm, { name: 'a', description: 'Use when: x "y"', model: "it's", memory: 'project' });
  assert.equal(readFrontmatter('no frontmatter'), null);
});

test('sessionSettings uses absolute per-agent paths, per memory scope, and keeps auto memory on', () => {
  const s = sessionSettings('/ws', 'demo', 'art');
  assert.equal(s.autoMemoryEnabled, true);
  assert.equal(s.autoMemoryDirectory, resolve('/ws/projects/demo/.claude/agent-memory/art'));
  assert.deepEqual(s.permissions.additionalDirectories, [
    resolve('/ws/inbox/attachments/demo/art'), resolve('/ws/inbox/attachments/demo/_shared'),
  ]);
  assert.equal(sessionSettings('/ws', 'demo', 'art', 'local').autoMemoryDirectory, resolve('/ws/projects/demo/.claude/agent-memory-local/art'));
});

test('listAgents flags unsafe names and duplicateNames finds shared names', t => {
  const root = fixture(t);
  addAgentFile(root, 'art.md', 'name: art\ndescription: a\nmemory: project');
  addAgentFile(root, 'sub/art-v2.md', 'name: art\ndescription: copy\nmemory: project');
  addAgentFile(root, 'evil.md', 'name: ../../../escaped\ndescription: x\nmemory: project');
  addAgentFile(root, 'loc.md', 'name: loc\ndescription: l\nmemory: local');
  const agents = listAgents(root, 'demo');
  assert.equal(agents.find(a => a.name === 'loc').isolated, true);
  const evil = agents.find(a => a.name.includes('escaped'));
  assert.equal(evil.valid, false);
  assert.equal(evil.memoryDir, '');
  assert.deepEqual(duplicateNames(agents).map(d => [d.name, d.files.length]), [['art', 2]]);
});

test('new-agent creates definition, memory and image folders, then never overwrites', t => {
  const root = fixture(t);
  const r = run('new-agent.mjs', ['demo', 'asset-builder', '--role', 'Builds sprites: 2D # pixel art', '--tools', 'Read, Write, Glob'], root);
  assert.equal(r.code, 0, r.err);
  const file = join(root, 'projects', 'demo', '.claude', 'agents', 'asset-builder.md');
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /\{\{/);
  const fm = readFrontmatter(text);
  assert.equal(fm.name, 'asset-builder');
  assert.equal(fm.memory, 'project');
  assert.equal(fm.tools, 'Read, Write, Glob');
  assert.match(fm.description, /Builds sprites: 2D # pixel art/);
  const memory = join(root, 'projects', 'demo', '.claude', 'agent-memory', 'asset-builder', 'MEMORY.md');
  assert.ok(existsSync(memory));
  assert.ok(existsSync(join(root, 'inbox', 'attachments', 'demo', 'asset-builder')));
  assert.ok(existsSync(join(root, 'inbox', 'attachments', 'demo', '_shared')));
  assert.deepEqual(listAgents(root, 'demo').map(a => [a.name, a.isolated]), [['asset-builder', true]]);

  // Name taken: an edited file (even without frontmatter) is never overwritten, nor is memory.
  writeFileSync(file, 'edited');
  writeFileSync(memory, 'learned things');
  const again = run('new-agent.mjs', ['demo', 'asset-builder'], root);
  assert.notEqual(again.code, 0);
  assert.match(again.err, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), 'edited');
  assert.equal(readFileSync(memory, 'utf8'), 'learned things');
});

test('new-agent keeps text on one line, substitutes once and uses the real project spelling', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'projects', 'Tattoogenda'));
  const r = run('new-agent.mjs', ['tattoogenda', 'art', '--role', 'line one\rpermissionMode: bypassPermissions', '--description', '{{AGENT_ROLE}}'], root);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(join(root, 'projects', 'Tattoogenda', '.claude', 'agents', 'art.md'), 'utf8');
  const fm = readFrontmatter(text);
  assert.equal(fm.description, '{{AGENT_ROLE}}');
  assert.equal(fm.permissionMode, undefined);
  assert.match(text, /line one permissionMode: bypassPermissions/);
  assert.ok(readdirSync(join(root, 'inbox', 'attachments')).includes('Tattoogenda'));
});

test('new-agent refuses library agent names, missing projects and bad input', t => {
  const root = fixture(t);
  assert.match(run('new-agent.mjs', ['demo', 'code-reviewer'], root).err, /library agent/);
  assert.match(run('new-agent.mjs', ['nope', 'art'], root).err, /not found/);
  assert.match(run('new-agent.mjs', ['demo', 'Art'], root).err, /kebab-case/);
  assert.match(run('new-agent.mjs', ['demo', 'art', '--tools', 'Read\nBash'], root).err, /--tools/);
  assert.match(run('new-agent.mjs', ['demo', 'art', '--bogus', 'x'], root).err, /unknown option/);
  assert.ok(!existsSync(join(root, 'projects', 'demo', '.claude')));
});

test('agent-session --print gives an isolated launch for an existing agent only', t => {
  const root = fixture(t);
  assert.match(run('agent-session.mjs', ['demo', 'art', '--print'], root).err, /no agent "art"/);
  assert.equal(run('new-agent.mjs', ['demo', 'art'], root).code, 0);
  const r = run('agent-session.mjs', ['demo', 'art', '--print'], root);
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.equal(plan.cwd, join(root, 'projects', 'demo'));
  assert.equal(plan.command, join(root, 'bin', WIN ? 'claude.exe' : 'claude'));
  assert.deepEqual(plan.args.slice(0, 3), ['--agent', 'art', '--settings']);
  assert.ok(plan.settingsFile.startsWith(root), plan.settingsFile);
  assert.deepEqual(JSON.parse(readFileSync(plan.settingsFile, 'utf8')), sessionSettings(root, 'demo', 'art'));
});

test('agent-session refuses unsafe names, duplicates and non-isolated memory without writing', t => {
  const root = fixture(t);
  addAgentFile(root, 'evil.md', 'name: ../../../escaped\ndescription: x\nmemory: project');
  addAgentFile(root, 'a1.md', 'name: art\ndescription: a\nmemory: project');
  addAgentFile(root, 'sub/a2.md', 'name: art\ndescription: b\nmemory: project');
  addAgentFile(root, 'u.md', 'name: shared-brain\ndescription: u\nmemory: user');
  addAgentFile(root, 'n.md', 'name: no-mem\ndescription: n');
  const before = tree(root);
  assert.match(run('agent-session.mjs', ['demo', '../../../escaped', '--print'], root).err, /kebab-case/);
  assert.match(run('agent-session.mjs', ['demo', 'art', '--print'], root).err, /more than one file/);
  assert.match(run('agent-session.mjs', ['demo', 'shared-brain', '--print'], root).err, /memory: user/);
  assert.match(run('agent-session.mjs', ['demo', 'no-mem', '--print'], root).err, /no memory scope/);
  assert.deepEqual(tree(root), before);
  assert.ok(!existsSync(join(homedir(), '.claude', 'agent-memory', 'shared-brain')));
});

test('agent-session reports a missing claude, even with --print', t => {
  const root = fixture(t);
  assert.equal(run('new-agent.mjs', ['demo', 'art'], root).code, 0);
  rmSync(join(root, 'bin'), { recursive: true });
  const r = run('agent-session.mjs', ['demo', 'art', '--print'], root);
  // A real native install in %USERPROFILE%\.local\bin is still found; otherwise it must fail clearly.
  if (r.code === 0) assert.equal(JSON.parse(r.out).command, join(homedir(), '.local', 'bin', WIN ? 'claude.exe' : 'claude'));
  else assert.match(r.err, /claude was not found/);
});

test('resolveClaude notices an npm claude.cmd shim on Windows', { skip: !WIN }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'claude.cmd'), '');
  assert.equal(resolveClaude({ PATH: dir }).shim, join(dir, 'claude.cmd'));
});

test('checkAgentText keeps the name, needs a description and warns without own memory', () => {
  const ok = '---\nname: art\ndescription: Draws.\nmemory: project\n---\nBody\n';
  assert.deepEqual(checkAgentText(ok, 'art'), { error: '', warnings: [] });
  assert.match(checkAgentText(ok.replace('name: art', 'name: painter'), 'art').error, /must stay "art"/);
  assert.match(checkAgentText(ok.replace('description: Draws.', 'description:'), 'art').error, /description is required/);
  assert.match(checkAgentText('no frontmatter', 'art').error, /frontmatter/);
  assert.match(checkAgentText('x'.repeat(61 * 1024), 'art').error, /60 KB/);
  assert.equal(checkAgentText(ok.replace('memory: project', 'memory: user'), 'art').warnings.length, 1);
});

test('saveAgentText refuses stale edits and keeps CRLF line endings', t => {
  const root = fixture(t);
  addAgentFile(root, 'art.md', 'name: art\r\ndescription: Draws.\r\nmemory: project');
  const agent = listAgents(root, 'demo')[0];
  const before = readFileSync(agent.file, 'utf8');
  const text = '---\nname: art\ndescription: Paints.\nmemory: project\n---\nNew body\n';
  assert.equal(saveAgentText(agent, text, 'stale').conflict, true);
  assert.equal(readFileSync(agent.file, 'utf8'), before);
  const r = saveAgentText(agent, text, textHash(before));
  assert.equal(r.error, '');
  const after = readFileSync(agent.file, 'utf8');
  assert.match(after, /description: Paints\.\r\n/);
  assert.equal(r.hash, textHash(after));
  assert.match(saveAgentText(agent, text.replace('name: art', 'name: x'), r.hash).error, /must stay/);
});

test('archiveAgent moves the file out of .claude/agents and restoreAgent brings it back', t => {
  const root = fixture(t);
  addAgentFile(root, 'team/art.md', 'name: art\ndescription: Draws.\nmemory: project');
  const memory = join(root, 'projects', 'demo', '.claude', 'agent-memory', 'art', 'MEMORY.md');
  mkdirSync(dirname(memory), { recursive: true });
  writeFileSync(memory, '- remembered');
  assert.equal(listAgents(root, 'demo')[0].rel, 'team/art.md');
  archiveAgent(root, 'demo', listAgents(root, 'demo')[0]);
  assert.deepEqual(listAgents(root, 'demo'), []);
  assert.ok(existsSync(memory), 'memory stays');
  // A second agent with the same name, archived too, gets its own file.
  addAgentFile(root, 'art.md', 'name: art\ndescription: Again.\nmemory: project');
  archiveAgent(root, 'demo', listAgents(root, 'demo')[0]);
  assert.deepEqual(listArchivedAgents(root, 'demo').map(a => [a.archivedAs, a.name, a.valid]), [['art--2.md', 'art', true], ['art.md', 'art', true]]);
  assert.equal(restoreAgent(root, 'demo', 'art.md').name, 'art');
  assert.deepEqual(listAgents(root, 'demo').map(a => [a.name, a.rel, a.description]), [['art', 'art.md', 'Draws.']]);
  assert.match(restoreAgent(root, 'demo', 'art--2.md').error, /already exists/);
  assert.match(restoreAgent(root, 'demo', '../x.md').error, /no archived agent/);
});

test('agent-session --prompt-file starts with the prompt and may read the extra folders', t => {
  const root = fixture(t);
  assert.equal(run('new-agent.mjs', ['demo', 'art'], root).code, 0);
  const extra = join(root, 'inbox', 'attachments', '_flows', 'hero');
  // The child's temp folder is root, so this is its prompt folder (tools/lib/prompt-file.mjs).
  const promptFile = join(root, 'claude-workspace', 'prompts', 'p.json');
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, JSON.stringify({ prompt: '-Draw "hero"\nnow', readDirs: [extra] }));
  const r = run('agent-session.mjs', ['demo', 'art', '--print', '--prompt-file', promptFile], root);
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.deepEqual(plan.args.slice(4), ['--', '-Draw "hero"\nnow']);
  const settings = JSON.parse(readFileSync(plan.settingsFile, 'utf8'));
  assert.deepEqual(settings.permissions.additionalDirectories, [...sessionSettings(root, 'demo', 'art').permissions.additionalDirectories, extra]);
  assert.ok(!existsSync(promptFile), 'the prompt file is used once');
  // The plain session keeps its own settings file.
  const plain = JSON.parse(run('agent-session.mjs', ['demo', 'art', '--print'], root).out);
  assert.notEqual(plain.settingsFile, plan.settingsFile);
  assert.match(run('agent-session.mjs', ['demo', 'art', '--print', '--prompt-file', promptFile], root).err, /could not read the prompt file/);
  // A file outside the prompt folder (named by mistake) is read but never deleted.
  const elsewhere = join(root, 'settings.json');
  writeFileSync(elsewhere, JSON.stringify({ permissions: {} }));
  assert.match(run('agent-session.mjs', ['demo', 'art', '--print', '--prompt-file', elsewhere], root).err, /prompt is empty/);
  assert.ok(existsSync(elsewhere));
});
