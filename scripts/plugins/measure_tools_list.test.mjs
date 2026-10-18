// node --test scripts/plugins/measure_tools_list.test.mjs
// Offline: a fake vendor (MCP + DCR OAuth) proves the login path end to end,
// that tokens/client ids never reach the output files, and the digest rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
process.env.MEASURE_OUT_DIR = out;
const opener = path.join(out, 'open.sh');
fs.writeFileSync(opener, '#!/bin/sh\ncurl -s -o /dev/null -L "$1"\n', { mode: 0o755 });
process.env.MEASURE_OPEN_CMD = opener;
const stray = path.join(out, 'open-stray.sh');
// First a stray callback with the wrong state (must not abort the login), then the real flow.
fs.writeFileSync(stray, '#!/bin/sh\nru=$(printf %s "$1" | sed -n \'s/.*redirect_uri=\\([^&]*\\).*/\\1/p\' | sed \'s/%3A/:/g;s/%2F/\\//g\')\ncurl -s -o /dev/null "$ru?state=wrong&code=evil"\ncurl -s -o /dev/null -L "$1"\n', { mode: 0o755 });
const { APPS, measure, schemaDigest, canonical } = await import('./measure_tools_list.mjs');

const SECRET_TOKEN = 'tok-SECRET-123';
const CLIENT_ID = 'client-SECRET-456';
function fakeVendor() {
  let origin = '';
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, origin);
    const json = (code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (u.pathname === '/mcp') {
        if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
          return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm", scope="read write"` });
        }
        const m = JSON.parse(body || '{}');
        if (m.method === 'initialize') return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' }, capabilities: {} } });
        if (m.method === 'tools/list') {
          const first = !m.params?.cursor;
          return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: first ? 'b_tool' : 'a_tool', inputSchema: { type: 'object', properties: { y: {}, x: {} } } }], ...(first ? { nextCursor: 'p2' } : {}) } });
        }
        res.writeHead(202); return res.end();
      }
      if (u.pathname === '/prm') return json(200, { authorization_servers: [origin] });
      if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { registration_endpoint: `${origin}/register`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` });
      if (u.pathname === '/register') return json(201, { client_id: CLIENT_ID });
      if (u.pathname === '/authorize') {
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        const r = new URL(u.searchParams.get('redirect_uri'));
        r.searchParams.set('code', 'the-code'); r.searchParams.set('state', u.searchParams.get('state'));
        res.writeHead(302, { location: r.toString() }); return res.end();
      }
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body);
        assert.ok(p.get('code_verifier'));
        assert.equal(p.get('resource'), `${origin}/mcp`, 'RFC 8707 resource on the token request');
        return json(200, { access_token: SECRET_TOKEN });
      }
      return json(404, {});
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${s.address().port}`; r({ s, origin }); }));
}

test('digest is key-order independent and covers name + inputSchema only', () => {
  const a = { name: 't', inputSchema: { type: 'object', properties: { a: 1, b: 2 } }, description: 'x' };
  const b = { description: 'y', inputSchema: { properties: { b: 2, a: 1 }, type: 'object' }, name: 't' };
  assert.equal(schemaDigest(a), schemaDigest(b));
  assert.notEqual(schemaDigest(a), schemaDigest({ ...a, name: 'u' }));
  assert.notEqual(schemaDigest(a), schemaDigest({ ...a, inputSchema: { type: 'object' } }));
  assert.match(schemaDigest(a), /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonical({ b: [2, 1], a: null }), '{"a":null,"b":[2,1]}');
});

test('DCR loopback login lists tools across pages and leaks no secret to disk', async () => {
  const { s, origin } = await fakeVendor();
  APPS.fake = { url: `${origin}/mcp`, auth: 'dcr' };
  const line = await measure('fake', { probeOnly: false, forceLogin: false });
  s.close();
  assert.match(line, /2 tools/);
  const files = fs.readdirSync(out).filter((f) => f.startsWith('fake.'));
  assert.deepEqual(files.sort(), ['fake.digests.json', 'fake.meta.json', 'fake.tools-list.json']);
  for (const f of files) {
    const t = fs.readFileSync(path.join(out, f), 'utf8');
    assert.ok(!t.includes(SECRET_TOKEN) && !t.includes(CLIENT_ID), `${f} leaked a secret`);
  }
  const d = JSON.parse(fs.readFileSync(path.join(out, 'fake.digests.json'), 'utf8'));
  assert.deepEqual(Object.keys(d).sort(), ['a_tool', 'b_tool']);
});

test('probe mode never logs in and records the 401', async () => {
  const { s, origin } = await fakeVendor();
  APPS.fake2 = { url: `${origin}/mcp`, auth: 'dcr' };
  const line = await measure('fake2', { probeOnly: true, forceLogin: false });
  s.close();
  assert.match(line, /HTTP 401/);
  assert.ok(fs.existsSync(path.join(out, 'fake2.probe.json')));
  assert.ok(!fs.existsSync(path.join(out, 'fake2.tools-list.json')));
});

test('--login keeps the signed-in list apart from an unauthenticated one (.auth. infix)', async () => {
  const { s, origin } = await fakeVendor();
  APPS.fake3 = { url: `${origin}/mcp`, auth: 'dcr' };
  await measure('fake3', { probeOnly: false, forceLogin: true });
  s.close();
  const files = fs.readdirSync(out).filter((f) => f.startsWith('fake3.')).sort();
  assert.deepEqual(files, ['fake3.auth.digests.json', 'fake3.auth.meta.json', 'fake3.auth.tools-list.json']);
});

test('a stray callback with the wrong state does not abort the login', async () => {
  const { s, origin } = await fakeVendor();
  APPS.fake4 = { url: `${origin}/mcp`, auth: 'dcr' };
  process.env.MEASURE_OPEN_CMD = stray;
  try {
    assert.match(await measure('fake4', { probeOnly: false, forceLogin: false }), /2 tools/);
  } finally {
    process.env.MEASURE_OPEN_CMD = opener;
    s.close();
  }
});

test('a missing browser opener fails with a fixed message that carries no auth URL', async () => {
  const { s, origin } = await fakeVendor();
  APPS.fake5 = { url: `${origin}/mcp`, auth: 'dcr' };
  process.env.MEASURE_OPEN_CMD = path.join(out, 'no-such-opener');
  try {
    await assert.rejects(measure('fake5', { probeOnly: false, forceLogin: false }), (e) => {
      assert.match(e.message, /could not launch the browser opener/);
      assert.ok(!/client_id|state=|code_challenge|redirect_uri/.test(e.message + (e.stack || '')));
      return true;
    });
  } finally {
    process.env.MEASURE_OPEN_CMD = opener;
    s.close();
  }
});
