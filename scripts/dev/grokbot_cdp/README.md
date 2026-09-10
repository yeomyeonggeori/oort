# Grok Bot CDP harness (developer-local only)

This directory is a **planner/operator local verification harness**. It is not
a product surface and must not ship to users.

Canon: ADR-0183 결재 기록 2 (`docs/adr/0183-codebase-docs-lightening.md:134`) —
local self-host / join tests on this machine may drive Grok Bot over CDP.
**Users and public surfaces stay prohibited** from CDP / selector automation.
The playbook `docs/SELF_HOST_AGENT.md` §3.3.16 / §3.3.19 states that user-facing
ban; this README.md is the exception for a developer sitting at the machine.

Disk identity measured 2026-09-08 on this machine (app **not** listening on
9333): Grok Bot `0.30.0` (`CFBundleVersion` 0.30.0), bundle
`com.anysphere.sand`. Live CDP `/json/version` is recorded only when the port
is open.

## What it talks to

| Item | Value |
|---|---|
| App | `/Applications/Grok Bot.app` (`com.anysphere.sand`) |
| CDP | `--remote-debugging-port=9333` (the app must be started with this flag) |
| Renderer | a **single** `page` target |
| WS | `websocket-client`, `suppress_origin=True` (a present `Origin` is 403) |
| Inject | `Input.insertText` (ProseMirror / TipTap). `innerText` assignment does not update editor state |
| SEND | **not automated**. The vendor auto-mode classifier blocks scripted send. Procedure: human **Enter 1 tap** |

Interpreter measured here: `/opt/homebrew/bin/python3` with
`websocket-client`. The skip path uses only the stdlib (`socket`) so a missing
package still prints SKIPPED when the port is closed.

```sh
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/read.py
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/write.py --text 'oort-cdp-probe'
# human Enter tap in the Grok Bot composer — scripts never press Enter / click Send
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/read.py
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/clear.py
```

## OS Return (planner/operator, this machine)

OS Return fails when the Grok Bot window is on another Space. Bring the
app forward with `open -a "Grok Bot"` before Return. This is a local
harness note, not a user playbook step (`docs/SELF_HOST_AGENT.md` §3.3
points here).

## App absent

If nothing is listening on `127.0.0.1:9333`, every script prints exactly:

```
SKIPPED: Grok Bot app not running (port 9333 closed)
```

and exits 0. That is not a silent skip.

## Sabotage (must be able to go RED)

With the app running on :9333:

```sh
# Origin header present → DevTools WS 403
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/write.py --sabotage origin

# DOM innerText write → ProseMirror state unchanged (`proseMirrorUpdated: false`)
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/write.py --sabotage innertext
```

If the app is **not** running, the same commands still attempt the WS
handshake against :9333 and report the handshake error (connection refused),
not a forged 403. Do not treat that as the Origin-403 proof.

Contract tests (stdlib only):

```sh
# GREEN — skip string, suppress_origin, Input.insertText, no auto-SEND
/opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/test_contracts.py

# RED — demands an auto-SEND helper that this harness must not contain
GROKBOT_CDP_CONTRACT_SABOTAGE=require_send /opt/homebrew/bin/python3 scripts/dev/grokbot_cdp/test_contracts.py
```

## Do not

- commit pairing / active credentials, Grok account data, or composer contents
  that are not the probe string
- add `--send`, Enter `dispatchKeyEvent`, or a click on the send control
- call these scripts from a public / user playbook as if they were the join path
  (join remains loopback curl + static bearer in `SELF_HOST_AGENT.md` §3.3.16)
