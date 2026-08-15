import { ApiError, type WorkSession } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  HOST_CONNECT_TIMEOUT_MS,
  isValidPtyId,
  quietSpan,
  type ObserverFailure,
} from "./observerStream";

// =============================================================================
// 라이브 화면 보기 (LIVE-2 / ADR-0165): the sandbox's screen, live, in a video
// element that cannot click back.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD: a viewer sends no input.
//
// `observerStream.ts` holds the same sentence one protocol over and holds it
// the same way — by absence. There, the absence is an encoder for `send_stdin`.
// Here it is bigger and easier to check: there are exactly three frames this
// module can build (`answerFrame`, `iceFrame`, `byeFrame`), none of them
// carries input, and there is no `open_input` encoder even though the producer
// knows that word (template.spec.json's viewer vocabulary lists it precisely so
// a producer can refuse it by name). WebRTC's own input path is a datachannel,
// and this module never names `createDataChannel` either — see
// `displayStream.test.ts`, which reads this file and the component beside it.
//
// The stronger half of the guarantee is not here at all, which is the point of
// ADR-0165 D4: the PRODUCER does not put an `m=application` section in its
// offer, so there is no datachannel for a patched client to open. This module's
// job is to notice when that stops being true — `sdpNegotiatesInput` is the
// browser-side twin of the probe's `sdp_has_input_channel`, and an offer that
// negotiates one is refused rather than rendered. A producer that is view-only
// in its paperwork and controllable on the wire is exactly what the probe's
// red proof exists to catch; this is the same catch, on the machine of the
// person who would be looking at the screen.
//
// TOPOLOGY. momo carries neither the signalling nor the media (D2/D3): the
// capability call is the only thing this client asks a momo server for, and
// everything after it is between this browser and the VM.
//
// WHAT IS SHARED WITH THE TERMINAL, AND WHY. The endpoint check, the CSP
// classifier, the handshake deadline, the close classifier, the link model and
// the id grammar are IMPORTED from `observerStream.ts` and not restated: they
// are facts about dialling a host from a browser, and the second copy is what
// would drift. What is not shared is the copy, because the noun is different —
// "출력이 끊겼습니다" is not a sentence about a screen.
// =============================================================================

/**
 * WebSocket subprotocol carrying the capability bearer, the display twin of
 * `OBSERVER_SUBPROTOCOL`.
 *
 * A browser cannot set an Authorization header on a WebSocket upgrade, and the
 * query parameter is worse in a specific way (it lands in proxy and host access
 * logs as part of the request line, and the server refuses to store any endpoint
 * that carries a query at all), so the bearer rides the subprotocol list here
 * exactly as it does for terminals.
 *
 * `infra/cubesandbox/display-template/template.spec.json` declares this string
 * as the template contract and `scripts/verify_display_attach.sh` cross-reads
 * the two, so this constant and the producer's cannot drift apart silently.
 */
export const DISPLAY_SUBPROTOCOL = "momo.display.v1";

export function displaySubprotocols(capabilityToken: string): string[] {
  return [DISPLAY_SUBPROTOCOL, capabilityToken];
}

/**
 * The producer's own id grammar. One regex for both kinds — see `isValidPtyId`,
 * whose docstring says why this is a re-export and not a second copy.
 */
export const isValidDisplayId = isValidPtyId;

/**
 * The grade this client can honestly render.
 *
 * A grant that says anything else is refused rather than displayed: the whole
 * reason `mode` is on the wire is so a UI can state what it is before a socket
 * is dialled, and a client that ignores the word would draw a controllable
 * stream and a view-only one identically.
 */
export const DISPLAY_OBSERVER_MODE = "observer";

/**
 * How long the capability the server just minted stays valid, and therefore how
 * often this client re-asks the ledger whether the stream it is holding is
 * still allowed to exist.
 *
 * WHAT THIS IS NOT: a re-issue loop. Minting a fresh capability on a timer would
 * publish a realtime frame per viewer per minute (the display issue path emits
 * the same kind-blind observer envelope the PTY one does), which is the exact
 * trade `observerStream.observerCountLabel` documents refusing. The capability
 * this client holds does not need renewing either: the producer re-validates the
 * SAME token against the server with `stream: true` for the life of the peer
 * connection (template.spec.json `signalling.revalidateSeconds`), which is what
 * makes host revocation and 소유자만 보기 cut a stream that is already open.
 *
 * What this period does drive is the client's own half of that: the ledger read
 * whose answer `displayStillPermits` acts on. React Query pauses its interval
 * while the tab is hidden, and a hidden tab is precisely where a WebRTC stream
 * keeps running with nobody re-checking it, so the component re-asks on this
 * clock while it holds a stream.
 */
export const DISPLAY_REVERIFY_MS = 60_000;

/**
 * Deadline from the signalling socket opening to the first decoded frame.
 *
 * `HOST_CONNECT_TIMEOUT_MS` bounds the WebSocket handshake and stops there, and
 * the leg after it is longer and quieter: the producer has to offer, this
 * browser has to answer, and ICE has to find a path. Any of those can simply
 * not happen, with no event on any object this component holds — a producer
 * that accepts the socket and never offers, or an offer answered into a network
 * that drops every media packet. A busy state with no end is the same lie as a
 * false live state, which is the failure `HOST_CONNECT_TIMEOUT_MS` was measured
 * against one protocol over, so this leg gets a deadline of its own.
 *
 * It is a BACKSTOP, not the primary signal. The primary signal is the browser's
 * own verdict: `RTCPeerConnection.connectionState === "failed"` arrives when ICE
 * gives up and is acted on immediately, and it is more accurate than any clock
 * here because it knows what it tried.
 *
 * 30 seconds is not a measured number, and this is the honest place to say so:
 * `template.spec.json` lists `iceReachability` as unverified, so nobody yet
 * knows what a real browser-to-microVM negotiation costs. What IS known is the
 * shape of the choice — too short reports a failure the browser was still
 * working on, too long leaves a person watching a spinner — and that leaving it
 * unbounded is not one of the options. The spike (#1411) is what replaces the
 * guess with a measurement.
 */
export const DISPLAY_NEGOTIATE_TIMEOUT_MS = 30_000;

// ---- what the producer says -------------------------------------------------

/**
 * A frame from the producer, classified.
 *
 * The vocabulary is `template.spec.json`'s `signalling.messages.producerToViewer`
 * and nothing else. Anything outside it is `unknown` and dropped rather than
 * guessed at: this socket negotiates one media session, and a frame this client
 * does not understand is not an instruction it may act on.
 */
export type ProducerFrame =
  /** The producer accepted the capability and says what grade it serves. */
  | {
      kind: "ready";
      displayId: string;
      mode: string;
      /** The producer's own statement of ADR-0165 D4. Must be false. */
      inputEnabled: boolean;
    }
  /** The SDP offer. `sdp` is passed to the peer connection verbatim. */
  | { kind: "offer"; sdp: string }
  /** One ICE candidate. Empty `candidate` is end-of-candidates. */
  | { kind: "ice"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /** The producer refused something, by name. */
  | { kind: "error"; reason: string }
  /** Not a frame this client acts on. */
  | { kind: "unknown" };

export function classifyProducerFrame(text: string): ProducerFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "unknown" };
  const frame = parsed as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      // Every field is required. A `ready` missing its grade is not a weaker
      // `ready`, it is a frame from something this client has not agreed a
      // contract with, and treating it as observer/false would invent the two
      // answers that matter most.
      if (
        typeof frame.display_id !== "string" ||
        typeof frame.mode !== "string" ||
        typeof frame.input_enabled !== "boolean"
      ) {
        return { kind: "unknown" };
      }
      return {
        kind: "ready",
        displayId: frame.display_id,
        mode: frame.mode,
        inputEnabled: frame.input_enabled,
      };
    case "offer":
      if (typeof frame.sdp !== "string" || frame.sdp === "") {
        return { kind: "unknown" };
      }
      return { kind: "offer", sdp: frame.sdp };
    case "ice":
      if (typeof frame.candidate !== "string") return { kind: "unknown" };
      return {
        kind: "ice",
        candidate: frame.candidate,
        sdpMid: typeof frame.sdp_mid === "string" ? frame.sdp_mid : null,
        sdpMLineIndex:
          typeof frame.sdp_mline_index === "number" &&
          Number.isInteger(frame.sdp_mline_index)
            ? frame.sdp_mline_index
            : null,
      };
    case "error":
      return {
        kind: "error",
        reason: typeof frame.reason === "string" ? frame.reason : "",
      };
    default:
      return { kind: "unknown" };
  }
}

/**
 * Whether an SDP negotiates a datachannel — i.e. a way in.
 *
 * The browser-side twin of `scripts/display_signaling_probe.py`'s
 * `sdp_has_input_channel`, character for character in what it looks for, and
 * here for the reason that probe has a red proof: ADR-0165 D4 puts the view-only
 * guarantee in the producer, and a client that renders whatever it is offered
 * cannot tell anyone when the producer stops holding it. An offer with an
 * `m=application` section is refused before `setRemoteDescription`, so this
 * client never even has a channel object to leave unused.
 */
export function sdpNegotiatesInput(sdp: string): boolean {
  return sdp
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith("m=application") || line.includes("webrtc-datachannel")
    );
}

/** A display offer that carries no video carries no screen. */
export function sdpCarriesVideo(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((line) => line.startsWith("m=video"));
}

// ---- the three frames a viewer may send -------------------------------------
//
// THE WHOLE LIST. `template.spec.json` gives the viewer four words and this
// module implements three of them; the fourth is `open_input`, and its absence
// here is the client half of ADR-0165 D4. There is no flag that turns it on,
// because there is no encoder to turn on. If control is ever granted
// (ADR-0004 증보 3), it belongs in a different module with its own review.

/** The answer to the producer's offer. Built by the peer connection, not here. */
export function answerFrame(sdp: string): string {
  return JSON.stringify({ sdp, type: "answer" });
}

/** One of this browser's own ICE candidates. */
export function iceFrame(candidate: {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}): string {
  return JSON.stringify({
    candidate: candidate.candidate,
    sdp_mid: candidate.sdpMid,
    sdp_mline_index: candidate.sdpMLineIndex,
    type: "ice",
  });
}

/** Leaving on purpose, so the producer can drop the peer connection at once. */
export function byeFrame(): string {
  return JSON.stringify({ type: "bye" });
}

// ---- ICE ---------------------------------------------------------------------

/**
 * The ICE configuration, which is empty, and that is a decision rather than a
 * gap (ADR-0165 D3 · template.spec.json `ice`).
 *
 * No TURN: a third-party relay would put someone else's server in the media
 * path, which breaks the egress boundary the whole topology exists to hold, and
 * an oort-operated one is an ADR 증보 waiting on the reachability measurement
 * (spike #1411), not something a client may configure. No STUN either: the
 * template declares `stun: []` for the same reason, since naming a public STUN
 * server here would introduce a third-party dependency by default.
 *
 * So this build negotiates on host candidates. Whether that is enough is the
 * open question of this wave, and when it is not, the failure is honest and
 * named (`media_failed`) rather than papered over with somebody else's server.
 */
export const DISPLAY_ICE_SERVERS: RTCIceServer[] = [];

// ---- failures ----------------------------------------------------------------

/**
 * Every way watching a screen can fail.
 *
 * The shared members are `ObserverFailure`'s, imported rather than re-listed:
 * a refused capability, a blocked connect-src and an unroutable host are the
 * same events on both surfaces, classified by the same functions
 * (`classifyClose`, `cspBlockedHost`). What is added here is what only a media
 * session can do.
 */
export type DisplayFailure =
  | ObserverFailure
  /** The server has no screen to hand out for this session (409). */
  | "display_unavailable"
  /** The producer's offer negotiated a datachannel — ADR-0165 D4 is broken. */
  | "producer_input_channel"
  /** The producer refused, by name, in an `error` frame. */
  | "producer_refused"
  /** The socket opened and the producer never offered a screen. */
  | "producer_silent"
  /** The producer spoke something this client cannot act on. */
  | "signal_invalid"
  /** Signalling completed and the media path never came up, or fell over. */
  | "media_failed"
  /** This runtime has no WebRTC at all. */
  | "webrtc_unsupported";

/**
 * What happened, then what to do next. No apology, no filler, and no sentence
 * that blames the reader (design-taste-web §5).
 *
 * These are the terminal table's sentences with the noun changed, and the noun
 * is the reason they are a second table rather than a shared one: "출력이
 * 끊겼습니다" under a black rectangle describes the wrong thing, and a reader
 * who cannot see a screen is not helped by being told about output. The
 * vocabulary is ADR-0004 증보 3 D1's: 라이브 화면 and 보기, never 인수.
 *
 * These are the sentences for the reader a failure HAPPENS TO. Two of them are
 * third person about a decision the reader may have made themselves; read
 * through `displayFailureCopy` rather than indexed directly, so the owner gets
 * their own version.
 */
export const DISPLAY_FAILURE_COPY: Readonly<Record<DisplayFailure, string>> = {
  capability_denied:
    "이 세션의 라이브 화면을 볼 권한이 없습니다. 세션 소유자가 관전을 닫았거나 이 채널의 멤버가 아닙니다.",
  session_unavailable:
    "지금은 라이브 화면을 볼 수 없습니다. 세션이 끝났거나 호스트 연결이 해제됐습니다.",
  display_unavailable:
    "이 세션에는 지금 볼 수 있는 화면이 없습니다. 화면을 띄운 호스트에서 실행 중인 세션만 볼 수 있습니다.",
  grant_invalid:
    "화면 주소를 확인하지 못했습니다. 세션을 시작한 호스트의 등록 정보를 확인하세요.",
  server_unreachable:
    "서버에 화면 보기 권한을 요청하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
  host_unreachable:
    "호스트에 닿지 못했습니다. 화면은 서버를 거치지 않고 호스트에서 직접 오므로, 이 브라우저가 호스트 주소에 닿을 수 있어야 합니다.",
  host_blocked_by_policy:
    "이 페이지의 보안 정책이 호스트 주소로의 연결을 막았습니다. 데스크톱 앱에서는 그대로 볼 수 있고, 브라우저에서 열려면 이 웹을 서빙하는 서버가 호스트 주소를 허용해야 합니다.",
  host_timeout: `호스트가 ${Math.round(
    HOST_CONNECT_TIMEOUT_MS / 1000
  )}초 안에 응답하지 않았습니다. 호스트 주소와 네트워크를 확인한 뒤 다시 연결하세요.`,
  grant_expired: "연결 권한이 만료됐습니다. 다시 연결하세요.",
  host_revoked:
    "세션이 종료됐거나 호스트 연결이 해제됐습니다. 상태를 확인한 뒤 다시 연결하세요.",
  stream_dropped: "화면 연결이 끊겼습니다. 다시 연결하세요.",
  stream_closed: "호스트가 화면 연결을 닫았습니다.",
  observation_closed: "세션 소유자가 관전을 닫았습니다.",
  session_ended: "세션이 끝나 화면이 닫혔습니다.",
  // Not "호스트 오류". This one is a statement about a broken guarantee, and the
  // reader is entitled to know which guarantee: a producer that offers an input
  // channel is a producer this client will not draw, however well the pixels
  // would have arrived.
  producer_input_channel:
    "호스트가 입력 채널이 있는 화면을 보내려 해서 연결하지 않았습니다. 라이브 화면은 보기 전용이어야 하므로, 이 호스트의 화면 설정을 확인하세요.",
  producer_refused:
    "호스트가 화면 연결을 거절했습니다. 세션 상태를 확인한 뒤 다시 연결하세요.",
  producer_silent:
    "호스트가 연결은 받았지만 화면을 보내오지 않았습니다. 호스트에서 화면 구성 요소가 실행 중인지 확인한 뒤 다시 연결하세요.",
  signal_invalid:
    "호스트가 이 클라이언트가 이해할 수 없는 응답을 보냈습니다. 호스트의 화면 구성 요소 버전을 확인하세요.",
  media_failed:
    "권한과 신호는 오갔지만 화면 데이터가 흐르지 못했습니다. 이 브라우저와 호스트 사이의 방화벽이 미디어 포트를 막았을 수 있습니다.",
  webrtc_unsupported:
    "이 브라우저에서는 라이브 화면을 열 수 없습니다. WebRTC를 지원하는 브라우저나 데스크톱 앱에서 열어 보세요.",
};

/**
 * The owner's own view of a failure they caused, the display twin of
 * `observerFailureCopy`.
 *
 * WHY A SECOND TABLE AND NOT A CONDITION IN THE FIRST. `DISPLAY_FAILURE_COPY`
 * is written for the reader a failure happens TO, and for two of its entries
 * that reader is not always a third party. Both sentences below are third
 * person about an action the owner just took one block up, on the same panel:
 * the 소유자만 보기 toggle lives in 터미널 관전, and the owner who presses it
 * gets this surface reporting their own click back to them as somebody else's
 * decision, with no next step (design-taste-web §5).
 *
 *   - `observation_closed` fires on the ledger re-read while a stream is held.
 *   - `capability_denied` is the same fact one round trip earlier: the owner
 *     closed observation and clicked 화면 보기 before the ledger caught up, and
 *     the server answered 403 `session observation is owner-only`.
 *
 * WHAT THE OWNER'S SENTENCES SAY THAT THE TERMINAL'S DO NOT. `displayGate`'s
 * owner branch already had to answer the question this surface raises and the
 * terminal's does not: display has no controller grade, so an `owner_only`
 * session has no screen for its OWNER either (display_attach.rs: refusing is
 * the fail-closed direction, an owner exemption is a permission decision nobody
 * has made). So these reuse that gate sentence's family rather than the
 * terminal's — an owner told only "관전을 닫았습니다" would reasonably expect the
 * screen to still be theirs to open, which is the half-truth the gate's own
 * docstring refuses.
 *
 * The gate carries the standing state (닫아 두었습니다) and this carries the
 * action just taken (닫았습니다), which is the same split the terminal makes
 * between `observeGate` and `observerFailureCopy`. The banner needs its own
 * because a banner is what the reader is looking at: the component drops the
 * gate line while one of these failures is on screen, so if the owner sentence
 * lived only in the gate it would be suppressed at exactly the moment it is
 * true.
 */
const DISPLAY_OWNER_FAILURE_COPY: Readonly<
  Partial<Record<DisplayFailure, string>>
> = {
  observation_closed:
    "관전을 소유자만 보기로 닫았습니다. 라이브 화면은 보기 전용 권한만 있어서, 닫혀 있는 동안은 소유자도 볼 수 없습니다. 팀원 관전을 허용하면 이 자리에서 다시 열립니다.",
  capability_denied:
    "이 세션의 라이브 화면을 볼 권한이 없습니다. 라이브 화면은 보기 전용 권한만 있어서, 관전을 소유자만 보기로 닫아 두면 소유자도 볼 수 없습니다. 팀원 관전을 허용하면 이 자리에서 열립니다.",
};

export function displayFailureCopy(
  failure: DisplayFailure,
  isOwner: boolean
): string {
  if (!isOwner) return DISPLAY_FAILURE_COPY[failure];
  return DISPLAY_OWNER_FAILURE_COPY[failure] ?? DISPLAY_FAILURE_COPY[failure];
}

/**
 * Failures a retry can plausibly fix.
 *
 * `producer_input_channel` is deliberately NOT here, and it is the one entry
 * worth arguing about. A retry would dial the same producer and get the same
 * offer, and offering the button would suggest the reader can click their way
 * past a broken guarantee. The way out is a host that stops doing it.
 *
 * `signal_invalid` and `media_failed` are here: the first can be a producer
 * mid-restart, and the second is exactly the case where a second ICE
 * negotiation sometimes succeeds where the first did not.
 */
const RETRYABLE: ReadonlySet<DisplayFailure> = new Set<DisplayFailure>([
  "server_unreachable",
  "host_unreachable",
  "host_timeout",
  "grant_expired",
  "grant_invalid",
  "stream_dropped",
  "stream_closed",
  "capability_denied",
  "session_unavailable",
  "display_unavailable",
  "host_revoked",
  "producer_refused",
  "producer_silent",
  "signal_invalid",
  "media_failed",
]);

/**
 * Whether the failed state offers 다시 연결, which is two questions and not one:
 * can this failure change, and does the ledger still permit watching at all.
 * A retry on a session the ledger has already ended is a button whose only
 * outcome is the same error one round trip later.
 */
export function displayOffersRetry(
  failure: DisplayFailure,
  gateAvailable: boolean
): boolean {
  return gateAvailable && RETRYABLE.has(failure);
}

/**
 * The one failure whose way out is a new DOCUMENT rather than a new socket: a
 * Content-Security-Policy is delivered with the page and fixed for its
 * lifetime, so an operator who adds the host to `connect-src` changes nothing
 * for a tab that is already open.
 */
export function displayOffersReload(failure: DisplayFailure): boolean {
  return failure === "host_blocked_by_policy";
}

/**
 * Why the capability call failed. The status codes are the server's own
 * contract, and 409 is the one that differs from the terminal path: the display
 * route answers 409 for "this session has no screen to hand out" — a live
 * session whose host never advertised a display, or whose host was revoked —
 * which is a different sentence from "the session is gone" (404).
 */
export function classifyDisplayGrantFailure(error: unknown): DisplayFailure {
  if (error instanceof NetworkError) return "server_unreachable";
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 401) return "capability_denied";
    if (error.status === 409) return "display_unavailable";
    if (error.status === 404) return "session_unavailable";
  }
  return "server_unreachable";
}

// ---- who may watch ----------------------------------------------------------

export interface DisplayGate {
  available: boolean;
  /** Why not, in words. Null when watching is available. */
  reason: string | null;
}

/**
 * Whether this session offers a screen to watch AT ALL, before any permission
 * question the server will answer for itself.
 *
 * Not an access check and it must not read as one: the server decides, and its
 * refusals come back as failures with their own sentences. This only keeps the
 * surface from offering a control that cannot work, and states the reason
 * instead — the same rule the terminal block one section up follows.
 *
 * The `owner_only` branch is where this differs from the terminal, and the
 * difference is real rather than cosmetic. Display has no controller grade, so
 * an `owner_only` session has no display access **for anybody, including its
 * owner**: the server's own comment says refusing is the fail-closed direction
 * and that an owner exemption is a permission decision nobody has made
 * (ADR-0004 증보 3 · LIVE-3). Telling the owner "관전을 닫아 두었습니다" the way
 * the terminal does would be a half-truth here, because on the terminal they
 * can still watch and here they cannot.
 */
export function displayGate(
  session: Pick<
    WorkSession,
    "status" | "observation" | "remoteDisplayAvailable"
  >,
  isOwner: boolean
): DisplayGate {
  if (session.status !== "running" && session.status !== "idle") {
    return {
      available: false,
      reason:
        session.status === "orphaned"
          ? "호스트 연결이 끊겨 화면을 볼 수 없습니다."
          : "닫힌 세션은 화면을 볼 수 없습니다.",
    };
  }
  if (!session.remoteDisplayAvailable) {
    return {
      available: false,
      reason:
        "이 세션은 호스트 화면을 열어 두지 않았습니다. 화면을 띄운 호스트에서 실행한 세션만 볼 수 있습니다.",
    };
  }
  if (session.observation === "owner_only") {
    return {
      available: false,
      reason: isOwner
        ? "관전을 소유자만 보기로 닫아 두었습니다. 라이브 화면은 보기 전용 권한만 있어서, 닫혀 있는 동안은 소유자도 볼 수 없습니다. 팀원 관전을 허용하면 이 자리에서 열립니다."
        : "세션 소유자가 관전을 닫아 두었습니다.",
    };
  }
  return { available: true, reason: null };
}

// ---- what arrived -----------------------------------------------------------

/** Frames and bytes decoded from the producer's video track, as counted so far. */
export interface DisplayInboundStats {
  frames: number;
  bytes: number;
}

/**
 * The honest liveness signal for a screen, read off the peer connection.
 *
 * The terminal counts BYTES because bytes are what a pty delivers, and the same
 * rule applies one protocol over: `framesDecoded` moves exactly as fast as the
 * screen updates and stops dead when it stops. Neither `connectionState` nor a
 * `<video>` element that has an `srcObject` can substitute — a stalled WebRTC
 * connection reports `connected` for the whole of its 30-odd second timeout
 * while a frozen last frame sits on screen, which is the "convincing live
 * object" failure `ObserverTerminal` was written against, in its worst form.
 *
 * `bytes` is kept beside it because a screen that is not CHANGING still costs
 * bytes: an idle agent's desktop encodes to almost nothing and decodes almost no
 * new frames, so the two numbers separate "the picture is still" from "the pipe
 * is dead".
 *
 * Takes anything Map-shaped so it can be measured without a browser.
 */
export function readInboundVideoStats(
  report: Iterable<[unknown, unknown]>
): DisplayInboundStats | null {
  let seen = false;
  let frames = 0;
  let bytes = 0;
  for (const [, value] of report) {
    if (typeof value !== "object" || value === null) continue;
    const stat = value as Record<string, unknown>;
    if (stat.type !== "inbound-rtp") continue;
    if (stat.kind !== "video" && stat.mediaType !== "video") continue;
    // Several inbound-rtp entries can exist (simulcast layers, a re-negotiated
    // track). Summing is right for bytes and right enough for frames: the
    // question this number answers is "is it moving", not "how many frames did
    // the encoder emit".
    seen = true;
    if (typeof stat.framesDecoded === "number") frames += stat.framesDecoded;
    if (typeof stat.bytesReceived === "number") bytes += stat.bytesReceived;
  }
  return seen ? { frames, bytes } : null;
}

/**
 * The status word under the frame.
 *
 * The link MODEL itself (`observerLink`, `QUIET_AFTER_MS`) is the terminal's and
 * is imported, because the question "may this surface still claim to be live"
 * has one answer for both protocols. What is restated is the vocabulary: the
 * verb for a screen is 보기 (ADR-0004 증보 3 D1's words, 인수 banned), and the
 * two network states keep the terminal's wording because a network is a network.
 *
 * `quiet` still says 보는 중, because it still is: the connection is up, the
 * browser has a network, and the desktop simply has not changed. What changes is
 * that the age of the last frame sits beside it.
 */
export const DISPLAY_LINK_STATUS: Readonly<
  Record<"live" | "quiet" | "offline" | "unverified", string>
> = {
  live: "보는 중",
  quiet: "보는 중",
  offline: "네트워크 끊김",
  unverified: "연결 확인 필요",
};

/**
 * The two link states that need a sentence and not just a word. Neither blames
 * the reader and neither guesses: the offline one states what the browser
 * reported and what will be possible when it changes, the other states exactly
 * what is and is not known about the connection.
 */
export const DISPLAY_LINK_NOTE: Readonly<
  Record<"offline" | "unverified", string>
> = {
  offline:
    "이 브라우저의 네트워크가 끊겼습니다. 화면은 더 오지 않고, 연결이 돌아오면 여기에서 다시 연결할 수 있습니다.",
  unverified:
    "네트워크가 돌아왔습니다. 끊긴 동안 이 연결이 살아남았는지는 다음 화면이 도착해야 알 수 있습니다.",
};

/** How long since the last new frame, or null while the screen is updating. */
export function displayQuietLabel(
  quietMs: number,
  everReceived: boolean
): string | null {
  const span = quietSpan(quietMs);
  if (span === null) return null;
  return everReceived ? `마지막 화면 ${span} 전` : `${span}째 화면 없음`;
}

