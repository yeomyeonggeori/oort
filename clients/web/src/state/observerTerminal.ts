import type { TerminalAttachCapabilityResponse } from "../api/client";

export type ObserverTerminalStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface ObserverTerminalState {
  status: ObserverTerminalStatus;
  message?: string;
}

export type ObserverTerminalEvent =
  | { type: "request" }
  | { type: "grant" }
  | { type: "connected" }
  | { type: "closed"; message?: string }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const initialObserverTerminalState: ObserverTerminalState = {
  status: "idle",
};

/** Pure state machine: invalid/stale transport events are ignored. */
export function reduceObserverTerminal(
  state: ObserverTerminalState,
  event: ObserverTerminalEvent
): ObserverTerminalState {
  switch (event.type) {
    case "request":
      return state.status === "idle" ||
        state.status === "disconnected" ||
        state.status === "error"
        ? { status: "requesting" }
        : state;
    case "grant":
      return state.status === "requesting" ? { status: "connecting" } : state;
    case "connected":
      return state.status === "connecting" ? { status: "connected" } : state;
    case "closed":
      return state.status === "connecting" || state.status === "connected"
        ? {
            status: "disconnected",
            ...(event.message ? { message: event.message } : {}),
          }
        : state;
    case "failed":
      return state.status === "requesting" || state.status === "connecting"
        ? { status: "error", message: event.message }
        : state;
    case "reset":
      return initialObserverTerminalState;
  }
}

export interface ObserverTerminalConnection {
  close(): void;
}

export interface ObserverTerminalCallbacks {
  onOpen(): void;
  onData(data: Uint8Array): void;
  onClose(message?: string): void;
  onError(message: string): void;
}

const PTY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Browser-safe direct attach. Fetch can carry Authorization without putting
 * the capability in a URL. Browser WebSocket cannot set that header, so WSS
 * endpoints fail closed until a host exposes the canonical HTTPS stream.
 */
export function connectObserverTerminal(
  grant: TerminalAttachCapabilityResponse,
  callbacks: ObserverTerminalCallbacks
): ObserverTerminalConnection {
  const abort = new AbortController();
  let endpoint: URL;
  try {
    endpoint = new URL(grant.attach_endpoint);
  } catch {
    queueMicrotask(() => callbacks.onError("유효하지 않은 터미널 주소입니다."));
    return { close: () => abort.abort() };
  }

  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !PTY_ID.test(grant.pty_id)
  ) {
    queueMicrotask(() => callbacks.onError("안전하지 않은 터미널 연결 정보입니다."));
    return { close: () => abort.abort() };
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    queueMicrotask(() =>
      callbacks.onError(
        "이 호스트는 웹용 HTTPS 관전 스트림을 제공하지 않습니다."
      )
    );
    return { close: () => abort.abort() };
  }

  // The capability exists only in this call stack/request header. It is never
  // copied into observable UI state, storage, URL parameters, or log output.
  void fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${grant.capability_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "connect", pty_id: grant.pty_id }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: abort.signal,
  })
    .then(async (response) => {
      if (!response.ok || response.body === null) {
        throw new Error("터미널 관전 연결이 거부되었습니다.");
      }
      callbacks.onOpen();
      const reader = response.body.getReader();
      while (!abort.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        callbacks.onData(chunk.value);
      }
      if (!abort.signal.aborted) callbacks.onClose();
    })
    .catch((error: unknown) => {
      if (abort.signal.aborted) return;
      callbacks.onError(
        error instanceof Error
          ? error.message
          : "터미널 관전 연결에 실패했습니다."
      );
    });

  return { close: () => abort.abort() };
}
