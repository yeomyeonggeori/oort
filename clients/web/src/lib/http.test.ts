import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkError, fetchWithDeadline } from "./http";

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
    expect((failure as NetworkError).message).toContain("응답하지 않았습니다");
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
    expect((failure as NetworkError).message).toContain("서버에 닿지 못했습니다");
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
