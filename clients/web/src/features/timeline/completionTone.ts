import type { CompletionTone } from "@momo/core/features/timeline/completionReportCard";

// =============================================================================
// 완료 리포트 게이트 결과의 **역할을 이 팔레트의 토큰으로** 옮기는 다리 (UXC-A).
//
// `approvalNoteTone.ts` 가 승인 노트 톤에 대해, `dividerTone` 이 구분선에 대해
// 하는 것과 같은 계약이다: 역할은 코어가 정하고(`COMPLETION_CHECK_TONE` /
// `COMPLETION_OUTCOME_TONE`) 「그 역할을 어느 토큰이 지는가」는 여기 한 곳에 적으며,
// 그 적음이 옳은지는 `completionTone.test.ts` 가 `tokens.css` 를 직접 파싱해 잰다.
//
// 이 다리가 없으면 색은 `AgentCard.tsx` 안의 리터럴이 되고, `skip: "text-danger"`
// 같은 한 글자 오타가 모든 게이트를 통과한 채 사람이 다시 스크린샷을 뜰 때만
// 잡힌다 — design-system README §5.3 이 이름 대어 지목한 사각지대다. 여기서
// 지키는 것은 「초록이다」가 아니라 **역할**이다: 실패는 침묵(skip)과, 대기와,
// 통과와 **서로 다른 값**이어야 하고, 그 다름을 테스트가 두 스킴 모두에서 잰다.
// =============================================================================

/** 역할 -> 토큰 이름. `approvalNoteTone` 의 `--` 이름과 같은 격. */
export const COMPLETION_TONE_TOKEN: Readonly<Record<CompletionTone, string>> = {
  ok: "--ok",
  danger: "--danger",
  warn: "--warn",
  muted: "--ink-muted",
};

/** 역할 -> 이 클라의 잉크 유틸리티. 토큰과 반드시 짝이다(테스트가 잰다). */
export const COMPLETION_TONE_CLASS: Readonly<Record<CompletionTone, string>> = {
  ok: "text-ok",
  danger: "text-danger",
  warn: "text-warn",
  muted: "text-ink-muted",
};
