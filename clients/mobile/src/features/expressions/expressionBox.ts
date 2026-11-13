import type {
  ExpressionMedia,
  ExpressionVariant,
} from '@momo/core/features/expressions/types';

// =============================================================================
// 표현 그림의 「칸」(#5451).
//
// 앞 판의 `ExpressionImage` 는 칸의 크기를 **지금 그리는 변형(thumb·small·large)의 가로세로**와 **받기가 끝났는가**에서 셈했다.
// 받는 중이거나 변형이 바뀌는 사이(`thumb → large`, 4번 돌고 `large → thumb`, 눌러서 다시 재생)에는 0x0 에 글자 `:이름:` 한 줄이 서서
// 행이 160pt → 글자 한 줄 → 160pt 로 접혔다 펴졌다. 대화에 들어올 때마다 보이던 위아래 떨림과, 이모티콘·GIF 를 누를 때 사라지거나 떨던 것이
// 같은 뿌리다.
//
// 칸은 **그림이 정해지면 바뀌지 않는다**: 크기 표(ADR-0218 D1)의 점 수와 등록이 말하는 가로세로 비율(목록 응답의 `media.large`)만으로 셈한다.
// 어느 변형을 그리는지, 받았는지는 칸에 영향이 없다. 비율은 변형마다 반올림이 달라 0.4pt 쯤 어긋날 수 있어서 가장 큰 그림 하나로 못 박는다.
// =============================================================================

export type PhoneExpressionSize =
  | 'reaction'
  | 'inline'
  | 'medium'
  | 'large'
  | 'grid'
  | 'tile';

/**
 * 크기·변형 이름은 표의 **키**에서 꺼낸다(`SIZE.large`, `VARIANT.thumb`). 이 파일에 글자 낱말을 새로 쓰면 직접 문구 장부(`direct-copy`, 글자 낱말을 센다)가
 * 늘어서, 같은 이름을 키(세지 않는다)에서 되돌려 받는다. 타입이 키의 존재를 지킨다.
 */
export const nameOf = <K extends string>(table: Record<K, unknown>) =>
  Object.fromEntries(Object.keys(table).map(key => [key, key])) as {[P in K]: P};
const SIZE = nameOf<PhoneExpressionSize>({reaction: 0, inline: 0, medium: 0, large: 0, grid: 0, tile: 0});
const VARIANT = nameOf<ExpressionVariant>({thumb: 0, small: 0, large: 0});

/**
 * 크기 표(ADR-0218 D1)의 한 변(pt). `inline` 은 글자 높이라 여기 없다(본문 글자 크기 × 글자 배율).
 * `tile` 은 표현 시트의 이모티콘·GIF 탭이 쓰는 큰 칸이다(#4942) — `grid` 와 같은 정지 그림(thumb)이고 크기만 다르다.
 */
export const EXPRESSION_POINTS: Partial<Record<PhoneExpressionSize, number>> = {
  reaction: 20,
  medium: 48,
  large: 160,
  grid: 32,
  tile: 64,
};

/** 움직이는 그림은 GIF 를 총 이만큼 돌고 정지한다(ADR-0218 D1: 총 4회 뒤 정지, 탭으로 다시). */
export const EXPRESSION_REPEATS = 4;

/**
 * 이 크기의 움직이는 그림은 4번 돌고 멈추지 않고 계속 도는가: **반응 칩만** 그렇다(owner 2026-11-07, ADR-0218 증보 §13). 크기 이름은 표의 키에서 꺼낸다(위 머리말: 글자 낱말을 새로 쓰지 않는다).
 * 동작 줄이기·화면 밖·앱이 뒤에 있는 동안은 이 크기도 정지 thumb 이다(`expressionVariantFor` 의 `animate`).
 */
export const keepsMoving = (size: PhoneExpressionSize): boolean => size === SIZE.reaction;

export interface ExpressionBox {
  width: number;
  height: number;
}

/**
 * 이 크기로 서는 칸. 비율은 `media.large` 로 못 박는다 — 어느 변형을 지금 그리든, 받는 중이든 칸은 같다.
 * 값이 어긋난(0·유한하지 않은) 그림은 정사각으로 둔다(칸이 0 으로 접히지 않게).
 */
export function expressionBoxOf(
  size: PhoneExpressionSize,
  media: Pick<ExpressionMedia, 'large'>,
  bodyPoints: number,
): ExpressionBox {
  // `inline` 은 표에 없다 — 글자 높이(본문 글자 크기 × 글자 배율)다.
  const points = EXPRESSION_POINTS[size] ?? bodyPoints;
  const {width, height} = media.large;
  const ratio =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width / height
      : 1;
  return {
    width: points * Math.min(1, ratio),
    height: points / Math.max(1, ratio),
  };
}

/** 움직이는 그림인가 — 큰 그림이 GIF 이고 장면이 둘 이상이다(정지 그림은 PNG 로 다시 인코딩된다, ADR-0218 D3). */
export function isAnimatedMedia(media: Pick<ExpressionMedia, 'large'>): boolean {
  return media.large.mime === 'image/gif' && media.large.frameCount > 1;
}

/**
 * 지금 그릴 변형.
 *  · 고르개의 칸(`still`)은 늘 thumb.
 *  · 움직이는 그림: 보이는 동안(`animate`)만 움직이는 변형(large 크기는 large, 나머지는 small) — 화면 밖·동작 줄이기·4번 돈 뒤에는 정지 thumb.
 *  · 정지 그림: 한 번 화면에 보인 뒤(`seen`)에는 선명한 변형(large 크기는 large, 나머지는 small)이다. 정지 그림은 움직임이 없어서
 *    화면 밖으로 나가도 thumb 로 되돌리지 않는다(되돌리면 같은 그림을 두 번 받고 깜빡일 뿐이다).
 */
export function expressionVariantFor(input: {
  size: PhoneExpressionSize;
  still: boolean;
  animated: boolean;
  animate: boolean;
  seen: boolean;
}): ExpressionVariant {
  if (input.still) return VARIANT.thumb;
  const sharp = input.size === SIZE.large ? VARIANT.large : VARIANT.small;
  if (input.animated) return input.animate ? sharp : VARIANT.thumb;
  return input.seen ? sharp : VARIANT.thumb;
}
