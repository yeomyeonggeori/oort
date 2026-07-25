import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
  HOST_CONNECT_TIMEOUT_MS,
  isRetryable,
  isValidPtyId,
  observationStillPermits,
  observerCountLabel,
  observerSubprotocols,
  observeGate,
  OBSERVER_COUNT_NOTE,
  OBSERVER_FAILURE_COPY,
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
//   - the cursor is off (`cursorInactiveStyle: "none"`). A blinking block in a
//     disconnected terminal is a claim that a process is waiting for you.
//   - every disconnect names its own cause (observerStream.ObserverFailure) and
//     leaves the received output on screen, because what arrived was real.
//
// READ-ONLY, TWICE. The capability is `observer`, so the server issues stdout
// rights only and the host re-validates that grade. On this side there is no
// encoder for send_stdin/resize/kill at all (observerStream.ts), the terminal
// runs with `disableStdin`, and nothing is ever registered on `onData`. Focus
// still works, because copying and scrolling are the point.
//
// COLOR. xterm needs literal colors in JS, which is exactly what the token
// system forbids in a component (design-taste-web §2). So the theme is READ off
// the DOM: two probe elements carry token utility classes, and their computed
// values are handed to xterm. Nothing is restated, `light-dark()` resolves in
// the browser, and a scheme change re-reads it.
// =============================================================================

/** ANSI colors are the program's own vocabulary; xterm's defaults stay. */
type TerminalTheme = Pick<
  ITheme,
  "background" | "foreground" | "cursor" | "selectionBackground"
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
}: {
  session: WorkSession;
  hostName: string | null;
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
  const [scopePending, setScopePending] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

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
    const fit = new runtime.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    // Local geometry only. There is no resize frame in this client, so the HOST
    // pty keeps the size it was created with: fitting changes how many rows this
    // browser draws, never how the host wraps the output it writes.
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* the pane can be mid-layout; the next resize event fits again */
      }
    };
    refit();
    refitRef.current = refit;
    terminalRef.current = terminal;
    return terminal;
  }, []);

  const start = useCallback(async () => {
    const run = runRef.current + 1;
    runRef.current = run;
    closeSocket();
    bytesRef.current = 0;
    setBytes(0);
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

    // The handshake gets a deadline, because nothing else will end it: an
    // unroutable host holds CONNECTING until the OS gives up, and a socket the
    // page's own CSP blocks never fires a single event (see
    // HOST_CONNECT_TIMEOUT_MS). Without this the panel's busy line runs forever.
    const deadline = window.setTimeout(() => {
      if (runRef.current !== run || opened) return;
      runRef.current += 1;
      closeSocket();
      setPhase({ kind: "failed", failure: "host_timeout" });
    }, HOST_CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      window.clearTimeout(deadline);
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
        bytesRef.current += new TextEncoder().encode(data).length;
        return;
      }
      if (data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(data);
        terminal.write(chunk);
        bytesRef.current += chunk.byteLength;
      }
      // Anything else (a Blob, if binaryType were ever changed) is dropped
      // rather than guessed at: this socket carries pty bytes and nothing else.
    };
    socket.onclose = (event: CloseEvent) => {
      window.clearTimeout(deadline);
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

  // The published byte count. The cleanup flush is what makes the frozen number
  // under a dropped socket the REAL total rather than whatever the last tick
  // happened to catch.
  useEffect(() => {
    if (phase.kind !== "watching") return;
    const timer = window.setInterval(() => setBytes(bytesRef.current), 500);
    return () => {
      window.clearInterval(timer);
      setBytes(bytesRef.current);
    };
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
    setBytes(0);
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

  // Scheme changes re-read the tokens rather than restating them, and a pane
  // resize refits the rows this browser draws.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const terminal = terminalRef.current;
      const mount = mountRef.current;
      const probe = selectionProbeRef.current;
      if (!terminal || !mount || !probe) return;
      terminal.options.theme = readTheme(mount, probe);
    };
    const onResize = () => refitRef.current?.();
    media.addEventListener("change", applyTheme);
    window.addEventListener("resize", onResize);
    return () => {
      media.removeEventListener("change", applyTheme);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  async function changeScope(next: WorkSession["observation"]) {
    if (scopePending || next === session.observation) return;
    setScopePending(true);
    setScopeError(null);
    try {
      await setWorkSessionObservation(workspaceId, session.id, next);
      await queryClient.invalidateQueries({
        queryKey: ["work-sessions", workspaceId],
      });
    } catch {
      setScopeError("관전 범위를 바꾸지 못했습니다. 다시 시도하세요.");
    } finally {
      setScopePending(false);
    }
  }

  const showTerminal = phase.kind !== "idle";
  const canToggle = canChangeObservation(session, auth.member.id);
  const gateReasonInBanner =
    phase.kind === "failed" &&
    (phase.failure === "observation_closed" || phase.failure === "session_ended");

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
              pending={scopePending}
              onClick={() => void changeScope("open")}
              testId="work-observation-open"
            />
            <ScopeButton
              label="소유자만 보기"
              active={session.observation === "owner_only"}
              pending={scopePending}
              onClick={() => void changeScope("owner_only")}
              testId="work-observation-owner-only"
            />
          </div>
        )}
      </div>

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
            message={OBSERVER_FAILURE_COPY[phase.failure]}
            {...(isRetryable(phase.failure)
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
        <div
          // The whole point of a read-only terminal is that it can be read:
          // focus reaches it (xterm puts a textarea inside), selection and
          // scrolling work, and with stdin disabled a keystroke does nothing.
          // The ring is on the wrapper because xterm owns the inner elements.
          className="h-terminal-body overflow-hidden rounded-sm border border-line bg-surface-raised p-2 font-mono text-meta text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent"
          ref={mountRef}
          role="log"
          aria-label="세션 터미널 출력, 읽기 전용"
          data-testid="work-observer-terminal"
        />
        <span
          ref={selectionProbeRef}
          aria-hidden="true"
          className="hidden bg-accent-soft"
        />
        <p className="pt-1 text-meta text-ink-muted" data-testid="work-observer-readonly">
          읽기 전용입니다. 출력만 호스트에서 직접 받고, 입력, 크기 조절, 종료는
          보낼 수 없습니다. 복사와 스크롤은 그대로 됩니다.
        </p>
        <p className="text-meta text-ink-muted" data-testid="work-observer-bytes">
          {phase.kind === "watching" ? "관전 중" : "연결 없음"} · 받은 출력{" "}
          <span data-numeric className="font-mono">
            {bytes.toLocaleString("ko-KR")}
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
 */
function ScopeButton({
  label,
  active,
  pending,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  pending: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-busy={pending || undefined}
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "" : undefined}
      className={cn(
        "rounded-sm px-2 py-px text-timestamp focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        active
          ? "bg-accent-soft text-ink"
          : "text-ink-muted hover:bg-surface-hover"
      )}
    >
      {label}
    </button>
  );
}
