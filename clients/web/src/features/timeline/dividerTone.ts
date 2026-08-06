import type { DividerTone } from "@momo/core/features/timeline/divider";

// =============================================================================
// 코어의 **역할**을 이 팔레트의 토큰으로 옮기는 다리 (design-review U4-4 D-2).
//
// `spacing.ts`가 간격에 대해 하는 일을 색에 대해 한다. 그 파일과 같은 이유로
// 두 벌이 생기고(코어는 값을 모르고, 화면은 클래스만 받는다), 같은 방식으로
// 갈라지지 않게 막는다 — `dividerTone.test.ts`가 `tokens.css`를 직접 파싱해
// 코어의 명세(`DIVIDER_TONE_SPEC`)를 이 표에 대고 잰다.
//
// ## 왜 이 파일이 생겼나
//
// 리뷰: *"웹 `tone="accent"` → `--accent`. 폰 `color.warn`. 폰의 `accent`는 파랑
// 이다. 두 값이 지금 비슷한 호박색이라 화면에서는 통일되어 보이지만 계약이
// 아니다."* 그 상태에서 웹의 코드가 말하고 있던 것은 「이 구분선은 accent다」
// 였고, 그것은 **어느 토큰인가**이지 **왜 그 토큰인가**가 아니다. 팔레트를
// 손대는 사람은 「accent를 파랑으로 바꾼다」는 결정을 내릴 수 있고, 그 결정이
// 안읽음 경계에 무슨 일을 하는지는 어디에도 적혀 있지 않았다.
//
// 이제 화면은 역할을 받는다(`tone="boundary"`), 그 역할이 어느 토큰인지는 이
// 표가 한 자리에서 답하며, 그 토큰이 역할을 만족하는지는 테스트가 잰다.
// =============================================================================

/** 이 톤이 실제로 쓰는 CSS 변수 이름. 테스트가 `tokens.css`에서 이 이름을 찾는다. */
export const DIVIDER_TONE_TOKEN: Record<DividerTone, string> = {
  quiet: "--ink-muted",
  boundary: "--accent",
};

/**
 * 명세의 `mustDifferFrom`에 나오는 역할 이름 → 이 팔레트의 토큰.
 *
 * `quiet`은 위 표가 이미 답하므로 여기 없다. 나머지 둘은 구분선의 톤이 아니라
 * **다른 표면의 정체**이고, 그것들과 겹치지 않는 것이 계약이다.
 */
export const CONTRAST_ROLE_TOKEN: Record<string, string> = {
  agent: "--agent",
  danger: "--danger",
};

/** 라벨과 rule에 걸리는 클래스. 문자열 리터럴이라 Tailwind 스캐너가 본다. */
export const DIVIDER_TONE_CLASS: Record<
  DividerTone,
  { label: string; rule: string }
> = {
  // 조용한 표지: 글자는 물러난 잉크, rule은 그냥 선이다. rule까지 물들이면
  // 「그냥 선」이 아니게 되고, 날짜가 안읽음만큼 크게 말하기 시작한다.
  quiet: { label: "text-ink-muted", rule: "bg-line" },
  // 경계: 라벨과 rule이 **같은 색**이다. 한 경계는 한 색이고, 그것이 코어
  // 명세의 `paintsRule`이 말하는 것이다. 굵기는 색과 함께 간다 — 색만으로
  // 앞으로 나오게 하면 색각 이상이 있는 사람에게 이 줄은 그냥 회색 줄이다.
  boundary: { label: "font-medium text-accent", rule: "bg-accent" },
};
