// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { PHONE_LINK_FIRST_RUN_KEY } from "@/features/auth/phoneLinkFirstRunStore";
import { clearAllFirstAgentMarkers, firstAgentIsPending } from "./firstAgentStore";
import { clearFreshSignup, peekFreshSignup } from "./freshSignup";
import { peekKickoffSettled, resetKickoffHoldForTests } from "./firstRunGate";
import {
  recordFirstRunPending,
  recordFreshSignupFirstRun,
} from "./freshSignupFirstRun";

// 저장소 슬롯 이름은 각 스토어의 비공개 상수다. ConnectPage.test.tsx 가 그러듯
// 여기 그대로 적어 쓰기 순서를 잰다 — 이름이 바뀌면 이 시험이 먼저 붉다.
const FIRST_AGENT_PENDING_SLOT = "momo.web.firstAgentPending.v1";
const FRESH_SIGNUP_SLOT = "oort.freshSignup.v1";

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

function reset() {
  sessionStorage.clear();
  clearAllFirstAgentMarkers();
  clearFreshSignup();
  resetKickoffHoldForTests();
}

beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

/** 실행 중 sessionStorage/localStorage 에 쓰인 키를 순서대로 모은다. */
function recordWrites(run: () => void): string[] {
  const keys: string[] = [];
  const orig = Storage.prototype.setItem;
  const spy = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key: string, value: string) {
      keys.push(key);
      return orig.call(this, key, value);
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return keys;
}

describe("recordFreshSignupFirstRun (#2301)", () => {
  it("invite-join 이 찍던 순서 그대로 넷을 찍는다: 폰 → 첫 에이전트 → fresh-signup → 킥오프 홀드", () => {
    expect(peekKickoffSettled()).toBe(true);
    const keys = recordWrites(() => recordFreshSignupFirstRun(session));
    expect(keys).toEqual([
      PHONE_LINK_FIRST_RUN_KEY,
      FIRST_AGENT_PENDING_SLOT,
      FRESH_SIGNUP_SLOT,
    ]);
    expect(sessionStorage.getItem(PHONE_LINK_FIRST_RUN_KEY)).toBe("pending");
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(true);
    expect(peekFreshSignup()).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
    expect(peekKickoffSettled()).toBe(false);
  });

  it("recordFirstRunPending 은 pending 둘만 찍고 fresh-signup·홀드는 건드리지 않는다", () => {
    const keys = recordWrites(() =>
      recordFirstRunPending(session.member.workspaceId)
    );
    expect(keys).toEqual([PHONE_LINK_FIRST_RUN_KEY, FIRST_AGENT_PENDING_SLOT]);
    expect(firstAgentIsPending(session.member.workspaceId)).toBe(true);
    expect(peekFreshSignup()).toBeNull();
    expect(peekKickoffSettled()).toBe(true);
  });
});
