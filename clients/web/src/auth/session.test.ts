import { describe, expect, it } from "vitest";
import { rotateSessionData, type SessionData } from "./session";

const session: SessionData = {
  refreshToken: "old-refresh",
  realtimeWebSocketUrl: "wss://rt.example.com/connection/websocket",
  member: {
    id: "00000000-0000-0000-0000-000000000001",
    workspaceId: "00000000-0000-0000-0000-000000000002",
    kind: "human",
    displayName: "곽성재",
    handle: "sj",
  },
};

describe("refresh token rotation", () => {
  it("replaces only the persisted refresh token", () => {
    const rotated = rotateSessionData(session, "new-refresh");
    expect(rotated.refreshToken).toBe("new-refresh");
    expect(rotated.member).toBe(session.member);
    expect(rotated.realtimeWebSocketUrl).toBe(session.realtimeWebSocketUrl);
  });

  it("does not mutate the previous session snapshot", () => {
    rotateSessionData(session, "new-refresh");
    expect(session.refreshToken).toBe("old-refresh");
  });
});
