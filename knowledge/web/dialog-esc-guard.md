---
title: Unsaved-changes guard on a dialog in Edge
tags: [web, html, dialog, edge, chromium, keyboard, testing]
updated: 2026-10-21
---

# Unsaved-changes guard on a dialog in Edge

TL;DR: Don't rely on `preventDefault()` in a `<dialog>`'s `cancel` event to keep it open on
Esc: Chromium can fire it as not cancelable. Handle Escape on `keydown` (call
`preventDefault()`, then your own "discard changes?" check); keep the `cancel` handler as a
fallback.

## Details
- Esc on a modal `<dialog>` is a "close request". Under the HTML close-watcher rules, the
  `cancel` event is only cancelable when there was user activation since the last close request,
  so a second Esc without a click in between can close the dialog even though the handler called
  `preventDefault()`. Edits in it are then lost.
- `preventDefault()` on the Escape `keydown` stops the close request from happening at all, so
  the page decides.
- Send every way out through one function: the ✕ button, Cancel, a backdrop click and Esc.
- Reset the guard on the dialog's `close` event, so the next dialog starts clean.
- Synthetic `new KeyboardEvent('keydown', ...)` does not trigger the browser's own Esc handling,
  so it can't test this. Use trusted input: DevTools protocol `Input.dispatchKeyEvent`.

## Example

```js
let closeGuard = null; // returns false to stay open
function closeDialog() { if (closeGuard && !closeGuard()) return; dialog.close(); }
dialog.addEventListener('keydown', e => {
  if (e.key === 'Escape' && closeGuard) { e.preventDefault(); closeDialog(); }
});
dialog.addEventListener('cancel', e => { if (closeGuard && !closeGuard()) e.preventDefault(); });
dialog.addEventListener('close', () => { closeGuard = null; });
// In an editor: closeGuard = () => !dirty() || confirm('Discard your changes?');
```

Working code: `tools/workspace-app/ui/app.js` (`closeDialog`, the agent and flow editors).

## Source
- Workspace app, 2026-10-21, Edge 155.0.4283.62 (headless). Verified: with the keydown handler,
  three real Esc presses answered "keep editing" left the dialog open, and one answered
  "discard" closed it (`Input.dispatchKeyEvent` from Node 23, which has a built-in `WebSocket`).
- The uncancelable `cancel` itself was reported in a code review from the spec and not
  reproduced here (unverified).
