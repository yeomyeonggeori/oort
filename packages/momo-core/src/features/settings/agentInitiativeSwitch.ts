// =============================================================================
// 워크스페이스 설정 「에이전트의 먼저 제안」 끄개 (ADR-0186 증보 v5 U-b-3 K1, #4705).
//
// 서버 쪽 사실(계약 = ADR, 서버 PR B #4704):
//   - 끄개는 관리자 전용 설정 가방(`GET|PATCH /v1/workspaces/{ws}/settings`)의 불리언 키
//     `agent_initiative` 다. **없으면 켜짐**이다(`team_ai_fast_path` 와 반대: 그쪽은 없으면 꺼짐).
//     불리언이 아닌 값은 서버가 꺼짐으로 읽는다(문이 닫힌 쪽으로 실패한다).
//   - 끄면 새 먼저 제안은 모두 닫히고, 이미 올라온 카드는 승인해도 실행되지 않는다(결정 때 재증명).
//     거절은 언제나 된다. 에이전트의 `workspace.settings.update` 는 이 키를 바꾸지 못한다.
//
// **기능 감지.** 이 키를 모르는 서버(PR B 이전)와 아는 서버는 가방만 봐서는 구별되지 않는다: 둘 다
// 키가 없다(= 켜짐으로 읽는다). 그래서 키가 없을 때만 **부작용 없는 물음**을 한 번 던진다. 불리언이
// 아닌 값(`"probe"`)을 PATCH 한다. 서버는 가방을 쓰기 전에 모든 키를 검사하고 거절하므로 어느
// 서버에서도 아무것도 바뀌지 않는다(`merge_workspace_settings`, `teamAiSwitch.ts` 와 같은 방식).
//   - 400 「unknown settings key」 → 모른다. 카드를 그리지 않는다.
//   - 그 밖의 400 → 키를 알고 값이 틀렸다고 거절한 것이다. 카드를 그린다.
//   - 그 밖(403·네트워크·200) → 확인하지 못했다. 카드를 그리지 않는다(fail closed).
// `null` 이나 `true`/`false` 로 묻지 않는 이유: `null` 은 키를 지우고 `false` 는 문을 닫는다.
// 물음이 아니라 쓰기다.
//
// runtime-unverified: 이 트랙(track/uxui)에는 서버 PR B 가 없다. 거절 문장은 team_ai 선례를
// 따라 판정하되 키 이름에 기대지 않는다(「unknown settings key」만 가른다).
// =============================================================================

import { ApiError } from "../../lib/api";
import { settingsRequest } from "./api";

export const AGENT_INITIATIVE_SETTINGS_KEY = "agent_initiative";
export const AGENT_INITIATIVE_PROBE_VALUE = "probe";

/** 가방에서 읽은 끄개. `known` 이 거짓이면 가방만으로는 서버가 키를 아는지 모른다. */
export interface AgentInitiativeState {
  known: boolean;
  /** 먼저 제안이 열려 있는가. 키가 없으면 열려 있다. */
  enabled: boolean;
}

function bagRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readAgentInitiative(bag: unknown): AgentInitiativeState {
  const flag = bagRecord(bag)[AGENT_INITIATIVE_SETTINGS_KEY];
  if (flag === undefined) return { known: false, enabled: true };
  // 서버가 닫힌 쪽으로 읽는 값(불리언이 아님)은 켜진 것처럼 그리지 않는다.
  return { known: true, enabled: flag === true };
}

export type AgentInitiativeSupport = "ready" | "absent" | "unknown";

/** 물음(불리언 아닌 값 PATCH)의 대답을 판정한다. */
export function classifyAgentInitiativeProbe(error: unknown): AgentInitiativeSupport {
  if (!(error instanceof ApiError) || error.status !== 400) return "unknown";
  return error.message.toLowerCase().includes("unknown settings key")
    ? "absent"
    : "ready";
}

function settingsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`;
}

/**
 * 서버가 끄개를 아는지 묻는다. 정상 서버는 반드시 400 으로 거절하므로, 200 이 오면(검증이 사라진
 * 서버) 판정하지 않고 `unknown` 으로 둔다.
 */
export async function probeAgentInitiativeSwitch(
  workspaceId: string
): Promise<AgentInitiativeSupport> {
  try {
    await settingsRequest<unknown>(settingsPath(workspaceId), {
      method: "PATCH",
      body: JSON.stringify({
        [AGENT_INITIATIVE_SETTINGS_KEY]: AGENT_INITIATIVE_PROBE_VALUE,
      }),
    });
    return "unknown";
  } catch (error) {
    return classifyAgentInitiativeProbe(error);
  }
}

/** 켜기/끄기. 응답은 저장된 가방 전체다. */
export function setAgentInitiativeSwitch(
  workspaceId: string,
  enabled: boolean
): Promise<unknown> {
  return settingsRequest<unknown>(settingsPath(workspaceId), {
    method: "PATCH",
    body: JSON.stringify({ [AGENT_INITIATIVE_SETTINGS_KEY]: enabled }),
  });
}

// ---- 문구 ----------------------------------------------------------------------

export const AGENT_INITIATIVE_SECTION_TITLE = "에이전트의 먼저 제안";

export const AGENT_INITIATIVE_SECTION_DESCRIPTION =
  "허락을 받은 에이전트가 부르지 않아도 소유자와의 대화에 승인 카드를 올릴 수 있어요. 실행은 사람이 승인한 뒤에만 일어나요.";

export const AGENT_INITIATIVE_SWITCH_LABEL = "먼저 제안 받기";

export const AGENT_INITIATIVE_SWITCH_DESCRIPTION =
  "끄면 새 카드가 올라오지 않고, 이미 올라온 카드는 승인해도 실행되지 않아요.";

export function agentInitiativeBusyLabel(next: boolean): string {
  return next ? "먼저 제안 켜는 중" : "먼저 제안 끄는 중";
}

/** 저장 실패를 한 문장으로. 키를 모르는 서버(400)는 서버를 먼저 올리라고 말한다. */
export function agentInitiativeSaveErrorCopy(error: unknown): string {
  if (classifyAgentInitiativeProbe(error) === "absent") {
    return "이 서버는 아직 이 설정을 몰라요. 서버를 업데이트한 뒤 다시 시도하세요.";
  }
  return "설정을 저장하지 못했어요. 연결을 확인하고 다시 시도하세요.";
}
