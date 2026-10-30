// @vitest-environment jsdom
import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {AgentRunProgress} from '@momo/core/lib/api';
import {useAgentFeed, useNeedsAction} from './useInbox';

const data = vi.hoisted(() => ({
  approval: {id: 'approval', workspaceId: 'workspace', runId: 'run', channelId: 'channel', requestedBy: 'agent', actionType: 'tool_call', status: 'approved' as const},
  groups: {channels: [{id: 'channel', name: '실험실'}], dms: []},
  directory: {members: [], byId: new Map()},
  progress: new Map<string, readonly AgentRunProgress[]>(),
  listeners: new Set<() => void>(),
}));
vi.mock('../agents/agentRunProgressStore', () => ({
  runProgressSnapshot: () => data.progress,
  subscribeRunProgress: (listener: () => void) => {
    data.listeners.add(listener);
    return () => data.listeners.delete(listener);
  },
}));
vi.mock('@/app/session', () => ({useSession: () => ({workspaceId: 'workspace', session: {member: {id: 'human'}}})}));
vi.mock('./actorNames', () => ({actorNamesIn: () => ({name: '달무리봇', isAgent: true})}));
vi.mock('@/features/workspace/useWorkspace', () => ({
  useChannels: () => ({groups: data.groups}),
  useDirectory: () => ({directory: data.directory}),
  channelLabel: () => '실험실',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({invalidateQueries: vi.fn()}),
  // 결정 직후 대기 페이지에 남아 있는 기록도 같은 상태로 읽어야 해요.
  useQuery: () => ({data: [data.approval]}),
  useQueries: ({queries, combine}: {queries: {queryKey: string[]}[]; combine: (rows: unknown[]) => unknown}) => combine(queries.map(({queryKey}) => ({
    data: queryKey[0] === 'approvals' && queryKey[2] === 'approved' ? [data.approval] : [],
    dataUpdatedAt: 0,
  }))),
}));
beforeEach(() => { data.progress = new Map(); });
afterEach(cleanup);

it.each(['needs-action', 'agent'] as const)('%s는 타임라인 진행 입력의 변경을 인박스 상태에 반영한다', (feed) => {
  const useFeed = feed === 'agent' ? useAgentFeed : useNeedsAction;
  const {result} = renderHook(() => useFeed(true));
  const outcome = () => result.current.items.find(item => item.key === 'approval:approval')?.outcome;
  expect(outcome()).toBe('실행 중');
  for (const [phase, endReason, word] of [
    ['running', undefined, '실행 중'],
    ['succeeded', undefined, '끝'],
    ['failed', 'agent_error', '실패'],
    ['timed_out', 'approval_expired', '만료'],
  ] as const) {
    const run: AgentRunProgress = {
      id: 'run', channelId: 'channel', agentMemberId: 'agent', status: phase,
      phase, endReason, leaseState: 'none', stepCount: 0, ahead: [], createdAtMs: 0, updatedAtMs: 0,
    };
    act(() => {
      data.progress = new Map([['channel', [run]]]);
      data.listeners.forEach(listener => listener());
    });
    expect(outcome()).toBe(word);
  }
});
