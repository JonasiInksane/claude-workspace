// The input manifest of a run (plan row A6): exactly which inputs it started with, built by the
// run manager when it creates the run and written into run.json, where runs/store.mjs keeps it
// unchanged (frozen) together with manifestSha256, the SHA-256 of its canonical JSON.
//
//   { version: 1,
//     stagePrompts: [{ stage, file: "pipelines/app/<pipeline>/<stage>.md", sha256 }],
//     profile: { sha256 },                         the profile as read at the start
//     projectSettings: { version, sha256 } | null, the same values as run.projectSettings
//     assets: [{ ref, pin, version, sha256, kind, title, file: "inputs/assets/...", archived? }],
//     models: { <stage>: <model> }, efforts: { <stage>: <effort> },   per Claude stage
//     versions: { node, claudeCode },              the same values as run.versions at the start
//     hub: { commit, pipelinesClean } }            the hub's HEAD, and whether pipelines/app had
//                                                  no local changes then (null: unknown)
//
// Hashes are hex SHA-256: a stage prompt's of its text with CRLF read as LF (prompts.mjs
// loadPrompt), so a CRLF and an LF checkout of the hub agree; the profile's of its canonical JSON
// (core/datadir.mjs), so spacing and line endings in the file don't matter. Every Claude stage of
// the pipeline is listed, also one that may be skipped later. Models are the choices at the start
// (catalog.mjs stageModel); a stage records the model it really ran with in its attempt.
import { canonicalJson, sha256Text } from '../core/datadir.mjs';
import { git as realGit } from '../core/git.mjs';
import * as realCatalog from './catalog.mjs';
import * as realPrompts from './prompts.mjs';
import { ASSET_INPUT_RE, assetInputName } from '../attached-assets.mjs';

export const MANIFEST_VERSION = 1;
// git answers in milliseconds; a hub repository that hangs must not hold a start up for long.
export const HUB_GIT_TIMEOUT_MS = 5000;
const PROMPT_RE = /^pipelines\/app\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\.md$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// The manifest's own hash: hex SHA-256 of its canonical JSON.
export const manifestHash = manifest => sha256Text(canonicalJson(manifest));

// The hash a stage prompt template has in a manifest (its text as loadPrompt gives it).
export const templateHash = text => sha256Text(String(text ?? ''));

// The profile's hash, or null without a profile.
export const profileHash = profile => (profile && typeof profile === 'object' ? sha256Text(canonicalJson(profile)) : null);

// The pipeline and stage of a Claude stage's prompt file, or null when it names none.
export function promptOf(stage) {
  const m = PROMPT_RE.exec(String((stage && stage.prompt) || ''));
  return m ? { pipeline: m[1], stage: m[2], file: m[0] } : null;
}

const claudeStages = def => ((def && def.stages) || []).filter(s => s && s.kind === 'claude');

// [{ stage, file, sha256 }] for every Claude stage with a prompt file. Throws when a template is
// missing or fails its checks (loadPrompt), so a run never starts with a prompt it can't build.
export async function stagePromptHashes(root, def, { prompts = realPrompts } = {}) {
  const out = [];
  for (const s of claudeStages(def)) {
    const p = promptOf(s);
    if (!p) continue;
    out.push({ stage: s.id, file: p.file, sha256: templateHash(await prompts.loadPrompt(root, p.pipeline, p.stage)) });
  }
  return out;
}

// { models: { <stage>: model }, efforts: { <stage>: effort } } as catalog.mjs stageModel chooses
// them for a run like `run` (its level, risk tags and values).
export function stageModels(def, { profile = {}, settings = {}, run = null, stageModel = realCatalog.stageModel } = {}) {
  const models = {};
  const efforts = {};
  for (const s of claudeStages(def)) {
    const m = stageModel({ pipeline: def, stage: s, profile: profile || {}, settings: settings || {}, run });
    models[s.id] = m.model;
    efforts[s.id] = m.effort;
  }
  return { models, efforts };
}

// { commit, pipelinesClean } of the hub: its HEAD ('' without git or a commit) and whether
// pipelines/app has no local changes, untracked files included (null when git can't say).
export async function hubState(root, { git = realGit, timeoutMs = HUB_GIT_TIMEOUT_MS } = {}) {
  let commit = '';
  try {
    const out = String(await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeoutMs })).trim();
    commit = SHA_RE.test(out) ? out : '';
  } catch { commit = ''; }
  if (!commit) return { commit: '', pipelinesClean: null };
  try {
    const status = String(await git(root, ['status', '--porcelain', '--untracked-files=all', '--', 'pipelines/app'], { timeoutMs }));
    return { commit, pipelinesClean: status.trim() === '' };
  } catch {
    return { commit, pipelinesClean: null };
  }
}

// One manifest asset from a resolved item (attached-assets.mjs).
export function manifestAsset(item) {
  const a = {
    ref: item.ref, pin: item.pin ?? null, version: item.version, sha256: item.sha256, kind: item.kind,
    title: String(item.title || ''), file: `inputs/${assetInputName(item)}`,
  };
  if (item.archived) a.archived = true;
  return a;
}

// The manifest of a run about to be created. `def` is the pipeline, `run` what the run will be
// (level, riskTags, values: they decide the models), `assets` the resolved items whose copies the
// run gets, `versions` and `projectSettings` the values run.json gets. `hubState` and the catalog's
// `stageModel` can be replaced in tests.
export async function buildManifest({
  root, def, profile = null, settings = {}, run = null, projectSettings = null, assets = [], versions = {},
  prompts = realPrompts, stageModel = realCatalog.stageModel, hub = hubState,
}) {
  const [stagePrompts, hubNow] = await Promise.all([stagePromptHashes(root, def, { prompts }), hub(root)]);
  const { models, efforts } = stageModels(def, { profile, settings, run, stageModel });
  return {
    version: MANIFEST_VERSION,
    stagePrompts,
    profile: { sha256: profileHash(profile) },
    projectSettings: projectSettings ? { version: projectSettings.version, sha256: projectSettings.sha256 } : null,
    assets: assets.map(manifestAsset),
    models,
    efforts,
    versions: { node: versions.node ?? null, claudeCode: versions.claudeCode ?? null },
    hub: { commit: hubNow.commit || '', pipelinesClean: typeof hubNow.pipelinesClean === 'boolean' ? hubNow.pipelinesClean : null },
  };
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Why a manifest can't go into run.json, or ''. Checks the shape buildManifest makes, so a run
// can't record something its page can't show.
export function manifestProblem(m) {
  if (!isObj(m)) return 'the manifest must be an object';
  if (m.version !== MANIFEST_VERSION) return `the manifest has version ${String(m.version).slice(0, 12)}; this app writes version ${MANIFEST_VERSION}`;
  if (!Array.isArray(m.stagePrompts) || !m.stagePrompts.every(p => isObj(p) && typeof p.stage === 'string' && PROMPT_RE.test(String(p.file)) && HEX64_RE.test(String(p.sha256)))) {
    return 'the manifest lists a stage prompt without a stage, a pipelines/app file or a SHA-256';
  }
  if (!isObj(m.profile) || !(m.profile.sha256 === null || HEX64_RE.test(String(m.profile.sha256)))) return 'the manifest has no profile hash';
  if (!(m.projectSettings === null || (isObj(m.projectSettings) && Number.isSafeInteger(m.projectSettings.version) && HEX64_RE.test(String(m.projectSettings.sha256))))) {
    return 'the manifest names project settings without a version and a SHA-256';
  }
  if (!Array.isArray(m.assets) || !m.assets.every(a => isObj(a) && typeof a.ref === 'string' && Number.isSafeInteger(a.version) && HEX64_RE.test(String(a.sha256))
    && ASSET_INPUT_RE.test(String(a.file).replace(/^inputs\//, '')) && String(a.file).startsWith('inputs/'))) {
    return 'the manifest lists an asset without a ref, a version, a SHA-256 or its inputs/assets file';
  }
  if (!isObj(m.models) || !isObj(m.versions) || !isObj(m.hub)) return 'the manifest has no models, versions or hub';
  return '';
}
