// Pipelines as data: what the launcher can start, which stages each run has, and the defaults
// for models, caps and fix rounds. The page sends only a pipeline id plus field values; the
// server checks every value here (checkValues), so the page can't start anything else.
//
// A pipeline is { id, label, ask, placeholder, blurb, claude, editing, hidden, requires, fields,
// stages, cannot, expected }. A stage is { id, kind: gate | claude | human | git, who, label, goal,
// run (gate function name in executor.mjs), profile (READ | CHECK | EDIT), modelKey, prompt,
// schema, caps (read | edit), when (a PREDICATES name), waits (a waiting kind) }.
// Everything here is plain data or pure functions, so it can be shown to the page as it is.
// Nothing here names a real project: project facts come from the private profile.
// Stage ids are lowercase words joined by dashes (runs/store.mjs uses them in folder names).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const STAGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LEVELS = ['quick', 'standard', 'paranoid'];
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
export const RISK_TAGS = ['money', 'tenant', 'contract'];
export const FIX_ROUNDS = { maxAuto: 2, maxUser: 2 };
export const RESUME_BONUS_TURNS = 20;
const MIN = 60 * 1000;
export const CAPS = {
  read: { maxTurns: 40, wallMs: 15 * MIN, budgetUsd: 5 },
  edit: { maxTurns: 60, wallMs: 30 * MIN, budgetUsd: 15 },
};

// Default model and effort per stage kind (modelKey). Review and verify are raised by risk.
export const MODEL_DEFAULTS = {
  scope: { model: 'opus', effort: 'high' },
  investigate: { model: 'opus', effort: 'high' },
  implement: { model: 'opus', effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  verify: { model: 'opus', effort: 'high' },
  prove: { model: 'sonnet', effort: 'high' },
  answer: { model: 'sonnet', effort: 'high' },
  triage: { model: 'sonnet', effort: 'high' },
};
const ESCALATED = { model: 'opus', effort: 'xhigh' };

export const PROFILE_TEXT = {
  READ: 'READ: reads files only, no shell',
  CHECK: 'CHECK: reads files, runs tg-check only',
  EDIT: 'EDIT: edits files in the run worktree, runs tg-check only',
};

export const EDIT_CANNOT = [
  'Push, merge, or commit without your click',
  'Run dev servers, migrations, db:push or seeds',
  'Read .env, .npmrc or .sentryclirc',
  'Change package.json, tsconfig or lint config unless you tick them in the plan',
  'Touch your main checkout: it edits only the run worktree',
];
export const READ_CANNOT = [
  'Edit any file',
  'Run anything except read-only git and the profile checks',
  'Read .env, .npmrc or .sentryclirc',
];
const CHECK_CANNOT = ['Use Claude: this costs zero tokens', 'Change your files'];

// ---------- Fields

const opts = list => list.map(([value, label]) => [value, label]);
const CARE = {
  key: 'care', label: 'How careful?', kind: 'select', advanced: true, default: 'standard',
  options: opts([['quick', 'Quick'], ['standard', 'Standard'], ['paranoid', 'Paranoid']]),
};
const WHAT = (label, max = 600) => ({ key: 'what', label, kind: 'textarea', required: true, max });

// ---------- Stages

const gate = (id, label, goal, run, extra = {}) => ({ id, kind: 'gate', who: 'code', label, goal, run, ...extra });
const human = (id, label, goal, waits, extra = {}) => ({ id, kind: 'human', who: 'you', label, goal, waits, ...extra });
function claude(pipeline, id, label, goal, profile, schema, extra = {}) {
  return {
    id, kind: 'claude', who: 'claude', label, goal, profile, schema, modelKey: id,
    prompt: `pipelines/app/${pipeline}/${id}.md`, caps: profile === 'EDIT' ? 'edit' : 'read', ...extra,
  };
}
const commitStage = () => ({ id: 'commit', kind: 'git', who: 'you', label: 'Commit', goal: 'exact files, a message you can edit, never pushed', waits: 'commit' });

// The slice spine shared by fix and refactor (debug and feature swap the first stages).
function tail(p, proveKind, proveGoal) {
  return [
    claude(p, 'prove', 'Prove', proveGoal, 'EDIT', 'tests.v1', { proveKind }),
    gate('gate-b', 'Gate B', proveKind === 'pins' ? 'pins must pass on the old code' : 'the new test must fail on its assertion, and not be a known failure', 'gateB'),
    claude(p, 'implement', 'Implement', 'edits in the run worktree; writes the record and a commit message draft', 'EDIT', 'change.v1'),
    gate('checks', 'Checks', 'G0, fences, ratchets and the level checks; pins and red tests; automatic fix rounds', 'checks'),
    claude(p, 'review', 'Review', 'fresh session; sees the plan, diff and gate summary only', 'READ', 'findings.v1'),
    claude(p, 'verify', 'Verify', 'same tier as review; marks findings unconfirmed, never drops them', 'READ', 'findings.v1', { when: 'verifyNeeded' }),
    human('review-gate', 'Review gate', 'approve, send back, or open in terminal', 'review'),
    commitStage(),
  ];
}
const preflight = () => gate('preflight', 'Preflight', 'run worktree clean, lock, base commit, cached baseline', 'preflight');
function spine(p, proveKind, proveGoal) {
  return [
    preflight(),
    claude(p, 'scope', 'Scope', 'files, callers, tests and risks; one to three slices', 'READ', 'plan.v1'),
    human('plan', 'Approve the plan', 'pick a slice, answer questions, tick any config files', 'plan'),
    ...tail(p, proveKind, proveGoal),
  ];
}

// ---------- The catalog

export const PIPELINES = [
  {
    id: 'explain', label: 'Explain', ask: 'What do you want to understand?', placeholder: 'e.g. how does a saved form reach the database?',
    blurb: 'read-only, an answer with sources', claude: true, editing: false, requires: { profile: true, isolation: 'none' },
    fields: [WHAT('Question'), { key: 'where', label: 'Where to look', kind: 'path', max: 300 }],
    stages: [claude('explain', 'answer', 'Read and answer', 'cites path:line; read-only', 'READ', 'answer.v1')],
    cannot: READ_CANNOT, expected: '2-5 min',
  },
  {
    id: 'review', label: 'Review', ask: 'What should I review?', placeholder: 'e.g. my uncommitted changes',
    blurb: 'read-only, findings you can fix or dismiss', claude: true, editing: false, requires: { profile: true, isolation: 'none' },
    fields: [
      { key: 'target', label: 'What to review', kind: 'select', required: true, default: 'uncommitted',
        options: opts([['uncommitted', 'My uncommitted changes'], ['branch', 'This branch vs base'], ['last', 'Last N commits'], ['app', 'An app branch']]) },
      { key: 'n', label: 'How many commits', kind: 'text', max: 2 },
      { key: 'branch', label: 'App branch', kind: 'text', max: 120 },
      { key: 'focus', label: 'Focus', kind: 'multi', default: ['correctness'],
        options: opts([['correctness', 'Correctness'], ['money', 'Money'], ['tenant', 'Tenant boundaries'], ['contract', 'API contract'], ['tests', 'Tests'], ['security', 'Security']]) },
      { key: 'depth', label: 'Depth', kind: 'select', default: 'quick',
        options: opts([['quick', 'Quick (sonnet/high)'], ['deep', 'Deep (opus/xhigh plus verify)']]) },
    ],
    stages: [
      gate('collect', 'Collect', 'diff, stats, risk paths and static checks into the inputs folder', 'collect'),
      claude('review', 'review', 'Review', 'read-only review of the diff', 'READ', 'findings.v1'),
      claude('review', 'verify', 'Verify', 'Deep only; marks findings unconfirmed, never drops them', 'READ', 'findings.v1', { when: 'deep' }),
      human('triage', 'Triage', 'fix, dismiss with a reason, or keep each finding', 'triage'),
    ],
    cannot: READ_CANNOT, expected: '5-15 min',
  },
  {
    id: 'check', label: 'Check my work', ask: 'What should I check?', placeholder: 'e.g. my uncommitted changes',
    blurb: 'code only, zero tokens', claude: false, editing: false, requires: { profile: true, isolation: 'main-ok' },
    fields: [
      { key: 'what', label: 'What to check', kind: 'select', required: true, default: 'uncommitted',
        options: opts([['uncommitted', 'My uncommitted changes'], ['branch', 'This branch vs base'], ['everything', 'Everything']]) },
      { key: 'level', label: 'How careful?', kind: 'select', default: 'quick',
        options: opts([['quick', 'Quick'], ['standard', 'Standard'], ['paranoid', 'Paranoid']]) },
    ],
    stages: [
      gate('preflight', 'Preflight', 'tree, base commit and baseline; your .env is never loaded', 'checkPreflight'),
      gate('checks', 'Run the checks', 'the level checks, compared with the baseline by test identity', 'checkRun'),
    ],
    cannot: CHECK_CANNOT, expected: '2-15 min',
  },
  {
    id: 'architecture', label: 'Architecture check', ask: 'Which lenses?', placeholder: 'e.g. tenant guard, money invariants, feature boundaries',
    blurb: 'free code probes, then a short triage', claude: true, editing: false, requires: { profile: true, isolation: 'none' },
    fields: [
      { key: 'lenses', label: 'Lenses', kind: 'multi', options: 'profile.lenses' },
      { key: 'compare', label: 'Compare with', kind: 'select', default: 'last', options: opts([['last', 'The last scan'], ['commit', 'A stored scan at a commit']]) },
      { key: 'commit', label: 'Commit', kind: 'text', max: 40, advanced: true },
    ],
    stages: [
      gate('scan', 'Scan', 'code probes; free; one to three minutes', 'scan'),
      claude('architecture', 'triage', 'Triage', 'new candidates only, at most 30', 'READ', 'triage.v1', { when: 'hasCandidates' }),
      human('decide', 'Accept issues as findings', 'accept or dismiss what triage flagged', 'decide', { when: 'needsDecision' }),
    ],
    cannot: READ_CANNOT, expected: '10-30 min; the scan alone is free',
  },
  {
    id: 'fix', label: 'Fix a finding', ask: 'Which finding?', placeholder: 'e.g. pick an open finding from the list',
    blurb: 'writes a failing test first, then the fix', claude: true, editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [
      { key: 'finding', label: 'Finding', kind: 'finding', required: true, max: 40 },
      { key: 'notes', label: 'Anything I should know?', kind: 'textarea', max: 2000 },
      CARE,
    ],
    stages: spine('fix', 'red', 'a red test that fails on its assertion, not a crash'),
    cannot: EDIT_CANNOT, expected: '30-90 min',
  },
  {
    id: 'refactor', label: 'Refactor', ask: 'What do you want to refactor?', placeholder: 'e.g. Move the cart total math into a tested cents module',
    blurb: 'edits in the run worktree after you approve a plan', claude: true, editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [
      WHAT('What to refactor'),
      { key: 'where', label: 'Where', kind: 'path', max: 300, advanced: true },
      { key: 'kind', label: 'Kind', kind: 'select', advanced: true, default: 'auto',
        options: opts([['auto', 'Auto'], ['split', 'Split a big file'], ['public-boundary', 'public.ts boundary'], ['dedupe', 'Dedupe'],
          ['untangle-cycle', 'Untangle a cycle'], ['move-rename', 'Move or rename'], ['cents-math', 'Cents math'], ['other', 'Other']]) },
      CARE,
      { key: 'keep', label: 'Keep the same', kind: 'multi', advanced: true, default: ['trpc', 'legacy', 'queues', 'ui'],
        options: opts([['trpc', 'Procedure names'], ['legacy', 'Legacy router keys'], ['queues', 'Queue names'], ['ui', 'UI behaviour']]) },
      { key: 'out', label: 'Keep out', kind: 'text', max: 300, advanced: true },
    ],
    stages: spine('refactor', 'pins', 'characterization tests (pins) that pass on the old code'),
    cannot: EDIT_CANNOT, expected: '40-90 min, mostly checks',
  },
  {
    id: 'debug', label: 'Debug', ask: 'What is wrong?', placeholder: 'e.g. saving the form twice creates two records',
    blurb: 'investigates, then pins the bug with a failing test', claude: true, editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [
      WHAT('What is wrong'),
      { key: 'seen', label: 'Where you see it', kind: 'select', default: 'unsure',
        options: opts([['web', 'Web'], ['expo', 'Expo'], ['server', 'Server'], ['worker', 'Worker'], ['test', 'A test'], ['unsure', 'Not sure']]) },
      { key: 'repro', label: 'How to reproduce', kind: 'textarea', max: 2000 },
      { key: 'error', label: 'Error text', kind: 'textarea', max: 20000 },
      { key: 'expected', label: 'What you expected', kind: 'textarea', max: 1000 },
      { key: 'screenshot', label: 'Screenshot', kind: 'image', max: 300 },
      CARE,
    ],
    stages: [
      preflight(),
      claude('debug', 'investigate', 'Investigate', 'may run focused tests with tg-check; returns hypotheses', 'CHECK', 'diagnosis.v1'),
      human('hypothesis', 'Pick a hypothesis', 'the one to prove with a failing test', 'hypothesis'),
      ...tail('debug', 'red', 'a failing repro test; if none is possible the run stops with the diagnosis')
        .map(s => (s.id === 'prove' ? { ...s, when: 'pinnable', endIfSkipped: 'passed' } : s)),
    ],
    cannot: EDIT_CANNOT, expected: '20-60 min',
  },
  {
    id: 'feature', label: 'New feature', ask: 'What should users be able to do?', placeholder: 'e.g. users can export their list as CSV',
    blurb: 'a spec, then one slice at a time (server, web, Expo)', claude: true, editing: true, requires: { profile: true, isolation: 'tree' },
    fields: [
      WHAT('What users should be able to do'),
      { key: 'who', label: 'Who', kind: 'multi', options: opts([['owner', 'Owner'], ['staff', 'Staff'], ['customers', 'Customers']]) },
      { key: 'surfaces', label: 'Surfaces', kind: 'multi', default: ['server', 'web'], options: opts([['server', 'Server'], ['web', 'Web'], ['expo', 'Expo']]) },
      { key: 'doneWhen', label: 'Done when', kind: 'textarea', max: 1500, lines: 10 },
      { key: 'money', label: 'Touches money or more than one tenant?', kind: 'select', default: 'unsure',
        options: opts([['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure (counts as yes)']]) },
      { key: 'out', label: 'Keep out', kind: 'text', max: 300, advanced: true },
      CARE,
    ],
    stages: [
      preflight(),
      claude('feature', 'scope', 'Scope', 'a spec plus ordered slices', 'READ', 'spec.v1', { when: 'notChild' }),
      human('spec', 'Approve the spec', 'pick the slice to build', 'spec', { when: 'notChild' }),
      ...tail('feature', 'red', 'acceptance tests that fail first'),
    ],
    cannot: EDIT_CANNOT, expected: 'per slice, like a refactor',
  },
  {
    id: 'setup-worktree', label: 'Set up the run worktree', ask: '', placeholder: '', hidden: true,
    blurb: 'creates the run worktree and installs its dependencies once', claude: false, editing: false, requires: { profile: true, isolation: 'none' },
    fields: [],
    stages: [gate('setup', 'Set up', 'git worktree add, then the install and generate commands', 'setup')],
    cannot: ['Use Claude', 'Change your main checkout'], expected: '5-30 min',
  },
];

export function pipelineById(id) {
  return PIPELINES.find(p => p.id === id) || null;
}

// ---------- Predicates for `when` (pure functions of the run)

const outputOf = (run, stage) => (run && run.outputs && run.outputs[stage]) || null;
export const PREDICATES = {
  verifyNeeded: run => run.level === 'paranoid' || hasRisk(run),
  deep: run => (run.values || {}).depth === 'deep',
  hasCandidates: run => ((outputOf(run, 'scan') || {}).candidates || 0) > 0,
  needsDecision: run => ((outputOf(run, 'triage') || {}).items || []).some(i => i.verdict === 'issue' || i.verdict === 'owner-decision'),
  pinnable: run => (outputOf(run, 'investigate') || {}).pinnable !== false,
  notChild: run => !(run.parent && run.inherit && run.inherit.spec),
};
const hasRisk = run => (run.riskTags || []).some(t => RISK_TAGS.includes(t));

// ---------- Levels

// The level from "How careful?", raised (never lowered) by risk tags. Returns { level, reasons }.
export function computeLevel(care, riskResult = { tags: [], hits: [] }, { from } = {}) {
  let level = LEVELS.includes(care) ? care : 'standard';
  if (from && LEVELS.indexOf(from) > LEVELS.indexOf(level)) level = from;
  const reasons = [];
  const seen = new Set();
  for (const h of riskResult.hits || []) {
    if (!RISK_TAGS.includes(h.tag) || seen.has(h.tag)) continue;
    seen.add(h.tag);
    reasons.push(`${h.tag} path: ${h.glob || h.path}`);
  }
  if (reasons.length && LEVELS.indexOf(level) < 1) level = 'standard';
  return { level, reasons };
}

// Paths named in the request (Where, a debug repro path), used for risk tags before scope.
export function requestPaths(values = {}) {
  return [values.where].filter(p => typeof p === 'string' && p);
}

// ---------- Models and caps

const MODEL_NAME_RE = /^(?:opus|sonnet|haiku|claude-[a-z0-9.-]{3,60})$/;
function cleanChoice(x) {
  if (!x || typeof x !== 'object') return null;
  const model = MODEL_NAME_RE.test(String(x.model || '')) ? x.model : null;
  const effort = EFFORT_ORDER.includes(x.effort) ? x.effort : null;
  return model || effort ? { model, effort } : null;
}

// Whether a review or verify stage of the spine must run at least opus/xhigh.
function mustEscalate(pipelineId, stage, run) {
  if (!['review', 'verify'].includes(stage.modelKey)) return false;
  if (pipelineId === 'review') return false;
  return pipelineId === 'fix' || (run && (run.level === 'paranoid' || hasRisk(run)));
}

// The model and effort of one stage. Order: settings.models["<pipeline>.<stage>"], then
// profile.models (same key, or the bare stage id), then the catalog. Spine review and verify
// stages on fix, paranoid or risk-tagged runs are raised to at least opus/xhigh whatever the
// overrides say (the risk tier forces the bar; the model's own report never lowers it).
// Returns { model, effort, source, raised }.
export function stageModel({ pipeline, stage, profile = {}, settings = {}, run = null }) {
  const p = typeof pipeline === 'string' ? pipelineById(pipeline) : pipeline;
  const s = typeof stage === 'string' ? (p.stages.find(x => x.id === stage) || {}) : stage;
  const key = `${p.id}.${s.id}`;
  let base = { ...(MODEL_DEFAULTS[s.modelKey] || MODEL_DEFAULTS.answer) };
  if (p.id === 'review') base = (run && (run.values || {}).depth === 'deep') ? { ...ESCALATED } : { model: 'sonnet', effort: 'high' };
  const escalate = mustEscalate(p.id, s, run);
  if (escalate) base = { ...ESCALATED };
  let source = 'catalog';
  const layers = [
    ['profile', cleanChoice((profile.models || {})[s.id])],
    ['profile', cleanChoice((profile.models || {})[key])],
    ['settings', cleanChoice((settings.models || {})[key])],
  ];
  const out = { ...base };
  for (const [name, c] of layers) {
    if (!c) continue;
    if (c.model) out.model = c.model;
    if (c.effort) out.effort = c.effort;
    source = name;
  }
  let raised = false;
  if (escalate) {
    if (!/opus/i.test(out.model)) { out.model = 'opus'; raised = true; }
    if (EFFORT_ORDER.indexOf(out.effort) < EFFORT_ORDER.indexOf('xhigh')) { out.effort = 'xhigh'; raised = true; }
  }
  return { model: out.model, effort: out.effort, source, raised };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Turn, time and budget caps of one stage; profile.caps.{read,edit} may override
// { maxTurns, minutes, budgetUsd }. bonusTurns is the one-time +20 of a capped resume.
export function stageCaps(stage, { profile = {}, bonusTurns = 0 } = {}) {
  const kind = stage.caps === 'edit' ? 'edit' : 'read';
  const base = { ...CAPS[kind] };
  const o = ((profile.caps || {})[kind]) || {};
  if (Number.isInteger(o.maxTurns)) base.maxTurns = o.maxTurns;
  if (Number.isFinite(o.minutes)) base.wallMs = o.minutes * MIN;
  if (Number.isFinite(o.budgetUsd)) base.budgetUsd = o.budgetUsd;
  base.maxTurns = clamp(base.maxTurns + (bonusTurns || 0), 1, 200);
  base.budgetUsd = clamp(base.budgetUsd, 0.5, 50);
  base.wallMs = clamp(base.wallMs, MIN, 120 * MIN);
  return base;
}

// Whether a run of this pipeline takes the project lock (editing runs, and check or setup when
// they use the run worktree).
export function needsLock(pipeline, treeMode) {
  const p = typeof pipeline === 'string' ? pipelineById(pipeline) : pipeline;
  if (!p) return false;
  if (p.editing || p.id === 'setup-worktree') return true;
  return p.id === 'check' && treeMode === 'run';
}

// ---------- Values

const PATH_RE = /^[A-Za-z0-9_@.()[\] +,=-][A-Za-z0-9_@.()[\] +,=/-]*$/;
// A project-relative posix path, or '' when it is absolute, climbs out, or has odd characters.
export function cleanRelPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  s = s.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!s || s.length > 300 || /^[A-Za-z]:/.test(s) || s.startsWith('/')) return '';
  if (s.split('/').some(part => part === '..' || part === '.')) return '';
  return PATH_RE.test(s) ? s : '';
}

const IMAGE_RE = /^[A-Za-z0-9 _.()-]+(?:\/[A-Za-z0-9 _.()-]+)*\.(?:png|jpe?g|gif|webp)$/i;
const BRANCH_RE = /^app\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Field options: a list, or 'profile.lenses' for the lens ids of the project profile.
export function optionsFor(field, { profile } = {}) {
  if (field.options === 'profile.lenses') return ((profile && profile.lenses) || []).map(id => [id, id]);
  return field.options || [];
}

function idRegex(profile) {
  const src = profile && profile.findings && profile.findings.idPattern;
  if (!src) return null;
  try { return new RegExp(`^(?:${src})$`); } catch { return null; }
}

// Checks one field. Returns [error, cleanValue].
function checkField(field, raw, ctx) {
  const label = field.label;
  const options = optionsFor(field, ctx);
  if (field.kind === 'multi') {
    const list = raw == null || raw === '' ? (field.default || []) : (Array.isArray(raw) ? raw : [raw]);
    const allowed = new Set(options.map(o => o[0]));
    const out = [];
    for (const v of list.map(x => String(x))) {
      if (!allowed.has(v)) return [`${label} has an unknown option: ${v.slice(0, 40)}.`];
      if (!out.includes(v)) out.push(v);
    }
    return ['', out];
  }
  if (field.kind === 'bool') return ['', raw === true || raw === 'true'];
  let x = raw == null ? '' : String(raw);
  x = field.kind === 'textarea' ? x.replace(/\r\n/g, '\n').trim() : x.trim();
  if (!x && field.default !== undefined) x = field.default;
  if (field.required && !x) return [`${label} needs an answer.`];
  if (x.length > (field.max || 300)) return [`${label} is longer than ${field.max || 300} characters.`];
  if (field.lines && x.split('\n').length > field.lines) return [`${label} has more than ${field.lines} lines.`];
  if (!x) return ['', ''];
  if (field.kind === 'select' && !options.some(o => o[0] === x)) {
    return [`${label} must be one of ${options.map(o => o[0]).join(', ')}.`];
  }
  if (field.kind === 'path') {
    const p = cleanRelPath(x);
    if (!p) return [`${label} must be a path inside the project, like apps/web/src.`];
    x = p;
  }
  if (field.kind === 'image') {
    const p = x.replace(/\\/g, '/');
    if (!IMAGE_RE.test(p) || p.split('/').includes('..')) return [`${label} must be an image from the inbox.`];
    x = p;
  }
  if (field.kind === 'finding') {
    const re = idRegex(ctx.profile);
    if (re && !re.test(x)) return [`${label} "${x.slice(0, 40)}" is not a finding id.`];
    if (ctx.findings) {
      const f = (ctx.findings.findings || []).find(item => item.id === x);
      if (!f) return [`Finding ${x} is not in the findings list.`];
      if (f.status !== 'open') return [`Finding ${x} is ${f.status}, not open.`];
    }
  }
  return ['', x];
}

// Rules that span fields.
function crossCheck(pipeline, v) {
  if (pipeline.id === 'review') {
    if (v.target === 'last') {
      const n = Number(v.n);
      if (!/^\d{1,2}$/.test(String(v.n)) || n < 1 || n > 50) return 'How many commits needs a number from 1 to 50.';
      v.n = n;
    } else v.n = '';
    if (v.target === 'app') {
      if (!BRANCH_RE.test(v.branch || '')) return 'App branch must be a branch name starting with app/.';
    } else v.branch = '';
  }
  if (pipeline.id === 'architecture') {
    if (v.compare === 'commit' && !SHA_RE.test(v.commit || '')) return 'Commit must be a commit id (7 to 40 hex characters).';
    if (v.compare !== 'commit') v.commit = '';
  }
  return '';
}

// An inbox image (relative to inbox/attachments) exists: ctx.inboxExists(rel) when given, else a
// stat under ctx.root. Without either, the executor finds out when it copies the file.
function screenshotExists(rel, ctx) {
  if (typeof ctx.inboxExists === 'function') return !!ctx.inboxExists(rel);
  if (!ctx.root) return true;
  return existsSync(join(ctx.root, 'inbox', 'attachments', ...rel.split('/')));
}

// Checks the launcher values of one pipeline. ctx = { profile, findings, root, inboxExists(rel) }.
// Returns { error, values }: values are trimmed, defaulted, and limited to the pipeline's fields.
export function checkValues(pipeline, values = {}, ctx = {}) {
  const p = typeof pipeline === 'string' ? pipelineById(pipeline) : pipeline;
  if (!p) return { error: `There is no pipeline called ${String(pipeline).slice(0, 40)}.`, values: null };
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { error: 'The values must be an object.', values: null };
  if (p.requires.profile && !ctx.profile) return { error: 'This project has no profile yet. Create one from the example first.', values: null };
  const out = {};
  for (const f of p.fields) {
    const [error, v] = checkField(f, values[f.key], ctx);
    if (error) return { error, values: null };
    out[f.key] = v;
  }
  if (out.screenshot && !screenshotExists(out.screenshot, ctx)) {
    return { error: 'Screenshot is not in the inbox any more.', values: null };
  }
  const error = crossCheck(p, out);
  return error ? { error, values: null } : { error: '', values: out };
}

const SAFE_TITLE = s => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
// The run title, for example "Refactor: Move the cart money math into a cents module".
export function runTitle(pipeline, values = {}) {
  const p = typeof pipeline === 'string' ? pipelineById(pipeline) : pipeline;
  const subject = {
    review: () => ({ uncommitted: 'uncommitted changes', branch: 'this branch', last: `last ${values.n} commits`, app: values.branch })[values.target],
    check: () => ({ uncommitted: 'uncommitted changes', branch: 'this branch', everything: 'everything' })[values.what],
    architecture: () => (values.lenses && values.lenses.length ? values.lenses.join(', ') : 'all lenses'),
    fix: () => values.finding,
    'setup-worktree': () => 'run worktree',
  }[p.id];
  const text = SAFE_TITLE(subject ? subject() : values.what) || p.label;
  const title = `${p.label}: ${text}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

// ---------- For the page

function capsFacts(p) {
  if (!p.claude) return [['Expected', p.expected]];
  const facts = p.editing
    ? [['Turns', `${CAPS.edit.maxTurns} per edit stage, ${CAPS.read.maxTurns} per read stage`],
      ['Time', `${CAPS.edit.wallMs / MIN} min per edit stage, ${CAPS.read.wallMs / MIN} per read stage`],
      ['Fix rounds', `${FIX_ROUNDS.maxAuto} automatic, ${FIX_ROUNDS.maxUser} more by you`]]
    : [['Turns', `${CAPS.read.maxTurns} per stage`], ['Time', `${CAPS.read.wallMs / MIN} min per stage`]];
  return [...facts, ['Expected', p.expected]];
}

// The page's view of one pipeline: stages with who, model and profile text, caps, the cannot
// list, fields with their options, and why it can't start (disabledReason, '' when it can).
export function pipelineForUi(id, { profile = null, settings = {}, findings = null, run = null } = {}) {
  const p = pipelineById(id);
  if (!p) return null;
  const fields = p.fields.map(f => {
    const ui = { key: f.key, label: f.label, kind: f.kind, required: !!f.required, max: f.max || null, advanced: !!f.advanced, default: f.default ?? null };
    if (f.lines) ui.lines = f.lines;
    if (f.kind === 'select' || f.kind === 'multi') ui.options = optionsFor(f, { profile });
    if (f.kind === 'finding' && findings) {
      ui.options = (findings.findings || []).filter(x => x.status === 'open').map(x => [x.id, `${x.id}: ${x.title || ''}`.slice(0, 120)]);
    }
    return ui;
  });
  const stages = p.stages.map((s, n) => {
    const ui = { n, id: s.id, kind: s.kind, who: s.who, label: s.label, goal: s.goal, when: s.when || null, waits: s.waits || null };
    if (s.kind === 'claude') {
      const m = stageModel({ pipeline: p, stage: s, profile: profile || {}, settings, run });
      const c = stageCaps(s, { profile: profile || {} });
      Object.assign(ui, { profile: s.profile, profileText: PROFILE_TEXT[s.profile], schema: s.schema, model: m.model, effort: m.effort,
        modelSource: m.source, caps: { maxTurns: c.maxTurns, minutes: Math.round(c.wallMs / MIN) } });
    }
    return ui;
  });
  let disabledReason = '';
  if (p.requires.profile && !profile) disabledReason = 'This project has no profile yet. Create one from the example first.';
  return {
    id: p.id, label: p.label, ask: p.ask, placeholder: p.placeholder, blurb: p.blurb, claude: p.claude, editing: p.editing,
    hidden: !!p.hidden, isolation: p.requires.isolation, fields, stages, cannot: p.cannot, caps: capsFacts(p), expected: p.expected,
    disabledReason,
  };
}

// Every pipeline the launcher shows (hidden ones left out).
export function pipelinesForUi(ctx = {}) {
  return PIPELINES.filter(p => !p.hidden).map(p => pipelineForUi(p.id, ctx));
}
