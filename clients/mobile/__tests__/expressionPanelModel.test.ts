import type {ExpressionSection} from '@momo/core/features/expressions/gridSections';
import type {Expression} from '@momo/core/features/expressions/types';
import {
  layoutPanelSections,
  offsetOfSection,
  PANEL_HEADER_HEIGHT,
  PANEL_MIN_COLUMNS,
  PANEL_ROW_HEIGHT,
  panelColumns,
  sectionAtOffset,
} from '../src/features/expressions/panelModel';

// =============================================================================
// 키보드 자리 창의 격자 산수 (#5452) — 순수 함수. 세트 띠가 구역으로 건너뛰는 위치와 「지금 구역」은 그리기 전에 산수로 안다.
// =============================================================================

const items = (count: number, prefix: string) =>
  Array.from({length: count}, (_, index) => ({id: `${prefix}${index}`}) as Expression);
const section = (id: string, count: number): ExpressionSection => ({
  id,
  kind: 'set',
  label: id,
  items: items(count, id),
});

describe('panelColumns — 한 줄의 칸 수는 글자 배율만큼 줄고 세 칸 아래로는 안 내려간다', () => {
  it('폭 402·배율 1 이면 5칸, 배율 2 면 줄어 세 칸이 바닥이다', () => {
    expect(panelColumns(402, 16, 1, 72)).toBe(5);
    expect(panelColumns(402, 16, 2, 72)).toBe(PANEL_MIN_COLUMNS);
    expect(panelColumns(320, 16, 1, 72)).toBe(4);
  });
  it('배율 1 미만은 1 로 읽는다(작은 글자가 칸을 늘리지 않는다)', () => {
    expect(panelColumns(402, 16, 0.5, 72)).toBe(5);
  });
});

describe('layoutPanelSections — 구역마다 이름줄 + 칸 줄의 고정 높이', () => {
  it('구역의 위쪽은 앞 구역들의 높이 합이고 전체 높이가 그 합이다', () => {
    const {layouts, total} = layoutPanelSections([section('a', 6), section('b', 3), section('c', 10)], 5);
    expect(layouts.map(layout => layout.rows.map(row => row.length))).toEqual([[5, 1], [3], [5, 5]]);
    const heights = [
      PANEL_HEADER_HEIGHT + 2 * PANEL_ROW_HEIGHT,
      PANEL_HEADER_HEIGHT + PANEL_ROW_HEIGHT,
      PANEL_HEADER_HEIGHT + 2 * PANEL_ROW_HEIGHT,
    ];
    expect(layouts.map(layout => layout.height)).toEqual(heights);
    expect(layouts.map(layout => layout.top)).toEqual([0, heights[0], heights[0] + heights[1]]);
    expect(total).toBe(heights[0] + heights[1] + heights[2]);
  });
  it('구역이 없으면 비어 있고 높이 0 이다', () => {
    expect(layoutPanelSections([], 5)).toEqual({layouts: [], total: 0});
  });
  it('모든 그림이 한 줄 안에 한 번씩 선다(줄이 칸을 잃지 않는다)', () => {
    const {layouts} = layoutPanelSections([section('a', 11)], 4);
    expect(layouts[0].rows.flat().map(item => item.id)).toEqual(section('a', 11).items.map(item => item.id));
  });
});

describe('sectionAtOffset · offsetOfSection — 띠의 표시와 건너뛰기', () => {
  const {layouts, total} = layoutPanelSections([section('a', 6), section('b', 3), section('c', 2)], 5);
  const [a, b, c] = layouts;

  it('스크롤 위치가 구역의 위쪽을 지나면 그 구역이다', () => {
    expect(sectionAtOffset(layouts, 0, 200, total)).toBe('a');
    expect(sectionAtOffset(layouts, b.top - 2, 200, total)).toBe('a');
    expect(sectionAtOffset(layouts, b.top, 200, total)).toBe('b');
    expect(sectionAtOffset(layouts, c.top, 200, total)).toBe('c');
  });
  it('맨 아래까지 내려오면 마지막 구역이다 - 짧은 마지막 구역은 위쪽에 닿을 수 없다', () => {
    // 마지막 구역(c)의 위쪽에는 닿지 못해도(내용 끝에서 멈춘다) 맨 아래에서는 c 가 표시된다.
    const bottom = total - 200;
    expect(bottom).toBeLessThan(c.top);
    expect(sectionAtOffset(layouts, bottom, 200, total)).toBe('c');
    // 내용이 창보다 짧으면 이 규칙은 없다(스크롤이 없다).
    expect(sectionAtOffset(layouts, 0, total + 10, total)).toBe('a');
  });
  it('구역이 없으면 null, 건너뛰기는 구역의 위쪽을 돌려주고 모르는 열쇠는 null 이다', () => {
    expect(sectionAtOffset([], 0, 200, 0)).toBeNull();
    expect(offsetOfSection(layouts, 'a')).toBe(a.top);
    expect(offsetOfSection(layouts, 'c')).toBe(c.top);
    expect(offsetOfSection(layouts, 'zzz')).toBeNull();
  });
});
