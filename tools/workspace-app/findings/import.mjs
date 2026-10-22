// Findings import: reads an audit report, the project's records and git, and proposes a status
// for every finding. Nothing is written until you apply the proposal.
//
// The audit is Markdown. Findings come from tables whose first column starts with a finding id
// (the profile's findings.idPattern), and from bullets under a severity heading that name an id
// in parentheses ("The password hint is shown in plain text (X6)."). Severity comes from the nearest ###
// heading (Critical, High, Medium, Low), phases from "### Phase <id>: <label>" lists, and owner
// decisions from the "Open questions" section. Records are the project's own Markdown notes in
// docs.recordsDir; a finished record on the integration branch that names an id means the finding
// is done (a record whose Status says Partly or In progress doesn't count).
//
// Proposed status, in this order: done (a record or an "(audit <id>)" commit subject on the
// integration branch), on-branch (the same, only on an unmerged app/ branch), open (the audit says
// Open or Partly), otherwise the audit's own status. A status a run or you set survives a new
// import unless records or git show the finding fixed, and done never moves back. An override you
// choose at Apply follows the same table as a click (store.transitionProblem): it can't take a
// finding out of a run, off its branch or out of done.
// Audit, record and commit text are data: they only ever become titles, evidence and reasons.
import { readFile } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { jsonHash, sha256Text } from '../core/datadir.mjs';
import {
  BLASTS, SEVERITIES, STATUSES, clearPendingImport, emptyDoc, loadFindings, loadPendingImport, savePendingImport,
  transitionProblem, updateFindings,
} from './store.mjs';

// Used when a profile has no findings.idPattern: ids shaped like C1, H12, Q-H1, R-N2 or W-14.
export const DEFAULT_ID_PATTERN = '\\b[A-Z]{1,3}(?:-[A-Z]{1,3})?-?\\d{1,3}\\b';
export const TITLE_MAX = 80;
export const EVIDENCE_MAX = 600;
// Statuses an import override may choose. In run, on branch and done come from runs and git.
export const OVERRIDE_STATUSES = ['proposed', 'open', 'dismissed'];

const OWNER_RE = /\b(open questions|owner decisions?|questions for the owner|decisions? for the owner)\b/i;
const MARKS_RE = /\*\*|__|[✔✓✅☑]/g;
// A record whose Status line starts like this is not finished, so it doesn't make a finding done.
const UNFINISHED_RE = /^(partly|partial|partially|in progress|wip|draft|open|todo|to do|blocked|not done|started|pending|planned)\b/i;
// Branch and revision names from the profile: no option-like or odd names reach git.
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const RANGE_MAX = 30;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// A regular expression from a profile value. A bad pattern is the profile's fault, so it is a
// 400 that names the profile key, never a raw SyntaxError (500).
function profileRegExp(source, key, flags = '') {
  try {
    return new RegExp(source, flags);
  } catch (e) {
    throw httpError(400, `${key} in the profile is not a valid regular expression: ${e.message}`);
  }
}

// ---- git ----

// Runs git through the injected runner and returns stdout as text. `git` is core/git.mjs's
// git(dir, args, opts) function, or anything with such a .git function (the module itself).
export async function gitText(git, dir, args) {
  const fn = typeof git === 'function' ? git : git && typeof git.git === 'function' ? git.git.bind(git) : null;
  if (!fn) throw new Error('No git runner was given.');
  const out = await fn(dir, args);
  if (typeof out === 'string') return out;
  if (Buffer.isBuffer(out)) return out.toString('utf8');
  return String(out?.stdout ?? '');
}

const lines = text => String(text || '').split(/\r?\n/).filter(Boolean);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Local branch names (refs/heads/...), optionally only those merged into `into`.
export async function branchNames(git, dir, { mergedInto } = {}) {
  const args = ['for-each-ref', '--format=%(refname)'];
  if (mergedInto) args.push(`--merged=${mergedInto}`);
  args.push('refs/heads/');
  return lines(await gitText(git, dir, args)).map(r => r.replace(/^refs\/heads\//, ''));
}

// [{sha, subject}] for a revision range, newest first.
export async function commitSubjects(git, dir, range, { max = 2000 } = {}) {
  const out = await gitText(git, dir, ['log', `-n${max}`, '--format=%H%x1f%s', range, '--']);
  return lines(out).map(l => {
    const [sha, subject = ''] = l.split('\x1f');
    return { sha, subject };
  });
}

// A branch or revision name from the profile, checked before it reaches git. Throws (400).
export function checkRef(ref, what) {
  const s = String(ref ?? '');
  if (!REF_RE.test(s)) throw httpError(400, `The profile's ${what} "${s.slice(0, 80)}" is not a branch or commit name.`);
  return s;
}

async function refExists(git, dir, ref) {
  try {
    await gitText(git, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// ---- text helpers ----

// An id matcher from a pattern string or RegExp: all(text) lists the ids in text (no repeats),
// lead matches one at the start. A bad pattern throws (400, naming findings.idPattern).
export function idFinder(idPattern) {
  const src = idPattern instanceof RegExp ? idPattern.source : String(idPattern || '').trim() || DEFAULT_ID_PATTERN;
  const key = 'findings.idPattern';
  const all = profileRegExp(src, key, 'g');
  const lead = profileRegExp(`^(?:${src})`, key);
  const whole = profileRegExp(`^(?:${src})$`, key);
  return { all: text => [...new Set(String(text || '').match(all) || [])], lead, whole: id => whole.test(String(id || '')) };
}

// The ids inside a range a fix plan names ("R-9 to R-13", "A-4 through A-10"): only the ones
// between the two ends, because `all` already finds the ends. Both ends must be ids with the same
// prefix, and a range covers at most RANGE_MAX ids.
export function rangeIds(text, finder) {
  const out = [];
  const re = /\b([A-Z]{1,3}(?:-[A-Z]{1,3})?-?)(\d{1,3})\s+(?:to|through|thru|–|—)\s+\1(\d{1,3})\b/g;
  for (const m of cleanCell(text).matchAll(re)) {
    const a = Number(m[2]);
    const b = Number(m[3]);
    if (!(b > a) || b - a > RANGE_MAX) continue;
    if (!finder.whole(`${m[1]}${m[2]}`) || !finder.whole(`${m[1]}${m[3]}`)) continue;
    for (let n = a + 1; n < b; n++) {
      const id = `${m[1]}${n}`;
      if (finder.whole(id)) out.push(id);
    }
  }
  return [...new Set(out)];
}

// Cell or heading text without bold markers, check marks and backticks, on one line.
export function cleanCell(text) {
  return String(text || '').replace(MARKS_RE, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

// Like cleanCell, but keeps backticks (evidence shows code names as written).
const cleanEvidence = text => String(text || '').replace(MARKS_RE, '').replace(/\s+/g, ' ').trim();

function cap(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// The ids at the start of a cell ("T-7, T-8 / T-9 label"), and the text after them.
export function leadingIds(text, lead) {
  let rest = String(text || '');
  const ids = [];
  for (;;) {
    const m = lead.exec(rest);
    if (!m || !m[0]) break;
    ids.push(m[0]);
    rest = rest.slice(m[0].length);
    const sep = /^\s*(?:,|\/|\+|&|\band\b)\s*/i.exec(rest);
    if (sep && lead.test(rest.slice(sep[0].length))) {
      rest = rest.slice(sep[0].length);
      continue;
    }
    break;
  }
  return { ids: [...new Set(ids)], rest: rest.replace(/^[\s:·.,;\-–—]+/, '').trim() };
}

// A title of at most 80 characters: the first sentence when it is short enough, otherwise the
// text cut at the last clause break (comma, semicolon, colon, dash) or else the last word that
// fits. Backticks and bold markers are removed.
export function titleFrom(text, max = TITLE_MAX) {
  let s = cleanCell(text);
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(s);
  if (sentence && sentence[1].length <= max && sentence[1].length >= 12) s = sentence[1];
  const tidy = x => x.replace(/[.:;,\s–—-]+$/, '');
  s = tidy(s);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  let clause = -1;
  for (const m of head.matchAll(/[,;:]\s|\s[–—-]\s/g)) clause = m.index;
  if (clause >= 30) return tidy(head.slice(0, clause));
  const space = head.lastIndexOf(' ');
  const cut = space > max / 2 ? head.slice(0, space) : s.slice(0, max);
  return tidy(cut.replace(/\s+(?:and|or|but|so|which|that|the|a|an|to|of|with|for)$/i, ''));
}

export function severityWord(text) {
  const m = /^(critical|high|medium|low)\b/i.exec(cleanCell(text));
  return m ? m[1].toLowerCase() : null;
}

// The common audit convention C1/H2/M3/L4 when no heading gives the severity.
export function severityFromId(id) {
  const m = /^([CHML])-?\d+$/.exec(String(id || ''));
  return m ? { C: 'critical', H: 'high', M: 'medium', L: 'low' }[m[1]] : null;
}

// The audit's own status word, normalized: fixed, partly, open, dismissed, unknown (or null).
export function auditStatus(text) {
  const s = cleanCell(text).toLowerCase();
  if (!s) return null;
  if (/^(fixed|done|closed|resolved|merged)\b/.test(s)) return 'fixed';
  if (/^(partly|partial|partially|in progress)\b/.test(s)) return 'partly';
  if (/^(open|todo|to do|not fixed|unfixed|new|still open|regressed)\b/.test(s)) return 'open';
  if (/^(won'?t fix|wontfix|dismissed|accepted risk|not an issue|invalid)\b/.test(s)) return 'dismissed';
  return 'unknown';
}

// A rough blast radius from the Where cell: one file is small, a few files or one folder are
// medium, many files or "and others" are large. No location means medium. A heuristic, labelled
// as such in the proposal.
export function blastFrom(where) {
  const s = String(where || '');
  if (!s.trim()) return 'medium';
  if (/\b(and others|\d+\s+others|and more|everywhere)\b/i.test(s)) return 'large';
  const tokens = new Set(s.match(/[\w.@-]*[\w-]+\/[\w./*@-]*|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|prisma|sql|ya?ml|py|css)\b/g) || []);
  let weight = 0;
  for (const t of tokens) weight += /\.[a-z]{1,6}$/i.test(t.replace(/[/*]+$/, '')) && !/[*]$/.test(t) ? 1 : 2;
  if (weight >= 4) return 'large';
  if (weight >= 2) return 'medium';
  return 'small';
}

function phaseHeading(text) {
  const m = /^phase\s+([0-9]+(?:\.[0-9]+)*[a-z]?)\b\s*(?:[:.\-–—]\s*(.*))?$/i.exec(cleanCell(text));
  if (!m) return null;
  const name = String(m[2] || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { id: m[1], label: name ? `Phase ${m[1]}: ${name}` : `Phase ${m[1]}` };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = cells => cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));

function columnIndexes(header) {
  const find = re => header.findIndex(h => re.test(h));
  return {
    problem: find(/^(problem|finding|issue|title|summary|description)$/),
    note: find(/^(note|notes|comment|comments|details)$/),
    status: find(/^(status|state)$/),
    where: find(/^(where|location|file|files|path|paths)$/),
    fix: find(/^(fix|recommendation|suggested fix|remedy)$/),
    severity: find(/^(severity|sev|priority)$/),
    phase: find(/^phase$/),
  };
}

// ---- the audit ----

// Parses an audit report. Returns { findings, phases, warnings }:
//   findings: [{id, title, severity, severitySource, statusInAudit, statusText, phase,
//               ownerDecision, evidence, where, blast, area, section}] in audit order
//   phases:   [{id, label, ids}]
export function parseAudit(md, { idPattern } = {}) {
  const finder = idFinder(idPattern);
  const rows = String(md || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const found = new Map();
  const phases = [];
  const phaseOf = new Map();
  const ownerIds = new Set();
  const listed = new Set();
  const soft = new Set(); // ids inside a range: kept only when the audit describes them
  let section = '';
  let severity = null;
  let phase = null;
  let ownerSection = false;
  let table = null;
  let group = '';
  let inList = false;

  const add = f => {
    const prev = found.get(f.id);
    if (!prev) { found.set(f.id, f); return; }
    for (const k of ['title', 'statusInAudit', 'statusText', 'where', 'area', 'evidence', 'phaseColumn']) {
      if (!prev[k] && f[k]) prev[k] = f[k];
    }
    const strong = s => s === 'column' || s === 'heading';
    if (f.severity && (!prev.severity || (strong(f.severitySource) && !strong(prev.severitySource)))) {
      prev.severity = f.severity;
      prev.severitySource = f.severitySource;
    }
  };
  const notePhase = (ids, isSoft = false) => {
    for (const id of ids) {
      (isSoft ? soft : listed).add(id);
      if (!phaseOf.has(id)) phaseOf.set(id, phase);
      const p = phases.find(x => x.id === phase);
      if (p && !p.ids.includes(id)) p.ids.push(id);
    }
  };
  const finding = (id, fields, sev, sevSource) => {
    const s = sev || severityFromId(id);
    add({
      id, title: '', statusInAudit: null, statusText: '', where: '', area: '', evidence: '', phaseColumn: null,
      ...fields,
      severity: s, severitySource: sev ? sevSource : s ? 'id' : null, section,
    });
  };

  const tableRow = cells => {
    const { ids, rest } = leadingIds(cleanCell(cells[0]), finder.lead);
    if (!ids.length) return;
    const c = table.cols;
    const cell = i => (i >= 0 && i < cells.length ? cells[i] : '');
    const problem = cell(c.problem);
    const note = cell(c.note);
    const where = cell(c.where);
    const fix = cell(c.fix);
    const statusText = cleanCell(cell(c.status));
    const fallback = c.problem < 0 && c.note < 0 && c.status < 0 ? cell(1) : '';
    const title = titleFrom(c.problem >= 0 ? problem : rest || note || fallback);
    const evidence = c.problem >= 0
      ? [cleanEvidence(problem), where && `Where: ${cleanEvidence(where)}`, fix && `Fix: ${cleanEvidence(fix)}`]
      : [statusText && `Audit status: ${statusText}.`, cleanEvidence(note || fallback)];
    const colSeverity = severityWord(cell(c.severity));
    const phaseText = cleanCell(cell(c.phase)).replace(/^phase\s+/i, '');
    for (const id of ids) {
      finding(id, {
        title: title || ids.join(', '), statusInAudit: auditStatus(statusText), statusText,
        where: cleanEvidence(where), evidence: cap(evidence.filter(Boolean).join(' '), EVIDENCE_MAX),
        phaseColumn: phaseText || null,
      }, colSeverity || severity, colSeverity ? 'column' : 'heading');
    }
  };

  const bullet = (text, indent) => {
    const label = /^\*\*([^*]+?)\*\*:?\s*$/.exec(text.trim());
    if (label) {
      if (indent === 0) group = cleanCell(label[1]).replace(/:$/, '');
      return;
    }
    if (indent === 0) group = '';
    const clean = cleanCell(text);
    const lead = leadingIds(clean, finder.lead);
    if (lead.ids.length && lead.rest) {
      for (const id of lead.ids) finding(id, { title: titleFrom(lead.rest), evidence: cap(cleanEvidence(text), EVIDENCE_MAX), area: group }, severity, 'heading');
      return;
    }
    for (const m of clean.matchAll(/\(([^()]*)\)/g)) {
      const inner = leadingIds(m[1].trim(), finder.lead);
      if (!inner.ids.length || inner.rest) continue;
      const before = clean.slice(0, m.index).trim();
      for (const id of inner.ids) {
        finding(id, { title: titleFrom(before || clean), evidence: cap(cleanEvidence(text), EVIDENCE_MAX), area: group }, severity, 'heading');
      }
    }
  };

  let fence = false;
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, '');
    // Code blocks are quoted material: a "#" or "|" inside one is not structure.
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; table = null; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = cleanCell(h[2]);
      table = null;
      group = '';
      inList = false;
      if (level <= 2) {
        section = text;
        severity = null;
        phase = null;
        ownerSection = OWNER_RE.test(text);
      }
      if (level === 3) {
        severity = severityWord(text);
        phase = null;
      }
      if (level === 2 || level === 3) {
        const p = phaseHeading(text);
        if (p) {
          phase = p.id;
          severity = null;
          if (!phases.some(x => x.id === p.id)) phases.push({ ...p, ids: [] });
        }
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = splitRow(line);
      if (!table) {
        const header = cells.map(x => cleanCell(x).toLowerCase());
        table = { header, cols: columnIndexes(header) };
      } else if (!isSeparator(cells)) {
        tableRow(cells);
      }
      continue;
    }
    table = null;
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      inList = true;
      const ids = finder.all(li[2]);
      if (phase) {
        notePhase(ids);
        notePhase(rangeIds(li[2], finder), true);
      }
      if (ownerSection) ids.forEach(id => ownerIds.add(id));
      if (severity && !phase && !ownerSection) bullet(li[2], li[1].length);
      continue;
    }
    if (inList && /^\s+\S/.test(line)) {
      const ids = finder.all(line);
      if (phase) {
        notePhase(ids);
        notePhase(rangeIds(line, finder), true);
      }
      if (ownerSection) ids.forEach(id => ownerIds.add(id));
      continue;
    }
    if (line.trim()) inList = false;
  }

  const warnings = [];
  const noSeverity = [];
  const findings = [...found.values()].map(f => {
    let { severity: sev, severitySource: src } = f;
    if (!sev) {
      sev = 'medium';
      src = 'default';
      noSeverity.push(f.id);
    }
    const { phaseColumn, ...rest } = f;
    return {
      ...rest, severity: sev, severitySource: src,
      phase: phaseColumn || phaseOf.get(f.id) || null,
      ownerDecision: ownerIds.has(f.id),
      blast: blastFrom(f.where),
    };
  });
  if (noSeverity.length) warnings.push(`No severity found for ${noSeverity.join(', ')}; medium assumed.`);
  const orphans = [...listed].filter(id => !found.has(id));
  if (orphans.length) warnings.push(`The phase lists name ${orphans.join(', ')}, which no table row or bullet describes; they were left out.`);
  for (const p of phases) p.ids = p.ids.filter(id => found.has(id) || listed.has(id));
  return { findings, phases, warnings };
}

// ---- records ----

const posixDir = dir => String(dir || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

function isRecordPath(p, dir, nameRe) {
  if (!p.startsWith(`${dir}/`) || !/\.md$/i.test(p)) return false;
  const name = posix.basename(p);
  if (/^readme\.md$/i.test(name)) return false;
  return nameRe ? nameRe.test(name) : true;
}

// One record's facts: { title, ids, statusLine, date }. Ids come from the H1's parentheses, the
// Status line and the first section (everything before the second "## " heading).
export function parseRecord(text, { idPattern } = {}) {
  const finder = idFinder(idPattern);
  const rows = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  let seenH1 = false;
  let statusLine = '';
  let date = null;
  let sections = 0;
  const h1Ids = [];
  const first = [];
  for (const row of rows) {
    const h1 = /^#\s+(.*)$/.exec(row);
    if (h1 && !seenH1) {
      seenH1 = true;
      title = cleanCell(h1[1].replace(/\s*\(([^()]*)\)/g, (all, inner) => {
        const ids = finder.all(inner);
        h1Ids.push(...ids);
        return ids.length ? '' : all;
      }));
      continue;
    }
    if (/^##\s/.test(row)) sections++;
    if (sections < 2) first.push(row);
    const plain = row.replace(/\*\*|__/g, '');
    const st = /^\s*(?:[-*]\s+)?status\s*:\s*(.+)$/i.exec(plain);
    if (st && !statusLine) statusLine = cleanCell(st[1]);
    const dt = /^\s*(?:[-*]\s+)?(?:date|merged|completed|closed)\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(plain);
    if (dt && !date) date = dt[1];
  }
  const ids = [...new Set([...h1Ids, ...finder.all(statusLine), ...finder.all(first.join('\n'))])];
  return { title, ids, statusLine, date };
}

// When each record file was first added on `ref`: Map path -> YYYY-MM-DD.
async function addDates(git, dir, ref, rel) {
  const out = await gitText(git, dir, ['log', '--format=%x1e%cs', '--name-only', '--diff-filter=A', ref, '--', rel]);
  const dates = new Map();
  for (const chunk of out.split('\x1e')) {
    const [date, ...files] = lines(chunk);
    for (const f of files) dates.set(f.trim(), date);
  }
  return dates;
}

// The records in `recordsDir` as committed on `ref` (default HEAD, so uncommitted notes never
// count). Returns [{name, path, title, ids, statusLine, date}] sorted by name.
//   name: the file name without .md; date: the record's Date line, else the day it was added.
//   files: limit to these paths (already known to be on ref); nameRe: profile docs.recordNameRe.
// A records folder outside the repository or a bad name rule throws (400, naming the profile key).
export async function scanRecords({ git, dir, recordsDir, ref = 'HEAD', idPattern, nameRe, files }) {
  const rel = posixDir(recordsDir);
  if (!rel || rel.split('/').includes('..') || /^[a-z]:|^\//i.test(rel)) {
    throw httpError(400, `docs.recordsDir in the profile ("${String(recordsDir ?? '').slice(0, 120)}") is not a folder inside the repository.`);
  }
  const re = nameRe instanceof RegExp ? nameRe : nameRe ? profileRegExp(nameRe, 'docs.recordNameRe') : null;
  const listing = files || lines(await gitText(git, dir, ['ls-tree', '-r', '--name-only', ref, '--', rel]));
  const paths = listing.map(p => p.trim()).filter(p => isRecordPath(p, rel, re));
  if (!paths.length) return [];
  const dates = await addDates(git, dir, ref, rel);
  const out = await mapLimit(paths, 6, async p => {
    const r = parseRecord(await gitText(git, dir, ['show', `${ref}:${p}`]), { idPattern });
    return { name: posix.basename(p).replace(/\.md$/i, ''), path: p, title: r.title, ids: r.ids, statusLine: r.statusLine, date: r.date || dates.get(p) || null };
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Ids a commit subject names as "(audit X1)" or "(audit X1, X3)".
export function auditMentions(subject, finder) {
  const ids = [];
  for (const m of String(subject || '').matchAll(/\(audit\b[:\s]*([^)]*)\)/gi)) ids.push(...finder.all(m[1]));
  return [...new Set(ids)];
}

// ---- the proposal ----

// True when a record's Status line says the work isn't finished ("Partly", "In progress", ...).
export function recordUnfinished(statusLine) {
  return UNFINISHED_RE.test(cleanCell(statusLine));
}

// Evidence per finding id: Map id -> { records, commits, why, notes }. A finding counts as fixed
// `where` only with at least one finished record or one "(audit <id>)" commit subject; an
// unfinished record only adds a note.
function evidenceFor({ records, commits, auditIds, finder, where }) {
  const map = new Map();
  const entry = id => {
    if (!map.has(id)) map.set(id, { records: [], commits: [], why: [], notes: [] });
    return map.get(id);
  };
  for (const r of records) {
    for (const id of r.ids) {
      if (!auditIds.has(id)) continue;
      const e = entry(id);
      const status = r.statusLine ? ` (Status: ${cap(r.statusLine, 80)})` : '';
      if (recordUnfinished(r.statusLine)) {
        e.notes.push(`record ${r.name} ${where} names it but is not finished${status}; not counted as fixed`);
        continue;
      }
      e.records.push(r.name);
      e.why.push(`record ${r.name} ${where}${status}`);
    }
  }
  for (const c of commits) {
    for (const id of auditMentions(c.subject, finder)) {
      if (!auditIds.has(id)) continue;
      const e = entry(id);
      e.commits.push(c.sha.slice(0, 7));
      e.why.push(`commit ${c.sha.slice(0, 7)} ${where} names (audit ${id})`);
    }
  }
  return map;
}

const proves = e => !!e && (e.records.length > 0 || e.commits.length > 0);

function computedStatus(f, done, branch) {
  if (proves(done)) return { status: 'done', source: done.records.length ? 'record' : 'git', why: done.why };
  if (proves(branch)) return { status: 'on-branch', source: 'git', why: branch.why, branch: branch.branch };
  const said = f.statusText ? `audit: ${f.statusText}` : '';
  switch (f.statusInAudit) {
    case 'fixed': return { status: 'done', source: 'audit', why: [said] };
    case 'dismissed': return { status: 'dismissed', source: 'audit', why: [said] };
    case 'open': case 'partly': return { status: 'open', source: 'audit', why: [said] };
    case 'unknown': return { status: 'open', source: 'audit', why: [`audit status "${f.statusText}" not recognised; open assumed`] };
    default: return { status: 'open', source: 'audit', why: ['audit: new finding, no status given'] };
  }
}

// Statuses set by runs and by you survive a new import, unless records or git show the finding
// is fixed. Done is never moved back. Returns why the current status stays, or null.
function keepCurrent(cur, computed) {
  if (!cur || computed.status === cur.status) return null;
  if (cur.status === 'done') return 'already done';
  if (computed.status === 'done' && computed.source !== 'audit') return null;
  if (cur.status === 'in-run') return `a run is working on it${cur.runId ? ` (${cur.runId})` : ''}`;
  if (cur.status === 'dismissed') return 'you dismissed it';
  if (cur.status === 'on-branch' && computed.status !== 'done') return `its fix is on ${cur.branch || 'a branch'}, not merged yet`;
  if (cur.statusSource === 'user') return `you set it to ${cur.status}`;
  return null;
}

// Builds the import proposal. Nothing is written. Returns
//   { rows: [{id, title, severity, phase, current, proposed, why, statusSource, change, records,
//             commits, branch, evidence, blast, area, ownerDecision, statusInAudit}],
//     hash, phases, source, warnings, counts }
// `hash` covers the rows, phases and source, so apply can check you confirmed this exact proposal.
export async function proposeImport({ profile, mainDir, auditText, current, git }) {
  const idPattern = profile?.findings?.idPattern;
  const finder = idFinder(idPattern);
  const parsed = parseAudit(auditText, { idPattern });
  const integration = profile?.git?.integrationBranch;
  if (!integration) throw httpError(400, 'The profile has no git.integrationBranch, so the import cannot tell what is merged.');
  checkRef(integration, 'git.integrationBranch');
  if (!(await refExists(git, mainDir, integration))) throw httpError(400, `The integration branch ${integration} does not exist in the checkout.`);
  const prefix = profile.git.branchPrefix || 'app/';
  const recordsDir = profile.docs?.recordsDir || '';
  const nameRe = profile.docs?.recordNameRe ? profileRegExp(profile.docs.recordNameRe, 'docs.recordNameRe') : null;
  const baseline = profile.findings?.auditBaseline || profile.git?.auditBaseline || '';
  if (baseline) checkRef(baseline, 'findings.auditBaseline');
  const auditIds = new Set(parsed.findings.map(f => f.id));
  const warnings = [...parsed.warnings];

  const records = recordsDir ? await scanRecords({ git, dir: mainDir, recordsDir, ref: integration, idPattern, nameRe }) : [];
  if (!recordsDir) warnings.push('The profile has no docs.recordsDir, so records were not read.');
  let range = integration;
  if (baseline && (await refExists(git, mainDir, baseline))) range = `${baseline}..${integration}`;
  else if (baseline) warnings.push(`The audit baseline ${baseline} was not found; all commit subjects on ${integration} were read.`);
  const subjects = await commitSubjects(git, mainDir, range);
  const done = evidenceFor({ records, commits: subjects, auditIds, finder, where: `on ${integration}` });

  const merged = new Set(await branchNames(git, mainDir, { mergedInto: integration }));
  const unmerged = (await branchNames(git, mainDir)).filter(b => b.startsWith(prefix) && !merged.has(b)).sort();
  const onBranch = new Map();
  for (const branch of unmerged) {
    if (!REF_RE.test(branch)) {
      warnings.push(`The branch name ${cap(branch, 80)} looks odd, so it was not read.`);
      continue;
    }
    const changed = recordsDir
      ? lines(await gitText(git, mainDir, ['diff', '--name-only', '--diff-filter=AM', `${integration}...${branch}`, '--', posixDir(recordsDir)]))
      : [];
    const recs = changed.length ? await scanRecords({ git, dir: mainDir, recordsDir, ref: branch, idPattern, nameRe, files: changed }) : [];
    const subs = await commitSubjects(git, mainDir, `${integration}..${branch}`);
    const ev = evidenceFor({ records: recs, commits: subs, auditIds, finder, where: `only on ${branch}, not merged into ${integration}` });
    for (const [id, e] of ev) {
      const have = onBranch.get(id);
      if (!have || (!proves(have) && proves(e))) onBranch.set(id, { ...e, branch, notes: [...(have?.notes || []), ...e.notes] });
      else have.notes.push(...e.notes);
    }
  }

  const byId = new Map((current?.findings || []).map(f => [f.id, f]));
  const empty = { records: [], commits: [], notes: [] };
  const rows = parsed.findings.map(f => {
    const cur = byId.get(f.id) || null;
    const onMain = done.get(f.id);
    const onApp = onBranch.get(f.id);
    const computed = computedStatus(f, onMain, onApp);
    const kept = keepCurrent(cur, computed);
    const ev = proves(onMain) ? onMain : proves(onApp) ? onApp : empty;
    const why = kept ? [`kept ${cur.status}: ${kept}`, ...computed.why] : [...computed.why];
    why.push(...(onMain?.notes || []), ...(onApp?.notes || []));
    if (f.ownerDecision) why.push('waits on an owner decision (open questions)');
    const proposed = kept ? cur.status : computed.status;
    return {
      id: f.id, title: f.title, severity: f.severity, phase: f.phase,
      current: cur ? cur.status : null, proposed, change: !cur || cur.status !== proposed,
      why: why.filter(Boolean), statusSource: kept ? cur.statusSource || 'user' : computed.source,
      records: ev.records, commits: ev.commits,
      branch: kept ? cur.branch || null : computed.branch || null,
      evidence: f.evidence, blast: f.blast, area: f.area, ownerDecision: f.ownerDecision, statusInAudit: f.statusInAudit,
    };
  });
  const phases = parsed.phases.map(p => ({ id: p.id, label: p.label }));
  const source = {
    audit: String(profile?.findings?.audit || ''),
    auditSha256: `sha256:${sha256Text(String(auditText || ''))}`,
    baselineCommit: baseline || null,
  };
  const hash = jsonHash({ rows, phases, source });
  const counts = { total: rows.length, changed: rows.filter(r => r.change).length };
  for (const s of STATUSES) counts[s] = rows.filter(r => r.proposed === s).length;
  return { rows, hash, phases, source, warnings, counts };
}

// Refuses (400) an override the import may not set. An override equal to the row's proposal is
// the proposal itself. Any other override must be in OVERRIDE_STATUSES and, for a finding already
// on the board, be a move you could make with a click (store.transitionProblem with by 'user'):
// proposed or dismissed to open, anything to dismissed. So an override never takes a finding out
// of a live run, off its branch or out of done.
function checkOverrides(ov, rows, byId) {
  for (const [id, status] of Object.entries(ov)) {
    const row = rows.find(r => r.id === id);
    if (!row) throw httpError(400, `The proposal has no finding ${id}.`);
    if (status === row.proposed) continue;
    if (!OVERRIDE_STATUSES.includes(status)) {
      throw httpError(400, `${id}: the import can't set ${status}. In run, on branch and done come from runs, records and git.`);
    }
    const cur = byId.get(id);
    const problem = cur && cur.status !== status ? transitionProblem(cur.status, status, 'user') : '';
    if (problem) throw httpError(400, `${id} is ${cur.status}, so the import can't set it to ${status}. ${problem}`);
  }
}

// Applies an import proposal to the current board and returns the new document (not saved).
//   accept: 'all' or [id]; overrides: { id: status } (see checkOverrides). Every status change
//   gets a history entry with by: 'import'; a move to on-branch also records the branch and the
//   commits it was found with, so reconcile knows which fix to look for on the integration branch.
// An overridden row keeps its audit fields and records but not the commits and branch git found:
// those were evidence for the status you set aside.
export function applyImport(current, proposal, { accept = 'all', overrides = {}, at = new Date().toISOString() } = {}) {
  const rows = Array.isArray(proposal?.rows) ? proposal.rows : [];
  const ids = new Set(rows.map(r => r.id));
  let chosen;
  if (accept === 'all') chosen = ids;
  else if (Array.isArray(accept)) {
    const unknown = accept.filter(id => !ids.has(id));
    if (unknown.length) throw httpError(400, `The proposal has no finding ${unknown.join(', ')}.`);
    chosen = new Set(accept);
  } else throw httpError(400, 'accept must be "all" or a list of finding ids.');
  const base = current && Array.isArray(current.findings) ? current : emptyDoc(current?.project || '');
  const byId = new Map(base.findings.map(f => [f.id, f]));
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  checkOverrides(ov, rows, byId);

  const fromAudit = [];
  for (const row of rows) {
    const cur = byId.get(row.id);
    if (!chosen.has(row.id)) {
      if (cur) fromAudit.push(cur);
      continue;
    }
    const overridden = Object.prototype.hasOwnProperty.call(ov, row.id) && ov[row.id] !== row.proposed;
    const status = overridden ? ov[row.id] : row.proposed;
    const reason = overridden ? `set to ${status} at import` : cap((row.why || []).join('; '), 300);
    const commits = overridden ? [] : row.commits || [];
    const branch = overridden ? null : row.branch || null;
    const entry = { at, from: cur ? cur.status : null, to: status, by: 'import', reason };
    if (status === 'on-branch') {
      if (branch) entry.branch = branch;
      if (commits.length) entry.commits = [...commits];
    }
    const auditFields = {
      title: row.title, severity: SEVERITIES.includes(row.severity) ? row.severity : 'medium', phase: row.phase ?? null,
      area: row.area || '', blast: BLASTS.includes(row.blast) ? row.blast : 'medium', ownerDecision: !!row.ownerDecision,
      evidence: cap(row.evidence || '', EVIDENCE_MAX),
    };
    if (cur) {
      const next = { ...cur, ...auditFields };
      next.records = [...new Set([...(cur.records || []), ...(row.records || [])])];
      next.commits = [...new Set([...(cur.commits || []), ...commits])];
      if (status !== cur.status) {
        next.status = status;
        next.statusSource = overridden ? 'user' : row.statusSource;
        if (branch) next.branch = branch;
        next.history = [...(cur.history || []), entry];
      }
      fromAudit.push(next);
    } else {
      fromAudit.push({
        id: row.id, ...auditFields, status, statusSource: overridden ? 'user' : row.statusSource,
        estimateMin: null, records: row.records || [], commits: [...commits], branch,
        runId: null, notes: '', history: [entry],
      });
    }
  }
  const others = base.findings.filter(f => !ids.has(f.id));
  const phases = [...(proposal.phases || []).map(p => ({ id: String(p.id), label: p.label }))];
  for (const p of base.phases || []) if (!phases.some(x => x.id === String(p.id))) phases.push(p);
  return {
    ...base,
    version: 1,
    source: { ...(proposal.source || {}), importedAt: at, confirmedAt: at },
    phases,
    findings: [...fromAudit, ...others],
  };
}

// ---- the two steps the routes take ----

// Step 1: reads the profile's audit file, builds a proposal and keeps it as the pending import.
// Returns the proposal. Throws 400 when the profile names no audit or it can't be read.
export async function prepareImport({ dataDir, project, profile, mainDir, git }) {
  const auditPath = profile?.findings?.audit;
  if (!auditPath) throw httpError(400, 'The profile has no findings.audit path, so there is nothing to import.');
  if (!isAbsolute(String(auditPath))) throw httpError(400, 'findings.audit in the profile must be a full path to the audit file.');
  let auditText;
  try {
    auditText = await readFile(auditPath, 'utf8');
  } catch (e) {
    throw httpError(400, `Could not read the audit file (${e.code || e.message}). Check findings.audit in the profile.`);
  }
  const current = await loadFindings(dataDir, project);
  const proposal = await proposeImport({ profile, mainDir, auditText, current, git });
  await savePendingImport(dataDir, project, proposal, { baseHash: current.hash });
  return proposal;
}

// Step 2: applies the pending proposal you confirmed. `hash` must be the proposal's hash (409
// otherwise), and the board must be unchanged since the proposal was made (409 otherwise).
// Returns { doc, message }.
export async function applyPendingImport({ dataDir, project, hash, accept = 'all', overrides = {}, at = new Date().toISOString() }) {
  const pending = await loadPendingImport(dataDir, project);
  if (!pending || !pending.proposal) throw httpError(409, 'There is no import waiting. Run Import findings first.');
  if (pending.proposal.hash !== hash) throw httpError(409, 'The import proposal changed since you looked at it. Look at it again, then apply.');
  let applied = 0;
  const result = await updateFindings(dataDir, project, doc => {
    if ((doc.hash || null) !== (pending.baseHash || null)) {
      throw httpError(409, 'The findings changed since the proposal was made. Run Import findings again.');
    }
    const next = applyImport(doc, pending.proposal, { accept, overrides, at });
    applied = accept === 'all' ? pending.proposal.rows.length : accept.length;
    return next;
  });
  await clearPendingImport(dataDir, project);
  const total = pending.proposal.rows.length;
  return { doc: result.doc, message: `Applied ${applied} of ${total} findings.` };
}
