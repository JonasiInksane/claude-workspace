// Tests for gates/contract.mjs on synthetic router and queue texts (test/fixtures/g0/): router
// keys and modules, enum and regex queue names, and the per-pipeline removal rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareContract, enumMembers, extractContract, moduleOf, routerKeys } from './contract.mjs';

const fixture = name => readFileSync(new URL(`../test/fixtures/g0/${name}`, import.meta.url), 'utf8');
const profile = JSON.parse(fixture('profile.json'));
const ROUTER = 'apps/api/src/routes/invoices/router.mjs';
const OTHER = 'apps/api/src/routes/teams/router.mjs';
const LEGACY = 'apps/api/src/legacy/router.mjs';
const QUEUES = 'apps/api/src/queues.mjs';
const TEAMS = "export const teamsRouter = router({\n  invite: memberProcedure.mutation(() => null),\n});\n";
const LEGACY_TEXT = "export const oldRouter = router({\n  syncV1: signedInProcedure.query(() => []),\n  pingV1: openProcedure.query(() => 'ok'),\n});\n";

// A read/list pair over an in-memory tree, like G0 builds from git or the folder.
function fakeTree(files) {
  return {
    read: async p => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    list: async globs => Object.keys(files).filter(p => globs.some(g => g === p || (g.endsWith('/**/router.mjs') && p.startsWith(g.slice(0, -'**/router.mjs'.length)) && p.endsWith('/router.mjs')))),
  };
}

const baseFiles = { [ROUTER]: fixture('router-base.txt'), [OTHER]: TEAMS, [LEGACY]: LEGACY_TEXT, [QUEUES]: fixture('queues.txt') };

test('routerKeys finds `key: someProcedure` lines with their line numbers', () => {
  const keys = routerKeys(fixture('router-base.txt'));
  assert.deepEqual(keys.map(k => [k.key, k.builder]), [
    ['list', 'memberProcedure'], ['get', 'memberProcedure'], ['pay', 'memberProcedure'],
    ['publicSummary', 'openProcedure'], ['me', 'signedInProcedure'], ['list', 'memberProcedure'],
  ]);
  assert.equal(keys[0].line, 5);
  assert.equal(keys[1].line, 6);
});

test('moduleOf is the folder above router.mjs', () => {
  assert.equal(moduleOf(ROUTER), 'invoices');
  assert.equal(moduleOf('apps\\api\\src\\trpc\\router.mjs'), 'trpc');
  assert.equal(moduleOf('router.mjs'), '(root)');
});

test('enumMembers takes string values, or member names without one, and skips comments', () => {
  assert.deepEqual(enumMembers(fixture('queues.txt'), 'Jobs'), ['send-mail', 'resize-image', 'Cleanup']);
  assert.equal(enumMembers('export enum Other { A }', 'Jobs'), null);
});

test('extractContract reads procedures per module, the legacy router and both queue kinds', async () => {
  const c = await extractContract(profile, fakeTree(baseFiles));
  assert.deepEqual(c.procedures, ['invoices.get', 'invoices.list', 'invoices.list', 'invoices.me', 'invoices.pay', 'invoices.publicSummary', 'teams.invite']);
  assert.deepEqual(c.legacy, ['pingV1', 'syncV1']);
  assert.deepEqual(c.queues, ['Cleanup', 'audit-log', 'resize-image', 'send-mail']);
  assert.equal(c.sources['procedure:invoices.pay'], ROUTER);
  assert.equal(c.sources['queue:audit-log'], QUEUES);
  assert.deepEqual(c.problems, []);
});

test('missing files and enums are listed as problems; no contract section gives empty lists', async () => {
  const c = await extractContract(profile, fakeTree({ [ROUTER]: fixture('router-base.txt'), [QUEUES]: 'export const AUDIT_QUEUE = "audit-log";' }));
  assert.deepEqual(c.problems, [`${LEGACY} was not found.`, `${QUEUES} has no enum Jobs.`]);
  assert.deepEqual(c.queues, ['audit-log']);
  assert.deepEqual(await extractContract({}, fakeTree(baseFiles)), { procedures: [], legacy: [], queues: [], sources: {}, problems: [] });
});

async function baseAndHead(headChanges) {
  const base = await extractContract(profile, fakeTree(baseFiles));
  const head = await extractContract(profile, fakeTree({ ...baseFiles, ...headChanges }));
  return { base, head };
}

test('a refactor may remove nothing; duplicates count, so one of two `list` keys going is a removal', async () => {
  const { base, head } = await baseAndHead({ [ROUTER]: fixture('router-head.txt') });
  const r = compareContract(base, head, { pipeline: 'refactor' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.removed.map(x => [x.kind, x.name, x.file]), [['procedure', 'invoices.list', ROUTER], ['procedure', 'invoices.pay', ROUTER]]);
  assert.deepEqual(r.added.map(x => x.name), ['invoices.refund']);
  assert.match(r.messages[0], /A refactor may not remove contract names/);
});

test('feature, fix and debug may remove a name when the plan lists its file (warn), not otherwise (fail)', async () => {
  const { base, head } = await baseAndHead({ [ROUTER]: fixture('router-head.txt') });
  for (const pipeline of ['feature', 'fix', 'debug']) {
    assert.equal(compareContract(base, head, { pipeline, plan: { files: [ROUTER] } }).status, 'warn', pipeline);
    assert.equal(compareContract(base, head, { pipeline, plan: { files: [OTHER] } }).status, 'fail', pipeline);
    assert.equal(compareContract(base, head, { pipeline, planFiles: [ROUTER.toUpperCase()] }).ok, true, pipeline);
  }
});

test('legacy keys and queue names are contract names too', async () => {
  const { base, head } = await baseAndHead({ [LEGACY]: LEGACY_TEXT.replace(/  pingV1.*\n/, ''), [QUEUES]: fixture('queues.txt').replace("'send-mail'", "'send-email'") });
  const r = compareContract(base, head, { pipeline: 'feature', plan: { files: [LEGACY] } });
  assert.equal(r.status, 'fail');                     // the queue file is not in the plan
  assert.deepEqual(r.removed.map(x => `${x.kind}:${x.name}`), ['legacy:pingV1', 'queue:send-mail']);
  assert.deepEqual(r.added.map(x => `${x.kind}:${x.name}`), ['queue:send-email']);
});

test('read-only pipelines report removals as information; additions alone pass', async () => {
  const { base, head } = await baseAndHead({ [ROUTER]: fixture('router-head.txt') });
  const review = compareContract(base, head, { pipeline: 'review' });
  assert.equal(review.status, 'warn');
  assert.equal(review.ok, true);
  const added = await baseAndHead({ [OTHER]: TEAMS.replace('});', '  revoke: memberProcedure.mutation(() => null),\n});') });
  const r = compareContract(added.base, added.head, { pipeline: 'refactor' });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.added.map(x => x.name), ['teams.revoke']);
  assert.equal(compareContract(base, base, { pipeline: 'refactor' }).messages.length, 0);
});

test('an unknown pipeline is treated as strictly as a refactor', async () => {
  const { base, head } = await baseAndHead({ [ROUTER]: fixture('router-head.txt') });
  assert.equal(compareContract(base, head, {}).status, 'fail');
});
