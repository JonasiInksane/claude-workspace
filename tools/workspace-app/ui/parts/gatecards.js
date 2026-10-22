// The gate cards of a run that waits for you (SPEC 5.6 table, mockup #r-gate and #r-ready), one
// per waiting kind:
//   plan, spec      the summary, slices as a radio list, the slice's files with Remove boxes ("new"
//                   marked), risk tags, must-tick files to tick, Claude's questions with answer
//                   fields, notes; Approve and Revise. The spec adds acceptance, the schema change
//                   and the migration plan as text (the app never migrates).
//   hypothesis      the hypotheses as a radio list with evidence and confidence; Approve and
//                   Revise; "Not pinnable" when no failing test can reproduce the bug.
//   fence           the files outside the plan with Claude's reason quoted as data; Allow for
//                   this run, Send back (leave them out), Stop, keep patch.
//   review, commit  "Review gate ready", which opens #review/<id> (UI-REVIEW's screen).
//   triage, decide  the findings (review runs) or triaged items (architecture runs) with Fix or
//                   Accept, Dismiss (with a reason) and Keep, Make finding, Save and Done.
//
// Everything Claude wrote is shown as text through h(). A card is built once per wait (the view
// rebuilds it only when the waiting kind or its start time changes), so what you tick and type
// survives the 2 s polling; update(run, busy) refreshes only the buttons. Buttons come from
// run.actions: one that can't act now keeps its place in the tab order (aria-disabled) and says
// why in visible text next to it (SPEC 5.11). The pure helpers are exported for tests.
import { act as toastResult, api, h, icon, keyed, plural } from '../lib.js';

const asList = x => (Array.isArray(x) ? x : []);
const unique = list => [...new Set(list)];
const pathOf = f => (f && typeof f === 'object' ? String(f.path || '') : String(f || ''));
let uid = 0;
const nextId = prefix => `${prefix}-${++uid}`;

const ALERT = '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>';
const CHECK = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';
const BUSY = 'Wait: another action is still running.';

// ---------------------------------------------------------------- pure helpers

// One action of run.actions ({ action, label, enabled, reason }), or null.
export const actionOf = (run, name) => asList(run && run.actions).find(a => a && a.action === name) || null;

// '<kind>|<since>' while the run waits, '' otherwise: the view rebuilds the card when it changes.
export function gateKey(run) {
  if (!run || run.status !== 'waiting' || !run.waiting) return '';
  return `${run.waiting.kind || ''}|${run.waiting.since || ''}`;
}

// The files a plan or spec proposes for one slice: the slice's own list, or the plan's file list
// (the same rule as the server's proposedFiles).
export function sliceFiles(output, slice) {
  const s = asList(output && output.slices)[slice] || {};
  const own = asList(s.files).map(pathOf).filter(Boolean);
  return unique(own.length ? own : asList(output && output.files).map(pathOf).filter(Boolean));
}

// The paths named in a hypothesis's evidence ("src/a.js:12 shows …" -> "src/a.js"), like the
// server's evidencePaths: the first word, without a :line or :line:col suffix.
export function evidencePaths(evidence) {
  const out = [];
  for (const e of asList(evidence)) {
    let p = String(e).trim().split(/[\s,;]/)[0].replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
    p = p.replace(/\/+/g, '/').replace(/\/$/, '');
    if (!p || p.length > 300 || /^[A-Za-z]:/.test(p) || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '.')) continue;
    if (/^[A-Za-z0-9_@.()[\] +,=-][A-Za-z0-9_@.()[\] +,=/-]*$/.test(p)) out.push(p);
  }
  return unique(out);
}

// What Send back says at the fence gate when you write no note yourself.
export function fenceNote(paths) {
  const list = asList(paths);
  if (!list.length) return '';
  return list.length === 1 ? `Leave ${list[0]} out of this change.` : `Leave these files out of this change: ${list.join(', ')}.`;
}

// Triage decisions that differ from what the run has saved: [{ ref, decision, reason }].
// picks and saved are Maps of ref -> { decision, reason } (saved values may be null).
export function changedDecisions(picks, saved) {
  const out = [];
  for (const [ref, p] of picks) {
    if (!p || !p.decision) continue;
    const s = saved.get(ref);
    const reason = String(p.reason || '').trim();
    if (s && s.decision === p.decision && String(s.reason || '').trim() === reason) continue;
    out.push({ ref, decision: p.decision, reason });
  }
  return out;
}

// The first reason the decisions can't be saved, or ''.
export function decisionsProblem(decisions) {
  const bad = asList(decisions).find(d => d.decision === 'dismiss' && !d.reason);
  if (bad) return `Say why you dismiss ${bad.ref}.`;
  const long = asList(decisions).find(d => d.reason.length > 300);
  return long ? `The reason for ${long.ref} is longer than 300 characters.` : '';
}

// ---------------------------------------------------------------- buttons with reasons

// A button and its "why not" text. set(enabled, reason, label) updates both. A button that can't
// act stays focusable (aria-disabled, not disabled), so a keyboard or screen-reader user still
// reaches it and hears the reason through aria-describedby; clicks on it do nothing.
export function actButton(label, onClick, { cls = '', key = '', iconMarkup = '' } = {}) {
  const why = h('span', { class: 'reason', id: nextId('why'), hidden: true });
  const text = h('span', {}, label);
  const btn = h('button', {
    class: cls ? `btn ${cls}` : 'btn', type: 'button',
    on: { click: e => { if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; } onClick(e); } },
  }, iconMarkup ? icon(iconMarkup) : null, text);
  const el = h('span', { class: 'act' }, btn, why);
  if (key) keyed(el, key);
  return {
    el, btn,
    set(enabled, reason = '', newLabel) {
      if (newLabel !== undefined && text.textContent !== newLabel) text.textContent = newLabel;
      if (enabled) btn.removeAttribute('aria-disabled'); else btn.setAttribute('aria-disabled', 'true');
      why.textContent = enabled ? '' : reason;
      why.hidden = enabled || !reason;
      if (!enabled && reason) btn.setAttribute('aria-describedby', why.id); else btn.removeAttribute('aria-describedby');
    },
  };
}

// Sets a button from its run action: off with the server's reason, off while another action
// runs, off with a local reason (an empty form), else on. `label` overrides the action's label.
export function setFrom(b, a, busy = '', local = '', label) {
  const text = label || (a && a.label) || undefined;
  if (!a) b.set(false, 'This run does not offer this action.', text);
  else if (!a.enabled) b.set(false, a.reason || 'Not possible now.', text);
  else if (busy) b.set(false, BUSY, text);
  else if (local) b.set(false, local, text);
  else b.set(true, '', text);
}

// ---------------------------------------------------------------- shared pieces

function cardShell(title, { cls = '', mark = ALERT } = {}) {
  const id = nextId('gc-h');
  return h('section', { class: `gatecard${cls ? ` ${cls}` : ''}`, 'aria-labelledby': id }, h('h3', { id }, icon(mark), title));
}

function notesField(label, hint, onInput) {
  const id = nextId('gc-notes');
  return keyed(h('div', { class: 'gc-field' },
    h('label', { for: id }, label), hint ? h('small', { class: 'muted' }, hint) : null,
    h('textarea', { id, rows: '2', maxlength: '2000', on: { input: e => onInput(e.target.value) } })), `notes-${label}`);
}

function list(items, cls = 'gc-list') {
  return h('ul', { class: cls }, items.map(x => h('li', {}, x)));
}

const SEVERITY = { high: 'red', medium: 'amber', low: '' };
const sevBadge = sev => h('span', { class: `badge ${SEVERITY[sev] || ''}`.trim() }, String(sev || 'unrated'));
const VERDICTS = { issue: ['Issue', 'red'], noise: ['Noise', ''], 'owner-decision': ['You decide', 'amber'] };

// The must-tick block: config files that Claude may change only when ticked.
function tickBlock(files, ticked, takeOver, onChange) {
  if (!files.length) return null;
  return h('fieldset', { class: 'gc-set gc-tick' },
    h('legend', {}, 'Files that need your tick'),
    h('p', { class: 'small' }, 'Config files: Claude may change one only when you tick it. Unticked, the checks refuse any change to it.'),
    files.map(f => keyed(h('div', { class: 'gc-tickrow' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: ticked.has(f), on: { change: e => { if (e.target.checked) ticked.add(f); else ticked.delete(f); onChange(); } } }),
        'Allow changes to ', h('code', {}, f)),
      takeOver.has(f) ? h('p', { class: 'note small' }, 'A stage cannot edit this file (protected config). Edit it yourself after Open in terminal.') : null), `tick-${f}`)));
}

// ---------------------------------------------------------------- plan and spec

function riskLine(run, detail) {
  const tags = unique([...asList(detail.riskTags), ...asList(run.riskTags)].map(String));
  const reasons = unique([...asList(detail.levelReason), ...asList(run.levelReason)].map(String));
  if (!tags.length && !reasons.length && !run.level) return null;
  return h('p', { class: 'small gc-risk' },
    run.level ? ['How careful: ', h('b', {}, run.level)] : null,
    tags.length ? [' · risk tags: ', tags.map(t => h('span', { class: 'badge amber' }, t))] : null,
    reasons.length ? ` (${reasons.join('; ')})` : '');
}

function planCard(run, ctx, kind) {
  const out = (run.outputs && run.outputs.scope) || {};
  const detail = (run.waiting && run.waiting.detail) || {};
  const isSpec = kind === 'spec';
  const slices = asList(out.slices);
  const whyOf = new Map(asList(out.files).filter(f => f && typeof f === 'object').map(f => [String(f.path), String(f.why || '')]));
  const fresh = new Set([...asList(detail.newFiles), ...asList(run.newFiles)]);
  const takeOver = new Set(asList(detail.editInTakeOver));
  const questions = asList(out.questions).map(String);
  const st = { slice: 0, removed: new Set(), ticked: new Set(), answers: new Map(), notes: '' };
  let current = run;
  let busyNow = '';

  const el = cardShell(isSpec ? 'Needs your OK: the spec' : 'Needs your OK: the plan');
  if (out.summary) el.append(h('p', { class: 'gc-summary' }, String(out.summary)));
  const risk = riskLine(run, detail);
  if (risk) el.append(risk);

  if (isSpec) {
    const acc = asList(out.acceptance).map(String);
    if (acc.length) el.append(h('div', { class: 'gc-block' }, h('h4', {}, 'Acceptance'), list(acc)));
    el.append(h('p', { class: 'small' }, out.schemaChange
      ? ['Database schema: ', h('b', {}, 'changes'), '. The app never migrates: you run any migration yourself.']
      : 'Database schema: no change.'));
    if (out.migrationPlan) el.append(h('div', { class: 'gc-block' }, h('h4', {}, 'Migration plan (as text)'), h('p', { class: 'gc-pre' }, String(out.migrationPlan))));
  }
  const risks = asList(out.risks).map(r => (typeof r === 'string' ? r : `${r.kind || 'risk'}${r.path ? ` · ${r.path}` : ''}: ${r.note || ''}`));
  if (risks.length) el.append(h('div', { class: 'gc-block' }, h('h4', {}, 'Risks Claude sees'), list(risks)));

  const sliceName = nextId('gc-slice');
  if (slices.length) {
    el.append(h('fieldset', { class: 'gc-set' }, h('legend', {}, isSpec ? 'Slice to build first' : 'Slice to build'),
      slices.map((s, i) => keyed(h('label', { class: 'gc-opt' },
        h('input', { type: 'radio', name: sliceName, value: String(i), checked: i === 0, on: { change: () => { st.slice = i; drawFiles(); refresh(); } } }),
        h('span', {},
          h('b', {}, `${i + 1}. ${s.title || 'Slice'}`), s.surface ? ` (${s.surface})` : '',
          s.goal ? h('span', { class: 'gc-sub' }, String(s.goal)) : null,
          h('small', { class: 'muted gc-sub' }, [
            asList(s.tests).length ? plural(asList(s.tests).length, 'test') : 'no tests named',
            Number.isFinite(s.estLines) ? `about ${s.estLines} lines` : '',
            asList(s.outOfScope).length ? `out of scope: ${asList(s.outOfScope).join(', ')}` : '',
          ].filter(Boolean).join(' · ')))), `slice-${i}`))));
  }

  const filesSet = h('fieldset', { class: 'gc-set' });
  const tickBox = h('div');
  el.append(filesSet, tickBox);
  function drawTicks() {
    const files = sliceFiles(out, st.slice).filter(f => !st.removed.has(f));
    const must = asList(detail.mustTick).map(String).filter(f => files.includes(f));
    for (const f of [...st.ticked]) if (!must.includes(f)) st.ticked.delete(f);
    tickBox.replaceChildren(...[tickBlock(must, st.ticked, takeOver, refresh)].filter(Boolean));
  }
  function drawFiles() {
    const files = sliceFiles(out, st.slice);
    for (const f of [...st.removed]) if (!files.includes(f)) st.removed.delete(f);
    const tests = asList((slices[st.slice] || {}).tests).map(String);
    filesSet.replaceChildren(...[h('legend', {}, `Files Claude may change (${files.length})`),
      files.length ? h('ul', { class: 'gc-files' }, files.map(f => keyed(h('li', {},
        h('span', { class: 'gc-file' }, h('code', {}, f), fresh.has(f) ? h('span', { class: 'badge blue' }, 'new') : null,
          whyOf.get(f) ? h('span', { class: 'muted small' }, whyOf.get(f)) : null),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: st.removed.has(f), on: { change: e => { if (e.target.checked) st.removed.add(f); else st.removed.delete(f); drawTicks(); refresh(); } } }),
          'Remove', h('span', { class: 'sr-only' }, ` ${f} from the plan`))), `file-${f}`)))
        : h('p', { class: 'small muted' }, 'This slice names no files.'),
      tests.length ? h('p', { class: 'small gc-tests' }, 'Tests: ', tests.map((t, i) => [i ? ', ' : '', h('code', {}, t)])) : null].filter(Boolean));
    drawTicks();
  }
  drawFiles();

  if (questions.length) {
    el.append(h('fieldset', { class: 'gc-set' }, h('legend', {}, 'Claude asks'),
      questions.map((q, i) => {
        const id = nextId('gc-q');
        return keyed(h('div', { class: 'gc-field' }, h('label', { for: id }, q),
          h('input', { id, type: 'text', maxlength: '2000', on: { input: e => st.answers.set(q, e.target.value) } })), `q-${i}`);
      })));
  }
  el.append(notesField('Notes for Claude', 'Optional when you approve. Revise sends them back to Scope.', v => { st.notes = v; refresh(); }));

  const approve = actButton(isSpec ? 'Approve spec' : 'Approve plan', () => ctx.act('approve', {
    slice: st.slice,
    removedFiles: [...st.removed],
    ticked: [...st.ticked],
    answers: [...st.answers].map(([q, a]) => ({ q, a: String(a).trim() })).filter(x => x.a),
    notes: st.notes.trim(),
  }), { cls: 'primary', key: 'gc-approve' });
  const revise = actButton('Revise', () => ctx.act('revise', { notes: st.notes.trim() }), { key: 'gc-revise' });
  el.append(h('div', { class: 'row-actions gc-actions' }, approve.el, revise.el));

  function refresh() {
    const kept = sliceFiles(out, st.slice).filter(f => !st.removed.has(f)).length;
    setFrom(approve, actionOf(current, 'approve'), busyNow, kept ? '' : 'Keep at least one file in the plan, or revise it.');
    setFrom(revise, actionOf(current, 'revise'), busyNow, st.notes.trim() ? '' : 'Write in the notes what should change first.');
  }
  return { el, update(next, busy) { current = next; busyNow = busy; refresh(); } };
}

// ---------------------------------------------------------------- hypothesis (debug)

function hypothesisCard(run, ctx) {
  const diag = (run.outputs && run.outputs.investigate) || {};
  const detail = (run.waiting && run.waiting.detail) || {};
  const hyps = asList(diag.hypotheses);
  const pinnable = detail.pinnable !== false && diag.pinnable !== false;
  const takeOver = new Set(asList(detail.editInTakeOver));
  const st = { pick: 0, ticked: new Set(), notes: '' };
  let current = run;
  let busyNow = '';

  const el = cardShell('Needs your OK: pick a hypothesis');
  if (!pinnable) {
    el.append(h('p', { class: 'note' }, 'Not pinnable: Claude found no failing test that can reproduce this bug. If you approve, the run stops with the diagnosis, and Open in terminal stays available.'));
  }
  const name = nextId('gc-hyp');
  el.append(h('fieldset', { class: 'gc-set' }, h('legend', {}, 'Hypothesis to prove'),
    hyps.length ? hyps.map((x, i) => keyed(h('label', { class: 'gc-opt' },
      h('input', { type: 'radio', name, value: String(i), checked: i === 0, on: { change: () => { st.pick = i; drawTicks(); refresh(); } } }),
      h('span', {},
        h('b', {}, `${i + 1}. ${x.claim || 'Hypothesis'}`),
        h('span', { class: 'gc-sub small' }, `Confidence: ${x.confidence || 'not given'}`),
        asList(x.evidence).length ? h('ul', { class: 'gc-list gc-ev' }, asList(x.evidence).map(e => h('li', {}, h('code', {}, String(e))))) : null,
        x.howToProve ? h('span', { class: 'gc-sub small' }, `How to prove it: ${x.howToProve}`) : null)), `hyp-${i}`))
      : h('p', { class: 'small muted' }, 'Claude returned no hypotheses. Revise, or cancel the run.')));
  if (diag.reproPlan) el.append(h('div', { class: 'gc-block' }, h('h4', {}, 'How to reproduce'), h('p', { class: 'gc-pre' }, String(diag.reproPlan))));
  const tickBox = h('div');
  el.append(tickBox);
  function drawTicks() {
    const files = evidencePaths((hyps[st.pick] || {}).evidence);
    const must = asList(detail.mustTick).map(String).filter(f => files.includes(f));
    for (const f of [...st.ticked]) if (!must.includes(f)) st.ticked.delete(f);
    tickBox.replaceChildren(...[tickBlock(must, st.ticked, takeOver, refresh)].filter(Boolean));
  }
  drawTicks();
  el.append(notesField('Notes for Claude', 'Optional when you approve. Revise sends them back to Investigate.', v => { st.notes = v; refresh(); }));

  const approve = actButton('Approve hypothesis', () => ctx.act('approve', { hypothesis: st.pick, ticked: [...st.ticked], notes: st.notes.trim() }), { cls: 'primary', key: 'gc-approve' });
  const revise = actButton('Revise', () => ctx.act('revise', { notes: st.notes.trim() }), { key: 'gc-revise' });
  el.append(h('div', { class: 'row-actions gc-actions' }, approve.el, revise.el));

  function refresh() {
    const files = evidencePaths((hyps[st.pick] || {}).evidence);
    setFrom(approve, actionOf(current, 'approve'), busyNow,
      !hyps.length ? 'There is no hypothesis to approve.' : files.length ? '' : 'This hypothesis names no file in its evidence; revise it instead.',
      pinnable ? undefined : 'Approve: stop with the diagnosis');
    setFrom(revise, actionOf(current, 'revise'), busyNow, st.notes.trim() ? '' : 'Write in the notes what should change first.');
  }
  return { el, update(next, busy) { current = next; busyNow = busy; refresh(); } };
}

// ---------------------------------------------------------------- fence

function fenceCard(run, ctx) {
  const d = (run.waiting && run.waiting.detail) || {};
  const paths = asList(d.paths).map(String);
  const reasons = d.reasons && typeof d.reasons === 'object' ? d.reasons : {};
  const red = asList(d.red).map(String);
  const picked = new Set(paths);
  let note = '';
  let current = run;
  let busyNow = '';
  const one = paths.length === 1;

  const el = cardShell(one ? 'Needs your OK: file outside the plan' : `Needs your OK: ${paths.length} files outside the plan`);
  el.append(h('p', {}, 'Implement changed ', one ? h('code', {}, paths[0]) : plural(paths.length, 'file'),
    one ? '. It was not in the plan you approved.' : ' that were not in the plan you approved.'));
  el.append(h('ul', { class: 'gc-fence' }, paths.map(p => keyed(h('li', {},
    one ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: true, on: { change: e => { if (e.target.checked) picked.add(p); else picked.delete(p); refresh(); } } }),
      h('span', { class: 'sr-only' }, 'Include '), h('code', {}, p)),
    one ? null : h('br'),
    reasons[p]
      ? h('span', { class: 'small' }, 'Claude\'s reason, quoted as data: ', h('q', { class: 'gc-quote' }, String(reasons[p])))
      : h('span', { class: 'small muted' }, 'Claude gave no reason for this file.')), `fence-${p}`))));
  if (red.length) el.append(h('div', { class: 'note red small' }, 'Other checks are red too: ', list(red)));
  el.append(h('p', { class: 'small muted' }, `If you allow ${one ? 'it' : 'them'}, the checks run again and ${one ? 'the file shows' : 'the files show'} in red at the review gate.`));
  el.append(notesField('Note for Claude (Send back)', `Optional. Without one, Claude reads: "${fenceNote(paths)}"`, v => { note = v; }));

  const base = p => p.split('/').pop();
  const allow = actButton('Allow for this run', () => ctx.act('allow', { paths: [...picked] }), { cls: 'primary', key: 'gc-allow' });
  const back = actButton(one ? `Send back: leave ${base(paths[0])} out` : 'Send back: leave them out',
    () => ctx.act('sendback', { note: note.trim() || fenceNote([...picked]), leaveOut: [...picked] }), { key: 'gc-back' });
  const stop = actButton('Stop, keep patch', () => ctx.act('stop', {}, {
    confirm: ['Stop this run?', 'Your changes are saved to final/stopped.patch and the run worktree is reset. The lock is released.', 'Stop, keep patch'],
  }), { cls: 'ghost', key: 'gc-stop' });
  el.append(h('div', { class: 'row-actions gc-actions' }, allow.el, back.el, stop.el));

  function refresh() {
    const none = picked.size ? '' : 'Tick at least one file first.';
    setFrom(allow, actionOf(current, 'allow'), busyNow, none, 'Allow for this run');
    setFrom(back, actionOf(current, 'sendback'), busyNow, none, one ? `Send back: leave ${base(paths[0])} out` : 'Send back: leave them out');
    setFrom(stop, actionOf(current, 'stop'), busyNow);
  }
  return { el, update(next, busy) { current = next; busyNow = busy; refresh(); } };
}

// ---------------------------------------------------------------- review and commit

function readyCard(run, ctx, kind) {
  const d = (run.waiting && run.waiting.detail) || {};
  const n = Number(d.findings) || 0;
  const el = cardShell(kind === 'commit' ? 'Ready to commit' : 'Review gate ready', { cls: 'ready', mark: CHECK });
  el.append(h('p', {},
    kind === 'commit' ? 'You approved the change. ' : 'All checks passed. ',
    d.verdict ? ['The fresh reviewer says ', h('b', {}, String(d.verdict)), ` with ${plural(n, 'finding')}. `] : '',
    kind === 'review' ? (d.verified ? 'Verify ran on the findings. ' : 'Verify did not run: quick review. ') : '',
    'Nothing is committed until you click.'));
  if (kind === 'commit' && asList(d.files).length) el.append(h('p', { class: 'small muted' }, `${plural(asList(d.files).length, 'file')} will be staged, exactly the ones the gates checked.`));
  const open = keyed(h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.go('review', run.id) } }, 'Open review gate'), 'gc-open');
  el.append(h('div', { class: 'row-actions gc-actions' }, open));
  return { el, update() {} };
}

// ---------------------------------------------------------------- triage (review) and decide (architecture)

function triageCard(run, ctx, kind) {
  const isReview = kind === 'triage';
  const itemsOf = r => (isReview
    ? asList(r.outputs && r.outputs.review && r.outputs.review.findings)
    : asList(r.outputs && r.outputs.triage && r.outputs.triage.items));
  const refOf = it => String(isReview ? it.id : it.ref);
  const savedOf = r => new Map(itemsOf(r).map(it => [refOf(it), it.triage ? { decision: it.triage.decision, reason: it.triage.reason || '' } : null]));
  const choices = isReview ? [['fix', 'Fix'], ['dismiss', 'Dismiss'], ['keep', 'Keep']] : [['accept', 'Accept as finding'], ['dismiss', 'Dismiss'], ['keep', 'Keep']];
  const words = { fix: 'to fix', dismiss: 'dismissed', keep: 'kept', accept: 'accepted as a finding' };
  const items = itemsOf(run);
  let saved = savedOf(run);
  const picks = new Map();
  const savedText = new Map(); // ref -> its "Saved: …" line
  let current = run;
  let busyNow = '';

  const el = cardShell(isReview ? `Needs you: triage ${plural(items.length, 'finding')}` : `Needs you: decide on ${plural(items.length, 'item')}`);
  el.append(h('p', { class: 'small' }, isReview
    ? 'Fix, dismiss with a reason, or keep each finding. Save, then Done ends the run.'
    : 'Accept what should become a finding, dismiss with a reason, or keep it for later. Save, then Done ends the run.'));
  if (isReview) {
    const review = (run.outputs && run.outputs.review) || {};
    if (review.verdict) el.append(h('p', { class: 'small' }, 'Verdict: ', h('b', {}, String(review.verdict)), review.verified ? ' · verified' : ' · verify did not run'));
    if (asList(review.notProven).length) el.append(h('div', { class: 'gc-block' }, h('h4', {}, 'Not proven'), list(asList(review.notProven).map(String))));
  }
  if (!items.length) el.append(h('p', { class: 'muted small' }, isReview ? 'No findings.' : 'No items.'));

  el.append(h('ul', { class: 'gc-items' }, items.map(it => {
    const ref = refOf(it);
    const pick = { decision: (saved.get(ref) || {}).decision || '', reason: (saved.get(ref) || {}).reason || '' };
    picks.set(ref, pick);
    const reasonId = nextId('gc-why');
    const reasonInput = h('input', { id: reasonId, type: 'text', maxlength: '300', value: pick.reason, on: { input: e => { pick.reason = e.target.value; refresh(); } } });
    const reasonBox = h('div', { class: 'gc-field gc-why', hidden: pick.decision !== 'dismiss' }, h('label', { for: reasonId }, `Why dismiss ${ref}?`), reasonInput);
    const name = nextId('gc-dec');
    const verdict = VERDICTS[it.verdict];
    const status = h('p', { class: 'small muted gc-saved' });
    savedText.set(ref, status);
    const where = it.path ? `${it.path}${it.line ? `:${it.line}` : ''}` : '';
    const propose = h('button', {
      class: 'link small', type: 'button',
      on: { click: () => toastResult(api('/api/findings/propose', { method: 'POST', body: { project: run.project, runId: run.id, ref } })) },
    }, 'Make finding');
    return keyed(h('li', { class: `gc-item${it.status === 'unconfirmed' ? ' unconfirmed' : ''}` },
      h('div', { class: 'gc-item-head' }, h('b', {}, ref),
        isReview ? sevBadge(it.severity) : null,
        isReview && it.kind === 'follow-up' ? h('span', { class: 'badge' }, 'follow-up') : null,
        verdict ? h('span', { class: `badge ${verdict[1]}`.trim() }, verdict[0]) : null,
        it.rule ? h('span', { class: 'muted small' }, String(it.rule)) : null,
        where ? h('code', {}, where) : null),
      it.claim ? h('p', {}, String(it.claim)) : null,
      it.evidence ? h('p', { class: 'gc-ev-text' }, String(it.evidence)) : null,
      it.suggestion ? h('p', { class: 'small' }, `Suggestion: ${it.suggestion}`) : null,
      !isReview && it.reason ? h('p', { class: 'small' }, String(it.reason)) : null,
      !isReview && it.suggestedSlice ? h('p', { class: 'small' }, `Suggested slice: ${it.suggestedSlice}`) : null,
      it.status === 'unconfirmed' ? h('p', { class: 'small muted' }, 'Verify could not confirm this one. Kept and shown, never dropped.') : null,
      h('fieldset', { class: 'gc-choice' }, h('legend', { class: 'sr-only' }, `Decision for ${ref}`),
        choices.map(([value, label]) => h('label', { class: 'check' },
          h('input', {
            type: 'radio', name, value, checked: pick.decision === value,
            on: { change: () => { pick.decision = value; reasonBox.hidden = value !== 'dismiss'; refresh(); if (value === 'dismiss') reasonInput.focus(); } },
          }), label)),
        propose),
      reasonBox, status), `item-${ref}`);
  })));

  const save = actButton('Save triage', () => ctx.act('triage', { decisions: changedDecisions(picks, saved) }), { cls: 'primary', key: 'gc-save' });
  const done = actButton('Done', async () => {
    const pending = changedDecisions(picks, saved);
    if (pending.length && !(await ctx.act('triage', { decisions: pending }))) return;
    await ctx.act('done', {});
  }, { key: 'gc-done' });
  el.append(h('div', { class: 'row-actions gc-actions' }, save.el, done.el));

  function refresh() {
    const pending = changedDecisions(picks, saved);
    const problem = decisionsProblem(pending);
    setFrom(save, actionOf(current, 'triage'), busyNow, pending.length ? problem : `Pick ${isReview ? 'Fix' : 'Accept'}, Dismiss or Keep for an item first.`);
    setFrom(done, actionOf(current, 'done'), busyNow, problem, pending.length ? 'Save and finish' : 'Done');
    for (const [ref, line] of savedText) {
      const s = saved.get(ref);
      line.textContent = s && s.decision ? `Saved: ${words[s.decision] || s.decision}${s.reason ? ` (${s.reason})` : ''}.` : '';
      line.hidden = !line.textContent;
    }
  }
  return { el, update(next, busy) { current = next; busyNow = busy; saved = savedOf(next); refresh(); } };
}

// ---------------------------------------------------------------- the card for a run

// The card for the run's wait, or null when it waits for nothing. ctx: { act(action, payload,
// { confirm }) -> Promise of the answer (null after an error), go(view, sub), busy() -> the
// action in flight or '' }. The view calls update(run, busy) after every pull.
export function gateCard(run, ctx) {
  const kind = gateKey(run) ? String(run.waiting.kind || '') : '';
  let card = null;
  if (kind === 'plan' || kind === 'spec') card = planCard(run, ctx, kind);
  else if (kind === 'hypothesis') card = hypothesisCard(run, ctx);
  else if (kind === 'fence') card = fenceCard(run, ctx);
  else if (kind === 'review' || kind === 'commit') card = readyCard(run, ctx, kind);
  else if (kind === 'triage' || kind === 'decide') card = triageCard(run, ctx, kind);
  else if (kind) card = { el: cardShell(`Needs you: ${kind}`), update() {} };
  if (card) card.update(run, ctx.busy ? ctx.busy() : '');
  return card;
}
