import {makeDirectory} from '@momo/core/features/workspace/directory';
import {contrast} from '@momo/core/design/color';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Dimensions, Image, StyleSheet} from 'react-native';

import {darkPalette, ds2Radius, lightPalette, slopTo, space, TOUCH_TARGET} from '../src/design/tokens';
import {
  Composer,
  composerColumnBudget,
  INPUT_CHROME,
  INPUT_CHROME_X,
} from '../src/features/conversation/Composer';
import {
  COMPOSER_CHROME_X,
  CONV,
  composerFloat,
  composerTextColumn,
} from '../src/features/conversation/convDesign';
import {
  WorkConversationView,
  type ComposerGate,
} from '../src/features/work/WorkConversation';

// =============================================================================
// #4179 — 대화 입력 알약: 두 원이 알약 끝 반원과 **동심**이다.
//
// 성재의 Buzz 캡처를 픽셀로 쟀더니(PR 본문 「실측」 표) Buzz 의 한 줄 알약은 두 원이 같은
// 지름(36pt)이고, 원과 알약 가장자리 사이가 사방 같으며(≈9pt), 알약 반경이 그 합(18 + 9 =
// 27)이다. 옛 oort 는 원이 34·38 으로 달랐고 좌우 4 · 위아래 7~9 로 여백이 갈라져, 원이 끝
// 곡선에 붙어 보였다.
//
// 이 파일이 재는 것은 **관계**다 — 값이 아니라. 값은 `convDesign.ts` 에 이름으로 있고,
// 반경은 여백에서 계산하지 않고 **따로 적혀** 있다(계산으로 묶으면 여백 하나만 바꿔도 이
// 시험이 못 빨개진다). 그래서 아래 첫 절이 토큰 수준에서 관계를 단정하고, 둘째 절이 그 값을
// **배송되는 렌더**가 읽는다는 것을 단정한다.
// =============================================================================

/** 스타일 배열을 한 객체로 — 알약·원이 `[기본, 인라인]` 배열로 서는 자리가 있다. */
const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

const DIRECTORY = makeDirectory([]);
const TARGET = {workspaceId: 'ws', channelId: 'ch'};

const BASE_WINDOW = Dimensions.get('window');
function setWindow(next: {width?: number; fontScale?: number; height?: number}) {
  const window = {...BASE_WINDOW, ...next};
  Dimensions.set({window, screen: window});
}
afterEach(() => {
  cleanup();
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
});

function composer() {
  return render(
    <Composer
      recipient="place"
      channelLabel="agent-lab"
      directory={DIRECTORY}
      attachmentTarget={TARGET}
      onSend={() => {}}
    />,
  );
}

/** 첫 조상 중 조건을 만족하는 스타일. 알약 안쪽 줄(`styles.bar`)은 testID 가 없다. */
function ancestorStyle(
  node: ReturnType<typeof screen.getByTestId>,
  match: (style: Record<string, number | string | undefined>) => boolean,
) {
  let cursor = node.parent as typeof node | null;
  while (cursor) {
    const style = flat(cursor.props?.style);
    if (match(style)) return style;
    cursor = cursor.parent as typeof node | null;
  }
  throw new Error('조건을 만족하는 조상 스타일이 없다');
}

describe('동심 — 토큰 수준의 관계', () => {
  it('알약 반경 − 원 ↔ 가장자리 여백 = 원 반경', () => {
    // 이 한 줄이 이 배치의 계약이다. 셋 중 어느 하나만 바꿔도 빨갛다 — 값이 따로 적혀 있기 때문.
    expect(CONV.composerRadius - CONV.composerGap).toBe(CONV.composerCircle / 2);
  });

  it('한 줄 알약의 높이는 지름의 두 배가 아니라 반경의 두 배다 — 끝이 온전한 반원이다', () => {
    // 한 줄 높이 = 원 + 위아래 여백 = 36 + 18 = 54 = 2 × 27. 이 등식이 깨지면 한 줄에서도 끝이
    // 반원이 아니다(반경이 높이의 절반보다 작으면 직선 구간이, 크면 눌린 모서리가 생긴다).
    expect(CONV.composerCircle + 2 * CONV.composerGap).toBe(2 * CONV.composerRadius);
  });

  it('DS2 반경 사다리의 컴포저 단이 같은 값이다', () => {
    expect(ds2Radius.composer).toBe(CONV.composerRadius);
  });

  it('원 ↔ 글 시작은 입력창 안쪽 여백과 테두리의 합이다', () => {
    // `Composer` 의 `INPUT_PAD_X + INPUT_BORDER`. 어긋나면 글 칸 산수(`COMPOSER_CHROME_X`)가
    // 배송되는 입력창과 다른 수를 든다.
    expect(INPUT_CHROME_X / 2).toBe(CONV.composerTextInset);
    expect(INPUT_CHROME / 2).toBe(CONV.composerTextInset);
  });

  it('알약 안에서 글 칸이 아닌 가로가 실제 구조와 같다', () => {
    // 왼쪽: 여백 + 원 + 글 여백. 오른쪽도 같다. 두 원이 있으니 대칭이다.
    expect(COMPOSER_CHROME_X).toBe(
      2 * (CONV.composerGap + CONV.composerCircle + CONV.composerTextInset),
    );
    expect(COMPOSER_CHROME_X).toBe(108);
  });

  it('원은 엄지 44 안에 든다 — 눌림 영역이 알약 밖으로 안 나간다', () => {
    const slop = slopTo(CONV.composerCircle);
    expect(CONV.composerCircle + 2 * slop).toBe(TOUCH_TARGET);
    expect(slop).toBeLessThan(CONV.composerGap);
  });
});

describe('동심 — 배송되는 렌더가 그 값을 읽는다', () => {
  it('두 원이 같은 지름이고 반지름이 반원이다', () => {
    composer();
    for (const id of ['composer-attach', 'composer-send']) {
      const style = flat(screen.getByTestId(id).props.style);
      expect([id, style.width, style.height, style.borderRadius]).toEqual([
        id,
        CONV.composerCircle,
        CONV.composerCircle,
        CONV.composerCircle / 2,
      ]);
    }
  });

  it('원의 눌림 영역은 둘 다 정확히 44 다', () => {
    composer();
    for (const id of ['composer-attach', 'composer-send']) {
      const node = screen.getByTestId(id);
      expect([id, CONV.composerCircle + node.props.hitSlop * 2]).toEqual([id, TOUCH_TARGET]);
    }
  });

  it('알약의 반경이 원 반경 + 사방 여백이다', () => {
    composer();
    expect(flat(screen.getByTestId('composer-pill').props.style).borderRadius).toBe(
      CONV.composerRadius,
    );
  });

  it('좌우 여백 = 위아래 여백 = 원 ↔ 알약 가장자리 — 두 원 모두', () => {
    composer();
    const bar = ancestorStyle(
      screen.getByTestId('composer-attach'),
      style => style.flexDirection === 'row',
    );
    // 좌우: 안쪽 줄의 가로 여백이 곧 원 ↔ 가장자리.
    expect(bar.paddingHorizontal).toBe(CONV.composerGap);
    // 위아래: 안쪽 줄의 세로 여백 + 원이 입력창 한 줄(44) 안에서 받는 여유 = 같은 값.
    for (const id of ['composer-attach', 'composer-send']) {
      const circle = flat(screen.getByTestId(id).props.style);
      expect([id, (bar.paddingVertical as number) + (circle.marginBottom as number)]).toEqual([
        id,
        CONV.composerGap,
      ]);
    }
  });

  it('한 줄 알약의 높이가 2 × 반경이다 — 입력창 44 + 위아래 안쪽 여백', () => {
    composer();
    const bar = ancestorStyle(
      screen.getByTestId('composer-attach'),
      style => style.flexDirection === 'row',
    );
    const input = flat(screen.getByTestId('composer-input').props.style);
    expect(input.minHeight).toBe(TOUCH_TARGET);
    expect(TOUCH_TARGET + 2 * (bar.paddingVertical as number)).toBe(2 * CONV.composerRadius);
  });

  it('원은 글이 여러 줄로 자라도 아래에 남는다 — 아래·옆 여백이 한 줄 때와 같다', () => {
    composer();
    const bar = ancestorStyle(
      screen.getByTestId('composer-attach'),
      style => style.flexDirection === 'row',
    );
    // `flex-end` 이면 원의 아래 여백(안쪽 줄 아래 여백 + 원의 marginBottom)은 줄 수와 무관하다.
    expect(bar.alignItems).toBe('flex-end');
    fireEvent.changeText(screen.getByTestId('composer-input'), '가\n나\n다\n라');
    const grown = ancestorStyle(
      screen.getByTestId('composer-attach'),
      style => style.flexDirection === 'row',
    );
    expect(grown.alignItems).toBe('flex-end');
    expect(grown.paddingHorizontal).toBe(CONV.composerGap);
  });

  it('알약에 테두리가 없다 — 선 대신 부드러운 그림자', () => {
    composer();
    const pill = flat(screen.getByTestId('composer-pill').props.style);
    expect(pill.borderWidth).toBeUndefined();
    expect(pill.borderColor).toBeUndefined();
    expect(pill.boxShadow).toBe(darkPalette.elevationRest);
  });
});

describe('작업 대화 입력 알약 — 같은 자', () => {
  const gate: ComposerGate = {kind: 'ready'};

  function work() {
    return render(
      <WorkConversationView
        items={[]}
        agentName="Claude Code"
        nameOf={() => '팀원'}
        gate={gate}
        onSend={async () => ({ok: true})}
        renderPermission={() => null}
      />,
    );
  }

  it('원 지름·반경·눌림이 대화 컴포저와 같다', () => {
    work();
    const send = screen.getByTestId('work-chat-send');
    const style = flat(send.props.style);
    expect([style.width, style.height, style.borderRadius]).toEqual([
      CONV.composerCircle,
      CONV.composerCircle,
      CONV.composerCircle / 2,
    ]);
    expect(CONV.composerCircle + send.props.hitSlop * 2).toBe(TOUCH_TARGET);
  });

  it('알약 반경이 같고, 바깥 가장자리에서 원까지 사방 같다', () => {
    work();
    const send = screen.getByTestId('work-chat-send');
    const pill = ancestorStyle(send, style => style.flexDirection === 'row' && style.borderRadius !== undefined);
    expect(pill.borderRadius).toBe(CONV.composerRadius);
    const border = pill.borderWidth as number;
    // 오른쪽: 테두리 + 안쪽 오른쪽 여백.
    expect(border + (pill.paddingRight as number)).toBe(CONV.composerGap);
    // 위·아래: 테두리 + 안쪽 위아래 여백 + 원이 입력창 한 줄 안에서 받는 여유.
    const circle = flat(send.props.style);
    expect(border + (pill.paddingVertical as number) + (circle.marginBottom as number)).toBe(
      CONV.composerGap,
    );
  });

  it('한 줄 알약 높이가 2 × 반경이다', () => {
    work();
    const pill = ancestorStyle(
      screen.getByTestId('work-chat-send'),
      style => style.flexDirection === 'row' && style.borderRadius !== undefined,
    );
    const input = flat(screen.getByTestId('work-chat-input').props.style);
    expect(input.minHeight).toBe(TOUCH_TARGET);
    expect(
      TOUCH_TARGET + 2 * (pill.paddingVertical as number) + 2 * (pill.borderWidth as number),
    ).toBe(2 * CONV.composerRadius);
  });

  it('바깥 여백은 독 그대로다 — 위 안내 줄(「끼어들기」 칩)과 오른쪽 끝이 맞는다', () => {
    // 대화 컴포저의 `composerFloat` 를 여기 쓰면 칩이 알약 밖으로 튀어나온다(캡처로 확인).
    work();
    const pill = ancestorStyle(
      screen.getByTestId('work-chat-send'),
      style => style.flexDirection === 'row' && style.borderRadius !== undefined,
    );
    expect(pill.marginHorizontal).toBeUndefined();
    const dock = flat(screen.getByTestId('work-chat-dock').props.style);
    expect(dock.paddingHorizontal).toBe(CONV.composerFloatMin);
  });

  it('글은 입력창 안쪽 여백만큼 안에서 시작한다 — 대화 컴포저의 글 자리와 같다', () => {
    work();
    const input = flat(screen.getByTestId('work-chat-input').props.style);
    expect(input.paddingVertical).toBe(CONV.composerTextInset);
  });
});

describe('알약이 화면 가장자리에서 뜬 거리 — Buzz 만큼, 글 칸이 모자라면 줄어든다', () => {
  const AX_XXL = 3.143;

  it('글 칸이 남는 폭에서는 Buzz 값이다', () => {
    // 글 칸 바닥(258) + 108 + 2 × 40 = 446 이상이면 Buzz 값 그대로다.
    const enough = CONV.composerTextMin + COMPOSER_CHROME_X + 2 * CONV.composerFloatMax;
    expect(composerFloat(enough, 1)).toBe(CONV.composerFloatMax);
    expect(composerFloat(enough + 100, 1)).toBe(CONV.composerFloatMax);
    expect(composerFloat(enough - 2, 1)).toBe(CONV.composerFloatMax - 1);
  });

  it('글 칸이 바닥 아래로 내려가려 하면 그만큼 줄고, 그때도 글 칸은 바닥을 지킨다', () => {
    for (const width of [320, 340, 360, 375, 390, 393, 402, 430]) {
      for (const fontScale of [0.823, 1, 1.118, 1.235, 1.353]) {
        const float = composerFloat(width, fontScale);
        expect([width, fontScale, float >= CONV.composerFloatMin]).toEqual([width, fontScale, true]);
        expect([width, fontScale, float <= CONV.composerFloatMax]).toEqual([width, fontScale, true]);
        // 바닥에 닿지 않은 자리(= 줄어든 자리)에서는 글 칸이 정확히 바닥 이상이다.
        if (float > CONV.composerFloatMin && float < CONV.composerFloatMax) {
          expect(composerTextColumn(width, fontScale)).toBeGreaterThanOrEqual(
            CONV.composerTextMin * fontScale,
          );
        }
      }
    }
  });

  it('창이 좁아질수록·글자가 커질수록 거리는 줄기만 한다', () => {
    let previous = Infinity;
    for (let width = 430; width >= 280; width -= 1) {
      const float = composerFloat(width, 1);
      expect(float).toBeLessThanOrEqual(previous);
      previous = float;
    }
    previous = Infinity;
    for (const fontScale of [0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571]) {
      const float = composerFloat(393, fontScale);
      expect(float).toBeLessThanOrEqual(previous);
      previous = float;
    }
  });

  it('접근성 큰 글자에서는 옛 값(12)까지 내려온다', () => {
    expect(composerFloat(393, AX_XXL)).toBe(CONV.composerFloatMin);
    expect(composerFloat(375, AX_XXL)).toBe(CONV.composerFloatMin);
  });

  it('렌더가 그 식을 읽는다 — 스타일시트에 못 박히지 않는다', () => {
    for (const [width, fontScale] of [
      [402, 1],
      [440, 1],
      [393, 2.143],
    ] as const) {
      setWindow({width, fontScale});
      const view = composer();
      const pill = flat(screen.getByTestId('composer-pill').props.style);
      expect([width, fontScale, pill.marginHorizontal]).toEqual([
        width,
        fontScale,
        composerFloat(width, fontScale),
      ]);
      view.unmount();
    }
  });

  it('실측 폭 표 — PR 본문에 적은 숫자가 식에서 나온다', () => {
    // [창 폭, 뜬 거리, 글 칸] @ 글자 배수 1. 아이폰 16 Pro·17(402) · 15·16·17 기본(393) ·
    // 14·15 기본(390) · SE 3세대(375) · Pro Max(440). 글 칸 = 폭 − 2 × 거리 − 108.
    const table = [402, 393, 390, 375, 440].map(width => [
      width,
      composerFloat(width, 1),
      composerTextColumn(width, 1),
    ]);
    expect(table).toEqual([
      [402, 18, 258],
      [393, 13, 259],
      [390, 12, 258],
      [375, 12, 243],
      [440, 37, 258],
    ]);
  });

  it('글 칸 바닥은 가장 긴 기본 에이전트 안내 문장이 한 줄에 드는 폭이다', () => {
    // 코어 `composerCopy.ts` 폭표(폰 16pt): hermes 256.0 이 가장 길다. 그보다 좁아지면 빈 알약이
    // 두 줄로 자란다. 이 단정은 바닥을 낮추는 사람이 그 거래를 알고 낮추게 한다.
    const LONGEST_DEFAULT_AGENT_SENTENCE = 256.0;
    expect(CONV.composerTextMin).toBeGreaterThanOrEqual(LONGEST_DEFAULT_AGENT_SENTENCE);
    expect(CONV.composerTextMin).toBeLessThan(LONGEST_DEFAULT_AGENT_SENTENCE + 4);
  });
});

describe('흐린 보내기 원 — 알약 위에서 또렷하고, 두 스킴이 같은 위계다', () => {
  // 알약의 바탕은 유리(틴트 위 블러)라 정확한 값이 없다. 가장 가까운 불투명 대역인 `surface` 를
  // 바탕으로 잰다 — 라이트는 더 밝은 쪽, 다크는 더 어두운 쪽이라 둘 다 어림이지만 방향이 같다.
  for (const [name, palette] of [
    ['라이트', lightPalette],
    ['다크', darkPalette],
  ] as const) {
    it(`${name}: 원이 바탕 위 3:1 이상, 글리프가 원 위 3:1 이상`, () => {
      expect(contrast(palette.textFaint, palette.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.onPrimary, palette.textFaint)).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: 옛 값(surfaceMuted)은 1.5:1 도 못 됐다 — 회귀 표식`, () => {
      expect(contrast(palette.surfaceMuted, palette.surface)).toBeLessThan(1.5);
    });
  }

  it('보낼 수 없을 때 원이 textFaint, 보낼 수 있으면 잉크다', () => {
    composer();
    const idle = flat(screen.getByTestId('composer-send').props.style);
    expect(idle.backgroundColor).toBe(darkPalette.textFaint);
    fireEvent.changeText(screen.getByTestId('composer-input'), '보낼 글');
    const live = flat(screen.getByTestId('composer-send').props.style);
    expect(live.backgroundColor).toBe(darkPalette.primary);
  });

  it('글리프는 두 상태에서 같은 색이다 — 같은 버튼의 흐린 판', () => {
    composer();
    const glyph = () => {
      const send = screen.getByTestId('composer-send');
      const image = send.findByType(Image);
      return flat(image.props.style).tintColor;
    };
    const idle = glyph();
    fireEvent.changeText(screen.getByTestId('composer-input'), '보낼 글');
    expect(glyph()).toBe(idle);
    expect(idle).toBe(darkPalette.onPrimary);
  });
});

describe('도크 산수는 실제 알약을 읽는다', () => {
  it('안쪽 줄 위아래 여백 × 2 + 도크 위 여백 = 입력창·시트 말고 도크가 지는 세로', () => {
    // `composerColumnBudget` 이 내는 dockChrome 은 상수가 아니라 이 식이다.
    const padY = CONV.composerGap - (TOUCH_TARGET - CONV.composerCircle) / 2;
    expect(composerColumnBudget(1, 874).dockChrome).toBe(padY * 2 + space.sm);
  });
});
