// The sidebar's entries (SPEC 5.1, hub spec plan A2), built from the state: Today; Projects (its
// count) with every project nested under it, a code project with its amber count of runs waiting
// for you; Assets; Flows; Runs (the running count) with up to three runs waiting at a review gate
// nested under it. The foot of the sidebar, above the Hub session buttons, holds Library (its
// settings are there too). Inbox images is not in the nav: Assets opens it.
//
// An entry is { key, route, sub, label, icon, count, countCls, sr, cls, title }; main.js renders
// each as a button that calls go(route, sub). A count is aria-hidden and `sr` says it in words.
// Nothing here touches the DOM, so nav.test.mjs runs it in Node.
import { plural } from '../lib.js';
import { countOf, projectRoute, routeOf } from '../store.js';

export const MAX_REVIEW_ITEMS = 3;

// "1 flow", "3 projects": the screen-reader text of a plain view's count.
const COUNT_WORDS = { projects: 'project', flows: 'flow', assets: 'asset' };
const countText = (id, n) => (COUNT_WORDS[id] && Number.isFinite(Number(n)) ? plural(Number(n), COUNT_WORDS[id]) : String(n));

// A plain view's entry: its label, icon and count(state), or null when visible(state) says no.
function plainItem(v, s, label = v.label) {
  if (!v) return null;
  if (v.visible && !v.visible(s)) return null;
  const count = v.count ? v.count(s) : '';
  const shown = count !== '' && count !== null && count !== undefined && count !== 0;
  return { key: v.id, route: routeOf(v.id), label, icon: v.icon, count: shown ? count : '', sr: shown ? `, ${countText(v.id, count)}` : '' };
}

// The main nav. `views` are the view modules by id (today, projects, assets, flows, runs);
// `running` is the number of running runs and `reviews` the runs waiting at a review gate.
export function navItems(state, { views = {}, running = 0, reviews = [] } = {}) {
  const s = state || {};
  const items = [];
  if (views.today) items.push({ key: 'today', route: 'today', label: 'Today', icon: views.today.icon });
  items.push(plainItem(views.projects, s));
  for (const p of Array.isArray(s.projects) ? s.projects : []) {
    if (!p || !p.name) continue;
    const waiting = p.type && p.type.id === 'code' ? countOf(p.waiting) : 0;
    items.push({
      key: `project/${p.name}`, route: 'project', sub: p.name, label: p.name, cls: 'sub', title: p.name,
      count: waiting || '', countCls: 'amber', sr: waiting ? `, ${waiting} waiting` : '',
    });
  }
  items.push(plainItem(views.assets, s), plainItem(views.flows, s));
  if (views.runs) {
    const n = countOf(running);
    items.push({ key: 'runs', route: 'runs', label: 'Runs', icon: views.runs.icon, count: n || '', sr: n ? `, ${n} running` : '' });
    for (const r of (Array.isArray(reviews) ? reviews : []).slice(0, MAX_REVIEW_ITEMS)) {
      if (r && r.id) items.push({ key: `review/${r.id}`, route: 'review', sub: r.id, label: `Review gate: ${r.title || r.id}`, cls: 'sub', title: r.title || r.id });
    }
  }
  return items.filter(Boolean);
}

// The foot of the sidebar: Library (views/tools.js, route #library).
export function footItems(state, { views = {} } = {}) {
  return [plainItem(views.tools, state || {}, 'Library')].filter(Boolean);
}

// Is this entry the screen on show? Runs also covers a single run, and Assets the Inbox images it
// opens; a project entry covers every tab of its project; a review entry its own run only.
export function isCurrentItem(item, view, sub) {
  if (item.route === 'runs') return view === 'runs' || view === 'run';
  if (item.route === 'assets') return view === 'assets' || view === 'images';
  if (item.route === 'project') return view === 'project' && projectRoute(sub).name === item.sub;
  if (item.route === 'review') return view === 'review' && sub === item.sub;
  return routeOf(view) === item.route;
}
