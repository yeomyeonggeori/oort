#!/usr/bin/env python3
"""A scripted `prime-agent --mode rpc` stand-in — the harness half of the smoke.

The container tests run the real harness against a loopback provider, and that
is the measurement that matters. This double exists for the half the gate can
run everywhere: it speaks the same JSONL on the same pipes, so the adapter's
transport, buffering, stream arithmetic and idempotency are exercised with no
Docker, no npm, no network and no credential.

It only ever emits shapes taken from the harness's own `docs/rpc.md` and from the
spike's captured transcripts. Where it deviates it does so loudly, in a scenario
named for the deviation (`die`, `silent-drift`), because a double that quietly
invents a shape teaches the adapter to expect a thing that does not exist.

Scenarios (`--scenario`):

    text          one streamed answer, then `agent_end`
    tool          answer, `ipython` call, tool result, second answer
    refine        as `text`, and a `refine` command answers with
                  `refine_complete` + `response` (the undocumented pair)
    silent-drift  as `text`, but the harness state file is rewritten mid-turn
                  with **no** event at all — the kernel path
    abort         streams, then answers `abort` with
                  `message_update{error, reason: "aborted"}`
    die           streams half an answer and exits, leaving the adapter an EOF
                  with a stream still open
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time

# Long enough that the adapter's buffer has to flush several times, because a
# single-slice answer would prove the streaming contract by accident.
TEXT = (
    "prime 어댑터가 한 문장을 조각으로 보냅니다. "
    "이 문장은 델타 버퍼링이 실제로 여러 조각을 하나의 메시지로 모으는지 재려고 충분히 깁니다. "
    "스파이크가 잰 값은 답 하나에 REST 쓰기 17회였고, 그때는 그것이 채널 메시지 17개였습니다. "
    "지금은 같은 답이 메시지 하나로 자랍니다. 여는 POST 하나와 절대 본문을 실은 조각들, "
    "그리고 마지막 조각 하나가 그 메시지를 닫습니다. "
    "그래서 이 문장은 길고, 길어야 그 산술이 실제로 도는 것을 볼 수 있습니다."
)


def emit(record: dict) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def stream_text(text: str, chunk: int = 7, pause: float = 0.005) -> None:
    emit({"type": "message_start", "message": {"role": "assistant"}})
    emit({"type": "message_update", "assistantMessageEvent": {"type": "text_start", "contentIndex": 0}})
    for index in range(0, len(text), chunk):
        emit(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": text[index : index + chunk],
                },
            }
        )
        time.sleep(pause)
    emit(
        {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "contentIndex": 0, "content": text},
        }
    )
    emit({"type": "message_end", "message": {"role": "assistant"}})


def write_harness_state(path: str, entry_id: str, refinement_id: str) -> None:
    """Rewrite the harness state file the way the kernel's `rlm.harness` would."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "entries": {"memory": {entry_id: {"title": entry_id, "content": "written by the kernel"}}},
                "refinements": [{"id": refinement_id, "summary": "kernel-side write"}],
            },
            handle,
        )


def refinement_result(refinement_id: str, entry_id: str) -> dict:
    return {
        "id": refinement_id,
        "scope": "global",
        "summary": "remember how this workspace likes its diffs",
        "appliedEdits": [
            {"action": "create", "kind": "memory", "id": entry_id, "applied": True, "after": "…"}
        ],
        "rollbackId": "rollback_" + refinement_id,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default=os.environ.get("FAKE_PRIME_SCENARIO", "text"))
    parser.add_argument("--harness-state", default=os.environ.get("FAKE_PRIME_HARNESS_STATE", ""))
    parser.add_argument("--mode")
    parser.add_argument("--model")
    parser.add_argument("--no-session", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("-e", "--extension", action="append")
    args, _unknown = parser.parse_known_args()

    scenario = args.scenario
    entry_id = "oort-adapter-probe"
    refinement_id = "refine_20260808000000000"
    done = threading.Event()

    def on_prompt() -> None:
        if scenario == "die":
            stream_half()
            os._exit(1)
        if scenario == "tool":
            stream_text("먼저 셀을 하나 돌리겠습니다.")
            call_id = "call_probe"
            emit(
                {
                    "type": "tool_execution_start",
                    "toolName": "ipython",
                    "toolCallId": call_id,
                    "args": {"code": "print('oort')"},
                }
            )
            emit(
                {
                    "type": "tool_execution_update",
                    "toolCallId": call_id,
                    "partialResult": {"content": [{"text": "oort"}], "details": {"status": "running"}},
                }
            )
            emit(
                {
                    "type": "tool_execution_end",
                    "toolName": "ipython",
                    "toolCallId": call_id,
                    "isError": False,
                    "result": {"content": [{"text": "oort"}]},
                }
            )
            stream_text(TEXT)
        elif scenario == "silent-drift":
            stream_text(TEXT)
            if args.harness_state:
                write_harness_state(args.harness_state, entry_id, refinement_id)
        elif scenario == "abort":
            stream_half()
            return  # wait for the `abort` command
        else:
            stream_text(TEXT)
        emit({"type": "turn_end"})
        emit({"type": "agent_end"})
        done.set()

    def stream_half() -> None:
        emit({"type": "message_update", "assistantMessageEvent": {"type": "text_start", "contentIndex": 0}})
        for index in range(0, 120, 7):
            emit(
                {
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": TEXT[index : index + 7],
                    },
                }
            )
            time.sleep(0.005)

    emit({"type": "agent_start"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = command.get("type")
        if kind == "get_state":
            emit({"type": "response", "id": command.get("id"), "command": "get_state", "success": True, "data": {}})
        elif kind == "prompt":
            emit({"type": "response", "id": command.get("id"), "command": "prompt", "success": True})
            threading.Thread(target=on_prompt, daemon=True).start()
        elif kind == "refine":
            if args.harness_state:
                write_harness_state(args.harness_state, entry_id, refinement_id)
            # The order the spike measured: the undocumented event first, its
            # command response second.
            emit({"type": "refine_complete", "result": refinement_result(refinement_id, entry_id)})
            emit({"type": "response", "id": command.get("id"), "command": "refine", "success": True, "data": {}})
        elif kind == "abort":
            emit(
                {
                    "type": "message_update",
                    "assistantMessageEvent": {"type": "error", "contentIndex": 0, "reason": "aborted"},
                }
            )
            emit({"type": "response", "id": command.get("id"), "command": "abort", "success": True})
            emit({"type": "agent_end"})
            done.set()
        elif kind == "extension_ui_response":
            emit({"type": "response", "id": command.get("id"), "command": "extension_ui_response", "success": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
