// The project Settings tab's form without the DOM (views/project/settings.js draws it): the fields
// the editor holds, whether they differ from a saved version, the body of a save, the checks the
// server makes (mirrored here so a mistake shows while you type; the server checks every save
// again and stays the authority), the server's refusal split back into the fields it names, and
// the field-by-field difference of two versions for Compare.
//
// Fields: { rules, model, effort, permissionMode, allowedTools, assets: [{ ref, pin }] }, where
// allowedTools is the field's text ("Read, Grep") and pin is null (the latest version) or a
// version number. "The same" means the same after the server's own tidying
// (project-settings.mjs): rules without CR, leading blank lines and trailing white space; tools
// split at commas and spaces outside parentheses, each kept once, joined with ", "; a trimmed
// model. So the editor calls a draft unchanged exactly when a save would answer "Nothing changed".
//
// Everything here is pure; parts/settings-form.test.mjs tests it.

// The same patterns as tools/lib/prompt-file.mjs (MODEL_RE, TOOL_RULE_RE) and project-settings.mjs
// (control characters other than tab and newline). Keep them in step.
export const MODEL_RE = /^[A-Za-z0-9][\w.:\-[\]]{0,79}$/;
export const TOOL_RULE_RE = /^[A-Za-z][\w-]*(\([^()\r\n"]{1,200}\))?$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// What GET /api/project-settings sends as `limits`, until it has answered.
export const DEFAULT_LIMITS = Object.freeze({ rules: 20000, assets: 50, allowedTools: 20 });
export const FIELD_KEYS = Object.freeze(['rules', 'model', 'effort', 'permissionMode', 'allowedTools', 'assets']);

// The words for a permission mode in the select (the flow editor's words).
export const PERMISSION_WORDS = Object.freeze({
  manual: 'Manual: asks before edits and commands',
  plan: 'Plan: reads and proposes, changes nothing',
  acceptEdits: 'Accept edits: edits files without asking',
  auto: 'Auto',
});

const fmt = n => Number(n).toLocaleString('en-US');

// ---------------------------------------------------------------- tidying, as the server does

export const normalizeRules = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

// "Read, Grep Bash(git log *)" -> ['Read', 'Grep', 'Bash(git log *)']: commas, spaces and
// newlines separate rules, except inside parentheses (prompt-file.mjs splitToolRules).
export function splitToolRules(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,\s]/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// The rules each once, in order.
export const toolList = text => [...new Set(splitToolRules(text))];
export const normalizeTools = text => toolList(text).join(', ');

export const pinText = pin => (Number.isSafeInteger(pin) && pin >= 1 ? `v${pin}` : 'latest');

export const emptyFields = () => ({ rules: '', model: '', effort: '', permissionMode: '', allowedTools: '', assets: [] });

// A saved version (GET /api/project-settings `current`, or one version) as fields; null (no
// settings yet) gives the empty ones.
export function fieldsOf(s) {
  if (!s || typeof s !== 'object') return emptyFields();
  const d = s.defaults && typeof s.defaults === 'object' ? s.defaults : {};
  return {
    rules: typeof s.rules === 'string' ? s.rules : '',
    model: typeof d.model === 'string' ? d.model : '',
    effort: typeof d.effort === 'string' ? d.effort : '',
    permissionMode: typeof d.permissionMode === 'string' ? d.permissionMode : '',
    allowedTools: typeof s.allowedTools === 'string' ? s.allowedTools : '',
    assets: Array.isArray(s.assets)
      ? s.assets.filter(a => a && typeof a.ref === 'string').map(a => ({ ref: a.ref, pin: Number.isSafeInteger(a.pin) ? a.pin : null }))
      : [],
  };
}

// The fields as the server would store them.
export function tidyFields(f) {
  const x = f || emptyFields();
  return {
    rules: normalizeRules(x.rules),
    model: String(x.model ?? '').trim(),
    effort: String(x.effort ?? '').trim(),
    permissionMode: String(x.permissionMode ?? '').trim(),
    allowedTools: normalizeTools(x.allowedTools),
    assets: (Array.isArray(x.assets) ? x.assets : []).map(a => ({ ref: String(a.ref ?? '').trim(), pin: Number.isSafeInteger(a.pin) ? a.pin : null })),
  };
}

export const sameFields = (a, b) => JSON.stringify(tidyFields(a)) === JSON.stringify(tidyFields(b));

// The body of POST /api/project-settings: every field, so the saved version is what the editor
// shows. `basedOn` is the version the editor opened (0 when there was none).
export function saveBody(project, basedOn, f) {
  return {
    project,
    basedOn: Number.isSafeInteger(basedOn) && basedOn >= 1 ? basedOn : 0,
    rules: String(f.rules ?? ''),
    defaults: { model: String(f.model ?? '').trim(), effort: String(f.effort ?? ''), permissionMode: String(f.permissionMode ?? '') },
    allowedTools: String(f.allowedTools ?? ''),
    assets: (f.assets || []).map(a => ({ ref: a.ref, pin: Number.isSafeInteger(a.pin) ? a.pin : null })),
  };
}

// ---------------------------------------------------------------- checks while typing

const noProblems = () => ({ rules: [], model: [], effort: [], permissionMode: [], allowedTools: [], assets: [] });

// The problems of the fields, by field: the server's checks for what a person can get wrong in
// the editor. `limits` and `choices` come from GET /api/project-settings.
export function checkFields(f, limits = DEFAULT_LIMITS, choices = null) {
  const out = noProblems();
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const rules = normalizeRules(f.rules);
  if (rules.length > lim.rules) out.rules.push(`The rules are ${fmt(rules.length - lim.rules)} characters over the limit of ${fmt(lim.rules)}.`);
  const bad = CONTROL_RE.exec(rules);
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    out.rules.push(`Line ${rules.slice(0, bad.index).split('\n').length} has a control character (U+${code}); remove it.`);
  }
  const model = String(f.model ?? '').trim();
  if (model && !MODEL_RE.test(model)) out.model.push('Use an alias such as opus or sonnet, or a full model name (letters, digits, . _ : - [ ]).');
  for (const key of ['effort', 'permissionMode']) {
    const v = String(f[key] ?? '');
    const list = choices && Array.isArray(choices[key]) ? choices[key] : null;
    if (v && list && !list.includes(v)) out[key].push(`"${v}" is not one of ${list.join(', ')}.`);
  }
  const tools = toolList(f.allowedTools);
  if (tools.length > lim.allowedTools) out.allowedTools.push(`${tools.length} rules; at most ${lim.allowedTools}.`);
  for (const r of tools.filter(x => !TOOL_RULE_RE.test(x))) {
    out.allowedTools.push(`"${r.slice(0, 80)}" is not a tool rule. Use names like Read or Bash(npm test:*).`);
  }
  const assets = Array.isArray(f.assets) ? f.assets : [];
  if (assets.length > lim.assets) out.assets.push(`${assets.length} assets attached; at most ${lim.assets}.`);
  return out;
}

export const problemCount = problems => Object.values(problems || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);

// ---------------------------------------------------------------- the server's refusal

// Which field a sentence of a 400 names (the sentences of project-settings.mjs). A piece that
// matches none continues the sentence before it (some sentences hold "; " themselves).
const PROBLEM_FIELDS = [
  [/^(rules must be |the rules (are|have) )/, 'rules'],
  [/^defaults\.model /, 'model'],
  [/^defaults\.effort /, 'effort'],
  [/^defaults\.permissionMode /, 'permissionMode'],
  [/^allowedTools( must| has |: )/, 'allowedTools'],
  [/^assets( must| has |\[\d+\])/, 'assets'],
  [/^(defaults[. ]|"[^"]*" is not a project setting|and \d+ more$)/, 'other'],
];
const NOT_SAVED = 'The settings were not saved: ';

// A 400's message ("The settings were not saved: a; b; c.") as { rules, model, effort,
// permissionMode, allowedTools, assets, other }: lists of the server's sentences. Any other
// message goes to `other` whole.
export function splitProblems(message) {
  const out = { ...noProblems(), other: [] };
  const text = String(message ?? '').trim();
  if (!text.startsWith(NOT_SAVED)) {
    if (text) out.other.push(text);
    return out;
  }
  const pieces = [];
  for (const piece of text.slice(NOT_SAVED.length).replace(/\.$/, '').split('; ')) {
    if (!pieces.length || PROBLEM_FIELDS.some(([re]) => re.test(piece))) pieces.push(piece);
    else pieces[pieces.length - 1] += `; ${piece}`;
  }
  for (const p of pieces) {
    const hit = PROBLEM_FIELDS.find(([re]) => re.test(p));
    out[hit ? hit[1] : 'other'].push(`${p}.`);
  }
  return out;
}

// ---------------------------------------------------------------- comparing two versions

const FIELD_ROWS = [['model', 'Model'], ['effort', 'Effort'], ['permissionMode', 'Permission mode'], ['allowedTools', 'Pre-approved tools'], ['assets', 'Attached assets']];
const assetsText = list => list.map(a => `${a.ref} (${pinText(a.pin)})`).join(', ');

// Every setting but the rules, side by side: [{ key, label, before, after, changed }], with the
// values as text ('' for an empty one; the view says what empty means).
export function fieldDiff(a, b) {
  const x = tidyFields(a);
  const y = tidyFields(b);
  return FIELD_ROWS.map(([key, label]) => {
    const before = key === 'assets' ? assetsText(x.assets) : x[key];
    const after = key === 'assets' ? assetsText(y.assets) : y[key];
    return { key, label, before, after, changed: before !== after };
  });
}

// What changed in the attached assets from `a` to `b`: [{ ref, change: 'added' | 'removed' |
// 'pin', before, after }] (pins; null is the latest), added and re-pinned in b's order, then the
// removed ones in a's order.
export function assetChanges(a, b) {
  const before = new Map(tidyFields(a).assets.map(x => [x.ref, x.pin]));
  const after = tidyFields(b).assets;
  const out = [];
  for (const { ref, pin } of after) {
    if (!before.has(ref)) out.push({ ref, change: 'added', before: null, after: pin });
    else if (before.get(ref) !== pin) out.push({ ref, change: 'pin', before: before.get(ref), after: pin });
  }
  const kept = new Set(after.map(x => x.ref));
  for (const [ref, pin] of before) if (!kept.has(ref)) out.push({ ref, change: 'removed', before: pin, after: null });
  return out;
}

// The rules' length as the server counts it, against the limit: { count, limit, state: 'ok' |
// 'near' (90 % and up) | 'over', text: "1,234 / 20,000 characters" }.
export function rulesCount(text, limit = DEFAULT_LIMITS.rules) {
  const count = normalizeRules(text).length;
  const state = count > limit ? 'over' : count >= limit * 0.9 ? 'near' : 'ok';
  return { count, limit, state, text: `${fmt(count)} / ${fmt(limit)} characters` };
}
