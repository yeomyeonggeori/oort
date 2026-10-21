import {ds2Radius, TOUCH_TARGET} from '../../design/tokens';

// =============================================================================
// 사진 카드의 치수 — Buzz 실측(IMG_4321, @3x → pt, 402pt 폭) 그대로 (#4181).
//
// 값마다 실측을 옆에 적는다. 스타일시트에 숫자를 흩으면 `designSystem.test.ts` 의 스윕이
// 「격자 밖 리터럴」로 세고, 다음 사람이 「이 12 는 어디서 왔나」를 한 자리에서 읽지
// 못한다 (`convDesign.ts` 와 같은 이유). 이 파일의 값은 이름으로만 스타일에 들어간다.
//
// ## 사양 표
//
//   | 항목          | Buzz 실측                       | 이 파일                                |
//   |---------------|---------------------------------|----------------------------------------|
//   | 좌우 여백     | ≈10                             | 10                                     |
//   | 높이          | ≈372 (화면 874 의 ≈43%)         | 화면 높이 × 0.43 (300~460 로 묶음)     |
//   | 모서리        | ≈32                             | 30 (`ds2Radius.sheet`, 사다리의 한 칸) |
//   | 열 · 틈       | 3열 · 사이 1pt 안팎             | 3 · 1                                  |
//   | 정렬          | 최신 사진이 위                  | 최신순(`creationTime` 내림차순)        |
//   | 뒤로 원       | ≈45, 왼쪽 아래, 가장자리에서 ≈12 | 44(`TOUCH_TARGET`) · 12                |
//   | 알약          | 오른쪽 아래, 진한 유리, 높이 ≈45 | 44 · 12 · 잉크 채움                    |
//
// ## 사다리 밖 값을 쓰지 않은 두 자리
//
// - **모서리 32 → 30.** 폰 반경 사다리는 `10·14·20·26·30·pill` 이다(ADR-0189 D6). 32 는
//   사다리에 없고, 사다리에 값을 더하는 것은 `docs/design-system/README.md` §6 의
//   결정 절차다. 실측과의 차이는 2pt 라서(카드 폭의 0.5%) 가장 가까운 칸 `sheet`
//   (페이지 시트 위 모서리)를 쓴다. 사다리가 32 를 얻는 날 이 줄 하나를 고친다.
// - **뒤로 원·알약 높이 45 → 44.** 터치 최소 `TOUCH_TARGET` 이 이미 그 값이다. 실측
//   45 는 반올림 오차 안이고, 두 이름을 따로 두면 터치 최소를 조정하는 날 하나만 움직인다.
// =============================================================================

export const PHOTO_CARD = {
  /** 카드 좌우 여백. Buzz ≈10. */
  inset: 10,
  /** 카드 높이 = 화면 높이의 비율. Buzz 372 / 874 ≈ 0.426. */
  heightRatio: 0.43,
  /** 작은 화면(iPhone SE 667pt → 287)에서도 3행이 서도록 하한을 둔다. */
  minHeight: 300,
  /** 큰 화면·가로 모드에서 카드가 화면을 먹지 않도록 상한을 둔다. */
  maxHeight: 460,
  /** 카드 모서리. Buzz ≈32 → 사다리 30. */
  radius: ds2Radius.sheet,
  /** 열 수. Buzz 3열. */
  columns: 3,
  /** 사진 사이 틈. Buzz 1pt 안팎. (이름이 `gap` 이 아닌 것은 간격 스윕이 키 이름을 속성으로 읽기 때문이다.) */
  cellGap: 1,
  /** 떠 있는 뒤로 원·알약이 카드 가장자리에서 떨어진 거리. Buzz ≈12. */
  controlInset: 12,
  /** 뒤로 원의 지름·알약의 높이. Buzz ≈45 → 터치 최소와 같은 값. */
  control: TOUCH_TARGET,
  /** 알약 안 좌우 여백. 「N장 첨부」가 한 줄로 서는 최소(`control` 의 절반 + 글자 틈). */
  pillPadX: 20,
  /** 선택 표식(순번 원)의 지름. 터치 대상이 아니라 표시라서 44 가 아니다 — 셀 전체가 대상이다. */
  badge: 24,
  /** 선택 표식이 사진 모서리에서 떨어진 거리. */
  badgeInset: 6,
  /** 선택된 사진의 테두리 두께. */
  ringWidth: 3,
  /** 한 번에 불러오는 사진 수 (`getAssetsAsync` 의 `first`). 3열 × 20행. */
  pageSize: 60,
} as const;

/**
 * 메뉴 → 카드 변신의 값 (#4181 D3).
 *
 * 스프링은 「겉보기 250~350ms, 넘침 거의 없음」(이슈 Goal 3)이 목표다. 질량 1 · 강성
 * 300 · 감쇠 32 의 감쇠비는 ζ = 32 / (2·√300) ≈ 0.92 — 넘침은 0.1% 아래라 눈에 안
 * 보이고, 정착(2% 이내)은 4 / (ζ·ω) ≈ 4 / (0.92 × 17.3) ≈ 0.25s 다.
 */
export const PHOTO_MORPH = {
  spring: {stiffness: 300, damping: 32, mass: 1},
  /** 「동작 줄이기」에서 두 층이 바뀌는 시간. 모션 사다리의 `instant`(120ms)보다 한 칸 위가 아니라 같은 칸이다. */
  fadeMs: 120,
  /** 메뉴 층이 사라지는 진행 구간 [시작, 끝]. */
  menuFade: [0, 0.5],
  /** 사진 층이 나타나는 진행 구간 [시작, 끝]. 메뉴가 거의 사라진 뒤에 켜져 두 층이 겹쳐 비치는 시간이 짧다. */
  cardFade: [0.35, 0.9],
  /** 메뉴 내용이 줄어드는 끝 배율(카드의 왼쪽 위 칸으로 접혀 들어간다 — Buzz 중간 프레임). */
  menuEndScale: 0.55,
  /** 사진 층이 자라 들어오는 시작 배율. */
  cardStartScale: 0.94,
} as const;

export interface PhotoCardSize {
  width: number;
  height: number;
}

/** 이 화면에서 카드가 서는 크기. */
export function photoCardSize(viewport: PhotoCardSize): PhotoCardSize {
  const height = Math.round(viewport.height * PHOTO_CARD.heightRatio);
  return {
    width: viewport.width - 2 * PHOTO_CARD.inset,
    height: Math.min(PHOTO_CARD.maxHeight, Math.max(PHOTO_CARD.minHeight, height)),
  };
}

/** 카드 폭에서 셀 한 변. 열 사이 틈을 뺀 나머지를 균등 분할한다(소수점은 RN 이 픽셀에 맞춘다). */
export function photoCellSize(cardWidth: number): number {
  const {columns, cellGap} = PHOTO_CARD;
  return (cardWidth - cellGap * (columns - 1)) / columns;
}
