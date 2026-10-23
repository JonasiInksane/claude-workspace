// The project page's Assets tab (#project/<name>/assets, every type). For a project with an asset
// pipeline: its game assets as the Assets view shows them (views/assets.js projectAssetsCard:
// thumbnails that open the 3D or sprite dialog with checks and your verdict). For every project,
// below that, a short note: assets of its own (images, Markdown, PDFs, versioned and attached to
// runs) arrive with the asset library. Kept small on purpose; the asset library replaces it.
//
// Data: the state only (state.assets).
import { h } from '../../lib.js';
import { go, state } from '../../store.js';
import { createMemo, patch } from '../../parts/patch.js';
import { btn } from '../../parts/project-ui.js';
import { projectAssetsCard } from '../assets.js';

const memo = createMemo();

// The state.assets entry of a project with an asset pipeline, or null.
export const pipelineAssets = (name, assets = state && state.assets) =>
  (Array.isArray(assets) ? assets.find(a => a && a.project === name) : null) || null;

function libraryNote() {
  return memo('library', [], () => h('div', { class: 'card' }, h('div', { class: 'empty' },
    h('b', {}, 'Project assets arrive with the asset library'),
    'Reference images, Markdown and PDFs for this project, each upload a new version you can attach to runs. Until then, images go to Inbox images.',
    h('div', { class: 'mt-4' }, btn('as:images', 'Inbox images', () => go('images'))))));
}

export default {
  id: 'assets',
  label: 'Assets',
  render(el, ctx) {
    const entry = pipelineAssets(ctx.project.name);
    patch(el, [
      entry ? memo(`pipeline:${ctx.project.name}`, [entry], () => projectAssetsCard(entry)) : null,
      libraryNote(),
    ]);
  },
};
