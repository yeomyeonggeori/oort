import { describe, expect, it } from "vitest";
import { connectionCopy, connectionDotClass } from "./connStatusIndicator";

// Red proof for presence 6a. The connection indicator moved from the workspace
// rail to the profile panel, and the one thing that must survive the move is
// that its label and color stay bound to connStatus. Hardcoding either (the
// "decorate the dot" regression, SKILL §8) or forking the strings turns these
// red. It does not assert placement — design-review screenshots do that.
describe("connection status indicator (presence 6a)", () => {
  it("labels each realtime status with the shared copy, no fork", () => {
    expect(connectionCopy("connected")).toBe("실시간 연결됨");
    expect(connectionCopy("connecting")).toBe("연결 중");
    expect(connectionCopy("disconnected")).toBe("연결 끊김, 재연결 중");
  });

  it("maps each status to a status token color, and only status tokens", () => {
    expect(connectionDotClass("connected")).toBe("bg-ok");
    expect(connectionDotClass("connecting")).toBe("bg-warn");
    expect(connectionDotClass("disconnected")).toBe("bg-danger");
  });
});
