// The page's one general modal dialog (<dialog id="dialog"> in index.html) and the form helper
// built on it. A view opens it with openDialog(); only one dialog shows at a time, and opening
// another replaces the content. The palette and the commit dialog are their own <dialog>
// elements (#palette, #commitDialog), and lib.js confirmDialog() makes a short-lived one.
//
// Accessibility: index.html gives the dialog aria-modal and aria-labelledby="dialogTitle";
// openDialog() puts that id on the title, so screen readers name the dialog by it.
//
// Unsaved changes: pass `guard`, a function that returns false to keep the dialog open (it
// usually asks confirm()). Esc, the close button, Cancel and a click on the backdrop all ask
// it; call clearGuard() before closing after a successful save. Esc is handled on keydown,
// because Edge may make the `cancel` event uncancelable (knowledge/web/dialog-esc-guard.md).
import { $, h, toast } from './lib.js';

export const dialog = $('#dialog');
let closeGuard = null;
// A dialog that takes dropped or pasted images (the flow editor) sets this.
let dialogUpload = null;

// The upload function of the open dialog, or null (main.js routes pasted and dropped files).
export const getDialogUpload = () => dialogUpload;
export function clearGuard() { closeGuard = null; }

// Closes unless the guard says to stay open.
export function closeDialog() {
  if (closeGuard && !closeGuard()) return;
  dialog.close();
}

dialog.addEventListener('close', () => { closeGuard = null; dialogUpload = null; });
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

// title: text; body: a node; actions: buttons for the footer; wide: the large size;
// guard: see above; upload: (files, pasted) => ... for images dropped or pasted on the dialog.
export function openDialog(title, body, { wide = false, actions = [], guard = null, upload = null } = {}) {
  closeGuard = guard;
  dialogUpload = upload;
  dialog.className = wide ? 'wide' : '';
  dialog.setAttribute('aria-labelledby', 'dialogTitle');
  dialog.setAttribute('aria-modal', 'true');
  dialog.replaceChildren(...[
    h('div', { class: 'card-head' }, h('h3', { id: 'dialogTitle' }, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', on: { click: closeDialog } }, '✕')),
    h('div', { class: 'card-body' }, body),
    actions.length ? h('div', { class: 'card-foot dialog-actions' }, actions) : null,
  ].filter(Boolean));
  if (!dialog.open) dialog.showModal();
}

// A form in the dialog. `controls` are [label, hint, element], or a ready-made element (for
// example a group of checkboxes); `submit` returns a promise. An error shows inside the form;
// success closes the dialog and shows the server's message.
export function formDialog(title, intro, controls, submitLabel, submit) {
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
  controls.map(c => (c instanceof Node ? c : h('label', {}, c[0], c[1] ? h('small', {}, c[1]) : null, c[2]))),
  error,
  h('div', { class: 'dialog-actions' },
    h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), button));
  openDialog(title, form);
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
}
