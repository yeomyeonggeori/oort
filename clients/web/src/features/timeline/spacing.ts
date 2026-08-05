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
// =============================================================================

/**
 * Tailwind 기본 스케일의 px 값. 여기 없는 단계를 쓰면 테스트가 잡는다 —
 * 임의의 숫자를 클래스 이름에 적어 넣는 것(`pt-[13px]`)을 막는 장치이기도 하다.
 */
export const TAILWIND_SPACE_PX: Record<string, number> = {
  px: 1,
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "5": 20,
  "6": 24,
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
 * 앞 행의 `pb-1.5`와 합쳐 `ROW_SPACE.betweenGroups`가 된다.
 */
export const ROW_GROUP_START_PAD_CLASS = "pt-3 pb-1.5";
/** 이어지는 행. 위아래가 대칭이라 두 연속 행 사이가 `ROW_SPACE.withinGroup`이다. */
export const ROW_CONTINUATION_PAD_CLASS = "py-1.5";

/** `py-1.5` → 6 같은 변환. 테스트와 이 파일이 같은 규칙을 쓰게 한다. */
export function tailwindPx(className: string): number {
  const suffix = className.slice(className.indexOf("-") + 1);
  const value = TAILWIND_SPACE_PX[suffix];
  if (value === undefined) {
    throw new Error(
      `Tailwind 기본 스케일에 없는 단계다: "${className}". 임의값을 클래스에 적어 넣으면 ` +
        "코어의 간격 판정과 화면이 조용히 갈라진다"
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
