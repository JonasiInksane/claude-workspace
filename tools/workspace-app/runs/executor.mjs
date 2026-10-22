// The stage executor: runs a pipeline run from stage to stage, and carries out the buttons
// (approve, allow, fix, commit, take over and the rest). The run manager (runs/manager.mjs) drives
// it: start() schedules advance(run, { signal }), a click goes to handle(run, action, payload),
// and cancel aborts the driver, stops the processes and then calls cancelPath(run, reason).
//
// advance takes the first stage that is not done or skipped and runs it by kind:
//   gate    a function in GATES (preflight, gateB, checks, collect, scan, ...), all app code;
//   claude  builds the prompt from pipelines/app/<pipeline>/<stage>.md, writes the stage
//           settings, takes a Claude slot and calls runClaudeStage;
//   human   sets `waiting` and stops; a button continues the run;
//   git     waits for the commit button.
// It saves run.json after every transition and returns at a wait, at an end state, or soon after
// `signal` aborts (then it changes nothing more: the manager owns cancel and shutdown).
// handle never advances by itself: it leaves the run 'running' when it should go on, and the
// manager schedules the next advance.
//
// Safety rules kept here: Claude's output never names a file the app acts on unless the path is
// clean and inside the tree, and the commit uses the app's own git listing, never Claude's list;
// READ and CHECK inputs go through inputs/ and are re-hashed before every gate (R27); the approved
// plan, pins and red tests live only in run.json; a commit needs the button, a matching tree hash
// and exactly the gated files (R17); a failed editing run saves final/stopped.patch, resets the
// tree and gives the lock back.
//
// Every dependency is injected (createExecutor(deps)), so tests run with fakes; defaultDeps()
// loads the real modules for the wiring and the integration test.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as catalogModule from './catalog.mjs';
import * as promptsModule from './prompts.mjs';
import { allowedActions, currentIndex, isUnpinnableEnd, lastSessionId, takeoverStageIndex } from './actions.mjs';

// The three headless permission profiles; runs/argv.mjs owns the table (deps.argv wins).
export const HEADLESS = {
  READ: { mode: 'manual', tools: ['Read', 'Grep', 'Glob'] },
  CHECK: { mode: 'manual', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
  EDIT: { mode: 'acceptEdits', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'] },
};
const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
const PROJECT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_NAME_RE = /^[0-9a-z][0-9a-z-]{0,79}$/;
const ROW_MAX = 300;
const INLINE_MAX = 8 * 1024;
const EDIT_INLINE_MAX = 40 * 1024;
const ERROR_TEXT_MAX = 20 * 1024;
const MESSAGE_MAX = 8000;
const NOTE_MAX = 2000;
const MAX_LINE_ROWS = 200;
const CANCEL_WAIT_MS = 10_000;
// acceptEdits under --restricted refuses these (spike A6), so a ticked one is edited in Take over.
const PROTECTED_RE = /(?:^|\/)\.(?:husky|claude|vscode|git)(?:\/|$)|(?:^|\/)\.mcp\.json$/i;
const DEFAULT_TEST_RE = /\.(?:test|spec|integration)\.[cm]?[jt]sx?$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha7 = s => String(s || '').slice(0, 7);
const unique = list => [...new Set(list.filter(x => x !== undefined && x !== null && x !== ''))];
const asList = x => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const pad2 = n => String(n).padStart(2, '0');
const pathOf = x => (typeof x === 'string' ? x : (x && x.path) || '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// An Error that routes and the manager turn into an HTTP answer.
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
const httpFail = (status, message) => { throw httpError(status, message); };

// ---------- Small pure helpers (exported for tests)

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const sha256Text = s => createHash('sha256').update(s).digest('hex');

// "claude-opus-5-5" becomes "Claude Opus 5.5"; anything else becomes "Claude".
export function modelLabel(id) {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(String(id || ''));
  if (!m) return 'Claude';
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}.${m[3]}`;
}

// "stages/NN-<id>[-aK]" and "gates/NN-<id>[-rR]" (SPEC 2.3), relative and posix.
export function stageRel(index, id, attempt = 1) {
  return `stages/${pad2(index)}-${id}${attempt >= 2 ? `-a${attempt}` : ''}`;
}
export function gateRel(index, id, round = 1) {
  return `gates/${pad2(index)}-${id}${round >= 2 ? `-r${round}` : ''}`;
}

// The -n name of a stage session: "<run id>-<stage id>", cut to 80 characters.
export function sessionName(runId, stageId) {
  const n = `${runId}-${stageId}`.toLowerCase().replace(/[^0-9a-z-]/g, '-').slice(0, 80).replace(/-+$/, '');
  return SESSION_NAME_RE.test(n) ? n : `run-${stageId}`.slice(0, 80);
}

// A path from git: posix, relative, no "..", no control characters. '' when it is none of that.
export function gitRelPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || /[\0-\x1f]/.test(s) || /^[A-Za-z]:/.test(s) || s.startsWith('/')) return '';
  if (s.split('/').some(part => part === '..' || part === '.' || part === '')) return '';
  return s;
}

// Normalizes git's changed-file list to [{path, status, oldPath}]. Paths the app can't handle go
// into `bad` (and fail the checks), never silently out of the fences.
export function normChanged(list, bad = []) {
  const out = [];
  for (const x of asList(list)) {
    const raw = pathOf(x);
    const path = gitRelPath(raw);
    if (!path) { if (raw) bad.push(raw); continue; }
    const status = (typeof x === 'object' && x.status) ? String(x.status)[0].toUpperCase() : 'M';
    const oldRaw = typeof x === 'object' && x.oldPath ? x.oldPath : '';
    const oldPath = oldRaw ? gitRelPath(oldRaw) : '';
    if (oldRaw && !oldPath) bad.push(oldRaw);
    out.push(oldPath ? { path, status, oldPath } : { path, status });
  }
  return out;
}
// Paths the tree hash and the commit cover: every changed path, plus the old side of renames.
export const treeFiles = changed => unique(changed.flatMap(c => [c.path, c.oldPath])).sort();

// A path from Claude's output, relative to `tree`: absolute paths inside the tree become relative;
// anything outside, climbing out, or with odd characters gives ''.
export function outputRelPath(p, tree = '') {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\')) {
    if (!tree) return '';
    const norm = x => (/^[A-Za-z]:/.test(x) ? win32.normalize(x).replace(/\\/g, '/') : posix.normalize(x.replace(/\\/g, '/')));
    const base = norm(tree).replace(/\/+$/, '').toLowerCase();
    const full = norm(s);
    if (!full.toLowerCase().startsWith(`${base}/`)) return '';
    s = full.slice(base.length + 1);
  }
  return catalogModule.cleanRelPath(s);
}

// Cleans the paths in a stage output. Returns { output, dropped }: paths outside the tree or
// with odd characters are removed (R13), so nothing later acts on them.
export function sanitizeOutput(schema, out, tree = '') {
  const o = JSON.parse(JSON.stringify(out || {}));
  let dropped = 0;
  const clean = p => { const c = outputRelPath(p, tree); if (!c && p) dropped += 1; return c; };
  const cleanList = list => asList(list).map(clean).filter(Boolean);
  if (schema === 'plan.v1' || schema === 'spec.v1') {
    if (o.files) o.files = asList(o.files).map(f => ({ ...f, path: clean(f.path) })).filter(f => f.path);
    if (o.existingTests) o.existingTests = cleanList(o.existingTests);
    for (const r of asList(o.risks)) if (r && typeof r === 'object' && r.path) r.path = clean(r.path);
    for (const s of asList(o.slices)) { s.files = cleanList(s.files); s.tests = cleanList(s.tests); }
    if (o.where) o.where = clean(o.where);
  } else if (schema === 'tests.v1') {
    o.tests = asList(o.tests).map(t => ({ ...t, path: clean(t.path) })).filter(t => t.path);
  } else if (schema === 'change.v1') {
    o.changes = asList(o.changes).map(c => ({ ...c, path: clean(c.path) })).filter(c => c.path);
    o.recordPath = o.recordPath ? clean(o.recordPath) : '';
  } else if (schema === 'findings.v1') {
    for (const f of asList(o.findings)) f.path = clean(f.path);
  } else if (schema === 'answer.v1') {
    o.sources = asList(o.sources).map(s => ({ ...s, path: clean(s.path) })).filter(s => s.path);
  } else if (schema === 'diagnosis.v1') {
    // Evidence such as "C:\...\src\a.ts:12 (the call)": an absolute path inside the tree becomes
    // relative (the line and the rest are kept), one outside the tree drops the item. Other
    // evidence text stays as it is.
    for (const h of asList(o.hypotheses)) {
      if (!h || typeof h !== 'object') continue;
      h.evidence = asList(h.evidence).map(e => {
        const str = String(e).trim();
        const m = /^([A-Za-z]:[\\/]|[\\/])/.test(str) ? /^(\S+?)((?::\d+){1,2})?(?=$|[\s,;])([\s\S]*)$/.exec(str) : null;
        if (!m) return str;
        const rel = clean(m[1]);
        return rel ? `${rel}${m[2] || ''}${m[3]}` : '';
      }).filter(Boolean);
    }
  }
  return { output: o, dropped };
}

const VERDICT_ORDER = ['ship', 'fix', 'stop'];
// Merges a verify result into the review: findings are marked, never dropped. Verify items refer
// to review findings by ref "F<n>"; high and medium findings verify didn't mention become
// unconfirmed; new verify items are added with source "verify".
export function mergeVerify(review, verify) {
  const findings = asList(review && review.findings).map(f => ({ ...f }));
  const byId = new Map(findings.map(f => [String(f.id).toUpperCase(), f]));
  const mentioned = new Set();
  let next = findings.length + 1;
  for (const v of asList(verify && verify.findings)) {
    const ref = String((v && v.ref) || '').trim().toUpperCase();
    const target = byId.get(ref);
    if (target) {
      mentioned.add(ref);
      target.status = v.status === 'confirmed' ? 'confirmed' : 'unconfirmed';
      if (v.evidence) target.verifyNote = String(v.evidence).slice(0, 600);
    } else {
      findings.push({ ...v, id: `F${next++}`, source: 'verify', status: v.status || 'confirmed' });
    }
  }
  for (const f of findings) {
    if (f.source !== 'verify' && !mentioned.has(String(f.id).toUpperCase()) && (f.severity === 'high' || f.severity === 'medium')) f.status = 'unconfirmed';
  }
  const a = VERDICT_ORDER.indexOf(review && review.verdict);
  const b = VERDICT_ORDER.indexOf(verify && verify.verdict);
  const verdict = VERDICT_ORDER[Math.max(a, b)] || (review && review.verdict) || 'fix';
  return { ...review, verdict, findings, notProven: unique([...asList(review && review.notProven), ...asList(verify && verify.notProven)]), verified: true };
}

// The commit message draft: change.v1's message, the record, the app's verification line and a
// Co-Authored-By line built from the implement stage's resolved model.
export function commitDraft(run) {
  const change = (run.outputs || {}).implement || {};
  const st = (run.stages || []).find(s => s.id === 'implement');
  const last = st && st.attempts && st.attempts[st.attempts.length - 1];
  const model = (last && (last.initModel || last.model)) || '';
  const body = String(change.commitMessage || run.title || 'Change').trim();
  const lines = [body];
  const extra = [];
  if (change.recordPath) extra.push(`Record: ${change.recordPath}`);
  if (run.lastGate && run.lastGate.chip) extra.push(`Checked by the app at ${run.level || 'standard'} level: ${run.lastGate.chip}`);
  if (extra.length) lines.push('', ...extra);
  lines.push('', `Co-Authored-By: ${modelLabel(model)} <noreply@anthropic.com>`);
  return `${lines.join('\n')}\n`;
}

// Turns evidence strings such as "src/a.ts:12" into clean paths.
export function evidencePaths(evidence) {
  return unique(asList(evidence).map(e => catalogModule.cleanRelPath(String(e).trim().split(/[\s,;]/)[0].replace(/:\d+(?::\d+)?$/, ''))));
}

// Ratchet wins from the G0 metric rows ({metric, before, after}), lower is better.
export function winsFromMetricRows(rows, via, at) {
  const out = [];
  for (const r of asList(rows)) {
    if (!r || typeof r.before !== 'number' || typeof r.after !== 'number' || !(r.after < r.before)) continue;
    out.push({ at, kind: 'ratchet', metric: r.metric, label: r.label || r.metric, from: r.before, to: r.after, via });
  }
  return out;
}

// ---------- Plans from gate approvals (pure; throw 400 errors with plain messages)

function cleanAnswers(raw, questions) {
  const out = [];
  for (const x of asList(raw)) {
    const q = String((x && x.q) || '');
    if (!questions.includes(q)) httpFail(400, 'An answer refers to a question the plan did not ask.');
    const a = String((x && x.a) || '').trim();
    if (a.length > NOTE_MAX) httpFail(400, `An answer is longer than ${NOTE_MAX} characters.`);
    if (a) out.push({ q, a });
  }
  return out;
}
function cleanNotes(raw) {
  const n = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (n.length > NOTE_MAX) httpFail(400, `The notes are longer than ${NOTE_MAX} characters.`);
  return n;
}
function pickPaths(raw, allowed, what) {
  const list = unique(asList(raw).map(p => catalogModule.cleanRelPath(p) || String(p)));
  for (const p of list) if (!allowed.includes(p)) httpFail(400, `${String(p).slice(0, 120)} is not ${what}.`);
  return list;
}
function finishPlan(plan) {
  plan.hash = `sha256:${sha256Text(canonicalJson({ ...plan, hash: undefined }))}`;
  return plan;
}

// The files a plan or spec proposes for one slice: the slice's files, or the plan's file list.
export function proposedFiles(output, slice) {
  const s = asList(output && output.slices)[slice] || {};
  return unique(asList(s.files).length ? asList(s.files) : asList(output && output.files).map(pathOf));
}

// Plan gate (plan.v1) or spec gate (spec.v1). payload = {slice, removedFiles, ticked, answers,
// notes}. mustTickFor(files) lists the must-tick files among the plan's files.
export function buildPlan(output, payload = {}, { schema = 'plan.v1', mustTickFor = () => [], at }) {
  const slices = asList(output && output.slices);
  const slice = payload.slice === undefined || payload.slice === null || payload.slice === '' ? 0 : Number(payload.slice);
  if (!Number.isInteger(slice) || slice < 0 || slice >= slices.length) httpFail(400, `Pick a slice from 1 to ${slices.length}.`);
  const s = slices[slice];
  const proposed = proposedFiles(output, slice);
  const removedFiles = pickPaths(payload.removedFiles, proposed, 'in the plan');
  const files = proposed.filter(p => !removedFiles.includes(p));
  if (!files.length) httpFail(400, 'No files are left in the plan; revise it instead.');
  const mustTick = mustTickFor(files);
  const ticked = pickPaths(payload.ticked, mustTick, 'a must-tick file of this plan');
  const plan = {
    schema, approvedAt: at, slice, files, removedFiles, ticked,
    tests: unique(asList(s.tests)), answers: cleanAnswers(payload.answers, asList(output.questions).map(String)),
    notes: cleanNotes(payload.notes), output,
  };
  if (schema === 'spec.v1') plan.acceptance = asList(output.acceptance);
  return finishPlan(plan);
}

// Hypothesis gate (debug): payload = {hypothesis, ticked, notes}. The plan's files are the paths
// named in the chosen hypothesis's evidence; anything else is decided at the fence gate.
export function buildHypothesisPlan(diagnosis, payload = {}, { mustTickFor = () => [], at }) {
  const list = asList(diagnosis && diagnosis.hypotheses);
  const index = payload.hypothesis === undefined || payload.hypothesis === null || payload.hypothesis === '' ? 0 : Number(payload.hypothesis);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) httpFail(400, `Pick a hypothesis from 1 to ${list.length}.`);
  const hypothesis = list[index];
  const files = evidencePaths(hypothesis.evidence);
  if (!files.length) httpFail(400, 'This hypothesis names no file in the tree, so the plan would allow no edits; revise it instead.');
  const ticked = pickPaths(payload.ticked, mustTickFor(files), 'a must-tick file of this hypothesis');
  return finishPlan({
    schema: 'diagnosis.v1', approvedAt: at, slice: index, files, removedFiles: [], ticked, tests: [], answers: [],
    notes: cleanNotes(payload.notes), output: diagnosis, hypothesis,
  });
}

// ---------- The executor
//
// deps (all injected; see defaultDeps for the real ones):
//   dataDir, hubRoot                         required
//   store       runs/store.mjs               saveRun, appendTimeline, writeInput, verifyInputs, runDir
//   locks       runs/locks.mjs               acquire, release; holder = the lock holder record
//   claudeStage runs/claude-stage.mjs        runClaudeStage, claudeEnv
//   claudeSettings runs/settings.mjs         stageSettings, guardConfig, takeoverSettings
//   shim        gates/shim.mjs               writeShim; checkPath = gates/check.mjs
//   checks      gates/check.mjs + commands   runChecks, planChecks, runCommand, mainCheckoutRefusal
//   g0, stagegates, fences                   runG0; gateB, pinsIntact, redNowPasses, denialTestPresent; mustTickFiles
//   worktree    runs/worktree.mjs            worktreeStatus, setupWorktree, prepareRunTree, applyChanges,
//                                            savePatch, applyPatch, resetTree, commitInTree, branchModeCheck,
//                                            prepareBranchMode, finishBranchMode, branchName
//   git         core/git.mjs                 git, changedFiles, diffText, diffNames, fileAt, treeHash, appBranches
//   probes      probes/scan + metrics        scan, recordScan, loadMetrics, loadDetails, newCandidates, appendWins
//   baseline    gates/baseline.mjs           baselineKey, loadBaseline
//   findings    findings/store.mjs           updateFindings | loadFindings + saveFindings, setStatus
//   reports     runs/report.mjs              saveRunReport; runTool for a private hub
//   profileFor(project), mainDirFor(project), getSettings() or settings, riskTags or profileLib.riskTags,
//   profileLib.workspaceOf, slots {claude, checks}, register, unregister, signals, proc, clock, redact,
//   redactDeep, trustFor(run) or trustState(path), startClaude (or launcher.startClaude), startRun,
//   schedule, claudeCommand, nodePath, gitBash, timing (claude-stage test override), argv.
export function createExecutor(deps = {}) {
  const d = { prompts: promptsModule, catalog: catalogModule, ...deps };
  if (!d.dataDir) throw new Error('The executor needs deps.dataDir (the private data folder).');
  if (!d.hubRoot) throw new Error('The executor needs deps.hubRoot (the workspace root).');
  if (!d.store) throw new Error('The executor needs deps.store (runs/store.mjs).');
  const dataDir = d.dataDir;
  const loops = new Map();
  const controllers = new Map();
  const cancelling = new Set();
  const lastStatus = new Map();
  const contexts = new WeakMap();

  // A dependency function by dotted name, bound to its module, or a plain error naming it.
  function dep(name) {
    const parts = name.split('.');
    const host = parts.length > 1 ? d[parts[0]] : d;
    const f = host && host[parts[parts.length - 1]];
    if (typeof f !== 'function') throw new Error(`The executor was started without ${name}.`);
    return f.bind(host);
  }
  // The first of several places a function may come from, or null.
  function optFn(...names) {
    for (const name of names) {
      const parts = name.split('.');
      const host = parts.length > 1 ? d[parts[0]] : d;
      const f = host && host[parts[parts.length - 1]];
      if (typeof f === 'function') return f.bind(host);
    }
    return null;
  }
  const now = () => (d.clock && typeof d.clock.now === 'function' ? d.clock.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  const redact = s => (typeof d.redact === 'function' ? String(d.redact(String(s))) : String(s));
  const capMsg = s => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > ROW_MAX ? `${t.slice(0, ROW_MAX - 1)}…` : t; };
  const def = run => {
    const p = d.catalog.pipelineById(run.pipeline);
    if (!p) throw new Error(`There is no pipeline called ${String(run.pipeline).slice(0, 40)}.`);
    return p;
  };

  function runDir(run) {
    if (!RUN_ID_RE.test(String(run.id)) || !PROJECT_RE.test(String(run.project))) throw new Error('The run id or project name is not valid.');
    return typeof d.store.runDir === 'function' ? d.store.runDir(dataDir, run) : join(dataDir, 'runs', run.project, run.id);
  }
  const finalFile = (run, name) => join(runDir(run), 'final', name);

  // ---------- Saving, rows, files

  async function save(run) {
    await d.store.saveRun(dataDir, run);
    // The manager's store wrapper signals every write; this adds one per status change for a
    // store that doesn't.
    if (d.signals && typeof d.signals.emit === 'function' && lastStatus.get(run.id) !== run.status) {
      lastStatus.set(run.id, run.status);
      try { d.signals.emit({ run: run.id, project: run.project, seq: null, status: run.status }); } catch { /* a signal is a hint */ }
    }
  }

  // Appends timeline rows; never throws (a lost row must not stop a run).
  async function rows(run, list) {
    const cur = run.current || {};
    const clean = asList(list).filter(Boolean).map(r => ({ stage: cur.stage || null, attempt: cur.attempt || null, ...r, msg: capMsg(redact(r.msg)) }));
    if (!clean.length) return;
    try { await d.store.appendTimeline(dataDir, run, clean); } catch { /* the run folder may be gone */ }
  }
  const row = (run, kind, msg, extra = {}) => rows(run, [{ kind, msg, ...extra }]);
  // Gate progress rows (check rows, probe rows): shown as kind "gate".
  const gateSink = run => r => {
    const list = asList(r).map(x => (typeof x === 'string' ? { msg: x } : x)).filter(x => x && x.status !== 'running');
    rows(run, list.map(x => ({ msg: x.msg || `${x.label || x.id}: ${x.status}${x.reason ? ` (${x.reason})` : ''}`, ok: x.status ? !['fail', 'error'].includes(x.status) : undefined, kind: 'gate' })));
  };
  function lineSink(run) {
    let n = 0;
    return line => {
      n += 1;
      if (n <= MAX_LINE_ROWS) row(run, 'gate', String(line || ''));
      else if (n === MAX_LINE_ROWS + 1) row(run, 'gate', 'More output is in the setup log.');
    };
  }

  async function writeJsonFile(file, data) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    for (let i = 0; ; i++) {
      try { await rename(tmp, file); return; } catch (e) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await sleep(50 * 2 ** i);
      }
    }
  }
  async function readJsonFile(file, fallback = null) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
  }
  async function writeFinal(run, name, data) {
    if (typeof data === 'string') {
      await mkdir(dirname(finalFile(run, name)), { recursive: true });
      await writeFile(finalFile(run, name), data);
    } else await writeJsonFile(finalFile(run, name), data);
  }
  const input = (run, name, data) => d.store.writeInput(dataDir, run, name, data);
  async function nonEmptyFile(file) {
    try { return (await stat(file)).size > 0; } catch { return false; }
  }

  // ---------- Context: profile, main checkout, settings

  async function context(run) {
    if (contexts.has(run)) return contexts.get(run);
    if (typeof d.profileFor !== 'function') throw new Error('The executor was started without profileFor.');
    const r = await d.profileFor(run.project);
    const wrapped = r && typeof r === 'object' && 'profile' in r && ('exists' in r || 'errors' in r);
    const profile = wrapped ? r.profile : r;
    if (wrapped && asList(r.errors).length) throw new Error(`The ${run.project} profile has errors: ${asList(r.errors)[0]}`);
    if (!profile) throw new Error(`There is no profile for ${run.project}.`);
    const mainDir = (run.isolation && run.isolation.mainDir) || (d.mainDirFor ? await d.mainDirFor(run.project) : '');
    if (!mainDir) throw new Error(`The checkout of ${run.project} was not found; link it in Projects first.`);
    let settings = {};
    if (typeof d.getSettings === 'function') settings = (await d.getSettings()) || {};
    else if (typeof d.settings === 'function') settings = (await d.settings()) || {};
    else if (d.settings && typeof d.settings === 'object') settings = d.settings;
    const c = { profile, mainDir, settings };
    contexts.set(run, c);
    return c;
  }
  const isolationMode = (project, profile, settings) => (((settings || {}).isolation || {})[project] || (profile.isolation || {}).mode || 'worktree');
  const testRegex = profile => { try { return (profile.fences || {}).testPattern ? new RegExp(profile.fences.testPattern) : DEFAULT_TEST_RE; } catch { return DEFAULT_TEST_RE; } };
  const allowValues = profile => asList((profile.secrets || {}).allowValues);
  const redactOut = (value, profile) => (typeof d.redactDeep === 'function' ? d.redactDeep(value, { allow: allowValues(profile) }) : value);

  async function gitOut(dir, args) {
    const r = await dep('git.git')(dir, args);
    const s = typeof r === 'string' ? r : Buffer.isBuffer(r) ? r.toString('utf8') : (r && (r.stdout ?? r.out)) || '';
    return String(s).trim();
  }
  const revParse = (dir, ref) => gitOut(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const mergeBase = (dir, a, b) => gitOut(dir, ['merge-base', a, b]);
  async function changedOf(dir, base, { head = null, bad = [] } = {}) {
    const opts = head ? { includeUntracked: false, head } : { includeUntracked: true };
    return normChanged(await dep('git.changedFiles')(dir, base, opts), bad);
  }
  const secretExcludes = profile => asList((profile.secrets || {}).denyReadGlobs);
  // A short diff stat: one line per file with its status.
  const statText = changed => changed.map(c => `${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`).join('\n');

  function riskOf(profile, paths) {
    const clean = unique(asList(paths).map(p => catalogModule.cleanRelPath(p) || gitRelPath(p)));
    if (!clean.length) return { tags: [], hits: [] };
    const fn = optFn('riskTags', 'profileLib.riskTags');
    if (!fn) throw new Error('The executor was started without riskTags.');
    const r = fn(profile, clean) || {};
    return { tags: asList(r.tags), hits: asList(r.hits) };
  }
  // Raises (never lowers) the run's level from risk hits, and remembers the tags.
  function applyRisk(run, risk, care) {
    const lvl = d.catalog.computeLevel(care || (run.values || {}).care || run.level || 'standard', risk, { from: run.level });
    run.level = lvl.level;
    run.levelReason = unique([...asList(run.levelReason), ...lvl.reasons]);
    run.riskTags = unique([...asList(run.riskTags), ...risk.tags]);
    const seen = new Set(asList(run.riskHits).map(h => `${h.tag}:${h.path}`));
    run.riskHits = [...asList(run.riskHits), ...risk.hits.filter(h => !seen.has(`${h.tag}:${h.path}`))].slice(0, 50);
  }
  async function mustTickOf(profile, files) {
    if (!files.length) return [];
    const r = await dep('fences.mustTickFiles')(profile, files);
    return unique(asList(r).map(pathOf));
  }
  const protectedPath = p => {
    const editable = optFn('fences.editableInStage');
    return editable ? !editable(p) : PROTECTED_RE.test(p);
  };

  // ---------- Locks, trees, findings

  async function acquireLock(run) {
    if (run.lockHeld) return;
    let r;
    try { r = await dep('locks.acquire')(dataDir, run.project, { runId: run.id, holder: d.holder, proc: d.proc, now }); } catch (e) { httpFail(409, e.message); }
    if (r === false || (r && r.ok === false)) httpFail(409, (r && (r.reason || r.error)) || `${run.project} is busy with another run. Park it or wait.`);
    run.lockHeld = true;
  }
  async function releaseLock(run) {
    if (!run.lockHeld) return;
    try { await dep('locks.release')(dataDir, run.project, run.id); } catch (e) { await row(run, 'error', `Could not release the lock: ${e.message}`); }
    run.lockHeld = false;
  }
  // The run owns a tree the app may reset: the run worktree, or the main checkout in branch mode.
  const ownsTree = run => !!(run.treeReady && run.isolation && run.isolation.tree && run.base && run.base.sha &&
    (run.isolation.treeMode === 'run' || run.isolation.mode === 'branch'));
  const branchMode = run => !!(run.isolation && run.isolation.mode === 'branch');
  // For resets and patches: in branch mode the main checkout is allowed, but only while the
  // branch mode record of this run still counts (worktree.mjs assertRunTree).
  const mainCheckoutOpts = run => (branchMode(run) ? { allowMain: true, runId: run.id } : { allowMain: false });

  // Saves the tree's changes to final/stopped.patch (when asked), resets the tree to its base and,
  // in branch mode, switches the main checkout back to where it was. When the patch can't be
  // saved nothing is reset, since the reset would lose the changes: the tree (and the caller's
  // lock) stay as they are, and it returns { kept: true }.
  async function tidyTree(run, { patch }) {
    if (!ownsTree(run)) return { kept: false };
    const { tree } = run.isolation;
    const base = run.base.sha;
    const { profile } = await context(run);
    if (patch) {
      run.patch = '';
      try {
        const r = await dep('worktree.savePatch')(tree, base, finalFile(run, 'stopped.patch'), { exclude: secretExcludes(profile) });
        run.patch = r && r.empty ? '' : 'final/stopped.patch';
      } catch (e) {
        await row(run, 'error', `Could not save the changes to final/stopped.patch, so ${basename(tree)} was not reset and keeps them: ${e.message}`);
        return { kept: true };
      }
    }
    try { await dep('worktree.resetTree')(tree, base, mainCheckoutOpts(run)); } catch (e) { await row(run, 'error', `Could not reset the tree: ${e.message}`); }
    await leaveBranchMode(run);
    run.treeReady = false;
    return { kept: false };
  }
  const keptText = run => `The changes could not be saved to final/stopped.patch, so ${basename(run.isolation.tree)} was not reset and keeps them`;
  async function leaveBranchMode(run) {
    if (!branchMode(run) || !run.treeReady) return;
    try {
      const r = await dep('worktree.finishBranchMode')({ mainDir: run.isolation.mainDir, original: run.isolation.original || null, runId: run.id });
      if (r && r.switched === false) await row(run, 'info', 'Your checkout is no longer where the run left it, so the app left it as it is.');
    } catch (e) {
      await row(run, 'error', `Could not switch your checkout back: ${e.message}`);
    }
  }
  // Takes the lock and puts the run's tree back: the base checked out, then final/stopped.patch
  // applied (retry after a failure, unpark). Refusals become 409 and leave nothing behind.
  async function restoreTree(run) {
    const { profile, mainDir } = await context(run);
    await acquireLock(run);
    const base = run.base.sha;
    try {
      if (branchMode(run)) {
        const b = await dep('worktree.prepareBranchMode')({ profile, mainDir, baseSha: base, runId: run.id });
        run.isolation = { ...run.isolation, tree: (b && b.tree) || mainDir, original: (b && b.original) || run.isolation.original || null };
      } else {
        const prep = await dep('worktree.prepareRunTree')({ profile, mainDir, dataDir, baseSha: base, onLine: lineSink(run), proc: d.proc, runCommand: d.checks && d.checks.runCommand });
        run.isolation = { ...run.isolation, tree: (prep && prep.tree) || run.isolation.tree };
      }
      run.treeReady = true;
      const patch = finalFile(run, 'stopped.patch');
      if (await nonEmptyFile(patch)) await dep('worktree.applyPatch')(run.isolation.tree, patch, mainCheckoutOpts(run));
    } catch (e) {
      if (run.treeReady) await tidyTree(run, { patch: false });
      await releaseLock(run);
      httpFail(409, e.message);
    }
  }

  // Moves the run's finding (fix runs) to `to`. A refusal becomes an info row, never an error.
  async function moveFinding(run, to, extra = {}) {
    const id = run.findingId || (run.pipeline === 'fix' ? (run.values || {}).finding : null);
    if (!id || !d.findings || typeof d.findings.setStatus !== 'function') return;
    const opts = { by: 'run', runId: run.id, at: iso(), ...extra };
    try {
      if (typeof d.findings.updateFindings === 'function') {
        await d.findings.updateFindings(dataDir, run.project, doc => {
          const f = asList(doc && doc.findings).find(x => x.id === id);
          if (!f || f.status === to) return doc;
          return d.findings.setStatus(doc, id, to, opts).doc;
        });
      } else {
        const doc = await d.findings.loadFindings(dataDir, run.project);
        const f = asList(doc && doc.findings).find(x => x.id === id);
        if (!f || f.status === to) return;
        const out = d.findings.setStatus(doc, id, to, opts);
        await d.findings.saveFindings(dataDir, run.project, out.doc || out, { baseHash: doc.hash });
      }
    } catch (e) { await row(run, 'info', `Finding ${id} was not moved to ${to}: ${e.message}`); }
  }

  // ---------- Slots and process registration

  // A release function for a free slot ('claude' or 'checks'); an abort while waiting throws.
  async function takeSlot(kind, run, stage, signal) {
    const sem = d.slots && d.slots[kind];
    if (!sem || typeof sem.acquire !== 'function') return () => {};
    const r = await sem.acquire({ run, stage, signal });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (typeof r === 'function') r();
      else if (r && typeof r.release === 'function') r.release();
    };
  }
  function register(entry) {
    try { return typeof d.register === 'function' ? d.register(entry) : null; } catch { return null; }
  }
  function unregister(token) {
    try { if (token != null && typeof d.unregister === 'function') d.unregister(token); } catch { /* best effort */ }
  }

  // ---------- Stage bookkeeping

  function ensureStages(run, p) {
    run.stages = Array.isArray(run.stages) ? run.stages : [];
    p.stages.forEach((s, n) => {
      if (!run.stages[n] || run.stages[n].id !== s.id) run.stages[n] = { id: s.id, n, kind: s.kind, status: 'pending' };
      if (s.kind === 'claude' && !Array.isArray(run.stages[n].attempts)) run.stages[n].attempts = [];
    });
    run.stages.length = p.stages.length;
    run.outputs = run.outputs || {};
    run.allowances = run.allowances || [];
    run.pins = run.pins || [];
    run.redTests = run.redTests || [];
    run.levelReason = run.levelReason || [];
    run.riskTags = run.riskTags || [];
    run.fixRounds = { auto: 0, user: 0, maxAuto: catalogModule.FIX_ROUNDS.maxAuto, maxUser: catalogModule.FIX_ROUNDS.maxUser, ...(run.fixRounds || {}) };
  }
  const firstOpen = run => run.stages.findIndex(s => s.status !== 'done' && s.status !== 'skipped');
  function setCurrent(run, index) {
    const st = run.stages[index];
    const attempt = st.kind === 'claude' ? Math.max(1, (st.attempts || []).length) : Math.max(1, st.rounds || 1);
    run.current = { stage: st.id, index, attempt, round: 1 + run.fixRounds.auto + run.fixRounds.user };
  }
  // Puts stage `id` back to pending (with what its next attempt should do) and every later stage too.
  function reopenFrom(run, id, next) {
    const i = run.stages.findIndex(s => s.id === id);
    if (i < 0) throw new Error(`This run has no ${id} stage.`);
    for (let k = i; k < run.stages.length; k++) {
      run.stages[k].status = 'pending';
      delete run.stages[k].next;
    }
    if (next) run.stages[i].next = next;
    run.gatedTree = null;
    run.current = { ...(run.current || {}), stage: id, index: i };
    return i;
  }

  // Ends the run. The tree is reset and the lock released; a failed editing run keeps its work in
  // final/stopped.patch, which Retry stage brings back. When that can't be saved the run does not
  // end: it is interrupted with its changes in the tree and the lock held, so Retry, Stop and
  // Cancel stay on. After a commit the run tree is already clean and detached, so only branch
  // mode switches back.
  async function endRun(run, status, reason = '') {
    const p = def(run);
    run.status = status;
    run.statusReason = reason;
    run.waiting = null;
    run.endedAt = iso();
    if (status === 'committed') await leaveBranchMode(run);
    else if ((await tidyTree(run, { patch: status === 'failed' && p.editing })).kept) {
      run.status = 'interrupted';
      run.statusReason = `${reason ? `${reason} ` : ''}${keptText(run)}.`;
      run.endedAt = null;
      await row(run, 'status', `Run interrupted: ${run.statusReason}`);
      await save(run);
      return;
    }
    run.treeReady = status === 'committed' ? false : run.treeReady;
    await releaseLock(run);
    if (status === 'failed') await moveFinding(run, 'open', { reason: 'the run failed' });
    await row(run, 'status', reason ? `Run ${status}: ${reason}` : `Run ${status}`);
    await save(run);
  }

  async function waitFor(run, index, kind) {
    const st = run.stages[index];
    st.status = 'waiting';
    st.startedAt = st.startedAt || iso();
    run.status = 'waiting';
    run.statusReason = '';
    run.waiting = { kind, since: iso(), detail: await waitDetail(run, kind) };
    await row(run, 'status', `Waiting for you: ${def(run).stages[index].label}`);
    await save(run);
  }

  async function waitDetail(run, kind) {
    const out = run.outputs || {};
    if (kind === 'plan' || kind === 'spec') {
      const { profile } = await context(run);
      const o = out.scope || {};
      const files = unique([...asList(o.files).map(pathOf), ...asList(o.slices).flatMap(s => asList(s.files))]);
      const mustTick = await mustTickOf(profile, files);
      return { mustTick, editInTakeOver: mustTick.filter(protectedPath), newFiles: asList(run.newFiles),
        riskTags: asList(run.riskTags), levelReason: asList(run.levelReason) };
    }
    if (kind === 'hypothesis') {
      const { profile } = await context(run);
      const files = unique(asList((out.investigate || {}).hypotheses).flatMap(h => evidencePaths(h.evidence)));
      const mustTick = await mustTickOf(profile, files);
      return { pinnable: (out.investigate || {}).pinnable !== false, mustTick, editInTakeOver: mustTick.filter(protectedPath) };
    }
    if (kind === 'review') {
      const r = out.review || {};
      return { verdict: r.verdict || '', findings: asList(r.findings).length, verified: !!r.verified, treeSha: (run.gatedTree || {}).treeSha || '' };
    }
    if (kind === 'commit') return { files: (run.gatedTree || {}).files || [], treeSha: (run.gatedTree || {}).treeSha || '' };
    if (kind === 'triage') return { findings: asList((out.review || {}).findings).length };
    if (kind === 'decide') return { items: asList((out.triage || {}).items).length };
    return {};
  }

  // ---------- The loop

  // Runs the run until it waits for you, ends, or `signal` aborts. Resolves either way.
  function advance(run, { signal } = {}) {
    if (loops.has(run.id)) return loops.get(run.id);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    controllers.set(run.id, ctl);
    const p = (async () => {
      try { await loop(run, ctl.signal); } catch (e) {
        if (!ctl.signal.aborted && !cancelling.has(run.id)) await crashed(run, e);
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (controllers.get(run.id) === ctl) controllers.delete(run.id);
        loops.delete(run.id);
      }
    })();
    loops.set(run.id, p);
    return p;
  }

  async function crashed(run, e) {
    try {
      for (const st of asList(run.stages)) if (st.status === 'running') st.status = 'failed';
      run.error = { message: `The executor stopped: ${e.message}`, at: iso() };
      await row(run, 'error', run.error.message);
      await endRun(run, 'failed', run.error.message);
    } catch { /* nothing more to do */ }
  }

  async function loop(run, sig) {
    const p = def(run);
    ensureStages(run, p);
    if (run.status !== 'running') return;
    for (let guard = 0; guard < 300; guard++) {
      if (sig.aborted || cancelling.has(run.id)) return;
      const i = firstOpen(run);
      if (i < 0) { await endRun(run, 'passed'); return; }
      const s = p.stages[i];
      setCurrent(run, i);
      if (s.when && !d.catalog.PREDICATES[s.when](run)) {
        Object.assign(run.stages[i], { status: 'skipped', endedAt: iso(), meta: 'Not needed for this run' });
        await row(run, 'stage', `${s.label}: skipped`, { stage: s.id });
        if (s.endIfSkipped) {
          await endRun(run, s.endIfSkipped, s.id === 'prove' ? 'No test can pin this bug; see the diagnosis. Take over to fix it by hand.' : '');
          return;
        }
        await save(run);
        continue;
      }
      if (s.kind === 'human' || s.kind === 'git') { await waitFor(run, i, s.waits); return; }
      if (s.kind === 'claude' && s.profile === 'EDIT' && (await topUpBaseline(run, i, s, sig)).stop) return;
      const r = s.kind === 'gate' ? await runGate(run, i, s, sig) : await runClaude(run, i, s, sig);
      if (!r || r.stop) return;
    }
    throw new Error('The run went round its stages 300 times.');
  }

  // The level can rise after preflight (scope paths, the approved plan), and the commands the
  // higher level adds would then have no baseline, so every failure they find would count as new.
  // Before an edit stage, while the tree is still at base, the baseline is topped up for them.
  // Once the tree has changed that can't be done honestly; the timeline says so instead.
  async function topUpBaseline(run, i, s, sig) {
    if (!run.baselineLevel || run.baselineLevel === run.level || !run.treeReady) return {};
    const { profile } = await context(run);
    const { tree, treeMode } = run.isolation;
    if ((await changedOf(tree, run.base.sha)).length) {
      await row(run, 'info', `The level rose to ${run.level} after the tree changed, so the checks it adds have no baseline: their failures count as new.`);
    } else {
      const rel = gateRel(i, `baseline-${run.level}`);
      const gateDir = join(runDir(run), ...rel.split('/'));
      await mkdir(gateDir, { recursive: true });
      await row(run, 'stage', `The level rose to ${run.level}; the baseline is topped up before ${s.label}`, { stage: s.id });
      const b = await ensureBaseline(run, { profile, tree, treeMode, baseSha: run.base.sha, level: run.level, gateDir, signal: sig, stage: s.id });
      if (b.cancelled || sig.aborted) return { stop: true };
      if (b.error) await row(run, 'error', `The baseline for ${run.level} could not be made, so the checks it adds count every failure as new: ${b.error}`);
    }
    run.baselineLevel = run.level;
    await save(run);
    return {};
  }

  // ---------- Gates

  async function runGate(run, i, s, sig) {
    const st = run.stages[i];
    delete st.next;
    st.rounds = (st.rounds || 0) + 1;
    const rel = gateRel(i, s.id, st.rounds);
    const gateDir = join(runDir(run), ...rel.split('/'));
    await mkdir(gateDir, { recursive: true });
    Object.assign(st, { status: 'running', startedAt: iso(), gate: rel });
    delete st.endedAt;
    run.status = 'running';
    run.current = { ...run.current, attempt: st.rounds };
    await save(run);
    await row(run, 'stage', `${s.label} started`);
    const fn = GATES[s.run];
    let r;
    try {
      if (!fn) throw new Error(`there is no gate called ${s.run}`);
      const problem = await inputsProblem(run);
      r = problem ? failed(problem) : await fn(run, i, s, { gateDir, rel, signal: sig });
    } catch (e) {
      if (sig.aborted || cancelling.has(run.id)) return { stop: true };
      r = { status: 'failed', reason: e.status ? e.message : `${s.label} failed: ${e.message}` };
    }
    if (sig.aborted || cancelling.has(run.id) || (r && r.status === 'cancelled')) return { stop: true };
    return applyGate(run, i, s, r || failed(`${s.label} returned nothing.`));
  }

  async function applyGate(run, i, s, r) {
    const st = run.stages[i];
    st.endedAt = iso();
    if (r.meta) st.meta = r.meta;
    if (r.status === 'retry') { await save(run); return {}; }
    if (r.status === 'waiting') {
      st.status = 'waiting';
      run.status = 'waiting';
      run.waiting = { kind: r.waiting.kind, since: iso(), detail: r.waiting.detail || {} };
      await row(run, 'status', `Waiting for you: ${r.meta || r.waiting.kind}`);
      await save(run);
      return { stop: true };
    }
    if (r.status === 'gates-red') {
      st.status = 'failed';
      run.status = 'gates-red';
      run.statusReason = r.reason;
      run.waiting = null;
      await row(run, 'gate', r.reason, { ok: false });
      await save(run);
      return { stop: true };
    }
    if (r.status !== 'done') {
      st.status = 'failed';
      run.error = { message: r.reason || `${s.label} failed.`, at: iso() };
      await row(run, 'error', run.error.message);
      await endRun(run, 'failed', run.error.message);
      return { stop: true };
    }
    st.status = 'done';
    await row(run, 'gate', `${s.label}: ${r.meta || 'done'}`, { ok: true });
    if (r.end) { await endRun(run, r.end, r.reason || ''); return { stop: true }; }
    await save(run);
    return {};
  }
  const done = (meta, extra = {}) => ({ status: 'done', meta, ...extra });
  const failed = reason => ({ status: 'failed', reason });

  // '' when inputs/ still holds exactly what the app wrote, else why not (R27).
  async function inputsProblem(run) {
    if (typeof d.store.verifyInputs !== 'function') return '';
    let r;
    try { r = await d.store.verifyInputs(dataDir, run); } catch (e) { return `The run inputs could not be checked: ${e.message}`; }
    if (!r || r === true || r.ok !== false) return '';
    const list = asList(r.problems).length ? asList(r.problems) : [...asList(r.changed), ...asList(r.missing), ...asList(r.extra)];
    return `The run inputs changed after the app wrote them: ${list.slice(0, 5).join(' ') || 'unknown change'}`;
  }

  const baselineKeyFor = (baseSha, treeMode) => (d.baseline && typeof d.baseline.baselineKey === 'function'
    ? d.baseline.baselineKey({ baseSha, treeMode, node: process.versions.node })
    : `${String(baseSha).slice(0, 12)}-${treeMode}-node${process.versions.node}`);
  async function loadBaselineSafe(run) {
    try { return d.baseline && d.baseline.loadBaseline && run.baselineKey ? await d.baseline.loadBaseline(dataDir, run.project, run.baselineKey) : null; } catch { return null; }
  }

  // The baseline for the level's commands on the base tree. Commands already in the saved
  // baseline are not run again (runChecks role 'base' also skips them).
  async function ensureBaseline(run, { profile, tree, treeMode, baseSha, level, gateDir, signal, stage }) {
    const key = baselineKeyFor(baseSha, treeMode);
    run.baselineKey = key;
    // Without the listening ports G4 always plans as "not run", and its baseline would never be made.
    const listening = asList(await dep('checks.listeningPorts')({ profile, level }));
    const planned = asList(await dep('checks.planChecks')({ profile, level, changed: [], what: 'everything', listening }))
      .filter(c => c.commandId && !c.skipReason).map(c => c.commandId);
    if (!planned.length) return { cached: true, key };
    const existing = await loadBaselineSafe(run);
    if (existing && planned.every(id => existing.commands && existing.commands[id])) return { cached: true, key };
    const release = await takeSlot('checks', run, stage, signal);
    try {
      const s = await dep('checks.runChecks')({ profile, project: run.project, dataDir, tree, treeMode, baseSha, changed: [], level,
        what: 'everything', role: 'base', gateDir, signal, onRow: gateSink(run), proc: d.proc, baselineKey: key, git: d.git, runId: run.id, listening });
      if (signal.aborted || s.result === 'cancelled') return { cancelled: true };
      if (s.result === 'refused') return { error: s.refusal || 'The checks refused this tree.' };
      return { cached: false, key, chip: s.chip || '' };
    } finally { release(); }
  }
  const firstProblem = s => {
    const c = asList(s && s.checks).find(x => x.status === 'error' || x.status === 'fail');
    return c ? `${c.label || c.id}: ${c.reason || c.status}` : (s && (s.refusal || s.chip)) || 'see the gate log';
  };

  // Runs the given test files with their workspace's test command; returns one merged TAP result.
  // Takes the check slot itself (one check at a time, R20), so callers must not hold it.
  async function runTests(run, profile, paths, gateDir, signal, stage) {
    const release = await takeSlot('checks', run, stage, signal);
    try { return await runTestGroups(run, profile, paths, gateDir, signal); } finally { release(); }
  }
  async function runTestGroups(run, profile, paths, gateDir, signal) {
    const groups = new Map();
    const owner = optFn('profileLib.workspaceOf');
    for (const p of unique(paths)) {
      const ws = owner ? owner(profile, p) : null;
      const wsDef = typeof ws === 'string' ? asList(profile.workspaces).find(w => w.id === ws) : ws;
      const cmd = wsDef && asList(wsDef.test)[0];
      if (!cmd) throw new Error(`No test command covers ${p}.`);
      groups.set(cmd, [...(groups.get(cmd) || []), p]);
    }
    const tap = { tests: [], files: [], counts: { pass: 0, fail: 0, skip: 0, todo: 0 }, parseErrors: [], results: [] };
    for (const [commandId, files] of groups) {
      const r = await dep('checks.runCommand')({ profile, commandId, tree: run.isolation.tree, files, gateDir, signal, proc: d.proc,
        treeMode: run.isolation.treeMode, base: run.base.sha });
      tap.results.push({ commandId, status: r.status, exitCode: r.exitCode, log: r.log });
      const t = r.tap || {};
      tap.tests.push(...asList(t.tests));
      tap.files.push(...asList(t.files));
      tap.parseErrors.push(...asList(t.parseErrors));
      for (const k of Object.keys(tap.counts)) tap.counts[k] += ((t.counts || {})[k]) || 0;
    }
    return tap;
  }
  const sha256Of = run => async p => sha256Text(await readFile(join(run.isolation.tree, ...p.split('/'))));
  const readAtBase = run => p => dep('git.fileAt')(run.isolation.tree, run.base.sha, p);
  const readAtHead = run => async p => { try { return await readFile(join(run.isolation.tree, ...p.split('/')), 'utf8'); } catch { return null; } };
  async function readAllowlist(project) {
    const doc = await readJsonFile(join(dataDir, 'profiles', `${project}.allowlist.json`), null);
    return doc && (Array.isArray(doc) || Array.isArray(doc.list)) ? doc : null;
  }

  const GATES = {
    // Editing runs: the tree at base (run worktree or branch mode), the level, the baseline and
    // the base metric scan the G0 ratchet compares against.
    async preflight(run, i, s, g) {
      const { profile, mainDir, settings } = await context(run);
      const mode = isolationMode(run.project, profile, settings);
      const integration = profile.git.integrationBranch;
      const inherit = run.inherit || {};
      const baseSha = inherit.baseSha || await revParse(mainDir, integration);
      run.versions = { ...(run.versions || {}), node: process.versions.node };
      if (mode === 'worktree') {
        const prep = await dep('worktree.prepareRunTree')({ profile, mainDir, dataDir, baseSha, onLine: lineSink(run), signal: g.signal,
          proc: d.proc, runCommand: d.checks && d.checks.runCommand });
        run.isolation = { mode, tree: prep.tree, mainDir, treeMode: 'run', ...(prep.refreshed ? { refreshed: asList(prep.ran) } : {}) };
      } else {
        const b = await dep('worktree.prepareBranchMode')({ profile, mainDir, baseSha, runId: run.id });
        run.isolation = { mode: 'branch', tree: (b && b.tree) || mainDir, mainDir, treeMode: 'main', original: (b && b.original) || null };
      }
      run.base = { ...(run.base || {}), branch: inherit.branch || integration, sha: baseSha };
      run.treeReady = true;
      if (inherit.spec && !run.plan) {
        run.outputs.scope = inherit.spec;
        const tick = await mustTickOf(profile, proposedFiles(inherit.spec, inherit.slice || 0));
        run.plan = buildPlan(inherit.spec, { slice: inherit.slice || 0, ticked: asList(inherit.ticked).filter(f => tick.includes(f)) },
          { schema: 'spec.v1', at: iso(), mustTickFor: files => tick.filter(f => files.includes(f)) });
      }
      applyRisk(run, riskOf(profile, [...d.catalog.requestPaths(run.values), ...asList(run.plan && run.plan.files)]));
      if (run.pipeline === 'feature' && (run.values || {}).money !== 'no') {
        applyRisk(run, { tags: ['money'], hits: [{ tag: 'money', path: '', glob: 'you said it may touch money' }] });
      }
      await save(run);
      const b = await ensureBaseline(run, { profile, tree: run.isolation.tree, treeMode: run.isolation.treeMode, baseSha, level: run.level,
        gateDir: g.gateDir, signal: g.signal, stage: s.id });
      if (b.cancelled) return { status: 'cancelled' };
      if (b.error) return failed(b.error);
      run.baselineLevel = run.level;
      await baseScan(run, profile, g.signal);
      const where = run.isolation.treeMode === 'run' ? `${basename(run.isolation.tree)} clean` : 'branch mode';
      return done(`${where} · base ${sha7(baseSha)} · baseline ${b.cached ? 'cached' : 'computed'}`);
    },

    // Gate B: the new tests on unchanged source (pins pass, red tests fail on an assertion).
    async gateB(run, i, s, g) {
      const { profile } = await context(run);
      const proveDef = def(run).stages.find(x => x.id === 'prove');
      const tests = run.outputs.prove || { tests: [] };
      const changed = await changedOf(run.isolation.tree, run.base.sha);
      const baseline = await loadBaselineSafe(run);
      const r = await dep('stagegates.gateB')({
        kind: proveDef.proveKind, tests, baseline, readAtBase: readAtBase(run), sha256: sha256Of(run), changed, plan: run.plan,
        testPattern: (profile.fences || {}).testPattern || null, runFiles: files => runTests(run, profile, files, g.gateDir, g.signal, s.id),
      });
      if (g.signal.aborted) return { status: 'cancelled' };
      if (!r || !r.ok) {
        const problems = asList(r && r.problems).slice(0, 20);
        const summary = { at: iso(), result: 'red', stage: 'gate-b', problems: problems.length ? problems : ['the new tests did not behave as planned'], gate: g.rel };
        await input(run, 'gate-summary.json', JSON.stringify(summary, null, 2));
        run.lastGate = { at: summary.at, result: 'red', chip: 'Gate B red', folder: g.rel };
        return { status: 'gates-red', meta: 'Gate B red', reason: `Gate B: ${summary.problems.join('; ')}` };
      }
      run.pins = asList(r.pins);
      run.redTests = asList(r.redTests);
      return done(proveDef.proveKind === 'pins' ? `${plural(run.pins.length, 'pinned file')} pass on the old code` : `${plural(run.redTests.length, 'red test')} fail on their assertion`);
    },

    // Checks C: G0, the level checks, fences, pins and red tests, then the automatic fix loop.
    async checks(run, i, s, g) {
      const { profile } = await context(run);
      const { tree, treeMode } = run.isolation;
      const base = run.base.sha;
      const bad = [];
      const changed = await changedOf(tree, base, { bad });
      applyRisk(run, riskOf(profile, changed.flatMap(c => [c.path, c.oldPath])));
      if (run.baselineLevel && run.baselineLevel !== run.level) {
        await row(run, 'info', `The changed files raise the level to ${run.level}, so the checks it adds have no baseline: their failures count as new.`);
        run.baselineLevel = run.level;
      }
      const diff = String(await dep('git.diffText')(tree, base, { includeUntracked: true, exclude: secretExcludes(profile) }) || '');
      await input(run, 'diff.patch', diff);
      await input(run, 'changed.json', JSON.stringify(changed, null, 2));
      await input(run, 'stat.txt', statText(changed));
      const allowlist = await readAllowlist(run.project);
      let g0res = null;
      const runG0 = async (o = {}) => {
        g0res = await dep('g0.runG0')({ profile, tree, baseSha: base, changed, diff, plan: run.plan, ticked: asList(run.plan && run.plan.ticked),
          allowances: run.allowances, pipeline: run.pipeline, git: d.git, probes: d.probes, allowlist, baseScan: run.baseScan || null, proc: d.proc,
          gateDir: o.gateDir || g.gateDir, signal: o.signal || g.signal, runCommand: o.runCommand || (d.checks && d.checks.runCommand) });
        return g0res;
      };
      const release = await takeSlot('checks', run, s.id, g.signal);
      let summary;
      try {
        summary = await dep('checks.runChecks')({ profile, project: run.project, dataDir, tree, treeMode, baseSha: base, changed,
          level: run.level, what: 'uncommitted', role: 'head', gateDir: g.gateDir, signal: g.signal, onRow: gateSink(run), runG0,
          proc: d.proc, baselineKey: run.baselineKey, git: d.git, runId: run.id });
        if (!g0res && summary.result !== 'refused' && !g.signal.aborted) await runG0();
      } finally { release(); }
      if (g.signal.aborted || summary.result === 'cancelled') return { status: 'cancelled' };
      if (summary.result === 'refused') return failed(summary.refusal || 'The checks refused this tree.');
      const fence = (g0res && g0res.fence) || {};
      const outside = unique(asList(fence.outsidePlan).map(pathOf));
      const red = [];
      if (!changed.length) red.push('Implement changed no files.');
      for (const p of bad) red.push(`git listed a path the app can't handle safely: ${String(p).slice(0, 120)}`);
      for (const [bucket, label] of [['forbidden', 'forbidden file'], ['mustTick', 'must-tick file not ticked'], ['pinnedChanged', 'pinned test changed'], ['existingTestChanged', 'existing test changed']]) {
        for (const x of asList(fence[bucket])) red.push(`${label}: ${pathOf(x)}`);
      }
      const failing = asList(summary.checks).filter(c => (c.status === 'fail' || c.status === 'error') && c.id !== 'g0.fences');
      // A level without G0 leaves runG0 to the fallback above, so runChecks never saw its rows
      // (secrets, format, ratchets): they count here, or a planted key could go green.
      const seen = new Set(asList(summary.checks).map(c => c.id));
      failing.push(...asList(g0res && g0res.rows).filter(r => r && !seen.has(r.id) && r.id !== 'g0.fences' && (r.status === 'fail' || r.status === 'error')));
      red.push(...failing.map(c => `${c.label || c.id}: ${c.reason || c.status}`));
      if (!failing.length && summary.result === 'error') red.push(`The checks could not run: ${firstProblem(summary)}`);
      let pinsState = null;
      if (run.pins.length) {
        const tap = await runTests(run, profile, run.pins.map(p => p.path), g.gateDir, g.signal, s.id);
        pinsState = await dep('stagegates.pinsIntact')({ pins: run.pins, readBytes: p => readFile(join(tree, ...p.split('/'))), tap });
        if (!pinsState.ok) {
          const what = [...asList(pinsState.changed).map(x => `${pathOf(x)} changed`), ...asList(pinsState.failed).map(x => `${x.name || pathOf(x)} ${x.status || 'failed'}`)];
          red.push(`pins: ${unique(what).join(', ') || 'not intact'}`);
        }
      }
      if (run.redTests.length) {
        const tap = await runTests(run, profile, run.redTests.map(t => t.path), g.gateDir, g.signal, s.id);
        const r = await dep('stagegates.redNowPasses')({ redTests: run.redTests, tap });
        if (!r.ok) red.push(`red test still fails: ${asList(r.stillFailing).map(x => x.name || pathOf(x)).join(', ') || 'see the log'}`);
      }
      if (run.riskTags.includes('tenant')) {
        const r = await dep('stagegates.denialTestPresent')({ changed, readAtHead: readAtHead(run), riskHits: asList(run.riskHits),
          testPattern: (profile.fences || {}).testPattern || null });
        if (!r.ok) red.push(r.reason || 'no denial test for the tenant paths (heuristic)');
      }
      if (g.signal.aborted) return { status: 'cancelled' };
      const metricRow = asList(g0res && g0res.rows).find(x => x && x.id === 'g0.ratchets.metrics');
      run.metricRows = asList(metricRow && metricRow.details && metricRow.details.rows);
      const gateSummary = { at: iso(), result: red.length ? 'red' : outside.length ? 'fence' : 'green', chip: summary.chip || '',
        problems: red.slice(0, 40), outsidePlan: outside, newTests: asList((summary.tests || {}).new).slice(0, 40), gate: g.rel };
      await input(run, 'gate-summary.json', JSON.stringify(gateSummary, null, 2));
      run.lastGate = { at: gateSummary.at, result: gateSummary.result, chip: gateSummary.chip, folder: g.rel };
      if (outside.length) {
        const reasons = {};
        for (const c of asList((run.outputs.implement || {}).changes)) if (outside.includes(c.path)) reasons[c.path] = capMsg(redact(c.what || ''));
        return { status: 'waiting', meta: `${plural(outside.length, 'file')} outside the plan`, waiting: { kind: 'fence', detail: { paths: outside, reasons, red } } };
      }
      if (red.length) {
        if (run.fixRounds.auto < run.fixRounds.maxAuto) {
          run.fixRounds.auto += 1;
          reopenFrom(run, 'implement', { mode: 'resume', reason: 'auto-fix', gateSummary });
          await row(run, 'gate', `Red: ${red[0]}. Automatic fix round ${run.fixRounds.auto} of ${run.fixRounds.maxAuto}.`, { ok: false });
          return { status: 'retry', meta: `red; automatic fix round ${run.fixRounds.auto}` };
        }
        return { status: 'gates-red', meta: plural(red.length, 'problem'), reason: `Gates still red after ${plural(run.fixRounds.auto, 'automatic fix round')}: ${red[0]}` };
      }
      const files = treeFiles(changed);
      const treeSha = await dep('git.treeHash')(tree, base, files, join(runDir(run), 'tmp', `index-${pad2(i)}-${run.stages[i].rounds}`));
      run.gatedTree = { treeSha, at: iso(), files };
      await writeProof(run, { summary, fence, pinsState, changed });
      await writeFinal(run, 'diff.patch', diff);
      await writeFinal(run, 'commit-msg.txt', commitDraft(run));
      return done(`green · ${summary.chip || 'all checks passed'}`);
    },

    // Review: the diff of the chosen target into inputs/, read-only in the main checkout.
    async collect(run, i, s, g) {
      const { profile, mainDir } = await context(run);
      const v = run.values || {};
      const integration = profile.git.integrationBranch;
      let base;
      let head = null;
      if (v.target === 'branch') { head = await revParse(mainDir, 'HEAD'); base = await mergeBase(mainDir, integration, head); }
      else if (v.target === 'last') { head = await revParse(mainDir, 'HEAD'); base = await revParse(mainDir, `HEAD~${Number(v.n) || 1}`); }
      else if (v.target === 'app') { head = await revParse(mainDir, v.branch); base = await mergeBase(mainDir, integration, head); }
      else base = await revParse(mainDir, 'HEAD');
      const exclude = secretExcludes(profile);
      const diff = String(await dep('git.diffText')(mainDir, base, head ? { head, includeUntracked: false, exclude } : { includeUntracked: true, exclude }) || '');
      const bad = [];
      const changed = await changedOf(mainDir, base, { head, bad });
      run.isolation = { mode: 'none', tree: mainDir, mainDir, treeMode: 'main' };
      run.base = { branch: v.target === 'app' ? v.branch : (v.target === 'branch' ? integration : ''), sha: base, head };
      if (!changed.length) return done('nothing to review', { end: 'passed', reason: 'Nothing to review: there are no changes.' });
      applyRisk(run, riskOf(profile, changed.flatMap(c => [c.path, c.oldPath])), 'standard');
      // G0 as information only: no profile command runs in your main checkout.
      const skip = async () => ({ status: 'skip', reason: 'Not run for a read-only review', durationMs: 0 });
      let g0res = null;
      try {
        g0res = await dep('g0.runG0')({ profile, tree: mainDir, baseSha: base, changed, diff, plan: null, ticked: [], allowances: [], pipeline: 'review',
          gateDir: g.gateDir, git: d.git, runCommand: skip, probes: d.probes, signal: g.signal, proc: d.proc });
      } catch (e) { await row(run, 'info', `Static checks were not run: ${e.message}`); }
      if (g.signal.aborted) return { status: 'cancelled' };
      await input(run, 'diff.patch', diff);
      await input(run, 'stat.txt', statText(changed));
      await input(run, 'changed.json', JSON.stringify(changed, null, 2));
      const g0rows = asList(g0res && g0res.rows).map(r => ({ id: r.id, label: r.label, status: r.status, reason: r.reason }));
      await input(run, 'g0.json', JSON.stringify({ rows: g0rows, secretsFound: (g0res && g0res.secretsFound) || 0, unhandledPaths: bad }, null, 2));
      run.outputs.collect = { files: changed.length, g0: g0rows };
      const tags = run.riskTags.length ? ` · ${run.riskTags.join(', ')}` : '';
      return done(`${plural(changed.length, 'file')} · base ${sha7(base)}${tags}`);
    },

    // Architecture: the code probes, the scan record, and the candidates new since the compare scan.
    async scan(run, i, s, g) {
      const { profile, mainDir } = await context(run);
      const v = run.values || {};
      const sha = await revParse(mainDir, 'HEAD');
      run.isolation = { mode: 'none', tree: mainDir, mainDir, treeMode: 'main' };
      run.base = { branch: '', sha };
      const before = (await dep('probes.loadMetrics')(dataDir, run.project)) || { scans: [] };
      const scans = asList(before.scans);
      const ref = v.compare === 'commit' ? [...scans].reverse().find(x => String(x.sha || '').startsWith(v.commit)) : scans[scans.length - 1];
      if (v.compare === 'commit' && !ref) return failed(`There is no stored scan for commit ${sha7(v.commit)}; compare with the last scan instead.`);
      const result = await dep('probes.scan')({ profile, tree: mainDir, sha, signal: g.signal, onRow: gateSink(run), proc: d.proc });
      if (g.signal.aborted) return { status: 'cancelled' };
      const recorded = await dep('probes.recordScan')(dataDir, run.project, result, { profile });
      const lenses = asList(v.lenses).length ? asList(v.lenses) : asList(profile.lenses);
      const loadDetails = optFn('probes.loadDetails');
      const prevDetails = ref && loadDetails ? await loadDetails(dataDir, run.project, ref.id) : null;
      const found = asList(await dep('probes.newCandidates')(prevDetails, result.details, { max: 30, ids: lenses }));
      const candidates = found.slice(0, 30).map((c, n) => ({ ref: `C${n + 1}`, ...c }));
      await input(run, 'candidates.json', JSON.stringify(candidates, null, 2));
      run.outputs.scan = { scanId: recorded && recorded.scanId, candidates: candidates.length, wins: asList(recorded && recorded.wins).length,
        errors: Object.keys(result.errors || {}), score: recorded ? recorded.score ?? null : null, since: ref ? ref.sha || null : null };
      const since = ref ? ` since ${sha7(ref.sha)}` : prevDetails ? '' : ' (first scan: nothing to compare)';
      return done(`${plural(candidates.length, 'new candidate')}${since}`);
    },

    // Check my work: the run worktree when it is ready (your changes copied in, a baseline at
    // base), otherwise your main checkout (refused there while it has a .env and no guard).
    async checkPreflight(run, i, s, g) {
      const { profile, mainDir, settings } = await context(run);
      const v = run.values || {};
      const what = v.what || 'uncommitted';
      const integration = profile.git.integrationBranch;
      const head = await revParse(mainDir, 'HEAD');
      const base = what === 'branch' ? await mergeBase(mainDir, integration, head) : head;
      run.level = v.level || run.level || 'quick';
      run.base = { branch: what === 'branch' ? integration : '', sha: base, head };
      let ready = false;
      if (isolationMode(run.project, profile, settings) === 'worktree') {
        const ws = await dep('worktree.worktreeStatus')({ profile, mainDir, dataDir });
        ready = !!ws && ws.state === 'ready';
        if (!ready) await row(run, 'info', `${(ws && ws.text) || 'The run worktree is not ready.'} The checks run in your main checkout.`);
      }
      if (!ready) {
        await releaseLock(run);
        run.isolation = { mode: 'none', tree: mainDir, mainDir, treeMode: 'main' };
        run.baselineKey = baselineKeyFor(base, 'main');
        await save(run);
        return done(`main checkout · base ${sha7(base)} · no baseline in the main checkout, so every failure counts as new`);
      }
      await acquireLock(run);
      const prep = await dep('worktree.prepareRunTree')({ profile, mainDir, dataDir, baseSha: base, onLine: lineSink(run), signal: g.signal,
        proc: d.proc, runCommand: d.checks && d.checks.runCommand });
      run.isolation = { mode: 'worktree', tree: prep.tree, mainDir, treeMode: 'run' };
      run.treeReady = true;
      await save(run);
      const b = await ensureBaseline(run, { profile, tree: prep.tree, treeMode: 'run', baseSha: base, level: run.level, gateDir: g.gateDir, signal: g.signal, stage: s.id });
      if (b.cancelled) return { status: 'cancelled' };
      if (b.error) return failed(b.error);
      if (what === 'branch') await gitOut(prep.tree, ['checkout', '-q', '--detach', head]);
      else await dep('worktree.applyChanges')({ tree: prep.tree, mainDir, mode: 'uncommitted', exclude: secretExcludes(profile) });
      return done(`${basename(prep.tree)} · base ${sha7(base)} · baseline ${b.cached ? 'cached' : 'computed'}`);
    },

    async checkRun(run, i, s, g) {
      const { profile } = await context(run);
      const v = run.values || {};
      const { tree, treeMode } = run.isolation;
      const base = run.base.sha;
      const bad = [];
      const changed = await changedOf(tree, base, { bad });
      let diff = '';
      try { diff = String(await dep('git.diffText')(tree, base, { includeUntracked: true, exclude: secretExcludes(profile) }) || ''); } catch { diff = ''; }
      const runG0 = async (o = {}) => dep('g0.runG0')({ profile, tree, baseSha: base, changed, diff, plan: null, ticked: [], allowances: [],
        pipeline: 'check', git: d.git, probes: d.probes, proc: d.proc, allowlist: await readAllowlist(run.project),
        gateDir: o.gateDir || g.gateDir, signal: o.signal || g.signal, runCommand: o.runCommand || (d.checks && d.checks.runCommand) });
      const release = await takeSlot('checks', run, s.id, g.signal);
      let summary;
      try {
        summary = await dep('checks.runChecks')({ profile, project: run.project, dataDir, tree, treeMode, baseSha: base, changed,
          level: run.level, what: v.what || 'uncommitted', role: 'head', gateDir: g.gateDir, signal: g.signal, onRow: gateSink(run), runG0,
          proc: d.proc, baselineKey: run.baselineKey, git: d.git, runId: run.id });
      } finally { release(); }
      if (g.signal.aborted || summary.result === 'cancelled') return { status: 'cancelled' };
      run.outputs.checks = { result: summary.result, chip: summary.chip || '', counts: summary.counts || {}, gate: g.rel, refusal: summary.refusal || '', unhandledPaths: bad };
      run.lastGate = { at: iso(), result: summary.result, chip: summary.chip || '', folder: g.rel };
      if (summary.result === 'refused') return failed(summary.refusal || 'The checks refused this tree.');
      if (summary.result === 'pass' && !bad.length) return done(summary.chip || 'all checks passed', { end: 'passed', reason: summary.chip || '' });
      const why = bad.length ? `git listed a path the app can't handle safely: ${bad[0]}` : summary.chip || firstProblem(summary);
      return done(summary.chip || summary.result, { end: 'failed', reason: why });
    },

    async setup(run, i, s, g) {
      const { profile, mainDir } = await context(run);
      const r = await dep('worktree.setupWorktree')({ profile, mainDir, dataDir, onLine: lineSink(run), signal: g.signal, proc: d.proc,
        runCommand: d.checks && d.checks.runCommand });
      if (r && (r.error || r.status === 'failed')) return failed(typeof r.error === 'string' ? r.error : 'The worktree setup failed; see the setup log.');
      return done(`ready${r && r.path ? ` at ${r.path}` : ''}`, { end: 'passed', reason: `The run worktree is ready${r && r.path ? ` at ${r.path}` : ''}.` });
    },
  };

  // The cycle probes at base, so the G0 metric ratchet has a base value. Optional: a failure is
  // an info row and the ratchet then says "not compared".
  async function baseScan(run, profile, signal) {
    const ids = asList(profile.probes).filter(p => p && p.kind === 'cycles').map(p => p.id);
    const scanFn = optFn('probes.scan');
    if (!ids.length || !scanFn) return;
    try {
      const r = await scanFn({ profile, tree: run.isolation.tree, sha: run.base.sha, ids, signal, proc: d.proc });
      run.baseScan = { values: r.values || {}, errors: r.errors || {} };
    } catch (e) {
      if (!signal.aborted) await row(run, 'info', `The base metric scan did not run: ${e.message}`);
    }
  }

  async function writeProof(run, { summary, fence, pinsState, changed }) {
    const inPlan = new Set(asList(run.plan && run.plan.files));
    const turns = {};
    for (const st of run.stages) for (const a of asList(st.attempts)) turns[st.id] = (turns[st.id] || 0) + (a.numTurns || a.turns || 0);
    const after = [];
    for (const p of run.pins) {
      try { after.push({ path: p.path, sha256: await sha256Of(run)(p.path) }); } catch { after.push({ path: p.path, sha256: null }); }
    }
    const allowed = run.allowances.map(a => a.path);
    const proof = {
      version: 1, runId: run.id, project: run.project, pipeline: run.pipeline, builtAt: iso(),
      base: { branch: run.base.branch, sha: run.base.sha }, branch: run.branch || null, tree: run.isolation.treeMode === 'run' ? basename(run.isolation.tree) : 'main checkout (branch mode)',
      level: run.level, levelReason: asList(run.levelReason),
      checks: asList(summary.checks).map(c => ({ id: c.id, label: c.label || c.id, command: c.command || '', result: c.status, durationMs: c.durationMs || 0 })),
      baseline: { key: run.baselineKey || summary.baselineKey || '', ...pickCounts(summary.counts) },
      pins: { before: run.pins.map(p => ({ path: p.path, sha256: p.sha256 })), after,
        identical: run.pins.every((p, k) => after[k] && after[k].sha256 === String(p.sha256).replace(/^sha256:/, '')), green: !pinsState || !!pinsState.ok },
      redTests: run.redTests,
      scope: { inPlan: changed.filter(c => inPlan.has(c.path)).length, total: changed.length, allowedByUser: allowed,
        outside: asList(fence.outsidePlan).map(pathOf).filter(p => !allowed.includes(p)) },
      existingTestsChanged: asList(fence.existingTestChanged).map(pathOf),
      treeHash: { gated: run.gatedTree.treeSha, atCommit: null, match: null },
      turns, versions: run.versions || {}, notProven: asList((run.outputs.implement || {}).notProven),
    };
    await writeFinal(run, 'proof.json', proof);
    await writeFinal(run, 'proof.md', proofMarkdown(proof));
    return proof;
  }
  const pickCounts = c => ({ new: (c || {}).new || 0, known: (c || {}).known || 0, flaky: (c || {}).flaky || 0, canShrink: (c || {}).canShrink || 0 });

  // ---------- Claude stages

  function headless(name) {
    const table = (d.argv && d.argv.HEADLESS_PROFILES) || HEADLESS;
    const p = table[name] || HEADLESS[name];
    return { mode: p.mode, tools: Array.isArray(p.tools) ? [...p.tools] : String(p.tools).split(',') };
  }

  // The data a stage sees. READ and CHECK stages get files in inputs/ (shown inline when short);
  // EDIT stages have no --add-dir, so their inputs are written into the prompt. With `preview`
  // nothing is written.
  async function buildVars(run, s, { profile, cwd, edit, preview = false }) {
    const inputsDir = preview ? '<run folder>\\inputs' : join(runDir(run), 'inputs');
    const out = run.outputs || {};
    const v = run.values || {};
    const docs = profile.docs || {};
    const vars = {
      project: profile.label || run.project, readFirst: d.prompts.readFirstList(profile),
      reviewRules: docs.reviewRules || 'the review rules in the project instructions',
      recordsDir: docs.recordsDir || '', recordsIndex: docs.recordsIndex || '',
      testPattern: (profile.fences || {}).testPattern || '', level: run.level || 'standard',
      riskTags: asList(run.levelReason).join('; ') || asList(run.riskTags).join(', ') || 'none', schemaName: s.schema,
      inputsDir: edit ? '(none: this stage gets its inputs in this prompt)' : inputsDir,
    };
    const block = async (name, file, text) => {
      const t = String(text == null ? '' : text);
      if (edit) {
        const c = d.prompts.capBytes(t, EDIT_INLINE_MAX);
        return d.prompts.dataBlock(name, c.cut ? `${c.text}\n(cut at 40 KB)` : c.text);
      }
      if (!preview) await input(run, file, t);
      if (Buffer.byteLength(t, 'utf8') <= INLINE_MAX) return `${d.prompts.dataBlock(name, t)}\n(Also in ${file} in the inputs folder.)`;
      return `(${name} is long, so it is not shown here: Read ${file} in ${inputsDir}.)`;
    };
    vars.request = await block('request', 'request.md', await requestText(run, profile, { edit }));
    const { error, ...shown } = v;
    vars.values = await block('values', 'values.json', JSON.stringify(shown, null, 2));
    if (run.plan) {
      const { output, ...plan } = run.plan;
      vars.plan = await block('plan', 'plan.json', JSON.stringify({ ...plan, summary: (output || {}).summary || '' }, null, 2));
      vars.answers = await block('answers', 'answers.json', JSON.stringify(run.plan.answers || [], null, 2));
      if (run.plan.notes) vars.notes = await block('notes', 'notes.md', run.plan.notes);
      const slice = asList((output || {}).slices)[run.plan.slice] || null;
      vars.slice = await block('slice', 'slice.json', JSON.stringify({ slice, testsFromProve: asList((out.prove || {}).tests), pins: run.pins.map(p => p.path), redTests: run.redTests }, null, 2));
      if (run.plan.schema === 'spec.v1') {
        vars.spec = await block('spec', 'spec.json', JSON.stringify({ summary: (output || {}).summary, acceptance: run.plan.acceptance,
          schemaChange: (output || {}).schemaChange, migrationPlan: (output || {}).migrationPlan }, null, 2));
      }
      if (run.plan.hypothesis) vars.hypothesis = await block('hypothesis', 'hypothesis.json', JSON.stringify({ hypothesis: run.plan.hypothesis, reproPlan: (output || {}).reproPlan }, null, 2));
    }
    if (s.id === 'verify' && out.review) vars.findings = await block('findings', 'findings.json', JSON.stringify(out.review.findings, null, 2));
    if (s.id === 'triage' && run.pipeline === 'architecture') {
      let text = '[]';
      if (!preview) { try { text = await readFile(join(inputsDir, 'candidates.json'), 'utf8'); } catch { text = '[]'; } }
      vars.candidates = await block('candidates', 'candidates.json', text);
    }
    if (s.id === 'review' || s.id === 'verify') {
      let changedText = '[]';
      let statTxt = '';
      let gs = null;
      if (!preview) {
        changedText = (await readFile(join(inputsDir, 'changed.json'), 'utf8').catch(() => '[]'));
        statTxt = (await readFile(join(inputsDir, 'stat.txt'), 'utf8').catch(() => ''));
        gs = await readJsonFile(join(inputsDir, 'gate-summary.json'), null);
      }
      vars.diffStat = statTxt ? `${d.prompts.dataBlock('diff-stat', statTxt)}\n(The full diff is diff.patch in the inputs folder.)` : '(See diff.patch in the inputs folder.)';
      vars.changes = d.prompts.dataBlock('changed-files', changedText);
      if (gs) vars.gateSummary = d.prompts.dataBlock('gate-summary', JSON.stringify(gs, null, 2));
      else if (run.pipeline === 'review') vars.gateSummary = '(See g0.json in the inputs folder for the static checks; none of the project commands ran.)';
    }
    if (!preview && run.pipeline === 'debug' && s.id === 'investigate') {
      if (v.error) await input(run, 'error.txt', v.error);
      if (v.screenshot) await copyScreenshot(run, v.screenshot);
    }
    vars.projectInstructions = preview && !run.base
      ? '(CLAUDE.md and AGENTS.md from the base commit go here when the run starts.)'
      : await d.prompts.projectInstructions({ git: d.git, dir: cwd, sha: run.base.sha });
    return vars;
  }

  // Copies an inbox image into inputs/ through the store, so it is hashed like every input.
  async function copyScreenshot(run, rel) {
    const clean = String(rel).replace(/\\/g, '/');
    if (clean.split('/').includes('..')) return;
    const ext = extname(clean).toLowerCase().replace(/[^.a-z]/g, '') || '.png';
    try {
      const bytes = await readFile(join(d.hubRoot, 'inbox', 'attachments', ...clean.split('/')));
      await input(run, `screenshot${ext}`, bytes);
    } catch (e) { await row(run, 'info', `The screenshot was not copied: ${e.code || e.message}`); }
  }

  const optionLabel = (pipelineId, key, value) => {
    const p = d.catalog.pipelineById(pipelineId);
    const f = p && p.fields.find(x => x.key === key);
    return ((f && asList(f.options).find(o => o[0] === value)) || [value, value])[1];
  };
  async function requestText(run, profile, { edit }) {
    const v = run.values || {};
    const list = x => asList(x).join(', ') || 'none';
    switch (run.pipeline) {
      case 'explain': return `Question: ${v.what}\nWhere to look: ${v.where || 'anywhere in the project'}`;
      case 'review': return [`Review: ${optionLabel('review', 'target', v.target)}${v.target === 'last' ? ` (${v.n})` : ''}${v.target === 'app' ? ` (${v.branch})` : ''}`,
        `Base commit: ${sha7(run.base && run.base.sha)}${run.base && run.base.head ? ` · head ${sha7(run.base.head)}` : ' · your working tree'}`,
        `Focus: ${list(v.focus)}`, `Depth: ${v.depth || 'quick'}`].join('\n');
      case 'architecture': return `Lenses: ${list(asList(v.lenses).length ? v.lenses : profile.lenses)}`;
      case 'fix': {
        let items = [];
        try { items = d.findings && d.findings.loadFindings ? asList(((await d.findings.loadFindings(dataDir, run.project)) || {}).findings) : []; } catch { items = []; }
        const item = items.find(x => x.id === v.finding) || {};
        return [`Finding ${v.finding}: ${item.title || '(title not found)'}`, `Severity: ${item.severity || 'unknown'} · Area: ${item.area || 'unknown'}`,
          `Evidence from the audit: ${item.evidence || '(none)'}`, `Notes from the user: ${v.notes || '(none)'}`].join('\n');
      }
      case 'refactor': return [v.what, `Where: ${v.where || 'find it'} · Kind: ${v.kind || 'auto'} · Care: ${v.care || 'standard'}`,
        `Keep unchanged: ${list(v.keep)}`, `Keep out: ${v.out || 'nothing named'}`].join('\n');
      case 'debug': {
        const lines = [`What is wrong: ${v.what}`, `Seen in: ${v.seen || 'unsure'}`, `How to reproduce: ${v.repro || '(not given)'}`, `Expected: ${v.expected || '(not given)'}`];
        if (v.error && edit) lines.push(`Error text:\n${d.prompts.capBytes(v.error, ERROR_TEXT_MAX).text}`);
        else lines.push(v.error ? 'The error text is error.txt in the inputs folder.' : 'No error text was given.');
        if (v.screenshot && !edit) lines.push('A screenshot is in the inputs folder.');
        return lines.join('\n');
      }
      case 'feature': return [v.what, `Who: ${list(v.who)}`, `Surfaces: ${list(v.surfaces)}`, `Done when:\n${v.doneWhen || '(not given)'}`,
        `Touches money or more than one tenant: ${v.money || 'unsure'} (unsure counts as yes)`, `Keep out: ${v.out || 'nothing named'}`].join('\n');
      default: return String(v.what || '');
    }
  }

  // Read-only pipelines work in the main checkout at HEAD; set that up when no gate did.
  async function ensureReadOnlyTree(run, mainDir) {
    if (!run.isolation || !run.isolation.tree) run.isolation = { ...(run.isolation || {}), mode: 'none', tree: mainDir, mainDir, treeMode: 'main' };
    if (!run.base || !run.base.sha) run.base = { branch: '', sha: await revParse(mainDir, 'HEAD') };
  }

  const promptName = s => {
    const m = /^pipelines\/app\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\.md$/.exec(String(s.prompt || ''));
    if (!m) throw new Error(`The stage ${s.id} has no prompt file.`);
    return { pipeline: m[1], stage: m[2] };
  };

  async function runClaude(run, i, s, sig) {
    const st = run.stages[i];
    const next = st.next || { mode: 'fresh' };
    const ctx = await context(run);
    const { profile, mainDir } = ctx;
    await ensureReadOnlyTree(run, mainDir);
    const cwd = run.isolation.tree;
    const edit = s.profile === 'EDIT';
    let prompt;
    let resumeSessionId;
    if (next.mode === 'resume') {
      resumeSessionId = lastSessionId(run, i);
      if (!resumeSessionId) throw new Error(`${s.label} has no session to resume.`);
      const vars = { schemaName: s.schema };
      if (next.notes) vars.notes = d.prompts.dataBlock('notes', next.notes);
      if (next.gateSummary) vars.gateSummary = d.prompts.dataBlock('gate-summary', JSON.stringify(next.gateSummary, null, 2));
      if (next.findings) vars.findings = d.prompts.dataBlock('findings', JSON.stringify(next.findings, null, 2));
      prompt = d.prompts.resumePrompt(next.reason && next.reason !== 'retry' ? next.reason : 'resume', vars);
    } else {
      const vars = await buildVars(run, s, { profile, cwd, edit });
      const { pipeline, stage } = promptName(s);
      prompt = d.prompts.renderPrompt(await d.prompts.loadPrompt(d.hubRoot, pipeline, stage), vars);
    }
    delete st.next;
    const result = await attempt(run, i, s, { ctx, cwd, prompt, resumeSessionId, bonusTurns: next.bonusTurns || 0, why: next.reason || 'fresh', sig });
    if (!result) return { stop: true };
    return afterClaude(run, i, s, result, ctx, sig);
  }

  // One attempt of a Claude stage (a new folder stages/NN-id[-aK]). Returns the stageResult, or
  // null when the run is being cancelled or the app is closing.
  async function attempt(run, i, s, { ctx, cwd, prompt, resumeSessionId, bonusTurns, why, sig }) {
    const st = run.stages[i];
    const { profile, mainDir, settings } = ctx;
    let release;
    try { release = await takeSlot('claude', run, s.id, sig); } catch (e) {
      if (sig.aborted) return null;
      throw e;
    }
    if (sig.aborted || cancelling.has(run.id)) { release(); return null; }
    let token = null;
    try {
      const k = st.attempts.length + 1;
      const folder = stageRel(i, s.id, k);
      const dir = runDir(run);
      const stageDir = join(dir, ...folder.split('/'));
      const tmpDir = join(dir, 'tmp', basename(folder));
      const binDir = join(stageDir, 'bin');
      const inputsDir = join(dir, 'inputs');
      await mkdir(stageDir, { recursive: true });
      await mkdir(tmpDir, { recursive: true });
      await mkdir(inputsDir, { recursive: true });
      const hp = headless(s.profile);
      const model = d.catalog.stageModel({ pipeline: def(run), stage: s, profile, settings, run });
      const caps = d.catalog.stageCaps(s, { profile, bonusTurns });
      const sessionId = resumeSessionId || randomUUID();
      const settingsFile = join(stageDir, 'settings.json');
      const nodePath = d.nodePath || process.execPath;
      const stageSettings = await dep('claudeSettings.stageSettings')({ profile: s.profile, hubRoot: d.hubRoot, dataDir, runDir: dir, stageDir,
        tree: cwd, mainDir, profileDoc: profile, nodePath });
      await writeJsonFile(settingsFile, stageSettings);
      if (s.profile !== 'READ') {
        await writeJsonFile(join(stageDir, 'guard.json'), await dep('claudeSettings.guardConfig')({ tree: cwd, runDir: dir, hubRoot: d.hubRoot, dataDir, mainDir,
          secretFiles: asList((profile.secrets || {}).trackedSecretFiles) }));
        await writeJsonFile(join(stageDir, 'check-context.json'), checkContext(run, profile, cwd));
        await dep('shim.writeShim')(binDir, { nodePath, checkPath: d.checkPath || defaultCheckPath(), stageDir });
      }
      const spec = {
        profile: s.profile, mode: hp.mode, tools: hp.tools, model: model.model, effort: model.effort, maxTurns: caps.maxTurns, budgetUsd: caps.budgetUsd,
        sessionId, name: sessionName(run.id, s.id), settingsFile, cwd, addDirs: s.profile === 'EDIT' ? [] : [inputsDir],
      };
      const env = dep('claudeStage.claudeEnv')({ shimDir: s.profile === 'READ' ? '' : binDir, gitBash: d.gitBash || '', tmpDir });
      const rec = { k, folder, sessionId, name: spec.name, startedAt: iso(), model: model.model, effort: model.effort, profile: s.profile, mode: hp.mode,
        maxTurns: caps.maxTurns, cwd, why };
      st.attempts.push(rec);
      Object.assign(st, { status: 'running', startedAt: st.startedAt || rec.startedAt });
      delete st.endedAt;
      if (s.id === 'review') run.reviewEffort = model.effort;
      run.status = 'running';
      run.current = { ...(run.current || {}), stage: s.id, index: i, attempt: k };
      await save(run);
      await row(run, 'stage', `${s.label} started (${model.model}/${model.effort}, ${s.profile}${resumeSessionId ? ', resumed' : ''})`, { attempt: k });
      let result;
      try {
        result = await dep('claudeStage.runClaudeStage')({
          spec, prompt, stageDir, env, claudeCommand: d.claudeCommand, caps: { maxTurns: caps.maxTurns, wallMs: caps.wallMs }, schemaName: s.schema,
          onRow: r => rows(run, asList(r)),
          // Saved at once: startup recovery needs the pid and start time of a stage that runs.
          onProc: (p, info = {}) => {
            if (info.event === 'exit') { unregister(token); token = null; return; }
            rec.proc = { pid: p.pid, image: p.image, startedAt: p.startedAt };
            unregister(token);
            token = register({ kind: 'claude', runId: run.id, project: run.project, stage: s.id, attempt: k, rec: rec.proc });
            save(run).catch(() => {});
          },
          signal: sig, clock: d.clock, proc: d.proc, resumeSessionId, stage: s.id, attempt: k, timing: d.timing,
        });
      } catch (e) {
        result = { status: 'failed', reason: `${s.label} could not run: ${e.message}` };
      }
      Object.assign(rec, {
        endedAt: iso(), status: result.status, turns: result.turnsCounted, numTurns: result.numTurns, subtype: result.subtype, durationMs: result.durationMs,
        estUsd: result.estUsd, denials: asList(result.denials).length, ccVersion: (result.init || {}).ccVersion || null, initModel: (result.init || {}).model || null,
        init: result.init ? (result.init.check === 'mismatch' || result.init.check === 'ok' ? result.init.check : (result.init.check ? 'ok' : 'missing')) : '',
        autoResumed: !!result.autoResumed,
      });
      if (rec.ccVersion) run.versions = { ...(run.versions || {}), claudeCode: rec.ccVersion };
      if (result.rateLimit) run.rateLimit = result.rateLimit;
      if (sig.aborted || cancelling.has(run.id)) return null;
      return result;
    } finally {
      release();
      unregister(token);
    }
  }

  // What tg-check reads in a CHECK or EDIT stage (gates/check.mjs inStage).
  function checkContext(run, profile, tree) {
    const f = profile.fences || {};
    return {
      runDir: runDir(run), dataDir, project: run.project, tree, baseSha: run.base.sha, planFiles: asList(run.plan && run.plan.files),
      plannedTests: unique([...asList(run.plan && run.plan.tests), ...asList((run.outputs.prove || {}).tests).map(t => t.path)]),
      ticked: asList(run.plan && run.plan.ticked), testPattern: f.testPattern || '', mustTick: asList(f.mustTick), mustTickNew: asList(f.mustTickNew),
      allowed: ['test', 'types', 'lint'],
    };
  }

  function failReason(result, s) {
    if (result.reason || result.error || result.statusReason) return String(result.reason || result.error || result.statusReason);
    const problems = asList(result.init && result.init.problems);
    if (problems.length) return `Stopped before any work: ${problems.join('; ')}`;
    if (asList(result.outputErrors).length) return `Claude returned a result that does not fit ${s.schema}: ${asList(result.outputErrors).slice(0, 3).join('; ')}`;
    if (result.output === undefined || result.output === null) return 'Claude returned no structured result.';
    return `${s.label} ended with ${result.subtype || result.status}.`;
  }

  async function afterClaude(run, i, s, result, ctx, sig) {
    const st = run.stages[i];
    st.endedAt = iso();
    if (result.status === 'done' && (result.output === undefined || result.output === null || asList(result.outputErrors).length)) {
      result = { ...result, status: 'failed', reason: result.reason || 'Claude returned no structured result.' };
    }
    if (result.status === 'done') {
      const { output, dropped } = sanitizeOutput(s.schema, result.output, run.isolation.tree);
      if (dropped) await row(run, 'info', `Ignored ${plural(dropped, 'path')} in Claude's output that point outside the project.`);
      const problem = await storeOutput(run, s, redactOut(output, ctx.profile), result, ctx);
      if (problem) {
        st.status = 'failed';
        run.error = { message: problem, at: iso() };
        await row(run, 'error', problem);
        await endRun(run, 'failed', problem);
        return { stop: true };
      }
      st.status = 'done';
      st.meta = plural(result.numTurns || result.turnsCounted || 0, 'turn');
      await row(run, 'stage', `${s.label} done`);
      await save(run);
      return {};
    }
    if (result.status === 'capped' || result.status === 'paused-limit') {
      st.status = result.status;
      run.status = result.status;
      run.statusReason = result.reason || (result.status === 'capped' ? 'Turn cap reached' : 'Paused: usage limit');
      await row(run, 'status', run.statusReason);
      await save(run);
      return { stop: true };
    }
    if (result.status === 'cancelled') {
      if (sig.aborted || cancelling.has(run.id)) return { stop: true };
      st.status = 'interrupted';
      run.status = 'interrupted';
      run.statusReason = `${s.label} was stopped from outside the app.`;
      await row(run, 'status', run.statusReason);
      await save(run);
      return { stop: true };
    }
    st.status = 'failed';
    run.error = { message: failReason(result, s), at: iso() };
    await endRun(run, 'failed', run.error.message);
    return { stop: true };
  }

  // Keeps a stage output in run.json (run.outputs) and, for answers, reviews, diagnoses and
  // triage, in final/. Returns '' or why the output can't be used.
  async function storeOutput(run, s, output, result, { profile }) {
    if (s.id === 'scope') {
      if (!asList(output.slices).length) return 'Scope returned no slices.';
      run.outputs.scope = output;
      const files = unique([...asList(output.files).map(pathOf), ...asList(output.slices).flatMap(x => asList(x.files))]);
      const unknown = new Set(asList(result.paths && result.paths.unknown).map(p => outputRelPath(p, run.isolation.tree)));
      run.newFiles = files.filter(p => unknown.has(p));
      applyRisk(run, riskOf(profile, files));
      return '';
    }
    if (s.id === 'investigate') {
      if (!asList(output.hypotheses).length) return 'Investigate returned no hypotheses.';
      run.outputs.investigate = output;
      await writeFinal(run, 'diagnosis.json', output);
      return '';
    }
    if (s.id === 'review') {
      const review = { version: 1, verdict: output.verdict, notProven: asList(output.notProven), verified: false, stage: s.id, at: iso(),
        findings: asList(output.findings).map((f, n) => ({ ...f, id: `F${n + 1}`, source: 'review' })) };
      run.outputs.review = review;
      delete run.outputs.verify;
      await writeFinal(run, 'review.json', review);
      return '';
    }
    if (s.id === 'verify') {
      const merged = mergeVerify(run.outputs.review || { findings: [], verdict: output.verdict }, output);
      run.outputs.review = merged;
      run.outputs.verify = { verdict: output.verdict, count: asList(output.findings).length };
      await writeFinal(run, 'review.json', merged);
      return '';
    }
    if (s.id === 'triage') {
      let refs = new Set();
      try { refs = new Set(asList(JSON.parse(await readFile(join(runDir(run), 'inputs', 'candidates.json'), 'utf8'))).map(c => c.ref)); } catch { refs = new Set(); }
      output.items = asList(output.items).map(it => ({ ...it, known: refs.has(it.ref) }));
      await writeFinal(run, 'triage.json', output);
    }
    if (s.id === 'answer') await writeFinal(run, 'answer.json', output);
    if (s.id === 'prove' && !asList(output.tests).length) return 'Prove returned no tests.';
    run.outputs[s.id] = output;
    return '';
  }

  // ---------- Actions

  // Applies one click. Checks it against allowedActions (400 with the reason) and returns
  // { ok, message, run }. It never advances the run: when the status is 'running' afterwards,
  // the caller (the manager) schedules advance.
  async function handle(run, action, payload = {}) {
    const p = def(run);
    ensureStages(run, p);
    payload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const ctx = { running: loops.has(run.id), trusted: await trustedFor(run) };
    const a = allowedActions(run, p, ctx).find(x => x.action === action);
    if (!a || !ACTIONS[action]) httpFail(400, `There is no action called ${String(action).slice(0, 40)}.`);
    if (!a.enabled) httpFail(400, a.reason);
    const out = await ACTIONS[action](run, p, payload);
    return typeof out === 'string' ? { ok: true, message: out, run } : { ok: true, ...out, run };
  }

  async function trustedFor(run) {
    if (typeof d.trustFor === 'function') { try { return await d.trustFor(run); } catch { return undefined; } }
    if (typeof d.trustState !== 'function') return undefined;
    try {
      const where = (run.isolation && run.isolation.mainDir) || (d.mainDirFor ? await d.mainDirFor(run.project) : '');
      if (!where) return undefined;
      const t = await d.trustState(where);
      return t && t.state === 'trusted' ? true : t && t.state === 'not-trusted' ? false : undefined;
    } catch { return undefined; }
  }

  // Marks the waiting human stage done and clears `waiting`.
  function passGate(run) {
    const i = currentIndex(run);
    run.stages[i].status = 'done';
    run.stages[i].endedAt = iso();
    run.waiting = null;
    run.status = 'running';
    run.statusReason = '';
    return i;
  }
  // The edit stage a fix or send back goes to: prove when Gate B is red, otherwise implement.
  const editTarget = run => {
    const st = run.stages[currentIndex(run)] || {};
    return run.status === 'gates-red' && st.id === 'gate-b' ? 'prove' : 'implement';
  };
  const proceed = run => { run.status = 'running'; run.waiting = null; run.error = null; run.statusReason = ''; };

  const ACTIONS = {
    async approve(run, p, payload) {
      const kind = run.waiting.kind;
      const { profile } = await context(run);
      const at = iso();
      if (kind === 'plan' || kind === 'spec') {
        const out = run.outputs.scope;
        const tick = await mustTickOf(profile, unique([...asList(out.files).map(pathOf), ...asList(out.slices).flatMap(x => asList(x.files))]));
        run.plan = buildPlan(out, payload, { schema: kind === 'spec' ? 'spec.v1' : 'plan.v1', at, mustTickFor: files => tick.filter(f => files.includes(f)) });
        applyRisk(run, riskOf(profile, run.plan.files));
      } else if (kind === 'hypothesis') {
        const diag = run.outputs.investigate;
        const tick = await mustTickOf(profile, unique(asList(diag.hypotheses).flatMap(h => evidencePaths(h.evidence))));
        run.plan = buildHypothesisPlan(diag, payload, { at, mustTickFor: files => tick.filter(f => files.includes(f)) });
        applyRisk(run, riskOf(profile, run.plan.files));
      }
      passGate(run);
      const what = kind === 'review' ? 'the change' : `the ${kind}${run.plan ? ` (${kind === 'hypothesis' ? 'hypothesis' : 'slice'} ${run.plan.slice + 1}, ${plural(run.plan.files.length, 'file')})` : ''}`;
      await row(run, 'you', `You approved ${what}.`);
      await save(run);
      return kind === 'review' ? 'Approved. The commit gate is next.' : `Approved the ${kind}.`;
    },

    async revise(run, p, payload) {
      const notes = cleanNotes(payload.notes);
      if (!notes) httpFail(400, 'Say what should change first.');
      const i = currentIndex(run);
      const target = p.stages.slice(0, i).map((s, n) => [s, n]).reverse().find(([s, n]) => s.kind === 'claude' && run.stages[n].status === 'done');
      if (!target) httpFail(400, 'There is no earlier Claude stage to revise.');
      reopenFrom(run, target[0].id, { mode: 'resume', reason: 'revise', notes });
      proceed(run);
      await row(run, 'you', `You asked ${target[0].label} to revise.`);
      await save(run);
      return `Sent your notes to ${target[0].label}.`;
    },

    async allow(run, p, payload) {
      const offered = asList(run.waiting.detail && run.waiting.detail.paths);
      const paths = payload.paths === undefined ? offered : pickPaths(payload.paths, offered, 'waiting at the fence gate');
      if (!paths.length) httpFail(400, 'Pick at least one file to allow.');
      const at = iso();
      const have = new Set(run.allowances.map(a => a.path));
      for (const path of paths) if (!have.has(path)) run.allowances.push({ path, at, stage: 'checks', reason: 'allowed at the fence gate' });
      reopenFrom(run, 'checks');
      proceed(run);
      await row(run, 'you', `You allowed ${plural(paths.length, 'file')} outside the plan for this run.`);
      await save(run);
      return `Allowed ${plural(paths.length, 'file')}. The checks run again.`;
    },

    async sendback(run, p, payload) {
      const note = cleanNotes(payload.note || payload.notes);
      if (!note) httpFail(400, 'Write a note for Claude first.');
      const fence = run.waiting && run.waiting.kind === 'fence';
      const leaveOut = fence ? pickPaths(payload.leaveOut, asList(run.waiting.detail.paths), 'waiting at the fence gate') : [];
      const text = leaveOut.length ? `${note}\n\nLeave these files unchanged (undo your edits to them): ${leaveOut.join(', ')}` : note;
      const target = editTarget(run);
      reopenFrom(run, target, { mode: 'resume', reason: 'sendback', notes: text });
      proceed(run);
      await row(run, 'you', `You sent the change back to ${target}.`);
      await save(run);
      return `Sent back to ${target}.`;
    },

    async fix(run, p, payload) {
      let next;
      if (run.waiting && run.waiting.kind === 'review') {
        const all = asList(run.outputs.review && run.outputs.review.findings);
        const ids = unique(asList(payload.findings).map(String));
        const picked = all.filter(f => ids.includes(f.id));
        if (!picked.length) httpFail(400, 'Send back is off: tick at least one finding first.');
        if (picked.length !== ids.length) httpFail(400, 'A ticked finding is not in this review.');
        next = { mode: 'resume', reason: 'user-fix', findings: picked.map(({ id, severity, rule, path, line, claim, evidence, suggestion }) => ({ id, severity, rule, path, line, claim, evidence, suggestion })) };
      } else {
        const gs = await readJsonFile(join(runDir(run), 'inputs', 'gate-summary.json'), null) || { problems: [run.statusReason] };
        next = editTarget(run) === 'prove' ? { mode: 'resume', reason: 'prove-fix', gateSummary: gs } : { mode: 'resume', reason: 'auto-fix', gateSummary: gs };
      }
      run.fixRounds.user += 1;
      const target = next.reason === 'prove-fix' ? 'prove' : 'implement';
      reopenFrom(run, target, next);
      proceed(run);
      await row(run, 'you', `You started fix round ${run.fixRounds.user} of ${run.fixRounds.maxUser}${next.findings ? ` with ${plural(next.findings.length, 'finding')}` : ''}.`);
      await save(run);
      return `Fix round ${run.fixRounds.user} started.`;
    },

    async commit(run, p, payload) {
      const { profile } = await context(run);
      const message = String(payload.message || '').replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
      if (!message) httpFail(400, 'The commit message is empty.');
      if (message.length > MESSAGE_MAX) httpFail(400, `The commit message is longer than ${MESSAGE_MAX} characters.`);
      const gated = run.gatedTree;
      const gatedFiles = [...gated.files].sort();
      if (payload.files !== undefined) {
        const files = unique(asList(payload.files).map(x => gitRelPath(x))).sort();
        if (files.join('\n') !== gatedFiles.join('\n')) httpFail(400, 'The file list differs from the files the gates checked.');
      }
      if (payload.treeSha !== undefined && payload.treeSha !== gated.treeSha) httpFail(409, 'The gates ran again since you opened the dialog; reload the review.');
      const { tree, mainDir } = run.isolation;
      const base = run.base.sha;
      const changedNow = treeFiles(await changedOf(tree, base));
      const shaNow = await dep('git.treeHash')(tree, base, gated.files, join(runDir(run), 'tmp', `index-commit-${now()}`));
      if (shaNow !== gated.treeSha || changedNow.join('\n') !== gatedFiles.join('\n')) return treeMoved(run);
      const messageFile = finalFile(run, 'commit-msg.txt');
      await writeFinal(run, 'commit-msg.txt', `${message}\n`);
      const existing = asList(await dep('git.appBranches')(mainDir, { prefix: (profile.git || {}).branchPrefix || 'app/' })).map(b => (typeof b === 'string' ? b : b.name));
      const branch = dep('worktree.branchName')(await branchText(run), new Date(now()), existing);
      let r;
      try {
        // In branch mode the commit gate needs this run's own branch mode record (viaRecord).
        r = await dep('worktree.commitInTree')({ tree, base, branch, files: gated.files, messageFile, gatedTreeSha: gated.treeSha, runId: run.id });
      } catch (e) {
        if (e.status === 409 || e.code === 'TREE_CHANGED') return treeMoved(run);
        await row(run, 'error', e.message);
        httpFail(409, e.message);
      }
      const hookChanged = asList(r.hookChanged).map(pathOf);
      run.commit = { sha: r.sha, branch, at: iso(), hookChanged, stashDelta: r.stashDelta || 0 };
      run.branch = branch;
      const gate = run.stages.findIndex(x => x.id === 'review-gate');
      if (gate >= 0 && run.stages[gate].status !== 'done') Object.assign(run.stages[gate], { status: 'done', endedAt: iso() });
      const ci = run.stages.findIndex(x => x.id === 'commit');
      Object.assign(run.stages[ci], { status: 'done', endedAt: iso(), meta: `${sha7(r.sha)} on ${branch}` });
      await leftoverAfterCommit(run, r);
      const proof = await readJsonFile(finalFile(run, 'proof.json'), null);
      if (proof) {
        proof.branch = branch;
        proof.treeHash = { ...proof.treeHash, atCommit: r.treeSha || null, match: hookChanged.length === 0 };
        await writeFinal(run, 'proof.json', proof);
        await writeFinal(run, 'proof.md', proofMarkdown(proof));
      }
      await moveFinding(run, 'on-branch', { branch, commit: r.sha, reason: `committed on ${branch}` });
      await recordWins(run, r.sha, branch);
      const hookNote = hookChanged.length ? ` The hook changed ${hookChanged.join(', ')}.` : ' The hook changed nothing.';
      const stashNote = r.stashDelta ? ' The pre-commit hook left a stash entry; the app did not touch it.' : '';
      const leftNote = run.leftoverPatch ? ` Uncommitted changes the hook left are in ${run.leftoverPatch}.` : '';
      const text = `Committed ${sha7(r.sha)} on ${branch}. Not pushed.${hookNote}${stashNote}${leftNote}`;
      await endRun(run, 'committed', text);
      return text;
    },

    async stop(run) {
      const out = await cancelPath(run, 'stopped by you');
      if (out.run.status !== 'cancelled') return out.message;
      return out.run.patch ? 'Stopped. Your changes are in final/stopped.patch and the tree is reset.' : 'Stopped. There were no changes to keep, and the tree is reset.';
    },
    async cancel(run) {
      return (await cancelPath(run, 'cancelled by you')).message;
    },

    async retry(run, p) {
      let i = currentIndex(run);
      const preIndex = p.stages.findIndex(s => s.kind === 'gate');
      if (run.pipeline === 'check' && !run.treeReady && i > 0) i = reopenFrom(run, p.stages[0].id);
      else if (p.editing && run.base && run.base.sha && !run.treeReady && i > preIndex) await restoreTree(run);
      else if ((p.editing || p.id === 'setup-worktree') && !run.lockHeld) await acquireLock(run);
      run.stages[i].status = 'pending';
      run.stages[i].next = { mode: 'fresh', reason: 'retry' };
      proceed(run);
      if (run.pipeline === 'fix') await moveFinding(run, 'in-run', { reason: 'retried' });
      await row(run, 'you', `You retried ${p.stages[i].label}.`);
      await save(run);
      return `Retrying ${p.stages[i].label}.`;
    },

    async resume(run, p) {
      const i = currentIndex(run);
      const st = run.stages[i];
      const bonus = st.status === 'capped' && !st.bonusUsed ? catalogModule.RESUME_BONUS_TURNS : 0;
      if (bonus) st.bonusUsed = true;
      if (p.editing && run.base && run.base.sha && !run.treeReady) await restoreTree(run);
      else if (p.editing && !run.lockHeld) await acquireLock(run);
      st.status = 'pending';
      st.next = { mode: 'resume', reason: 'resume', bonusTurns: bonus };
      proceed(run);
      await row(run, 'you', `You resumed ${p.stages[i].label}${bonus ? ` with ${bonus} more turns` : ''}.`);
      await save(run);
      return `Resuming ${p.stages[i].label}.`;
    },

    async takeover(run, p) {
      const idx = takeoverStageIndex(run, p);
      const s = p.stages[idx];
      const st = run.stages[idx];
      const sid = lastSessionId(run, idx);
      const att = [...st.attempts].reverse().find(a => a.sessionId === sid) || {};
      const unpinnable = isUnpinnableEnd(run, p);
      // Everything that can refuse comes before restoreTree, which takes the lock and the tree of
      // an ended run: after it, only a terminal that fails to open needs undoing (below).
      const startClaude = optFn('startClaude', 'launcher.startClaude', 'actions.startClaude');
      if (!startClaude) httpFail(500, 'The executor was started without startClaude, so it cannot open a terminal.');
      const stageDir = join(runDir(run), ...String(att.folder || stageRel(idx, s.id, 1)).split('/'));
      const mode = s.profile === 'EDIT' ? 'acceptEdits' : 'manual';
      const base = await readJsonFile(join(stageDir, 'settings.json'), null);
      if (!base) httpFail(409, `The settings of ${s.label} are missing, so it can't be taken over.`);
      const settingsFile = join(stageDir, 'settings.takeover.json');
      await writeJsonFile(settingsFile, dep('claudeSettings.takeoverSettings')(base));
      if (unpinnable) await restoreTree(run);
      const dir = run.isolation.tree || att.cwd;
      try {
        await startClaude({ dir, title: `${run.title || run.id} (take over)`, resume: sid, launch: { permissionMode: mode, settingsFile }, kind: 'takeover', project: run.project });
      } catch (e) {
        if (unpinnable) { await tidyTree(run, { patch: false }); await releaseLock(run); await save(run); }
        httpFail(409, `The terminal did not open: ${e.message}`);
      }
      run.takeover = { stage: s.id, index: idx, sessionId: sid, since: iso(), mode, settingsFile, from: { status: run.status, waiting: run.waiting }, unpinnable };
      run.status = 'in-terminal';
      run.waiting = null;
      await row(run, 'you', `You took over ${s.label} in a terminal.`);
      await save(run);
      return `${s.label} is open in a terminal. Close it, then use Back to app.`;
    },

    async back(run, p) {
      const t = run.takeover || {};
      if (t.unpinnable && (await tidyTree(run, { patch: true })).kept) {
        await save(run);
        httpFail(409, `Still in the terminal. ${keptText(run)}; close programs that use it, then use Back to app again.`);
      }
      run.takeovers = [...asList(run.takeovers), { ...t, endedAt: iso() }];
      run.takeover = null;
      if (t.unpinnable) {
        await releaseLock(run);
        run.status = 'passed';
        await row(run, 'you', 'You came back from the terminal.');
        await save(run);
        return run.patch ? 'Back in the app. Your changes from the terminal are in final/stopped.patch.' : 'Back in the app. The terminal changed nothing.';
      }
      const s = p.stages[t.index];
      if (!s) httpFail(400, 'The taken-over stage is not in this run.');
      if (s.id === 'prove' || s.id === 'implement') run.outputs[s.id] = run.outputs[s.id] || await outputFromTree(run, s.id);
      if (run.outputs[s.id] || s.id === 'review' || s.id === 'verify') {
        reopenFrom(run, s.id);
        run.stages[t.index].status = 'done';
      } else {
        reopenFrom(run, s.id, { mode: 'fresh', reason: 'after take over' });
      }
      proceed(run);
      await row(run, 'you', `You came back from the terminal; ${s.label} counts as done and the next gate runs again.`);
      await save(run);
      return 'Back in the app. The next gate runs again.';
    },

    async park(run) {
      const waiting = run.waiting;
      const index = currentIndex(run);
      if ((await tidyTree(run, { patch: true })).kept) {
        await save(run);
        httpFail(409, `Not parked. ${keptText(run)}; close programs that use it, then try again.`);
      }
      await releaseLock(run);
      run.parked = { at: iso(), waiting, index, patch: run.patch || '', gatedTreeSha: (run.gatedTree || {}).treeSha || '' };
      run.status = 'parked';
      run.waiting = null;
      await row(run, 'you', `You parked the run.${run.patch ? ' Its changes are in final/stopped.patch.' : ''}`);
      await save(run);
      return 'Parked. The lock is free.';
    },

    async unpark(run) {
      await restoreTree(run);
      const parked = run.parked || {};
      run.parked = null;
      if (parked.gatedTreeSha && run.gatedTree) {
        const sha = await dep('git.treeHash')(run.isolation.tree, run.base.sha, run.gatedTree.files, join(runDir(run), 'tmp', `index-unpark-${now()}`));
        if (sha !== parked.gatedTreeSha) {
          reopenFrom(run, 'checks');
          proceed(run);
          await row(run, 'you', 'You resumed the parked run; the tree differs from the gated one, so the checks run again.');
          await save(run);
          return 'Resumed. The checks run again.';
        }
      }
      if (parked.waiting) {
        run.status = 'waiting';
        run.waiting = { ...parked.waiting, since: iso() };
      } else proceed(run);
      await row(run, 'you', 'You resumed the parked run.');
      await save(run);
      return 'Resumed at the same gate.';
    },

    async triage(run, p, payload) {
      const decisions = asList(payload.decisions);
      if (!decisions.length) httpFail(400, 'There are no triage decisions.');
      const isReview = run.waiting.kind === 'triage';
      const allowed = isReview ? ['fix', 'dismiss', 'keep'] : ['accept', 'dismiss', 'keep'];
      const items = isReview ? asList(run.outputs.review && run.outputs.review.findings) : asList(run.outputs.triage && run.outputs.triage.items);
      const at = iso();
      for (const x of decisions) {
        const ref = String((x && x.ref) || '');
        const item = isReview ? items.find(f => f.id === ref) : items.find(f => String(f.ref) === ref);
        if (!item) httpFail(400, `${ref.slice(0, 40) || 'An item'} is not in this ${isReview ? 'review' : 'triage'}.`);
        if (!allowed.includes(x.decision)) httpFail(400, `Pick one of ${allowed.join(', ')} for ${ref}.`);
        const reason = String(x.reason || '').replace(/\s+/g, ' ').trim();
        if (x.decision === 'dismiss' && !reason) httpFail(400, `Say why you dismiss ${ref}.`);
        if (reason.length > 300) httpFail(400, 'A reason is longer than 300 characters.');
        item.triage = { decision: x.decision, reason, at };
      }
      if (isReview) await writeFinal(run, 'review.json', run.outputs.review);
      else await writeFinal(run, 'triage.json', run.outputs.triage);
      await row(run, 'you', `You triaged ${plural(decisions.length, 'item')}.`);
      await save(run);
      return `Saved ${plural(decisions.length, 'decision')}.`;
    },

    async done(run) {
      passGate(run);
      await row(run, 'you', 'You finished the triage.');
      await save(run);
      return 'Done.';
    },

    async report(run) {
      const { profile } = await context(run);
      const r = await dep('reports.saveRunReport')({ root: d.hubRoot, dataDir, run, profile, runTool: optFn('runTool', 'launcher.runTool') || undefined });
      await row(run, 'you', 'You saved the run as a report.');
      return { message: (r && (r.message || (r.file ? `Saved the report: ${r.file}` : ''))) || 'Saved the report.', report: r || null };
    },

    async 'next-slice'(run) {
      const next = run.plan.slice + 1;
      const startRun = optFn('startRun');
      if (!startRun) httpFail(500, 'The executor was started without startRun.');
      const r = await startRun({ project: run.project, pipeline: 'feature', values: run.values }, {
        parent: run.id, skip: ['scope', 'spec'],
        extra: { inherit: { spec: run.plan.output, slice: next, baseSha: run.commit.sha, branch: run.commit.branch, ticked: run.plan.ticked } },
      });
      await row(run, 'you', `You started slice ${next + 1}.`);
      return { message: `Started slice ${next + 1}.`, childRunId: (r && (r.runId || (r.run && r.run.id) || r.id)) || null };
    },
  };

  // The words the app/<mmdd>-<slug> branch name is made of: the request, or for a fix the
  // finding's title (its id alone has no words long enough).
  async function branchText(run) {
    const v = run.values || {};
    if (v.what) return v.what;
    if (v.finding && d.findings && typeof d.findings.loadFindings === 'function') {
      try {
        const f = asList(((await d.findings.loadFindings(dataDir, run.project)) || {}).findings).find(x => x.id === v.finding);
        if (f && f.title) return f.title;
      } catch { /* fall back to the title */ }
    }
    return run.title || 'change';
  }

  // The tree changed between the gates and the commit click: the checks run again (409).
  async function treeMoved(run) {
    reopenFrom(run, 'checks');
    proceed(run);
    await row(run, 'gate', 'Tree changed since gates ran. The checks run again.', { ok: false });
    await save(run);
    if (typeof d.schedule === 'function') { try { d.schedule(run.id); } catch { /* the caller retries */ } }
    httpFail(409, 'Tree changed since gates ran. The checks run again.');
  }

  // A hook that left uncommitted changes: they are kept in final/leftover.patch and the tree is
  // reset to the new commit, so the next run starts clean.
  async function leftoverAfterCommit(run, r) {
    if (!asList(r.leftover).length) return;
    const { profile } = await context(run);
    try {
      await dep('worktree.savePatch')(run.isolation.tree, r.sha, finalFile(run, 'leftover.patch'), { exclude: secretExcludes(profile) });
      run.leftoverPatch = 'final/leftover.patch';
      await dep('worktree.resetTree')(run.isolation.tree, r.sha, mainCheckoutOpts(run));
    } catch (e) { await row(run, 'error', `The hook left changes that could not be set aside: ${e.message}`); }
  }

  async function outputFromTree(run, stageId) {
    const { profile } = await context(run);
    const changed = await changedOf(run.isolation.tree, run.base.sha);
    if (stageId === 'prove') {
      const testRe = testRegex(profile);
      return { tests: changed.filter(c => testRe.test(c.path)).map(c => ({ path: c.path, name: '', proves: 'written in Take over' })), notes: 'Written in Take over.' };
    }
    return { changes: changed.map(c => ({ path: c.path, what: 'changed in Take over' })), recordPath: '', commitMessage: run.title || '',
      notProven: ['Changes made in Take over were not described by the implement stage.'] };
  }

  async function recordWins(run, sha, branch) {
    try {
      const wins = winsFromMetricRows(run.metricRows, { kind: 'commit', sha, branch, runId: run.id }, iso());
      const append = optFn('probes.appendWins');
      if (wins.length && append) await append(dataDir, run.project, wins);
    } catch (e) { await row(run, 'info', `Wins were not recorded: ${e.message}`); }
  }

  // Cancel or stop: kill, keep the patch when the run owns a tree, reset, release, cancelled.
  // The manager has already aborted the driver and stopped the registered processes; this also
  // works on its own (then it aborts and waits up to 10 s for the loop). When the patch can't be
  // saved nothing is reset and the run is not cancelled: a run that waited for you still waits,
  // and one whose stage was running is interrupted, both with the tree and the lock kept.
  async function cancelPath(run, reason = 'cancelled by you') {
    cancelling.add(run.id);
    try {
      const c = controllers.get(run.id);
      if (c) c.abort();
      const pending = loops.get(run.id);
      if (pending) await Promise.race([pending.catch(() => {}), sleep(CANCEL_WAIT_MS)]);
      const p = def(run);
      ensureStages(run, p);
      const lastOf = st => asList(st.attempts)[asList(st.attempts).length - 1];
      for (const st of run.stages) {
        const last = lastOf(st);
        if (st.status === 'running' && last && last.proc && d.proc && typeof d.proc.safeKill === 'function') {
          try { await d.proc.safeKill(last.proc); } catch { /* already gone */ }
        }
      }
      // After the kills, so no stage writes into the tree while its patch is saved.
      const { kept } = await tidyTree(run, { patch: p.editing });
      const stageEnd = kept ? { running: 'interrupted' } : { running: 'cancelled', waiting: 'cancelled' };
      let stopped = false;
      for (const st of run.stages) {
        const last = lastOf(st);
        if (stageEnd[st.status]) { stopped = stopped || st.status === 'running'; st.status = stageEnd[st.status]; st.endedAt = iso(); }
        if (last && last.status === 'running') last.status = stageEnd.running;
      }
      if (kept) {
        if (stopped || run.status === 'running') {
          run.status = 'interrupted';
          run.statusReason = `${reason}, but ${keptText(run).replace(/^The/, 'the')}`;
          run.waiting = null;
          await row(run, 'status', `Run interrupted: ${run.statusReason}`);
        }
        await save(run);
        return { message: `Not cancelled. ${keptText(run)}; close programs that use it, then try again.`, run };
      }
      await releaseLock(run);
      await moveFinding(run, 'open', { reason });
      run.status = 'cancelled';
      run.statusReason = reason;
      run.waiting = null;
      run.endedAt = iso();
      await row(run, 'status', `Run cancelled: ${reason}`);
      await save(run);
      const saved = run.patch ? ' Your changes are in final/stopped.patch.' : '';
      return { message: `Cancelled.${saved}`, run };
    } finally { cancelling.delete(run.id); }
  }

  // ---------- Preview (the launcher, before a start)

  // What the launcher shows for a draft from the manager ({project, def, values, level, riskTags,
  // profile, settings, isolationMode, ...}): { prompt, where, refusals, estimate, treeMode,
  // stages }. Writes nothing.
  async function preview(draft) {
    if (!draft || draft.error || !draft.profile) return {};
    const p = draft.def || d.catalog.pipelineById(draft.pipeline);
    const profile = draft.profile;
    const out = { refusals: [], estimate: p.expected || null };
    const mainDir = d.mainDirFor ? await d.mainDirFor(draft.project) : '';
    if (!mainDir) return { ...out, refusals: [`The checkout of ${draft.project} was not found; link it in Projects first.`] };
    const mode = draft.isolationMode || isolationMode(draft.project, profile, draft.settings);
    const need = (p.requires || {}).isolation || 'none';
    const prefix = (profile.git || {}).branchPrefix || 'app/';
    const mmdd = (() => { const t = new Date(now()); return `${pad2(t.getMonth() + 1)}${pad2(t.getDate())}`; })();
    if (need === 'tree' && mode === 'worktree') {
      const ws = await optStatus(profile, mainDir);
      out.treeMode = 'run';
      if (!ws || ws.state !== 'ready') out.refusals.push(`This run needs the run worktree: ${(ws && ws.text) || 'it is not set up yet.'} Set it up in the cockpit first.`);
      out.where = `the ${(ws && ws.name) || 'run'} worktree${ws && ws.state === 'ready' ? ` (idle at ${sha7(ws.head)})` : ''}, on a new branch ${prefix}${mmdd}-…`;
    } else if (need === 'tree') {
      out.treeMode = 'main';
      const check = optFn('worktree.branchModeCheck');
      if (check) {
        try { const r = await check({ profile, mainDir }); if (r && r.ok === false) out.refusals.push(r.reason); } catch (e) { out.refusals.push(e.message); }
      }
      out.where = `your main checkout, on a new branch ${prefix}${mmdd}-… (branch mode)`;
    } else if (need === 'main-ok') {
      const ws = mode === 'worktree' ? await optStatus(profile, mainDir) : null;
      if (ws && ws.state === 'ready') {
        out.treeMode = 'run';
        out.where = `the ${ws.name} worktree, with your changes copied in`;
      } else {
        out.treeMode = 'main';
        out.where = 'your main checkout (no baseline there, so every failure counts as new)';
        const refusal = await mainRefusal(profile, mainDir);
        if (refusal) out.refusals.push(refusal);
      }
    } else if (p.id === 'setup-worktree') {
      out.treeMode = 'main';
      out.where = `a new run worktree at ${(profile.isolation || {}).worktreePath || 'the profile path'}, made from your checkout (which stays as it is)`;
    } else {
      out.treeMode = 'main';
      out.where = 'read-only in the main checkout, no lock needed';
    }
    const pseudo = { id: 'preview', project: draft.project, pipeline: p.id, values: draft.values || {}, level: draft.level, riskTags: draft.riskTags || [],
      levelReason: draft.levelReason || [], outputs: {}, pins: [], redTests: [], stages: [] };
    const ui = d.catalog.pipelineForUi(p.id, { profile, settings: draft.settings || {}, run: pseudo });
    if (ui) out.stages = ui.stages;
    // The first Claude stage's prompt, when it always runs (a conditional stage like the
    // architecture triage depends on what the scan finds).
    const first = p.stages.find(s => s.kind === 'claude');
    if (first && !first.when) {
      try {
        const base = need === 'tree' ? await revParse(mainDir, profile.git.integrationBranch) : await revParse(mainDir, 'HEAD');
        pseudo.base = { sha: base };
        const vars = await buildVars(pseudo, first, { profile, cwd: mainDir, edit: first.profile === 'EDIT', preview: true });
        const { pipeline, stage } = promptName(first);
        out.prompt = d.prompts.renderPrompt(await d.prompts.loadPrompt(d.hubRoot, pipeline, stage), vars);
      } catch (e) { out.prompt = `(The prompt could not be built: ${e.message})`; }
    }
    return out;
  }
  async function optStatus(profile, mainDir) {
    const fn = optFn('worktree.worktreeStatus');
    if (!fn) return null;
    try { return await fn({ profile, mainDir, dataDir }); } catch (e) { return { state: 'failed', text: e.message, name: 'the run worktree' }; }
  }
  async function mainRefusal(profile, mainDir) {
    const fn = optFn('checks.mainCheckoutRefusal');
    if (!fn) return '';
    let guardContent = null;
    const guard = profile.mainCheckoutGuard;
    if (guard && guard.file) {
      try { guardContent = await dep('git.fileAt')(mainDir, 'HEAD', guard.file); } catch { guardContent = null; }
    }
    try { return fn({ profile, tree: mainDir, treeMode: 'main', guardContent }) || ''; } catch (e) { return e.message; }
  }

  // ---------- For tests and shutdown

  const wait = id => loops.get(id) || Promise.resolve();
  const abort = id => { const c = controllers.get(id); if (c) c.abort(); return !!c; };
  const isActive = id => loops.has(id);

  return { advance, handle, cancelPath, preview, wait, abort, isActive };
}

const defaultCheckPath = () => fileURLToPath(new URL('../gates/check.mjs', import.meta.url));

// Every dependency function createExecutor may call, by dotted name: what defaultDeps (or any
// other wiring) must provide. The manager adds ENGINE_DEPS; LAUNCH_DEPS come from the app's
// launcher (ctx.actions) and are needed only for Take over and Save as report.
export const DEP_FUNCTIONS = Object.freeze([
  'store.saveRun', 'store.appendTimeline', 'store.writeInput', 'store.verifyInputs', 'store.runDir',
  'locks.acquire', 'locks.release',
  'claudeStage.runClaudeStage', 'claudeStage.claudeEnv',
  'claudeSettings.stageSettings', 'claudeSettings.guardConfig', 'claudeSettings.takeoverSettings', 'shim.writeShim',
  'checks.runChecks', 'checks.planChecks', 'checks.listeningPorts', 'checks.runCommand', 'checks.mainCheckoutRefusal', 'g0.runG0',
  'stagegates.gateB', 'stagegates.pinsIntact', 'stagegates.redNowPasses', 'stagegates.denialTestPresent',
  'fences.mustTickFiles', 'fences.editableInStage',
  'worktree.worktreeStatus', 'worktree.setupWorktree', 'worktree.prepareRunTree', 'worktree.applyChanges', 'worktree.savePatch',
  'worktree.applyPatch', 'worktree.resetTree', 'worktree.commitInTree', 'worktree.branchModeCheck', 'worktree.prepareBranchMode',
  'worktree.finishBranchMode', 'worktree.branchName',
  'git.git', 'git.changedFiles', 'git.diffText', 'git.diffNames', 'git.fileAt', 'git.treeHash', 'git.appBranches',
  'probes.scan', 'probes.recordScan', 'probes.loadMetrics', 'probes.loadDetails', 'probes.newCandidates', 'probes.appendWins',
  'baseline.baselineKey', 'baseline.loadBaseline',
  'findings.loadFindings', 'findings.saveFindings', 'findings.updateFindings', 'findings.setStatus',
  'reports.saveRunReport', 'profileLib.workspaceOf', 'riskTags', 'redact', 'redactDeep', 'trustState', 'getSettings', 'profileFor', 'mainDirFor',
]);
export const ENGINE_DEPS = Object.freeze(['slots.claude.acquire', 'slots.checks.acquire', 'register', 'unregister', 'schedule', 'startRun', 'signals.emit']);
export const LAUNCH_DEPS = Object.freeze(['startClaude', 'runTool']);

// The real modules, mapped to the dependency names createExecutor uses. The manager adds store,
// slots, signals, register, unregister, schedule, startRun and holder; the app adds
// claudeCommand, startClaude and runTool. Loaded lazily so tests of this file never need them.
export async function defaultDeps({ hubRoot, dataDir, ...overrides } = {}) {
  const imp = rel => import(new URL(rel, import.meta.url).href);
  const [git, worktree, claudeStage, claudeSettings, argv, shim, check, commands, g0, stagegates, fences, baseline, secrets,
    scan, metrics, profile, trust, findings, report, store, locks, proc, settings, projects] = await Promise.all([
    imp('../core/git.mjs'), imp('./worktree.mjs'), imp('./claude-stage.mjs'), imp('./settings.mjs'), imp('./argv.mjs'), imp('../gates/shim.mjs'),
    imp('../gates/check.mjs'), imp('../gates/commands.mjs'), imp('../gates/g0.mjs'), imp('../gates/stagegates.mjs'), imp('../gates/fences.mjs'),
    imp('../gates/baseline.mjs'), imp('../gates/secrets.mjs'), imp('../probes/scan.mjs'), imp('../probes/metrics.mjs'), imp('../profile/profile.mjs'),
    imp('../profile/trust.mjs'), imp('../findings/store.mjs'), imp('./report.mjs'), imp('./store.mjs'), imp('./locks.mjs'), imp('../core/proc.mjs'),
    imp('../core/settings.mjs'), imp('../../lib/projects.mjs'),
  ]);
  return {
    hubRoot, dataDir, git, worktree, claudeStage, claudeSettings, argv, shim, g0, stagegates, fences, baseline, findings, reports: report, store, locks, proc,
    checks: { runChecks: check.runChecks, mainCheckoutRefusal: check.mainCheckoutRefusal, listeningPorts: check.listeningPorts, planChecks: commands.planChecks,
      runCommand: commands.runCommand },
    probes: { scan: scan.scan, recordScan: metrics.recordScan, loadMetrics: metrics.loadMetrics, loadDetails: metrics.loadDetails,
      newCandidates: metrics.newCandidates, detectWins: metrics.detectWins, appendWins: metrics.appendWins },
    profileLib: profile, riskTags: profile.riskTags,
    redact: text => secrets.redact(text), redactDeep: (value, opts) => secrets.redactDeep(value, opts),
    trustState: path => trust.trustState(path),
    getSettings: () => settings.loadSettings(dataDir),
    profileFor: project => profile.loadProfile(dataDir, project),
    mainDirFor: name => projects.realProjectDir(hubRoot, name),
    holder: proc.selfRecord(), nodePath: process.execPath, checkPath: defaultCheckPath(),
    ...overrides,
  };
}

// proof.json as a Markdown table, for final/proof.md and reports.
export function proofMarkdown(p) {
  const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `# Proof: ${cell(p.pipeline)} run ${cell(p.runId)}`, '',
    '| Item | Value |', '|---|---|',
    `| Base | ${cell(p.base && p.base.branch)} ${cell(sha7(p.base && p.base.sha))} |`,
    `| Branch | ${cell(p.branch || 'not committed yet')} |`,
    `| Tree | ${cell(p.tree)} |`,
    `| Level | ${cell(p.level)}${asList(p.levelReason).length ? ` (${cell(asList(p.levelReason).join('; '))})` : ''} |`,
    `| Baseline | ${cell(p.baseline.new)} new, ${cell(p.baseline.known)} known, ${cell(p.baseline.flaky)} flaky |`,
    `| Pins | ${p.pins.before.length ? `${p.pins.identical ? 'identical' : 'changed'}, ${p.pins.green ? 'green' : 'red'}` : 'none'} |`,
    `| Scope | ${cell(p.scope.inPlan)} of ${cell(p.scope.total)} files in the plan${p.scope.allowedByUser.length ? `; allowed by you: ${cell(p.scope.allowedByUser.join(', '))}` : ''} |`,
    `| Existing tests changed | ${cell(p.existingTestsChanged.join(', ') || 'none')} |`,
    `| Tree hash | ${cell(sha7(p.treeHash.gated))}${p.treeHash.match === null ? '' : p.treeHash.match ? ', matches the commit' : ', the hook changed files'} |`,
    `| Versions | node ${cell(p.versions.node || '?')}, Claude Code ${cell(p.versions.claudeCode || '?')} |`,
    '', '| Check | Result | Took |', '|---|---|---|',
    ...p.checks.map(c => `| ${cell(c.label)} | ${cell(c.result)} | ${Math.round((c.durationMs || 0) / 1000)} s |`),
  ];
  if (p.notProven.length) lines.push('', '## Not proven', '', ...p.notProven.map(x => `- ${cell(x)}`));
  return `${lines.join('\n')}\n`;
}
