// Save as report: turns a finished run into a dated Markdown report and registers it.
//
// Where it goes depends on the profile's privacy flag:
//   privacy.hubPublic true (or no profile)  -> <dataDir>/reports/<project>/<YYYY-MM-DD>_<pipeline>-<slug>/
//                                              registered in <dataDir>/reports/index.json
//   privacy.hubPublic false                 -> <hub>/reports/<YYYY-MM-DD>_<project>-<pipeline>-<slug>/
//                                              registered by running tools/register-report.mjs
// A public hub never receives a run report: findings, paths and evidence are project security
// detail. The date and slug come from the run, so saving the same run again finds its folder and
// writes report-v2.md, report-v3.md, ... next to report.md (an HTML comment in each file names
// the run). Everything Claude wrote is quoted, secret-scanned and redacted before it is written;
// so is your own request text.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_RE, projectPaths, readJson, writeJsonAtomic } from '../core/datadir.mjs';
import { redact, scanText } from '../gates/secrets.mjs';

// The pipeline labels of runs/catalog.mjs, kept here so a report never needs the catalog.
export const PIPELINE_LABELS = {
  explain: 'Explain', review: 'Review', check: 'Check my work', architecture: 'Architecture check',
  fix: 'Fix a finding', refactor: 'Refactor', debug: 'Debug', feature: 'New feature', 'setup-worktree': 'Set up the run worktree',
};
export const REPORT_TYPES = { review: 'audit', architecture: 'audit', explain: 'research', check: 'status' };
export const TITLE_REQUEST_MAX = 80;

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
const PIPELINE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPORT_FILE_RE = /^report(?:-v(\d+))?\.md$/i;
const STATUS_LABELS = {
  running: 'running', waiting: 'waiting for you', 'in-terminal': 'in terminal', passed: 'passed', committed: 'committed',
  failed: 'failed', 'gates-red': 'ended with red checks', capped: 'hit a cap', 'paused-limit': 'paused at the usage limit',
  interrupted: 'was interrupted', parked: 'parked', cancelled: 'cancelled',
};
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const pad = n => String(n).padStart(2, '0');
function localDay(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function duration(ms) {
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${s} s`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortSha = c => {
  const sha = typeof c === 'string' ? c : c && typeof c.sha === 'string' ? c.sha : '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : '';
};

export function reportType(pipeline) {
  return REPORT_TYPES[pipeline] || 'other';
}

// Text that goes into a report title, a summary or a command-line argument: no quotes,
// backticks or $, no control characters, one line, at most `max` characters (cut at a word).
export function sanitizeText(text, max = TITLE_REQUEST_MAX) {
  let s = String(text || '').replace(/['"`$‘’“”]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    s = (space > max / 2 ? cut.slice(0, space) : s.slice(0, max)).trim();
  }
  return s;
}

// kebab-case for folder names: at most 6 words and 40 characters; "run" when nothing is left.
export function slugFrom(text) {
  const words = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const out = [];
  for (const w of words) {
    if (out.length >= 6 || [...out, w].join('-').length > 40) break;
    out.push(w);
  }
  return out.join('-') || 'run';
}

// What you asked the run to do: the "what" field, else the run title without its pipeline label,
// else the finding id, else the run id.
export function requestOf(run) {
  const v = run?.values || {};
  if (typeof v.what === 'string' && v.what.trim()) return v.what;
  const label = PIPELINE_LABELS[run?.pipeline] || '';
  const title = String(run?.title || '').trim();
  if (title) {
    for (const l of [label, String(run.pipeline || '')]) {
      if (l && title.toLowerCase().startsWith(`${l.toLowerCase()}:`)) return title.slice(l.length + 1).trim();
    }
    return title;
  }
  if (typeof v.finding === 'string' && v.finding.trim()) return v.finding;
  return String(run?.id || 'run');
}

// "<Pipeline label>: <request>", the request redacted and sanitized (at most 80 characters).
export function reportTitle(run, { label, allow = [] } = {}) {
  const name = label || PIPELINE_LABELS[run?.pipeline] || String(run?.pipeline || 'Run');
  const request = sanitizeText(redact(requestOf(run), { allow }), TITLE_REQUEST_MAX);
  return request ? `${name}: ${request}` : name;
}

// ---- Markdown building ----

// A writer that quotes, secret-scans and redacts untrusted text, and counts what it redacted.
function textTools(allow) {
  let secrets = 0;
  const scrub = text => {
    const s = String(text ?? '');
    if (!s) return '';
    secrets += scanText(s, { allow }).length;
    return redact(s, { allow });
  };
  // Outside code spans, "<" and "&" are escaped so quoted text can't become HTML, and square
  // brackets so it can't become a link or an image.
  const safe = text => scrub(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[[\]]/g, m => `\\${m}`);
  const cut = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
  return {
    count: () => secrets,
    // A block quote: every line starts with "> ", so Claude's text never becomes report structure.
    block: (text, max = 4000) => {
      const s = cut(safe(text).replace(/\r\n?/g, '\n').trim(), max);
      return s ? s.split('\n').map(l => `> ${l}`.trimEnd()).join('\n') : '> (empty)';
    },
    // A short quote on one line, for a list item or a table cell.
    inline: (text, max = 300) => `"${cut(safe(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'), max)}"`,
    // A path or command in a code span (backticks removed from the text itself).
    code: (text, max = 200) => {
      const s = cut(scrub(text).replace(/[`\r\n|]+/g, ' ').trim(), max);
      return s ? `\`${s}\`` : '';
    },
    // Our own words or ids: escaped for tables, not quoted.
    plain: (text, max = 300) => cut(safe(text).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'), max),
  };
}

function chipOf(counts) {
  if (!counts || typeof counts !== 'object') return '';
  const parts = [`${counts.new ?? 0} new`, `${counts.known ?? 0} known`];
  if (counts.flaky) parts.push(`${counts.flaky} flaky`);
  if (counts.canShrink) parts.push(`${counts.canShrink} can shrink`);
  return parts.join(' · ');
}

function findingCounts(list) {
  const by = {};
  for (const f of list) by[f.severity] = (by[f.severity] || 0) + 1;
  return SEVERITIES.filter(s => by[s]).map(s => `${by[s]} ${s}`).join(', ');
}

function checksChip(outputs) {
  if (outputs.proof?.baseline) return chipOf(outputs.proof.baseline);
  if (outputs.checks?.chip) return String(outputs.checks.chip);
  if (outputs.checks?.counts) return chipOf(outputs.checks.counts);
  return '';
}

function findingsSection(t, o) {
  const out = [];
  const review = Array.isArray(o.review?.findings) ? o.review.findings : null;
  if (review) {
    if (o.review.verdict) out.push(`Verdict: **${t.plain(o.review.verdict, 20)}** (the review's own words below are quoted).`, '');
    if (!review.length) out.push('The review found nothing.', '');
    review.forEach((f, i) => {
      const sev = SEVERITIES.includes(f.severity) ? f.severity : 'unrated';
      const where = f.path ? ` · ${t.code(`${f.path}${f.line ? `:${f.line}` : ''}`)}` : '';
      out.push(`### ${i + 1}. ${sev[0].toUpperCase()}${sev.slice(1)} · ${t.plain(f.kind || 'issue', 20)}${where}`);
      if (f.status === 'unconfirmed') out.push('', 'Unconfirmed by the verify stage. Kept and shown, never dropped.');
      if (f.rule) out.push('', `Rule: ${t.inline(f.rule, 200)}`);
      out.push('', 'Claim:', t.block(f.claim, 1500));
      if (f.evidence) out.push('', 'Evidence:', t.block(f.evidence, 1500));
      if (f.suggestion) out.push('', 'Suggestion:', t.block(f.suggestion, 1500));
      out.push('');
    });
  }
  if (Array.isArray(o.triage?.items)) {
    out.push('### Triage', '');
    if (!o.triage.items.length) out.push('Nothing to triage.');
    for (const it of o.triage.items) {
      out.push(`- ${t.inline(it.ref, 120)} · ${t.plain(it.verdict || 'unsorted', 20)}: ${t.inline(it.reason, 400)}${it.suggestedSlice ? `; slice: ${t.inline(it.suggestedSlice, 200)}` : ''}`);
    }
    out.push('');
  }
  if (o.answer && typeof o.answer.answer === 'string') {
    out.push('### Answer', '', t.block(o.answer.answer, 8000), '');
    const sources = Array.isArray(o.answer.sources) ? o.answer.sources : [];
    if (sources.length) {
      out.push('Sources Claude named:', '');
      for (const s of sources) out.push(`- ${t.code(`${s.path || ''}${s.line ? `:${s.line}` : ''}`)}${s.note ? ` ${t.inline(s.note, 200)}` : ''}`);
      out.push('');
    }
    const qs = Array.isArray(o.answer.openQuestions) ? o.answer.openQuestions : [];
    if (qs.length) out.push('Open questions:', '', ...qs.map(q => `- ${t.inline(q, 300)}`), '');
    if (o.answer.suggestedNote) out.push('Suggested note:', t.block(o.answer.suggestedNote, 1500), '');
  }
  if (Array.isArray(o.diagnosis?.hypotheses)) {
    out.push('### Diagnosis', '', `Pinnable by a test: ${o.diagnosis.pinnable === false ? 'no' : 'yes'}.`, '');
    o.diagnosis.hypotheses.forEach((h, i) => {
      out.push(`${i + 1}. Confidence ${t.plain(h.confidence || 'unrated', 10)}:`, '', t.block(h.claim, 1000), '');
      for (const e of Array.isArray(h.evidence) ? h.evidence : []) out.push(`   - Evidence: ${t.inline(e, 300)}`);
      if (h.howToProve) out.push(`   - How to prove it: ${t.inline(h.howToProve, 300)}`);
      out.push('');
    });
    if (o.diagnosis.reproPlan) out.push('Repro plan:', t.block(o.diagnosis.reproPlan, 1500), '');
  }
  if (!out.length) out.push('No findings in this run.', '');
  return out;
}

function proofSection(t, o) {
  const out = [];
  const p = o.proof;
  if (p) {
    const chip = chipOf(p.baseline);
    if (chip) out.push(`Test baseline: ${chip}${p.baseline?.key ? ` (baseline ${t.code(p.baseline.key, 80)})` : ''}.`, '');
    const checks = Array.isArray(p.checks) ? p.checks : [];
    if (checks.length) {
      out.push('| Check | Result | Took |', '|---|---|---|');
      for (const c of checks) out.push(`| ${t.plain(c.label || c.id, 120)} | ${t.plain(c.result || '', 20)} | ${duration(c.durationMs)} |`);
      out.push('');
    }
    if (p.pins) out.push(`- Pinned tests: ${p.pins.identical ? 'unchanged' : 'CHANGED'}, ${p.pins.green ? 'green' : 'NOT green'}.`);
    if (p.scope) {
      const allowed = Array.isArray(p.scope.allowedByUser) ? p.scope.allowedByUser : [];
      out.push(`- Scope: ${p.scope.inPlan ?? '?'} of ${p.scope.total ?? '?'} changed files were in the plan${allowed.length ? `; allowed by you: ${allowed.map(x => t.code(x)).join(', ')}` : ''}.`);
    }
    const changedTests = Array.isArray(p.existingTestsChanged) ? p.existingTestsChanged : [];
    if (changedTests.length) out.push(`- Existing tests changed: ${changedTests.map(x => t.code(x)).join(', ')}.`);
    if (p.treeHash) {
      const m = p.treeHash.match === true ? 'matches the gated tree' : p.treeHash.match === false ? 'DIFFERS from the gated tree' : 'not committed yet';
      out.push(`- Tree hash: ${m}.`);
    }
    if (p.turns && typeof p.turns === 'object') {
      out.push(`- Turns: ${Object.entries(p.turns).map(([k, v]) => `${t.plain(k, 30)} ${Number(v) || 0}`).join(', ')}.`);
    }
    if (p.versions) out.push(`- Versions: Node ${t.plain(p.versions.node || '?', 20)}, Claude Code ${t.plain(p.versions.claudeCode || '?', 20)}.`);
    out.push('');
  } else if (o.checks) {
    const s = o.checks;
    out.push(`Result: ${t.plain(s.result || '?', 20)}${checksChip(o) ? ` · ${t.plain(checksChip(o), 120)}` : ''}${s.level ? ` · level ${t.plain(s.level, 20)}` : ''}.`, '');
    const checks = Array.isArray(s.checks) ? s.checks : [];
    if (checks.length) {
      out.push('| Group | Check | Result | Took |', '|---|---|---|---|');
      for (const c of checks) out.push(`| ${t.plain(c.group || '', 10)} | ${t.plain(c.label || c.id, 120)} | ${t.plain(c.status || '', 10)}${c.reason ? `: ${t.plain(c.reason, 120)}` : ''} | ${duration(c.durationMs)} |`);
      out.push('');
    }
    const fresh = Array.isArray(s.tests?.new) ? s.tests.new : [];
    if (fresh.length) out.push('New failures:', '', ...fresh.slice(0, 50).map(id => `- ${t.code(id, 300)}`), '');
  }
  if (!out.length) out.push('No checks ran in this run.', '');
  return out;
}

// The report text: a title, 3-5 summary bullets, then Snapshot, Findings, Proof, Not proven and
// Sources. `outputs` = { answer, review, proof, diagnosis, triage, checks } (any may be missing).
// Claude's text is quoted, secret-scanned and redacted; so is the request.
export function buildReportMarkdown(run, outputs = {}, { allow = [], title, label, now = new Date() } = {}) {
  const t = textTools(allow);
  const o = outputs || {};
  const name = label || PIPELINE_LABELS[run?.pipeline] || String(run?.pipeline || 'Run');
  const heading = t.plain(title || reportTitle(run, { label, allow }), 200);
  const status = STATUS_LABELS[run?.status] || String(run?.status || 'unknown');

  // Sections first, so the bullets can count what was redacted.
  const findings = findingsSection(t, o);
  const proof = proofSection(t, o);
  const notProven = [...(Array.isArray(o.review?.notProven) ? o.review.notProven : []), ...(Array.isArray(o.proof?.notProven) ? o.proof.notProven : [])];
  const notProvenLines = notProven.length ? notProven.map(x => `- ${t.inline(x, 400)}`) : ['Nothing listed.'];
  const requestQuote = t.block(requestOf(run), 1500);

  const bullets = [`- **Result:** ${t.plain(name, 40)} ${status}${run?.endedAt ? ` on ${localDay(run.endedAt)}` : ''}.`];
  const review = Array.isArray(o.review?.findings) ? o.review.findings : null;
  if (review) {
    const c = findingCounts(review);
    bullets.push(`- **Findings:** ${plural(review.length, 'finding')}${c ? ` (${c})` : ''}${o.review.verdict ? `; verdict ${t.plain(o.review.verdict, 20)}` : ''}.`);
  } else if (o.answer && typeof o.answer.answer === 'string') {
    const n = Array.isArray(o.answer.sources) ? o.answer.sources.length : 0;
    const q = Array.isArray(o.answer.openQuestions) ? o.answer.openQuestions.length : 0;
    bullets.push(`- **Answer:** ${plural(n, 'source')}, ${plural(q, 'open question')}.`);
  } else if (Array.isArray(o.diagnosis?.hypotheses)) {
    const n = o.diagnosis.hypotheses.length;
    bullets.push(`- **Diagnosis:** ${n} ${n === 1 ? 'hypothesis' : 'hypotheses'}; pinnable by a test: ${o.diagnosis.pinnable === false ? 'no' : 'yes'}.`);
  } else if (Array.isArray(o.triage?.items)) {
    bullets.push(`- **Triage:** ${plural(o.triage.items.length, 'item')}.`);
  } else {
    bullets.push('- **Findings:** none in this run.');
  }
  const chip = checksChip(o);
  bullets.push(chip ? `- **Checks:** ${t.plain(chip, 120)}.` : '- **Checks:** none ran in this run.');
  const sha = shortSha(run?.commit);
  if (sha) bullets.push(`- **Commit:** ${sha}${run.commit?.branch || run.branch ? ` on ${t.plain(run.commit?.branch || run.branch, 80)}` : ''}; not pushed.`);
  if (notProven.length && bullets.length < 5) bullets.push(`- **Not proven:** ${plural(notProven.length, 'item')}; see below.`);
  if (t.count() && bullets.length < 5) bullets.push(`- **Redacted:** ${plural(t.count(), 'secret-shaped string')} in the text below.`);

  const snap = ['| Field | Value |', '|---|---|',
    `| Run | ${t.code(run?.id, 80)} |`, `| Pipeline | ${t.plain(name, 40)} |`, `| Project | ${t.plain(run?.project, 60)} |`,
    `| Status | ${t.plain(status, 40)} |`];
  if (run?.createdAt) snap.push(`| Started | ${localTime(run.createdAt)} |`);
  if (run?.createdAt && run?.endedAt) snap.push(`| Took | ${duration(new Date(run.endedAt) - new Date(run.createdAt))} |`);
  if (run?.base?.branch || run?.base?.sha) snap.push(`| Base | ${t.plain(run.base.branch || '', 80)}${run.base.sha ? ` at ${t.code(String(run.base.sha).slice(0, 7))}` : ''} |`);
  if (run?.branch) snap.push(`| Branch | ${t.code(run.branch, 120)} |`);
  if (sha) snap.push(`| Commit | ${t.code(sha)} (not pushed) |`);
  if (run?.level) snap.push(`| Level | ${t.plain(run.level, 20)}${Array.isArray(run.levelReason) && run.levelReason.length ? `: ${t.plain(run.levelReason.join('; '), 300)}` : ''} |`);
  if (run?.versions) snap.push(`| Versions | Node ${t.plain(run.versions.node || '?', 20)}, Claude Code ${t.plain(run.versions.claudeCode || '?', 20)} |`);

  const used = ['`run.json`'];
  if (o.review) used.push('`final/review.json`');
  if (o.answer) used.push('`final/answer.json`');
  if (o.diagnosis) used.push('`final/diagnosis.json`');
  if (o.triage) used.push('`final/triage.json`');
  if (o.proof) used.push('`final/proof.json`');
  else if (o.checks) used.push('the gate `summary.json`');

  return [
    `# ${heading}`, '', ...bullets.slice(0, 5), '',
    '## Snapshot', '', ...snap, '', 'You asked:', '', requestQuote, '',
    '## Findings', '', ...findings,
    '## Proof', '', ...proof,
    '## Not proven', '', ...notProvenLines, '',
    '## Sources', '',
    `- The run folder \`runs/${t.plain(run?.project, 60)}/${t.plain(run?.id, 64)}\` in the app's private data folder: ${used.join(', ')}.`,
    `- Written by the workspace app on ${localDay(now)} from the run's files. Text from Claude is quoted as data, secret-scanned and redacted; it was not re-checked by hand.`,
    '',
  ].join('\n');
}

function summaryLine(run, outputs, { label } = {}) {
  const name = label || PIPELINE_LABELS[run?.pipeline] || String(run?.pipeline || 'Run');
  const parts = [`${name} ${STATUS_LABELS[run?.status] || run?.status || ''}`.trim()];
  const review = Array.isArray(outputs?.review?.findings) ? outputs.review.findings : null;
  if (review) {
    const c = findingCounts(review);
    parts.push(`${plural(review.length, 'finding')}${c ? ` (${c})` : ''}`);
  } else if (outputs?.answer) parts.push('answer with sources');
  else if (outputs?.diagnosis) parts.push('diagnosis');
  const chip = checksChip(outputs || {});
  parts.push(chip ? `checks ${chip}` : 'no checks');
  if (shortSha(run?.commit)) parts.push(`commit ${shortSha(run.commit)}`);
  return sanitizeText(parts.join('; '), 200);
}

// ---- loading and saving ----

// The run's outputs from its folder: final/{answer,review,proof,diagnosis,triage}.json and the
// newest gate summary.json, else what run.json keeps in run.outputs (the executor writes both).
// Missing ones are null.
export async function loadRunOutputs(dataDir, run) {
  if (!run || !RUN_ID_RE.test(String(run.id || ''))) throw httpError(400, 'The run id is not valid.');
  const dir = join(projectPaths(dataDir, run.project).runs, run.id);
  const read = file => readJson(file, null).catch(() => null);
  const [answer, review, proof, diagnosis, triage] = await Promise.all(
    ['answer', 'review', 'proof', 'diagnosis', 'triage'].map(n => read(join(dir, 'final', `${n}.json`))));
  let checks = null;
  let gates = [];
  try { gates = (await readdir(join(dir, 'gates'))).filter(n => /^[0-9a-z-]+$/i.test(n)).sort().reverse(); } catch { gates = []; }
  for (const g of gates) {
    checks = await read(join(dir, 'gates', g, 'summary.json'));
    if (checks) break;
  }
  const kept = run.outputs && typeof run.outputs === 'object' ? run.outputs : {};
  const obj = v => (v && typeof v === 'object' ? v : null);
  return {
    answer: answer || obj(kept.answer), review: review || obj(kept.review), proof,
    diagnosis: diagnosis || obj(kept.investigate), triage: triage || obj(kept.triage), checks: checks || obj(kept.checks),
  };
}

const marker = runId => `<!-- workspace-app run: ${runId} -->`;

// The folder for this run's report under `base`: the same folder as an earlier save of the run,
// or a new one (`<id>`, `<id>-2`, ... when another run already uses the name).
async function pickFolder(base, id, runId) {
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? id : `${id}-${n}`;
    const dir = join(base, name);
    let entries;
    try {
      entries = await readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return { name, dir };
      throw e;
    }
    if (!entries.length) return { name, dir };
    for (const f of entries.filter(x => REPORT_FILE_RE.test(x))) {
      const text = await readFile(join(dir, f), 'utf8').catch(() => '');
      if (text.includes(marker(runId))) return { name, dir };
    }
  }
  throw new Error(`There are too many reports named ${id}.`);
}

// Writes report.md, or the next free report-vN.md. Returns { file, version }.
async function writeVersion(dir, text) {
  await mkdir(dir, { recursive: true });
  for (let n = 1; n < 100; n++) {
    const file = n === 1 ? 'report.md' : `report-v${n}.md`;
    try {
      await writeFile(join(dir, file), text, { encoding: 'utf8', flag: 'wx' });
      return { file, version: n };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('This report already has 99 versions.');
}

// .md and .html files in the folder, report.md first, then by name with numbers in order (the
// same order tools/register-report.mjs uses).
async function stepsOf(dir, relDir) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const files = (await readdir(dir)).filter(f => /\.(md|html)$/i.test(f)).sort((a, b) =>
    (a.toLowerCase() === 'report.md' ? 0 : 1) - (b.toLowerCase() === 'report.md' ? 0 : 1) || collator.compare(a, b));
  return files.map(f => ({ name: f.replace(/\.(md|html)$/i, '').replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()), path: `${relDir}/${f}` }));
}

// True when reports/reports.json in the hub already lists the folder id. Any read or parse
// problem counts as "not registered", so the caller passes every field (register-report upserts,
// so that is right either way).
async function hubRegistered(root, id) {
  try {
    const text = (await readFile(join(root, 'reports', 'reports.json'), 'utf8')).replace(/^﻿/, '');
    const data = JSON.parse(text);
    return Array.isArray(data?.reports) && data.reports.some(r => r && r.id === id);
  } catch {
    return false;
  }
}

let indexQueue = Promise.resolve();
// Upserts the report in <dataDir>/reports/index.json (one write at a time).
function registerPrivate(dataDir, entry) {
  const run = async () => {
    const file = projectPaths(dataDir, entry.project).reportsIndex;
    const data = (await readJson(file, null)) || { version: 1, reports: [] };
    if (!Array.isArray(data.reports)) data.reports = [];
    const i = data.reports.findIndex(r => r && r.project === entry.project && r.id === entry.id);
    if (i < 0) data.reports.push(entry);
    else data.reports[i] = { ...data.reports[i], ...entry, created: data.reports[i].created || entry.created };
    await writeJsonAtomic(file, { version: 1, ...data });
  };
  indexQueue = indexQueue.catch(() => {}).then(run);
  return indexQueue;
}

// Saves the run as a report and registers it. Returns
//   { destination: 'private'|'hub', id, dir, file, version, title, type, summary, message }
// runTool({args, cwd}) -> {status, output} runs a Node script (the app's actions.runTool); it is
// used only for a private hub. `outputs` may be passed in; otherwise they are read from the run.
export async function saveRunReport({ root, dataDir, run, profile, runTool, outputs, label, now = new Date() }) {
  if (!run || !RUN_ID_RE.test(String(run.id || ''))) throw httpError(400, 'The run id is not valid.');
  if (!PROJECT_RE.test(String(run.project || ''))) throw httpError(400, 'The run has no valid project name.');
  if (!PIPELINE_RE.test(String(run.pipeline || ''))) throw httpError(400, 'The run has no valid pipeline name.');
  const allow = Array.isArray(profile?.secrets?.allowValues) ? profile.secrets.allowValues : [];
  const outs = outputs || await loadRunOutputs(dataDir, run);
  const title = reportTitle(run, { label, allow });
  const type = reportType(run.pipeline);
  const summary = summaryLine(run, outs, { label });
  const date = localDay(run.createdAt || now) || localDay(now);
  const slug = slugFrom(sanitizeText(redact(requestOf(run), { allow }), TITLE_REQUEST_MAX));
  // Only an explicit "the hub is private" sends a report into the hub.
  const toHub = profile?.privacy?.hubPublic === false;
  const text = `${buildReportMarkdown(run, outs, { allow, title, label, now })}\n${marker(run.id)}\n`;

  if (!toHub) {
    const base = projectPaths(dataDir, run.project).reports;
    const { name, dir } = await pickFolder(base, `${date}_${run.pipeline}-${slug}`, run.id);
    const { file, version } = await writeVersion(dir, text);
    const today = localDay(now);
    await registerPrivate(dataDir, {
      id: name, project: run.project, runId: run.id, pipeline: run.pipeline, title, type, status: 'active',
      created: today, updated: today, folder: `${run.project}/${name}`, summary,
      steps: await stepsOf(dir, `${run.project}/${name}`),
    });
    return {
      destination: 'private', id: name, dir, file, version, title, type, summary,
      message: `Saved privately in the app data folder: reports/${run.project}/${name}/${file}. The hub is public, so it stays out of the hub.`,
    };
  }

  if (!root) throw httpError(500, 'The hub folder is unknown, so the report cannot be saved there.');
  if (typeof runTool !== 'function') throw httpError(500, 'No tool runner was given to register the report.');
  const { name, dir } = await pickFolder(join(root, 'reports'), `${date}_${run.project}-${run.pipeline}-${slug}`, run.id);
  const { file, version } = await writeVersion(dir, text);
  // A folder that isn't registered yet (a first save, or one whose registration failed before)
  // needs the title; a registered one only gets the new summary, so your own edits of its title,
  // project or type in reports.json stay.
  const args = [join(root, 'tools', 'register-report.mjs'), '--folder', `reports/${name}`];
  if (!(await hubRegistered(root, name))) args.push('--title', title, '--project', run.project, '--type', type, '--summary', summary);
  else args.push('--summary', summary);
  const r = await runTool({ args, cwd: root });
  if (!r || r.status !== 0) {
    const why = String(r?.output || 'no output').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw httpError(500, `The report was written to reports/${name}/${file}, but register-report failed: ${why}`);
  }
  return {
    destination: 'hub', id: name, dir, file, version, title, type, summary,
    message: `Saved to reports/${name}/${file} and registered.`,
  };
}
