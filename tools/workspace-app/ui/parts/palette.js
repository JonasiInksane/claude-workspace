// The palette (SPEC 5.9; mockup #palette): Ctrl+K or "Start something" opens it. Type to
// filter screens (every tab of every project's page among them, "example > Findings"), "New run:
// <pipeline>" per profiled project, runs (waiting ones first, at most 20), flows, skills and
// workspace tools, and the keyboard shortcuts sheet. Arrow keys move, Enter picks, Esc closes.
// With no match, Enter routes the typed text with the server's rules (store.routeIntent) and
// opens the launcher with it. screenItems() is pure, for palette.test.mjs.
//
// Markup: <dialog id="palette"> in index.html holds the field and the list. The list is a
// listbox whose options carry aria-selected; the focus stays in the field (a combobox with
// aria-activedescendant), so typing and arrow keys work together. Every label is text.
import { $, h, statusBadge } from '../lib.js';
import { openDialog } from '../dialog.js';
import {
  atReviewGate, currentProject, go, loadPipelines, openLauncher, pipelines, profiledProjects, projectSub, refresh, routeIntent, runs, settings,
  state, tabsOf,
} from '../store.js';
import { runCommand, skillDialog } from '../views/tools.js';
import { runFlowDialog } from '../views/flows.js';
import { tabLabel } from '../views/project/tabs.js';

const MAX_RUNS = 20;
let dlg = null;
let input = null;
let list = null;
let shown = []; // the items on screen, in order
let selected = 0;
let returnFocus = null;

// The screens to jump to, as { label, route, sub }: the global ones in the nav's order, every tab
// of every project's page ("example > Findings"), then Library and Inbox images. `label(id)` names
// a tab (views/project/tabs.js tabLabel).
export function screenItems(s, label = tabLabel) {
  const out = [{ label: 'Today', route: 'today', sub: '' }, { label: 'Projects', route: 'projects', sub: '' }];
  for (const p of s && Array.isArray(s.projects) ? s.projects : []) {
    if (!p || !p.name) continue;
    for (const tab of tabsOf(p)) out.push({ label: `${p.name} > ${label(tab)}`, route: 'project', sub: projectSub(p.name, tab) });
  }
  for (const [text, route] of [['Assets', 'assets'], ['Flows', 'flows'], ['Runs', 'runs'], ['Library', 'library'], ['Inbox images', 'images']]) {
    out.push({ label: text, route, sub: '' });
  }
  return out;
}

// Every item: { label, group, run }. Built when the palette opens, so it reflects the state.
function allItems() {
  const s = state;
  const out = screenItems(s).map(x => ({ label: x.label, group: 'Screen', run: () => go(x.route, x.sub) }));

  for (const p of profiledProjects()) {
    for (const def of pipelines.list) {
      out.push({ label: `New run: ${def.label}`, group: p.name, run: () => openLauncher(def.id, { project: p.name }) });
    }
  }

  for (const r of [...runs.waiting, ...runs.running].slice(0, MAX_RUNS)) {
    const atReview = atReviewGate(r);
    out.push({
      label: r.title || r.id,
      group: atReview ? 'Review gate' : statusBadge(r.status).label,
      run: () => go(atReview ? 'review' : 'run', r.id),
    });
  }

  if (s && s.tools && s.tools.claude) {
    for (const f of s.flows || []) {
      if (!f.error) out.push({ label: `Run flow: ${f.title}…`, group: 'Flow', run: () => runFlowDialog(f) });
    }
    for (const skill of (s.catalog && s.catalog.skills) || []) {
      out.push({ label: `${skill.label} (/${skill.id})`, group: 'Skill', run: () => skillDialog(skill) });
    }
  }
  for (const cmd of (s && s.catalog && s.catalog.commands) || []) {
    out.push({ label: cmd.preview ? `${cmd.label}…` : cmd.label, group: 'Workspace tool', run: () => runCommand(cmd, { preview: cmd.preview }) });
  }
  out.push({ label: 'Keyboard shortcuts', group: 'Help', run: showShortcuts });
  out.push({ label: 'Refresh the data', group: 'App', run: () => refresh() });
  return out;
}

// Every typed word must appear in the label or the group.
function filter(items, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(it => {
    const text = `${it.label} ${it.group}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
}

function render() {
  shown = filter(allItems(), input.value.trim());
  selected = Math.min(selected, Math.max(0, shown.length - 1));
  if (!shown.length) {
    const text = input.value.trim();
    const pick = text ? routeIntent(text) : null;
    const def = pick && pipelines.list.find(p => p.id === pick.pipeline);
    list.replaceChildren(h('li', { class: 'pal-empty', role: 'presentation' },
      text ? ['Nothing matches. Press Enter to open ', h('b', {}, def ? def.label : pick.pipeline),
        currentProject ? ` in ${currentProject}` : '', ' with this text.'] : 'Nothing to show.'));
    input.removeAttribute('aria-activedescendant');
    return;
  }
  list.replaceChildren(...shown.map((it, i) => h('li', {
    id: `pal-opt-${i}`, role: 'option', 'aria-selected': i === selected ? 'true' : 'false', class: i === selected ? 'sel' : null,
    on: { click: () => choose(i), mousemove: () => { if (selected !== i) { selected = i; mark(); } } },
  }, h('span', { class: 'pal-label' }, it.label), h('small', {}, it.group))));
  mark();
}

// Moves the selection marker without rebuilding the list.
function mark() {
  [...list.children].forEach((li, i) => {
    li.setAttribute('aria-selected', i === selected ? 'true' : 'false');
    li.classList.toggle('sel', i === selected);
  });
  const li = list.children[selected];
  if (li && li.id) {
    input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  }
}

function choose(i) {
  const it = shown[i];
  if (!it) return;
  close(false);
  it.run();
}

function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!shown.length) return;
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
    mark();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (shown.length) { choose(selected); return; }
    const text = input.value.trim();
    if (!text) return;
    const pick = routeIntent(text);
    close(false);
    openLauncher(pick.pipeline, { what: text, findingId: pick.findingId });
  }
}

export const isPaletteOpen = () => !!(dlg && dlg.open);

export function openPalette() {
  if (!dlg || dlg.open) return;
  returnFocus = document.activeElement;
  input.value = '';
  selected = 0;
  render();
  dlg.showModal();
  input.focus();
  // The pipeline list arrives from the server; show "New run" items once it is there.
  if (!pipelines.loaded) loadPipelines(currentProject).then(() => { if (dlg.open) render(); });
}

// Closes it; `restore` puts the focus back where it was (not when an item opens something).
export function closePalette() { close(true); }
function close(restore) {
  if (!dlg || !dlg.open) return;
  if (!restore) returnFocus = null;
  dlg.close();
}

export function togglePalette() {
  if (isPaletteOpen()) closePalette();
  else openPalette();
}

// main.js calls this once. The dialog and its field are in index.html.
export function initPalette() {
  dlg = $('#palette');
  input = $('#palInput');
  list = $('#palList');
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', onKey);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(true); });
  dlg.addEventListener('close', () => {
    const back = returnFocus;
    returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------- the shortcuts sheet

const SHORTCUTS = [
  ['Anywhere', [
    ['Ctrl K', 'Open or close this palette (Start something)'],
    ['g then t', 'Today'],
    ['g then p', 'The current project\'s page'],
    ['g then a', 'Assets'],
    ['g then f', 'Flows'],
    ['g then r', 'Runs'],
    ['Esc', 'Close a dialog or the palette'],
  ]],
  ['Project page (focus on the tabs)', [
    ['Left / Right', 'Previous / next tab'], ['Home / End', 'First / last tab'], ['Enter or Space', 'Open the focused tab'],
  ]],
  ['Launcher', [['Ctrl Enter', 'Start the run, once the preview has loaded']]],
  ['Live run (single keys, focus inside the run)', [
    ['T', 'Take over in a terminal'], ['.', 'Cancel the run (asks first)'], ['j / k', 'Next / previous timeline row'],
  ]],
  ['Review gate (single keys, focus inside the review)', [
    ['F', 'Fix the selected findings'], ['T', 'Take over in a terminal'], ['C', 'Open the commit dialog'],
    ['j / k', 'Next / previous finding'], ['Space', 'Tick or untick a finding'],
  ]],
];

export function showShortcuts() {
  const on = settings.shortcuts.singleKey !== false;
  openDialog('Keyboard shortcuts', h('div', { class: 'keys' },
    h('p', { class: 'muted' }, `Single-key shortcuts are ${on ? 'on' : 'off'}. They act only while the focus is inside their panel, never while you type or a dialog is open. The g shortcuts need the second key within one second.`),
    SHORTCUTS.map(([title, rows]) => h('div', {},
      h('h4', {}, title),
      h('dl', { class: 'keys-list' }, rows.map(([keys, what]) => [h('dt', {}, h('kbd', {}, keys)), h('dd', {}, what)]))))));
}
