// The intent box: "What do you want to do?" text routed to a pipeline by keyword, so the
// launcher opens prefilled. Rules are tried in order and the first match wins; with no match the
// text goes to Explain, which is read-only and cheap.
//
// The fix rule matches the words fix and close, plus the project's own finding id pattern
// (profile.findings.idPattern). No project's ids are written here: the hub repo is public.

export const ROUTES = [
  [/refactor|split|untangle|dedupe|clean ?up|move .* into|rename/i, 'refactor'],
  [/\b(fix|close)\b/i, 'fix'],
  [/\bwhy\b|bug|broken|error|crash|twice|fails?\b/i, 'debug'],
  [/review|look over/i, 'review'],
  [/architect|cycle|boundar|probe/i, 'architecture'],
  [/check my|run (the )?checks/i, 'check'],
  [/\badd\b|new feature|let (users|staff)|support for|can send/i, 'feature'],
  [/how|what|explain|understand|where/i, 'explain'],
];
const FIX_INDEX = ROUTES.findIndex(r => r[1] === 'fix');
const MAX_TEXT = 2000;

// The profile's finding id pattern as a RegExp (case-sensitive, as written), or null.
function idRegex(idPattern) {
  if (!idPattern || typeof idPattern !== 'string' || idPattern.length > 500) return null;
  try { return new RegExp(idPattern); } catch { return null; }
}

// Routes the text. Returns { pipeline, findingId? }; findingId is set only for fix, when the
// text names an id that matches the profile's pattern.
export function routeIntent(text, { idPattern } = {}) {
  const t = String(text || '').slice(0, MAX_TEXT);
  if (!t.trim()) return { pipeline: 'explain' };
  const idRe = idRegex(idPattern);
  const id = idRe ? (t.match(idRe) || [])[0] : '';
  for (let i = 0; i < ROUTES.length; i++) {
    const [re, pipeline] = ROUTES[i];
    if (re.test(t)) return pipeline === 'fix' && id ? { pipeline, findingId: id } : { pipeline };
    // The id rule sits right after the fix words, so "refactor X" still goes to refactor.
    if (i === FIX_INDEX && id) return { pipeline: 'fix', findingId: id };
  }
  return { pipeline: 'explain' };
}

// The same rules for the page, as { pattern, flags, pipeline } (the page builds RegExps).
export function routesForUi({ idPattern } = {}) {
  const out = [];
  ROUTES.forEach(([re, pipeline], i) => {
    out.push({ pattern: re.source, flags: re.flags, pipeline });
    if (i === FIX_INDEX && idRegex(idPattern)) out.push({ pattern: idPattern, flags: '', pipeline: 'fix' });
  });
  return out;
}
