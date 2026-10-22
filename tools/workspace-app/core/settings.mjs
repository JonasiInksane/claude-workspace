// Per-PC app settings: dataDir/settings.json (SPEC 2.13).
//
//   { "version": 1, "shortcuts": { "singleKey": true }, "notify": { "web": true },
//     "fun": { "celebration": true, "streak": false },
//     "isolation": { "<project>": "worktree" | "branch" },
//     "models": { "<pipeline>.<stage>": { "model": "opus", "effort": "high" } } }
//
// loadSettings never fails: a missing file gives the defaults, and a hand-edited file keeps only
// the values that are valid. saveSettings takes a patch from the page, checks every value, merges
// it into what is on disk (null removes an isolation or models entry) and writes atomically.
// The theme is not here: it stays in localStorage['ws-theme'], like the navigator's.
import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EFFORTS, MODEL_RE } from '../../lib/prompt-file.mjs';
import { JSON_PARSE_CODE, PROJECT_RE, readJsonSync, writeJsonAtomicSync } from './datadir.mjs';

export const ISOLATION_MODES = ['worktree', 'branch'];
// "<pipeline>.<stage>", for example "refactor.scope".
export const MODEL_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The on/off settings, by section.
const SWITCHES = { shortcuts: ['singleKey'], notify: ['web'], fun: ['celebration', 'streak'] };
const SECTIONS = ['version', ...Object.keys(SWITCHES), 'isolation', 'models'];

export const settingsFile = dataDir => join(resolve(dataDir), 'settings.json');

// A fresh copy of the defaults. The streak is off by default (plan section 6).
export function defaultSettings() {
  return {
    version: 1,
    shortcuts: { singleKey: true },
    notify: { web: true },
    fun: { celebration: true, streak: false },
    isolation: {},
    models: {},
  };
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The problem with one models entry ({model, effort}), or ''. `partial` allows null values
// (a patch that removes one of the two).
function modelEntryError(key, entry, partial) {
  if (!isPlain(entry)) return `models.${key} must be an object with model and effort`;
  for (const k of Object.keys(entry)) {
    if (k !== 'model' && k !== 'effort') return `models.${key}.${k} is not a setting`;
  }
  const { model, effort } = entry;
  if (model !== undefined && !(partial && model === null)) {
    if (typeof model !== 'string' || !MODEL_RE.test(model)) return `models.${key}.model must be an alias such as opus or sonnet, or a full model name`;
  }
  if (effort !== undefined && !(partial && effort === null)) {
    if (!EFFORTS.includes(effort)) return `models.${key}.effort must be one of ${EFFORTS.join(', ')}`;
  }
  if (!partial && model === undefined && effort === undefined) return `models.${key} needs a model or an effort`;
  return '';
}

// Checks a patch from the page. Returns '' or a plain-English problem.
export function settingsPatchError(patch) {
  if (!isPlain(patch)) return 'Settings must be sent as an object.';
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (!SECTIONS.includes(key)) return `"${key}" is not a setting.`;
    if (key === 'version') {
      if (value !== 1) return 'version must be 1.';
      continue;
    }
    if (!isPlain(value)) return `${key} must be an object.`;
    for (const [k, v] of Object.entries(value)) {
      if (SWITCHES[key]) {
        if (!SWITCHES[key].includes(k)) return `"${key}.${k}" is not a setting.`;
        if (typeof v !== 'boolean') return `${key}.${k} must be true or false.`;
      } else if (key === 'isolation') {
        if (!PROJECT_RE.test(k)) return `"${k}" is not a project name.`;
        if (v !== null && !ISOLATION_MODES.includes(v)) return `isolation.${k} must be worktree or branch.`;
      } else {
        if (!MODEL_KEY_RE.test(k)) return `"${k}" is not a pipeline stage. Use <pipeline>.<stage>, for example refactor.scope.`;
        if (v === null) continue;
        const problem = modelEntryError(k, v, true);
        if (problem) return `${problem}.`;
      }
    }
  }
  return '';
}

// Keeps the valid values of a settings object read from disk; everything else gets its default.
export function cleanSettings(raw) {
  const out = defaultSettings();
  if (!isPlain(raw)) return out;
  for (const [section, names] of Object.entries(SWITCHES)) {
    for (const name of names) {
      if (isPlain(raw[section]) && typeof raw[section][name] === 'boolean') out[section][name] = raw[section][name];
    }
  }
  if (isPlain(raw.isolation)) {
    for (const [k, v] of Object.entries(raw.isolation)) {
      if (PROJECT_RE.test(k) && ISOLATION_MODES.includes(v)) out.isolation[k] = v;
    }
  }
  if (isPlain(raw.models)) {
    for (const [k, v] of Object.entries(raw.models)) {
      if (!MODEL_KEY_RE.test(k) || modelEntryError(k, v, false)) continue;
      out.models[k] = {};
      if (v.model !== undefined) out.models[k].model = v.model;
      if (v.effort !== undefined) out.models[k].effort = v.effort;
    }
  }
  return out;
}

// The file as it is on disk: { raw, broken, error }. Only a file that isn't valid JSON is broken;
// a read error such as EBUSY (a scanner holding the file) is returned as `error`, because the
// file itself may be fine.
function readRaw(file) {
  try {
    return { raw: readJsonSync(file, null), broken: false, error: null };
  } catch (err) {
    if (err && err.code === JSON_PARSE_CODE) return { raw: null, broken: true, error: null };
    return { raw: null, broken: false, error: err };
  }
}

// The settings of this PC, with defaults filled in. Never throws for a missing or broken file.
export function loadSettings(dataDir) {
  return cleanSettings(readRaw(settingsFile(dataDir)).raw);
}

// Merges a checked patch: sections merge key by key; null removes an isolation or models entry;
// a models entry merges field by field (null removes a field, and an empty entry is removed).
function merge(current, patch) {
  const out = JSON.parse(JSON.stringify(current));
  for (const [section, value] of Object.entries(patch)) {
    if (section === 'version') continue;
    for (const [k, v] of Object.entries(value)) {
      if (section === 'models') {
        if (v === null) { delete out.models[k]; continue; }
        const entry = { ...(out.models[k] || {}) };
        for (const [f, fv] of Object.entries(v)) {
          if (fv === null) delete entry[f];
          else entry[f] = fv;
        }
        if (Object.keys(entry).length) out.models[k] = entry;
        else delete out.models[k];
      } else if (v === null) {
        delete out[section][k];
      } else {
        out[section][k] = v;
      }
    }
  }
  return out;
}

// Checks and saves a patch; returns the full settings now on disk. A bad patch throws an Error
// with status 400 and nothing is written. A settings.json that isn't valid JSON is kept as
// settings.<time>.bad.json before the new file is written. A settings.json that can't be read
// right now (EBUSY, EPERM, EACCES) throws an Error with status 503 and nothing is written, so
// the saved choices are never replaced by the defaults.
export function saveSettings(dataDir, patch) {
  const problem = settingsPatchError(patch);
  if (problem) {
    const err = new Error(problem);
    err.status = 400;
    throw err;
  }
  const file = settingsFile(dataDir);
  const { raw, broken, error } = readRaw(file);
  if (error) {
    const err = new Error(`settings.json could not be read (${error.code || error.message}); nothing was saved. Try again in a moment.`);
    err.status = 503;
    throw err;
  }
  if (broken) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { renameSync(file, join(resolve(dataDir), `settings.${stamp}.bad.json`)); } catch { /* keep going */ }
  }
  const next = cleanSettings(merge(cleanSettings(raw), patch));
  writeJsonAtomicSync(file, next);
  return next;
}
