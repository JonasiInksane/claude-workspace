// Scans the workspace and writes index.html: a dashboard plus a navigator that mirrors the folders.
// Usage: node tools/build-index.mjs [--quiet]
// Everything is embedded in the page (no fetch), so index.html also works when double-clicked (file://).
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, relative, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = join(toolsDir, '..');
const quiet = process.argv.includes('--quiet');

const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);
// OS clutter (gitignored): never listed in the tree or counted as inbox items.
const CLUTTER = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const TEXT_EXT = new Set([
  '.md', '.markdown', '.json', '.jsonc', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.ps1', '.psm1',
  '.cmd', '.bat', '.sh', '.txt', '.yml', '.yaml', '.toml', '.css', '.csv', '.log', '.ini', '.cfg', '.xml',
  '.gd', '.cs', '.tscn', '.tres', '.py',
]);
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.gitkeep', '.worktreeinclude', '.editorconfig', '.env.example']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_BYTES = 200_000;
// Inside projects/<name>/ only these files (plus .claude/**) are listed; source code is not indexed.
const PROJECT_FILES = new Set(['README.md', 'CLAUDE.md']);
const GAME_LIBS = ['phaser', 'three', 'pixi.js', 'kaplay', 'excalibur'];

const toPosix = p => p.replaceAll('\\', '/');
const relPath = full => toPosix(relative(root, full));
const stripBom = s => s.replace(/^\uFEFF/, '');
const isImage = name => IMAGE_EXT.has(extname(name).toLowerCase());
// Never embed secrets: .env, .env.local, .env.production ... (.env.example is fine: names only), and
// .claude/settings.local.json, which often holds personal "env" values such as tokens.
const isSecret = name => (/^\.env(\..+)?$/i.test(name) && name.toLowerCase() !== '.env.example') ||
  name.toLowerCase() === 'settings.local.json';
const isText = name => TEXT_NAMES.has(name.toLowerCase()) || TEXT_EXT.has(extname(name).toLowerCase());

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function safeStat(full) {
  try { return statSync(full); } catch { return null; }
}
function readText(full) {
  try { return stripBom(readFileSync(full, 'utf8')); } catch { return null; }
}

// ---------- Frontmatter (small YAML subset: key: value, quoted values, [a, b], "- item" lists, | and > blocks)
function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
    return v.slice(1, -1);
  }
  return v.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
}
function parseFrontmatter(src) {
  const m = (src || '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: src || '' };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/);
    if (!km) continue;
    const key = km[1];
    let raw = (km[2] || '').trim();
    let val;
    if (/^[|>][+-]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      val = raw[0] === '|' ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
    } else if (raw === '' || raw.startsWith('#')) {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
      val = items.length ? items : '';
    } else if (/^\[.*\]$/.test(raw)) {
      val = raw.slice(1, -1).split(',').map(s => unquote(s)).filter(Boolean);
    } else {
      val = unquote(raw);
      // plain multi-line scalar: indented continuation lines
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) val += ' ' + lines[++i].trim();
    }
    meta[key] = val;
  }
  return { meta, body: src.slice(m[0].length) };
}
const truthy = v => /^(true|yes|on)$/i.test(String(v ?? '').trim());
const str = v => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const firstH1 = body => {
  const m = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].replace(/[*_`]/g, '').trim() : '';
};
function firstParagraph(body) {
  let afterH1 = body.replace(/^[\s\S]*?^#\s+.*$/m, '');
  if (afterH1 === body) afterH1 = body;
  let inFence = false;
  for (const line of afterH1.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || !t || t.startsWith('#') || t.startsWith('|') || t.startsWith('<') || t.startsWith('---')) continue;
    const clean = t.replace(/^>\s*/, '').replace(/^\*\*TL;DR:?\*\*:?\s*/i, '').replace(/^TL;DR:?\s*/i, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
    if (clean) return clean.length > 180 ? clean.slice(0, 177) + '...' : clean;
  }
  return '';
}

// ---------- Tree
let fileCount = 0;
function walk(dir) {
  const rel = relPath(dir);
  const isProjectRoot = /^projects\/[^/]+$/.test(rel);
  const isDotClaude = basename(dir) === '.claude';
  const entries = safeReaddir(dir)
    .filter(e => !SKIP.has(e.name) && !CLUTTER.has(e.name.toLowerCase()))
    .filter(e => !(dir === root && /^index\.html(\.\d+\.tmp)?$/.test(e.name))) // the generated page (and its temp file)
    .filter(e => !(isDotClaude && e.name === 'worktrees'))
    .map(e => {
      const full = join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        const st = safeStat(full);
        if (!st) return null;
        isDir = st.isDirectory();
        if (isDir && rel !== 'projects') return null; // follow linked project folders only (avoids cycles)
      }
      return { e, full, isDir };
    })
    .filter(Boolean)
    .sort((a, b) => (b.isDir - a.isDir) || a.e.name.localeCompare(b.e.name));

  const children = [];
  for (const { e, full, isDir } of entries) {
    const path = relPath(full);
    if (isDir) {
      if (isProjectRoot && e.name !== '.claude') continue; // don't recurse into project source
      children.push({ type: 'dir', name: e.name, path, children: walk(full) });
      continue;
    }
    if (isProjectRoot && !PROJECT_FILES.has(e.name)) continue;
    const st = safeStat(full);
    if (!st) continue;
    const node = { type: 'file', name: e.name, path, size: st.size, mtime: st.mtime.toISOString() };
    if (isSecret(e.name)) node.secret = true; // listed by name only, never embedded
    else if (isText(e.name) && st.size <= MAX_BYTES) {
      const text = readText(full);
      if (text != null && !text.includes('\u0000')) node.content = text;
    }
    fileCount++;
    children.push(node);
  }
  return children;
}

// ---------- Reports registry (C1)
function loadReports() {
  const file = join(root, 'reports', 'reports.json');
  if (!existsSync(file)) return { present: false, reports: [] };
  let j;
  try { j = JSON.parse(readText(file)); } catch (err) {
    return { present: true, error: 'reports/reports.json is not valid JSON: ' + err.message, reports: [] };
  }
  const list = j && Array.isArray(j.reports) ? j.reports : [];
  const reports = list.filter(r => r && typeof r === 'object').map(r => ({
    id: str(r.id),
    title: str(r.title) || str(r.id) || 'Untitled report',
    project: r.project ? str(r.project) : null,
    type: str(r.type) || 'other',
    status: str(r.status) || 'active',
    created: str(r.created),
    updated: str(r.updated) || str(r.created),
    folder: toPosix(str(r.folder)),
    summary: str(r.summary),
    steps: (Array.isArray(r.steps) ? r.steps : [])
      .filter(s => s && typeof s.path === 'string')
      .map(s => {
        const p = toPosix(s.path).replace(/^\.\//, '');
        return { name: str(s.name) || basename(p), path: p, exists: existsSync(join(root, p)) };
      }),
  }));
  return { present: true, reports };
}

// ---------- Projects (C8)
function detectProject(dir) {
  const has = p => existsSync(join(dir, p));
  const names = safeReaddir(dir).map(e => e.name);
  let deps = {};
  let raw = '';
  if (has('package.json')) {
    raw = readText(join(dir, 'package.json')) || '';
    try {
      const pkg = JSON.parse(raw);
      const obj = v => (v && typeof v === 'object' ? v : {});
      deps = { ...obj(pkg.dependencies), ...obj(pkg.devDependencies) };
    } catch { deps = null; } // unparsable: fall back to a text search below
  }
  const hasDep = name => deps
    ? Object.prototype.hasOwnProperty.call(deps, name)
    : new RegExp('"' + name.replace('.', '\\.') + '"\\s*:').test(raw);
  let type = 'other';
  if (names.some(n => /^next\.config\./i.test(n)) || hasDep('next')) type = 'nextjs';
  else if (has('project.godot')) type = 'godot';
  else if (has(join('ProjectSettings', 'ProjectVersion.txt'))) type = 'unity';
  else if (GAME_LIBS.some(hasDep)) type = 'web-game';
  return {
    type,
    hasClaudeMd: has('CLAUDE.md') || has(join('.claude', 'CLAUDE.md')),
    hasReadme: has('README.md'),
  };
}
function loadProjects() {
  const base = join(root, 'projects');
  return safeReaddir(base)
    .filter(e => !e.name.startsWith('.') && !SKIP.has(e.name))
    .filter(e => e.isDirectory() || (e.isSymbolicLink() && safeStat(join(base, e.name))?.isDirectory()))
    .map(e => ({ name: e.name, path: 'projects/' + e.name, ...detectProject(join(base, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Skills and agents
function loadSkills(relDir) {
  const base = join(root, relDir);
  return safeReaddir(base)
    .filter(e => e.isDirectory() && existsSync(join(base, e.name, 'SKILL.md')))
    .map(e => {
      const { meta } = parseFrontmatter(readText(join(base, e.name, 'SKILL.md')) || '');
      return {
        name: str(meta.name) || e.name,
        folder: e.name,
        description: str(meta.description),
        argumentHint: str(meta['argument-hint']),
        manual: truthy(meta['disable-model-invocation']),
        path: relDir + '/' + e.name + '/SKILL.md',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
function loadAgents(relDir) {
  const base = join(root, relDir);
  return safeReaddir(base)
    .filter(e => e.isFile() && /\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name))
    .map(e => {
      const { meta } = parseFrontmatter(readText(join(base, e.name)) || '');
      return {
        name: str(meta.name) || e.name.replace(/\.md$/i, ''),
        description: str(meta.description),
        tools: str(meta.tools),
        model: str(meta.model),
        path: relDir + '/' + e.name,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Knowledge notes (C3)
function loadKnowledge() {
  const notes = [];
  const visit = dir => {
    for (const e of safeReaddir(dir)) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { visit(full); continue; }
      if (!/\.md$/i.test(e.name) || /^(INDEX|README)\.md$/i.test(e.name)) continue;
      const st = safeStat(full);
      const src = readText(full);
      if (!st || src == null) continue;
      const { meta, body } = parseFrontmatter(src);
      const path = relPath(full);
      const updated = /^\d{4}-\d{2}-\d{2}/.test(str(meta.updated)) ? str(meta.updated).slice(0, 10) : '';
      notes.push({
        title: str(meta.title) || firstH1(body) || e.name.replace(/\.md$/i, ''),
        path,
        area: path.split('/').length > 2 ? path.split('/')[1] : '',
        tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [str(meta.tags)] : [],
        updated,
        mtime: st.mtime.toISOString(),
        summary: firstParagraph(body),
      });
    }
  };
  visit(join(root, 'knowledge'));
  return notes;
}

// ---------- Inbox (C4): every file, including binaries.
// Same rules as tools/hooks/session-start.mjs: README.md, dotfiles (.gitkeep), OS clutter and
// _processed/ folders are not inbox items. Files in inbox/_processed/ are only counted.
function loadInbox() {
  const base = join(root, 'inbox');
  const out = { exists: existsSync(base), items: [], processed: 0 };
  const countProcessed = dir => {
    for (const e of safeReaddir(dir)) {
      if (e.name.startsWith('.') || CLUTTER.has(e.name.toLowerCase())) continue;
      if (e.isDirectory()) countProcessed(join(dir, e.name));
      else out.processed++;
    }
  };
  const visit = dir => {
    for (const e of safeReaddir(dir)) {
      const lower = e.name.toLowerCase();
      if (SKIP.has(e.name) || e.name.startsWith('.') || CLUTTER.has(lower) || lower === 'readme.md') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (lower === '_processed') { if (dir === base) countProcessed(full); continue; }
        visit(full);
        continue;
      }
      const rel = toPosix(relative(base, full));
      const st = safeStat(full);
      if (!st || !st.isFile()) continue;
      out.items.push({
        name: e.name,
        path: relPath(full),
        folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        size: st.size,
        mtime: st.mtime.toISOString(),
        isImage: isImage(e.name),
      });
    }
  };
  if (out.exists) visit(base);
  out.items.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

function workspaceName() {
  const readme = readText(join(root, 'README.md'));
  const h1 = readme ? firstH1(parseFrontmatter(readme).body) : '';
  return h1 && h1.length <= 60 ? h1 : 'Claude Workspace';
}

// ---------- Build
const data = {
  name: workspaceName(),
  root: toPosix(root),
  built: new Date().toISOString(),
  tree: walk(root),
  reports: loadReports(),
  projects: loadProjects(),
  skills: {
    hub: loadSkills('.claude/skills'),
    library: loadSkills('library/skills'),
    agents: loadAgents('library/agents'),
    hubAgents: loadAgents('.claude/agents'),
  },
  knowledge: loadKnowledge(),
  inbox: loadInbox(),
};

const template = readFileSync(join(toolsDir, 'index.template.html'), 'utf8');
const PLACEHOLDER = '/*__DATA__*/null';
if (!template.includes(PLACEHOLDER)) {
  console.error('tools/index.template.html is missing the ' + PLACEHOLDER + ' placeholder.');
  process.exit(1);
}
// Valid JSON and a valid JS literal. Escaping every "<" makes "</script>" and "<!--" in file contents harmless.
const json = JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
// Write to a temp file and rename it over index.html, so a browser (or a second build started by the
// after-edit hook) never sees a half-written page. On Windows a rename can fail for a moment while another
// process (a parallel build, antivirus) holds the file, so retry briefly, then fall back to a direct write.
const out = join(root, 'index.html');
const tmp = join(root, `index.html.${process.pid}.tmp`);
const html = template.replace(PLACEHOLDER, () => json);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let written = false;
try {
  writeFileSync(tmp, html);
  for (let i = 0; i < 8 && !written; i++) {
    try { renameSync(tmp, out); written = true; } catch { pause(25 * (i + 1)); }
  }
} catch { /* temp file not writable: direct write below */ }
try {
  if (!written) writeFileSync(out, html);
} finally {
  for (let i = 0; i < 8 && existsSync(tmp); i++) {
    try { unlinkSync(tmp); } catch { pause(25 * (i + 1)); }
  }
}

if (!quiet) console.log(`index.html written (${fileCount} files)`);
