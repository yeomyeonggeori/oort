import {cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {ActivityIndicator, Dimensions, StyleSheet, Text} from 'react-native';

import {STACK_PILL_SCALE} from '../src/design/atoms';
import {SHEET_ICONS} from '../src/design/icons';
import {ConfirmCheck, SheetHeader} from '../src/design/SheetChrome';
import {ListRow} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';
import {imageSources} from './fixtures/sheetContract';

// =============================================================================
// `ListRow` 의 세 슬롯 — 오른쪽 임의 노드(`trailing`) · 역할(`accessibilityRole`) · 펼침(`expanded`) 과 확정 ✓ 의 진행 표시
// (`ConfirmCheck busy`) (#4458 2단계).
//
// 1단계가 부품에 자리가 없어 접거나 잃었던 표시(AI 시트의 칩, PR 이동 행의 link, 작업 맡기기 펼침 행의 상태)를 되살리는
// 부품 쪽 시험이다. 호스트 시트가 그 슬롯을 **실제로 쓰는가**는 각 시트의 시험이 잰다(`aiSheet`·`teamBoard`·`delegateWork`).
// 이 파일은 `sheetKit.test.tsx` 와 따로 둔다 — #4457 이 같은 파일의 같은 자리에 시험을 더해서 병합이 겹쳤다.
//
// 각 단정은 일부러 되돌려 본 사보타주 표가 PR 에 있다(S1~S6 · S21~S24).
// =============================================================================

afterEach(cleanup);
afterEach(() => jest.restoreAllMocks());

const mount = (ui: React.ReactElement) => render(<FixedScheme scheme="light">{ui}</FixedScheme>);

/**
 * `useWindowDimensions` 가 읽는 창의 글자 배율만 바꾼다. **RN 의 jest 프리셋 기본 배율은 2** 라서(= `STACK_PILL_SCALE`
 * 1.5 이상) 손대지 않으면 `ListRow` 의 값이 늘 제목 아래로 내려온 모습(#4457 의 값 쌓기)으로 그려진다 — 「오른쪽에 선 값」을
 * 재는 시험은 배율 1 을 직접 고른다.
 */
function setFontScale(fontScale: number) {
  const real = Dimensions.get('window');
  jest.spyOn(Dimensions, 'get').mockImplementation(() => ({...real, fontScale}) as never);
}

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
  it('trailing 은 값 뒤·셰브론 앞에 **그려지고**, 없으면 그 자리도 없다 (기본 글씨 — 값이 오른쪽에 선다)', () => {
    setFontScale(1);
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
    expect(drawnChildren('row')).toEqual(['View', 'row-value', 'chip', 'Image']);
    view.rerender(
      <FixedScheme scheme="light">
        <ListRow title="내 맥" detail="켜져 있어요" value="값" accessory="chevron" onPress={() => {}} testID="row" />
      </FixedScheme>,
    );
    expect(screen.queryByTestId('chip')).toBeNull();
    expect(drawnChildren('row')).toEqual(['View', 'row-value', 'Image']);
  });

  it('큰 글씨(STACK_PILL_SCALE 부터): 값은 이름 칸으로 내려오고 trailing 은 그대로 셰브론 앞에 선다 — #4457 의 값 쌓기와 #4458 의 trailing 이 만나는 자리', () => {
    setFontScale(STACK_PILL_SCALE);
    mount(
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
    // 행의 직계 자식에는 값이 없다(이름 칸 안으로 내려갔다) — 표식은 여전히 셰브론 바로 앞이다.
    expect(drawnChildren('row')).toEqual(['View', 'chip', 'Image']);
    expect(within(screen.getByTestId('row')).getByTestId('row-value')).toHaveTextContent('값');
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

describe('확정 ✓ 의 진행 표시 — 왕복 중에는 ✓ 자리에 스피너가 선다 (#4458 보안 검수 M1)', () => {
  it('진행 중이 아니면 ✓ 글리프가 서고 스피너는 없다', () => {
    mount(<ConfirmCheck label="저장" onPress={() => {}} testID="check" />);
    expect(imageSources(screen.getByTestId('check'))).toEqual([SHEET_ICONS.check]);
    expect(screen.getByTestId('check').findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(screen.getByTestId('check').props.accessibilityState).toMatchObject({busy: false, disabled: false});
  });

  it('진행 중이면 ✓ 글리프 대신 스피너가 서고, 눌려도 아무 일이 없고, 이름은 호출자의 것이며 상태는 busy·disabled 다', () => {
    const onPress = jest.fn();
    mount(<ConfirmCheck label="보내는 중" onPress={onPress} busy testID="check" />);
    const check = screen.getByTestId('check');
    // 그려진 모양: ✓ 글리프는 없고 스피너 하나가 선다.
    expect(imageSources(check)).toEqual([]);
    expect(within(check).UNSAFE_getAllByType(ActivityIndicator)).toHaveLength(1);
    expect(screen.getByTestId('check-busy')).toBeTruthy();
    // 보조기술이 읽는 상태와 이름.
    expect(check.props.accessibilityLabel).toBe('보내는 중');
    expect(check.props.accessibilityState).toMatchObject({busy: true, disabled: true});
    fireEvent.press(check);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('SheetHeader 는 confirm.busy 를 ✓ 에 전한다 — 머리의 오른쪽 X 는 진행 중에도 닫는다', () => {
    const onClose = jest.fn();
    const onPress = jest.fn();
    mount(
      <SheetHeader
        title="시험 시트"
        closeLabel="시험 시트 닫기"
        onClose={onClose}
        closeTestID="close"
        confirm={{label: '보내는 중', onPress, busy: true, testID: 'check'}}
      />,
    );
    expect(screen.getByTestId('check').props.accessibilityState).toMatchObject({busy: true, disabled: true});
    expect(screen.getByTestId('check-busy')).toBeTruthy();
    fireEvent.press(screen.getByTestId('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});
