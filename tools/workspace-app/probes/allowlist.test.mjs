// Tests for probes/allowlist.mjs: the "Rebuild allowlist" proposal from a fresh scan, and saving
// and loading the list in the private data folder (never the hub). Writes only under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, writeFiles } from '../test/helpers.mjs';
import { allowlistProposal, loadAllowlist, saveAllowlist } from './allowlist.mjs';

const PROJECT = 'example';

// A scan result (or a stored scan) with an unfiltered and a filtered router-keys probe.
const scanWith = (nonShop, extra = {}) => ({
  values: {
    publicTeamId: { value: 1, nonShop: ['billing.only'], filtered: true },
    procedures: { value: 9, nonShop, filtered: false },
    ...extra,
  },
});

test('the first proposal sets the allowlist up from the scan', () => {
  const p = allowlistProposal(scanWith(['teams.mine', 'billing.webhook', 'teams.mine']), null);
  assert.deepEqual(p, { add: ['billing.webhook', 'teams.mine'], remove: [], list: ['billing.webhook', 'teams.mine'], setUp: false });
});

test('a later proposal lists what a fresh scan adds and removes', () => {
  const current = ['billing.webhook', 'core.health', 'old.gone'];
  const p = allowlistProposal(scanWith(['core.health', 'billing.webhook', 'teams.members.invite']), current);
  assert.deepEqual(p, {
    add: ['teams.members.invite'], remove: ['old.gone'], list: ['billing.webhook', 'core.health', 'teams.members.invite'], setUp: true,
  });
  // The saved file object works as `current` too.
  assert.deepEqual(allowlistProposal(scanWith(['core.health']), { version: 1, list: ['core.health'] }), { add: [], remove: [], list: ['core.health'], setUp: true });
});

test('the proposal finds the procedures probe, or the one you name', () => {
  // Without "procedures", the first unfiltered router-keys entry is used, never a filtered one.
  const other = { values: { filteredFirst: { nonShop: ['x.filtered'], filtered: true }, routes: { nonShop: ['x.y'], filtered: false } } };
  assert.deepEqual(allowlistProposal(other, null).list, ['x.y']);
  assert.deepEqual(allowlistProposal(scanWith(['a.b']), null, { probe: 'publicTeamId' }).list, ['billing.only']);
  assert.throws(() => allowlistProposal({ values: { asNever: { value: 3 } } }, null), /The scan has no procedure list/);
  assert.throws(() => allowlistProposal(scanWith(['a.b']), null, { probe: 'nope' }), /no procedure list/);
  assert.throws(() => allowlistProposal(null, null), /no procedure list/);
});

test('the proposal refuses entries that are not procedure ids', () => {
  assert.throws(() => allowlistProposal(scanWith(['ok.id', '../x']), null), /"\.\.\/x" is not a procedure id/);
  assert.throws(() => allowlistProposal(scanWith(['ok.id']), ['bad id']), /"bad id" is not a procedure id/);
  assert.throws(() => allowlistProposal(scanWith(['ok.id']), { list: 'nope' }), /must be a list/);
});

test('saveAllowlist writes a sorted list next to the profile in the data folder', async t => {
  const dataDir = tempDir('wp6-allow-', t);
  const r = await saveAllowlist(dataDir, PROJECT, ['teams.mine', 'billing.webhook', 'teams.mine'], { source: { scanId: 's-261022-100000', sha: 'abc' } });
  assert.equal(r.path, join(dataDir, 'profiles', 'example.allowlist.json'));
  assert.equal(r.count, 2);
  const doc = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.project, PROJECT);
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.source, { scanId: 's-261022-100000', sha: 'abc' });
  assert.deepEqual(doc.list, ['billing.webhook', 'teams.mine']);
  assert.ok(Number.isFinite(Date.parse(doc.updatedAt)));
  assert.deepEqual(readdirSync(dataDir), ['profiles']);
  assert.deepEqual(await loadAllowlist(dataDir, PROJECT), ['billing.webhook', 'teams.mine']);
  // Saving the proposal's list round-trips: the next proposal has nothing to change.
  const p = allowlistProposal(scanWith(['billing.webhook', 'teams.mine']), await loadAllowlist(dataDir, PROJECT));
  assert.deepEqual([p.add, p.remove, p.setUp], [[], [], true]);
});

test('loadAllowlist gives null before the first save and refuses a broken file', async t => {
  const dataDir = tempDir('wp6-allow-', t);
  assert.equal(await loadAllowlist(dataDir, PROJECT), null);
  writeFiles(dataDir, { 'profiles/example.allowlist.json': { version: 1 } });
  await assert.rejects(loadAllowlist(dataDir, PROJECT), /example\.allowlist\.json has no list/);
  writeFiles(dataDir, { 'profiles/example.allowlist.json': '{ "list": [' });
  await assert.rejects(loadAllowlist(dataDir, PROJECT), /is not valid JSON/);
  await assert.rejects(saveAllowlist(dataDir, PROJECT, 'x'), /must be a list of procedure ids/);
  await assert.rejects(saveAllowlist(dataDir, '../hub', ['a.b']), /is not a project name/);
  await assert.rejects(saveAllowlist(dataDir, PROJECT, Array.from({ length: 5001 }, (_, i) => `m.k${i}`)), /more than 5000 entries/);
});
