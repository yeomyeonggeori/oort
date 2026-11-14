import {render, screen} from '@testing-library/react-native';
import React from 'react';
import {Image, PixelRatio, StyleSheet, View} from 'react-native';

import {
  ChoiceRow,
  ListRow,
  ROW_END_GLYPHS,
  ROW_END_INK_INSET,
  RowStatusIcon,
} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';
import {assetFile, endGlyphInk, inkGaps, type AssetScale} from './fixtures/endGlyphInk';
import {drainRender} from './testkit';

// =============================================================================
// 줄 끝 열 (#5791) — 셰브론·펼침·복사·✓·종·빗금 종의 **잉크**가 한 세로 줄에 선다.
//
// 그림마다 칸 안의 잉크 여백이 달라서(셰브론 18칸에 잉크 6pt 폭) 칸 끝을 맞추면 잉크가 최대 5pt 어긋났다(에이전트 DM 「대화 정보」).
// 부품(`sheetParts`)이 글리프마다의 잉크 여백 표(`ROW_END_GLYPHS`, 배율별 화소)를 들고 보정한다 — 부르는 쪽은 이웃을 몰라도 된다.
//
// 이 시험은 표를 같은 숫자로 다시 적지 않는다. **PNG 를 디스크에서 읽어** 알파 경계를 재고(`fixtures/endGlyphInk`),
//   1) 표가 그 값과 화소 단위로 같은지(그림을 한 화소 옮겨 다시 구우면 붉다),
//   2) 실제로 그린 줄에서 잉크가 열(`ROW_END_INK_INSET`)에 서는지 — 렌더된 여백·이동 + 그림에서 잰 여백으로 — 를 2배·3배로 잰다.
// =============================================================================

const SCALES: readonly AssetScale[] = [2, 3];

describe('줄 끝 글리프의 잉크 표는 그림 파일의 알파 경계와 같다 (#5791)', () => {
  for (const [name, glyph] of Object.entries(ROW_END_GLYPHS)) {
    for (const scale of SCALES) {
      it(`${name} @${scale}x`, () => {
        const {width, height, ...gaps} = inkGaps(assetFile(glyph.source, scale));
        expect([name, scale, gaps]).toEqual([name, scale, glyph.ink[scale]]);
        // 그림 칸 = 그림 화소 / 배율 — 키우거나 줄이지 않고 1:1 로 그린다(흐려지지 않는다).
        expect([name, width % scale, height % scale]).toEqual([name, 0, 0]);
      });
    }
  }
});

describe.each(SCALES)('부품이 그린 줄 끝 글리프는 잉크가 한 열에 선다 — @%sx (#5791)', scale => {
  afterEach(drainRender);

  beforeEach(() => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(scale);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const noop = () => {};

  const mount = () =>
    render(
      <FixedScheme scheme="light">
        <View>
          <ListRow title="에이전트 정보" accessory="chevron" onPress={noop} testID="chevron" />
          <ListRow title="기본 채널" value="# 디자인" accessory="expand" onPress={noop} testID="expand" />
          <ListRow
            title="기본 채널"
            value="# 디자인"
            accessory="expand"
            expanded
            onPress={noop}
            testID="expand-open"
          />
          <ListRow title="이름 복사" accessory="copy" onPress={noop} testID="copy" />
          <ListRow title="알림 끄기" trailing={<RowStatusIcon name="bell" />} onPress={noop} testID="bell" />
          <ListRow
            title="알림 켜기"
            trailing={<RowStatusIcon name="bell-off" />}
            onPress={noop}
            testID="bell-off"
          />
          <ChoiceRow title="시스템 설정" selected onPress={noop} testID="check" />
        </View>
      </FixedScheme>,
    );

  const ROWS = [
    ['chevron', 'chevron18'],
    ['expand', 'down'],
    ['expand-open', 'down'],
    ['copy', 'copy22'],
    ['bell', 'bell'],
    ['bell-off', 'bell-off'],
    ['check', 'check22'],
  ] as const;

  it('잉크 오른쪽 끝은 줄 안쪽 여백 끝에서 열 값만큼 안쪽 — 모든 글리프가 같은 화소에 선다', () => {
    mount();
    for (const [testID, picture] of ROWS) {
      const ink = endGlyphInk(screen.getByTestId(testID), scale);
      expect([testID, ink.file, ink.insetPx]).toEqual([
        testID,
        `${picture}@${scale}x.png`,
        ROW_END_INK_INSET * scale,
      ]);
    }
  });

  it('잉크 세로 가운데는 칸(= 줄) 가운데에서 반 화소 안이다', () => {
    mount();
    for (const [testID] of ROWS) {
      const {centerPx} = endGlyphInk(screen.getByTestId(testID), scale);
      expect([testID, Math.abs(centerPx) <= 0.5]).toEqual([testID, true]);
    }
  });

  it('고르지 않은 라디오 줄도 ✓ 칸의 자리를 같은 여백으로 지킨다 — 고를 때 제목 폭이 움찔하지 않는다', () => {
    render(
      <FixedScheme scheme="light">
        <ChoiceRow title="밝게" selected={false} onPress={noop} testID="off" />
        <ChoiceRow title="어둡게" selected onPress={noop} testID="on" />
      </FixedScheme>,
    );
    // ✓ 칸 = 줄 안에서 `marginRight` 를 가진 유일한 호스트 요소(고른 줄에서는 ✓ 그림을 품는다).
    const slot = (testID: string) => {
      const found = screen
        .getByTestId(testID)
        .findAll(
          (node: ReturnType<typeof screen.getByTestId>) =>
            typeof node.type === 'string' && StyleSheet.flatten(node.props.style)?.marginRight !== undefined,
        );
      expect([testID, found.length]).toEqual([testID, 1]);
      return found[0];
    };
    const style = (testID: string) => StyleSheet.flatten(slot(testID).props.style) as {marginRight?: number};
    // 열 보정은 늘 서는 칸이 진다(그림이 지면 고른 줄만 칸이 밀려 제목 폭이 바뀐다).
    expect(slot('on').findAll((node: ReturnType<typeof screen.getByTestId>) => node.type === Image)).toHaveLength(1);
    expect(style('on').marginRight).toBeLessThan(0);
    expect(style('off')).toEqual(style('on'));
  });
});
