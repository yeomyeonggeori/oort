import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NetworkError,
  fetchWithDeadline,
  parseRetryAfterSeconds,
  subscribeRestOutcome,
  type RestOutcome,
} from "./http";

// The bug this file exists for (MOMO-609 / parity gate G-1): a connect attempt
// against a name the webview could not resolve left `fetch` pending, so the
// connect screen sat on "로그인 중…" past 70 seconds with no error and no retry.
// What is pinned here is that NOTHING can pend forever, and that the three ways
// a request can end stay distinguishable: an answer, an absence, a cancellation.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that never answers until the signal aborts, like an unroutable host. */
function neverAnswers() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("request deadline", () => {
  it("returns the answer, body and all, when the server responds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ seq: 7 })));
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json<{ seq: number }>()).toEqual({ seq: 7 });
  });

  it("ends a request nothing ever answers, as a timeout", async () => {
    vi.stubGlobal("fetch", neverAnswers());
    const failure = await fetchWithDeadline("http://unresolvable.local:28000", {}, 20)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as NetworkError).failure).toBe("timeout");
    expect((failure as NetworkError).message).toContain("응답하지 않았어요");
  });

  it("counts the deadline against the body too, not just the headers", async () => {
    // Headers arrive at once and the body then stalls: from the reader's seat
    // that is the same infinite wait, so it has to abort on the same deadline.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () => {
                  controller.error(
                    new DOMException("The operation was aborted.", "AbortError")
                  );
                });
              },
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      fetchWithDeadline("http://slow.test/v1/messages", {}, 20)
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("reports a refused connection as unreachable, not as a slow server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const failure = await fetchWithDeadline("http://127.0.0.1:1/v1/auth/login")
      .then(() => null)
      .catch((error: unknown) => error);
    expect((failure as NetworkError).failure).toBe("unreachable");
    expect((failure as NetworkError).message).toContain("서버에 닿지 못했어요");
  });

  it("keeps the caller's own cancellation a cancellation", async () => {
    // react-query aborting a superseded query is not a broken network, and
    // reporting it as one would put a red banner on a screen nobody is on.
    vi.stubGlobal("fetch", neverAnswers());
    const caller = new AbortController();
    const pending = fetchWithDeadline(
      "http://server.test/v1/ping",
      { signal: caller.signal },
      5_000
    );
    caller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(NetworkError);
  });

  it("does not fail a request that already answered when the deadline passes", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
      const res = await fetchWithDeadline("http://server.test/v1/ping", {}, 20);
      vi.advanceTimersByTime(1_000);
      expect(res.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reading the body", () => {
  it("gives a non-JSON error body back as null rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 }))
    );
    const res = await fetchWithDeadline("http://proxy.test/v1/ping");
    expect(res.ok).toBe(false);
    expect(res.jsonOrNull()).toBeNull();
    expect(() => res.json()).toThrow();
  });

  it("treats an empty body as no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.text).toBe("");
    expect(res.jsonOrNull()).toBeNull();
  });
});

describe("reading the Retry-After header", () => {
  it("hands the raw header to a caller that is told to come back later", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "17" },
          })
      )
    );
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe("17");
  });

  it("is null when the server did not say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.retryAfter).toBeNull();
  });
});

// #4663: a 429 or 503 says how long to wait in `Retry-After`. The answer exposes it as
// whole seconds, or says nothing, and never guesses a number the server did not give.
describe("Retry-After", () => {
  it.each([
    ["7", 7],
    ["  12 ", 12],
    ["0", 0],
    ["120", 120],
  ])("reads %j as %i seconds", (header, seconds) => {
    expect(parseRetryAfterSeconds(header)).toBe(seconds);
  });

  it.each([
    "",
    "soon",
    "1.5",
    "-3",
    "+5",
    "7s",
    "Wed, 21 Oct 2026 07:28:00 GMT",
    "9".repeat(30),
  ])("reads %j as no answer at all", (header) => {
    expect(parseRetryAfterSeconds(header)).toBeUndefined();
  });

  it("reads a missing header as no answer", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
  });

  it("hands the seconds of a 429 to the caller, whatever the header's letter case", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "slow down" } }, 429))
    );
    const plain = await fetchWithDeadline("http://server.test/v1/ping");
    expect("retryAfterSeconds" in plain).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 429, headers: { "rEtRy-AfTeR": "11" } })
      )
    );
    const limited = await fetchWithDeadline("http://server.test/v1/ping");
    expect(limited.status).toBe(429);
    expect(limited.retryAfterSeconds).toBe(11);
  });

  it("gives nothing for an HTTP-date wait, which it will not turn into a guess", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 503,
            headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
          })
      )
    );
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.status).toBe(503);
    expect(res.retryAfterSeconds).toBeUndefined();
  });

  it("still answers when fetch hands back something with no headers at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 429, ok: false, text: async () => "{}" }))
    );
    const res = await fetchWithDeadline("http://server.test/v1/ping");
    expect(res.status).toBe(429);
    expect(res.retryAfterSeconds).toBeUndefined();
  });
});

// #5219 (additive): `fetchWithDeadline` reports how each exchange ended so the connection model can tell
// "the server cannot be reached" from "the socket dropped". Reporting must never change a request.
describe("REST outcome observation", () => {
  const heard: RestOutcome[] = [];
  const stops: Array<() => void> = [];
  afterEach(() => {
    heard.length = 0;
    while (stops.length > 0) stops.pop()?.();
  });
  const listen = () => stops.push(subscribeRestOutcome((outcome) => heard.push(outcome)));

  it("reports an answer (with the 5xx error.code and no query), a timeout and an unreachable host, and not the caller's own cancel", async () => {
    listen();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await fetchWithDeadline("http://server.test/v1/ping?page=2#frag", { method: "post" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "drive_unavailable", message: "no drive" } }, 503))
    );
    await fetchWithDeadline("http://server.test/v1/files");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await fetchWithDeadline("http://server.test/v1/html");
    vi.stubGlobal("fetch", neverAnswers());
    await fetchWithDeadline("http://server.test/v1/slow", {}, 20).catch(() => null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await fetchWithDeadline("http://server.test/v1/down").catch(() => null);
    vi.stubGlobal("fetch", neverAnswers());
    const caller = new AbortController();
    const cancelled = fetchWithDeadline("http://server.test/v1/cancelled", { signal: caller.signal }, 5_000);
    caller.abort();
    await cancelled.catch(() => null);

    expect(heard.map(({ kind, method, target }) => ({ kind, method, target }))).toEqual([
      { kind: "response", method: "POST", target: "http://server.test/v1/ping" },
      { kind: "response", method: "GET", target: "http://server.test/v1/files" },
      { kind: "response", method: "GET", target: "http://server.test/v1/html" },
      { kind: "network", method: "GET", target: "http://server.test/v1/slow" },
      { kind: "network", method: "GET", target: "http://server.test/v1/down" },
    ]);
    expect(heard[0]).toMatchObject({ status: 200 });
    expect(heard[0]).not.toHaveProperty("code");
    expect(heard[1]).toMatchObject({ status: 503, code: "drive_unavailable" });
    expect(heard[2]).toMatchObject({ status: 502 });
    expect(heard[2]).not.toHaveProperty("code");
    expect(heard[3]).toMatchObject({ failure: "timeout" });
    expect(heard[4]).toMatchObject({ failure: "unreachable" });
  });

  it("changes nothing about the request: a throwing subscriber, no subscriber and an unsubscribed one all see the same answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ seq: 7 })));
    stops.push(
      subscribeRestOutcome(() => {
        throw new Error("a broken subscriber");
      })
    );
    const withBroken = await fetchWithDeadline("http://server.test/v1/ping");
    expect(withBroken.json<{ seq: number }>()).toEqual({ seq: 7 });

    const unsubscribe = subscribeRestOutcome((outcome) => heard.push(outcome));
    unsubscribe();
    await fetchWithDeadline("http://server.test/v1/ping");
    expect(heard).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "x" } }, 409)));
    const refused = await fetchWithDeadline("http://server.test/v1/conflict");
    expect(refused.status).toBe(409);
  });

  it("changes nothing even when the report itself cannot be made (an address that is not a string)", async () => {
    // A subscriber is listening, so the report is built; building it throws on this address. Without the
    // guard that throw lands in fetchWithDeadline's own catch and the answered request becomes a NetworkError.
    listen();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ seq: 9 })));
    const odd = new URL("http://server.test/v1/odd") as unknown as string;
    const answered = await fetchWithDeadline(odd);
    expect(answered.json<{ seq: number }>()).toEqual({ seq: 9 });
    expect(heard).toEqual([]);
  });
});
