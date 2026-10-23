// The run file readers that the runs routes (routes/runs.mjs) and the Ask context (runs/context.mjs)
// share: one file of a run folder read up to a cap, a run's JSON file, the first of several text
// files with secrets redacted, and the run's diff split into its files. They lived in the routes
// module; they are here so the engine side reads a run exactly the way the review routes do,
// without importing a routes module.
//
// Safety (R22): every path is relative to the run folder and comes from the callers' constants or
// the app's own listings (the diff's file headers, a gate's summary.json), never from the page.
// Text is cut at TEXT_MAX and passed through gates/secrets.mjs `redact` before it leaves here.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '../gates/secrets.mjs';
import { runDir } from './store.mjs';

export const TEXT_MAX = 2 * 1024 * 1024;
// GET /api/run-file names and the run file each one reads (relative to the run folder).
export const RUN_FILES = Object.freeze({
  diff: ['final/diff.patch', 'inputs/diff.patch'],
  proof: ['final/proof.md'],
  review: ['final/review.json'],
  'commit-msg': ['final/commit-msg.txt'],
  'stopped-patch': ['final/stopped.patch'],
  answer: ['final/answer.json'],
  diagnosis: ['final/diagnosis.json'],
  triage: ['final/triage.json'],
  // The architecture scan's candidates ({ref, probe, path, line, text}) for the decide gate.
  candidates: ['inputs/candidates.json'],
});
export const DIFF_FILE_MAX = 400;

// A file read up to `max` bytes: { text, truncated }, or null when it doesn't exist (or is a
// folder). One byte more than allowed is read, so a cut file is told apart from an exact fit.
export async function readCapped(file, max = TEXT_MAX) {
  let fh;
  try { fh = await open(file, 'r'); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = Math.min(st.size, max) + 1;
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    return { text: buf.subarray(0, Math.min(bytesRead, max)).toString('utf8'), truncated: bytesRead > max };
  } finally {
    await fh.close();
  }
}

// The absolute path of `rel` (relative, posix) inside the run's folder.
export const runFile = (dataDir, run, rel) => join(runDir(dataDir, run), ...rel.split('/'));

// A JSON file of the run, or null when it is missing, cut or not JSON.
export async function readRunJson(dataDir, run, rel) {
  const r = await readCapped(runFile(dataDir, run, rel));
  if (!r || r.truncated) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

// The first of `rels` that exists, redacted and capped: { text, truncated, rel } or null.
export async function firstText(dataDir, run, rels, max = TEXT_MAX) {
  for (const rel of rels) {
    const r = await readCapped(runFile(dataDir, run, rel), max);
    if (r) return { text: redact(r.text), truncated: r.truncated, rel };
  }
  return null;
}

// Splits a unified git diff into its files: [{ path, text, add, del }]. The path comes from the
// "+++ b/" line (or "--- a/" for a deletion, or the "diff --git" header for binary and rename-only
// parts), so only paths the diff itself names are ever offered.
export function splitDiff(diff) {
  const out = [];
  const parts = String(diff || '').split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '));
  for (const text of parts) {
    const lines = text.split('\n');
    const plus = lines.find(l => l.startsWith('+++ '));
    const minus = lines.find(l => l.startsWith('--- '));
    const strip = (l, pre) => l.slice(4).replace(/\t$/, '').replace(new RegExp(`^${pre}/`), '');
    let path = '';
    if (plus && !/^\+\+\+ \/dev\/null/.test(plus)) path = strip(plus, 'b');
    else if (minus && !/^--- \/dev\/null/.test(minus)) path = strip(minus, 'a');
    else {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
      path = m ? m[2] : '';
    }
    if (!path || path.length > DIFF_FILE_MAX) continue;
    let add = 0;
    let del = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    out.push({ path, text, add, del });
  }
  return out;
}

// The run's diff (final/diff.patch, else inputs/diff.patch), redacted, as its files.
export async function runDiff(dataDir, run) {
  const r = await firstText(dataDir, run, RUN_FILES.diff);
  return r ? { files: splitDiff(r.text), truncated: r.truncated } : { files: [], truncated: false };
}
