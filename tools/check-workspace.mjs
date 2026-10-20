// Self-check for the workspace. Exits 1 when there are errors.
//
// Usage: node tools/check-workspace.mjs
//
// Checks: strict JSON, skill and agent frontmatter, knowledge notes + INDEX.md, the reports
// registry, relative Markdown links, CLAUDE.md @imports, hook script paths, .env.example,
// absolute user paths, file sizes, lists the projects with their detected type and agents, and
// checks the inbox's agent image folders.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectType, typeLabel } from './lib/project-type.mjs';
import { duplicateNames, listAgents } from './lib/agents.mjs';
import { scanInbox } from './lib/inbox.mjs';

function isDirPath(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Built-in and bundled command names a skill must never reuse (SPEC C5).
const BUILTIN = new Set([
  'plan', 'resume', 'recap', 'run', 'review', 'init', 'memory', 'doctor', 'compact', 'clear',
  'context', 'config', 'status', 'hooks', 'mcp', 'agents', 'skills', 'verify', 'goal', 'loop',
  'schedule', 'batch', 'fork', 'help', 'model', 'cost', 'usage', 'rewind', 'export', 'add-dir',
  'login', 'logout', 'permissions', 'statusline', 'tasks', 'todos', 'btw', 'diff', 'effort',
  'plugin', 'reload-skills', 'code-review', 'security-review', 'simplify', 'handoff',
  'rename', 'branch', 'background', 'stats', 'theme', 'terminal-setup', 'fewer-permission-prompts',
  'settings', 'new', 'continue', 'reset', 'undo', 'checkpoint', 'bashes',
]);
const REPORT_TYPES = ['status', 'onboarding', 'audit', 'research', 'playtest', 'plan', 'other'];
const REPORT_STATUSES = ['active', 'done', 'archived'];
const REPORT_ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next']);
const SCRIPT_EXT = /\.(mjs|cjs|js|ps1|sh|py)$/i;

// ---------------------------------------------------------------- helpers

const posix = p => p.split('\\').join('/');
const rel = abs => posix(relative(root, abs));
const abs = r => join(root, ...r.split('/'));

function readText(file) {
  return readFileSync(file, 'utf8');
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// All files outside projects/, inbox/, .git, node_modules and .claude/worktrees (workspace-relative, posix).
function walk(dirAbs, out = []) {
  let entries;
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dirAbs, e.name);
    const r = rel(full);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (r === 'projects' || r === 'inbox' || r === '.claude/worktrees') continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

function listDirs(dirAbs) {
  try {
    return readdirSync(dirAbs, { withFileTypes: true })
      .filter(e => (e.isDirectory() || (e.isSymbolicLink() && isDirPath(join(dirAbs, e.name)))) && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch { return []; }
}

// Minimal YAML frontmatter parser: key: value, inline [a, b] lists, "- item" lists,
// quoted strings, block scalars (| and >) and indented continuation lines.
function parseScalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => unquote(s.trim())).filter(s => s !== '');
  }
  return unquote(v);
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, '').trim(); // trailing comment on a plain value
}

function parseFrontmatter(text) {
  const res = { ok: false, bom: false, data: {}, error: '', endLine: 0 };
  if (text.charCodeAt(0) === 0xfeff) { res.bom = true; text = text.slice(1); }
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') { res.error = 'no frontmatter (line 1 must be ---)'; return res; }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) { res.error = 'frontmatter is not closed with ---'; return res; }
  let cur = null; // { key, mode: 'plain' | 'empty' | 'list' | 'block', sep, parts }
  const flush = () => {
    if (!cur) return;
    if (cur.mode === 'list') res.data[cur.key] = cur.parts;
    else if (cur.mode === 'block') res.data[cur.key] = cur.parts.join(cur.sep).trim();
    else if (cur.mode === 'plain' && cur.parts.length) {
      const first = res.data[cur.key];
      if (typeof first === 'string') res.data[cur.key] = [first, ...cur.parts].join(' ');
    }
    cur = null;
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      if (cur && cur.mode === 'block') cur.parts.push('');
      continue;
    }
    const m = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (m) {
      flush();
      const key = m[1];
      const v = (m[2] || '').trim();
      if (v === '') { res.data[key] = ''; cur = { key, mode: 'empty', parts: [] }; }
      else if (/^[|>][+-]?$/.test(v)) { res.data[key] = ''; cur = { key, mode: 'block', sep: v[0] === '|' ? '\n' : ' ', parts: [] }; }
      else { res.data[key] = parseScalar(v); cur = { key, mode: 'plain', parts: [] }; }
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if ((cur.mode === 'empty' || cur.mode === 'list') && t.startsWith('-')) {
      cur.mode = 'list';
      cur.parts.push(unquote(t.replace(/^-\s*/, '')));
    } else if (cur.mode === 'empty') {
      cur.mode = 'plain';
      res.data[cur.key] = t;
    } else {
      cur.parts.push(t);
    }
  }
  flush();
  res.ok = true;
  res.endLine = end + 1;
  return res;
}

// Lines of a Markdown file with fenced code, inline code, HTML comments and frontmatter blanked out.
function proseLines(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let fence = null;
  let inComment = false;
  let start = 0;
  if (lines[0] && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { start = i + 1; break; }
    }
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && line.trim() === fm[1]) fence = null;
      continue;
    }
    if (fm && !inComment) { fence = fm[1]; continue; }
    let s = '';
    let rest = line;
    while (rest.length) {
      if (inComment) {
        const e = rest.indexOf('-->');
        if (e < 0) { rest = ''; } else { rest = rest.slice(e + 3); inComment = false; }
      } else {
        const b = rest.indexOf('<!--');
        if (b < 0) { s += rest; rest = ''; } else { s += rest.slice(0, b); rest = rest.slice(b + 4); inComment = true; }
      }
    }
    s = s.replace(/(`+)(.+?)\1(?!`)/g, m => ' '.repeat(m.length));
    out.push({ n: i + 1, s });
  }
  return out;
}

function extractLinks(s) {
  const out = [];
  let idx = 0;
  while ((idx = s.indexOf('](', idx)) !== -1) {
    if (s.lastIndexOf('[', idx) < 0) { idx += 2; continue; }
    let j = idx + 2;
    let target = null;
    const e = s[j] === '<' ? s.indexOf('>', j) : -1;
    // <dest> form only when the > is followed by ")" or a space; "(<name>.md)" is a placeholder.
    if (e > 0 && /^[\s)]/.test(s.slice(e + 1))) {
      target = s.slice(j + 1, e);
    } else {
      let depth = 1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) break; }
      }
      if (depth === 0) target = s.slice(idx + 2, j).trim().split(/\s+/)[0];
    }
    if (target !== null) out.push(target);
    idx += 2;
  }
  const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(s);
  if (def) out.push(def[1].replace(/^<|>$/g, ''));
  return out;
}

// Returns the local path part of a link target, or null if it should not be checked.
function localTarget(t) {
  t = (t || '').trim();
  if (!t || t.startsWith('#') || t.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]+:/i.test(t)) return null; // http:, https:, mailto:, vscode: ...
  if (/[<>{}*$]/.test(t)) return null; // placeholders and globs
  t = t.replace(/[#?].*$/, '');
  if (!t) return null;
  try { t = decodeURIComponent(t); } catch { /* keep as is */ }
  return t;
}

// SPEC C8 project detection.
function detectProject(dirAbs) {
  const has = p => existsSync(join(dirAbs, p));
  const hasClaudeMd = has('CLAUDE.md') || has('.claude/CLAUDE.md');
  return { label: typeLabel(detectProjectType(dirAbs)), hasClaudeMd };
}

// ---------------------------------------------------------------- runner

const results = [];
function check(name, fn) {
  const r = { name, count: 0, unit: '', note: '', errors: [], warnings: [] };
  try { fn(r); } catch (e) { r.errors.push(`check crashed: ${e && e.stack ? e.stack.split('\n')[0] : e}`); }
  results.push(r);
}

const files = walk(root);
const projectNames = listDirs(join(root, 'projects'));
const jsonCache = new Map();

// 1. Strict JSON parse of every *.json (outside projects/, inbox/, node_modules), plus .mcp.json sanity.
check('json', r => {
  r.unit = 'files';
  for (const f of files.filter(f => f.toLowerCase().endsWith('.json'))) {
    r.count++;
    const text = readText(abs(f));
    if (text.charCodeAt(0) === 0xfeff) { r.errors.push(`${f}: starts with a UTF-8 BOM; save it as UTF-8 without BOM`); continue; }
    let data;
    try { data = JSON.parse(text); } catch (e) { r.errors.push(`${f}: invalid JSON (${e.message})`); continue; }
    jsonCache.set(f, data);
    if (basename(f) === '.mcp.json') {
      const servers = data && data.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        r.errors.push(`${f}: needs an "mcpServers" object`);
        continue;
      }
      for (const [name, s] of Object.entries(servers)) {
        if (!s || typeof s !== 'object') { r.errors.push(`${f}: server "${name}" must be an object`); continue; }
        if (s.url && !s.type) r.errors.push(`${f}: server "${name}" has a url but no "type" (Claude Code rejects it; use "http")`);
        if (!s.url && !s.command) r.errors.push(`${f}: server "${name}" needs "command" (stdio) or "type" + "url"`);
        if (s.type === 'sse') r.warnings.push(`${f}: server "${name}" uses deprecated "sse"; prefer "http"`);
        const secretish = { ...(s.env || {}), ...(s.headers || {}) };
        for (const [k, v] of Object.entries(secretish)) {
          if (typeof v === 'string' && v.trim() && !v.includes('${') &&
              /(key|token|secret|password|authorization)/i.test(k)) {
            r.errors.push(`${f}: server "${name}" has a literal value for ${k}; use \${VAR} and keep secrets out of tracked files`);
          }
        }
      }
    }
  }
});

// 2. Skills: frontmatter on line 1, name + description, name == folder, not a built-in name.
const skillNames = { hub: new Set(), library: new Set() };
check('skills', r => {
  for (const [kind, base] of [['hub', '.claude/skills'], ['library', 'library/skills']]) {
    const baseAbs = abs(base);
    if (!existsSync(baseAbs)) { r.warnings.push(`${base}/ not found`); continue; }
    for (const folder of listDirs(baseAbs)) {
      const names = readdirSync(join(baseAbs, folder));
      const p = `${base}/${folder}/SKILL.md`;
      if (!names.includes('SKILL.md')) {
        const wrongCase = names.find(n => n.toLowerCase() === 'skill.md');
        if (wrongCase) r.errors.push(`${base}/${folder}/${wrongCase}: must be named exactly SKILL.md`);
        else r.warnings.push(`${base}/${folder}/ has no SKILL.md (not a skill)`);
        continue;
      }
      r.count++;
      const text = readText(abs(p));
      const fm = parseFrontmatter(text);
      if (fm.bom) r.errors.push(`${p}: starts with a BOM, so line 1 is not "---"; save as UTF-8 without BOM`);
      if (!fm.ok) { r.errors.push(`${p}: ${fm.error}`); continue; }
      const { name, description } = fm.data;
      if (typeof name !== 'string' || !name) r.errors.push(`${p}: missing "name"`);
      else {
        if (name !== folder) r.errors.push(`${p}: name "${name}" does not match folder "${folder}"`);
        if (BUILTIN.has(name)) r.errors.push(`${p}: "${name}" is a built-in command name; rename the skill`);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
          r.warnings.push(`${p}: name should be lowercase letters, digits and hyphens (max 64)`);
        }
        skillNames[kind].add(name);
      }
      if (typeof description !== 'string' || !description.trim()) r.errors.push(`${p}: missing "description"`);
      else {
        const wtu = typeof fm.data.when_to_use === 'string' ? fm.data.when_to_use : '';
        if (description.length + wtu.length > 1536) {
          r.warnings.push(`${p}: description + when_to_use is over 1,536 characters and will be truncated`);
        }
      }
      const lines = text.split(/\r?\n/).length;
      if (lines > 500) r.warnings.push(`${p}: ${lines} lines (keep SKILL.md under 500; move detail to supporting files)`);
    }
  }
  for (const n of skillNames.hub) {
    if (skillNames.library.has(n)) {
      r.warnings.push(`skill "${n}" exists in both .claude/skills and library/skills; once installed, the personal (library) copy wins`);
    }
  }
});

// 3. Agents: name + description.
check('agents', r => {
  const agentFiles = files.filter(f =>
    (/^library\/agents\/[^/]+\.md$/i.test(f) || /^\.claude\/agents\/.+\.md$/i.test(f)));
  const seen = new Map();
  for (const f of agentFiles) {
    if (basename(f).toLowerCase() === 'readme.md') {
      if (f.startsWith('library/')) r.warnings.push(`${f}: README.md in library/agents is not an agent (install-library skips it)`);
      continue;
    }
    r.count++;
    const fm = parseFrontmatter(readText(abs(f)));
    if (fm.bom) r.errors.push(`${f}: starts with a BOM; save as UTF-8 without BOM`);
    if (!fm.ok) { r.errors.push(`${f}: ${fm.error}`); continue; }
    const { name, description } = fm.data;
    if (typeof name !== 'string' || !name) r.errors.push(`${f}: missing "name"`);
    else {
      if (name.includes(':') || name.startsWith('-') || name.length > 256) {
        r.errors.push(`${f}: name "${name}" must not contain ':' or start with '-' (max 256 chars)`);
      }
      if (seen.has(name)) r.errors.push(`${f}: agent name "${name}" is also used by ${seen.get(name)}`);
      seen.set(name, f);
    }
    if (typeof description !== 'string' || !description.trim()) r.errors.push(`${f}: missing "description"`);
  }
});

// 4. Knowledge notes: C3 frontmatter and listed in knowledge/INDEX.md.
check('knowledge', r => {
  r.unit = 'notes';
  if (!existsSync(abs('knowledge'))) { r.warnings.push('knowledge/ not found'); return; }
  const indexPath = 'knowledge/INDEX.md';
  const linked = new Set();
  if (!existsSync(abs(indexPath))) r.errors.push(`${indexPath} is missing`);
  else {
    const text = readText(abs(indexPath));
    if (!/^\|\s*Note\s*\|\s*Tags\s*\|\s*Updated\s*\|\s*Summary\s*\|/mi.test(text)) {
      r.warnings.push(`${indexPath}: table header "| Note | Tags | Updated | Summary |" not found`);
    }
    for (const { s } of proseLines(text)) {
      for (const t of extractLinks(s)) {
        const lt = localTarget(t);
        if (lt) linked.add(posix(relative(root, resolve(abs('knowledge'), lt))));
      }
    }
  }
  const notes = files.filter(f => f.startsWith('knowledge/') && f.toLowerCase().endsWith('.md') &&
    f !== indexPath && basename(f).toLowerCase() !== 'readme.md');
  for (const f of notes) {
    r.count++;
    const text = readText(abs(f));
    const fm = parseFrontmatter(text);
    if (fm.bom) r.errors.push(`${f}: starts with a BOM; save as UTF-8 without BOM`);
    if (!fm.ok) { r.errors.push(`${f}: ${fm.error} (needs title, tags, updated)`); }
    else {
      const { title, tags, updated, claude_code_version: ccv } = fm.data;
      if (typeof title !== 'string' || !title.trim()) r.errors.push(`${f}: missing "title"`);
      if (!Array.isArray(tags)) r.errors.push(`${f}: "tags" must be a list like [tag-a, tag-b]`);
      if (!isValidDate(updated)) r.errors.push(`${f}: "updated" must be a date like 2026-10-20`);
      if (ccv !== undefined && !/^\d+\.\d+\.\d+$/.test(String(ccv))) {
        r.warnings.push(`${f}: claude_code_version "${ccv}" should look like 2.1.304`);
      }
      const h1 = text.split(/\r?\n/).slice(fm.endLine).find(l => /^#\s+/.test(l));
      if (!h1) r.warnings.push(`${f}: no H1 heading after the frontmatter`);
      else if (typeof title === 'string' && h1.replace(/^#\s+/, '').trim() !== title.trim()) {
        r.warnings.push(`${f}: H1 "${h1.replace(/^#\s+/, '').trim()}" differs from title "${title}"`);
      }
    }
    const parts = f.split('/');
    if (parts.length < 3) r.warnings.push(`${f}: notes belong in knowledge/<area>/`);
    const file = basename(f);
    if (parts[1] === 'decisions') {
      if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) {
        r.warnings.push(`${f}: decision files are named YYYY-MM-DD-topic.md`);
      }
      for (const sec of ['Context', 'Options', 'Decision', 'Consequences']) {
        if (!new RegExp(`^#{2,3}\\s+${sec}\\b`, 'mi').test(text)) r.warnings.push(`${f}: missing section "## ${sec}"`);
      }
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) {
      r.warnings.push(`${f}: file name should be kebab-case`);
    }
    if (!linked.has(f)) r.errors.push(`${f}: not linked from ${indexPath}`);
  }
});

// 5. Reports registry (C1).
check('reports', r => {
  r.unit = 'entries';
  const p = 'reports/reports.json';
  if (!existsSync(abs(p))) {
    if (existsSync(abs('reports'))) r.warnings.push(`${p} not found (tools/register-report.mjs creates it)`);
    return;
  }
  const data = jsonCache.get(p);
  if (data === undefined) { r.errors.push(`${p}: cannot validate (invalid JSON, see the json check)`); return; }
  if (data.version !== 1) r.errors.push(`${p}: "version" must be 1`);
  if (!Array.isArray(data.reports)) { r.errors.push(`${p}: "reports" must be an array`); return; }
  const ids = new Set();
  data.reports.forEach((e, i) => {
    r.count++;
    const where = `${p} [${i}]${e && e.id ? ` ${e.id}` : ''}`;
    if (!e || typeof e !== 'object') { r.errors.push(`${where}: entry must be an object`); return; }
    if (typeof e.id !== 'string' || !REPORT_ID_RE.test(e.id)) r.errors.push(`${where}: id must be YYYY-MM-DD_kebab-slug`);
    else if (ids.has(e.id)) r.errors.push(`${where}: duplicate id`);
    ids.add(e.id);
    if (typeof e.title !== 'string' || !e.title.trim()) r.errors.push(`${where}: missing title`);
    if (e.project !== null && typeof e.project !== 'string') r.errors.push(`${where}: project must be a projects/ folder name or null`);
    else if (typeof e.project === 'string') {
      if (!e.project || e.project.includes('/')) r.errors.push(`${where}: project must be a folder name under projects/ or null`);
      else if (!projectNames.includes(e.project)) r.warnings.push(`${where}: projects/${e.project} not found on this machine`);
    }
    if (!REPORT_TYPES.includes(e.type)) r.errors.push(`${where}: type must be one of ${REPORT_TYPES.join(', ')}`);
    if (!REPORT_STATUSES.includes(e.status)) r.errors.push(`${where}: status must be one of ${REPORT_STATUSES.join(', ')}`);
    if (!isValidDate(e.created)) r.errors.push(`${where}: created must be YYYY-MM-DD`);
    if (!isValidDate(e.updated)) r.errors.push(`${where}: updated must be YYYY-MM-DD`);
    if (isValidDate(e.created) && isValidDate(e.updated) && e.updated < e.created) r.errors.push(`${where}: updated is before created`);
    if (typeof e.id === 'string' && e.folder !== `reports/${e.id}`) r.errors.push(`${where}: folder must be "reports/${e.id}"`);
    else if (typeof e.folder === 'string' && !existsSync(abs(e.folder))) r.errors.push(`${where}: folder ${e.folder} does not exist`);
    if (e.summary !== undefined && typeof e.summary !== 'string') r.errors.push(`${where}: summary must be a string`);
    if (e.summary === undefined) r.warnings.push(`${where}: no summary`);
    if (!Array.isArray(e.steps)) { r.errors.push(`${where}: steps must be an array`); return; }
    if (e.steps.length === 0) r.warnings.push(`${where}: no steps`);
    for (const s of e.steps) {
      if (!s || typeof s.name !== 'string' || typeof s.path !== 'string') { r.errors.push(`${where}: each step needs name and path`); continue; }
      if (s.path.includes('\\') || /^([a-z]:|\/)/i.test(s.path)) r.errors.push(`${where}: step path "${s.path}" must be workspace-relative with forward slashes`);
      else if (!existsSync(abs(s.path))) r.errors.push(`${where}: step path ${s.path} does not exist`);
    }
  });
  for (const d of listDirs(abs('reports'))) {
    if (REPORT_ID_RE.test(d) && !ids.has(d)) r.warnings.push(`reports/${d}/ is not registered (run tools/register-report.mjs)`);
  }
});

// 6. Relative Markdown links outside projects/ and inbox/.
check('links', r => {
  for (const f of files.filter(f => f.toLowerCase().endsWith('.md'))) {
    const dir = dirname(abs(f));
    for (const { n, s } of proseLines(readText(abs(f)))) {
      for (const t of extractLinks(s)) {
        const lt = localTarget(t);
        if (!lt) continue;
        r.count++;
        const target = lt.startsWith('/') ? join(root, lt) : resolve(dir, lt);
        if (!existsSync(target)) r.errors.push(`${f}:${n}: broken link "${t}"`);
      }
    }
  }
});

// 7. @imports in the root CLAUDE.md files (an import that does not resolve is silently skipped).
check('imports', r => {
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    if (!existsSync(abs(f))) continue;
    const dir = dirname(abs(f));
    for (const { n, s } of proseLines(readText(abs(f)))) {
      const re = /(^|\s)@([^\s`'"()<>]+\.md)\b/gi;
      let m;
      while ((m = re.exec(s))) {
        const p = m[2];
        if (p.startsWith('~')) continue;
        r.count++;
        if (!existsSync(resolve(dir, p.replace(/\\ /g, ' ')))) r.errors.push(`${f}:${n}: @${p} does not exist`);
      }
    }
  }
});

// 8. Hook scripts referenced from .claude/settings.json files exist; exec form needs a real .exe.
check('hooks', r => {
  const settings = files.filter(f => /(^|\/)\.claude\/settings(\.local)?\.json$/.test(f));
  if (!settings.includes('.claude/settings.json')) r.warnings.push('.claude/settings.json not found');
  for (const f of settings) {
    const data = jsonCache.get(f);
    if (!data || typeof data.hooks !== 'object' || data.hooks === null) continue;
    const projectDir = dirname(dirname(abs(f)));
    for (const [event, groups] of Object.entries(data.hooks)) {
      if (!Array.isArray(groups)) { r.errors.push(`${f}: hooks.${event} must be an array`); continue; }
      for (const g of groups) {
        for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
          r.count++;
          if (!h || h.type !== 'command' || typeof h.command !== 'string') continue;
          let tokens;
          if (Array.isArray(h.args)) {
            if (/^(npx|npm|pnpm|yarn|eslint|prettier|tsc|next)$/i.test(h.command) || /\.(cmd|bat)$/i.test(h.command)) {
              r.errors.push(`${f}: ${event} hook runs "${h.command}" in exec form; on Windows that needs a real .exe (use node <script> or shell form)`);
            }
            tokens = h.args.map(String);
          } else {
            tokens = h.command.split(/\s+/).map(t => t.replace(/^["']|["']$/g, ''));
          }
          for (const t of tokens) {
            if (!SCRIPT_EXT.test(t)) continue;
            const p = t.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, projectDir);
            const target = resolve(projectDir, p);
            if (!existsSync(target)) r.errors.push(`${f}: ${event} hook script not found: ${posix(relative(root, target))}`);
          }
        }
      }
    }
  }
});

// 9. .env.example holds names only.
check('env', r => {
  r.unit = 'keys';
  const f = '.env.example';
  if (!existsSync(abs(f))) { r.warnings.push(`${f} not found`); return; }
  readText(abs(f)).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) { r.warnings.push(`${f}:${i + 1}: not a KEY= line`); return; }
    r.count++;
    let v = m[2].trim();
    if (v.startsWith('#')) v = '';
    v = v.replace(/\s+#.*$/, '').trim();
    if (v === '""' || v === "''") v = '';
    if (v) r.errors.push(`${f}:${i + 1}: ${m[1]} has a value; .env.example must hold names only`);
  });
});

// 10. No absolute user paths in shareable folders.
check('paths', r => {
  r.unit = 'files';
  const dirs = ['.claude/skills/', 'library/', 'templates/', 'context/'];
  const patterns = [
    /[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)/i,
    /(?:^|[^\w.~-])\/[a-z]\/Users\//i,
    /(?:^|[\s"'`(=:])\/home\//,
  ];
  for (const f of files.filter(f => dirs.some(d => f.startsWith(d)))) {
    const full = abs(f);
    if (statSync(full).size > 1_000_000) continue;
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    r.count++;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      if (patterns.some(p => p.test(line))) r.errors.push(`${f}:${i + 1}: absolute user path; use ~, %USERPROFILE% or a relative path`);
    });
  }
});

// 11. Size targets (warnings only).
check('sizes', r => {
  r.unit = 'files';
  const lineCount = f => readText(abs(f)).split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== '').length;
  if (existsSync(abs('CLAUDE.md'))) {
    r.count++;
    const n = lineCount('CLAUDE.md');
    if (n > 120) r.warnings.push(`CLAUDE.md: ${n} lines (target under 120; move detail into knowledge/ or skills)`);
  }
  for (const f of files.filter(f => /^context\/[^/]+\.md$/i.test(f))) {
    r.count++;
    const n = lineCount(f);
    if (n >= 40) r.warnings.push(`${f}: ${n} lines (context files stay under 40; they load in every session)`);
  }
  for (const f of files.filter(f => /^knowledge\/.+\.md$/i.test(f) && basename(f) !== 'INDEX.md')) {
    r.count++;
    const n = lineCount(f);
    if (n > 150) r.warnings.push(`${f}: ${n} lines (notes are ideally under 150; split by topic)`);
  }
});

// 12. Projects with their detected type (C8) and project agents. Informational, plus a warning
// when a project with agents turns auto memory off (that also turns agent memory off).
check('projects', r => {
  r.count = projectNames.length;
  r.note = projectNames.map(n => {
    const p = detectProject(join(root, 'projects', n));
    const agents = listAgents(root, n);
    if (agents.length) {
      for (const s of ['settings.json', 'settings.local.json']) {
        let json = null;
        try { json = JSON.parse(readText(join(root, 'projects', n, '.claude', s)).replace(/^﻿/, '')); } catch { continue; }
        if (json && json.autoMemoryEnabled === false) {
          r.warnings.push(`projects/${n}/.claude/${s}: autoMemoryEnabled is false, so its agents have no memory as subagents (agent-session.mjs still turns it on)`);
        }
      }
      for (const a of agents.filter(x => !x.isolated)) {
        r.warnings.push(`projects/${n}: agent "${a.name}" has no "memory: project" (or local), so it has no memory of its own`);
      }
      for (const a of agents.filter(x => !x.valid)) {
        r.warnings.push(`projects/${n}: agent name "${a.name}" is not kebab-case or is reserved; agent-session.mjs and the app skip it`);
      }
      for (const d of duplicateNames(agents)) {
        const where = d.files.map(f => relative(root, f).split('\\').join('/')).join(', ');
        r.errors.push(`projects/${n}: agent name "${d.name}" is used by ${where} (Claude Code loads only one; they would share one memory folder)`);
      }
    }
    const agentNote = agents.length ? `, agents: ${agents.map(a => a.name).join(' ')}` : '';
    return `${n} [${p.label}${p.hasClaudeMd ? '' : ', no CLAUDE.md'}${agentNote}]`;
  }).join(', ');
});

// 13. Inbox: triage items and agent image libraries (tools/lib/inbox.mjs). Warns about image
// folders whose agent no longer exists and loose files directly in attachments/<project>/.
check('inbox', r => {
  const ib = scanInbox(root);
  r.count = ib.items.length;
  r.unit = 'items';
  if (ib.libraries.length) r.note = `${ib.libraries.length} agent image folder${ib.libraries.length === 1 ? '' : 's'}`;
  for (const l of ib.libraries) {
    if (!l.agent) r.warnings.push(`${l.path}/: files directly in a project folder; move them into <agent>/ or _shared/`);
    else if (!l.known) r.warnings.push(`${l.path}/: projects/${l.project} has no agent "${l.agent}" (renamed or removed?)`);
  }
  if (ib.truncated) r.warnings.push('inbox/ is too deep or too large; only part of it was scanned');
});

// ---------------------------------------------------------------- output

const SINGULAR = { files: 'file', notes: 'note', entries: 'entry', keys: 'key', items: 'item' };
let errors = 0;
let warnings = 0;
for (const r of results) {
  errors += r.errors.length;
  warnings += r.warnings.length;
  const mark = r.errors.length ? '\u2716' : '\u2714';
  const unit = r.unit ? ' ' + (r.count === 1 ? (SINGULAR[r.unit] || r.unit) : r.unit) : '';
  const count = `(${r.count}${unit})`;
  const tail = [];
  if (r.errors.length) tail.push(`${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`);
  if (r.warnings.length) tail.push(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`);
  console.log(`${mark} ${r.name} ${count}${tail.length ? ', ' + tail.join(', ') : ''}${r.note ? ': ' + r.note : ''}`);
  for (const e of r.errors) console.log(`    error: ${e}`);
  for (const w of r.warnings) console.log(`    warn:  ${w}`);
}
console.log(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
process.exitCode = errors ? 1 : 0;
