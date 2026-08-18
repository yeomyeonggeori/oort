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
import {
  autoReturnFor,
  classifyControlGrantFailure,
  controlAffordance,
  controlFailureCopy,
  controlObservationRestoredNote,
  controlOffersRetry,
  controlSwallowsKey,
  forwardKey,
  forwardPointer,
  forwardWheel,
  normalisedPoint,
  CONTROL_ACTIVE_DETAIL,
  CONTROL_CAPTURE_LIMIT_COPY,
  CONTROL_INPUT_CHANNEL_LABEL,
  CONTROL_INVITE_COPY,
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

  const teardown = useCallback((saidBye: boolean) => {
    const connectCleanup = connectCleanupRef.current;
    connectCleanupRef.current = null;
    connectCleanup?.();
    if (negotiateTimerRef.current !== null) {
      window.clearTimeout(negotiateTimerRef.current);
      negotiateTimerRef.current = null;
    }
    channelRef.current = null;
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
      if (runRef.current !== run) return;
      setPhase({ kind: "failed", failure: classifyControlGrantFailure(error) });
      return;
    }
    if (runRef.current !== run) return;
    // The window is OPEN from here on: the server minted the grant and stopped
    // the agent in the same call. Every exit below therefore has to close it,
    // which is why `returnedRef` is armed and not merely available.
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
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void video.play().catch(() => {});
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
  }, [endControl, session.id, teardown, workspaceId]);

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
  const surfaceRef = useRef<HTMLDivElement>(null);
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
    const descriptor = {
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
    };
    if (controlSwallowsKey(descriptor)) event.preventDefault();
    void forwardKey(channelRef.current, descriptor, action);
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
          <span
            className="shrink-0 rounded-sm bg-accent-soft px-2 py-px text-timestamp text-accent"
            data-testid="work-control-grade"
          >
            {CONTROL_PHASE_COPY.controlling}
          </span>
        )}
      </div>

      {busyCopy !== null && (
        <p
          role="status"
          className="flex items-center gap-2 pt-1 text-meta text-ink-muted"
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
          <p className="text-meta text-ink-muted" data-testid="work-control-returned">
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
            className="aspect-video overflow-hidden rounded-sm border border-line bg-surface-raised focus-visible:focus-ring"
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
              className="pt-1 text-meta text-warn"
              data-testid="work-control-state"
            >
              키보드는 연결됐지만 아직 화면이 도착하지 않았습니다.
            </p>
          )}
          {controlling && (
            <p
              className="pt-1 text-meta text-ink-muted"
              data-testid="work-control-capture-limit"
            >
              {CONTROL_CAPTURE_LIMIT_COPY}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
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
        </div>
      )}

      {/* 프레임보다 오래 사는 한 문장. 반환이 서버에 닿을 때까지 에이전트는
          여전히 멈춰 있고, 사람이 가장 먼저 묻는 것이 그것이다. */}
      {showActiveDetail && (
        <p
          className="pt-1 text-meta text-ink-muted"
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
      <p className="pt-2 text-meta text-ink-muted" data-testid="work-control-blocked">
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
      <p className="text-meta text-ink-muted">{CONTROL_INVITE_COPY}</p>
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
