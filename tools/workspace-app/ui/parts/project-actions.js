// What the project page's buttons do when more than one tab offers them, moved from the cockpit
// view: create the profile from the example, set up the run worktree or switch between it and
// branch mode, the setup checklist's actions, park the run that holds the lock, and start a
// read-only Review of an app branch. A change asks first (or the screen already said what it
// does); afterwards the tab's data loads again. Nothing here builds a path: the server gets names.
import { act, api, confirmDialog, copy, toast } from '../lib.js';
import { go, loadPipelines, refresh } from '../store.js';
import { reload } from './project-data.js';
import { post } from './project-ui.js';

// "Create from the example": copies the synthetic example profile into the private data folder.
export async function createProfile(name) {
  const r = await act(post('/api/project/profile-init', { project: name }));
  if (!r) return false;
  await refresh();
  loadPipelines(name, { force: true });
  reload();
  return true;
}

// Starts the hidden setup-worktree run and opens it.
export async function setupWorktree(name) {
  try {
    const r = await post('/api/project/worktree-setup', { project: name });
    toast(r.message || 'Setting up the run worktree.');
    if (r.runId) go('run', r.runId);
  } catch (e) { toast(e.message, true); }
}

// Run worktree or branch mode, for this PC. Branch mode asks first.
export async function setIsolation(name, mode) {
  if (mode === 'branch' && !(await confirmDialog('Use branch mode?',
    'Editing runs will use your main checkout on a new branch instead of the run worktree. You can switch back here at any time.', 'Use branch mode'))) return;
  if (await act(post('/api/project/isolation', { project: name, mode }))) reload();
}

// An action of the "Setup N/4" checklist ({ kind, ... } from GET /api/project).
export function checklistAction(name, a) {
  if (!a) return;
  if (a.kind === 'link') go('projects');
  else if (a.kind === 'profile-init') createProfile(name);
  else if (a.kind === 'worktree-setup') setupWorktree(name);
  else if (a.kind === 'isolation') setIsolation(name, a.mode);
  else if (a.kind === 'copy') copy(a.text || '');
}

// Parks the run that holds the lock: its changes go to final/stopped.patch, the lock is freed.
export async function park(lock) {
  const ok = await confirmDialog('Park this run?',
    `${lock.title || `Run ${lock.runId}`} waits at the ${lock.waiting || 'next'} gate and holds the lock. Parking saves its changes to final/stopped.patch and frees the lock and the run worktree. Resume it later from the run, at the same gate.`,
    'Park run');
  if (ok && await act(post('/api/runs/park', { id: lock.runId }))) reload();
}

// "Diff" on an app branch, and a card on the board's On branch column: a read-only Review run.
export async function reviewBranch(name, branch) {
  const ok = await confirmDialog(`Review ${branch}?`,
    'Starts a read-only Review of this app branch against the base. Claude reads the diff and lists findings you can fix or dismiss; nothing is changed. About 5 to 15 minutes.',
    'Start review');
  if (!ok) return;
  try {
    const r = await api('/api/runs', { method: 'POST', body: { project: name, pipeline: 'review', values: { target: 'app', branch } } });
    if (r.runId) go('run', r.runId);
  } catch (e) { toast(e.message, true); }
}
