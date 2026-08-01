import { describe, expect, it } from "vitest";
import { connectionAlert, type ConnectionAlertInput } from "./connectionAlert";

function input(overrides: Partial<ConnectionAlertInput> = {}): ConnectionAlertInput {
  return {
    browserOffline: false,
    connStatus: "connected",
    sustained: false,
    ...overrides,
  };
}

describe("connectionAlert", () => {
  it("says nothing while the rail is up", () => {
    expect(connectionAlert(input())).toBeNull();
    expect(connectionAlert(input({ sustained: true }))).toBeNull();
  });

  it("says nothing during the ordinary opening handshake", () => {
    expect(connectionAlert(input({ connStatus: "connecting" }))).toBeNull();
  });

  it("says nothing about a drop that heals inside the dwell", () => {
    expect(connectionAlert(input({ connStatus: "disconnected" }))).toBeNull();
  });

  // The QA case: the socket never came up at all, so the status stays
  // `connecting` and the only signal on screen was an 8px dot.
  it("names a handshake that never completed", () => {
    const alert = connectionAlert(
      input({ connStatus: "connecting", sustained: true })
    );
    expect(alert?.kind).toBe("never-connected");
    expect(alert?.canRetry).toBe(true);
    expect(alert?.message).toContain("아직");
  });

  it("names a connection that was lost, in different words", () => {
    const alert = connectionAlert(
      input({ connStatus: "disconnected", sustained: true })
    );
    expect(alert?.kind).toBe("dropped");
    expect(alert?.canRetry).toBe(true);
    const never = connectionAlert(
      input({ connStatus: "connecting", sustained: true })
    );
    expect(alert?.message).not.toBe(never?.message);
  });

  it("reports the browser's own offline immediately and offers no retry", () => {
    const alert = connectionAlert(input({ browserOffline: true }));
    expect(alert?.kind).toBe("browser-offline");
    expect(alert?.canRetry).toBe(false);
  });

  it("lets the browser's answer outrank the rail's", () => {
    const alert = connectionAlert(
      input({ browserOffline: true, connStatus: "disconnected", sustained: true })
    );
    expect(alert?.kind).toBe("browser-offline");
  });
});
