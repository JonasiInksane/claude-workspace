// Tests for profile/trust.mjs with a fake home folder and a fake .claude.json; the real one is
// never read. Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustCommand, trustKey, trustState } from './trust.mjs';
import { tempDir } from '../test/helpers.mjs';

function fakeHome(t, projects) {
  const home = tempDir('ws-trust-', t);
  if (projects !== undefined) {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' }, projects }));
  }
  return home;
}

test('a folder with hasTrustDialogAccepted is trusted, matched case-insensitively with either slash', async t => {
  const home = fakeHome(t, { 'C:/Users/Me/Code/Example': { hasTrustDialogAccepted: true } });
  for (const path of ['C:\\Users\\Me\\Code\\Example', 'c:\\users\\me\\code\\example\\', 'C:/Users/Me/Code/Example']) {
    const r = await trustState(path, { home });
    assert.equal(r.state, 'trusted', path);
    assert.equal(r.key, 'C:/Users/Me/Code/Example');
  }
});

test('false, missing or another folder means not trusted', async t => {
  const home = fakeHome(t, {
    'C:/Users/Me/Code/Example': { hasTrustDialogAccepted: false },
    'C:/Users/Me/Code/Other': { hasTrustDialogAccepted: true },
    'C:/Users/Me/Code/Third': {},
  });
  assert.equal((await trustState('C:\\Users\\Me\\Code\\Example', { home })).state, 'not-trusted');
  assert.equal((await trustState('C:\\Users\\Me\\Code\\Third', { home })).state, 'not-trusted');
  assert.equal((await trustState('C:\\Users\\Me\\Code\\Nowhere', { home })).state, 'not-trusted');
  assert.equal((await trustState('C:\\Users\\Me\\Code\\Other2', { home })).state, 'not-trusted', 'a name prefix is not a parent');
});

test('a trusted parent folder covers its subfolders', async t => {
  const home = fakeHome(t, { 'C:/dev/hub': { hasTrustDialogAccepted: true } });
  const r = await trustState('C:\\dev\\hub\\projects\\game', { home });
  assert.deepEqual([r.state, r.key], ['trusted', 'C:/dev/hub']);
});

test('no file, broken JSON or no projects map gives unknown', async t => {
  assert.equal((await trustState('C:\\x', { home: fakeHome(t) })).state, 'unknown');
  const broken = fakeHome(t);
  writeFileSync(join(broken, '.claude.json'), '{"projects":');
  assert.equal((await trustState('C:\\x', { home: broken })).state, 'unknown');
  const empty = fakeHome(t);
  writeFileSync(join(empty, '.claude.json'), '{"numStartups":3}');
  assert.equal((await trustState('C:\\x', { home: empty })).state, 'unknown');
});

test('the home folder comes from USERPROFILE when no home is passed', async t => {
  const home = fakeHome(t, { 'C:/Repo': { hasTrustDialogAccepted: true } });
  assert.equal((await trustState('C:\\Repo', { env: { USERPROFILE: home } })).state, 'trusted');
});

test('the command is a PowerShell line with the path single-quoted', async t => {
  assert.equal(trustCommand("C:\\Users\\Me\\it's here"), "cd 'C:\\Users\\Me\\it''s here'; claude");
  const r = await trustState('C:\\Repo', { home: fakeHome(t) });
  assert.equal(r.command, "cd 'C:\\Repo'; claude");
  assert.equal(trustKey('C:\\A\\B\\'), 'c:/a/b');
});
