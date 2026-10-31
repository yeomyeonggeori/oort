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
import {leftEdge} from './fixtures/leftInset';

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
// #4912 2차(디자인 검수 H2): 에이전트 프로필·목록에는 가로 여백을 주는 그릇이 없다(`Screen` 은 0, 상세의 스크롤은 아래
// 여백뿐 - 두 화면에서 직접 재는 시험은 `agentUsageHosts.test.tsx`). 그래서 가터는 `AgentUsageStatus` 가 스스로 진다.
// 첫 판은 「그 화면이 가터를 준다」고 적고 이 자리를 비워 두었고, 프로필의 비용 줄이 화면 왼쪽 끝(x≈1)에 붙었다.
// 재는 값은 조상 전체의 가로 여백 합이다(`leftEdge`): 가터가 비면 0, 부품과 호스트가 둘 다 지면 32 가 되어 둘 다 빨갛다.
function mountList() {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(<QueryClientProvider client={client}><AgentUsageStatus /></QueryClientProvider>);
}

it('starts the profile usage line one SAFE_GUTTER in from the screen edge, once', async () => {
  jest.mocked(fetchAgentUsage).mockResolvedValue(data()); mount(true);
  await waitFor(() => expect(screen.getByTestId('agent-usage-status')).toHaveTextContent(/자기 보고/));
  expect(leftEdge(screen.getByTestId('agent-usage-status'))).toBe(SAFE_GUTTER);
});
it('starts the list status line one SAFE_GUTTER in while loading', async () => {
  jest.mocked(fetchAgentUsage).mockReturnValue(new Promise(() => {}));
  mountList();
  expect(leftEdge(await screen.findByText(COPY.loading))).toBe(SAFE_GUTTER);
});
it('starts the list status line - and its retry button - one SAFE_GUTTER in when the read failed', async () => {
  jest.mocked(fetchAgentUsage).mockRejectedValue(new Error('unavailable'));
  mountList();
  expect(leftEdge(await screen.findByText(COPY.error))).toBe(SAFE_GUTTER);
  // 「다시 불러오기」도 같은 가터 안에서 시작한다(줄만 들이고 단추는 가장자리에 두면 한 덩어리가 두 x 에서 시작한다).
  expect(leftEdge(screen.getByRole('button', {name: '다시 불러오기'}))).toBe(SAFE_GUTTER);
});
it('starts the hidden-personal-agents sentence one SAFE_GUTTER in', async () => {
  jest.mocked(fetchAgentUsage).mockResolvedValue(data());
  mountList();
  expect(leftEdge(await screen.findByText('숨겨진 개인 에이전트 3개'))).toBe(SAFE_GUTTER);
});
it('keeps the fee editor inside the report on the report gutter alone - the editor must not add a second layer', async () => {
  // `SubscriptionEditor` 는 `group` 을 쓰고 `report` 안에 있다. `group` 이 가터를 지면 정액 칸이 32 가 된다.
  // (`status` 를 `group` 에서 떼어 낸 이유가 이것이고, 그 둘을 다시 합치면 여기서 빨개진다.)
  // 입력 칸은 알약(`InputPill`)의 상자를 잰다: 알약은 제 안쪽 padding(16)으로 글자를 밀므로 그 안의 `TextInput` 은 32 에서 시작한다.
  jest.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
  await screen.findByLabelText(COPY.subscription);
  expect(leftEdge(screen.getByTestId('subscription-a-pill'))).toBe(SAFE_GUTTER);
  expect(leftEdge(screen.getByRole('button', {name: '구독 정액 저장'}))).toBe(SAFE_GUTTER);
  expect(leftEdge(screen.getByText('비워서 저장하면 정액을 지워요.'))).toBe(SAFE_GUTTER);
});
