// Dashboard: counts, the inbox, active reports and the projects, each with a shortcut.
import { fmtDay, fmtSize, fmtTime, h, launch, openPlace, plural, qs } from '../lib.js';
import { go } from '../store.js';

function stat(value, label, onClick) {
  return h('button', { class: 'stat', on: { click: onClick } }, h('b', {}, value), h('span', {}, label));
}

function thumbFor(item) {
  if (item.isImage) return h('span', { class: 'thumb' }, h('img', { src: `/img?${qs({ path: item.path })}`, alt: '', loading: 'lazy' }));
  const ext = (item.name.split('.').pop() || 'file').slice(0, 4);
  return h('span', { class: 'thumb' }, ext);
}

function render(el, { state: s }) {
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
      h('button', { class: 'btn small', on: { click: () => go('projects') } }, 'All projects')),
    h('div', { class: 'card-body' }, s.projects.length
      ? h('ul', { class: 'list' }, s.projects.map(p => h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title' }, p.name),
          h('div', { class: 'sub' }, `${p.label} · ${plural(p.agents.length, 'agent')}`)),
        h('button', { class: 'btn small', disabled: !p.launchable || !s.tools.claude, on: { click: () => launch({ kind: 'project', project: p.name }) } }, 'Start Claude'))))
      : h('div', { class: 'empty' }, h('b', {}, 'No projects yet'), 'Start Claude in the hub and run ', h('code', {}, '/new-project'), '.')));

  el.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Dashboard'), h('p', {}, fmtDay(s.today)))),
    h('div', { class: 'stats' },
      stat(`${s.inbox.total}${s.inbox.truncated ? '+' : ''}`, 'inbox items waiting', () => inboxCard.scrollIntoView({ behavior: 'smooth' })),
      stat(libFiles, 'agent images', () => go('images')),
      stat(s.flows.length, 'flows', () => go('flows')),
      stat(s.reports.length, 'active reports', () => reportsCard.scrollIntoView({ behavior: 'smooth' })),
      stat(s.projects.length, 'projects', () => go('projects'))),
    h('div', { class: 'grid2' }, inboxCard, h('div', { class: 'stack' }, reportsCard, projectsCard)),
  );
}

export default {
  id: 'home',
  label: 'Dashboard',
  icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  render,
};
