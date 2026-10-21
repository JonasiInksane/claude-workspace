// Adds a project agent: a specialist with its own memory and its own image folder.
//
// Usage:
//   node tools/new-agent.mjs <project> <agent> [--role "<what it does>"] [--description "<when to use it>"]
//                            [--tools "Read, Grep, Glob"]
//
// - <project> is an existing folder in projects/. <agent> must be kebab-case (asset-builder).
// - Writes projects/<project>/.claude/agents/<agent>.md from templates/agent/agent.md and seeds
//   projects/<project>/.claude/agent-memory/<agent>/MEMORY.md. Existing files are never overwritten.
// - Creates inbox/attachments/<project>/<agent>/ and inbox/attachments/<project>/_shared/.
// - Start the agent with: node tools/agent-session.mjs <project> <agent>
// - --root <dir> uses another workspace root (for tests).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentFile, checkAgentName, imagesDir, libraryAgentNames, listAgents, memoryDir, resolveProject,
  sharedImagesDir,
} from './lib/agents.mjs';

const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS = ['role', 'description', 'tools', 'root'];

function fail(msg) {
  console.error(`new-agent: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log('Usage: node tools/new-agent.mjs <project> <agent> [--role "<what it does>"] [--description "<when to use it>"] [--tools "Read, Grep"]');
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else { val = argv[++i]; }
      if (!OPTIONS.includes(key)) fail(`unknown option --${key}`);
      if (val === undefined || val.trim() === '') fail(`--${key} needs a value`);
      out[key] = val.trim();
    } else {
      out.positional.push(a);
    }
  }
  if (out.positional.length > 2) fail(`unexpected argument "${out.positional[2]}"`);
  [out.project, out.agent] = out.positional;
  return out;
}

const oneLine = s => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

// One pass, so a value that contains "{{AGENT_ROLE}}" is not substituted again.
function render(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}

// Writes a new file; never overwrites. Returns true when written.
function writeNew(file, content, root) {
  const rel = relative(root, file).split('\\').join('/');
  if (existsSync(file)) { console.log(`  kept (exists)  ${rel}`); return false; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  console.log(`  added          ${rel}`);
  return true;
}

// ---- main ----
const opts = parseArgs(process.argv.slice(2));
const root = opts.root ? resolve(opts.root) : toolsRoot;
if (!opts.project || !opts.agent) { usage(); fail('a project and an agent name are required'); }

const { name: projectName, error: projectErr } = resolveProject(root, opts.project);
if (projectErr) fail(`${projectErr}. Create or clone it first with /new-project.`);
opts.project = projectName; // the folder's real spelling, also for the inbox folder

const existing = listAgents(root, opts.project).map(a => a.name);
// A file without valid frontmatter is not listed, but its name is still taken.
if (existsSync(agentFile(root, opts.project, opts.agent))) existing.push(opts.agent);
const nameErr = checkAgentName(opts.agent, { taken: existing });
if (nameErr) fail(nameErr);
if (libraryAgentNames(root).includes(opts.agent)) {
  fail(`"${opts.agent}" is a library agent (library/agents/). A project agent with that name would replace it. Pick another name.`);
}
if (opts.tools && !/^[\w .,()*:/-]+$/.test(opts.tools)) fail('--tools must be a comma-separated list such as "Read, Grep, Glob"');

const templateDir = join(toolsRoot, 'templates', 'agent');
const read = name => {
  try { return readFileSync(join(templateDir, name), 'utf8'); }
  catch { return fail(`templates/agent/${name} was not found. Nothing was created.`); }
};
const agentTemplate = read('agent.md');
const memoryTemplate = read('MEMORY.md');

const role = opts.role ? oneLine(opts.role) : '<What this agent does, in one or two sentences.>';
const description = opts.description
  ? oneLine(opts.description)
  : `Specialist for the ${opts.project} project: ${opts.role ? oneLine(opts.role).replace(/[.!\s]+$/, '') : opts.agent}. Use when a task matches this role.`;
const vars = {
  PROJECT_NAME: opts.project,
  AGENT_NAME: opts.agent,
  // Double-quoted YAML (a JSON string is valid YAML), so ": " or "#" in the text can't break it.
  AGENT_DESCRIPTION: JSON.stringify(description),
  AGENT_ROLE: role,
};
let agentText = render(agentTemplate, vars);
if (opts.tools) agentText = agentText.replace(/^memory: project$/m, `memory: project\ntools: ${opts.tools}`);

console.log(`Agent ${opts.agent} in projects/${opts.project}:`);
writeNew(agentFile(root, opts.project, opts.agent), agentText, root);
writeNew(join(memoryDir(root, opts.project, opts.agent), 'MEMORY.md'), render(memoryTemplate, vars), root);
for (const dir of [imagesDir(root, opts.project, opts.agent), sharedImagesDir(root, opts.project)]) {
  const rel = relative(root, dir).split('\\').join('/');
  if (existsSync(dir)) { console.log(`  kept (exists)  ${rel}/`); continue; }
  mkdirSync(dir, { recursive: true });
  console.log(`  added          ${rel}/`);
}

console.log('');
console.log('Next steps:');
console.log(`  1. Fill in the <...> lines in projects/${opts.project}/.claude/agents/${opts.agent}.md`);
console.log(`  2. Start it (own memory, own images):  node tools/agent-session.mjs ${opts.project} ${opts.agent}`);
console.log('     Or, inside a normal project session, ask Claude to "use the ' + opts.agent + ' agent".');
console.log(`  3. The memory folder is inside the project repo; commit it there when you want it versioned.`);
