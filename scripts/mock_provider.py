#!/usr/bin/env python3
"""Credential-free mock T3 substrate — ADR-0142 D2/D3 (MOMO-670).

Implements exactly the provider-neutral REST shape `HTTPCloudProviderAdapter`
speaks, so a verifier exercises the same adapter code production uses:

    POST   /v1/instances                -> 201 {"instanceId": ...}
    POST   /v1/instances/{id}/pause     -> 204
    POST   /v1/instances/{id}/resume    -> 200
    DELETE /v1/instances/{id}           -> 204 (404 once already absent)
    GET    /v1/instances/{id}           -> 200 {"state": ...} | 404

Two substrates are run from this one file (`--provider-id mock-a|mock-b`) so
cross-provider continuity cannot lean on either one's conveniences:

  mock-a  supports pause, resume restores memory.
  mock-b  refuses pause outright (405) and cold-boots.

Honesty is the point, not realism (ADR-0142 D3.1):

  * A paused instance refuses every call that needs it running, by name and
    with 409 — it never answers 2xx for work it did not do. The first review of
    this area went green because a mock pretended a paused sandbox was live.
  * A killed instance answers `absent` from `probe` and 404 from lifecycle
    calls. `--dishonest-probe` (or `POST /controls/dishonest-probe`) flips only
    that answer to `present`, which is the red-proof lever: momo must refuse to
    settle a session on a provider that contradicts itself, and the verifier
    must go red by name rather than hang.

`/requests` is a local inspection surface for verifiers; production substrates
have no such endpoint. Request bodies carry a one-shot workd bootstrap token,
so they are held in memory for the verifier and never written to the log.
"""

from __future__ import annotations

import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

INSTANCE_PATH = re.compile(r"^/v1/instances/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$")
INSTANCE_ACTION = re.compile(
    r"^/v1/instances/([A-Za-z0-9][A-Za-z0-9_-]{0,127})/(pause|resume)$"
)

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {}


def _reset(provider_id: str, supports_pause: bool, dishonest_probe: bool) -> None:
    _STATE.clear()
    _STATE.update(
        {
            "providerID": provider_id,
            "supportsPause": supports_pause,
            "dishonestProbe": dishonest_probe,
            "requests": [],
            "instances": {},       # instanceId -> "running"|"paused"|"absent"
            "createKeys": {},      # Idempotency-Key -> instanceId
            "resumeMode": "",
            "resumeStage": 0,
        }
    )


_RESUME_RELEASE = threading.Event()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{_STATE['providerID']}] " + fmt % args)

    # ---- inspection -------------------------------------------------------
    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "providerId": _STATE["providerID"]})
            return
        if self.path == "/requests":
            with _LOCK:
                payload = {
                    "providerId": _STATE["providerID"],
                    "requests": list(_STATE["requests"]),
                    "instances": dict(_STATE["instances"]),
                }
            self._json(200, payload)
            return
        match = INSTANCE_PATH.match(self.path)
        if match:
            self._probe(match.group(1))
            return
        self.send_error(404)

    def _probe(self, instance_id: str) -> None:
        with _LOCK:
            _STATE["requests"].append({"method": "GET", "path": self.path})
            state = _STATE["instances"].get(instance_id)
            dishonest = _STATE["dishonestProbe"]
        if state is None:
            self._json(404, {"error": "unknown instance"})
            return
        if state == "absent":
            if dishonest:
                # The lie under test: this substrate died and says otherwise.
                self._json(200, {"state": "running"})
                return
            self._json(404, {"error": "instance is gone"})
            return
        self._json(200, {"state": state})

    # ---- lifecycle --------------------------------------------------------
    def do_POST(self) -> None:
        if self.path.startswith("/controls/"):
            self._control(self.path[len("/controls/"):])
            return
        if self.path == "/v1/instances":
            self._create()
            return
        match = INSTANCE_ACTION.match(self.path)
        if match:
            instance_id, action = match.group(1), match.group(2)
            if action == "pause":
                self._pause(instance_id)
            else:
                self._resume(instance_id)
            return
        self.send_error(404)

    def _control(self, name: str) -> None:
        self._body()
        with _LOCK:
            if name == "kill":
                # Every live instance dies where it stands. Nothing tells momo.
                for key in list(_STATE["instances"]):
                    _STATE["instances"][key] = "absent"
            elif name == "dishonest-probe":
                _STATE["dishonestProbe"] = True
            elif name == "resume-missing":
                for key in list(_STATE["instances"]):
                    _STATE["instances"][key] = "absent"
            elif name == "resume-drop-then-missing":
                _STATE["resumeMode"] = "drop_then_missing"
                _STATE["resumeStage"] = 0
            elif name == "resume-drop-then-block":
                _STATE["resumeMode"] = "drop_then_block"
                _STATE["resumeStage"] = 0
                _RESUME_RELEASE.clear()
            elif name == "release-resume":
                _RESUME_RELEASE.set()
            else:
                self.send_error(404)
                return
            snapshot = {
                "resumeMode": _STATE["resumeMode"],
                "dishonestProbe": _STATE["dishonestProbe"],
                "instances": dict(_STATE["instances"]),
            }
        self._json(200, snapshot)

    def _create(self) -> None:
        body = self._body()
        if not isinstance(body, dict) or not isinstance(body.get("imageRef"), str):
            self.send_error(400)
            return
        key = self.headers.get("Idempotency-Key") or ""
        with _LOCK:
            existing = _STATE["createKeys"].get(key)
            if existing is None:
                # Same key -> same instance, so a lost 201 cannot bill twice.
                existing = f"{_STATE['providerID']}-{len(_STATE['createKeys']) + 1}"
                _STATE["createKeys"][key or f"unkeyed-{len(_STATE['createKeys'])}"] = existing
                _STATE["instances"][existing] = "running"
            _STATE["requests"].append(
                {"method": "POST", "path": self.path, "body": body,
                 "instanceId": existing}
            )
        self._json(201, {"instanceId": existing, "state": "running"})

    def _pause(self, instance_id: str) -> None:
        self._body()
        with _LOCK:
            _STATE["requests"].append({"method": "POST", "path": self.path})
            supports = _STATE["supportsPause"]
            state = _STATE["instances"].get(instance_id)
        if not supports:
            # Declared unsupported in the registry. Say so instead of no-op'ing
            # a 204 that would let the ledger bill a running instance as paused.
            self._json(405, {"error": "this substrate does not support pause"})
            return
        if state is None or state == "absent":
            self._json(404, {"error": "instance is gone"})
            return
        if state == "paused":
            self._json(409, {"error": "instance is already paused"})
            return
        with _LOCK:
            _STATE["instances"][instance_id] = "paused"
        self._empty(204)

    def _resume(self, instance_id: str) -> None:
        self._body()
        with _LOCK:
            _STATE["requests"].append({"method": "POST", "path": self.path})
            supports = _STATE["supportsPause"]
            mode = _STATE["resumeMode"]
            stage = _STATE["resumeStage"]
            if mode:
                _STATE["resumeStage"] += 1
            if mode == "drop_then_missing":
                _STATE["instances"][instance_id] = "absent"
            state = _STATE["instances"].get(instance_id)
        if mode in {"drop_then_missing", "drop_then_block"} and stage == 0:
            # Ambiguous REST loss *after* the substrate saw the request: the
            # caller learns nothing and the durable intent must carry the retry.
            self.close_connection = True
            self.connection.shutdown(2)
            self.connection.close()
            return
        if mode == "drop_then_block":
            _RESUME_RELEASE.wait(timeout=30)
            with _LOCK:
                state = _STATE["instances"].get(instance_id)
        if not supports:
            self._json(405, {"error": "this substrate does not support resume"})
            return
        if state is None or state == "absent":
            self._json(404, {"error": "instance is gone"})
            return
        with _LOCK:
            _STATE["instances"][instance_id] = "running"
        self._json(200, {"instanceId": instance_id, "state": "running"})

    def do_DELETE(self) -> None:
        match = INSTANCE_PATH.match(self.path)
        if not match:
            self.send_error(404)
            return
        instance_id = match.group(1)
        with _LOCK:
            _STATE["requests"].append({"method": "DELETE", "path": self.path})
            known = instance_id in _STATE["instances"]
            if known:
                _STATE["instances"][instance_id] = "absent"
        if not known:
            self._json(404, {"error": "unknown instance"})
            return
        self._empty(204)

    # ---- transport --------------------------------------------------------
    def _body(self) -> Any:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def _json(self, status: int, value: Any) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=28055)
    parser.add_argument("--provider-id", default="mock-a", choices=["mock-a", "mock-b"])
    parser.add_argument(
        "--dishonest-probe",
        action="store_true",
        help="report a dead instance as running (red proof only)",
    )
    args = parser.parse_args()
    _reset(args.provider_id, args.provider_id == "mock-a", args.dishonest_probe)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[{args.provider_id}] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
