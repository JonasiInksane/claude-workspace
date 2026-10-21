// The Assets view's data: game assets made by a project's asset pipeline (projects/<p>/tools/
// asset.mjs, assets/<style>/<category>/<Name>/asset.json), their check results and review
// renders, the files the page may load (renders, concept images, models), and the user's
// verdict. The pipeline's own scripts write everything except the verdict, which goes into the
// asset's asset.json status and brief.md log, as the project's CLAUDE.md asks.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { isInside } from './uploads.mjs';

const FILE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json; charset=utf-8', glb: 'model/gltf-binary' };
const PART = /^[A-Za-z0-9][\w-]*$/; // a style, category or asset folder name
const VIEWS = ['front', 'three-quarter', 'side', 'back', 'material', 'silhouette', 'scale'];
export const VERDICTS = { approve: 'approved', revise: 'revise', reject: 'rejected' };
const MAX_NOTES = 2000;

const dirs = p => { try { return readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map(e => e.name); } catch { return []; } };
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const posix = p => p.split(sep).join('/');

// Projects whose folder has the asset pipeline.
export function assetProjects(root) {
  return dirs(join(root, 'projects')).filter(p => isFile(join(root, 'projects', p, 'tools', 'asset.mjs')) && existsSync(join(root, 'projects', p, 'assets')));
}

function checkSummary(dir, stage) {
  const c = readJson(join(dir, 'review', `check-${stage}.json`));
  if (!c || !c.summary) return null;
  return { ...c.summary, checkedAt: c.checkedAt || '', triangles: c.triangles ?? null, dimensionsM: c.dimensionsM || null };
}

// Every asset of one project, with what its card shows.
export function listAssets(root, project) {
  const base = join(root, 'projects', project, 'assets');
  const out = [];
  for (const style of dirs(base)) {
    for (const category of dirs(join(base, style))) {
      for (const name of dirs(join(base, style, category))) {
        const dir = join(base, style, category, name);
        const asset = readJson(join(dir, 'asset.json'));
        if (!asset) continue;
        const id = `${style}/${category}/${name}`;
        const thumb = ['review/final_front.png', 'review/raw_front.png', 'concept/front.png'].find(f => isFile(join(dir, f)));
        out.push({
          id, name: asset.name || name, style: asset.style || style, category, cls: asset.class || '', source: asset.source || 'procedural',
          status: asset.status || '', final: checkSummary(dir, 'final'), raw: checkSummary(dir, 'raw'),
          thumb: thumb ? `${id}/${thumb}` : '',
        });
      }
    }
  }
  return out;
}

// The asset's folder from an id like lunafen/props/CrystalPendant, or an error.
export function assetDir(root, project, id) {
  const parts = String(id || '').split('/');
  if (parts.length !== 3 || !parts.every(p => PART.test(p))) return { error: `"${id}" is not an asset id (style/category/Name)` };
  const dir = join(root, 'projects', project, 'assets', ...parts);
  if (!isFile(join(dir, 'asset.json'))) return { error: `assets/${id} has no asset.json` };
  return { dir };
}

const images = (dir, sub, filter = () => true) => {
  try {
    return readdirSync(join(dir, sub)).filter(n => /\.(png|jpe?g)$/i.test(n) && filter(n)).sort();
  } catch { return []; }
};

// The brief's log: its last entries (each "- " line with the lines indented under it).
function briefLog(dir, count = 8) {
  let text;
  try { text = readFileSync(join(dir, 'brief.md'), 'utf8'); } catch { return []; }
  const at = text.search(/^## Log\s*$/m);
  if (at < 0) return [];
  const entries = [];
  for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
    if (/^## /.test(line)) break;
    if (line.startsWith('- ')) entries.push(line.slice(2));
    else if (/^\s+\S/.test(line) && entries.length) entries[entries.length - 1] += ` ${line.trim()}`;
  }
  return entries.slice(-count).reverse();
}

// Everything the detail view shows for one asset.
export function assetDetail(root, project, id) {
  const { dir, error } = assetDir(root, project, id);
  if (error) return { error };
  const asset = readJson(join(dir, 'asset.json')) || {};
  const order = n => { const i = VIEWS.findIndex(v => n.includes(`_${v}.`)); return i < 0 ? VIEWS.length : i; };
  const renders = stage => images(dir, 'review', n => n.startsWith(`${stage}_`)).sort((a, b) => order(a) - order(b)).map(n => `${id}/review/${n}`);
  const check = stage => {
    const c = readJson(join(dir, 'review', `check-${stage}.json`));
    if (!c) return null;
    const rank = { fail: 0, warn: 1, pass: 2 };
    return {
      summary: c.summary, checkedAt: c.checkedAt || '', triangles: c.triangles ?? null, dimensionsM: c.dimensionsM || null,
      checks: (c.checks || []).map(k => ({ id: k.id, status: k.status, message: k.message })).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)),
    };
  };
  const finalModel = `export/SM_${asset.name || id.split('/')[2]}.glb`;
  const record = readJson(join(dir, 'gen', 'record.json'));
  return {
    id, dir: posix(relative(root, dir)), asset,
    models: { final: isFile(join(dir, finalModel)) ? `${id}/${finalModel}` : '', raw: isFile(join(dir, 'gen', 'raw.glb')) ? `${id}/gen/raw.glb` : '' },
    renders: { final: renders('final'), raw: renders('raw') },
    concept: images(dir, 'concept').map(n => `${id}/concept/${n}`),
    checks: { final: check('final'), raw: check('raw') },
    generation: record ? { task: record.task, model: record.model, credits: record.credits, finishedAt: record.finishedAt || '' } : null,
    log: briefLog(dir),
  };
}

// A file the page may load: a render, concept image, model or report inside the project's
// assets/ folder, by its path from there (style/category/Name/...). Returns { full, type } or null.
export function assetFile(root, project, path) {
  const rel = String(path || '');
  const type = FILE_TYPES[extname(rel).slice(1).toLowerCase()];
  if (!type || rel.includes('\0')) return null;
  const base = join(root, 'projects', project, 'assets');
  const full = resolve(base, rel);
  if (!isInside(base, full) || !isFile(full)) return null;
  return { full, type };
}

// The user's verdict: asset.json status, and a dated line at the end of the brief's log.
export function setVerdict(root, project, id, verdict, notes = '') {
  const { dir, error } = assetDir(root, project, id);
  if (error) return { error };
  if (!VERDICTS[verdict]) return { error: `verdict must be one of: ${Object.keys(VERDICTS).join(', ')}` };
  const text = String(notes || '').trim();
  if (text.length > MAX_NOTES) return { error: `notes are longer than ${MAX_NOTES} characters` };
  const file = join(dir, 'asset.json');
  const asset = readJson(file);
  if (!asset) return { error: `assets/${id}/asset.json can't be read` };
  const brief = join(dir, 'brief.md');
  if (!isFile(brief)) return { error: `assets/${id} has no brief.md to log the verdict in` };
  asset.status = VERDICTS[verdict];
  writeFileSync(file, JSON.stringify(asset, null, 2) + '\n', 'utf8');
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lines = text ? text.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
  const entry = [`- ${day} user verdict (workspace app): ${verdict}${lines.length ? '. Notes:' : ''}`, ...lines.map(l => `  ${l}`)].join('\n');
  const current = readFileSync(brief, 'utf8');
  const log = current.search(/^## Log\s*$/m);
  const next = log < 0 ? -1 : current.slice(log + 1).search(/^## /m);
  if (log >= 0 && next >= 0) {
    // Another section follows the log: the entry goes just before it.
    const at = log + 1 + next;
    const before = current.slice(0, at).replace(/\s*$/, '\n');
    writeFileSync(brief, `${before}${entry}\n\n${current.slice(at)}`, 'utf8');
  } else {
    appendFileSync(brief, `${current.endsWith('\n') ? '' : '\n'}${log < 0 ? '\n## Log\n' : ''}${entry}\n`, 'utf8');
  }
  return { status: asset.status };
}
