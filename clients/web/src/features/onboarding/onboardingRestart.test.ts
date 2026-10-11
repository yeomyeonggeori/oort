// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import {
  firstAgentIsPending,
  markFirstAgentPending,
} from "@/features/welcome/firstAgentStore";
import { markFreshSignup, peekFreshSignup } from "@/features/welcome/freshSignup";
import {
  DURABLE_SLOT_TTL_MS,
  readDurable,
  removeDurable,
  writeDurable,
} from "./durableSlot";
import {
  clearOwnerOnboardingPending,
  markOwnerOnboardingPending,
  readOwnerOnboardingStage,
} from "./ownerOnboardingStore";
import { readS1Draft, writeS1Draft } from "./s1Draft";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";

function login(memberId: string, workspaceId = WS): void {
  const response: LoginResponse = {
    accessToken: "test-only-not-a-credential",
    refreshToken: "test-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "demo" },
    realtimeWebSocketUrl: "ws://test.invalid/connection/websocket",
  };
  applyLogin(response);
}

/** 영속 슬롯 키(`슬롯@워크스페이스:멤버`). 세션 자체의 저장 키는 세지 않는다. */
function slotKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.includes("@"));
}

/** 앱 종료 → 재실행: 탭 단위 저장소는 사라지고 localStorage만 남는다. */
function restartApp(): void {
  sessionStorage.clear();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  clearOwnerOnboardingPending();
  clearSession();
  localStorage.clear();
  sessionStorage.clear();
});

describe("온보딩 진행 상태는 앱 재시작을 넘어 이어진다 (#3696)", () => {
  it("S1 대기 표지와 S1 초안이 재시작 뒤에도 남는다", () => {
    login(ME);
    markOwnerOnboardingPending();
    writeS1Draft({ workspaceName: "새벽팀", displayName: "성재", handle: "seongjae" });
    restartApp();
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    expect(readS1Draft()).toEqual({
      workspaceName: "새벽팀",
      displayName: "성재",
      handle: "seongjae",
    });
  });

  it("첫 가입 표지와 첫 에이전트 대기 표지가 재시작 뒤에도 남는다", () => {
    login(ME);
    markFreshSignup({ workspaceId: WS, memberId: ME });
    markFirstAgentPending(WS);
    restartApp();
    expect(peekFreshSignup()).toEqual({ workspaceId: WS, memberId: ME });
    expect(firstAgentIsPending(WS)).toBe(true);
  });

  it("다른 계정은 이 계정의 진행 상태를 보지 못한다", () => {
    login(ME);
    markOwnerOnboardingPending();
    writeS1Draft({ workspaceName: "새벽팀", displayName: "성재", handle: "seongjae" });
    clearSession();
    login(OTHER);
    expect(readOwnerOnboardingStage()).toBeNull();
    expect(readS1Draft()).toBeNull();
    // 다른 서버(워크스페이스)의 같은 멤버 id도 보지 못한다.
    clearSession();
    login(ME, "00000000-0000-7000-8000-0000000000ff");
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("14일이 지난 표지는 없는 것으로 읽고 지운다", () => {
    login(ME);
    const t0 = 1_000_000;
    writeDurable("oort.test.slot", "x", t0);
    expect(readDurable("oort.test.slot", t0 + DURABLE_SLOT_TTL_MS)).toBe("x");
    expect(readDurable("oort.test.slot", t0 + DURABLE_SLOT_TTL_MS + 1)).toBeNull();
    expect(slotKeys()).toEqual([]);
  });

  it("저장된 계정이 없으면(로그인 전) 옛 sessionStorage 동작 그대로다", () => {
    markOwnerOnboardingPending();
    expect(localStorage.length).toBe(0);
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    restartApp();
    expect(readOwnerOnboardingStage()).toBeNull();
    removeDurable("oort.test.slot");
  });

  it("완료하면 영속 슬롯도 비워진다", () => {
    login(ME);
    markOwnerOnboardingPending();
    writeS1Draft({ workspaceName: "a", displayName: "b", handle: "cc" });
    expect(slotKeys().length).toBe(2);
    clearOwnerOnboardingPending();
    expect(slotKeys()).toEqual([]);
  });
});
