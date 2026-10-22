// This PC's app settings (SPEC 2.13 and 4): GET /api/settings answers with the settings, defaults
// filled in; POST /api/settings takes a patch from the page (the request body itself, for example
// { "fun": { "streak": true } }), checks every value and saves it (core/settings.mjs). A bad patch
// is a 400 and nothing is written. The file lives in the private data folder, never in the hub;
// the theme is not here (it stays in the page's localStorage).
import { loadSettings, saveSettings } from '../core/settings.mjs';
import { HttpError, readJson } from '../http.mjs';

export function routes({ dataDir }) {
  return {
    'GET /api/settings': async () => ({ ok: true, settings: loadSettings(dataDir) }),

    // Sections merge key by key; null removes an isolation or models entry. Answers with the full
    // settings now on disk.
    'POST /api/settings': async req => {
      const patch = await readJson(req);
      let settings;
      try { settings = saveSettings(dataDir, patch); } catch (e) {
        if (e && e.status) throw new HttpError(e.status, e.message);
        throw e;
      }
      return { ok: true, settings };
    },
  };
}
