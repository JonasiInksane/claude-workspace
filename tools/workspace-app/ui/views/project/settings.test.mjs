// Tests for the project page's Settings tab (views/project/settings.js) in a stand-in DOM
// (test/dom.mjs) with a fake server: the profile's status in words and the --check command; the
// editor before and after the settings load (rules with the character count, the defaults, the
// tools, the attached assets with their state from resolve and their version pins); saving with
// basedOn; the mirrored checks and a refused save's problems next to their fields; a 409 that
// keeps what was typed and offers Reload, and a newer version noticed while typing; attaching
// through the picker and removing; the versions list with View and Compare; the unsaved-changes
// guard; the projects that can't have settings; and refreshes that land late: one that left
// before a save, Reload while one is out, and a conflict that clears when the version is back.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, settle, textOf } from '../../../test/dom.mjs';

const dom = installDom({ hash: '#project/example/settings' });
after(() => dom.uninstall());

// ---------------------------------------------------------------- a fake server

const SHA = n => String(n).repeat(64).slice(0, 64);
const versions = {}; // project -> saved settings, oldest first
let postReply = null; // the next POST's answer, when a test sets one
let resolveFails = false;
// While set, GET /api/project-settings answers what was current when it was asked, once this
// promise resolves (a refresh that left before a save and lands after it).
let settingsGate = null;
const library = [
  { ref: 'shared:style-guide', id: 'style-guide', scope: 'shared', project: null, title: 'Style guide', kind: 'text', tags: ['docs'], description: '', archived: false, latest: { n: 3, sha256: SHA(3), bytes: 1200, type: 'text/markdown' }, versionCount: 3 },
  { ref: 'shared:brand', id: 'brand', scope: 'shared', project: null, title: 'Brand colours', kind: 'image', tags: ['brand'], description: '', archived: false, latest: { n: 1, sha256: SHA(1), bytes: 900, type: 'image/png' }, versionCount: 1 },
  { ref: 'shared:old-logo', id: 'old-logo', scope: 'shared', project: null, title: 'Old logo', kind: 'image', tags: [], description: '', archived: true, latest: { n: 1, sha256: SHA(4), bytes: 500, type: 'image/png' }, versionCount: 1 },
  { ref: 'example:logo', id: 'logo', scope: 'project', project: 'example', title: 'Logo', kind: 'image', tags: [], description: '', archived: false, latest: { n: 2, sha256: SHA(2), bytes: 700, type: 'image/png' }, versionCount: 2 },
];

function save(project, fields, basedOn) {
  const list = versions[project] || (versions[project] = []);
  const version = list.length + 1;
  const s = {
    format: 1, project, version, basedOn: basedOn || null, savedAt: new Date(Date.now() - (5 - version) * 3600_000).toISOString(),
    rules: fields.rules || '', defaults: { model: '', effort: '', permissionMode: '', ...(fields.defaults || {}) },
    allowedTools: fields.allowedTools || '', assets: fields.assets || [], sha256: SHA(version + 4),
  };
  list.push(s);
  return s;
}

function settingsAnswer(project) {
  const list = versions[project] || [];
  return {
    ok: true, project, current: list[list.length - 1] || null,
    versions: [...list].reverse().map(s => ({ version: s.version, savedAt: s.savedAt, sha256: s.sha256, basedOn: s.basedOn })),
    limits: { rules: 20000, assets: 50, allowedTools: 20 },
    choices: { defaults: ['model', 'effort', 'permissionMode'], effort: ['low', 'medium', 'high', 'xhigh', 'max'], permissionMode: ['manual', 'plan', 'acceptEdits', 'auto'] },
  };
}

function resolveAnswer(attachments) {
  return attachments.map(({ ref, pin }) => {
    const a = library.find(x => x.ref === ref);
    if (!a) return { ref, pin, version: pin, sha256: null, bytes: null, path: null, rel: null, type: null, kind: null, title: null, missing: true };
    const v = pin || a.latest.n;
    return { ref, pin, version: v, sha256: SHA(v), bytes: 10, path: 'x', rel: 'x', type: a.latest.type, kind: a.kind, title: a.title, ...(a.archived ? { archived: true } : {}), ...(v > a.latest.n ? { missing: true } : {}) };
  });
}

const calls = fakeFetch((path, { method, body }) => {
  const url = new URL(path, 'http://x');
  if (method === 'GET' && url.pathname === '/api/project-settings') {
    const answer = settingsAnswer(url.searchParams.get('project'));
    return settingsGate ? settingsGate.then(() => answer) : answer;
  }
  if (method === 'GET' && url.pathname === '/api/project-settings/version') {
    const s = (versions[url.searchParams.get('project')] || []).find(x => x.version === Number(url.searchParams.get('v')));
    return s ? { ok: true, project: s.project, settings: s } : reply(404, { ok: false, error: 'no such version' });
  }
  if (method === 'POST' && url.pathname === '/api/project-settings') {
    if (postReply) { const r = postReply; postReply = null; return typeof r === 'function' ? r() : r; }
    const list = versions[body.project] || [];
    const have = list.length ? list[list.length - 1].version : 0;
    if (body.basedOn !== have) return reply(409, { ok: false, error: `The settings of ${body.project} changed since you opened them: v${have} is current now, not v${body.basedOn}. Reload them, then save again.` });
    const s = save(body.project, body, have);
    return { ok: true, project: body.project, version: s.version, sha256: s.sha256, unchanged: false, message: `Saved the settings of ${body.project} as v${s.version}` };
  }
  if (method === 'GET' && url.pathname === '/api/library') {
    const project = url.searchParams.get('project');
    return { ok: true, assets: library.filter(a => a.scope === 'shared' || a.project === project) };
  }
  if (method === 'GET' && url.pathname === '/api/project') {
    return { ok: true, profile: { exists: true, valid: true, errors: [], warnings: [], path: 'C:\\data\\profiles\\example.json' } };
  }
  if (method === 'POST' && url.pathname === '/api/library/resolve') {
    return resolveFails ? reply(400, { ok: false, error: 'other:x belongs to projects/other' }) : { ok: true, items: resolveAnswer(body.attachments) };
  }
  return { ok: true, message: 'Created.', pipelines: [], routes: [], projects: [] };
});

const store = await import('../../store.js');
const { onData, reload, slot } = await import('../../parts/project-data.js');
const { mayLeave, guardedHash } = await import('../../parts/leave-guard.js');
const { checkCommand, profileStatus, default: settings } = await import('./settings.js');

const dialog = dom.document.querySelector('#dialog');
const toasts = () => dom.document.querySelector('#toasts').textContent;
const ctx = p => ({ state: store.state, project: p, rest: '', go: store.go, refresh: () => {} });
const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'settings'], realPath: 'C:\\x' };
const notes = { name: 'notes', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'settings'], realPath: 'C:\\y' };
store.setState({ root: 'C:\\ws', tools: {}, projects: [example, notes], assets: [] });

// Shows the tab for `p`, waits for its data and paints it again (project.js repaints on every
// answer; here the test does).
async function open(p) {
  const el = dom.document.createElement('div');
  dom.document.body.append(el);
  settings.onShow(ctx(p));
  settings.render(el, ctx(p));
  await settle(5);
  settings.render(el, ctx(p));
  await settle(150); // the attachments' resolve is debounced
  return el;
}
const paint = (el, p = example) => settings.render(el, ctx(p));
const q = (el, sel) => el.querySelector(sel);
const byKey = (el, key) => el.querySelectorAll('[data-key]').find(n => n.dataset.key === key);
function type(control, value, event = 'input') {
  control.value = value;
  control.dispatchEvent(fakeEvent(event));
}

test('profileStatus: valid, with warnings, with problems, missing and not loaded', () => {
  assert.deepEqual(profileStatus({ exists: true, valid: true, errors: [], warnings: [] }), { state: 'valid', text: 'Present and valid.', items: [] });
  assert.deepEqual(profileStatus({ exists: true, valid: true, warnings: ['Old field'] }), { state: 'valid', text: 'Present and valid, with 1 warning.', items: ['Old field'] });
  assert.deepEqual(profileStatus({ exists: true, valid: false, errors: ['a', 'b'] }), { state: 'invalid', text: 'The profile has 2 problems.', items: ['a', 'b'] });
  assert.equal(profileStatus({ exists: false }).state, 'missing');
  assert.equal(profileStatus(null).state, 'unknown');
  assert.equal(profileStatus('x').state, 'unknown');
  assert.equal(checkCommand('example'), 'node tools/workspace-app/profile/profile.mjs --check example');
});

test('nothing saved yet: where the settings apply, an empty editor, no versions, and the profile below', async () => {
  const el = dom.document.createElement('div');
  settings.render(el, ctx(example));
  assert.match(textOf(el), /Rules and settings Loading…/, 'before the answer');
  settings.onShow(ctx(example));
  await settle(5);
  slot('example').project = { data: { profile: { exists: true, valid: false, errors: ['commands.test is missing'], warnings: [], path: 'C:\\data\\profiles\\example.json' } } };
  paint(el);
  const text = textOf(el);
  assert.match(text, /Where these apply: every Claude stage of runs in this project .* every session the app starts here: Start Claude here, skills, flows and agents/);
  assert.match(text, /Nothing saved yet: the first save makes v1/);
  assert.match(text, /0 \/ 20,000 characters/);
  assert.match(text, /No assets attached\./);
  assert.match(text, /Runs, sessions and flows started here get them in those versions \(a run copies them into its inputs\)\. A missing one stops the start; an archived one is still used\./);
  assert.match(text, /No versions yet\. The first save makes v1\./);
  assert.match(text, /Has problems The profile has 1 problem\./);
  assert.match(text, /node tools\/workspace-app\/profile\/profile\.mjs --check example/);
  const rules = q(el, 'textarea');
  assert.equal(rules.getAttribute('id'), 'st-rules-example');
  assert.ok(q(el, 'label[for="st-rules-example"]'), 'the rules have a label');
  assert.equal(byKey(el, 'st:save:example').disabled, true, 'nothing to save');
  assert.ok(calls.some(c => c.path === '/api/project-settings?project=example'));
  assert.ok(calls.some(c => c.path === '/api/library?project=example&archived=1'));
  assert.equal(guardedHash(), '#project/example/settings', 'the tab guards its draft');
  settings.onHide();
  assert.equal(guardedHash(), '');
});

test('typing counts and checks as you go; Save sends every field with basedOn and becomes the next version', async () => {
  const el = await open(example);
  const rules = q(el, '#st-rules-example');
  type(rules, '- Money is in cents.\n- Tests first.');
  assert.match(textOf(el), /35 \/ 20,000 characters/);
  assert.match(textOf(el), /Unsaved changes/);
  // The mirrored checks: a model with a space, a tool rule that isn't one.
  type(q(el, '#st-model-example'), 'opus 4');
  type(q(el, '#st-tools-example'), 'Read, Bash(');
  assert.match(textOf(q(el, '#st-model-problems-example')), /alias such as opus or sonnet/);
  assert.equal(q(el, '#st-model-example').getAttribute('aria-invalid'), 'true');
  assert.match(textOf(q(el, '#st-allowedTools-problems-example')), /"Bash\(" is not a tool rule/);
  assert.equal(byKey(el, 'st:save:example').disabled, true);
  assert.match(textOf(el), /Fix the marked fields first\./);
  type(q(el, '#st-model-example'), 'sonnet');
  type(q(el, '#st-tools-example'), 'Read, Grep');
  type(q(el, '#st-effort-example'), 'high', 'change');
  assert.equal(q(el, '#st-model-example').getAttribute('aria-invalid'), null);
  const saveBtn = byKey(el, 'st:save:example');
  assert.equal(saveBtn.disabled, false);
  dom.click(saveBtn);
  await settle(5);
  const post = calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop();
  assert.deepEqual(post.body, {
    project: 'example', basedOn: 0, rules: '- Money is in cents.\n- Tests first.', defaults: { model: 'sonnet', effort: 'high', permissionMode: '' },
    allowedTools: 'Read, Grep', assets: [],
  });
  assert.match(toasts(), /Saved the settings of example as v1/);
  paint(el);
  assert.match(textOf(el), /Saved as v1/);
  assert.match(textOf(el), /v1 current Saved .* · the first/);
  assert.equal(byKey(el, 'st:save:example').disabled, true);
  // Trailing spaces change nothing the server would store: still saved.
  type(rules, '- Money is in cents.\n- Tests first.   \n\n');
  assert.match(textOf(el), /Saved as v1/);
  settings.onHide();
});

test('a refused save shows the server\'s sentences next to their fields; anything else below', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- One more rule.');
  postReply = reply(400, { ok: false, error: 'The settings were not saved: allowedTools: "Grep(a" is not a tool rule. Use names like Read or Bash(npm test:*); "x" is not a project setting (use rules, defaults, allowedTools, assets).' });
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  assert.match(textOf(q(el, '#st-allowedTools-problems-example')), /"Grep\(a" is not a tool rule/);
  assert.equal(q(el, '#st-tools-example').getAttribute('aria-invalid'), 'true');
  assert.match(textOf(q(el, '.st-alerts .form-error')), /"x" is not a project setting/);
  assert.equal(q(el, '#st-rules-example').value, '- One more rule.', 'nothing typed is lost');
  // The next edit clears the server's verdict (it was about the old text).
  type(q(el, '#st-rules-example'), '- One more rule!');
  assert.equal(q(el, '#st-allowedTools-problems-example').hidden, true);
  // A network failure says nothing was saved.
  postReply = () => { throw new Error('down'); };
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  assert.match(textOf(el), /could not be reached; nothing was saved/);
  settings.onHide();
});

test('a 409 keeps what you typed and offers Reload; Reload loads the current version', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- Mine.');
  save('example', { rules: '- Theirs.' }, 1); // v2, saved elsewhere
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  paint(el);
  const box = q(el, '.st-conflict');
  assert.equal(box.hidden, false);
  assert.equal(box.getAttribute('role'), 'alert');
  assert.match(textOf(box), /changed since you opened them: v2 is current now, not v1/);
  assert.match(textOf(box), /What you typed stays here until you choose/);
  assert.equal(q(el, '#st-rules-example').value, '- Mine.');
  assert.equal(byKey(el, 'st:save:example').disabled, true);
  assert.match(textOf(el), /Reload first\./);
  // Compare: the current version next to your changes.
  dom.click(byKey(el, 'st:compare-mine:example'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /Compare v2 \(current\) with Your changes/);
  assert.match(textOf(dialog), /- - Theirs\./);
  assert.match(textOf(dialog), /\+ - Mine\./);
  dialog.close();
  dom.click(byKey(el, 'st:reload:example'));
  await settle(5);
  paint(el);
  assert.equal(q(el, '#st-rules-example').value, '- Theirs.');
  assert.equal(q(el, '.st-conflict').hidden, true);
  assert.match(textOf(el), /Saved as v2/);
  settings.onHide();
});

test('a newer version that arrives while you type is noticed before you save', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- Draft.');
  save('example', { rules: '- Elsewhere.' }, 2); // v3
  await settings.onShow(ctx(example));
  await settle(5);
  paint(el);
  assert.match(textOf(q(el, '.st-conflict')), /v3 of these settings was saved elsewhere since you opened v2, so a save now would be refused/);
  assert.equal(q(el, '#st-rules-example').value, '- Draft.');
  // A clean editor just moves on to the newer version.
  globalThis.confirm = () => true;
  dom.click(byKey(el, 'st:discard:example'));
  paint(el);
  assert.equal(q(el, '#st-rules-example').value, '- Elsewhere.');
  assert.equal(q(el, '.st-conflict').hidden, true);
  settings.onHide();
});

test('attached assets: their state from resolve, a pin per asset, Remove, and Attach… through the picker', async () => {
  save('example', { rules: '- Elsewhere.', assets: [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:logo', pin: 2 }, { ref: 'shared:gone', pin: null }, { ref: 'shared:old-logo', pin: null }] }, 3); // v4
  const el = await open(example);
  const rows = el.querySelectorAll('.st-asset');
  assert.equal(rows.length, 4);
  const titleAndSub = r => `${r.querySelector('.title').textContent} | ${r.querySelector('.sub').textContent}`;
  assert.equal(titleAndSub(rows[0]), 'Style guide | shared:style-guide · Text · uses v3');
  assert.equal(titleAndSub(rows[1]), 'Logo | example:logo · Image · uses v2');
  assert.equal(titleAndSub(rows[2]), 'shared:gone | ', 'a missing asset is named by its ref, once');
  assert.equal(rows[2].querySelector('.badge').textContent, 'Missing');
  assert.equal(rows[3].querySelector('.badge').textContent, 'Archived');
  assert.doesNotMatch(textOf(rows[0]), /null/);
  const pin = byKey(el, 'st:pin:example:logo');
  assert.equal(pin.value, '2');
  assert.deepEqual(pin.children.map(o => o.textContent), ['Latest (v2)', 'v2', 'v1']);
  assert.equal(pin.getAttribute('aria-label'), 'Version of Logo');
  assert.deepEqual(byKey(el, 'st:pin:shared:style-guide').children.map(o => o.textContent), ['Latest (v3)', 'v3', 'v2', 'v1']);
  const resolve = calls.filter(c => c.path === '/api/library/resolve').pop();
  assert.equal(resolve.body.project, 'example');
  assert.equal(resolve.body.attachments.length, 4);
  // Follow the latest instead of v2: a change to save.
  type(pin, '', 'change');
  assert.match(textOf(el), /Unsaved changes/);
  dom.click(byKey(el, 'st:rm:shared:gone'));
  assert.equal(el.querySelectorAll('.st-asset').length, 3);
  // The picker: shared assets and example's own, not archived ones; attached ones are fixed.
  dom.click(byKey(el, 'st:attach:example'));
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /Attach assets to example/);
  const items = dialog.querySelectorAll('.lib-pick');
  assert.deepEqual(items.map(i => i.querySelector('.title').textContent), ['Style guide', 'Brand colours', 'Logo']);
  const boxes = items.map(i => i.querySelector('input'));
  assert.deepEqual(boxes.map(b => [b.checked, b.disabled]), [[true, true], [false, false], [true, true]]);
  boxes[1].checked = true;
  boxes[1].dispatchEvent(fakeEvent('change'));
  dom.click(dialog.querySelector('[data-key="pk:attach"]'));
  await settle(150);
  assert.equal(dialog.open, false);
  assert.match(toasts(), /1 asset attached; save to keep it/);
  assert.deepEqual(el.querySelectorAll('.st-asset').map(r => r.querySelector('.title').textContent), ['Style guide', 'Logo', 'Old logo', 'Brand colours']);
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  const post = calls.filter(c => c.method === 'POST' && c.path === '/api/project-settings').pop();
  assert.deepEqual(post.body.assets, [{ ref: 'shared:style-guide', pin: null }, { ref: 'example:logo', pin: null }, { ref: 'shared:old-logo', pin: null }, { ref: 'shared:brand', pin: null }]);
  assert.equal(post.body.basedOn, 4);
  // A refused resolve says so under the list.
  resolveFails = true;
  type(byKey(el, 'st:pin:shared:style-guide'), '1', 'change');
  await settle(150);
  assert.match(textOf(el), /Their state could not be checked: other:x belongs to projects\/other/);
  resolveFails = false;
  settings.onHide();
});

test('versions: the list with the current one marked; View shows one read-only; Compare diffs it with the current', async () => {
  const el = await open(example);
  const card = q(el, '.st-versions');
  assert.match(textOf(card), /v5 current Saved .* · based on v4/);
  assert.equal(card.querySelectorAll('li').length, 5);
  dom.click(byKey(card, 'st:view:2'));
  await settle(5);
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /Settings v2 of example/);
  assert.equal(dialog.querySelector('pre.st-rules-view').textContent, '- Theirs.');
  assert.match(textOf(dialog), /Model Your own default/);
  assert.match(textOf(dialog), /SHA-256 6{64}/);
  dialog.close();
  dom.click(byKey(card, 'st:cmp:2'));
  await settle(5);
  assert.match(textOf(dialog), /Compare v2 with v5 · example/);
  assert.match(textOf(dialog), /Rules, v2 to v5\s*1 line added, 1 removed/);
  const diffLines = dialog.querySelector('pre.textdiff').children;
  assert.deepEqual(diffLines.map(s => s.className), ['del', 'add']);
  const changed = dialog.querySelectorAll('tr.changed').map(r => r.querySelector('th').textContent);
  assert.deepEqual(changed, ['Attached assetschanged']);
  assert.match(textOf(dialog), /Attached shared:style-guide \(latest\)/);
  dialog.close();
  // The current version compares with the one before it.
  dom.click(byKey(card, 'st:cmp:5'));
  await settle(5);
  assert.match(textOf(dialog), /Compare v4 with v5/);
  dialog.close();
  settings.onHide();
});

test('the guard: leaving with unsaved changes asks; Cancel keeps the draft, OK drops it', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- Unsaved.');
  dom.location.hash = '#today';
  assert.equal(mayLeave('#today', () => false), false);
  assert.equal(dom.location.hash, '#project/example/settings');
  paint(el);
  assert.equal(q(el, '#st-rules-example').value, '- Unsaved.', 'still there after a repaint');
  assert.equal(mayLeave('#today', () => true), true);
  settings.onHide();
  const again = await open(example);
  assert.notEqual(q(again, '#st-rules-example').value, '- Unsaved.', 'a discarded draft is gone');
  settings.onHide();
});

test('a plain project: Create from the example; an uppercase name has no settings and asks for none', async () => {
  const el = await open(notes);
  assert.match(textOf(el), /No profile\. With one, this becomes a code project/);
  assert.ok(q(el, '#st-rules-notes'), 'every project with a lowercase name gets the editor');
  dom.click(byKey(el, 'st:create'));
  await settle(5);
  assert.deepEqual(calls.find(c => c.path === '/api/project/profile-init').body, { project: 'notes' });
  settings.onHide();
  const upper = { ...notes, name: 'BigApp' };
  const n = calls.length;
  const el2 = await open(upper);
  assert.match(textOf(el2), /No settings for this folder name/);
  assert.match(textOf(el2), /A profile needs a lowercase folder name/);
  assert.equal(q(el2, 'textarea'), null);
  assert.ok(!calls.slice(n).some(c => c.path.includes('BigApp')), 'nothing is asked for that name');
  assert.equal(guardedHash(), '', 'nothing to guard');
  settings.onHide();
});

test('a refresh that left before your save lands after it: no flip back, no false conflict', async () => {
  const el = await open(example);
  const seen = []; // [rules, conflict shown] at every repaint, as project.js repaints on every answer
  const off = onData(() => { paint(el); seen.push([q(el, '#st-rules-example').value, !q(el, '.st-conflict').hidden]); });
  const have = versions.example.length;
  // Saved, then typed on: the late answer (the version before the save) is no save elsewhere.
  type(q(el, '#st-rules-example'), '- Saved here.');
  let release;
  settingsGate = new Promise(r => { release = r; });
  reload('example');
  await settle();
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  type(q(el, '#st-rules-example'), '- Saved here, and more.');
  settingsGate = null;
  release();
  await settle(10);
  assert.ok(seen.length && seen.every(([, conflict]) => !conflict), JSON.stringify(seen));
  assert.equal(byKey(el, 'st:save:example').disabled, false, 'Save is not blocked');
  // Saved and clean: the late answer does not put the version before back for a moment.
  seen.length = 0;
  settingsGate = new Promise(r => { release = r; });
  reload('example');
  await settle();
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  settingsGate = null;
  release();
  await settle(10);
  assert.ok(seen.length && seen.every(([rules, conflict]) => rules === '- Saved here, and more.' && !conflict), JSON.stringify(seen));
  assert.match(textOf(el), new RegExp(`Saved as v${have + 2}`));
  off();
  settings.onHide();
});

test('Reload in the conflict note shows a save that landed while a refresh was out', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- Mine again.');
  save('example', { rules: '- Theirs again.' }, versions.example.length);
  dom.click(byKey(el, 'st:save:example'));
  await settle(5);
  paint(el);
  assert.equal(q(el, '.st-conflict').hidden, false);
  let release;
  settingsGate = new Promise(r => { release = r; });
  reload('example'); // out with "Theirs again"
  await settle();
  const newest = save('example', { rules: '- Newest.' }, versions.example.length);
  dom.click(byKey(el, 'st:reload:example'));
  await settle(5);
  settingsGate = null;
  release();
  await settle(10);
  paint(el);
  assert.equal(dom.document.querySelector('#toasts').lastChild.textContent, `Loaded v${newest.version}`);
  assert.equal(q(el, '#st-rules-example').value, '- Newest.');
  assert.equal(q(el, '.st-conflict').hidden, true);
  settings.onHide();
});

test('a conflict a refresh raised goes again once the current version is the editor\'s own again', async () => {
  const el = await open(example);
  type(q(el, '#st-rules-example'), '- Typed while they were gone.');
  const kept = versions.example;
  versions.example = [];
  await reload('example');
  paint(el);
  assert.match(textOf(q(el, '.st-conflict')), /are gone from the data folder, so a save now would be refused/);
  assert.equal(byKey(el, 'st:save:example').disabled, true);
  versions.example = kept;
  await reload('example');
  paint(el);
  assert.equal(q(el, '.st-conflict').hidden, true, 'back as they were: nothing to reload');
  assert.equal(byKey(el, 'st:save:example').disabled, false);
  assert.equal(q(el, '#st-rules-example').value, '- Typed while they were gone.');
  globalThis.confirm = () => true;
  dom.click(byKey(el, 'st:discard:example'));
  settings.onHide();
});
