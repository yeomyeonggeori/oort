import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import {
  issueObserverTerminalAttach,
  setWorkSessionObservation,
  uuidEq,
  type WorkSession,
} from "@/lib/api";
import { InlineBanner } from "@/features/common/States";
import {
  attachSocketUrl,
  canChangeObservation,
  classifyClose,
  classifyGrantFailure,
  connectFrame,
  cspBlockedHost,
  HOST_COLUMNS,
  HOST_CONNECT_TIMEOUT_MS,
  isValidPtyId,
  newlineCount,
  observationStillPermits,
  observerCountLabel,
  observerFailureCopy,
  observerSubprotocols,
  observeGate,
  offersRetry,
  terminalOwnsKey,
  OBSERVER_COUNT_NOTE,
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
//   - 관전 중 is shown only while the WebSocket is OPEN. Not while it is
//     connecting, not after a close, never from the ledger.
//   - the running byte count under the terminal is the honest liveness signal:
//     it moves exactly as fast as bytes arrive and stops dead when they stop.
//     There is no caret, no pulse and no shimmer over a dead socket.
//   - a live socket is not the same claim as a live SCREEN. Scrolling back
//     freezes the viewport while bytes keep arriving, so the panel says so and
//     offers the way back to the tail (R1 M1).
//   - the cursor is off (`cursorInactiveStyle: "none"`). A blinking block in a
//     disconnected terminal is a claim that a process is waiting for you.
//   - every disconnect names its own cause (observerStream.ObserverFailure) and
//     leaves the received output on screen, because what arrived was real.
//   - a failure is never a terminus. While the ledger still permits watching,
//     there is always a control that starts it again (R1 H1).
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
  connecting: "호스트에 연결하는 중",
};

export function ObserverTerminal({
  session,
  hostName,
  wide,
  onWideChange,
}: {
  session: WorkSession;
  hostName: string | null;
  /** The pane is showing at full surface width (WorkPanel owns the state). */
  wide: boolean;
  onWideChange: (wide: boolean) => void;
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

  const mountRef = useRef<HTMLDivElement>(null);
  const selectionProbeRef = useRef<HTMLSpanElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Generation counter: an old attempt's callbacks must not touch new state. */
  const runRef = useRef(0);

  const closeSocket = useCallback(() => {
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
    const run = runRef.current + 1;
    runRef.current = run;
    closeSocket();
    bytesRef.current = 0;
    linesRef.current = 0;
    tailAnchorRef.current = null;
    setBytes(0);
    setLines(0);
    setBehind(0);
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
    terminal.reset();

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
      window.clearTimeout(deadline);
      give("host_blocked_by_policy");
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const done = () => {
      window.clearTimeout(deadline);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };

    socket.onopen = () => {
      done();
      if (runRef.current !== run) return;
      opened = true;
      socket.send(connectFrame(grant.pty_id));
      setPhase({ kind: "watching" });
      refitRef.current?.();
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (runRef.current !== run) return;
      const data = event.data;
      if (typeof data === "string") {
        terminal.write(data);
        bytesRef.current += TEXT_ENCODER.encode(data).length;
        linesRef.current += newlineCount(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(data);
        terminal.write(chunk);
        bytesRef.current += chunk.byteLength;
        linesRef.current += newlineCount(chunk);
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
  }, [closeSocket, ensureTerminal, session.id, workspaceId]);

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
    };
    const timer = window.setInterval(publish, 500);
    return () => {
      window.clearInterval(timer);
      publish();
    };
  }, [phase.kind]);

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
    if (phase.kind !== "failed") {
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
    setBytes(0);
    setLines(0);
    setBehind(0);
    setCloseArmed(false);
    setPhase({ kind: "idle" });
  }, [session.id, closeSocket]);

  // Leaving the panel (or switching sessions) drops the stream with it.
  useEffect(
    () => () => {
      runRef.current += 1;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      refitRef.current = null;
    },
    []
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

  const showTerminal = phase.kind !== "idle";
  const canToggle = canChangeObservation(session, auth.member.id);
  const gateReasonInBanner =
    phase.kind === "failed" &&
    (phase.failure === "observation_closed" || phase.failure === "session_ended");
  // One notice at a time under the terminal. Both facts are true at once in a
  // narrow pane, but "you are not looking at the tail" is the one that changes
  // what the reader should do next, and stacking two warn-toned rows over a
  // 320px column turns both into wallpaper.
  const folded =
    phase.kind === "watching" && behind === 0 && columns < HOST_COLUMNS;

  return (
    <section
      className="border-b border-line px-4 py-2"
      data-testid="work-observer"
      data-phase={phase.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 text-meta text-ink-muted">터미널 관전</h4>
        {session.observerGrantCount > 0 && (
          <span
            className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp text-ink"
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
          <p className="text-meta text-ink">
            관전을 닫으면 지금 보고 있는 팀원의 화면이 그 자리에서 끊깁니다.
            {session.observerGrantCount > 0 && (
              <>
                {" "}
                최근 1분 안에 발급된 관전 권한은{" "}
                <span data-numeric>{session.observerGrantCount}</span>건입니다.
              </>
            )}
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

      {session.observerGrantCount > 0 && (
        <p className="pt-1 text-meta text-ink-muted" data-testid="work-observer-note">
          {OBSERVER_COUNT_NOTE}
        </p>
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
          <p className="text-meta text-ink-muted" data-testid="work-observer-invite">
            {hostName === null
              ? "관전을 시작하면 호스트의 출력이 이 자리에 그대로 흐릅니다. 출력은 서버를 거치지 않고 호스트에서 직접 옵니다."
              : `관전을 시작하면 ${hostName}의 출력이 이 자리에 그대로 흐릅니다. 출력은 서버를 거치지 않고 호스트에서 직접 옵니다.`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void start()}
            data-testid="work-observer-start"
          >
            관전 시작
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
        <div className="pt-1">
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
              : {})}
            testId="work-observer-error"
          />
        </div>
      )}

      {/* The terminal stays mounted across a failure: those bytes really did
          arrive, and clearing them on a dropped socket would delete the only
          record of what the agent printed. */}
      <div className={cn("pt-2", !showTerminal && "hidden")}>
        {/* The frame and the terminal are two boxes on purpose.
            FitAddon measures its parent with `getComputedStyle().height`, which
            on a `box-sizing: border-box` element resolves to the BORDER box
            (measured: a 320px box with p-2 and a hairline reports 320 while
            only 302 is content). Padding on the mount therefore made every fit
            propose one row more than fits, which clipped half a row against a
            fixed height and ran away entirely against a content height: the
            box grew ~12 rows per frame, forever. So the mount carries no
            padding and no border, and the chrome lives out here. */}
        <div className="rounded-sm border border-line bg-surface-raised p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
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
            className={cn(
              "overflow-hidden bg-surface-raised font-mono text-meta text-ink",
              !bodyFitsContent && "h-terminal-body"
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

        {/* Scrolled off the tail with the socket still open. The header still
            says 관전 중 and it is still true, but the SCREEN stopped being the
            newest thing that arrived, and nothing said so: xterm hides its
            scrollbar at rest, so a frozen viewport under a rising byte count
            looked exactly like a live one (R1 M1). */}
        {behind > 0 && (
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
            pane is (R1 H2). */}
        {folded && (
          <div
            className="flex flex-wrap items-center gap-2 pt-1"
            data-testid="work-observer-folded"
          >
            <p className="min-w-0 flex-1 text-meta text-ink-muted">
              이 폭에서는 <span data-numeric>{columns}</span>칼럼만 보입니다.
              호스트는 <span data-numeric>{HOST_COLUMNS}</span>칼럼으로 쓰고
              있어서 긴 줄은 접혀서 보입니다.
            </p>
            {!wide && (
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

        <p className="pt-1 text-meta text-ink-muted" data-testid="work-observer-readonly">
          읽기 전용입니다. 출력만 호스트에서 직접 받고, 입력, 크기 조절, 종료는
          보낼 수 없습니다. 복사와 스크롤은 그대로 됩니다.
        </p>
        <p className="text-meta text-ink-muted" data-testid="work-observer-bytes">
          {phase.kind === "watching" ? "관전 중" : "연결 없음"} · 받은 출력{" "}
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
        "flex items-center gap-1 rounded-sm px-2 py-px text-timestamp focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
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
