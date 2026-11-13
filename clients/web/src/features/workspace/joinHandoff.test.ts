import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOpenHref, isSameServer, opensInBrowser, probeServerReachable } from "./joinHandoff";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isSameServer (#5785 수리 1회차)", () => {
  it("끝 슬래시·대소문자는 같은 서버로 본다", () => {
    expect(isSameServer("https://Team.Example.com/", "https://team.example.com")).toBe(true);
  });
  it("포트·스킴·호스트가 다르면 다른 서버다", () => {
    expect(isSameServer("https://team.example.com", "https://team.example.com:8443")).toBe(false);
    expect(isSameServer("http://team.example.com", "https://team.example.com")).toBe(false);
    expect(isSameServer("https://a.example.com", "https://b.example.com")).toBe(false);
  });
  it("빈 주소끼리는 같다고 하지 않는다", () => {
    expect(isSameServer("", "")).toBe(false);
  });
});

describe("probeServerReachable", () => {
  it("응답이 오면 닿은 것이다(no-cors로 /healthz, 쿠키 없이)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: "opaque" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeServerReachable("https://team.example.com/")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://team.example.com/healthz");
    expect(init.mode).toBe("no-cors");
    expect(init.credentials).toBe("omit");
  });

  it("이름이 안 풀리거나 연결이 거절되면(fetch가 던지면) 닿지 않은 것이다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(probeServerReachable("https://tema.exmaple.com")).resolves.toBe(false);
  });

  it("시간 안에 답이 없으면 닿지 않은 것이다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );
    const pending = probeServerReachable("https://slow.example.com", 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toBe(false);
  });
});

describe("opensInBrowser · browserOpenHref (#5785 수리 2회차)", () => {
  const other = { kind: "server", serverUrl: "https://team.example.com" } as const;
  it("웹이고 출처가 다르면 브라우저로 연다. 데스크탑·같은 출처·서버 없는 초대는 아니다", () => {
    expect(opensInBrowser(other, false, "https://app.oor7.com")).toBe(true);
    expect(opensInBrowser(other, true, "https://app.oor7.com")).toBe(false);
    expect(opensInBrowser(other, false, "https://team.example.com/")).toBe(false);
    expect(opensInBrowser({ kind: "invite", serverUrl: "", inviteCode: "x" }, false, "https://a.b")).toBe(false);
  });
  it("http·https만 연다(javascript:·data:·ftp:는 null)", () => {
    expect(browserOpenHref(other)).toBe("https://team.example.com/");
    expect(browserOpenHref({ kind: "server", serverUrl: "http://10.0.0.5:8080" })).toBe("http://10.0.0.5:8080/");
    for (const serverUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example.com", "not a url"]) {
      expect(browserOpenHref({ kind: "server", serverUrl })).toBeNull();
    }
  });
  it("초대면 코드를 실어서 연다", () => {
    expect(
      browserOpenHref({ kind: "invite", serverUrl: "https://team.example.com", inviteCode: "abc_DEF-123" })
    ).toBe("https://team.example.com/?code=abc_DEF-123");
  });
});
