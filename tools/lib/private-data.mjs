// Private project data and the public hub. A project profile (in the private data folder,
// %LOCALAPPDATA%\claude-workspace\profiles\<project>.json, never in the hub) can list `privacy`
// markers: regular expressions for text that must not appear in files the hub repo publishes,
// such as names of security-relevant code. tools/check-workspace.mjs scans the hub's tracked
// files with them (the private-project-data check).
//
//   privacy: { hubPublic: true, markers: ["<regex>", ...], knownExposed: ["reports/x/report.md"] }
//
// knownExposed lists hub files that are already public with such text in them; they only warn.
// This file reads profiles only (never .env or other secrets), and skips unreadable ones.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/; // <project>.json, not <project>.allowlist.json
export const MAX_SCAN_BYTES = 1024 * 1024;

// The app's private data folder: %LOCALAPPDATA%\claude-workspace. The same rule as the app's
// core/datadir.mjs, which tools/lib can't import.
export function defaultDataDir(env = process.env) {
  return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-workspace');
}

// Every readable profile with its privacy settings. Returns { dataDir, profiles, problems }:
//   profiles  [{ project, file, hubPublic, markers: RegExp[], knownExposed: Set<hub path> }]
//   problems  plain sentences about files or markers that were skipped
export function readPrivateProfiles(env = process.env) {
  const dataDir = defaultDataDir(env);
  const dir = join(dataDir, 'profiles');
  const profiles = [];
  const problems = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && PROFILE_FILE.test(e.name)).map(e => e.name).sort();
  } catch { return { dataDir, profiles, problems }; }
  for (const name of names) {
    let data;
    try { data = JSON.parse(readFileSync(join(dir, name), 'utf8').replace(/^﻿/, '')); } catch (e) {
      problems.push(`profiles/${name} could not be read (${e.message}), so its markers were not checked`);
      continue;
    }
    const privacy = data && typeof data.privacy === 'object' && data.privacy ? data.privacy : {};
    const markers = [];
    for (const m of Array.isArray(privacy.markers) ? privacy.markers : []) {
      try { markers.push(new RegExp(String(m))); } catch {
        problems.push(`profiles/${name} has a marker that is not a valid regular expression; it was skipped`);
      }
    }
    const exposed = Array.isArray(privacy.knownExposed) ? privacy.knownExposed : [];
    profiles.push({
      project: typeof data.project === 'string' && data.project ? data.project : name.slice(0, -5),
      file: join(dir, name),
      hubPublic: privacy.hubPublic === true,
      markers,
      knownExposed: new Set(exposed.map(p => String(p).replace(/\\/g, '/').replace(/^\.\//, ''))),
    });
  }
  return { dataDir, profiles, problems };
}

// The profiles' markers: [{ project, hubPublic, markers: RegExp[], knownExposed: Set }].
export function privateMarkers(env = process.env) {
  return readPrivateProfiles(env).profiles;
}

// The line (1-based) where index `i` of `text` sits.
const lineAt = (text, i) => text.slice(0, i).split('\n').length;

// The markers that match `text`, each with the line of its first match.
export function matchMarkers(text, markers) {
  const out = [];
  for (const re of markers) {
    const m = re.exec(text);
    if (m) out.push({ marker: re.source, line: lineAt(text, m.index) });
  }
  return out;
}

// Scans hub files (hub-relative posix paths) for the markers of every profile with
// hubPublic: true. Skips projects/ (each project is its own repo), files over 1 MB and binary
// files. `untracked` files are scanned too and reported as such.
// Returns [{ file, project, matches: [{marker, line}], exposed, tracked }].
export function findPrivateData(root, { tracked = [], untracked = [], profiles = [] } = {}) {
  const active = profiles.filter(p => p.hubPublic && p.markers.length);
  const hits = [];
  if (!active.length) return hits;
  const scan = (file, isTracked) => {
    if (file.startsWith('projects/')) return;
    let buf;
    try { buf = readFileSync(join(root, ...file.split('/'))); } catch { return; }
    if (buf.length > MAX_SCAN_BYTES || buf.subarray(0, 8000).includes(0)) return;
    const text = buf.toString('utf8');
    for (const p of active) {
      const matches = matchMarkers(text, p.markers);
      if (matches.length) hits.push({ file, project: p.project, matches, exposed: p.knownExposed.has(file), tracked: isTracked });
    }
  };
  for (const f of tracked) scan(f, true);
  for (const f of untracked) scan(f, false);
  return hits;
}
