// End to end for the Ask panel's questions (hub spec plan A7): the real app (createApp) with the
// real run engine, driven over HTTP the way the page drives it (sign-in cookie, Origin,
// X-Workspace-App), with test/fake-claude.mjs as claude, in the style of test/e2e.test.mjs.
//
// One temporary workspace holds a copy of pipelines/app and the synthetic "example" project (a git
// repo matching the fake profile); its data folder holds the run fixtures (the review gate run the
// questions are about) and a findings board. Each Explain stage gets its own structured answer
// through engineOptions.claudeCommand. Covered: a question about a run (parent, context in
// run.json, inputs/context.md hashed, the prompt's context block with the run's facts and diff),
// a follow-up (parent is the first question, the thread names it, the prompt carries the first
// question and answer), and a question about a finding (its run as parent, its record in the
// prompt). Nothing here starts a real claude or touches a real repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.mjs';
import { saveFindings } from '../findings/store.mjs';
import { installRunFixtures } from './fixtures/runs/install.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, tempDir, writeFiles } from './helpers.mjs';

const HUB = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TOKEN = 'ask-e2e-token';
const REVIEW_GATE = '261022-100010-refactor-review-gate';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function world(t) {
  const base = tempDir('wa', t);
  const root = join(base, 'hub');
  const dataDir = join(base, 'data');
  const fakeDir = join(base, 'fake');
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; });
  cpSync(join(HUB, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  await makeRepo(join(root, 'projects', 'example'), { files: exampleRepoFiles() });
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile() });
  writeFiles(fakeDir, { 'none.json': {} });
  await installRunFixtures(dataDir, { profile: false });
  await saveFindings(dataDir, 'example', { version: 1, project: 'example', phases: [], findings: [
    { id: 'EX-1', title: 'Cart total rounds wrong', severity: 'high', phase: '1', area: 'web', status: 'in-run', statusSource: 'run', blast: 'small',
      ownerDecision: false, records: [], commits: [], branch: null, runId: REVIEW_GATE, evidence: 'total() sums floats', notes: '', history: [] }] });

  // The answers, one per Explain stage in order.
  const answers = [];
  let n = 0;
  const claudeCommand = opts => {
    const f = join(fakeDir, `answer-${++n}-${opts.attempt}.json`);
    writeFileSync(f, JSON.stringify(answers.shift() || { answer: 'No scripted answer.', sources: [], openQuestions: [], suggestedNote: '' }));
    return [process.execPath, FAKE, '--fixture', 'auto', '--delay-ms', '1', '--structured-file', f];
  };
  const actions = { tools: { wt: '', claude: '', edge: '', editor: null }, startClaude: async () => ({}), runTool: async () => ({}) };
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
  const signIn = await raw('GET', `/?t=${TOKEN}`);
  const cookie = signIn.headers['set-cookie'][0].split(';')[0];
  const ok = async (method, path, body) => {
    const r = await raw(method, path, { body, cookie });
    assert.equal(r.status, 200, `${method} ${path}: ${r.text.slice(0, 500)}`);
    return r.json;
  };
  // Asks and waits for the run to pass; returns the run as the page sees it.
  async function ask(what, context, answer) {
    answers.push(answer);
    const { runId } = await ok('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what }, context });
    const end = Date.now() + 60_000;
    let last = null;
    while (Date.now() < end) {
      last = (await ok('GET', `/api/run?id=${runId}&limit=1`)).run;
      if (last.status === 'passed') return last;
      if (last.status !== 'running') break;
      await sleep(100);
    }
    assert.fail(`run ${runId} is ${last && last.status}: ${last && last.statusReason}`);
  }
  const runFolder = id => join(dataDir, 'runs', 'example', id);
  const prompt = id => readFileSync(join(runFolder(id), 'stages', '00-answer', 'prompt.md'), 'utf8');
  return { dataDir, ask, ok, runFolder, prompt };
}

test('Ask: a question about a run, a follow-up and a question about a finding, through the real engine', { timeout: 180_000 }, async t => {
  const w = await world(t);

  const first = await w.ask('Why a cents helper?', { run: REVIEW_GATE },
    { answer: 'To keep money in whole cents: total() calls sumCents (apps/web/src/features/cart/total.mjs:3).',
      sources: [{ path: 'apps/web/src/features/cart/total.mjs', line: 3, note: 'the call' }], openQuestions: [], suggestedNote: '' });
  assert.equal(first.parent, REVIEW_GATE, 'the run asked about is the parent');
  assert.deepEqual(first.context, { kind: 'run', run: REVIEW_GATE, title: 'Refactor: Move cart totals into a cents helper', after: null, thread: [] });
  assert.match(first.outputs.answer.answer, /whole cents/);
  const runJson = JSON.parse(readFileSync(join(w.runFolder(first.id), 'run.json'), 'utf8'));
  const contextFile = readFileSync(join(w.runFolder(first.id), 'inputs', 'context.md'), 'utf8');
  assert.equal(runJson.inputsHashes['context.md'], `sha256:${createHash('sha256').update(contextFile).digest('hex')}`, 'context.md is hashed like every input');
  const p1 = w.prompt(first.id);
  assert.ok(p1.includes(`<data name="context">\n${contextFile}\n</data>`), 'the prompt shows the context as data');
  for (const want of ['Run 261022-100010-refactor-review-gate: Refactor: Move cart totals into a cents helper', 'waiting for the user at the review gate',
    'Summary: Move the cart total into a cents helper.', 'Verdict: ship', '+export const total = items => sumCents(items);']) {
    assert.ok(p1.includes(want), `the prompt has: ${want}`);
  }

  const second = await w.ask('Does the pin test still pass?', { run: REVIEW_GATE, after: first.id },
    { answer: 'Yes: the pin test checks total([1, 2, 3]) is 6.', sources: [], openQuestions: [], suggestedNote: '' });
  assert.equal(second.parent, first.id, 'a follow-up hangs under the previous question');
  assert.deepEqual(second.context.thread, [first.id]);
  const p2 = w.prompt(second.id);
  assert.ok(p2.includes(`Q1 (run ${first.id}): Why a cents helper?\nA1: To keep money in whole cents`), 'the follow-up carries the thread');
  assert.ok(p2.indexOf('# Earlier questions') < p2.indexOf('## Diff'));

  const third = await w.ask('Is this finding real?', { finding: { project: 'example', id: 'EX-1' } },
    { answer: 'Yes: total() sums floats.', sources: [], openQuestions: [], suggestedNote: '' });
  assert.equal(third.parent, REVIEW_GATE, "a finding's question hangs under the finding's run");
  assert.equal(third.context.title, 'EX-1: Cart total rounds wrong');
  assert.ok(w.prompt(third.id).includes('Finding EX-1 of example: Cart total rounds wrong'));
  assert.ok(w.prompt(third.id).includes('## Evidence\n\ntotal() sums floats'));

  // The runs index records the parents, so the Tasks tab groups the questions under the run.
  const rows = (await w.ok('GET', '/api/runs?project=example&pipeline=explain&limit=10')).runs;
  assert.deepEqual([first.id, second.id, third.id].map(id => rows.find(r => r.id === id).parent), [REVIEW_GATE, first.id, REVIEW_GATE]);
});
