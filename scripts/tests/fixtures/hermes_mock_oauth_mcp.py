#!/usr/bin/env python3
"""Mock OAuth 2.1 MCP server for scripts/tests/test_login_relay_docker.sh (#4078). stdlib only.

  hermes_mock_oauth_mcp.py PORT SUFFIX [--google-like]

Issues `MOCK-ACCESS-TOKEN-<SUFFIX>` / `MOCK-REFRESH-TOKEN-<SUFFIX>` so a test can prove those bytes never cross the
login relay while they DO land in /opt/data (the positive control). Default: every /mcp call needs a bearer (401
first, like a normal OAuth MCP server). --google-like: `initialize` and `tools/list` pass WITHOUT auth and only
`tools/call` answers 401 — the reason `hermes mcp login` never starts the flow for Google and mcp_login_probe.py exists.
Prints one line per /token call: whether a PKCE verifier arrived and whether the code is the test's marker code.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PORT = int(sys.argv[1])
SUFFIX = sys.argv[2]
GOOGLE_LIKE = "--google-like" in sys.argv[3:]
BASE = "http://127.0.0.1:%d" % PORT
ACCESS = "MOCK-ACCESS-TOKEN-" + SUFFIX
REFRESH = "MOCK-REFRESH-TOKEN-" + SUFFIX


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _j(self, code, obj, hdr=None):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        for k, v in (hdr or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/.well-known/oauth-protected-resource"):
            return self._j(200, {"resource": BASE + "/mcp", "authorization_servers": [BASE]})
        if self.path.startswith("/.well-known/oauth-authorization-server"):
            return self._j(200, {
                "issuer": BASE, "authorization_endpoint": BASE + "/authorize", "token_endpoint": BASE + "/token",
                "registration_endpoint": BASE + "/register", "code_challenge_methods_supported": ["S256"],
                "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"],
            })  # fmt: skip
        self._j(404, {})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n)
        if self.path == "/register":
            return self._j(201, {"client_id": "mock-client", "redirect_uris": json.loads(raw)["redirect_uris"], "token_endpoint_auth_method": "none"})
        if self.path == "/token":
            f = parse_qs(raw.decode())
            code = (f.get("code") or [""])[0]
            print("TOKEN grant=%s has_verifier=%s code_is_marker=%s" % ((f.get("grant_type") or [""])[0], "code_verifier" in f, code.startswith("MARKER-CODE-")), flush=True)
            return self._j(200, {"access_token": ACCESS, "refresh_token": REFRESH, "token_type": "Bearer", "expires_in": 3600})
        if self.path == "/mcp":
            m = json.loads(raw)
            i = m.get("id")
            needs_auth = (m.get("method") == "tools/call") if GOOGLE_LIKE else True
            if needs_auth and self.headers.get("authorization") != "Bearer " + ACCESS:
                return self._j(401, {"error": "unauthorized"}, {"www-authenticate": 'Bearer resource_metadata="%s/.well-known/oauth-protected-resource"' % BASE})
            if i is None:
                self.send_response(202)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            if m["method"] == "initialize":
                return self._j(200, {"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": m["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "mock", "version": "1"}}})
            if m["method"] == "tools/list":
                tools = [{"name": n, "description": "d", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}} for n in ("get_note", "list_labels", "list_calendars", "list_recent_files")]
                return self._j(200, {"jsonrpc": "2.0", "id": i, "result": {"tools": tools}})
            if m["method"] == "tools/call":
                return self._j(200, {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": "ok"}], "isError": False}})
            return self._j(200, {"jsonrpc": "2.0", "id": i, "result": {}})
        self._j(404, {})


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
