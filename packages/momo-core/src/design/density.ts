// =============================================================================
// 밀도 세 단계 — 값 정의 (ADR-0189 증보 1 D1, 증보 3 D8, 표 §5).
//
// `compact`(촘촘하게)·`comfortable`(편하게, 기본)·`spacious`(여유롭게). 본문 D4의 두 단계를
// 증보 1 D1이 세 단계로 되돌렸다. 화면 적용은 AP-2a(#4189, DS2-8 #2720 흡수)가 한다.
//
// 밀도가 바꾸지 않는 것: 터치 타깃 하한 44pt, 탭바·FAB 기하, 타입 스케일(글자 크기는 다른
// 축이다 — `appearance.ts`의 `fontSize`). `spacious`는 반경과 카드 안 여백을 바꾸지 않는다
// (증보 1 D1). 반경을 한 단 내리는 규칙은 `compact`에만 남는다.
//
// ## 이 표가 읽히는 곳
//
// | 필드 | 읽는 쪽 |
// |---|---|
// | `messageGap`·`messageGroupGap`·`messageAvatar`·`proseGap`·`listItemGap` | 웹 대화 표면. `clients/web/src/design/appearance/density.css`가 이 표를 CSS 변수로 옮기고, `densityTokens.test.ts`가 둘을 한 칸씩 대조한다 |
// | 나머지(`phoneListRow`·`phoneSectionHeader`·`desktopSidebarRow`·`cardPadding`·반경 넷) | 아직 읽는 표면이 없다(폰·사이드바는 이 슬라이스의 범위 밖). 값은 설계값이다 |
//
// 대화 표면의 수치는 「제안값」이 아니라 **지금 화면이 그리는 값**에서 읽었다(AP-2a): 행 사이
// 12·묶음 사이 18은 `ROW_SPACE`, 아바타 32는 `AVATAR_SIZE`, 마크다운 블록 사이 8은
// `MessageBody`의 `gap-2`였다. 그래서 `comfortable`은 이 변경 전과 **픽셀이 같다**.
// 위아래 단계는 같은 비율로 한 단씩 벌렸다.
//
// 수치의 개념 출처: Buzz desktop `src/shared/styles/globals/typography.css:34-66`
// (Apache-2.0, Copyright 2026 Block, Inc., 커밋 af5bb0a)의 「밀도 세 단계가 간격 변수만
// 바꾼다」는 구조와 문단 6/8/10 간격. 코드는 복사하지 않았다.
// =============================================================================

/** 첫 값이 기본이다(`DEFAULT_DENSITY_ID`). 화면에 보이는 순서는 `DENSITY_DISPLAY_ORDER`다. */
export const DENSITY_IDS = ["comfortable", "compact", "spacious"] as const;
export type DensityId = (typeof DENSITY_IDS)[number];

export const DEFAULT_DENSITY_ID: DensityId = DENSITY_IDS[0];

/** 컨트롤에 놓는 순서: 촘촘 → 기본 → 여유. 저장 목록의 순서와 다르다(기본이 맨 앞). */
export const DENSITY_DISPLAY_ORDER = ["compact", "comfortable", "spacious"] as const satisfies readonly DensityId[];

/** 터치 타깃 하한(디자인 시스템 §2.7). 밀도가 이 밑으로 내리지 않는다. */
export const DENSITY_TOUCH_FLOOR = 44;

/**
 * 저장된 값을 읽는다. 세 이름만 유효하다. 옛 이름 `comfy`(ADR-0179 D7의 3단 명칭)는
 * `comfortable`로 읽고, 모르는 값도 기본값이다(증보 1 D1).
 */
export function normalizeDensity(raw: unknown): DensityId {
  if (raw === "compact" || raw === "spacious") return raw;
  return "comfortable";
}

export interface DensityValues {
  /** 폰 목록 행 높이. */
  phoneListRow: number;
  /** 폰 섹션 머리 높이. */
  phoneSectionHeader: number;
  /** 데스크탑 사이드바 행 높이. */
  desktopSidebarRow: number;
  /** 카드 안 여백. */
  cardPadding: number;
  /** 같은 사람이 연달아 쓴 두 행 **사이에 남는 거리**(웹: 위 행 아래 패딩 + 아래 행 위 패딩). */
  messageGap: number;
  /** 사람이 바뀌는 자리(묶음 머리 행)의 위 행과의 거리. 묶음 안 거리보다 크다. */
  messageGroupGap: number;
  /** 메시지 아바타 한 변. */
  messageAvatar: number;
  /** 마크다운 블록(문단·목록·코드) 사이 간격. */
  proseGap: number;
  /** 목록 항목 사이 간격. */
  listItemGap: number;
  /** 폰 카드 반경 / 행 선택 반경. */
  phoneCardRadius: number;
  phoneRowRadius: number;
  /** 웹 카드 반경 / 행 반경. */
  webCardRadius: number;
  webRowRadius: number;
}

export const DENSITY: Readonly<Record<DensityId, DensityValues>> = {
  comfortable: {
    phoneListRow: 46,
    phoneSectionHeader: 44,
    desktopSidebarRow: 34,
    cardPadding: 14,
    messageGap: 12,
    messageGroupGap: 18,
    messageAvatar: 32,
    proseGap: 8,
    // 본문 줄 높이(`leading-relaxed`)가 항목 사이를 이미 열어 둬서 현행 간격이 0이다.
    // 촘촘하게도 0이고, 여유롭게만 연다.
    listItemGap: 0,
    phoneCardRadius: 20,
    phoneRowRadius: 14,
    webCardRadius: 20,
    webRowRadius: 14,
  },
  compact: {
    phoneListRow: 44,
    phoneSectionHeader: 36,
    desktopSidebarRow: 28,
    cardPadding: 10,
    messageGap: 8,
    messageGroupGap: 12,
    messageAvatar: 28,
    proseGap: 6,
    listItemGap: 0,
    phoneCardRadius: 14,
    phoneRowRadius: 10,
    webCardRadius: 18,
    webRowRadius: 10,
  },
  spacious: {
    phoneListRow: 52,
    phoneSectionHeader: 52,
    desktopSidebarRow: 40,
    cardPadding: 14,
    messageGap: 16,
    messageGroupGap: 24,
    messageAvatar: 36,
    proseGap: 10,
    listItemGap: 4,
    phoneCardRadius: 20,
    phoneRowRadius: 14,
    webCardRadius: 20,
    webRowRadius: 14,
  },
};
