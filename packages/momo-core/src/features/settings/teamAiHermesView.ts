// =============================================================================
// 설정의 「Hermes 도움」 행과 「하루 Hermes 맡기기」 칸이 읽는 판정 (ADR-0201 증보 v4 P7·P8·P10, 화면 #5375 = P14-S7).
//
// 읽기는 `teamAiLimits.ts`의 위임 칸(`TeamAiDelegationStatus`, 서버 문의 닫힌 낱말)이 한다. 여기는 그 사실을 화면이
// 언제 그리고 무엇을 쓰는지로만 바꾼다. 웹·폰이 같은 판정을 쓴다.
//
// **언제 보이는가 (planner 브리프 #5375 「꺼져 있을 때는 아무것도 새로 보이지 않아요」):** 운영자가 위임을 연 서버
// (천장이 있음)에서만 보인다. 천장이 비었거나 서버가 위임 칸을 보내지 않았으면(모름) 행도 칸도 없다. 그래서 운영이
// 꺼진 지금은 설정에 새 줄이 하나도 생기지 않는다. 증보 v4 P8은 천장이 없을 때도 「지금은 쓸 수 없어요」를 말하라고
// 했는데, 그 문장은 운영자가 연 뒤 다른 문(G3~G5, 오늘 횟수)이 닫혔을 때만 보인다 — 이 갈림은 인계에 결정 항목으로
// 남긴다. 판정은 까닭 낱말이 아니라 `ceilingOff`로 한다: 까닭은 **처음 닫힌 문**이고 G3(연결)가 G6(천장)보다 앞이라,
// 운영이 꺼진 서버도 「연결 안 됨」으로 읽힐 수 있다.
//
// 묶음이 꺼져 있어도 행은 남는다(스위치가 다시 켜는 길이다). 그때는 까닭 줄을 그리지 않는다.
// =============================================================================

import type { PlainMessageKey } from "./teamAiCopyKeys";
import { TEAM_AI_DELEGATION_REASON_COPY } from "./teamAiCopyKeys";
import {
  DAILY_DELEGATIONS_MAX,
  DAILY_DELEGATIONS_MIN,
  type TeamAiDelegationStatus,
} from "./teamAiLimits";

/** 설정에 Hermes 맡기기(역할 행·하루 칸)를 그리는가: 서버가 위임 칸을 온전히 보냈고 운영자 천장이 있다. */
export function hermesSettingsVisible(status: TeamAiDelegationStatus): boolean {
  return status.known && !status.ceilingOff;
}

/**
 * 역할 행 아래의 「지금은 쓸 수 없어요」 뒤에 붙는 까닭의 키. 묶음이 켜져 있고(G1) 워크스페이스 쪽 문이 닫혀 있을 때만
 * 있다. 묶음이 꺼졌으면 스위치가 이미 말한다.
 */
export function hermesRowUnavailableKey(
  bundleOn: boolean,
  status: TeamAiDelegationStatus
): PlainMessageKey | null {
  if (!bundleOn || status.available) return null;
  return TEAM_AI_DELEGATION_REASON_COPY[status.unavailableReason ?? "unknown"];
}

/** 하루 맡기기 칸이 받는 가장 큰 값: 설정 상한(200)과 운영자 천장 중 작은 것. 천장이 없으면 설정 상한. */
export function delegationInputMax(status: TeamAiDelegationStatus): number {
  return status.ceiling === null
    ? DAILY_DELEGATIONS_MAX
    : Math.max(DAILY_DELEGATIONS_MIN, Math.min(DAILY_DELEGATIONS_MAX, status.ceiling));
}

/** 하루 맡기기 칸의 입력을 읽은 결과. `value: null`은 「정하지 않음 = 기본 30」으로 되돌리기다. */
export type DelegationInput =
  | { ok: true; value: number | null }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "over_ceiling"; max: number };

/**
 * 하루 맡기기 칸의 글을 읽는다. 빈 칸은 기본값으로 되돌리기(`null`), 1~200의 정수만 값이고, 운영자 천장을 넘으면
 * 저장하지 않고 그 상한을 말한다(서버도 같은 범위를 거절한다).
 */
export function parseDelegationInput(text: string, status: TeamAiDelegationStatus): DelegationInput {
  const typed = text.trim();
  if (typed === "") return { ok: true, value: null };
  if (!/^[0-9]{1,4}$/.test(typed)) return { ok: false, error: "invalid" };
  const value = Number(typed);
  if (value < DAILY_DELEGATIONS_MIN || value > DAILY_DELEGATIONS_MAX) return { ok: false, error: "invalid" };
  const max = delegationInputMax(status);
  if (value > max) return { ok: false, error: "over_ceiling", max };
  return { ok: true, value };
}

/** 칸에 처음 보이는 글: 관리자가 정한 값, 없으면 빈 칸(기본 30은 안내 문장이 말한다). */
export function delegationInputText(status: TeamAiDelegationStatus): string {
  return status.limit === null ? "" : String(status.limit);
}
