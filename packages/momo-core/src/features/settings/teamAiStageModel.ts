// =============================================================================
// 온보딩 「팀 AI」 단계의 순수 모델 (ADR-0201 증보 v3 B3·B10, #4945).
//
// 화면이 어느 모습인지(`teamAiStageView`)와 그 모습의 코메토 말(`teamAiStageGuide`)을 정한다.
// 웹 컴포넌트는 이 답을 그리기만 한다. 판정이 컴포넌트 안에 흩어지면 키가 있는 서버·없는 서버·
// 운영자가 아닌 사람·연결 실패가 서로 다른 순서로 읽힌다.
//
// 이 모듈에는 사용자 문구가 없다. 문구는 사전 키(`teamAi.stage.*`)로만 가리킨다.
// 순수 모듈이다(DOM·fetch·React 없음).
// =============================================================================

import type { GuideState } from "../onboarding/guide";
import type { ProviderLink } from "./api";
import type { PlainMessageKey } from "./teamAiCopyKeys";

/** 이 단계가 서는 모습. 위에서부터 먼저 맞는 것이 이긴다(`teamAiStageView`). */
export const TEAM_AI_STAGE_VIEW = {
  /** 운영자인지 아직 모른다(키 줄을 읽는 중). */
  loading: "loading",
  /** 운영자가 아니라 키를 넣을 수 없다. 한 줄과 계속. */
  notOperator: "not-operator",
  /** 키 줄을 읽지 못했다(403이 아닌 오류). 다시 시도와 나중에. */
  loadError: "load-error",
  /** 키가 없거나 방금 확인에 실패했다: 키 폼. */
  key: "key",
  /** 키를 시험 호출로 확인하는 중. */
  verifying: "verifying",
  /** 키가 확인됐다: 이름과 역할을 고른다. */
  setup: "setup",
  /** 「도우미 켜기」 쓰기가 도는 중. */
  enabling: "enabling",
  /** 켰다: 부르는 이름과 계속. */
  done: "done",
} as const;

export type TeamAiStageView = (typeof TEAM_AI_STAGE_VIEW)[keyof typeof TEAM_AI_STAGE_VIEW];

export interface TeamAiStageViewInput {
  /** 켜기가 끝났다(결과가 있다). */
  done: boolean;
  /** 켜기 쓰기가 도는 중이다. */
  enabling: boolean;
  /** 키 줄(`GET /v1/provider/link`)을 아직 못 읽었다. */
  linkPending: boolean;
  /** 키 줄이 403이었다: 운영자가 아니다. */
  denied: boolean;
  /** 키 줄이 403이 아닌 오류였다. */
  linkError: boolean;
  /** 키가 확인됐다(통과했거나 서버가 직접 확인하지 않는 서버). */
  verified: boolean;
  /** 키를 확인하는 중이거나 곧 확인한다. */
  verifying: boolean;
}

export function teamAiStageView(input: TeamAiStageViewInput): TeamAiStageView {
  if (input.done) return TEAM_AI_STAGE_VIEW.done;
  if (input.enabling) return TEAM_AI_STAGE_VIEW.enabling;
  if (input.linkPending) return TEAM_AI_STAGE_VIEW.loading;
  if (input.denied) return TEAM_AI_STAGE_VIEW.notOperator;
  if (input.linkError) return TEAM_AI_STAGE_VIEW.loadError;
  if (input.verified) return TEAM_AI_STAGE_VIEW.setup;
  if (input.verifying) return TEAM_AI_STAGE_VIEW.verifying;
  return TEAM_AI_STAGE_VIEW.key;
}

export interface TeamAiStageGuideInput {
  /** 방금 키 확인이 실패했다(`key` 모습에서만 뜻이 있다). */
  keyFailed: boolean;
  /** 「도우미 켜기」가 실패했다(`setup` 모습에서만 뜻이 있다). */
  enableFailed: boolean;
  /** 서버가 키를 직접 확인하지 않아 「확인 전」으로 넘어왔다. */
  unverified: boolean;
}

export interface TeamAiStageGuide {
  state: GuideState;
  line: PlainMessageKey;
  /** 둘째 줄의 사전 키. 없으면 null. */
  detail: PlainMessageKey | null;
  /** 둘째 줄이 사전이 아니라 확인 실패 사유 문장(`teamCheckReason`)이다. */
  detailIsCheckReason: boolean;
}

function guide(
  state: GuideState,
  line: PlainMessageKey,
  detail: PlainMessageKey | null = null,
  detailIsCheckReason = false
): TeamAiStageGuide {
  return { state, line, detail, detailIsCheckReason };
}

/** 코메토의 표정과 말(ADR-0193 D11: 상태와 표정은 1:1이고 문장이 함께 간다). */
export function teamAiStageGuide(
  view: TeamAiStageView,
  input: TeamAiStageGuideInput
): TeamAiStageGuide {
  switch (view) {
    case TEAM_AI_STAGE_VIEW.loading:
      return guide("checking", "teamAi.stage.checkingLine");
    case TEAM_AI_STAGE_VIEW.notOperator:
      return guide("awaiting", "teamAi.stage.notOperatorLine", "teamAi.stage.notOperatorDetail");
    case TEAM_AI_STAGE_VIEW.loadError:
      return guide("trouble", "teamAi.stage.loadErrorLine", "teamAi.stage.loadErrorDetail");
    case TEAM_AI_STAGE_VIEW.verifying:
      return guide("checking", "teamAi.stage.verifyingLine");
    case TEAM_AI_STAGE_VIEW.setup:
      if (input.enableFailed) {
        return guide("trouble", "teamAi.stage.enableFailedLine", "teamAi.stage.enableFailedDetail");
      }
      return guide(
        "awaiting",
        "teamAi.stage.setupLine",
        input.unverified ? "teamAi.stage.setupUnverifiedDetail" : "teamAi.stage.setupDetail"
      );
    case TEAM_AI_STAGE_VIEW.enabling:
      return guide("preparing", "teamAi.stage.enablingLine");
    case TEAM_AI_STAGE_VIEW.done:
      return guide("success", "teamAi.stage.doneLine", "teamAi.stage.doneDetail");
    default:
      return input.keyFailed
        ? guide("trouble", "teamAi.stage.keyFailedLine", null, true)
        : guide("awaiting", "teamAi.stage.keyLine", "teamAi.stage.keyDetail");
  }
}

/**
 * 이 서버에 이미 팀 AI 키가 있는가: 사용자가 저장했거나 서버 환경값이 있다(모의 연결은 키가
 * 아니다). 있으면 단계는 키를 다시 묻지 않고 확인부터 한다.
 */
export function providerLinkHasKey(link: ProviderLink | null | undefined): boolean {
  if (!link) return false;
  return link.configured || (link.keyConfigured && link.availability !== "mock");
}

/** 쿼리 키. 설정·AI 허브·채팅 카드가 같은 키를 읽으므로 한 곳에 둔다(캐시가 하나로 맞는다). */
export const TEAM_AI_QUERY_KEYS = {
  providerLink: ["settings", "provider-link"],
  providerLinkChain: ["settings", "provider-link-chain"],
  providerDefaultAi: ["settings", "provider-default-ai"],
  /** 워크스페이스 설정 가방(관리자 전용). 웹 `teamAiSettingKey`와 같은 값이다. */
  settingsBag: (workspaceId: string) =>
    ["settings", "team-ai", workspaceId.toLowerCase()] as const,
} as const;

/**
 * 폰 설정 페이지 위에 쌓이는 「도우미」 장의 이름표(`SettingsSubPage`). 화면 상태의 이름이라 문구가 아니다. 코어에 두는
 * 까닭은 직접 문구 장부가 한 낱말 문자열을 문구로 세기 때문이다.
 */
export const TEAM_AI_HELPER_PAGE = "teamAiHelper" as const;
