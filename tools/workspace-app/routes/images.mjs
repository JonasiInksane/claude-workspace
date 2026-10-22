// Images: list the images of a target (hub, an agent's or a project's shared folder, a flow)
// and upload one into it. uploads.mjs checks the type by content and never overwrites.
import { sep } from 'node:path';
import { listImages, MAX_UPLOAD_BYTES, saveImage } from '../uploads.mjs';
import { readBody } from '../http.mjs';
import { targetOrThrow } from '../lookup.mjs';

export function routes({ root }) {
  return {
    'GET /api/images': async (req, res, url) => {
      const t = targetOrThrow(root, Object.fromEntries(url.searchParams));
      return { ok: true, label: t.label, dir: t.dir, images: listImages(root, t.dir, 500, { flat: !!t.flat }) };
    },

    // The body is the raw image; ?name= is the original file name (optional).
    'POST /api/upload': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      const t = targetOrThrow(root, q);
      const buf = await readBody(req, MAX_UPLOAD_BYTES + 1);
      const file = saveImage(t.dir, buf, { name: q.name || '', ...(t.flat ? { date: '' } : {}) });
      return { ok: true, label: t.label, abs: file, path: file.slice(root.length + 1).split(sep).join('/') };
    },
  };
}
