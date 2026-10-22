// Tests for runs/report.mjs: where a run report goes (private data folder or hub, by the privacy
// flag), titles and folder names, report-v2 on a second save, register-report as an argument list,
// and the Markdown: Claude's text quoted, secret-scanned and redacted.
// Run: node --test tools/workspace-app/runs/report.test.mjs
// The hub root and the data folder are temporary folders; register-report is a fake runTool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/datadir.mjs';
import { fakeProfile, tempDir } from '../test/helpers.mjs';
import {
  PIPELINE_LABELS, buildReportMarkdown, loadRunOutputs, reportTitle, reportType, requestOf, sanitizeText, saveRunReport, slugFrom,
} from './report.mjs';

// The folder id rule of tools/register-report.mjs.
const REGISTER_ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = () => ['sk', 'live', 'x'.repeat(24)].join('_'); // built at runtime, never a literal key
const NOW = new Date(2026, 0, 20, 18, 0);

function run(over = {}) {
  return {
    version: 1, id: '260120-104212-review-loan-export', project: 'example', pipeline: 'review',
    title: 'Review: the loan export change', values: { what: 'the loan export change' },
    status: 'passed', createdAt: new Date(2026, 0, 20, 10, 42).toISOString(), endedAt: new Date(2026, 0, 20, 10, 58).toISOString(),
    base: { branch: 'main', sha: 'a'.repeat(40) }, branch: null, commit: null, level: 'standard', levelReason: ['tenant path'],
    versions: { node: '24.11.1', claudeCode: '2.1.307' }, outputs: {}, ...over,
  };
}

const review = () => ({
  verdict: 'fix', notProven: ['The email path was not exercised.'],
  findings: [
    { id: 'F1', severity: 'high', kind: 'issue', rule: 'Tenant checks', path: 'apps/api/src/loans/export.mjs', line: 12,
      claim: 'The export trusts the query.\n## Injected heading\n[click](http://example.invalid) <script>alert(1)</script>',
      evidence: `const key = "${KEY()}";`, suggestion: 'Read the member from the session.', status: 'confirmed' },
    { id: 'F2', severity: 'low', kind: 'follow-up', path: 'apps/web/src/a.mjs', claim: 'Naming.', evidence: '', suggestion: '', status: 'unconfirmed' },
  ],
});

function recorder(result = { status: 0, output: 'registered' }) {
  const calls = [];
  const fn = async opts => { calls.push(opts); return typeof result === 'function' ? result(opts) : result; };
  fn.calls = calls;
  return fn;
}

// A fake register-report that, like the real one, lists the folder in <root>/reports/reports.json.
function registrar(root) {
  return recorder(async ({ args }) => {
    const id = args[args.indexOf('--folder') + 1].split('/').pop();
    const file = join(root, 'reports', 'reports.json');
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, reports: [] };
    if (!data.reports.some(r => r.id === id)) data.reports.push({ id });
    await writeJsonAtomic(file, data);
    return { status: 0, output: 'registered' };
  });
}

// ---------------------------------------------------------------- destination

test('a public hub keeps run reports in the private data folder and registers them in its index', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  const runTool = recorder();
  const r = await saveRunReport({ root, dataDir, run: run(), profile: fakeProfile(), runTool, outputs: { review: review() }, now: NOW });
  assert.equal(r.destination, 'private');
  assert.equal(r.id, '2026-01-20_review-the-loan-export-change');
  assert.equal(r.dir, join(dataDir, 'reports', 'example', r.id));
  assert.equal(r.file, 'report.md');
  assert.equal(r.version, 1);
  assert.equal(r.title, 'Review: the loan export change');
  assert.equal(r.type, 'audit');
  assert.match(r.message, /Saved privately in the app data folder: reports\/example\/2026-01-20_review-the-loan-export-change\/report\.md/);
  assert.equal(runTool.calls.length, 0, 'register-report is never run for a private report');
  assert.ok(!existsSync(join(root, 'reports')), 'nothing is written into the hub');
  const index = JSON.parse(readFileSync(join(dataDir, 'reports', 'index.json'), 'utf8'));
  assert.equal(index.version, 1);
  assert.deepEqual(index.reports.map(x => [x.id, x.project, x.runId, x.type, x.status, x.created, x.folder]), [
    [r.id, 'example', run().id, 'audit', 'active', '2026-01-20', `example/${r.id}`],
  ]);
  assert.deepEqual(index.reports[0].steps, [{ name: 'Report', path: `example/${r.id}/report.md` }]);
  assert.equal(index.reports[0].summary, 'Review passed; 2 findings (1 high, 1 low); no checks');
});

test('without a profile, or without an explicit private hub, a report stays private', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  for (const profile of [null, {}, { privacy: {} }, { privacy: { hubPublic: 'no' } }]) {
    const r = await saveRunReport({ root, dataDir, run: run({ id: `r-${Math.random().toString(36).slice(2, 8)}` }), profile, runTool: recorder(), outputs: {}, now: NOW });
    assert.equal(r.destination, 'private', JSON.stringify(profile));
  }
  assert.ok(!existsSync(join(root, 'reports')));
});

test('a private hub gets the report in reports/ and registers it with register-report as an argument list', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  const profile = fakeProfile({ privacy: { hubPublic: false } });
  const runTool = recorder();
  const r = await saveRunReport({ root, dataDir, run: run(), profile, runTool, outputs: { review: review() }, now: NOW });
  assert.equal(r.destination, 'hub');
  assert.equal(r.id, '2026-01-20_example-review-the-loan-export-change');
  assert.match(r.id, REGISTER_ID_RE, 'register-report accepts the folder name');
  assert.ok(existsSync(join(root, 'reports', r.id, 'report.md')));
  assert.equal(runTool.calls.length, 1);
  assert.deepEqual(runTool.calls[0], {
    cwd: root,
    args: [join(root, 'tools', 'register-report.mjs'), '--folder', `reports/${r.id}`, '--title', 'Review: the loan export change',
      '--project', 'example', '--type', 'audit', '--summary', 'Review passed; 2 findings (1 high, 1 low); no checks'],
  });
  assert.ok(runTool.calls[0].args.every(a => typeof a === 'string'), 'every argument is a plain string; no shell');
  assert.equal(r.message, `Saved to reports/${r.id}/report.md and registered.`);
  assert.ok(!existsSync(join(dataDir, 'reports')), 'nothing private is written');
});

test('saving the same run again writes report-v2.md in the same folder; another run gets its own folder', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  const first = await saveRunReport({ root, dataDir, run: run(), profile: fakeProfile(), runTool: recorder(), outputs: {}, now: NOW });
  const second = await saveRunReport({ root, dataDir, run: run(), profile: fakeProfile(), runTool: recorder(), outputs: {}, now: new Date(2026, 0, 21, 9, 0) });
  assert.equal(second.id, first.id);
  assert.deepEqual([second.file, second.version], ['report-v2.md', 2]);
  assert.deepEqual(readdirSync(first.dir).sort(), ['report-v2.md', 'report.md']);
  const index = JSON.parse(readFileSync(join(dataDir, 'reports', 'index.json'), 'utf8'));
  assert.equal(index.reports.length, 1, 'one entry per report, updated');
  assert.deepEqual([index.reports[0].created, index.reports[0].updated], ['2026-01-20', '2026-01-21']);
  assert.deepEqual(index.reports[0].steps.map(s => s.path.split('/').pop()), ['report.md', 'report-v2.md']);
  const other = await saveRunReport({ root, dataDir, run: run({ id: '260120-110000-review-loan-export' }), profile: fakeProfile(), runTool: recorder(), outputs: {}, now: NOW });
  assert.equal(other.id, `${first.id}-2`, 'same day and slug, another run');
  assert.equal(other.file, 'report.md');

  const hub = fakeProfile({ privacy: { hubPublic: false } });
  const tool = registrar(root);
  await saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: tool, outputs: {}, now: NOW });
  const v2 = await saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: tool, outputs: {}, now: NOW });
  assert.equal(v2.file, 'report-v2.md');
  assert.deepEqual(tool.calls[1].args.slice(1), ['--folder', `reports/${v2.id}`, '--summary', 'Review passed; no checks'], 'a revision of a registered report only updates the summary');
});

test('a hub report whose registration failed is registered in full on the next save', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  const hub = fakeProfile({ privacy: { hubPublic: false } });
  const full = id => ['--folder', `reports/${id}`, '--title', 'Review: the loan export change', '--project', 'example', '--type', 'audit',
    '--summary', 'Review passed; no checks'];
  await assert.rejects(saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: recorder({ status: 1, output: 'reports.json is busy' }), outputs: {}, now: NOW }),
    e => e.status === 500 && /register-report failed: reports\.json is busy/.test(e.message));
  const tool = registrar(root);
  const v2 = await saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: tool, outputs: {}, now: NOW });
  assert.equal(v2.file, 'report-v2.md');
  assert.deepEqual(tool.calls[0].args.slice(1), full(v2.id), 'not registered yet: title, project and type are passed');
  const v3 = await saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: tool, outputs: {}, now: NOW });
  assert.deepEqual(tool.calls[1].args.slice(1), ['--folder', `reports/${v3.id}`, '--summary', 'Review passed; no checks']);
  writeFileSync(join(root, 'reports', 'reports.json'), '{ not json');
  const unreadable = recorder();
  const v4 = await saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: unreadable, outputs: {}, now: NOW });
  assert.equal(v4.file, 'report-v4.md');
  assert.deepEqual(unreadable.calls[0].args.slice(1), full(v4.id), 'an unreadable registry: every field is passed (register-report upserts)');
});

test('a failed register-report says where the report was written; bad ids are refused before any path is built', async t => {
  const root = tempDir('ws-rep-hub-', t);
  const dataDir = tempDir('ws-rep-data-', t);
  const hub = fakeProfile({ privacy: { hubPublic: false } });
  await assert.rejects(saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: recorder({ status: 1, output: 'register-report: --title needs a value\n' }), outputs: {}, now: NOW }),
    e => e.status === 500 && /written to reports\/2026-01-20_example-review-the-loan-export-change\/report\.md, but register-report failed: register-report: --title needs a value/.test(e.message));
  await assert.rejects(saveRunReport({ root: '', dataDir, run: run(), profile: hub, runTool: recorder(), outputs: {} }), e => e.status === 500);
  await assert.rejects(saveRunReport({ root, dataDir, run: run(), profile: hub, runTool: null, outputs: {} }), e => e.status === 500);
  for (const bad of [{ id: '../x' }, { id: 'A B' }, { project: '../x' }, { project: 'Example' }, { pipeline: '../x' }, { pipeline: '' }]) {
    await assert.rejects(saveRunReport({ root, dataDir, run: run(bad), profile: hub, runTool: recorder(), outputs: {} }), e => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(readdirSync(join(root, 'reports')), ['2026-01-20_example-review-the-loan-export-change']);
});

// ---------------------------------------------------------------- titles, slugs, types

test('titles are "<Pipeline label>: <request>" with quotes, backticks and $ removed, the request at most 80 characters', () => {
  const r = run({ values: { what: 'Why does `renew()` say "it\'s $5"\nwhen the\tlimit is reached and the member has other loans that are overdue as well?' } });
  const title = reportTitle(r);
  assert.equal(title, 'Review: Why does renew() say its 5 when the limit is reached and the member has other', 'cut at a word');
  assert.ok(!/['"`$\n\t]/.test(title));
  assert.ok(title.length <= 'Review: '.length + 80);
  const secret = reportTitle(run({ values: { what: `rotate ${KEY()} today` } }));
  assert.ok(!secret.includes(KEY()));
  assert.match(secret, /^Review: rotate sk_l…\[redacted \d+\] today$/);
  assert.ok(reportTitle(run({ values: { what: `rotate ${KEY()}` } }), { allow: [KEY()] }).includes(KEY()), 'allowed values stay');
  assert.equal(reportTitle(run({ pipeline: 'fix', values: {}, title: 'Fix a finding: X1' })), 'Fix a finding: X1');
  assert.equal(requestOf(run({ values: {}, title: 'Review: the branch' })), 'the branch', 'the pipeline label is not repeated');
  assert.equal(requestOf(run({ values: { finding: 'X7' }, title: '' })), 'X7');
  assert.equal(requestOf(run({ values: {}, title: '' })), run().id);
  assert.equal(sanitizeText('a'.repeat(100)).length, 80);
  assert.equal(sanitizeText('one two three', 9), 'one two');
  assert.equal(slugFrom('Ünïcode & Symbols: the Loan EXPORT, again and again and again'), 'unicode-symbols-the-loan-export-again');
  assert.equal(slugFrom('$$$'), 'run');
  assert.deepEqual(['review', 'architecture', 'explain', 'check', 'fix', 'refactor', 'debug', 'feature', 'x'].map(reportType),
    ['audit', 'audit', 'research', 'status', 'other', 'other', 'other', 'other', 'other']);
  assert.equal(PIPELINE_LABELS.architecture, 'Architecture check');
});

// ---------------------------------------------------------------- the Markdown

test('buildReportMarkdown has 3 to 5 bullets, then Snapshot, Findings, Proof, Not proven and Sources', () => {
  const md = buildReportMarkdown(run({ status: 'committed', commit: { sha: 'b'.repeat(40), branch: 'app/0120-loan-export' } }), {
    review: review(),
    proof: { baseline: { key: 'k1', new: 0, known: 4, flaky: 1, canShrink: 0 }, checks: [{ id: 'types:web', label: 'Types: web', result: 'pass', durationMs: 252000 }],
      pins: { identical: true, green: true }, scope: { inPlan: 6, total: 7, allowedByUser: ['apps/web/src/b.mjs'] }, treeHash: { match: true },
      turns: { scope: 18, implement: 32 }, versions: { node: '24.11.1', claudeCode: '2.1.307' }, notProven: ['Mobile totals'] },
  }, { now: NOW });
  const headings = md.split('\n').filter(l => /^#{1,2} /.test(l));
  assert.deepEqual(headings, ['# Review: the loan export change', '## Snapshot', '## Findings', '## Proof', '## Not proven', '## Sources']);
  const bullets = md.split('## Snapshot')[0].split('\n').filter(l => l.startsWith('- '));
  assert.ok(bullets.length >= 3 && bullets.length <= 5, String(bullets.length));
  assert.equal(bullets[0], '- **Result:** Review committed on 2026-01-20.');
  assert.equal(bullets[1], '- **Findings:** 2 findings (1 high, 1 low); verdict fix.');
  assert.equal(bullets[2], '- **Checks:** 0 new · 4 known · 1 flaky.');
  assert.equal(bullets[3], '- **Commit:** bbbbbbb on app/0120-loan-export; not pushed.');
  assert.match(md, /\| Types: web \| pass \| 4 m 12 s \|/);
  assert.match(md, /- Pinned tests: unchanged, green\./);
  assert.match(md, /- Scope: 6 of 7 changed files were in the plan; allowed by you: `apps\/web\/src\/b\.mjs`\./);
  assert.match(md, /- Tree hash: matches the gated tree\./);
  assert.match(md, /## Not proven\n\n- "The email path was not exercised\."\n- "Mobile totals"/);
  assert.match(md, /Unconfirmed by the verify stage\. Kept and shown, never dropped\./);
  assert.match(md, /The run folder `runs\/example\/260120-104212-review-loan-export`/);
});

test('Claude\'s text stays quoted data: no headings, links or HTML of its own, and secrets are redacted', () => {
  const md = buildReportMarkdown(run(), { review: review() }, { now: NOW });
  const claim = md.split('Claim:\n')[1].split('\n\n')[0];
  assert.ok(claim.split('\n').every(l => l.startsWith('> ')), 'every line of the claim is inside a block quote');
  assert.ok(!/^## Injected heading/m.test(md), 'a heading in Claude\'s text never becomes a report heading');
  assert.ok(!md.includes('[click](http'), 'link syntax is escaped');
  assert.match(md, /\\\[click\\\]\(http:\/\/example\.invalid\)/);
  assert.ok(!md.includes('<script>'), 'HTML is escaped');
  assert.match(md, /&lt;script>/);
  assert.ok(!md.includes(KEY()), 'the secret-shaped string is redacted');
  assert.match(md, /sk_l…\\\[redacted \d+\\\]/, 'the marker is escaped like any other bracket, so it can never start a link');
  assert.match(md, /- \*\*Redacted:\*\* 1 secret-shaped string in the text below\./);
  const request = buildReportMarkdown(run({ values: { what: `explain ${KEY()}` } }), {}, { now: NOW });
  assert.ok(!request.includes(KEY()), 'your own request is redacted too');
});

test('buildReportMarkdown covers answers, diagnoses, triage and check summaries', () => {
  const answer = buildReportMarkdown(run({ pipeline: 'explain', values: { what: 'how renewals work' } }), {
    answer: { answer: 'Renewals go through renew().', sources: [{ path: 'apps/api/src/loans/renew.mjs', line: 14, note: 'entry point' }], openQuestions: ['Who owns the limit?'], suggestedNote: 'Renewals: renew.mjs' },
  }, { now: NOW });
  assert.match(answer, /- \*\*Answer:\*\* 1 source, 1 open question\./);
  assert.match(answer, /> Renewals go through renew\(\)\./);
  assert.match(answer, /- `apps\/api\/src\/loans\/renew\.mjs:14` "entry point"/);
  const diag = buildReportMarkdown(run({ pipeline: 'debug' }), {
    diagnosis: { pinnable: false, reproPlan: 'Set the clock to the 1st.', hypotheses: [{ claim: 'Dates come from the real clock.', evidence: ['digest.test.mjs:12'], confidence: 'high', howToProve: 'A fixed clock.' }] },
  }, { now: NOW });
  assert.match(diag, /- \*\*Diagnosis:\*\* 1 hypothesis; pinnable by a test: no\./);
  const triage = buildReportMarkdown(run({ pipeline: 'architecture' }), { triage: { items: [{ ref: 'c1', verdict: 'issue', reason: 'New deep import.', suggestedSlice: 'Add a public.ts' }] } }, { now: NOW });
  assert.match(triage, /^# Architecture check: /m);
  assert.match(triage, /- "c1" · issue: "New deep import\."; slice: "Add a public\.ts"/);
  const check = buildReportMarkdown(run({ pipeline: 'check', status: 'failed' }), {
    checks: { result: 'fail', chip: '1 new · 4 known', level: 'quick', checks: [{ group: 'G2', label: 'Unit tests: api', status: 'fail', durationMs: 4000 }], tests: { new: ['src/a.test.mjs::adds'] } },
  }, { now: NOW });
  assert.match(check, /Result: fail · 1 new · 4 known · level quick\./);
  assert.match(check, /\| G2 \| Unit tests: api \| fail \| 4 s \|/);
  assert.match(check, /- `src\/a\.test\.mjs::adds`/);
  const none = buildReportMarkdown(run({ pipeline: 'refactor' }), {}, { now: NOW });
  assert.match(none, /No findings in this run\./);
  assert.match(none, /No checks ran in this run\./);
  assert.match(none, /## Not proven\n\nNothing listed\./);
});

// ---------------------------------------------------------------- reading the run folder

test('loadRunOutputs reads final/ and the newest gate summary, and falls back to run.outputs', async t => {
  const dataDir = tempDir('ws-rep-data-', t);
  const r = run({ outputs: { investigate: { hypotheses: [], pinnable: true }, triage: { items: [{ ref: 'kept' }] } } });
  const dir = join(dataDir, 'runs', 'example', r.id);
  await writeJsonAtomic(join(dir, 'final', 'review.json'), review());
  await writeJsonAtomic(join(dir, 'final', 'triage.json'), { items: [{ ref: 'from-file' }] });
  await writeJsonAtomic(join(dir, 'gates', '06-checks', 'summary.json'), { result: 'fail', chip: 'old' });
  await writeJsonAtomic(join(dir, 'gates', '06-checks-r2', 'summary.json'), { result: 'pass', chip: 'new' });
  const o = await loadRunOutputs(dataDir, r);
  assert.equal(o.review.verdict, 'fix');
  assert.deepEqual(o.triage.items, [{ ref: 'from-file' }], 'the final/ file wins');
  assert.deepEqual(o.diagnosis, { hypotheses: [], pinnable: true }, 'from run.outputs.investigate');
  assert.equal(o.checks.chip, 'new');
  assert.equal(o.answer, null);
  assert.equal(o.proof, null);
  await assert.rejects(loadRunOutputs(dataDir, run({ id: '..' })), e => e.status === 400);
  const saved = await saveRunReport({ root: dataDir, dataDir, run: r, profile: fakeProfile(), runTool: recorder(), now: NOW });
  assert.match(readFileSync(join(saved.dir, saved.file), 'utf8'), /Verdict: \*\*fix\*\*/, 'outputs are read from the run when not passed');
  assert.match(readFileSync(join(saved.dir, saved.file), 'utf8'), /<!-- workspace-app run: 260120-104212-review-loan-export -->\n$/);
});
