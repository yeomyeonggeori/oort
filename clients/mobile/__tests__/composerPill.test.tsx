import {measureComposerText} from './fixtures/composerMeasurement';
import {AttachmentTray} from '../src/features/attachments/AttachmentTray';
import {QuoteDraftBar} from '../src/features/conversation/Quote';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {contrast} from '@momo/core/design/color';
import {cleanup, fireEvent, render, screen, waitFor} from './fixtures/darkWorld';
import React from 'react';
import {AccessibilityInfo, Dimensions, Image, StyleSheet} from 'react-native';

import {
  resetBlurSupportForTests,
  resetLiquidGlassSupportForTests,
} from '../src/design/glass';
import {darkPalette, ds2Radius, lightPalette, line, slopTo, space, TOUCH_TARGET} from '../src/design/tokens';
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
/** 프리셋의 `AccessibilityInfo` 는 이미 `jest.fn` 이다(`shellChrome.test.tsx` 와 같은 길). */
const a11y = AccessibilityInfo as unknown as {isReduceTransparencyEnabled: jest.Mock};

beforeEach(() => {
  setWindow({fontScale: 1});
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  cleanup();
  resetLiquidGlassSupportForTests();
  resetBlurSupportForTests();
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

/** 알약(선)과 그 안쪽 줄(여백) — 둘을 합쳐야 원이 **바깥 가장자리**에서 떨어진 거리가 나온다. */
function pillAndBar() {
  const pill = flat(screen.getByTestId('composer-pill').props.style);
  const bar = ancestorStyle(
    screen.getByTestId('composer-attach'),
    // 안쪽 줄은 선(알약)과 달리 가로·세로 여백을 함께 든 첫 조상이다(#4305: 더는 row 가 아니다 — 두 원이
    // 알약 바닥에 절대 배치로 서고 글 칸·도구 줄이 세로로 쌓인다).
    style => style.paddingHorizontal !== undefined && style.paddingVertical !== undefined,
  );
  return {pill, bar, edge: (pill.borderWidth ?? 0) as number};
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
    const {bar, edge} = pillAndBar();
    // 좌우: 알약의 선 + 안쪽 줄의 가로 여백이 곧 바깥 가장자리에서 원까지.
    expect(edge + (bar.paddingHorizontal as number)).toBeCloseTo(CONV.composerGap, 10);
    // 위아래: 선 + 안쪽 줄의 세로 여백 + 원이 입력창 한 줄(44) 안에서 받는 여유 = 같은 값.
    for (const id of ['composer-attach', 'composer-send']) {
      const circle = flat(screen.getByTestId(id).props.style);
      // 원은 알약 바닥·옆에 절대 배치다: 안쪽 가장자리에서 `bottom` 만큼 위, 선이 그 바깥에 더해진다.
      expect(circle.position).toBe('absolute');
      expect([id, edge + (circle.bottom as number)]).toEqual([id, CONV.composerGap]);
    }
    const attach = flat(screen.getByTestId('composer-attach').props.style);
    const send = flat(screen.getByTestId('composer-send').props.style);
    expect(edge + (attach.left as number)).toBeCloseTo(CONV.composerGap, 10);
    expect(edge + (send.right as number)).toBeCloseTo(CONV.composerGap, 10);
  });

  it('한 줄 알약의 높이가 2 × 반경이다 — 입력창 44 + 선 + 위아래 안쪽 여백', () => {
    composer();
    const {bar, edge} = pillAndBar();
    const input = flat(screen.getByTestId('composer-input').props.style);
    expect(input.minHeight).toBe(TOUCH_TARGET);
    expect(
      TOUCH_TARGET + 2 * (edge + (bar.paddingVertical as number)),
    ).toBeCloseTo(2 * CONV.composerRadius, 10);
  });

  it('원은 글이 여러 줄로 자라도 아래에 남는다 — 아래·옆 여백이 한 줄 때와 같다', () => {
    composer();
    // 원이 알약 바닥에 절대 배치(`bottom`)이면 아래 여백은 줄 수와 무관하고, 펼침(도구 줄이 생긴 뒤)에서도
    // 같은 자리다 — 「+ 가 왼쪽 아래」(#4305).
    const circles = () =>
      ['composer-attach', 'composer-send'].map(id => {
        const style = flat(screen.getByTestId(id).props.style);
        return [style.position, style.bottom, style.left, style.right];
      });
    const before = pillAndBar();
    const circlesBefore = circles();
    fireEvent.changeText(screen.getByTestId('composer-input'), '가\n나\n다\n라');
    const grown = pillAndBar();
    expect(circles()).toEqual(circlesBefore);
    expect(grown.bar.paddingHorizontal).toBe(before.bar.paddingHorizontal);
    expect(grown.bar.paddingVertical).toBe(before.bar.paddingVertical);
  });

  it('재료마다 선이 다르다 — 리퀴드는 투명(두께는 남김), 블러·불투명은 경계로 보인다', async () => {
    // 이 환경 기본(블러 모듈 없음 → 94% 대체)은 선이 보인다.
    const first = composer();
    const fallback = pillAndBar();
    expect(fallback.pill.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(fallback.pill.borderColor).toBe(darkPalette.glassLine);
    first.unmount();

    // iOS 26: 네이티브 가장자리가 따로 있어 선은 투명이고 **두께는 같다**(산수가 안 움직인다).
    resetLiquidGlassSupportForTests(true);
    const second = composer();
    const liquid = pillAndBar();
    expect(screen.getByTestId('composer-pill-liquid')).toBeTruthy();
    expect(liquid.pill.borderColor).toBe('transparent');
    expect(liquid.pill.borderWidth).toBe(fallback.pill.borderWidth);
    second.unmount();

    // 투명도 줄이기: 리퀴드여도 불투명 surface — 알약은 다크에서 바닥과 1.1:1 이라 선이 경계다.
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    composer();
    await waitFor(() => expect(screen.getByTestId('composer-pill-opaque')).toBeTruthy());
    const opaque = pillAndBar();
    expect(opaque.pill.borderColor).toBe(darkPalette.glassLine);
  });

  it('그림자는 rest 다 — Buzz 의 부드러운 그림자(float 은 세 배 짙었다)', () => {
    composer();
    const {pill} = pillAndBar();
    expect(pill.boxShadow).toBe(darkPalette.elevationRest);
    expect(pill.boxShadow).not.toBe(darkPalette.elevationFloat);
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

  it('#4790 작업 대화도 네 줄 뒤 스크롤하고 큰 글자 첫 줄이 잘리지 않는다', () => {
    for (const fontScale of [1, 1.786, 2.143, 2.643, 3.143, 3.571]) {
      setWindow({fontScale});
      const view = work();
      const input = () => screen.getByTestId('work-chat-input');
      expect(flat(input().props.style).minHeight).toBeGreaterThanOrEqual(Math.ceil(line.body * fontScale) + 18);
      fireEvent.changeText(input(), '긴 지시'.repeat(100));
      measureComposerText(1000, true);
      expect(flat(input().props.style).height).toBe(4 * line.body * fontScale + 18);
      expect(input().props.scrollEnabled).toBe(true);
      expect(input().props.onContentSizeChange).toBeUndefined();
      fireEvent.changeText(input(), '');
      expect(input().props.scrollEnabled).toBe(false);
      fireEvent.changeText(input(), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄');
      expect(input().props.scrollEnabled).toBe(true);
      view.unmount();
    }
  });

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
    expect(dock.paddingHorizontal).toBe(CONV.workDockInset);
  });

  it('글은 입력창 안쪽 여백만큼 안에서 시작한다 — 대화 컴포저의 글 자리와 같다', () => {
    work();
    const input = flat(screen.getByTestId('work-chat-input').props.style);
    expect(input.paddingVertical).toBe(CONV.composerTextInset);
  });
});

describe('#4790 도크 8pt', () => {
  it('첨부 트레이와 인용 바도 알약의 8pt 가장자리에서 시작한다', () => {
    const tray = render(<AttachmentTray drafts={[]} pickerIssue="permission-denied"
      onRemove={() => {}} onRetry={() => {}} onClear={() => {}} />);
    expect(flat(screen.getByTestId('attachment-tray').props.style).paddingHorizontal).toBe(8);
    tray.unmount();
    render(<QuoteDraftBar block={{kind: 'unresolved', targetId: 'quoted', targetSeq: null}}
      directory={DIRECTORY} onCancel={() => {}} />);
    expect(flat(screen.getByTestId('quote-draft').props.style).paddingLeft).toBe(8);
    expect(flat(screen.getByTestId('quote-draft').props.style).paddingRight).toBe(8);
  });

  it('폭·글자 배수와 무관하게 입력창과 형제 줄이 8pt 선에 선다', () => {
    expect(CONV.composerDockInset).toBe(8);
    for (const width of [320, 375, 393, 402, 440]) {
      for (const fontScale of [1, 1.786, 2.643, 3.571]) {
        setWindow({width, fontScale});
        const view = render(<Composer recipient="place" channelLabel="긴-방-이름"
          directory={DIRECTORY} attachmentTarget={TARGET} offline dmHint="안내" onSend={() => {}} />);
        expect(composerFloat(width, fontScale)).toBe(8);
        expect(composerTextColumn(width, fontScale)).toBe(width - 16 - COMPOSER_CHROME_X);
        expect(flat(screen.getByTestId('composer-pill').props.style).marginHorizontal).toBe(8);
        for (const id of ['composer-offline', 'composer-dm-hint']) {
          expect(flat(screen.getByTestId(id).props.style).paddingHorizontal).toBe(8);
        }
        view.unmount();
      }
    }
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
    composer();
    const {bar, edge} = pillAndBar();
    const budget = composerColumnBudget(1, 874);
    expect(budget.dockChrome).toBeCloseTo(
      2 * (edge + (bar.paddingVertical as number)) + 44 + space.sm,
      10,
    );
    // 선 + 안쪽 줄 위아래 여백 = 5 라 도크 크롬은 18 이다 — 옛 알약은 16 이었다(#4179).
    expect(budget.dockChrome).toBe(62);
  });
});
