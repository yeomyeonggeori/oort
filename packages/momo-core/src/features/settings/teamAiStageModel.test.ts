// #4945: 온보딩 팀 AI 단계가 어느 모습으로 서는가. 판정의 순서가 안전이다(건너뛰기·운영자 아님·실패가 먼저).
import { describe, expect, it } from "vitest";
import type { ProviderLink } from "./api";
import {
  providerLinkHasKey,
  TEAM_AI_STAGE_VIEW as VIEW,
  teamAiStageGuide,
  teamAiStageView,
  type TeamAiStageViewInput,
} from "./teamAiStageModel";

const base: TeamAiStageViewInput = {
  done: false,
  enabling: false,
  linkPending: false,
  denied: false,
  linkError: false,
  verified: false,
  verifying: false,
};

describe("모습 판정", () => {
  it("읽는 중 → 운영자 아님 → 읽기 실패 → 키 폼 순서로, 확인되면 설정, 켜면 끝이다", () => {
    expect(teamAiStageView({ ...base, linkPending: true })).toBe(VIEW.loading);
    expect(teamAiStageView({ ...base, denied: true })).toBe(VIEW.notOperator);
    expect(teamAiStageView({ ...base, linkError: true })).toBe(VIEW.loadError);
    expect(teamAiStageView(base)).toBe(VIEW.key);
    expect(teamAiStageView({ ...base, verifying: true })).toBe(VIEW.verifying);
    expect(teamAiStageView({ ...base, verified: true })).toBe(VIEW.setup);
    expect(teamAiStageView({ ...base, verified: true, enabling: true })).toBe(VIEW.enabling);
    expect(teamAiStageView({ ...base, verified: true, done: true })).toBe(VIEW.done);
  });

  it("운영자가 아니면 확인된 키가 있어도 설정 모습을 세우지 않는다", () => {
    expect(teamAiStageView({ ...base, denied: true, verified: true })).toBe(VIEW.notOperator);
    expect(teamAiStageView({ ...base, linkError: true, verifying: true })).toBe(VIEW.loadError);
  });
});

describe("코메토의 말", () => {
  it("키가 없으면 묻고, 확인에 실패하면 당황과 사유 문장이다", () => {
    expect(teamAiStageGuide(VIEW.key, { keyFailed: false, enableFailed: false, unverified: false })).toEqual({
      state: "awaiting",
      line: "teamAi.stage.keyLine",
      detail: "teamAi.stage.keyDetail",
      detailIsCheckReason: false,
    });
    expect(teamAiStageGuide(VIEW.key, { keyFailed: true, enableFailed: false, unverified: false })).toEqual({
      state: "trouble",
      line: "teamAi.stage.keyFailedLine",
      detail: null,
      detailIsCheckReason: true,
    });
  });

  it("설정은 기다림, 켜기 실패는 당황, 확인 전 서버는 그 사실을 말한다", () => {
    const none = { keyFailed: false, enableFailed: false, unverified: false };
    expect(teamAiStageGuide(VIEW.setup, none).detail).toBe("teamAi.stage.setupDetail");
    expect(teamAiStageGuide(VIEW.setup, { ...none, unverified: true }).detail).toBe(
      "teamAi.stage.setupUnverifiedDetail"
    );
    expect(teamAiStageGuide(VIEW.setup, { ...none, enableFailed: true }).state).toBe("trouble");
    expect(teamAiStageGuide(VIEW.enabling, none).state).toBe("preparing");
    expect(teamAiStageGuide(VIEW.done, none).state).toBe("success");
  });
});

describe("이미 있는 키", () => {
  const link = (over: Partial<ProviderLink>) =>
    ({ configured: false, keyConfigured: false, availability: "live", ...over }) as ProviderLink;

  it("저장했거나 서버 환경값이 있으면 키가 있다. 모의 연결과 빈 서버는 없다", () => {
    expect(providerLinkHasKey(link({ configured: true }))).toBe(true);
    expect(providerLinkHasKey(link({ keyConfigured: true }))).toBe(true);
    expect(providerLinkHasKey(link({ keyConfigured: true, availability: "mock" }))).toBe(false);
    expect(providerLinkHasKey(link({}))).toBe(false);
    expect(providerLinkHasKey(null)).toBe(false);
  });
});
