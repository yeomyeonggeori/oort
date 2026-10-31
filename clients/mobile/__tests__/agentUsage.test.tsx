import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {StyleSheet} from 'react-native';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, saveSubscriptionFee,
  type AgentUsageResponse,
} from '@momo/core/features/settings/agentUsage';
import {AgentMonthlyReport, AgentUsageStatus} from '../src/features/agents/AgentUsage';
import {SAFE_GUTTER} from '../src/design/tokens';

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

// #4912: 설정 안쪽 장(`SubPage`)의 스크롤은 가로 여백을 주지 않는다. 장마다 제 가터(`SAFE_GUTTER`)를 지는데
// (`ThemePage` 의 `themePage`), 월 보고만 지지 않아 안내·기간·「다시 불러오기」·정액 입력·「저장」이 화면
// 가장자리(x=0)에 붙었다. 레이아웃은 JS 렌더러에 없으므로 「그 다섯이 가터를 문 한 그릇 안에 있다」로 잰다.
const flat = (node: {props: {style?: unknown}}) =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;

it('puts the loaded report, its note, range, refresh, fee input and save inside one SAFE_GUTTER container', async () => {
  jest.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
  const report = await screen.findByTestId('agent-monthly-report');
  expect(flat(report).paddingHorizontal).toBe(SAFE_GUTTER);
  const inside = within(report);
  expect(inside.getByText(COPY.note)).toBeTruthy();
  expect(inside.getByText('2026-10-01 ~ 2026-10-30 (UTC)')).toBeTruthy();
  expect(inside.getByRole('button', {name: '다시 불러오기'})).toBeTruthy();
  expect(inside.getByLabelText(COPY.subscription)).toBeTruthy();
  expect(inside.getByRole('button', {name: '구독 정액 저장'})).toBeTruthy();
});
it('keeps the same gutter while the report is still loading', () => {
  jest.mocked(fetchAgentUsage).mockReturnValue(new Promise(() => {}));
  mount();
  const state = screen.getByTestId('agent-monthly-report-state');
  expect(flat(state).paddingHorizontal).toBe(SAFE_GUTTER);
  expect(within(state).getByText(COPY.loading)).toBeTruthy();
});
it('keeps the same gutter when the report failed, retry button included', async () => {
  jest.mocked(fetchAgentUsage).mockRejectedValue(new Error('unavailable')); mount();
  await screen.findByText(COPY.error);
  const state = screen.getByTestId('agent-monthly-report-state');
  expect(flat(state).paddingHorizontal).toBe(SAFE_GUTTER);
  expect(within(state).getByRole('button', {name: '다시 불러오기'})).toBeTruthy();
});
it('leaves the shared status line to its host: the gutter is the report page, not AgentUsageStatus', async () => {
  // `AgentUsageStatus` 는 에이전트 목록·상세 화면 안에 서고 그 화면이 제 가터를 준다. 이 장의 가터를 같이 쓰는
  // `group` 에 얹으면 목록에서 이중 인셋이 된다. 그 그릇이 가터를 지면 이 줄이 빨개진다.
  jest.mocked(fetchAgentUsage).mockResolvedValue(data()); mount(true);
  const status = await screen.findByTestId('agent-usage-status');
  // 바로 윗 그릇 하나가 아니라 **모든 조상**을 본다: 합성 요소 한 겹이 사이에 끼어 있어도 이 단정이 비지 않는다.
  interface Walkable {parent: Walkable | null; props: {style?: unknown}}
  const gutters: unknown[] = [];
  for (let node: Walkable | null = status as unknown as Walkable; node; node = node.parent) {
    const value = flat(node).paddingHorizontal;
    if (value !== undefined) {gutters.push(value);}
  }
  expect(gutters).toEqual([]);
});
