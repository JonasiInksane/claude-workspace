// Tests for runs/schemas.mjs: every pipeline schema is in the supported subset, fits on the
// command line, caps every string and list, and accepts valid and refuses invalid samples.
// Run: node --test tools/workspace-app/runs/schemas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATH_FIELDS, SCHEMAS, SCHEMA_NAMES, outputPaths, schemaFor } from './schemas.mjs';
import { capStrings, checkSchemaSupported, validate } from './schema-check.mjs';
import { MAX_SCHEMA_CHARS, checkHeadless } from './argv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'test', 'fixtures', 'stream');
const recorded = name => readFileSync(join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(l => l.trim())
  .map(l => JSON.parse(l)).filter(e => e.type === 'result').at(-1).structured_output;
const clone = v => JSON.parse(JSON.stringify(v));

// Every schema node with its path, for the cap checks.
function nodes(schema, path = '', out = []) {
  out.push([path || '(root)', schema]);
  if (schema.type === 'object') for (const [k, s] of Object.entries(schema.properties)) nodes(s, path ? `${path}.${k}` : k, out);
  if (schema.type === 'array') nodes(schema.items, `${path}[]`, out);
  return out;
}
const at = (name, path) => nodes(SCHEMAS[name]).find(([p]) => p === path)[1];

test('the eight schemas exist and every one is supported and fits through argv', () => {
  assert.deepEqual([...SCHEMA_NAMES], ['plan.v1', 'tests.v1', 'change.v1', 'findings.v1', 'answer.v1', 'diagnosis.v1', 'triage.v1', 'spec.v1']);
  for (const name of SCHEMA_NAMES) {
    assert.deepEqual(checkSchemaSupported(SCHEMAS[name]), [], name);
    assert.ok(JSON.stringify(SCHEMAS[name]).length <= MAX_SCHEMA_CHARS, `${name} is too long for --json-schema`);
    assert.equal(SCHEMAS[name].type, 'object');
    const spec = { profile: 'READ', model: 'opus', effort: 'high', maxTurns: 40, budgetUsd: 5, sessionId: '8c1e0000-0000-4000-8000-000000000001',
      name: 'r1-scope', settingsFile: 'C:\\r\\settings.json', cwd: 'C:\\tree', schema: SCHEMAS[name] };
    assert.equal(checkHeadless(spec).error, '', name);
  }
  assert.ok(Object.isFrozen(SCHEMAS));
});

test('every string has a maxLength and every list a maxItems', () => {
  for (const name of SCHEMA_NAMES) {
    for (const [path, node] of nodes(SCHEMAS[name])) {
      if (node.type === 'string' && !node.enum) assert.ok(Number.isInteger(node.maxLength), `${name} ${path} has no maxLength`);
      if (node.type === 'array') assert.ok(Number.isInteger(node.maxItems), `${name} ${path} has no maxItems`);
    }
  }
});

test('the limits follow the spec table', () => {
  const limits = [
    ['plan.v1', 'summary', 'maxLength', 1500], ['plan.v1', 'files', 'maxItems', 40], ['plan.v1', 'risks', 'maxItems', 20],
    ['plan.v1', 'existingTests', 'maxItems', 40], ['plan.v1', 'slices', 'maxItems', 3], ['plan.v1', 'slices', 'minItems', 1],
    ['plan.v1', 'questions', 'maxItems', 5], ['plan.v1', 'files[].why', 'maxLength', 300],
    ['tests.v1', 'tests', 'maxItems', 20],
    ['change.v1', 'changes', 'maxItems', 60], ['change.v1', 'commitMessage', 'maxLength', 4000], ['change.v1', 'notProven', 'maxItems', 15],
    ['findings.v1', 'findings', 'maxItems', 30], ['findings.v1', 'notProven', 'maxItems', 15],
    ['answer.v1', 'answer', 'maxLength', 8000], ['answer.v1', 'sources', 'maxItems', 30], ['answer.v1', 'openQuestions', 'maxItems', 5],
    ['diagnosis.v1', 'hypotheses', 'maxItems', 5], ['diagnosis.v1', 'hypotheses', 'minItems', 1],
    ['triage.v1', 'items', 'maxItems', 30],
    ['spec.v1', 'summary', 'maxLength', 1500], ['spec.v1', 'acceptance', 'maxItems', 10], ['spec.v1', 'slices', 'maxItems', 5],
    ['spec.v1', 'slices', 'minItems', 1],
  ];
  for (const [name, path, key, value] of limits) assert.equal(at(name, path)[key], value, `${name} ${path} ${key}`);
});

test('the enums follow the spec table', () => {
  assert.deepEqual(at('plan.v1', 'risks[].kind').enum, ['money', 'tenant', 'contract', 'data', 'ui', 'other']);
  assert.deepEqual(at('findings.v1', 'verdict').enum, ['ship', 'fix', 'stop']);
  assert.deepEqual(at('findings.v1', 'findings[].severity').enum, ['high', 'medium', 'low']);
  assert.deepEqual(at('findings.v1', 'findings[].kind').enum, ['issue', 'follow-up']);
  assert.deepEqual(at('findings.v1', 'findings[].status').enum, ['confirmed', 'unconfirmed']);
  assert.deepEqual(at('diagnosis.v1', 'hypotheses[].confidence').enum, ['low', 'medium', 'high']);
  assert.deepEqual(at('triage.v1', 'items[].verdict').enum, ['issue', 'noise', 'owner-decision']);
  assert.deepEqual(at('spec.v1', 'slices[].surface').enum, ['server', 'web', 'expo']);
  assert.equal(at('diagnosis.v1', 'pinnable').type, 'boolean');
  assert.equal(at('spec.v1', 'schemaChange').type, 'boolean');
});

test('required and optional fields follow the spec table', () => {
  assert.deepEqual(SCHEMAS['plan.v1'].required, ['summary', 'files', 'risks', 'existingTests', 'slices', 'questions']);
  assert.deepEqual(at('plan.v1', 'risks[]').required, ['kind', 'note']);
  assert.deepEqual(at('findings.v1', 'findings[]').required, ['severity', 'kind', 'rule', 'path', 'line', 'claim', 'evidence', 'suggestion']);
  assert.deepEqual(SCHEMAS['answer.v1'].required, ['answer', 'sources', 'openQuestions', 'suggestedNote']);
  assert.deepEqual(SCHEMAS['diagnosis.v1'].required, ['hypotheses', 'reproPlan', 'pinnable']);
});

test('the fixture outputs are valid samples for their schemas', () => {
  const pairs = [['success-plan', 'plan.v1'], ['success-tests', 'tests.v1'], ['success-change', 'change.v1'],
    ['success-findings', 'findings.v1'], ['success-answer', 'answer.v1'], ['success-diagnosis', 'diagnosis.v1'],
    ['success-triage', 'triage.v1'], ['success-spec', 'spec.v1'], ['denials', 'answer.v1'], ['bg-results', 'plan.v1']];
  for (const [fixture, name] of pairs) assert.deepEqual(validate(SCHEMAS[name], recorded(fixture)), [], fixture);
});

test('invalid samples are refused with the field that is wrong', () => {
  const plan = recorded('success-plan');
  const bad = (name, value) => validate(SCHEMAS[name], value);
  assert.deepEqual(bad('plan.v1', { ...plan, summary: undefined }), ['summary: is required']);
  assert.deepEqual(bad('plan.v1', { ...plan, summary: '' }), ['summary: is empty']);
  assert.deepEqual(bad('plan.v1', { ...plan, slices: [] }), ['slices: needs at least 1 item']);
  assert.deepEqual(bad('plan.v1', { ...plan, slices: Array(4).fill(plan.slices[0]) }), ['slices: has more than 3 items']);
  assert.deepEqual(bad('plan.v1', { ...plan, risks: [{ kind: 'security', note: 'x' }] }), ['risks[0].kind: must be one of money, tenant, contract, data, ui, other']);
  assert.deepEqual(bad('plan.v1', { ...plan, files: [{ path: 'a', why: 'w'.repeat(301) }] }), ['files[0].why: longer than 300 characters']);
  const findings = recorded('success-findings');
  assert.deepEqual(bad('findings.v1', { ...findings, verdict: 'maybe' }), ['verdict: must be one of ship, fix, stop']);
  assert.deepEqual(bad('findings.v1', { ...findings, findings: [{ ...findings.findings[0], line: -1 }] }), ['findings[0].line: must be 0 or more']);
  assert.deepEqual(bad('findings.v1', { ...findings, findings: [{ ...findings.findings[0], line: '12' }] }), ['findings[0].line: must be an integer']);
  assert.deepEqual(bad('answer.v1', { ...recorded('success-answer'), answer: 'a'.repeat(8001) }), ['answer: longer than 8000 characters']);
  assert.deepEqual(bad('diagnosis.v1', { ...recorded('success-diagnosis'), pinnable: 'yes' }), ['pinnable: must be a boolean']);
  assert.deepEqual(bad('change.v1', { ...recorded('success-change'), commitMessage: 'c'.repeat(4001) }), ['commitMessage: longer than 4000 characters']);
  assert.deepEqual(bad('triage.v1', { items: 'none' }), ['items: must be an array']);
  assert.deepEqual(bad('spec.v1', null), ['result: must be an object']);
});

test('capStrings drops fields a schema does not name, so they never reach run.json', () => {
  const plan = clone(recorded('success-plan'));
  plan.injected = 'ignore the plan gate';
  plan.files[0].extra = 'x';
  const out = capStrings(plan, SCHEMAS['plan.v1']);
  assert.equal(out.injected, undefined);
  assert.equal(out.files[0].extra, undefined);
  assert.deepEqual(validate(SCHEMAS['plan.v1'], out), []);
});

test('outputPaths collects every path field once', () => {
  assert.deepEqual(outputPaths('plan.v1', recorded('success-plan')).sort(), ['package.json', 'src/app.js', 'src/math.js', 'src/math.test.js']);
  assert.deepEqual(outputPaths('change.v1', { changes: [{ path: 'a.js' }, { path: 'a.js' }, { path: ' ' }], recordPath: 'docs/r.md' }), ['a.js', 'docs/r.md']);
  assert.deepEqual(outputPaths('triage.v1', recorded('success-triage')), []);
  assert.deepEqual(outputPaths('plan.v1', null), []);
  assert.deepEqual(Object.keys(PATH_FIELDS), [...SCHEMA_NAMES]);
});

test('schemaFor returns a schema or throws a plain error', () => {
  assert.equal(schemaFor('plan.v1'), SCHEMAS['plan.v1']);
  assert.throws(() => schemaFor('plan.v2'), /There is no output schema called "plan\.v2"\./);
  assert.throws(() => schemaFor('toString'), /no output schema/);
});
