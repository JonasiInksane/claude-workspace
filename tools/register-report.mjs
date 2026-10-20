// Registers (upserts) a report folder in reports/reports.json.
//
// Usage:
//   node tools/register-report.mjs --folder reports/<id> [--title "..."] [--project <name>]
//                                  [--type status] [--status active] [--summary "..."]
//
// - id = folder basename = YYYY-MM-DD_kebab-slug. The folder must sit directly in reports/.
// - Creating a new entry needs --title. type defaults to "other", status to "active".
// - Updating only overwrites the fields you pass, bumps "updated" and keeps "created".
// - steps are recomputed every run: every .md/.html file directly in the folder,
//   report.md first, then the rest by name.
// - --project none (or "") clears the project.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(root, 'reports', 'reports.json');

const TYPES = ['status', 'onboarding', 'audit', 'research', 'playtest', 'plan', 'other'];
const STATUSES = ['active', 'done', 'archived'];
const ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN = ['folder', 'title', 'project', 'type', 'status', 'summary'];

function fail(msg) {
  console.error(`register-report: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(
    'Usage: node tools/register-report.mjs --folder reports/<YYYY-MM-DD_slug> [--title "..."]\n' +
    '         [--project <name>|none] [--type ' + TYPES.join('|') + ']\n' +
    '         [--status ' + STATUSES.join('|') + '] [--summary "..."]'
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    if (!a.startsWith('--')) fail(`unexpected argument "${a}". Run with --help for usage.`);
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else {
      val = argv[i + 1];
      // A following known option means the value is missing; other text may start with "--".
      const isOption = val !== undefined && val.startsWith('--') && KNOWN.includes(val.slice(2).split('=')[0]);
      if (val === undefined || isOption) fail(`--${key} needs a value`);
      i++;
    }
    if (!KNOWN.includes(key)) fail(`unknown option --${key}. Run with --help for usage.`);
    out[key] = val;
  }
  return out;
}

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prettify(file) {
  const base = file.slice(0, file.length - extname(file).length);
  const words = base.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function computeSteps(folderAbs, folderRel) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = readdirSync(folderAbs, { withFileTypes: true })
    .filter(e => e.isFile() && ['.md', '.html'].includes(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort((a, b) => {
      const ra = a.toLowerCase() === 'report.md' ? 0 : 1;
      const rb = b.toLowerCase() === 'report.md' ? 0 : 1;
      return ra - rb || collator.compare(a, b);
    });
  return files.map(f => ({ name: prettify(f), path: `${folderRel}/${f}` }));
}

function loadRegistry() {
  if (!existsSync(registryPath)) return { data: { version: 1, reports: [] }, created: true };
  let text = readFileSync(registryPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try { data = JSON.parse(text); }
  catch (e) { fail(`reports/reports.json is not valid JSON (${e.message}). Fix it first.`); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.reports)) {
    fail('reports/reports.json must look like {"version": 1, "reports": [...]}.');
  }
  return { data, created: false };
}

// ---- main ----
const args = parseArgs(process.argv.slice(2));
if (!args.folder) { usage(); fail('--folder is required'); }

// Resolve the folder: workspace-relative first, then relative to the current directory.
let folderAbs = isAbsolute(args.folder) ? resolve(args.folder) : resolve(root, args.folder);
if (!existsSync(folderAbs) && !isAbsolute(args.folder)) {
  const alt = resolve(process.cwd(), args.folder);
  if (existsSync(alt)) folderAbs = alt;
}
if (!existsSync(folderAbs) || !statSync(folderAbs).isDirectory()) {
  fail(`folder not found: ${args.folder}. Create reports/<YYYY-MM-DD_slug>/ with a report.md first.`);
}
const folderRel = relative(root, folderAbs).split('\\').join('/');
const id = basename(folderAbs);
if (folderRel !== `reports/${id}`) {
  fail(`the folder must sit directly in reports/ (got "${folderRel}").`);
}
if (!ID_RE.test(id)) {
  fail(`folder name "${id}" must be YYYY-MM-DD_kebab-slug, for example 2026-10-20_my-app-audit.`);
}

if (args.type !== undefined && !TYPES.includes(args.type)) {
  fail(`--type must be one of: ${TYPES.join(', ')}`);
}
if (args.status !== undefined && !STATUSES.includes(args.status)) {
  fail(`--status must be one of: ${STATUSES.join(', ')}`);
}
let project;
if (args.project !== undefined) {
  const p = args.project.trim();
  if (p === '' || p.toLowerCase() === 'none' || p.toLowerCase() === 'null') project = null;
  else if (!/^[A-Za-z0-9._-]+$/.test(p) || /^\.+$/.test(p)) fail('--project must be a folder name under projects/ (no slashes).');
  else project = p;
  if (project && !existsSync(join(root, 'projects', project))) {
    console.warn(`register-report: warning: projects/${project} does not exist (kept anyway).`);
  }
}
if (args.title !== undefined && !args.title.trim()) fail('--title cannot be empty');

const { data, created: registryCreated } = loadRegistry();
const steps = computeSteps(folderAbs, folderRel);
if (steps.length === 0) console.warn('register-report: warning: the folder has no .md or .html files yet.');
const date = today();
const idx = data.reports.findIndex(r => r && r.id === id);

let line;
if (idx === -1) {
  if (!args.title) fail(`"${id}" is not registered yet, so --title is required.`);
  const entry = {
    id,
    title: args.title.trim(),
    project: project === undefined ? null : project,
    type: args.type ?? 'other',
    status: args.status ?? 'active',
    created: date,
    updated: date,
    folder: folderRel,
    summary: args.summary ?? '',
    steps,
  };
  data.reports.push(entry);
  line = `created ${id}: "${entry.title}" (type ${entry.type}, status ${entry.status}, ${steps.length} step${steps.length === 1 ? '' : 's'})`;
} else {
  const old = data.reports[idx];
  const changes = [];
  const next = { ...old };
  const set = (key, value) => {
    if (value === undefined) return;
    if (JSON.stringify(old[key]) !== JSON.stringify(value)) {
      const show = v => (v === null || v === undefined ? 'none' : typeof v === 'string' && v.length > 40 ? `"${v.slice(0, 37)}..."` : JSON.stringify(v));
      changes.push(`${key} ${show(old[key])} -> ${show(value)}`);
    }
    next[key] = value;
  };
  set('title', args.title === undefined ? undefined : args.title.trim());
  set('project', project);
  set('type', args.type);
  set('status', args.status);
  set('summary', args.summary);
  next.folder = folderRel;
  if (!next.created) next.created = date;
  const oldSteps = Array.isArray(old.steps) ? old.steps : [];
  if (JSON.stringify(oldSteps) !== JSON.stringify(steps)) {
    changes.push(`steps ${oldSteps.length} -> ${steps.length}`);
  }
  next.steps = steps;
  next.updated = date;
  // Keep the C1 key order.
  const order = ['id', 'title', 'project', 'type', 'status', 'created', 'updated', 'folder', 'summary', 'steps'];
  const ordered = {};
  for (const k of order) if (k in next) ordered[k] = next[k];
  for (const k of Object.keys(next)) if (!(k in ordered)) ordered[k] = next[k];
  data.reports[idx] = ordered;
  line = `updated ${id}: ${changes.length ? changes.join(', ') : 'no field changes'} (updated ${date})`;
}

const out = data.version === undefined ? { version: 1, ...data } : data;
mkdirSync(dirname(registryPath), { recursive: true });
writeFileSync(registryPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(line + (registryCreated ? ' [created reports/reports.json]' : ''));
