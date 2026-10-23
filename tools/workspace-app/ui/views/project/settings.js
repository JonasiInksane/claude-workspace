// The project page's Settings tab (#project/<name>/settings, every type). For now: a short note
// that project rules arrive with project settings, and the project's profile (the private file in
// the data folder that makes it a code project): for a code project whether it is there and valid
// or which problems it has, with the --check command that checks it from a terminal; for another
// project, Create from the example, which turns it into a code project. Kept small on purpose;
// the project settings replace it.
//
// Data: GET /api/project's `profile` part (project-data.js `project`), for lowercase names only
// (the data folder accepts no others). The pure helpers (checkCommand, profileStatus) are
// exported for settings.test.mjs.
import { copy, h, plural } from '../../lib.js';
import { createMemo, patch } from '../../parts/patch.js';
import { dataOf, slot, use } from '../../parts/project-data.js';
import { btn, cardHead, DATA_NAME_RE, errorNote, loadingBody } from '../../parts/project-ui.js';
import { createProfile } from '../../parts/project-actions.js';

const memo = createMemo();

// ---------------------------------------------------------------- pure helpers (tested)

// The command that checks a project's profile from a terminal (run from the workspace root).
export const checkCommand = name => `node tools/workspace-app/profile/profile.mjs --check ${name}`;

// GET /api/project's profile part ({ exists, valid, errors, warnings, path }) as
// { state: 'valid' | 'invalid' | 'missing' | 'unknown', text, items }.
export function profileStatus(pr) {
  if (!pr || typeof pr !== 'object') return { state: 'unknown', text: 'Not loaded yet.', items: [] };
  if (!pr.exists) return { state: 'missing', text: 'No profile yet.', items: [] };
  const errors = Array.isArray(pr.errors) ? pr.errors.map(String) : [];
  const warnings = Array.isArray(pr.warnings) ? pr.warnings.map(String) : [];
  if (!pr.valid) return { state: 'invalid', text: `The profile has ${plural(errors.length, 'problem')}.`, items: errors };
  return { state: 'valid', text: warnings.length ? `Present and valid, with ${plural(warnings.length, 'warning')}.` : 'Present and valid.', items: warnings };
}

// ---------------------------------------------------------------- cards

function rulesNote() {
  return memo('rules', [], () => h('div', { class: 'card' }, h('div', { class: 'empty' },
    h('b', {}, 'Project rules arrive with project settings'),
    'Rules for every Claude session here, the default model, effort and permission mode, allowed tools and attached assets, saved as versions. Until then, Claude follows the project\'s CLAUDE.md.')));
}

function codeProfileCard(name, P) {
  const d = dataOf(P);
  const st = profileStatus(d && d.profile);
  return memo(`profile:${name}`, [st, d && d.profile && d.profile.path, P && P.error], () => {
    const head = cardHead('Profile', h('span', { class: 'muted small' }, 'private: in the data folder, never in the hub'));
    if (!d) return h('div', { class: 'card' }, head, P && P.error ? h('div', { class: 'card-body' }, errorNote(P.error, 'project')) : loadingBody());
    const cls = st.state === 'valid' ? 'ok' : st.state === 'invalid' ? 'red' : 'amber';
    const word = { valid: 'Valid', invalid: 'Has problems', missing: 'Missing', unknown: 'Unknown' }[st.state];
    return h('div', { class: 'card' }, head, h('div', { class: 'card-body vgrid' },
      h('p', {}, h('span', { class: `badge ${cls}` }, word), ' ', st.text),
      d.profile.path ? h('p', { class: 'mono st-path' }, d.profile.path) : null,
      st.items.length ? h('ul', { class: st.state === 'invalid' ? 'st-items errors' : 'st-items' }, st.items.map(t => h('li', {}, t))) : null,
      st.state === 'missing' ? h('div', {}, btn('st:create', 'Create from the example', () => createProfile(name), { cls: 'btn small primary' })) : null,
      h('div', { class: 'st-check' },
        h('p', { class: 'muted small' }, 'Check it from a terminal in the workspace folder:'),
        h('div', { class: 'row-actions' }, h('code', { class: 'st-command' }, checkCommand(name)),
          btn('st:copy', 'Copy', () => copy(checkCommand(name)), { title: 'Copies the command' })))));
  });
}

// An asset or plain project: what a profile would add, and the button that makes one.
function otherProfileCard(p) {
  const valid = DATA_NAME_RE.test(p.name);
  return memo(`profile-other:${p.name}`, [valid], () => h('div', { class: 'card' },
    cardHead('Profile', h('span', { class: 'muted small' }, 'private: in the data folder, never in the hub')),
    h('div', { class: 'card-body vgrid' },
      h('p', {}, 'No profile. With one, this becomes a code project: runs, checks, findings and architecture scans work for it, in the Tasks, Findings, Changes, Checks and Architecture tabs.'),
      valid
        ? h('div', {}, btn('st:create', 'Create from the example', () => createProfile(p.name), { cls: 'btn small primary' }),
          h('p', { class: 'muted small mt-2' }, 'It starts from the synthetic example; replace its values with the project\'s own.'))
        : h('p', { class: 'note' }, 'A profile needs a lowercase folder name (letters, digits and single hyphens).'))));
}

// ---------------------------------------------------------------- the tab

const isCode = p => !!(p && p.type && p.type.id === 'code');
let release = () => {};

export default {
  id: 'settings',
  label: 'Settings',
  render(el, ctx) {
    const p = ctx.project;
    patch(el, [rulesNote(), isCode(p) ? codeProfileCard(p.name, slot(p.name).project) : otherProfileCard(p)]);
  },
  onShow(ctx) {
    release();
    release = isCode(ctx.project) ? use(ctx.project.name, ['project']) : () => {};
  },
  onHide() { release(); release = () => {}; },
};
