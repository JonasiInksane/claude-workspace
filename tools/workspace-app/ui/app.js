// Workspace app UI. Plain JS, no build step. Data is always rendered as text (h() below),
// never as HTML: names, descriptions and file names come from repos and the inbox.

const $ = sel => document.querySelector(sel);
const VIEWS = ['home', 'flows', 'tools', 'projects', 'images'];
const MAX_UPLOAD = 25 * 1024 * 1024;

let state = null;
let view = 'home';
let stopped = false;
let lastRefresh = 0;
let currentDir = { key: '', dir: '' }; // folder of the image target, once loaded
let galleryCache = { key: '', nodes: [] }; // shown again while a refresh reloads the gallery
const recentUploads = [];
let imageTarget = loadTarget();

// ---------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Fixed icon markup (no data inside), parsed once.
function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  return t.content.firstChild;
}
const ICON_UPLOAD = '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>';

const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const fmtDay = ymd => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function toast(message, isError = false) {
  const t = h('div', { class: `toast${isError ? ' err' : ''}`, role: isError ? 'alert' : 'status' }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 3500);
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied: ${text}`), () => toast('Could not copy to the clipboard', true));
}

function showStopped(message) {
  if (stopped) return;
  stopped = true;
  document.body.append(h('div', { class: 'overlay' }, h('div', {},
    h('h2', {}, 'The workspace app is not connected'),
    h('p', { class: 'muted' }, message || ''),
    h('p', {}, 'Close this window and start the app again (', h('code', {}, 'Workspace App.cmd'), ' or the Claude Workspace shortcut).'))));
}

async function api(path, { method = 'GET', body, raw, contentType } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-Workspace-App'] = '1';
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = contentType || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, opts); } catch {
    // Also happens when a dropped file can't be read, so this alone doesn't mean "stopped".
    throw Object.assign(new Error('Could not reach the app server (or read the file).'), { network: true });
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : { ok: false, error: await res.text() };
  if (res.status === 403 && !isJson) { showStopped(data.error); throw new Error(data.error); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// After a network error on the heartbeat or a refresh: is the server really gone?
function checkServer() {
  fetch('/health').then(r => { if (!r.ok) showStopped('The app server is not answering.'); },
    () => showStopped('The app server has stopped.'));
}

async function act(promise) {
  try {
    const r = await promise;
    toast((r && r.message) || 'Done');
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}
const launch = body => act(api('/api/launch', { method: 'POST', body }));
const openPlace = body => act(api('/api/open', { method: 'POST', body }));

// ---------------------------------------------------------------- image target

function loadTarget() {
  try { return JSON.parse(localStorage.getItem('imageTarget')) || { hub: true }; } catch { return { hub: true }; }
}
function setTarget(t) {
  imageTarget = t;
  try { localStorage.setItem('imageTarget', JSON.stringify(t)); } catch { /* private mode */ }
}
// A target is { hub: true }, { project, agent } (agent may be '_shared') or { flow, title }.
const targetKey = t => (t.hub ? 'hub' : t.flow ? `f:${t.flow}` : `p:${t.project}/${t.agent}`);
const targetParams = t => (t.hub ? { hub: '1' } : t.flow ? { flow: t.flow } : { project: t.project, agent: t.agent });
function targetLabel(t) {
  if (t.hub) return 'Hub';
  if (t.flow) return `flow ${t.title || t.flow}`;
  return `${t.project} · ${t.agent === '_shared' ? 'shared' : t.agent}`;
}
function allTargets() {
  const list = [{ hub: true }];
  for (const p of state.projects) {
    list.push({ project: p.name, agent: '_shared' });
    for (const a of p.agents.filter(x => x.valid)) list.push({ project: p.name, agent: a.name });
  }
  return list;
}

// ---------------------------------------------------------------- dialog

const dialog = $('#dialog');
// A dialog with unsaved changes sets this; it returns false to stay open.
let closeGuard = null;
// A dialog that takes dropped or pasted images (the flow editor) sets this.
let dialogUpload = null;
function closeDialog() {
  if (closeGuard && !closeGuard()) return;
  dialog.close();
}
dialog.addEventListener('close', () => { closeGuard = null; dialogUpload = null; });
// Esc with unsaved changes: handled on keydown, because Edge may make the `cancel` event
// uncancelable (no user activation since the last Esc) and then close anyway.
dialog.addEventListener('keydown', e => {
  if (e.key === 'Escape' && closeGuard) { e.preventDefault(); closeDialog(); }
});
dialog.addEventListener('cancel', e => { if (closeGuard && !closeGuard()) e.preventDefault(); });
// Close on a click on the backdrop, but not when a drag (text selection) started inside.
let downOnBackdrop = false;
dialog.addEventListener('pointerdown', e => { downOnBackdrop = e.target === dialog; });
dialog.addEventListener('click', e => {
  if (e.target === dialog && downOnBackdrop) closeDialog();
  downOnBackdrop = false;
});
function openDialog(title, body, { wide = false, actions = [], guard = null, upload = null } = {}) {
  closeGuard = guard;
  dialogUpload = upload;
  dialog.className = wide ? 'wide' : '';
  dialog.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', on: { click: closeDialog } }, '✕')),
    h('div', { class: 'card-body' }, body),
    actions.length ? h('div', { class: 'card-foot dialog-actions' }, actions) : null,
  );
  if (!dialog.open) dialog.showModal();
}

// ---------------------------------------------------------------- views

function show(v) {
  view = VIEWS.includes(v) ? v : 'home';
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.view === view);
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
  $('main').scrollTop = 0;
}

function render() {
  if (!state) return;
  $('#rootPath').textContent = state.root.split(/[\\/]/).pop();
  $('#rootPath').title = state.root;
  $('#countProjects').textContent = state.projects.length || '';
  $('#countFlows').textContent = state.flows.length || '';
  const missing = [];
  if (!state.tools.claude) missing.push('Claude Code not found');
  if (!state.tools.wt) missing.push('no Windows Terminal (new windows instead)');
  $('#toolsInfo').textContent = missing.join(' · ') || `Today ${state.today}`;
  for (const id of ['#startHub', '#continueHub']) $(id).disabled = !state.tools.claude;
  // Re-rendering replaces the view; keep the reader's place (show() scrolls to the top itself).
  const main = $('main');
  const top = main.scrollTop;
  ({ home: renderHome, flows: renderFlows, tools: renderTools, projects: renderProjects, images: renderImages })[view]();
  main.scrollTop = top;
}

async function refresh() {
  lastRefresh = Date.now();
  try {
    state = await api('/api/state');
    render();
  } catch (e) {
    if (e.network) checkServer();
    else if (!stopped) toast(e.message, true);
  }
}

function stat(value, label, onClick) {
  return h('button', { class: 'stat', on: { click: onClick } }, h('b', {}, value), h('span', {}, label));
}

function thumbFor(item) {
  if (item.isImage) return h('span', { class: 'thumb' }, h('img', { src: `/img?${qs({ path: item.path })}`, alt: '', loading: 'lazy' }));
  const ext = (item.name.split('.').pop() || 'file').slice(0, 4);
  return h('span', { class: 'thumb' }, ext);
}

function renderHome() {
  const s = state;
  const libFiles = s.inbox.libraries.reduce((n, l) => n + l.files, 0);
  const inboxCard = h('div', { class: 'card', id: 'inboxCard' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Inbox'),
      h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'inbox' }) } }, 'Open folder')),
    h('div', { class: 'card-body' },
      s.inbox.error ? h('p', { class: 'badge warn' }, s.inbox.error) : null,
      s.inbox.truncated ? h('p', { class: 'muted' }, 'Only part of the inbox was scanned (too deep or too many files).') : null,
      s.inbox.items.length
        ? h('ul', { class: 'list' }, s.inbox.items.slice(0, 12).map(it => h('li', {},
          thumbFor(it),
          h('div', { class: 'main' },
            h('div', { class: 'title', title: it.path }, it.name),
            h('div', { class: 'sub' }, `${it.path.split('/').slice(1, -1).join('/') || 'inbox'} · ${fmtSize(it.size)} · ${fmtTime(it.mtime)}`)))))
        : h('div', { class: 'empty' }, h('b', {}, 'Inbox zero'), 'Drop notes, links and screenshots in inbox/, or paste images under Images.')),
    h('div', { class: 'card-foot' },
      s.inbox.total ? ['File these with ', h('code', {}, '/inbox-triage'), ' in a hub session.', s.inbox.total > 12 ? ` ${s.inbox.total - 12} more not shown.` : ''] : '',
      libFiles ? h('div', {}, `Agent images (not triage items): ${plural(libFiles, 'file')} in ${plural(s.inbox.libraries.length, 'folder')}.`) : null));

  const reportsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Active reports')),
    h('div', { class: 'card-body' }, s.reports.length
      ? h('ul', { class: 'list' }, s.reports.map(r => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title', title: r.title }, r.title),
          h('div', { class: 'sub' }, [r.type, r.project || 'hub', r.updated && `updated ${r.updated}`].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'report', report: r.id }) } }, 'Folder'))))
      : h('div', { class: 'empty' }, 'No active reports.')));

  const projectsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Projects'),
      h('button', { class: 'btn small', on: { click: () => show('projects') } }, 'All projects')),
    h('div', { class: 'card-body' }, s.projects.length
      ? h('ul', { class: 'list' }, s.projects.map(p => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title' }, p.name),
          h('div', { class: 'sub' }, `${p.label} · ${plural(p.agents.length, 'agent')}`)),
        h('button', { class: 'btn small', disabled: !p.launchable || !s.tools.claude, on: { click: () => launch({ kind: 'project', project: p.name }) } }, 'Start Claude'))))
      : h('div', { class: 'empty' }, h('b', {}, 'No projects yet'), 'Start Claude in the hub and run ', h('code', {}, '/new-project'), '.')));

  $('#view-home').replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Dashboard'), h('p', {}, fmtDay(s.today)))),
    h('div', { class: 'stats' },
      stat(`${s.inbox.total}${s.inbox.truncated ? '+' : ''}`, 'inbox items waiting', () => $('#inboxCard').scrollIntoView({ behavior: 'smooth' })),
      stat(libFiles, 'agent images', () => show('images')),
      stat(s.flows.length, 'flows', () => show('flows')),
      stat(s.reports.length, 'active reports', () => reportsCard.scrollIntoView({ behavior: 'smooth' })),
      stat(s.projects.length, 'projects', () => show('projects'))),
    h('div', { class: 'grid2' }, inboxCard, h('div', { class: 'stack' }, reportsCard, projectsCard)),
  );
}

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
      h('button', { class: 'btn small', disabled: !a.valid, on: { click: () => { setTarget({ project: p.name, agent: a.name }); show('images'); } } }, 'Images')));
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
          h('button', { class: 'btn small', on: { click: () => { setTarget({ project: p.name, agent: '_shared' }); show('images'); } } }, 'Images'))))
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
      closeGuard = null;
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

function renderProjects() {
  const head = h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Projects'),
    h('p', {}, 'Each project is its own repo in projects/. Its agents keep their own memory and images.')));
  if (!state.projects.length) {
    $('#view-projects').replaceChildren(head, h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('b', {}, 'No projects yet'), 'Start Claude in the hub and run ', h('code', {}, '/new-project <name> nextjs'),
      ' (or game, or with a git URL to clone).')));
    return;
  }
  $('#view-projects').replaceChildren(head, h('div', { class: 'stack' }, state.projects.map(projectCard)));
}

// ---------------------------------------------------------------- flows

// Where a flow runs, as one select value: hub, project:<name> or agent:<project>/<agent>.
const flowTargetValue = f => (f.target === 'hub' ? 'hub' : f.target === 'project' ? `project:${f.project}` : `agent:${f.project}/${f.agent}`);
function flowTargetLabel(f) {
  if (f.target === 'hub') return 'Hub';
  return f.target === 'project' ? f.project : `${f.project} · ${f.agent}`;
}
function parseTargetValue(v) {
  if (v === 'hub') return { target: 'hub', project: '', agent: '' };
  if (v.startsWith('project:')) return { target: 'project', project: v.slice(8), agent: '' };
  const rest = v.slice(6);
  const i = rest.lastIndexOf('/');
  return { target: 'agent', project: rest.slice(0, i), agent: rest.slice(i + 1) };
}

function targetSelect(current) {
  const select = h('select', {},
    h('option', { value: 'hub' }, 'Hub: Claude in the workspace'),
    state.projects.filter(p => p.launchable).map(p => h('optgroup', { label: p.name },
      h('option', { value: `project:${p.name}` }, `${p.name}: project session`),
      p.agents.filter(a => a.valid && a.isolated && !a.duplicate)
        .map(a => h('option', { value: `agent:${p.name}/${a.name}` }, `${p.name}: ${a.name} (agent, own memory and images)`)))));
  if (current) {
    const v = flowTargetValue(current);
    if (![...select.options].some(o => o.value === v)) select.prepend(h('option', { value: v }, `${flowTargetLabel(current)} (not available now)`));
    select.value = v;
  }
  return select;
}

async function loadFlowThumbs(f, box) {
  try {
    const r = await api(`/api/images?${qs({ flow: f.slug })}`);
    box.replaceChildren(...r.images.slice(0, 6).map(img => h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name, title: img.name, loading: 'lazy' })));
  } catch { /* thumbnails are a nicety */ }
}

function flowCard(f) {
  const thumbs = h('div', { class: 'flow-thumbs' });
  if (f.images) loadFlowThumbs(f, thumbs);
  const badge = f.target === 'agent' ? 'violet' : f.target === 'project' ? 'blue' : '';
  return h('div', { class: 'card flow' },
    h('div', { class: 'card-head' },
      h('div', { class: 'project-title' }, h('h3', {}, f.title || f.slug), h('span', { class: `badge ${badge}` }, flowTargetLabel(f))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary small', disabled: !!f.error || !state.tools.claude, on: { click: () => runFlowDialog(f) } }, 'Run…'),
        h('button', { class: 'btn small', on: { click: () => flowDialog(f.slug) } }, 'Edit'))),
    h('div', { class: 'card-body' },
      f.error ? h('div', { class: 'form-error' }, `Can't run: ${f.error}. Edit it to pick another target.`) : null,
      f.description ? h('p', { class: 'flow-desc' }, f.description) : null,
      h('div', { class: 'muted small-text' }, f.images ? plural(f.images, 'reference image') : 'No images', ' · ', h('code', {}, `flows/${f.slug}.md`)),
      thumbs));
}

function renderFlows() {
  const archived = state.archivedFlows.length
    ? h('details', { class: 'archived' },
      h('summary', {}, `Archived flows (${state.archivedFlows.length})`),
      h('ul', { class: 'list' }, state.archivedFlows.map(x => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title' }, x.title), h('div', { class: 'sub' }, `flows/_archived/${x.archivedAs}`)),
        h('button', {
          class: 'btn small',
          on: { click: () => act(api('/api/flows/restore', { method: 'POST', body: { archivedAs: x.archivedAs } })).then(refresh) },
        }, 'Restore')))))
    : null;
  $('#view-flows').replaceChildren(
    h('div', { class: 'view-head' },
      h('div', {}, h('h2', {}, 'Flows'),
        h('p', {}, 'A tuned prompt plus its reference images. Run starts Claude with both, in the hub, a project or one agent.')),
      h('button', { class: 'btn primary', on: { click: () => flowDialog('') } }, '+ New flow')),
    state.flows.length
      ? h('div', { class: 'grid2' }, state.flows.map(flowCard))
      : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No flows yet'),
        'Make one for work you repeat: a prompt you have tuned, plus the images that go with it.')),
    archived || '');
}

// Create (slug '') or edit a flow. A new flow reopens in edit mode, where images can be added.
async function flowDialog(slug) {
  let f = { title: '', description: '', target: 'hub', project: '', agent: '', prompt: '', hash: '' };
  if (slug) {
    try { f = await api(`/api/flow?${qs({ slug })}`); } catch (e) { toast(e.message, true); return; }
  }
  const title = h('input', { required: true, maxlength: 120, autocomplete: 'off', placeholder: 'Hero sprite from a sketch' });
  const description = h('input', { maxlength: 300, autocomplete: 'off', placeholder: 'Optional: what it is for, shown on its card' });
  const target = targetSelect(slug ? f : null);
  const prompt = h('textarea', {
    class: 'code-edit prompt-edit', 'aria-label': 'Prompt',
    placeholder: 'Write it as you would type it to Claude: the goal, the constraints, what done looks like.',
  });
  title.value = f.title;
  description.value = f.description;
  prompt.value = f.prompt;
  const snapshot = () => JSON.stringify([title.value, description.value, target.value, prompt.value]);
  const initial = snapshot();
  const dirty = () => snapshot() !== initial;
  const error = h('div', { class: 'form-error', hidden: true });
  const save = h('button', { class: 'btn primary' }, slug ? 'Save' : 'Create flow');

  let upload = null;
  let images;
  if (slug) {
    const gallery = h('div', { class: 'gallery small' });
    const reload = async () => {
      try {
        const r = await api(`/api/images?${qs({ flow: slug })}`);
        gallery.replaceChildren(...(r.images.length ? r.images.map(img => imageTile(img, { zoom: false })) : [h('p', { class: 'muted' }, 'No images yet.')]));
      } catch (e) { gallery.replaceChildren(h('p', { class: 'muted' }, e.message)); }
    };
    upload = async (files, pasted) => { await uploadFiles(files, pasted, { flow: slug, title: f.title }); reload(); };
    const input = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, hidden: true,
      on: { change: e => { const files = [...e.target.files]; e.target.value = ''; upload(files, false); } },
    });
    images = h('div', {},
      h('div', { class: 'section-label' }, h('span', {}, 'Reference images'),
        h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'images', flow: slug }) } }, 'Open folder')),
      h('div', {
        class: 'drop compact', id: 'dialogDrop', tabindex: '0', role: 'button', 'aria-label': 'Add images to this flow',
        on: { click: () => input.click(), keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      }, h('b', {}, 'Drop images here, paste with Ctrl+V, or click to choose'),
      h('span', {}, `Saved right away in inbox/attachments/_flows/${slug}/. Every run passes their paths.`)),
      input, gallery);
    reload();
  } else {
    images = h('p', { class: 'muted hint' }, 'After you create the flow, you can add reference images to it here.');
  }

  const doSave = async () => {
    if (save.disabled) return; // Ctrl+S while a save is running, or after a create
    save.disabled = true;
    error.hidden = true;
    try {
      const body = { slug, hash: f.hash, title: title.value, description: description.value, prompt: prompt.value, ...parseTargetValue(target.value) };
      const r = await api('/api/flows', { method: 'POST', body });
      closeGuard = null;
      toast(r.message);
      await refresh();
      if (slug) dialog.close();
      else flowDialog(r.slug); // Save stays disabled: this dialog is done
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      save.disabled = false;
    }
  };
  save.addEventListener('click', doSave);
  const body = h('div', { class: 'form flow-form' },
    h('div', { class: 'two-col' },
      h('label', {}, 'Title', title),
      h('label', {}, 'Runs in', h('small', {}, 'An agent starts with its own memory and images.'), target)),
    h('label', {}, 'Description', description),
    h('label', {}, 'Prompt', h('small', {}, 'Notes for one run and the image paths are added when you run it. Ctrl+S saves.'), prompt),
    error,
    images);
  body.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  });
  const archive = slug ? h('button', {
    class: 'btn danger push-left',
    on: { click: () => { if (!dirty() || confirm('Discard your changes to this flow?')) archiveFlowDialog(slug, f.title); } },
  }, 'Archive…') : null;
  openDialog(slug ? `Edit flow: ${f.title}` : 'New flow', body, {
    wide: true,
    guard: () => !dirty() || confirm('Discard your changes to this flow?'),
    upload,
    actions: [archive, h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'), save].filter(Boolean),
  });
  (slug ? prompt : title).focus();
}

function archiveFlowDialog(slug, title) {
  openDialog(`Archive ${title}?`, h('div', {},
    h('p', {}, 'Its file moves to ', h('code', {}, 'flows/_archived/'), ', so it leaves this list.'),
    h('p', { class: 'muted' }, 'Its images stay where they are. Restore (under the flows) brings it back with them.')), {
    actions: [
      h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        on: { click: async () => { dialog.close(); await act(api('/api/flows/archive', { method: 'POST', body: { slug } })); refresh(); } },
      }, 'Archive'),
    ],
  });
}

// Shows the exact prompt Claude will start with (built by the server), with optional notes.
function runFlowDialog(f) {
  const notes = h('textarea', { maxlength: 2000, placeholder: 'Optional: what is different this time, for example "the hero, walking left"' });
  const pre = h('pre', { class: 'output' }, 'Loading…');
  let timer = 0;
  const preview = async () => {
    try {
      pre.textContent = (await api('/api/flows/run', { method: 'POST', body: { slug: f.slug, notes: notes.value, preview: true } })).prompt;
    } catch (e) { pre.textContent = e.message; }
  };
  notes.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 350); });
  const start = h('button', { class: 'btn primary' }, `Start in ${flowTargetLabel(f)}`);
  start.addEventListener('click', async () => {
    start.disabled = true;
    const r = await act(api('/api/flows/run', { method: 'POST', body: { slug: f.slug, notes: notes.value } }));
    start.disabled = false;
    if (r) dialog.close();
  });
  openDialog(`Run: ${f.title || f.slug}`, h('div', { class: 'form' },
    h('label', {}, 'Notes for this run', h('small', {}, 'Added below the prompt. Leave empty to run the flow as it is.'), notes),
    h('div', {}, h('div', { class: 'section-label' }, h('span', {}, 'Claude starts with')), pre)), {
    wide: true,
    actions: [h('button', { class: 'btn', on: { click: closeDialog } }, 'Cancel'), start],
  });
  preview();
  notes.focus();
}

// ---------------------------------------------------------------- tools

// A form in the dialog. `controls` are [label, hint, element]; `submit` returns a promise. An
// error shows inside the form; success closes the dialog and shows the server's message.
function formDialog(title, intro, controls, submitLabel, submit) {
  const error = h('div', { class: 'error', hidden: true });
  const button = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', {
    class: 'form',
    on: {
      submit: async e => {
        e.preventDefault();
        button.disabled = true;
        error.hidden = true;
        try {
          const r = await submit();
          dialog.close();
          if (r && r.message) toast(r.message);
        } catch (x) {
          error.textContent = x.message;
          error.hidden = false;
        } finally {
          button.disabled = false;
        }
      },
    },
  },
  intro ? h('p', { class: 'muted' }, intro) : null,
  controls.map(([label, hint, el]) => h('label', {}, label, hint ? h('small', {}, hint) : null, el)),
  error,
  h('div', { class: 'dialog-actions' },
    h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), button));
  openDialog(title, form);
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
}

const skillById = id => state.catalog.skills.find(s => s.id === id);
const startSkill = (id, values) => api('/api/skill', { method: 'POST', body: { id, values } });

function fieldControl(f, skill, preset) {
  if (f.kind === 'project') {
    const projects = state.projects.filter(p => skill.where !== 'project' || p.launchable);
    const el = h('select', { required: true }, projects.map(p => h('option', { value: p.name }, p.name)));
    if (preset.project) el.value = preset.project;
    return el;
  }
  if (f.kind === 'select') return h('select', {}, f.options.map(([value, label]) => h('option', { value }, label)));
  if (f.kind === 'date') return h('input', { type: 'date' });
  if (f.kind === 'textarea') return h('textarea', { required: !!f.required, maxlength: f.max || 200 });
  return h('input', { required: !!f.required, maxlength: f.max || 200, autocomplete: 'off' });
}

// No fields: start at once. Otherwise ask for them first. `preset` fills in a project.
function skillDialog(skill, preset = {}) {
  if (!skill.fields.length) { act(startSkill(skill.id, {})); return; }
  const controls = skill.fields.map(f => [f.label, f.hint, fieldControl(f, skill, preset)]);
  formDialog(`${skill.label} (/${skill.id})`, skill.text, controls,
    skill.where === 'project' ? 'Start in the project' : 'Start in the hub',
    () => startSkill(skill.id, Object.fromEntries(skill.fields.map((f, i) => [f.key, controls[i][2].value]))));
}

// Runs a workspace tool and shows its output. The library shows a preview first, with a
// button that installs for real.
async function runCommand(cmd, { preview = false, confirm = false } = {}) {
  const status = h('span', { class: 'badge' }, 'Running…');
  const pre = h('pre', { class: 'output' });
  const install = h('button', { class: 'btn primary', hidden: true, on: { click: () => runCommand(cmd, { confirm: true }) } }, 'Install now');
  openDialog(preview ? `${cmd.label}: preview` : cmd.label,
    h('div', {}, h('p', { class: 'target-path mono' }, preview ? `${cmd.command} --dry-run` : cmd.command), status, pre), {
      wide: true,
      actions: [install, h('button', { class: 'btn', on: { click: () => dialog.close() } }, 'Close')],
    });
  try {
    const r = await api('/api/run', { method: 'POST', body: { id: cmd.id, preview, confirm } });
    pre.textContent = r.output.trim() || '(no output)';
    status.textContent = r.status === 0 ? 'Finished' : `Exit code ${r.status}`;
    status.className = `badge ${r.status === 0 ? 'ok' : 'warn'}`;
    if (preview && r.status === 0) install.hidden = false;
  } catch (e) {
    status.textContent = 'Failed';
    status.className = 'badge warn';
    pre.textContent = e.message;
  }
  refresh();
}

function newProjectDialog() {
  const name = h('input', { required: true, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'my-app', autocomplete: 'off', spellcheck: 'false' });
  const type = h('select', {}, state.catalog.projectTypes.map(t => h('option', { value: t }, t === 'nextjs' ? 'Next.js' : 'Game')));
  const from = h('input', { placeholder: 'https://github.com/you/repo.git', autocomplete: 'off', spellcheck: 'false' });
  formDialog('New project', 'Runs tools/new-project.mjs in a terminal, so you can follow a clone.', [
    ['Name', 'Lowercase with dashes. It becomes projects/<name>.', name],
    ['Template', 'Copies templates/<type>/ into the project. Existing files are never overwritten.', type],
    ['Git URL', 'Optional: clone this repo instead of starting an empty one.', from],
  ], 'Create', () => api('/api/projects', { method: 'POST', body: { name: name.value.trim(), type: type.value, from: from.value.trim() } }));
}

function toolRow(title, text, button) {
  return h('li', {}, h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'sub wrap' }, text)), button);
}

function renderTools() {
  const c = state.catalog;
  const skillRow = s => toolRow([s.label, ' ', h('code', {}, `/${s.id}`)], s.text, h('button', {
    class: 'btn small primary',
    disabled: !state.tools.claude || (s.fields.some(f => f.kind === 'project') && !state.projects.length),
    on: { click: () => skillDialog(s) },
  }, s.fields.length ? 'Start…' : 'Start'));
  const card = (title, rows, foot) => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, title)),
    h('div', { class: 'card-body' }, h('ul', { class: 'list' }, rows)),
    foot ? h('div', { class: 'card-foot' }, foot) : null);

  $('#view-tools').replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Tools'),
      h('p', {}, 'Skills open Claude in a new terminal and run the command there. Workspace tools run here and show their output.'))),
    h('div', { class: 'grid2' },
      card('Hub skills', c.skills.filter(s => s.where === 'hub').map(skillRow),
        ['/write-handoff is not here: it sums up the session it runs in, so type it in that session.']),
      h('div', { class: 'stack' },
        card('Project skills', c.skills.filter(s => s.where === 'project').map(skillRow),
          ['Run /onboard-project first in a project without a CLAUDE.md.']),
        card('Workspace', [
          toolRow('New project', 'From the Next.js or game template, or cloned from a git URL.',
            h('button', { class: 'btn small', on: { click: newProjectDialog } }, 'New…')),
          ...c.commands.map(cmd => toolRow(cmd.label, cmd.text, h('button', {
            class: 'btn small', on: { click: () => runCommand(cmd, { preview: cmd.preview }) },
          }, cmd.preview ? 'Preview…' : 'Run'))),
        ]))),
  );
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

function lightbox(img) {
  openDialog(img.name, h('div', { class: 'lightbox' },
    h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name }),
    h('p', { class: 'target-path mono' }, img.abs)), {
    wide: true,
    actions: [
      h('button', { class: 'btn', on: { click: () => copy(img.abs) } }, 'Copy path'),
      h('button', { class: 'btn primary', on: { click: () => dialog.close() } }, 'Close'),
    ],
  });
}

// zoom: false inside another dialog (the lightbox would replace it).
function imageTile(img, { zoom = true } = {}) {
  return h('div', { class: 'tile' },
    h('button', { class: 'pic', title: `${img.name} (${fmtSize(img.size)})`, on: { click: () => (zoom ? lightbox(img) : window.open(`/img?${qs({ path: img.path })}`, '_blank')) } },
      h('img', { src: `/img?${qs({ path: img.path })}`, alt: img.name, loading: 'lazy' })),
    h('div', { class: 'meta' }, h('span', { title: img.name }, img.name),
      h('button', { class: 'icon-btn', title: 'Copy the full path', on: { click: () => copy(img.abs) } }, 'Copy')));
}

async function loadGallery(box, pathEl) {
  const key = targetKey(imageTarget);
  let r;
  try { r = await api(`/api/images?${qs(targetParams(imageTarget))}`); } catch (e) {
    box.replaceChildren(h('div', { class: 'empty' }, e.message));
    return;
  }
  if (key !== targetKey(imageTarget) || !box.isConnected) return; // target changed or view re-rendered
  currentDir = { key, dir: r.dir };
  pathEl.textContent = r.dir;
  if (!r.images.length) {
    box.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'No images here yet'), 'Drop, paste or choose images above.'));
  } else {
    const days = new Map();
    for (const img of r.images) {
      const d = img.date || 'Not in a dated folder';
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(img);
    }
    box.replaceChildren(...[...days].flatMap(([d, imgs]) => [h('div', { class: 'day' }, d), h('div', { class: 'gallery' }, imgs.map(imageTile))]));
  }
  galleryCache = { key, nodes: [...box.childNodes] };
}

function drawUploads() {
  const list = $('#uploads');
  if (list) list.replaceChildren(...recentUploads.map(u => h('li', { class: u.cls }, u.text)));
}

function renderImages() {
  if (!allTargets().some(t => targetKey(t) === targetKey(imageTarget))) setTarget({ hub: true });
  const select = h('select', {
    'aria-label': 'Where images are saved',
    on: { change: e => { setTarget(allTargets().find(t => targetKey(t) === e.target.value) || { hub: true }); renderImages(); } },
  });
  select.append(h('option', { value: 'hub' }, 'Hub · not for a project yet (triaged later)'));
  for (const p of state.projects) {
    select.append(h('optgroup', { label: p.name },
      h('option', { value: targetKey({ project: p.name, agent: '_shared' }) }, `${p.name} · shared by all agents`),
      p.agents.filter(a => a.valid).map(a => h('option', { value: targetKey({ project: p.name, agent: a.name }) }, `${p.name} · ${a.name}`))));
  }
  select.value = targetKey(imageTarget);

  const key = targetKey(imageTarget);
  const pathEl = h('div', { class: 'target-path mono' }, currentDir.key === key ? currentDir.dir : ' ');
  const input = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, hidden: true,
    on: { change: e => { uploadFiles([...e.target.files], false); e.target.value = ''; } },
  });
  const drop = h('div', {
    class: 'drop', id: 'dropZone', tabindex: '0', role: 'button', 'aria-label': 'Choose images to upload',
    on: {
      click: () => input.click(),
      keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    },
  }, icon(ICON_UPLOAD), h('b', {}, 'Drop images here, or paste with Ctrl+V'),
  h('span', {}, `Saved to ${targetLabel(imageTarget)} in today's folder · PNG, JPEG, GIF, WebP or BMP up to 25 MB`));
  // Same target as last time (a refresh): keep the old gallery until the new one is loaded.
  const gallery = h('div', {}, galleryCache.key === key ? galleryCache.nodes : h('div', { class: 'empty' }, 'Loading…'));

  $('#view-images').replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Images'),
      h('p', {}, 'Agent images stay with that agent: only its own sessions can read them. Hub images wait in the inbox for triage.'))),
    h('div', { class: 'target-bar' },
      h('label', {}, 'Save to ', select),
      h('button', { class: 'btn small', on: { click: () => openPlace({ place: 'images', ...targetParams(imageTarget) }) } }, 'Open folder'),
      h('button', {
        class: 'btn small',
        on: { click: () => (currentDir.key === targetKey(imageTarget) ? copy(currentDir.dir) : toast('The folder is still loading.', true)) },
      }, 'Copy folder path')),
    pathEl, drop, input,
    h('ul', { class: 'uploads', id: 'uploads' }, recentUploads.map(u => h('li', { class: u.cls }, u.text))),
    gallery,
  );
  loadGallery(gallery, pathEl);
}

async function uploadFiles(files, pasted, target = imageTarget) {
  const images = files.filter(f => /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type) || !f.type);
  if (!images.length) { toast('Only PNG, JPEG, GIF, WebP and BMP images can be uploaded.', true); return; }
  let saved = 0;
  for (const f of images) {
    const label = pasted ? 'pasted image' : f.name;
    const entry = { cls: '', text: `Uploading ${label}…` };
    recentUploads.unshift(entry);
    recentUploads.length = Math.min(recentUploads.length, 8);
    drawUploads();
    if (f.size > MAX_UPLOAD) {
      Object.assign(entry, { cls: 'err', text: `${label}: larger than 25 MB` });
      drawUploads();
      continue;
    }
    try {
      const r = await api(`/api/upload?${qs({ ...targetParams(target), name: pasted ? '' : f.name })}`, { method: 'POST', raw: f, contentType: f.type });
      Object.assign(entry, { cls: 'ok', text: `Saved ${r.path}` });
      saved++;
    } catch (e) {
      const why = e.network ? 'could not be read or sent' : e.message;
      Object.assign(entry, { cls: 'err', text: `${label}: ${why}` });
    }
    drawUploads();
  }
  if (saved) toast(`${plural(saved, 'image')} saved to ${targetLabel(target)}`);
  await refresh();
}

// ---------------------------------------------------------------- events

for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => show(b.dataset.view));
$('#startHub').addEventListener('click', () => launch({ kind: 'hub' }));
$('#continueHub').addEventListener('click', () => launch({ kind: 'hub', continueLast: true }));
$('#openNavigator').addEventListener('click', () => openPlace({ place: 'navigator' }));
$('#refresh').addEventListener('click', refresh);
window.addEventListener('focus', () => {
  ping();
  if (Date.now() - lastRefresh > 5000) refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));

document.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (dialog.open) {
    if (!dialogUpload) return;
    // Copies from Office apps carry text and a picture: in a text box, paste the text.
    const inTextBox = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (inTextBox && [...e.clipboardData.types].includes('text/plain')) return;
    e.preventDefault();
    dialogUpload(files, true);
    return;
  }
  if (view !== 'images') return;
  e.preventDefault();
  uploadFiles(files, true);
});
// File drags only: text drags (for example inside the New agent form) behave as usual.
// A dropped file would otherwise make the window navigate to it.
const hasFiles = e => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = dialog.open ? (dialogUpload ? $('#dialogDrop') : null) : view === 'images' ? $('#dropZone') : null;
  if (zone) zone.classList.add('over');
});
const clearDropZones = () => { for (const z of document.querySelectorAll('.drop.over')) z.classList.remove('over'); };
document.addEventListener('dragleave', e => { if (e.relatedTarget === null) clearDropZones(); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  clearDropZones();
  if (dialog.open && !dialogUpload) { toast('Close the dialog first, then drop the files.', true); return; }
  if (!dialog.open && view !== 'images') { toast('Open Images (or a flow) first, then drop the files there.', true); return; }
  const files = [];
  let folders = 0;
  for (const item of [...e.dataTransfer.items]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) { folders++; continue; }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  if (folders) toast(`${plural(folders, 'folder')} skipped: drop the images themselves.`, true);
  if (!files.length) return;
  if (dialog.open) dialogUpload(files, false);
  else uploadFiles(files, false);
});

// Heartbeat: the server stops itself a few minutes after the last window closes.
function ping() {
  if (stopped) return;
  api('/api/ping', { method: 'POST' }).catch(e => { if (e.network) checkServer(); });
}
setInterval(ping, 15000);
ping();

show(location.hash.slice(1) || 'home');
refresh();
