// =============================================================================
// 도우미 역할 묶음의 코어 모델 (ADR-0201 증보 v3 B3, 서버 #4964 / 화면 #4945).
//
// 서버 쪽 사실:
//   - 설정 가방(`GET|PATCH /v1/workspaces/{ws}/settings`, 관리자 전용)의 `team_ai_roles` 객체다.
//     묶음은 일곱이고 `chat_read`는 칸이 아니라 늘 켜져 있다. 나머지 여섯 칸이 불리언이다.
//   - **기본은 모두 켬(owner 답 2026-11-01).** 키가 없거나 칸이 없거나 `null`이면 켬이다.
//     칸이 **있는데** 불리언이 아니면 끔이다(바깥에서 들어온 값은 닫힌 쪽으로 읽는다). 객체가 아닌
//     값이면 여섯 칸 모두 끔이다. 서버 읽기(`TeamAiRoles::from_value`)와 같은 규칙이다.
//   - PATCH는 이 키만 **한 단계 아래로 병합**한다: 이름을 댄 칸만 바뀌고 안 댄 칸은 그대로,
//     `null`은 그 칸을 지운다(= 켬). 그래서 칸 하나만 보내도 다른 묶음이 움직이지 않는다.
//     `chat_read`·모르는 묶음·불리언 아닌 값은 400, 팀 기억이 꺼져 있는데 기억을 켜면 409 `team_memory_off`.
//   - 묶음이 꺼지면 서버가 그 묶음의 도구와 카드를 요청에 광고하지 않고 실행도 거절한다(구조).
//   - 고지 기록(#5040): 파일·기억의 「공급자로 가는 내용」 줄을 보인 화면은 같은 설정 PATCH 본문에
//     `team_ai_roles_notice {bundles, noticeVersion, via}`를 실어 그 사실을 남긴다. 설정이 아니라
//     기록이라 가방에 저장되지도 응답에 실리지도 않는다. 없어도 아무것도 막지 않고(옛 클라이언트),
//     서버가 모르는 판·묶음·via는 400이다. 판은 **화면이 말한다**: 이 모듈의 `TEAM_AI_NOTICE_VERSION`은
//     사전(`teamAi.roles.*`)의 고지 문장이 가리키는 판이라 문장을 바꾸면 함께 올린다.
//
// 이 모듈에는 사용자 문구가 없다. 화면은 문구를 i18n 사전(`teamAi.roles.*`)으로 넣는다.
// 읽기는 전부 총 함수다: 모양이 다르면 던지지 않고 서버와 같은 쪽으로 읽는다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { settingsRequest } from "./api";

export const TEAM_AI_ROLES_KEY = "team_ai_roles";

/** 팀 기억이 꺼져 있는데 기억 묶음을 켜면 서버가 409에 싣는 코드(`ApiError.code`). */
export const TEAM_MEMORY_OFF = "team_memory_off";

/** 대화·읽기. 칸이 아니라 늘 켜져 있고, 보내면 400이다. 화면은 잠긴 행으로만 보인다. */
export const TEAM_AI_ALWAYS_ON_BUNDLE = "chat_read" as const;

/** 관리자가 끄고 켤 수 있는 여섯 묶음. ADR B3 표의 순서이고 서버 `SWITCHABLE_BUNDLES`와 같다. */
export const TEAM_AI_SWITCHABLE_BUNDLES = [
  "workspace_admin",
  "invite_access",
  "long_research",
  "files",
  "memory",
  "code",
] as const;

export type TeamAiSwitchableBundle = (typeof TEAM_AI_SWITCHABLE_BUNDLES)[number];

/** 화면이 보이는 일곱 묶음(ADR B3 표의 순서). */
export const TEAM_AI_BUNDLES = [
  TEAM_AI_ALWAYS_ON_BUNDLE,
  ...TEAM_AI_SWITCHABLE_BUNDLES,
] as const;

export type TeamAiBundle = (typeof TEAM_AI_BUNDLES)[number];

export type TeamAiRoles = Readonly<Record<TeamAiBundle, boolean>>;

/**
 * 켜면 부른 사람이 볼 수 있는 파일·기억의 **내용**이 팀 AI 공급자로 가는 묶음(B3 고지).
 * 화면은 이 둘이 켜져 있을 때 고지 한 줄을 보이고, 설정의 역할 칸은 옆에 늘 보인다.
 */
export const TEAM_AI_NOTICE_BUNDLES = ["files", "memory"] as const;

export type TeamAiNoticeBundle = (typeof TEAM_AI_NOTICE_BUNDLES)[number];

/** 고지 기록을 싣는 요청 본문의 키. 설정이 아니라 기록이라 가방에 저장되지 않는다(#5040). */
export const TEAM_AI_ROLES_NOTICE_KEY = "team_ai_roles_notice";

/**
 * 사전의 고지 문장(`teamAi.roles.*`의 파일·기억 줄)이 가리키는 문구의 판. 서버 `NOTICE_VERSIONS`에
 * 있어야 기록된다(모르는 판은 400). **사전의 고지 문장을 바꾸면 이 값을 올리고, 서버 목록에 판을
 * 더한다**(옛 판은 지우지 않는다: 설치된 클라이언트가 아직 옛 문구를 보일 수 있다).
 */
export const TEAM_AI_NOTICE_VERSION = "2026-11-01.v1";

/** 고지 줄을 보인 화면. 서버의 `ScreenNotice`와 같고, 카드는 승인 자신의 기록이라 여기 없다. */
export type TeamAiNoticeVia = "onboarding" | "settings";

/** 화면이 「이 고지 줄을 보였다」고 서버에 남기는 기록(`team_ai_roles_notice`의 값). */
export interface TeamAiRolesNotice {
  bundles: TeamAiNoticeBundle[];
  noticeVersion: string;
  via: TeamAiNoticeVia;
}

/**
 * 고지 기록을 만든다. 고지가 있는 묶음(파일·기억)만 남기고 표 순서로 중복 없이 담는다. 남는 묶음이
 * 없으면 null이다(보일 줄이 없었으니 남길 기록도 없다).
 */
export function teamAiRolesNotice(
  via: TeamAiNoticeVia,
  bundles: readonly string[]
): TeamAiRolesNotice | null {
  const shown = TEAM_AI_NOTICE_BUNDLES.filter((id) => bundles.includes(id));
  return shown.length === 0
    ? null
    : { bundles: shown, noticeVersion: TEAM_AI_NOTICE_VERSION, via };
}

/**
 * 설정 화면의 스위치 하나가 싣는 고지 기록. **켤 때만**, 고지 줄이 있는 묶음일 때만이다: 끄는 것은
 * 공급자로 가는 내용을 늘리지 않고, 다른 묶음은 보인 고지가 없다.
 */
export function teamAiSettingsToggleNotice(
  bundle: TeamAiSwitchableBundle,
  next: boolean
): TeamAiRolesNotice | null {
  return next ? teamAiRolesNotice("settings", [bundle]) : null;
}

/** 기본값: 일곱 묶음 모두 켬. 온보딩을 건너뛰었거나 설정이 없는 워크스페이스도 같다. */
export function defaultTeamAiRoles(): TeamAiRoles {
  return {
    chat_read: true,
    workspace_admin: true,
    invite_access: true,
    long_research: true,
    files: true,
    memory: true,
    code: true,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 가방의 `team_ai_roles`를 서버와 같은 규칙으로 읽는다. 가방이 없으면 기본(모두 켬)이다. */
export function readTeamAiRoles(bag: unknown): TeamAiRoles {
  const stored = record(bag)?.[TEAM_AI_ROLES_KEY];
  const roles: Record<TeamAiBundle, boolean> = { ...defaultTeamAiRoles() };
  if (stored === undefined || stored === null) return roles;
  const fields = record(stored);
  for (const id of TEAM_AI_SWITCHABLE_BUNDLES) {
    // 객체가 아닌 값은 읽을 수 없다는 뜻이라 어느 칸도 켜지 않는다(닫힌 쪽).
    if (fields === null) {
      roles[id] = false;
      continue;
    }
    const value = fields[id];
    roles[id] = value === undefined || value === null || value === true;
  }
  return roles;
}

/** 바뀐 칸만 담은 변경. 켜는 값도 `true`로 적는다(`null`로 지우지 않는다). */
export type TeamAiRolesChange = Partial<Record<TeamAiSwitchableBundle, boolean>>;

/** `from`에서 `to`로 가려면 바뀌어야 하는 칸만 돌려준다. 같으면 빈 객체다. */
export function teamAiRolesChange(from: TeamAiRoles, to: TeamAiRoles): TeamAiRolesChange {
  const change: TeamAiRolesChange = {};
  for (const id of TEAM_AI_SWITCHABLE_BUNDLES) {
    if (from[id] !== to[id]) change[id] = to[id];
  }
  return change;
}

export function isTeamAiRolesChangeEmpty(change: TeamAiRolesChange): boolean {
  return Object.keys(change).length === 0;
}

/**
 * `PATCH …/settings {team_ai_roles: change}` — 한 단계 병합이라 댄 칸만 바뀐다. 응답은 병합된
 * 가방 전체다. 빈 변경은 부르지 않는 것이 호출자의 몫이다(보낼 것이 없다).
 *
 * `notice`가 있으면 같은 본문에 고지 기록(`team_ai_roles_notice`)이 함께 실려, 서버가 스위치와 같은
 * 트랜잭션에서 기록을 남긴다(#5040). 없으면 본문은 예전과 똑같다.
 */
export function patchTeamAiRoles(
  workspaceId: string,
  change: TeamAiRolesChange,
  notice?: TeamAiRolesNotice | null
): Promise<unknown> {
  const body: Record<string, unknown> = { [TEAM_AI_ROLES_KEY]: change };
  if (notice) body[TEAM_AI_ROLES_NOTICE_KEY] = notice;
  return settingsRequest<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    }
  );
}

export type TeamAiNoticeKind = "files" | "memory" | "both";

/**
 * 어느 고지 문장을 보일지. 파일·기억 중 켜진 것만 말한다(꺼진 묶음의 고지는 말하지 않는다).
 * 둘 다 꺼져 있으면 null이라 고지 줄이 서지 않는다.
 */
export function teamAiNoticeKind(roles: TeamAiRoles): TeamAiNoticeKind | null {
  const files = roles.files;
  const memory = roles.memory;
  if (files && memory) return "both";
  if (files) return "files";
  if (memory) return "memory";
  return null;
}

export type TeamAiRolesErrorKind = "team_memory_off" | "forbidden" | "other";

/** 저장 실패를 화면이 갈라 말할 종류로. 서버 문장은 영어라서 코드와 상태로 가른다. */
export function teamAiRolesErrorKind(error: unknown): TeamAiRolesErrorKind {
  if (error instanceof ApiError) {
    if (error.code === TEAM_MEMORY_OFF) return "team_memory_off";
    if (error.status === 403) return "forbidden";
  }
  return "other";
}
