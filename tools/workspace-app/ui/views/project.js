// The project page (#project/<name>/<tab>[/<rest>]; hub spec plan A1): one page for every project
// in projects/, whatever its type. The header (name, real path, type badge, Start Claude here and
// More), a tab bar with the tabs of the project's type (project-types.mjs on the server, sent as
// state.projects[i].tabs) and the open tab's panel (views/project/<tab>.js, listed in
// views/project/tabs.js, which also documents a tab module's contract).
//
// Routes: #project/<name> opens the type's first tab, and so does an unknown tab (main.js applies
// store.canonicalProjectSub before it shows the page); the old #cockpit/<name> and #health/<name>
// open Overview and Architecture. Every tab is its own history entry, so Back and Forward walk
// through the tabs you opened.
//
// Keyboard (WAI-ARIA tabs with manual activation, since a tab may have to load first): the tab
// bar is one Tab stop (the open tab); Left and Right move the focus to the previous and next tab
// (wrapping), Home and End to the first and last, and Enter or Space opens the focused tab, which
// keeps the focus. Each tab has aria-selected and aria-controls; the panel has role="tabpanel"
// and is labelled by its tab.
//
// A project the state doesn't list (a profile or a listed repo whose checkout isn't here, or a
// name typed by hand) is asked about with GET /api/project: "not linked yet" with the way to link
// it, or "No project named x". A project whose linked folder is gone shows only that.
//
// Rendering: like the cockpit before it, the page patches its parts (parts/patch.js), so a refresh
// keeps the focus, an open <details> and typed text: the header and the tab bar are rebuilt only
// when what they show changed; the panel belongs to the open tab. Data comes through
// parts/project-data.js, and every answer for the project on screen repaints it.
//
// The pure helper tabKeyTarget is exported for project.test.mjs.
import { h, icon, keepFocus, keyed, launch, openPlace } from '../lib.js';
import {
  go, goProject, loadPipelines, projectEntry, projectRoute, refresh, setCurrentProject, state, sub, tabsOf, view,
} from '../store.js';
import { createMemo, patch } from '../parts/patch.js';
import { dataOf, onData, reload, slot, use } from '../parts/project-data.js';
import { btn, errorNote, ICONS, startProblem, stateCard } from '../parts/project-ui.js';
import { tabLabel, tabModule } from './project/tabs.js';

export const PANEL_ID = 'project-panel';
export const tabId = id => `ptab-${id}`;
const TYPE_BADGE = { code: 'blue', assets: 'violet' };

// ---------------------------------------------------------------- pure helpers (tested)

// Where a key in the tab bar moves the focus: the index of a tab, or -1 for a key the tab bar
// leaves alone. Left and Right wrap around.
export function tabKeyTarget(key, index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) return -1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

// ---------------------------------------------------------------- state of the page

const memo = createMemo();
let section = null;
let visible = false;
let active = null; // the tab on show: { key, mod, release }
let focusTab = ''; // the tab to focus once the navigation a tab click started is shown
const asked = new Set(); // projects the state didn't list but the server knows: refreshed once

const tabCtx = (p, r) => ({ state, project: p, rest: r.rest, go, refresh: () => { refresh(); reload(); } });

// Starts what the route shows (the tab's onShow, or the question about an unknown project) and
// stops what it showed before. A no-op while the same tab of the same project stays on show.
function sync(r, p) {
  const key = p ? [p.name, r.tab, r.rest, p.realPath ? 1 : 0, p.type ? p.type.id : ''].join('|') : `?${r.name}`;
  if (active && active.key === key) return;
  deactivate();
  active = { key, mod: null, release: () => {} };
  if (!r.name) return;
  if (!p) { active.release = use(r.name, ['project']); return; }
  if (!p.realPath) return;
  const mod = tabModule(r.tab);
  active.mod = mod;
  if (mod && mod.onShow) mod.onShow(tabCtx(p, r));
  if (p.type && p.type.id === 'code') {
    setCurrentProject(p.name);
    loadPipelines(p.name);
  }
}

function deactivate() {
  if (!active) return;
  const { mod, release } = active;
  active = null;
  if (mod && mod.onHide) mod.onHide();
  release();
}

function repaint() {
  if (section && visible && view === 'project') keepFocus(section, () => render(section, { sub }));
}

onData(name => { if (projectRoute(sub).name === name) repaint(); });

// ---------------------------------------------------------------- header

function moreMenu(p) {
  const tools = state.tools || {};
  const present = !!p.realPath;
  const problem = startProblem(p, tools);
  const tabs = tabsOf(p);
  const item = (key, label, fn, disabled = false) => keyed(h('button', {
    type: 'button', disabled,
    on: { click: e => { const d = e.target.closest('details'); if (d) d.open = false; fn(); } },
  }, label), key);
  return h('details', { class: 'menu' },
    keyed(h('summary', { class: 'btn', 'aria-label': 'More project actions' }, 'More', icon(ICONS.down)), 'more'),
    h('div', { class: 'menu-list' },
      item('m-continue', 'Continue last session', () => launch({ kind: 'project', project: p.name, continueLast: true }), !!problem),
      tools.editor ? item('m-editor', `Open in ${tools.editor}`, () => openPlace({ place: 'project', project: p.name, with: 'editor' }), !present) : null,
      item('m-folder', 'Open folder', () => openPlace({ place: 'project', project: p.name }), !present),
      item('m-agents', 'Agents', () => (tabs.includes('agents') ? goProject(p.name, 'agents') : go('projects'))),
      item('m-projects', 'All projects', () => go('projects'))));
}

function header(p) {
  const tools = state.tools || {};
  const problem = startProblem(p, tools);
  const label = p.profileLabel || p.name;
  const type = p.type || { id: 'generic', label: 'Project' };
  return memo(`head:${p.name}`, [label, p.realPath, p.linked, type, p.launchable, !!tools.claude, tools.editor || '', tabsOf(p)], () => h('div', { class: 'view-head pj-head' },
    h('div', { class: 'pj-title' },
      h('div', { class: 'pj-name' }, h('h2', {}, label),
        h('span', { class: `badge${TYPE_BADGE[type.id] ? ` ${TYPE_BADGE[type.id]}` : ''}`, title: 'The project type decides which tabs the page has' }, type.label)),
      h('p', { class: 'mono' }, p.realPath || (p.linked ? 'Link broken: its folder is gone' : 'Not linked yet'))),
    h('div', { class: 'row-actions' },
      btn('start', 'Start Claude here', () => launch({ kind: 'project', project: p.name }),
        { cls: 'btn', disabled: !!problem, describedBy: problem ? 'pj-start-why' : null, title: 'Opens a terminal at the real path and starts Claude there' }),
      problem ? h('span', { class: 'reason', id: 'pj-start-why' }, problem) : null,
      moreMenu(p))));
}

// ---------------------------------------------------------------- tab bar and panel

// Left, Right, Home and End move the focus between the tabs; Enter and Space click the button.
function onTabKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const list = e.currentTarget;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const from = e.target && e.target.closest ? e.target.closest('[role="tab"]') : null;
  const to = tabKeyTarget(e.key, tabs.indexOf(from), tabs.length);
  if (to < 0) return;
  e.preventDefault();
  tabs[to].focus();
}

function openTab(name, id) {
  focusTab = id;
  goProject(name, id);
}

function tabBar(p, tab) {
  const tabs = tabsOf(p).filter(id => tabModule(id));
  const label = `${p.profileLabel || p.name} sections`;
  return memo(`tabs:${p.name}`, [tabs, tab, label], () => {
    const list = h('div', { class: 'pj-tabs', role: 'tablist', 'aria-label': label, on: { keydown: onTabKey } },
      tabs.map(id => {
        const selected = id === tab;
        return keyed(h('button', {
          type: 'button', role: 'tab', class: 'pj-tab', id: tabId(id), 'aria-selected': selected ? 'true' : 'false',
          'aria-controls': PANEL_ID, tabindex: selected ? '0' : '-1', on: { click: () => openTab(p.name, id) },
        }, tabLabel(id)), `tab:${id}`);
      }));
    return list;
  });
}

// The one panel; a tab that comes on show starts on an empty panel.
const panelEl = { el: null, key: '' };
function panel(p, r) {
  if (!panelEl.el) panelEl.el = h('div', { class: 'pj-panel', role: 'tabpanel', id: PANEL_ID, tabindex: '0' });
  const el = panelEl.el;
  const key = `${p.name}|${r.tab}`;
  if (panelEl.key !== key) {
    el.replaceChildren();
    panelEl.key = key;
  }
  el.setAttribute('aria-labelledby', tabId(r.tab));
  const mod = tabModule(r.tab);
  if (mod) mod.render(el, tabCtx(p, r));
  else patch(el, [memo(`notab:${r.tab}`, [], () => stateCard('This tab is not in the app', `There is no ${r.tab} tab.`))]);
  return el;
}

// ---------------------------------------------------------------- states without tabs

function noProject() {
  return [
    memo('none:head', [], () => h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Project')))),
    memo('none', [], () => stateCard('No project chosen yet', 'Every project in projects/ has a page with its tabs. Pick one under Projects in the sidebar, or link or clone one.',
      btn('none:projects', 'Projects', () => go('projects'), { cls: 'btn primary' }))),
  ];
}

// A name the state doesn't list: what the server says about it.
function unknown(name) {
  const P = slot(name).project;
  const d = dataOf(P);
  const head = memo(`uhead:${name}`, [d && d.project, !!(P && P.error)], () => h('div', { class: 'view-head pj-head' },
    h('div', { class: 'pj-title' }, h('div', { class: 'pj-name' }, h('h2', {}, (d && d.project.label) || name)),
      h('p', { class: 'mono' }, d ? d.project.realPath || 'Not linked yet' : P && P.error ? '' : 'Loading…'))));
  let body;
  if (!P) body = memo(`uload:${name}`, [], () => h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading…'))));
  else if (!d && (P.status === 404 || P.status === 400)) {
    body = memo(`unknown:${name}`, [P.error], () => stateCard(`No project named ${name}`, P.error,
      btn('unknown:projects', 'Projects', () => go('projects'), { cls: 'btn primary' })));
  } else if (!d) body = memo(`uerr:${name}`, [P.error], () => h('div', { class: 'card' }, h('div', { class: 'card-body' }, errorNote(P.error, 'project'))));
  else if (!d.project.present) {
    const linked = (d.checklist || []).find(x => x.id === 'linked');
    body = memo(`unlinked:${name}`, [linked ? linked.text : ''], () => stateCard(`${d.project.label || name} is not linked yet`,
      `${linked ? linked.text : 'The app can\'t find the checkout.'} Linking makes a junction in projects/ that points at your existing checkout; nothing in the checkout is moved or changed.`,
      btn('link', 'Link existing checkout', () => go('projects'), { cls: 'btn primary' })));
  } else {
    // The checkout is here but the state doesn't list it yet: load the state again, once.
    if (!asked.has(name)) { asked.add(name); refresh(); }
    body = memo(`ufresh:${name}`, [], () => h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading the project…'))));
  }
  return [head, body];
}

// A project in the state whose checkout isn't reachable: a broken link.
function goneCard(p) {
  return memo(`gone:${p.name}`, [p.linked], () => stateCard(
    p.linked ? 'The linked folder is gone' : `${p.name} is not linked yet`,
    p.linked ? `projects/${p.name} links to a folder that is gone. Unlink it in Projects, then link the checkout again; nothing in a checkout is changed.`
      : 'Link the checkout you already have in Projects; nothing in it is moved or changed.',
    btn('gone:projects', 'Open Projects', () => go('projects'), { cls: 'btn primary' })));
}

// ---------------------------------------------------------------- the view

function render(el, ctx) {
  section = el;
  const r = projectRoute(ctx.sub);
  const p = r.name ? projectEntry(r.name) : null;
  if (visible) sync(r, p);
  if (!r.name) { patch(el, noProject()); return; }
  if (!p) { patch(el, unknown(r.name)); return; }
  if (!p.realPath) { patch(el, [header(p), goneCard(p)]); return; }
  patch(el, [header(p), tabBar(p, r.tab), panel(p, r)]);
}

export default {
  id: 'project',
  label: 'Project',
  icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 4v5"/>',
  render,
  onShow({ sub: subPath }) {
    visible = true;
    if (state) {
      const r = projectRoute(subPath);
      sync(r, r.name ? projectEntry(r.name) : null);
    }
    if (focusTab && section) {
      const t = section.querySelector(`#${tabId(focusTab)}`);
      if (t) t.focus({ preventScroll: true });
    }
    focusTab = '';
  },
  onHide() {
    visible = false;
    deactivate();
  },
};
