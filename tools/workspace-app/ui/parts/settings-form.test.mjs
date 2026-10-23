// Tests for parts/settings-form.js, the Settings tab's form without the DOM: tidying as the server
// does (so "unchanged" means the same as the server's "Nothing changed"), fields from a saved
// version, the save body with basedOn, the mirrored checks (model, tools, rules length and control
// characters, asset count, choices), the server's 400 split back into its fields (sentences that
// hold "; " themselves included), the field-by-field difference and the asset changes of two
// versions, and the character count. Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetChanges, checkFields, emptyFields, fieldDiff, fieldsOf, normalizeRules, normalizeTools, pinText, problemCount,
  rulesCount, sameFields, saveBody, splitProblems, splitToolRules, tidyFields,
} from './settings-form.js';

const saved = {
  format: 1, project: 'example', version: 2, basedOn: 1, savedAt: '2026-10-23T08:00:00.000Z',
  rules: '- Money is in cents.\n- Tests first.', defaults: { model: 'sonnet', effort: 'high', permissionMode: 'plan' },
  allowedTools: 'Read, Grep', assets: [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:logo', pin: 2 }], sha256: 'a'.repeat(64),
};

test('tidying: rules, tools and the model as the server stores them', () => {
  assert.equal(normalizeRules('\r\n  \n- a\r\n- b  \n\n'), '- a\n- b');
  assert.equal(normalizeRules(null), '');
  assert.deepEqual(splitToolRules('Read, Grep\nBash(git log *)  Read'), ['Read', 'Grep', 'Bash(git log *)', 'Read']);
  assert.equal(normalizeTools('Read,  Grep Read, Bash(npm test:*)'), 'Read, Grep, Bash(npm test:*)');
  assert.equal(normalizeTools(''), '');
  assert.deepEqual(tidyFields({ ...emptyFields(), model: ' opus ', assets: [{ ref: ' shared:a ', pin: 'x' }] }).assets, [{ ref: 'shared:a', pin: null }]);
  assert.equal(tidyFields(null).rules, '');
  assert.deepEqual([pinText(null), pinText(3), pinText(0), pinText('2')], ['latest', 'v3', 'latest', 'latest']);
});

test('fieldsOf: a saved version as fields; nothing saved gives the empty ones', () => {
  assert.deepEqual(fieldsOf(saved), {
    rules: saved.rules, model: 'sonnet', effort: 'high', permissionMode: 'plan', allowedTools: 'Read, Grep',
    assets: [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:logo', pin: 2 }],
  });
  assert.deepEqual(fieldsOf(null), emptyFields());
  assert.deepEqual(fieldsOf({ defaults: null, assets: [null, { ref: 3 }, { ref: 'shared:x', pin: 1.5 }] }).assets, [{ ref: 'shared:x', pin: null }]);
});

test('sameFields: what the server would store, so trailing spaces and repeated tools change nothing', () => {
  const a = fieldsOf(saved);
  assert.equal(sameFields(a, { ...a, rules: `${a.rules}   \n\n`, allowedTools: 'Read Grep, Read' }), true);
  assert.equal(sameFields(a, { ...a, rules: `${a.rules}\n- One more.` }), false);
  assert.equal(sameFields(a, { ...a, assets: [...a.assets].reverse() }), false, 'the order of the assets counts');
  assert.equal(sameFields(a, { ...a, assets: [{ ref: 'shared:style-guide', pin: 1 }, a.assets[1]] }), false, 'a pin counts');
  assert.equal(sameFields(emptyFields(), fieldsOf(null)), true);
});

test('saveBody: every field, the defaults as an object, basedOn the opened version (0 for none)', () => {
  const f = { ...fieldsOf(saved), model: ' opus ' };
  assert.deepEqual(saveBody('example', 2, f), {
    project: 'example', basedOn: 2, rules: saved.rules, defaults: { model: 'opus', effort: 'high', permissionMode: 'plan' },
    allowedTools: 'Read, Grep', assets: [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:logo', pin: 2 }],
  });
  assert.equal(saveBody('example', 0, emptyFields()).basedOn, 0);
  assert.equal(saveBody('example', null, emptyFields()).basedOn, 0);
  assert.equal(saveBody('example', -1, emptyFields()).basedOn, 0);
});

test('checkFields: the problems a person can make in the editor, by field', () => {
  assert.equal(problemCount(checkFields(fieldsOf(saved))), 0);
  const p = checkFields({
    ...emptyFields(), rules: `${'x'.repeat(30)}\n\u0007`, model: 'opus 4', allowedTools: 'Read, Bash), Grep(a"b), Write', assets: [1, 2, 3].map(i => ({ ref: `shared:a${i}`, pin: null })),
  }, { rules: 20, assets: 2, allowedTools: 2 });
  assert.deepEqual(p.rules, ['The rules are 12 characters over the limit of 20.', 'Line 2 has a control character (U+0007); remove it.']);
  assert.match(p.model[0], /alias such as opus or sonnet/);
  assert.deepEqual(p.allowedTools, ['4 rules; at most 2.', '"Bash)" is not a tool rule. Use names like Read or Bash(npm test:*).',
    '"Grep(a"b)" is not a tool rule. Use names like Read or Bash(npm test:*).']);
  // An open parenthesis keeps the rest in one rule, as the server splits it.
  assert.deepEqual(checkFields({ ...emptyFields(), allowedTools: 'Read, Bash(, Grep' }).allowedTools, ['"Bash(, Grep" is not a tool rule. Use names like Read or Bash(npm test:*).']);
  assert.deepEqual(p.assets, ['3 assets attached; at most 2.']);
  assert.equal(problemCount(p), 7);
  // Choices: only with the server's list (an old version may hold a value the select lacks).
  const c = checkFields({ ...emptyFields(), effort: 'huge', permissionMode: 'bypassPermissions' }, null, { effort: ['low', 'high'], permissionMode: ['plan'] });
  assert.deepEqual([c.effort.length, c.permissionMode.length], [1, 1]);
  assert.equal(problemCount(checkFields({ ...emptyFields(), effort: 'huge' })), 0);
  // The limit counts the stored text: leading blank lines and trailing spaces don't count.
  assert.equal(checkFields({ ...emptyFields(), rules: `\n\n${'x'.repeat(20)}    ` }, { rules: 20 }).rules.length, 0);
});

test('splitProblems: a 400 back into its fields, sentences with "; " inside kept whole', () => {
  const msg = 'The settings were not saved: the rules have a control character (U+0007) on line 3; remove it; '
    + 'defaults.model must be empty, an alias such as opus or sonnet, or a full model name; '
    + 'defaults.effort must be empty or one of low, high; '
    + 'allowedTools has 21 rules; at most 20; '
    + 'allowedTools: "Bash(a; b" is not a tool rule. Use names like Read or Bash(npm test:*); '
    + 'assets[0].ref other:logo belongs to another project; attach shared assets or example\'s own; '
    + '"version" is not a project setting (use rules, defaults, allowedTools, assets); and 3 more.';
  const p = splitProblems(msg);
  assert.deepEqual(p.rules, ['the rules have a control character (U+0007) on line 3; remove it.']);
  assert.equal(p.model.length, 1);
  assert.equal(p.effort.length, 1);
  assert.deepEqual(p.allowedTools, ['allowedTools has 21 rules; at most 20.', 'allowedTools: "Bash(a; b" is not a tool rule. Use names like Read or Bash(npm test:*).']);
  assert.deepEqual(p.assets, ['assets[0].ref other:logo belongs to another project; attach shared assets or example\'s own.']);
  assert.deepEqual(p.other, ['"version" is not a project setting (use rules, defaults, allowedTools, assets).', 'and 3 more.']);
  assert.deepEqual(p.permissionMode, []);
  // Anything else (a 500 naming a file, a network error) is one sentence in `other`.
  assert.deepEqual(splitProblems('The settings v1 of example can\'t be used: it is not valid JSON.').other.length, 1);
  assert.deepEqual(splitProblems('').other, []);
  assert.deepEqual(splitProblems('The settings were not saved: defaults must be an object with model, effort and permissionMode.').other,
    ['defaults must be an object with model, effort and permissionMode.']);
});

test('fieldDiff and assetChanges: the other settings side by side, and what happened to each asset', () => {
  const a = fieldsOf(saved);
  const b = { ...a, effort: '', allowedTools: 'Read, Grep, Bash(npm test:*)', assets: [{ ref: 'example:logo', pin: null }, { ref: 'shared:brand', pin: 1 }] };
  const rows = fieldDiff(a, b);
  assert.deepEqual(rows.map(r => [r.key, r.changed]), [['model', false], ['effort', true], ['permissionMode', false], ['allowedTools', true], ['assets', true]]);
  assert.deepEqual(rows[1], { key: 'effort', label: 'Effort', before: 'high', after: '', changed: true });
  assert.equal(rows[4].before, 'shared:style-guide (latest), example:logo (v2)');
  assert.deepEqual(assetChanges(a, b), [
    { ref: 'example:logo', change: 'pin', before: 2, after: null },
    { ref: 'shared:brand', change: 'added', before: null, after: 1 },
    { ref: 'shared:style-guide', change: 'removed', before: null, after: null },
  ]);
  assert.deepEqual(assetChanges(a, a), []);
  assert.equal(fieldDiff(a, { ...a, allowedTools: 'Grep Read Read' }).find(r => r.key === 'allowedTools').changed, true, 'the order of tools counts');
  assert.equal(fieldDiff(a, { ...a, allowedTools: 'Read Grep Read' }).find(r => r.key === 'allowedTools').changed, false);
});

test('rulesCount: the stored length against the limit, near from 90 %, over past it', () => {
  assert.deepEqual(rulesCount('abc', 20000), { count: 3, limit: 20000, state: 'ok', text: '3 / 20,000 characters' });
  assert.equal(rulesCount('x'.repeat(18000), 20000).state, 'near');
  assert.deepEqual(rulesCount('x'.repeat(20001), 20000), { count: 20001, limit: 20000, state: 'over', text: '20,001 / 20,000 characters' });
  assert.equal(rulesCount('\n\nabc   ').count, 3);
  assert.equal(rulesCount('').text, '0 / 20,000 characters');
});
