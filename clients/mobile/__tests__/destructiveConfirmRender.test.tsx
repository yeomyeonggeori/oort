import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';

import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {StopTurnControl} from '../src/features/agents/StopTurnControl';
import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {darkPalette, lightPalette, type Palette} from '../src/design/tokens';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 확정 버튼이 **화면에서** 무엇으로 칠해지는가 (#1210 D2).
//
// `paletteContrast.test.ts` 는 토큰의 숫자를 지고, `fillTokens.test.ts` 는 소스가
// 어느 이름을 적었는지를 진다. 둘 다 초록이면서 화면이 틀릴 수 있는 자리가 하나
// 남는다: 스타일이 실제로 그 버튼에 **닿는가**. 감사(§B-4 ②)가 잡은 결함이 정확히
// 그 층에서 살았다 — 팔레트는 옳았고, 이름만 하나 잘못 붙어 있었다.
//
// 그래서 여기서는 렌더 트리에서 평평하게 편 스타일을 읽는다. 두 스킴 모두에서
// 읽는 이유는 이 결함이 다크에서 5배 나빴기 때문이다: 한 스킴만 재면 그 사실이
// 단정에 들어오지 않는다.
//
// 시각이 아니라 **관계**를 잰다. 값 자체는 웹 정본에서 오고 그 대조는 이미 다른
// 스위트가 하므로, 여기서 못 박는 것은 「거부 채움 ≠ 테두리 토큰」과 「거부 라벨은
// 그 채움에 매인 잉크」다.
// =============================================================================

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

function client(): QueryClient {
  return new QueryClient({defaultOptions: {queries: {retry: false, enabled: false}}});
}

function draw(scheme: ColorScheme, node: React.ReactNode): void {
  render(
    <FixedScheme scheme={scheme}>
      <QueryClientProvider client={client()}>
        <SessionProvider member={SELF}>{node}</SessionProvider>
      </QueryClientProvider>
    </FixedScheme>,
  );
}

/** 렌더 트리의 style 을 평평하게 편 것. 배열·중첩을 그대로 받는다. */
function flat(testID: string): Record<string, unknown> {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<
    string,
    unknown
  >;
}

afterEach(cleanup);

describe.each(SCHEMES)('%s — 확정 버튼의 실제 스타일', (scheme, palette) => {
  it('거부 확정은 파괴 채움으로 칠해진다 (테두리 토큰이 아니라)', () => {
    draw(
      scheme,
      <ApprovalDecision
        approvalId="ap-1"
        initialArmed="reject"
        onSettled={() => {}}
        testIDPrefix="row"
      />,
    );
    expect(flat('row-commit').backgroundColor).toBe(palette.dangerFill);
    // 그리고 **그것이 테두리 토큰이 아니다.** 이 줄이 회귀의 이름이다.
    expect(flat('row-commit').backgroundColor).not.toBe(palette.dangerBorder);
  });

  it('승인 확정은 주 액션 채움 그대로다 (이 수리가 건드리지 않은 쪽)', () => {
    draw(
      scheme,
      <ApprovalDecision
        approvalId="ap-1"
        initialArmed="approve"
        onSettled={() => {}}
        testIDPrefix="row"
      />,
    );
    expect(flat('row-commit').backgroundColor).toBe(palette.accent);
  });

  it('턴 중단 확정도 같은 파괴 채움을 든다', () => {
    draw(
      scheme,
      <StopTurnControl
        runId="run-1"
        agentName="김인턴"
        initialArmed
        onOutcome={() => {}}
        testIDPrefix="turn"
      />,
    );
    expect(flat('turn-commit').backgroundColor).toBe(palette.dangerFill);
    expect(flat('turn-commit').backgroundColor).not.toBe(palette.dangerBorder);
  });
});
