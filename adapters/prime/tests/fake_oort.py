#!/usr/bin/env python3
"""A loopback stand-in for the two oort message routes, with their real rules.

Not a mock in the "returns 200 to anything" sense. It is a model of the server's
*contract*, and it is deliberately strict, because the whole value of testing an
adapter against a double is lost the moment the double accepts something the
server refuses. Every rule below is one this repo's Rust already enforces:

* `deny_unknown_fields` on both request bodies (`dto.rs`) — a typo'd key is a
  400, never a silently dropped intent;
* `props` is a flat `string -> string` map, and `momo.stream` is server-owned and
  stripped from anything a client sends (`routes/messages.rs::props_value`);
* `clientMsgId` is the idempotency key: a repeat returns the stored message and
  does **not** allocate a new `seq`;
* an opening `stream` block must be `{rev: 0, streaming: true}` and nothing else;
* a slice's `rev` must be >= 1, and one that is **not newer** than the stored rev
  is a no-op rather than an error — that is the staleness guard, and a double
  that treated it as an error would hide the very retry safety it exists for;
* `outcome` rides only a final slice and is `cancelled` or `failed`.

Two knobs model the parts of the real server this adapter currently has to plan
around, so a test can assert on both worlds:

* `serves_run_id` — ADR-0158 D5. `False` is today's server, which answers
  *"runId (agent-run binding) is not served by momo-server yet"* with a 400.
* `patch_allowed` — the agent-bearer allow-list (`momo_auth::required_agent_scope`)
  covers `POST …/channels/{ch}/messages` and not `PATCH …/messages/{id}`, so an
  agent credential gets 403 on every slice. `False` reproduces that.
"""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

STREAM_PROPS_KEY = "momo.stream"
OPENING_STREAM_REV = 0

SEND_KEYS = {
    "clientMsgId",
    "rootId",
    "replyToId",
    "type",
    "body",
    "props",
    "runId",
    "attachmentIds",
    "routing",
    "signature",
    "stream",
}
EDIT_KEYS = {"body", "stream"}
STREAM_OPEN_KEYS = {"rev", "streaming"}
STREAM_EDIT_KEYS = {"rev", "final", "outcome"}


class Refused(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class OortModel:
    """The message store and its rules. No HTTP, no threads, no clock."""

    def __init__(self, *, serves_run_id: bool = False, patch_allowed: bool = True):
        self.serves_run_id = serves_run_id
        self.patch_allowed = patch_allowed
        self.seq = 0
        self.messages: dict[str, dict[str, Any]] = {}
        self.by_client_msg_id: dict[str, str] = {}
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _reject_unknown(payload: dict[str, Any], allowed: set[str], where: str) -> None:
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise Refused(400, f"unknown field(s) in {where}: {', '.join(unknown)}")

    @staticmethod
    def _clean_props(props: Any) -> dict[str, str]:
        if props is None:
            return {}
        if not isinstance(props, dict):
            raise Refused(400, "props must be an object")
        cleaned: dict[str, str] = {}
        for key, value in props.items():
            if not isinstance(value, str):
                raise Refused(400, f"props.{key} must be a string (v0 props are flat)")
            if key == STREAM_PROPS_KEY:
                # Server-owned. Silently dropped rather than refused, matching
                # `props_value`'s `continue`.
                continue
            cleaned[key] = value
        return cleaned

    def _view(self, message: dict[str, Any]) -> dict[str, Any]:
        view = {
            "id": message["id"],
            "seq": message["seq"],
            "type": message["type"],
            "body": message["body"],
            "state": message["state"],
        }
        if message["props"]:
            view["props"] = dict(message["props"])
        return view

    # -- routes ------------------------------------------------------------

    def post_message(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with self._lock:
            self.requests.append({"method": "POST", "payload": payload})
            self._reject_unknown(payload, SEND_KEYS, "the send request")
            client_msg_id = payload.get("clientMsgId")
            if not isinstance(client_msg_id, str) or not client_msg_id:
                raise Refused(400, "clientMsgId is required")
            if "runId" in payload and not self.serves_run_id:
                raise Refused(400, "runId (agent-run binding) is not served by momo-server yet")
            props = self._clean_props(payload.get("props"))

            opens_stream = False
            stream = payload.get("stream")
            if stream is not None:
                if not isinstance(stream, dict):
                    raise Refused(400, "stream must be an object")
                self._reject_unknown(stream, STREAM_OPEN_KEYS, "the opening stream block")
                if stream.get("rev") != OPENING_STREAM_REV:
                    raise Refused(400, "a stream's opening marker must be rev 0")
                if stream.get("streaming") is not True:
                    raise Refused(400, "a stream's opening marker must be streaming: true")
                opens_stream = True

            existing_id = self.by_client_msg_id.get(client_msg_id)
            if existing_id is not None:
                # A retry. The stored row is the answer, and no new seq is
                # allocated — this is the whole reason a stable key matters.
                return 200, self._view(self.messages[existing_id])

            if opens_stream:
                props[STREAM_PROPS_KEY] = json.dumps({"rev": OPENING_STREAM_REV, "streaming": True})
            self.seq += 1
            message_id = str(uuid.uuid4())
            self.messages[message_id] = {
                "id": message_id,
                "seq": self.seq,
                "clientMsgId": client_msg_id,
                "type": payload.get("type") or "text",
                "body": payload.get("body") or "",
                "props": props,
                "state": "sent",
                "streaming": opens_stream,
                "rev": OPENING_STREAM_REV if opens_stream else None,
                "outcome": None,
                "editedAtMs": None,
                "slices": 0,
            }
            return 201, self._view(self.messages[message_id])

    def patch_message(self, message_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with self._lock:
            self.requests.append({"method": "PATCH", "id": message_id, "payload": payload})
            if not self.patch_allowed:
                raise Refused(403, "agent bearer is not allowed for this route")
            self._reject_unknown(payload, EDIT_KEYS, "the edit request")
            message = self.messages.get(message_id)
            if message is None:
                raise Refused(404, "message not found")
            body = payload.get("body")
            if not isinstance(body, str) or body == "":
                raise Refused(400, "body is required")
            stream = payload.get("stream")
            if stream is None:
                message["body"] = body
                message["state"] = "edited"
                message["editedAtMs"] = 1
                return 200, self._view(message)

            self._reject_unknown(stream, STREAM_EDIT_KEYS, "the stream block")
            rev = stream.get("rev")
            if not isinstance(rev, int) or rev < 1:
                raise Refused(400, "a stream slice's rev starts at 1")
            is_final = stream.get("final")
            if not isinstance(is_final, bool):
                raise Refused(400, "final is required on a stream slice")
            outcome = stream.get("outcome")
            if outcome is not None:
                if not is_final:
                    raise Refused(400, "an outcome only rides the final slice")
                if outcome not in ("cancelled", "failed"):
                    raise Refused(400, 'stream outcome must be "cancelled" or "failed"')
            stored_rev = message.get("rev")
            if stored_rev is not None and rev <= stored_rev:
                # Not newer: a no-op, not an error. A late retry cannot rewind a
                # message, and it does not fail either.
                return 200, self._view(message)
            message["body"] = body
            message["rev"] = rev
            message["slices"] += 1
            props = dict(message["props"])
            props[STREAM_PROPS_KEY] = json.dumps(
                {"rev": rev, "streaming": not is_final, **({"outcome": outcome} if outcome else {})}
            )
            message["props"] = props
            if is_final:
                message["streaming"] = False
                message["outcome"] = outcome
            # A slice never stamps `editedAtMs` — that asymmetry is #1152's whole
            # point: an answer arriving is not a person revising.
            return 200, self._view(message)

    # -- assertions --------------------------------------------------------

    def message_by_client_msg_id(self, client_msg_id: str) -> dict[str, Any] | None:
        message_id = self.by_client_msg_id.get(client_msg_id)
        return self.messages.get(message_id) if message_id else None

    def of_type(self, message_type: str) -> list[dict[str, Any]]:
        return [m for m in self.messages.values() if m["type"] == message_type]


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep test output readable
        pass

    @property
    def model(self) -> OortModel:
        return self.server.model  # type: ignore[attr-defined]

    def _read(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise Refused(400, "malformed json") from None
        if not isinstance(payload, dict):
            raise Refused(400, "body must be an object")
        return payload

    def _respond(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return (self.headers.get("Authorization") or "").startswith("Bearer ")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def _dispatch(self, method: str) -> None:
        try:
            if not self._authorized():
                raise Refused(401, "authentication required")
            payload = self._read()
            parts = [part for part in self.path.split("/") if part]
            if method == "POST" and parts[-1:] == ["messages"]:
                status, view = self.model.post_message(payload)
            elif method == "PATCH" and len(parts) >= 2 and parts[-2] == "messages":
                status, view = self.model.patch_message(parts[-1], payload)
            else:
                raise Refused(404, "no such route")
            if status == 201 and method == "POST":
                # The store keys retries by clientMsgId; do it after a successful
                # insert so a refused send never registers.
                self.model.by_client_msg_id[payload["clientMsgId"]] = view["id"]
            self._respond(status, view)
        except Refused as refused:
            self._respond(refused.status, {"error": {"message": refused.message}})


class FakeOort:
    """A running loopback server plus the model behind it."""

    def __init__(self, **model_kwargs: Any):
        self.model = OortModel(**model_kwargs)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.model = self.model  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeOort":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
