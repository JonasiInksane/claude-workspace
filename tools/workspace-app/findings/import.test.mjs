// Tests for findings/import.mjs: the audit parser, record scanning, the import proposal against a
// temporary git repo with merged and unmerged branches, applying a proposal, and the two-step
// prepare/apply flow with its 409s.
// Run: node --test tools/workspace-app/findings/import.test.mjs
// The audit and records are synthetic (test/fixtures/findings/); every repo and data folder is a
// temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../core/git.mjs';
import { commitAll, fakeProfile, makeRepo, runGit, tempDir, writeFiles } from '../test/helpers.mjs';
import {
  DEFAULT_ID_PATTERN, applyImport, applyPendingImport, auditMentions, auditStatus, blastFrom, checkRef, cleanCell, gitText,
  idFinder, leadingIds, parseAudit, parseRecord, prepareImport, proposeImport, rangeIds, recordUnfinished, scanRecords,
  severityFromId, titleFrom,
} from './import.mjs';
import { emptyDoc, findingsFile, importFile, loadFindings, loadPendingImport, saveFindings } from './store.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'findings');
const fx = rel => readFileSync(join(FIX, rel), 'utf8');
const AUDIT = fx('audit.md');
const AT = '2026-01-20T10:00:00.000Z';

// ---------------------------------------------------------------- the audit parser

test('parseAudit reads every finding of the synthetic audit with severity, status, phase and owner flag', () => {
  const { findings, phases, warnings } = parseAudit(AUDIT);
  const rows = findings.map(f => [f.id, f.severity, f.severitySource, f.statusInAudit, f.phase, f.ownerDecision]);
  assert.deepEqual(rows, [
    ['C7', 'critical', 'id', 'fixed', null, false],
    ['H21', 'high', 'id', 'open', '1', false],
    ['H23', 'high', 'id', 'partly', '1', false],
    ['H29', 'high', 'id', 'open', '2', false],
    ['M4', 'medium', 'id', 'partly', null, false],
    ['L2', 'low', 'id', 'open', null, false],
    ['K-3', 'medium', 'default', 'fixed', '2', false],
    ['K-4', 'medium', 'default', 'fixed', '2', false],
    ['K-5', 'medium', 'default', 'fixed', '2', false],
    ['W-2', 'medium', 'default', 'open', '2', false],
    ['W-6', 'medium', 'default', 'open', '2', false],
    ['W-7', 'medium', 'default', 'open', '2', false],
    ['D-1', 'medium', 'default', 'open', null, false],
    ['D-9', 'medium', 'default', 'open', null, false],
    ['Q-8', 'medium', 'default', 'dismissed', null, false],
    ['X1', 'critical', 'heading', null, '1', false],
    ['X2', 'critical', 'heading', null, '1', false],
    ['X3', 'high', 'heading', null, '1', true],
    ['R-N1', 'high', 'heading', null, '2', false],
    ['Q-H1', 'high', 'heading', null, '1.5', false],
    ['Q-H2', 'high', 'heading', null, '1.5', false],
    ['X6', 'medium', 'heading', null, '2', false],
    ['X7', 'medium', 'heading', null, '2', false],
    ['R-M1', 'medium', 'heading', null, '1', true],
    ['L-3', 'low', 'heading', null, null, false],
  ]);
  assert.deepEqual(phases.map(p => [p.id, p.label]), [['1', 'Phase 1: access'], ['1.5', 'Phase 1.5: tests green again'], ['2', 'Phase 2: holds and fines']]);
  assert.deepEqual(phases[0].ids, ['X1', 'H23', 'X2', 'X3', 'H21', 'R-M1']);
  assert.ok(phases[2].ids.includes('K-4'), 'K-4 sits inside "K-3 to K-5"');
  assert.ok(!phases[2].ids.includes('Z-41'), 'an id inside a range that the audit never describes is dropped silently');
  assert.deepEqual(warnings, [
    'No severity found for K-3, K-4, K-5, W-2, W-6, W-7, D-1, D-9, Q-8; medium assumed.',
    'The phase lists name Z-99, Z-40, Z-42, which no table row or bullet describes; they were left out.',
  ]);
});

test('parseAudit takes titles from the Problem cell, the id cell label or the Note, without backticks and at most 80 characters', () => {
  const byId = new Map(parseAudit(AUDIT).findings.map(f => [f.id, f]));
  assert.equal(byId.get('C7').title, 'loan export authz', 'a v1 row: the label after the id');
  assert.equal(byId.get('H21').title, 'fine waivers in fines.waive', 'backticks removed');
  assert.equal(byId.get('W-6').title, 'Overdue days are counted three different ways', 'no label: the Note');
  assert.equal(byId.get('K-4').title, 'K-3, K-4, K-5', 'no label and no Note: the ids');
  assert.equal(byId.get('X1').title, 'The public loan export accepts a memberId from the query string', 'bold removed, cut at a clause');
  assert.equal(byId.get('Q-H1').title, 'The reminder tests fail on the first day of every month', 'the first sentence, without its full stop');
  assert.equal(byId.get('X6').title, 'The password hint is shown in plain text', 'a grouped bullet: the text before the id');
  assert.equal(byId.get('X6').area, 'Members');
  assert.equal(byId.get('R-M1').area, 'Fines');
  for (const f of byId.values()) {
    assert.ok(f.title.length <= 80, f.id);
    assert.ok(!f.title.includes('`'), f.id);
    assert.ok(f.evidence.length <= 600, f.id);
  }
  assert.match(byId.get('X1').evidence, /Where: `apps\/api\/src\/loans\/export\.mjs:8-20`/, 'evidence keeps code names as written');
  assert.match(byId.get('H23').evidence, /^Audit status: Partly\. Masked on paper/);
  assert.equal(byId.get('X2').blast, 'large', 'four files');
  assert.equal(byId.get('X3').blast, 'small', 'one file');
  assert.equal(byId.get('Q-H1').blast, 'large', '"and others"');
  assert.equal(byId.get('C7').blast, 'medium', 'no location');
});

test('parseAudit ignores code blocks, rows without an id, id-like words without digits and non-finding tables', () => {
  const ids = parseAudit(AUDIT).findings.map(f => f.id);
  assert.ok(!ids.includes('Z-1'), 'a table inside a fenced code block is quoted material');
  assert.ok(!ids.some(id => /LINT|loan|Stray/.test(id)));
  assert.equal(new Set(ids).size, ids.length, 'every id once');
  const crlf = parseAudit(`\uFEFF${AUDIT.replace(/\r?\n/g, '\r\n')}`); // the fixture may already be CRLF (core.autocrlf)
  assert.deepEqual(crlf, parseAudit(AUDIT), 'a byte order mark and CRLF line ends change nothing');
});

test('parseAudit uses the profile id pattern, and a severity column wins over the heading', () => {
  const md = [
    '## Status of v1 findings', '| ID | Status | Note |', '|---|---|---|', '| EX-1 old thing | Fixed | |', '| H41 not an EX id | Open | |', '',
    '## New findings', '### Low', '| # | Problem | Severity | Phase |', '|---|---|---|---|',
    '| EX-2 | The `cart` total rounds twice. | High | 3 |', '| EX-3 | Typo in the footer. | | |', '',
    '### Phase 3: polish', '1. **EX-3** and EX-2.',
  ].join('\n');
  const { findings } = parseAudit(md, { idPattern: '\\bEX-\\d{1,3}\\b' });
  assert.deepEqual(findings.map(f => [f.id, f.severity, f.severitySource, f.phase, f.title]), [
    ['EX-1', 'medium', 'default', null, 'old thing'],
    ['EX-2', 'high', 'column', '3', 'The cart total rounds twice'],
    ['EX-3', 'low', 'heading', '3', 'Typo in the footer'],
  ]);
  assert.deepEqual(parseAudit(md, { idPattern: /\bNOPE-\d\b/ }).findings, []);
  assert.throws(() => parseAudit(md, { idPattern: '(' }), /not a valid regular expression/);
});

// ---------------------------------------------------------------- small helpers

test('the text helpers clean cells, split leading ids, read statuses and expand ranges', () => {
  const finder = idFinder(DEFAULT_ID_PATTERN);
  assert.equal(cleanCell('**X1** ✔ `a.b`  \n c'), 'X1 a.b c');
  assert.deepEqual(leadingIds('K-3, K-4 / K-5 and R-N1 label: rest', finder.lead), { ids: ['K-3', 'K-4', 'K-5', 'R-N1'], rest: 'label: rest' });
  assert.deepEqual(leadingIds('D-1 / D-9 shelf labels', finder.lead), { ids: ['D-1', 'D-9'], rest: 'shelf labels' });
  assert.deepEqual(leadingIds('Dead files', finder.lead), { ids: [], rest: 'Dead files' });
  const statuses = [['**Fixed** (for those)', 'fixed'], ['Done', 'fixed'], ['Partly', 'partly'], ['In progress', 'partly'],
    ['Open (only in December)', 'open'], ['**Open, worse**: see X', 'open'], ["Won't fix", 'dismissed'], ['Accepted risk', 'dismissed'],
    ['Unclear', 'unknown'], ['', null]];
  for (const [text, want] of statuses) assert.equal(auditStatus(text), want, text);
  assert.deepEqual(['C1', 'H12', 'M3', 'L4', 'X1', 'H-2'].map(severityFromId), ['critical', 'high', 'medium', 'low', null, 'high']);
  assert.deepEqual(rangeIds('**A-4** to **A-7**, R-9 through R-11, B-1 to C-3, Z-1 to Z-99', finder), ['A-5', 'A-6', 'R-10'], 'same prefix only, at most 30');
  assert.equal(blastFrom(''), 'medium');
  assert.equal(blastFrom('`a/b.mjs:3`'), 'small');
  assert.equal(blastFrom('`a/b.mjs`, `c/d.mjs`'), 'medium');
  assert.equal(blastFrom('`a/**`, `b/c/*`'), 'large', 'folders weigh more than files');
  assert.equal(blastFrom('`x.mjs` and others'), 'large');
  const long = titleFrom('word '.repeat(40));
  assert.ok(long.length <= 80 && !long.endsWith(' '));
  assert.equal(titleFrom('A `code` name, then a long clause that goes on and on and on until it is far past eighty characters'), 'A code name, then a long clause that goes on and on and on until it is far past');
  assert.deepEqual(auditMentions('Fix it (audit X3) and (audit: X1, R-N1)', finder), ['X3', 'X1', 'R-N1']);
  assert.ok(recordUnfinished('Partly'));
  assert.ok(recordUnfinished('**In progress** since Monday'));
  assert.ok(!recordUnfinished('Done (audit X2)'));
  assert.ok(!recordUnfinished(''));
  assert.equal(checkRef('main', 'x'), 'main');
  for (const bad of ['-x', 'a..b', 'a b', '', 'a;b']) assert.throws(() => checkRef(bad, 'git.integrationBranch'), e => e.status === 400, bad);
});

test('parseRecord takes ids from the H1, the Status line and the first section only', () => {
  const r = parseRecord(fx('records/LOAN-EXPORT-SESSION.md'));
  assert.deepEqual(r, { title: 'Loan export reads the member from the session', ids: ['X1', 'H23'], statusLine: 'Done', date: '2026-01-12' });
  assert.deepEqual(parseRecord(fx('records/RENEWAL-LINK-EXPIRY.md')).ids, ['X2'], 'from **Status:** Done (audit X2)');
  const waiver = parseRecord(fx('records/WAIVER-RULE.md'));
  assert.deepEqual(waiver.ids, ['H21', 'R-M1'], 'the first section counts');
  assert.equal(waiver.statusLine, 'Partly');
  assert.deepEqual(parseRecord('# Title (EX-4)\n\nStatus: Done', { idPattern: '\\bEX-\\d+\\b' }).ids, ['EX-4']);
});

test('gitText accepts a git function returning text, a Buffer or {stdout}, or the core/git module', async () => {
  assert.equal(await gitText(async () => 'a', '.', []), 'a');
  assert.equal(await gitText(async () => Buffer.from('b'), '.', []), 'b');
  assert.equal(await gitText(async () => ({ stdout: 'c' }), '.', []), 'c');
  assert.equal(await gitText({ git: async () => 'd' }, '.', []), 'd');
  await assert.rejects(gitText(null, '.', []), /No git runner/);
});

// ---------------------------------------------------------------- a repo with records and branches

const RECORDS = ['LOAN-EXPORT-SESSION.md', 'RENEWAL-LINK-EXPIRY.md', 'WAIVER-RULE.md', 'README.md', 'lowercase-note.md'];

// main:  Start (audit Q-H1) = the audit baseline
//        Records for the first fixes          (X1, H23, X2; an unfinished one for H21 and R-M1)
//        Visitor view for the catalog (audit X3)
//        Hold limits (audit X7)                (app/0111-hold-limits, merged with a fast-forward)
// app/0112-renewal-limit   unmerged, adds a finished record for R-N1
// app/0113-search-job      unmerged, a commit "(audit Q-H2)"
// scratch/notes            unmerged and not an app branch, a record and a commit for X6
// plus an uncommitted record for L2 in the working tree
async function scenarioRepo(t) {
  const dir = join(tempDir('ws-imp-', t), 'repo');
  const base = await makeRepo(dir, { files: { 'README.md': '# Example library\n', 'docs/README.md': '# Docs\n' }, commit: 'Start (audit Q-H1)' });
  writeFiles(dir, Object.fromEntries(RECORDS.map(n => [`docs/records/${n}`, fx(`records/${n}`)])));
  await commitAll(dir, 'Records for the first fixes');
  writeFiles(dir, { 'apps/api/src/catalog/page.mjs': 'export const view = book => ({ title: book.title });\n' });
  const x3 = await commitAll(dir, 'Visitor view for the catalog (audit X3)');
  await runGit(dir, ['switch', '-q', '-c', 'app/0111-hold-limits']);
  writeFiles(dir, { 'apps/api/src/holds/limit.mjs': 'export const MAX_HOLDS = 5;\n' });
  const x7 = await commitAll(dir, 'Hold limits (audit X7)');
  await runGit(dir, ['switch', '-q', 'main']);
  await runGit(dir, ['merge', '-q', '--ff-only', 'app/0111-hold-limits']);
  await runGit(dir, ['switch', '-q', '-c', 'app/0112-renewal-limit']);
  writeFiles(dir, { 'docs/records/RENEWAL-LIMIT.md': fx('records-branch/RENEWAL-LIMIT.md') });
  await commitAll(dir, 'Renewal limit');
  await runGit(dir, ['switch', '-q', 'main']);
  await runGit(dir, ['switch', '-q', '-c', 'app/0113-search-job']);
  writeFiles(dir, { 'apps/api/src/search/job.mjs': 'export const rebuild = () => [];\n' });
  const qh2 = await commitAll(dir, 'Search rebuild as a job (audit Q-H2)');
  await runGit(dir, ['switch', '-q', 'main']);
  await runGit(dir, ['switch', '-q', '-c', 'scratch/notes']);
  writeFiles(dir, { 'docs/records/HINT-HIDDEN.md': '# Hint hidden (X6)\n\nStatus: Done\n' });
  await commitAll(dir, 'Hide the hint (audit X6)');
  await runGit(dir, ['switch', '-q', 'main']);
  writeFiles(dir, { 'docs/records/FOOTER-YEAR.md': '# Footer year (L2)\n\nStatus: Done\n' });
  return { dir, base, x3, x7, qh2 };
}

// The example profile pointed at the scenario repo, with the default id pattern (the example's
// own pattern only knows EX- ids). `over` patches git, findings and docs key by key.
function scenarioProfile(dir, base, over = {}) {
  return fakeProfile({
    git: { integrationBranch: 'main', ...over.git },
    findings: { audit: join(dir, '..', 'audit.md'), auditBaseline: base, idPattern: null, ...over.findings },
    docs: { ...over.docs },
  });
}

test('scanRecords reads committed records only, skipping the index and names outside the record rule', async t => {
  const { dir } = await scenarioRepo(t);
  const nameRe = new RegExp(fakeProfile().docs.recordNameRe);
  const recs = await scanRecords({ git, dir, recordsDir: 'docs/records', nameRe });
  assert.deepEqual(recs.map(r => [r.name, r.ids, r.statusLine]), [
    ['LOAN-EXPORT-SESSION', ['X1', 'H23'], 'Done'],
    ['RENEWAL-LINK-EXPIRY', ['X2'], 'Done (audit X2)'],
    ['WAIVER-RULE', ['H21', 'R-M1'], 'Partly'],
  ]);
  assert.equal(recs[0].date, '2026-01-12', 'the Date line');
  assert.match(recs[1].date, /^\d{4}-\d{2}-\d{2}$/, 'otherwise the day it was added');
  assert.equal(recs[0].path, 'docs/records/LOAN-EXPORT-SESSION.md');
  const all = await scanRecords({ git, dir, recordsDir: 'docs/records/' });
  assert.ok(all.some(r => r.name === 'lowercase-note'), 'without a name rule every .md but the README counts');
  assert.ok(!all.some(r => r.name === 'README' || r.name === 'FOOTER-YEAR'), 'never the index, never an uncommitted file');
  const onBranch = await scanRecords({ git, dir, recordsDir: 'docs/records', ref: 'app/0112-renewal-limit', nameRe });
  assert.ok(onBranch.some(r => r.name === 'RENEWAL-LIMIT'));
  assert.deepEqual(await scanRecords({ git, dir, recordsDir: 'docs/none' }), []);
  for (const bad of ['../outside', 'C:/x', '/abs', '']) {
    await assert.rejects(scanRecords({ git, dir, recordsDir: bad }), e => e.status === 400 && /docs.recordsDir .* is not a folder inside the repository/.test(e.message), bad);
  }
  await assert.rejects(scanRecords({ git, dir, recordsDir: 'docs/records', nameRe: '[' }), e => e.status === 400 && /docs.recordNameRe in the profile is not a valid regular expression/.test(e.message));
});

test('proposeImport proposes done from records and commits on the integration branch, on-branch from unmerged app branches', async t => {
  const { dir, base, x3, x7, qh2 } = await scenarioRepo(t);
  const before = [await runGit(dir, ['status', '--porcelain']), await runGit(dir, ['rev-parse', 'HEAD']), await runGit(dir, ['branch', '--show-current'])];
  const p = await proposeImport({ profile: scenarioProfile(dir, base), mainDir: dir, auditText: AUDIT, current: emptyDoc('example'), git });
  const by = new Map(p.rows.map(r => [r.id, r]));
  const want = {
    C7: ['done', 'audit'], H21: ['open', 'audit'], H23: ['done', 'record'], H29: ['open', 'audit'], M4: ['open', 'audit'], L2: ['open', 'audit'],
    'K-3': ['done', 'audit'], 'K-4': ['done', 'audit'], 'K-5': ['done', 'audit'], 'W-2': ['open', 'audit'], 'W-6': ['open', 'audit'],
    'W-7': ['open', 'audit'], 'D-1': ['open', 'audit'], 'D-9': ['open', 'audit'], 'Q-8': ['dismissed', 'audit'],
    X1: ['done', 'record'], X2: ['done', 'record'], X3: ['done', 'git'], 'R-N1': ['on-branch', 'git'], 'Q-H1': ['open', 'audit'],
    'Q-H2': ['on-branch', 'git'], X6: ['open', 'audit'], X7: ['done', 'git'], 'R-M1': ['open', 'audit'], 'L-3': ['open', 'audit'],
  };
  assert.deepEqual(Object.fromEntries(p.rows.map(r => [r.id, [r.proposed, r.statusSource]])), want);
  assert.deepEqual(by.get('X1').records, ['LOAN-EXPORT-SESSION']);
  assert.deepEqual(by.get('X1').why, ['record LOAN-EXPORT-SESSION on main (Status: Done)']);
  assert.deepEqual(by.get('X3').commits, [x3.slice(0, 7)]);
  assert.deepEqual(by.get('X3').why, [`commit ${x3.slice(0, 7)} on main names (audit X3)`, 'waits on an owner decision (open questions)']);
  assert.deepEqual(by.get('X7').commits, [x7.slice(0, 7)], 'a merged app branch counts as the integration branch');
  assert.equal(by.get('R-N1').branch, 'app/0112-renewal-limit');
  assert.deepEqual(by.get('R-N1').records, ['RENEWAL-LIMIT']);
  assert.match(by.get('R-N1').why[0], /only on app\/0112-renewal-limit, not merged into main/);
  assert.equal(by.get('Q-H2').branch, 'app/0113-search-job');
  assert.deepEqual(by.get('Q-H2').commits, [qh2.slice(0, 7)]);
  assert.match(by.get('H21').why.join(' '), /record WAIVER-RULE on main names it but is not finished \(Status: Partly\); not counted as fixed/);
  assert.deepEqual(by.get('C7').why, ['audit: Fixed']);
  assert.deepEqual(by.get('R-M1').why.slice(-1), ['waits on an owner decision (open questions)']);
  assert.equal(by.get('R-M1').ownerDecision, true);
  assert.deepEqual(by.get('Q-H1').why, ['audit: new finding, no status given'], 'a commit at the audit baseline is older than the audit');
  assert.ok(!by.get('X6').records.length && !by.get('X6').commits.length, 'a scratch branch and a note outside the record rule never count');
  assert.ok(!by.get('L2').records.length, 'an uncommitted record never counts');
  assert.ok(p.rows.every(r => r.current === null && r.change === true));
  assert.deepEqual(p.phases.map(x => x.id), ['1', '1.5', '2']);
  assert.equal(p.source.baselineCommit, base);
  assert.match(p.source.auditSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([p.counts.total, p.counts.done, p.counts['on-branch'], p.counts.open, p.counts.dismissed], [25, 9, 2, 13, 1]);
  assert.match(p.hash, /^sha256:[0-9a-f]{64}$/);
  const again = await proposeImport({ profile: scenarioProfile(dir, base), mainDir: dir, auditText: AUDIT, current: emptyDoc('example'), git });
  assert.equal(again.hash, p.hash, 'the same inputs give the same hash');
  const after = [await runGit(dir, ['status', '--porcelain']), await runGit(dir, ['rev-parse', 'HEAD']), await runGit(dir, ['branch', '--show-current'])];
  assert.deepEqual(after, before, 'the checkout is only read');
});

test('proposeImport keeps what runs and you set, never moves done back, and lets records close a finding', async t => {
  const { dir, base } = await scenarioRepo(t);
  const cur = (id, status, extra = {}) => ({ id, title: id, severity: 'medium', phase: null, status, statusSource: 'run', blast: 'medium',
    ownerDecision: false, estimateMin: null, records: [], commits: [], branch: null, runId: null, evidence: '', notes: '', history: [], ...extra });
  const current = { ...emptyDoc('example'), findings: [
    cur('X6', 'in-run', { runId: 'r-x6' }), cur('L2', 'dismissed', { statusSource: 'user' }), cur('D-1', 'done', { statusSource: 'merged' }),
    cur('Q-H1', 'on-branch', { branch: 'app/0101-clock' }), cur('Q-8', 'open', { statusSource: 'user' }), cur('X1', 'in-run', { runId: 'r-x1' }),
    cur('C7', 'open', { statusSource: 'user' }), cur('W-2', 'open', { statusSource: 'audit' }), cur('AP-1', 'proposed'),
  ] };
  const p = await proposeImport({ profile: scenarioProfile(dir, base), mainDir: dir, auditText: AUDIT, current, git });
  const by = new Map(p.rows.map(r => [r.id, r]));
  const got = id => [by.get(id).current, by.get(id).proposed, by.get(id).change];
  assert.deepEqual(got('X6'), ['in-run', 'in-run', false]);
  assert.match(by.get('X6').why[0], /^kept in-run: a run is working on it \(r-x6\)/);
  assert.deepEqual(got('L2'), ['dismissed', 'dismissed', false]);
  assert.deepEqual(got('D-1'), ['done', 'done', false], 'done never moves back');
  assert.deepEqual(got('Q-H1'), ['on-branch', 'on-branch', false]);
  assert.match(by.get('Q-H1').why[0], /not merged yet/);
  assert.equal(by.get('Q-H1').branch, 'app/0101-clock');
  assert.deepEqual(got('Q-8'), ['open', 'open', false], 'the audit says won\'t fix, but you reopened it');
  assert.deepEqual(got('X1'), ['in-run', 'done', true], 'a finished record closes it even while a run holds it');
  assert.deepEqual(got('C7'), ['open', 'open', false], 'the audit\'s own "Fixed" does not override you');
  assert.deepEqual(got('W-2'), ['open', 'open', false]);
  assert.ok(!by.has('AP-1'), 'findings outside the audit are not part of the proposal');
});

test('proposeImport refuses a profile without a usable integration branch and warns about a missing baseline', async t => {
  const { dir, base } = await scenarioRepo(t);
  const args = profile => ({ profile, mainDir: dir, auditText: AUDIT, current: null, git });
  await assert.rejects(proposeImport(args(scenarioProfile(dir, base, { git: { integrationBranch: null } }))), e => e.status === 400 && /no git.integrationBranch/.test(e.message));
  await assert.rejects(proposeImport(args(scenarioProfile(dir, base, { git: { integrationBranch: 'gone' } }))), e => e.status === 400 && /does not exist/.test(e.message));
  await assert.rejects(proposeImport(args(scenarioProfile(dir, base, { git: { integrationBranch: '--output=x' } }))), e => e.status === 400 && /not a branch or commit name/.test(e.message));
  await assert.rejects(proposeImport(args(scenarioProfile(dir, base, { findings: { auditBaseline: '-x' } }))), e => e.status === 400);
  const p = await proposeImport(args(scenarioProfile(dir, base, { findings: { auditBaseline: 'abcdef1' } })));
  assert.ok(p.warnings.some(w => /audit baseline abcdef1 was not found/.test(w)));
  assert.equal(p.rows.find(r => r.id === 'Q-H1').proposed, 'done', 'without a baseline every commit subject on main counts');
  const noRecords = await proposeImport(args(scenarioProfile(dir, base, { docs: { recordsDir: null } })));
  assert.ok(noRecords.warnings.some(w => /no docs.recordsDir/.test(w)));
  assert.equal(noRecords.rows.find(r => r.id === 'X1').proposed, 'open');
  // A bad profile value is the profile's fault: 400 with the key named, never a raw 500.
  for (const [over, key] of [[{ findings: { idPattern: '(' } }, 'findings.idPattern'], [{ docs: { recordNameRe: '[' } }, 'docs.recordNameRe'],
    [{ docs: { recordsDir: '../up' } }, 'docs.recordsDir']]) {
    await assert.rejects(proposeImport(args(scenarioProfile(dir, base, over))), e => e.status === 400 && e.message.startsWith(key), key);
  }
  assert.throws(() => idFinder('('), e => e.status === 400 && /^findings.idPattern in the profile is not a valid regular expression/.test(e.message));
});

// ---------------------------------------------------------------- applying

function sampleProposal() {
  const row = (id, proposed, extra = {}) => ({ id, title: `Title ${id}`, severity: 'high', phase: '1', current: null, proposed, change: true,
    why: [`because ${id}`], statusSource: 'audit', records: [], commits: [], branch: null, evidence: `evidence ${id}`, blast: 'small',
    area: '', ownerDecision: false, statusInAudit: 'open', ...extra });
  return {
    rows: [row('X1', 'done', { statusSource: 'record', records: ['LOAN-EXPORT-SESSION'] }), row('R-N1', 'on-branch', { statusSource: 'git', branch: 'app/0112-renewal-limit' }),
      row('Q-H1', 'open'), row('Q-8', 'dismissed')],
    phases: [{ id: '1', label: 'Phase 1: access' }], source: { audit: 'C:\\example\\audit.md', auditSha256: 'sha256:x', baselineCommit: null }, hash: 'sha256:p',
  };
}

test('applyImport writes history entries by import and keeps findings the audit does not list', () => {
  const current = { ...emptyDoc('example'), phases: [{ id: '9', label: 'Phase 9: later' }], findings: [
    { id: 'AP-1', title: 'proposed by a run', severity: 'low', status: 'proposed', history: [] },
    { id: 'Q-H1', title: 'old title', severity: 'low', status: 'in-run', statusSource: 'run', runId: 'r1', records: ['A'], commits: [], history: [{ at: AT, from: null, to: 'in-run', by: 'run', reason: '' }] },
  ] };
  const doc = applyImport(current, sampleProposal(), { at: AT });
  assert.deepEqual(doc.findings.map(f => [f.id, f.status]), [['X1', 'done'], ['R-N1', 'on-branch'], ['Q-H1', 'open'], ['Q-8', 'dismissed'], ['AP-1', 'proposed']]);
  const x1 = doc.findings[0];
  assert.deepEqual(x1.history, [{ at: AT, from: null, to: 'done', by: 'import', reason: 'because X1' }]);
  assert.equal(x1.statusSource, 'record');
  assert.deepEqual(x1.records, ['LOAN-EXPORT-SESSION']);
  assert.equal(doc.findings[1].branch, 'app/0112-renewal-limit');
  const qh1 = doc.findings[2];
  assert.equal(qh1.title, 'Title Q-H1', 'audit fields are refreshed');
  assert.deepEqual(qh1.history.map(h => [h.from, h.to, h.by]), [[null, 'in-run', 'run'], ['in-run', 'open', 'import']]);
  assert.deepEqual(qh1.records, ['A'], 'records are merged, never dropped');
  assert.deepEqual(doc.phases, [{ id: '1', label: 'Phase 1: access' }, { id: '9', label: 'Phase 9: later' }]);
  assert.deepEqual(doc.source, { audit: 'C:\\example\\audit.md', auditSha256: 'sha256:x', baselineCommit: null, importedAt: AT, confirmedAt: AT });
  const twice = applyImport(doc, sampleProposal(), { at: '2026-01-21T10:00:00.000Z' });
  assert.equal(twice.findings[0].history.length, 1, 'an unchanged status adds no history');
});

test('applyImport takes a chosen list and overrides, and refuses overrides the import may not set', () => {
  const doc = applyImport(null, sampleProposal(), { accept: ['X1', 'Q-H1'], overrides: { 'Q-H1': 'dismissed' }, at: AT });
  assert.deepEqual(doc.findings.map(f => [f.id, f.status, f.statusSource]), [['X1', 'done', 'record'], ['Q-H1', 'dismissed', 'user']]);
  assert.equal(doc.findings[1].history[0].reason, 'set to dismissed at import');
  const same = applyImport(null, sampleProposal(), { overrides: { X1: 'done' }, at: AT });
  assert.equal(same.findings[0].status, 'done', 'an override equal to the proposal is fine');
  for (const [opts, re] of [
    [{ overrides: { 'Q-H1': 'done' } }, /can't set done/], [{ overrides: { 'Q-H1': 'in-run' } }, /can't set in-run/],
    [{ overrides: { NOPE: 'open' } }, /no finding NOPE/], [{ accept: ['NOPE'] }, /no finding NOPE/], [{ accept: 'some' }, /accept must be/],
  ]) {
    assert.throws(() => applyImport(null, sampleProposal(), opts), e => e.status === 400 && re.test(e.message), JSON.stringify(opts));
  }
});

test('an override follows the click rules: it never takes a finding out of a run, off its branch or out of done', () => {
  const cur = (id, status, extra = {}) => ({ id, title: id, severity: 'high', status, statusSource: 'run', records: [], commits: [], branch: null,
    runId: null, history: [], ...extra });
  const row = (id, proposed, current, extra = {}) => ({ id, title: `Title ${id}`, severity: 'high', phase: '1', current, proposed, change: proposed !== current,
    why: [`because ${id}`], statusSource: 'audit', records: [], commits: [], branch: null, evidence: '', blast: 'small', area: '', ownerDecision: false,
    statusInAudit: 'open', ...extra });
  const current = { ...emptyDoc('example'), findings: [
    cur('X1', 'in-run', { runId: 'r1' }), cur('X2', 'done', { statusSource: 'merged' }), cur('X3', 'on-branch', { branch: 'app/0120-x3' }),
    cur('X6', 'dismissed', { statusSource: 'user' }), cur('AP-1', 'proposed'), cur('X7', 'open'),
  ] };
  const proposal = { rows: [
    row('X1', 'in-run', 'in-run'), row('X2', 'done', 'done'), row('X3', 'on-branch', 'on-branch', { branch: 'app/0120-x3' }),
    row('X6', 'dismissed', 'dismissed'), row('AP-1', 'proposed', 'proposed'),
    row('X7', 'done', 'open', { statusSource: 'git', commits: ['abc1234'], branch: 'app/0120-x7' }),
  ], phases: [], source: {}, hash: 'sha256:p' };
  for (const [id, to] of [['X1', 'open'], ['X1', 'proposed'], ['X2', 'open'], ['X2', 'proposed'], ['X3', 'open'], ['X7', 'proposed']]) {
    assert.throws(() => applyImport(current, proposal, { overrides: { [id]: to }, at: AT }),
      e => e.status === 400 && e.message.startsWith(`${id} is ${current.findings.find(f => f.id === id).status}, so the import can't set it to ${to}.`), `${id} -> ${to}`);
  }
  const doc = applyImport(current, proposal, { overrides: { X1: 'dismissed', X2: 'dismissed', X6: 'open', 'AP-1': 'open', X7: 'open' }, at: AT });
  assert.deepEqual(doc.findings.map(f => [f.id, f.status]), [['X1', 'dismissed'], ['X2', 'dismissed'], ['X3', 'on-branch'], ['X6', 'open'], ['AP-1', 'open'], ['X7', 'open']]);
  assert.deepEqual(doc.findings[0].history, [{ at: AT, from: 'in-run', to: 'dismissed', by: 'import', reason: 'set to dismissed at import' }], 'a dismissal always has a reason');
  const x7 = doc.findings[5];
  assert.deepEqual([x7.history.length, x7.statusSource, x7.commits, x7.branch], [0, 'run', [], null], 'kept open: no move, and none of the commits or branch behind the rejected done');
});

test('an import to on-branch records its branch and commits; an overridden row carries neither', () => {
  const p = sampleProposal();
  p.rows[0].commits = ['def5678'];
  p.rows[1].commits = ['abc1234'];
  const doc = applyImport(null, p, { overrides: { X1: 'open' }, at: AT });
  const [x1, rn1] = doc.findings;
  assert.deepEqual([x1.status, x1.commits, x1.branch, x1.records], ['open', [], null, ['LOAN-EXPORT-SESSION']], 'records stay as context; commits do not');
  assert.deepEqual(rn1.history, [{ at: AT, from: null, to: 'on-branch', by: 'import', reason: 'because R-N1', branch: 'app/0112-renewal-limit', commits: ['abc1234'] }]);
  assert.deepEqual(rn1.commits, ['abc1234']);
});

// ---------------------------------------------------------------- prepare and apply with a data folder

test('prepareImport keeps a pending proposal and writes no findings until applyPendingImport', async t => {
  const { dir, base } = await scenarioRepo(t);
  const dataDir = tempDir('ws-imp-data-', t);
  writeFiles(join(dir, '..'), { 'audit.md': AUDIT });
  const profile = scenarioProfile(dir, base);
  const proposal = await prepareImport({ dataDir, project: 'example', profile, mainDir: dir, git });
  assert.equal(proposal.rows.length, 25);
  assert.ok(!existsSync(findingsFile(dataDir, 'example')), 'nothing is written before Apply');
  assert.equal((await loadPendingImport(dataDir, 'example')).proposal.hash, proposal.hash);
  await assert.rejects(applyPendingImport({ dataDir, project: 'example', hash: 'sha256:other' }), e => e.status === 409 && /changed since you looked/.test(e.message));
  const r = await applyPendingImport({ dataDir, project: 'example', hash: proposal.hash, at: AT });
  assert.equal(r.message, 'Applied 25 of 25 findings.');
  const doc = await loadFindings(dataDir, 'example');
  assert.equal(doc.findings.length, 25);
  assert.equal(doc.findings.find(f => f.id === 'X3').status, 'done');
  assert.ok(doc.findings.every(f => f.history.length === 1 && f.history[0].by === 'import'));
  assert.ok(!existsSync(importFile(dataDir, 'example')), 'the pending proposal is moved aside');
  assert.ok(existsSync(join(dataDir, 'findings', 'example.import.applied.json')));
  await assert.rejects(applyPendingImport({ dataDir, project: 'example', hash: proposal.hash }), e => e.status === 409 && /no import waiting/.test(e.message));
});

test('applyPendingImport refuses when the board changed after the proposal was made', async t => {
  const { dir, base } = await scenarioRepo(t);
  const dataDir = tempDir('ws-imp-data-', t);
  writeFiles(join(dir, '..'), { 'audit.md': AUDIT });
  const proposal = await prepareImport({ dataDir, project: 'example', profile: scenarioProfile(dir, base), mainDir: dir, git });
  await saveFindings(dataDir, 'example', { ...emptyDoc('example'), findings: [] }, { baseHash: null });
  await assert.rejects(applyPendingImport({ dataDir, project: 'example', hash: proposal.hash, accept: ['X1'] }),
    e => e.status === 409 && /changed since the proposal was made/.test(e.message));
  const partial = await prepareImport({ dataDir, project: 'example', profile: scenarioProfile(dir, base), mainDir: dir, git });
  const r = await applyPendingImport({ dataDir, project: 'example', hash: partial.hash, accept: ['X1', 'R-N1'] });
  assert.equal(r.message, 'Applied 2 of 25 findings.');
  assert.deepEqual(r.doc.findings.map(f => [f.id, f.status]), [['X1', 'done'], ['R-N1', 'on-branch']]);
});

test('prepareImport refuses a profile with no audit, a relative audit path or an unreadable file', async t => {
  const dataDir = tempDir('ws-imp-data-', t);
  const base = { dataDir, project: 'example', mainDir: dataDir, git };
  await assert.rejects(prepareImport({ ...base, profile: fakeProfile({ findings: null }) }), e => e.status === 400 && /no findings.audit/.test(e.message));
  await assert.rejects(prepareImport({ ...base, profile: fakeProfile({ findings: { audit: 'reports/audit.md' } }) }), e => e.status === 400 && /full path/.test(e.message));
  await assert.rejects(prepareImport({ ...base, profile: fakeProfile({ findings: { audit: join(dataDir, 'missing.md') } }) }), e => e.status === 400 && /Could not read the audit file \(ENOENT\)/.test(e.message));
  writeFiles(dataDir, { 'audit.md': AUDIT });
  await assert.rejects(prepareImport({ ...base, project: '../up', profile: fakeProfile({ findings: { audit: join(dataDir, 'audit.md') } }) }),
    e => e.status === 400 && /not a valid project name/.test(e.message));
});
