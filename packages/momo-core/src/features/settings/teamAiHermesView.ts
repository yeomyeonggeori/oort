// =============================================================================
// 설정의 「Hermes 도움」 행과 「하루 Hermes 맡기기」 칸이 읽는 판정 (ADR-0201 증보 v4 P7·P8·P10, 화면 #5375 = P14-S7).
//
// 읽기는 `teamAiLimits.ts`의 위임 칸(`TeamAiDelegationStatus`, 서버 문의 닫힌 낱말)이 한다. 여기는 그 사실을 화면이
// 언제 그리고 무엇을 쓰는지로만 바꾼다. 웹·폰이 같은 판정을 쓴다.
//
// **언제 보이는가 (ADR 증보 v4 P8이 정본, planner 2026-11-10 답):** 서버가 위임 칸을 온전히 보냈으면(`known`) 소유자·관리자의
// 설정에 「Hermes 도움」 행이 선다 — 운영자 천장이 없는 서버에서도(천장 없음 = 미설정, 운영자가 `0`으로 끈 서버도). 한도 가방 자체가 소유자·관리자에게만 읽히므로
// 일반 멤버에게는 아무것도 새로 보이지 않는다. 서버가 위임 칸을 모르면(옛 서버) 행이 없다(모르는 것을 말하지 않는다).
//
// **까닭은 사실대로:** 묶음이 켜져 있고 문이 닫혔으면 「지금은 쓸 수 없어요.」 뒤에 까닭을 붙인다(P8 「닫힌 낱말 이유와 함께」).
// 운영자가 `0`으로 꺼 두었으면(`ceilingOff`) 서버의 까닭 낱말을 쓰지 않는다 — 그 낱말은 **처음 닫힌 문**이고 G3(연결)이 G6(천장)
// 보다 앞이라, 천장이 꺼진 서버에서도 「연결 안 됨」으로 읽힐 수 있다. 그때는 따로 오는 서버 사실 `ceilingOff` 자체가 까닭이고
// 늘 참인 문장 `ceiling_unset`(「서버 운영자가 Hermes 맡기기를 꺼 두었어요.」)을 고정으로 붙인다(#5375 수리 1회차,
// 검수 M1). 천장이 있으면 서버 낱말의 문장을 그대로 붙인다.
//
// **조작:** 역할 스위치는 늘 쓸 수 있다(묶음은 관리자의 설정이고, P10 「켠 채라도 … 이유를 보인다」). 「하루 Hermes 맡기기」
// 칸은 끔이 아닐 때 선다(천장이 없으면 설정 상한 200까지, 있으면 천장 안에서 — P7). 끄면 실제 상한이 0이라 고를 것이 없다.
//
// 묶음이 꺼져 있으면 행과 스위치는 남고(다시 켜는 길이다) 까닭 줄은 그리지 않는다.
// =============================================================================

import type { PlainMessageKey } from "./teamAiCopyKeys";
import { TEAM_AI_DELEGATION_REASON_COPY } from "./teamAiCopyKeys";
import {
  DAILY_DELEGATIONS_MAX,
  DAILY_DELEGATIONS_MIN,
  type TeamAiDelegationStatus,
} from "./teamAiLimits";

/** 설정에 「Hermes 도움」 역할 행을 그리는가: 서버가 위임 칸을 온전히 보냈다(운영자 천장이 비어 있어도). */
export function hermesSettingsVisible(status: TeamAiDelegationStatus): boolean {
  return status.known;
}

/** 「하루 Hermes 맡기기」 칸을 그리는가: 위 조건 + 운영자 천장이 있다(P7 「천장 안에서 조정」). */
export function hermesLimitItemVisible(status: TeamAiDelegationStatus): boolean {
  return status.known && !status.ceilingOff;
}

/** 역할 행 아래의 「지금은 쓸 수 없어요.」 줄. `reason`이 `null`이면 까닭 문장 없이 그 한 문장만 보인다. */
export interface HermesRowUnavailable {
  reason: PlainMessageKey | null;
}

/**
 * 역할 행 아래 줄의 판정(한 곳). 묶음이 켜져 있고(G1) 워크스페이스 쪽 문이 닫혀 있을 때만 있다. 묶음이 꺼졌으면 스위치가
 * 이미 말한다. 운영자가 꺼 두었으면 까닭은 서버의 첫 닫힌 문 낱말이 아니라 천장 사실의 문장(`ceiling_unset`)이다 —
 * 첫 닫힌 문 낱말(예: 「연결 안 됨」)은 천장 사실과 다를 수 있다.
 */
export function hermesRowUnavailable(
  bundleOn: boolean,
  status: TeamAiDelegationStatus
): HermesRowUnavailable | null {
  if (!bundleOn || status.available) return null;
  if (status.ceilingOff) return { reason: TEAM_AI_DELEGATION_REASON_COPY.ceiling_unset };
  return { reason: TEAM_AI_DELEGATION_REASON_COPY[status.unavailableReason ?? "unknown"] };
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
