// Tests for runs/catalog.mjs: the pipeline definitions, value checks, levels, models and caps.
// Pure functions only; the example profile comes from test/helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPS, checkValues, cleanRelPath, computeLevel, needsLock, pipelineById, pipelineForUi, pipelinesForUi, PIPELINES, PREDICATES,
  requestPaths, runTitle, STAGE_ID_RE, stageCaps, stageModel,
} from './catalog.mjs';
import { SCHEMAS } from './schemas.mjs';
import { fakeProfile } from '../test/helpers.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const GATE_FUNCTIONS = ['preflight', 'gateB', 'checks', 'collect', 'scan', 'checkPreflight', 'checkRun', 'setup'];
const WAIT_KINDS = ['plan', 'spec', 'hypothesis', 'fence', 'review', 'commit', 'triage', 'decide'];
const profile = () => fakeProfile();
const findings = () => ({ findings: [{ id: 'EX-1', title: 'One', status: 'open' }, { id: 'EX-2', title: 'Two', status: 'done' }] });

test('every pipeline has the shape the launcher and executor rely on', () => {
  const ids = PIPELINES.map(p => p.id);
  assert.deepEqual(ids, ['explain', 'review', 'check', 'architecture', 'fix', 'refactor', 'debug', 'feature', 'setup-worktree']);
  for (const p of PIPELINES) {
    assert.ok(p.label && Array.isArray(p.fields) && Array.isArray(p.stages) && p.stages.length, p.id);
    assert.ok(['none', 'tree', 'main-ok'].includes(p.requires.isolation), p.id);
    assert.ok(Array.isArray(p.cannot) && p.cannot.length, `${p.id} cannot list`);
    const stageIds = p.stages.map(s => s.id);
    assert.equal(new Set(stageIds).size, stageIds.length, `${p.id} stage ids are unique`);
    for (const s of p.stages) {
      // runs/store.mjs uses stage ids in folder names: lowercase and dashes only.
      assert.match(s.id, STAGE_ID_RE, `${p.id}.${s.id}`);
      assert.ok(['gate', 'claude', 'human', 'git'].includes(s.kind));
      assert.ok(['code', 'claude', 'you'].includes(s.who));
      if (s.when) assert.equal(typeof PREDICATES[s.when], 'function', `${p.id}.${s.id} when`);
      if (s.kind === 'gate') assert.ok(GATE_FUNCTIONS.includes(s.run), `${p.id}.${s.id} run`);
      if (s.kind === 'human' || s.kind === 'git') assert.ok(WAIT_KINDS.includes(s.waits), `${p.id}.${s.id} waits`);
      if (s.kind === 'claude') {
        assert.ok(['READ', 'CHECK', 'EDIT'].includes(s.profile));
        assert.ok(SCHEMAS[s.schema], `${p.id}.${s.id} schema ${s.schema}`);
        assert.equal(s.prompt, `pipelines/app/${p.id}/${s.id}.md`);
        assert.ok(existsSync(join(HUB, ...s.prompt.split('/'))), `${s.prompt} exists`);
        assert.equal(s.caps, s.profile === 'EDIT' ? 'edit' : 'read');
      }
    }
  }
});

test('the slice spine has the SPEC order for fix and refactor', () => {
  const spine = ['preflight', 'scope', 'plan', 'prove', 'gate-b', 'implement', 'checks', 'review', 'verify', 'review-gate', 'commit'];
  for (const id of ['fix', 'refactor']) assert.deepEqual(pipelineById(id).stages.map(s => s.id), spine);
  assert.equal(pipelineById('fix').stages.find(s => s.id === 'prove').proveKind, 'red');
  assert.equal(pipelineById('refactor').stages.find(s => s.id === 'prove').proveKind, 'pins');
  assert.deepEqual(pipelineById('debug').stages.map(s => s.id),
    ['preflight', 'investigate', 'hypothesis', 'prove', 'gate-b', 'implement', 'checks', 'review', 'verify', 'review-gate', 'commit']);
  assert.equal(pipelineById('debug').stages.find(s => s.id === 'investigate').profile, 'CHECK');
  assert.deepEqual(pipelineById('feature').stages.slice(0, 3).map(s => [s.id, s.schema || s.waits]), [['preflight', undefined], ['scope', 'spec.v1'], ['spec', 'spec']]);
  assert.deepEqual(pipelineById('review').stages.map(s => s.id), ['collect', 'review', 'verify', 'triage']);
  assert.deepEqual(pipelineById('architecture').stages.map(s => s.id), ['scan', 'triage', 'decide']);
  assert.equal(pipelineById('check').claude, false);
  assert.ok(pipelineById('check').cannot.includes('Use Claude: this costs zero tokens'));
});

test('only the edit stages get the EDIT profile, and read-only pipelines never edit', () => {
  for (const p of PIPELINES) {
    for (const s of p.stages.filter(x => x.kind === 'claude')) {
      const edit = s.id === 'prove' || s.id === 'implement';
      assert.equal(s.profile === 'EDIT', edit, `${p.id}.${s.id}`);
    }
    if (!p.editing) assert.ok(!p.stages.some(s => s.profile === 'EDIT' || s.kind === 'git'), p.id);
  }
});

test('predicates decide the optional stages', () => {
  assert.equal(PREDICATES.verifyNeeded({ level: 'paranoid', riskTags: [] }), true);
  assert.equal(PREDICATES.verifyNeeded({ level: 'standard', riskTags: ['tenant'] }), true);
  assert.equal(PREDICATES.verifyNeeded({ level: 'standard', riskTags: [] }), false);
  assert.equal(PREDICATES.deep({ values: { depth: 'deep' } }), true);
  assert.equal(PREDICATES.hasCandidates({ outputs: { scan: { candidates: 0 } } }), false);
  assert.equal(PREDICATES.hasCandidates({ outputs: { scan: { candidates: 2 } } }), true);
  assert.equal(PREDICATES.needsDecision({ outputs: { triage: { items: [{ verdict: 'noise' }] } } }), false);
  assert.equal(PREDICATES.needsDecision({ outputs: { triage: { items: [{ verdict: 'owner-decision' }] } } }), true);
  assert.equal(PREDICATES.pinnable({ outputs: { investigate: { pinnable: false } } }), false);
  assert.equal(PREDICATES.pinnable({ outputs: { investigate: { pinnable: true } } }), true);
  assert.equal(PREDICATES.notChild({ parent: 'x', inherit: { spec: {} } }), false);
  assert.equal(PREDICATES.notChild({ parent: null }), true);
});

test('computeLevel raises on risk hits and never lowers', () => {
  assert.deepEqual(computeLevel('quick', { tags: [], hits: [] }), { level: 'quick', reasons: [] });
  const money = { tags: ['money'], hits: [{ path: 'apps/api/src/billing/charge.mjs', tag: 'money', glob: 'apps/api/src/billing/**' }] };
  assert.deepEqual(computeLevel('quick', money), { level: 'standard', reasons: ['money path: apps/api/src/billing/**'] });
  assert.equal(computeLevel('paranoid', money).level, 'paranoid');
  assert.equal(computeLevel('quick', { tags: [], hits: [] }, { from: 'standard' }).level, 'standard');
  assert.equal(computeLevel('nonsense').level, 'standard');
  const twice = { tags: ['money'], hits: [money.hits[0], { ...money.hits[0], path: 'apps/api/src/billing/b.mjs' }] };
  assert.equal(computeLevel('standard', twice).reasons.length, 1);
});

test('stageModel: defaults, escalation and the override order', () => {
  const fix = pipelineById('fix');
  const refactor = pipelineById('refactor');
  const at = (p, id, extra = {}) => stageModel({ pipeline: p, stage: id, profile: {}, settings: {}, ...extra });
  assert.deepEqual(pick(at(refactor, 'scope')), { model: 'opus', effort: 'high' });
  assert.deepEqual(pick(at(refactor, 'prove')), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(pick(at(refactor, 'review')), { model: 'opus', effort: 'high' });
  assert.deepEqual(pick(at(fix, 'review')), { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(pick(at(refactor, 'review', { run: { level: 'paranoid', riskTags: [] } })), { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(pick(at(refactor, 'verify', { run: { level: 'standard', riskTags: ['contract'] } })), { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(pick(at('explain', 'answer')), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(pick(at('architecture', 'triage')), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(pick(at('review', 'review', { run: { values: { depth: 'quick' } } })), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(pick(at('review', 'review', { run: { values: { depth: 'deep' } } })), { model: 'opus', effort: 'xhigh' });
  // settings beat the profile, which beats the catalog
  const profileModels = { models: { 'refactor.scope': { model: 'sonnet', effort: 'medium' } } };
  assert.equal(at(refactor, 'scope', { profile: profileModels }).source, 'profile');
  const both = at(refactor, 'scope', { profile: profileModels, settings: { models: { 'refactor.scope': { model: 'haiku', effort: 'low' } } } });
  assert.deepEqual(pick(both), { model: 'haiku', effort: 'low' });
  assert.equal(both.source, 'settings');
  // an override can't lower an escalated review
  const lowered = at(fix, 'review', { settings: { models: { 'fix.review': { model: 'sonnet', effort: 'low' } } } });
  assert.deepEqual(pick(lowered), { model: 'opus', effort: 'xhigh' });
  assert.equal(lowered.raised, true);
  // junk overrides are ignored
  assert.deepEqual(pick(at(refactor, 'scope', { settings: { models: { 'refactor.scope': { model: 'rm -rf', effort: 'huge' } } } })), { model: 'opus', effort: 'high' });
});
const pick = m => ({ model: m.model, effort: m.effort });

test('stageCaps: read and edit defaults, the resume bonus and profile overrides', () => {
  const read = pipelineById('refactor').stages.find(s => s.id === 'scope');
  const edit = pipelineById('refactor').stages.find(s => s.id === 'implement');
  assert.deepEqual(stageCaps(read), { ...CAPS.read });
  assert.deepEqual(stageCaps(edit), { maxTurns: 60, wallMs: 30 * 60000, budgetUsd: 15 });
  assert.equal(stageCaps(edit, { bonusTurns: 20 }).maxTurns, 80);
  const o = stageCaps(read, { profile: { caps: { read: { maxTurns: 500, minutes: 5, budgetUsd: 0.1 } } } });
  assert.deepEqual(o, { maxTurns: 200, wallMs: 5 * 60000, budgetUsd: 0.5 });
});

test('needsLock: editing pipelines, setup, and check in the run worktree', () => {
  assert.equal(needsLock('refactor', 'run'), true);
  assert.equal(needsLock('setup-worktree', 'main'), true);
  assert.equal(needsLock('check', 'run'), true);
  assert.equal(needsLock('check', 'main'), false);
  assert.equal(needsLock('explain', 'main'), false);
  assert.equal(needsLock('nope', 'run'), false);
});

test('cleanRelPath keeps project paths and refuses everything else', () => {
  assert.equal(cleanRelPath('apps/web/src'), 'apps/web/src');
  assert.equal(cleanRelPath('.\\apps\\web\\'), 'apps/web');
  for (const bad of ['', '../x', 'a/../b', '/etc/passwd', 'C:/x', 'c:\\x', 'a/./b', 'a;b', 'a$b', 'x'.repeat(301)]) {
    assert.equal(cleanRelPath(bad), '', JSON.stringify(bad));
  }
});

test('checkValues: required fields, limits, options and paths', () => {
  const ctx = { profile: profile() };
  assert.match(checkValues('nope', {}, ctx).error, /no pipeline called nope/);
  assert.match(checkValues('explain', {}, ctx).error, /Question needs an answer/);
  assert.match(checkValues('explain', { what: 'x' }, {}).error, /no profile yet/);
  assert.match(checkValues('explain', { what: 'x'.repeat(601) }, ctx).error, /longer than 600/);
  assert.match(checkValues('explain', { what: 'why', where: '../../etc' }, ctx).error, /path inside the project/);
  assert.deepEqual(checkValues('explain', { what: '  why?  ', where: 'apps/api/', extra: 'dropped' }, ctx), { error: '', values: { what: 'why?', where: 'apps/api' } });
  assert.match(checkValues('explain', [], ctx).error, /must be an object/);
  const r = checkValues('refactor', { what: 'Split it' }, ctx);
  assert.equal(r.error, '');
  assert.deepEqual(r.values.keep, ['trpc', 'legacy', 'queues', 'ui']);
  assert.equal(r.values.care, 'standard');
  assert.equal(r.values.kind, 'auto');
  assert.match(checkValues('refactor', { what: 'x', kind: 'teleport' }, ctx).error, /Kind must be one of/);
  assert.match(checkValues('refactor', { what: 'x', keep: ['trpc', 'everything'] }, ctx).error, /unknown option: everything/);
  assert.match(checkValues('feature', { what: 'x', doneWhen: Array(12).fill('a').join('\n') }, ctx).error, /more than 10 lines/);
  assert.equal(checkValues('feature', { what: 'x' }, ctx).values.money, 'unsure');
});

test('checkValues: review targets, architecture commits, findings and screenshots', () => {
  const ctx = { profile: profile() };
  assert.match(checkValues('review', { target: 'last', n: 'ab' }, ctx).error, /number from 1 to 50/);
  assert.equal(checkValues('review', { target: 'last', n: '3' }, ctx).values.n, 3);
  assert.match(checkValues('review', { target: 'app', branch: 'main' }, ctx).error, /starting with app\//);
  assert.equal(checkValues('review', { target: 'app', branch: 'app/1022-x' }, ctx).values.branch, 'app/1022-x');
  assert.equal(checkValues('review', { target: 'uncommitted', branch: 'app/x', n: 4 }, ctx).values.branch, '');
  assert.match(checkValues('architecture', { compare: 'commit', commit: 'zz' }, ctx).error, /commit id/);
  assert.deepEqual(checkValues('architecture', { lenses: ['todoCount'] }, ctx).values.lenses, ['todoCount']);
  assert.match(checkValues('architecture', { lenses: ['nope'] }, ctx).error, /unknown option/);
  const withFindings = { profile: profile(), findings: findings() };
  assert.match(checkValues('fix', { finding: 'not-an-id' }, withFindings).error, /not a finding id/);
  assert.match(checkValues('fix', { finding: 'EX-9' }, withFindings).error, /not in the findings list/);
  assert.match(checkValues('fix', { finding: 'EX-2' }, withFindings).error, /is done, not open/);
  assert.equal(checkValues('fix', { finding: 'EX-1' }, withFindings).error, '');
  const shot = { what: 'broken', screenshot: 'shots/a.png' };
  assert.match(checkValues('debug', { ...shot, screenshot: '../a.png' }, ctx).error, /image from the inbox/);
  assert.match(checkValues('debug', shot, { ...ctx, inboxExists: () => false }).error, /not in the inbox/);
  assert.equal(checkValues('debug', shot, { ...ctx, inboxExists: () => true }).error, '');
  assert.match(checkValues('debug', { what: 'x', error: 'e'.repeat(20001) }, ctx).error, /longer than 20000/);
});

test('runTitle and requestPaths', () => {
  assert.equal(runTitle('refactor', { what: 'Split\nthe  cart' }), 'Refactor: Split the cart');
  assert.equal(runTitle('review', { target: 'last', n: 3 }), 'Review: last 3 commits');
  assert.equal(runTitle('check', { what: 'everything' }), 'Check my work: everything');
  assert.equal(runTitle('fix', { finding: 'EX-1' }), 'Fix a finding: EX-1');
  assert.equal(runTitle('explain', { what: 'x'.repeat(300) }).length, 120);
  assert.deepEqual(requestPaths({ where: 'apps/api' }), ['apps/api']);
  assert.deepEqual(requestPaths({}), []);
});

test('pipelineForUi shows stages with models, profile text, caps and the reason it is off', () => {
  const ui = pipelineForUi('refactor', { profile: profile() });
  assert.equal(ui.disabledReason, '');
  const scope = ui.stages.find(s => s.id === 'scope');
  assert.deepEqual([scope.model, scope.effort, scope.profile, scope.caps.maxTurns], ['opus', 'high', 'READ', 40]);
  assert.match(scope.profileText, /reads files only/);
  assert.ok(ui.fields.find(f => f.key === 'kind').options.length > 3);
  assert.ok(ui.caps.some(([k]) => k === 'Fix rounds'));
  assert.match(pipelineForUi('refactor', {}).disabledReason, /no profile/);
  const fixUi = pipelineForUi('fix', { profile: profile(), findings: findings() });
  assert.deepEqual(fixUi.fields.find(f => f.key === 'finding').options, [['EX-1', 'EX-1: One']]);
  assert.deepEqual(pipelineForUi('architecture', { profile: profile() }).fields[0].options, [['missingAssert', 'missingAssert'], ['todoCount', 'todoCount']]);
  assert.equal(pipelineForUi('nope'), null);
  assert.ok(!pipelinesForUi({ profile: profile() }).some(p => p.id === 'setup-worktree'));
});

test('catalog text names no real project', () => {
  const text = JSON.stringify(PIPELINES);
  for (const word of ['tattoogenda', 'tg-run', 'apps/server', 'apps/expo']) assert.ok(!text.toLowerCase().includes(word), word);
});
