// Pipeline runs over HTTP (SPEC section 4): what the launcher can start, starting and previewing a
// run, the runs list, one run with its timeline and buttons, the review gate's data, one file's
// diff, the run's text files, and every button (approve, commit, cancel and the rest).
//
//   GET  /api/pipelines?project    the launcher's pipelines (stages, models, caps, cannot, fields,
//                                  disabledReason) and the intent box's routing rules
//   POST /api/runs                 { project, pipeline, values, preview } -> preview or { runId }
//   GET  /api/runs                 the runs index (latest line per run) with durationMs
//   GET  /api/run?id&since         the run (secrets redacted, with its buttons) and timeline rows
//   GET  /api/run-review?id        verdict, findings, notProven, proof, checks summary, files
//   GET  /api/run-diff?id&file     one file's part of the run's diff
//   GET  /api/run-file?id&name     a run file by name from a fixed list, or a gate check's log
//   POST /api/runs/<action>        { id, ...payload } -> manager.action
//
// Safety (R22): run ids and project names are checked by regex before anything else; run files are
// picked from a fixed list of names; a diff file or a gate log is only ever one the app's own
// listing names (the diff's file headers, the run's gates folder, the gate's summary.json), so no
// path from the page is joined. Everything sent is redacted (gates/secrets.mjs) and text is cut
// at 2 MB. The engine (ctx.getEngine) is asked for only inside handlers.
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, readJson } from '../http.mjs';
import { PROJECT_RE } from '../core/datadir.mjs';
import { loadSettings } from '../core/settings.mjs';
import { loadProfile, riskTags } from '../profile/profile.mjs';
import { loadFindings } from '../findings/store.mjs';
import { redact, redactDeep } from '../gates/secrets.mjs';
import * as store from '../runs/store.mjs';
import { pipelineById, pipelinesForUi } from '../runs/catalog.mjs';
import { routesForUi } from '../runs/intent.mjs';
import { ACTIONS } from '../runs/actions.mjs';

// The run id rule of SPEC section 4 (the same as runs/store.mjs RUN_ID_RE).
export const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
export const TEXT_MAX = 2 * 1024 * 1024;
// GET /api/run-file names and the run file each one reads (relative to the run folder).
export const RUN_FILES = Object.freeze({
  diff: ['final/diff.patch', 'inputs/diff.patch'],
  proof: ['final/proof.md'],
  review: ['final/review.json'],
  'commit-msg': ['final/commit-msg.txt'],
  'stopped-patch': ['final/stopped.patch'],
  answer: ['final/answer.json'],
  diagnosis: ['final/diagnosis.json'],
  triage: ['final/triage.json'],
  // The architecture scan's candidates ({ref, probe, path, line, text}) for the decide gate.
  candidates: ['inputs/candidates.json'],
});
const GATE_DIR_RE = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DIFF_FILE_MAX = 400;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = x => (Array.isArray(x) ? x : []);

// ---------- Checks on what the page sends

function runIdOrThrow(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) throw new HttpError(400, 'That is not a run id.');
  return id;
}

function projectOrThrow(project) {
  const s = String(project ?? '');
  if (!PROJECT_RE.test(s)) throw new HttpError(400, `"${s.slice(0, 40)}" is not a project name.`);
  return s;
}

function intParam(value, { name, min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d{1,9}$/.test(String(value))) throw new HttpError(400, `${name} must be a whole number.`);
  const n = Number(value);
  if (n < min || n > max) throw new HttpError(400, `${name} must be from ${min} to ${max}.`);
  return n;
}

// ---------- Reading run files

// The run, or 404. A run.json that can't be read is a 500 with the reason.
async function runOr404(dataDir, id) {
  let run;
  try { run = await store.findRun(dataDir, id); } catch (err) {
    throw new HttpError(500, `Run ${id} could not be read: ${err.message}`);
  }
  if (!run) throw new HttpError(404, `There is no run ${id}.`);
  return run;
}

// A file inside the run folder (relative posix parts, all from this module's constants or the
// app's own listings), read up to `max` bytes. null when it doesn't exist.
async function readCapped(file, max = TEXT_MAX) {
  let fh;
  try { fh = await open(file, 'r'); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = Math.min(st.size, max) + 1; // one more byte than allowed tells a cut file
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    return { text: buf.subarray(0, Math.min(bytesRead, max)).toString('utf8'), truncated: bytesRead > max };
  } finally {
    await fh.close();
  }
}

const runFile = (dataDir, run, rel) => join(store.runDir(dataDir, run), ...rel.split('/'));

async function readRunJson(dataDir, run, rel) {
  const r = await readCapped(runFile(dataDir, run, rel));
  if (!r || r.truncated) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

// The first of `rels` that exists, redacted and capped: { text, truncated, rel } or null.
async function firstText(dataDir, run, rels) {
  for (const rel of rels) {
    const r = await readCapped(runFile(dataDir, run, rel));
    if (r) return { text: redact(r.text), truncated: r.truncated, rel };
  }
  return null;
}

// ---------- The diff

// Splits a unified git diff into its files: [{ path, text, add, del }]. The path comes from the
// "+++ b/" line (or "--- a/" for a deletion, or the "diff --git" header for binary and rename-only
// parts), so only paths the diff itself names are ever offered.
export function splitDiff(diff) {
  const out = [];
  const parts = String(diff || '').split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '));
  for (const text of parts) {
    const lines = text.split('\n');
    const plus = lines.find(l => l.startsWith('+++ '));
    const minus = lines.find(l => l.startsWith('--- '));
    const strip = (l, pre) => l.slice(4).replace(/\t$/, '').replace(new RegExp(`^${pre}/`), '');
    let path = '';
    if (plus && !/^\+\+\+ \/dev\/null/.test(plus)) path = strip(plus, 'b');
    else if (minus && !/^--- \/dev\/null/.test(minus)) path = strip(minus, 'a');
    else {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
      path = m ? m[2] : '';
    }
    if (!path || path.length > DIFF_FILE_MAX) continue;
    let add = 0;
    let del = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    out.push({ path, text, add, del });
  }
  return out;
}

async function runDiff(dataDir, run) {
  const r = await firstText(dataDir, run, RUN_FILES.diff);
  return r ? { files: splitDiff(r.text), truncated: r.truncated } : { files: [], truncated: false };
}

// ---------- The run as the page sees it

const durationOf = (createdAt, endedAt, now = Date.now()) => {
  const start = Date.parse(createdAt || '');
  if (!Number.isFinite(start)) return null;
  const end = endedAt ? Date.parse(endedAt) : now;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
};

// The run without the app's internals (owner process, input hashes), secrets redacted, each stage
// with its label, who and goal from the pipeline, plus the buttons (allowedActions).
export function runView(run, actions = [], def = pipelineById(run.pipeline)) {
  const { owner, inputsHashes, ...rest } = run || {};
  const view = redactDeep(rest);
  const stageDefs = (def && def.stages) || [];
  view.stages = asList(view.stages).map((s, i) => {
    const sd = stageDefs[i] && stageDefs[i].id === s.id ? stageDefs[i] : stageDefs.find(x => x.id === s.id) || {};
    return { ...s, label: sd.label || s.id, who: sd.who || null, goal: sd.goal || '' };
  });
  view.pipelineLabel = def ? def.label : run.pipeline;
  view.durationMs = durationOf(run.createdAt, run.endedAt);
  view.actions = asList(actions);
  return view;
}

async function viewFor(manager, run) {
  if (!run) return null;
  return runView(run, await manager.actionsFor(run));
}

// The profile object of a project when it exists and is valid, else null, plus its problem text.
async function profileOf(dataDir, project) {
  try {
    const r = await loadProfile(dataDir, project);
    if (!r.exists) return { profile: null, problem: '' };
    if (!r.valid) {
      const n = r.errors.length;
      return { profile: null, problem: `The profile for ${project} has ${n} problem${n === 1 ? '' : 's'}; fix ${n === 1 ? 'it' : 'them'} in the cockpit setup first.` };
    }
    return { profile: r.profile, problem: '' };
  } catch (err) {
    return { profile: null, problem: `The profile for ${project} could not be read: ${err.message}` };
  }
}

// ---------- Routes

export function routes({ dataDir, getEngine }) {
  const engine = () => {
    if (typeof getEngine !== 'function') throw new HttpError(503, 'The run engine is not available in this app.');
    return getEngine();
  };

  const table = {
    'GET /api/pipelines': async (req, res, url) => {
      const q = url.searchParams;
      const project = q.get('project') ? projectOrThrow(q.get('project')) : '';
      const settings = loadSettings(dataDir);
      const { profile, problem } = project ? await profileOf(dataDir, project) : { profile: null, problem: '' };
      let findings = null;
      if (project && profile) { try { findings = await loadFindings(dataDir, project); } catch { findings = null; } }
      const pipelines = pipelinesForUi({ profile, settings, findings }).map(p => {
        const needsProfile = pipelineById(p.id).requires.profile;
        if (needsProfile && !project) return { ...p, disabledReason: 'Pick a project first.' };
        if (needsProfile && problem) return { ...p, disabledReason: problem };
        return p;
      });
      const idPattern = profile && profile.findings ? profile.findings.idPattern : undefined;
      return { ok: true, pipelines, routes: routesForUi({ idPattern }) };
    },

    'POST /api/runs': async req => {
      const b = await readJson(req);
      const project = projectOrThrow(b.project);
      const def = pipelineById(String(b.pipeline ?? ''));
      if (!def || def.hidden) throw new HttpError(400, `"${String(b.pipeline ?? '').slice(0, 40)}" is not a pipeline you can start here.`);
      if (b.values !== undefined && !isPlainObject(b.values)) throw new HttpError(400, 'The values must be an object.');
      const request = { project, pipeline: def.id, values: b.values || {} };
      const manager = await engine();
      if (b.preview) return { ok: true, preview: redactDeep(await manager.preview(request)) };
      const { runId } = await manager.start(request);
      return { ok: true, runId };
    },

    'GET /api/runs': async (req, res, url) => {
      const q = url.searchParams;
      const filter = { limit: intParam(q.get('limit'), { name: 'limit', min: 1, max: 500, fallback: 50 }) };
      if (q.get('project')) filter.project = projectOrThrow(q.get('project'));
      if (q.get('pipeline')) {
        const def = pipelineById(q.get('pipeline'));
        if (!def) throw new HttpError(400, `"${q.get('pipeline').slice(0, 40)}" is not a pipeline.`);
        filter.pipeline = def.id;
      }
      if (q.get('status')) {
        const list = q.get('status').split(',').map(s => s.trim()).filter(Boolean);
        const bad = list.find(s => !store.RUN_STATUSES.includes(s));
        if (bad !== undefined) throw new HttpError(400, `"${bad.slice(0, 40)}" is not a run status.`);
        filter.status = list;
      }
      if (q.get('before')) filter.before = runIdOrThrow(q.get('before'));
      const now = Date.now();
      const runs = (await store.listRuns(dataDir, filter)).map(r => redactDeep({ ...r, durationMs: durationOf(r.createdAt, r.endedAt, now) }));
      return { ok: true, runs };
    },

    'GET /api/run': async (req, res, url) => {
      const q = url.searchParams;
      const id = runIdOrThrow(q.get('id'));
      const since = intParam(q.get('since'), { name: 'since', min: 0, max: 1e9, fallback: 0 });
      const limit = intParam(q.get('limit'), { name: 'limit', min: 1, max: 2000, fallback: 500 });
      const manager = await engine();
      const run = await runOr404(dataDir, id);
      const { rows, next, more } = await store.readTimeline(dataDir, run, since, limit);
      return { ok: true, run: await viewFor(manager, run), rows: redactDeep(rows), next, more };
    },

    'GET /api/run-review': async (req, res, url) => {
      const id = runIdOrThrow(url.searchParams.get('id'));
      const run = await runOr404(dataDir, id);
      const review = (run.outputs && run.outputs.review) || await readRunJson(dataDir, run, 'final/review.json') || null;
      const proof = await readRunJson(dataDir, run, 'final/proof.json');
      const folder = run.lastGate && typeof run.lastGate.folder === 'string' ? run.lastGate.folder : '';
      const checks = /^gates\/\d{2}-[a-z0-9-]+$/.test(folder) ? await readRunJson(dataDir, run, `${folder}/summary.json`) : null;
      const { profile } = await profileOf(dataDir, run.project);
      const { files, truncated } = await runDiff(dataDir, run);
      return redactDeep({
        ok: true,
        verdict: review ? review.verdict || null : null,
        findings: review ? asList(review.findings) : [],
        notProven: review ? asList(review.notProven) : [],
        verified: review ? !!review.verified : false,
        proof: proof || null,
        checks: checks || null,
        gate: run.lastGate || null,
        files: files.map(f => ({ path: f.path, add: f.add, del: f.del, tags: profile ? riskTags(profile, [f.path]).tags : [] })),
        diffTruncated: truncated,
      });
    },

    'GET /api/run-diff': async (req, res, url) => {
      const q = url.searchParams;
      const id = runIdOrThrow(q.get('id'));
      const want = String(q.get('file') ?? '');
      if (!want || want.length > DIFF_FILE_MAX) throw new HttpError(400, 'Name a file of the diff.');
      const run = await runOr404(dataDir, id);
      const { files } = await runDiff(dataDir, run);
      const f = files.find(x => x.path === want);
      if (!f) throw new HttpError(404, `${want.slice(0, 120)} is not in this run's diff.`);
      const cut = Buffer.byteLength(f.text, 'utf8') > TEXT_MAX;
      return { ok: true, path: f.path, hunks: cut ? Buffer.from(f.text, 'utf8').subarray(0, TEXT_MAX).toString('utf8') : f.text, truncated: cut };
    },

    'GET /api/run-file': async (req, res, url) => {
      const q = url.searchParams;
      const id = runIdOrThrow(q.get('id'));
      const name = String(q.get('name') ?? '');
      if (name !== 'log' && !Object.hasOwn(RUN_FILES, name) && name !== 'plan') {
        throw new HttpError(400, `"${name.slice(0, 40)}" is not a run file. Use one of ${[...Object.keys(RUN_FILES), 'plan', 'log'].join(', ')}.`);
      }
      let gate = '';
      let check = '';
      if (name === 'log') {
        gate = String(q.get('gate') ?? '').replace(/^gates\//, '');
        check = String(q.get('check') ?? '');
        if (!GATE_DIR_RE.test(gate)) throw new HttpError(400, 'gate must be a gate folder of this run, such as 06-checks.');
        if (!CHECK_ID_RE.test(check)) throw new HttpError(400, 'check must be a check id from that gate.');
      }
      const run = await runOr404(dataDir, id);
      if (name === 'plan') {
        const plan = run.plan || (run.outputs && run.outputs.scope) || null;
        if (!plan) throw new HttpError(404, 'This run has no plan yet.');
        return { ok: true, text: redact(JSON.stringify(plan, null, 2)), truncated: false };
      }
      if (name === 'log') {
        // The folder and the log file are the ones the app's own listing and summary name.
        let folders = [];
        try { folders = (await readdir(runFile(dataDir, run, 'gates'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); } catch { folders = []; }
        const folder = folders.find(f => f === gate);
        if (!folder) throw new HttpError(404, `This run has no gate folder ${gate}.`);
        const summary = await readRunJson(dataDir, run, `gates/${folder}/summary.json`);
        const entry = summary && asList(summary.checks).find(c => c && c.id === check);
        if (!entry || typeof entry.log !== 'string' || !LOG_NAME_RE.test(entry.log)) throw new HttpError(404, `Gate ${folder} has no log for ${check}.`);
        const r = await readCapped(runFile(dataDir, run, `gates/${folder}/${entry.log}`));
        if (!r) throw new HttpError(404, `The log of ${check} is missing.`);
        return { ok: true, text: redact(r.text), truncated: r.truncated };
      }
      const r = await firstText(dataDir, run, RUN_FILES[name]);
      if (!r) throw new HttpError(404, `This run has no ${name} file.`);
      return { ok: true, text: r.text, truncated: r.truncated };
    },
  };

  // One POST route per button: { id, ...payload } goes to manager.action (which checks it
  // against allowedActions: 400 with the reason, 409 while busy or when the tree moved).
  for (const name of ACTIONS) {
    table[`POST /api/runs/${name}`] = async req => {
      const b = await readJson(req);
      const id = runIdOrThrow(b.id);
      const { id: _id, ...payload } = isPlainObject(b) ? b : {};
      const manager = await engine();
      const out = await manager.action(id, name, payload);
      const run = (out && out.run) || await store.findRun(dataDir, id).catch(() => null);
      // next-slice answers with the child run to open, report with where it saved the report.
      const extra = {};
      if (out && out.childRunId && RUN_ID_RE.test(String(out.childRunId))) extra.childRunId = String(out.childRunId);
      if (out && out.report && typeof out.report === 'object') extra.report = { message: redact(String(out.report.message || '')), file: String(out.report.file || '') };
      return { ok: true, message: (out && out.message) || 'Done.', ...extra, run: await viewFor(manager, run) };
    };
  }
  return table;
}
