// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse } from "@momo/core/lib/api";
import { ClaimPage } from "./ClaimPage";
import {
  dismissPhoneLinkFirstRun,
  phoneLinkFirstRunIsPending,
} from "./phoneLinkFirstRunStore";
import {
  clearAllFirstAgentMarkers,
  firstAgentIsPending,
  writeFirstAgentMarker,
} from "@/features/welcome/firstAgentStore";
import { clearFreshSignup, peekFreshSignup } from "@/features/welcome/freshSignup";
import {
  decideFirstRunForSession,
  resetKickoffHoldForTests,
  settleKickoffHold,
  type FirstRunSurface,
} from "@/features/welcome/firstRunGate";

// =============================================================================
// claim 성공 뒤 first-run 사다리 (#2301).
//
// ClaimPage 가 markFreshSignup 하나만 찍던 동안 게이트는 곧장 "app" 이었다.
// 여기서는 App.tsx 가 게이트에 넘기는 입력 그대로 물어, 네 마커 중 하나라도
// 빠지면 사다리의 한 칸이 무너지게 잰다:
//   holdKickoffForFreshSignup 누락    → 1칸 "kickoff-hold" 가 "first-agent"
//   markFreshSignup 누락              → 1칸 "kickoff-hold" 가 "first-agent"
//                                       (fresh 마커 부재는 settled 로 읽힌다)
//   markFirstAgentPending 누락        → 2칸 "first-agent" 가 "phone-link"
//   markPhoneLinkFirstRunPending 누락 → 3칸 "phone-link" 가 "app"
// =============================================================================

const claimOwnerPassword = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    claimOwnerPassword: (...args: unknown[]) =>
      claimOwnerPassword(...args) as Promise<LoginResponse>,
  };
});

// claimPath.ts TOKEN_SHAPE: 43 base64url chars, no padding.
const TOKEN = "A".repeat(43);
const PASSWORD = "correct-horse-battery-staple";

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "데모 사용자",
    handle: "demo",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

function resetFirstRunState() {
  sessionStorage.clear();
  clearAllFirstAgentMarkers();
  clearFreshSignup();
  resetKickoffHoldForTests();
}

beforeEach(() => {
  resetFirstRunState();
  claimOwnerPassword.mockReset();
  claimOwnerPassword.mockResolvedValue(session);
  window.history.replaceState(null, "", `/claim/${TOKEN}`);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  resetFirstRunState();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

/** App.tsx 가 게이트에 넘기는 입력 그대로. */
function decide(): FirstRunSurface {
  return decideFirstRunForSession({
    workspaceId: session.member.workspaceId,
    phonePending: phoneLinkFirstRunIsPending(),
  });
}

function fill(testId: string, value: string) {
  const node = document.querySelector(
    `[data-testid="${testId}"]`
  ) as HTMLInputElement | null;
  expect(node, testId).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node, testId).not.toBeNull();
  act(() => {
    (node as HTMLElement).click();
  });
}

async function submitClaim(
  onLoggedIn: (next: LoginResponse) => void
): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(ClaimPage, { onLoggedIn }));
  });
  fill("claim-password", PASSWORD);
  fill("claim-confirm", PASSWORD);
  await act(async () => {
    click("claim-submit");
  });
  return host;
}

describe("claim → first-run 사다리 (#2301)", () => {
  it("claim 성공 뒤 게이트가 kickoff-hold → first-agent → phone-link → app 순으로 연다", async () => {
    // 전제: 마커가 없는 세션은 곧장 앱. 아래 단정이 헛돌지 않게 먼저 잰다.
    expect(decide()).toBe("app");

    const surfacesAtHandoff: FirstRunSurface[] = [];
    const onLoggedIn = vi.fn(() => {
      surfacesAtHandoff.push(decide());
    });
    await submitClaim(onLoggedIn);
    await vi.waitFor(() => {
      expect(onLoggedIn).toHaveBeenCalledTimes(1);
    });
    expect(onLoggedIn).toHaveBeenCalledWith(session);
    expect(claimOwnerPassword).toHaveBeenCalledWith(TOKEN, PASSWORD);
    expect(window.location.pathname).toBe("/");

    // 마커는 세션을 넘기기 전에 다 찍혀 있다 — App 이 첫 렌더에서 "app" 을 보지 않게.
    expect(surfacesAtHandoff).toEqual(["kickoff-hold"]);

    // 1칸: 킥오프 홀드. fresh-signup 마커와 홀드가 짝으로 있어야 선다.
    expect(peekFreshSignup()).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
    expect(decide()).toBe("kickoff-hold");

    // 2칸: 첫 에이전트 (#2216).
    settleKickoffHold();
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(true);
    expect(decide()).toBe("first-agent");

    // 3칸: 폰 연결 (ADR-0180 D7).
    writeFirstAgentMarker(session.member.workspaceId, "done");
    expect(phoneLinkFirstRunIsPending()).toBe(true);
    expect(decide()).toBe("phone-link");

    // 4칸: 앱.
    dismissPhoneLinkFirstRun();
    expect(decide()).toBe("app");
  });

  it("claim 실패는 마커를 하나도 찍지 않는다", async () => {
    claimOwnerPassword.mockRejectedValue(new ApiError(410, "claim token expired"));
    const onLoggedIn = vi.fn();
    const host = await submitClaim(onLoggedIn);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="claim-error"]')).not.toBeNull();
    });
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(peekFreshSignup()).toBeNull();
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(false);
    expect(phoneLinkFirstRunIsPending()).toBe(false);
    expect(decide()).toBe("app");
  });
});
