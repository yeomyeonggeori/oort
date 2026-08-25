import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { subscribeTheme } from "@/design/theme";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import {
  issueObserverTerminalAttach,
  setWorkSessionObservation,
  uuidEq,
  type WorkSession,
} from "@momo/core/lib/api";
import { InlineBanner } from "@/features/common/States";
import {
  attachSocketUrl,
  canChangeObservation,
  classifyClose,
  classifyGrantFailure,
  classifyHostFrame,
  connectFrame,
  cspBlockedHost,
  HOST_COLUMNS,
  HOST_CONNECT_TIMEOUT_MS,
  isValidPtyId,
  newlineCount,
  observationStillPermits,
  observerCountLabel,
  observerFailureCopy,
  observerLink,
  observerSubprotocols,
  observeGate,
  offersReload,
  offersRetry,
  quietLabel,
  terminalOwnsKey,
  OBSERVER_COUNT_NOTE,
  OBSERVER_LINK_NOTE,
  OBSERVER_LINK_STATUS,
  type ObserverFailure,
} from "./observerStream";
import type { ITheme, Terminal } from "./terminalRuntime";

// =============================================================================
// 터미널 관전 (AX-3 / MOMO-619, ADR-0126 D1): the session's stdout, live, in a
// terminal that cannot type back.
//
// THE ONE THING THIS SURFACE MUST NEVER DO is look connected when it is not.
// A terminal is the most convincing "live" object in a product: black box,
// monospace, a cursor. MOMO-618 R2 already caught this client blinking a caret
// under text that had stopped arriving, and the fix there was to bind the
// caret to a fact the client can actually observe. The same rule, harder, here:
//
//   - 관전 중 is shown only while the WebSocket is OPEN, the browser reports a
//     network, and nothing says the connection has been cut under it. Not while
//     it is connecting, not after a close, never from the ledger. An OPEN socket
//     alone was not enough: R2 H1 measured the network dropped under a live
//     stream, no `onclose` ever arrived, and 관전 중 froze for as long as the
//     emulator would run while the panel above it said the opposite. What can be
//     observed honestly is `navigator.onLine` and the age of the last byte, so
//     that is what the claim is bound to (observerStream.observerLink).
//   - the running byte count under the terminal is the honest liveness signal:
//     it moves exactly as fast as bytes arrive and stops dead when they stop.
//     There is no caret, no pulse and no shimmer over a dead socket. When it
//     stops for more than QUIET_AFTER_MS the surface says so in words, because a
//     number that stopped moving is only legible to someone who was watching it.
//   - a live socket is not the same claim as a live SCREEN. Scrolling back
//     freezes the viewport while bytes keep arriving, so the panel says so and
//     offers the way back to the tail (R1 M1).
//   - the cursor is off (`cursorInactiveStyle: "none"`). A blinking block in a
//     disconnected terminal is a claim that a process is waiting for you.
//   - every disconnect names its own cause (observerStream.ObserverFailure) and
//     leaves the received output on screen, because what arrived was real. So
//     does 관전 중단: R2 M1 caught the reader's own stop erasing the transcript
//     the same code kept across a crash, and a stop button is an instruction
//     about the stream, not about what is already on screen.
//   - a failure is never a terminus. While the ledger still permits watching,
//     there is always a control that starts it again (R1 H1), including the one
//     failure that needs a new document rather than a new socket (R2 M4).
//   - a frame with nothing in it is not kept: a connection that failed before a
//     single byte arrived hides the terminal instead of drawing an empty box and
//     explaining that its scroll and copy work (R2 M6).
//
// READ-ONLY, TWICE. The capability is `observer`, so the server issues stdout
// rights only and the host re-validates that grade. On this side there is no
// encoder for send_stdin/resize/kill at all (observerStream.ts), the terminal
// runs with `disableStdin`, and nothing is ever registered on `onData`. Focus
// still works, because copying and scrolling are the point, and Tab and Escape
// still belong to the browser (`terminalOwnsKey`), because a surface you cannot
// leave with the keyboard is not read-only, it is a trap.
//
// COLOR. xterm needs literal colors in JS, which is exactly what the token
// system forbids in a component (design-taste-web §2). So the theme is READ off
// the DOM: two probe elements carry token utility classes, and their computed
// values are handed to xterm. Nothing is restated, `light-dark()` resolves in
// the browser, and a scheme change re-reads it.
// =============================================================================

/** One encoder for the life of the module: a new one per frame is per-byte waste. */
const TEXT_ENCODER = new TextEncoder();

/** ANSI colors are the program's own vocabulary; xterm's defaults stay. */
type TerminalTheme = Pick<
  ITheme,
  "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground"
>;

function readTheme(surface: HTMLElement, selection: HTMLElement): TerminalTheme {
  const surfaceStyle = getComputedStyle(surface);
  const selectionStyle = getComputedStyle(selection);
  return {
    background: surfaceStyle.backgroundColor,
    foreground: surfaceStyle.color,
    // The cursor is painted in the BACKGROUND colour, which is how you turn it
    // off in xterm: `cursorInactiveStyle: "none"` only covers the unfocused
    // terminal, and this one is focusable on purpose (copy, scroll). Measured
    // on momowebqa 2026-07-26: clicking into the terminal drew a solid block
    // cursor under the last line, which in a surface that cannot accept a
    // keystroke is a prompt claiming to wait for you.
    cursor: surfaceStyle.backgroundColor,
    // And `cursorAccent` is the GLYPH inside that block, whose xterm default is
    // pure black. An invisible block over an empty cell hid that; over a cell
    // with a character in it the character itself was repainted (R1 N1,
    // measured on `.xterm-cursor-block` in both schemes), which deletes it in
    // dark mode and breaks the no-pure-black rule in light (§8). Reading it as
    // the foreground makes the whole cell ordinary again.
    cursorAccent: surfaceStyle.color,
    selectionBackground: selectionStyle.backgroundColor,
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "issuing" }
  | { kind: "connecting" }
  | { kind: "watching" }
  | { kind: "failed"; failure: ObserverFailure };

const PHASE_BUSY_COPY: Readonly<Record<"issuing" | "connecting", string>> = {
  issuing: "관전 권한을 받는 중",
  // 「명사 + 중」 (#1501). `DisplayObserver` 의 같은 표와 글자까지 같아야 한다:
  // 두 관전 패널은 같은 호스트에 같은 걸음으로 붙고, 낱말이 갈리면 같은 사실이
  // 화면마다 다른 말이 된다. 이 일치는 주석 약속이 아니라 단정이다 —
  // displayStream.test.ts 「두 관전 패널의 connecting 낱말은 글자까지 같다」(#1511).
  connecting: "호스트에 연결 중",
};

export function ObserverTerminal({
  session,
  hostName,
  wide,
  onWideChange,
  headingLevel = 4,
  variant = "pane",
}: {
  session: WorkSession;
  hostName: string | null;
  /** The pane is showing at full surface width (WorkPanel owns the state). */
  wide: boolean;
  onWideChange: (wide: boolean) => void;
  /** Follows the WorkSessionDetail heading in its route or panel context. */
  headingLevel?: 2 | 3 | 4;
  /**
   * `dock` is the channel-bottom terminal (#1758). Same observer stream, no
   * stdin. The box fills the dock instead of a fixed 320px pane body, and it
   * drops the pane hairline that would double the dock's own border.
   */
  variant?: "pane" | "dock";
}) {
  const { session: auth, workspaceId } = useSession();
  const queryClient = useQueryClient();
  const isOwner = uuidEq(session.memberId, auth.member.id);
  const gate = observeGate(session, isOwner);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /**
   * Bytes received, counted in a ref and published twice a second.
   *
   * The count is the honest liveness signal on this surface, so it has to move;
   * it does not have to move at the speed of a pty. A host that prints a
   * megabyte a second would otherwise re-render this tree tens of thousands of
   * times per second to redraw a number nobody can read that fast, and the
   * terminal itself (which xterm paints on its own schedule) would be competing
   * with React for the frame.
   */
  const [bytes, setBytes] = useState(0);
  const bytesRef = useRef(0);
  const [lines, setLines] = useState(0);
  const linesRef = useRef(0);
  /**
   * Whether a single byte has ever arrived on THIS attempt.
   *
   * It decides two different things and both are about not lying with a box:
   * the terminal is kept on screen after 관전 중단 because there is something in
   * it (R2 M1), and it is not drawn at all after a failure that received
   * nothing, where the frame plus its "복사와 스크롤은 그대로 됩니다" caption
   * described a terminal that never existed (R2 M6).
   */
  const [received, setReceived] = useState(false);
  const receivedRef = useRef(false);
  /** Seconds since the last byte, published while watching. */
  const [quietSeconds, setQuietSeconds] = useState(0);
  const lastByteAtRef = useRef(0);
  /** The browser reported an outage and nothing has arrived since. */
  const [doubted, setDoubted] = useState(false);
  const doubtedRef = useRef(false);
  /** Lines arrived since the reader scrolled off the tail, 0 while pinned. */
  const [behind, setBehind] = useState(0);
  const tailAnchorRef = useRef<number | null>(null);
  /** Columns this viewport can show, straight off xterm after every fit. */
  const [columns, setColumns] = useState(HOST_COLUMNS);
  /** The failed body hugs its output instead of holding a 320px empty band. */
  const [bodyFitsContent, setBodyFitsContent] = useState(false);
  const [scopePending, setScopePending] =
    useState<WorkSession["observation"] | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  /**
   * The browser's own verdict on whether it has a network at all.
   *
   * `navigator.onLine` is a weak signal for "can I reach that host" and a strong
   * one for the opposite: false means no socket on this page is going anywhere,
   * which is exactly the claim 관전 중 must stop making (R2 H1). The momo
   * realtime status (`live`, which WorkPanel already has) is deliberately NOT
   * used for this: it is a socket to a DIFFERENT peer, and a momo relay restart
   * would make this panel announce that a host stream had died while its bytes
   * were still arriving, which is the same false claim pointing the other way.
   */
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine
  );
  /**
   * The pane is already the whole chat surface, so 넓게 보기 cannot widen it.
   * Same 900px breakpoint as tokens.css `work-pane` / `pane-wide-toggle`, read
   * here so the fold notice can say what the reader can actually do (R2 M2).
   */
  const [paneAtWindowWidth, setPaneAtWindowWidth] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const selectionProbeRef = useRef<HTMLSpanElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /**
   * The connecting leg's own cleanup — the handshake deadline and the document
   * listener that catches a CSP refusal — held where `closeSocket` can reach it.
   *
   * It is a ref rather than a local because the two events that used to run it
   * (`onopen`, `onclose`) are the two `closeSocket` deletes first, on purpose: a
   * socket handler that fires during teardown would report a failure the reader
   * has already left behind. So on every OTHER way out of `connecting` — the
   * handshake deadline giving up, 관전 중단, the ledger revoking mid-handshake, a
   * different session arriving in the same mounted panel, the panel unmounting,
   * a retry closing the previous attempt — nothing on the socket fires at all,
   * and a cleanup that lives only in those handlers is a cleanup that never
   * runs. The timer is harmless when it is missed (the generation counter makes
   * it a no-op), but the `document` listener is not: it is attached to a node
   * that outlives this component, so it survives for the life of the tab and a
   * fresh one accumulates behind every retry and every session switch.
   */
  const connectCleanupRef = useRef<(() => void) | null>(null);
  /** Generation counter: an old attempt's callbacks must not touch new state. */
  const runRef = useRef(0);

  /** One byte arrived: the clock restarts and any doubt about the link ends. */
  const markByte = useCallback(() => {
    lastByteAtRef.current = performance.now();
    if (!receivedRef.current) {
      receivedRef.current = true;
      setReceived(true);
    }
    if (doubtedRef.current) {
      doubtedRef.current = false;
      setDoubted(false);
    }
  }, []);

  const closeSocket = useCallback(() => {
    // First, because it is the one thing here that is NOT reachable from the
    // socket: everything below either belongs to this component's own refs or
    // dies with the socket, while the connecting leg hung a listener on the
    // document. It also has to run ahead of the early return an already-null
    // socket takes — an attempt whose socket is gone still has that listener.
    // Running it here is what makes every exit path an exit path.
    const connectCleanup = connectCleanupRef.current;
    connectCleanupRef.current = null;
    connectCleanup?.();
    const socket = socketRef.current;
    socketRef.current = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }, []);

  /**
   * How far the viewport is from the tail, recomputed from the buffer itself.
   *
   * The question a reader needs answered is not "did you scroll" but "is what
   * is on screen the newest thing that arrived", and only the buffer knows:
   * `viewportY` is where the window sits and `baseY` is where the tail is. The
   * anchor is the line total at the moment the two parted, so the number shown
   * is lines that arrived while looking away, not lines scrolled past.
   */
  const syncTail = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    if (buffer.viewportY >= buffer.baseY) {
      tailAnchorRef.current = null;
      setBehind(0);
      return;
    }
    if (tailAnchorRef.current === null) tailAnchorRef.current = linesRef.current;
    setBehind(Math.max(0, linesRef.current - tailAnchorRef.current));
  }, []);

  // Going back to the tail also hands the caret back to the terminal: this
  // control removes itself the moment it works, and a keyboard reader who
  // pressed it would otherwise be left standing on nothing (the house rule
  // WorkPanel states for every step in and out of the pane).
  const jumpToTail = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToBottom();
    terminal.focus();
    syncTail();
  }, [syncTail]);

  // One terminal per mounted panel, created on the first attempt and kept
  // afterwards: the output it already received is history worth keeping on
  // screen while a retry runs.
  const ensureTerminal = useCallback(async (): Promise<Terminal | null> => {
    if (terminalRef.current) return terminalRef.current;
    const mount = mountRef.current;
    const probe = selectionProbeRef.current;
    if (!mount || !probe) return null;
    const runtime = await import("./terminalRuntime");
    if (!mountRef.current) return null;
    const style = getComputedStyle(mount);
    const terminal = new runtime.Terminal({
      // Read-only, stated to the library itself: with stdin disabled xterm
      // neither echoes nor emits key data, so there is no path from a keystroke
      // to `onData` even if one were ever registered.
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      // Type comes from the token scale (the mount carries font-mono text-meta),
      // so the terminal is 12px in the same monospace stack as every other
      // figure in this client instead of xterm's stock 15px sans-adjacent size.
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize),
      scrollback: 5_000,
      theme: readTheme(mount, probe),
    });
    terminal.attachCustomKeyEventHandler(terminalOwnsKey);
    const fit = new runtime.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    // 가로 스크롤은 xterm 의 `.xterm-viewport` 가 한다. 마운트 상자는
    // overflow-hidden 이라 후보가 아니고, 면제 선언은 실제로 끄는 상자에 둔다
    // (#1758 M-2). 하네스는 overflow-x:auto|scroll 상자만 보고 data-scroll-x 를
    // 건너뛴다.
    mount.querySelector(".xterm-viewport")?.setAttribute("data-scroll-x", "");
    // Local geometry only. There is no resize frame in this client, so the HOST
    // pty keeps the size it was created with: fitting changes how many rows this
    // browser draws, never how the host wraps the output it writes. Which is
    // exactly why `columns` is published to the reader (HOST_COLUMNS).
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* the pane can be mid-layout; the next resize event fits again */
      }
    };
    refit();
    refitRef.current = refit;
    terminal.onResize(({ cols }) => setColumns(cols));
    terminal.onWriteParsed(syncTail);
    terminal.onScroll(syncTail);
    setColumns(terminal.cols);
    terminalRef.current = terminal;
    return terminal;
  }, [syncTail]);

  const start = useCallback(async () => {
    // Nothing is cleared here. An attempt that fails before it reaches the host
    // leaves the previous transcript and the counts that describe it on screen,
    // because they are still true; the clearing happens in one place below,
    // beside the `terminal.reset()` that makes them false (R2 M1).
    const run = runRef.current + 1;
    runRef.current = run;
    closeSocket();
    setPhase({ kind: "issuing" });

    let grant;
    try {
      grant = await issueObserverTerminalAttach(workspaceId, session.id);
    } catch (error) {
      if (runRef.current !== run) return;
      setPhase({ kind: "failed", failure: classifyGrantFailure(error) });
      return;
    }
    if (runRef.current !== run) return;

    const url = attachSocketUrl(grant.attach_endpoint);
    if (url === null || !isValidPtyId(grant.pty_id)) {
      setPhase({ kind: "failed", failure: "grant_invalid" });
      return;
    }

    const terminal = await ensureTerminal();
    if (runRef.current !== run) return;
    if (!terminal) {
      setPhase({ kind: "failed", failure: "grant_invalid" });
      return;
    }
    // Reconnect starts from a clean screen. A host replays its scrollback on
    // connect, so writing it under what the previous socket already delivered
    // would duplicate every line and leave a transcript that never happened.
    // The counters go with the screen and not with the attempt: they describe
    // what is visible, so they are zeroed exactly here, where it stops being
    // visible, and never on a retry that failed before reaching the host.
    terminal.reset();
    bytesRef.current = 0;
    linesRef.current = 0;
    tailAnchorRef.current = null;
    receivedRef.current = false;
    doubtedRef.current = false;
    lastByteAtRef.current = performance.now();
    setBytes(0);
    setLines(0);
    setBehind(0);
    setReceived(false);
    setDoubted(false);
    setQuietSeconds(0);

    setPhase({ kind: "connecting" });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, observerSubprotocols(grant.capability_token));
    } catch {
      setPhase({ kind: "failed", failure: "host_unreachable" });
      return;
    }
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let opened = false;

    const give = (failure: ObserverFailure) => {
      runRef.current += 1;
      closeSocket();
      setPhase({ kind: "failed", failure });
    };

    // The handshake gets a deadline, because nothing else will end it: an
    // unroutable host holds CONNECTING until the OS gives up, and a socket the
    // page's own CSP blocks never fires a single event on the socket (see
    // HOST_CONNECT_TIMEOUT_MS). Without this the panel's busy line runs forever.
    const deadline = window.setTimeout(() => {
      if (runRef.current !== run || opened) return;
      give("host_timeout");
    }, HOST_CONNECT_TIMEOUT_MS);

    // The CSP refusal DOES have an event, just not on the socket. Reporting it
    // as "the host did not answer in 15 seconds" was true and useless: the host
    // was never asked, the address is not the problem, and no retry can fix a
    // policy. `document` is the target the spec fires it at.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (runRef.current !== run || opened) return;
      if (!cspBlockedHost(event, url)) return;
      // No clearTimeout here: `give` closes the socket, and closeSocket runs
      // `done`. One place clears this attempt's deadline, so there is no second
      // place to forget to add the next line to.
      give("host_blocked_by_policy");
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    /**
     * End the connecting leg. Idempotent, because it is now reached from both
     * directions: the socket settling, and any close that abandons the attempt
     * before it settled. Removing a listener that is already gone and clearing a
     * timer that already fired are both no-ops, and the ref is only cleared when
     * it is still this attempt's — a newer attempt's cleanup must survive an
     * older one's late `onclose`.
     */
    const done = () => {
      if (connectCleanupRef.current === done) connectCleanupRef.current = null;
      window.clearTimeout(deadline);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };
    connectCleanupRef.current = done;

    socket.onopen = () => {
      done();
      if (runRef.current !== run) return;
      opened = true;
      socket.send(connectFrame(grant.pty_id));
      // The quiet clock starts at the handshake, not at the first byte: a host
      // that accepts the socket and then says nothing is exactly the case the
      // reader needs told, and until something arrives the label counts from
      // here ("14초째 출력 없음").
      lastByteAtRef.current = performance.now();
      setQuietSeconds(0);
      setPhase({ kind: "watching" });
      refitRef.current?.();
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (runRef.current !== run) return;
      const data = event.data;
      if (typeof data === "string") {
        // MOMO-655: the host's replay markers arrive as text frames and are not
        // terminal bytes. Writing one would print JSON into the reader's
        // scrollback at the moment the panel is meant to look like it caught up.
        // They are also not "arrival" for the liveness clock: a marker says the
        // replay ended, not that the agent printed something.
        const frame = classifyHostFrame(data);
        if (frame.kind !== "output") return;
        terminal.write(data);
        bytesRef.current += TEXT_ENCODER.encode(data).length;
        linesRef.current += newlineCount(data);
        markByte();
        return;
      }
      if (data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(data);
        terminal.write(chunk);
        bytesRef.current += chunk.byteLength;
        linesRef.current += newlineCount(chunk);
        markByte();
      }
      // Anything else (a Blob, if binaryType were ever changed) is dropped
      // rather than guessed at: this socket carries pty bytes and nothing else.
    };
    socket.onclose = (event: CloseEvent) => {
      done();
      if (runRef.current !== run) return;
      socketRef.current = null;
      setPhase({
        kind: "failed",
        failure: classifyClose({
          opened,
          code: event.code,
          reason: event.reason,
        }),
      });
    };
    // `error` carries nothing a browser is allowed to describe (a refused TLS
    // handshake, a blocked connect-src and an unroutable host are one event),
    // so the close that always follows is what names the failure.
    socket.onerror = () => {};
  }, [closeSocket, ensureTerminal, markByte, session.id, workspaceId]);

  /**
   * Stop the stream, keep what it delivered.
   *
   * 관전 중단 closes the socket and nothing else: the counters keep their totals
   * and the terminal keeps its scrollback, so the surface reads 연결 없음 over
   * the output that really arrived. It used to unmount the whole block and put
   * the "관전을 시작하면 ..." invitation back, which threw away the only record
   * of what the agent printed on the reader's own click, while the identical
   * bytes were carefully preserved across a crash two paths over (R2 M1).
   */
  const stop = useCallback(() => {
    runRef.current += 1;
    closeSocket();
    setPhase({ kind: "idle" });
  }, [closeSocket]);

  // The socket outlives the server's own revocation: closing observation
  // deletes the capability rows, and ending the session stops the ledger, but
  // neither can reach a socket held between this browser and the host. So the
  // client enforces it, exactly as the mac console does (reconcileObserverAccess).
  const watching = phase.kind === "watching" || phase.kind === "connecting";
  const revoked = observationStillPermits(session);
  useEffect(() => {
    if (!watching || revoked === null) return;
    runRef.current += 1;
    closeSocket();
    setPhase({ kind: "failed", failure: revoked });
  }, [watching, revoked, closeSocket]);

  // ...and when the ledger allows it AGAIN, the failure that quoted the ledger
  // stops being a fact. Without this the panel argued with itself: the owner
  // pressed 팀원 관전 허용 and the toggle flipped while the banner underneath
  // it still read "세션 소유자가 관전을 닫았습니다", with no 관전 시작 anywhere
  // (R1 H1, measured). A reopened gate is a fresh idle surface.
  const gateOpen = gate.available;
  const gateWasOpen = useRef(gateOpen);
  useEffect(() => {
    const reopened = gateOpen && !gateWasOpen.current;
    gateWasOpen.current = gateOpen;
    if (!reopened) return;
    setPhase((current) => (current.kind === "failed" ? { kind: "idle" } : current));
  }, [gateOpen]);

  // The published counters. The cleanup flush is what makes the frozen number
  // under a dropped socket the REAL total rather than whatever the last tick
  // happened to catch.
  useEffect(() => {
    if (phase.kind !== "watching") return;
    const publish = () => {
      setBytes(bytesRef.current);
      setLines(linesRef.current);
      // Whole seconds, so a quiet stream re-renders this tree once a second
      // instead of twice, and a busy one not at all (the value stays 0).
      setQuietSeconds(
        Math.max(0, Math.floor((performance.now() - lastByteAtRef.current) / 1000))
      );
    };
    const timer = window.setInterval(publish, 500);
    return () => {
      window.clearInterval(timer);
      publish();
    };
  }, [phase.kind]);

  // The browser's network verdict. `online` is polled from the events rather
  // than read at render time because `navigator.onLine` is not reactive: without
  // these two listeners the panel would only notice an outage on some unrelated
  // re-render, which on a frozen stream is never (R2 H1).
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Once the browser has said "no network" under a live stream, this socket is
  // unproven until a byte arrives on it, whatever the readyState says.
  useEffect(() => {
    if (online || phase.kind !== "watching" || doubtedRef.current) return;
    doubtedRef.current = true;
    setDoubted(true);
  }, [online, phase.kind]);

  // Which side of the pane breakpoint the window is on (tokens.css work-pane).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(width < 900px)");
    const sync = () => setPaneAtWindowWidth(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /**
   * A dead terminal is as tall as what it holds, not as tall as a live one.
   *
   * 320px is 22 rows at the measured 14px cell, the smallest window in which a
   * command and its output are visible together, and it is the right measure
   * while bytes are arriving. A stream that failed after one line kept the same
   * box and left a 300px empty band under a single sentence (R1 M7, the same
   * regression the diff card had to fix in MOMO-518 R2 H1). xterm sizes its own
   * viewport from its row count, so hugging the content means telling the
   * terminal how many rows it has; the box then follows, because the mount
   * carries no padding for FitAddon to double count (see the frame below).
   * Measured: 320px/22 rows becomes 42px/3 rows for a two line transcript, and
   * the height holds still there instead of chasing its own fit.
   */
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    // Streaming (or about to): the window is worth its full 320px. Stopped or
    // failed: it is worth exactly what it holds. 관전 중단 joined the failure
    // path here in R2 because the stopped surface now KEEPS its output (M1), and
    // a two line transcript under a 320px box is the same empty band by another
    // route.
    if (phase.kind !== "failed" && phase.kind !== "idle") {
      setBodyFitsContent(false);
      refitRef.current?.();
      return;
    }
    const buffer = terminal.buffer.active;
    const used = Math.max(1, buffer.baseY + buffer.cursorY + 1);
    if (used >= terminal.rows) {
      setBodyFitsContent(false);
      return;
    }
    terminal.resize(terminal.cols, used);
    setBodyFitsContent(true);
  }, [phase.kind]);

  // A different session in the same mounted panel is a different stream. The
  // panel unmounts on the way back to the list today, so this is insurance
  // rather than a live path, but the failure it prevents is the worst kind:
  // one session's output under another session's title.
  useEffect(() => {
    runRef.current += 1;
    closeSocket();
    terminalRef.current?.reset();
    bytesRef.current = 0;
    linesRef.current = 0;
    tailAnchorRef.current = null;
    receivedRef.current = false;
    doubtedRef.current = false;
    setBytes(0);
    setLines(0);
    setBehind(0);
    setReceived(false);
    setDoubted(false);
    setQuietSeconds(0);
    setCloseArmed(false);
    setPhase({ kind: "idle" });
  }, [session.id, closeSocket]);

  // Leaving the panel (or switching sessions) drops the stream with it. It goes
  // through `closeSocket` like every other exit rather than closing the socket
  // by hand: doing it by hand left the socket's handlers attached, which made
  // this the one door whose connecting-leg cleanup depended on `onclose`
  // arriving after the component was already gone. `closeSocket` is a stable
  // callback, so this still runs on unmount and nowhere else.
  useEffect(
    () => () => {
      runRef.current += 1;
      closeSocket();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      refitRef.current = null;
    },
    [closeSocket]
  );

  // Scheme changes re-read the tokens rather than restating them. Geometry is
  // watched on the BOX and not on the window, because the box changes without
  // the window: opening the detail, and the 넓게 보기 toggle below, both resize
  // the pane while `window.resize` never fires (R1 H2).
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const terminal = terminalRef.current;
      const mount = mountRef.current;
      const probe = selectionProbeRef.current;
      if (!terminal || !mount || !probe) return;
      terminal.options.theme = readTheme(mount, probe);
    };
    media.addEventListener("change", applyTheme);
    // 설정 > 테마의 전환도 같은 재읽기를 일으켜야 한다 (U2). 그 전환은 미디어 질의가
    // 아니라 루트의 `data-theme` 스탬프로 일어나므로 위 리스너는 깨어나지 않고, 열려
    // 있던 관전 터미널만 이전 스킴의 색으로 남는다(라이트 종이 위의 검은 판). 이
    // 구독이 불릴 때 스탬프는 이미 붙어 있으므로, 여기서 읽는 계산값은 새 스킴의
    // 것이다(src/design/theme.ts setTheme).
    const unsubscribeTheme = subscribeTheme(applyTheme);
    const mount = mountRef.current;
    const observer = new ResizeObserver(() => refitRef.current?.());
    // The wheel is the way a reader leaves the tail, and it does not go through
    // xterm's own `onScroll` on every path. A capturing listener on the box
    // sees `.xterm-viewport` scroll whoever caused it; scroll does not bubble,
    // which is why this is capture and not a plain listener.
    if (mount) {
      observer.observe(mount);
      mount.addEventListener("scroll", syncTail, true);
    }
    return () => {
      media.removeEventListener("change", applyTheme);
      unsubscribeTheme();
      observer.disconnect();
      mount?.removeEventListener("scroll", syncTail, true);
    };
  }, [syncTail]);

  // The armed confirmation belongs to one fact on screen. If observation closes
  // by another path (another client, the owner's mac console), the sentence
  // asking whether to close it is about something that already happened.
  useEffect(() => {
    if (session.observation !== "open") setCloseArmed(false);
  }, [session.observation]);

  async function changeScope(next: WorkSession["observation"]) {
    if (scopePending !== null || next === session.observation) return;
    setScopePending(next);
    setScopeError(null);
    try {
      await setWorkSessionObservation(workspaceId, session.id, next);
      setCloseArmed(false);
      await queryClient.invalidateQueries({
        queryKey: ["work-sessions", workspaceId],
      });
    } catch {
      setScopeError("관전 범위를 바꾸지 못했습니다. 다시 시도하세요.");
    } finally {
      setScopePending(null);
    }
  }

  // The frame is drawn while a stream is being set up or running, and after
  // that only if it holds something. `issuing` and `connecting` are in here for
  // a mechanical reason as well as an honest one: xterm measures its parent on
  // open, and a mount inside a `hidden` box fits to zero columns.
  const showTerminal =
    phase.kind === "issuing" ||
    phase.kind === "connecting" ||
    phase.kind === "watching" ||
    received;
  const canToggle = canChangeObservation(session, auth.member.id);
  const gateReasonInBanner =
    phase.kind === "failed" &&
    (phase.failure === "observation_closed" || phase.failure === "session_ended");
  const link = observerLink({
    watching: phase.kind === "watching",
    online,
    quietMs: quietSeconds * 1000,
    doubted,
  });
  // Only while a socket is held. The clock stops with the stream, so keeping
  // the clause afterwards would freeze "마지막 출력 15초 전" over a surface that
  // has since said 연결 없음 for ten minutes: a stale number is the same class
  // of lie this file exists to prevent, one size smaller.
  const quiet = link === null ? null : quietLabel(quietSeconds * 1000, received);
  // One notice at a time under the terminal. All three facts can be true at
  // once in a narrow pane, and stacking three warn-toned rows over a 320px
  // column turns all of them into wallpaper, so they are ranked by which one
  // changes what the reader should do next: a connection that may be dead
  // outranks a viewport that is not at the tail, which outranks lines that are
  // folded but present.
  const notice =
    link === "offline" || link === "unverified"
      ? "link"
      : behind > 0
        ? "tail"
        : phase.kind === "watching" && columns < HOST_COLUMNS
          ? "folded"
          : null;
  // Below 900px the pane is ALREADY the whole chat surface (tokens.css
  // work-pane), and 넓게 보기 is hidden there because it has nothing left to do.
  // R2 M2 measured what that left behind: a permanent "긴 줄은 접혀서 보입니다"
  // over zero controls. The remedy at that width is the window, so the notice
  // says the window instead of pointing at a button that is not there.
  const paneAtFullWidth = wide || paneAtWindowWidth;
  const Heading =
    headingLevel === 2 ? "h2" : headingLevel === 3 ? "h3" : "h4";
  const docked = variant === "dock";

  return (
    <section
      className={cn(
        "px-4 py-2",
        docked
          ? "flex min-h-0 flex-1 flex-col overflow-hidden"
          : "border-b border-line"
      )}
      data-testid="work-observer"
      data-phase={phase.kind}
      data-link={link ?? undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading className="min-w-0 flex-1 text-meta text-ink-muted">
          터미널 관전
        </Heading>
        {/* 읽기 전용 is a property of the surface, so it is stated once where
            the surface is named. It used to be three muted lines under the
            terminal, repeated in every state, in a 320px column that was
            already carrying nine lines of fixed explanation (R2 M5). The
            sentence itself is not lost: the invitation above the terminal says
            it in full before anyone starts, and it stays here as the chip's
            title for anyone who arrives mid-stream. */}
        {(gate.available || showTerminal) && (
          <span
            className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp text-ink-muted"
            title="출력만 호스트에서 직접 받습니다. 입력, 크기 조절, 종료는 보낼 수 없고 복사와 스크롤은 그대로 됩니다."
            data-testid="work-observer-readonly"
          >
            읽기 전용
          </span>
        )}
        {session.observerGrantCount > 0 && (
          <span
            className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp text-ink"
            title={OBSERVER_COUNT_NOTE}
            aria-label={`${observerCountLabel(
              session.observerGrantCount
            )}, ${OBSERVER_COUNT_NOTE}`}
            data-testid="work-observer-count"
          >
            <span data-numeric>{observerCountLabel(session.observerGrantCount)}</span>
          </span>
        )}
        {canToggle && (
          <div
            role="group"
            aria-label="터미널 관전 범위"
            className="flex shrink-0 items-center gap-px rounded-sm border border-line-strong p-px"
            data-testid="work-observation-toggle"
          >
            <ScopeButton
              label="팀원 관전 허용"
              active={session.observation === "open"}
              pending={scopePending === "open"}
              onClick={() => {
                setCloseArmed(false);
                void changeScope("open");
              }}
              testId="work-observation-open"
            />
            {/* Closing is the destructive half and does not fire from this
                click (§6): it arms the confirmation below, which is the same
                two step shape 세션 종료 uses one block down. */}
            <ScopeButton
              label="소유자만 보기"
              active={session.observation === "owner_only"}
              pending={scopePending === "owner_only"}
              expanded={
                session.observation === "open" ? closeArmed : undefined
              }
              onClick={() => {
                if (session.observation === "owner_only") return;
                setCloseArmed((armed) => !armed);
              }}
              testId="work-observation-owner-only"
            />
          </div>
        )}
      </div>

      {/* Not a toast and not a dialog: the sentence sits where the control is,
          and it names the cost in the same words the badge above uses. Closing
          observation revokes every capability the server has issued and drops
          the sockets teammates are holding, which is a change to SOMEONE ELSE's
          screen, arriving with no warning on their side. */}
      {closeArmed && (
        <div className="pt-1" data-testid="work-observation-confirm">
          {/* The grant count is deliberately NOT quoted here (R2 M7). It counts
              capabilities issued in the last minute, so one teammate who
              reconnected once reads as "2건", and a sentence asking whether to
              cut someone off is the last place to put a number that means
              something other than people. The badge above states the number
              with its unit; this states the consequence. */}
          <p className="text-meta text-ink">
            관전을 닫으면 지금 보고 있는 팀원의 화면이 그 자리에서 끊깁니다.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCloseArmed(false)}
              data-testid="work-observation-close-cancel"
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-busy={scopePending === "owner_only" || undefined}
              onClick={() => void changeScope("owner_only")}
              data-testid="work-observation-close-commit"
            >
              {scopePending === "owner_only" && (
                <Loader2 aria-hidden="true" className="spinner-busy" />
              )}
              {scopePending === "owner_only" ? "닫는 중" : "관전 닫기"}
            </Button>
          </div>
        </div>
      )}

      {scopeError && (
        <p role="alert" className="pt-1 text-meta text-danger" data-testid="work-observation-error">
          {scopeError}
        </p>
      )}

      {/* Not available: the reason, in words, and no control that cannot act.
          It is dropped when the banner below is already saying the same thing:
          closing observation used to print the fact twice, once as "your stream
          stopped" and once as "there is no start button", three muted lines for
          one click (measured on momowebqa 2026-07-26). */}
      {!gate.available && !gateReasonInBanner && (
        <p className="pt-1 text-meta text-ink-muted" data-testid="work-observer-blocked">
          {gate.reason}
        </p>
      )}

      {gate.available && phase.kind === "idle" && (
        <div className="flex flex-col items-start gap-2 pt-1">
          {/* Two different idle states, because they answer different
              questions. Before anything has arrived this is an invitation and
              says what watching IS. After 관전 중단 the output is still on
              screen below, so the sentence says what happened to it and what
              starting again will do to it, since a host replays its scrollback
              and the screen therefore has to be cleared first (see `start`). */}
          <p className="text-meta text-ink-muted" data-testid="work-observer-invite">
            {received
              ? "관전을 멈췄습니다. 아래 출력은 받은 그대로 남아 있고, 다시 시작하면 화면을 지우고 호스트가 보내는 출력부터 새로 그립니다."
              : hostName === null
                ? "관전을 시작하면 호스트의 출력이 이 자리에 그대로 흐릅니다. 읽기 전용이라 입력은 보낼 수 없고, 출력은 서버를 거치지 않고 호스트에서 직접 옵니다."
                : `관전을 시작하면 ${hostName}의 출력이 이 자리에 그대로 흐릅니다. 읽기 전용이라 입력은 보낼 수 없고, 출력은 서버를 거치지 않고 호스트에서 직접 옵니다.`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void start()}
            data-testid="work-observer-start"
          >
            {received ? "관전 다시 시작" : "관전 시작"}
          </Button>
        </div>
      )}

      {(phase.kind === "issuing" || phase.kind === "connecting") && (
        <p
          role="status"
          className="flex items-center gap-2 pt-1 text-meta text-ink-muted"
          data-testid="work-observer-busy"
        >
          <Loader2 aria-hidden="true" className="spinner-busy size-4" />
          {PHASE_BUSY_COPY[phase.kind]}
        </p>
      )}

      {phase.kind === "failed" && (
        // Full bleed inside a padded section (R2 M8). InlineBanner brings its
        // own px-4 and its own bottom rule because it is built to span a panel;
        // dropped into this px-4 section it indented the error sentence 16px
        // past the heading above it and drew a rule narrower than the block.
        // The negative margin gives it the width it was drawn for, so its text
        // lands on the same left edge as everything else here.
        <div className="-mx-4 pt-1">
          <InlineBanner
            tone={
              phase.failure === "stream_closed" ||
              phase.failure === "session_ended" ||
              phase.failure === "observation_closed"
                ? "neutral"
                : "error"
            }
            message={observerFailureCopy(phase.failure, isOwner)}
            {...(offersRetry(phase.failure, gate.available)
              ? { actionLabel: "다시 연결", onAction: () => void start() }
              : offersReload(phase.failure)
                ? {
                    // A policy the page carries cannot be re-asked on this
                    // document, and an operator who has just fixed connect-src
                    // otherwise has to find the way back into this panel by
                    // hand (R2 M4). The reload is the action that can change
                    // the answer, so it is the one offered.
                    actionLabel: "새로고침",
                    onAction: () => window.location.reload(),
                  }
                : {})}
            testId="work-observer-error"
          />
        </div>
      )}

      {/* The terminal stays mounted across a failure: those bytes really did
          arrive, and clearing them on a dropped socket would delete the only
          record of what the agent printed. */}
      <div
        className={cn(
          "pt-2",
          !showTerminal && "hidden",
          docked && "flex min-h-0 flex-1 flex-col"
        )}
      >
        {/* The frame and the terminal are two boxes on purpose.
            FitAddon measures its parent with `getComputedStyle().height`, which
            on a `box-sizing: border-box` element resolves to the BORDER box
            (measured: a 320px box with p-2 and a hairline reports 320 while
            only 302 is content). Padding on the mount therefore made every fit
            propose one row more than fits, which clipped half a row against a
            fixed height and ran away entirely against a content height: the
            box grew ~12 rows per frame, forever. So the mount carries no
            padding and no border, and the chrome lives out here. */}
        <div
          className={cn(
            "rounded-sm border border-line bg-surface-raised p-2 focus-within:focus-ring",
            docked && "flex min-h-0 flex-1 flex-col"
          )}
        >
          <div
            // The whole point of a read-only terminal is that it can be read:
            // focus reaches it (xterm puts a textarea inside), selection and
            // scrolling work, and with stdin disabled a keystroke does nothing.
            // The ring is on the frame because xterm owns the inner elements.
            //
            // `role="log"` used to be here and is deliberately gone (R1 M5):
            // log carries an implicit aria-live="polite", which handed a screen
            // reader every byte of a 190 kB burst to read out. A labelled group
            // plus the counted summary underneath says the same thing in one
            // sentence, and xterm's own screenReaderMode stays off because it
            // would put that live region back.
            //
            className={cn(
              "overflow-hidden bg-surface-raised font-mono text-meta text-ink",
              docked
                ? "min-h-0 flex-1"
                : !bodyFitsContent && "h-terminal-body"
            )}
            ref={mountRef}
            role="group"
            aria-label="세션 터미널 출력, 읽기 전용"
            data-testid="work-observer-terminal"
          />
        </div>
        <span
          ref={selectionProbeRef}
          aria-hidden="true"
          className="hidden bg-accent-soft"
        />

        {/* The link is not the socket's readyState. Either the browser has said
            it has no network at all, or it said so while this stream was open
            and has not proved otherwise since. Both are rows rather than words
            because both need a next step spelled out (R2 H1). */}
        {notice === "link" && link !== null && (
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="work-observer-link"
            data-link={link}
          >
            <p role="status" className="min-w-0 flex-1 text-meta text-warn">
              {OBSERVER_LINK_NOTE[link === "offline" ? "offline" : "unverified"]}
            </p>
            {link === "unverified" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void start()}
                data-testid="work-observer-relink"
              >
                다시 연결
              </Button>
            )}
          </div>
        )}

        {/* Scrolled off the tail with the socket still open. The header still
            says 관전 중 and it is still true, but the SCREEN stopped being the
            newest thing that arrived, and nothing said so: xterm hides its
            scrollbar at rest, so a frozen viewport under a rising byte count
            looked exactly like a live one (R1 M1). */}
        {notice === "tail" && (
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="work-observer-tail"
          >
            <p className="min-w-0 flex-1 text-meta text-warn">
              이전 출력을 보는 중입니다. 그 사이{" "}
              <span data-numeric>{behind.toLocaleString()}</span>줄이 더
              도착했습니다.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={jumpToTail}
              data-testid="work-observer-tail-jump"
            >
              <ArrowDown aria-hidden="true" />
              최신 출력으로
            </Button>
          </div>
        )}

        {/* The viewport is narrower than what the host is writing for, so the
            lines on screen are folded, not shown. This client sends no resize
            frame by design, so the only thing that can change is how wide this
            pane is (R1 H2), and where the pane is already as wide as it gets,
            the window (R2 M2). Every branch here ends in something the reader
            can do. */}
        {notice === "folded" && (
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="work-observer-folded"
          >
            <p className="min-w-0 flex-1 text-meta text-ink-muted">
              이 폭에서는 <span data-numeric>{columns}</span>칼럼만 보입니다.
              호스트는 <span data-numeric>{HOST_COLUMNS}</span>칼럼으로 쓰고
              있어서 긴 줄은 접혀서 보입니다.
              {paneAtFullWidth && " 창을 넓히면 접히지 않습니다."}
            </p>
            {!paneAtFullWidth && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pane-wide-toggle"
                onClick={() => onWideChange(true)}
                data-testid="work-observer-widen"
              >
                패널 넓게 보기
              </Button>
            )}
          </div>
        )}

        {/* What the surface is, then what it holds. The first word is the whole
            liveness claim and it is bound to what this client can observe: an
            OPEN socket, a browser that has a network, and bytes recent enough
            that silence is not worth naming. When it is, the age of the last
            byte sits beside it rather than being left for the reader to infer
            from a number that stopped moving (R2 H1). */}
        <p
          className={cn(
            "pt-1 text-meta",
            link === "offline" || link === "unverified"
              ? "text-warn"
              : "text-ink-muted"
          )}
          data-testid="work-observer-bytes"
        >
          {link === null ? "연결 없음" : OBSERVER_LINK_STATUS[link]}
          {quiet !== null && (
            <>
              {" · "}
              <span data-numeric>{quiet}</span>
            </>
          )}{" "}
          · 받은 출력{" "}
          <span data-numeric className="font-mono">
            {lines.toLocaleString()}
          </span>
          줄,{" "}
          <span data-numeric className="font-mono">
            {bytes.toLocaleString()}
          </span>
          바이트
        </p>
        {phase.kind === "watching" && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={stop}
              data-testid="work-observer-stop"
            >
              관전 중단
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 가로 `notice === "folded"` 와 같은 문법의 세로 바닥 (#1758 R2-H2). */
export const TERMINAL_SHORT_COPY =
  "창이 낮아 터미널을 접었습니다. 창을 높이면 펼쳐집니다.";

export function TerminalShortNotice() {
  return (
    <p
      className="px-4 py-2 text-meta text-ink-muted"
      data-testid="terminal-dock-short"
    >
      {TERMINAL_SHORT_COPY}
    </p>
  );
}

/**
 * One half of the scope control. `aria-pressed` rather than two radio inputs:
 * both options are actions the owner takes, and the pressed one is the state.
 *
 * `pending` is an in-button spinner and not only `aria-busy` (R1 M4): the
 * attribute is real and correct for a screen reader, and on screen it was
 * nothing at all, so on a slow line the control looked like it had ignored the
 * click. The button keeps its own width while the spinner is up because the
 * label stays; only the icon appears.
 */
function ScopeButton({
  label,
  active,
  pending,
  expanded,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  pending: boolean;
  /** Set when this button opens a confirmation rather than acting. */
  expanded?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-busy={pending || undefined}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "" : undefined}
      className={cn(
        "flex items-center gap-1 rounded-sm px-2 py-px text-timestamp focus-visible:focus-ring",
        active
          ? "bg-accent-soft text-ink"
          : "text-ink-muted hover:bg-surface-hover"
      )}
    >
      {pending && <Loader2 aria-hidden="true" className="spinner-busy size-3" />}
      {label}
    </button>
  );
}
