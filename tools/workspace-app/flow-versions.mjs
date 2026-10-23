// Flow versions: which version of a flow, and of its images, a launch used, and the record of
// every launch. A flow file changes over time (edited in the app or by hand, on either PC), so a
// session started last week can't be traced to its prompt by the flow's name alone.
//
// flowVersion(root, slug) -> { sha256, hubCommit, committed, images: [{ file, sha256 }], captions }
//   sha256     of the flow file's text with CRLF turned into LF, so a PC that checks the hub out
//              with CRLF (core.autocrlf=true) and one with LF get the same hash for the same flow
//   hubCommit  the hub's HEAD (git rev-parse HEAD); '' without git, a repository or a commit
//   committed  true when the file's text (CRLF as LF) equals its text at hubCommit, so that
//              commit alone tells which prompt ran; false for a new or edited flow, or without git
//   images     the images a run passes (flows.mjs flowImages, the run's own list), sorted by file
//              name, each with the SHA-256 of its bytes
//   captions   the SHA-256 of those images' captions as canonical JSON ('' when none has one):
//              captions go into the prompt too
// It is null for a flow name that isn't one, or a flow file that can't be read.
//
// <dataDir>/flow-runs.jsonl gets one line per launch that started (a failed launch writes none):
//   {"at":"…","flow":"<slug>","version":{…},"target":"hub|project|agent","project":"…","agent":"…","sessionId":"<uuid>",
//    "assets":[{"ref":"shared:style-guide","version":2,"sha256":"…"}]}
// For a flow that runs in any project (project "*"), `project` is the one the run chose.
// `assets` are the exact versions the session was given: the flow's own attachments and its
// project's (attached-assets.mjs). Lines from before assets were recorded read as [].
// readFlowRuns gives the newest records of one flow, and versionChanges says what changed since.
// The session's own line in sessions.jsonl (launch.mjs) gets the flow's slug, sha256, hubCommit
// and committed as well (sessionFlowRef), so it says which version ran even when this file's
// line could not be written.
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { flowFile, flowImages, readCaptions, SLUG_RE } from '../lib/flows.mjs';
import { appendJsonl, canonicalJson, readJsonl, sha256File, sha256Text } from './core/datadir.mjs';
import { git } from './core/git.mjs';

export const FLOW_RUNS_FILE = 'flow-runs.jsonl';
export const RECENT_RUNS = 20;
// git answers in milliseconds; a hub repository that hangs must not hold a launch up for long.
export const VERSION_GIT_TIMEOUT_MS = 5000;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // SHA-1, or SHA-256 repositories
const HEX64_RE = /^[0-9a-f]{64}$/;

export const flowRunsFile = dataDir => join(dataDir, FLOW_RUNS_FILE);
export const normalizeText = text => String(text).replace(/\r\n/g, '\n');

// Plain code-unit order, the same on every PC (localeCompare depends on the ICU data).
const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

// { hubCommit, committed } for flows/<slug>.md. The path inside the repository comes from the
// hub's own place in it (rev-parse --show-prefix), so a hub inside a bigger repository still
// compares the right file. Any git failure gives '' and false.
async function hubState(root, slug, normalized, timeoutMs) {
  let prefix = '';
  let sha = '';
  try {
    // Two lines: the prefix ('' at the top, else "hub/"), then the commit.
    [prefix = '', sha = ''] = (await git(root, ['rev-parse', '--show-prefix', 'HEAD'], { timeoutMs })).split(/\r?\n/);
  } catch {
    return { hubCommit: '', committed: false };
  }
  if (!SHA_RE.test(sha)) return { hubCommit: '', committed: false };
  try {
    // cat-file gives the blob as stored, with no line-ending conversion; 128: no such file there.
    const r = await git(root, ['cat-file', 'blob', `${sha}:${prefix}flows/${slug}.md`], { full: true, okCodes: [0, 128], timeoutMs });
    return { hubCommit: sha, committed: r.code === 0 && normalizeText(r.stdout) === normalized };
  } catch {
    return { hubCommit: sha, committed: false };
  }
}

// The images a run passes (their full paths), each with the SHA-256 of its bytes. One that is
// gone between the listing and the hash is left out: the run couldn't read it either.
async function imageVersions(files) {
  const hashed = await Promise.all(files.map(async file => {
    try { return { file: basename(file), sha256: await sha256File(file) }; } catch { return null; }
  }));
  return hashed.filter(Boolean).sort(byFile);
}

// The SHA-256 of the captions (`all`: captions.json's content) these images have, the way
// runPrompt uses them (trimmed, empty ones left out), or '' when none has one.
function captionsHash(all, images) {
  const used = {};
  for (const { file } of images) {
    const c = typeof all[file] === 'string' ? all[file].trim() : '';
    if (c) used[file] = c;
  }
  return Object.keys(used).length ? sha256Text(canonicalJson(used)) : '';
}

// The version of flows/<slug>.md as it is now (see the top of this file). A run passes what it
// built its prompt from instead: `text` (the flow file as it read it, tools/lib/flows.mjs getFlow),
// `images` (its list of image paths) and `captions` (captions.json as it read it), so a file that
// changes in between can't give the record another version than the one that ran. Never throws
// for a git problem; `timeoutMs` caps each git call.
export async function flowVersion(root, slug, { timeoutMs = VERSION_GIT_TIMEOUT_MS, text, images, captions } = {}) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  let read = text;
  if (typeof read !== 'string') {
    try { read = await readFile(flowFile(root, slug), 'utf8'); } catch { return null; }
  }
  const normalized = normalizeText(read);
  const files = Array.isArray(images) ? images : flowImages(root, slug);
  const [hub, hashed] = await Promise.all([hubState(root, slug, normalized, timeoutMs), imageVersions(files)]);
  const all = captions && typeof captions === 'object' && !Array.isArray(captions) ? captions : readCaptions(root, slug);
  return {
    sha256: sha256Text(normalized), hubCommit: hub.hubCommit, committed: hub.committed, images: hashed, captions: captionsHash(all, hashed),
  };
}

// What a flow launch's line in sessions.jsonl records of the flow (launch.mjs recordSession):
// { slug, sha256, hubCommit, committed } of the version that ran ('' and false without one).
export const sessionFlowRef = (slug, version) => ({
  slug, sha256: version ? version.sha256 : '', hubCommit: version ? version.hubCommit : '', committed: !!(version && version.committed),
});

// Appends one launch to flow-runs.jsonl (the folder is made on first use). Throws when the line
// can't be written; the caller decides whether that matters (a started session stays started).
// `assets`: [{ ref, version, sha256 }] (attached-assets.mjs assetRecords).
export async function recordFlowRun(dataDir, { flow, version = null, target, project = '', agent = '', sessionId = '', assets = [] }, now = new Date()) {
  await appendJsonl(flowRunsFile(dataDir), {
    at: now.toISOString(), flow, version: version || null, target, project: project || '', agent: agent || '', sessionId: sessionId || '',
    assets: cleanAssets(assets),
  });
}

const str = v => (typeof v === 'string' ? v : '');
// A launch time the page can show: an ISO timestamp (recordFlowRun writes toISOString()), else ''.
const isoTime = v => (/^\d{4}-\d\d-\d\dT/.test(str(v)) && !Number.isNaN(Date.parse(v)) ? v : '');

// A version from a record, with only the fields and types flowVersion writes (null when it has
// none), so a hand-edited or torn line can't break the page that shows it. `committed` needs the
// commit it is committed in.
function cleanVersion(v) {
  if (!v || typeof v !== 'object' || !HEX64_RE.test(str(v.sha256))) return null;
  const images = (Array.isArray(v.images) ? v.images : [])
    .filter(i => i && typeof i === 'object' && str(i.file) && HEX64_RE.test(str(i.sha256)))
    .map(i => ({ file: i.file, sha256: i.sha256 }));
  const hubCommit = SHA_RE.test(str(v.hubCommit)) ? v.hubCommit : '';
  return {
    sha256: v.sha256, hubCommit, committed: v.committed === true && hubCommit !== '', images,
    captions: HEX64_RE.test(str(v.captions)) ? v.captions : '',
  };
}

// The assets of a record with only { ref, version, sha256 } each, and only entries that have all
// three, so a hand-edited or torn line can't break the page.
function cleanAssets(list) {
  return (Array.isArray(list) ? list : [])
    .filter(a => a && typeof a === 'object' && str(a.ref) && Number.isSafeInteger(a.version) && a.version >= 1 && HEX64_RE.test(str(a.sha256)))
    .map(a => ({ ref: a.ref, version: a.version, sha256: a.sha256 }));
}

// The newest `limit` launches of one flow, newest first (the file's own order: lines are only
// ever appended). Lines of other flows, broken lines and lines that aren't records are skipped.
export async function readFlowRuns(dataDir, slug, { limit = RECENT_RUNS } = {}) {
  const { rows } = await readJsonl(flowRunsFile(dataDir));
  const mine = rows.filter(r => r && typeof r === 'object' && !Array.isArray(r) && r.flow === slug);
  return (limit > 0 ? mine.slice(-limit) : []).reverse().map(r => ({
    at: isoTime(r.at), flow: slug, version: cleanVersion(r.version), target: str(r.target), project: str(r.project),
    agent: str(r.agent), sessionId: str(r.sessionId), assets: cleanAssets(r.assets),
  }));
}

// What changed between a recorded version and the current one: [] for nothing, otherwise
// 'prompt' (the flow file's text) and/or 'images' (an image added, removed or changed, or a
// caption). Without a current version (the flow file is gone) there is nothing to compare: [].
// A record without a version gives ['unknown'].
export function versionChanges(was, now) {
  if (!now) return [];
  if (!was) return ['unknown'];
  const out = [];
  if (was.sha256 !== now.sha256) out.push('prompt');
  const imagesKey = v => canonicalJson([(Array.isArray(v.images) ? v.images : []).map(i => [i.file, i.sha256]), v.captions || '']);
  if (imagesKey(was) !== imagesKey(now)) out.push('images');
  return out;
}
