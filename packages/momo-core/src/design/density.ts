// =============================================================================
// 밀도 두 단계 — 값 정의만 (ADR-0189 D4, 표 §5).
//
// `comfortable`(기본)과 `compact`. ADR-0174 D2와 ADR-0179 D7의 3단
// (compact/comfy/spacious)을 대체한다. 화면 적용은 DS2-8(#2720)이 한다.
//
// 밀도가 바꾸지 않는 것: 터치 타깃 하한 44pt, 탭바·FAB 기하, 타입 스케일.
// =============================================================================

export const DENSITY_IDS = ["comfortable", "compact"] as const;
export type DensityId = (typeof DENSITY_IDS)[number];

export const DEFAULT_DENSITY_ID: DensityId = DENSITY_IDS[0];

/** 터치 타깃 하한(디자인 시스템 §2.7). 밀도가 이 밑으로 내리지 않는다. */
export const DENSITY_TOUCH_FLOOR = 44;

/**
 * 저장된 값을 읽는다. 옛 이름은 방어적으로 옮긴다: `comfy`·`spacious` →
 * `comfortable`, `compact` → `compact`. 모르는 값은 기본값이다.
 */
export function normalizeDensity(raw: unknown): DensityId {
  if (raw === "compact") return "compact";
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
  /** 메시지 사이 간격. */
  messageGap: number;
  /** 메시지 아바타 한 변. */
  messageAvatar: number;
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
    messageGap: 16,
    messageAvatar: 36,
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
    messageAvatar: 28,
    phoneCardRadius: 14,
    phoneRowRadius: 10,
    webCardRadius: 18,
    webRowRadius: 10,
  },
};
