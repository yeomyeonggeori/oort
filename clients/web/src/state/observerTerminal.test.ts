import { describe, expect, it } from "vitest";
import {
  initialObserverTerminalState,
  reduceObserverTerminal,
  type ObserverTerminalState,
} from "./observerTerminal";

function step(
  state: ObserverTerminalState,
  event: Parameters<typeof reduceObserverTerminal>[1]
) {
  return reduceObserverTerminal(state, event);
}

describe("observer terminal state machine", () => {
  it("starts requesting from idle", () => {
    expect(step(initialObserverTerminalState, { type: "request" })).toEqual({
      status: "requesting",
    });
  });

  it("moves from a grant to connecting", () => {
    expect(step({ status: "requesting" }, { type: "grant" }).status).toBe(
      "connecting"
    );
  });

  it("marks the stream connected only after transport open", () => {
    expect(step({ status: "connecting" }, { type: "connected" }).status).toBe(
      "connected"
    );
  });

  it("marks an active stream disconnected on close", () => {
    expect(step({ status: "connected" }, { type: "closed" }).status).toBe(
      "disconnected"
    );
  });

  it("retains a safe close explanation", () => {
    expect(
      step(
        { status: "connecting" },
        { type: "closed", message: "세션이 종료되었습니다." }
      )
    ).toEqual({ status: "disconnected", message: "세션이 종료되었습니다." });
  });

  it("turns grant request failures into retryable errors", () => {
    expect(
      step(
        { status: "requesting" },
        { type: "failed", message: "관전 권한이 없습니다." }
      )
    ).toEqual({ status: "error", message: "관전 권한이 없습니다." });
  });

  it("turns attach failures into retryable errors", () => {
    expect(
      step(
        { status: "connecting" },
        { type: "failed", message: "호스트에 연결할 수 없습니다." }
      ).status
    ).toBe("error");
  });

  it("surfaces a stream failure after connection", () => {
    expect(
      step(
        { status: "connected" },
        { type: "failed", message: "스트림이 끊겼습니다." }
      )
    ).toEqual({ status: "error", message: "스트림이 끊겼습니다." });
  });

  it("can retry after disconnect", () => {
    expect(step({ status: "disconnected" }, { type: "request" }).status).toBe(
      "requesting"
    );
  });

  it("can retry after an error without retaining the message", () => {
    expect(
      step({ status: "error", message: "old" }, { type: "request" })
    ).toEqual({ status: "requesting" });
  });

  it("ignores stale connected events", () => {
    const idle = { status: "idle" } as const;
    expect(step(idle, { type: "connected" })).toBe(idle);
  });

  it("ignores duplicate requests while active", () => {
    const connected = { status: "connected" } as const;
    expect(step(connected, { type: "request" })).toBe(connected);
  });

  it("resets every state to idle", () => {
    expect(step({ status: "connected" }, { type: "reset" })).toEqual({
      status: "idle",
    });
  });
});
