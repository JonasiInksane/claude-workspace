// Projects: one card per project, with its agents (start isolated, edit, memory, images, new,
// archive and restore), then the Repositories card (projects/repos.json), folded at the bottom.
// A card's name opens the project's page (views/project.js); agentsSection() is that page's
// Agents tab too.
//
// Linked checkouts (SPEC 5.8, R24): a repo that is listed but not on this PC offers Clone and
// "Link existing checkout…", which links a checkout that lives elsewhere as projects/<name> (a
// junction; POST /api/projects/link checks the folder, its git top and its origin, and the
// dialog shows a refusal inline). A linked project shows "Linked: <real path>" and Unlink, which
// removes only the link (POST /api/projects/unlink; the checkout is never touched). A link whose
// folder is gone says so and offers Unlink.
//
// The view repaints only when the projects, repos or tools changed, so a live-update refresh
// keeps folded sections, open dialogs and the focus as they are.
import { act, api, confirmDialog, h, keepFocus, keyed, launch, openPlace, plural, qs, toast } from '../lib.js';
import { clearGuard, closeDialog, dialog, formDialog, openDialog } from '../dialog.js';
import { go, goProject, refresh, state } from '../store.js';
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
      keyed(h('button', {
        class: 'btn primary small', type: 'button', disabled: !usable || !!launchProblem(p),
        title: 'Opens a terminal with only this agent\'s memory and images',
        on: { click: () => launch({ kind: 'agent', project: p.name, agent: a.name }) },
      }, 'Start'), `agent-${p.name}-${a.name}-start`),
      keyed(h('button', { class: 'btn small', type: 'button', disabled: !a.valid, title: 'Role, description, model and instructions', on: { click: () => editAgentDialog(p, a) } }, 'Edit'), `agent-${p.name}-${a.name}-edit`),
      keyed(h('button', { class: 'btn small', type: 'button', disabled: !a.isolated || !a.valid, on: { click: () => memoryDialog(p.name, a.name) } }, 'Memory'), `agent-${p.name}-${a.name}-memory`),
      keyed(h('button', { class: 'btn small', type: 'button', disabled: !a.valid, on: { click: () => { setTarget({ project: p.name, agent: a.name }); go('images'); } } }, 'Images'), `agent-${p.name}-${a.name}-images`)));
}

// A <details> whose open state survives repaints (keyed by `id`); `open` is the first state.
const folded = new Map();
function foldable(id, open, props, ...children) {
  const box = h('details', { ...props, open: folded.has(id) ? folded.get(id) : open }, ...children);
  box.addEventListener('toggle', () => folded.set(id, box.open));
  return box;
}

// Why Claude can't start in this project now ('' when it can). Shown as text next to the buttons.
function launchProblem(p) {
  if (p.linked && !p.realPath) return 'The linked folder is gone. Unlink it, then link the checkout again.';
  if (!p.launchable) return 'The folder name has unusual characters; start it from a terminal.';
  if (!state.tools.claude) return 'Claude Code was not found on this PC, so sessions can\'t start.';
  return '';
}

// "Linked: C:\…\checkout", or a red "Link broken" when the folder behind the link is gone.
function linkBadge(p) {
  if (!p.linked) return null;
  return p.realPath
    ? h('span', { class: 'badge violet linked-badge', title: 'projects/ holds a link to this folder; Claude and git run there' },
      'Linked: ', h('span', { class: 'mono' }, p.realPath))
    : h('span', { class: 'badge red' }, 'Link broken: its folder is gone');
}

// Removes the link projects/<name> after a confirm; the checkout itself is never touched (the
// server refuses anything that is not a link). Resolves true when the link is gone.
async function unlink(name) {
  const ok = await confirmDialog(`Unlink ${name}?`, 'Removes only the link in projects/. Your checkout is not touched.', 'Unlink');
  if (!ok) return false;
  const r = await act(api('/api/projects/unlink', { method: 'POST', body: { name } }));
  refresh();
  return !!r;
}

// The agents of a project card, also the project page's Agents tab (views/project/agents.js):
// each agent with Start, Edit, Memory and Images, the shared images row, + New agent, and the
// archived agents with Restore (folded).
export function agentsSection(p) {
  const k = what => `project-${p.name}-${what}`;
  const agents = p.agents.length
    ? h('ul', { class: 'agents' }, p.agents.map(a => agentRow(p, a)),
      h('li', { class: 'agent' },
        h('div', { class: 'agent-name' }, 'Shared images', h('span', { class: 'badge' }, plural(p.sharedImages, 'image'))),
        h('div', { class: 'agent-desc' }, 'Every agent of this project can read these.'),
        h('div', { class: 'row-actions' },
          keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => { setTarget({ project: p.name, agent: '_shared' }); go('images'); } } }, 'Images'), k('shared-images')))))
    : h('div', { class: 'empty' }, h('b', {}, 'No agents yet'),
      'Add a specialist such as ', h('code', {}, 'asset-builder'), '. Each agent keeps its own memory and image folder.');
  const archived = p.archived.length
    ? foldable(`archived-${p.name}`, false, { class: 'archived' },
      h('summary', {}, `Archived agents (${p.archived.length})`),
      h('ul', { class: 'agents' }, p.archived.map(x => h('li', { class: 'agent' },
        h('div', { class: 'agent-name' }, x.name || x.archivedAs),
        h('div', { class: 'agent-desc' }, x.valid ? x.description : `No usable name in .claude/agents-archived/${x.archivedAs}`),
        h('div', { class: 'row-actions' }, keyed(h('button', {
          class: 'btn small', type: 'button', disabled: !x.valid,
          title: 'Moves its file back to .claude/agents/; its memory and images are still there',
          on: { click: () => act(api('/api/agents/restore', { method: 'POST', body: { project: p.name, archivedAs: x.archivedAs } })).then(refresh) },
        }, 'Restore'), k(`restore-${x.archivedAs}`)))))))
    : null;
  return [
    h('div', { class: 'section-label' }, h('span', {}, `Agents (${p.agents.length})`),
      keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => newAgentDialog(p) } }, '+ New agent'), k('new-agent'))),
    agents, archived,
  ];
}

function projectCard(p) {
  const problem = launchProblem(p);
  const canLaunch = !problem;
  const gone = p.linked && !p.realPath;
  const hint = p.launchable ? '' : 'The folder name has unusual characters; start it from a terminal.';
  const k = what => `project-${p.name}-${what}`;
  return h('div', { class: 'card project' },
    h('div', { class: 'card-head' },
      h('div', { class: 'project-title' },
        h('h3', {}, keyed(h('button', { class: 'link project-link', type: 'button', title: 'Opens the project page', on: { click: () => goProject(p.name) } }, p.name), k('page'))),
        h('span', { class: 'badge blue' }, p.label),
        p.hasClaudeMd ? h('span', { class: 'badge ok' }, 'CLAUDE.md') : h('span', { class: 'badge warn', title: 'Run /onboard-project in a session there' }, 'No CLAUDE.md'),
        linkBadge(p)),
      h('div', { class: 'row-actions' },
        keyed(h('button', { class: 'btn primary small', type: 'button', disabled: !canLaunch, title: hint, on: { click: () => launch({ kind: 'project', project: p.name }) } }, 'Start Claude'), k('start')),
        keyed(h('button', { class: 'btn small', type: 'button', disabled: !canLaunch, title: hint || 'claude -c in this project', on: { click: () => launch({ kind: 'project', project: p.name, continueLast: true }) } }, 'Continue'), k('continue')),
        p.hasClaudeMd ? null : keyed(h('button', {
          class: 'btn small', type: 'button', disabled: !canLaunch, title: hint || 'Runs /onboard-project there: maps the repo and writes its CLAUDE.md',
          on: { click: () => skillDialog(skillById('onboard-project'), { project: p.name }) },
        }, 'Onboard'), k('onboard')),
        keyed(h('button', { class: 'btn small', type: 'button', disabled: gone, on: { click: () => openPlace({ place: 'project', project: p.name }) } }, 'Folder'), k('folder')),
        state.tools.editor ? keyed(h('button', { class: 'btn small', type: 'button', disabled: gone, on: { click: () => openPlace({ place: 'project', project: p.name, with: 'editor' }) } }, state.tools.editor), k('editor')) : null,
        p.linked ? keyed(h('button', { class: 'btn small', type: 'button', title: 'Removes only the link in projects/; your checkout stays', on: { click: () => unlink(p.name) } }, 'Unlink…'), k('unlink')) : null),
      problem ? h('p', { class: 'reason project-reason' }, problem) : null),
    h('div', { class: 'card-body' }, agentsSection(p)));
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

// Links a checkout that already exists elsewhere on this PC as projects/<name> (a listed repo
// that isn't here). The server checks the folder (absolute, local, outside the hub, the top of a
// git checkout whose origin is the listed URL); a refusal shows under the field, which keeps the
// focus and the text, so it can be corrected. A 409 means projects/<name> is already taken, for
// example by an old link whose folder is gone (the state can't show those): the dialog then
// offers to remove that link, which the server does only for a link, never for a folder.
function linkDialog(x) {
  const path = h('input', {
    id: 'linkPath', required: true, autocomplete: 'off', spellcheck: 'false', maxlength: 400,
    placeholder: `C:\\Users\\you\\code\\${x.name}`, 'aria-describedby': 'linkPathHelp linkPathError',
  });
  const error = h('div', { class: 'form-error', id: 'linkPathError', hidden: true });
  const clear = () => { path.removeAttribute('aria-invalid'); error.hidden = true; fix.hidden = true; };
  const fix = h('button', {
    class: 'btn small', type: 'button', hidden: true,
    on: { click: async () => { if (await unlink(x.name)) { clear(); path.focus(); } } },
  }, `Remove the old link projects/${x.name}…`);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Link');
  const fail = (message, status) => {
    error.textContent = message;
    error.hidden = false;
    fix.hidden = status !== 409;
    path.setAttribute('aria-invalid', 'true');
    path.focus();
  };
  path.addEventListener('input', clear);
  // novalidate as an attribute (h() would set the lowercase DOM property, which does nothing), so
  // an empty field reaches the submit handler and gets the inline error, not a browser bubble.
  const form = h('form', {
    class: 'form', novalidate: '',
    on: {
      submit: async e => {
        e.preventDefault();
        if (!path.value.trim()) { fail('Paste the folder path first.'); return; }
        submit.disabled = true;
        try {
          const r = await api('/api/projects/link', { method: 'POST', body: { name: x.name, path: path.value.trim() } });
          dialog.close();
          toast(r.message);
          refresh();
        } catch (err) {
          fail(err.message, err.status);
        } finally {
          submit.disabled = false;
        }
      },
    },
  },
  h('p', { class: 'muted' }, `Makes projects/${x.name} a link to a checkout you already have. Nothing is cloned or copied, and the `,
    'checkout is not changed: Claude and git run in its real folder.'),
  h('label', { for: 'linkPath' }, 'Folder of your checkout',
    h('small', { id: 'linkPathHelp' }, `Paste the folder of your existing checkout, for example C:\\Users\\…\\${x.name}. `,
      `It must be the top folder of a git checkout whose origin is ${x.url}.`),
    path),
  error,
  h('div', {}, fix),
  h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), submit));
  openDialog(`Link existing checkout: ${x.name}`, form);
  path.focus();
}

// One listed repo: its state on this PC and what can be done (Folder; Clone or Link; Unlink).
function listedRow(x, needs) {
  const p = state.projects.find(q => q.name === x.name);
  const linked = !!(p && p.linked);
  const broken = linked && !p.realPath;
  const k = what => `repo-${x.name}-${what}`;
  let badges;
  if (broken) badges = h('span', { class: 'badge red' }, 'link broken');
  else if (x.present) {
    badges = [h('span', { class: `badge ${x.originMatches ? 'ok' : 'warn'}` }, x.originMatches ? 'on this PC' : 'other origin here'),
      linked ? h('span', { class: 'badge violet' }, 'linked') : null];
  } else badges = h('span', { class: 'badge' }, 'not on this PC');
  let actions;
  if (broken) {
    actions = keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => unlink(x.name) } }, 'Unlink…'), k('unlink'));
  } else if (x.present) {
    actions = keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => openPlace({ place: 'project', project: x.name }) } }, 'Folder'), k('folder'));
  } else {
    actions = h('div', { class: 'row-actions' },
      keyed(h('button', {
        class: 'btn small primary', type: 'button', title: 'A fresh git clone into projects/, in a terminal',
        on: { click: () => act(api('/api/repos/clone', { method: 'POST', body: { name: x.name } })) },
      }, 'Clone'), k('clone')),
      keyed(h('button', { class: 'btn small', type: 'button', title: 'Use a checkout you already have elsewhere on this PC', on: { click: () => linkDialog(x) } },
        'Link existing checkout…'), k('link')));
  }
  const sub = broken ? `projects/${x.name} links to a folder that is gone · listed: ${x.url}`
    : linked ? `${x.url} · linked to ${p.realPath}`
      : x.originMatches || !x.present ? x.url : `listed: ${x.url} · here: ${x.origin}`;
  return h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title repo-title' }, x.name, badges, needs(x.requires)),
      h('div', { class: 'sub', title: x.url }, sub)),
    actions);
}

// The Repositories card, folded (a <details>) unless `open`; its summary counts what needs a look.
function reposCard(open) {
  const r = state.repos;
  const needs = reqs => reqs.map(q => h('span', { class: `badge ${r.have[q] ? 'ok' : 'warn'}`, title: r.have[q] ? 'Found on this PC' : 'Not found on this PC' },
    r.have[q] ? REQ_LABEL[q] : `${REQ_LABEL[q]} missing`));
  const listed = r.list.map(x => listedRow(x, needs));
  const unlisted = r.unlisted.map(u => h('li', {},
    h('div', { class: 'main' },
      h('div', { class: 'title repo-title' }, u.name, h('span', { class: 'badge warn' }, 'not listed')),
      h('div', { class: 'sub' }, u.origin ? `${u.origin} · another PC won't get it` : 'No GitHub remote yet: push it first, then list it')),
    u.origin ? keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => addRepoDialog(u) } }, 'Add to list'), `repo-${u.name}-add`) : null));
  const missing = r.list.filter(x => !x.present).length;
  const counts = [plural(r.list.length, 'listed repo'), missing ? `${missing} not on this PC` : '', r.unlisted.length ? `${r.unlisted.length} not listed` : '']
    .filter(Boolean).join(' · ');
  return foldable('repos', open, { class: 'card repos' },
    h('summary', { class: 'card-head repos-summary' }, h('h3', {}, 'Repositories'), h('span', { class: 'muted small' }, counts)),
    h('div', { class: 'card-body' },
      h('div', { class: 'repos-tools' },
        h('span', { class: 'muted small' }, 'Clone a listed repo, link a checkout you already have, or list a project for your other PCs.'),
        keyed(h('button', { class: 'btn small', type: 'button', on: { click: cloneDialog } }, 'Clone a repo…'), 'repos-clone')),
      r.error ? h('div', { class: 'form-error' }, r.error) : null,
      listed.length || unlisted.length ? h('ul', { class: 'list' }, listed, unlisted)
        : h('div', { class: 'empty' }, 'No repos listed yet. Clone one, or list a project once it is on GitHub.')),
    h('div', { class: 'card-foot' },
      'The list is projects/repos.json in the workspace repo: commit and push it after a change, and another PC can clone the same ' +
      'projects here or with Setup.ps1 -Mode Install. A clone runs in a terminal, where GitHub may ask you to sign in.'));
}

let lastSignature = '';

// Projects first, the Repositories card folded at the bottom (open when there is no project
// yet, since cloning or linking is then the only way forward). Repaints only on a change.
function render(el) {
  // The run counts change during every run and are not shown here, so they don't count.
  const signature = JSON.stringify([state.projects.map(({ waiting, running, ...p }) => p), state.repos, state.tools]);
  if (signature === lastSignature && el.firstChild) return;
  lastSignature = signature;
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Projects'),
    h('p', {}, 'Each project is its own repo in projects/, or a link to a checkout elsewhere. Its agents keep their own memory and images.')));
  keepFocus(el, () => {
    if (!state.projects.length) {
      el.replaceChildren(head, h('div', { class: 'stack' }, h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('b', {}, 'No projects yet'), 'Clone or link one of yours below, or start Claude in the hub and run ', h('code', {}, '/new-project <name> nextjs'),
        ' (or game).')), reposCard(true)));
      return;
    }
    el.replaceChildren(head, h('div', { class: 'stack' }, state.projects.map(projectCard), reposCard(false)));
  });
}

export default {
  id: 'projects',
  label: 'Projects',
  icon: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  count: s => s.projects.length || '',
  render,
};
