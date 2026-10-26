import {cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {ActivityIndicator, Image, StyleSheet, Switch} from 'react-native';

import {HOME_ICONS, SHEET_ICONS} from '../src/design/icons';
import {ChoiceRow, ListRow} from '../src/design/sheetParts';
import {FixedScheme, paletteFor, type ColorScheme} from '../src/design/theme';
import {line, SHEET, space} from '../src/design/tokens';
import {
  ActionRow,
  SettingsNote,
  SwitchRow,
} from '../src/features/profile/settingsRows';

// =============================================================================
// #4457 — 설정 페이지의 얇은 행 부품(`settingsRows.tsx`).
//
// 이 부품들은 `design/sheetParts.tsx` 의 `ListRow` 가 갖지 못한 세 가지(라디오 · 읽는 중의 오른쪽
// 자리 · 접근성으로만 잠기는 상태)를 같은 토큰으로 얇게 더한 것이다. 시험이 지키는 약속은 둘:
//   1. **모양이 `ListRow` 와 갈라지지 않는다** — 한 카드 안에서 두 가족의 행이 섞여 서므로, 치수가
//      한 칸이라도 어긋나면 행 높이가 들쭉날쭉해진다(값이 아니라 관계를 잰다).
//   2. **모르는 값을 말하지 않는다** — 읽는 중·못 읽음에는 스위치를 그리지 않는다.
// =============================================================================

afterEach(cleanup);

function mount(ui: React.ReactElement, scheme: ColorScheme = 'light') {
  return render(<FixedScheme scheme={scheme}>{ui}</FixedScheme>);
}

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.style);

/** 행 상자의 치수만 뽑는다 — 색·눌림 같은 상태 스타일은 빼고. */
const BOX = [
  'minHeight',
  'flexDirection',
  'alignItems',
  'gap',
  'paddingHorizontal',
  'paddingVertical',
] as const;
const box = (testID: string) => {
  const style = flat(testID);
  return Object.fromEntries(BOX.map(key => [key, style[key]]));
};
const type = (text: string) => {
  const style = StyleSheet.flatten(screen.getByText(text).props.style);
  return {fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color};
};

describe.each(['light', 'dark'] as const)('행 모양은 ListRow 와 같다 (%s)', scheme => {
  it('스위치 행·라디오 행의 상자가 ListRow 의 상자와 같다', () => {
    mount(
      <>
        <ListRow title="기준" detail="기준 설명" onPress={() => {}} testID="base" />
        <SwitchRow
          title="스위치"
          detail="스위치 설명"
          checked
          control={{kind: 'none'}}
          onPress={() => {}}
          testID="switch"
        />
        <ChoiceRow title="라디오" detail="라디오 설명" selected={false} onPress={() => {}} testID="choice" />
        <ActionRow title="동작" detail="동작 설명" chevron onPress={() => {}} testID="action" />
      </>,
      scheme,
    );
    // 기준이 비어 있지 않다 — 둘 다 undefined 여서 맞는 헛단정을 막는다.
    expect(box('base')).toEqual({
      minHeight: SHEET.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    });
    expect(box('switch')).toEqual(box('base'));
    expect(box('action')).toEqual(box('base'));
    // 설명 줄이 있으면 라디오 행만 위로 붙는다(점·✓ 가 제목 첫 줄 옆에 서도록) — 나머지 치수는 같다.
    expect({...box('choice'), alignItems: 'center'}).toEqual(box('base'));
    expect(box('choice').alignItems).toBe('flex-start');
  });

  it('이름·설명 글자가 ListRow 와 같은 크기·줄 높이·색이다', () => {
    mount(
      <>
        <ListRow title="기준" detail="기준 설명" onPress={() => {}} />
        <SwitchRow title="스위치" detail="스위치 설명" checked={false} control={{kind: 'none'}} onPress={() => {}} />
        <ChoiceRow title="라디오" detail="라디오 설명" selected={false} onPress={() => {}} />
        <ActionRow title="동작" detail="동작 설명" onPress={() => {}} />
      </>,
      scheme,
    );
    expect(type('스위치')).toEqual(type('기준'));
    expect(type('라디오')).toEqual(type('기준'));
    expect(type('동작')).toEqual(type('기준'));
    expect(type('동작 설명')).toEqual(type('기준 설명'));
    expect(type('스위치 설명')).toEqual(type('기준 설명'));
    expect(type('라디오 설명')).toEqual(type('기준 설명'));
    expect(type('기준').color).toBe(paletteFor(scheme).text);
    expect(type('기준 설명').color).toBe(paletteFor(scheme).textMuted);
  });
});

describe.each(['light', 'dark'] as const)('스위치 행의 꺼짐 트랙은 ListRow 의 토글과 같다 (%s)', scheme => {
  it('꺼짐 트랙·iOS 바탕이 둘 다 textFaint 이고, border 가 아니다', () => {
    const {UNSAFE_getAllByType} = mount(
      <>
        <ListRow title="기준" accessory="toggle" toggle={{value: false, onValueChange: () => {}}} />
        <SwitchRow
          title="스위치"
          checked={false}
          control={{kind: 'switch', value: false, onValueChange: () => {}}}
          onPress={() => {}}
        />
      </>,
      scheme,
    );
    const [base, mine] = UNSAFE_getAllByType(Switch);
    const palette = paletteFor(scheme);
    // 비교가 헛돌지 않게: 두 색이 실제로 다르다 — 되돌리면(border) 이 줄이 붉어진다.
    expect(palette.textFaint).not.toBe(palette.border);
    expect(base.props.trackColor.false).toBe(palette.textFaint);
    expect(mine.props.trackColor.false).toBe(base.props.trackColor.false);
    expect(mine.props.ios_backgroundColor).toBe(base.props.ios_backgroundColor);
    expect(mine.props.trackColor.true).toBe(base.props.trackColor.true);
  });
});

describe('ActionRow', () => {
  const hostsOf = (testID: string) => within(screen.getByTestId(testID, {includeHiddenElements: true}));

  it('셰브론은 ListRow 의 것과 같은 글리프·크기이고, 진행 중이면 스피너가 셰브론을 대신한다', () => {
    mount(
      <>
        <ListRow title="기준" accessory="chevron" onPress={() => {}} testID="base" />
        <ActionRow title="동작" chevron onPress={() => {}} testID="idle" />
        <ActionRow title="진행" chevron pending onPress={() => {}} testID="busy" />
        <ActionRow title="없음" onPress={() => {}} testID="plain" />
      </>,
    );
    const glyph = (testID: string) => hostsOf(testID).UNSAFE_queryAllByType(Image).map(image => image.props.source);
    expect(glyph('base')).toEqual([SHEET_ICONS.chevron]);
    expect(glyph('idle')).toEqual([SHEET_ICONS.chevron]);
    const sizeOf = (testID: string) => StyleSheet.flatten(hostsOf(testID).UNSAFE_getByType(Image).props.style);
    expect(sizeOf('idle')).toEqual(sizeOf('base'));
    // 진행 중에는 셰브론이 없고 스피너가 하나다 — 누른 줄에서 진행이 보인다.
    expect(glyph('busy')).toEqual([]);
    expect(hostsOf('busy').UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);
    expect(hostsOf('idle').UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    // 아무것도 안 준 행은 오른쪽이 비어 있다.
    expect(glyph('plain')).toEqual([]);
    expect(hostsOf('plain').UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it.each(['light', 'dark'] as const)('강조는 accentText, 위험은 danger, 둘 다 굵게 — 기본은 text (%s)', scheme => {
    mount(
      <>
        <ActionRow title="기본" onPress={() => {}} />
        <ActionRow title="강조" tone="accent" onPress={() => {}} />
        <ActionRow title="위험" tone="danger" onPress={() => {}} />
      </>,
      scheme,
    );
    const palette = paletteFor(scheme);
    const title = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);
    expect(title('기본').color).toBe(palette.text);
    expect(title('기본').fontWeight).toBeUndefined();
    expect(title('강조')).toMatchObject({color: palette.accentText, fontWeight: '600'});
    expect(title('위험')).toMatchObject({color: palette.danger, fontWeight: '600'});
    // 비교가 헛돌지 않게: 세 색이 서로 다르다.
    expect(new Set([palette.text, palette.accentText, palette.danger]).size).toBe(3);
  });

  it('이름은 제목이고(보조 줄을 섞지 않는다), expanded 는 줬을 때만 상태에 들어간다', () => {
    mount(
      <>
        <ActionRow title="직접 고르기" detail="시각을 정해요" expanded={false} onPress={() => {}} testID="closed" />
        <ActionRow title="열림" expanded onPress={() => {}} testID="open" />
        <ActionRow title="평범" onPress={() => {}} testID="plain" />
        <ActionRow title="따로" accessibilityLabel="따로, 내일" onPress={() => {}} testID="named" />
      </>,
    );
    expect(screen.getByTestId('closed').props.accessibilityLabel).toBe('직접 고르기');
    expect(screen.getByTestId('closed').props.accessibilityState).toEqual({expanded: false});
    expect(screen.getByTestId('open').props.accessibilityState).toEqual({expanded: true});
    // 안 준 행은 값이 있는 상태 키가 하나도 없다 — `false` 를 섞지 않는다(Pressable 이 그것도 접근성 상태에 섞는다).
    // (Pressable 은 상태를 모든 키가 undefined 인 객체로 정규화하므로 「객체 없음」이 아니라 「값 있는 키 없음」을 잰다.)
    const given = (id: string) =>
      Object.entries(screen.getByTestId(id).props.accessibilityState ?? {}).filter(([, value]) => value !== undefined);
    expect(given('plain')).toEqual([]);
    expect(given('open')).toEqual([['expanded', true]]);
    expect(screen.getByTestId('named').props.accessibilityLabel).toBe('따로, 내일');
  });

  it('expanded 를 주면 오른쪽 끝이 ⌄ 이고 펼치면 뒤집힌다 — ListRow 의 펼침과 같은 표지, 셰브론 ›(더 들어간다)와 갈린다', () => {
    mount(
      <>
        <ListRow title="기준" accessory="expand" expanded onPress={() => {}} testID="base" />
        <ActionRow title="접힘" expanded={false} onPress={() => {}} testID="closed" />
        <ActionRow title="열림" expanded onPress={() => {}} testID="open" />
        <ActionRow title="섞임" chevron expanded={false} onPress={() => {}} testID="both" />
        <ActionRow title="들어감" chevron onPress={() => {}} testID="push" />
      </>,
    );
    const glyph = (testID: string) => hostsOf(testID).UNSAFE_queryAllByType(Image).map(image => image.props.source);
    const imageStyle = (testID: string) => StyleSheet.flatten(hostsOf(testID).UNSAFE_getByType(Image).props.style);
    expect(glyph('base')).toEqual([HOME_ICONS.down]);
    expect(glyph('closed')).toEqual([HOME_ICONS.down]);
    expect(glyph('open')).toEqual([HOME_ICONS.down]);
    // 둘 다 줘도 ⌄ 하나다 — 셰브론과 펼침이 한 행에서 겹치지 않는다. 펼침이 아닌 「들어감」은 그대로 ›.
    expect(glyph('both')).toEqual([HOME_ICONS.down]);
    expect(glyph('push')).toEqual([SHEET_ICONS.chevron]);
    // 같은 크기·색이고(ListRow 와 한 가족), 뒤집힘은 펼친 행에만 있다.
    const {transform: baseFlip, ...baseBox} = imageStyle('base');
    const {transform: closedFlip, ...closedBox} = imageStyle('closed');
    expect(closedBox).toEqual(baseBox);
    expect(baseFlip).toEqual([{rotate: '180deg'}]);
    expect(closedFlip).toBeUndefined();
    expect(imageStyle('open').transform).toEqual([{rotate: '180deg'}]);
    expect(imageStyle('both').transform).toBeUndefined();
  });

  it('비활성이면 눌러도 아무 일이 없고 접근성이 잠겼다고 말한다', () => {
    const onPress = jest.fn();
    mount(
      <>
        <ActionRow title="켬" onPress={onPress} testID="on" />
        <ActionRow title="잠김" disabled onPress={onPress} testID="off" />
      </>,
    );
    fireEvent.press(screen.getByTestId('on'));
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('off'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('off').props.accessibilityState).toMatchObject({disabled: true});
    expect(screen.getByTestId('on').props.accessibilityState?.disabled).not.toBe(true);
  });
});

describe.each(['light', 'dark'] as const)('ChoiceRow — 고른 줄의 세 신호 (%s)', scheme => {
  it('강조색 글자·굵기·✓ 가 함께 서고, 고르지 않은 줄에는 셋 다 없다', () => {
    mount(
      <>
        <ChoiceRow title="고름" selected onPress={() => {}} testID="on" checkTestID="on-check" />
        <ChoiceRow title="안고름" selected={false} onPress={() => {}} testID="off" checkTestID="off-check" />
      </>,
      scheme,
    );
    const palette = paletteFor(scheme);
    const title = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);
    expect(title('고름')).toMatchObject({color: palette.accentText, fontWeight: '600'});
    expect(title('안고름').color).toBe(palette.text);
    expect(title('안고름').fontWeight).toBeUndefined();
    // ✓ 도 같은 강조색이고, 고르지 않은 줄에는 없다(자리만 지킨다).
    const check = StyleSheet.flatten(
      screen.getByTestId('on-check', {includeHiddenElements: true}).props.style,
    );
    expect(check.tintColor).toBe(palette.accentText);
    expect(screen.queryByTestId('off-check', {includeHiddenElements: true})).toBeNull();
    // 비교가 헛돌지 않게: 강조색과 글자색이 다르다.
    expect(palette.accentText).not.toBe(palette.text);
  });
});

describe('ChoiceRow — 앞 칸', () => {
  it('기본은 제목 첫 줄 높이의 22pt 칸이고, 설명 줄이 있으면 행이 위로 붙는다', () => {
    mount(
      <ChoiceRow title="점" detail="설명" selected leading={<></>} onPress={() => {}} testID="dot" />,
    );
    expect(flat('dot-lead')).toMatchObject({width: SHEET.iconSlot, height: line.body});
    expect(flat('dot').alignItems).toBe('flex-start');
  });

  it('견본·썸네일처럼 줄보다 큰 앞 칸은 가운데에 서고 고정 높이가 없다 — 폭은 넘긴 값이다', () => {
    mount(
      <ChoiceRow
        title="견본"
        detail="설명"
        selected={false}
        leading={<></>}
        leadingWidth={44}
        leadingAlign="center"
        onPress={() => {}}
        testID="swatch"
      />,
    );
    const lead = flat('swatch-lead');
    expect(lead.width).toBe(44);
    expect(lead.height).toBeUndefined();
    // 설명 줄이 있어도 행이 위로 붙지 않는다(가운데 정렬 그대로).
    expect(flat('swatch').alignItems).toBe('center');
  });
});

describe('ChoiceRow', () => {
  it('라디오로 읽히고, 선택된 줄에만 ✓ 가 있다', () => {
    mount(
      <>
        <ChoiceRow title="온라인" selected onPress={() => {}} testID="a" checkTestID="a-check" />
        <ChoiceRow title="자리 비움" selected={false} onPress={() => {}} testID="b" checkTestID="b-check" />
      </>,
    );
    expect(screen.getByTestId('a').props.accessibilityRole).toBe('radio');
    expect(screen.getByTestId('a').props.accessibilityState).toMatchObject({selected: true});
    expect(screen.getByTestId('b').props.accessibilityState).toMatchObject({selected: false});
    expect(screen.queryByTestId('a-check', {includeHiddenElements: true})).not.toBeNull();
    expect(screen.queryByTestId('b-check', {includeHiddenElements: true})).toBeNull();
  });

  it('누르면 onPress 이고, 비활성이면 눌러도 아무 일이 없고 접근성이 잠겼다고 말한다', () => {
    const onPress = jest.fn();
    mount(
      <>
        <ChoiceRow title="켬" selected={false} onPress={onPress} testID="on" />
        <ChoiceRow title="잠김" selected={false} disabled onPress={onPress} testID="off" />
      </>,
    );
    fireEvent.press(screen.getByTestId('on'));
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('off'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('off').props.accessibilityState).toMatchObject({disabled: true});
    // 켜진 줄은 잠겼다고 말하지 않는다.
    expect(screen.getByTestId('on').props.accessibilityState.disabled).not.toBe(true);
  });

  it('앞 표지는 장식이라 낭독에서 빠지고, 설명 줄이 있으면 제목 첫 줄 높이를 지킨다', () => {
    mount(
      <ChoiceRow
        title="방해 금지"
        detail="알림도 함께 멈춰요"
        selected
        leading={<></>}
        onPress={() => {}}
        testID="row"
      />,
    );
    expect(screen.getByTestId('row-lead', {includeHiddenElements: true}).props.importantForAccessibility).toBe(
      'no',
    );
    // 점 칸의 폭은 아이콘 칸 — 카드의 inset="icon" 구분선이 글자 열에 맞는 근거다.
    expect(flat('row-lead').width).toBe(SHEET.iconSlot);
  });
});

describe('SwitchRow', () => {
  it('스위치가 있으면 값을 보이고, 컨트롤을 돌리면 onValueChange, 행을 누르면 onPress', () => {
    const onPress = jest.fn();
    const onValueChange = jest.fn();
    mount(
      <SwitchRow
        title="푸시 알림"
        checked
        control={{kind: 'switch', value: true, onValueChange, testID: 'sw'}}
        onPress={onPress}
        testID="row"
      />,
    );
    const row = screen.getByTestId('row');
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toMatchObject({checked: true, disabled: false});
    const control = screen.getByTestId('sw', {includeHiddenElements: true});
    // 컨트롤은 보조기술에서 숨는다 — 한 행에 요소가 하나다.
    expect(control.props.accessibilityElementsHidden).toBe(true);
    fireEvent(control, 'valueChange', false);
    expect(onValueChange).toHaveBeenCalledWith(false);
    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('읽는 중에는 스피너만 서고 스위치는 없다 — 모르는 값을 「꺼짐」으로 그리지 않는다', () => {
    mount(
      <SwitchRow
        title="푸시 알림"
        checked={false}
        a11yDisabled
        control={{kind: 'loading', testID: 'spinner'}}
        onPress={() => {}}
        testID="row"
      />,
    );
    expect(screen.queryByTestId('spinner', {includeHiddenElements: true})).not.toBeNull();
    // `Switch` 호스트가 하나도 없다(이 행은 testID 없는 스위치도 그리지 않는다).
    expect(screen.UNSAFE_queryAllByType(require('react-native').Switch)).toHaveLength(0);
    expect(screen.getByTestId('row').props.accessibilityState).toMatchObject({disabled: true});
  });

  it('못 읽은 행은 오른쪽이 비어 있다', () => {
    mount(
      <SwitchRow
        title="푸시 알림"
        checked={false}
        a11yDisabled
        control={{kind: 'none'}}
        onPress={() => {}}
        testID="row"
      />,
    );
    expect(screen.UNSAFE_queryAllByType(require('react-native').Switch)).toHaveLength(0);
    expect(screen.UNSAFE_queryAllByType(require('react-native').ActivityIndicator)).toHaveLength(0);
  });

  it('접근성 잠김은 눌림을 막지 않는다 — 막는 것은 쓰기를 쥔 훅이다(옛 줄과 같은 약속)', () => {
    const onPress = jest.fn();
    mount(
      <SwitchRow title="작업 끝남" checked a11yDisabled control={{kind: 'none'}} onPress={onPress} testID="row" />,
    );
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsNote', () => {
  it('실패는 위험색이고 나타나는 순간 읽힌다(라이브 영역), 안내는 아니다', () => {
    mount(
      <>
        <SettingsNote tone="danger" testID="bad">
          저장하지 못했습니다.
        </SettingsNote>
        <SettingsNote testID="hint">팀 설정이 꺼져 있습니다.</SettingsNote>
      </>,
    );
    expect(screen.getByTestId('bad').props.accessibilityLiveRegion).toBe('polite');
    expect(StyleSheet.flatten(screen.getByTestId('bad').props.style).color).toBe(
      paletteFor('light').dangerText,
    );
    expect(screen.getByTestId('hint').props.accessibilityLiveRegion).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('hint').props.style).color).toBe(
      paletteFor('light').textMuted,
    );
  });
});
