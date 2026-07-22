#!/usr/bin/env python3
"""Credential-free NDJSON ACP agent used only by verify_acp_host.sh."""

import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def result(request_id, value):
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


pending_prompt = None
terminal_stage = None

for raw_line in sys.stdin:
    try:
        message = json.loads(raw_line)
    except json.JSONDecodeError:
        continue
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        result(request_id, {"protocolVersion": 1, "agentCapabilities": {"promptCapabilities": {}}})
    elif method == "session/new":
        result(request_id, {"sessionId": "mock-acp-session"})
    elif method == "session/prompt":
        pending_prompt = request_id
        session_id = message["params"]["sessionId"]
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "mock progress"},
                    "vendorExtension": {"density": "high"},
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [{"content": "inspect", "status": "completed"}],
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "id": 9001,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {"toolCallId": "tool-1", "title": "Run mock terminal", "kind": "execute"},
                "options": [
                    {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
                ],
            },
        })
    elif request_id == 9001 and "result" in message:
        outcome = message["result"].get("outcome", {})
        if outcome.get("outcome") == "selected":
            terminal_stage = "create"
            send({
                "jsonrpc": "2.0",
                "id": 9002,
                "method": "terminal/create",
                "params": {"command": "printf", "args": ["mock-terminal"]},
            })
        else:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "mock-acp-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "rejected branch stopped"},
                    },
                },
            })
            result(pending_prompt, {"stopReason": "refused"})
            pending_prompt = None
    elif request_id == 9002 and terminal_stage == "create":
        terminal_stage = "output"
        terminal_id = message["result"]["terminalId"]
        send({"jsonrpc": "2.0", "id": 9003, "method": "terminal/output", "params": {"terminalId": terminal_id}})
    elif request_id == 9003 and terminal_stage == "output":
        terminal_stage = "wait"
        send({"jsonrpc": "2.0", "id": 9004, "method": "terminal/wait_for_exit", "params": {"terminalId": "mock-terminal-id"}})
    elif request_id == 9004 and terminal_stage == "wait":
        terminal_stage = "release"
        send({"jsonrpc": "2.0", "id": 9005, "method": "terminal/release", "params": {"terminalId": "mock-terminal-id"}})
    elif request_id == 9005 and terminal_stage == "release":
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "mock-acp-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "approved branch executed"},
                },
            },
        })
        result(pending_prompt, {"stopReason": "end_turn"})
        pending_prompt = None
        terminal_stage = None
