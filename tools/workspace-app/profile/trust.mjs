// Has the user accepted Claude Code's trust dialog for a project folder?
//
// Interactive flows and Take over open `claude` in the project; headless -p runs skip the dialog.
// The cockpit's first-open checklist shows the state and, when it isn't trusted, the exact command
// to run once by hand.
//
// Claude Code keeps the answer in %USERPROFILE%\.claude.json:
//   { "projects": { "C:/Users/me/repo": { "hasTrustDialogAccepted": true, ... } } }
// Keys use forward slashes (seen on Claude Code 2.1.307; SPEC assumption A22). This module matches
// them case-insensitively and with either slash. Claude Code is understood to accept trust given
// to a parent folder for its subfolders too (not verified on this PC), so a trusted ancestor
// counts as trusted. The file is only read, never written, and only the projects map is looked at
// (the file also holds account details).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// "C:\Users\Me\Repo\" -> "c:/users/me/repo": the form keys are compared in.
export function trustKey(path) {
  return resolve(String(path)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// The PowerShell line that trusts the folder: open Claude there once and accept.
export function trustCommand(path) {
  return `cd '${String(path).replace(/'/g, "''")}'; claude`;
}

function configFile(home, env) {
  return join(home || env.USERPROFILE || homedir(), '.claude.json');
}

async function readProjects(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    return data && typeof data.projects === 'object' && data.projects ? data.projects : null;
  } catch {
    return null;
  }
}

// Returns { state: 'trusted' | 'not-trusted' | 'unknown', command, key }.
// - trusted: the folder (or a parent folder) has hasTrustDialogAccepted: true.
// - not-trusted: .claude.json was read and says nothing, or false, for the folder.
// - unknown: there is no readable .claude.json with a projects map.
// `home` and `env` are for tests.
export async function trustState(realPath, { home = '', env = process.env } = {}) {
  const command = trustCommand(realPath);
  const projects = await readProjects(configFile(home, env));
  if (!projects) return { state: 'unknown', command, key: null };
  const want = trustKey(realPath);
  let exact = null;
  let parent = null;
  for (const [key, entry] of Object.entries(projects)) {
    const k = String(key).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const accepted = !!(entry && entry.hasTrustDialogAccepted === true);
    if (k === want) exact = { key, accepted };
    else if (accepted && want.startsWith(`${k}/`)) parent = { key, accepted };
  }
  if (exact && exact.accepted) return { state: 'trusted', command, key: exact.key };
  if (parent) return { state: 'trusted', command, key: parent.key };
  return { state: 'not-trusted', command, key: exact ? exact.key : null };
}
