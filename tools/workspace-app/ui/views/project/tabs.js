// The project page's tabs (views/project.js shows them), one module per tab in this folder. Which
// tabs a project gets, and in which order, comes from its type on the server (project-types.mjs,
// sent as state.projects[i].tabs); this list maps those ids to their modules.
//
// A tab module default-exports { id, label, render(el, ctx), onShow?(ctx), onHide?() }:
//   render(el, ctx)  fills `el` (the tab panel) on every repaint; patch it (parts/patch.js) so the
//                    focus, an open <details> and typed text survive
//   onShow(ctx)      the tab came on screen (or its project or rest changed): start loading what
//                    it shows (parts/project-data.js use()) and keep the release function
//   onHide()         the tab went: release what onShow took
// with ctx = { state, project (its /api/state entry), rest (the hash after the tab), go, refresh }.
// A new tab: its module here, its id in a type's `tabs` in project-types.mjs, its styles in
// css/project.css.
import overview from './overview.js';
import tasks from './tasks.js';
import findings from './findings.js';
import changes from './changes.js';
import checks from './checks.js';
import architecture from './architecture.js';
import agents from './agents.js';
import assets from './assets.js';
import settings from './settings.js';

export const TABS = [overview, tasks, findings, changes, checks, architecture, agents, assets, settings];

const byId = new Map(TABS.map(t => [t.id, t]));
export const tabModule = id => (byId.has(id) ? byId.get(id) : null);
export const tabLabel = id => (byId.has(id) ? byId.get(id).label : String(id || ''));
