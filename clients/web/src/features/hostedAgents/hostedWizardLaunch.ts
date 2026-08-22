import type { HostedPresetId } from "@momo/core/features/hostedAgents/presets";

/**
 * 에이전트 허브 원클릭이 마법사에 넘기는 시드. 단계 기계는 바꾸지 않고
 * identity 프리필과 (가능할 때) 첫 발급만 대신 밟는다.
 *
 * 비밀값은 여기 없다. 발급 응답은 마법사 안에서만 산다.
 */
export interface HostedWizardLaunch {
  presetId: HostedPresetId;
  displayName: string;
  handle: string;
  connectionId?: string;
  autoAdvance?: "create" | "regenerate";
}

/**
 * 원클릭 자동 발급을 지금 쏠지, 기다릴지, 영구히 내릴지.
 *
 * 열림 시점에 온라인이어야 무장한다. 유예됐거나 시드와 다른 초안이면
 * 무장 해제하고, 발급은 푸터 버튼이 이어받는다.
 */
export type AutoAdvanceDecision =
  | "fire-create"
  | "fire-regenerate"
  | "disarm"
  | "wait";

export function initialAutoAdvanceArmed(
  launch: HostedWizardLaunch | null,
  offline: boolean
): boolean {
  return launch?.autoAdvance !== undefined && !offline;
}

export function decideAutoAdvance(input: {
  armed: boolean;
  offline: boolean;
  autoAdvance: HostedWizardLaunch["autoAdvance"];
  draftReady: boolean;
  draftMatchesSeed: boolean;
  hasConnectionId: boolean;
}): AutoAdvanceDecision {
  if (!input.armed) return "wait";
  if (input.offline) return "disarm";
  if (input.autoAdvance === "create") {
    if (!input.draftReady) return "wait";
    if (!input.draftMatchesSeed) return "disarm";
    return "fire-create";
  }
  if (input.autoAdvance === "regenerate") {
    if (!input.hasConnectionId) return "wait";
    return "fire-regenerate";
  }
  return "wait";
}
