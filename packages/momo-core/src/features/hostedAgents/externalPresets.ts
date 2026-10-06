import { HOSTED_AGENT_SIGNATURES, GROK_HOSTED_AGENT_ID } from "./detect";
import { hostedPreset, type HostedPresetId } from "./presets";

// =============================================================================
// 「에이전트 만들기 → 다른 곳에서 도는 에이전트」 안의 프리셋 고르기 (AT-7 제안 5, #3523).
//
// 그록봇 한 줄 초대는 데스크탑에서 앱이 보일 때만 떴다. 이 목록은 같은 감지 결과를
// 만들기 흐름 안으로 옮기고, 감지가 없는 웹에서도 프리셋은 그대로 고르게 한다.
//
// 지키는 규칙 셋.
//   1. 추천은 **감지가 실제로 앱을 봤을 때만** 붙는다. 못 찾았거나 웹이면 추천하지 않는다.
//      못 찾은 것은 「없다」가 아니라 「이 컴퓨터에서는 못 찾았다」로만 말한다.
//   2. 지원하지 않는 것은 **고를 수 없는 줄**로 보이고 사유를 말한다. 눌러서 위저드로
//      들어가는 가짜 길을 만들지 않는다(dots).
//   3. 고르는 것은 위저드의 시작 값(프리셋·이름·핸들)뿐이다. 위저드 단계·권한은 그대로다.
// =============================================================================

export type ExternalDetection = "detected" | "not-found" | "unavailable";

export type ExternalPresetCardId = HostedPresetId | "dots";

export interface ExternalPresetCard {
  id: ExternalPresetCardId;
  title: string;
  note: string;
  state: "available" | "soon";
  /** 감지로 추천하는 줄. 한 목록에 하나만 참이다. */
  recommended: boolean;
  /** 줄 옆 짧은 표지. 추천이면 「추천」, 지원 전이면 「곧 지원」. */
  badge: string | null;
}

export const EXTERNAL_PICKER_COPY = {
  title: "어떤 에이전트를 초대할까요?",
  description: "에이전트를 고르면 연결 값을 만드는 순서가 이어져요.",
  listLabel: "초대할 에이전트",
  cancel: "닫기",
  recommendedBadge: "추천",
  soonBadge: "곧 지원",
  detectedNote: "이 컴퓨터에서 앱을 찾았어요.",
  notFoundNote: "이 컴퓨터에서는 앱을 찾지 못했어요. 다른 곳에서 쓰고 있다면 그대로 이어가도 돼요.",
  grokNote: "연결 값을 말로 전하면 그록봇이 직접 붙여요.",
  genericNote: "원격 MCP 서버를 붙일 수 있는 에이전트라면 무엇이든 이 순서로 붙어요.",
  dotsNote: "아직 연결할 수 없어요.",
} as const;

/** 고른 줄이 위저드에 넘기는 시작 값. 이름은 감지 서명과 같은 한 곳에서 온다. */
export function externalPresetSeed(id: HostedPresetId): { displayName: string; handle: string } {
  if (id === "grok") {
    const identity = HOSTED_AGENT_SIGNATURES.find((s) => s.id === GROK_HOSTED_AGENT_ID)?.identity;
    if (identity) return { displayName: identity.displayName, handle: identity.handle };
  }
  return { displayName: "", handle: "" };
}

export function externalPresetCards(detection: ExternalDetection): ExternalPresetCard[] {
  const copy = EXTERNAL_PICKER_COPY;
  const grokDetected = detection === "detected";
  const grokNote =
    detection === "detected"
      ? `${copy.detectedNote} ${copy.grokNote}`
      : detection === "not-found"
        ? `${copy.grokNote} ${copy.notFoundNote}`
        : copy.grokNote;
  return [
    {
      id: "grok",
      title: "그록봇",
      note: grokNote,
      state: "available",
      recommended: grokDetected,
      badge: grokDetected ? copy.recommendedBadge : null,
    },
    {
      id: "generic",
      title: hostedPreset("generic").label,
      note: copy.genericNote,
      state: "available",
      recommended: false,
      badge: null,
    },
    {
      id: "dots",
      title: "dots",
      note: copy.dotsNote,
      state: "soon",
      recommended: false,
      badge: copy.soonBadge,
    },
  ];
}
