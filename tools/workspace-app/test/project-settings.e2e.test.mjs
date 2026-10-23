// End to end for project settings (plan A3: a rule saved in the app shows up in the next run's
// prompt and in a flow session, and the run records the version). The real app (createApp) over
// HTTP the way the page calls it, with the real run engine and test/fake-claude.mjs as claude,
// and the real launcher (launch.mjs realActions) whose runner records the terminal it would open
// instead of opening one. Nothing starts a real claude, a terminal or a window; the workspace
// (the synthetic "example" project) and the data folder are temporary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.mjs';
import { realActions, sessionsFile } from '../launch.mjs';
import { takePromptFile } from '../../lib/prompt-file.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, tempDir, writeFiles } from './helpers.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TOKEN = 'settings-e2e';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');

async function world(t) {
  const base = tempDir('wps', t);
  const root = join(base, 'hub');
  const dataDir = join(base, 'data');
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; });
  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  await makeRepo(join(root, 'projects', 'example'), { files: exampleRepoFiles() });
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({}) });
  const answer = join(base, 'answer.json');
  writeFileSync(answer, JSON.stringify({ answer: 'In charge().', sources: [], openQuestions: [], suggestedNote: '' }));
  const claudeCommand = () => [process.execPath, FAKE, '--fixture', 'auto', '--delay-ms', '1', '--structured-file', answer];
  // The launcher for real, but its runner only records what it would start.
  const opened = [];
  const actions = realActions({
    root, dataDir, tools: { wt: 'wt.exe', claude: 'C:\\bin\\claude.exe', edge: '', editor: null },
    runner: async (command, args) => { opened.push(decode(args[args.indexOf('-EncodedCommand') + 1])); },
  });
  let port = 0;
  const app = createApp({ root, token: TOKEN, actions, getPort: () => port, dataDir, engineOptions: { claudeCommand, timing: { tailMs: 25, tickMs: 200 } } });
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(async () => {
    await (await app.getEngine()).shutdown();
    await new Promise(r => server.close(r));
  });
  const raw = (method, path, { body, cookie } = {}) => new Promise((resolveP, reject) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${port}`, 'X-Workspace-App': '1', 'Content-Type': 'application/json' });
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolveP({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const cookie = (await raw('GET', `/?t=${TOKEN}`)).headers['set-cookie'][0].split(';')[0];
  const ok = async (method, path, body) => {
    const r = await raw(method, path, { body, cookie });
    assert.equal(r.status, 200, `${method} ${path}: ${r.text.slice(0, 500)}`);
    return r.json;
  };
  async function passed(id) {
    const end = Date.now() + 60_000;
    let last = null;
    while (Date.now() < end) {
      last = await ok('GET', `/api/run?id=${id}&since=0&limit=500`);
      if (last.run.status === 'passed') return last.run;
      if (['failed', 'cancelled', 'interrupted', 'capped'].includes(last.run.status)) break;
      await sleep(100);
    }
    assert.fail(`run ${id} is ${last && last.run.status}: ${last && last.run.statusReason}`);
  }
  const stagePrompt = id => readFileSync(join(dataDir, 'runs', 'example', id, 'stages', '00-answer', 'prompt.md'), 'utf8');
  const sessions = () => readFileSync(sessionsFile(dataDir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { root, dataDir, ok, passed, stagePrompt, opened, sessions };
}

test('a rule saved in the app reaches the next run and the next session in the project; each records its version', { timeout: 180_000 }, async t => {
  const w = await world(t);
  const v1 = await w.ok('POST', '/api/project-settings', { project: 'example', basedOn: 0, rules: '- Money is in cents.', defaults: { effort: 'high' } });
  assert.equal(v1.version, 1);
  const block1 = '<project_instructions source="workspace-rules@v1">\n- Money is in cents.\n</project_instructions>';

  // The launcher's preview already shows the rules a run started now gets.
  const preview = await w.ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'Where is tax added?' }, preview: true });
  assert.ok(preview.preview.prompt.includes(block1), 'the preview has the rules');

  // A run records v1, and its Claude stage gets v1's rules after CLAUDE.md and AGENTS.md.
  const first = await w.ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'Where is tax added?' } });
  const run1 = await w.passed(first.runId);
  assert.deepEqual(run1.projectSettings, { version: 1, sha256: v1.sha256 });
  const p1 = w.stagePrompt(first.runId);
  assert.ok(p1.indexOf('source="CLAUDE.md@') < p1.indexOf('source="AGENTS.md@') && p1.indexOf('source="AGENTS.md@') < p1.indexOf(block1), 'CLAUDE.md, AGENTS.md, then the rules');

  // A new version: the next run gets it; the first keeps the one it started with.
  const v2 = await w.ok('POST', '/api/project-settings', { project: 'example', basedOn: 1, rules: '- Money is in cents.\n- No floats.' });
  const second = await w.ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'Where are totals summed?' } });
  assert.deepEqual((await w.passed(second.runId)).projectSettings, { version: 2, sha256: v2.sha256 });
  assert.match(w.stagePrompt(second.runId), /<project_instructions source="workspace-rules@v2">\n- Money is in cents\.\n- No floats\.\n<\/project_instructions>/);
  assert.deepEqual((await w.ok('GET', `/api/run?id=${first.runId}&since=0&limit=1`)).run.projectSettings, { version: 1, sha256: v1.sha256 });

  // A flow in the project: its own model wins, the project's effort fills the gap, the rules
  // go to claude through the prompt file only, and sessions.jsonl records the version.
  const flow = await w.ok('POST', '/api/flows', { title: 'Tidy the cart', target: 'project', project: 'example', prompt: 'Tidy the cart module.', model: 'sonnet' });
  await w.ok('POST', '/api/flows/run', { slug: flow.slug });
  const flowCommand = w.opened.at(-1);
  assert.match(flowCommand, /claude-prompt\.mjs' '[^']*\.json'$/);
  assert.ok(!flowCommand.includes('No floats'), 'the rules are not in the PowerShell command');
  const handed = takePromptFile(flowCommand.match(/'([^']*\.json)'$/)[1]);
  assert.match(handed.prompt, /Tidy the cart module\./);
  assert.deepEqual([handed.launch.model, handed.launch.effort, handed.launch.appendSystemPrompt], ['sonnet', 'high', '- Money is in cents.\n- No floats.']);
  // Start Claude here in the project: no prompt, the rules all the same.
  await w.ok('POST', '/api/launch', { kind: 'project', project: 'example' });
  const here = takePromptFile(w.opened.at(-1).match(/'([^']*\.json)'$/)[1]);
  assert.deepEqual([here.prompt, here.launch.effort, here.launch.appendSystemPrompt], ['', 'high', '- Money is in cents.\n- No floats.']);
  // The hub has no project settings.
  await w.ok('POST', '/api/launch', { kind: 'hub' });
  assert.match(w.opened.at(-1), /& 'C:\\bin\\claude\.exe' '--session-id' '[0-9a-f-]{36}'$/);
  const ref2 = { version: 2, sha256: v2.sha256 };
  assert.deepEqual(w.sessions().map(s => [s.kind, s.project, s.projectSettings]), [['flow', 'example', ref2], ['project', 'example', ref2], ['hub', '', undefined]]);
});
