// Tests for runs/schema-check.mjs: the supported schema subset, the validator and the capper.
// Run: node --test tools/workspace-app/runs/schema-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRING_CAP, MAX_PROBLEMS, capStrings, checkSchemaSupported, validate } from './schema-check.mjs';

const sample = {
  type: 'object',
  description: 'A sample',
  required: ['title', 'items'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 10 },
    count: { type: 'integer', minimum: 0, maximum: 5 },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    done: { type: 'boolean' },
    kind: { type: 'string', enum: ['a', 'b'] },
    items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 5 } } } },
  },
};

test('checkSchemaSupported accepts the subset', () => {
  assert.deepEqual(checkSchemaSupported(sample), []);
});

test('checkSchemaSupported names every unsupported or inconsistent part', () => {
  const cases = [
    [{ type: 'object', properties: {}, additionalProperties: false }, 'result: "additionalProperties" is not supported'],
    [{ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } }, 'a: "pattern" is not supported'],
    [{ type: ['string', 'null'] }, 'result: type must be one of object, array, string, number, integer, boolean'],
    [{ type: 'string', items: { type: 'string' } }, 'result: items needs type array'],
    [{ type: 'array' }, 'result: an array needs items'],
    [{ type: 'object' }, 'result: an object needs properties'],
    [{ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, 'result: required field "b" is not in properties'],
    [{ type: 'number', maxLength: 3 }, 'result: maxLength needs type string'],
    [{ type: 'string', minLength: 5, maxLength: 2 }, 'result: minLength is larger than maxLength'],
    [{ type: 'string', maxLength: -1 }, 'result: maxLength must be a whole number of 0 or more'],
    [{ type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 1 }, 'result: minItems is larger than maxItems'],
    [{ type: 'integer', minimum: 5, maximum: 1 }, 'result: minimum is larger than maximum'],
    [{ type: 'string', enum: [] }, 'result: enum must be a non-empty list of strings or numbers'],
    [{ type: 'string', minimum: 1 }, 'result: minimum needs type number or integer'],
    [{ type: 'string', properties: {} }, 'result: properties and required need type object'],
    [{ type: 'array', items: { type: 'object', properties: { x: { type: 'date' } } } }, '[].x: type must be one of object, array, string, number, integer, boolean'],
    ['not a schema', 'result: a schema must be an object'],
  ];
  for (const [schema, problem] of cases) {
    assert.ok(checkSchemaSupported(schema).includes(problem), `${JSON.stringify(schema)} should report: ${problem}\n got ${JSON.stringify(checkSchemaSupported(schema))}`);
  }
});

test('validate accepts a valid value and ignores fields the schema does not name', () => {
  assert.deepEqual(validate(sample, { title: 'ok', items: [{ path: 'a.js' }], count: 5, ratio: 0.5, done: true, kind: 'a', extra: { anything: 1 } }), []);
});

test('validate reports problems with their paths', () => {
  const problems = validate(sample, { title: '', items: [{ path: 'too-long.js' }, {}, { path: 'x' }], count: 2.5, ratio: 2, done: 'yes', kind: 'c' });
  const expected = [
    'title: is empty',
    'count: must be an integer',
    'ratio: must be 1 or less',
    'done: must be a boolean',
    'kind: must be one of a, b',
    'items: has more than 2 items',
    'items[0].path: longer than 5 characters',
    'items[1].path: is required',
  ];
  assert.deepEqual([...problems].sort(), [...expected].sort());
});

test('validate checks the root type, required fields and array minimums', () => {
  assert.deepEqual(validate(sample, null), ['result: must be an object']);
  assert.deepEqual(validate(sample, []), ['result: must be an object']);
  assert.deepEqual(validate(sample, {}), ['title: is required', 'items: is required']);
  assert.deepEqual(validate(sample, { title: 'x', items: [] }), ['items: needs at least 1 item']);
  assert.deepEqual(validate({ type: 'array', items: { type: 'string' } }, 'x'), ['result: must be an array']);
  assert.deepEqual(validate({ type: 'integer', minimum: 1 }, 0), ['result: must be 1 or more']);
  assert.deepEqual(validate({ type: 'number' }, Number.NaN), ['result: must be a number']);
});

test('string lengths count code points, as JSON Schema validators do', () => {
  const s = { type: 'string', maxLength: 3 };
  assert.deepEqual(validate(s, '\u{1F600}\u{1F600}\u{1F600}'), []);
  assert.deepEqual(validate(s, 'abcd'), ['result: longer than 3 characters']);
  assert.deepEqual(validate({ type: 'string', minLength: 2 }, 'a'), ['result: shorter than 2 characters']);
});

test('validate stops after MAX_PROBLEMS problems', () => {
  const s = { type: 'array', items: { type: 'string' }, maxItems: 1000 };
  assert.equal(validate(s, Array(100).fill(1)).length, MAX_PROBLEMS);
});

test('capStrings cuts strings and arrays, drops unknown fields and leaves the input alone', () => {
  const input = { title: 'abcdefghijklmnop', items: [{ path: '123456789', junk: 1 }, { path: 'b' }, { path: 'c' }], extra: 'x' };
  const copy = JSON.parse(JSON.stringify(input));
  const out = capStrings(input, sample);
  assert.deepEqual(out, { title: 'abcdefghij', items: [{ path: '12345' }, { path: 'b' }] });
  assert.deepEqual(input, copy);
  assert.equal(capStrings('\u{1F600}'.repeat(12), { type: 'string', maxLength: 10 }), '\u{1F600}'.repeat(10));
});

test('capStrings always cuts a string, even where the schema expects another type', () => {
  const long = 'x'.repeat(1000);
  assert.equal(capStrings(long, { type: 'integer' }).length, DEFAULT_STRING_CAP);
  assert.equal(capStrings(long, undefined).length, DEFAULT_STRING_CAP);
  assert.equal(capStrings(7, { type: 'string', maxLength: 1 }), 7);
  assert.deepEqual(capStrings({ a: 1 }, { type: 'array', items: { type: 'string' } }), { a: 1 });
});
