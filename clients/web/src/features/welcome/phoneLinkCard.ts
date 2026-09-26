import { isDefaultWelcomeChannel } from "./welcomeKickoff";

// =============================================================================
// 「폰에서도」 채널 카드의 문장과 마운트 조건 (#2818, ADR-0193 D7).
// 컴포넌트는 `PhoneLinkChannelCard.tsx`, 상태 저장소는 `phoneLinkCardStore.ts`.
// 코메토의 말은 해요체 한 문장이고, 건너뛰기 문장은 재진입 위치를 말한다(D11).
// =============================================================================

export const PHONE_LINK_CARD_COPY = {
  title: "폰에서도 쓰려면 QR을 찍어요.",
  detail: "설정 › 기기에서도 언제든 열 수 있어요.",
  create: "QR 만들기",
  later: "나중에",
  openTitle: "폰에서 oort를 열고 이 QR을 찍어요.",
  linkedTitle: "폰이 연결됐어요.",
  linkedDetail: "설정 › 기기에서 볼 수 있어요.",
  close: "닫기",
  collapsedLink: "설정 › 기기",
  collapsedAfter: "에서 언제든 연결할 수 있어요.",
} as const;

export const PHONE_LINK_SETTINGS_HREF = "/settings?section=devices";

/**
 * 마운트 여부는 ChatShell이 이 함수로 정한다: 첫 대화 채널
 * (기본 공개 채널)이고 킥오프가 끝났을 때만. 카드 자기 상태(대기·접힘·닫힘)는
 * 이 기기의 저장소가 정한다.
 */
export function shouldMountPhoneLinkCard(input: {
  channel: { kind?: string; name?: string } | null | undefined;
  kickoffPhase: string;
  kickoffSettled: boolean;
}): boolean {
  if (!input.channel) return false;
  if (!isDefaultWelcomeChannel(input.channel)) return false;
  // 킥오프 띠가 서 있는 동안(stage·backstop·exiting)과 그 판정 전(hold)에는
  // 서지 않는다. 오프너가 먼저다(이슈 Acceptance 「오프너 뒤」).
  return input.kickoffPhase === "hidden" && input.kickoffSettled;
}
