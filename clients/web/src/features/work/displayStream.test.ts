import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  attachSocketUrl,
  classifyClose,
  observationStillPermits,
  observerLink,
} from "./observerStream";
import {
  answerFrame,
  byeFrame,
  classifyDisplayGrantFailure,
  classifyProducerFrame,
  displayFailureCopy,
  displayGate,
  displayOffersReload,
  displayOffersRetry,
  displayQuietLabel,
  displaySubprotocols,
  iceFrame,
  isValidDisplayId,
  readInboundVideoStats,
  sdpCarriesVideo,
  sdpNegotiatesInput,
  DISPLAY_FAILURE_COPY,
  DISPLAY_ICE_SERVERS,
  DISPLAY_LINK_STATUS,
  DISPLAY_NEGOTIATE_TIMEOUT_MS,
  DISPLAY_OBSERVER_MODE,
  DISPLAY_REVERIFY_MS,
  DISPLAY_SUBPROTOCOL,
  type DisplayFailure,
} from "./displayStream";

// =============================================================================
// LIVE-2 / ADR-0165. Two kinds of test live here and they prove different
// things:
//
//   * the CONTRACT tests replay `scripts/display_signaling_probe.py`'s producer,
//     frame for frame, and assert what this client does with each one. The probe
//     proves the producer half over a real socket between two processes; this
//     proves the browser half of the same round trip, from the same script.
//   * the ABSENCE tests read the two source files. View-only here is not a
//     branch that can be asserted from outside — it is code that does not exist,
//     and the only way to hold that is to fail when it appears.
//
// Neither of them proves that a real WebRTC producer inside a CubeSandbox
// microVM behaves this way. Nothing in this repository can build or boot one
// (infra/cubesandbox/display-template/README.md), so every claim about the real
// producer stays `runtime-unverified(cubesandbox webrtc producer)`.
// =============================================================================

const DISPLAY_STREAM_SOURCE = readFileSync(
  fileURLToPath(new URL("./displayStream.ts", import.meta.url)),
  "utf8"
);
const DISPLAY_COMPONENT_SOURCE = readFileSync(
  fileURLToPath(new URL("./DisplayObserver.tsx", import.meta.url)),
  "utf8"
);
const TEMPLATE_SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../infra/cubesandbox/display-template/template.spec.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as {
  signalling: {
    subprotocol: string;
    messages: { producerToViewer: string[]; viewerToProducer: string[] };
  };
  producer: { direction: string; inputDatachannel: boolean; recording: boolean };
  ice: { turn: null | string; stun: string[] };
};

/** Comments in this repository quote counter-examples verbatim; strip them. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const DISPLAY_STREAM_CODE = codeOnly(DISPLAY_STREAM_SOURCE);
const DISPLAY_COMPONENT_CODE = codeOnly(DISPLAY_COMPONENT_SOURCE);

const OWNER = "019F9AB9-6D8F-7C55-9C3E-6A2B3F5D1A20";
const WATCHER = "019F9AB9-6D90-7A11-8D44-1C7E9B2F4D31";

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B77",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019FA1C4-3B29-7C42-8E10-77B3D5A9E204",
    memberId: OWNER,
    hostId: "019FA1C4-3B31-7E88-B0D2-2F41C6A73E55",
    rootMessageId: "019FA1C4-3B21-7D0E-9AA1-5E6C82F41B78",
    tool: "claude",
    label: "pgbackrest WAL 복구 리허설",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: true,
    startedAtMs: 1_785_180_004_120,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// the viewer sends no input, and it is an absence rather than a check
// -----------------------------------------------------------------------------

describe("the viewer sends no input", () => {
  // ADR-0165 D4's client half. Adding any of these is the one change that would
  // silently turn a view-only surface into a controllable one, and none of them
  // is something a reviewer would notice as "a new feature" in a diff that also
  // touched layout.
  it("has no encoder for the one viewer word that would carry input", () => {
    expect(DISPLAY_STREAM_CODE).not.toMatch(/open_input/);
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(/open_input/);
  });

  it("never opens a datachannel, on either side of the module boundary", () => {
    for (const source of [DISPLAY_STREAM_CODE, DISPLAY_COMPONENT_CODE]) {
      expect(source).not.toMatch(/createDataChannel|ondatachannel|RTCDataChannel/);
    }
  });

  it("sends no media of its own: no track, no transceiver, no capture", () => {
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(
      /addTrack|addTransceiver|getUserMedia|getDisplayMedia/
    );
  });

  // ADR-0165 D5. A frame that reaches a canvas is a frame that can be saved,
  // and the surface that must not keep one is also the surface where the API to
  // keep one is one line away.
  it("has no path that captures or records a frame", () => {
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(
      /MediaRecorder|captureStream|drawImage|toDataURL|toBlob|<canvas/
    );
  });

  // A video with `controls` hands the browser's own save/download affordance to
  // the reader, which is the D5 hole that does not look like one.
  it("draws the video without the browser's own control bar", () => {
    expect(DISPLAY_COMPONENT_CODE).toMatch(/<video/);
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(/\bcontrols\b(?!List)/);
  });

  // Every input event a browser can raise on a video element. Registering one
  // is how a "just for scrolling" handler becomes the seed of an input path.
  it("registers no keyboard, pointer or wheel handler on the frame", () => {
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(
      /onKeyDown|onKeyUp|onKeyPress|onMouseDown|onMouseUp|onMouseMove|onPointerDown|onPointerMove|onPointerUp|onWheel|onClick=\{[^}]*video/
    );
  });

  it("builds exactly three viewer frames, and none of them carries input", () => {
    expect(JSON.parse(answerFrame("v=0\r\n"))).toEqual({
      sdp: "v=0\r\n",
      type: "answer",
    });
    expect(
      JSON.parse(
        iceFrame({
          candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
        })
      )
    ).toEqual({
      candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
      sdp_mid: "0",
      sdp_mline_index: 0,
      type: "ice",
    });
    expect(JSON.parse(byeFrame())).toEqual({ type: "bye" });
  });

  // The template hands the viewer four words. This client implements three of
  // them; the fourth is the one whose absence IS the guarantee, so the count is
  // asserted against the spec rather than remembered.
  it("implements every viewer word the template declares except open_input", () => {
    const declared = TEMPLATE_SPEC.signalling.messages.viewerToProducer;
    expect(declared).toContain("open_input");
    for (const word of declared) {
      const present = new RegExp(`"${word}"`).test(DISPLAY_STREAM_CODE);
      expect(present, `viewer word ${word}`).toBe(word !== "open_input");
    }
  });
});

// -----------------------------------------------------------------------------
// the probe's producer, replayed frame for frame
// -----------------------------------------------------------------------------

/**
 * `producer_offer_sdp` from `scripts/display_signaling_probe.py`, verbatim.
 * Two facts about this string carry the whole D4 guarantee and both are
 * structural: an `m=video` line with `a=sendonly`, and NO `m=application`.
 */
const PROBE_OFFER = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=oort-display-display-probe",
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
].join("\r\n");

/** `prove_red`'s producer: view-only in its paperwork, controllable on the wire. */
const PROBE_RED_OFFER =
  PROBE_OFFER +
  [
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:1",
    "a=sctp-port:5000",
    "",
  ].join("\r\n");

describe("the signalling round trip the probe proves, from the browser side", () => {
  it("dials with the subprotocol the template declares, bearer second", () => {
    expect(DISPLAY_SUBPROTOCOL).toBe(TEMPLATE_SPEC.signalling.subprotocol);
    const token = `momo_terminal_attach_v1.${"b".repeat(43)}`;
    expect(displaySubprotocols(token)).toEqual([DISPLAY_SUBPROTOCOL, token]);
  });

  it("reads the producer's ready frame, and requires its three facts", () => {
    expect(
      classifyProducerFrame(
        JSON.stringify({
          type: "ready",
          display_id: "display-probe",
          mode: "observer",
          input_enabled: false,
        })
      )
    ).toEqual({
      kind: "ready",
      displayId: "display-probe",
      mode: "observer",
      inputEnabled: false,
    });
    // A ready without its grade is not a weaker ready, it is a frame from
    // something this client has no contract with. Defaulting the two fields
    // that matter would invent exactly the answers the frame exists to give.
    for (const partial of [
      { type: "ready", mode: "observer", input_enabled: false },
      { type: "ready", display_id: "d", input_enabled: false },
      { type: "ready", display_id: "d", mode: "observer" },
    ]) {
      expect(classifyProducerFrame(JSON.stringify(partial))).toEqual({
        kind: "unknown",
      });
    }
  });

  it("takes the probe's offer and refuses the red proof's", () => {
    expect(classifyProducerFrame(JSON.stringify({ type: "offer", sdp: PROBE_OFFER })))
      .toEqual({ kind: "offer", sdp: PROBE_OFFER });
    expect(sdpCarriesVideo(PROBE_OFFER)).toBe(true);
    expect(sdpNegotiatesInput(PROBE_OFFER)).toBe(false);

    // The client half of `--prove-red`. A producer that negotiates a datachannel
    // is caught HERE, before `setRemoteDescription`, so this client never holds
    // a channel object at all.
    expect(sdpNegotiatesInput(PROBE_RED_OFFER)).toBe(true);
    // And the surface refuses it rather than retrying into it: a retry would
    // dial the same producer and get the same offer.
    expect(displayOffersRetry("producer_input_channel", true)).toBe(false);
  });

  it("catches a datachannel however the producer spells it", () => {
    expect(sdpNegotiatesInput("v=0\nm=application 9 UDP/DTLS/SCTP 5000\n")).toBe(true);
    expect(
      sdpNegotiatesInput("v=0\r\na=sctpmap:5000 webrtc-datachannel 1024\r\n")
    ).toBe(true);
    // A screen with no video is not a screen, whatever else it negotiated.
    expect(sdpCarriesVideo("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")).toBe(false);
  });

  it("reads an ICE candidate and its optional coordinates", () => {
    expect(
      classifyProducerFrame(
        JSON.stringify({
          type: "ice",
          candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
          sdp_mid: "0",
          sdp_mline_index: 0,
        })
      )
    ).toEqual({
      kind: "ice",
      candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    // End of candidates, and a candidate whose coordinates the producer left out.
    expect(classifyProducerFrame(JSON.stringify({ type: "ice", candidate: "" })))
      .toEqual({ kind: "ice", candidate: "", sdpMid: null, sdpMLineIndex: null });
  });

  it("treats an error frame as the producer's refusal, by name", () => {
    expect(
      classifyProducerFrame(JSON.stringify({ type: "error", reason: "view_only" }))
    ).toEqual({ kind: "error", reason: "view_only" });
  });

  it("acts on nothing outside the producer vocabulary the template declares", () => {
    const declared = TEMPLATE_SPEC.signalling.messages.producerToViewer;
    expect(declared.sort()).toEqual(["error", "ice", "offer", "ready"]);
    for (const text of [
      JSON.stringify({ type: "input" }),
      JSON.stringify({ type: "answer", sdp: "v=0" }),
      JSON.stringify({ type: "bye" }),
      "not json at all",
      "null",
      "[]",
    ]) {
      expect(classifyProducerFrame(text)).toEqual({ kind: "unknown" });
    }
  });

  it("carries no TURN and no STUN, exactly as the template declares", () => {
    // ADR-0165 D3. An empty list is the decision, not a gap: a third-party relay
    // in the media path is what the whole topology exists to avoid, and an
    // oort-operated one is an ADR 증보 waiting on the reachability spike.
    expect(DISPLAY_ICE_SERVERS).toEqual([]);
    expect(TEMPLATE_SPEC.ice.turn).toBeNull();
    expect(TEMPLATE_SPEC.ice.stun).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// the grant
// -----------------------------------------------------------------------------

describe("the capability the server hands back", () => {
  it("dials only an endpoint the server's own grammar allows", () => {
    expect(attachSocketUrl("wss://vm-7.oor7.internal/display/signal/d-1")).toBe(
      "wss://vm-7.oor7.internal/display/signal/d-1"
    );
    // https is stored and dialled as wss (the server accepts both schemes).
    expect(attachSocketUrl("https://vm-7.oor7.internal/display/signal/d-1")).toBe(
      "wss://vm-7.oor7.internal/display/signal/d-1"
    );
    for (const rejected of [
      "ws://vm-7.oor7.internal/display/signal/d-1",
      "wss://user:pw@vm-7.oor7.internal/d",
      "wss://vm-7.oor7.internal/d?token=leak",
      "wss://vm-7.oor7.internal/d#frag",
      "not a url",
    ]) {
      expect(attachSocketUrl(rejected), rejected).toBeNull();
    }
  });

  it("holds the producer id to the one grammar migration 075 wrote", () => {
    expect(isValidDisplayId("display-probe")).toBe(true);
    expect(isValidDisplayId("d.0:1_x")).toBe(true);
    expect(isValidDisplayId("-leading-dash")).toBe(false);
    expect(isValidDisplayId("has space")).toBe(false);
    expect(isValidDisplayId("../../etc/passwd")).toBe(false);
    expect(isValidDisplayId("")).toBe(false);
    expect(isValidDisplayId(`a${"b".repeat(128)}`)).toBe(false);
  });

  it("names the grade it can render, and it is the server's word", () => {
    expect(DISPLAY_OBSERVER_MODE).toBe("observer");
  });

  // Each status is a different next step, which is the whole reason they are not
  // one sentence. 409 is the one that differs from the terminal path: the server
  // answers it for "this session has no screen to hand out", which is not the
  // same fact as "the session is gone".
  it("separates the server's refusals by what the reader can do about them", () => {
    expect(classifyDisplayGrantFailure(new NetworkError("timeout", 15_000))).toBe(
      "server_unreachable"
    );
    expect(
      classifyDisplayGrantFailure(
        new ApiError(403, "session observation is owner-only")
      )
    ).toBe("capability_denied");
    expect(
      classifyDisplayGrantFailure(new ApiError(409, "display attach is unavailable"))
    ).toBe("display_unavailable");
    expect(
      classifyDisplayGrantFailure(new ApiError(404, "work session not found"))
    ).toBe("session_unavailable");
    expect(
      classifyDisplayGrantFailure(new ApiError(401, "unauthorized"))
    ).toBe("capability_denied");
  });

  it("classifies a socket close by whether it ever opened", () => {
    expect(classifyClose({ opened: false, code: 1006, reason: "" })).toBe(
      "host_unreachable"
    );
    expect(classifyClose({ opened: true, code: 1000, reason: "" })).toBe(
      "stream_closed"
    );
    expect(classifyClose({ opened: true, code: 1006, reason: "" })).toBe(
      "stream_dropped"
    );
    expect(
      classifyClose({ opened: true, code: 1008, reason: "capability expired" })
    ).toBe("grant_expired");
    expect(
      classifyClose({ opened: true, code: 1008, reason: "host revoked" })
    ).toBe("host_revoked");
  });
});

// -----------------------------------------------------------------------------
// the four states, and the three refusals that must not be one refusal
// -----------------------------------------------------------------------------

describe("who is told they cannot watch, and why", () => {
  it("says a session with no published screen has no screen", () => {
    const gate = displayGate(session({ remoteDisplayAvailable: false }), false);
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain("호스트 화면을 열어 두지 않았습니다");
  });

  it("does not derive the screen from the terminal, in either direction", () => {
    // The server's own DTO says these are independent, and a client that folded
    // them would offer the wrong verb on whichever session had only one.
    expect(
      displayGate(
        session({ remoteAttachAvailable: true, remoteDisplayAvailable: false }),
        false
      ).available
    ).toBe(false);
    expect(
      displayGate(
        session({ remoteAttachAvailable: false, remoteDisplayAvailable: true }),
        false
      ).available
    ).toBe(true);
  });

  it("tells the OWNER of an owner-only session that they cannot watch either", () => {
    // The difference from the terminal that is real rather than cosmetic:
    // display has no controller grade, so `owner_only` closes the screen to
    // everybody including its owner. Reusing the terminal's sentence here would
    // be a half-truth, because there the owner can still watch.
    const gate = displayGate(session({ observation: "owner_only" }), true);
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain("소유자도 볼 수 없습니다");

    const teammate = displayGate(session({ observation: "owner_only" }), false);
    expect(teammate.available).toBe(false);
    expect(teammate.reason).toBe("세션 소유자가 관전을 닫아 두었습니다.");
  });

  it("reports the owner's own close to the owner, not about them", () => {
    // The 소유자만 보기 toggle is one block up on this same panel. Both of these
    // failures are what the owner sees one click after pressing it, so the
    // owner-blind table would narrate the reader's own decision back to them as
    // a third party's ("세션 소유자가 …") and give them nothing to do about it.
    for (const failure of ["observation_closed", "capability_denied"] as const) {
      const teammate = displayFailureCopy(failure, false);
      const owner = displayFailureCopy(failure, true);
      expect(teammate, failure).toBe(DISPLAY_FAILURE_COPY[failure]);
      expect(owner, failure).not.toBe(teammate);
      expect(owner, failure).not.toContain("세션 소유자가");
      // The fact only this surface has to carry: display has no controller
      // grade, so a closed session has no screen for its owner either
      // (display_attach.rs refuses `observation != open` for everyone). An
      // owner told only "관전을 닫았습니다" would expect the screen to still be
      // theirs to open.
      expect(owner, failure).toContain("소유자도 볼 수 없습니다");
      // §5: and then the way back, which is a control the owner actually has.
      expect(owner, failure).toContain("팀원 관전을 허용하면");
    }
  });

  it("says the same thing to both sides everywhere else", () => {
    const owned = new Set<DisplayFailure>(["observation_closed", "capability_denied"]);
    for (const failure of Object.keys(DISPLAY_FAILURE_COPY) as DisplayFailure[]) {
      if (owned.has(failure)) continue;
      expect(displayFailureCopy(failure, true), failure).toBe(
        DISPLAY_FAILURE_COPY[failure]
      );
      expect(displayFailureCopy(failure, false), failure).toBe(
        DISPLAY_FAILURE_COPY[failure]
      );
    }
  });

  it("keeps the banner's owner sentence in the gate's family, and in its own tense", () => {
    // Same family: the gate already had to answer "why can the owner not watch
    // their own screen", and two different explanations of one rule on one panel
    // is how a reader learns to trust neither.
    const gateReason = displayGate(session({ observation: "owner_only" }), true).reason;
    const banner = displayFailureCopy("observation_closed", true);
    for (const shared of ["소유자도 볼 수 없습니다", "팀원 관전을 허용하면"]) {
      expect(gateReason).toContain(shared);
      expect(banner).toContain(shared);
    }
    // Different tense, because they describe different moments: the gate is the
    // standing state of a session the reader arrived at, the banner is the
    // action they just took. Same split the terminal makes between `observeGate`
    // and `observerFailureCopy`.
    expect(banner).not.toBe(gateReason);
    expect(gateReason).toContain("닫아 두었습니다");
    expect(banner).toContain("닫았습니다");
  });

  it("holds the copy discipline on the owner's sentences too", () => {
    for (const failure of ["observation_closed", "capability_denied"] as const) {
      const owner = displayFailureCopy(failure, true);
      expect(owner, failure).not.toMatch(/[—–]/);
      expect(owner, failure).not.toMatch(/죄송|잠시 후 다시/);
      // ADR-0004 증보 3 D1: this grade takes nothing over.
      expect(owner, failure).not.toMatch(/인수/);
    }
  });

  it("reads the banner through the owner-aware function, never the raw table", () => {
    // The finding this pins: the component indexed `DISPLAY_FAILURE_COPY`
    // directly, which is owner-blind by construction. An absence test, because
    // the regression is a one-character edit back to a subscript.
    expect(DISPLAY_COMPONENT_CODE).toMatch(/displayFailureCopy\(/);
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(/DISPLAY_FAILURE_COPY\s*\[/);
  });

  it("keeps the three unavailable reasons apart", () => {
    const reasons = new Set([
      displayGate(session({ remoteDisplayAvailable: false }), false).reason,
      displayGate(session({ observation: "owner_only" }), false).reason,
      DISPLAY_FAILURE_COPY.display_unavailable,
      DISPLAY_FAILURE_COPY.capability_denied,
    ]);
    expect(reasons.size).toBe(4);
  });

  it("names an orphaned session as orphaned, never as closed", () => {
    // orphaned is not a final state one pane over (the lineage there offers
    // 새 호스트에서 재개), so calling it closed here would demote a resumable
    // session in the same breath as the block above calls it resumable.
    expect(displayGate(session({ status: "orphaned" }), true).reason).toContain(
      "호스트 연결이 끊겨"
    );
    expect(displayGate(session({ status: "ended" }), true).reason).toContain(
      "닫힌 세션"
    );
  });

  it("offers no retry on a gate that is shut, whatever the failure was", () => {
    expect(displayOffersRetry("stream_dropped", true)).toBe(true);
    expect(displayOffersRetry("stream_dropped", false)).toBe(false);
    // A policy the page carries cannot be re-asked on this document, so the
    // action offered is the one that can change the answer.
    expect(displayOffersRetry("host_blocked_by_policy", true)).toBe(false);
    expect(displayOffersReload("host_blocked_by_policy")).toBe(true);
    expect(displayOffersReload("stream_dropped")).toBe(false);
    // Nothing a reader can do brings back a browser that has no WebRTC.
    expect(displayOffersRetry("webrtc_unsupported", true)).toBe(false);
  });

  it("has a sentence for every failure it can reach, and no em-dash in any", () => {
    const failures: DisplayFailure[] = [
      "capability_denied",
      "session_unavailable",
      "display_unavailable",
      "grant_invalid",
      "server_unreachable",
      "host_unreachable",
      "host_blocked_by_policy",
      "host_timeout",
      "grant_expired",
      "host_revoked",
      "stream_dropped",
      "stream_closed",
      "observation_closed",
      "session_ended",
      "producer_input_channel",
      "producer_refused",
      "producer_silent",
      "signal_invalid",
      "media_failed",
      "webrtc_unsupported",
    ];
    for (const failure of failures) {
      const copy = DISPLAY_FAILURE_COPY[failure];
      expect(copy, failure).toBeTruthy();
      expect(copy, failure).not.toMatch(/[—–]/);
      // §7: errors say what happened and the next step. They do not apologise
      // and they do not tell the reader to try again later and hope.
      expect(copy, failure).not.toMatch(/죄송|잠시 후 다시/);
    }
    expect(Object.keys(DISPLAY_FAILURE_COPY).sort()).toEqual([...failures].sort());
  });

  // ADR-0004 증보 3 D1: control is not 인수, and a UI that uses the word teaches
  // a vocabulary the product does not have.
  it("never says 인수 anywhere on this surface", () => {
    expect(DISPLAY_STREAM_CODE).not.toMatch(/인수/);
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(/인수/);
  });
});

// -----------------------------------------------------------------------------
// liveness: what the surface is allowed to claim
// -----------------------------------------------------------------------------

describe("보는 중 is bound to frames this browser decoded", () => {
  it("reads the decoded frame count off the peer connection's stats", () => {
    const report = new Map<string, unknown>([
      ["T01", { type: "transport", bytesReceived: 9_999 }],
      [
        "IT01",
        { type: "inbound-rtp", kind: "video", framesDecoded: 412, bytesReceived: 1_204_884 },
      ],
      ["OB01", { type: "outbound-rtp", kind: "video", framesSent: 7 }],
    ]);
    expect(readInboundVideoStats(report)).toEqual({
      frames: 412,
      bytes: 1_204_884,
    });
  });

  it("sums several inbound tracks and reports nothing when there are none", () => {
    expect(
      readInboundVideoStats(
        new Map<string, unknown>([
          ["a", { type: "inbound-rtp", mediaType: "video", framesDecoded: 10, bytesReceived: 100 }],
          ["b", { type: "inbound-rtp", kind: "video", framesDecoded: 5, bytesReceived: 50 }],
          ["c", { type: "inbound-rtp", kind: "audio", framesDecoded: 900 }],
        ])
      )
    ).toEqual({ frames: 15, bytes: 150 });
    expect(readInboundVideoStats(new Map())).toBeNull();
    expect(
      readInboundVideoStats(new Map([["x", { type: "candidate-pair" }]]))
    ).toBeNull();
  });

  it("stops claiming 보는 중 the moment the browser says it has no network", () => {
    // The link model itself is the terminal's, imported rather than restated:
    // "may this surface still claim to be live" has one answer for both.
    expect(
      observerLink({ watching: true, online: true, quietMs: 0, doubted: false })
    ).toBe("live");
    expect(
      observerLink({ watching: true, online: false, quietMs: 0, doubted: false })
    ).toBe("offline");
    expect(
      observerLink({ watching: true, online: true, quietMs: 0, doubted: true })
    ).toBe("unverified");
    expect(
      observerLink({ watching: true, online: true, quietMs: 11_000, doubted: false })
    ).toBe("quiet");
    expect(
      observerLink({ watching: false, online: true, quietMs: 0, doubted: false })
    ).toBeNull();
  });

  it("says 보는 중 while quiet, and names the gap beside it", () => {
    // A still desktop is not a dead connection, so silence is reported as
    // itself and the reader judges.
    expect(DISPLAY_LINK_STATUS.quiet).toBe(DISPLAY_LINK_STATUS.live);
    expect(displayQuietLabel(9_000, true)).toBeNull();
    expect(displayQuietLabel(34_000, true)).toBe("마지막 화면 34초 전");
    expect(displayQuietLabel(34_000, false)).toBe("34초째 화면 없음");
    expect(displayQuietLabel(120_000, true)).toBe("마지막 화면 2분 전");
  });

  it("drops a stream the ledger no longer permits", () => {
    // The server revokes the capability, but the peer connection is between this
    // browser and the VM and nothing on the momo side can reach in and close it.
    expect(observationStillPermits(session())).toBeNull();
    expect(observationStillPermits(session({ observation: "owner_only" }))).toBe(
      "observation_closed"
    );
    expect(observationStillPermits(session({ status: "ended" }))).toBe(
      "session_ended"
    );
  });

  // The busy state that had no end was the measured failure one protocol over,
  // and the leg after the WebSocket handshake is where it would come back: a
  // producer that accepts the socket and never offers raises no event anywhere.
  it("bounds the leg the handshake deadline does not cover", () => {
    expect(DISPLAY_NEGOTIATE_TIMEOUT_MS).toBeGreaterThan(0);
    // Two different silences, two different sentences: the producer never
    // offered, or it offered and no pixel ever arrived.
    expect(DISPLAY_FAILURE_COPY.producer_silent).not.toBe(
      DISPLAY_FAILURE_COPY.media_failed
    );
    expect(displayOffersRetry("producer_silent", true)).toBe(true);
    expect(DISPLAY_COMPONENT_CODE).toMatch(/DISPLAY_NEGOTIATE_TIMEOUT_MS/);
    expect(DISPLAY_COMPONENT_CODE).toMatch(/producer_silent/);
  });

  it("re-asks the ledger on the capability's own clock", () => {
    // 60 seconds is the capability lifetime, and the re-verification is a LEDGER
    // read rather than a second capability: minting one on a timer would publish
    // a realtime frame per viewer per minute, which is the trade the terminal's
    // observer-count docstring already documents refusing.
    expect(DISPLAY_REVERIFY_MS).toBe(60_000);
    expect(DISPLAY_COMPONENT_CODE).toMatch(/invalidateQueries/);
    expect(DISPLAY_COMPONENT_CODE.match(/issueDisplayAttach\(/g)).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// the surface's own four states
// -----------------------------------------------------------------------------

describe("the four states this surface must ship", () => {
  it("draws a busy line, a live frame, a named failure and a blocked reason", () => {
    for (const testId of [
      "work-display-busy", // 연결 중
      "work-display-video", // 라이브
      "work-display-error", // 끊김·재시도
      "work-display-blocked", // 불가
    ]) {
      expect(DISPLAY_COMPONENT_CODE, testId).toContain(testId);
    }
  });

  it("never leaves a failure without a way forward while the gate is open", () => {
    // A failure is not a terminus: while the ledger still permits watching there
    // is always a control that starts it again, including the one failure that
    // needs a new document rather than a new socket.
    const stuck: DisplayFailure[] = [
      "producer_input_channel",
      "observation_closed",
      "session_ended",
      "webrtc_unsupported",
    ];
    const failures = Object.keys(DISPLAY_FAILURE_COPY) as DisplayFailure[];
    for (const failure of failures) {
      const forward =
        displayOffersRetry(failure, true) || displayOffersReload(failure);
      expect(forward, failure).toBe(!stuck.includes(failure));
    }
  });

  it("keeps its viewer id out of the session ledger's own vocabulary", () => {
    // The observer count the server publishes is kind-blind: one number covering
    // terminal and screen grants alike. A second badge here would put the same
    // number on screen twice and read as two different counts.
    expect(DISPLAY_COMPONENT_CODE).not.toMatch(/observerGrantCount/);
  });
});

// -----------------------------------------------------------------------------
// the template contract, cross-read
// -----------------------------------------------------------------------------

describe("the template this client dials", () => {
  it("declares a send-only producer with no input channel and no recording", () => {
    expect(TEMPLATE_SPEC.producer.direction).toBe("sendonly");
    expect(TEMPLATE_SPEC.producer.inputDatachannel).toBe(false);
    expect(TEMPLATE_SPEC.producer.recording).toBe(false);
  });

  it("agrees with this client about the subprotocol, or this test fails", () => {
    // `scripts/verify_display_attach.sh` phase 3 cross-reads the same pair from
    // the other side. Drift on either side fails a gate rather than a person
    // looking at a black rectangle.
    expect(DISPLAY_SUBPROTOCOL).toBe(TEMPLATE_SPEC.signalling.subprotocol);
  });
});

// -----------------------------------------------------------------------------
// nothing here is measured against a real sandbox
// -----------------------------------------------------------------------------

describe("what this file does not prove", () => {
  it("keeps the unverified label in the spec it reads", () => {
    const spec = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../../infra/cubesandbox/display-template/template.spec.json",
            import.meta.url
          )
        ),
        "utf8"
      )
    ) as { unverified: Record<string, string> };
    // An honest label that can be deleted silently is not one. This client's
    // claims inherit it: no CubeSandbox template has been built or booted, so
    // every statement here is contract-level.
    expect(spec.unverified.iceReachability).toBeTruthy();
    expect(spec.unverified.producerSelection).toBeTruthy();
  });

  it("mints and dials nothing at test time", () => {
    // The one thing this suite is not allowed to become is a probe that talks to
    // something. Every assertion above is over a pure function or a source file.
    expect(WATCHER).not.toBe(OWNER);
  });
});
