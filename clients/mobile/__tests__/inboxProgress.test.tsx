import { act, cleanup, renderHook } from '@testing-library/react-native';
import type { AgentRunProgress } from '@momo/core/lib/api';
import { useAgentFeed, useNeedsAction } from '../src/features/inbox/useInbox';

const mockData = {
  approval: {
    id: 'approval',
    workspaceId: 'workspace',
    runId: 'run',
    channelId: 'channel',
    requestedBy: 'agent',
    actionType: 'tool_call',
    status: 'approved' as const,
  },
  groups: { channels: [{ id: 'channel', name: '실험실' }], dms: [] },
  directory: {
    members: [],
    byId: new Map([
      [
        'agent',
        {
          id: 'agent',
          kind: 'agent',
          displayName: '달무리봇',
          ownerHumanId: 'human',
        },
      ],
    ]),
  },
  progress: new Map<string, readonly AgentRunProgress[]>(),
  listeners: new Set<() => void>(),
};
jest.mock('../src/features/agents/agentRunProgressStore', () => ({
  runProgressSnapshot: () => mockData.progress,
  subscribeRunProgress: (listener: () => void) => {
    mockData.listeners.add(listener);
    return () => mockData.listeners.delete(listener);
  },
}));
jest.mock('../src/session/useSession', () => ({
  useSession: () => ({ workspaceId: 'workspace', member: { id: 'human' } }),
}));
jest.mock('../src/lib/useNow', () => ({ useNow: () => 0 }));
jest.mock('../src/features/workspace/queries', () => ({
  useChannels: () => ({ groups: mockData.groups }),
  useDirectory: () => ({ directory: mockData.directory }),
  channelLabel: () => '실험실',
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  // 결정 직후 대기 페이지에 남아 있는 기록도 같은 상태로 읽어야 해요.
  useQuery: () => ({ data: [mockData.approval] }),
  useQueries: ({
    queries,
    combine,
  }: {
    queries: { queryKey: string[] }[];
    combine: (rows: unknown[]) => unknown;
  }) =>
    combine(
      queries.map(({ queryKey }) => ({
        data:
          queryKey[0] === 'approvals' && queryKey[2] === 'approved'
            ? [mockData.approval]
            : [],
        dataUpdatedAt: 0,
      })),
    ),
}));
beforeEach(() => {
  mockData.progress = new Map();
});
afterEach(cleanup);

it.each(['needs-action', 'agent'] as const)(
  '%s는 타임라인 진행 입력의 변경을 인박스 상태에 반영한다',
  feed => {
    function useOwnedAgentFeed(enabled: boolean) {
      return useAgentFeed(enabled, 'human');
    }
    const useFeed = feed === 'agent' ? useOwnedAgentFeed : useNeedsAction;
    const { result } = renderHook(() => useFeed(true));
    const outcome = () =>
      result.current.items.find(item => item.key === 'approval:approval')
        ?.outcome;
    expect(outcome()).toBe('실행 중');
    for (const [phase, endReason, word] of [
      ['running', undefined, '실행 중'],
      ['succeeded', undefined, '끝'],
      ['failed', 'agent_error', '실패'],
      ['timed_out', 'approval_expired', '만료'],
    ] as const) {
      const run: AgentRunProgress = {
        id: 'run',
        channelId: 'channel',
        agentMemberId: 'agent',
        status: phase,
        phase,
        endReason,
        leaseState: 'none',
        stepCount: 0,
        ahead: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      };
      act(() => {
        mockData.progress = new Map([['channel', [run]]]);
        mockData.listeners.forEach(listener => listener());
      });
      expect(outcome()).toBe(word);
    }
  },
);
