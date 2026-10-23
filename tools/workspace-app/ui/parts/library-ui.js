// Pieces the asset library's screens share (views/assets.js, views/project/assets.js, the Settings
// tab's attached assets and parts/library-dialogs.js): an asset's preview (an image's thumbnail
// from /library-file, the first lines of a text asset, a PDF's icon), its card, the icon of its
// kind, and a drop zone that takes dropped and chosen files.
//
// A text asset is untrusted: its preview is fetched as text (parts/library.js textPreview) and set
// as textContent, never parsed. Everything else renders through lib.js h() as text as well.
//
// The drop zone handles its own drop (and stops it there), so main.js's page-wide drop handler
// never sees a file dropped on it; files dropped elsewhere still go where main.js sends them.
import { fmtSize, h, icon, keyed, plural, toast } from '../lib.js';
import { fileUrl, kindWord, PREVIEW_LINES, textPreview } from './library.js';

export const KIND_ICONS = Object.freeze({
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 15.5h1.5a1.5 1.5 0 0 0 0-3H8.5v5"/>',
  broken: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
});
const UPLOAD_ICON = '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>';

export const kindIcon = kind => icon(KIND_ICONS[kind] || KIND_ICONS.broken);

// How much of a text the detail dialog's preview shows.
export const LARGE_TEXT = Object.freeze({ lines: 40, chars: 8000 });

// The first lines of a text version into `el` (a .lib-text element), when they arrive.
export function fillTextPreview(el, ref, n, { lines = PREVIEW_LINES, chars } = {}) {
  el.textContent = 'Loading…';
  textPreview(ref, n, { lines, chars }).then(p => {
    el.textContent = p.lines.length ? `${p.lines.join('\n')}${p.more ? '\n…' : ''}` : '(empty)';
    el.classList.toggle('empty-text', !p.lines.length);
  }, e => { el.textContent = e.message; });
  return el;
}

// An asset's preview: { ref, kind, latest: { n } } from a listing (or a full asset); `large` is the
// detail dialog's size, with more of a text. Decorative for screen readers: the card or the dialog
// names the asset in words.
export function assetPreview(a, { large = false } = {}) {
  const cls = `lib-thumb${large ? ' large' : ''}`;
  const lines = large ? LARGE_TEXT : { lines: PREVIEW_LINES };
  const n = a && a.latest ? a.latest.n : null;
  if (!a || a.error || !n) {
    return h('span', { class: `${cls} broken`, 'aria-hidden': 'true' }, kindIcon('broken'), h('span', {}, a && a.error ? 'Can\'t be read' : 'No version'));
  }
  if (a.kind === 'image') {
    return h('span', { class: `${cls} image`, 'aria-hidden': 'true' }, h('img', { src: fileUrl(a.ref, n), alt: '', loading: 'lazy', decoding: 'async' }));
  }
  if (a.kind === 'text') {
    return h('span', { class: `${cls} text`, 'aria-hidden': 'true' }, fillTextPreview(h('span', { class: 'lib-text' }), a.ref, n, lines));
  }
  if (a.kind === 'pdf' && large) {
    return h('span', { class: `${cls} pdf`, 'aria-hidden': 'true' }, kindIcon('pdf'), h('span', {}, 'PDF: download it to read it'));
  }
  return h('span', { class: `${cls} pdf`, 'aria-hidden': 'true' }, kindIcon('pdf'), h('span', {}, 'PDF'));
}

// "3 versions · 12 KB" for a listing entry.
export function assetMeta(a) {
  if (!a || a.error) return a && a.error ? String(a.error) : '';
  return [plural(a.versionCount || 0, 'version'), a.latest ? fmtSize(a.latest.bytes || 0) : ''].filter(Boolean).join(' · ');
}

// Where an asset lives, as a badge text: Shared, or its project.
export const placeWord = a => (a && a.scope === 'shared' ? 'Shared' : (a && a.project) || '');

// One asset as a card: the open button (preview, title, ref, size; its label says the same in
// words), then the badges and any action buttons. `badges` are { text, cls, title }.
export function assetCard(a, { onOpen, badges = [], actions = [], keyPrefix = 'lib' } = {}) {
  const words = [a.title, kindWord(a.kind), assetMeta(a), a.archived ? 'archived' : ''].filter(Boolean).join(', ');
  const open = keyed(h('button', {
    class: 'lib-open', type: 'button', 'aria-label': `${words}. Open its details`, on: { click: () => onOpen && onOpen(a) },
  },
  assetPreview(a),
  h('span', { class: 'lib-info' },
    h('b', { class: 'lib-title' }, a.title || a.id),
    h('span', { class: 'lib-ref mono' }, a.ref),
    h('span', { class: 'lib-meta' }, assetMeta(a)))), `${keyPrefix}:open:${a.ref}`);
  const tags = (a.tags || []).length ? h('span', { class: 'lib-tags' }, a.tags.map(t => h('span', { class: 'lib-tag' }, t))) : null;
  const allBadges = [
    a.kind ? { text: kindWord(a.kind), cls: '' } : null,
    { text: placeWord(a), cls: a.scope === 'shared' ? 'blue' : 'violet' },
    a.archived ? { text: 'Archived', cls: 'amber' } : null,
    ...badges,
  ].filter(b => b && b.text);
  return h('div', { class: `lib-card${a.archived ? ' archived' : ''}${a.error ? ' broken' : ''}` },
    open,
    h('div', { class: 'lib-card-foot' },
      h('span', { class: 'row-actions lib-badges' }, allBadges.map(b => h('span', { class: `badge${b.cls ? ` ${b.cls}` : ''}`, title: b.title || null }, b.text))),
      tags,
      actions.length ? h('span', { class: 'row-actions lib-actions' }, actions) : null));
}

// ---------------------------------------------------------------- the drop zone

const hasFiles = e => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

// The files of a drop, without folders (a toast says how many were skipped).
export function droppedFiles(dataTransfer) {
  const files = [];
  let folders = 0;
  for (const item of [...((dataTransfer && dataTransfer.items) || [])]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) { folders++; continue; }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  if (!files.length && !folders && dataTransfer && dataTransfer.files) files.push(...dataTransfer.files);
  if (folders) toast(`${plural(folders, 'folder')} skipped: drop the files themselves.`, true);
  return files;
}

// Makes `el` take dropped files (a drop zone, or a card around one): a file drag over it marks
// `zone` (default: el), a drop hands the files to onFiles(files, false) and stops there, so
// main.js's page-wide handler doesn't see it. `single` keeps only the first file.
export function dropTarget(el, { zone = el, onFiles, single = false }) {
  el.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (zone) zone.classList.add('over');
  });
  el.addEventListener('dragleave', e => {
    if (zone && (!e.relatedTarget || !el.contains(e.relatedTarget))) zone.classList.remove('over');
  });
  el.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (zone) zone.classList.remove('over');
    const files = droppedFiles(e.dataTransfer);
    if (files.length) onFiles(single ? files.slice(0, 1) : files, false);
  });
  return el;
}

// A drop zone with its hidden file input: click, Enter or Space chooses files; dropping files on
// it hands them over too. onFiles(files, pasted = false).
export function dropZone({ key, label, hint = '', accept = '', multiple = true, onFiles, compact = true }) {
  const input = h('input', {
    type: 'file', accept: accept || null, multiple, hidden: true, tabindex: '-1',
    on: { change: e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) onFiles(files, false); } },
  });
  const zone = keyed(h('div', {
    class: `drop${compact ? ' compact' : ''} lib-drop`, tabindex: '0', role: 'button', 'aria-label': hint ? `${label}. ${hint}` : label,
    on: {
      click: () => input.click(),
      keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    },
  }, icon(UPLOAD_ICON), h('b', {}, label), hint ? h('span', {}, hint) : null), key);
  dropTarget(zone, { onFiles, single: !multiple });
  return h('div', { class: 'lib-drop-wrap' }, zone, input);
}
