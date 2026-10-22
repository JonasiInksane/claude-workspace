// Projects: the Repositories card (projects/repos.json) and one card per project, with its
// agents (start isolated, edit, memory, images, new, archive and restore).
import { act, api, h, launch, openPlace, plural, qs, toast } from '../lib.js';
import { clearGuard, closeDialog, dialog, formDialog, openDialog } from '../dialog.js';
import { go, refresh, state } from '../store.js';
import { skillById, skillDialog } from './tools.js';
import { setTarget } from './images.js';

function agentRow(p, a) {
  const usable = a.valid && a.isolated && !a.duplicate;
  const why = !a.valid ? 'Unusable name (not kebab-case or reserved). Rename it in its agent file.'
    : a.duplicate ? 'More than one agent file uses this name, so they would share one memory. Rename one.'
      : !a.isolated ? 'No "memory: project" in its agent file, so it has no memory of its own.' : '';
  return h('li', { class: `agent${usable ? '' : ' disabled'}` },
    h('div', { class: 'agent-name' }, a.name,
      a.isolated ? h('span', { class: 'badge violet', title: `.claude/agent-memory/${a.name}/` }, `memory · ${plural(a.memoryFiles, 'file')}`) : null,
      h('span', { class: 'badge' }, plural(a.images, 'image'))),
    h('div', { class: 'agent-desc' }, why || a.description),
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn primary small', disabled: !usable || !p.launchable || !state.tools.claude,
        title: 'Opens a terminal with only this agent\'s memory and images',
        on: { click: () => launch({ kind: 'agent', project: p.name, agent: a.name }) },
      }, 'Start'),
      h('button', { class: 'btn small', disabled: !a.valid, title: 'Role, description, model and instructions', on: { click: () => editAgentDialog(p, a) } }, 'Edit'),
      h('button', { class: 'btn small', disabled: !a.isolated || !a.valid, on: { click: () => memoryDialog(p.name, a.name) } }, 'Memory'),
      h('button', { class: 'btn small', disabled: !a.valid, on: { click: () => { setTarget({ project: p.name, agent: a.name }); go('images'); } } }, 'Images')));
}

function projectCard(p) {
  const canLaunch = p.launchable && state.tools.claude;
  const hint = p.launchable ? '' : 'The folder name has unusual characters; start it from a terminal.';
  const agents = p.agents.length
    ? h('ul', { class: 'agents' }, p.agents.map(a => agentRow(p, a)),
      h('li', { class: 'agent' },
        h('div', { class: 'agent-name' }, 'Shared images', h('span', { class: 'badge' }, plural(p.sharedImages, 'image'))),
        h('div', { class: 'agent-desc' }, 'Every agent of this project can read these.'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn small', on: { click: () => { setTarget({ project: p.name, agent: '_shared' }); go('images'); } } }, 'Images'))))
    : h('div', { class: 'empty' }, h('b', {}, 'No agents yet'),
      'Add a specialist such as ', h('code', {}, 'asset-builder'), '. Each agent keeps its own memory and image folder.');
  const archived = p.archived.length
    ? h('details', { class: 'archived' },
      h('summary', {}, `Archived agents (${p.archived.length})`),
      h('ul', { class: 'agents' }, p.archived.map(x => h('li', { class: 'agent' },
        h('div', { class: 'agent-name' }, x.name || x.archivedAs),
        h('div', { class: 'agent-desc' }, x.valid ? x.description : `No usable name in .claude/agents-archived/${x.archivedAs}`),
        h('div', { class: 'row-actions' }, h('button', {
          class: 'btn small', disabled: !x.valid,
          title: 'Moves its file back to .claude/agents/; its memory and images are still there',
          on: { click: () => act(api('/api/agents/restore', { method: 'POST', body: { project: p.name, archivedAs: x.archivedAs } })).then(refresh) },
        }, 'Restore'))))))
    : null;
  return h('div', { class: 'card project' },
    h('div', { class: 'card-head' },
      h('div', { class: 'project-title' }, h('h3', {}, p.name), h('span', { class: 'badge blue' }, p.label),
        p.hasClaudeMd ? h('span', { class: 'badge ok' }, 'CLAUDE.md') : h('span', { class: 'badge warn', title: 'Run /onboard-project in a session there' }, 'No CLAUDE.md')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary small', disabled: !canLaunch, title: hint, on: { click: () => launch({ kind: 'project', project: p.name }) } }, 'Start Claude'),
        h('button', { class: 'btn small', disabled: !canLaunch, title: hint || 'claude -c in this project', on: { click: () => launch({ kind: 'project', project: p.name, continueLast: true }) } }, 'Continue'),
        p.hasClaudeMd ? null : h('button', {
          class: 'btn small', disabled: !canLaunch, title: hint || 'Runs /onboard-project there: maps the repo and writes its CLAUDE.md',
          on: { click: () => skillDialog(skillById('onboard-project'), { project: p.name }) },
        }, 'Onboard'),
        h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'project', project: p.name }) } }, 'Folder'),
        state.tools.editor ? h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'project', project: p.name, with: 'editor' }) } }, state.tools.editor) : null)),
    h('div', { class: 'card-body' },
      h('div', { class: 'section-label' }, h('span', {}, `Agents (${p.agents.length})`),
        h('button', { class: 'btn small', on: { click: () => newAgentDialog(p) } }, '+ New agent')),
      agents, archived));
}

// ---------------------------------------------------------------- agent dialogs

// The whole agent file in a text box: the frontmatter (name, description, memory, model) and
// the instructions below it. The server refuses a rename and a save over newer changes.
async function editAgentDialog(p, a) {
  const ref = { project: p.name, agent: a.name, file: a.file };
  let f;
  try { f = await api(`/api/agent-file?${qs(ref)}`); } catch (e) { toast(e.message, true); return; }
  const area = h('textarea', { class: 'code-edit', spellcheck: 'false', 'aria-label': `${a.name} agent file` });
  area.value = f.text;
  const original = area.value; // the text box turns CRLF into LF; compare with what it holds
  const dirty = () => area.value !== original;
  const error = h('div', { class: 'form-error', hidden: true });
  const save = h('button', { class: 'btn primary' }, 'Save');
  const doSave = async () => {
    if (save.disabled) return; // Ctrl+S while a save is running
    save.disabled = true;
    error.hidden = true;
    try {
      const r = await api('/api/agent-file', { method: 'POST', body: { ...ref, text: area.value, hash: f.hash } });
      clearGuard();
      dialog.close();
      toast(r.message);
      for (const w of r.warnings || []) toast(w, true);
      refresh();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener('click', doSave);
  area.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  });
  const archive = h('button', {
    class: 'btn danger push-left',
    on: { click: () => { if (!dirty() || confirm(`Discard your changes to ${a.name}?`)) archiveDialog(p, a); } },
  }, 'Archive…');
  openDialog(`Edit ${a.name}`, h('div', {},
    h('p', { class: 'target-path mono' }, f.path),
    area,
    h('p', { class: 'muted hint' },
      'Between the --- lines: ', h('code', {}, 'description'), ' (when Claude hands work to it), ',
      h('code', {}, 'memory: project'), ' (its own memory), ', h('code', {}, 'model'), ' (inherit, sonnet, opus, haiku, fable or a full model ID) and optional ',
      h('code', {}, 'tools'), '. Below: its instructions. The name stays fixed. Ctrl+S saves.'),
    error), {
    wide: true,
    guard: () => !dirty() || confirm(`Discard your changes to ${a.name}?`),
    actions: [
      archive,
      state.tools.editor ? h('button', { class: 'btn', on: { click: () => openPlace({ place: 'agent', ...ref, with: 'editor' }) } }, `Open in ${state.tools.editor}`) : null,
      h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'),
      save,
    ].filter(Boolean),
  });
  area.focus();
}

function archiveDialog(p, a) {
  const body = { project: p.name, agent: a.name, file: a.file };
  openDialog(`Archive ${a.name}?`, h('div', {},
    h('p', {}, 'Its file moves to ', h('code', {}, '.claude/agents-archived/'), ', so Claude no longer uses it.'),
    h('p', { class: 'muted' }, 'Its memory and images stay where they are. Restore (under the agents list) brings it back with both.')), {
    actions: [
      h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        on: { click: async () => { dialog.close(); await act(api('/api/agents/archive', { method: 'POST', body })); refresh(); } },
      }, 'Archive'),
    ],
  });
}

function newAgentDialog(p) {
  const error = h('div', { class: 'error', hidden: true });
  const name = h('input', { required: true, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'asset-builder', autocomplete: 'off', spellcheck: 'false' });
  const role = h('textarea', { placeholder: 'Builds sprites, icons and UI images in assets/. Keeps the palette consistent.' });
  const description = h('input', { placeholder: 'When Claude should hand work to this agent (optional)' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create agent');
  const form = h('form', {
    class: 'form',
    on: {
      submit: async e => {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          const r = await api('/api/agents', { method: 'POST', body: { project: p.name, agent: name.value.trim(), role: role.value, description: description.value } });
          dialog.close();
          toast(r.message);
          await refresh();
        } catch (x) {
          error.textContent = x.message;
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
  },
  h('label', {}, 'Name', h('small', {}, 'Lowercase with dashes, for example asset-builder. It becomes the folder name for its memory and images.'), name),
  h('label', {}, 'Role', h('small', {}, 'What it does, in a sentence or two. You can refine the agent file later.'), role),
  h('label', {}, 'Description', h('small', {}, 'Optional. By default it is made from the role.'), description),
  error,
  h('div', { class: 'dialog-actions' },
    h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), submit));
  openDialog(`New agent in ${p.name}`, form);
  name.focus();
}

async function memoryDialog(project, agent) {
  let m;
  try { m = await api(`/api/memory?${qs({ project, agent })}`); } catch (e) { toast(e.message, true); return; }
  const pre = h('pre');
  const files = h('div', { class: 'files' });
  const select = f => {
    pre.textContent = f.content + (f.truncated ? '\n\n(only the first 100 KB is shown)' : '');
    for (const b of files.children) b.classList.toggle('active', b.dataset.name === f.name);
  };
  for (const f of m.files) files.append(h('button', { dataset: { name: f.name }, title: f.name, on: { click: () => select(f) } }, f.name));
  const body = m.files.length
    ? h('div', { class: 'memory' }, files, pre)
    : h('div', { class: 'empty' }, h('b', {}, 'No memory yet'), 'The agent writes here as it learns.');
  openDialog(`${agent}: memory`, h('div', {}, h('p', { class: 'target-path mono' }, m.dir), body), {
    wide: true,
    actions: [
      h('button', { class: 'btn', on: { click: () => openPlace({ place: 'memory', project, agent }) } }, 'Open memory folder'),
      h('button', { class: 'btn primary', on: { click: () => dialog.close() } }, 'Close'),
    ],
  });
  if (m.files[0]) select(m.files[0]);
}

// ---------------------------------------------------------------- repositories

const REQ_LABEL = { 'git-lfs': 'Git LFS', 'blender-5.2': 'Blender 5.2' };
// Same rule as tools/lib/repos.mjs: https://github.com/me/My_Game.git -> my-game.
const repoNameFromUrl = url => (String(url).trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Checkboxes for what a repo needs on a PC, as one form row; `picked()` returns the values.
function requirementBoxes(selected = []) {
  const boxes = Object.entries(REQ_LABEL).map(([value, label]) =>
    [h('input', { type: 'checkbox', value, checked: selected.includes(value) }), label]);
  const row = h('div', { class: 'check-group' }, h('div', { class: 'check-title' }, 'Needs on each PC',
    h('small', {}, 'Setup.ps1 and this list warn when it is missing.')),
  boxes.map(([box, label]) => h('label', { class: 'check' }, box, label)));
  return { row, picked: () => boxes.filter(([box]) => box.checked).map(([box]) => box.value) };
}

function cloneDialog() {
  const url = h('input', { required: true, placeholder: 'https://github.com/you/repo.git', autocomplete: 'off', spellcheck: 'false' });
  const name = h('input', { required: true, pattern: '[a-z0-9]+(-[a-z0-9]+)*', autocomplete: 'off', spellcheck: 'false' });
  let nameTyped = false;
  name.addEventListener('input', () => { nameTyped = true; });
  url.addEventListener('input', () => { if (!nameTyped) name.value = repoNameFromUrl(url.value); });
  const add = h('input', { type: 'checkbox', checked: true });
  const reqs = requirementBoxes();
  formDialog('Clone a repo', 'A plain git clone into projects/<name>, in a terminal: nothing is added to the repo.', [
    ['Git URL', 'HTTPS or SSH, for example https://github.com/you/game-dev.git', url],
    ['Folder name', 'Flows and agents refer to it, so keep it the same on every PC.', name],
    h('label', { class: 'check' }, add, 'Add it to projects/repos.json, so other PCs get it'),
    reqs.row,
  ], 'Clone', () => api('/api/repos/clone', {
    method: 'POST', body: { url: url.value.trim(), name: name.value.trim(), add: add.checked, requires: reqs.picked() },
  }).then(r => { refresh(); return r; }));
}

function addRepoDialog(u) {
  const reqs = requirementBoxes();
  formDialog(`List ${u.name}`, `Adds ${u.origin} to projects/repos.json, so another PC can clone it into projects/${u.name}.`,
    [reqs.row], 'Add to list',
    () => api('/api/repos/add', { method: 'POST', body: { name: u.name, requires: reqs.picked() } }).then(r => { refresh(); return r; }));
}

function reposCard() {
  const r = state.repos;
  const needs = reqs => reqs.map(q => h('span', { class: `badge ${r.have[q] ? 'ok' : 'warn'}`, title: r.have[q] ? 'Found on this PC' : 'Not found on this PC' },
    r.have[q] ? REQ_LABEL[q] : `${REQ_LABEL[q]} missing`));
  const listed = r.list.map(x => h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title repo-title' }, x.name,
        x.present ? h('span', { class: `badge ${x.originMatches ? 'ok' : 'warn'}` }, x.originMatches ? 'on this PC' : 'other origin here')
          : h('span', { class: 'badge' }, 'not on this PC'),
        needs(x.requires)),
      h('div', { class: 'sub', title: x.url }, x.originMatches ? x.url : `listed: ${x.url} · here: ${x.origin}`)),
    x.present
      ? h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'project', project: x.name }) } }, 'Folder')
      : h('button', { class: 'btn small primary', on: { click: () => act(api('/api/repos/clone', { method: 'POST', body: { name: x.name } })) } }, 'Clone')));
  const unlisted = r.unlisted.map(u => h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title repo-title' }, u.name, h('span', { class: 'badge warn' }, 'not listed')),
      h('div', { class: 'sub' }, u.origin ? `${u.origin} · another PC won't get it` : 'No GitHub remote yet: push it first, then list it')),
    u.origin ? h('button', { class: 'btn small', on: { click: () => addRepoDialog(u) } }, 'Add to list') : null));
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Repositories'),
      h('button', { class: 'btn small', on: { click: cloneDialog } }, 'Clone a repo…')),
    h('div', { class: 'card-body' },
      r.error ? h('div', { class: 'form-error' }, r.error) : null,
      listed.length || unlisted.length ? h('ul', { class: 'list' }, listed, unlisted)
        : h('div', { class: 'empty' }, 'No repos listed yet. Clone one, or list a project once it is on GitHub.')),
    h('div', { class: 'card-foot' },
      'The list is projects/repos.json in the workspace repo: commit and push it after a change, and another PC can clone the same ' +
      'projects here or with Setup.ps1 -Mode Install. A clone runs in a terminal, where GitHub may ask you to sign in.'));
}

function render(el) {
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Projects'),
    h('p', {}, 'Each project is its own repo in projects/. Its agents keep their own memory and images.')));
  if (!state.projects.length) {
    el.replaceChildren(head, reposCard(), h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, 'No projects yet'), 'Clone one of yours above, or start Claude in the hub and run ', h('code', {}, '/new-project <name> nextjs'),
      ' (or game).')));
    return;
  }
  el.replaceChildren(head, h('div', { class: 'stack' }, reposCard(), state.projects.map(projectCard)));
}

export default {
  id: 'projects',
  label: 'Projects',
  icon: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  count: s => s.projects.length || '',
  render,
};
