// GET /api/state: everything the page shows, in one call (state.mjs builds it).
import { buildState } from '../state.mjs';

export function routes({ root, actions }) {
  return {
    'GET /api/state': async () => ({ ok: true, ...(await buildState(root, actions.tools || {})) }),
  };
}
