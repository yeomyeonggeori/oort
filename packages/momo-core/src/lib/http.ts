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

/**
 * A deadline timer that runs this long (or longer) past its due time ran on an event loop that was not
 * running for that long: the Mac slept, or the app was napping or suspended behind other windows (#5587).
 * The deadline then measured the device, not the server — the timer fires the moment the app wakes,
 * before the request has had any awake time to be answered. Such a timeout is still thrown (callers keep
 * their behaviour) but is reported with `lateMs`, and the connection verdict does not count it as
 * "the server did not answer" (`features/connection/restSignal.ts`).
 *
 * 10 s: a hidden page's timers are aligned to 1 s and a busy loop runs a timer late by well under a
 * second, so 10 s past due is not ordinary throttling. A browser tab hidden for many minutes can run
 * timers up to a minute late; a timeout there is not counted either — nobody was looking, and the next
 * request after the person returns tests the server again.
 */
export const LATE_WAKE_MS = 10_000;

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
  const next = "주소와 네트워크를 확인하고 다시 시도해 주세요.";
  return failure === "timeout"
    ? `서버가 ${seconds(timeoutMs)}초 안에 응답하지 않았어요. ${next}`
    : `서버에 닿지 못했어요. ${next}`;
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
  /**
   * The `Date` header, or null. The refresh proof's clock correction reads it
   * (`refresh_proof_stale`, #3106).
   */
  readonly date?: string | null;
  /**
   * The raw `Retry-After` header, or null. A 429 or 503 that says when to come
   * back says it here and nowhere else (the error envelope carries no seconds).
   */
  readonly retryAfter?: string | null;
  /**
   * Retry-After (#4663, additive): the `Retry-After` header as whole seconds, only when the
   * server sent it as a plain integer (a 429 or 503 does). Absent when the header is missing
   * or in any other form (an HTTP date, a fraction, text). Absent means "the server did not
   * say how long", never "no wait", so a caller must not default it to a number.
   */
  readonly retryAfterSeconds?: number;
  /** Parsed body. Throws on a body that is not JSON, like `Response.json()`. */
  json<T>(): T;
  /** Parsed body, or null when there is none or it is not JSON. */
  jsonOrNull<T>(): T | null;
}

function httpResponse(
  status: number,
  ok: boolean,
  text: string,
  date: string | null = null,
  retryAfter: string | null = null
): HttpResponse {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
  return {
    status,
    ok,
    text,
    date,
    retryAfter,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
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
 * Retry-After (#4663, additive): the delta-seconds form of the header, or `undefined`.
 * Only a plain run of digits that fits a safe integer counts. The HTTP-date form, a negative
 * or fractional number and any text are `undefined`: a client that guessed a wait from them
 * would be inventing a number the server never gave.
 */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

// ---- REST outcome observation (#5219, #5201 S-A; additive) -------------------
//
// "Can the server be reached?" is not something a socket can answer: the realtime
// rail can be up while REST is down (an api container restarting) and the other
// way round. Every REST exchange already funnels through `fetchWithDeadline`, so
// this is the one place that sees all of them. It only REPORTS what happened to a
// subscriber (features/connection/restSignal.ts folds the reports into a verdict);
// it decides nothing, and a request behaves exactly as before whether anyone is
// listening or not. A subscriber that throws is ignored: observing a request must
// never change what the request resolves to.

interface RestOutcomeBase {
  /** Epoch ms when the exchange ended. */
  readonly at: number;
  /** Upper-case HTTP method. */
  readonly method: string;
  /** The URL without its query and fragment: which request this was. */
  readonly target: string;
}

/** The server answered. `code` is the error envelope's `error.code`, only when the body carried one (5xx only). */
export interface RestResponseOutcome extends RestOutcomeBase {
  readonly kind: "response";
  readonly status: number;
  readonly code?: string;
}

/** Nothing answered: the deadline blew or the connection failed (a `NetworkError` was thrown). */
export interface RestNetworkOutcome extends RestOutcomeBase {
  readonly kind: "network";
  readonly failure: NetworkFailure;
  /**
   * #5587 (additive): only on a `timeout` whose deadline timer fired `LATE_WAKE_MS` or more after it was
   * due — how late, in ms. The app was asleep for that long, so this timeout is not evidence about the
   * server. Absent on an on-time timeout and on every connection failure.
   */
  readonly lateMs?: number;
}

export type RestOutcome = RestResponseOutcome | RestNetworkOutcome;

const restObservers = new Set<(outcome: RestOutcome) => void>();

/**
 * Hear how every REST exchange ends. Returns the unsubscribe. A request the caller
 * itself cancelled is not an outcome and is never reported (a cancelled query is
 * not a broken network).
 */
export function subscribeRestOutcome(observer: (outcome: RestOutcome) => void): () => void {
  restObservers.add(observer);
  return () => {
    restObservers.delete(observer);
  };
}

/**
 * Tell every subscriber how an exchange ended. `build` makes the report lazily and
 * the whole path cannot throw: with nobody listening nothing is built, and a report
 * that cannot be built or a subscriber that throws leaves the request exactly as
 * it was (a throw here would land in `fetchWithDeadline`'s own `catch` and turn an
 * answered request into a `NetworkError`).
 */
function reportRestOutcome(build: () => RestOutcome): void {
  if (restObservers.size === 0) return;
  let outcome: RestOutcome;
  try {
    outcome = build();
  } catch {
    return; // The report could not be made; the request itself is unaffected.
  }
  for (const observer of [...restObservers]) {
    try {
      observer(outcome);
    } catch {
      // A broken subscriber must not turn an answered request into a failed one.
    }
  }
}

function restTarget(url: string): string {
  return url.replace(/[?#][\s\S]*$/, "");
}

function restMethod(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

/** `error.code` of the envelope, the same reading `api.ts` `parseError` uses; undefined when absent or empty. */
function restErrorCode(response: HttpResponse): string | undefined {
  const code = response.jsonOrNull<{ error?: { code?: unknown } }>()?.error?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

function reportResponse(url: string, init: RequestInit, response: HttpResponse): void {
  reportRestOutcome(() => {
    // Only a 5xx can be "the server did not really answer"; skip parsing every other body.
    const code = response.status >= 500 ? restErrorCode(response) : undefined;
    return {
      kind: "response",
      at: Date.now(),
      method: restMethod(init),
      target: restTarget(url),
      status: response.status,
      ...(code === undefined ? {} : { code }),
    };
  });
}

function reportNetworkFailure(
  url: string,
  init: RequestInit,
  failure: NetworkFailure,
  lateMs: number | null = null
): void {
  reportRestOutcome(() => ({
    kind: "network",
    at: Date.now(),
    method: restMethod(init),
    target: restTarget(url),
    failure,
    ...(lateMs === null ? {} : { lateMs }),
  }));
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
  // How late the deadline timer woke, when it woke `LATE_WAKE_MS` or more past due (#5587). Wall clock
  // on purpose: a monotonic clock may not advance while the Mac sleeps, and sleep is what this measures.
  let lateMs: number | null = null;
  const armedAt = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    const late = Date.now() - armedAt - timeoutMs;
    if (late >= LATE_WAKE_MS) lateMs = late;
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
    const response = httpResponse(
      res.status,
      res.ok,
      text,
      res.headers?.get?.("Date") ?? null,
      res.headers?.get?.("Retry-After") ?? null
    );
    reportResponse(url, init, response);
    return response;
  } catch (error) {
    if (timedOut) {
      reportNetworkFailure(url, init, "timeout", lateMs);
      throw new NetworkError("timeout", timeoutMs, error);
    }
    if (callerSignal?.aborted) throw error; // the caller cancelled; not a failure
    reportNetworkFailure(url, init, "unreachable");
    throw new NetworkError("unreachable", timeoutMs, error);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", relay);
  }
}
