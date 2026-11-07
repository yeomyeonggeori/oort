import type {ExpressionSection} from '@momo/core/features/expressions/gridSections';
import type {Expression} from '@momo/core/features/expressions/types';

// =============================================================================
// 키보드 자리 창(이모티콘·GIF 탭)의 격자 산수 (#5452). 순수 모듈이다: 구역을 줄로 풀어 놓고, 구역마다 위쪽 위치와 높이를 정하고, 스크롤 위치가 어느 구역인지 답한다.
//
// 구역 목록(`buildExpressionSections`)은 코어가 웹과 같은 함수로 만든다. 폰이 더하는 것은 **높이가 글자 크기에 안 흔들리는 줄**이다: 구역 이름줄과 칸 줄을 고정 높이로 두어
// (이름줄은 글자 배율 상한이 있다) 세트 띠가 구역으로 건너뛰는 위치를 그리기 전에 산수로 안다. 측정(`onLayout`)에 기대면 화면 밖 구역의 위치를 모른다.
// =============================================================================

/** 구역 이름줄의 높이(pt). 글자는 한 줄이고 배율 상한이 있어 이 높이를 넘지 않는다. */
export const PANEL_HEADER_HEIGHT = 32;
/** 칸 한 줄의 높이(pt): 정지 그림 64 + 칸 위아래 여백. */
export const PANEL_ROW_HEIGHT = 72;
/** 칸 한 줄에 서는 최소 칸 수. */
export const PANEL_MIN_COLUMNS = 3;

export interface PanelSectionLayout {
  section: ExpressionSection;
  /** 칸 줄(`columns` 개씩). */
  rows: Expression[][];
  /** 이 구역의 위쪽(목록 안, pt). */
  top: number;
  height: number;
}

/** 한 줄에 서는 칸 수: 글자가 커지면 칸이 넓어지니 줄어든다. */
export function panelColumns(width: number, gutter: number, fontScale: number, cell: number): number {
  const room = width - gutter * 2;
  return Math.max(PANEL_MIN_COLUMNS, Math.floor(room / (cell * Math.max(1, fontScale))));
}

export function layoutPanelSections(
  sections: readonly ExpressionSection[],
  columns: number,
): {layouts: PanelSectionLayout[]; total: number} {
  const layouts: PanelSectionLayout[] = [];
  let top = 0;
  for (const section of sections) {
    const rows: Expression[][] = [];
    for (let at = 0; at < section.items.length; at += columns) rows.push(section.items.slice(at, at + columns));
    const height = PANEL_HEADER_HEIGHT + rows.length * PANEL_ROW_HEIGHT;
    layouts.push({section, rows, top, height});
    top += height;
  }
  return {layouts, total: top};
}

/**
 * 스크롤 위치가 가리키는 구역의 열쇠. 구역의 위쪽이 스크롤 위치를 지났으면 그 구역이고, 맨 아래까지 내려왔으면 마지막 구역이다
 * (짧은 마지막 구역은 위쪽에 닿을 수 없다 - 세트 띠의 표시가 그 구역에서 멈추게 한다).
 */
export function sectionAtOffset(
  layouts: readonly Pick<PanelSectionLayout, 'section' | 'top'>[],
  offset: number,
  viewport: number,
  content: number,
): string | null {
  if (layouts.length === 0) return null;
  if (viewport > 0 && content > viewport && offset + viewport >= content - 1) return layouts[layouts.length - 1].section.id;
  let current = layouts[0].section.id;
  for (const layout of layouts) {
    if (layout.top <= offset + 1) current = layout.section.id;
    else break;
  }
  return current;
}

/** 세트 띠의 단추 하나가 가리키는 구역의 위쪽. 모르는 열쇠면 null. */
export function offsetOfSection(layouts: readonly Pick<PanelSectionLayout, 'section' | 'top'>[], id: string): number | null {
  return layouts.find(layout => layout.section.id === id)?.top ?? null;
}
