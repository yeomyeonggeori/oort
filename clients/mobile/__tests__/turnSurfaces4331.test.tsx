import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {line} from '../src/design/tokens';

// =============================================================================
// 에이전트 활동 줄이 입력하는 동안 대화를 흔들지 않는다 (#4331)
//
// 실기(3053): 「대기 1번째 17시간째 기다려요 · 중단」 줄이 입력창 위에 서 있는 DM. 이 줄의 높이가 **글자에 따라** 1~2pt 달라졌고
// (시뮬레이터 실측: 「59분째」→「1시간째」에서 57→56, 줄 높이를 고정만 해 봐도 58→56), 그 높이는 도크의 일부라 목록의 보이는 창이
// 그만큼 움직였다. 활동 줄이 도크의 **흐름 안**에 있다는 것도 같은 보증의 한 반쪽이다 — 목록이 도크 윗면에서 끝나므로 마지막 행은
// 줄 위에 온전히 선다.
//
// 제스트에는 레이아웃이 없다. 높이 자체는 못 재고, 이 파일은 그 높이를 **글자와 무관하게 만드는 메커니즘**(가운데 맞춤 · 고정 줄 높이)과
// **흐름 안 배치**를 잠근다. 높이의 숫자는 `measure/steady.tsx` 의 `tick` 장면(시뮬레이터)이 잰다.
// =============================================================================

const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHANNEL = 'cccccccc-1111-4111-8111-cccccccccccc';
const NOW = 1_760_000_000_000;

const DIRECTORY = makeDirectory([
  {
    id: AGENT,
    workspaceId: 'ws',
    kind: 'agent',
    status: 'active',
    displayName: 'hermes',
    handle: 'hermes',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember,
]);

const QUEUED: AgentWorkingSignal = {
  memberId: AGENT,
  channelId: CHANNEL,
  state: 'queued',
  source: 'run',
  runId: 'A2222222-2222-4222-8222-A22222222222',
  headlines: [],
  lastActivityAtMs: NOW,
  server: {phase: 'queued', leaseState: 'none', queuePosition: 1, aheadTotal: 0, queuedAtMs: NOW - 17 * 3_600_000},
};

function bar() {
  return (
    <AgentActivityBar
      turns={[QUEUED]}
      directory={DIRECTORY}
      nowMs={NOW}
      live
      renderStop={() => <View testID="stop-slot" />}
    />
  );
}

type Node = ReturnType<typeof screen.getByTestId>;

const flat = (node: Node) =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;

afterEach(() => {
  cleanup();
});

describe('활동 줄의 높이는 글자와 무관하다 (#4331)', () => {
  it('줄은 가운데 맞춤이다 — 기준선 맞춤이면 줄 높이가 글자의 기준선에 따라 달라졌다', () => {
    render(bar());
    const row = screen.getByTestId(`composer-working-row-${AGENT}`);
    expect(flat(row).alignItems).toBe('center');
  });

  it('줄의 글자들은 줄 높이를 고정으로 든다 — 글자에 따라 줄 상자가 달라지지 않는다', () => {
    render(bar());
    // 이름 + 단계 글자(「: 아직 받지 않았어요」 — 5분을 넘은 사람 요청, #4285)와 근거 글자(「17시간째 기다려요」)가 갱신되는 두 글자다.
    const main = screen.getByLabelText('hermes: 아직 받지 않았어요');
    const detail = screen.getByTestId('activity-detail');
    expect(flat(main).lineHeight).toBe(line.meta);
    expect(flat(detail).lineHeight).toBe(line.meta);
  });
});

describe('활동 줄은 도크의 흐름 안에 선다 (#4331)', () => {
  it('목록 쪽이 아니라 도크 안이고, 흐름 밖(absolute)·음수 여백이 아니다', () => {
    render(<ConversationLayout list={<View testID="list-child" />} composer={bar()} />);
    const target = screen.getByTestId('composer-working');
    const chain: Node[] = [];
    for (let node: Node | null = target; node !== null; node = node.parent) {
      chain.push(node);
    }
    const ids = chain.map(node => node.props.testID).filter(Boolean);
    expect(ids).toContain('composer-dock');
    expect(ids).not.toContain('conversation-list');
    // 도크 안쪽으로 올라가는 동안 흐름을 떠나거나 위로 겹치는 스타일이 없다.
    const dockAt = chain.findIndex(node => node.props.testID === 'composer-dock');
    for (const node of chain.slice(0, dockAt + 1)) {
      const style = flat(node);
      expect(style.position).not.toBe('absolute');
      expect(Number(style.marginTop ?? 0)).toBeGreaterThanOrEqual(0);
    }
  });
});
