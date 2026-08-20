#!/usr/bin/env python3
"""LIVE-5c: a person's keystroke reaches a real screen, and an observer's does not.

WHAT THIS PROVES, AND WHAT IT DOES NOT
======================================

`display_signaling_probe.py` proves the view-only CONTRACT against a stub. This
proves the INPUT half against the **real** producer — the one the template bakes
— by being a real WebRTC peer:

  1. `granted`     the producer's `ready` carries `input_enabled: true`, and it
                   carries it because the SERVER said so. The producer is given
                   no env var that could turn input on; the only thing that can
                   is `validate.input_enabled`, which is the server's conjunction
                   of controller-mode AND an open control window.
  2. `channel`     the OFFER carries `m=application`, and the datachannel arrives
                   on the viewer's `on-data-channel` — the producer opened it.
                   The viewer never calls `create-data-channel`, exactly as the
                   web client never calls `createDataChannel`: a viewer that
                   opened its own channel would be routing around the grant.
  3. `delivery`    key frames encoded to `template.spec.json`'s
                   `signalling.inputChannel` are parsed by the producer, injected
                   with XTEST, and land in a real application on the X display
                   the capture pipeline is reading. The evidence is not "we sent
                   frames" — it is a FILE the typed command created, so the
                   assertion fails if anything between the browser grammar and
                   the far side's keymap is wrong.
  4. `revocation`  when the server stops granting (`input_enabled: false` at the
                   next re-validation), the channel closes and later frames land
                   nowhere. The STREAM stays up: a returned window is not a
                   revoked capability, and the person keeps watching. Run this
                   with `--watch-revoke`, and close the window from the server
                   side while it waits.
  5. `jamming`     `--jam` floods the SIGNALLING socket with frames the message
                   loop discards (non-text, and text that is not JSON) while the
                   revocation is pending. The re-validation is the only clock
                   that can take the keyboard away, so a loop that lets discarded
                   frames skip it lets a returned controller keep typing.

THE RED PROOF FOR (5), AND HOW TO RE-RUN IT
===========================================

The producer's re-validation must sit at the TOP of its message loop, where no
`continue` can jump over it. To prove that is load-bearing rather than tidy,
move the `if time.monotonic() > deadline:` block in `handle_connection` back
below the message handlers, rebuild the image, and run:

    display_input_e2e.py --capability <controller> --jam --watch-revoke 75

...then close the control window from the server side. MEASURED 2026-08-18:

  * check at the BOTTOM — the window closed and 75s later the input channel was
    still open and XTEST injection still live. The producer never re-validated
    once, because the jamming frames hit `continue` every pass.
  * check at the TOP — revoked within one re-validation period: channel closed,
    stream up, keys typed afterwards reached nothing.

A returned window that keeps typing is worse than a stream that never started,
so this is the ordering that has to be defended by a test rather than a comment.

THE CUBESANDBOX/TURN LEG (`--remote-proof`, #1587)
==================================================

This header used to end "it does not prove the CubeSandbox/TURN leg"; that leg
is now this file's `--remote-proof` mode, and it is what measured
`runtimeVerified.inputDeliveredInMicroVM`. The producer runs inside a real
microVM on momo-cube-host and forces relay-only ICE; this harness wires the
SAME server-minted `ice_servers` the display-attach issue handed it
(`--ice-servers-json`, REQUIRED in this mode — without it the viewer would
offer host candidates and a PASS could ride a relay<->host pair the real web
client never has) and forces relay too, so the exchange completes relay<->relay
over `typ relay` candidates. A microVM has no exec path out, so the delivery
proof is not a file — it is the SCREEN: the relay-carried H264 is decoded
(avdec_h264; a keyframe is requested via upstream force-key-unit -> RTCP PLI,
because a mid-stream join never sees the opening IDR) and the saved frame shows
the typed marker echoed at the microVM's own shell prompt. Ledger wiring for
that run is `scripts/display_microvm_seed.py`; the host procedure is
docs/runbooks/cubesandbox-host-install.md §8-E.

WHERE IT RUNS
=============

Inside the display template image, because that is where `webrtcbin`, the X
server and the producer are (the `--remote-proof` viewer additionally wants
`gstreamer1.0-libav` for avdec_h264 — the measurement used the template image
plus that one package). `scripts/verify_display_attach.sh` does not run it
for the same reason it cannot boot a producer: this needs the template.
"""

from __future__ import annotations

import argparse
import base64
import glob
import hashlib
import json
import os
import shutil
import socket
import struct
import sys
import threading
import time
import urllib.parse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SUBPROTOCOL = "momo.display.v1"
INPUT_LABEL = "momo.input.v1"
OPCODE_TEXT = 0x1
OPCODE_CLOSE = 0x8

# The command the harness types. It is the evidence: a file exists afterwards
# only if every physical key survived the browser grammar, the wire, the frame
# parse, XTEST, and the far side's keymap.
PROOF_PATH = "/tmp/momo-input-proof.txt"
PROOF_TEXT = "LIVE5C-INPUT-OK"


class E2EFailure(Exception):
    def __init__(self, stage: str, detail: str) -> None:
        super().__init__(f"[{stage}] {detail}")
        self.stage = stage


def log(msg: str) -> None:
    print(f"[input-e2e] {msg}", flush=True)


# ---------------------------------------------------------------------------
# RFC 6455 client half (the viewer masks; the producer does not)
# ---------------------------------------------------------------------------


class Peer:
    def __init__(self, sock: socket.socket, buffered: bytes = b"") -> None:
        self.sock = sock
        self.buffered = buffered
        self.lock = threading.Lock()

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def _recv_exactly(peer: Peer, count: int) -> bytes:
    out = b""
    if peer.buffered:
        out = peer.buffered[:count]
        peer.buffered = peer.buffered[count:]
    while len(out) < count:
        chunk = peer.sock.recv(count - len(out))
        if not chunk:
            raise E2EFailure("transport", "producer closed the socket")
        out += chunk
    return out


def _send_frame(peer: Peer, payload: bytes, opcode: int = OPCODE_TEXT) -> None:
    header = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header += bytes([0x80 | length])
    elif length < (1 << 16):
        header += bytes([0x80 | 126]) + struct.pack(">H", length)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", length)
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    with peer.lock:
        peer.sock.sendall(header + mask + masked)


def _recv_frame(peer: Peer) -> tuple[int, bytes]:
    first, second = _recv_exactly(peer, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exactly(peer, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exactly(peer, 8))[0]
    key = _recv_exactly(peer, 4) if masked else b""
    payload = _recv_exactly(peer, length)
    if masked:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def send_json(peer: Peer, message: dict) -> None:
    _send_frame(peer, json.dumps(message).encode("utf-8"))


def dial(host: str, port: int, capability: str) -> Peer:
    sock = socket.create_connection((host, port), timeout=20)
    sock.settimeout(30)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET /display/signal/x HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        # The browser grammar: the capability is the SECOND subprotocol token.
        f"Sec-WebSocket-Protocol: {SUBPROTOCOL}, {capability}\r\n"
        "\r\n"
    )
    sock.sendall(request.encode("ascii"))
    raw = b""
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            raise E2EFailure("handshake", "producer closed during the upgrade")
        raw += chunk
    head, _, buffered = raw.partition(b"\r\n\r\n")
    status = head.decode("latin-1").split("\r\n")[0]
    if "101" not in status:
        raise E2EFailure("handshake", f"producer refused the upgrade: {status}")
    expected = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    headers = {}
    for line in head.decode("latin-1").split("\r\n")[1:]:
        if ": " in line:
            name, _, value = line.partition(": ")
            headers[name.lower()] = value
    if headers.get("sec-websocket-accept") != expected:
        raise E2EFailure("handshake", "Sec-WebSocket-Accept did not verify")
    if headers.get("sec-websocket-protocol") != SUBPROTOCOL:
        raise E2EFailure(
            "handshake",
            "the producer must echo the BARE subprotocol, never the capability",
        )
    return Peer(sock, buffered)


# ---------------------------------------------------------------------------
# The input frames — encoded from template.spec.json, not from memory
# ---------------------------------------------------------------------------

# W3C `KeyboardEvent.code` for the characters this harness types. The contract
# carries the PHYSICAL key, so the harness has to spell the command in keys and
# shifts the way a keyboard would.
CODE_FOR_CHAR = {
    **{c: f"Key{c.upper()}" for c in "abcdefghijklmnopqrstuvwxyz"},
    **{c.upper(): f"Key{c.upper()}" for c in "abcdefghijklmnopqrstuvwxyz"},
    **{d: f"Digit{d}" for d in "0123456789"},
    " ": "Space",
    "-": "Minus",
    "_": "Minus",
    "/": "Slash",
    ".": "Period",
    ">": "Period",
    "5": "Digit5",
    "C": "KeyC",
}
SHIFTED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ_>")


def turn_uris_from_ice_servers(ice_servers) -> tuple[str, str]:
    """Render the server's `ice_servers` into webrtcbin's `turn://` spelling.

    Byte-for-byte the producer's own renderer (`momo-display-producer`
    `turn_uris_from_ice_servers`), copied here rather than imported because this
    harness stays stdlib+GStreamer with no repo import path. It is what makes the
    VIEWER a relay peer too: in production the web client builds its
    `RTCPeerConnection` from exactly this `ice_servers` list (the display-attach
    ISSUE response), so a microVM measurement in which the viewer used host
    candidates while the producer was relay-only would connect over a path the
    real client never has. Returns `(udp_uri, tcp_uri)`; both carry a credential
    and are therefore never logged.
    """
    udp = ""
    tcp = ""
    for server in ice_servers or []:
        username = urllib.parse.quote(str(server.get("username", "")), safe="")
        credential = urllib.parse.quote(str(server.get("credential", "")), safe="")
        if not username or not credential:
            continue
        for url in server.get("urls") or []:
            url = str(url).strip()
            if url.startswith("turn:"):
                scheme, rest = "turn", url[len("turn:"):]
            elif url.startswith("turns:"):
                scheme, rest = "turns", url[len("turns:"):]
            else:
                continue
            uri = f"{scheme}://{username}:{credential}@{rest}"
            if "transport=tcp" in rest:
                tcp = tcp or uri
            else:
                udp = udp or uri
    return udp, tcp


def ice_servers_from_json(path: str) -> list:
    """Read `ice_servers` from a display-attach ISSUE response (or a bare array)."""
    with open(path) as handle:
        document = json.load(handle)
    if isinstance(document, dict):
        return document.get("ice_servers") or []
    if isinstance(document, list):
        return document
    return []


def key_frame(action: str, code: str, shift: bool = False) -> dict:
    """`signalling.inputChannel.keyFrame` — and no character, ever."""
    return {
        "type": "key",
        "action": action,
        "code": code,
        "ctrl": False,
        "shift": shift,
        "alt": False,
        "meta": False,
        "repeat": False,
    }


def frames_for_text(text: str) -> list[dict]:
    frames: list[dict] = []
    for char in text:
        code = CODE_FOR_CHAR.get(char)
        if code is None:
            raise E2EFailure("encode", f"no physical key for {char!r}")
        shift = char in SHIFTED
        if shift:
            frames.append(key_frame("down", "ShiftLeft", True))
        frames.append(key_frame("down", code, shift))
        frames.append(key_frame("up", code, shift))
        if shift:
            frames.append(key_frame("up", "ShiftLeft", False))
    return frames


# ---------------------------------------------------------------------------
# The WebRTC viewer half
# ---------------------------------------------------------------------------


class Viewer:
    """A real peer: it answers the producer's offer and receives its channel."""

    def __init__(self, peer: Peer, ice_servers=None, snapshot_dir: str = "") -> None:
        import gi

        gi.require_version("Gst", "1.0")
        gi.require_version("GstWebRTC", "1.0")
        gi.require_version("GstSdp", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gst, GstSdp, GstVideo, GstWebRTC

        self._Gst = Gst
        self._GstSdp = GstSdp
        self._GstVideo = GstVideo
        self._GstWebRTC = GstWebRTC
        self.peer = peer
        self.snapshot_dir = snapshot_dir
        self._snapshot_serial = 0
        # Built by hand rather than `parse_launch`: a one-element launch string
        # returns the ELEMENT, not a pipeline, and `get_by_name` on it is None.
        self.pipe = Gst.Pipeline.new("viewer")
        self.webrtc = Gst.ElementFactory.make("webrtcbin", "recv")
        if self.webrtc is None:
            raise E2EFailure("viewer", "webrtcbin is missing from this image")
        self.webrtc.set_property("latency", 50)
        # Match the producer: max-bundle is what a browser answers with, and the
        # harness is standing in for a browser.
        self.webrtc.set_property(
            "bundle-policy", self._GstWebRTC.WebRTCBundlePolicy.MAX_BUNDLE
        )
        # LIVE-5c #1587 — when the producer runs inside a CubeSandbox microVM it
        # forces ice-transport-policy=relay, so it offers ONLY `typ relay`
        # candidates on the oort TURN. A viewer that offered host candidates
        # would have nothing the producer's relay could reach. Wiring the SAME
        # `ice_servers` the display-attach issue handed this viewer (the exact
        # list the web client feeds `new RTCPeerConnection`) and forcing relay
        # here makes the round trip relay<->relay end to end — the thing
        # `unverified.inputDeliveryInMicroVM` names as still unmeasured.
        udp_uri, tcp_uri = turn_uris_from_ice_servers(ice_servers)
        if udp_uri:
            self.webrtc.set_property("turn-server", udp_uri)
            if tcp_uri:
                try:
                    self.webrtc.emit("add-turn-server", tcp_uri)
                except Exception as exc:  # noqa: BLE001
                    log(f"ice: viewer add-turn-server(tcp) failed ({exc})")
            self.webrtc.set_property(
                "ice-transport-policy",
                self._GstWebRTC.WebRTCICETransportPolicy.RELAY,
            )
            log("ice: viewer TURN wired (udp+tcp), ice-transport-policy=RELAY (credential not logged)")
        self.pipe.add(self.webrtc)
        self.webrtc.connect("on-ice-candidate", self._on_ice_candidate)
        self.webrtc.connect("on-data-channel", self._on_data_channel)
        # State transitions, because "the channel never opened" is four different
        # failures and they need telling apart: ICE that never connected, DTLS
        # that never completed, an answer the producer rejected, or a channel the
        # producer never made.
        for prop in ("ice-connection-state", "ice-gathering-state", "connection-state"):
            self.webrtc.connect(
                f"notify::{prop}",
                lambda element, spec, name=prop: log(
                    f"{name} = {element.get_property(name).value_nick}"
                ),
            )
        # The producer sends video this harness does not render; a pad that goes
        # nowhere would stall the session, so each one is drained.
        self.webrtc.connect("pad-added", self._on_pad_added)
        # Surface decode/transport faults instead of a silent "no frame": the
        # snapshot branch is several elements deep and a caps or plugin fault
        # there would otherwise present only as an empty directory.
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error)
        bus.connect("message::warning", self._on_bus_warning)
        self.pipe.set_state(Gst.State.PLAYING)
        self.channel = None
        self.channel_open = threading.Event()
        self.channel_closed = threading.Event()

    def _on_bus_error(self, _bus, message) -> None:
        err, debug = message.parse_error()
        log(f"gst ERROR from {message.src.get_name()}: {err.message} ({debug})")

    def _on_bus_warning(self, _bus, message) -> None:
        warn, debug = message.parse_warning()
        log(f"gst warning from {message.src.get_name()}: {warn.message}")

    def _on_pad_added(self, _element, pad) -> None:
        if self.snapshot_dir:
            self._attach_snapshot_branch(pad)
            return
        sink = self._Gst.ElementFactory.make("fakesink", None)
        sink.set_property("sync", False)
        self.pipe.add(sink)
        sink.sync_state_with_parent()
        pad.link(sink.get_static_pad("sink"))

    def _attach_snapshot_branch(self, pad) -> None:
        """Decode the producer's H264 to a rolling PNG on disk.

        The evidence a microVM run can produce is not a proof FILE — that file
        would be written inside the microVM, which has no exec path out (no
        envd). It is the SCREEN itself, decoded from the relay-carried video: a
        frame showing the typed characters echoed in the xterm is the whole loop
        (datachannel -> XTEST -> the app in the microVM -> its X server -> the
        capture pipeline -> H264 -> relay -> here). openh264dec, because the
        template image ships no `avdec_h264`.
        """
        Gst = self._Gst
        os.makedirs(self.snapshot_dir, exist_ok=True)
        # A leaky queue right off the webrtc pad so decode backpressure never
        # stalls the transport, then depay -> parse -> H264 decoder -> convert
        # -> a rolling PNG. avdec_h264 is preferred over openh264dec: a receiver
        # that joins mid-stream feeds the decoder P-frames before its first IDR,
        # and openh264dec was measured (#1587) to stall permanently on that
        # (depay + parse pass every AU, the decoder emits none), while
        # avdec_h264 waits for the IDU and recovers. openh264dec stays the
        # fallback for an image without libav. No videorate: it needs two
        # buffers to compute a rate and stalled the branch before the first
        # frame.
        decoder = "avdec_h264" if Gst.ElementFactory.find("avdec_h264") else "openh264dec"
        log(f"snapshot: using {decoder}")
        chain = [
            ("queue", {"leaky": 2, "max-size-buffers": 8}),
            ("rtph264depay", None),
            ("h264parse", {"config-interval": -1}),
            ("capsfilter", {"caps": self._Gst.Caps.from_string(
                "video/x-h264,stream-format=byte-stream,alignment=au")}),
            (decoder, None),
            ("videoconvert", None),
            ("pngenc", None),
            (
                "multifilesink",
                {
                    "location": os.path.join(self.snapshot_dir, "frame-%05d.png"),
                    "max-files": 8,
                    "sync": False,
                },
            ),
        ]
        elements = []
        for factory, props in chain:
            element = Gst.ElementFactory.make(factory, None)
            if element is None:
                log(f"snapshot: {factory} missing — falling back to fakesink")
                sink = Gst.ElementFactory.make("fakesink", None)
                sink.set_property("sync", False)
                self.pipe.add(sink)
                sink.sync_state_with_parent()
                pad.link(sink.get_static_pad("sink"))
                return
            for name, value in (props or {}).items():
                element.set_property(name, value)
            elements.append(element)
        for element in elements:
            self.pipe.add(element)
            element.sync_state_with_parent()
        caps = pad.get_current_caps()
        link_ret = pad.link(elements[0].get_static_pad("sink"))
        for upstream, downstream in zip(elements, elements[1:]):
            upstream.link(downstream)

        # A counting probe so "no frame" tells host-media-absent from
        # decode-branch-broken: if buffers arrive here but no PNG lands, the
        # decoder is the fault; if none arrive, the relay never carried video.
        def make_counter(stage):
            def _count(_pad, _info, box={"n": 0}):
                box["n"] += 1
                if box["n"] in (1, 30, 150):
                    log(f"snapshot: {stage} produced {box['n']} buffer(s)")
                return Gst.PadProbeReturn.OK
            return _count

        for stage, element in (
            ("depay", elements[1]),
            ("h264parse", elements[2]),
            ("openh264dec", elements[4]),
            ("pngenc", elements[6]),
        ):
            element.get_static_pad("src").add_probe(
                Gst.PadProbeType.BUFFER, make_counter(stage)
            )
        # A receiver that joined mid-stream missed the producer's opening
        # SPS/PPS/IDR, and a WebRTC H264 sender emits further IDRs only when the
        # far side asks — so without this the decode branch sees an unbroken run
        # of P-frames and openh264dec produces nothing (measured #1587: depay
        # and h264parse pass 150 AUs, the decoder 0). An upstream
        # force-key-unit event becomes an RTCP PLI to the producer, whose
        # x264enc then emits an IDR the decoder can start on. Sent a few times
        # because the first can race DTLS/SRTP coming fully up.
        self._keyframe_pad = pad
        self._request_keyframe()
        from gi.repository import GLib
        for delay_ms in (700, 1600, 3000):
            GLib.timeout_add(delay_ms, self._request_keyframe_once)
        log(
            f"snapshot: decode branch attached (link={link_ret.value_nick}, "
            f"pad caps={caps.to_string() if caps else 'none-yet'})"
        )

    def _request_keyframe(self) -> None:
        pad = getattr(self, "_keyframe_pad", None)
        if pad is None:
            return
        event = self._GstVideo.video_event_new_upstream_force_key_unit(
            self._Gst.CLOCK_TIME_NONE, True, 0
        )
        pad.send_event(event)

    def _request_keyframe_once(self) -> bool:
        self._request_keyframe()
        return False  # one-shot GLib timeout

    def snapshot(self, label: str) -> str:
        """Copy the freshest decoded frame to `<dir>/<label>.png` and return it.

        Returns an empty string if no frame has decoded yet (a black or
        never-connected stream), which the caller treats as a failed capture
        rather than a passing one.
        """
        if not self.snapshot_dir:
            return ""
        frames = sorted(glob.glob(os.path.join(self.snapshot_dir, "frame-*.png")))
        if not frames:
            return ""
        latest = frames[-1]
        target = os.path.join(self.snapshot_dir, f"{label}.png")
        try:
            shutil.copyfile(latest, target)
        except OSError as exc:
            log(f"snapshot: could not save {label} ({exc})")
            return ""
        log(f"snapshot: {label} saved ({os.path.getsize(target)} bytes)")
        return target

    def _on_ice_candidate(self, _element, mline_index, candidate) -> None:
        send_json(
            self.peer,
            {"type": "ice", "candidate": candidate, "sdpMLineIndex": mline_index},
        )

    def _on_data_channel(self, _element, channel) -> None:
        label = channel.get_property("label")
        if label != INPUT_LABEL:
            log(f"channel {label!r} is not the contract's — closing it")
            channel.emit("close")
            return
        self.channel = channel
        channel.connect("on-open", lambda _c: self.channel_open.set())
        channel.connect("on-close", lambda _c: self.channel_closed.set())
        # webrtcbin may hand the channel over already open.
        if channel.get_property("ready-state") == self._GstWebRTC.WebRTCDataChannelState.OPEN:
            self.channel_open.set()
        log(f"data channel {label!r} arrived from the PRODUCER")

    def accept_offer(self, sdp_text: str) -> None:
        ok, sdp = self._GstSdp.SDPMessage.new_from_text(sdp_text)
        if ok != self._GstSdp.SDPResult.OK:
            raise E2EFailure("offer", "the producer's SDP does not parse")
        offer = self._GstWebRTC.WebRTCSessionDescription.new(
            self._GstWebRTC.WebRTCSDPType.OFFER, sdp
        )
        promise = self._Gst.Promise.new()
        self.webrtc.emit("set-remote-description", offer, promise)
        promise.interrupt()
        promise = self._Gst.Promise.new()
        self.webrtc.emit("create-answer", None, promise)
        promise.wait()
        reply = promise.get_reply()
        answer = reply.get_value("answer")
        self.webrtc.emit("set-local-description", answer, self._Gst.Promise.new())
        send_json(self.peer, {"type": "answer", "sdp": answer.sdp.as_text()})

    def add_ice(self, candidate: str, mline_index: int) -> None:
        self.webrtc.emit("add-ice-candidate", mline_index, candidate)

    def send_input(self, frame: dict) -> None:
        if self.channel is None:
            raise E2EFailure("input", "no input channel")
        self.channel.emit("send-string", json.dumps(frame))

    def stop(self) -> None:
        self.pipe.set_state(self._Gst.State.NULL)


def pump(peer: Peer, viewer: Viewer, ready_box: dict, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            opcode, payload = _recv_frame(peer)
        except (E2EFailure, OSError):
            return
        if opcode == OPCODE_CLOSE:
            return
        if opcode != OPCODE_TEXT:
            continue
        try:
            message = json.loads(payload.decode("utf-8"))
        except ValueError:
            continue
        kind = message.get("type")
        if kind == "ready":
            ready_box["ready"] = message
        elif kind == "offer":
            ready_box["offer"] = message.get("sdp", "")
            viewer.accept_offer(ready_box["offer"])
        elif kind == "ice":
            viewer.add_ice(
                message.get("candidate", ""), int(message.get("sdpMLineIndex", 0))
            )
        elif kind == "error":
            ready_box.setdefault("errors", []).append(message)


def wait_for(predicate, timeout: float, stage: str, detail: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise E2EFailure(stage, detail)


BEAT_PATH = "/tmp/momo-input-beats.txt"
REVOKE_PATH = "/tmp/momo-input-after-revoke.txt"
OPCODE_BINARY = 0x2


def jam(peer: Peer, stop: threading.Event, interval: float) -> None:
    """Flood the signalling socket with frames the producer's loop discards.

    Not a stress test — a starvation test. Both of these are dropped by the
    message loop, and if the loop's re-validation sits after the drop, a viewer
    sending them faster than the tick keeps the producer from ever asking the
    server whether this person still holds the window. The keyboard then outlives
    the grant, which is the one thing the control window exists to bound.
    """
    while not stop.is_set():
        try:
            # A binary frame: discarded for its opcode.
            _send_frame(peer, b"\x00\x01\x02\x03", OPCODE_BINARY)
            # A text frame that is not JSON: discarded at the parse.
            _send_frame(peer, b"{not json at all")
        except (OSError, E2EFailure):
            return
        time.sleep(interval)


def watch_revoke(viewer: "Viewer", peer: Peer, args) -> int:
    """Prove the keyboard goes away when the server stops granting it.

    Three assertions, because "the channel closed" alone would also be true of a
    dead connection, and a dead connection is the WRONG outcome: returning a
    window must leave the person watching the screen they no longer drive.
    """
    log(f"revoke: waiting up to {args.watch_revoke}s for the server to close the window")
    if not viewer.channel_closed.wait(args.watch_revoke):
        raise E2EFailure(
            "revoke",
            "the input channel was still open after the control window closed — "
            "the producer never re-validated (see the jamming note in this file's "
            "header) or never acted on the answer",
        )
    log("revoke: input channel CLOSED")

    # The stream must NOT have been cut with it.
    try:
        send_json(peer, {"type": "ping-not-a-frame-type"})
    except OSError as exc:
        raise E2EFailure(
            "revoke", f"the signalling socket died with the window ({exc}) — "
            "a returned window must leave the stream up"
        )
    if viewer.webrtc.get_property("connection-state").value_nick in ("failed", "closed"):
        raise E2EFailure(
            "revoke",
            "the peer connection ended with the control window — the person "
            "should still be watching",
        )
    log("revoke: stream still up (peer connection alive, signalling alive)")

    # And input really is gone: a typed command after the close must not run.
    marker = "AFTER-REVOKE"
    try:
        for frame in frames_for_text(f"echo {marker} > {REVOKE_PATH}"):
            viewer.send_input(frame)
            time.sleep(0.004)
        viewer.send_input(key_frame("down", "Enter"))
        viewer.send_input(key_frame("up", "Enter"))
    except Exception:  # noqa: BLE001
        # Sending on a closed channel raising is itself a pass for this half.
        pass
    time.sleep(3)
    if os.path.exists(REVOKE_PATH):
        raise E2EFailure(
            "revoke",
            f"a command typed AFTER the window closed still ran ({REVOKE_PATH} "
            "exists) — the channel closed but injection did not stop",
        )
    log("revoke: keys typed after the close reached nothing")
    print("[input-e2e] PASS revocation (channel closed, stream up, injection stopped)")
    return 0


def remote_proof(viewer: "Viewer", args) -> int:
    """Prove a key reached the app INSIDE a CubeSandbox microVM, over relay.

    This is the half `unverified.inputDeliveryInMicroVM` names. The producer is
    in a real microVM on momo-cube-host and forced relay-only; this viewer wired
    the same TURN and connected relay<->relay. What it cannot do is read the
    microVM's filesystem, so the proof is not a file — it is the SCREEN: the
    relay-carried video, decoded here, showing the typed characters echoed in the
    xterm. A frame before typing and a frame after are saved; the caller reads
    the second one.

    The command typed uses physical keys only and is chosen to be legible on
    screen (its echo and its output both name the run). The channel opening and
    the frames going out are asserted here; that the characters actually LANDED
    is what the saved screenshot shows, which is why the run prints the path
    rather than swallowing it into a boolean.
    """
    # A moment for the first keyframes to decode, so "before" is a real frame.
    before = ""
    for _ in range(80):
        before = viewer.snapshot("before-typing")
        if before:
            break
        time.sleep(0.25)
    if not before:
        raise E2EFailure(
            "delivery",
            "no video frame decoded before typing — the relay stream never "
            "arrived, so nothing could carry the on-screen proof either",
        )
    log(f"remote: pre-typing frame captured ({before})")

    for frame in frames_for_text(args.type_text):
        viewer.send_input(frame)
        time.sleep(0.02)
    # Snapshot the typed line while it is on the current row, then run it.
    time.sleep(1.0)
    typed = viewer.snapshot("after-typing")
    viewer.send_input(key_frame("down", "Enter"))
    viewer.send_input(key_frame("up", "Enter"))
    time.sleep(1.5)
    after = viewer.snapshot("after-enter")
    if not typed and not after:
        raise E2EFailure(
            "delivery",
            "no video frame decoded after typing — the stream stopped carrying "
            "the screen, so the keystrokes cannot be confirmed on it",
        )
    log(f"remote: post-typing frames captured (typed={typed} after={after})")
    print(
        "[input-e2e] PASS remote granted/channel/typed over relay — "
        f"on-screen proof in {args.snapshot_dir} "
        "(read after-typing.png / after-enter.png for the echoed command)"
    )
    return 0


def soak(viewer: "Viewer", args) -> int:
    """Hold one control session open and keep asking whether it still delivers.

    THE MEASUREMENT LIVE-5c OWED (`credentialCeiling` — resolved by this soak,
    PR #1570). The server re-mints the relay credential on every re-validate;
    the producer installs one at pipeline construction and throws the rest
    away, because GStreamer cannot swap a TURN server on a running ICE agent.
    The hypothesis was that this makes the credential's TTL a ceiling on the
    PEER CONNECTION — and the measurement REFUTED it: coturn checks the REST
    username's expiry only at ALLOCATE, never on an existing allocation's
    REFRESH, so a 60s-TTL session held a 200s soak with 10/10 beats delivered
    (relay-only, last beat t+180s). The soak stays runnable as the regression
    instrument for that claim: if a relay ever starts enforcing expiry on
    REFRESH (config drift, a coturn upgrade), this is what notices.

    A beat is a typed line, not a ping: what is being measured is whether a
    PERSON's keystroke still arrives, which is the thing that stops working.
    """
    beats = 0
    delivered = 0
    last_ok = time.monotonic()
    started = time.monotonic()
    first_failure_at = None
    try:
        os.unlink(BEAT_PATH)
    except OSError:
        pass
    log(
        f"soak: holding the session for {args.soak_seconds}s, "
        f"typing every {args.soak_interval}s"
    )
    while time.monotonic() - started < args.soak_seconds:
        beats += 1
        marker = f"BEAT{beats}"
        try:
            for frame in frames_for_text(f"echo {marker} > {BEAT_PATH}"):
                viewer.send_input(frame)
                time.sleep(0.004)
            viewer.send_input(key_frame("down", "Enter"))
            viewer.send_input(key_frame("up", "Enter"))
        except Exception as exc:  # noqa: BLE001
            log(f"soak: could not send beat {beats} ({exc})")

        landed = False
        deadline = time.monotonic() + min(args.soak_interval, 8)
        while time.monotonic() < deadline:
            try:
                with open(BEAT_PATH) as handle:
                    if marker in handle.read():
                        landed = True
                        break
            except OSError:
                pass
            time.sleep(0.2)

        elapsed = int(time.monotonic() - started)
        if landed:
            delivered += 1
            last_ok = time.monotonic()
            log(f"soak: t+{elapsed}s beat {beats} DELIVERED")
        else:
            if first_failure_at is None:
                first_failure_at = elapsed
                log(f"soak: t+{elapsed}s beat {beats} LOST — first failure")
            else:
                log(f"soak: t+{elapsed}s beat {beats} lost")
        time.sleep(max(0.0, args.soak_interval - (time.monotonic() - (started + elapsed))))

    total = int(time.monotonic() - started)
    log(
        f"soak: {delivered}/{beats} beats delivered over {total}s; "
        f"last delivery at t+{int(last_ok - started)}s; "
        + (
            f"first loss at t+{first_failure_at}s"
            if first_failure_at is not None
            else "no loss observed"
        )
    )
    print("[input-e2e] SOAK COMPLETE")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8452)
    parser.add_argument("--capability", required=True)
    parser.add_argument(
        "--expect-input",
        choices=("granted", "refused"),
        default="granted",
        help="what the SERVER is expected to have answered for this capability",
    )
    parser.add_argument("--proof-path", default=PROOF_PATH)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument(
        "--soak-seconds",
        type=float,
        default=0.0,
        help="hold the session this long, typing periodically (credential ceiling)",
    )
    parser.add_argument("--soak-interval", type=float, default=15.0)
    parser.add_argument(
        "--watch-revoke",
        type=float,
        default=0.0,
        help="after delivery, wait this long for the server to close the window "
        "and assert the channel closes, the stream survives, and injection stops",
    )
    parser.add_argument(
        "--jam",
        action="store_true",
        help="flood the signalling socket with discarded frames while waiting "
        "(red proof: a re-validation that a `continue` can skip never fires)",
    )
    parser.add_argument("--jam-interval", type=float, default=0.05)
    parser.add_argument(
        "--ice-servers-json",
        default="",
        help="a display-attach ISSUE response (or a bare ice_servers array): "
        "wires the viewer's TURN and forces relay, so a microVM producer's "
        "relay-only offer connects relay<->relay (LIVE-5c #1587)",
    )
    parser.add_argument(
        "--snapshot-dir",
        default="",
        help="decode the relay-carried video and save PNG frames here; the "
        "screenshot is the microVM's on-screen proof that a key arrived",
    )
    parser.add_argument(
        "--remote-proof",
        action="store_true",
        help="the producer runs in a microVM whose filesystem this harness "
        "cannot read: succeed on grant+channel+on-screen delivery (a decoded "
        "frame) instead of a local proof file",
    )
    parser.add_argument(
        "--type-text",
        default="echo LIVE5C-MICROVM-OK",
        help="the visible command typed in --remote-proof mode (physical keys "
        "only; its echo on the xterm is the evidence)",
    )
    args = parser.parse_args()

    # `--remote-proof` exists to measure the relay leg, so the relay is not
    # optional in it: without `--ice-servers-json` the viewer would offer host
    # candidates, and against a host-reachable producer the run could PASS over
    # a relay<->host pair — a green that contradicts the relay<->relay claim the
    # graduated label makes. Refused before GStreamer is even imported, so a
    # re-run that dropped the flag fails in milliseconds with the reason named.
    if args.remote_proof:
        if not args.ice_servers_json:
            parser.error(
                "--remote-proof requires --ice-servers-json (the display-attach "
                "issue response): the microVM claim is relay<->relay, and a "
                "viewer without the server-minted relay credential would not "
                "measure it"
            )
        if not args.snapshot_dir:
            parser.error(
                "--remote-proof requires --snapshot-dir: the on-screen frame IS "
                "the delivery proof in this mode"
            )

    ice_servers = ice_servers_from_json(args.ice_servers_json) if args.ice_servers_json else None
    if args.remote_proof:
        udp_uri, tcp_uri = turn_uris_from_ice_servers(ice_servers)
        if not udp_uri and not tcp_uri:
            parser.error(
                "--remote-proof: the --ice-servers-json document rendered no "
                "turn:// URI (empty ice_servers, or entries without a "
                "credential) — the viewer cannot be a relay peer with it, so "
                "the run would not measure the relay<->relay claim"
            )

    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst  # noqa: E402

    Gst.init(None)

    # webrtcbin's ICE and DTLS work is driven by a GMainContext: without a
    # running loop the pipeline builds, the offer is answered, and then nothing
    # else ever happens — no connectivity checks, no `on-data-channel`. The
    # producer runs one for the same reason; a harness that skipped it would be
    # measuring its own missing loop and reporting it as the producer's silence.
    loop = GLib.MainLoop()
    threading.Thread(target=loop.run, daemon=True).start()

    for stale in (args.proof_path, REVOKE_PATH):
        if os.path.exists(stale):
            os.unlink(stale)

    peer = dial(args.host, args.port, args.capability)
    log("attached")
    viewer = Viewer(peer, ice_servers=ice_servers, snapshot_dir=args.snapshot_dir)
    box: dict = {}
    stop = threading.Event()
    pumper = threading.Thread(target=pump, args=(peer, viewer, box, stop), daemon=True)
    pumper.start()

    try:
        ready = wait_for(lambda: box.get("ready"), 15, "ready", "no ready message")
        granted = bool(ready.get("input_enabled"))
        log(f"ready: mode={ready.get('mode')} input_enabled={granted}")

        if args.expect_input == "refused":
            if granted:
                raise E2EFailure("granted", "the server refused control but ready says enabled")
            offer = wait_for(lambda: box.get("offer"), 15, "offer", "no offer")
            if "m=application" in offer or "webrtc-datachannel" in offer:
                raise E2EFailure(
                    "channel",
                    "an ungranted viewer was offered a datachannel (D4 violated)",
                )
            log("PASS refused: no grant, no m=application, stream still up")
            return 0

        if not granted:
            raise E2EFailure(
                "granted",
                "the server granted control but the producer's ready says input_enabled=false",
            )
        offer = wait_for(lambda: box.get("offer"), 15, "offer", "no offer")
        if "m=application" not in offer:
            raise E2EFailure("channel", "a granted offer carries no m=application")
        log("offer carries m=application")

        if not viewer.channel_open.wait(args.timeout):
            raise E2EFailure("channel", "the producer's input channel never opened")
        log("input channel OPEN — typing")

        if args.remote_proof:
            return remote_proof(viewer, args)

        # Type the command, then Enter. Physical keys only.
        for frame in frames_for_text(f"echo {PROOF_TEXT} > {args.proof_path}"):
            viewer.send_input(frame)
            time.sleep(0.004)
        viewer.send_input(key_frame("down", "Enter"))
        viewer.send_input(key_frame("up", "Enter"))

        def proof_landed():
            try:
                with open(args.proof_path) as handle:
                    return PROOF_TEXT in handle.read()
            except OSError:
                return False

        wait_for(
            proof_landed,
            args.timeout,
            "delivery",
            f"the typed command never created {args.proof_path} — "
            "keys were sent but nothing reached the screen",
        )
        log(f"DELIVERED: the typed command wrote {args.proof_path}")

        if args.jam:
            log("jamming the signalling socket with frames the loop discards")
            threading.Thread(
                target=jam, args=(peer, stop, args.jam_interval), daemon=True
            ).start()

        if args.watch_revoke > 0:
            return watch_revoke(viewer, peer, args)

        if args.soak_seconds > 0:
            return soak(viewer, args)

        print(f"[input-e2e] PASS granted/channel/delivery ({PROOF_TEXT})")
        return 0
    finally:
        stop.set()
        try:
            send_json(peer, {"type": "bye"})
        except Exception:  # noqa: BLE001
            pass
        viewer.stop()
        peer.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except E2EFailure as exc:
        log(f"FAIL {exc}")
        raise SystemExit(1)
