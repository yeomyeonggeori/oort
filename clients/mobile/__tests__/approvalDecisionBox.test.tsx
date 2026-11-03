import type {SignalChoice} from '@momo/core/design/appearance';
import {contrast} from '@momo/core/design/color';
import {SIGNAL_PRESET_IDS} from '@momo/core/design/signal';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';

import {resolveAppearance} from '../src/design/appearanceState';
import {PrimaryButton} from '../src/design/atoms';
import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {FixedScheme} from '../src/design/theme';
import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 인박스 승인 카드의 「승인」(`ApprovalDecision` 의 `box` 모양)은 잉크이고, 잠겨도 라벨이 읽힌다
// (#5134, #5100 후속).
//
// 옛 판은 이랬다: 알약·요청 모양(`shape="pill"`·`"request"`, 대화 안 에이전트 카드)과 셸 주 단추
// (`PrimaryButton`, #5100)는 잉크(`primary`)인데 상자 모양만 승인 채움이 신호색(`accent`)이었다.
// 한 앱에서 승인 단추가 둘로 갈렸고, 커스텀 강조색(ADR-0174)을 고르면 인박스의 「승인」만 그 색으로
// 바뀌었다(ADR-0189 D3 「주 버튼 검정」이 막으려던 바로 그것). 눌림도 `accentPressed` 로 채움을
// 갈아 끼웠다.
//
// 상자는 셸 주 단추의 세 얼굴을 그대로 입는다 — 쉼 = 잉크 + `onPrimary`, 잠김 = `surfaceMuted` +
// `textMuted` 라벨(흐리지 않음), 진행(자기 결정이 나가는 중) = 잉크 유지, 눌림 = 흐림만 낮춤.
// 아래는 그 답을 **그려진 값**으로 잰다 — 소스의 이름이 아니라 렌더된 style 의 색 역할·글자 대비·
// 눌림 흐림이다. 테마 3 × 모드 2 × 신호 8(기본·프리셋 4·커스텀 3) = 48조합을 돈다.
// 커스텀 강조색이 이 단추를 못 칠한다는 증거는 신호가 바뀐 조합에서도 채움이 그대로라는 데서 나온다.
//
// 이 파일이 재지 못하는 것: 실제 화면의 픽셀(잠긴 칸이 카드 위에서 보이는 정도 등)과 눌림의 체감 —
// 캡처와 design-review 의 몫이다. 잠긴 채움 `surfaceMuted` 는 바탕 위에서 1.0:1 에 가깝다
// (`docs/design-system/README.md` §3.3: 보조 채움은 채움 대비를 재지 않고 글자 라벨이 컨트롤을
// 식별시킨다) — 그래서 이 파일은 **라벨**의 대비를 잰다.
// =============================================================================

jest.setTimeout(60_000);

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

type Style = Record<string, unknown>;

/** 본문 글자 AA. 잠긴 컨트롤은 WCAG 1.4.3 의 예외지만 이 앱은 「못 누르는 버튼도 라벨은 읽혀야 한다」를 정했다. */
const MIN = 4.5;

const SIGNALS: ReadonlyArray<readonly [string, SignalChoice]> = [
  ['기본', null],
  ...SIGNAL_PRESET_IDS.map(id => [`프리셋 ${id}`, {preset: id}] as const),
  ['커스텀 #3A6BD8', {custom: '#3A6BD8'}],
  ['커스텀 #FFFFFF(보정)', {custom: '#FFFFFF'}],
  ['커스텀 #FFE600(순노랑)', {custom: '#FFE600'}],
];

const COMBOS = DS2_COMBOS.flatMap(([theme, mode]) =>
  SIGNALS.map(([signalLabel, signal]) => ({
    key: `${theme}/${mode} · ${signalLabel}`,
    group: `${theme}/${mode}`,
    theme,
    mode,
    signal,
    palette: resolveAppearance(theme, mode, signal).palette,
  })),
);

type Combo = (typeof COMBOS)[number];

/** 렌더된 Pressable 의 style 함수를 찾아 `pressed` 로 부른다(`approvalDecisionContrast.test.tsx` 와 같은 길). */
function pressableStyle(testID: string, pressed: boolean): Style {
  type Node = {props: Record<string, any>; parent: Node | null};
  let node: Node | null = screen.getByTestId(testID) as unknown as Node;
  while (node !== null && typeof node.props.style !== 'function') {
    node = node.parent;
  }
  if (node === null) throw new Error(`${testID}: Pressable style 함수를 찾지 못했다`);
  return StyleSheet.flatten(node.props.style({pressed})) as Style;
}

function labelNode(testID: string) {
  return within(screen.getByTestId(testID)).getByText(/./);
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** 흐림을 바탕 위에 합성한다. RN 은 opacity 를 자식까지 한 장으로 합성한다. */
function over(top: string, under: string, alpha: number): string {
  const a = rgb(top);
  const b = rgb(under);
  const mixed = [0, 1, 2].map(i => Math.round(a[i] * alpha + b[i] * (1 - alpha)));
  return `#${mixed.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 바탕 위에 선 단추에서 글자와 채움이 실제로 만드는 대비(흐림 포함). */
function seenContrast(button: Style, ink: unknown, backdrop: string): number {
  const alpha = typeof button.opacity === 'number' ? button.opacity : 1;
  return contrast(
    over(String(ink), backdrop, alpha),
    over(String(button.backgroundColor), backdrop, alpha),
  );
}

interface Face {
  rest: Style;
  pressed: Style;
  label: Style;
  text: string;
  state: {disabled?: boolean; busy?: boolean} | undefined;
}

interface Setup {
  shape?: 'box' | 'pill' | 'request';
  /** 승인할 수 없는 카드(사진이 아직 안 떴다 등). 거부는 계속 가능하다. */
  approveDisabled?: boolean;
  /** 안 풀리는 결정을 보내 둔 채로 읽는다 — 그 방향의 결정이 「나가는 중」이다. */
  press?: 'approve' | 'reject';
  /** 승인이 나가는 중에 승인이 막힌다 — 진행이 이겨야 한다. */
  blockApproveAfterPress?: boolean;
}

/** `ApprovalDecision` 하나를 한 조합에서 그려 승인 단추의 모양을 읽는다. */
async function drawn(combo: Combo, setup: Setup = {}): Promise<Face> {
  mockDecide.mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient({defaultOptions: {queries: {retry: false, enabled: false}}});
  const tree = (approveDisabled: boolean) => (
    <FixedScheme scheme={combo.mode} theme={combo.theme} signal={combo.signal}>
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <ApprovalDecision
            approvalId="ap-1"
            onSettled={() => {}}
            testIDPrefix="row"
            shape={setup.shape}
            approveDisabled={approveDisabled}
          />
        </SessionProvider>
      </QueryClientProvider>
    </FixedScheme>
  );
  const view = render(tree(setup.approveDisabled === true));
  if (setup.press !== undefined) {
    await act(async () => {
      fireEvent.press(screen.getByTestId(`row-${setup.press}`));
    });
  }
  if (setup.blockApproveAfterPress === true) view.rerender(tree(true));
  const label = labelNode('row-approve');
  const out: Face = {
    rest: pressableStyle('row-approve', false),
    pressed: pressableStyle('row-approve', true),
    label: StyleSheet.flatten(label.props.style) as Style,
    text: String(label.props.children),
    state: screen.getByTestId('row-approve').props.accessibilityState,
  };
  view.unmount();
  return out;
}

/** 셸 주 단추(`PrimaryButton`) 하나를 같은 조합에서 그려 눌린 모양을 읽는다 — 상자가 따라야 할 값. */
function primaryButtonPressed(combo: Combo): Style {
  const view = render(
    <FixedScheme scheme={combo.mode} theme={combo.theme} signal={combo.signal}>
      <PrimaryButton label="다음" onPress={() => {}} testID="btn" />
    </FixedScheme>,
  );
  const pressed = pressableStyle('btn', true);
  view.unmount();
  return pressed;
}

beforeEach(() => mockDecide.mockReset());
afterEach(cleanup);

describe('ApprovalDecision box — 승인은 잉크, 잠겨도 라벨이 읽힌다 (#5134)', () => {
  it('① 쉬는 승인은 잉크다 — 신호색도 커스텀 강조색도 칠하지 않고, 알약·요청과 같은 채움이다', async () => {
    const wrong: string[] = [];
    const accents = new Map<string, Set<string>>();
    for (const combo of COMBOS) {
      const {palette} = combo;
      const box = await drawn(combo);
      if (box.rest.backgroundColor !== palette.primary) {
        wrong.push(`${combo.key}: 채움 ${String(box.rest.backgroundColor)} ≠ primary ${palette.primary}`);
      }
      if (box.rest.backgroundColor === palette.accent) {
        wrong.push(`${combo.key}: 채움이 신호색(accent) ${palette.accent}`);
      }
      if (box.label.color !== palette.onPrimary) {
        wrong.push(`${combo.key}: 글자 ${String(box.label.color)} ≠ onPrimary ${palette.onPrimary}`);
      }
      const ratio = contrast(String(box.label.color), String(box.rest.backgroundColor));
      if (!(ratio >= MIN)) wrong.push(`${combo.key}: 라벨 대비 ${ratio.toFixed(2)} < ${MIN}`);
      // 한 앱에서 승인 단추 색 통일: 알약·요청이 입은 채움과 같아야 한다.
      for (const shape of ['pill', 'request'] as const) {
        const other = await drawn(combo, {shape});
        if (other.rest.backgroundColor !== box.rest.backgroundColor) {
          wrong.push(
            `${combo.key}: 상자 채움 ${String(box.rest.backgroundColor)} ≠ ${shape} 채움 ${String(other.rest.backgroundColor)}`,
          );
        }
      }
      accents.set(combo.group, (accents.get(combo.group) ?? new Set()).add(palette.accent));
    }
    expect(wrong).toEqual([]);
    // 이 걸음이 헛돌지 않는다: 신호를 바꾸면 accent 는 실제로 움직였다. 움직인 조합들에서도 채움은 그대로였다.
    expect([...accents].filter(([, seen]) => seen.size < 2).map(([group]) => group)).toEqual([]);
  });

  it('② 잠기면 옅은 칸 위에서도 라벨이 읽힌다 — 승인할 수 없을 때도, 거부가 나가는 중일 때도', async () => {
    const CAUSES: ReadonlyArray<readonly [string, Setup]> = [
      ['승인할 수 없다', {approveDisabled: true}],
      ['거부가 나가는 중', {press: 'reject'}],
    ];
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      for (const [cause, setup] of CAUSES) {
        const tag = `${combo.key} (${cause})`;
        const {rest, pressed, label, state} = await drawn(combo, setup);
        if (rest.backgroundColor !== palette.surfaceMuted) {
          wrong.push(`${tag}: 채움 ${String(rest.backgroundColor)} ≠ surfaceMuted ${palette.surfaceMuted}`);
        }
        if (label.color !== palette.textMuted) {
          wrong.push(`${tag}: 글자 ${String(label.color)} ≠ textMuted ${palette.textMuted}`);
        }
        // 흐리지 않는다 — 옅은 칸 위 라벨이 0.6 흐림 안에서 4.5:1 밑으로 내려가던 길을 막는다.
        if ((rest.opacity ?? 1) !== 1) wrong.push(`${tag}: 잠긴 승인이 흐려 있다 ${String(rest.opacity)}`);
        for (const [name, backdrop] of [
          ['bg', palette.bg],
          ['surface', palette.surface],
          ['sheet', palette.sheet],
        ] as const) {
          const ratio = seenContrast(rest, label.color, backdrop);
          if (!(ratio >= MIN)) wrong.push(`${tag} · ${name} 위: 라벨 대비 ${ratio.toFixed(2)} < ${MIN}`);
        }
        if (state?.disabled !== true || state.busy === true) {
          wrong.push(`${tag}: 보조기술 상태 ${JSON.stringify(state)} (기대 잠김, 진행 아님)`);
        }
        // 눌러도 소용없는 단추는 눌림 모양도 입지 않는다.
        if (pressed.opacity !== rest.opacity || pressed.backgroundColor !== rest.backgroundColor) {
          wrong.push(`${tag}: 잠긴 승인이 눌림 모양을 입는다`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('③ 자기 결정이 나가는 중이면 잉크가 남아 「보내는 중」이 읽힌다 — 승인이 막혀도 진행이 이긴다', async () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      for (const [cause, setup] of [
        ['보내는 중', {press: 'approve'}],
        ['보내는 중 + 승인 막힘', {press: 'approve', blockApproveAfterPress: true}],
      ] as const) {
        const tag = `${combo.key} (${cause})`;
        const {rest, pressed, label, text, state} = await drawn(combo, setup);
        if (text !== '보내는 중') wrong.push(`${tag}: 낱말 「${text}」 (기대 「보내는 중」)`);
        if (rest.backgroundColor !== palette.primary) {
          wrong.push(`${tag}: 채움 ${String(rest.backgroundColor)} ≠ primary ${palette.primary}`);
        }
        if (label.color !== palette.onPrimary) {
          wrong.push(`${tag}: 글자 ${String(label.color)} ≠ onPrimary ${palette.onPrimary}`);
        }
        if ((rest.opacity ?? 1) !== 1) wrong.push(`${tag}: 진행 중인 승인이 흐려 있다 ${String(rest.opacity)}`);
        const ratio = contrast(String(label.color), String(rest.backgroundColor));
        if (!(ratio >= MIN)) wrong.push(`${tag}: 낱말 대비 ${ratio.toFixed(2)} < ${MIN}`);
        if (state?.disabled !== true || state.busy !== true) {
          wrong.push(`${tag}: 보조기술 상태 ${JSON.stringify(state)} (기대 잠김+진행)`);
        }
        if (pressed.opacity !== rest.opacity || pressed.backgroundColor !== rest.backgroundColor) {
          wrong.push(`${tag}: 진행 중인 승인이 눌림 모양을 입는다`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('④ 눌리면 채움을 갈아 끼우지 않고 흐림만 낮춘다 — `PrimaryButton` 과 같은 값이고 바탕 위에서도 읽힌다', async () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      const {pressed, label} = await drawn(combo);
      if (pressed.backgroundColor !== palette.primary) {
        wrong.push(`${combo.key}: 눌린 채움 ${String(pressed.backgroundColor)} ≠ primary ${palette.primary}`);
      }
      const alpha = pressed.opacity;
      if (typeof alpha !== 'number' || alpha >= 1 || alpha < 0.5) {
        wrong.push(`${combo.key}: 눌림 흐림 ${String(alpha)} 은 (0.5, 1) 밖이다`);
        continue;
      }
      // 「PrimaryButton 규칙을 따른다」를 이름이 아니라 값으로: 같은 조합에서 그 부품을 그려 눌림 흐림을 맞댄다.
      const shell = primaryButtonPressed(combo).opacity;
      if (alpha !== shell) wrong.push(`${combo.key}: 눌림 흐림 ${alpha} ≠ PrimaryButton ${String(shell)}`);
      for (const [name, backdrop] of [
        ['bg', palette.bg],
        ['surface', palette.surface],
        ['sheet', palette.sheet],
      ] as const) {
        const ratio = seenContrast(pressed, label.color, backdrop);
        if (!(ratio >= MIN)) wrong.push(`${combo.key} · ${name} 위: 대비 ${ratio.toFixed(2)} < ${MIN}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
