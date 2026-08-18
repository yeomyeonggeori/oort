import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import {
  issueControllerDisplayAttach,
  returnDisplayControl,
  type WorkSession,
} from "@momo/core/lib/api";
import { InlineBanner } from "@/features/common/States";
import {
  attachSocketUrl,
  cspBlockedHost,
  classifyClose,
  HOST_CONNECT_TIMEOUT_MS,
} from "./observerStream";
import {
  answerFrame,
  byeFrame,
  classifyProducerFrame,
  displayFailureCopy,
  displayObservationStillPermits,
  displaySubprotocols,
  iceFrame,
  isValidDisplayId,
  sdpCarriesVideo,
  sdpNegotiatesInput,
  DISPLAY_ICE_SERVERS,
  DISPLAY_REVERIFY_MS,
} from "./displayStream";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import {
  autoReturnFor,
  classifyControlGrantFailure,
  controlAffordance,
  controlFailureCopy,
  controlObservationRestoredNote,
  controlOffersRetry,
  createKeyPresses,
  dispositionForKey,
  forwardKey,
  forwardPointer,
  forwardWheel,
  normalisedPoint,
  CONTROL_ACTIVE_DETAIL,
  CONTROL_CAPTURE_LIMIT_COPY,
  CONTROL_INPUT_CHANNEL_LABEL,
  CONTROL_INVITE_COPY,
  CONTROL_KEYBOARD_LOST_COPY,
  CONTROL_KEYBOARD_LOST_LABEL,
  CONTROL_NEGOTIATE_TIMEOUT_MS,
  CONTROL_PHASE_COPY,
  CONTROL_RETURN_COPY,
  CONTROL_RETURN_FAILED_COPY,
  CONTROL_RETURN_LABEL,
  CONTROL_START_LABEL,
  DISPLAY_CONTROLLER_MODE,
  type ControlFailure,
  type ControlInputSink,
  type ControlLifecycleEvent,
  type ControlReturnReason,
} from "./controlStream";

// =============================================================================
// 직접 조작 표면 (LIVE-5b / ADR-0004 증보 3).
//
// The screen, live, in a frame that CAN click back. It is a separate component
// from `DisplayObserver` for the reason `controlStream.ts` is a separate
// module from `displayStream.ts`: over there view-only is held by ABSENCE, and
// an absence does not survive a boolean threaded through the file that holds
// it. Everything that can carry a keystroke is in these two files and nowhere
// else in this client.
//
// WHAT IS NOT HERE, AND IS THE ORDERING THIS WHOLE SURFACE RESTS ON:
//
//   * `createDataChannel` — the PRODUCER opens the input channel, and only
//     after ITS OWN re-validation answered `input_enabled: true`. This side
//     listens on `ondatachannel`. A client that opened its own way in would
//     make the server's grant decorative, which is the failure ADR-0165 D4
//     spent its whole argument on and 증보 3 did not repeal.
//   * `open_input` — the viewer word exists in the template precisely so a
//     producer can refuse it by name. Sending it would be asking, and asking is
//     not authorisation.
//   * any store of what was typed. The handlers below call `forwardKey`, whose
//     return type is a three-word union, and drop it. Nothing here is a
//     `useState` of a key, a log of a key, or an attribute holding a key.
//
// THE FOUR STATES. 연결 중 · 조작 중 · 반환 중 · 실패, and every one of them
// says what is true of the AGENT as well as of the screen, because the reader's
// real question is never "is my socket up" — it is "is my agent stopped, and
// will it start again".
//
// AUTO-RETURN. A control window that outlives the person holding it is an agent
// left stopped. Three paths close it from here — the handshake deadline, a
// producer that went away, the person pressing 반환 — and every one of them
// runs the SAME return call, so there is one place where the window ends and
// one place that can fail. When it does fail, the surface says the server's 90
// second lease will finish the job, because that is the only true sentence left.
// =============================================================================

type Phase =
  | { kind: "issuing" }
  | { kind: "connecting" }
  | { kind: "negotiating" }
  | { kind: "controlling" }
  | { kind: "returning" }
  | { kind: "returned"; reason: ControlReturnReason; observationNote: string | null }
  | { kind: "return_failed" }
  | { kind: "failed"; failure: ControlFailure };

export function DisplayController({
  session,
  hostName,
  headingLevel = 4,
  onDone,
}: {
  session: WorkSession;
  hostName: string | null;
  headingLevel?: 3 | 4;
  /**
   * Control is over and this surface should go back to being a viewer.
   *
   * The parent owns the swap rather than this component hiding itself, because
   * the thing that replaces it is the observer stream and one component must
   * not decide to mount another. It is called only after the window is settled
   * one way or the other, so the reader never sees the viewer surface while
   * their agent is still stopped.
   */
  onDone: () => void;
}) {
  const { workspaceId } = useSession();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "issuing" });
  /**
   * Whether a frame has ever been decoded on this attempt.
   *
   * The controller surface keeps this and NOT the viewer's frame/byte readout.
   * A person about to type a password does not need a telemetry line; what they
   * need is to know the picture in front of them is now rather than a minute
   * ago, and that is one boolean plus the picture itself.
   */
  const [received, setReceived] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  /**
   * The producer's input channel.
   *
   * A REF and never state, and that is load-bearing rather than a performance
   * habit: a channel in state would be a channel React re-renders around, and
   * the handlers that write to it would close over a snapshot. It also keeps
   * the object out of the fiber tree, which is one of the four places
   * `controlStream.test.ts` scans for a leak.
   */
  const channelRef = useRef<ControlInputSink | null>(null);
  /**
   * What the reserved key's keydown decided, until that key comes back up
   * (#1563). A REF for the same two reasons the channel is one — the handlers
   * must read the live value, and nothing about a key belongs in the fiber
   * tree the leak scan reads.
   */
  const keyPressesRef = useRef(createKeyPresses());
  /** The producer's video, held until there is an element to put it in. */
  const streamRef = useRef<MediaStream | null>(null);
  const negotiateTimerRef = useRef<number | null>(null);
  const connectCleanupRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);
  /**
   * The observation setting this window is standing on top of.
   *
   * Captured at mount because the server FORCES `owner_only` for the life of
   * the window (LIVE-5a) and restores this value when it closes. By the time
   * the window ends, `session.observation` reads `owner_only` for every reader,
   * so asking it then would tell every owner their team can watch again —
   * including the owner who had closed observation themselves before they ever
   * took the keyboard.
   */
  const observationBeforeRef = useRef(session.observation);
  /**
   * The return is in flight or already made.
   *
   * The three auto-return paths can race each other (a socket close and a
   * deadline can land in the same tick), and a second DELETE would be answered
   * `closed: false` — harmless to the ledger, and a lie on screen, because the
   * surface would report a return that had already happened as one that found
   * nothing to close.
   */
  const returnedRef = useRef(false);

  /**
   * Put the held stream in the video element, if both exist yet.
   *
   * Idempotent and cheap, so it can be called from both sides of the race it
   * exists to settle: the track arriving, and the element appearing.
   */
  const attachStream = useCallback(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    // Autoplay can still be refused (a policy, a background tab). Swallowed
    // rather than reported: the frame arriving is what the surface reads.
    void video.play().catch(() => {});
  }, []);

  const teardown = useCallback((saidBye: boolean) => {
    const connectCleanup = connectCleanupRef.current;
    connectCleanupRef.current = null;
    connectCleanup?.();
    if (negotiateTimerRef.current !== null) {
      window.clearTimeout(negotiateTimerRef.current);
      negotiateTimerRef.current = null;
    }
    channelRef.current = null;
    // A window that is over holds nothing. The next one starts with no press
    // outstanding rather than with whatever this one's last chord left behind.
    keyPressesRef.current = createKeyPresses();
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
      peer.ondatachannel = null;
      peer.close();
    }
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  /**
   * End the window. THE ONE PLACE, for all four reasons.
   *
   * Every path that stops control comes through here, which is what makes
   * "the window always closes" a property of one function rather than a
   * discipline four call sites have to keep. It is idempotent on this side
   * (`returnedRef`) as well as on the server's, because the two guards protect
   * different things: the server's stops a retry from erroring, this one stops
   * a second attempt from overwriting a settled sentence with a weaker one.
   */
  const endControl = useCallback(
    async (reason: ControlReturnReason) => {
      if (returnedRef.current) return;
      returnedRef.current = true;
      runRef.current += 1;
      teardown(true);
      setPhase({ kind: "returning" });
      try {
        await returnDisplayControl(workspaceId, session.id);
      } catch {
        // The window is now the server's problem, and it has one: the lease.
        // Saying so is the whole point of this branch — see
        // CONTROL_RETURN_FAILED_COPY.
        setPhase({ kind: "return_failed" });
        void queryClient.invalidateQueries({
          queryKey: ["work-sessions", workspaceId],
        });
        return;
      }
      setPhase({
        kind: "returned",
        reason,
        observationNote: controlObservationRestoredNote(
          observationBeforeRef.current
        ),
      });
      // The ledger moved twice in one transaction (the window closed and
      // observation was restored), and both are projected on the session read.
      void queryClient.invalidateQueries({
        queryKey: ["work-sessions", workspaceId],
      });
    },
    [queryClient, session.id, teardown, workspaceId]
  );

  /**
   * Close a window this surface opened and is NOT holding, from outside the
   * component's lifecycle.
   *
   * DELIBERATELY UNGUARDED by `returnedRef`, which is the whole point of it
   * existing (grok freeze H-1). `returnedRef` protects a person's settled
   * sentence from being overwritten by a second attempt; it does not protect
   * the LEDGER, and the failure it let through was not a double return but a
   * single one that went **too early**:
   *
   *   1. the person confirms, and the mint goes out;
   *   2. they navigate away before it answers. The unmount effect returns
   *      control, and the server truthfully answers `closed: false` — there is
   *      nothing open yet;
   *   3. the mint lands. A window opens, the agent parks, and nobody is left
   *      holding either. It stands until the 90 second lease, and a retry in
   *      that gap is answered 409.
   *
   * So the late success closes the window itself, right where it learns the
   * window exists. It sets no state and reads no phase, because by then this
   * component may not be mounted.
   *
   * WHY THE MINT IS NOT ABORTED INSTEAD. An `AbortController` on the capability
   * call looks like the tidier fix and is strictly worse here: aborting makes
   * the promise reject, so the client never learns whether the server committed
   * the mint, and the only cleanup left is a blind DELETE racing the very
   * transaction it is trying to undo. Letting the request finish costs one
   * detached fetch and buys certainty — after it resolves, the window provably
   * exists and this call provably lands after it.
   */
  const abandonWindow = useCallback(() => {
    void returnDisplayControl(workspaceId, session.id).catch(() => {
      // Nothing left to tell: this path has no surface. The 90 second lease is
      // the backstop, and it is the server's own.
    });
  }, [session.id, workspaceId]);

  const start = useCallback(async () => {
    const run = runRef.current + 1;
    runRef.current = run;
    returnedRef.current = false;
    teardown(true);
    setReceived(false);
    setPhase({ kind: "issuing" });

    if (
      typeof window === "undefined" ||
      typeof window.RTCPeerConnection !== "function"
    ) {
      setPhase({ kind: "failed", failure: "webrtc_unsupported" });
      return;
    }

    let grant;
    try {
      grant = await issueControllerDisplayAttach(workspaceId, session.id);
    } catch (error) {
      const failure = classifyControlGrantFailure(error);
      // A refusal the server SPELLED (403/409/404) opened nothing, so there is
      // nothing to close. `server_unreachable` is the one that cannot be ruled
      // out: a request that never came back may still have committed, and a
      // window nobody knows about is exactly what H-1 is about. The return is
      // idempotent, so the cost of being wrong here is one 200 saying
      // `closed: false`.
      if (failure === "server_unreachable") abandonWindow();
      if (runRef.current !== run) return;
      setPhase({ kind: "failed", failure });
      return;
    }
    // The window is OPEN from here on: the server minted the grant and stopped
    // the agent in the same call. Every exit below therefore has to close it —
    // INCLUDING the exit where this attempt is no longer the current one.
    if (runRef.current !== run) {
      abandonWindow();
      return;
    }
    if (grant.mode !== DISPLAY_CONTROLLER_MODE) {
      // The server answered with a grade this surface did not ask for. Nothing
      // was stopped, so there is nothing to return.
      setPhase({ kind: "failed", failure: "signal_invalid" });
      return;
    }
    const url = attachSocketUrl(grant.display_endpoint);
    if (url === null || !isValidDisplayId(grant.display_id)) {
      void endControl(autoReturnFor({ kind: "negotiate_deadline" }));
      return;
    }

    setPhase({ kind: "connecting" });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, displaySubprotocols(grant.capability_token));
    } catch {
      void endControl(
        autoReturnFor({ kind: "socket_closed", offered: false, sessionGone: false })
      );
      return;
    }
    socketRef.current = socket;
    let opened = false;
    let offered = false;
    const pendingCandidates: RTCIceCandidateInit[] = [];
    let remoteDescriptionSet = false;
    const addCandidate = (init: RTCIceCandidateInit) => {
      const peer = peerRef.current;
      if (!peer || !remoteDescriptionSet) {
        pendingCandidates.push(init);
        return;
      }
      void peer.addIceCandidate(init).catch(() => {
        /* one path lost, not the negotiation */
      });
    };

    /**
     * A failure BEFORE the window can be blamed on the wire alone.
     *
     * It still returns control, because the window is open either way: the
     * grant that failed to become a stream stopped the agent when it was
     * minted. The failure sentence and the return notice are both true, and the
     * return is what the reader cares about, so the return wins the surface.
     */
    const give = (event: ControlLifecycleEvent) => {
      if (runRef.current !== run) return;
      void endControl(autoReturnFor(event));
    };

    const deadline = window.setTimeout(() => {
      if (runRef.current !== run || opened) return;
      give({ kind: "socket_closed", offered: false, sessionGone: false });
    }, HOST_CONNECT_TIMEOUT_MS);

    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (runRef.current !== run || opened) return;
      if (!cspBlockedHost(event, url)) return;
      // A policy is not something a retry changes, and the agent is stopped
      // right now. Return first; the banner is the observer surface's job when
      // the reader tries to watch instead.
      give({ kind: "socket_closed", offered: false, sessionGone: false });
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const done = () => {
      if (connectCleanupRef.current === done) connectCleanupRef.current = null;
      window.clearTimeout(deadline);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };
    connectCleanupRef.current = done;

    const answerOffer = async (sdp: string) => {
      // The MIRROR of the viewer's check, and the reason both exist. There, a
      // datachannel in the offer breaks the guarantee. Here, its ABSENCE breaks
      // the grant: the server said controller, and a producer that offers no
      // way in has served a screen this person cannot type into. Neither
      // surface renders a stream whose input rights disagree with its paperwork.
      if (!sdpNegotiatesInput(sdp)) {
        give({ kind: "no_input_channel" });
        return;
      }
      if (!sdpCarriesVideo(sdp)) {
        give({ kind: "producer_error" });
        return;
      }
      const peer = new window.RTCPeerConnection({
        // The server's per-session relay credential wins whenever it is there.
        // An EMPTY array is not an error and not a fallback failure: it means
        // this instance was given no relay policy, and the openapi says in
        // those words that a client must read it as "use what you already
        // have". What this client already has is the empty configuration
        // ADR-0165 D3 shipped.
        iceServers:
          grant.ice_servers.length > 0 ? grant.ice_servers : DISPLAY_ICE_SERVERS,
      });
      peerRef.current = peer;
      peer.ontrack = (event: RTCTrackEvent) => {
        if (runRef.current !== run) return;
        // The stream is KEPT, not just attached (measured in the gate).
        //
        // `ontrack` can arrive before React has committed the render that
        // creates the `<video>`: the phase moves to `negotiating` in a socket
        // handler and the offer answer runs through several microtasks after
        // it, so on a fast producer the element is still one commit away. The
        // first version dropped the track in that window and never got another
        // one — the surface then said 조작 중 over a permanently black frame,
        // with the keyboard working. Holding the stream lets the effect below
        // attach it the moment the element exists.
        streamRef.current = event.streams[0] ?? new MediaStream([event.track]);
        attachStream();
        setReceived(true);
      };
      // THE INPUT CHANNEL ARRIVES; IT IS NOT REQUESTED. See the header.
      peer.ondatachannel = (event: RTCDataChannelEvent) => {
        if (runRef.current !== run) return;
        const channel = event.channel;
        if (channel.label !== CONTROL_INPUT_CHANNEL_LABEL) {
          // A channel this client has no contract for is a channel it will not
          // send on. Closing it rather than ignoring it keeps the producer from
          // waiting on a peer that will never speak.
          channel.close();
          return;
        }
        channelRef.current = channel;
        channel.onopen = () => {
          if (runRef.current !== run) return;
          if (negotiateTimerRef.current !== null) {
            window.clearTimeout(negotiateTimerRef.current);
            negotiateTimerRef.current = null;
          }
          setPhase({ kind: "controlling" });
        };
        channel.onclose = () => {
          if (runRef.current !== run) return;
          channelRef.current = null;
          give({ kind: "channel_closed" });
        };
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
        // NOT a transition to 조작 중. Media being up is not a keyboard being
        // up: this surface only claims control when the input channel is open,
        // because the whole failure it exists against is a person typing into a
        // window that looks live and delivers nothing.
        if (peer.connectionState === "failed") give({ kind: "peer_failed" });
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
        give({ kind: "producer_error" });
      }
    };

    socket.onopen = () => {
      done();
      if (runRef.current !== run) return;
      opened = true;
      setPhase({ kind: "negotiating" });
      // THE auto-return DEADLINE. It covers the whole leg from an open socket
      // to a usable keyboard, and it is shorter than the server's lease on
      // purpose: a client that gave up after the lease would be reporting a
      // failure about a window that had already closed itself.
      negotiateTimerRef.current = window.setTimeout(() => {
        if (runRef.current !== run) return;
        give({ kind: "negotiate_deadline" });
      }, CONTROL_NEGOTIATE_TIMEOUT_MS);
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (runRef.current !== run) return;
      if (typeof event.data !== "string") return;
      const frame = classifyProducerFrame(event.data);
      switch (frame.kind) {
        case "ready":
          if (frame.mode !== DISPLAY_CONTROLLER_MODE) {
            give({ kind: "no_input_channel" });
            return;
          }
          // The producer's own statement that its validate said yes. A
          // controller grant with `input_enabled: false` is a producer that
          // disagrees with the server about who is holding this session, and
          // the disagreement is worth returning on rather than typing through.
          if (!frame.inputEnabled) give({ kind: "no_input_channel" });
          return;
        case "offer":
          offered = true;
          void answerOffer(frame.sdp);
          return;
        case "ice":
          if (frame.candidate === "") return;
          addCandidate({
            candidate: frame.candidate,
            sdpMid: frame.sdpMid,
            sdpMLineIndex: frame.sdpMLineIndex,
          });
          return;
        case "error":
          give({ kind: "producer_error" });
          return;
        default:
          return;
      }
    };
    socket.onclose = (event: CloseEvent) => {
      done();
      if (runRef.current !== run) return;
      socketRef.current = null;
      // The close classifier still runs, and its verdict is deliberately NOT
      // put on screen: whatever the code says, the fact this reader needs is
      // that their agent is coming back. The classification survives as the
      // reason the surface distinguishes a producer that never offered from one
      // that went away mid-control.
      const closed = classifyClose({
        opened,
        code: event.code,
        reason: event.reason,
      });
      give({
        kind: "socket_closed",
        offered,
        sessionGone: closed === "session_ended" || closed === "host_revoked",
      });
    };
    socket.onerror = () => {};
  }, [abandonWindow, attachStream, endControl, session.id, teardown, workspaceId]);

  // Taking control is what this component is FOR. It is mounted by a deliberate
  // act on the surface above (never by a link, never by a render), so starting
  // on mount is the honest reading of that act rather than an automatic one.
  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ledger revoking underneath a held keyboard. The producer re-validates
  // its own bearer for the other half; both are needed, because the producer's
  // clock is not this reader's.
  const revoked = displayObservationStillPermits(session, true);
  const holding =
    phase.kind === "connecting" ||
    phase.kind === "negotiating" ||
    phase.kind === "controlling";
  useEffect(() => {
    if (!holding || revoked === null) return;
    void endControl(autoReturnFor({ kind: "ledger_revoked" }));
  }, [endControl, holding, revoked]);

  // The 재검증 loop, the same one the viewer runs and for the same reason: a
  // hidden tab is exactly where a stream runs on with nobody re-reading the
  // ledger behind it.
  useEffect(() => {
    if (!holding) return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: ["work-sessions", workspaceId],
      });
    }, DISPLAY_REVERIFY_MS);
    return () => window.clearInterval(timer);
  }, [holding, queryClient, workspaceId]);

  // Leaving with the keyboard still held is the one exit that MUST return
  // control: a person who navigated away is a person who is not coming back to
  // press anything, and the agent would sit stopped until the lease lapsed.
  useEffect(
    () => () => {
      runRef.current += 1;
      if (!returnedRef.current) {
        returnedRef.current = true;
        void returnDisplayControl(workspaceId, session.id).catch(() => {
          /* the lease is the backstop; there is no surface left to tell */
        });
      }
      teardown(true);
    },
    [session.id, teardown, workspaceId]
  );

  const controlling = phase.kind === "controlling";
  // The other side of the ontrack race: the element appearing after the track
  // did. `attachStream` is a no-op when there is nothing held or nothing to
  // hold it, so this runs on every phase change and costs nothing.
  useEffect(() => {
    attachStream();
  }, [attachStream, phase.kind]);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * The control that ends the window, held so the release key can reach it.
   *
   * Escape moves the caret HERE rather than merely blurring the capture box
   * (design-review B-1). Blurring alone would drop focus on `<body>`, and the
   * reader who pressed Escape to get out would then have to tab from the top of
   * the document to find the way back — which is the same trap one step later.
   */
  const returnButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * The capture surface actually holds the caret.
   *
   * STATE, not a ref, because the screen changes with it: a window that is open
   * while the keyboard is somewhere else is a true state that used to be drawn
   * as 조작 중 (design-review H-2).
   */
  const [capturing, setCapturing] = useState(false);
  // The keyboard has to land somewhere, and a person who just pressed 직접 조작
  // should not have to hunt for the box that receives it.
  useEffect(() => {
    if (controlling) surfaceRef.current?.focus();
  }, [controlling]);

  const busyCopy =
    phase.kind === "issuing" || phase.kind === "connecting" || phase.kind === "negotiating"
      ? CONTROL_PHASE_COPY.connecting
      : phase.kind === "returning"
        ? CONTROL_PHASE_COPY.returning
        : null;
  // 반환 중에는 프레임이 서지 않는다. 그때 스트림은 이미 내려갔고, 남는 것은
  // 빈 사각형과 **누르면 아무 일도 일어나지 않는 반환 버튼**이다 — 사고가 아니라
  // 살아 있어 보이는 죽은 컨트롤이고, 이 레포가 어포던스 거짓말이라고 부르는 바로
  // 그것이다. 화면을 내리면 그 자리에 남는 것은 참인 한 문장뿐이다.
  const showFrame =
    phase.kind === "connecting" ||
    phase.kind === "negotiating" ||
    phase.kind === "controlling";
  // 에이전트는 반환이 서버에 닿을 때까지 여전히 멈춰 있다. 그래서 이 문장은
  // 프레임보다 오래 서 있어야 한다.
  const showActiveDetail = showFrame || phase.kind === "returning";
  const Heading = headingLevel === 3 ? "h3" : "h4";

  // ---- input capture --------------------------------------------------------
  //
  // Every handler below is the same three lines: read the event, hand it to the
  // forwarder, drop the outcome. `void` rather than a variable is the point —
  // there is nowhere for the outcome to be stored, and the outcome could not
  // carry a keystroke anyway (`ControlSendOutcome` is three words).

  const onKey = (event: React.KeyboardEvent, action: "down" | "up") => {
    // EVERY key this surface sees stops here (design-review B-1, measured).
    //
    // The work panel's own `<aside>` answers Escape by stepping back out of the
    // session detail, and it is an ancestor of this box — so the first draft of
    // the release key closed the whole detail instead, dropping the caret on a
    // session row and unmounting the control surface mid-window. Any ancestor
    // shortcut is the same bug in a different costume: while the keyboard is
    // captured, these presses are the VM's, and an app that also acted on them
    // would be typing into two machines at once.
    //
    // It is scoped by focus rather than by a flag: this handler only runs while
    // the caret is inside the capture box, so Escape goes back to closing the
    // detail the moment the keyboard leaves.
    event.stopPropagation();
    // Judged per PRESS, not per event (#1563): the keydown decides, and this
    // event's keyup follows that decision even if the modifiers have changed
    // under it. Handing a bare event to this function was how a Shift+Escape
    // whose Shift was lifted first left the host holding Escape forever.
    const disposition = dispositionForKey(
      {
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
      },
      action,
      keyPressesRef.current
    );
    if (disposition.kind === "ignore") {
      // A key whose press this surface never saw. Nothing was sent for it, so
      // nothing is sent now and the page's own default stands.
      return;
    }
    if (disposition.kind === "release") {
      // The one key that is not a keystroke here. It is answered on keydown
      // only — moving the caret on keyup as well would fire twice for one press
      // and fight whatever the first move landed on.
      event.preventDefault();
      if (action === "down") returnButtonRef.current?.focus();
      return;
    }
    if (disposition.preventDefault) event.preventDefault();
    void forwardKey(channelRef.current, disposition.event, action);
  };

  const pointFor = (event: React.MouseEvent) => {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return null;
    return normalisedPoint(event.clientX, event.clientY, box);
  };

  return (
    <section
      className="border-b border-line px-4 py-2"
      data-testid="work-control"
      data-phase={phase.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading className="min-w-0 flex-1 text-meta text-ink-muted">
          직접 조작
        </Heading>
        {controlling && (
          /* 기하는 CHIP_CLASS 다 (design-review M1). 손으로 적은 앞 판은
             `font-medium` 하나가 빠져 옆 블록의 칩들보다 가늘었다 — 한 화면에서
             같은 격의 칩이 두 굵기로 서면, 다른 것을 뜻한다고 읽힌다.

             낱말은 **캐럿이 어디 있는지**를 따라간다 (design-review H-2). 창이
             열려 있는 것과 키보드가 여기 있는 것은 다른 사실이고, 앞 판은 둘을
             한 낱말로 그려서 프레임 밖을 누른 사람에게 계속 「조작 중」이라고
             말했다. */
          <span
            className={cn(
              CHIP_CLASS,
              capturing
                ? "bg-accent-soft text-accent"
                : "bg-surface-hover text-warn"
            )}
            data-testid="work-control-grade"
            data-capturing={capturing ? "" : undefined}
          >
            {capturing
              ? CONTROL_PHASE_COPY.controlling
              : CONTROL_KEYBOARD_LOST_LABEL}
          </span>
        )}
      </div>

      {busyCopy !== null && (
        <p
          role="status"
          className="flex items-center gap-2 break-keep pt-1 text-meta text-ink-muted"
          data-testid="work-control-busy"
        >
          <Loader2 aria-hidden="true" className="spinner-busy size-4" />
          {busyCopy}
        </p>
      )}

      {phase.kind === "failed" && (
        <div className="-mx-4 pt-1">
          <InlineBanner
            tone="error"
            message={controlFailureCopy(phase.failure, displayFailureCopy)}
            {...(controlOffersRetry(
              phase.failure,
              controlAffordance(session, true)
            )
              ? { actionLabel: "다시 시도", onAction: () => void start() }
              : {})}
            testId="work-control-error"
          />
          <div className="px-4 pb-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDone}
              data-testid="work-control-dismiss"
            >
              관전으로 돌아가기
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "return_failed" && (
        <div className="-mx-4 pt-1">
          {/* neutral 이다. 이 프리미티브는 두 격만 알고(error·neutral) 이것은
              error 가 아니다: 사람이 고칠 것이 없고, 서버가 이미 마무리하고
              있으며, 사고가 아니라 시간의 문제다. error 를 입히면 role="alert"
              가 붙어 보조기술이 「지금 고쳐야 할 것」으로 읽는다. 옆에 다시 누를
              버튼도 두지 않는다: 방금 실패한 그 호출을 한 번 더 하라고 권하는
              것이 되고, backstop 은 도움이 필요 없다. */}
          <InlineBanner
            tone="neutral"
            message={CONTROL_RETURN_FAILED_COPY}
            testId="work-control-return-failed"
          />
          <div className="px-4 pb-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDone}
              data-testid="work-control-dismiss"
            >
              관전으로 돌아가기
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "returned" && (
        <div className="flex flex-col items-start gap-2 pt-1">
          <p
            className="break-keep text-meta text-ink-muted"
            data-testid="work-control-returned"
          >
            {CONTROL_RETURN_COPY[phase.reason]}
            {phase.observationNote !== null && ` ${phase.observationNote}`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDone}
            data-testid="work-control-dismiss"
          >
            관전으로 돌아가기
          </Button>
        </div>
      )}

      {showFrame && (
        <div className="pt-2">
          {/* The capture surface IS the frame's wrapper rather than a layer over
              it. A separate overlay would put a transparent element between the
              reader and the picture, and the first bug that follows is a click
              that lands on the wrong one. `tabIndex` because a div receives no
              keys otherwise, and a visible ring because a surface that is
              swallowing the keyboard must show that it has it. */}
          <div
            ref={surfaceRef}
            tabIndex={controlling ? 0 : -1}
            role="application"
            aria-label="세션 호스트 화면, 직접 조작"
            data-testid="work-control-surface"
            data-capturing={capturing ? "" : undefined}
            /* 링이 `focus-visible` 전용이었다 (design-review H-2): 마우스로 잡은
               캐럿은 아무 표시도 남기지 않아, 키보드를 가진 상자와 안 가진 상자가
               똑같이 생겼다. 이 표면에서 캐럿의 위치는 장식이 아니라 **키가 어디로
               가는가**이므로, 어떻게 잡았든 보여야 한다. `focus-visible` 규율을
               어기는 것이 아니라 그것이 답하는 질문이 다르다. */
            className={cn(
              "aspect-video overflow-hidden rounded-sm border bg-surface-raised focus:focus-ring",
              capturing ? "border-accent" : "border-line"
            )}
            onFocus={() => setCapturing(true)}
            onBlur={() => setCapturing(false)}
            onKeyDown={(event) => onKey(event, "down")}
            onKeyUp={(event) => onKey(event, "up")}
            onMouseMove={(event) => {
              const point = pointFor(event);
              if (point !== null) void forwardPointer(channelRef.current, point, "move");
            }}
            onMouseDown={(event) => {
              const point = pointFor(event);
              if (point === null) return;
              void forwardPointer(
                channelRef.current,
                { ...point, button: event.button },
                "down"
              );
            }}
            onMouseUp={(event) => {
              const point = pointFor(event);
              if (point === null) return;
              void forwardPointer(
                channelRef.current,
                { ...point, button: event.button },
                "up"
              );
            }}
            onWheel={(event) => {
              void forwardWheel(channelRef.current, event.deltaX, event.deltaY);
            }}
            onContextMenu={(event) => {
              // The browser's own menu over a remote desktop is a menu about the
              // wrong machine, and it steals the right-click the VM was meant to
              // get.
              event.preventDefault();
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              disablePictureInPicture
              className="pointer-events-none size-full object-contain"
              aria-hidden="true"
              data-testid="work-control-video"
            />
          </div>

          {/* 「조작 중」은 위 칩이 이미 말했다. 여기 서는 것은 칩이 말할 수 없는
              한 가지뿐이다: 키보드는 잡았는데 **아직 화면이 오지 않았다**. 그
              둘은 다른 사실이고, 둘을 한 낱말로 그리면 사람은 검은 사각형 앞에서
              자기 키가 가고 있는지 알 수 없다. 화면이 도착하면 이 줄은 사라진다 —
              그때는 그림 자체가 증거이고, 같은 사실을 두 번 말하는 카드는 두 가지가
              일어났다고 읽힌다. */}
          {controlling && !received && (
            <p
              role="status"
              className="break-keep pt-1 text-meta text-warn"
              data-testid="work-control-state"
            >
              키보드는 연결됐지만 아직 화면이 도착하지 않았습니다.
            </p>
          )}
          {controlling && (
            <p
              className="break-keep pt-1 text-meta text-ink-muted"
              data-testid="work-control-capture-limit"
            >
              {CONTROL_CAPTURE_LIMIT_COPY}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              ref={returnButtonRef}
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void endControl(autoReturnFor({ kind: "person_returned" }))
              }
              data-testid="work-control-return"
            >
              {CONTROL_RETURN_LABEL}
            </Button>
            {hostName !== null && (
              <span className="text-meta text-ink-muted">{hostName}</span>
            )}
          </div>

          {/* 컨트롤 **아래**에 선다, 위가 아니라 (실측). 위에 두었더니 캐럿이
              화면을 떠나는 순간 이 줄이 생기면서 바로 아래의 화면 돌려주기가
              내려갔다 — 그리고 캐럿이 떠나는 가장 흔한 이유가 그 버튼을 누르는
              것이다. 누르려는 컨트롤이 누르는 순간 손 밑에서 움직이는 것은
              게이트가 클릭을 놓친 이유이기도 했고, 사람에게는 그냥 안 눌리는
              버튼이다. 안내는 컨트롤을 밀지 않는다. */}
          {controlling && !capturing && (
            <p
              role="status"
              className="break-keep pt-1 text-meta text-warn"
              data-testid="work-control-keyboard-lost"
            >
              {CONTROL_KEYBOARD_LOST_COPY}
            </p>
          )}
        </div>
      )}

      {/* 프레임보다 오래 사는 한 문장. 반환이 서버에 닿을 때까지 에이전트는
          여전히 멈춰 있고, 사람이 가장 먼저 묻는 것이 그것이다. */}
      {showActiveDetail && (
        <p
          className="break-keep pt-1 text-meta text-ink-muted"
          data-testid="work-control-active-detail"
        >
          {CONTROL_ACTIVE_DETAIL}
        </p>
      )}
    </section>
  );
}

/**
 * The invitation, on the viewer surface.
 *
 * It lives HERE rather than in `DisplayObserver` so that every string about
 * control, and the decision about who is offered it, is in the pair of files a
 * reviewer reads for control. The observer component renders this and knows
 * nothing else about the subject.
 *
 * NO DISABLED STATE. When `controlAffordance` says no, this returns either a
 * sentence or nothing at all, and never a button that cannot act (LIVE-4
 * 어포던스 부재). The confirmation step is not decoration either: pressing this
 * stops somebody's agent, and a one-press path to that is how a person who
 * wanted a closer look ends up halting a run.
 */
export function ControlInvite({
  session,
  isOwner,
  armed,
  onArm,
  onStart,
}: {
  session: WorkSession;
  isOwner: boolean;
  armed: boolean;
  onArm: (armed: boolean) => void;
  onStart: () => void;
}) {
  const affordance = controlAffordance(session, isOwner);
  if (!affordance.offered) {
    return affordance.note === null ? null : (
      <p
        className="break-keep pt-2 text-meta text-ink-muted"
        data-testid="work-control-blocked"
      >
        {affordance.note}
      </p>
    );
  }
  if (!armed) {
    return (
      <div className="pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onArm(true)}
          data-testid="work-control-start"
        >
          {CONTROL_START_LABEL}
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col items-start gap-2 pt-2"
      data-testid="work-control-confirm"
    >
      <p className="break-keep text-meta text-ink-muted">{CONTROL_INVITE_COPY}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onStart}
          data-testid="work-control-confirm-start"
        >
          {CONTROL_START_LABEL}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onArm(false)}
          data-testid="work-control-confirm-cancel"
        >
          그만두기
        </Button>
      </div>
    </div>
  );
}
