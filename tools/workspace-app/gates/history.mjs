// Check history: one JSON line per finished check level, in
// <dataDir>/checks/<project>/history.jsonl, so the cockpit can show the last quick, standard and
// paranoid result (and a short list) without opening every run folder.
//
// - A line is {at, runId, level, treeMode, baseSha, node, result, chip, durationMs,
//   counts: {new, known, flaky}} (spec 2.10); historyLine() builds it from a check summary.
// - Lines go through core/datadir appendJsonl and readJsonl: a write cut off by a crash costs one
//   line, and readers skip lines that are not valid JSON.
// - Everything is async: the routes read this on request paths.
import { appendJsonl, projectPaths, readJsonl } from '../core/datadir.mjs';

export const LEVELS = ['quick', 'standard', 'paranoid'];

// The history file of a project. Throws on a project name that is not valid.
export function historyFile(dataDir, project) {
  return projectPaths(dataDir, project).checksHistory;
}

// The history line for a finished check summary (gates/check.mjs runChecks).
export function historyLine(summary, { runId = null, at } = {}) {
  const c = summary?.counts || {};
  return {
    at: at || summary?.endedAt || new Date().toISOString(),
    runId,
    level: summary?.level,
    treeMode: summary?.treeMode,
    baseSha: summary?.baseSha,
    node: summary?.node,
    result: summary?.result,
    chip: summary?.chip || '',
    durationMs: summary?.durationMs ?? 0,
    counts: { new: c.new || 0, known: c.known || 0, flaky: c.flaky || 0 },
  };
}

// Appends one line and returns it (with `at` filled in when missing).
export async function appendHistory(dataDir, project, line) {
  const file = historyFile(dataDir, project);
  const row = { at: new Date().toISOString(), ...line };
  await appendJsonl(file, row);
  return row;
}

async function readLines(dataDir, project) {
  const { rows } = await readJsonl(historyFile(dataDir, project));
  return rows.filter(r => r && typeof r === 'object' && !Array.isArray(r));
}

// The most recent lines first, at most `limit` (GET /api/checks shows 20).
export async function readHistory(dataDir, project, { limit = 20 } = {}) {
  const rows = await readLines(dataDir, project);
  return rows.reverse().slice(0, Math.max(0, limit));
}

// The last line per level: {quick, standard, paranoid}, each a history line or null.
export async function lastPerLevel(dataDir, project) {
  const out = Object.fromEntries(LEVELS.map(l => [l, null]));
  for (const row of await readLines(dataDir, project)) {
    if (LEVELS.includes(row.level)) out[row.level] = row;
  }
  return out;
}
