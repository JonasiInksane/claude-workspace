// What the Tools view can start. The page sends only an id plus form values; the server builds
// the prompt or the command line from this list, so the page can't start anything else.
//
// SKILLS start Claude with a slash command as its first prompt, in the hub or in a project.
// /write-handoff is left out on purpose: it sums up the session it runs in, so a fresh session
// has nothing to hand off. COMMANDS run a workspace tool inside the app and show its output.
import { resolveProject } from '../lib/agents.mjs';

const REPORT_TYPES = ['status', 'onboarding', 'audit', 'research', 'playtest', 'plan', 'other'];
const PROJECT = { key: 'project', label: 'Project', kind: 'project', required: true };

export const SKILLS = [
  {
    id: 'inbox-triage', where: 'hub', label: 'Inbox triage',
    text: 'Proposes where each inbox item goes, files them after your OK.', fields: [],
    args: () => [],
  },
  {
    id: 'day-recap', where: 'hub', label: 'Day recap',
    text: 'Sums up a day from reports, git, the processed inbox and notes. Changes nothing.',
    fields: [{ key: 'day', label: 'Day', kind: 'date', hint: 'Empty for today.' }],
    args: v => [v.day],
  },
  {
    id: 'context-sweep', where: 'hub', label: 'Context sweep',
    text: 'Finds oversized, stale or duplicate context and knowledge. Changes nothing without a yes.',
    fields: [{
      key: 'scope', label: 'Scope', kind: 'select',
      options: [['', 'Context and knowledge'], ['context', 'Only context/'], ['knowledge', 'Only knowledge/']],
    }],
    args: v => [v.scope],
  },
  {
    id: 'capture-lesson', where: 'hub', label: 'Capture lesson',
    text: 'Saves a lesson or gotcha as a knowledge note and updates knowledge/INDEX.md.',
    fields: [{ key: 'lesson', label: 'Lesson', kind: 'textarea', required: true, max: 2000, hint: 'A sentence or two.' }],
    args: v => [v.lesson],
  },
  {
    id: 'project-report', where: 'hub', label: 'Project report',
    text: 'Looks at a project without changing it and writes a registered report.',
    fields: [PROJECT, { key: 'type', label: 'Type', kind: 'select', options: REPORT_TYPES.map(t => [t, t]) }],
    args: v => [v.project, v.type || 'status'],
  },
  {
    id: 'onboard-project', where: 'project', label: 'Onboard project',
    text: 'Maps the repo, checks its commands, writes its CLAUDE.md and permissions.',
    fields: [PROJECT, { key: 'focus', label: 'Focus', kind: 'text', max: 300, hint: 'Optional, for example the checkout flow.' }],
    args: v => [v.focus],
  },
  {
    id: 'nextjs-feature', where: 'project', label: 'Next.js feature',
    text: 'Builds a Next.js feature: explore, plan (waits for your OK), implement, verify.',
    fields: [PROJECT, { key: 'feature', label: 'Feature', kind: 'textarea', required: true, max: 4000 }],
    args: v => [v.feature],
  },
  {
    id: 'game-feature', where: 'project', label: 'Game feature',
    text: 'Builds a game mechanic with testable logic: explore, spec and plan, implement, verify.',
    fields: [PROJECT, { key: 'mechanic', label: 'Mechanic or system', kind: 'textarea', required: true, max: 4000 }],
    args: v => [v.mechanic],
  },
];

export const COMMANDS = [
  { id: 'check', label: 'Check workspace', text: 'Self-check: JSON, skills, agents, knowledge index, reports, links.', args: ['check-workspace.mjs'] },
  { id: 'tests', label: 'Run tests', text: 'Every tool test under tools/.', args: ['run-tests.mjs'] },
  { id: 'navigator', label: 'Rebuild navigator', text: 'Writes index.html again from the current files.', args: ['build-index.mjs'] },
  {
    id: 'library', label: 'Install library', text: 'Copies library/ skills and agents to ~/.claude. Shows a preview first.',
    args: ['install-library.mjs'], preview: ['install-library.mjs', '--dry-run'],
  },
];

export const PROJECT_TYPES = ['nextjs', 'game'];

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// The catalog without functions, for the page.
export function catalogForUi() {
  return {
    skills: SKILLS.map(({ args, ...s }) => s),
    commands: COMMANDS.map(c => ({ id: c.id, label: c.label, text: c.text, preview: !!c.preview, command: `node tools/${c.args.join(' ')}` })),
    projectTypes: PROJECT_TYPES,
  };
}

// Checks the form values of one skill and builds its prompt.
// Returns { skill, project, prompt }; `project` is the folder's real spelling, or ''.
export function skillLaunch(root, id, values = {}) {
  const skill = SKILLS.find(s => s.id === id);
  if (!skill) fail(400, `unknown skill "${id}"`);
  const v = {};
  for (const f of skill.fields) {
    let x = values[f.key] == null ? '' : String(values[f.key]).trim();
    if (f.required && !x) fail(400, `${f.label} is required`);
    if (x.length > (f.max || 200)) fail(400, `${f.label} is longer than ${f.max || 200} characters`);
    if (f.kind === 'project') {
      const r = resolveProject(root, x);
      if (r.error) fail(404, r.error);
      x = r.name;
    } else if (f.kind === 'select' && x && !f.options.some(([value]) => value === x)) {
      // Empty means the skill's default (args() fills it in where one is needed).
      fail(400, `${f.label} must be one of ${f.options.map(o => o[0]).filter(Boolean).join(', ')}`);
    } else if (f.kind === 'date' && x && !/^\d{4}-\d{2}-\d{2}$/.test(x)) {
      fail(400, `${f.label} must be a date (YYYY-MM-DD)`);
    }
    v[f.key] = x;
  }
  const prompt = [`/${skill.id}`, ...skill.args(v)].filter(Boolean).join(' ');
  return { skill, project: v.project || '', prompt };
}

// The command line for one COMMANDS entry: [script, ...args] relative to tools/.
// A command with a preview runs for real only with confirm: true (after the preview was shown).
export function commandArgs(id, { preview = false, confirm = false } = {}) {
  const cmd = COMMANDS.find(c => c.id === id);
  if (!cmd) fail(400, `unknown command "${id}"`);
  if (preview) {
    if (!cmd.preview) fail(400, `${cmd.label} has no preview`);
    return { cmd, args: cmd.preview };
  }
  if (cmd.preview && confirm !== true) fail(400, `${cmd.label} runs only after its preview was confirmed`);
  return { cmd, args: cmd.args };
}
