// =============================================================================
// One HTTP transport with a deadline (MOMO-609 / parity gate G-1).
//
// `fetch()` has no timeout. A connect attempt that the OS never resolves — the
// measured case is a Bonjour `.local` name the WKWebView can only resolve to a
// link-local IPv6 address — leaves the promise pending for as long as the app
// runs. Every surface built on it then shows its BUSY state forever: the connect
// screen sat on "로그인 중…" past 70 seconds with no error, no retry and not one
// request in the server's access log (docs/planning/2026-07-25-parity-gate-report.md).
//
// So no request in this client is made without a deadline, and the deadline
// covers the BODY as well as the headers: headers can arrive promptly while the
// body stalls, which reads exactly the same from the person's seat. The body is
// therefore read here, inside the same AbortController, and callers get the text
// that already arrived instead of a stream they could hang on.
//
// A blown deadline is a NetworkError, never a silent nothing. `ApiError` still
// means "the server answered and said no"; NetworkError means "nothing answered",
// and those two must never be shown as the same thing.
//
// A caller-supplied `signal` (react-query cancellation, an unmounting effect)
// keeps its own meaning: that abort re-throws the DOMException the caller
// expects, so a cancelled query is not reported as a broken network.
// =============================================================================

/** Deadline for a single REST exchange. Long enough for a cold Swift API
 *  container to answer, short enough to stay inside a person's patience. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type NetworkFailure = "timeout" | "unreachable";

/**
 * The request never produced an HTTP answer. Distinct from `ApiError` on
 * purpose: a 401 is a decision, this is an absence, and only one of the two is
 * worth retrying with the same input.
 *
 * `message` is user-facing Korean copy, because every surface that catches this
 * renders it inline (design-taste-web §5: what happened + what to do next).
 */
export class NetworkError extends Error {
  readonly failure: NetworkFailure;

  constructor(failure: NetworkFailure, timeoutMs: number, cause?: unknown) {
    super(networkFailureCopy(failure, timeoutMs));
    this.name = "NetworkError";
    this.failure = failure;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Whole seconds, so the copy reads "15초" rather than "15000밀리초". */
function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function networkFailureCopy(failure: NetworkFailure, timeoutMs: number): string {
  const next = "주소와 네트워크를 확인하고 다시 시도하세요.";
  return failure === "timeout"
    ? `서버가 ${seconds(timeoutMs)}초 안에 응답하지 않았습니다. ${next}`
    : `서버에 닿지 못했습니다. ${next}`;
}

/**
 * A response whose body is already in hand. Callers branch on `status` and parse
 * with `json()`; nothing they can call later re-enters the network.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Raw body text, read within the deadline. Empty string for an empty body. */
  readonly text: string;
  /** Parsed body. Throws on a body that is not JSON, like `Response.json()`. */
  json<T>(): T;
  /** Parsed body, or null when there is none or it is not JSON. */
  jsonOrNull<T>(): T | null;
}

function httpResponse(status: number, ok: boolean, text: string): HttpResponse {
  return {
    status,
    ok,
    text,
    json<T>(): T {
      return JSON.parse(text) as T;
    },
    jsonOrNull<T>(): T | null {
      if (text === "") return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
  };
}

/**
 * One request, one deadline, body included.
 *
 * Throws `NetworkError` when the deadline blows or the connection fails, and
 * re-throws the caller's own abort untouched.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<HttpResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // The caller's signal is relayed rather than replaced: `AbortSignal.any` is
  // newer than the oldest WKWebView this ships into, and one listener is the
  // whole of what it would buy.
  const callerSignal = init.signal ?? null;
  const relay = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", relay);
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Still under the same signal: a body that stalls after the headers is the
    // same infinite wait, and it aborts on the same deadline.
    const text = await res.text();
    return httpResponse(res.status, res.ok, text);
  } catch (error) {
    if (timedOut) throw new NetworkError("timeout", timeoutMs, error);
    if (callerSignal?.aborted) throw error; // the caller cancelled; not a failure
    throw new NetworkError("unreachable", timeoutMs, error);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", relay);
  }
}
