// =============================================================================
// 온보딩의 「팀 AI 켜기」 쓰기 순서 (ADR-0201 증보 v3 B3·B10, #4945).
//
// 키를 저장하고 연결 확인을 마친 뒤, 관리자가 이름과 역할을 고르고 「도우미 켜기」를 누르면
// 이 함수가 서버 계약을 **정해진 순서로** 부른다. 순서가 곧 안전이다:
//
//   1. 기본 AI 「팀 에이전트의 답」 줄을 저장된 키로(`PUT /v1/provider/default-ai`). 이 줄이 안
//      풀리면 도우미는 모델을 부르지 못하고 `default_ai_unresolved`로 정직하게 실패한다.
//   2. 역할(`PATCH …/settings {team_ai_roles}`) — **바뀐 칸만**. 기본이 모두 켬이라 관리자가 끈
//      묶음만 `false`로 보낸다. 켜기보다 먼저 쓰는 이유: 끈 묶음이 있는 도우미는 처음 답하는
//      순간부터 그 일을 하지 않아야 한다(켠 뒤에 끄면 그 사이에 한 번은 켜진 채로 돈다).
//   3. 도우미 켜기(`PATCH …/settings {team_ai_fast_path: true}`) — 같은 트랜잭션에서 멤버와
//      기본 별칭이 생긴다. 멤버 id는 응답 가방의 `team_ai_agent_member_id`다.
//   4. 이름(`PATCH …/agents/{agent} {displayName}`) — 기본 이름과 다를 때만. 멤버는 켠 뒤에야
//      있으므로 마지막이다. 새 이름이 별칭에 더해지는 것은 서버가 같은 트랜잭션에서 한다.
//
// 앞 셋이 실패하면 던진다(`TeamAiSetupError`): 관리자가 고른 것과 다른 상태로 켜지 않는다.
// 이름 바꾸기 실패는 던지지 않고 결과에 싣는다: 도우미는 이미 켜졌고, 이름은 설정에서 다시
// 바꿀 수 있다(충돌·예약어는 사람이 다른 이름을 골라야 하는 일이라 켜기를 되돌리지 않는다).
//
// **다시 시도는 끝난 단계를 다시 하지 않는다.** 호출자가 `progress`를 들고 있다가 다시 넘기면
// 이미 끝난 단계는 건너뛴다. 역할만은 「끝났는가」가 아니라 **서버에 이미 쓴 값과의 차이**를 본다:
// 켜기가 실패한 뒤 관리자가 스위치를 바꾸고 다시 시도하면(꺼 뒀던 묶음을 도로 켜는 것까지) 바뀐 칸만
// 다시 쓰고, 달라진 것이 없으면 쓰지 않는다. 건너뛰기(나중에)는 이 함수를 부르지 않는 것이다: 쓰기 0회.
//
// 이 모듈에는 사용자 문구가 없다. 순수 오케스트레이션이라 쓰는 함수는 주입할 수 있다.
// =============================================================================

import { ApiError, renameAgent } from "../../lib/api";
import { putProviderDefaultAi } from "./defaultAi";
import {
  defaultTeamAiRoles,
  isTeamAiRolesChangeEmpty,
  patchTeamAiRoles,
  teamAiRolesChange,
  type TeamAiRoles,
  type TeamAiRolesChange,
} from "./teamAiRoles";
import {
  fetchWorkspaceSettingsBag,
  readTeamAiSwitch,
  setTeamAiSwitch,
  TEAM_AI_DEFAULT_NAME,
} from "./teamAiSwitch";

/** 이 함수가 던질 수 있는 단계. 이름 바꾸기는 던지지 않아 여기 없다. */
export type TeamAiSetupStep = "default_ai" | "roles" | "enable";

export class TeamAiSetupError extends Error {
  readonly step: TeamAiSetupStep;
  readonly cause: unknown;
  constructor(step: TeamAiSetupStep, cause: unknown) {
    super(`team ai setup failed at ${step}`);
    this.name = "TeamAiSetupError";
    this.step = step;
    this.cause = cause;
  }
}

export interface TeamAiSetupInput {
  workspaceId: string;
  /** 연결 확인이 통과한 키의 연결 순서(저장한 키는 머리라서 대개 0). */
  linkPosition: number;
  /** 관리자가 적은 이름. 앞뒤 공백은 걷는다. 기본 이름과 같으면 이름 바꾸기를 부르지 않는다. */
  name: string;
  /** 관리자가 고른 역할. 기본(모두 켬)과 다른 칸만 서버로 간다. */
  roles: TeamAiRoles;
}

/** 다시 시도가 건너뛸 수 있게 호출자가 들고 있는 진행 기록. */
export interface TeamAiSetupProgress {
  /** 끝난 단계. 역할은 여기 두지 않는다(아래 `rolesWritten`과 비교한다). */
  done: Set<TeamAiSetupStep>;
  /** 켜기가 끝나면 서버가 만든 도우미 멤버 id. */
  memberId: string | null;
  /** 이 설정이 지금까지 서버에 쓴 역할 칸. 기본(모두 켬) 위에 얹힌 값이 서버의 현재 상태다. */
  rolesWritten: TeamAiRolesChange;
}

export function newTeamAiSetupProgress(): TeamAiSetupProgress {
  return { done: new Set(), memberId: null, rolesWritten: {} };
}

export interface TeamAiSetupResult {
  memberId: string;
  /** 모든 쓰기가 끝난 뒤 다시 읽은 설정 가방(별칭 상태를 화면이 보인다). 못 읽으면 null. */
  bag: unknown;
  /** 이름 바꾸기가 거절됐으면 그 오류(켜기는 이미 끝났다). 안 바꿨거나 성공이면 null. */
  renameError: unknown;
}

/** 쓰는 함수 넷과 읽기 하나. 시험이 바꿔 끼운다. */
export interface TeamAiSetupDeps {
  putDefaultAi: (linkPosition: number) => Promise<unknown>;
  patchRoles: (workspaceId: string, change: TeamAiRolesChange) => Promise<unknown>;
  enable: (workspaceId: string) => Promise<unknown>;
  rename: (workspaceId: string, memberId: string, name: string) => Promise<unknown>;
  readBag: (workspaceId: string) => Promise<unknown>;
}

const REAL_DEPS: TeamAiSetupDeps = {
  putDefaultAi: (linkPosition) =>
    putProviderDefaultAi("teamAgent", { linkPosition, modelId: null }),
  patchRoles: patchTeamAiRoles,
  enable: (workspaceId) => setTeamAiSwitch(workspaceId, true),
  rename: renameAgent,
  readBag: fetchWorkspaceSettingsBag,
};

/** 정해진 순서로 쓴다(머리말). 앞 셋의 실패는 `TeamAiSetupError`, 이름 실패는 결과에 싣는다. */
export async function runTeamAiSetup(
  input: TeamAiSetupInput,
  progress: TeamAiSetupProgress,
  deps: TeamAiSetupDeps = REAL_DEPS
): Promise<TeamAiSetupResult> {
  const { workspaceId } = input;
  const name = input.name.trim();

  if (!progress.done.has("default_ai")) {
    try {
      await deps.putDefaultAi(input.linkPosition);
    } catch (error) {
      throw new TeamAiSetupError("default_ai", error);
    }
    progress.done.add("default_ai");
  }

  // 서버의 지금 역할 = 기본(모두 켬) + 이 설정이 이미 쓴 칸. 거기서 관리자가 고른 값까지의 차이만 쓴다.
  const serverRoles = { ...defaultTeamAiRoles(), ...progress.rolesWritten };
  const change = teamAiRolesChange(serverRoles, input.roles);
  if (!isTeamAiRolesChangeEmpty(change)) {
    try {
      await deps.patchRoles(workspaceId, change);
    } catch (error) {
      throw new TeamAiSetupError("roles", error);
    }
    Object.assign(progress.rolesWritten, change);
  }

  if (!progress.done.has("enable")) {
    let memberId: string | null;
    try {
      memberId = readTeamAiSwitch(await deps.enable(workspaceId)).memberId;
    } catch (error) {
      throw new TeamAiSetupError("enable", error);
    }
    // 켠 응답에 멤버 id가 없으면 서버가 도우미를 만들지 않은 것이다. 켠 척하지 않는다.
    if (memberId === null) throw new TeamAiSetupError("enable", new Error("no helper member"));
    progress.memberId = memberId;
    progress.done.add("enable");
  }

  const memberId = progress.memberId as string;
  let renameError: unknown = null;
  if (name !== "" && name !== TEAM_AI_DEFAULT_NAME) {
    try {
      await deps.rename(workspaceId, memberId, name);
    } catch (error) {
      renameError = error;
    }
  }

  let bag: unknown = null;
  try {
    bag = await deps.readBag(workspaceId);
  } catch {
    // 별칭 줄만 못 보인다. 켜기는 끝났다.
  }
  return { memberId, bag, renameError };
}

// ---- 이름 바꾸기 실패의 종류 ---------------------------------------------------------

export type TeamAiRenameErrorKind = "taken" | "reserved" | "invalid" | "forbidden" | "other";

/**
 * 이름 바꾸기 거절을 화면이 갈라 말할 종류로(서버 문장은 영어라 상태와 낱말로 가른다).
 * 409 = 다른 멤버의 이름·핸들과 겹치거나 비슷함(`conflicts_with_roster`), 400 + `reserved` = 멘션
 * 예약어(#4966), 그 밖의 400 = 비었거나 너무 김, 403 = 소유자·관리자가 아님.
 */
export function teamAiRenameErrorKind(error: unknown): TeamAiRenameErrorKind {
  if (!(error instanceof ApiError)) return "other";
  if (error.status === 409) return "taken";
  if (error.status === 400) return /reserved/i.test(error.message) ? "reserved" : "invalid";
  if (error.status === 403) return "forbidden";
  return "other";
}

/** 이름 입력이 저장할 만한가: 앞뒤 공백을 걷은 값이 비지 않아야 한다(100자 상한은 서버와 같다). */
export const TEAM_AI_NAME_MAX_LENGTH = 100;

export function teamAiNameDraft(draft: string): { name: string; valid: boolean } {
  const name = draft.trim();
  return { name, valid: name !== "" && Array.from(name).length <= TEAM_AI_NAME_MAX_LENGTH };
}
