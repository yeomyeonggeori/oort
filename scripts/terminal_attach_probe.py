#!/usr/bin/env python3
"""The client half of the standing attach round trip (MOMO-674).

WHAT IT ASSERTS, in the order a real terminal experiences it:

  1. `replay`     the bytes the pty printed BEFORE anyone attached arrive as
                  BINARY frames, and they contain the marker the session
                  actually printed.
  2. `replay_end` exactly one `{"type":"replay_end","byte_offset":N}` TEXT
                  frame separates that scrollback from live output — not zero
                  (nothing tells a client when it caught up), not two (a client
                  would clear twice), and never as terminal bytes (an xterm
                  would print the JSON into the user's scrollback).
  3. `live`       a `send_stdin` frame reaches the pty through the SAME socket
                  and its output comes back.

Every failure is named. A verifier that can only say "timed out" cannot tell a
missing marker apart from a host that never came up, which is the whole reason
this exists rather than a `curl` and a grep.

The bearer travels as `Sec-WebSocket-Protocol: momo.terminal.v1, <token>` — the
browser grammar (clients/web observerStream.ts `observerSubprotocols`), not the
mac's Authorization header, because the subprotocol path is the one no HTTP
client library will exercise for us. Certificates are NOT verified: the
verifier's proxy is a per-run self-signed stand-in for the operator's, and
pinning it would assert something about the test harness instead of about the
daemon.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import threading
import time
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SUBPROTOCOL = "momo.terminal.v1"

OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA


class ProbeFailure(Exception):
    """A named assertion failure. `stage` is what the operator has to look at."""

    def __init__(self, stage: str, detail: str) -> None:
        super().__init__(f"{stage}: {detail}")
        self.stage = stage
        self.detail = detail


def log(message: str) -> None:
    print(f"[attach-probe] {message}", file=sys.stderr, flush=True)


# ---- framing ---------------------------------------------------------------


def encode_client_frame(opcode: int, payload: bytes) -> bytes:
    """A masked frame, which RFC 6455 requires of every client."""
    head = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        head.append(0x80 | length)
    elif length <= 0xFFFF:
        head.append(0x80 | 126)
        head += struct.pack(">H", length)
    else:
        head.append(0x80 | 127)
        head += struct.pack(">Q", length)
    mask = os.urandom(4)
    head += mask
    head += bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes(head)


class Connection:
    """A blocking WebSocket client with just enough of RFC 6455 for this probe."""

    def __init__(self, sock: socket.socket, deadline_seconds: float) -> None:
        self.sock = sock
        self.buffer = bytearray()
        self.deadline_seconds = deadline_seconds
        self.sock.settimeout(1.0)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, opcode: int, payload: bytes) -> None:
        self.sock.sendall(encode_client_frame(opcode, payload))

    def _fill(self, stage: str) -> None:
        try:
            chunk = self.sock.recv(64 * 1024)
        except (socket.timeout, ssl.SSLWantReadError):
            return
        except OSError as error:
            raise ProbeFailure(stage, f"socket error: {error}") from error
        if not chunk:
            raise ProbeFailure(stage, "host closed the connection")
        self.buffer += chunk

    def _decode(self) -> tuple[int, bytes] | None:
        """One server frame, or None when more bytes are needed."""
        if len(self.buffer) < 2:
            return None
        first, second = self.buffer[0], self.buffer[1]
        opcode = first & 0x0F
        if second & 0x80:
            raise ProbeFailure("framing", "server frames must not be masked")
        length = second & 0x7F
        offset = 2
        if length == 126:
            if len(self.buffer) < 4:
                return None
            length = struct.unpack(">H", self.buffer[2:4])[0]
            offset = 4
        elif length == 127:
            if len(self.buffer) < 10:
                return None
            length = struct.unpack(">Q", self.buffer[2:10])[0]
            offset = 10
        if len(self.buffer) < offset + length:
            return None
        payload = bytes(self.buffer[offset : offset + length])
        del self.buffer[: offset + length]
        return opcode, payload

    def next_frame(self, stage: str, timeout: float | None = None) -> tuple[int, bytes]:
        limit = time.monotonic() + (
            self.deadline_seconds if timeout is None else timeout
        )
        while time.monotonic() < limit:
            frame = self._decode()
            if frame is not None:
                opcode, payload = frame
                if opcode == OPCODE_PING:
                    self.send(OPCODE_PONG, payload)
                    continue
                if opcode == OPCODE_PONG:
                    continue
                return opcode, payload
            self._fill(stage)
        raise ProbeFailure(stage, "no frame arrived before the deadline")


# ---- handshake -------------------------------------------------------------


def dial(url: str, token: str, connect_timeout: float) -> Connection:
    parsed = urlparse(url)
    secure = parsed.scheme in ("wss", "https")
    port = parsed.port or (443 if secure else 80)
    host = parsed.hostname or "127.0.0.1"
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"

    try:
        raw = socket.create_connection((host, port), timeout=connect_timeout)
    except OSError as error:
        raise ProbeFailure("handshake", f"cannot reach {host}:{port}: {error}") from error
    raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    if secure:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        try:
            sock: socket.socket = context.wrap_socket(raw, server_hostname=host)
        except (ssl.SSLError, OSError) as error:
            raw.close()
            raise ProbeFailure("handshake", f"TLS failed: {error}") from error
    else:
        sock = raw

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = "\r\n".join(
        [
            f"GET {target} HTTP/1.1",
            f"Host: {host}:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            f"Sec-WebSocket-Key: {key}",
            f"Sec-WebSocket-Protocol: {SUBPROTOCOL}, {token}",
        ]
    ) + "\r\n\r\n"
    sock.sendall(request.encode("ascii"))

    connection = Connection(sock, deadline_seconds=connect_timeout)
    limit = time.monotonic() + connect_timeout
    while b"\r\n\r\n" not in bytes(connection.buffer):
        if time.monotonic() >= limit:
            connection.close()
            raise ProbeFailure("handshake", "no HTTP response before the deadline")
        connection._fill("handshake")
    head, _, rest = bytes(connection.buffer).partition(b"\r\n\r\n")
    connection.buffer = bytearray(rest)
    text = head.decode("latin-1")
    status_line = text.split("\r\n", 1)[0]
    parts = status_line.split(" ")
    if len(parts) < 2 or parts[1] != "101":
        connection.close()
        raise ProbeFailure(
            "handshake", f"expected HTTP 101, got {status_line!r}"
        )
    expected = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    lowered = text.lower()
    if f"sec-websocket-accept: {expected.lower()}" not in lowered:
        connection.close()
        raise ProbeFailure("handshake", "Sec-WebSocket-Accept did not match the key")
    # RFC 6455: the server must name the subprotocol it selected out of the list
    # the client offered. That the CAPABILITY is not echoed back is the point of
    # sending it this way, so only the marker is checked here.
    if f"sec-websocket-protocol: {SUBPROTOCOL}" not in lowered:
        connection.close()
        raise ProbeFailure(
            "handshake",
            f"host did not select the {SUBPROTOCOL} subprotocol the bearer rode in on",
        )
    return connection


# ---- the three assertions --------------------------------------------------


def classify_text(payload: bytes) -> tuple[str, int] | None:
    """The daemon's marker shape, or None for ordinary text output.

    Mirrors clients/web `classifyHostFrame`: a marker without a numeric
    `byte_offset` is not the frame this contract names, so it is not counted as
    one.
    """
    if len(payload) > 256 or not payload.startswith(b"{"):
        return None
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    kind = parsed.get("type")
    if kind not in ("replay_end", "replay_overflow"):
        return None
    offset = parsed.get("byte_offset")
    if not isinstance(offset, int) or isinstance(offset, bool):
        return None
    return kind, offset


def run_probe(
    *,
    url: str,
    token: str,
    pty_id: str,
    expect_replay: str,
    live_input: str,
    expect_live: str,
    timeout: float,
    ready_file: str | None = None,
    expect_close_code: int | None = None,
    close_timeout: float = 60.0,
) -> None:
    connection = dial(url, token, connect_timeout=timeout)
    try:
        connection.send(
            OPCODE_TEXT,
            json.dumps({"pty_id": pty_id, "type": "connect"}, sort_keys=True).encode(),
        )

        # ---- 1 + 2: replay, then exactly one marker ------------------------
        # The stage waiting here is `replay_end`, because the marker is what this
        # loop is waiting FOR: a host that streams bytes forever and never says
        # "you have caught up" is a missing marker, not a missing replay. The
        # replayed CONTENT is asserted below, once the marker has separated it.
        retained = bytearray()
        markers: list[tuple[str, int]] = []
        while not markers:
            opcode, payload = connection.next_frame("replay_end")
            if opcode == OPCODE_BINARY:
                retained += payload
                continue
            if opcode == OPCODE_TEXT:
                marker = classify_text(payload)
                if marker is None:
                    # A host may legitimately send output as text; it is not a
                    # marker and belongs with the replayed bytes.
                    retained += payload
                    continue
                markers.append(marker)
                continue
            if opcode == OPCODE_CLOSE:
                raise ProbeFailure(
                    "replay_end",
                    f"host closed before any replay marker: {decode_close(payload)}",
                )
            raise ProbeFailure("replay_end", f"unexpected opcode 0x{opcode:x}")

        kind, offset = markers[0]
        if kind != "replay_end":
            raise ProbeFailure(
                "replay_end",
                f"the frame that ended replay was {kind!r}, not replay_end",
            )
        if offset < len(retained):
            raise ProbeFailure(
                "replay_end",
                f"byte_offset {offset} is behind the {len(retained)} bytes replayed",
            )
        if expect_replay and expect_replay.encode() not in bytes(retained):
            raise ProbeFailure(
                "replay",
                f"replay did not carry {expect_replay!r} "
                f"({len(retained)} bytes before the marker)",
            )
        log(
            f"replay {len(retained)} bytes -> replay_end byte_offset={offset}"
        )

        # ---- 3: live, through the same socket ------------------------------
        #
        # Skipped for an OBSERVER grant, which has no stdin at all: this client
        # never builds a `send_stdin` frame in that mode, exactly as the web's
        # observer surface has no encoder for one.
        if not expect_live:
            mark_ready(ready_file)
            wait_for_revoked_close(connection, expect_close_code, close_timeout)
            return
        connection.send(
            OPCODE_TEXT,
            json.dumps(
                {
                    "data": base64.b64encode(live_input.encode()).decode("ascii"),
                    "pty_id": pty_id,
                    "type": "send_stdin",
                },
                sort_keys=True,
            ).encode(),
        )
        live = bytearray()
        limit = time.monotonic() + timeout
        while expect_live.encode() not in bytes(live):
            if time.monotonic() >= limit:
                raise ProbeFailure(
                    "live",
                    f"send_stdin output never carried {expect_live!r} "
                    f"({len(live)} bytes after the marker)",
                )
            opcode, payload = connection.next_frame("live", timeout=timeout)
            if opcode == OPCODE_BINARY:
                live += payload
                continue
            if opcode == OPCODE_TEXT:
                marker = classify_text(payload)
                if marker is None:
                    live += payload
                    continue
                # A SECOND marker after replay ended is the failure this stage
                # exists to catch: a client that honours it clears its terminal
                # in the middle of live output.
                raise ProbeFailure(
                    "replay_end_exactly_once",
                    f"a second {marker[0]!r} frame arrived after replay ended",
                )
            if opcode == OPCODE_CLOSE:
                raise ProbeFailure(
                    "live", f"host closed before live output: {decode_close(payload)}"
                )
        log(f"live output carried {expect_live!r}")
        mark_ready(ready_file)
        wait_for_revoked_close(connection, expect_close_code, close_timeout)
    finally:
        connection.close()


def mark_ready(ready_file: str | None) -> None:
    """Tell the caller every assertion before the revoke stage has passed.

    A file rather than a log line because the caller is a shell script that has
    to do something (revoke the grant) at exactly this point and then keep
    waiting on this same socket.
    """
    if not ready_file:
        return
    with open(ready_file, "w", encoding="utf-8") as handle:
        handle.write("ready\n")
    os.chmod(ready_file, 0o600)


def wait_for_revoked_close(
    connection: Connection, expect_close_code: int | None, close_timeout: float
) -> None:
    """MOMO-674: the stream ends, by the named code, once the grant stops holding.

    Silence is the failure this waits for. An attach that keeps streaming after
    the owner closed observation is exactly the hole #869 left, and it does not
    announce itself — so the deadline expiring IS the finding, reported as one.
    """
    if expect_close_code is None:
        return
    limit = time.monotonic() + close_timeout
    while True:
        if time.monotonic() >= limit:
            raise ProbeFailure(
                "revoked_close",
                f"the stream was still open {close_timeout:.0f}s after the grant "
                "was revoked",
            )
        opcode, payload = connection.next_frame("revoked_close", timeout=close_timeout)
        if opcode != OPCODE_CLOSE:
            continue
        code, reason = decode_close_parts(payload)
        if code != expect_close_code:
            raise ProbeFailure(
                "revoked_close",
                f"expected close {expect_close_code}, got {code} ({reason!r})",
            )
        log(f"revoked stream closed with {code} {reason!r}")
        return


def decode_close_parts(payload: bytes) -> tuple[int, str]:
    if len(payload) < 2:
        return 0, ""
    return struct.unpack(">H", payload[:2])[0], payload[2:].decode(
        "utf-8", errors="replace"
    )


def decode_close(payload: bytes) -> str:
    code, reason = decode_close_parts(payload)
    return f"{code} {reason!r}"


# ---- red proof for the probe itself ----------------------------------------


class FakeHost:
    """A host that speaks the wire the daemon speaks, or deliberately does not.

    This exists so the marker assertions can be proven load-bearing WITHOUT a
    Docker stack: a verifier whose assertion has quietly stopped asserting is
    worse than no verifier, and "run it and see it pass" cannot tell those
    apart.
    """

    def __init__(self, behaviour: str) -> None:
        self.behaviour = behaviour
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        try:
            self.listener.close()
        except OSError:
            pass

    @staticmethod
    def _server_frame(opcode: int, payload: bytes) -> bytes:
        head = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            head.append(length)
        elif length <= 0xFFFF:
            head.append(126)
            head += struct.pack(">H", length)
        else:
            head.append(127)
            head += struct.pack(">Q", length)
        return bytes(head) + payload

    def _serve(self) -> None:
        try:
            sock, _ = self.listener.accept()
        except OSError:
            return
        try:
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    return
                head += chunk
            text = head.decode("latin-1")
            key = ""
            for line in text.split("\r\n"):
                if line.lower().startswith("sec-websocket-key:"):
                    key = line.split(":", 1)[1].strip()
            accept = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
            ).decode("ascii")
            sock.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n"
                    f"Sec-WebSocket-Protocol: {SUBPROTOCOL}\r\n\r\n"
                ).encode("ascii")
            )
            sock.sendall(self._server_frame(OPCODE_BINARY, b"MOMO_FAKE_REPLAY\r\n"))
            end = json.dumps(
                {"byte_offset": 18, "type": "replay_end"}, sort_keys=True
            ).encode()
            overflow = json.dumps(
                {"byte_offset": 18, "type": "replay_overflow"}, sort_keys=True
            ).encode()
            if self.behaviour == "good":
                sock.sendall(self._server_frame(OPCODE_TEXT, end))
            elif self.behaviour == "no-marker":
                pass
            elif self.behaviour == "overflow-instead":
                sock.sendall(self._server_frame(OPCODE_TEXT, overflow))
            elif self.behaviour == "two-markers":
                sock.sendall(self._server_frame(OPCODE_TEXT, end))
            else:
                raise AssertionError(self.behaviour)
            # Whatever the client types comes straight back, so the live stage
            # is exercised on every behaviour.
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    return
                if self.behaviour == "two-markers":
                    sock.sendall(self._server_frame(OPCODE_TEXT, end))
                sock.sendall(self._server_frame(OPCODE_BINARY, b"MOMO_FAKE_LIVE\r\n"))
        except OSError:
            return
        finally:
            try:
                sock.close()
            except OSError:
                pass


def selftest() -> int:
    """Every marker assertion, proven to fail by name when the wire breaks it."""
    cases = [
        ("good", None),
        ("no-marker", "replay_end"),
        ("overflow-instead", "replay_end"),
        ("two-markers", "replay_end_exactly_once"),
    ]
    failures = 0
    for behaviour, expected_stage in cases:
        host = FakeHost(behaviour)
        host.start()
        try:
            run_probe(
                url=f"ws://127.0.0.1:{host.port}/v1/terminal-attach",
                token="momo_terminal_attach_v1." + "a" * 43,
                pty_id="pty-selftest",
                expect_replay="MOMO_FAKE_REPLAY",
                live_input="anything\n",
                expect_live="MOMO_FAKE_LIVE",
                timeout=5.0,
            )
        except ProbeFailure as error:
            if expected_stage is None:
                log(f"SELFTEST FAIL {behaviour}: unexpected {error}")
                failures += 1
            elif error.stage != expected_stage:
                log(
                    f"SELFTEST FAIL {behaviour}: expected stage "
                    f"{expected_stage!r}, got {error.stage!r} ({error.detail})"
                )
                failures += 1
            else:
                log(f"selftest {behaviour} -> named failure {error.stage!r} OK")
        else:
            if expected_stage is not None:
                log(
                    f"SELFTEST FAIL {behaviour}: the {expected_stage!r} assertion "
                    "passed a wire that breaks it"
                )
                failures += 1
            else:
                log(f"selftest {behaviour} -> PASS OK")
        finally:
            host.stop()
    if failures:
        log(f"SELFTEST FAILED ({failures})")
        return 1
    log("selftest PASS: replay, replay_end and exactly-once each fail by name")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--url")
    parser.add_argument("--token")
    parser.add_argument("--pty-id")
    parser.add_argument("--expect-replay", default="")
    parser.add_argument("--live-input", default="")
    parser.add_argument("--expect-live", default="")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--ready-file",
        help="Written once every assertion before --expect-close-code has passed.",
    )
    parser.add_argument("--expect-close-code", type=int)
    parser.add_argument("--close-timeout", type=float, default=90.0)
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    missing = [
        name
        for name in ("url", "token", "pty_id")
        if not getattr(args, name)
    ]
    if bool(args.live_input) != bool(args.expect_live):
        missing.append("live_input and expect_live together (or neither)")
    if missing:
        parser.error("missing required arguments: " + ", ".join(sorted(missing)))

    try:
        run_probe(
            url=args.url,
            token=args.token,
            pty_id=args.pty_id,
            expect_replay=args.expect_replay,
            live_input=args.live_input,
            expect_live=args.expect_live,
            timeout=args.timeout,
            ready_file=args.ready_file,
            expect_close_code=args.expect_close_code,
            close_timeout=args.close_timeout,
        )
    except ProbeFailure as error:
        log(f"FAIL {error.stage}: {error.detail}")
        return 1
    stages = ["replay", "exactly one replay_end"]
    if args.expect_live:
        stages.append("send_stdin -> live output")
    if args.expect_close_code is not None:
        stages.append(f"close {args.expect_close_code} after revoke")
    log("PASS: " + " -> ".join(stages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
