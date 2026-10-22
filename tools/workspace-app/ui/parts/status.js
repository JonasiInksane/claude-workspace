// Run status as a dot and a text badge (SPEC 5.1 table, lib.js statusBadge). The dot is only
// decoration (aria-hidden); the badge always says the status in words, so status is never
// shown by colour alone (SPEC 5.11). Views put the two side by side with statusPair().
import { h, statusBadge } from '../lib.js';

// Badge class -> dot class (the dot has no "ok"; green means done well).
const DOT = { ok: 'green', blue: 'blue', amber: 'amber', red: 'red', violet: 'violet' };

// A coloured dot for a run status. Decoration only: pair it with badge().
export function dot(status) {
  const cls = DOT[statusBadge(status).cls] || '';
  return h('span', { class: cls ? `dot ${cls}` : 'dot', 'aria-hidden': 'true' });
}

// The status badge: its label from the table, or `text` when given (for example "Review gate").
export function badge(status, text = '') {
  const b = statusBadge(status);
  return h('span', { class: b.cls ? `badge ${b.cls}` : 'badge' }, text || b.label);
}

// [dot, badge] for a row.
export const statusPair = (status, text = '') => [dot(status), badge(status, text)];
