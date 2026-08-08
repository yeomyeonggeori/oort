import {
  DIVIDER_SPACE,
  ROW_SPACE,
} from "@momo/core/features/timeline/divider";

// =============================================================================
// 코어의 간격 판정을 Tailwind 클래스로 옮기는 다리 (U4-c · H-7).
//
// ## 왜 `style={{ paddingTop: … }}`가 아닌가
//
// 처음에는 코어의 숫자를 인라인 스타일로 그대로 걸었다 — 값이 한 벌로 남으니 그쪽이
// 옳아 보였다. **이 앱에서는 그게 실행되지 않는다**: CSP가 `style-src 'self'`이고,
// 레포의 eslint 규칙이 인라인 스타일을 아예 error로 막는다(`no-restricted-syntax`:
// "Inline style is blocked by CSP style-src 'self'"). 값이 화면에 닿는 길은 클래스뿐이다.
//
// 그래서 두 벌이 되는 것은 **피할 수 없다.** 피할 수 있는 것은 그 두 벌이 조용히
// 갈라지는 일이고, 그 일을 `spacing.test.ts`가 막는다 — 코어의 숫자를 고치면 여기
// 클래스도 같이 고칠 때까지 스위트가 붉다. 정본은 언제나 코어이고, 이 파일은 번역이다.
//
// ## 간격은 「행의 패딩」이 아니라 「행 사이의 거리」다
//
// 코어의 `ROW_SPACE`는 두 행 **사이에 남는 거리**를 말한다. 웹에서 그 거리는 위 행의
// `padding-bottom`과 아래 행의 `padding-top`의 합이므로, 클래스도 그 합으로 검산해야
// 한다. 테스트가 재는 것이 정확히 그 합이다.
//
// ## 번역이 실패하는 방식은 하나가 아니다 (U4-4R W-1·W-2)
//
// 1차는 이 다리를 놓고 `py-1.5`/`pb-1.5`를 적었다. 산수는 맞았고(6+6=12, 6+12=18)
// **그 클래스들이 존재하지 않았다.** 이 레포의 스케일은 고정이고(`tokens.css`의
// `--spacing: initial`), 하필 그 파일이 `py-1.5`를 「아예 컴파일되지 않는 예」로
// 이름 대어 적어 두었다. 결과는 묶음 안 간격 **0px** — 진단이 실측한 8px보다 나쁜
// 회귀였고, 화면은 그 상태로 머지됐다.
//
// 그 일을 막기로 한 가드는 초록이었다. 아래 표가 **Tailwind 기본 스케일**을 열거하고
// 있었기 때문이다 — 이 레포가 쓰는 표가 아니라 Tailwind가 기본으로 주는 표. 거기에는
// `1.5`가 있으므로 검산은 통과했고, 브라우저에는 그 클래스가 없었다.
//
// 그래서 이 파일은 이제 **이 레포의 표**만 말한다(아래 [`SPACING_SCALE_PX`]).
// 그리고 그 표가 진짜인지는 이 파일이 스스로 주장하지 않는다 — `spacing.test.ts`가
// `tokens.css`를 읽어 대조한다. 선언과 CSS가 갈라지면 스위트가 붉다.
// =============================================================================

/**
 * **이 레포의** 간격 표. `tokens.css`의 `@theme` 블록에 선언된 `--spacing-*`가 정본이고
 * 여기 있는 것은 그 사본이다 — `spacing.test.ts`가 그 파일을 파싱해 둘을 대조한다.
 *
 * Tailwind **기본** 스케일이 아니다. 이 레포는 `--spacing: initial`로 동적 배수를
 * 껐으므로 `py-1.5`·`p-5` 같은 격자 밖 클래스는 이름만 있고 규칙이 없다 —
 * 적어도 화면에 아무 일도 일어나지 않는다. 격자 밖 측정값이 필요하면 숫자가 아니라
 * **이름**으로 들어온다(`--spacing-row`, `--spacing-pane`…).
 *
 * 리듬 축만 담는다. 컨트롤 높이(`control*`)·패널 폭(`pane*`)·본문 측정값
 * (`diff-body`·`terminal-body`)은 간격이 아니라 다른 축이고, 행 패딩으로 쓸 일이
 * 없으므로 이 표에 넣지 않는다 — 넣으면 `py-pane`(320px)이 「유효한 간격」이 된다.
 */
export const SPACING_SCALE_PX: Record<string, number> = {
  "0": 0,
  px: 1,
  "1": 4,
  "2": 8,
  "3": 12,
  "4": 16,
  "6": 24,
  "8": 32,
  marker: 2,
  /** 행 하나가 무는 세로 여백 = `ROW_SPACE.withinGroup`의 절반 (tokens.css). */
  row: 6,
};

/** 날짜 구분선 — 하루가 바뀌는 자리라 가장 크게 연다. */
export const DAY_DIVIDER_PAD_CLASS = "py-3";
/** 안읽음·복구 — 같은 날 안의 표지. */
export const MARKER_DIVIDER_PAD_CLASS = "py-2";
/** 라벨과 rule 사이. */
export const DIVIDER_GAP_CLASS = "gap-3";
/** rule 두께. */
export const DIVIDER_RULE_CLASS = "h-px";

/**
 * 저자 묶음의 **머리** 행. 위로 크게 열고 아래는 묶음 안 간격의 절반만 남긴다.
 * 앞 행의 `pb-row`와 합쳐 `ROW_SPACE.betweenGroups`(6+12=18)가 된다.
 */
export const ROW_GROUP_START_PAD_CLASS = "pt-3 pb-row";
/**
 * 이어지는 행. 위아래가 대칭이라 두 연속 행 사이가 `ROW_SPACE.withinGroup`(6+6=12)이다.
 *
 * 대칭인 것은 우연이 아니다 — 행에는 `hover:bg-surface-hover`가 걸려 있고, 그 배경이
 * 칠해지는 상자가 곧 이 패딩 상자다. 위아래를 다르게 물리면 hover 띠가 글자 아래로
 * 처져 앉는다.
 */
export const ROW_CONTINUATION_PAD_CLASS = "py-row";

/** `py-row` → 6 같은 변환. 테스트와 이 파일이 같은 규칙을 쓰게 한다. */
export function spacingPx(className: string): number {
  const suffix = className.slice(className.indexOf("-") + 1);
  const value = SPACING_SCALE_PX[suffix];
  if (value === undefined) {
    // design-preflight-allow — 이 문구는 사람이 읽는 화면에 도달하지 않는다.
    // 개발자에게 던지는 진단이고, 근거는 둘이다: ① `spacingPx`를 부르는 자리는
    // 이 파일의 테스트뿐이다(`git grep spacingPx`), ② 그래도 렌더 중에 던져진다면
    // 받는 것은 `RenderErrorBoundary`인데 그 폴백은 자기 `message` prop을 그리고
    // `componentDidCatch`는 "intentionally avoids exposing application details in
    // UI"라고 적혀 있다 — `error.message`는 화면에 나가는 경로가 없다.
    // 그래서 문장을 고치는 대신 검토된 예외로 표시한다 (#1141).
    throw new Error(
      `이 레포의 간격 표에 없는 단계다: "${className}". 이 앱의 스케일은 고정이라 ` +
        "여기 없는 단계는 클래스 이름만 있고 CSS 규칙이 없다 — 화면에서는 0px이 된다 " +
        "(U4-4R W-1). 격자 밖 값이 필요하면 tokens.css에 이름을 먼저 만들 것"
    );
  }
  return value;
}

/** 이 파일이 코어와 어긋나지 않았는지. 테스트가 이 값을 읽는다. */
export const SPACING_BRIDGE = {
  dayDividerBlock: DIVIDER_SPACE.day,
  markerDividerBlock: DIVIDER_SPACE.marker,
  labelGap: DIVIDER_SPACE.labelGap,
  ruleThickness: DIVIDER_SPACE.ruleThickness,
  withinGroup: ROW_SPACE.withinGroup,
  betweenGroups: ROW_SPACE.betweenGroups,
} as const;
