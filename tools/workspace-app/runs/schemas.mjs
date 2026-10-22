// The structured-output schemas of the pipeline's Claude stages, keyed by name (plan.v1 ...).
//
// Each one goes to claude as --json-schema and back through schema-check.mjs, so it uses only
// the supported subset. Every string has a maxLength (300 by default, 1500 for summaries, 8000
// for answer.answer, 4000 for the commit message) and every array a maxItems, so one stage
// can't write megabytes into run.json. A schema must stay under 6000 characters as JSON
// (argv.mjs checks it), which is why descriptions are few and short.
//
// PATH_FIELDS names the fields that hold repository paths. claude-stage.mjs lists the ones that
// are outside the tree or don't exist in `paths.unknown`, and the executor never acts on those.

const str = (maxLength = 300, extra = {}) => ({ type: 'string', maxLength, ...extra });
const req = (maxLength = 300) => str(maxLength, { minLength: 1 });
const list = (items, maxItems, minItems) => ({ type: 'array', items, maxItems, ...(minItems ? { minItems } : {}) });
const oneOf = (...values) => ({ type: 'string', enum: values });
const obj = (properties, optional = []) => ({
  type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)),
});
const path = () => str(300, { minLength: 1, description: 'Repository-relative path with forward slashes' });
const line = () => ({ type: 'integer', minimum: 0, maximum: 1000000, description: '1-based line, 0 when unknown' });
const SUMMARY = 1500;

const planV1 = obj({
  summary: req(SUMMARY),
  files: list(obj({ path: path(), why: str() }), 40),
  risks: list(obj({ kind: oneOf('money', 'tenant', 'contract', 'data', 'ui', 'other'), path: str(), note: req() }, ['path']), 20),
  existingTests: list(path(), 40),
  slices: list(obj({
    title: req(120), goal: req(), files: list(path(), 40), tests: list(path(), 40),
    outOfScope: list(str(), 20), estLines: { type: 'integer', minimum: 0, maximum: 20000 },
  }), 3, 1),
  questions: list(str(), 5),
  where: str(),
  kind: str(60),
}, ['where', 'kind']);

const testsV1 = obj({
  tests: list(obj({ path: path(), name: req(), proves: req() }), 20),
  notes: str(SUMMARY),
});

const changeV1 = obj({
  changes: list(obj({ path: path(), what: req() }), 60),
  recordPath: str(),
  commitMessage: req(4000),
  notProven: list(str(), 15),
});

const findingsV1 = obj({
  verdict: oneOf('ship', 'fix', 'stop'),
  findings: list(obj({
    severity: oneOf('high', 'medium', 'low'),
    kind: oneOf('issue', 'follow-up'),
    rule: str(),
    path: path(),
    line: line(),
    claim: req(),
    evidence: str(SUMMARY),
    suggestion: str(),
    ref: str(),
    status: oneOf('confirmed', 'unconfirmed'),
  }, ['ref', 'status']), 30),
  notProven: list(str(), 15),
});

const answerV1 = obj({
  answer: req(8000),
  sources: list(obj({ path: path(), line: line(), note: str() }), 30),
  openQuestions: list(str(), 5),
  suggestedNote: str(SUMMARY),
});

const diagnosisV1 = obj({
  hypotheses: list(obj({
    claim: req(), evidence: list(str(), 10), confidence: oneOf('low', 'medium', 'high'), howToProve: str(),
  }), 5, 1),
  reproPlan: str(SUMMARY),
  pinnable: { type: 'boolean', description: 'true when a failing test can reproduce it' },
});

const triageV1 = obj({
  items: list(obj({
    ref: req(), verdict: oneOf('issue', 'noise', 'owner-decision'), reason: req(), suggestedSlice: str(),
  }), 30),
});

const specV1 = obj({
  summary: req(SUMMARY),
  acceptance: list(str(), 10),
  slices: list(obj({
    title: req(120), surface: oneOf('server', 'web', 'expo'), goal: req(), files: list(path(), 40), tests: list(path(), 40),
  }), 5, 1),
  schemaChange: { type: 'boolean', description: 'true when the database schema changes' },
  migrationPlan: str(SUMMARY),
  questions: list(str(), 5),
  risks: list(str(), 20),
});

export const SCHEMAS = Object.freeze({
  'plan.v1': planV1,
  'tests.v1': testsV1,
  'change.v1': changeV1,
  'findings.v1': findingsV1,
  'answer.v1': answerV1,
  'diagnosis.v1': diagnosisV1,
  'triage.v1': triageV1,
  'spec.v1': specV1,
});
export const SCHEMA_NAMES = Object.freeze(Object.keys(SCHEMAS));

// Field selectors: "files[].path" is the path of every item of files; "existingTests[]" is every
// item of a string list.
export const PATH_FIELDS = Object.freeze({
  'plan.v1': ['files[].path', 'risks[].path', 'existingTests[]', 'slices[].files[]', 'slices[].tests[]'],
  'tests.v1': ['tests[].path'],
  'change.v1': ['changes[].path', 'recordPath'],
  'findings.v1': ['findings[].path'],
  'answer.v1': ['sources[].path'],
  'diagnosis.v1': [],
  'triage.v1': [],
  'spec.v1': ['slices[].files[]', 'slices[].tests[]'],
});

// The schema for a name; throws on an unknown name.
export function schemaFor(name) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, name)) throw new Error(`There is no output schema called "${name}".`);
  return SCHEMAS[name];
}

// Every non-empty path string in an output, following PATH_FIELDS; duplicates removed.
export function outputPaths(name, value) {
  const found = new Set();
  for (const selector of PATH_FIELDS[name] || []) {
    for (const v of select(value, selector.split('.'))) {
      if (typeof v === 'string' && v.trim()) found.add(v.trim());
    }
  }
  return [...found];
}

function select(value, parts) {
  if (!parts.length) return [value];
  const [head, ...rest] = parts;
  const many = head.endsWith('[]');
  const key = many ? head.slice(0, -2) : head;
  const next = key ? (value && typeof value === 'object' ? value[key] : undefined) : value;
  if (!many) return next === undefined ? [] : select(next, rest);
  return Array.isArray(next) ? next.flatMap(item => select(item, rest)) : [];
}
