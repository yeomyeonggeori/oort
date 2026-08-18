import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { issueDisplayAttach, uuidEq, type WorkSession } from "@momo/core/lib/api";
import { InlineBanner } from "@/features/common/States";
import {
  attachSocketUrl,
  cspBlockedHost,
  classifyClose,
  HOST_CONNECT_TIMEOUT_MS,
  observerLink,
} from "./observerStream";
import {
  answerFrame,
  byeFrame,
  classifyDisplayGrantFailure,
  classifyProducerFrame,
  displayFailureCopy,
  displayGate,
  displayObservationStillPermits,
  displayOffersReload,
  displayOffersRetry,
  displayQuietLabel,
  displaySubprotocols,
  iceFrame,
  isValidDisplayId,
  readInboundVideoStats,
  sdpCarriesVideo,
  sdpNegotiatesInput,
  DISPLAY_ICE_SERVERS,
  DISPLAY_LINK_NOTE,
  DISPLAY_LINK_STATUS,
  DISPLAY_NEGOTIATE_TIMEOUT_MS,
  DISPLAY_OBSERVER_MODE,
  DISPLAY_REVERIFY_MS,
  type DisplayFailure,
} from "./displayStream";

// =============================================================================
// 라이브 화면 (LIVE-2 / ADR-0165): the sandbox's screen, live, in a frame that
// cannot click back.
//
// THIS SURFACE SENDS NOTHING TO THE VM. Not a keystroke, not a click, not a
// pointer position. The way that is held is the way `ObserverTerminal` holds
// its own version: by absence, in three places at once, none of which is a flag
// somebody can flip back.
//
//   1. `displayStream.ts` has encoders for `answer`, `ice` and `bye`, and no
//      encoder for `open_input`, which is a word the producer knows.
//   2. This file never calls `createDataChannel`, never calls `addTrack`, and
//      registers no keyboard, pointer or wheel handler on the video. WebRTC's
//      only input path is a datachannel, and there is no object here to send on.
//   3. The producer offers no `m=application` section at all (ADR-0165 D4), so
//      the channel does not exist to be opened. When an offer arrives carrying
//      one, this component refuses it (`producer_input_channel`) instead of
//      rendering a screen whose guarantee has quietly stopped being true.
//
// `displayStream.test.ts` reads both files and fails if any of that changes.
//
// AND IT KEEPS NO FRAMES (ADR-0165 D5). There is no canvas, no
// `captureStream`, no `MediaRecorder`, no `drawImage`, and the video carries no
// `controls` — a browser's own control bar is where a save/download affordance
// would come from on a surface that is not supposed to have one. Picture in
// picture is off for the same reason it is not needed: this is a pane inside a
// session, not a media player.
//
// THE ONE THING IT MUST NEVER DO is look live when it is not, and a video
// element is even better at that lie than a terminal: a frozen last frame is
// indistinguishable from a still desktop, and a stalled WebRTC connection
// reports `connected` for its whole timeout. So 보는 중 is bound to
// `framesDecoded` off the peer connection's own stats and to the two facts a
// browser can observe honestly (`navigator.onLine`, and how long since the last
// new frame), exactly as the terminal binds it to arriving bytes.
//
// WHY IT SITS BESIDE THE TERMINAL AND NOT IN A TAB. `remoteAttachAvailable` and
// `remoteDisplayAvailable` are independent server facts: a session can offer a
// screen and no terminal, or the reverse, or both. A tab strip would imply the
// reader has to choose, and would hide whichever one they did not.
// =============================================================================

type Phase =
  | { kind: "idle" }
  | { kind: "issuing" }
  | { kind: "connecting" }
  | { kind: "negotiating" }
  | { kind: "watching" }
  | { kind: "failed"; failure: DisplayFailure };

const PHASE_BUSY_COPY: Readonly<
  Record<"issuing" | "connecting" | "negotiating", string>
> = {
  issuing: "화면 보기 권한을 받는 중",
  // 「연결하는 중」이 아니다 (#1501): 한자어 동작명사가 있으면 「명사 + 중」이고,
  // 없을 때만 고유어 동사가 「-는 중」을 쓴다. 위아래 두 줄(받다·맞추다)이 그
  // 고유어 갈래라, 이 표 하나가 규칙의 두 쪽을 나란히 들고 있다.
  connecting: "호스트에 연결 중",
  negotiating: "화면 연결을 맞추는 중",
};

/**
 * How often the peer connection is asked what it has actually decoded.
 *
 * The same 500ms the terminal publishes its byte count on, and for the same
 * reason: the number is the liveness signal so it has to move, but it does not
 * have to move at the speed of a 30fps encoder.
 */
const STATS_POLL_MS = 500;

export function DisplayObserver({
  session,
  hostName,
  headingLevel = 4,
  controlInvite = null,
}: {
  session: WorkSession;
  hostName: string | null;
  /** Follows the WorkSessionDetail heading in its route or panel context. */
  headingLevel?: 3 | 4;
  /**
   * The way into 직접 조작, rendered as an opaque node (LIVE-5b).
   *
   * A SLOT AND NOT A CALLBACK, deliberately. Every absence this file's header
   * claims — no input handler, no datachannel, no encoder for the viewer word
   * that carries input — is held by `displayStream.test.ts` reading this source,
   * and the claims stay mechanically checkable only while nothing about control
   * is spelled here. A node arrives already built by `DisplayController.tsx`,
   * which is where the reviewer for control is meant to be looking.
   *
   * Null when there is nobody to offer it to. That is the caller's judgement
   * (`controlAffordance`), and it is a judgement about a person rather than
   * about this stream, which is the other reason it is not decided here.
   */
  controlInvite?: React.ReactNode;
}) {
  const { session: auth, workspaceId } = useSession();
  const queryClient = useQueryClient();
  const isOwner = uuidEq(session.memberId, auth.member.id);
  const gate = displayGate(session, isOwner);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** Frames and bytes decoded, published from the stats poll below. */
  const [frames, setFrames] = useState(0);
  const [bytes, setBytes] = useState(0);
  /** Whether a single frame has ever been decoded on THIS attempt. */
  const [received, setReceived] = useState(false);
  const receivedRef = useRef(false);
  /** Seconds since the last NEW frame, published while watching. */
  const [quietSeconds, setQuietSeconds] = useState(0);
  const lastFrameAtRef = useRef(0);
  const lastFrameCountRef = useRef(0);
  /** The browser reported an outage and nothing has arrived since. */
  const [doubted, setDoubted] = useState(false);
  const doubtedRef = useRef(false);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  /**
   * The deadline on the leg after the handshake, held in a ref because it is
   * cleared from three different places: the frame that satisfies it, the
   * teardown that abandons it, and the failure that replaces it.
   */
  const negotiateTimerRef = useRef<number | null>(null);
  /**
   * The connecting leg's own cleanup — the handshake deadline and the document
   * listener that catches a CSP refusal — held where `teardown` can reach it.
   *
   * It is a ref rather than a local because the two events that used to run it
   * (`onopen`, `onclose`) are the two `teardown` deletes first, on purpose: a
   * socket handler that fires during teardown would report a failure the reader
   * has already left behind. So on every OTHER way out of `connecting` — the
   * handshake deadline giving up, a different session arriving in the same
   * mounted panel, the panel unmounting, the ledger revoking mid-handshake —
   * nothing on the socket fires at all, and a cleanup that lives only in those
   * handlers is a cleanup that never runs. The timer is harmless when it is
   * missed (the generation counter makes it a no-op), but the `document`
   * listener is not: it is attached to a node that outlives this component, so
   * it survives for the life of the tab and a fresh one accumulates behind every
   * retry and every session switch.
   */
  const connectCleanupRef = useRef<(() => void) | null>(null);
  /** Generation counter: an old attempt's callbacks must not touch new state. */
  const runRef = useRef(0);

  /**
   * Drop everything this attempt is holding.
   *
   * The `bye` is a courtesy the producer can act on immediately (it is in the
   * viewer vocabulary for exactly this), and it is best effort: a socket that is
   * already closing throws, and a viewer that vanished without saying goodbye is
   * a case the producer has to survive anyway.
   */
  const teardown = useCallback((saidBye: boolean) => {
    // First, because it is the one thing here that is NOT reachable from the
    // socket: everything below either belongs to this component's own refs or
    // dies with the socket, while the connecting leg hung a listener on the
    // document. Running it here is what makes every exit path an exit path.
    const connectCleanup = connectCleanupRef.current;
    connectCleanupRef.current = null;
    connectCleanup?.();
    if (negotiateTimerRef.current !== null) {
      window.clearTimeout(negotiateTimerRef.current);
      negotiateTimerRef.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (saidBye && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(byeFrame());
        } catch {
          /* already going away; the close below is what matters */
        }
      }
      socket.close();
    }
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    const run = runRef.current + 1;
    runRef.current = run;
    teardown(true);
    setPhase({ kind: "issuing" });
    receivedRef.current = false;
    doubtedRef.current = false;
    lastFrameCountRef.current = 0;
    setReceived(false);
    setDoubted(false);
    setFrames(0);
    setBytes(0);
    setQuietSeconds(0);

    // A runtime with no WebRTC is checked before the capability call, so a
    // browser that cannot possibly render this does not mint a bearer to prove
    // it. `window` rather than a bare global: this bundle is also built for a
    // Node-side gate that has neither.
    if (typeof window === "undefined" || typeof window.RTCPeerConnection !== "function") {
      setPhase({ kind: "failed", failure: "webrtc_unsupported" });
      return;
    }

    let grant;
    try {
      grant = await issueDisplayAttach(workspaceId, session.id);
    } catch (error) {
      if (runRef.current !== run) return;
      setPhase({ kind: "failed", failure: classifyDisplayGrantFailure(error) });
      return;
    }
    if (runRef.current !== run) return;

    // The grade is read, not assumed. `observer` is the only thing this build
    // can serve and the only thing this client can draw; anything else is a
    // stream whose input rights this surface would be misrepresenting.
    if (grant.mode !== DISPLAY_OBSERVER_MODE) {
      setPhase({ kind: "failed", failure: "signal_invalid" });
      return;
    }
    const url = attachSocketUrl(grant.display_endpoint);
    if (url === null || !isValidDisplayId(grant.display_id)) {
      setPhase({ kind: "failed", failure: "grant_invalid" });
      return;
    }

    setPhase({ kind: "connecting" });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, displaySubprotocols(grant.capability_token));
    } catch {
      setPhase({ kind: "failed", failure: "host_unreachable" });
      return;
    }
    socketRef.current = socket;
    let opened = false;
    /** The producer got as far as offering a screen. It separates two silences. */
    let offered = false;
    /**
     * Candidates that arrived before there was anywhere to put them.
     *
     * A producer trickles as soon as it has an address, which is routinely
     * before this browser has finished `setRemoteDescription` on the offer that
     * created the peer connection. `addIceCandidate` throws in that window, and
     * a dropped candidate is a path that is simply never tried — on a build with
     * no STUN and no TURN (ADR-0165 D3), where the host candidates ARE the
     * connectivity, losing one is losing the connection.
     */
    const pendingCandidates: RTCIceCandidateInit[] = [];
    let remoteDescriptionSet = false;
    const addCandidate = (init: RTCIceCandidateInit) => {
      const peer = peerRef.current;
      if (!peer || !remoteDescriptionSet) {
        pendingCandidates.push(init);
        return;
      }
      void peer.addIceCandidate(init).catch(() => {
        /* a candidate the browser will not parse is one path lost, not the
           negotiation: ICE keeps trying the others. */
      });
    };

    const give = (failure: DisplayFailure) => {
      runRef.current += 1;
      teardown(false);
      setPhase({ kind: "failed", failure });
    };

    // The handshake gets a deadline for `HOST_CONNECT_TIMEOUT_MS`'s measured
    // reason: an unroutable host holds CONNECTING until the OS gives up, and a
    // socket the page's own CSP blocks fires no event on the socket at all.
    const deadline = window.setTimeout(() => {
      if (runRef.current !== run || opened) return;
      give("host_timeout");
    }, HOST_CONNECT_TIMEOUT_MS);

    // The CSP refusal does have an event, just not on the socket. Reporting it
    // as "the host did not answer in 15 seconds" is true and useless: the host
    // was never asked, and no retry can change a policy.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (runRef.current !== run || opened) return;
      if (!cspBlockedHost(event, url)) return;
      // No clearTimeout here: `give` tears down, and teardown runs `done`. One
      // place clears this attempt's deadline, so there is no second place to
      // forget to add the next line to.
      give("host_blocked_by_policy");
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    /**
     * End the connecting leg. Idempotent, because it is now reached from both
     * directions: the socket settling, and any teardown that abandons the
     * attempt before it settled. Removing a listener that is already gone and
     * clearing a timer that already fired are both no-ops, and the ref is only
     * cleared when it is still this attempt's — a newer attempt's cleanup must
     * survive an older one's late `onclose`.
     */
    const done = () => {
      if (connectCleanupRef.current === done) connectCleanupRef.current = null;
      window.clearTimeout(deadline);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };
    connectCleanupRef.current = done;

    /**
     * Answer the producer's offer.
     *
     * Note what is NOT here, because it is the whole contract: no
     * `addTrack` (this browser sends no media), no `addTransceiver` (the
     * recvonly transceiver comes from the producer's own sendonly m-line, which
     * is what makes "recvonly" a consequence of the offer rather than a request
     * of ours), and no `createDataChannel`.
     */
    const answerOffer = async (sdp: string) => {
      if (sdpNegotiatesInput(sdp)) {
        give("producer_input_channel");
        return;
      }
      if (!sdpCarriesVideo(sdp)) {
        give("signal_invalid");
        return;
      }
      const peer = new window.RTCPeerConnection({
        iceServers: DISPLAY_ICE_SERVERS,
      });
      peerRef.current = peer;
      peer.ontrack = (event: RTCTrackEvent) => {
        if (runRef.current !== run) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject =
          event.streams[0] ?? new MediaStream([event.track]);
        // Autoplay can still be refused (a policy, a background tab). The
        // rejection is swallowed rather than reported: the frame counter below
        // is what tells the reader whether anything is arriving, and a browser
        // that declined to start playing is not a broken stream.
        void video.play().catch(() => {});
      };
      peer.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (runRef.current !== run || !event.candidate) return;
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          iceFrame({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          })
        );
      };
      peer.onconnectionstatechange = () => {
        if (runRef.current !== run) return;
        if (peer.connectionState === "connected") {
          if (negotiateTimerRef.current !== null) {
            window.clearTimeout(negotiateTimerRef.current);
            negotiateTimerRef.current = null;
          }
          lastFrameAtRef.current = performance.now();
          setQuietSeconds(0);
          setPhase({ kind: "watching" });
          return;
        }
        if (peer.connectionState === "failed") give("media_failed");
      };
      try {
        await peer.setRemoteDescription({ type: "offer", sdp });
        if (runRef.current !== run) return;
        remoteDescriptionSet = true;
        for (const init of pendingCandidates.splice(0)) addCandidate(init);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (runRef.current !== run) return;
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(answerFrame(answer.sdp ?? ""));
      } catch {
        if (runRef.current !== run) return;
        give("signal_invalid");
      }
    };

    socket.onopen = () => {
      done();
      if (runRef.current !== run) return;
      opened = true;
      // Nothing is sent on open. The producer speaks first (`ready`, then
      // `offer`) because it is the one that had to validate the capability with
      // the server before it agreed to speak at all.
      lastFrameAtRef.current = performance.now();
      setQuietSeconds(0);
      setPhase({ kind: "negotiating" });
      // The leg the handshake deadline does not cover. It is armed here rather
      // than after the answer so that it also catches the producer that accepts
      // the socket and then says nothing at all, which is the one failure with
      // no event anywhere to report it.
      negotiateTimerRef.current = window.setTimeout(() => {
        if (runRef.current !== run) return;
        give(offered ? "media_failed" : "producer_silent");
      }, DISPLAY_NEGOTIATE_TIMEOUT_MS);
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (runRef.current !== run) return;
      if (typeof event.data !== "string") return;
      const frame = classifyProducerFrame(event.data);
      switch (frame.kind) {
        case "ready":
          // The producer's own statement of D4, checked rather than trusted.
          // Trusting it would be pointless (the SDP is the real guarantee and it
          // is checked below) but ignoring it would be worse: a producer that
          // announces input is a producer that disagrees with the server that
          // told it `input_enabled: false`, and that disagreement is worth
          // stopping on rather than watching through.
          if (frame.mode !== DISPLAY_OBSERVER_MODE) {
            give("signal_invalid");
            return;
          }
          if (frame.inputEnabled) {
            give("producer_input_channel");
          }
          return;
        case "offer":
          offered = true;
          void answerOffer(frame.sdp);
          return;
        case "ice":
          // An empty candidate is end-of-candidates and nothing to add.
          if (frame.candidate === "") return;
          addCandidate({
            candidate: frame.candidate,
            sdpMid: frame.sdpMid,
            sdpMLineIndex: frame.sdpMLineIndex,
          });
          return;
        case "error":
          give("producer_refused");
          return;
        default:
          return;
      }
    };
    socket.onclose = (event: CloseEvent) => {
      done();
      if (runRef.current !== run) return;
      socketRef.current = null;
      teardown(false);
      setPhase({
        kind: "failed",
        failure: classifyClose({
          opened,
          code: event.code,
          reason: event.reason,
        }),
      });
    };
    // `error` carries nothing a browser is allowed to describe, so the close
    // that always follows is what names the failure.
    socket.onerror = () => {};
  }, [session.id, teardown, workspaceId]);

  /** Stop watching. The frame goes with it: there is nothing to keep. */
  const stop = useCallback(() => {
    runRef.current += 1;
    teardown(true);
    setPhase({ kind: "idle" });
  }, [teardown]);

  // What the peer connection has actually decoded. This is the whole liveness
  // claim: `framesDecoded` moves as the screen updates and stops when it stops,
  // and a WebRTC connection that reports `connected` over a dead path cannot
  // move it.
  const watchingNow = phase.kind === "watching";
  useEffect(() => {
    if (!watchingNow) return;
    let cancelled = false;
    const poll = async () => {
      const peer = peerRef.current;
      if (!peer) return;
      let report: RTCStatsReport;
      try {
        report = await peer.getStats();
      } catch {
        return;
      }
      if (cancelled) return;
      const stats = readInboundVideoStats(report);
      if (!stats) return;
      setFrames(stats.frames);
      setBytes(stats.bytes);
      if (stats.frames > lastFrameCountRef.current) {
        lastFrameCountRef.current = stats.frames;
        lastFrameAtRef.current = performance.now();
        if (!receivedRef.current) {
          receivedRef.current = true;
          setReceived(true);
        }
        if (doubtedRef.current) {
          doubtedRef.current = false;
          setDoubted(false);
        }
      }
      setQuietSeconds(
        Math.max(0, Math.floor((performance.now() - lastFrameAtRef.current) / 1000))
      );
    };
    const timer = window.setInterval(() => void poll(), STATS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [watchingNow]);

  // The browser's network verdict, polled from the events because
  // `navigator.onLine` is not reactive: without these listeners an outage would
  // only be noticed on some unrelated re-render, which on a frozen stream is
  // never.
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Once the browser has said "no network" under a live stream, this connection
  // is unproven until a frame arrives on it, whatever any state field says.
  useEffect(() => {
    if (online || !watchingNow || doubtedRef.current) return;
    doubtedRef.current = true;
    setDoubted(true);
  }, [online, watchingNow]);

  // The stream outlives the server's own revocation: closing observation
  // deletes the capability rows and ending the session stops the ledger, but
  // neither can reach a peer connection held between this browser and the VM.
  // The producer re-validates its own bearer for the other half of this; both
  // halves are needed, because the producer's clock is not this reader's.
  //
  // Owner-aware since LIVE-3: `owner_only` means 「소유자만 본다」, so an owner
  // closing observation must not tear down their OWN screen one re-verify
  // later while the server goes on validating the grant behind it.
  const revoked = displayObservationStillPermits(session, isOwner);
  const holding =
    phase.kind === "watching" ||
    phase.kind === "connecting" ||
    phase.kind === "negotiating";
  useEffect(() => {
    if (!holding || revoked === null) return;
    runRef.current += 1;
    teardown(true);
    setPhase({ kind: "failed", failure: revoked });
  }, [holding, revoked, teardown]);

  // The 재검증 loop (DISPLAY_REVERIFY_MS). It re-reads the LEDGER rather than
  // minting a second capability — see the constant's docstring for why the
  // re-issue shape was refused — so that the revocation effect above is acting
  // on server truth that is at most one capability lifetime old. React Query
  // pauses its own interval while the tab is hidden, and a hidden tab is exactly
  // where a media stream runs on with nobody re-checking it.
  useEffect(() => {
    if (!holding) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: ["work-sessions", workspaceId],
      });
    }, DISPLAY_REVERIFY_MS);
    return () => window.clearInterval(timer);
  }, [holding, queryClient, workspaceId]);

  // A reopened gate is a fresh idle surface: a banner quoting the ledger stops
  // being a fact the moment the ledger says otherwise, and leaving it up would
  // put a sentence on screen arguing with the controls beside it.
  const gateOpen = gate.available;
  const gateWasOpen = useRef(gateOpen);
  useEffect(() => {
    const reopened = gateOpen && !gateWasOpen.current;
    gateWasOpen.current = gateOpen;
    if (!reopened) return;
    setPhase((current) => (current.kind === "failed" ? { kind: "idle" } : current));
  }, [gateOpen]);

  // A different session in the same mounted panel is a different screen, and
  // one session's desktop under another session's title is the worst thing this
  // component could put on a screen.
  useEffect(() => {
    runRef.current += 1;
    teardown(false);
    receivedRef.current = false;
    doubtedRef.current = false;
    lastFrameCountRef.current = 0;
    setReceived(false);
    setDoubted(false);
    setFrames(0);
    setBytes(0);
    setQuietSeconds(0);
    setPhase({ kind: "idle" });
  }, [session.id, teardown]);

  // Leaving the panel drops the stream with it.
  useEffect(
    () => () => {
      runRef.current += 1;
      teardown(true);
    },
    [teardown]
  );

  const link = observerLink({
    watching: watchingNow,
    online,
    quietMs: quietSeconds * 1000,
    doubted,
  });
  // Only while a connection is held. Keeping the clause afterwards would freeze
  // "마지막 화면 15초 전" over a surface that has said 연결 없음 for ten minutes.
  const quiet = link === null ? null : displayQuietLabel(quietSeconds * 1000, received);
  const busyCopy =
    phase.kind === "issuing" ||
    phase.kind === "connecting" ||
    phase.kind === "negotiating"
      ? PHASE_BUSY_COPY[phase.kind]
      : null;
  const busy = busyCopy !== null;
  // The frame is drawn while a connection is being set up or running, and not
  // after: unlike a terminal there is nothing kept from a stream that ended.
  // A video element left holding its last frame would be the frozen picture
  // this whole file is written against.
  const showFrame = busy || watchingNow;
  // One fact, one sentence. These two failures ARE the gate's own reason said
  // over again, and the banner is the copy that wins because it is what the
  // reader is looking at and the one carrying the tone. That only holds because
  // the banner is owner-aware (`displayFailureCopy`): while it indexed the
  // owner-blind table this line dropped the gate's owner sentence and put a
  // third-person one in its place, which is the opposite of a de-duplication.
  const gateReasonInBanner =
    phase.kind === "failed" &&
    (phase.failure === "observation_closed" || phase.failure === "session_ended");
  const Heading = headingLevel === 3 ? "h3" : "h4";

  return (
    <section
      className="border-b border-line px-4 py-2"
      data-testid="work-display"
      data-phase={phase.kind}
      data-link={link ?? undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading className="min-w-0 flex-1 text-meta text-ink-muted">
          라이브 화면
        </Heading>
        {/* 보기 전용 is a property of the surface, stated once where the surface
            is named. The word is deliberately not 인수: this grade cannot take
            anything over, and a label that hints otherwise is how someone ends
            up typing at a window that will never deliver a keystroke
            (ADR-0004 증보 3 D1). */}
        {(gate.available || showFrame) && (
          <span
            className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp text-ink-muted"
            title="화면만 호스트에서 직접 받습니다. 키보드, 마우스, 파일은 보낼 수 없고 화면은 저장되지 않습니다."
            data-testid="work-display-readonly"
          >
            보기 전용
          </span>
        )}
        {/* 관전 권한 N is deliberately NOT repeated here. The server's count is
            kind-blind — one number covering terminal and screen grants alike —
            and it is already on screen once, in the 터미널 관전 block. A second
            badge carrying the same number would read as a second, different
            count. */}
      </div>

      {/* Not available: the reason, in words, and no control that cannot act.
          Dropped when the banner below is already saying the same thing. */}
      {!gate.available && !gateReasonInBanner && (
        <p className="pt-1 text-meta text-ink-muted" data-testid="work-display-blocked">
          {gate.reason}
        </p>
      )}

      {gate.available && phase.kind === "idle" && (
        <div className="flex flex-col items-start gap-2 pt-1">
          <p className="text-meta text-ink-muted" data-testid="work-display-invite">
            {hostName === null
              ? "화면을 열면 이 세션이 실행 중인 호스트의 화면이 그대로 보입니다. 보기 전용이라 조작은 할 수 없고, 화면은 서버를 거치지 않고 호스트에서 직접 옵니다."
              : `화면을 열면 ${hostName}의 화면이 그대로 보입니다. 보기 전용이라 조작은 할 수 없고, 화면은 서버를 거치지 않고 호스트에서 직접 옵니다.`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void start()}
            data-testid="work-display-start"
          >
            화면 보기
          </Button>
        </div>
      )}

      {busyCopy !== null && (
        <p
          role="status"
          className="flex items-center gap-2 pt-1 text-meta text-ink-muted"
          data-testid="work-display-busy"
        >
          <Loader2 aria-hidden="true" className="spinner-busy size-4" />
          {busyCopy}
        </p>
      )}

      {phase.kind === "failed" && (
        // Full bleed inside a padded section: InlineBanner brings its own px-4
        // and its own bottom rule because it is built to span a panel, so the
        // negative margin gives it the width it was drawn for and lands its text
        // on the same left edge as everything else here.
        <div className="-mx-4 pt-1">
          <InlineBanner
            tone={
              phase.failure === "stream_closed" ||
              phase.failure === "session_ended" ||
              phase.failure === "observation_closed"
                ? "neutral"
                : "error"
            }
            // Owner-aware, and since LIVE-3 for a narrower reason than "the
            // 소유자만 보기 toggle is one block up". `owner_only` now means
            // 「소유자만 본다」, so closing observation refuses an owner nothing
            // and an owner does not reach the `observation_closed` banner at
            // all. What the owner-blind table still gets wrong for them is
            // `capability_denied`: its shared sentence offers two causes, and
            // observation can no longer be theirs. `displayFailureCopy` names
            // the one that can still be true, channel membership.
            message={displayFailureCopy(phase.failure, isOwner)}
            {...(displayOffersRetry(phase.failure, gate.available)
              ? { actionLabel: "다시 연결", onAction: () => void start() }
              : displayOffersReload(phase.failure)
                ? { actionLabel: "새로고침", onAction: () => window.location.reload() }
                : {})}
            testId="work-display-error"
          />
        </div>
      )}

      {showFrame && (
        <div className="pt-2">
          {/* 16:9 while nothing has arrived, so the pane does not jump when the
              first frame lands, and `object-contain` after, so a desktop that is
              not 16:9 is letterboxed rather than cropped. A cropped screen is a
              screen with something hidden off its edge, which on a surface whose
              only job is to show what the agent is doing is the one distortion
              that matters. */}
          <div className="aspect-video overflow-hidden rounded-sm border border-line bg-surface-raised">
            <video
              ref={videoRef}
              // No `controls`: a browser's control bar is where a save or
              // download affordance comes from, and ADR-0165 D5 says no frame is
              // kept anywhere. Muted because the producer sends no audio track
              // at all (template.spec.json `capture.audio: false`), and because
              // an unmuted video cannot autoplay.
              autoPlay
              playsInline
              muted
              disablePictureInPicture
              className="size-full object-contain"
              aria-label="세션 호스트 화면, 보기 전용"
              data-testid="work-display-video"
            />
          </div>

          {/* The link is not the connection state. Either the browser has said
              it has no network at all, or it said so while this stream was open
              and has not proved otherwise since. */}
          {(link === "offline" || link === "unverified") && (
            <div
              className="flex flex-wrap items-center gap-2 pt-1"
              data-testid="work-display-link"
              data-link={link}
            >
              <p role="status" className="min-w-0 flex-1 text-meta text-warn">
                {DISPLAY_LINK_NOTE[link]}
              </p>
              {link === "unverified" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void start()}
                  data-testid="work-display-relink"
                >
                  다시 연결
                </Button>
              )}
            </div>
          )}

          {/* What the surface is, then what it holds. The first word is the
              liveness claim and it is bound to frames this browser actually
              decoded, not to a connection state and not to the presence of a
              video element. */}
          <p
            className={cn(
              "pt-1 text-meta",
              link === "offline" || link === "unverified"
                ? "text-warn"
                : "text-ink-muted"
            )}
            data-testid="work-display-frames"
          >
            {link === null ? "연결 없음" : DISPLAY_LINK_STATUS[link]}
            {quiet !== null && (
              <>
                {" · "}
                <span data-numeric>{quiet}</span>
              </>
            )}{" "}
            · 받은 화면{" "}
            <span data-numeric className="font-mono">
              {frames.toLocaleString()}
            </span>
            프레임,{" "}
            <span data-numeric className="font-mono">
              {bytes.toLocaleString()}
            </span>
            바이트
          </p>

          {watchingNow && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={stop}
                data-testid="work-display-stop"
              >
                보기 중단
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 직접 조작으로 가는 문 (LIVE-5b). 마지막에 서는 이유는 위의 전부가
          「지금 무엇을 볼 수 있는가」이고 이것만 「무엇을 할 수 있는가」이기
          때문이다. 볼 수 없는 세션에도 설 수 있다: 조작이 왜 안 되는지는 화면이
          왜 안 보이는지와 같은 사실이 아니고, 어느 쪽도 상대를 대신 설명하지
          않는다.

          래퍼가 없다. 노드가 스스로 여백까지 들고 오거나 아무것도 아니거나
          둘 중 하나여야, 아무에게도 보일 것이 없는 세션에서 빈 띠 하나가
          남지 않는다 (승인 카드의 note 슬롯이 배운 것과 같다). */}
      {controlInvite}
    </section>
  );
}
