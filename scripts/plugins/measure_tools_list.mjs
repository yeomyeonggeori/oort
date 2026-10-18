#!/usr/bin/env node
// Vendor MCP `tools/list` measurement (#3944 C-S1b, ADR-0113 addendum 2 E2/E7).
//
// Usage:  scripts/plugins/measure_tools_list.sh <app|google|all> [--probe] [--login]
//   apps: github google-gmail google-calendar google-drive notion linear
//         atlassian-v1 atlassian-v2      (group: google = the three google-*)
//   --probe  no login at all: metadata + unauthenticated initialize/tools/list
//            status only (a server that lists tools without auth is recorded).
//   --login  skip the unauthenticated attempt and go straight to the login.
//            Output files get an `.auth.` infix (<app>.auth.tools-list.json) so an
//            unauthenticated list and a logged-in list can be diffed. NOTE: the
//            three Google servers list tools WITHOUT auth, but the unauthenticated
//            list can be narrower than the signed-in one - measure google with
//            --login too and compare.
//
// Order per app: (1) unauthenticated initialize + tools/list; (2) if the server
// demands auth: github = `gh auth token`, google = PKCE loopback with the
// pre-registered desktop client, notion/linear/atlassian = DCR + PKCE loopback.
// Browser consent happens via `open`; the script waits for the loopback callback.
//
// Secrets: tokens, client_id/secret, auth codes live in memory only. They are
// never written to disk, never printed, and error output carries status codes
// and vendor error codes only (never URLs with query strings or bodies of the
// token endpoints). Output dir (mode 700): ~/.cache/momo-scratch/3944-measure/
//   <app>.tools-list.json  raw merged tools/list result (all pages)
//   <app>.digests.json     { name: "sha256:..." }  normalised schemaDigest
//   <app>.meta.json        endpoint, serverInfo, protocolVersion, auth kind, time
//
// schemaDigest normalisation (this script defines it; document the same rule in
// the seed): sha256 over UTF-8 canonical JSON (object keys sorted recursively,
// no whitespace, arrays keep order) of {"inputSchema": <tool.inputSchema>,
// "name": <tool.name>}. Description/annotations are excluded on purpose.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const OUT_DIR = process.env.MEASURE_OUT_DIR || path.join(os.homedir(), '.cache', 'momo-scratch', '3944-measure');
const GOOGLE_CLIENT_FILE = path.join(os.homedir(), '.momo-secrets', 'google-oauth-hermes-k-s1b.json');
const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 20_000;
const LOGIN_WAIT_MS = 5 * 60_000;

const GOOGLE_SCOPES = {
  'google-gmail': ['https://www.googleapis.com/auth/gmail.readonly'],
  'google-calendar': ['https://www.googleapis.com/auth/calendar.readonly'],
  'google-drive': ['https://www.googleapis.com/auth/drive.readonly'],
};

const APPS = {
  github: { url: 'https://api.githubcopilot.com/mcp/', auth: 'gh' },
  'google-gmail': { url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'google' },
  'google-calendar': { url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'google' },
  'google-drive': { url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' },
  notion: { url: 'https://mcp.notion.com/mcp', auth: 'dcr' },
  linear: { url: 'https://mcp.linear.app/mcp', auth: 'dcr' },
  'atlassian-v1': { url: 'https://mcp.atlassian.com/v1/mcp', auth: 'dcr' },
  'atlassian-v2': { url: 'https://mcp.atlassian.com/v2/mcp', auth: 'dcr', allScopes: true },
};

// ---------- helpers ----------
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export function schemaDigest(tool) {
  const body = canonical({ inputSchema: tool.inputSchema ?? null, name: tool.name });
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}
const b64url = (b) => Buffer.from(b).toString('base64url');
const log = (...a) => console.error(...a);

async function fetchT(url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Parse a JSON-RPC reply that may arrive as JSON or as an SSE stream.
async function rpcBody(res) {
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    let last = null;
    for (const block of text.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) {
        try { last = JSON.parse(data); } catch { /* skip */ }
      }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// One MCP session: initialize -> initialized -> tools/list (all pages).
async function mcpList(url, token) {
  const base = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
  };
  if (token) base.authorization = `Bearer ${token}`;
  const post = (body, extra = {}) =>
    fetchT(url, { method: 'POST', headers: { ...base, ...extra }, body: JSON.stringify(body) });

  const r1 = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'oort-measure', version: '1' } },
  });
  if (r1.status !== 200) {
    return { ok: false, stage: 'initialize', status: r1.status, wwwAuthenticate: r1.headers.get('www-authenticate') || null };
  }
  const init = await rpcBody(r1);
  const sid = r1.headers.get('mcp-session-id');
  const sess = sid ? { 'mcp-session-id': sid } : {};
  const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sess);
  await n.text().catch(() => '');
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await post({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} }, sess);
    if (r.status !== 200) {
      return { ok: false, stage: 'tools/list', status: r.status, wwwAuthenticate: r.headers.get('www-authenticate') || null };
    }
    const j = await rpcBody(r);
    if (!j || !j.result) return { ok: false, stage: 'tools/list', status: 200, rpcError: j?.error?.code ?? 'no-result' };
    tools.push(...(j.result.tools || []));
    cursor = j.result.nextCursor;
    if (!cursor) break;
  }
  return {
    ok: true,
    serverInfo: init?.result?.serverInfo ?? null,
    protocolVersion: init?.result?.protocolVersion ?? null,
    tools,
  };
}

async function getJson(url) {
  try {
    const r = await fetchT(url, { headers: { accept: 'application/json' } });
    if (r.status !== 200) return null;
    return await r.json();
  } catch { return null; }
}

// Authorization-server metadata via the resource's protected-resource metadata.
async function discoverAs(mcpUrl, wwwAuth) {
  const u = new URL(mcpUrl);
  let prm = null;
  const m = /resource_metadata="([^"]+)"/.exec(wwwAuth || '');
  const candidates = [m?.[1], `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  for (const c of candidates) { prm = await getJson(c); if (prm) break; }
  const issuer = prm?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  const asCandidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`,
    `${iu.origin}/.well-known/oauth-authorization-server`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];
  let as = null;
  for (const c of asCandidates) { as = await getJson(c); if (as) break; }
  return { prm, as };
}

function openBrowser(url) {
  // `open` (macOS). Never log the URL: it carries client_id / state.
  const p = spawn(process.env.MEASURE_OPEN_CMD || 'open', [url], { stdio: 'ignore', detached: true });
  p.unref();
}

// Loopback PKCE: returns an access token (memory only).
async function loopbackLogin({ label, authEndpoint, tokenEndpoint, clientId, clientSecret, scope, extraAuthParams = {} }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  let resolveCode; let rejectCode;
  const codeP = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    if (u.searchParams.get('state') !== state) { res.end('state mismatch'); rejectCode(new Error('state mismatch')); return; }
    if (u.searchParams.get('error')) { res.end('login failed'); rejectCode(new Error(`authorization error: ${u.searchParams.get('error')}`)); return; }
    res.end('Done. You can close this tab.');
    resolveCode(u.searchParams.get('code'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const a = new URL(authEndpoint);
  const q = {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
    code_challenge: challenge, code_challenge_method: 'S256', ...extraAuthParams,
  };
  if (scope) q.scope = scope;
  for (const [k, v] of Object.entries(q)) a.searchParams.set(k, v);
  log(`[${label}] opening browser for consent at ${a.host} - click through, waiting up to 5 min...`);
  openBrowser(a.toString());
  const timer = setTimeout(() => rejectCode(new Error('login timed out')), LOGIN_WAIT_MS);
  try {
    const code = await codeP;
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    });
    if (clientSecret) form.set('client_secret', clientSecret);
    const r = await fetchT(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200 || !j.access_token) throw new Error(`token exchange failed: HTTP ${r.status} ${j.error || ''}`.trim());
    return j.access_token;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function tokenFor(name, app, wwwAuth) {
  if (app.auth === 'gh') {
    try {
      return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { throw new Error('gh auth token failed (gh auth login first)'); }
  }
  if (app.auth === 'google') {
    const raw = JSON.parse(fs.readFileSync(GOOGLE_CLIENT_FILE, 'utf8')).installed;
    return loopbackLogin({
      label: name,
      authEndpoint: raw.auth_uri,
      tokenEndpoint: raw.token_uri,
      clientId: raw.client_id,
      clientSecret: raw.client_secret,
      scope: GOOGLE_SCOPES[name].join(' '),
      extraAuthParams: { access_type: 'online', login_hint: 'kwak@dawn.kim' },
    });
  }
  // DCR
  const { prm, as } = await discoverAs(app.url, wwwAuth);
  if (!as?.registration_endpoint) throw new Error('no registration_endpoint (DCR unavailable)');
  // Redirect port must be known at registration: reserve one, register, then reuse.
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const reg = await fetchT(as.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'oort tools/list measure', redirect_uris: [redirectUri],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  const rj = await reg.json().catch(() => ({}));
  if (!(reg.status === 200 || reg.status === 201) || !rj.client_id) throw new Error(`DCR failed: HTTP ${reg.status} ${rj.error || ''}`.trim());
  // allScopes: every scope the resource advertises EXCEPT delete:/manage: ones,
  // so the consent screen never grants destructive scopes just to list tools.
  const wantScope = app.allScopes
    ? (prm?.scopes_supported || []).filter((x) => !/^(delete|manage):/.test(x)).join(' ')
    : (/scope="([^"]+)"/.exec(wwwAuth || '')?.[1] ?? '');
  return loopbackLoginFixedPort({
    label: name, authEndpoint: as.authorization_endpoint, tokenEndpoint: as.token_endpoint,
    clientId: rj.client_id, scope: wantScope, port,
    extraAuthParams: { resource: app.url },
  });
}

// DCR clients registered one exact redirect URI, so bind that port.
async function loopbackLoginFixedPort(opts) {
  const { port, ...rest } = opts;
  const orig = http.createServer;
  http.createServer = function patched(...args) {
    const s = orig.apply(this, args);
    const listen = s.listen.bind(s);
    s.listen = (p, ...r) => listen(p === 0 ? port : p, ...r);
    return s;
  };
  try { return await loopbackLogin(rest); } finally { http.createServer = orig; }
}

function save(name, result, meta, variant = '') {
  const base = variant ? `${name}.${variant}` : name;
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const w = (suffix, obj) => fs.writeFileSync(path.join(OUT_DIR, `${base}.${suffix}.json`), `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  if (result.ok) {
    w('tools-list', { tools: result.tools });
    const digests = {};
    for (const t of result.tools) digests[t.name] = schemaDigest(t);
    w('digests', digests);
  }
  w('meta', { app: name, endpoint: APPS[name].url, measuredAt: new Date().toISOString(), digestRule: 'sha256(canonical JSON of {inputSchema,name})', ...meta });
}

async function measure(name, { probeOnly, forceLogin }) {
  const app = APPS[name];
  let wwwAuth = null;
  let unauth = { ok: false, stage: 'skipped' };
  if (!forceLogin) {
    try { unauth = await mcpList(app.url, null); } catch (e) { unauth = { ok: false, stage: 'network', error: e.name }; }
    wwwAuth = unauth.wwwAuthenticate ?? null;
    if (unauth.ok) {
      save(name, unauth, { auth: 'none', serverInfo: unauth.serverInfo, protocolVersion: unauth.protocolVersion, toolCount: unauth.tools.length });
      return `${name}: ${unauth.tools.length} tools (no auth needed)  ${unauth.tools.map((t) => t.name).join(' ')}`;
    }
  }
  if (probeOnly) {
    fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.probe.json`), JSON.stringify({ app: name, endpoint: app.url, probedAt: new Date().toISOString(), auth: 'required', probe: { stage: unauth.stage, status: unauth.status ?? null, wwwAuthenticate: wwwAuth } }, null, 2) + '\n', { mode: 0o600 });
    return `${name}: probe only - unauthenticated ${unauth.stage} -> HTTP ${unauth.status ?? unauth.error ?? '-'} (login needed: ! scripts/plugins/measure_tools_list.sh ${name})`;
  }
  const token = await tokenFor(name, app, wwwAuth);
  const res = await mcpList(app.url, token);
  if (!res.ok) throw new Error(`${res.stage} failed with token: HTTP ${res.status ?? ''} ${res.rpcError ?? ''}`.trim());
  save(name, res, { auth: app.auth, serverInfo: res.serverInfo, protocolVersion: res.protocolVersion, toolCount: res.tools.length }, forceLogin ? 'auth' : '');
  return `${name}: ${res.tools.length} tools (auth: ${app.auth})  ${res.tools.map((t) => t.name).join(' ')}`;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { log('usage: measure_tools_list.sh <app|google|all> [--probe] [--login]\napps: ' + Object.keys(APPS).join(' ')); process.exit(2); }
  const names = target === 'all' ? Object.keys(APPS)
    : target === 'google' ? Object.keys(APPS).filter((n) => n.startsWith('google-'))
    : [target];
  for (const n of names) if (!APPS[n]) { log(`unknown app: ${n}`); process.exit(2); }
  let failed = 0;
  for (const n of names) {
    try { console.log(await measure(n, { probeOnly: flags.has('--probe'), forceLogin: flags.has('--login') })); }
    catch (e) { failed++; console.log(`${n}: FAILED - ${e.message}`); }
  }
  console.log(`output: ${OUT_DIR}`);
  process.exit(failed ? 1 : 0);
}

export { discoverAs, APPS, measure };
if (import.meta.url === `file://${process.argv[1]}`) await main();
