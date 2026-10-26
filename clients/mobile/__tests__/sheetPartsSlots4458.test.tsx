import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet, Text} from 'react-native';

import {ListRow} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';

// =============================================================================
// `ListRow` 의 세 슬롯 — 오른쪽 임의 노드(`trailing`) · 역할(`accessibilityRole`) · 펼침(`expanded`) (#4458 2단계).
//
// 1단계가 부품에 자리가 없어 접거나 잃었던 표시(AI 시트의 칩, PR 이동 행의 link, 작업 맡기기 펼침 행의 상태)를 되살리는
// 부품 쪽 시험이다. 호스트 시트가 그 슬롯을 **실제로 쓰는가**는 각 시트의 시험이 잰다(`aiSheet`·`teamBoard`·`delegateWork`).
// 이 파일은 `sheetKit.test.tsx` 와 따로 둔다 — #4457 이 같은 파일의 같은 자리에 시험을 더해서 병합이 겹쳤다.
//
// 각 단정은 일부러 되돌려 본 사보타주 표가 PR 에 있다(S1~S6).
// =============================================================================

afterEach(cleanup);

const mount = (ui: React.ReactElement) => render(<FixedScheme scheme="light">{ui}</FixedScheme>);

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.style);

interface RenderedNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RenderedNode | string> | null;
}

/**
 * 한 요소의 **그려진** 직계 자식 순서 — 각 자식의 `testID`, 없으면 호스트 종류(`View`·`Text`·`Image`). 값·표식·셰브론이 가로로
 * 어떤 순서로 서는지(그려지는 순서)를 렌더 트리에서 잰다.
 */
function drawnChildren(testID: string): string[] {
  const find = (node: unknown): RenderedNode | null => {
    if (node === null || typeof node === 'string') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = find(item);
        if (hit !== null) return hit;
      }
      return null;
    }
    const json = node as RenderedNode;
    if (json.props?.testID === testID) return json;
    for (const child of json.children ?? []) {
      const hit = find(child);
      if (hit !== null) return hit;
    }
    return null;
  };
  const host = find(screen.toJSON());
  return (host?.children ?? []).map((child: RenderedNode | string) =>
    typeof child === 'string' ? child : String(child.props.testID ?? child.type),
  );
}

describe('행 — 오른쪽 임의 노드·역할·펼침 상태 (#4458)', () => {
  it('trailing 은 값 뒤·셰브론 앞에 **그려지고**, 없으면 그 자리도 없다', () => {
    const view = mount(
      <ListRow
        title="내 맥"
        detail="켜져 있어요"
        value="값"
        accessory="chevron"
        trailing={<Text testID="chip">내 맥 켜짐</Text>}
        onPress={() => {}}
        testID="row"
      />,
    );
    expect(within(screen.getByTestId('row')).getByTestId('chip')).toHaveTextContent('내 맥 켜짐');
    // 이름 칸 → 값 → 표식 → 셰브론 순서로 서야 한다(표식이 셰브론 뒤로 가면 행의 오른쪽 끝이 어긋난다).
    expect(drawnChildren('row')).toEqual(['View', 'Text', 'chip', 'Image']);
    view.rerender(
      <FixedScheme scheme="light">
        <ListRow title="내 맥" detail="켜져 있어요" value="값" accessory="chevron" onPress={() => {}} testID="row" />
      </FixedScheme>,
    );
    expect(screen.queryByTestId('chip')).toBeNull();
    expect(drawnChildren('row')).toEqual(['View', 'Text', 'Image']);
  });

  it('trailing 은 눌리지 않는 행에도 서고, 기본 보조기술 이름(제목·보조 줄·값)에는 들어가지 않는다 — 이름은 호출자가 직접 준다', () => {
    mount(
      <>
        <ListRow
          title="내 맥"
          detail="켜져 있어요"
          value="값"
          trailing={<Text testID="chip-a">내 맥 켜짐</Text>}
          onPress={() => {}}
          testID="press"
        />
        <ListRow
          title="내 맥"
          trailing={<Text testID="chip-b">내 맥 켜짐</Text>}
          accessibilityLabel="내 맥, 내 맥 켜짐"
          onPress={() => {}}
          testID="named"
        />
        <ListRow title="안내" trailing={<Text testID="chip-c">표식</Text>} testID="inert" />
      </>,
    );
    expect(screen.getByTestId('press').props.accessibilityLabel).toBe('내 맥, 켜져 있어요, 값');
    expect(screen.getByTestId('named').props.accessibilityLabel).toBe('내 맥, 내 맥 켜짐');
    // 눌리지 않는 행에도 그려진다.
    expect(within(screen.getByTestId('inert')).getByTestId('chip-c')).toHaveTextContent('표식');
  });

  it('역할: 눌리는 행은 기본이 button 이고, 밖으로 나가는 행은 link 로 읽힌다 — 토글 행은 늘 switch', () => {
    mount(
      <>
        <ListRow title="기본" onPress={() => {}} testID="plain" />
        <ListRow title="링크" accessibilityRole="link" onPress={() => {}} testID="link" />
        <ListRow
          title="토글"
          accessory="toggle"
          accessibilityRole="link"
          toggle={{value: false, onValueChange: () => {}}}
          testID="toggle"
        />
      </>,
    );
    expect(screen.getByTestId('plain').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('link').props.accessibilityRole).toBe('link');
    expect(screen.getByTestId('toggle').props.accessibilityRole).toBe('switch');
  });

  it('펼침 상태: 주지 않으면 상태에 넣지 않고, 주면 보조기술에 말하며, 펼치면 ⌄ 가 뒤집힌다', () => {
    const row = (expanded?: boolean) => (
      <FixedScheme scheme="light">
        <ListRow
          title="더 보기"
          accessory="expand"
          expanded={expanded}
          onPress={() => {}}
          testID="row"
        />
      </FixedScheme>
    );
    const view = render(row());
    // 펼침이 아닌 행(주지 않음)은 `expanded` 를 말하지 않는다 — `false`(접힘)도 말이 되므로 둘은 다르다
    // (RN 의 `Pressable` 은 키를 늘 싣고 값만 `undefined` 로 둔다).
    expect(screen.getByTestId('row').props.accessibilityState.expanded).toBeUndefined();
    expect(flat('row-expand').transform).toBeUndefined();
    view.rerender(row(false));
    expect(screen.getByTestId('row').props.accessibilityState.expanded).toBe(false);
    expect(flat('row-expand').transform).toBeUndefined();
    view.rerender(row(true));
    expect(screen.getByTestId('row').props.accessibilityState.expanded).toBe(true);
    expect(flat('row-expand').transform).toEqual([{rotate: '180deg'}]);
  });
});
