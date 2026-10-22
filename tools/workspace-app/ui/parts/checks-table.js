// The checks table (SPEC 5.7 "Checks", mockup table.ctable): one row per check of a gate's
// summary.json (gates/check.mjs runChecks): the group and label, the result as words with an
// icon character, how long it took, and a link to the check's log. Shared: the review gate shows
// the last gate's checks with it, and the live run view shows a Check run's result with it.
//
// The result is always said in words ("Pass", "Fail: 2 new", "Not run: no router file
// changed"); the icon and the colour only repeat it (SPEC 5.11). A log opens in the page's
// dialog through GET /api/run-file?name=log, which serves only a log that the gate's own summary
// names, and shows as text. Failing tests are listed under their row as text too.
import { api, fmtDuration, h, plural, qs } from '../lib.js';
import { openDialog } from '../dialog.js';

// Check status -> [css class, icon character, word].
const RESULTS = {
  pass: ['pass', '✓', 'Pass'],
  fail: ['fail', '✗', 'Fail'],
  error: ['fail', '✗', 'Error'],
  warn: ['warn', '!', 'Warning'],
  skip: ['skip', '–', 'Not run'],
  running: ['skip', '…', 'Running'],
  cancelled: ['skip', '–', 'Cancelled'],
};
// Summary result -> [badge class, word] for the chip in a card head.
const OVERALL = {
  pass: ['ok', 'Green'],
  fail: ['red', 'Red'],
  error: ['red', 'Error'],
  refused: ['amber', 'Refused'],
  cancelled: ['', 'Cancelled'],
};
const FAILURES_SHOWN = 10;

const asList = x => (Array.isArray(x) ? x : []);
const noDot = s => String(s || '').trim().replace(/\.$/, '');

// The words of a check's result: "Pass", "Fail: 2 new", or the reason itself for a warning or a
// check that did not run (the reason already says "Pass, 1 allowed by you" or "Not run: ...").
export function resultText(check) {
  const status = String((check && check.status) || '');
  const reason = noDot(check && check.reason);
  const word = (RESULTS[status] || [null, null, status || 'Unknown'])[2];
  if (status === 'warn' || status === 'skip') return reason || word;
  if (status === 'fail' || status === 'error') return reason ? `${word}: ${reason}` : word;
  return reason ? `${word} · ${reason}` : word;
}

// "77 ms" reads oddly next to "4 m 12 s": under a second shows as "< 1 s", nothing as "–".
export function tookText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '–';
  return ms < 1000 ? '< 1 s' : fmtDuration(ms);
}

// The chip for a card head: "Green · 0 new · 61 known · 1 flaky" as a badge (null without a
// summary). The word comes first, so the colour never carries the result alone.
export function checksChip(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const [cls, word] = OVERALL[summary.result] || ['', String(summary.result || 'Unknown')];
  const counts = summary.counts || {};
  let chip = noDot(summary.chip);
  if (counts.flaky && !/flaky/.test(chip)) chip = chip ? `${chip} · ${counts.flaky} flaky` : `${counts.flaky} flaky`;
  return h('span', { class: cls ? `badge ${cls}` : 'badge' }, chip ? `${word} · ${chip}` : word);
}

// Opens a check's log in the dialog. The text arrives redacted and capped at 2 MB.
async function showLog(runId, gate, check) {
  const label = check.label || check.id;
  const out = h('pre', { class: 'output ctable-log', tabindex: '0', 'aria-label': `Log of ${label}` }, 'Loading…');
  const cut = h('p', { class: 'note', hidden: true }, 'The log is longer than 2 MB; this shows the start of it.');
  openDialog(`Log: ${label}`, h('div', { class: 'vgrid' },
    h('p', { class: 'muted small' }, check.command ? ['Command: ', h('code', {}, check.command)] : 'This check ran inside the app.'),
    cut, out), { wide: true });
  try {
    const r = await api(`/api/run-file?${qs({ id: runId, name: 'log', gate: String(gate).replace(/^gates\//, ''), check: check.id })}`);
    out.textContent = r.text || '(The log is empty.)';
    cut.hidden = !r.truncated;
  } catch (e) {
    out.textContent = e.status === 404 ? `There is no log for this check. ${e.message}` : `The log could not be loaded: ${e.message}`;
  }
}

// The failing tests of a check (details.failures, or details.new ids), as a closed <details>.
function failureList(check) {
  const d = check.details || {};
  const failures = asList(d.failures).filter(f => f && f.id);
  const rows = failures.length ? failures : asList(d.new).map(id => ({ id: String(id) }));
  if (!rows.length) return null;
  const shown = rows.slice(0, FAILURES_SHOWN);
  return h('details', { class: 'ctable-fail' },
    h('summary', {}, plural(rows.length, 'failing test')),
    h('ul', {}, shown.map(f => h('li', {},
      h('code', {}, f.id),
      f.message ? h('span', { class: 'ctable-msg' }, String(f.message).split('\n').find(l => l.trim()) || '') : null))),
    rows.length > shown.length ? h('p', { class: 'muted small' }, `${rows.length - shown.length} more in the log.`) : null);
}

function row(check, { runId, gate }) {
  const [cls, mark] = RESULTS[check.status] || ['skip', '?'];
  const text = resultText(check);
  const label = check.label || check.id || 'Check';
  const canLog = !!(runId && gate && check.id && typeof check.log === 'string' && check.log);
  return h('tr', {},
    h('td', {},
      check.group ? h('span', { class: 'ctable-group' }, check.group) : null,
      h('span', { title: check.command || null }, label)),
    h('td', {},
      h('span', { class: `res ${cls}${text.length > 26 ? ' long' : ''}` }, h('span', { 'aria-hidden': 'true' }, mark), text),
      check.status === 'fail' ? failureList(check) : null),
    h('td', { class: 'ctable-took' }, tookText(check.durationMs)),
    h('td', {}, canLog
      ? h('button', { class: 'link', type: 'button', 'aria-label': `Log of ${label}`, on: { click: () => showLog(runId, gate, check) } }, 'Log')
      : [h('span', { class: 'muted', 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'No log')]));
}

// checksTable(summary, { runId, gate, caption }) -> an element with the table, the refusal (when
// the checks refused the tree), and the flaky note. `gate` is the gate folder the summary came
// from (run.lastGate.folder, "gates/06-checks-r2"); without runId and gate the Log column shows
// dashes. A missing summary gives a short muted line.
export function checksTable(summary, { runId = '', gate = '', caption = 'Check results' } = {}) {
  if (!summary || typeof summary !== 'object') return h('p', { class: 'muted' }, 'No check results for this run yet.');
  const checks = asList(summary.checks).filter(c => c && typeof c === 'object');
  const flaky = asList(summary.tests && summary.tests.flaky).map(String);
  return h('div', { class: 'checks-table' },
    summary.refusal ? h('p', { class: 'note red' }, `The checks refused this tree: ${summary.refusal}`) : null,
    checks.length
      ? h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable' },
        h('caption', { class: 'sr-only' }, caption),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Check'), h('th', { scope: 'col' }, 'Result'), h('th', { scope: 'col' }, 'Took'), h('th', { scope: 'col' }, 'Log'))),
        h('tbody', {}, checks.map(c => row(c, { runId, gate })))))
      : h('p', { class: 'muted' }, 'No checks ran.'),
    flaky.length
      ? h('p', { class: 'muted small mt-2' }, 'Flaky: ', flaky.slice(0, 5).map((id, i) => [i ? ', ' : '', h('code', {}, id)]),
        flaky.length > 5 ? ` and ${flaky.length - 5} more` : '',
        ' failed once and passed on the retry. Logged, not blocking.')
      : null);
}
