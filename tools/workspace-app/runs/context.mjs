// The Ask panel's context (hub spec plan A7): what a question asked next to a run, a review gate
// or a finding is about, for the read-only Explain run that answers it.
//
// The page names the subject by reference only, { run: <id> } or { finding: { project, id } },
// plus `after` (the previous Explain run of the same thread) for a follow-up. Everything Claude
// sees is built here from the app's own records, never from text the page sends:
//
//   askContext(dataDir, raw, { project, pipeline })  the start route's check: 400 for a bad shape
//       or a context on another pipeline, 404 for a run or finding that isn't there, 409 while the
//       previous question of the thread still runs. Returns { context, parent }. `context` goes
//       into run.json as it is: kind, the reference, a title, after, and `thread`, the ids of the
//       thread's earlier Explain runs (oldest first, at most THREAD_MAX). `parent` is the run asked
//       about (for a finding, its run when it has one) or, for a follow-up, the previous question.
//   contextText(dataDir, run)  the context as Markdown, built when the Explain stage starts, so it
//       shows the subject as it is then. For a run: its title, status, request, plan summary, gate
//       summary, review, answer, changed files and diff. For a finding: its record from the
//       findings store. Then the thread's earlier questions and answers. The diff goes last and
//       gets only the room the rest leaves of CAPS.total; the subject has a cap of its own
//       (CAPS.main), and the thread's room is kept first, so its newest questions and answers are
//       never what is cut. Run files are read with the readers the review routes use
//       (runs/run-files.mjs), and the whole text is redacted.
//   contextBlock(dataDir, run, { write })  what the executor's one call puts into the Explain
//       prompt ({{context}}): the text written to inputs/context.md through `write` (the store's
//       writeInput, so it is hashed like every input) and returned as a <data name="context">
//       block, which never instructs Claude.
// A subject that is gone by the time the stage starts doesn't stop the question; the text says so.
import { HttpError } from '../http.mjs';
import { PROJECT_RE } from '../core/datadir.mjs';
import { loadFindings } from '../findings/store.mjs';
import { redact as redactSecrets } from '../gates/secrets.mjs';
import { pipelineById } from './catalog.mjs';
import { capBytes, dataBlock } from './prompts.mjs';
import { firstText, readCapped, readRunJson, RUN_FILES, runFile, splitDiff } from './run-files.mjs';
import { findRun, RUN_ID_RE } from './store.mjs';

export const CONTEXT_FILE = 'context.md';
// Earlier questions a follow-up carries.
export const THREAD_MAX = 6;
// UTF-8 bytes per part, and for the whole text. `main` is the subject (the run or finding without
// its diff); main and thread together stay within total with room for a note about the diff,
// and the diff gets what they leave.
export const CAPS = Object.freeze({
  total: 24 * 1024, main: 15 * 1024, diff: 12 * 1024, thread: 8 * 1024, request: 2000, answer: 1500, question: 600, field: 600, evidence: 2000,
});
// Less room than this for the diff's text leaves the diff out (with a note) rather than show a scrap.
const DIFF_MIN = 1024;
// Lines a list shows (files of the plan, findings, problems, sources) and files the diff lists.
export const LIST_MAX = 12;
export const FILES_MAX = 60;
// The findings routes' id rule (routes/findings.mjs FINDING_ID_RE).
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const TITLE_MAX = 200;
const SHAPE = 'The context must be { run: <run id> } or { finding: { project, id } }, plus after: <run id> for a follow-up.';
const WAIT_WORDS = {
  plan: 'the plan gate', spec: 'the spec gate', hypothesis: 'the hypothesis gate', fence: 'the fence gate (a file outside the plan)',
  review: 'the review gate', commit: 'the commit gate', triage: 'triage', decide: 'the decide gate',
};

const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = x => (Array.isArray(x) ? x : []);
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const sha7 = s => String(s || '').slice(0, 7);
const bytes = s => Buffer.byteLength(s, 'utf8');

// `text` cut to `max` UTF-8 bytes, with "…" when something was cut.
export function capText(text, max) {
  const c = capBytes(String(text == null ? '' : text), max);
  return c.cut ? `${c.text}…` : c.text;
}

// ---------- The start route's check

function runIdOrThrow(id, what) {
  if (typeof id === 'string' && RUN_ID_RE.test(id)) return id;
  throw new HttpError(400, what === 'after' ? 'after must be the run id of the previous question.' : 'That is not a run id.');
}

// The reference the page sent, checked for its shape only: { kind: 'run', run, after } or
// { kind: 'finding', finding: { project, id }, after }, where after is a run id or null. Any
// other key (text, a title) is refused, so nothing but a reference can come in. Throws a 400.
export function parseContext(raw) {
  if (!isPlain(raw) || Object.keys(raw).some(k => !['run', 'finding', 'after'].includes(k))) throw new HttpError(400, SHAPE);
  const hasRun = raw.run !== undefined && raw.run !== null;
  const hasFinding = raw.finding !== undefined && raw.finding !== null;
  if (hasRun === hasFinding) throw new HttpError(400, SHAPE);
  const after = raw.after === undefined || raw.after === null ? null : runIdOrThrow(raw.after, 'after');
  if (hasRun) return { kind: 'run', run: runIdOrThrow(raw.run, 'run'), after };
  const f = raw.finding;
  if (!isPlain(f) || Object.keys(f).some(k => !['project', 'id'].includes(k))) throw new HttpError(400, SHAPE);
  const project = String(f.project ?? '');
  if (!PROJECT_RE.test(project)) throw new HttpError(400, `"${project.slice(0, 40)}" is not a project name.`);
  if (typeof f.id !== 'string' || !FINDING_ID_RE.test(f.id)) throw new HttpError(400, `"${String(f.id ?? '').slice(0, 40)}" is not a finding id.`);
  return { kind: 'finding', finding: { project, id: f.id }, after };
}

// True when two contexts (a recorded one and a reference) name the same run or finding.
export function sameSubject(a, b) {
  if (!isPlain(a) || !isPlain(b) || a.kind !== b.kind) return false;
  if (a.kind === 'run') return typeof a.run === 'string' && a.run === b.run;
  return isPlain(a.finding) && isPlain(b.finding) && a.finding.project === b.finding.project && a.finding.id === b.finding.id;
}

async function runOr404(dataDir, id) {
  let run;
  try { run = await findRun(dataDir, id); } catch (err) {
    throw new HttpError(500, `Run ${id} could not be read: ${err.message}`);
  }
  if (!run) throw new HttpError(404, `There is no run ${id}.`);
  return run;
}

async function findingOr404(dataDir, { project, id }) {
  let doc;
  try { doc = await loadFindings(dataDir, project); } catch (err) {
    throw new HttpError(500, `The findings of ${project} could not be read: ${err.message}`);
  }
  const f = asList(doc && doc.findings).find(x => x && x.id === id);
  if (!f) throw new HttpError(404, `There is no finding ${id} in ${project}.`);
  return f;
}

// The finding's run id when that run still exists, else null (a parent must be a real run).
async function findingRun(dataDir, f) {
  if (typeof f.runId !== 'string' || !RUN_ID_RE.test(f.runId)) return null;
  const run = await findRun(dataDir, f.runId).catch(() => null);
  return run ? run.id : null;
}

// Checks a start's context against the app's records. See the header for what it returns.
export async function askContext(dataDir, raw, { project, pipeline } = {}) {
  const ref = parseContext(raw);
  if (pipeline !== 'explain') {
    const def = pipelineById(String(pipeline || ''));
    throw new HttpError(400, `Only Explain takes a context; ${def ? def.label : 'this pipeline'} doesn't.`);
  }
  let title;
  let parent;
  if (ref.kind === 'run') {
    const run = await runOr404(dataDir, ref.run);
    if (run.project !== project) throw new HttpError(400, `Run ${run.id} belongs to ${run.project}, not to ${project}.`);
    title = run.title || run.id;
    parent = run.id;
  } else {
    if (ref.finding.project !== project) throw new HttpError(400, `The finding ${ref.finding.id} belongs to ${ref.finding.project}, not to ${project}.`);
    const f = await findingOr404(dataDir, ref.finding);
    title = `${f.id}: ${oneLine(f.title) || '(no title)'}`;
    parent = await findingRun(dataDir, f);
  }
  let thread = [];
  if (ref.after) {
    const prev = await runOr404(dataDir, ref.after);
    if (prev.pipeline !== 'explain' || prev.project !== project || !sameSubject(prev.context, ref)) {
      throw new HttpError(400, `Run ${prev.id} is not an earlier question about this ${ref.kind}.`);
    }
    if (prev.status === 'running') throw new HttpError(409, 'The previous question is still running. Ask again when its answer is there.');
    thread = [...asList(prev.context.thread).filter(id => typeof id === 'string' && RUN_ID_RE.test(id)), prev.id].slice(-THREAD_MAX);
    parent = prev.id;
  }
  const subject = ref.kind === 'run' ? { run: ref.run } : { finding: ref.finding };
  return { context: { kind: ref.kind, ...subject, title: capText(oneLine(redactSecrets(title)), TITLE_MAX), after: ref.after, thread }, parent };
}

// ---------- The text

// The run's status in words: "waiting for the user at the review gate", "failed: <reason>".
export function statusWords(run) {
  if (run.status === 'waiting' && run.waiting && WAIT_WORDS[run.waiting.kind]) return `waiting for the user at ${WAIT_WORDS[run.waiting.kind]}`;
  const why = oneLine(run.statusReason || (run.error && run.error.message) || '');
  return why && run.status !== 'running' ? `${run.status}: ${capText(why, CAPS.field)}` : String(run.status || 'unknown');
}

// "## Title", a blank line and the lines; '' when there are none.
function section(title, lines) {
  const list = lines.filter(l => typeof l === 'string' && l !== '');
  return list.length ? [`## ${title}`, '', ...list].join('\n') : '';
}
const listLines = (items, fn) => {
  const list = asList(items);
  const shown = list.slice(0, LIST_MAX).map(fn);
  return list.length > LIST_MAX ? [...shown, `- (${list.length - LIST_MAX} more)`] : shown;
};

// The request as the run's stages saw it (inputs/request.md), else its question or values.
async function requestOf(dataDir, run) {
  const file = await readCapped(runFile(dataDir, run, 'inputs/request.md'), CAPS.request + 4).catch(() => null);
  if (file && file.text.trim()) return capText(file.text.trim(), CAPS.request);
  const v = isPlain(run.values) ? run.values : {};
  if (typeof v.what === 'string' && v.what.trim()) return capText(v.what.trim(), CAPS.request);
  const { error, ...rest } = v;
  return Object.keys(rest).length ? capText(JSON.stringify(rest), CAPS.request) : '';
}

function planLines(run) {
  const plan = isPlain(run.plan) ? run.plan : null;
  const out = (plan && isPlain(plan.output) && plan.output) || (isPlain(run.outputs) && isPlain(run.outputs.scope) && run.outputs.scope) || null;
  if (!plan && !out) return [];
  const lines = [];
  if (out && out.summary) lines.push(`Summary: ${capText(oneLine(out.summary), CAPS.field)}`);
  lines.push(plan && plan.approvedAt ? `Approved by the user at ${plan.approvedAt}.` : 'Not approved yet.');
  const slice = plan && out && Number.isInteger(plan.slice) ? asList(out.slices)[plan.slice] : null;
  if (slice) lines.push(`Slice ${plan.slice + 1}: ${capText(oneLine(slice.title), 120)}${slice.goal ? `: ${capText(oneLine(slice.goal), CAPS.field)}` : ''}`);
  const files = plan ? asList(plan.files) : asList(out && out.files).map(f => (isPlain(f) ? f.path : f));
  if (files.length) lines.push('Files:', ...listLines(files, p => `- ${capText(oneLine(p), 300)}`));
  return lines;
}

async function gateLines(dataDir, run) {
  const g = isPlain(run.lastGate) ? run.lastGate : null;
  const summary = await readRunJson(dataDir, run, 'inputs/gate-summary.json');
  if (!g && !isPlain(summary)) return [];
  const s = isPlain(summary) ? summary : {};
  const result = (g && g.result) || s.result || 'unknown';
  const chip = (g && g.chip) || s.chip || '';
  const lines = [`Last gate: ${result}${chip ? ` · ${chip}` : ''}${g && g.at ? ` (at ${g.at})` : ''}`];
  if (asList(s.problems).length) lines.push('Problems:', ...listLines(s.problems, p => `- ${capText(oneLine(p), 300)}`));
  if (asList(s.outsidePlan).length) lines.push('Files outside the plan:', ...listLines(s.outsidePlan, p => `- ${capText(oneLine(p), 300)}`));
  return lines;
}

// The review the review gate shows (run.outputs.review, else final/review.json), as GET /api/run-review reads it.
async function reviewLines(dataDir, run) {
  const review = (isPlain(run.outputs) && isPlain(run.outputs.review) && run.outputs.review) || await readRunJson(dataDir, run, 'final/review.json');
  if (!isPlain(review)) return [];
  const lines = [`Verdict: ${review.verdict || 'none'}${review.verified ? ' (verified by a second pass)' : ''}`];
  const where = f => (f.path ? ` ${f.path}${Number(f.line) > 0 ? `:${f.line}` : ''}` : '');
  if (asList(review.findings).length) {
    lines.push('Findings:', ...listLines(review.findings, f => `- ${f.id || '?'} ${f.severity || ''}${where(f)}: ${capText(oneLine(f.claim), 300)}`));
  }
  if (asList(review.notProven).length) lines.push('Not proven:', ...listLines(review.notProven, x => `- ${capText(oneLine(x), 300)}`));
  return lines;
}

// An Explain run's answer: the text and its sources.
function answerLines(answer) {
  if (!isPlain(answer) || !answer.answer) return [];
  return [capText(String(answer.answer).trim(), CAPS.answer),
    ...(asList(answer.sources).length ? ['Sources:', ...listLines(answer.sources, s => `- ${s.path}${Number(s.line) > 0 ? `:${s.line}` : ''}${s.note ? ` (${capText(oneLine(s.note), 120)})` : ''}`)] : [])];
}

// The run's changed files (a section) and its diff (final/diff.patch, else inputs/diff.patch):
// { text, partial, kb, truncated, count }. The text is cut a little past CAPS.diff here
// (partial) and to its room later (diffSection), after it is redacted, so a secret is never split
// by the cut that decides what Claude sees.
async function diffParts(dataDir, run) {
  const r = await firstText(dataDir, run, RUN_FILES.diff);
  if (!r || !r.text.trim()) return { files: '', diff: null };
  const files = splitDiff(r.text);
  const list = files.slice(0, FILES_MAX).map(f => `- ${f.path} (+${f.add} −${f.del})`);
  if (files.length > FILES_MAX) list.push(`- (${files.length - FILES_MAX} more files)`);
  const c = capBytes(r.text, CAPS.diff + 1024);
  const diff = { text: c.text, partial: c.cut || !!r.truncated, kb: Math.round(bytes(r.text) / 1024), truncated: !!r.truncated, count: files.length };
  return { files: section(`Changed files (${files.length})`, list), diff };
}

// The diff as a section of at most `room` bytes (its text already redacted): all of it, or the
// part that fits with a note, or only a note when less than DIFF_MIN of it would fit.
export function diffSection(diff, room) {
  if (!diff) return '';
  const head = '## Diff\n\n';
  const all = `in all it is ${diff.kb} KB${diff.truncated ? ' or more' : ''} over ${diff.count} files`;
  if (!diff.partial && bytes(diff.text) <= Math.min(room - bytes(head), CAPS.diff)) return head + diff.text;
  const note = `\n(The diff is cut here; ${all}.)`;
  const left = Math.min(room - bytes(head + note), CAPS.diff);
  if (left >= DIFF_MIN) return `${head}${capBytes(diff.text, left).text}${note}`;
  const out = `${head}(The diff is left out, so the context stays within ${CAPS.total / 1024} KB; ${all}.)`;
  return bytes(out) <= room ? out : '';
}

// `text` in at most `max` bytes: as it is, or cut with a note that says so.
function fit(text, max) {
  if (bytes(text) <= max) return text;
  const note = `\n\n(Cut here at ${Math.floor(max / 1024)} KB, to leave room for the rest of the context.)`;
  return `${capBytes(text, Math.max(0, max - bytes(note))).text}${note}`;
}

// The run part: { main, diff } with the diff kept apart (diffParts), so it gets only the room the
// rest leaves.
async function runPart(dataDir, id) {
  let run;
  try { run = await findRun(dataDir, id); } catch (err) {
    return { main: `# The run the question is about\n\nRun ${id} could not be read: ${err.message}`, diff: null };
  }
  if (!run) return { main: `# The run the question is about\n\nRun ${id} is gone: its folder is no longer in the data folder.`, diff: null };
  const def = pipelineById(run.pipeline);
  const base = run.base && run.base.sha ? ` · base ${run.base.branch ? `${run.base.branch} ` : ''}${sha7(run.base.sha)}` : '';
  const commit = run.commit && run.commit.sha ? ` · committed ${sha7(run.commit.sha)}${run.commit.branch ? ` on ${run.commit.branch}` : ''}` : '';
  const head = [
    '# The run the question is about', '',
    `Run ${run.id}: ${oneLine(run.title) || '(no title)'}`,
    `Pipeline: ${def ? def.label : run.pipeline} · status: ${statusWords(run)}${run.level ? ` · level: ${run.level}` : ''}`,
    `Started ${run.createdAt || 'at an unknown time'}${base}${run.branch ? ` · branch ${run.branch}` : ''}${commit}`,
  ].join('\n');
  const outputs = isPlain(run.outputs) ? run.outputs : {};
  const request = await requestOf(dataDir, run);
  const { files, diff } = await diffParts(dataDir, run);
  const main = [
    head,
    request ? `## Request\n\n${request}` : '',
    section('Plan', planLines(run)),
    section('Gate summary', await gateLines(dataDir, run)),
    section('Review', await reviewLines(dataDir, run)),
    section('Answer', answerLines(outputs.answer)),
    files,
  ].filter(Boolean).join('\n\n');
  return { main, diff };
}

// The finding part: its record from the findings store, or why it can't be shown.
async function findingPart(dataDir, ref) {
  const label = `${ref && ref.id} of ${ref && ref.project}`;
  let f = null;
  try { f = asList((await loadFindings(dataDir, ref.project)).findings).find(x => x && x.id === ref.id) || null; } catch (err) {
    return `# The finding the question is about\n\nThe findings of ${ref.project} could not be read: ${err.message}`;
  }
  if (!f) return `# The finding the question is about\n\nThe finding ${label} is no longer on the board.`;
  const facts = [
    f.severity ? `severity ${f.severity}` : '', f.status ? `status ${f.status}` : '',
    f.phase !== null && f.phase !== undefined && f.phase !== '' ? `phase ${f.phase}` : '', f.area ? `area ${capText(oneLine(f.area), 120)}` : '',
    f.blast ? `blast radius ${f.blast}` : '', f.ownerDecision ? 'waits for an owner decision' : '',
  ].filter(Boolean).join(' · ');
  const lines = ['# The finding the question is about', '', `Finding ${f.id} of ${ref.project}: ${oneLine(f.title) || '(no title)'}`];
  if (facts) lines.push(facts);
  if (typeof f.runId === 'string' && f.runId) lines.push(`Run: ${f.runId}`);
  if (f.branch) lines.push(`Branch: ${f.branch}`);
  if (asList(f.commits).length) lines.push(`Commits: ${asList(f.commits).slice(0, LIST_MAX).map(sha7).join(', ')}`);
  if (asList(f.records).length) lines.push(`Records: ${asList(f.records).slice(0, LIST_MAX).join(', ')}`);
  const out = [lines.join('\n')];
  if (f.evidence) out.push(`## Evidence\n\n${capText(String(f.evidence).trim(), CAPS.evidence)}`);
  if (f.notes) out.push(`## Notes\n\n${capText(String(f.notes).trim(), CAPS.evidence)}`);
  const history = asList(f.history).slice(-5).map(h => `- ${h.at || ''} ${h.from || 'new'} to ${h.to || '?'} by ${h.by || '?'}${h.reason ? `: ${capText(oneLine(h.reason), 200)}` : ''}${h.runId ? ` (run ${h.runId})` : ''}`);
  if (history.length) out.push(section('History (latest last)', history));
  return out.join('\n\n');
}

// One earlier question and its answer, or what became of it.
async function threadItem(dataDir, id, n) {
  const run = await findRun(dataDir, id).catch(() => null);
  if (!run) return `Q${n} (run ${id}): (this question is gone)`;
  const q = capText(oneLine(run.values && run.values.what), CAPS.question) || '(no question)';
  const answer = isPlain(run.outputs) && isPlain(run.outputs.answer) && run.outputs.answer.answer;
  const a = answer ? capText(String(answer).trim(), CAPS.answer) : `(no answer: the run is ${statusWords(run)})`;
  return `Q${n} (run ${id}): ${q}\nA${n}: ${a}`;
}

// The thread's earlier questions and answers, oldest first, within CAPS.thread (the oldest go first).
async function threadPart(dataDir, ids) {
  const list = asList(ids).filter(id => typeof id === 'string' && RUN_ID_RE.test(id)).slice(-THREAD_MAX);
  if (!list.length) return '';
  const items = [];
  for (const [i, id] of list.entries()) items.push(await threadItem(dataDir, id, i + 1));
  let left = 0;
  while (items.length > 1 && bytes(items.join('\n\n')) > CAPS.thread) { items.shift(); left++; }
  const note = left ? `(${left} older question${left === 1 ? '' : 's'} left out.)\n\n` : '';
  return `# Earlier questions and answers in this thread (oldest first)\n\n${note}${capText(items.join('\n\n'), CAPS.thread)}`;
}

// The context text of an Explain run that has run.context ('' without one). `redact` is applied
// after the secret patterns (the executor passes its own), to each part before it is cut.
// The room is shared out in order: the thread first (within CAPS.thread, its oldest questions
// dropped first), so the newest questions and answers always survive; then the subject, within
// CAPS.main and what the thread leaves; then the diff, within CAPS.diff and what is left of
// CAPS.total. The cut of the whole is only a safety net.
export async function contextText(dataDir, run, { redact } = {}) {
  const c = run && isPlain(run.context) ? run.context : null;
  if (!c) return '';
  const clean = text => (typeof redact === 'function' ? String(redact(redactSecrets(text))) : redactSecrets(text));
  let main = '';
  let diff = null;
  if (c.kind === 'run') ({ main, diff } = await runPart(dataDir, c.run));
  else if (c.kind === 'finding') main = await findingPart(dataDir, c.finding);
  else main = `(The app does not know a context of kind "${oneLine(c.kind).slice(0, 40)}".)`;
  const thread = clean(await threadPart(dataDir, c.thread));
  const sep = '\n\n';
  const subject = fit(clean(main), Math.min(CAPS.main, CAPS.total - (thread ? bytes(thread + sep) : 0)));
  const used = bytes(subject) + (thread ? bytes(sep + thread) : 0);
  const tail = diffSection(diff && { ...diff, text: clean(diff.text) }, CAPS.total - used - bytes(sep));
  const text = [subject, thread, tail].filter(Boolean).join(sep);
  const cut = capBytes(text, CAPS.total);
  return cut.cut ? `${cut.text}\n\n(The context is cut here at ${CAPS.total / 1024} KB.)` : cut.text;
}

// The {{context}} of the Explain prompt; `write(name, text)` keeps the text in inputs/ (the store's
// writeInput, hashed), left out for a preview.
export async function contextBlock(dataDir, run, { write, preview = false, redact } = {}) {
  const text = await contextText(dataDir, run, { redact });
  if (!preview && typeof write === 'function') await write(CONTEXT_FILE, text);
  return `${dataBlock('context', text)}\n(Also in ${CONTEXT_FILE} in the inputs folder.)`;
}
