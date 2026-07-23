#!/usr/bin/env python3
"""Credential-free newline-delimited JSON-RPC mock of `codex app-server`.

Used only by verify_workhost_engines.sh / WorkEngineAdapterTests to exercise the
CodexJSONRPCAdapter lifecycle (initialize -> initialized -> thread/start ->
turn/start -> stream deltas -> approval hook -> turn completion) over real stdio,
with no ChatGPT/OAuth (ADR-0004: the OAuth boundary lives in the user host's
Codex, never here). Messages follow codex app-server's shape: JSON-RPC 2.0 over
stdio WITHOUT the "jsonrpc" field.
"""

import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def result(request_id, value):
    send({"id": request_id, "result": value})


pending_turn = None

for raw_line in sys.stdin:
    try:
        message = json.loads(raw_line)
    except json.JSONDecodeError:
        continue
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        result(request_id, {"protocolVersion": 1, "serverInfo": {"name": "mock-codex"}})
    elif method == "initialized":
        # client notification, no response
        pass
    elif method == "thread/start":
        result(request_id, {"threadId": "mock-codex-thread"})
    elif method == "turn/start":
        pending_turn = request_id
        # stream one assistant message delta
        send({
            "method": "item/agentMessage/delta",
            "params": {"threadId": "mock-codex-thread", "delta": "mock codex progress"},
        })
        # server -> client approval request (has id)
        send({
            "id": 9101,
            "method": "commandExecution/requestApproval",
            "params": {
                "threadId": "mock-codex-thread",
                "command": ["printf", "codex-approve"],
                "reason": "run mock command",
            },
        })
    elif request_id == 9101 and "result" in message:
        decision = message["result"].get("decision")
        if decision in ("approved", "approved_for_session"):
            send({
                "method": "item/commandExecution/outputDelta",
                "params": {"threadId": "mock-codex-thread", "delta": "approved branch executed"},
            })
            result(pending_turn, {"stopReason": "end_turn"})
        else:
            send({
                "method": "item/agentMessage/delta",
                "params": {"threadId": "mock-codex-thread", "delta": "rejected branch stopped"},
            })
            result(pending_turn, {"stopReason": "refused"})
        pending_turn = None
