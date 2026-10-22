// A progress bar (mockup .bar): a track with a filled span. The CSP blocks style attributes,
// so the fill width is set through the CSSOM (el.style.width), never through h() or markup.
// The bar is an image to screen readers, named by `label` ("Phase 0: 9 of 13 closed"), and the
// view shows the same numbers as text next to it.
import { h } from '../lib.js';

const clamp = pct => Math.max(0, Math.min(100, Number.isFinite(Number(pct)) ? Number(pct) : 0));

// bar(69, 'green', 'Phase 0: 9 of 13 closed'). cls: '' (accent), 'green', 'blue' or 'red'.
export function bar(pct, cls = '', label = '') {
  const el = h('div', { class: cls ? `bar ${cls}` : 'bar', role: 'img' }, h('span'));
  setBar(el, pct, label);
  return el;
}

// Updates a bar made by bar() without rebuilding it (the width animates unless reduced motion).
export function setBar(el, pct, label = '') {
  const value = clamp(pct);
  el.firstChild.style.width = `${value}%`;
  el.setAttribute('aria-label', label || `${Math.round(value)}%`);
}
