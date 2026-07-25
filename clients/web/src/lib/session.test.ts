import { describe, expect, it } from "vitest";
import type { LoginResponse } from "./api";
import { parsePersistedSession, restoredLoginResponse } from "./session";

// The store's stateful half talks to localStorage and is exercised by the
// browser smoke; what is worth pinning here is the boundary that decides
// whether a reload resumes at all: what counts as a usable stored record, and
// what a restored session is allowed to claim.

const member: LoginResponse["member"] = {
  id: "0199aaaa-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human",
  displayName: "곽성재",
  handle: "seongjae",
};

const stored = {
  refreshToken: "refresh.token.value",
  realtimeWebSocketUrl: "ws://momowebqa.local:28001/connection/websocket",
  member,
};

describe("persisted session parsing", () => {
  it("accepts a complete record", () => {
    expect(parsePersistedSession(JSON.stringify(stored))).toEqual(stored);
  });

  it("treats an absent record as no session", () => {
    expect(parsePersistedSession(null)).toBeNull();
    expect(parsePersistedSession("")).toBeNull();
  });

  it("treats a corrupt record as no session instead of crashing the boot", () => {
    expect(parsePersistedSession("{not json")).toBeNull();
  });

  it("rejects a record missing the refresh token, which is the whole point", () => {
    const { refreshToken: _dropped, ...rest } = stored;
    expect(parsePersistedSession(JSON.stringify(rest))).toBeNull();
    expect(
      parsePersistedSession(JSON.stringify({ ...stored, refreshToken: "" }))
    ).toBeNull();
  });

  it("rejects a record missing the websocket address", () => {
    const { realtimeWebSocketUrl: _dropped, ...rest } = stored;
    expect(parsePersistedSession(JSON.stringify(rest))).toBeNull();
  });

  it("rejects a record whose member identity is incomplete", () => {
    expect(
      parsePersistedSession(
        JSON.stringify({ ...stored, member: { id: member.id } })
      )
    ).toBeNull();
  });
});

describe("restored session", () => {
  it("pairs the stored identity with the freshly rotated access token", () => {
    const restored = restoredLoginResponse(stored, "new.access.token");
    expect(restored.accessToken).toBe("new.access.token");
    expect(restored.member).toEqual(member);
  });

  it("keeps the websocket address the server issued, never a derived one", () => {
    // ADR-0110: the login response is the only authority for this address, so a
    // resume must carry it forward verbatim rather than rebuild it from origin.
    const restored = restoredLoginResponse(stored, "new.access.token");
    expect(restored.realtimeWebSocketUrl).toBe(stored.realtimeWebSocketUrl);
  });
});
