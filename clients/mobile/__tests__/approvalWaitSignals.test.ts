import type {Approval} from '@momo/core/lib/api';
import {
  IDLE_CUTOFF_MS,
  type AgentWorkingSignal,
  type ApprovalWait,
} from '@momo/core/features/agents/workingSignal';

import {
  agentTurnsInChannel,
  withApprovalWaits,
} from '../src/features/agents/workingSignal';
import {workspaceApprovalWaits} from '../src/features/conversation/approvalGate';

// =============================================================================
// 승인 원장을 열린 턴 **전체**(채널 너머)에 덮는 두 재료 (#5085).
//
// 대화 화면은 한 채널의 턴에 코어 `applyApprovalWaits` 를 부른다(#5066). 홈 「작업 중」 카드와 에이전트 탭은 채널 너머를 읽으므로 같은
// 규칙을 채널마다 부르는 얇은 함수(`withApprovalWaits`)와, 대기 승인을 워크스페이스 전체에서 모으는 함수(`workspaceApprovalWaits`)가
// 있다. 규칙(누가 기다리나·기한이 지났나)은 코어 시험(`applyApprovalWaits.test.ts`)이 재고, 여기서는 **채널을 넘는 배선**만 잰다.
// 화면 시험(`home.test.tsx`·`agentWorkingSignal.test.tsx`)은 채널 하나에서만 서므로 이 둘은 여기서만 지켜진다.
// =============================================================================

const NOW = 2_000_000_000_000;
const CH_A = 'ch-aaa';
const CH_B = 'ch-bbb';
const CH_C = 'ch-ccc';
const AGENT_1 = 'agent-1';
const AGENT_2 = 'agent-2';

const key = (channelId: string, memberId: string) =>
  `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;

function turn(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: AGENT_1,
    channelId: CH_A,
    state: 'working',
    source: 'status',
    runId: 'run-1',
    startedAtMs: NOW - 30_000,
    headlines: ['한 줄'],
    lastActivityAtMs: NOW - 1_000,
    ...over,
  };
}

function mapOf(...turns: AgentWorkingSignal[]): Map<string, AgentWorkingSignal> {
  return new Map(turns.map(t => [key(t.channelId, t.memberId), t]));
}

const wait = (
  channelId: string,
  requestedBy: string,
  over: Partial<ApprovalWait> = {},
): ApprovalWait => ({channelId, requestedBy, expiresAtMs: NOW + 3_600_000, ...over});

describe('withApprovalWaits — 규칙은 코어의 것이고 여기서는 채널마다 부른다', () => {
  it('대기 승인이 있는 채널마다 덮는다: 한 채널이 아니라 채널 너머, 대기 없는 채널·다른 에이전트는 그대로', () => {
    const all = mapOf(
      turn({channelId: CH_A, memberId: AGENT_1}),
      turn({channelId: CH_B, memberId: AGENT_1}),
      turn({channelId: CH_B, memberId: AGENT_2}),
      turn({channelId: CH_C, memberId: AGENT_1}),
    );

    const out = withApprovalWaits(
      all,
      [wait(CH_A, AGENT_1), wait(CH_B, AGENT_1)],
      NOW,
    );

    const state = (channelId: string, memberId: string) =>
      out.get(key(channelId, memberId))?.state;
    expect(state(CH_A, AGENT_1)).toBe('awaiting_approval');
    expect(state(CH_B, AGENT_1)).toBe('awaiting_approval');
    expect(state(CH_B, AGENT_2)).toBe('working');
    expect(state(CH_C, AGENT_1)).toBe('working');
    expect(out.size).toBe(4);
    // 입력은 바뀌지 않는다: 스토어가 이 사본을 읽는 표면과 같은 객체를 나눠 쓴다.
    expect(all.get(key(CH_A, AGENT_1))?.state).toBe('working');
  });

  it('만료된 신호는 덮기 전에 걸러져서 살아 있는 승인이 새 턴을 세운다 — 대기가 없으면 입력을 그대로 돌려준다', () => {
    const all = mapOf(turn({lastActivityAtMs: NOW - IDLE_CUTOFF_MS - 1}));
    expect(withApprovalWaits(all, [], NOW)).toBe(all);

    const out = withApprovalWaits(all, [wait(CH_A, AGENT_1)], NOW);

    // 옛 신호를 그 자리에서 바꿔 두면 아래 표면의 만료 거름(`agentTurnsInChannel`·`agentTurnsForMember`)이 그 턴을 지우고 살아 있는
    // 승인은 어디에도 안 보인다. 먼저 거르면 승인을 근거로 선 새 턴이 남고, 시작 시각은 지어내지 않는다.
    const [shown] = agentTurnsInChannel(out, CH_A, NOW);
    expect(shown).toMatchObject({
      memberId: AGENT_1,
      state: 'awaiting_approval',
      lastActivityAtMs: NOW,
    });
    expect(shown.startedAtMs).toBeUndefined();
  });
});

describe('workspaceApprovalWaits — 채널마다 approvalWaits 를 이어 붙인다', () => {
  const approval = (over: Partial<Approval>): Approval => ({
    id: 'ap',
    workspaceId: 'ws',
    runId: 'run-1',
    channelId: CH_A,
    requestedBy: AGENT_1,
    actionType: 'tool_call',
    status: 'pending',
    ...over,
  });

  it('여러 채널의 대기 승인을 모으고, 대기가 아닌 승인은 어느 채널에서도 빠진다', () => {
    const waits = workspaceApprovalWaits([
      approval({id: 'ap-1', channelId: CH_A, expiresAtMs: NOW + 1}),
      approval({id: 'ap-2', channelId: CH_B, requestedBy: AGENT_2, runId: 'run-2'}),
      approval({id: 'ap-3', channelId: CH_B, status: 'approved'}),
      approval({id: 'ap-4', channelId: CH_C, status: 'expired'}),
    ]);

    expect(waits).toEqual([
      {channelId: CH_A, requestedBy: AGENT_1, runId: 'run-1', expiresAtMs: NOW + 1},
      {channelId: CH_B, requestedBy: AGENT_2, runId: 'run-2'},
    ]);
    // 원장을 아직 못 읽었으면 기다림으로 세울 것이 없다.
    expect(workspaceApprovalWaits(undefined)).toEqual([]);
  });
});
