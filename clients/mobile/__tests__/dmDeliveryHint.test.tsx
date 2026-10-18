import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderHook, waitFor} from '@testing-library/react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';

import {useDmDeliveryHint} from '../src/features/conversation/useDmDeliveryHint';

const mockGet = jest.fn();
jest.mock('@momo/core/features/hostedAgents/api', () => ({
  getAgentDmDelivery: (...args: unknown[]) => mockGet(...args),
}));

// =============================================================================
// #4016 — 에이전트 DM 입력창 위 안내. 정상(답한다)에는 문장이 없고, 답하지 않는 상태만 말한다.
// =============================================================================

const AGENT = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  workspaceId: 'ws',
  kind: 'agent',
  status: 'active',
  displayName: 'grok',
  handle: 'grok',
} as unknown as RosterMember;

function hint(state: string | null) {
  mockGet.mockResolvedValue({agentMemberId: AGENT.id, ownerMemberId: null, state});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const wrapper = ({children}: {children: React.ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useDmDeliveryHint({
        workspaceId: 'ws',
        channelId: 'ch',
        directory: makeDirectory([AGENT]),
        dmAgent: AGENT,
      }),
    {wrapper},
  );
}

it.each(['open', 'not_hosted'])('답하는 상태(%s)에는 문장이 없다', async state => {
  const {result} = hint(state);
  await waitFor(() => expect(mockGet).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(result.current).toBeNull();
});

it('답하지 않는 상태는 계속 말한다 — 헛기다리지 않게', async () => {
  const {result} = hint('connection_unavailable');
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current).toContain('답하지 않아요');
});
