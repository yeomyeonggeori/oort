#!/opt/hermes/.venv/bin/python
"""Sign in to one Google MCP server from the Hermes shell (K-S1b, #3952).

Why this exists: `hermes mcp login <server>` only starts the OAuth flow when the server answers 401.
Google's MCP servers answer `initialize` and `tools/list` WITHOUT auth (they return 401 only on
`tools/call`), so `hermes mcp login` prints 「no OAuth token was obtained」 and never opens the flow.
This script runs the same Hermes OAuth provider (same pinned client, redirect_port, token files under
/opt/data/mcp-tokens) but makes one real read call so the flow starts. Run as the `hermes` user:

  runuser -u hermes -- /opt/hermes/.venv/bin/python /opt/data/mcp_login_probe.py gmail

It prints the consent URL and reads the address-bar URL you paste back. Never prints tokens or secrets.
"""
import asyncio
import sys

PROBE = {  # one harmless read call per server; names from the vendors' tools/list (readOnlyHint=true)
    "gmail": ("list_labels", {}),
    "google_calendar": ("list_calendars", {}),
    "google_drive": ("list_recent_files", {}),
}


async def main(name):
    sys.path.insert(0, "/opt/hermes")
    from hermes_cli.mcp_config import _get_mcp_servers, _oauth_tokens_present
    from tools.mcp_oauth import HermesTokenStorage, build_oauth_auth, force_interactive_oauth
    from mcp import ClientSession
    try:
        import httpx2 as httpx  # the MCP SDK (>= 2.0) sends its requests through httpx2
    except ImportError:
        import httpx
    from mcp.client.streamable_http import streamable_http_client

    # Google lists its authorization server as "https://accounts.google.com/" (trailing slash) while the
    # server's own metadata says issuer "https://accounts.google.com": the SDK's strict equality check
    # raises "issuer mismatch" and the flow dies. Compare without the trailing slash, for this run only.
    import mcp.client.auth.oauth2 as sdk_oauth2
    _strict = sdk_oauth2.validate_metadata_issuer

    def _lenient(asm, expected):
        return _strict(asm, str(expected).rstrip("/") if expected else expected)

    sdk_oauth2.validate_metadata_issuer = _lenient
    cfg = _get_mcp_servers().get(name)
    # The SDK replaces oauth.scope with the server's advertised scopes (Gmail: mail.google.com/, gmail.modify, ...
    # write-capable). Keep exactly the read-only scopes the operator wrote in config.yaml.
    wanted = ((cfg or {}).get("oauth") or {}).get("scope")
    if not wanted:
        print("oauth.scope is required in config.yaml (read-only scopes only)", file=sys.stderr)
        return 2
    sdk_oauth2.get_client_metadata_scopes = lambda *a, **k: wanted
    if not cfg or cfg.get("auth") != "oauth":
        print(f"no oauth server named {name!r} in config.yaml", file=sys.stderr)
        return 2
    HermesTokenStorage(name).remove(keep_metadata=True)
    tool, args = PROBE[name]
    with force_interactive_oauth():
        auth = build_oauth_auth(name, cfg["url"], cfg.get("oauth") or {})
        async with httpx.AsyncClient(auth=auth, follow_redirects=True, timeout=60.0) as http:
            async with streamable_http_client(cfg["url"], http_client=http) as (r, w):
                async with ClientSession(r, w) as s:
                    await s.initialize()
                    res = await s.call_tool(tool, args)
    print("probe call isError=%s" % bool(getattr(res, "isError", False)))
    ok = _oauth_tokens_present(name)
    print("token files present: %s" % ok)
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PROBE:
        print("usage: mcp_login_probe.py gmail|google_calendar|google_drive", file=sys.stderr)
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1])))
