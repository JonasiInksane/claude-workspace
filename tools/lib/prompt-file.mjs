// A first prompt for a new Claude session, handed over in a temp file.
//
// The workspace app writes the file; tools/workspace-app/claude-prompt.mjs or
// tools/agent-session.mjs --prompt-file reads it, deletes it, and passes the prompt to claude as
// an argument from Node. Why not on the command line: Windows PowerShell 5.1 mangles double
// quotes inside arguments it passes to programs, and a prompt can contain anything.
//
// File content (JSON): { "prompt": "...", "readDirs": ["C:\\abs\\folder", ...] }
// readDirs are folders outside the session's working folder that it may read without asking
// (for example a flow's reference images); they go into the session's --settings.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const promptDir = () => join(tmpdir(), 'claude-workspace', 'prompts');

export function writePromptFile({ prompt, readDirs = [] }) {
  mkdirSync(promptDir(), { recursive: true });
  const file = join(promptDir(), `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ prompt, readDirs }), 'utf8');
  return file;
}

// Reads the file and, when it is valid and in promptDir(), deletes it (a prompt is used once;
// a file named by mistake, such as a settings file, is never deleted). Throws with a plain
// message when it is missing or malformed.
export function takePromptFile(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`could not read the prompt file: ${e.message}`); }
  const prompt = data && typeof data.prompt === 'string' ? data.prompt : '';
  if (!prompt.trim()) throw new Error('the prompt is empty');
  const readDirs = Array.isArray(data.readDirs) ? data.readDirs : [];
  if (!readDirs.every(d => typeof d === 'string' && isAbsolute(d))) throw new Error('readDirs must be absolute folder paths');
  const rel = relative(promptDir(), resolve(file));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
  return { prompt, readDirs };
}

// The prompt as claude's last argument. "--" ends the options, so a prompt that starts with
// "-" stays a prompt.
export const promptArgs = prompt => (prompt.startsWith('-') ? ['--', prompt] : [prompt]);
