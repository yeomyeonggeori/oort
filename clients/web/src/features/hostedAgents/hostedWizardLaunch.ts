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
