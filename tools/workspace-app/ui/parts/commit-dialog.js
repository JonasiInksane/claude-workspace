// The commit dialog (SPEC 5.7, mockup #commit-dlg) in its own <dialog id="commitDialog"> from
// index.html. It shows the message draft the app wrote when the checks went green
// (final/commit-msg.txt: change.v1's message, the record and check lines, and a Co-Authored-By
// line with the implement stage's model), editable; the exact files the gates checked, which
// are the only files staged; the gated tree hash; and a note about the project's pre-commit
// hook. Commit posts { id, message, files, treeSha } to /api/runs/commit and nothing else: the
// server recomputes the tree hash, and there is no push or merge anywhere (R17).
//
// A tree that moved since the gates ran answers 409 ("Tree changed since gates ran…"). The
// dialog shows that sentence and offers "Reload the review", which pulls the run again through
// the caller and refreshes the file list and tree hash in place, keeping the message you edited
// (drafts live here per run until a commit succeeds). Esc and Cancel close it, except while a
// commit is in flight; the focus goes back to the button that opened it.
import { api, h, qs, toast } from '../lib.js';
import { settings } from '../store.js';

const drafts = new Map(); // run id -> the message as last edited
let session = null; // the open dialog: { runId, run, busy, opener, reload, onDone, celebrate, els }

const dialogEl = () => document.getElementById('commitDialog');
const sha7 = s => String(s || '').slice(0, 7);
const asList = x => (Array.isArray(x) ? x : []);
const actionOf = (run, name) => asList(run && run.actions).find(a => a && a.action === name) || null;

// Why Commit is off right now, or '' when it may be pressed.
function blockReason(s) {
  const gated = (s.run && s.run.gatedTree) || null;
  const commit = actionOf(s.run, 'commit');
  if (commit && !commit.enabled) return `Commit is off: ${commit.reason}`;
  if (!gated || !gated.treeSha || !asList(gated.files).length) return 'Commit is off: the gates have not recorded a checked tree yet.';
  if (s.loading) return 'Loading the message draft…';
  if (!s.els.msg.value.trim()) return 'Write a commit message first.';
  if (s.busy) return 'Committing…';
  return '';
}

// Updates everything that depends on the run (files, tree hash) and on the message.
function sync() {
  const s = session;
  if (!s) return;
  const gated = (s.run && s.run.gatedTree) || {};
  const files = asList(gated.files);
  s.els.files.replaceChildren(...(files.length ? files.map(f => h('li', {}, f)) : [h('li', { class: 'muted' }, 'No checked files.')]));
  s.els.filesCount.textContent = files.length ? ` (${files.length})` : '';
  const fresh = gated.treeSha && s.openedSha && gated.treeSha !== s.openedSha;
  s.els.tree.replaceChildren(...(gated.treeSha
    ? [h('span', { class: 'badge ok' }, 'Tree hash ok'), ' ', h('span', { class: 'muted small' },
      'Checked tree ', h('code', {}, sha7(gated.treeSha)), fresh ? ' (new: the checks ran again since you opened this dialog)' : '',
      '. The app recomputes it when you click Commit and refuses if anything moved since the checks.')]
    : [h('span', { class: 'badge red' }, 'No tree hash'), ' ', h('span', { class: 'muted small' }, 'The checks have not passed on this tree yet.')]));
  const why = blockReason(s);
  s.els.go.disabled = !!why;
  s.els.go.textContent = s.busy ? 'Committing…' : 'Commit';
  s.els.why.textContent = why;
  s.els.why.hidden = !why;
}

function showError(text, { reload = false } = {}) {
  const s = session;
  if (!s) return;
  // replaceChildren() would print a null as text, so the optional part is left out instead.
  const parts = [h('p', {}, text)];
  if (reload) {
    parts.push(h('p', { class: 'mt-2' }, h('button', { class: 'btn small', type: 'button', on: { click: reloadRun } }, 'Reload the review'),
      ' ', h('span', { class: 'small' }, 'Your message stays as you wrote it. The dialog also updates by itself when the checks pass again.')));
  }
  s.els.error.replaceChildren(...parts);
  s.els.error.hidden = false;
}
function clearError() {
  if (session) { session.els.error.hidden = true; session.els.error.replaceChildren(); }
}

// Pulls the run again through the caller (the review view re-reads /api/run and the review) and
// refreshes the dialog in place.
async function reloadRun() {
  const s = session;
  if (!s || typeof s.reload !== 'function') return;
  clearError();
  try {
    const run = await s.reload();
    if (session !== s) return;
    if (run) s.run = run;
    sync();
    // Still blocked by the gates (not by an empty message): they are most likely running again.
    if (blockReason(s) && s.els.msg.value.trim() && !(s.run.gatedTree && s.run.gatedTree.treeSha)) {
      showError('The checks are running again on the current tree. This dialog updates by itself when they pass; your message stays.');
    } else s.els.msg.focus();
  } catch (e) {
    showError(`The run could not be loaded again: ${e.message}`);
  }
}

// Loads the message draft unless an edited one is kept for this run.
async function loadDraft(s) {
  if (drafts.has(s.runId)) { s.els.msg.value = drafts.get(s.runId); return; }
  s.loading = true;
  sync();
  try {
    const r = await api(`/api/run-file?${qs({ id: s.runId, name: 'commit-msg' })}`);
    if (session !== s) return;
    s.els.msg.value = String(r.text || '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  } catch (e) {
    if (session !== s) return;
    s.els.draftNote.textContent = e.status === 404
      ? 'No message draft was saved for this run; write one.'
      : `The message draft could not be loaded (${e.message}); write one.`;
    s.els.draftNote.hidden = false;
  } finally {
    if (session === s) { s.loading = false; sync(); }
  }
}

// After a commit: ratchet wins this commit earned (GET /api/metrics names the run in each win's
// `via`), as toasts after the commit toast. Quiet on any error: the commit already happened.
async function winToasts(project, runId) {
  if (!project) return;
  try {
    const r = await api(`/api/metrics?${qs({ project })}`);
    const mine = asList(r.wins).filter(w => w && w.via && w.via.runId === runId).slice(0, 2);
    for (const w of mine) toast(`Win: ${w.text || w.label || w.metric}`);
  } catch { /* no wins shown */ }
}

// The celebration flash (settings.fun.celebration), only when every gate was green and the
// reader has not asked for reduced motion.
function flash() {
  if (settings.fun && settings.fun.celebration === false) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const f = document.getElementById('flash');
  if (!f) return;
  f.classList.remove('on');
  void f.offsetWidth; // restarts the animation
  f.classList.add('on');
}

async function commit() {
  const s = session;
  if (!s || s.busy || blockReason(s)) return;
  const gated = s.run.gatedTree;
  const message = s.els.msg.value.replace(/\r\n/g, '\n').trim();
  s.busy = true;
  clearError();
  sync();
  try {
    const r = await api('/api/runs/commit', { method: 'POST', body: { id: s.runId, message, files: [...gated.files], treeSha: gated.treeSha } });
    drafts.delete(s.runId);
    s.busy = false;
    const project = (r.run && r.run.project) || s.run.project;
    dialogEl().close();
    toast(r.message || 'Committed. Not pushed.');
    if (s.celebrate) flash();
    winToasts(project, s.runId);
    if (typeof s.onDone === 'function') s.onDone(r);
  } catch (e) {
    if (session !== s) return;
    s.busy = false;
    sync();
    if (e.status === 409) showError(e.message, { reload: true });
    else showError(e.network ? 'The app server did not answer; nothing was committed.' : e.message);
  }
}

function close() {
  if (session && session.busy) return;
  dialogEl().close();
}

// Builds the dialog's content once per opening.
function build(s) {
  const base = (s.run && s.run.base) || {};
  const tree = (s.run && s.run.isolation) || {};
  const where = tree.treeMode === 'run' ? 'the run worktree' : tree.treeMode === 'main' ? 'your main checkout (branch mode)' : 'the run tree';
  const els = {
    msg: h('textarea', { id: 'commitMsg', class: 'code-edit commit-msg', spellcheck: 'false', 'aria-describedby': 'commitMsgHint', maxlength: 8000 }),
    draftNote: h('p', { class: 'note', hidden: true }),
    files: h('ul', { class: 'commit-files mono', id: 'commitFiles', 'aria-labelledby': 'commitFilesLabel' }),
    filesCount: h('span'),
    tree: h('p', { class: 'commit-tree' }),
    error: h('div', { class: 'form-error', role: 'alert', hidden: true }),
    why: h('span', { class: 'reason', id: 'commitWhy', hidden: true }),
    go: h('button', { class: 'btn primary', type: 'button', 'aria-describedby': 'commitWhy', on: { click: commit } }, 'Commit'),
  };
  els.msg.addEventListener('input', () => { drafts.set(s.runId, els.msg.value); sync(); });
  s.els = els;
  const dlg = dialogEl();
  dlg.replaceChildren(
    h('div', { class: 'card-head' },
      h('h3', { id: 'commitDialogTitle' }, 'Commit this change'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', on: { click: close } }, '✕')),
    h('div', { class: 'card-body' },
      h('p', { class: 'muted small' }, 'In ', where, ', on a new branch from ', base.branch ? h('code', {}, base.branch) : 'the base',
        base.sha ? [' at ', h('code', {}, sha7(base.sha))] : '', '. The app names the branch when it commits. Not pushed, not merged.'),
      h('label', { class: 'commit-field', for: 'commitMsg' }, 'Commit message'),
      els.msg,
      h('p', { class: 'muted small', id: 'commitMsgHint' }, 'The first line is the subject. Keep the Co-Authored-By line: it names the model that wrote the change.'),
      els.draftNote,
      h('div', {}, h('b', { class: 'small', id: 'commitFilesLabel' }, 'Exactly these files are staged', els.filesCount), els.files),
      els.tree,
      h('p', { class: 'note info' }, "The project's pre-commit hook runs as usual; the app never skips it. After the commit, the app compares the committed tree with the checked one and tells you if the hook changed anything."),
      els.error),
    h('div', { class: 'card-foot' }, els.why,
      h('button', { class: 'btn ghost', type: 'button', on: { click: close } }, 'Cancel'),
      els.go));
}

// openCommitDialog({ runId, run, reload, onDone, celebrate }).
//   run: the run as GET /api/run sends it (gatedTree, actions, base, isolation, project).
//   reload(): resolves with the run pulled again (the caller also repaints its own view).
//   onDone(answer): after a successful commit, with the POST answer ({ message, run }).
//   celebrate: true when every gate was green (the flash may show).
export function openCommitDialog({ runId, run, reload = null, onDone = null, celebrate = false } = {}) {
  const dlg = dialogEl();
  if (!dlg || !runId || !run) return;
  if (dlg.open) dlg.close();
  const s = { runId, run, busy: false, loading: false, opener: document.activeElement, reload, onDone, celebrate, els: null,
    openedSha: (run.gatedTree && run.gatedTree.treeSha) || '' };
  session = s;
  build(s);
  sync();
  dlg.showModal();
  s.els.msg.focus();
  loadDraft(s).then(() => {
    if (session !== s) return;
    s.els.msg.setSelectionRange(0, 0);
    s.els.msg.scrollTop = 0;
  });
}

export const isCommitDialogOpen = () => !!(dialogEl() && dialogEl().open);

// The review view calls this after every pull that changed the run, so an open dialog follows
// the gates: after a stale-tree 409 the checks run again, and once they pass the new files and
// tree hash show here and Commit comes back on. The edited message is never touched.
export function syncCommitDialog(runId, run) {
  const s = session;
  if (!s || s.runId !== runId || s.busy || !run) return;
  const before = (s.run.gatedTree && s.run.gatedTree.treeSha) || '';
  s.run = run;
  const now = (run.gatedTree && run.gatedTree.treeSha) || '';
  if (now && now !== before) clearError();
  sync();
}

// One-time wiring of the <dialog>: Esc waits while a commit is in flight, and closing gives the
// focus back to the opener (or to the view heading when the opener is gone).
function wire() {
  const dlg = dialogEl();
  if (!dlg || dlg.dataset.wired) return;
  dlg.dataset.wired = '1';
  dlg.addEventListener('cancel', e => { if (session && session.busy) e.preventDefault(); });
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape' && session && session.busy) e.preventDefault(); });
  dlg.addEventListener('close', () => {
    const s = session;
    session = null;
    if (!s) return;
    // A poll may have repainted the view meanwhile: find the opener again by its data-key.
    const key = s.opener && s.opener.dataset ? s.opener.dataset.key : '';
    const again = key ? [...document.querySelectorAll('section.view:not([hidden]) [data-key]')].find(el => el.dataset.key === key && !el.disabled) : null;
    const back = (s.opener && s.opener.isConnected ? s.opener : again) || document.querySelector('section.view:not([hidden]) h2');
    if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
  });
}
if (typeof document !== 'undefined') wire();
