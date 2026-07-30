import { useEffect, useReducer, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  issueObserverTerminalAttach,
  type WorkSession,
} from "../api/client";
import {
  connectObserverTerminal,
  initialObserverTerminalState,
  reduceObserverTerminal,
  type ObserverTerminalConnection,
} from "../state/observerTerminal";

const STATUS_COPY = {
  idle: "연결 전",
  requesting: "관전 권한 요청 중…",
  connecting: "호스트 연결 중…",
  connected: "관전 중",
  disconnected: "연결 종료",
  error: "연결 실패",
} as const;

export default function ObserverTerminal({
  workspaceId,
  session,
}: {
  workspaceId: string;
  session: WorkSession;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const connectionRef = useRef<ObserverTerminalConnection | null>(null);
  const mountedRef = useRef(true);
  const [state, dispatch] = useReducer(
    reduceObserverTerminal,
    initialObserverTerminalState
  );
  const [rendererReady, setRendererReady] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(([module]) => {
      if (disposed || hostRef.current === null) return;
      const terminal = new module.Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        rows: 16,
        scrollback: 5_000,
        theme: { background: "#111014", foreground: "#e8e7ec" },
      });
      terminal.open(hostRef.current);
      terminal.writeln("momo observer · read only");
      terminalRef.current = terminal;
      setRendererReady(true);
    });
    return () => {
      disposed = true;
      mountedRef.current = false;
      connectionRef.current?.close();
      connectionRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  // running OR idle, matching the issuer: the spec says "The running or idle
  // session must carry a MomoHost-signed remote PTY binding"
  // (issueTerminalAttachCapability) and the server guards on exactly that pair
  // (TerminalAttachRoutes.swift `status == "running" || status == "idle"`).
  // Gating on running alone hid an observation the server would have granted —
  // ADR-0139 introduced `idle` and this branch was never widened with it.
  const available =
    (session.status === "running" || session.status === "idle") &&
    session.observation === "open" &&
    session.remoteAttachAvailable;
  const busy = state.status === "requesting" || state.status === "connecting";

  async function observe() {
    if (!available || busy || state.status === "connected") return;
    connectionRef.current?.close();
    connectionRef.current = null;
    dispatch({ type: "request" });
    terminalRef.current?.clear();
    try {
      // Keep this local binding short-lived: do not copy the raw grant into
      // component state, DOM attributes, storage, URLs, errors, or logs.
      const grant = await issueObserverTerminalAttach(workspaceId, session.id);
      if (!mountedRef.current) return;
      dispatch({ type: "grant" });
      connectionRef.current = connectObserverTerminal(grant, {
        onOpen: () => {
          if (mountedRef.current) dispatch({ type: "connected" });
        },
        onData: (data) => terminalRef.current?.write(data),
        onClose: (message) => {
          if (mountedRef.current) dispatch({ type: "closed", ...(message ? { message } : {}) });
        },
        onError: (message) => {
          if (mountedRef.current) dispatch({ type: "failed", message });
        },
      });
    } catch {
      if (mountedRef.current) {
        dispatch({
          type: "failed",
          message: "관전 권한을 발급받지 못했습니다.",
        });
      }
    }
  }

  return (
    <section className="observer-terminal" aria-label="읽기 전용 observer 터미널">
      <header className="observer-terminal-header">
        <div>
          <strong>Observer 터미널</strong>
          <span className="observer-read-only">읽기 전용 · stdin 없음</span>
        </div>
        <span
          className={`observer-status observer-status-${state.status}`}
          role="status"
        >
          {STATUS_COPY[state.status]}
        </span>
      </header>
      <div className="observer-terminal-screen" ref={hostRef} />
      {state.message && <p className="observer-error">{state.message}</p>}
      {!available && (
        <p className="muted observer-help">
          실행 중이거나 대기 중이고 공개 관전이 허용된 원격 PTY 세션만 연결할 수
          있습니다.
        </p>
      )}
      <div className="observer-terminal-actions">
        <span className="muted">
          활성 observer grant {session.observerGrantCount}개
        </span>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void observe()}
          disabled={!available || !rendererReady || busy || state.status === "connected"}
        >
          {state.status === "disconnected" || state.status === "error"
            ? "다시 관전"
            : "터미널 관전"}
        </button>
      </div>
    </section>
  );
}
