import {TOUCH_TARGET} from '../../design/tokens';

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
//   | 모서리        | ≈32(눈대중)                     | 34, 연속 곡선 — 메뉴 카드와 같은 값        |
//   | 열 · 틈       | 3열 · 사이 1pt 안팎             | 3 · 1                                  |
//   | 정렬          | 최신 사진이 위                  | 최신순(`creationTime` 내림차순)        |
//   | 뒤로 원       | ≈45, 왼쪽 아래, 가장자리에서 ≈12 | 44(`TOUCH_TARGET`) · 12                |
//   | 알약          | 오른쪽 아래, 진한 유리, 높이 ≈45 | 44 · 12 · 잉크 채움                    |
//
// ## 모서리는 메뉴 카드와 같은 값이다 (34, 연속 곡선)
//
// 이슈는 Buzz 카드 모서리를 「~32pt」로 적었다. 같은 눈대중으로 적은 메뉴의 「~27pt」는 #4180 이 캡처의
// 모서리 프로필을 iOS 연속 곡선과 최소제곱으로 맞춰 **34** 로 바로잡았다(`AttachMenu` 머리 「모서리」). 카드를
// 따로 32·30 으로 두면 변신 동안 모서리가 두 값 사이를 오가고 사다리에 없는 값이 하나 더 는다. 그래서 같은
// 값 하나를 쓴다 — 메뉴 카드와 이 카드가 한 모양의 두 크기다. `photoCardDesign.test.ts` 가 두 값이 같음을 잰다.
// 뒤로 원·알약 높이 45 → 44 는 터치 최소 `TOUCH_TARGET` 이 이미 그 값이다(실측 45 는 반올림 오차 안이고, 두
// 이름을 따로 두면 터치 최소를 조정하는 날 하나만 움직인다).
// =============================================================================

export const PHOTO_CARD = {
  /** 카드 좌우 여백. Buzz ≈10. */
  inset: 10,
  /**
   * 카드 폭 상한. 폰에서는 `창 폭 − 2×inset`(Buzz 382)이 상한에 안 걸린다. iPad 가로(1024)에서 상한이 없으면
   * 셀이 334pt 정사각형이 돼 한 줄만 보이는 거대한 카드가 된다 — 큰 폰(Pro Max 440)보다 조금 넓은 값에서 멈춘다.
   */
  maxWidth: 480,
  /** 카드 높이 = 화면 높이의 비율. Buzz 372 / 874 ≈ 0.426. */
  heightRatio: 0.43,
  /** 작은 화면(iPhone SE 667pt → 287)에서도 3행이 서도록 하한을 둔다. */
  minHeight: 300,
  /** 큰 화면·가로 모드에서 카드가 화면을 먹지 않도록 상한을 둔다. */
  maxHeight: 460,
  /**
   * 카드가 글자 배율을 따라 자라는 상한 배수. 본문·설명 글자는 배율 상한이 없어서(읽는 글자는 끝까지 자란다,
   * `atoms.tsx`) 고정 높이 카드에는 AX5 의 제목·설명이 들지 않았다. 카드가 `min(글자 배율, 이 값)` 만큼 자라
   * 같은 문장이 더 많이 보이게 하고, 그 위는 스크롤한다(`maxHeight` 가 마지막 상한). 1.6 은 컨트롤의 글자
   * 상한(`BAR_CONTROL_MAX_SCALE`)과 같은 값이다 — 카드가 컨트롤보다 더 크게 자랄 이유가 없다.
   */
  textGrowthMax: 1.6,
  /** 카드 모서리(연속 곡선). 메뉴 카드(`ATTACH_MENU.radius`)와 같다 — 위 「모서리는 메뉴 카드와 같은 값이다」. */
  radius: 34,
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
  /**
   * 메뉴 층이 줄어들며 사라지는 진행 구간 [시작, 끝]. **몸통이 다 선 뒤에** 시작한다 — 메뉴가 줄기
   * 시작하는 순간에는 이미 틀 안이 막혀 있어서 비치는 곳이 없다. 메뉴 층은 사진 층 위에 선다(그리는 순서).
   *
   * 메뉴가 **먼저 걷히고 사진이 이어 선다**(페이드 스루): 두 층이 겹치는 구간이 짧아서 메뉴 글자가 사진·
   * 설명 글자 위에 유령처럼 겹쳐 뭉개지지 않는다(design-review M2). 그 사이의 틈은 몸통이 메운다.
   */
  menuFade: [0.12, 0.5],
  /** 사진 층이 나타나는 진행 구간 [시작, 끝]. 메뉴 층이 걷히는 끝(0.5) 직전에 시작해 겹침이 짧다. */
  cardFade: [0.35, 0.75],
  /**
   * 틀의 몸통(카드 면 색)이 올라오는 진행 구간 [시작, 끝]. 틀이 메뉴 발자국을 벗어나 자라는 순간부터
   * 발자국 밖 띠(ㄴ자)가 층의 불투명도와 무관하게 막혀야 뒤 대화가 비치지 않는다(design-review H1).
   * 0 에서는 몸통이 없다 — 진행 0 의 틀은 메뉴와 같아야 하므로 메뉴의 유리를 덮지 않는다. 메뉴가 줄기
   * 시작하는 진행(`menuFade[0]`) 전에 다 서야 한다 — 시험이 잰다.
   */
  bodyFade: [0, 0.12],
  /** 메뉴 내용이 줄어드는 끝 배율(카드의 왼쪽 위 칸으로 접혀 들어간다 — Buzz 중간 프레임). */
  menuEndScale: 0.55,
  /** 사진 층이 자라 들어오는 시작 배율. */
  cardStartScale: 0.94,
} as const;

export interface PhotoCardSize {
  width: number;
  height: number;
}

/**
 * 이 화면에서 카드가 서는 크기. `fontScale`(`useWindowDimensions().fontScale`)이 1 보다 크면 높이가 그만큼
 * 자란다(`textGrowthMax` 까지, `maxHeight` 로 막힌다). 줄이지는 않는다.
 */
export function photoCardSize(viewport: PhotoCardSize & {fontScale?: number}): PhotoCardSize {
  const grow = Math.min(Math.max(viewport.fontScale ?? 1, 1), PHOTO_CARD.textGrowthMax);
  const height = Math.round(viewport.height * PHOTO_CARD.heightRatio * grow);
  return {
    width: Math.min(PHOTO_CARD.maxWidth, viewport.width - 2 * PHOTO_CARD.inset),
    height: Math.min(PHOTO_CARD.maxHeight, Math.max(PHOTO_CARD.minHeight, height)),
  };
}

/**
 * 스크롤 면이 넘쳐서 사람에게 「더 있다」를 알려야 하는가. 안 알리면 넘친 면은 다음 문장·행동이 첫 화면 밖에
 * 있다는 사실을 아무도 모른다. (RN iOS 스크롤 표시는 스크롤을 시작해야 보이므로 `flashScrollIndicators` 로 한 번
 * 보인다.)
 */
export function scrollNeedsHint(contentHeight: number, layoutHeight: number): boolean {
  return layoutHeight > 0 && contentHeight > layoutHeight + 1;
}

/** 카드 폭에서 셀 한 변. 열 사이 틈을 뺀 나머지를 균등 분할한다(소수점은 RN 이 픽셀에 맞춘다). */
export function photoCellSize(cardWidth: number): number {
  const {columns, cellGap} = PHOTO_CARD;
  return (cardWidth - cellGap * (columns - 1)) / columns;
}
