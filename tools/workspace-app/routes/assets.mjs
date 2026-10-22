// The Assets view's API: one asset's detail, and the user's verdict on it. The files themselves
// (renders, models) are served by app.mjs at /asset-file, sandboxed.
import { assetDetail, setVerdict } from '../assets.mjs';
import { HttpError, readJson } from '../http.mjs';
import { assetProjectOrThrow } from '../lookup.mjs';

export function routes({ root }) {
  return {
    'GET /api/asset': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      const project = assetProjectOrThrow(root, q.project);
      const d = assetDetail(root, project, q.id);
      if (d.error) throw new HttpError(404, d.error);
      return { ok: true, project, ...d };
    },

    'POST /api/asset-verdict': async req => {
      const b = await readJson(req);
      const project = assetProjectOrThrow(root, b.project);
      const r = setVerdict(root, project, String(b.id || ''), String(b.verdict || ''), String(b.notes || ''));
      if (r.error) throw new HttpError(400, r.error);
      return { ok: true, status: r.status, message: `${b.id}: ${b.verdict} saved (status ${r.status}, logged in brief.md)` };
    },
  };
}
