// HTTP handler for the workspace app. server.mjs owns the listening socket and the window;
// this file owns the access checks, the static page, the two sandboxed file routes (/img and
// /asset-file) and the dispatch to the JSON API in routes/*.mjs, so tests can drive it with a
// fake `actions` object (see app.test.mjs).
//
// Access: the app only answers on 127.0.0.1/localhost with the right port (Host check). The
// launch URL carries a sign-in token (/?t=...) that is new for every run of the server; it
// becomes an HttpOnly SameSite=Strict cookie, and every request except /health and the sign-in
// itself needs that cookie. POST requests also need a same-origin Origin header and the
// X-Workspace-App header, which other web pages cannot send without a CORS preflight that this
// server never approves.
//
// The API: each module in ROUTE_MODULES exports routes(ctx), an object that maps
// 'METHOD /api/path' to an async handler (req, res, url). A handler returns the JSON body to
// send with status 200, or undefined when it has answered itself (streaming). It refuses with
// `throw new HttpError(status, message)`, which becomes { ok: false, error: message }.
//
// The run engine (runs/wiring.mjs: the run manager with the real executor) is made lazily:
// ctx.getEngine() creates it on the first call and returns the same promise after that, so
// creating an app never starts one. Route handlers call it inside a handler, never in routes(ctx).
// server.mjs calls handler.getEngine() at startup (recovery before listening) and stops the
// engine before every exit; handler.isBusy() is also true while the engine runs a stage or check
// or applies a click.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { contentTypeFor, isInside } from './uploads.mjs';
import { assetFile } from './assets.mjs';
import { cookies, HttpError, json, listUiFiles, sameToken, send, sendStatic } from './http.mjs';
import { assetProjectOrThrow } from './lookup.mjs';
import { invalidateState } from './state.mjs';
import { createEngine } from './runs/wiring.mjs';
import * as agentRoutes from './routes/agents.mjs';
import * as assetRoutes from './routes/assets.mjs';
import * as flowRoutes from './routes/flows.mjs';
import * as imageRoutes from './routes/images.mjs';
import * as launchRoutes from './routes/launch.mjs';
import * as projectRoutes from './routes/projects.mjs';
import * as stateRoutes from './routes/state.mjs';
import * as toolRoutes from './routes/tools.mjs';
import * as runRoutes from './routes/runs.mjs';
import * as eventRoutes from './routes/events.mjs';
import * as cockpitRoutes from './routes/cockpit.mjs';
import * as checkRoutes from './routes/checks.mjs';
import * as findingRoutes from './routes/findings.mjs';
import * as metricRoutes from './routes/metrics.mjs';
import * as settingRoutes from './routes/settings.mjs';
import * as todayRoutes from './routes/today.mjs';
import * as projectSettingRoutes from './routes/project-settings.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
// A new routes/<area>.mjs goes in this list.
export const ROUTE_MODULES = [stateRoutes, imageRoutes, agentRoutes, assetRoutes, launchRoutes, flowRoutes, toolRoutes, projectRoutes,
  runRoutes, eventRoutes, cockpitRoutes, checkRoutes, findingRoutes, metricRoutes, settingRoutes, todayRoutes,
  projectSettingRoutes];
const ROUTE_KEY = /^(GET|POST) \/api\/[a-z0-9/-]+$/;

// Where the app keeps data that must not go into the (public) workspace repo:
// %LOCALAPPDATA%\claude-workspace. Nothing creates it until a feature writes there.
export function defaultDataDir(env = process.env) {
  return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-workspace');
}

// One route table from several. A key defined twice, or not shaped 'GET /api/...' or
// 'POST /api/...', is a programming error: it throws when the app starts.
export function mergeRoutes(tables) {
  const all = {};
  for (const table of tables) {
    for (const [key, fn] of Object.entries(table)) {
      if (!ROUTE_KEY.test(key)) throw new Error(`workspace-app: bad route key "${key}"`);
      if (typeof fn !== 'function') throw new Error(`workspace-app: route "${key}" has no handler`);
      if (key in all) throw new Error(`workspace-app: route "${key}" is defined twice`);
      all[key] = fn;
    }
  }
  return all;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// Options:
//   root, token, actions, getPort  the workspace, the sign-in token, the side effects (launch.mjs
//                                  realActions, or a recorder in tests) and the listening port
//   workspaceTag  a short hash of the root that /health reports, so a second start of the app
//                 can tell its own workspace's server from another one
//   onPing        called on every heartbeat (POST /api/ping)
//   uiDir         the page's folder (default ui/ next to this file), scanned once here
//   dataDir       private data folder (default defaultDataDir()); tests pass a temp folder
//   isBusy        optional () => boolean: true while work is running that must not be cut off
//                 (server.mjs asks handler.isBusy() before an idle shutdown)
//   engineOptions for the run engine (runs/wiring.mjs createEngine): fakeClaude, claudeCommand,
//                 limits, timing. Tests and the --fake-claude dev flag use them.
// Returns the request handler, with handler.isBusy() and handler.getEngine() attached.
export function createApp({
  root, token, actions, getPort, workspaceTag = '', onPing = () => {}, uiDir = join(appDir, 'ui'),
  dataDir = defaultDataDir(), isBusy = null, engineOptions = {},
}) {
  root = resolve(root);
  dataDir = resolve(dataDir);
  // The run engine, made on first use. A failed start is not kept, so the next call tries again.
  let engine = null;
  let enginePromise = null;
  const getEngine = () => {
    if (!enginePromise) {
      enginePromise = createEngine({ root, dataDir, actions, engineOptions }).then(
        m => { engine = m; return m; },
        err => { enginePromise = null; throw err; },
      );
    }
    return enginePromise;
  };
  const ctx = { root, actions, getPort, workspaceTag, dataDir, getEngine };
  const api = mergeRoutes([
    { 'POST /api/ping': async () => { onPing(); return { ok: true }; } },
    ...ROUTE_MODULES.map(m => m.routes(ctx)),
  ]);
  const uiFiles = listUiFiles(uiDir);
  const cookieName = () => `wsapp_${getPort()}`;
  const allowedHosts = () => [`127.0.0.1:${getPort()}`, `localhost:${getPort()}`];

  async function callApi(req, res, url) {
    const route = api[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'not found');
    try {
      const body = await route(req, res, url);
      if (body !== undefined) json(res, 200, body);
    } finally {
      // A change may make a state build that is already running out of date.
      if (req.method !== 'GET') invalidateState(root);
    }
  }

  async function handler(req, res) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts().includes(host)) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url, `http://${host}`);

      // Lets a second start find this server (server.mjs). Says nothing about the workspace.
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, app: 'claude-workspace-app', workspace: workspaceTag });
      }

      // Token exchange: the launch URL sets the cookie, then redirects to a clean URL.
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, 'This link has expired. Start the app again.');
        return send(res, 302, '', {
          Location: '/',
          'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!sameToken(cookies(req)[cookieName()], token)) {
        return send(res, 403, 'Not signed in. Start the app with "Workspace App.cmd" or node tools/workspace-app/server.mjs.',
          { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      if (req.method === 'POST') {
        const origin = String(req.headers.origin || '').toLowerCase();
        if (!allowedHosts().map(h => `http://${h}`).includes(origin) || req.headers['x-workspace-app'] !== '1') {
          return send(res, 403, 'Forbidden origin');
        }
      }

      if (req.method === 'GET' && uiFiles.has(url.pathname)) return sendStatic(res, uiFiles.get(url.pathname));

      if (req.method === 'GET' && url.pathname === '/img') {
        const rel = String(url.searchParams.get('path') || '');
        const full = resolve(root, rel);
        const type = contentTypeFor(full);
        if (!type || !isInside(join(root, 'inbox'), full) || !isFile(full)) throw new HttpError(404, 'image not found');
        return send(res, 200, readFileSync(full), {
          'Content-Type': type,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'private, max-age=300',
        });
      }

      // Renders, concept images and models of a project's assets (the Assets view).
      if (req.method === 'GET' && url.pathname === '/asset-file') {
        const project = assetProjectOrThrow(root, url.searchParams.get('project'));
        const f = assetFile(root, project, url.searchParams.get('path'));
        if (!f) throw new HttpError(404, 'asset file not found');
        return send(res, 200, readFileSync(f.full), {
          'Content-Type': f.type,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'private, no-cache',
        });
      }

      if (url.pathname.startsWith('/api/')) return await callApi(req, res, url);
      return send(res, 404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError || e.status ? e.status : 500;
      if (!res.headersSent) json(res, status, { ok: false, error: e.message || String(e) });
      else res.end();
    }
  }

  // Busy: the caller's own work, or the engine running a stage or check or applying a click.
  // Runs that only wait for you don't count (R21), so they never keep the app from closing.
  handler.isBusy = () => !!(isBusy && isBusy()) || !!(engine && engine.isBusy());
  handler.getEngine = getEngine;
  return handler;
}
