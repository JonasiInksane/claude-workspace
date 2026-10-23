// The asset library over HTTP. asset-library.mjs checks every value and does the writes; these
// handlers only read the request. The version files themselves are served by app.mjs at
// /library-file?ref=<ref>&v=<n> (sandboxed).
//
//   GET  /api/library?project=<name>&archived=1  shared assets plus that project's (every
//                                                project's without one); archived ones with archived=1
//   GET  /api/library/asset?ref=<ref>            one asset with every version
//   POST /api/library/upload?...                 the raw file as the body, read the way
//                                                POST /api/upload reads an image:
//                                                without ref, a new asset (scope, project, title, kind,
//                                                description, tags, note, name);
//                                                with ref and expect, a new version (name, note, kind)
//   POST /api/library/meta                       { ref, title, description, tags, expect }
//   POST /api/library/archive                    { ref, archived }
//   POST /api/library/resolve                    { project, attachments: [{ ref, pin }] }: the
//                                                versions and files they point to (changes nothing)
import { addVersion, createAsset, getAsset, listLibrary, resolveAttachments, setArchived, updateMeta } from '../asset-library.mjs';
import { HttpError, readBody, readJson } from '../http.mjs';
import { MAX_UPLOAD_BYTES } from '../uploads.mjs';

// Query values only a new asset takes: a new version keeps the asset's title, description and
// tags (POST /api/library/meta changes them).
const CREATE_ONLY = ['title', 'description', 'tags'];

async function readObject(req) {
  const b = await readJson(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'the body must be a JSON object');
  return b;
}

export function routes({ root }) {
  return {
    'GET /api/library': async (req, res, url) => {
      const q = url.searchParams;
      return { ok: true, assets: await listLibrary(root, { project: q.get('project') || '', includeArchived: q.get('archived') === '1' }) };
    },

    'GET /api/library/asset': async (req, res, url) => ({ ok: true, asset: await getAsset(root, url.searchParams.get('ref')) }),

    'POST /api/library/upload': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      if (q.ref) {
        const extra = CREATE_ONLY.filter(k => q[k] !== undefined && q[k] !== '');
        if (extra.length) throw new HttpError(400, `a new version keeps the asset's ${extra.join(' and ')}; change them with POST /api/library/meta`);
      }
      // One byte over the limit is read, so the library can say which limit the file is over.
      const buf = await readBody(req, MAX_UPLOAD_BYTES + 1);
      const r = q.ref
        ? await addVersion(root, q.ref, buf, { originalName: q.name, note: q.note, expectVersions: q.expect, kind: q.kind })
        : await createAsset(root, {
          scope: q.scope, project: q.project, title: q.title, kind: q.kind, description: q.description, tags: q.tags,
          note: q.note, originalName: q.name,
        }, buf);
      return { ok: true, ...r };
    },

    'POST /api/library/meta': async req => {
      const b = await readObject(req);
      return { ok: true, asset: await updateMeta(root, b.ref, { title: b.title, description: b.description, tags: b.tags, expect: b.expect }) };
    },

    'POST /api/library/archive': async req => {
      const b = await readObject(req);
      return { ok: true, asset: await setArchived(root, b.ref, b.archived) };
    },

    'POST /api/library/resolve': async req => {
      const b = await readObject(req);
      return { ok: true, items: await resolveAttachments(root, b.project || '', b.attachments) };
    },
  };
}
