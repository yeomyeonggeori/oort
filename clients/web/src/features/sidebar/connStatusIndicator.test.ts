import { describe, expect, it } from "vitest";
import {
  connectionBarClass,
  connectionCopy,
  showsConnectionBar,
} from "./connStatusIndicator";

// Red proof for presence 6a + its 6b design-review repair (H1). The connection
// indicator moved from the workspace rail to the profile panel, and two things
// must survive: its label and colour stay bound to connStatus (hardcoding either
// is the "decorate the dot" regression, SKILL §8), and a healthy rail draws
// NOTHING. It does not assert placement or shape in pixels — design-review
// screenshots do that.
describe("connection status indicator (presence 6a/6b)", () => {
  it("labels each realtime status with the shared copy, no fork", () => {
    expect(connectionCopy("connected")).toBe("실시간 연결됨");
    expect(connectionCopy("connecting")).toBe("연결 중");
    expect(connectionCopy("disconnected")).toBe("연결 끊김, 재연결 중");
  });

  // H1: a permanent green dot is decoration, and it also collided with the
  // presence badge one row away. Health is reported by silence.
  it("stands only while the rail is unhealthy", () => {
    expect(showsConnectionBar("connected")).toBe(false);
    expect(showsConnectionBar("connecting")).toBe(true);
    expect(showsConnectionBar("disconnected")).toBe(true);
  });

  it("maps the two unhealthy states to status tokens, and connected to nothing", () => {
    expect(connectionBarClass("connecting")).toBe("bg-warn");
    expect(connectionBarClass("disconnected")).toBe("bg-danger");
    // Not `bg-ok`: there is no healthy colour, because there is no healthy
    // indicator. Returning a class here is how the green dot comes back.
    expect(connectionBarClass("connected")).toBe("");
  });
});
