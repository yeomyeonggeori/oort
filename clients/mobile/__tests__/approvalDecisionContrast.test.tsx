import type {Member} from '@momo/core/lib/api';
import {contrast} from '@momo/core/design/color';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';

import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {darkPalette, lightPalette, type Palette} from '../src/design/tokens';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 누른 뒤에도 승인 버튼의 글자가 읽히는가 (#3852, #3829 design-review M4).
//
// 한 번 탭이 곧 결정이 된 뒤(#3819) 채움 승인 버튼은 세 얼굴을 갖는다 — 쉬는 때,
// 손가락이 닿아 있는 때, 「보내는 중」. 앞 판은 뒤의 둘에서 글자를 잃었다:
//
//   눌림     채움을 `surfacePressed`(옅은 회색)로 갈아 끼우면서 글자는 채움의 잉크
//            (`onAccent`/`onPrimary`, 흰색 계열)로 남았다 — 옅은 바탕 위 흰 글자.
//   보내는 중 두 버튼을 함께 `opacity: 0.6` 으로 흐렸다 — 지금 읽혀야 하는 낱말
//            「보내는 중」이 그 흐림 안에 있었다.
//
// 그래서 여기서는 렌더 트리의 실제 스타일을 읽어, 흐림(opacity)까지 카드 바탕 위에
// 합성한 뒤 글자 대비를 잰다. 4.5:1(본문 글자 기준)이 선이다.
// =============================================================================

const mockDecide = jest.fn();
jest.mock('@momo/core/features/timeline/approvalDecision', () => {
  const actual = jest.requireActual('@momo/core/features/timeline/approvalDecision');
  return {...actual, decideApproval: (...args: unknown[]) => mockDecide(...args)};
});

const WS = '22222222-2222-4222-8222-222222222222';
const SELF: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
} as Member;

const SCHEMES: ReadonlyArray<readonly [ColorScheme, Palette]> = [
  ['dark', darkPalette],
  ['light', lightPalette],
];
const SHAPES = ['box', 'pill'] as const;
const MIN = 4.5;

function draw(scheme: ColorScheme, shape: 'box' | 'pill'): void {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, enabled: false}},
  });
  render(
    <FixedScheme scheme={scheme}>
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <ApprovalDecision
            approvalId="ap-1"
            onSettled={() => {}}
            testIDPrefix="row"
            shape={shape}
          />
        </SessionProvider>
      </QueryClientProvider>
    </FixedScheme>,
  );
}

type Style = Record<string, unknown>;

/** 렌더된 Pressable 의 style 함수를 찾아 `pressed` 로 부른다. */
function pressableStyle(testID: string, pressed: boolean): Style {
  type Node = {props: Record<string, any>; parent: Node | null};
  let node: Node | null = screen.getByTestId(testID) as unknown as Node;
  while (node !== null && typeof node.props.style !== 'function') {
    node = node.parent;
  }
  if (node === null) throw new Error(`${testID}: Pressable style 함수를 찾지 못했다`);
  return StyleSheet.flatten(node.props.style({pressed})) as Style;
}

function labelStyle(testID: string): Style {
  const text = within(screen.getByTestId(testID)).getByText(/./);
  return StyleSheet.flatten(text.props.style) as Style;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** 흐림을 바탕 위에 합성한다. RN 은 opacity 를 자식까지 한 장으로 합성한다. */
function over(top: string, under: string, alpha: number): string {
  const a = rgb(top);
  const b = rgb(under);
  return hex([0, 1, 2].map(i => a[i] * alpha + b[i] * (1 - alpha)) as [number, number, number]);
}

/** 카드(surface) 위에 그려진 버튼에서 글자와 채움이 실제로 만드는 대비. */
function seenContrast(button: Style, label: Style, backdrop: string): number {
  const alpha = typeof button.opacity === 'number' ? button.opacity : 1;
  const fill = over(String(button.backgroundColor ?? backdrop), backdrop, alpha);
  const ink = over(String(label.color), backdrop, alpha);
  return contrast(ink, fill);
}

beforeEach(() => mockDecide.mockReset());
afterEach(cleanup);

describe.each(SCHEMES)('%s', (scheme, palette) => {
  describe.each(SHAPES)('%s 승인 버튼', shape => {
    it('쉬는 때 글자가 읽힌다', () => {
      draw(scheme, shape);
      const ratio = seenContrast(
        pressableStyle('row-approve', false),
        labelStyle('row-approve'),
        palette.surface,
      );
      expect(ratio).toBeGreaterThanOrEqual(MIN);
    });

    it('손가락이 닿아 있는 동안에도 글자가 읽힌다', () => {
      draw(scheme, shape);
      const pressed = pressableStyle('row-approve', true);
      // 채움이 살아 있다 — 옅은 눌림 회색으로 갈아 끼우지 않는다.
      expect(pressed.backgroundColor).not.toBe(palette.surfacePressed);
      const ratio = seenContrast(pressed, labelStyle('row-approve'), palette.surface);
      expect(ratio).toBeGreaterThanOrEqual(MIN);
    });

    it('「보내는 중」은 흐리지 않아 읽히고, 반대편 버튼만 잠긴 모양이 된다', async () => {
      mockDecide.mockImplementation(() => new Promise(() => {}));
      draw(scheme, shape);
      await act(async () => {
        fireEvent.press(screen.getByTestId('row-approve'));
      });
      expect(within(screen.getByTestId('row-approve')).getByText('보내는 중')).toBeTruthy();
      const sending = pressableStyle('row-approve', false);
      const ratio = seenContrast(sending, labelStyle('row-approve'), palette.surface);
      expect(ratio).toBeGreaterThanOrEqual(MIN);
      // 누르지 않은 쪽은 잠겼다는 것을 모양으로 말한다.
      expect(pressableStyle('row-reject', false).opacity).toBeLessThan(1);
    });
  });

  it('거부를 보내는 중이면 「보내는 중」이 그 버튼에서 읽힌다', async () => {
    mockDecide.mockImplementation(() => new Promise(() => {}));
    draw(scheme, 'pill');
    await act(async () => {
      fireEvent.press(screen.getByTestId('row-reject'));
    });
    const ratio = seenContrast(
      pressableStyle('row-reject', false),
      labelStyle('row-reject'),
      palette.surface,
    );
    expect(ratio).toBeGreaterThanOrEqual(MIN);
  });
});
