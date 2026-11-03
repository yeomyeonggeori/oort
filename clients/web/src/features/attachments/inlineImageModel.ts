// =============================================================================
// 타임라인 인라인 이미지의 크기 규칙 (#5189). 정본: docs/design-system/README.md §2.10.
//
// 순수 계산만 둔다. 자연 크기를 읽는 일(`<img onLoad>`)과 그리는 일은 `AttachmentList.tsx` 가
// 한다. 열 폭은 여기 없다: 열이 상자보다 좁으면 CSS(`max-w-full h-auto`)가 비율을 지킨 채
// 줄인다 — JS 가 열 폭을 추측하지 않는다. 모서리도 CSS 다(`tokens.css` `image-corner`).
//
// ## 왜 규칙이 필요했나
//
// 앞 판은 모든 한 장 그림을 폭 360 · 높이 320 상자 하나에 가두었다. 그 상자는 보통 그림에는
// 맞지만 가로로 긴 캡처(2072×110)는 360×19 가 되어 배율 0.17 로 글자가 뭉개졌고, 반경 10 이
// 높이 19 에 걸려 양끝이 알약이 되었다. 원본 바이트는 멀쩡했다(타임라인은 늘 원본을 그린다):
// 문제는 해상도가 아니라 **표시 크기**였다.
//
// ## 규칙: 상자 둘 중 더 크게 서는 쪽
//
//   보통 상자  360×320   fitStandard = min(1, 360/w, 320/h)    예전 그대로
//   넓은 상자  폭 제한 없음 × 높이 180
//              fitWide = min(1, 180/h, 1/2)                    원본 폭의 절반까지만
//
//   배율 = max(fitStandard, fitWide).  표시 = 원본 × 배율.  원본보다 키우지 않는다(배율 ≤ 1).
//
// 가로세로비 2 이하(16:9 스크린샷, 사진, 정사각, 세로)는 보통 상자가 이긴다: 늘 보던 크기다.
// 2 를 넘으면 넓은 상자가 이기기 시작해 높이 180 을 지키며 폭이 비율만큼 늘어난다(2.5:1 → 450×180).
// 두 값이 가로세로비 2 에서 같아서(360×180) 비슷한 두 그림이 전혀 다른 크기로 서는 절벽이 없다.
// 더 납작한 그림은 높이가 180 보다 낮아지고 폭이 늘어, 대화 열(CSS)이 허락하는 만큼 자란다.
//
// **절반 한계**(`wideEnlargeLimit`)는 해상도 규칙이다: 넓은 그림을 보통 상자보다 키우는 것은 원본
// 폭의 절반(= 2배 화면에서 원본 픽셀 1:1)까지만이다. 그래서 2배 화면에서 넓은 그림이 확대로
// 흐려지지 않고, 표시 크기 × DPR 이하의 픽셀만 그린다. 보통 상자 안의 그림은 이 한계를 받지
// 않는다(예전 그대로이고 새로 흐려지지 않는다). 원본 자체가 작으면 없는 픽셀을 만들지 않고 원본
// 크기에서 멈춘다.
//
// 자연 크기를 모르는 동안(받는 중, 디코드 전)은 `null` 이고 호출처가 옛 CSS 상자(360×320)로
// 그린다. 크기를 지어내지 않는다.
// =============================================================================

/**
 * 숫자는 `tokens.css` 의 이름 치수와 같은 값이다. 이름이 다른 토큰의 값을 빌려 쓰는 것이 아니라
 * 같은 사실을 가리키는 것이고, `inlineImageModel.test.ts` 가 `tokens.css` 를 읽어 한 줄씩 대조한다
 * (어느 한쪽만 바뀌면 시험이 붉다).
 */
export const INLINE_IMAGE = {
  /** `--spacing-inline-image-w`: 보통 상자의 폭. */
  standardWidth: 360,
  /** `--spacing-inline-image-h`: 모든 한 장 그림이 멈추는 높이. */
  maxHeight: 320,
  /** `--spacing-preview-frame`: 넓은 상자의 높이. 도착 전 자리 상자의 높이이기도 하다. */
  wideHeight: 180,
  /**
   * 넓은 그림을 보통 상자보다 키우는 한계(원본 대비 배율). 2배 화면에서 원본 픽셀 1:1 이다. 값은
   * 토큰이 아니라 해상도 가정이고, README §2.10 이 그 이유를 적는다.
   */
  wideEnlargeLimit: 0.5,
  /**
   * 이 높이 아래의 그림은 호버 행동 줄(`--spacing-control` 32 한 줄)을 위에서 8 띄워 얹으면 아래
   * 8 여유가 없어 그림 밖으로 삐져나온다. 그런 그림은 줄을 세로 가운데에 놓는다(`isCompactImage`).
   */
  compactBelow: 48,
} as const;

export interface NaturalSize {
  width: number;
  height: number;
}

export interface InlineImageBox {
  /** CSS px. 열이 더 좁으면 CSS 가 비율대로 줄인다. */
  width: number;
  height: number;
  /** 넓은 상자가 이겼다(가로세로비 2 초과). 높이 180 까지, 폭은 열이 허락하는 만큼. */
  wide: boolean;
}

function usable(value: number | undefined): value is number {
  return Number.isFinite(value) && (value as number) > 0;
}

/**
 * 한 장 그림이 서는 상자(CSS px). 자연 크기는 원본 픽셀이다. 자연 크기를 모르면(`null`) 상자를
 * 지어내지 않고 `null` 을 돌려주며, 호출처가 예전 상자(`IMAGE_FIT_UNKNOWN`)로 그린다.
 */
export function inlineImageBox(
  natural: Partial<NaturalSize> | null | undefined
): InlineImageBox | null {
  if (natural === null || natural === undefined) return null;
  const { width, height } = natural;
  if (!usable(width) || !usable(height)) return null;

  const fitStandard = Math.min(
    1,
    INLINE_IMAGE.standardWidth / width,
    INLINE_IMAGE.maxHeight / height
  );
  const fitWide = Math.min(
    1,
    INLINE_IMAGE.wideHeight / height,
    INLINE_IMAGE.wideEnlargeLimit
  );
  const scale = Math.max(fitStandard, fitWide);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    wide: fitWide > fitStandard,
  };
}

/**
 * 이미지의 크기 클래스(`tokens.css` 의 이름 치수). 자연 크기를 알면 상자는 HTML 치수 속성이 정하고,
 * 클래스는 열이 좁을 때 비율대로 줄이는 일만 한다. 모르는 동안은 예전 상자(360×320)다.
 * 한 낱말씩 따로 적는 것은 직접 문구 장부(`direct-copy`)가 JSX 안의 낱말 문자열을 문구로 세기
 * 때문이다: 클래스 이름은 문구가 아니므로 JSX 밖에서 이름을 붙인다.
 */
export const IMAGE_FIT_KNOWN = ["h-auto", "max-w-full"] as const;
export const IMAGE_FIT_UNKNOWN = ["max-h-inline-image-h", "max-w-inline-image-w"] as const;

/** 호버 행동 줄이 그림 안에 위에서 8 띄워 들어가지 못하는 낮은 그림인가. */
export function isCompactImage(box: InlineImageBox | null): boolean {
  return box !== null && box.height < INLINE_IMAGE.compactBelow;
}

// ---- 모서리 (CSS `image-corner` 의 명세) --------------------------------------

/**
 * 이미지 모서리 규칙. 구현은 CSS 다(`tokens.css` `@utility image-corner` =
 * `border-radius: min(var(--radius-md), 25%)`): 퍼센트는 가로 반경을 폭으로, 세로 반경을 높이로
 * 풀어서 **렌더된** 상자(열이 좁아 비율대로 줄어든 것까지)를 따라가고, JS 가 열 폭을 재지 않는다.
 * 이 상수와 함수는 그 CSS 가 말하는 바를 시험이 읽을 수 있게 적어 둔 명세이고, 시험이 `tokens.css`
 * 를 읽어 두 값이 같은지 대조한다.
 *
 * 왜 한 값(10)이 아닌가: 높이 19 의 가로 캡처에 반경 10 은 높이의 절반을 넘어 양끝이 알약이 된다.
 * 상한 10 은 `--radius-md`(이미지·배지·태그의 자리)이고, 사다리에 새 값을 더하지 않는다.
 */
export const IMAGE_CORNER = {
  /** `--radius-md`. */
  maxRadius: 10,
  /** 한 축의 반경이 그 축의 변에서 차지할 수 있는 최대 비율. */
  maxRatio: 0.25,
} as const;

/** 폭×높이 상자의 모서리 반경(CSS px): 가로 반경은 폭에서, 세로 반경은 높이에서 푼다. */
export function imageCornerRadius(
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: Math.min(IMAGE_CORNER.maxRadius, IMAGE_CORNER.maxRatio * width),
    y: Math.min(IMAGE_CORNER.maxRadius, IMAGE_CORNER.maxRatio * height),
  };
}
