import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError, type WorkSession } from "@/lib/api";
import { NetworkError } from "@/lib/http";
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
  OBSERVER_FAILURE_COPY,
  OBSERVER_SUBPROTOCOL,
  type ObserverFailure,
} from "./observerStream";

const OWNER = "00000000-0000-7000-8000-000000000101";

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "019F9AB9-6DA4-7BE7-9BC9-4A3872D921C3",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019F9AB9-6D9D-7A55-8AE8-4BD879349572",
    memberId: OWNER,
    hostId: "019F9AB9-6D96-7761-BB2C-4D1DF7D60A3A",
    rootMessageId: "019F9AB9-6DA4-7BE7-9BC9-4A3872D921C4",
    tool: "claude",
    label: "relay outbox_drain 재시작 루프 조사",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    startedAtMs: 1785007271329,
    ...over,
  };
}

describe("the observer sends nothing", () => {
  // The D1 contract says the observer grade cannot issue stdin/resize/kill
  // frames AT ALL. On this side that is enforced by absence, so the test that
  // protects it is a test about the source file: adding an encoder is the one
  // change that would silently turn a read-only surface into a writable one.
  it("has no encoder for stdin, resize or kill", () => {
    const source = readFileSync(
      new URL("./observerStream.ts", import.meta.url),
      "utf8"
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("send_stdin");
    expect(code).not.toContain('"resize"');
    expect(code).not.toContain('"kill"');
  });

  it("builds the mac's connect frame byte for byte", () => {
    expect(connectFrame("pty-619-abc")).toBe(
      '{"pty_id":"pty-619-abc","type":"connect"}'
    );
  });

  it("mirrors the server pty id grammar", () => {
    expect(isValidPtyId("pty-619-abc")).toBe(true);
    expect(isValidPtyId("_leading")).toBe(false);
    expect(isValidPtyId("has space")).toBe(false);
    expect(isValidPtyId("")).toBe(false);
    expect(isValidPtyId(`a${"b".repeat(128)}`)).toBe(false);
  });
});

describe("attachSocketUrl", () => {
  it("promotes https to wss and keeps wss", () => {
    expect(attachSocketUrl("https://host.example/v1/pty")).toBe(
      "wss://host.example/v1/pty"
    );
    expect(attachSocketUrl("wss://host.example:8443/pty")).toBe(
      "wss://host.example:8443/pty"
    );
  });

  it("refuses anything the server would not have stored", () => {
    expect(attachSocketUrl("ws://host.example/pty")).toBeNull();
    expect(attachSocketUrl("http://host.example/pty")).toBeNull();
    expect(attachSocketUrl("wss://user:pw@host.example/pty")).toBeNull();
    expect(attachSocketUrl("wss://host.example/pty?token=x")).toBeNull();
    expect(attachSocketUrl("wss://host.example/pty#frag")).toBeNull();
    expect(attachSocketUrl("not a url")).toBeNull();
  });
});

describe("capability bearer transport", () => {
  it("carries the token as a subprotocol, since a browser has no headers", () => {
    const token = `momo_terminal_attach_v1.${"a".repeat(43)}`;
    expect(observerSubprotocols(token)).toEqual([OBSERVER_SUBPROTOCOL, token]);
  });

  it("keeps the token a legal websocket subprotocol token", () => {
    const token = `momo_terminal_attach_v1.${"aZ0_-".repeat(8)}abc`;
    for (const value of observerSubprotocols(token)) {
      expect(value).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
    }
  });
});

describe("classifyGrantFailure", () => {
  it("separates a refusal from an absence", () => {
    expect(classifyGrantFailure(new ApiError(403, "forbidden"))).toBe(
      "capability_denied"
    );
    expect(classifyGrantFailure(new ApiError(409, "unavailable"))).toBe(
      "session_unavailable"
    );
    expect(classifyGrantFailure(new ApiError(404, "not found"))).toBe(
      "session_unavailable"
    );
    expect(classifyGrantFailure(new NetworkError("timeout", 15_000))).toBe(
      "server_unreachable"
    );
    expect(classifyGrantFailure(new Error("boom"))).toBe("server_unreachable");
  });
});

describe("classifyClose", () => {
  it("never reads a socket that never opened as a dropped stream", () => {
    expect(classifyClose({ opened: false, code: 1006, reason: "" })).toBe(
      "host_unreachable"
    );
    expect(classifyClose({ opened: true, code: 1006, reason: "" })).toBe(
      "stream_dropped"
    );
    expect(classifyClose({ opened: true, code: 1000, reason: "" })).toBe(
      "stream_closed"
    );
  });

  it("keeps the mac's reason vocabulary", () => {
    expect(
      classifyClose({ opened: false, code: 1008, reason: "capability expired" })
    ).toBe("grant_expired");
    expect(
      classifyClose({ opened: true, code: 1008, reason: "host revoked" })
    ).toBe("host_revoked");
    expect(
      classifyClose({ opened: false, code: 1008, reason: "forbidden" })
    ).toBe("capability_denied");
  });
});

describe("failure copy", () => {
  const failures = Object.keys(OBSERVER_FAILURE_COPY) as ObserverFailure[];

  it("says what happened for every failure, with no em-dash and no apology", () => {
    for (const failure of failures) {
      const copy = OBSERVER_FAILURE_COPY[failure];
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/[—–]/);
      expect(copy).not.toMatch(/죄송|불편|오류가 발생했습니다\.$/);
    }
  });

  it("names the deadline in the timeout copy, so the number cannot drift", () => {
    expect(OBSERVER_FAILURE_COPY.host_timeout).toContain(
      `${HOST_CONNECT_TIMEOUT_MS / 1000}초`
    );
  });

  it("offers a retry only where retrying can change the answer", () => {
    expect(isRetryable("stream_dropped")).toBe(true);
    expect(isRetryable("host_unreachable")).toBe(true);
    expect(isRetryable("host_timeout")).toBe(true);
    // The owner closed observation or the session ended: the next step is not
    // a retry, it is a different fact on screen.
    expect(isRetryable("observation_closed")).toBe(false);
    expect(isRetryable("session_ended")).toBe(false);
    expect(isRetryable("stream_closed")).toBe(false);
    expect(isRetryable("grant_invalid")).toBe(false);
  });
});

describe("observeGate", () => {
  it("offers watching only for a running session with a host terminal", () => {
    expect(observeGate(session(), false).available).toBe(true);
  });

  it("states the reason instead of a dead control", () => {
    expect(observeGate(session({ status: "ended" }), true).reason).toContain(
      "끝난 세션"
    );
    expect(
      observeGate(session({ remoteAttachAvailable: false }), true).reason
    ).toContain("호스트 터미널");
    expect(
      observeGate(session({ observation: "owner_only" }), false).reason
    ).toBe("세션 소유자가 관전을 닫아 두었습니다.");
  });

  it("tells the owner what to do about their own closed session", () => {
    const gate = observeGate(session({ observation: "owner_only" }), true);
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain("팀원 관전을 허용하면");
  });

  it("reports an ended session as ended even when it has a terminal binding", () => {
    const gate = observeGate(
      session({ status: "ended", observation: "owner_only" }),
      true
    );
    expect(gate.reason).toContain("끝난 세션");
  });
});

describe("observation scope control", () => {
  it("belongs to the owner of a running session", () => {
    expect(canChangeObservation(session(), OWNER)).toBe(true);
    // Ids cross the wire in mixed case (uuidEq), so this must fold.
    expect(canChangeObservation(session(), OWNER.toUpperCase())).toBe(true);
    expect(canChangeObservation(session(), "00000000-0000-7000-8000-000000000102")).toBe(
      false
    );
    expect(canChangeObservation(session({ status: "ended" }), OWNER)).toBe(false);
  });
});

describe("observationStillPermits", () => {
  it("drops a live socket the ledger no longer allows", () => {
    expect(observationStillPermits(session())).toBeNull();
    expect(observationStillPermits(session({ status: "ended" }))).toBe(
      "session_ended"
    );
    expect(observationStillPermits(session({ status: "orphaned" }))).toBe(
      "session_ended"
    );
    expect(
      observationStillPermits(session({ observation: "owner_only" }))
    ).toBe("observation_closed");
  });
});

describe("observerCountLabel", () => {
  it("keeps the mac wording", () => {
    expect(observerCountLabel(3)).toBe("관전 3");
  });
});
