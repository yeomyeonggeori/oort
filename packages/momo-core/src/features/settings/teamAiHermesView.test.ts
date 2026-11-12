// ADR-0201 증보 v4 P7·P8·P10 (#5375): 설정의 Hermes 행·하루 칸은 운영자가 연 서버에서만 서고, 닫힌 까닭은 서버 낱말 그대로다.
import { describe, expect, it } from "vitest";
import {
  delegationInputMax,
  delegationInputText,
  hermesLimitItemVisible,
  hermesRowUnavailable,
  hermesSettingsVisible,
  parseDelegationInput,
} from "./teamAiHermesView";
import { UNKNOWN_DELEGATION_STATUS, type TeamAiDelegationStatus } from "./teamAiLimits";

function status(over: Partial<TeamAiDelegationStatus> = {}): TeamAiDelegationStatus {
  return {
    known: true,
    limit: null,
    effective: 30,
    ceiling: 50,
    ceilingOff: false,
    today: 4,
    available: true,
    unavailableReason: null,
    ...over,
  };
}

/** 지금 운영의 모양: 천장 없음 = 닫힘. 첫 닫힌 문은 G3(연결)일 수 있다. */
const OPS_OFF = status({
  ceiling: null,
  ceilingOff: true,
  effective: 0,
  available: false,
  unavailableReason: "hermes_not_connected",
});

describe("hermesSettingsVisible · hermesLimitItemVisible (P8이 정본)", () => {
  it("서버가 위임 칸을 보냈으면 행은 선다 — 운영자 천장이 비어 있는 지금 운영에서도", () => {
    expect(hermesSettingsVisible(status())).toBe(true);
    expect(hermesSettingsVisible(OPS_OFF)).toBe(true);
  });

  it("하루 칸은 천장이 있을 때만(P7 「천장 안에서 조정」)", () => {
    expect(hermesLimitItemVisible(status())).toBe(true);
    expect(hermesLimitItemVisible(OPS_OFF)).toBe(false);
  });

  it("서버가 칸을 보내지 않았으면(옛 서버) 행도 칸도 없다", () => {
    expect(hermesSettingsVisible(UNKNOWN_DELEGATION_STATUS)).toBe(false);
    expect(hermesLimitItemVisible(UNKNOWN_DELEGATION_STATUS)).toBe(false);
  });
});

describe("hermesRowUnavailable", () => {
  it("천장이 있고 문이 닫혔으면 서버 낱말의 문장", () => {
    expect(hermesRowUnavailable(true, status({ available: false, unavailableReason: "hermes_not_connected" }))).toEqual({
      reason: "teamAi.delegation.reasonNotConnected",
    });
    expect(hermesRowUnavailable(true, status({ available: false, unavailableReason: "daily_cap" }))).toEqual({
      reason: "teamAi.delegation.reasonDailyCap",
    });
  });

  it("천장이 비었으면 까닭은 천장 사실의 문장 — 첫 닫힌 문이 「연결 안 됨」이어도 그 말을 붙이지 않는다", () => {
    expect(OPS_OFF.unavailableReason).toBe("hermes_not_connected");
    expect(hermesRowUnavailable(true, OPS_OFF)).toEqual({ reason: "teamAi.delegation.reasonCeilingUnset" });
  });

  it("묶음이 꺼졌거나 문이 열려 있으면 줄이 없다", () => {
    expect(hermesRowUnavailable(false, OPS_OFF)).toBeNull();
    expect(hermesRowUnavailable(true, status())).toBeNull();
  });
});

describe("하루 맡기기 칸", () => {
  it("상한은 min(200, 운영자 천장)", () => {
    expect(delegationInputMax(status({ ceiling: 50 }))).toBe(50);
    expect(delegationInputMax(status({ ceiling: 500 }))).toBe(200);
    expect(delegationInputMax(status({ ceiling: null, ceilingOff: true }))).toBe(200);
  });

  it("빈 칸은 기본 30으로 되돌리기, 1~상한의 정수만 값", () => {
    const s = status({ ceiling: 50 });
    expect(parseDelegationInput("", s)).toEqual({ ok: true, value: null });
    expect(parseDelegationInput(" 12 ", s)).toEqual({ ok: true, value: 12 });
    expect(parseDelegationInput("50", s)).toEqual({ ok: true, value: 50 });
    expect(parseDelegationInput("51", s)).toEqual({ ok: false, error: "over_ceiling", max: 50 });
    for (const bad of ["0", "-1", "1.5", "abc", "201", "99999"]) {
      expect(parseDelegationInput(bad, status({ ceiling: 500 }))).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("처음 글은 관리자가 정한 값, 없으면 빈 칸", () => {
    expect(delegationInputText(status({ limit: 12 }))).toBe("12");
    expect(delegationInputText(status({ limit: null }))).toBe("");
  });
});
