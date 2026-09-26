// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { FIRST_AGENT_STAGE_ORDER } from "./firstAgent";
import { markFreshSignup, clearFreshSignup } from "./freshSignup";
import {
  decideFirstRun,
  decideFirstRunForSession,
  firstRunStageOrder,
  holdKickoffForFreshSignup,
  peekKickoffSettled,
  resetKickoffHoldForTests,
  settleKickoffHold,
} from "./firstRunGate";
import {
  clearPhoneLinkCardForTests,
  markPhoneLinkCardPending,
  readPhoneLinkCard,
} from "./phoneLinkCardStore";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER = "00000000-0000-7000-8000-000000000101";

describe("first-run 게이트 순서", () => {
  beforeEach(() => {
    clearFreshSignup();
    resetKickoffHoldForTests();
  });

  it("렌더 순서는 킥오프 홀드 → 첫 에이전트 → 앱이다(폰은 게이트 단계가 아니다, #2818)", () => {
    expect(firstRunStageOrder()).toEqual(FIRST_AGENT_STAGE_ORDER);
    expect(firstRunStageOrder()).not.toContain("phone-link");
    expect(
      decideFirstRun({ kickoffSettled: false, firstAgentPending: true })
    ).toBe("kickoff-hold");
    expect(
      decideFirstRun({ kickoffSettled: true, firstAgentPending: true })
    ).toBe("first-agent");
    expect(
      decideFirstRun({ kickoffSettled: true, firstAgentPending: false })
    ).toBe("app");
  });

  it("폰 카드가 pending 이어도 첫 에이전트 뒤에는 곧장 앱이다(ADR-0193 D7)", () => {
    markPhoneLinkCardPending(WS);
    expect(readPhoneLinkCard(WS)).toBe("pending");
    expect(decideFirstRunForSession({ workspaceId: WS })).toBe("app");
    clearPhoneLinkCardForTests(WS);
  });

  it("홀드는 settle 전까지 앱을 연다", () => {
    markFreshSignup({ workspaceId: WS, memberId: MEMBER });
    holdKickoffForFreshSignup();
    expect(peekKickoffSettled()).toBe(false);
    settleKickoffHold();
    expect(peekKickoffSettled()).toBe(true);
  });
});
