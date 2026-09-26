// =============================================================================
// 터미널 도크의 높이 (#2774, ADR-0190 D5, 제안서 §3.4 「도크 크기」).
//
// 도크 높이는 이 기기에 둔다(ADR-0174 「외양=이 기기」). 값은 픽셀이 아니라
// 본문 판 높이에 대한 비율이다. 창 크기가 바뀌어도 같은 몫을 차지한다.
//
// 경계를 끌면 비율이 바뀌고, 경계를 더블클릭하면 두 단계(기본·크게)를 오간다.
// 어느 경우든 도크가 너무 낮아 터미널 줄이 안 보이거나, 너무 높아 위 화면이
// 사라지지 않게 픽셀 바닥으로 자른다.
//
// `layoutStore.ts`와 같은 모양이다. 저장소는 만지지 않고, 원문을 읽고 쓸
// 문자열을 만든다. 모르는 값은 `null`로 읽고 호스트는 기본값을 쓴다.
// =============================================================================

import { minimumSize, type LayoutNode } from "./layoutTree";

/** 저장소 항목 이름. 접미사가 `_KEY`가 아닌 이유는 layoutStore.ts와 같다. */
export const DOCK_ENTRY = "momo.web.workbench.dock.v1";

/** 두 단계. 더블클릭이 이 둘을 오간다. */
export const DOCK_RATIO_LOW = 0.4;
export const DOCK_RATIO_HIGH = 0.72;
export const DOCK_DEFAULT_RATIO = DOCK_RATIO_LOW;

/** 도크 본문 바닥. 머리 줄 + 터미널 몇 줄이 보이는 높이. */
export const DOCK_MIN_PX = 160;
/** 도크 위에 남기는 화면 바닥. 채널 머리와 컴포저 한 줄이 보이는 높이. */
export const DOCK_ROUTE_FLOOR_PX = 160;

/**
 * 도크에서 칸 영역이 아닌 부분의 높이: 위 경계 8 + 머리 32 + 격자 틈 8 + 격자
 * 상태 줄 28 + 아래 여백 4 = 80, 여유 8. 웹 토큰(`--spacing-control*`)과 같은 값이다.
 */
export const DOCK_CHROME_PX = 88;

/**
 * 이 배치의 칸이 모두 최소 크기를 지키려면 도크가 가져야 하는 높이
 * (`minimumSize`: 세로 분할은 합, 가로 분할은 최대, 틈 포함) + 머리. 호스트가
 * 도크의 최소 높이로 건다. 판이 이만큼 되지 않으면 채널 바닥(DOCK_ROUTE_FLOOR_PX)이
 * 이기고, 격자는 포커스 칸 하나만 보인다(`fitLayoutToSize`의 cramped).
 */
export function dockMinPx(root: LayoutNode): number {
  return Math.max(DOCK_MIN_PX, minimumSize(root).height + DOCK_CHROME_PX);
}

export interface DockPrefs {
  v: 1;
  ratio: number;
}

export function defaultDockPrefs(): DockPrefs {
  return { v: 1, ratio: DOCK_DEFAULT_RATIO };
}

/**
 * 비율을 판 높이에 맞춰 자른다. 판이 두 바닥의 합보다 낮으면 도크 바닥이
 * 이긴다(터미널이 한 줄도 안 보이는 도크는 도크가 아니다). 높이를 모르면
 * (0 이하) 비율의 뜻 범위(0, 1)로만 자른다.
 */
export function clampDockRatio(ratio: number, containerPx: number): number {
  const safe = Number.isFinite(ratio) ? ratio : DOCK_DEFAULT_RATIO;
  if (!(containerPx > 0)) return Math.min(0.95, Math.max(0.05, safe));
  const min = Math.min(1, DOCK_MIN_PX / containerPx);
  const max = Math.max(min, 1 - DOCK_ROUTE_FLOOR_PX / containerPx);
  return Math.min(max, Math.max(min, safe));
}

/**
 * 더블클릭 두 단계. 지금 높이가 두 단계의 가운데보다 낮으면 크게, 아니면
 * 기본으로 간다. 끌어서 어중간한 높이에 두었어도 한 번에 어느 한쪽에 선다.
 */
export function toggleDockRatio(ratio: number, containerPx: number): number {
  const mid = (DOCK_RATIO_LOW + DOCK_RATIO_HIGH) / 2;
  const next = ratio < mid ? DOCK_RATIO_HIGH : DOCK_RATIO_LOW;
  return clampDockRatio(next, containerPx);
}

/** 끌기: 판 위에서 포인터의 세로 위치로 비율을 만든다. 도크는 판 바닥에 붙는다. */
export function dockRatioFromPointer(pointerY: number, containerTop: number, containerPx: number): number {
  if (!(containerPx > 0)) return DOCK_DEFAULT_RATIO;
  const fromBottom = containerTop + containerPx - pointerY;
  return clampDockRatio(fromBottom / containerPx, containerPx);
}

export function serializeDockPrefs(prefs: DockPrefs): string {
  return JSON.stringify(prefs);
}

export function parseDockPrefs(raw: string | null | undefined): DockPrefs | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const ratio = record.ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
  return { v: 1, ratio };
}
