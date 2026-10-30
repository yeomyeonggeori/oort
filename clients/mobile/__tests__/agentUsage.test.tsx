import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, saveSubscriptionFee,
  type AgentUsageResponse,
} from '@momo/core/features/settings/agentUsage';
import {AgentMonthlyReport, AgentUsageStatus} from '../src/features/agents/AgentUsage';

jest.mock('@momo/core/features/settings/agentUsage', () => ({
  ...jest.requireActual('@momo/core/features/settings/agentUsage'),
  fetchAgentUsage: jest.fn(), saveSubscriptionFee: jest.fn(),
}));
jest.mock('../src/session/useSession', () => ({useSession: () => ({workspaceId: 'w'})}));
jest.mock('../src/features/workspace/queries', () => ({useDirectory: () => ({directory: jest.requireActual('@momo/core/features/workspace/directory').makeDirectory([
  {id: 'a', displayName: '기록 도우미', handle: 'scribe', kind: 'agent', callableBy: 'everyone'} as never,
])})}));

const metrics = {runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 0,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 1, source: 'self_reported' as const};
function data(admin = false): AgentUsageResponse {
  return {range: {from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z', bucket: 'day'},
    agents: [{...metrics, agentMemberId: 'a'}],
    totals: {mine: metrics, shared: metrics, ...(admin ? {workspace: metrics} : {})}, hiddenPersonalAgents: 3};
}
let client: QueryClient;
function mount(profile = false) {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(<QueryClientProvider client={client}>{profile ? <AgentUsageStatus agentId="A" /> : <AgentMonthlyReport workspaceId="w" />}</QueryClientProvider>);
}
afterEach(() => {cleanup(); client?.clear(); jest.resetAllMocks();});

it('reads the same response and renders shared profile words without truncating the cost line', async () => {
  jest.mocked(fetchAgentUsage).mockResolvedValue(data()); mount(true);
  await waitFor(() => expect(screen.getByTestId('agent-usage-status')).toHaveTextContent(/자기 보고.*추정/));
  expect(screen.getByTestId('agent-usage-status').props.numberOfLines).toBeUndefined();
  expect(screen.getByTestId('agent-usage-status')).not.toHaveTextContent('정확');
});
it('shows errors with retry, then an empty report; members see a count without workspace totals or fee inputs', async () => {
  jest.mocked(fetchAgentUsage).mockRejectedValueOnce(new Error('unavailable')); mount();
  await screen.findByText(COPY.error);
  jest.mocked(fetchAgentUsage).mockResolvedValue({...data(), agents: []});
  fireEvent.press(screen.getByRole('button', {name: '다시 불러오기'}));
  await screen.findByText(COPY.empty);
  expect(screen.getByText('숨겨진 개인 에이전트 3개')).toBeTruthy();
  expect(screen.queryByText(/워크스페이스 전체/)).toBeNull();
  expect(screen.queryByLabelText(COPY.subscription)).toBeNull();
});
it('lets admins set a shared fee, keeps a refused draft, and clears with null', async () => {
  jest.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
  const input = await screen.findByLabelText(COPY.subscription);
  fireEvent.changeText(input, '20.000001');
  jest.mocked(saveSubscriptionFee).mockRejectedValueOnce(new Error('403'));
  fireEvent.press(screen.getByRole('button', {name: '구독 정액 저장'}));
  await screen.findByText(COPY.saveError);
  expect(input.props.value).toBe('20.000001');
  expect(saveSubscriptionFee).toHaveBeenLastCalledWith('w', 'a', 20000001);
  jest.mocked(saveSubscriptionFee).mockResolvedValue({agentMemberId: 'a', subscriptionFee: null});
  fireEvent.changeText(input, '');
  fireEvent.press(screen.getByRole('button', {name: '구독 정액 저장'}));
  await waitFor(() => expect(saveSubscriptionFee).toHaveBeenLastCalledWith('w', 'a', null));
  await screen.findByText(COPY.saved);
});
