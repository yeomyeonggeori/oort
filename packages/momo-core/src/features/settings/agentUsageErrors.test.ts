import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { AGENT_USAGE_COPY as COPY } from "./agentUsage";
import { subscriptionSaveError } from "./agentUsageErrors";

// #4986. 사용량 오류 문장은 무슨 일이 일어났고 무엇을 할지를 말해야 한다(README §4 오류). 저장 실패는 원인이
// 달라도 한 문장이라서, 권한이 없는 사람에게 「다시 시도」를 권했다.
describe("에이전트 사용량의 오류 문장 (#4986)", () => {
  it("목록·표 안의 줄은 긴 머리말 대신 짧은 기간 말을 쓴다", () => {
    expect(COPY.period).toBe("이번 달");
    expect(COPY.title.startsWith(COPY.period)).toBe(true);
    expect(COPY.period.length).toBeLessThan(COPY.title.length);
  });

  it("읽기 실패 문장이 다음 행동을 말한다", () => {
    expect(COPY.error).toMatch(/불러오지 못했어요/u);
    expect(COPY.error).toMatch(/다시 불러와 주세요/u);
  });

  it("저장 실패는 원인별로 다른 문장이다: 403 은 권한, 409 는 다른 곳에서 바뀜, 그 밖은 연결", () => {
    expect(subscriptionSaveError(new ApiError(403, "forbidden"))).toBe(COPY.saveForbidden);
    expect(subscriptionSaveError(new ApiError(409, "conflict"))).toBe(COPY.saveConflict);
    expect(subscriptionSaveError(new ApiError(500, "boom"))).toBe(COPY.saveError);
    expect(subscriptionSaveError(new Error("403"))).toBe(COPY.saveError); // 글자만 403 인 일반 오류는 권한이 아니다
    expect(subscriptionSaveError(undefined)).toBe(COPY.saveError);
  });

  it("권한 문장은 「다시 시도」를 권하지 않고, 일반 문장만 권한다", () => {
    expect(COPY.saveForbidden).not.toMatch(/다시 시도/u);
    expect(COPY.saveForbidden).toMatch(/관리자/u);
    expect(COPY.saveConflict).toMatch(/다시 불러온 뒤/u);
    expect(COPY.saveError).toMatch(/다시 시도/u);
    expect(new Set([COPY.saveError, COPY.saveForbidden, COPY.saveConflict]).size).toBe(3);
  });
});
