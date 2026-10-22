// Structured-output checks for Claude stages: a small JSON Schema subset, a validator and a capper.
//
// Every Claude stage passes a schema with --json-schema, and Claude answers by calling its
// StructuredOutput tool. The spike showed a run can still end "success" with no
// structured_output at all (E4b), so the app checks the output itself and never trusts the
// run's own verdict.
//
// Only this subset is allowed, so the validator understands every rule a schema states:
//   type, properties, required, items, enum, minLength, maxLength, minItems, maxItems,
//   minimum, maximum, description
// Types: object, array, string, number, integer, boolean (one type per schema node).
// Fields a schema doesn't name are not errors; capStrings drops them, so they never reach
// run.json. String lengths count code points, the way JSON Schema validators do.

export const SUPPORTED_KEYWORDS = Object.freeze(['type', 'properties', 'required', 'items', 'enum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'description']);
export const SCHEMA_TYPES = Object.freeze(['object', 'array', 'string', 'number', 'integer', 'boolean']);
// A string with no maxLength of its own is still cut to this many characters by capStrings.
export const DEFAULT_STRING_CAP = 300;
// validate stops after this many problems, so one broken array can't flood the timeline.
export const MAX_PROBLEMS = 20;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = v => Number.isInteger(v) && v >= 0;
const codePoints = s => Array.from(s).length;
const at = path => path || 'result';
const child = (path, key) => (path ? `${path}.${key}` : key);

// Problems with a schema, as "path: message" strings; an empty list means it is supported.
export function checkSchemaSupported(schema, path = '') {
  const out = [];
  const p = at(path);
  if (!isPlainObject(schema)) return [`${p}: a schema must be an object`];
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(k)) out.push(`${p}: "${k}" is not supported`);
  }
  const t = schema.type;
  if (!SCHEMA_TYPES.includes(t)) out.push(`${p}: type must be one of ${SCHEMA_TYPES.join(', ')}`);
  if ('description' in schema && typeof schema.description !== 'string') out.push(`${p}: description must be text`);
  if ('enum' in schema) {
    const ok = Array.isArray(schema.enum) && schema.enum.length > 0
      && schema.enum.every(v => typeof v === 'string' || typeof v === 'number');
    if (!ok) out.push(`${p}: enum must be a non-empty list of strings or numbers`);
  }
  out.push(...rangeProblems(schema, p, t));
  if (t === 'object') out.push(...objectProblems(schema, path));
  else if ('properties' in schema || 'required' in schema) out.push(`${p}: properties and required need type object`);
  if (t === 'array') {
    if (!('items' in schema)) out.push(`${p}: an array needs items`);
    else out.push(...checkSchemaSupported(schema.items, `${path}[]`));
  } else if ('items' in schema) out.push(`${p}: items needs type array`);
  return out;
}

// The length, count and number limits must sit on the matching type and be in order.
function rangeProblems(schema, p, t) {
  const out = [];
  const pairs = [['minLength', 'maxLength', 'string'], ['minItems', 'maxItems', 'array']];
  for (const [lo, hi, type] of pairs) {
    for (const k of [lo, hi]) {
      if (!(k in schema)) continue;
      if (t !== type) out.push(`${p}: ${k} needs type ${type}`);
      else if (!isCount(schema[k])) out.push(`${p}: ${k} must be a whole number of 0 or more`);
    }
    if (isCount(schema[lo]) && isCount(schema[hi]) && schema[lo] > schema[hi]) out.push(`${p}: ${lo} is larger than ${hi}`);
  }
  for (const k of ['minimum', 'maximum']) {
    if (!(k in schema)) continue;
    if (t !== 'number' && t !== 'integer') out.push(`${p}: ${k} needs type number or integer`);
    else if (typeof schema[k] !== 'number' || !Number.isFinite(schema[k])) out.push(`${p}: ${k} must be a number`);
  }
  if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
    out.push(`${p}: minimum is larger than maximum`);
  }
  return out;
}

function objectProblems(schema, path) {
  const p = at(path);
  const out = [];
  const props = schema.properties;
  if (!isPlainObject(props)) return [`${p}: an object needs properties`];
  for (const [k, sub] of Object.entries(props)) out.push(...checkSchemaSupported(sub, child(path, k)));
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || !schema.required.every(r => typeof r === 'string')) {
      out.push(`${p}: required must be a list of field names`);
    } else {
      for (const r of schema.required) if (!(r in props)) out.push(`${p}: required field "${r}" is not in properties`);
    }
  }
  return out;
}

// Checks a value against a supported schema. Returns "path: message" strings (empty when valid),
// for example "slices[0].title: is required".
export function validate(schema, value) {
  const out = [];
  walk(schema, value, '', out);
  return out.slice(0, MAX_PROBLEMS);
}

function typeOk(type, v) {
  switch (type) {
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}

function walk(schema, v, path, out) {
  if (out.length >= MAX_PROBLEMS) return;
  const p = at(path);
  const article = /^[aeiou]/.test(schema.type) ? 'an' : 'a';
  if (!typeOk(schema.type, v)) {
    out.push(`${p}: must be ${article} ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(v)) out.push(`${p}: must be one of ${schema.enum.join(', ')}`);
  if (schema.type === 'string') {
    const n = codePoints(v);
    if (isCount(schema.minLength) && n < schema.minLength) out.push(`${p}: ${schema.minLength === 1 ? 'is empty' : `shorter than ${schema.minLength} characters`}`);
    if (isCount(schema.maxLength) && n > schema.maxLength) out.push(`${p}: longer than ${schema.maxLength} characters`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) out.push(`${p}: must be ${schema.minimum} or more`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) out.push(`${p}: must be ${schema.maximum} or less`);
  } else if (schema.type === 'array') {
    if (isCount(schema.minItems) && v.length < schema.minItems) out.push(`${p}: needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    if (isCount(schema.maxItems) && v.length > schema.maxItems) out.push(`${p}: has more than ${schema.maxItems} items`);
    v.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, out));
  } else if (schema.type === 'object') {
    for (const r of schema.required || []) if (v[r] === undefined) out.push(`${child(path, r)}: is required`);
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (v[k] !== undefined) walk(sub, v[k], child(path, k), out);
    }
  }
}

// A copy of `value` that fits the schema's size limits: strings cut to maxLength (or
// DEFAULT_STRING_CAP), arrays cut to maxItems, and object fields the schema doesn't name dropped.
// Values of the wrong type are left for validate to report, except strings, which are always cut.
export function capStrings(value, schema) {
  if (typeof value === 'string') {
    const max = schema && schema.type === 'string' && isCount(schema.maxLength) ? schema.maxLength : DEFAULT_STRING_CAP;
    return codePoints(value) > max ? Array.from(value).slice(0, max).join('') : value;
  }
  if (!schema) return value;
  if (Array.isArray(value) && schema.type === 'array') {
    const max = isCount(schema.maxItems) ? schema.maxItems : value.length;
    return value.slice(0, max).map(item => capStrings(item, schema.items));
  }
  if (isPlainObject(value) && schema.type === 'object') {
    const out = {};
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] !== undefined) out[k] = capStrings(value[k], sub);
    }
    return out;
  }
  return value;
}
