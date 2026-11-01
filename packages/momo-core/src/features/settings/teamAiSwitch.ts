// =============================================================================
// 워크스페이스 설정 「oort 도우미」 스위치 (ADR-0201 D8, #3836).
//
// 서버 쪽 사실 (PR #3837):
//   - 스위치는 운영자 전용 설정 가방(`GET|PATCH /v1/workspaces/{ws}/settings`)의
//     `team_ai_fast_path` 불리언이다. 기본은 꺼짐이고, 한 번도 저장한 적 없으면 키가 없다.
//   - `true` 를 저장하면 같은 트랜잭션에서 도우미 멤버를 만들거나 다시 깨우고,
//     `false` 는 멈춘다. 응답에는 서버만 쓰는 `team_ai_agent_member_id` 가 붙는다.
//   - 「oort-helper」 handle 을 다른 에이전트가 이미 쓰면 409 `team_ai_unavailable`.
//
// **기능 감지.** 이 스위치를 모르는 서버(#3837 이전)와 아는 서버는 가방만 봐서는
// 구별되지 않는다: 둘 다 키가 없을 수 있다. 그래서 키가 없을 때만 **부작용 없는 물음**
// 을 한 번 던진다: 불리언이 아닌 값(`"probe"`)을 PATCH 한다. 서버는 가방을 쓰기 전에
// 모든 키를 검사하고 거절하므로(`merge_workspace_settings`) 어느 서버에서도 아무 것도
// 바뀌지 않는다. 대답의 문장으로 가른다:
//   - 「team_ai_fast_path must be true or false」 → 이 서버는 스위치를 안다.
//   - 「unknown settings key: team_ai_fast_path」 → 모른다. 카드를 그리지 않는다.
//   - 그 밖(403·네트워크·다른 문장) → 확인하지 못했다. 카드를 그리지 않는다(fail closed).
// `null` 이나 `false` 로 묻지 않는 이유: `null` 은 키를 지우고 `false` 는 도우미를 멈추고
// 감사 행을 남긴다. 물음이 아니라 쓰기다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { settingsRequest } from "./api";
import { TEAM_AI_ROLES_NOTICE_KEY, type TeamAiRolesNotice } from "./teamAiRoles";

export const TEAM_AI_SETTINGS_KEY = "team_ai_fast_path";
export const TEAM_AI_MEMBER_SETTINGS_KEY = "team_ai_agent_member_id";

/** 가방에서 읽은 스위치. `known` 이 거짓이면 가방만으로는 서버가 아는지 모른다. */
export interface TeamAiSwitchState {
  known: boolean;
  enabled: boolean;
  memberId: string | null;
}

function bagRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readTeamAiSwitch(bag: unknown): TeamAiSwitchState {
  const raw = bagRecord(bag);
  const flag = raw[TEAM_AI_SETTINGS_KEY];
  const member = raw[TEAM_AI_MEMBER_SETTINGS_KEY];
  const memberId = typeof member === "string" && member !== "" ? member : null;
  return {
    // 서버만 쓰는 멤버 id 가 있다는 것도 이 서버가 스위치를 안다는 증거다.
    known: typeof flag === "boolean" || memberId !== null,
    enabled: flag === true,
    memberId,
  };
}

export type TeamAiSupport = "ready" | "absent" | "unknown";

/** 물음(불리언 아닌 값 PATCH)의 대답을 판정한다. */
export function classifyTeamAiProbe(error: unknown): TeamAiSupport {
  if (!(error instanceof ApiError) || error.status !== 400) return "unknown";
  const message = error.message.toLowerCase();
  if (message.includes("unknown settings key")) return "absent";
  if (message.includes(TEAM_AI_SETTINGS_KEY)) return "ready";
  return "unknown";
}

/** 운영자 전용 가방 전체. 운영자가 아니면 403 이다. */
export function fetchWorkspaceSettingsBag(workspaceId: string): Promise<unknown> {
  return settingsRequest<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`
  );
}

export const TEAM_AI_PROBE_VALUE = "probe";

/**
 * 서버가 스위치를 아는지 묻는다. 정상 서버는 반드시 400 으로 거절하므로, 200 이 오면
 * (검증이 사라진 서버) 판정하지 않고 `unknown` 으로 둔다.
 */
export async function probeTeamAiSwitch(workspaceId: string): Promise<TeamAiSupport> {
  try {
    await settingsRequest<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify({ [TEAM_AI_SETTINGS_KEY]: TEAM_AI_PROBE_VALUE }),
      }
    );
    return "unknown";
  } catch (error) {
    return classifyTeamAiProbe(error);
  }
}

/**
 * 켜기/끄기. 응답은 저장된 가방 전체다. `notice`는 온보딩이 역할 단계의 고지 기록을 켜는 요청에
 * 실을 때만 넘긴다(#5040): 없으면 본문은 `{team_ai_fast_path}` 하나로 예전과 같고, 고지 줄을 보이지
 * 않는 켜기(설정의 스위치·다음 단계 카드)는 넘기지 않는다.
 */
export function setTeamAiSwitch(
  workspaceId: string,
  enabled: boolean,
  notice?: TeamAiRolesNotice | null
): Promise<unknown> {
  const body: Record<string, unknown> = { [TEAM_AI_SETTINGS_KEY]: enabled };
  if (notice) body[TEAM_AI_ROLES_NOTICE_KEY] = notice;
  return settingsRequest<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    }
  );
}

// ---- 문구 ----------------------------------------------------------------------

/**
 * 서버가 도우미를 처음 만들 때 붙이는 표시 이름(`TEAM_AI_DEFAULT_DISPLAY_NAME`). 관리자가 바꾸면
 * 이 이름이 아니라 멤버의 표시 이름이 정본이다(ADR-0201 증보 v3 B10). 이 상수는 멤버가 아직
 * 없을 때와 온보딩 이름 칸의 처음 값에만 쓴다.
 */
export const TEAM_AI_DEFAULT_NAME = "oort 도우미";

/**
 * 화면이 도우미를 부르는 이름(B10-7 하드코딩 제거). 멤버가 있으면 그 표시 이름, 아직 없거나
 * 이름이 비어 있으면 기본 이름이다. 문구는 이 값으로 채우고 「oort 도우미」를 글자로 쓰지 않는다.
 */
export function teamAiHelperName(
  helper: { displayName?: string | null } | null | undefined
): string {
  const name = helper?.displayName?.trim();
  return name ? name : TEAM_AI_DEFAULT_NAME;
}

export function teamAiSectionTitle(helperName: string): string {
  return helperName;
}

export const TEAM_AI_SECTION_DESCRIPTION =
  "프로필 바꾸기, 에이전트 이름 바꾸기, 채널 만들기, 채널에 멤버 넣기처럼 간단한 부탁을 도우미가 바로 승인 카드로 올려요. 실행은 카드를 승인한 사람의 권한으로 해요.";

export const TEAM_AI_SWITCH_LABEL = "도우미 쓰기";

export function teamAiSwitchDescription(helperName: string): string {
  return `켜면 「${helperName}」 에이전트가 생기고, 부른 사람의 메시지 한 개와 채널·멤버 이름 목록만 AI 허브 › 기본 AI의 「팀 에이전트의 답」 줄에 정한 모델로 보내요. 다른 채널 글과 기억은 보내지 않아요. 사용량 한도는 정하지 않으면 없고, AI 허브 › 팀 AI 키의 「사용 한도」에서 정할 수 있어요.`;
}

export function teamAiSwitchBusyLabel(next: boolean): string {
  return next ? "도우미 켜는 중" : "도우미 끄는 중";
}

/** 저장 실패를 한 문장으로. 409 는 이름이 겹친 경우다. */
export function teamAiSaveErrorCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === "team_ai_unavailable") {
    return "「oort-helper」 이름을 다른 에이전트가 쓰고 있어요. 그 에이전트 이름을 바꾸고 다시 켜 주세요.";
  }
  return "설정을 저장하지 못했어요. 연결을 확인하고 다시 시도하세요.";
}
