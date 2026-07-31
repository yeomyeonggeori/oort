import { describe, expect, it } from "vitest";
import { ApiError, displayNameFromEmail, handleFromEmail } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import { normalizeServerUrl } from "@/lib/serverBase";
import { resolveSpikeRealtimeUrl } from "@/lib/realtime";
import {
  parseJoinDeepLink,
  parseJoinFromPageUrl,
  urlWithoutJoinParams,
} from "./deepLink";
import { discoveredServers } from "./discovery";
import { joinFailureCopy, prefillFocus, signInFailureCopy } from "./connectModel";

// The connect surface is mostly decisions about untrusted text: a URL someone
// typed, a link someone forwarded, a service record a shell reported. Those are
// the parts pinned here; the DOM half is exercised by the browser smoke.

describe("server URL validation", () => {
  it("keeps an explicit http base, port and all", () => {
    expect(normalizeServerUrl("http://macbook.local:28000")).toEqual({
      ok: true,
      base: "http://macbook.local:28000",
    });
  });

  it("reads a bare host as https rather than downgrading it to http", () => {
    expect(normalizeServerUrl("momo.example.com")).toEqual({
      ok: true,
      base: "https://momo.example.com",
    });
  });

  it("trims whitespace and the trailing slash so /v1 concatenates cleanly", () => {
    expect(normalizeServerUrl("  https://momo.example.com/  ")).toEqual({
      ok: true,
      base: "https://momo.example.com",
    });
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(normalizeServerUrl("https://team.example.com/momo/")).toEqual({
      ok: true,
      base: "https://team.example.com/momo",
    });
  });

  it("drops a query and fragment nobody meant to send to /v1", () => {
    expect(normalizeServerUrl("https://momo.example.com/?a=b#c")).toEqual({
      ok: true,
      base: "https://momo.example.com",
    });
  });

  it("rejects a non-http scheme with what to do instead", () => {
    const result = normalizeServerUrl("ws://momo.example.com");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("http://");
  });

  it("rejects an empty address", () => {
    expect(normalizeServerUrl("   ").ok).toBe(false);
  });

  it("rejects a scheme with no host", () => {
    expect(normalizeServerUrl("https://").ok).toBe(false);
  });
});

describe("momo://join deep link", () => {
  it("parses the canonical link, percent-decoding the server", () => {
    expect(
      parseJoinDeepLink(
        "momo://join?server=https%3A%2F%2Fapi.example.com&code=Ab3-_x"
      )
    ).toEqual({ serverUrl: "https://api.example.com", inviteCode: "Ab3-_x" });
  });

  it("does not care about parameter order and ignores unknown parameters", () => {
    expect(
      parseJoinDeepLink(
        "momo://join?code=abc&utm=mail&server=http%3A%2F%2Fmacbook.local%3A28180"
      )
    ).toEqual({
      serverUrl: "http://macbook.local:28180",
      inviteCode: "abc",
    });
  });

  it("accepts the authority-less form the mac parser also accepts", () => {
    expect(parseJoinDeepLink("momo:join?code=abc")).toEqual({
      serverUrl: "",
      inviteCode: "abc",
    });
  });

  it("keeps the code when the link's server is unusable", () => {
    expect(parseJoinDeepLink("momo://join?server=not%20a%20url&code=abc")).toEqual(
      { serverUrl: "", inviteCode: "abc" }
    );
  });

  it("ignores another scheme, another action, and an empty link", () => {
    expect(parseJoinDeepLink("https://join?code=abc")).toBeNull();
    expect(parseJoinDeepLink("momo://open?code=abc")).toBeNull();
    expect(parseJoinDeepLink("momo://join")).toBeNull();
    expect(parseJoinDeepLink("not a url")).toBeNull();
  });
});

describe("browser deep-link fallback", () => {
  it("reads server and code off the page query", () => {
    expect(
      parseJoinFromPageUrl(
        "https://momo.example.com/?server=https%3A%2F%2Fapi.example.com&code=abc"
      )
    ).toEqual({ serverUrl: "https://api.example.com", inviteCode: "abc" });
  });

  it("unwraps a whole momo:// link passed as ?join=", () => {
    expect(
      parseJoinFromPageUrl(
        "https://momo.example.com/?join=momo%3A%2F%2Fjoin%3Fserver%3Dhttps%253A%252F%252Fapi.example.com%26code%3Dabc"
      )
    ).toEqual({ serverUrl: "https://api.example.com", inviteCode: "abc" });
  });

  it("reads the hash query the router leaves behind", () => {
    expect(
      parseJoinFromPageUrl("https://momo.example.com/#/?code=abc")
    ).toEqual({ serverUrl: "", inviteCode: "abc" });
  });

  it("stays out of the way of an ordinary page URL", () => {
    expect(parseJoinFromPageUrl("http://127.0.0.1:5173/?stress=40")).toBeNull();
    expect(parseJoinFromPageUrl("http://127.0.0.1:5173/#/c/abc")).toBeNull();
  });

  it("strips the invite parameters and leaves everything else alone", () => {
    expect(
      urlWithoutJoinParams(
        "https://momo.example.com/?stress=40&code=secret&server=https%3A%2F%2Fapi.example.com#/inbox?code=secret&tab=all"
      )
    ).toBe("https://momo.example.com/?stress=40#/inbox?tab=all");
  });
});

describe("LAN discovery decisions", () => {
  it("offers a sighting whose advertised base is a usable http(s) URL", () => {
    expect(
      discoveredServers([
        { instanceName: "momo", baseUrl: "http://macbook.local:28000" },
      ])
    ).toEqual([
      { base: "http://macbook.local:28000", displayHost: "macbook.local:28000" },
    ]);
  });

  it("prefers the label the shell reported over one derived from the URL", () => {
    expect(
      discoveredServers([
        {
          baseUrl: "http://macbook.local:28000",
          displayHost: "MacBook-Pro-2.local:28000",
        },
      ])[0].displayHost
    ).toBe("MacBook-Pro-2.local:28000");
  });

  it("dedupes by base and preserves discovery order", () => {
    expect(
      discoveredServers([
        { baseUrl: "http://a.local:28000" },
        { baseUrl: "http://b.local:28000" },
        { baseUrl: "http://a.local:28000" },
      ]).map((server) => server.base)
    ).toEqual(["http://a.local:28000", "http://b.local:28000"]);
  });

  it("stays silent rather than guessing an address it was not told", () => {
    expect(
      discoveredServers([
        { instanceName: "momo", displayHost: "macbook.local:28000" },
        { baseUrl: "ftp://macbook.local" },
        { baseUrl: "   " },
        {},
      ])
    ).toEqual([]);
  });

  it("drops the port from the label when it is the scheme default", () => {
    expect(
      discoveredServers([{ baseUrl: "https://momo.example.com" }])[0].displayHost
    ).toBe("momo.example.com");
  });
});

describe("realtime address resolution (ADR-0110 boundary)", () => {
  const ws = "ws://macbook.local:28001/connection/websocket";

  it("rewrites a .local host only while the REST base is loopback", () => {
    expect(resolveSpikeRealtimeUrl(ws, { pageHost: "127.0.0.1", base: "" })).toBe(
      "ws://127.0.0.1:28001/connection/websocket"
    );
  });

  it("leaves the login address verbatim for a remote server", () => {
    expect(
      resolveSpikeRealtimeUrl(ws, {
        pageHost: "127.0.0.1",
        base: "https://api.example.com",
      })
    ).toBe(ws);
  });

  it("does not read the Tauri shell's own localhost origin as local dev", () => {
    expect(
      resolveSpikeRealtimeUrl(ws, {
        pageHost: "localhost",
        base: "http://192.168.0.9:28000",
      })
    ).toBe(ws);
  });

  it("leaves an already-loopback address and a malformed one alone", () => {
    const loopback = "ws://127.0.0.1:28001/connection/websocket";
    expect(
      resolveSpikeRealtimeUrl(loopback, { pageHost: "127.0.0.1", base: "" })
    ).toBe(loopback);
    expect(
      resolveSpikeRealtimeUrl("not a url", { pageHost: "127.0.0.1", base: "" })
    ).toBe("not a url");
  });
});

describe("prefill focus", () => {
  const filled = {
    serverUrl: "https://api.example.com",
    email: "seongjae@example.com",
    password: "pw",
    requiresServer: true,
  };

  it("lands on the first field the link could not fill", () => {
    expect(prefillFocus({ ...filled, email: "", password: "" })).toBe("email");
    expect(prefillFocus({ ...filled, password: "" })).toBe("password");
  });

  it("asks for a server first only where same-origin is not an option", () => {
    expect(prefillFocus({ ...filled, serverUrl: "" })).toBe("server");
    expect(
      prefillFocus({ ...filled, serverUrl: "", requiresServer: false })
    ).toBe("code");
  });
});

describe("failure copy", () => {
  it("splits the two meanings each invite status carries", () => {
    expect(joinFailureCopy(new ApiError(410, "invite expired")).message).toContain(
      "만료"
    );
    expect(joinFailureCopy(new ApiError(410, "invite revoked")).message).toContain(
      "회수"
    );
    expect(
      joinFailureCopy(new ApiError(409, "invite exhausted")).message
    ).toContain("사용 횟수");
  });

  it("sends an already-redeemed invite to the sign-in path", () => {
    const failure = joinFailureCopy(
      new ApiError(409, "invite already redeemed for this email")
    );
    expect(failure.suggestSignIn).toBe(true);
  });

  it("never shows a raw transport failure as an invite verdict", () => {
    const unreachable = new NetworkError("unreachable", 15_000);
    expect(joinFailureCopy(unreachable).message).toContain("서버에 닿지 못했습니다");
    expect(signInFailureCopy(unreachable).message).toContain(
      "서버에 닿지 못했습니다"
    );
    // A body that is not JSON is a client-side fault, not a verdict either.
    expect(signInFailureCopy(new SyntaxError("bad json")).message).toContain(
      "서버 응답을 읽지 못했습니다"
    );
  });

  it("offers a retry only where sending the same thing again could work", () => {
    // Nothing answered: the input is fine, the address or the network is not.
    expect(signInFailureCopy(new NetworkError("timeout", 15_000)).retryable).toBe(
      true
    );
    expect(signInFailureCopy(new ApiError(500, "boom")).retryable).toBe(true);
    // A rejected password is corrected in the field, not by pressing again.
    expect(signInFailureCopy(new ApiError(401, "invalid")).retryable).toBe(false);
    expect(joinFailureCopy(new ApiError(410, "invite expired")).retryable).toBe(
      false
    );
  });

  it("names which absence happened, because the next move differs", () => {
    expect(signInFailureCopy(new NetworkError("timeout", 15_000)).message).toContain(
      "15초"
    );
  });

  it("rewords the one sign-in status that has a human meaning", () => {
    expect(signInFailureCopy(new ApiError(401, "invalid credentials")).message).toBe(
      "이메일 또는 비밀번호가 맞지 않습니다."
    );
    expect(signInFailureCopy(new ApiError(500, "boom")).message).toBe("boom");
  });
});

describe("identity derived from an email (mac client parity)", () => {
  it("title-cases the dotted local part", () => {
    expect(displayNameFromEmail("seong.jae@example.com")).toBe("Seong Jae");
    expect(handleFromEmail("Seong.Jae@example.com")).toBe("seong-jae");
  });

  it("never produces an empty handle", () => {
    expect(handleFromEmail("...@example.com")).toBe("oort-user");
  });
});
