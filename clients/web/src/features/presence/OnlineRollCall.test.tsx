// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OnlineRollCall } from "./OnlineRollCall";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-000000000101";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** A realtime handle that records which workspaces are being counted in right now. */
function countingRealtime(): { counted: Set<string>; handle: RealtimeHandle } {
  const counted = new Set<string>();
  const handle = {
    joinOnlineRollCall: (workspaceId: string) => {
      counted.add(workspaceId);
      return () => {
        counted.delete(workspaceId);
      };
    },
  } as unknown as RealtimeHandle;
  return { counted, handle };
}

function session(workspaceId: string, realtime: RealtimeHandle | null): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function render(value: SessionContextValue): void {
  if (root === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root?.render(createElement(SessionProvider, { value }, createElement(OnlineRollCall))));
}

describe("OnlineRollCall: the app counts itself in while it is signed in (#4692)", () => {
  it("is counted into the signed-in workspace, draws nothing, and leaves on unmount", () => {
    const { counted, handle } = countingRealtime();
    render(session(WS, handle));
    expect([...counted]).toEqual([WS]);
    expect(host?.textContent).toBe("");

    act(() => root?.unmount());
    root = null;
    expect([...counted]).toEqual([]);
  });

  it("follows a workspace switch: the old roll-call is left before the new one is joined", () => {
    const { counted, handle } = countingRealtime();
    render(session(WS, handle));
    render(session(OTHER_WS, handle));
    expect([...counted]).toEqual([OTHER_WS]);
  });

  it("follows a new realtime handle (a new session): the old handle stops counting this app", () => {
    const first = countingRealtime();
    const second = countingRealtime();
    render(session(WS, first.handle));
    render(session(WS, second.handle));
    expect([...first.counted]).toEqual([]);
    expect([...second.counted]).toEqual([WS]);
  });

  it("is counted nowhere without a realtime handle, and a runtime that cannot join does not break the shell", () => {
    expect(() => render(session(WS, null))).not.toThrow();
    const legacy = {} as RealtimeHandle; // an older runtime: no `joinOnlineRollCall`
    expect(() => render(session(WS, legacy))).not.toThrow();
  });
});
