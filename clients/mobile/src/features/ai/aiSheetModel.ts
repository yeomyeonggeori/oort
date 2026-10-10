import {toolKeyForHarness} from '@momo/core/features/auth/personalAgentCall';
import {uuidEq, type RosterMember} from '@momo/core/lib/api';

import {HARNESS_LABEL, type HarnessKey, type MacState} from '../work/ask/model';
import {spawnPort} from '../work/ask/spawnPort';

// =============================================================================
// 「AI」 시트의 판정 — 어떤 구획이 서는가, 개인 에이전트가 누구인가 (N10 #3598).
//
// 시트는 이 파일의 답을 그리기만 한다. 구획이 서는 조건을 화면에 흩어 두면 승격 뒤에
// 한 곳은 켜지고 한 곳은 안 켜진다.
//
// ## 게이트는 하나다 — 부팅이 진짜 포트를 꽂으면 열린다
//
// 「내 도구」와 「개인 에이전트」는 둘 다 **내 맥으로 보내는 길**(`spawnPort().wired`)이
// 이 빌드에 꽂혀 있어야 선다. #3638에서 부팅(`boot/spawnPort.ts`)이 진짜 포트
// (`phoneSpawnPort.ts`)를 꽂아 두 구획이 함께 켜졌다. 시험·캡처 하네스는 포트를 직접
// 꽂거나 비운다(`__resetSpawnPort`).
//
// ## 개인 에이전트의 값은 로스터에서 온다 — 모르는 모양은 없는 것과 같다
//
// ADR-0198 증보 1 D7의 로스터 필드 `personalAgent{label, ownerId, ownerDisplayName,
// harness, enabled, mentionable}`는 이 트리의 코어 타입에 아직 없다. 타입을 새로 만들지
// 않고(공유 코어는 engine 소유), 모르는 필드를 **좁게 읽는다**: 모양이 맞지 않으면
// 그 행은 없는 것이다. 구서버는 이 필드를 보내지 않으므로 구획이 서지 않는다.
// =============================================================================

/** 내 맥으로 보내는 길이 이 빌드에 연결돼 있는가 — 「내 도구」·개인 에이전트의 게이트. */
export function myToolsGateOpen(): boolean {
  return spawnPort().wired;
}

export interface PersonalAgentRow {
  id: string;
  /** 로스터의 핸들(`@별칭`의 별칭). 컴포저가 멘션·DM을 이 별칭으로 알아본다. */
  handle: string;
  /** 서버가 준 하네스 키 그대로(`claude`·`codex`…). 호출 서명의 `tool`이다. */
  harnessKey: string;
  /** 로스터가 준 이름(예: 「내 Claude Code」). */
  label: string;
  /** 하네스 이름 — 아는 키는 사람 말로, 모르는 키는 그대로. */
  harnessLabel: string;
  /** 아는 하네스 키면 그 키(「내 맥에 보내기」가 미리 고른다), 모르면 `null`. */
  harness: HarnessKey | null;
}

function knownHarness(harness: string): HarnessKey | null {
  // 로스터는 `claude_code`, 도구 키는 `claude`다(#3660).
  const key = toolKeyForHarness(harness);
  return Object.prototype.hasOwnProperty.call(HARNESS_LABEL, key)
    ? (key as HarnessKey)
    : null;
}

/**
 * 이 사람의 개인 에이전트들. 조건은 모두 맞아야 한다:
 *   - 에이전트 멤버이고 활성이다.
 *   - `personalAgent`의 모양이 맞고 `ownerId`가 나다(소유자 전용 — 팀원의 것은 보이지 않는다).
 *   - `enabled`가 켜져 있다.
 *   - **은퇴하지 않았다** — T2의 `subscriptionRetired`가 참이면 숨긴다. 옛 구독 에이전트는
 *     「내 도구」가 대신하고, 시트가 그 행을 다시 세우면 같은 하네스가 두 번 보인다.
 */
export function personalAgentRows(
  members: readonly RosterMember[],
  selfId: string,
): PersonalAgentRow[] {
  const rows: PersonalAgentRow[] = [];
  for (const member of members) {
    if (member.kind !== 'agent' || member.status !== 'active') continue;
    const wire = member as unknown as Record<string, unknown>;
    if (wire.subscriptionRetired === true) continue;
    const personal = wire.personalAgent;
    if (typeof personal !== 'object' || personal === null) continue;
    const value = personal as Record<string, unknown>;
    if (
      typeof value.label !== 'string' ||
      value.label.trim() === '' ||
      typeof value.ownerId !== 'string' ||
      typeof value.harness !== 'string' ||
      value.enabled !== true ||
      value.subscriptionRetired === true
    ) {
      continue;
    }
    if (!uuidEq(value.ownerId, selfId)) continue;
    const known = knownHarness(value.harness);
    rows.push({
      id: member.id,
      handle: member.handle,
      harnessKey: value.harness,
      label: value.label.trim(),
      harnessLabel: known === null ? value.harness : HARNESS_LABEL[known],
      harness: known,
    });
  }
  return rows;
}

export interface AiSheetSections {
  /** 에이전트 — N8 「작업 맡기기」·에이전트 목록. 늘 선다. */
  agents: true;
  /** 내 도구 — T6b 「내 맥에 물어보기」. 게이트가 열렸을 때만. */
  myTools: boolean;
  /** 개인 에이전트 — 게이트가 열렸고 내 것이 있을 때만. */
  personal: boolean;
}

export function aiSheetSections(input: {
  gateOpen: boolean;
  personal: readonly PersonalAgentRow[];
}): AiSheetSections {
  return {
    agents: true,
    myTools: input.gateOpen,
    personal: input.gateOpen && input.personal.length > 0,
  };
}

export const MAC_ON_LABEL = '내 맥 켜짐';
export const MAC_OFF_LABEL = '내 맥 꺼짐';

/**
 * 맥 칩. 값이 있을 때만(등록된 맥이 있을 때) 말한다 — 값이 없는 것을 「꺼짐」으로 읽지 않는다.
 * 읽는 중(`undefined` 호스트 목록)도 값이 없는 것이다.
 */
export function macChip(
  state: MacState | null,
): {on: boolean; label: string} | null {
  if (state === null || state.kind === 'none') return null;
  return state.kind === 'on'
    ? {on: true, label: MAC_ON_LABEL}
    : {on: false, label: MAC_OFF_LABEL};
}

export const PERSONAL_BADGE = '개인';
