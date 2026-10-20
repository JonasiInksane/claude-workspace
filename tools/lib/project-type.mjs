// Project type detection (SPEC C8), shared by build-index, check-workspace, the session-start hook
// and start.ps1. Never throws: unreadable folders and broken package.json files give "other".
//
// Single-folder types, checked in this order:
//   nextjs    next.config.* exists, or "next" in dependencies/devDependencies
//   expo      "expo" in dependencies/devDependencies
//   godot     project.godot
//   unity     ProjectSettings/ProjectVersion.txt
//   web-game  phaser, three, pixi.js, kaplay or excalibur in dependencies
//   other     none of the above
// Monorepos: a folder whose package.json has "workspaces" (npm/yarn/bun) or that has
// pnpm-workspace.yaml is a monorepo when at least one workspace folder has a known type.
// Its type is "monorepo" and `parts` lists the typed workspace folders.
//
// CLI: node tools/lib/project-type.mjs <dir>   prints the label, e.g. "Monorepo: Next.js + Expo"
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAME_LIBS = ['phaser', 'three', 'pixi.js', 'kaplay', 'excalibur'];
export const TYPE_LABEL = {
  nextjs: 'Next.js', expo: 'Expo', godot: 'Godot', unity: 'Unity',
  'web-game': 'Web game', monorepo: 'Monorepo', other: 'Other',
};
const MAX_WORKSPACE_DIRS = 60;
const SKIP = new Set(['node_modules', '.git', '.next', '.turbo', 'dist', 'build', '.venv']);

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function readPackage(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return { pkg: null, raw: '' };
  let raw = '';
  try { raw = readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return { pkg: null, raw: '' }; }
  try { return { pkg: JSON.parse(raw), raw }; } catch { return { pkg: null, raw }; }
}
function depChecker({ pkg, raw }) {
  if (pkg && typeof pkg === 'object') {
    const deps = {};
    for (const key of ['dependencies', 'devDependencies']) {
      const d = pkg[key];
      if (d && typeof d === 'object' && !Array.isArray(d)) Object.assign(deps, d);
    }
    return name => Object.prototype.hasOwnProperty.call(deps, name);
  }
  // Unparsable package.json: fall back to a text search.
  return name => new RegExp('"' + name.replace(/\./g, '\\.') + '"\\s*:').test(raw);
}

// Type of one folder, ignoring workspaces.
export function detectSingleType(dir) {
  const names = listDir(dir).map(e => e.name);
  const hasDep = depChecker(readPackage(dir));
  if (names.some(n => /^next\.config\./i.test(n)) || hasDep('next')) return 'nextjs';
  if (hasDep('expo')) return 'expo';
  if (existsSync(join(dir, 'project.godot'))) return 'godot';
  if (existsSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
  if (GAME_LIBS.some(hasDep)) return 'web-game';
  return 'other';
}

// Workspace patterns from package.json "workspaces" or pnpm-workspace.yaml.
function workspacePatterns(dir) {
  const out = [];
  const { pkg } = readPackage(dir);
  if (pkg && typeof pkg === 'object') {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces
      : (pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : []);
    for (const p of ws) if (typeof p === 'string') out.push(p);
  }
  try {
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) out.push(m[1]);
  } catch { /* no pnpm workspace */ }
  return out.filter(p => !p.startsWith('!'));
}

// Expands simple patterns: "apps/*", "apps/**" (one level) and literal folders.
function expandPattern(dir, pattern) {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean.includes('..')) return [];
  const star = clean.match(/^(.*?)\/\*\*?$/);
  if (star) {
    const base = join(dir, star[1]);
    return listDir(base)
      .filter(e => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map(e => ({ rel: star[1] + '/' + e.name, abs: join(base, e.name) }))
      .filter(x => isDir(x.abs));
  }
  if (clean.includes('*')) return [];
  const abs = join(dir, clean);
  return isDir(abs) ? [{ rel: clean, abs }] : [];
}

export function detectProjectType(dir) {
  try {
    const patterns = workspacePatterns(dir);
    if (patterns.length) {
      const seen = new Set();
      const parts = [];
      for (const pattern of patterns) {
        for (const ws of expandPattern(dir, pattern)) {
          if (seen.has(ws.rel) || seen.size >= MAX_WORKSPACE_DIRS) continue;
          seen.add(ws.rel);
          const type = detectSingleType(ws.abs);
          if (type !== 'other') parts.push({ path: ws.rel, type });
        }
      }
      if (parts.length) return { type: 'monorepo', parts };
    }
    return { type: detectSingleType(dir), parts: [] };
  } catch {
    return { type: 'other', parts: [] };
  }
}

// "Next.js", or "Monorepo: Next.js + Expo" (each part type once, in order of appearance).
export function typeLabel(result) {
  if (!result || result.type !== 'monorepo') return TYPE_LABEL[result && result.type] || 'Other';
  const kinds = [...new Set(result.parts.map(p => p.type))];
  return 'Monorepo: ' + kinds.map(k => TYPE_LABEL[k] || k).join(' + ');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node tools/lib/project-type.mjs <dir>');
    process.exit(1);
  }
  console.log(typeLabel(detectProjectType(resolve(target))));
}
