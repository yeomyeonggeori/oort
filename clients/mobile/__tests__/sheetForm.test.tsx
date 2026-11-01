import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import {ChoiceRow} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';
import {Field, TextArea} from '../src/shell/sheetForm';

// 폼 시트의 입력 부품(`shell/sheetForm.tsx`)의 잠김 모양 (#5099 M2, 검증 줄 2회차 화면). 만드는 동안 잠긴 입력 칸이 평소 그대로여서
// 눌러도 자판이 안 오르는 칸이 고칠 수 있는 칸처럼 보였다. 부품이 `editable={false}` 를 보고 스스로 **같은 화면의 잠긴 행**(`ChoiceRow
// disabled`)과 같은 흐림을 입고 보조기술에도 잠겼다고 말한다 — `Field` 를 쓰는 다른 양식(작업 맡기기·맥에 보내기·에이전트에게 부탁하기)과
// 같은 파일의 `TextArea` 가 같이 좋아진다. 양식 한 장의 실제 모양은 `expressionPhoto.test` 가 잰다.

afterEach(() => {
  cleanup();
});

const style = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style);
const opacityOf = (testID: string) => style(testID)?.opacity;

// 흐림이 걸리는 상자: `Field` 는 알약 바깥 상자(`<testID>-pill`), `TextArea` 는 입력 자신이다.
const PARTS = [
  [
    'Field',
    (props: Partial<React.ComponentProps<typeof Field>>) => (
      <Field accessibilityLabel="칸" {...props} />
    ),
    (id: string) => `${id}-pill`,
  ],
  [
    'TextArea',
    (props: Partial<React.ComponentProps<typeof TextArea>>) => (
      <TextArea accessibilityLabel="칸" {...props} />
    ),
    (id: string) => id,
  ],
] as const;

describe.each(PARTS)('%s 의 잠김', (_name, make, boxOf) => {
  it('`editable={false}` 만 잠긴 행과 같은 흐림이고 잠겼다고 말한다 — 생략·`true` 는 살아 있다', () => {
    render(
      <FixedScheme scheme="light">
        {make({testID: 'omitted'})}
        {make({testID: 'on', editable: true})}
        {make({
          testID: 'off',
          editable: false,
          // 부르는 쪽이 이미 준 접근성 상태는 지우지 않고 잠김만 더한다.
          accessibilityState: {busy: true},
        })}
        <ChoiceRow
          title="행"
          selected={false}
          disabled
          onPress={jest.fn()}
          testID="row"
        />
      </FixedScheme>,
    );
    // 기준: 같은 화면의 잠긴 행. 둘 다 1 이라서 맞는 빈 비교가 되지 않게 실제로 흐린지부터 본다.
    const row = opacityOf('row');
    expect(row).toBeLessThan(1);
    expect(opacityOf(boxOf('off'))).toBe(row);
    // `editable` 은 생략하면 켜진 것이다 — 생략과 `true` 는 흐리지 않다(`!editable` 로 읽으면 평소 칸이 전부 흐려진다).
    expect(opacityOf(boxOf('omitted'))).toBeUndefined();
    expect(opacityOf(boxOf('on'))).toBeUndefined();
    // 보조기술: 잠긴 칸만 `disabled`, 부르는 쪽의 상태는 그대로다.
    expect(screen.getByTestId('off').props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(screen.getByTestId('omitted').props.accessibilityState).toBeUndefined();
    expect(screen.getByTestId('on').props.accessibilityState).toBeUndefined();
  });
});
