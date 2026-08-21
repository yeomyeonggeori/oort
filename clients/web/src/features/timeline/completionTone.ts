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

// ---- 그릇 쪽 다리 (#1516) ---------------------------------------------------
//
// 위 두 표가 「이 역할은 무슨 **잉크**인가」를 답한다면, 아래 둘은 「무슨 **그릇**에
// 서는가」를 답한다. 같은 계약이라 같은 자리에 산다: 역할은 코어가 정하고, 그 역할을
// 어느 토큰이 지는지는 여기 한 곳에 적으며, 그 적음이 옳은지는
// `completionTone.test.ts` 가 tokens.css 를 파싱해 잰다.
//
// **왜 잉크와 그릇이 따로 적히는가.** 둘이 언제나 짝이면 표 하나로 충분했을 것이다.
// 그렇지 않은 칸이 하나 있다: `muted` 의 잉크는 `--ink-muted` 인데 그릇은
// `--muted-soft` 다. 잉크는 전경 톤이고 그릇은 그 톤의 옅은 채움이라 서로 다른 축의
// 값이고, 이름이 파생되지 않는다. 규칙을 「`text-X` 의 X 에 `-soft` 를 붙인다」로
// 지으면 그 칸에서 `--ink-muted-soft` 라는 없는 토큰을 부르게 되고, 그 실패는
// 컴파일이 아니라 화면에서 **그릇 없는 칩**으로 나타난다.
//
// muted 가 톤 없는 그릇으로 떨어지는 것은 규칙의 예외가 아니라 규칙 그 자체다:
// 건너뛴 게이트는 아무것도 재지 않았으므로 물들일 톤이 없다. 그 자리에서 검증 칩이
// 수명주기 칩과 같은 그릇에 서는 것도 같은 이유다 — 둘 다 말할 것이 없다.

/** 역할 -> 그릇 토큰. `COMPLETION_TONE_TOKEN` 의 그릇 짝. */
export const COMPLETION_TONE_SOFT_TOKEN: Readonly<
  Record<CompletionTone, string>
> = {
  ok: "--ok-soft",
  danger: "--danger-soft",
  warn: "--warn-soft",
  muted: "--muted-soft",
};

/** 역할 -> 이 클라의 그릇 유틸리티. 토큰과 반드시 짝이다(테스트가 잰다). */
export const COMPLETION_TONE_SOFT_CLASS: Readonly<
  Record<CompletionTone, string>
> = {
  ok: "bg-ok-soft",
  danger: "bg-danger-soft",
  warn: "bg-warn-soft",
  muted: "bg-muted-soft",
};
