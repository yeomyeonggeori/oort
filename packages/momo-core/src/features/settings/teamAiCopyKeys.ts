// =============================================================================
// 도우미 역할·이름 화면이 읽는 사전 키 표 (#4945). 웹·폰이 같은 표를 읽는다.
//
// 이 파일에는 문구가 없다. 문구는 `i18n/catalogs/{ko-KR,en-US}/teamAi.json`에 있고, 여기는 어떤
// 묶음·오류가 어떤 키를 읽는지만 정한다. `satisfies`가 묶음 표·오류 종류와 이 표가 갈라지면
// 컴파일을 멈춘다(묶음을 더하고 문구를 빠뜨리는 일을 막는다).
// =============================================================================

import type { MessageArgs, MessageKey } from "../../i18n/generated/messages";
import type { TeamAiBundle, TeamAiNoticeKind, TeamAiRolesErrorKind } from "./teamAiRoles";
import type { TeamAiNameStatus } from "./teamAiNextStep";
import { TeamAiSetupError, type TeamAiRenameErrorKind } from "./teamAiSetup";
import { teamDefaultSaveMessage } from "./defaultAi";
import { teamAiRolesErrorKind } from "./teamAiRoles";
import { teamAiSaveErrorCopy } from "./teamAiSwitch";

/**
 * 값을 받지 않는 문구의 키만. 키를 변수로 들고 다니는 표(`TEAM_AI_ROLE_COPY`…)와 모델(`teamAiStageGuide`)은 이
 * 타입으로 좁혀야 `formatMessage(key)`가 인자 없이 불린다(값이 필요한 키가 섞이면 컴파일이 멈춘다).
 */
export type PlainMessageKey = {
  [K in MessageKey]: MessageArgs[K] extends Record<string, never> ? K : never;
}[MessageKey];

/** 묶음 하나의 이름과 한 줄 설명. */
export const TEAM_AI_ROLE_COPY = {
  chat_read: { name: "teamAi.roles.chatReadName", hint: "teamAi.roles.chatReadHint" },
  workspace_admin: {
    name: "teamAi.roles.workspaceAdminName",
    hint: "teamAi.roles.workspaceAdminHint",
  },
  invite_access: { name: "teamAi.roles.inviteAccessName", hint: "teamAi.roles.inviteAccessHint" },
  long_research: { name: "teamAi.roles.longResearchName", hint: "teamAi.roles.longResearchHint" },
  files: { name: "teamAi.roles.filesName", hint: "teamAi.roles.filesHint" },
  memory: { name: "teamAi.roles.memoryName", hint: "teamAi.roles.memoryHint" },
  code: { name: "teamAi.roles.codeName", hint: "teamAi.roles.codeHint" },
} as const satisfies Record<TeamAiBundle, { name: PlainMessageKey; hint: PlainMessageKey }>;

/** 파일·기억이 공급자로 보내는 내용의 고지. 서버 카드의 고지 문장(`NOTICE_VERSION` 2026-11-01.v1)과 같은 뜻이다. */
export const TEAM_AI_NOTICE_COPY = {
  files: "teamAi.roles.noticeFiles",
  memory: "teamAi.roles.noticeMemory",
  both: "teamAi.roles.noticeBoth",
} as const satisfies Record<TeamAiNoticeKind, PlainMessageKey>;

/** 설정의 역할 칸이 행 옆에 늘 보이는 고지. 파일·기억만 있고 나머지 묶음은 null이다. */
export function teamAiRoleNoticeKey(bundle: TeamAiBundle): PlainMessageKey | null {
  if (bundle === "files") return TEAM_AI_NOTICE_COPY.files;
  if (bundle === "memory") return TEAM_AI_NOTICE_COPY.memory;
  return null;
}

export const TEAM_AI_RENAME_ERROR_COPY = {
  taken: "teamAi.helper.nameErrorTaken",
  reserved: "teamAi.helper.nameErrorReserved",
  invalid: "teamAi.helper.nameErrorInvalid",
  forbidden: "teamAi.helper.nameErrorForbidden",
  other: "teamAi.helper.nameErrorOther",
} as const satisfies Record<TeamAiRenameErrorKind, PlainMessageKey>;

export const TEAM_AI_ROLES_ERROR_COPY = {
  team_memory_off: "teamAi.helper.rolesMemoryOff",
  forbidden: "teamAi.helper.rolesForbidden",
  other: "teamAi.helper.rolesSaveFailed",
} as const satisfies Record<TeamAiRolesErrorKind, PlainMessageKey>;

/** 표시 이름이 부르는 이름(별칭)이 못 된 까닭. 별칭이 만들어졌으면 이 표를 읽지 않는다. */
export const TEAM_AI_NAME_STATUS_COPY = {
  not_derivable: "teamAi.helper.aliasNotDerivable",
  reserved: "teamAi.helper.aliasReserved",
} as const satisfies Record<TeamAiNameStatus, PlainMessageKey>;

/**
 * 「도우미 켜기」 실패의 문장. 단계마다 이미 있는 문장을 쓴다: 기본 AI 저장은 기본 AI 표의 문장, 역할은
 * 사전, 켜기는 스위치의 문장. 사전 키면 `key`가, 코어가 가진 문장이면 `text`가 차 있다(둘 중 하나).
 */
export type TeamAiSetupErrorCopy =
  | { key: PlainMessageKey; text?: undefined }
  | { text: string; key?: undefined };

export function teamAiSetupErrorCopy(error: unknown): TeamAiSetupErrorCopy {
  if (error instanceof TeamAiSetupError) {
    if (error.step === "default_ai") return { text: teamDefaultSaveMessage(error.cause) };
    if (error.step === "roles") {
      return { key: TEAM_AI_ROLES_ERROR_COPY[teamAiRolesErrorKind(error.cause)] };
    }
    return { text: teamAiSaveErrorCopy(error.cause) };
  }
  return { text: teamAiSaveErrorCopy(error) };
}
