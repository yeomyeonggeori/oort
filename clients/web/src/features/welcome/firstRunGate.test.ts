// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { FIRST_AGENT_STAGE_ORDER } from "./firstAgent";
import { markFreshSignup, clearFreshSignup } from "./freshSignup";
import {
  decideFirstRun,
  firstRunStageOrder,
  holdKickoffForFreshSignup,
  peekKickoffSettled,
  resetKickoffHoldForTests,
  settleKickoffHold,
} from "./firstRunGate";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER = "00000000-0000-7000-8000-000000000101";

describe("first-run 게이트 순서", () => {
  beforeEach(() => {
    clearFreshSignup();
    resetKickoffHoldForTests();
  });

  it("렌더 순서는 킥오프 홀드 → 첫 에이전트 → 폰이다", () => {
    expect(firstRunStageOrder()).toEqual(FIRST_AGENT_STAGE_ORDER);
    expect(
      decideFirstRun({
        kickoffSettled: false,
        firstAgentPending: true,
        phonePending: true,
      })
    ).toBe("kickoff-hold");
    expect(
      decideFirstRun({
        kickoffSettled: true,
        firstAgentPending: true,
        phonePending: true,
      })
    ).toBe("first-agent");
    expect(
      decideFirstRun({
        kickoffSettled: true,
        firstAgentPending: false,
        phonePending: true,
      })
    ).toBe("phone-link");
    expect(
      decideFirstRun({
        kickoffSettled: true,
        firstAgentPending: false,
        phonePending: false,
      })
    ).toBe("app");
  });

  it("홀드는 settle 전까지 앱을 연다", () => {
    markFreshSignup({ workspaceId: WS, memberId: MEMBER });
    holdKickoffForFreshSignup();
    expect(peekKickoffSettled()).toBe(false);
    settleKickoffHold();
    expect(peekKickoffSettled()).toBe(true);
  });
});
