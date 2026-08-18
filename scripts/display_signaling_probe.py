#!/usr/bin/env python3
"""Two local peers, one signalling round trip: the LIVE-1 view-only contract.

WHAT THIS PROVES, AND WHAT IT DOES NOT
======================================

It proves the **contract** between the browser and the sandbox's WebRTC
producer, end to end over a real WebSocket, with two processes' worth of
separation between the peers:

  1. `subprotocol` the viewer dials with `Sec-WebSocket-Protocol:
                   momo.display.v1, <capability>` — the browser grammar, the same
                   one `clients/web/src/features/work/observerStream.ts` already
                   uses for terminals — and the producer accepts by echoing back
                   the bare `momo.display.v1`, never the capability.
  2. `validate`   the producer does not trust the token it was handed. It calls
                  the server's `…/display-attach/validate` and refuses anything
                  the server does not vouch for. Here that call is a stub whose
                  verdict the caller supplies, so both answers are exercised.
  3. `view_only`  the SDP the producer offers contains a **video** m-line and NO
                  `m=application` section. That absence IS the guarantee
                  (ADR-0165 D4): there is no datachannel to carry a keystroke, so
                  view-only survives a client that lies about its own flags.
  4. `no_input`   a viewer that asks for input anyway is refused by name and the
                  socket stays open, streaming. Asking is not an error; being
                  answered is not a channel.

It does **not** prove that a real Selkies/GStreamer producer inside a CubeSandbox
microVM behaves this way, because this repository cannot build or boot one — see
`infra/cubesandbox/display-template/README.md`. Every claim about the real
producer is labelled `runtime-unverified(cubesandbox webrtc producer)` and stays
that way until it is measured on a dedicated host.

WHY A HAND-ROLLED WEBSOCKET
===========================

Stdlib only, for `scripts/terminal_attach_probe.py`'s reason: this is a gate, and
a gate that needs `pip install` is a gate that is skipped. The frame codec below
is RFC 6455's minimum — text frames, one mask, no fragmentation — which is all a
signalling channel ever sends.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SUBPROTOCOL = "momo.display.v1"

OPCODE_TEXT = 0x1
OPCODE_CLOSE = 0x8

# The refusal a producer sends when a view-only viewer asks for input. A literal
# rather than a formatted string so the assertion below is decisive.
VIEW_ONLY_REFUSAL = "view_only"


class ProbeFailure(Exception):
    """A named assertion failure. `stage` is what the operator has to look at."""

    def __init__(self, stage: str, detail: str) -> None:
        super().__init__(f"{stage}: {detail}")
        self.stage = stage


# ---------------------------------------------------------------------------
# RFC 6455, the subset a signalling channel uses
# ---------------------------------------------------------------------------


def _accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class Peer:
    """A socket plus the bytes the HTTP handshake read past the end of itself.

    This class exists because of a defect this probe had and this comment is the
    reason it will not come back: reading the upgrade response with
    `recv(4096)` until `\r\n\r\n` also swallows whatever the peer pipelined
    behind it — and a producer that sends `ready` and `offer` immediately after
    `101 Switching Protocols` pipelines two frames every time. The symptom was a
    probe that passed or failed by timing. Whatever the handshake over-read is
    kept here and consumed before the socket is touched again.
    """

    def __init__(self, sock: socket.socket, buffered: bytes = b"") -> None:
        self.sock = sock
        self.buffered = buffered

    def close(self) -> None:
        self.sock.close()


def _recv_exactly(peer: Peer, count: int) -> bytes:
    chunks = []
    remaining = count
    if peer.buffered:
        take = peer.buffered[:remaining]
        peer.buffered = peer.buffered[len(take):]
        chunks.append(take)
        remaining -= len(take)
    while remaining:
        chunk = peer.sock.recv(remaining)
        if not chunk:
            raise ProbeFailure("transport", "peer closed mid-frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_frame(peer: Peer, payload: bytes, *, mask: bool, opcode: int = OPCODE_TEXT) -> None:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    mask_bit = 0x80 if mask else 0x00
    if length < 126:
        header.append(mask_bit | length)
    elif length < (1 << 16):
        header.append(mask_bit | 126)
        header += struct.pack("!H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", length)
    if mask:
        masking_key = os.urandom(4)
        header += masking_key
        payload = bytes(byte ^ masking_key[index % 4] for index, byte in enumerate(payload))
    peer.sock.sendall(bytes(header) + payload)


def _recv_frame(peer: Peer) -> tuple[int, bytes]:
    first, second = _recv_exactly(peer, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", _recv_exactly(peer, 2))
    elif length == 127:
        (length,) = struct.unpack("!Q", _recv_exactly(peer, 8))
    masking_key = _recv_exactly(peer, 4) if masked else b""
    payload = _recv_exactly(peer, length) if length else b""
    if masked:
        payload = bytes(byte ^ masking_key[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def _send_json(peer: Peer, message: dict, *, mask: bool) -> None:
    _send_frame(peer, json.dumps(message).encode("utf-8"), mask=mask)


def _recv_json(peer: Peer, stage: str) -> dict:
    opcode, payload = _recv_frame(peer)
    if opcode == OPCODE_CLOSE:
        raise ProbeFailure(stage, "peer closed the signalling channel")
    if opcode != OPCODE_TEXT:
        raise ProbeFailure(stage, f"expected a text frame, got opcode {opcode}")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeFailure(stage, f"signalling frame is not JSON: {error}") from error


# ---------------------------------------------------------------------------
# the producer half — what runs inside the sandbox
# ---------------------------------------------------------------------------


def producer_offer_sdp(display_id: str) -> str:
    """The SDP a view-only producer offers.

    Two facts about this string carry the whole ADR-0165 D4 guarantee, and both
    are structural rather than declarative:

      * there IS an `m=video` line with `a=sendonly` — the producer sends pixels
        and accepts none;
      * there is NO `m=application …webrtc-datachannel` section. A datachannel
        that does not appear in the offer cannot be negotiated by an answer, so a
        viewer cannot open one by asking, by lying about a flag, or by patching
        its own client.

    The session-level `a=setup:actpass` and the fingerprint are placeholders: this
    probe asserts the SHAPE of the negotiation, not the DTLS handshake.
    """
    return "\r\n".join(
        [
            "v=0",
            "o=- 0 0 IN IP4 127.0.0.1",
            f"s=oort-display-{display_id}",
            "t=0 0",
            "a=group:BUNDLE 0",
            "m=video 9 UDP/TLS/RTP/SAVPF 96",
            "c=IN IP4 0.0.0.0",
            "a=rtcp-mux",
            "a=mid:0",
            "a=sendonly",
            "a=rtpmap:96 H264/90000",
            "a=setup:actpass",
            "",
        ]
    )


def sdp_has_input_channel(sdp: str) -> bool:
    """Whether an SDP negotiates a datachannel — i.e. a way in."""
    return any(
        line.startswith("m=application") or "webrtc-datachannel" in line
        for line in sdp.splitlines()
    )


class StubValidator:
    """Stands in for `POST …/work-hosts/{host}/display-attach/validate`.

    A stub and not a mock of convenience: the real call is covered end to end by
    `display_attach_conformance_pg.rs` against the real router. What this probe
    needs from it is only its *verdict*, so that the producer's refusal path is
    exercised by a real socket rather than asserted about.
    """

    def __init__(self, *, valid_token: str, display_id: str) -> None:
        self.valid_token = valid_token
        self.display_id = display_id
        self.calls: list[str] = []

    def validate(self, token: str) -> dict | None:
        self.calls.append(token)
        if token != self.valid_token:
            return None
        return {
            "display_id": self.display_id,
            "mode": "observer",
            # The server's instruction. The producer obeys it by building an
            # offer with no application m-line — see `producer_offer_sdp`.
            "input_enabled": False,
        }


def serve_one_producer(listener: socket.socket, validator: StubValidator, log: list[str]) -> None:
    """Accept one viewer and speak the signalling contract to it."""
    connection, _address = listener.accept()
    connection.settimeout(10)
    peer = Peer(connection)
    try:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(4096)
            if not chunk:
                return
            request += chunk
        # Anything past the blank line is already-pipelined WebSocket bytes.
        request, _, peer.buffered = request.partition(b"\r\n\r\n")
        headers = {}
        for line in request.decode("latin-1").split("\r\n")[1:]:
            if ": " in line:
                name, _, value = line.partition(": ")
                headers[name.lower()] = value

        offered = [part.strip() for part in headers.get("sec-websocket-protocol", "").split(",")]
        if not offered or offered[0] != SUBPROTOCOL or len(offered) < 2:
            connection.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            log.append("producer: refused a handshake with no capability")
            return
        capability = offered[1]

        verdict = validator.validate(capability)
        if verdict is None:
            # A capability the server does not vouch for never becomes a socket.
            connection.sendall(b"HTTP/1.1 401 Unauthorized\r\n\r\n")
            log.append("producer: server refused the capability")
            return

        accept = _accept_key(headers["sec-websocket-key"])
        connection.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                # Echo the BARE subprotocol. Echoing the capability would put a
                # live bearer in the response headers of every proxy in between.
                f"Sec-WebSocket-Protocol: {SUBPROTOCOL}\r\n"
                "\r\n"
            ).encode("ascii")
        )

        _send_json(
            peer,
            {
                "type": "ready",
                "display_id": verdict["display_id"],
                "mode": verdict["mode"],
                "input_enabled": verdict["input_enabled"],
            },
            mask=False,
        )
        _send_json(
            peer,
            {"type": "offer", "sdp": producer_offer_sdp(verdict["display_id"])},
            mask=False,
        )

        while True:
            try:
                message = _recv_json(peer, "producer")
            except ProbeFailure:
                return
            kind = message.get("type")
            if kind == "answer":
                _send_json(
                    peer,
                    {"type": "ice", "candidate": "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host"},
                    mask=False,
                )
                log.append("producer: answered, sent a host candidate")
            elif kind == "ice":
                log.append("producer: accepted a viewer candidate")
            elif kind == "open_input":
                # The refusal is a sentence, not a channel. Note what does NOT
                # happen here: no renegotiation, no second offer, no m=application.
                _send_json(
                    peer,
                    {"type": "error", "reason": VIEW_ONLY_REFUSAL},
                    mask=False,
                )
                log.append("producer: refused an input request without renegotiating")
            elif kind == "bye":
                _send_frame(peer, b"", mask=False, opcode=OPCODE_CLOSE)
                return
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# the viewer half — what the browser does
# ---------------------------------------------------------------------------


def dial(port: int, capability: str) -> Peer:
    connection = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    connection.sendall(
        (
            "GET /display/signal HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: {SUBPROTOCOL}, {capability}\r\n"
            "\r\n"
        ).encode("ascii")
    )
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = connection.recv(4096)
        if not chunk:
            break
        response += chunk
    # The producer pipelines `ready` and `offer` behind the 101, so the split
    # here is load bearing rather than tidy (see `Peer`).
    response, _, pipelined = response.partition(b"\r\n\r\n")
    response += b"\r\n\r\n"
    status = response.split(b"\r\n", 1)[0].decode("latin-1")
    if "101" not in status:
        connection.close()
        raise ProbeFailure("handshake", f"producer refused the dial: {status}")
    if f"Sec-WebSocket-Protocol: {SUBPROTOCOL}\r\n".encode("ascii") not in response:
        connection.close()
        raise ProbeFailure(
            "subprotocol",
            "producer did not echo the bare subprotocol (a capability in a "
            "response header is a bearer in every intermediary's log)",
        )
    if capability.encode("ascii") in response:
        connection.close()
        raise ProbeFailure("subprotocol", "producer echoed the capability back")
    return Peer(connection, pipelined)


def run_round_trip(port: int, validator: StubValidator, log: list[str]) -> None:
    peer = dial(port, validator.valid_token)
    try:
        ready = _recv_json(peer, "ready")
        if ready.get("type") != "ready":
            raise ProbeFailure("ready", f"expected a ready frame, got {ready!r}")
        if ready.get("mode") != "observer":
            raise ProbeFailure("ready", f"expected observer mode, got {ready.get('mode')!r}")
        if ready.get("input_enabled") is not False:
            raise ProbeFailure(
                "ready",
                "the producer must announce input_enabled=false — ADR-0165 D4",
            )

        offer = _recv_json(peer, "offer")
        if offer.get("type") != "offer":
            raise ProbeFailure("offer", f"expected an offer, got {offer!r}")
        sdp = offer.get("sdp", "")
        if "m=video" not in sdp:
            raise ProbeFailure("offer", "a display offer with no video m-line carries no screen")
        if sdp_has_input_channel(sdp):
            raise ProbeFailure(
                "view_only",
                "the offer negotiated a datachannel — view-only must be the "
                "ABSENCE of an input path, not a flag beside one",
            )
        if "a=sendonly" not in sdp:
            raise ProbeFailure(
                "view_only",
                "the producer must offer sendonly video: it sends pixels and "
                "accepts no media back",
            )

        _send_json(peer, {"type": "answer", "sdp": "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n"}, mask=True)
        candidate = _recv_json(peer, "ice")
        if candidate.get("type") != "ice":
            raise ProbeFailure("ice", f"expected an ICE candidate, got {candidate!r}")
        if "typ relay" in candidate.get("candidate", ""):
            raise ProbeFailure(
                "ice",
                "a relay candidate means a TURN server is in the path; ADR-0165 "
                "D3 defers that decision and forbids a third-party one",
            )

        # Asking for input is allowed. Getting it is not.
        _send_json(peer, {"type": "open_input"}, mask=True)
        refusal = _recv_json(peer, "no_input")
        if refusal.get("type") != "error" or refusal.get("reason") != VIEW_ONLY_REFUSAL:
            raise ProbeFailure("no_input", f"expected a view_only refusal, got {refusal!r}")

        # And the stream is still up: refusing input did not end the watching.
        _send_json(peer, {"type": "ice", "candidate": "candidate:2 1 udp 1 127.0.0.1 9 typ host"}, mask=True)
        _send_json(peer, {"type": "bye"}, mask=True)
        log.append("viewer: completed offer/answer/ICE with no input path")
    finally:
        peer.close()


def run_rejected_dial(port: int, validator: StubValidator) -> None:
    """A capability the server refuses never becomes a socket."""
    try:
        dial(port, "momo_terminal_attach_v1." + "a" * 43)
    except ProbeFailure as failure:
        if failure.stage != "handshake":
            raise
        return
    raise ProbeFailure("unvouched", "the producer opened a stream on a capability the server refused")


def prove_red() -> int:
    """Show that this probe can fail, by breaking the one thing it exists to check.

    A gate nobody has seen go red is a gate nobody knows is wired up. Here the
    producer is swapped for one that negotiates a datachannel — a producer that
    is view-only in its paperwork and controllable on the wire, which is exactly
    the failure ADR-0165 D4 is written against — and this function requires the
    probe to catch it at the named `view_only` stage.
    """
    global producer_offer_sdp
    honest = producer_offer_sdp

    def controllable_offer(display_id: str) -> str:
        return honest(display_id) + "\r\n".join(
            [
                "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
                "c=IN IP4 0.0.0.0",
                "a=mid:1",
                "a=sctp-port:5000",
                "",
            ]
        )

    producer_offer_sdp = controllable_offer
    validator = StubValidator(valid_token="momo_terminal_attach_v1." + "c" * 43, display_id="red")
    log: list[str] = []
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(2)
    port = listener.getsockname()[1]
    try:
        server = threading.Thread(
            target=serve_one_producer, args=(listener, validator, log), daemon=True
        )
        server.start()
        try:
            run_round_trip(port, validator, log)
        except ProbeFailure as failure:
            if failure.stage != "view_only":
                print(
                    f"[display-signaling] FAIL red-proof: caught at {failure.stage}, "
                    "expected view_only",
                    file=sys.stderr,
                )
                return 1
            print(
                "[display-signaling] PASS red-proof: a producer that negotiates a "
                "datachannel is caught at the named view_only stage"
            )
            return 0
        finally:
            server.join(timeout=10)
    finally:
        producer_offer_sdp = honest
        listener.close()
    print(
        "[display-signaling] FAIL red-proof: a controllable producer passed the probe",
        file=sys.stderr,
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--capability",
        default="momo_terminal_attach_v1." + "b" * 43,
        help="the bearer the viewer presents (shape only; this probe mints nothing)",
    )
    parser.add_argument("--display-id", default="display-probe")
    parser.add_argument(
        "--prove-red",
        action="store_true",
        help="run the self-test instead: a controllable producer MUST be caught",
    )
    args = parser.parse_args()

    if args.prove_red:
        return prove_red()

    validator = StubValidator(valid_token=args.capability, display_id=args.display_id)
    log: list[str] = []

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    port = listener.getsockname()[1]

    try:
        # 1. the refused dial
        server = threading.Thread(target=serve_one_producer, args=(listener, validator, log), daemon=True)
        server.start()
        run_rejected_dial(port, validator)
        server.join(timeout=10)

        # 2. the honest round trip
        server = threading.Thread(target=serve_one_producer, args=(listener, validator, log), daemon=True)
        server.start()
        run_round_trip(port, validator, log)
        server.join(timeout=10)
    except ProbeFailure as failure:
        print(f"[display-signaling] FAIL {failure}", file=sys.stderr)
        for line in log:
            print(f"[display-signaling]   {line}", file=sys.stderr)
        return 1
    finally:
        listener.close()

    # The producer asked the server about every token it was handed, including
    # the one it then refused. A producer that only validates tokens it likes is
    # a producer that does not validate.
    if len(validator.calls) != 2:
        print(
            f"[display-signaling] FAIL validate: producer made {len(validator.calls)} "
            "validation calls for 2 dials",
            file=sys.stderr,
        )
        return 1

    for line in log:
        print(f"[display-signaling] {line}")
    print(
        "[display-signaling] PASS subprotocol/validate/view_only/no_input "
        "(two local peers; runtime-unverified against a real cubesandbox producer)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
