import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen, waitFor, within} from '@testing-library/react-native';
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, type AgentUsageResponse,
} from '@momo/core/features/settings/agentUsage';
import AgentDetailScreen from '../src/screens/AgentDetailScreen';
import AgentsScreen from '../src/screens/AgentsScreen';
import {SAFE_GUTTER} from '../src/design/tokens';
import {useAgentLiveness} from '../src/features/agents/useAgentLiveness';
import {leftEdge} from './fixtures/leftInset';

// #4912 2차(디자인 검수 H2): `AgentUsageStatus` 가 서는 자리마다 다른 줄과 같은 가터(`SAFE_GUTTER`)에서 시작한다.
//
// 첫 수리는 월 보고 페이지만 고치고 「에이전트 목록·상세는 그 화면이 가터를 준다」고 적어 두었다. 둘 다 아니었다:
// `Screen` 은 가로 여백이 없고 상세의 스크롤 `body` 는 아래 여백뿐이라, 프로필의 비용 줄이 화면 왼쪽 끝(x≈1)에 붙었다.
// `agentUsage.test.tsx` 는 부품 하나를 단독으로 재고, 이 파일은 **두 화면을 실제로 세워서** 재다. 화면이 가터를 더하면
// (이중 인셋) 부품 단독 시험은 초록인 채 화면만 32 로 좁아지므로, 자리마다 따로 잰다.
//
// 재는 값은 조상 전체의 가로 여백 합이다(`leftEdge`, JS 렌더러에는 레이아웃이 없다). 두 가지를 같이 단정한다:
//  - 절대값: 정확히 `SAFE_GUTTER` (비면 0, 부품과 호스트가 둘 다 지면 32).
//  - 상대값: 같은 화면의 **다른 줄**과 같은 x. 가터 값이 바뀌어도 줄이 이웃과 어긋나지 않는다.

jest.mock('@momo/core/features/settings/agentUsage', () => ({
  ...jest.requireActual('@momo/core/features/settings/agentUsage'),
  fetchAgentUsage: jest.fn(),
}));
jest.mock('../src/session/useSession', () => ({
  useSession: () => ({workspaceId: 'w', member: {id: 'me'}}),
}));
// 명부·채널·세션 같은 이 시험의 주제가 아닌 읽기는 고정된 답으로 둔다(참조가 렌더마다 바뀌지 않게 팩토리 안에서 한 번만 만든다).
jest.mock('../src/features/workspace/queries', () => {
  const {makeDirectory} = jest.requireActual('@momo/core/features/workspace/directory');
  const directory = makeDirectory([
    {
      id: 'a', workspaceId: 'w', kind: 'agent', status: 'active', displayName: '기록 도우미', handle: 'scribe',
      channelCount: 0, channelIds: [], capabilities: [], callableBy: 'everyone',
    } as never,
  ]);
  const refetch = jest.fn();
  const groups = {channels: [], dms: []};
  const remember = jest.fn();
  return {
    ...jest.requireActual('../src/features/workspace/queries'),
    useDirectory: () => ({directory, isLoading: false, isError: false, error: null, refetch}),
    useChannels: () => ({groups, refetch}),
    useRememberOpenedDm: () => remember,
  };
});
jest.mock('../src/features/agents/queries', () => {
  const refetch = jest.fn();
  const read = {kind: 'pending'};
  const models = {isPending: true, isError: false, data: undefined};
  const sessions = {data: [], isPending: false, isError: false, refetch};
  const hosts = {data: undefined};
  return {
    ...jest.requireActual('../src/features/agents/queries'),
    useAgentProfile: () => ({read}),
    useAllowedAgentModels: () => models,
    useWorkSessions: () => sessions,
    useWorkHosts: () => hosts,
  };
});
jest.mock('../src/features/agents/useAgentLiveness', () => ({
  ...jest.requireActual('../src/features/agents/useAgentLiveness'),
  useAgentLiveness: jest.fn(() => ({liveness: null, nowMs: 0})),
}));
jest.mock('../src/features/agents/workingSignal', () => {
  const signals = new Map();
  return {
    ...jest.requireActual('../src/features/agents/workingSignal'),
    useAgentWorkingSignals: () => signals,
  };
});
jest.mock('../src/realtime/RealtimeProvider', () => ({
  ...jest.requireActual('../src/realtime/RealtimeProvider'),
  useRealtime: () => ({status: 'connected', rail: null, subscriptionsWanted: false}),
}));

const metrics = {runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 0,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 0, source: 'measured' as const};
const data = (): AgentUsageResponse => ({
  range: {from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z', bucket: 'day'},
  agents: [{...metrics, agentMemberId: 'a'}],
  totals: {mine: metrics, shared: metrics}, hiddenPersonalAgents: 3,
});

let client: QueryClient;
function mount(ui: React.JSX.Element) {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const detail = () => mount(
  <AgentDetailScreen agent={{memberId: 'a', displayName: '기록 도우미', handle: 'scribe'}} onBack={() => {}} onOpenConversation={() => {}} />,
);
const list = () => mount(<AgentsScreen onOpenAgent={() => {}} onOpenHostedList={() => {}} />);
// `resetAllMocks` 는 쓰지 않는다: jest 프리셋이 깔아 둔 `AccessibilityInfo` 의 구현까지 지워서, 목록의 당겨서 새로고침(동작 줄이기
// 읽기)이 `undefined.then` 으로 죽는다. 이 시험이 만든 mock 만 되돌린다.
afterEach(() => {
  cleanup();
  client?.clear();
  jest.mocked(fetchAgentUsage).mockReset();
  jest.mocked(useAgentLiveness).mockReturnValue({liveness: null, nowMs: 0});
});
// 생존 라벨이 서는 에이전트(서버가 아는 hosted): 낱말은 core 가 정하고 이 시험은 자리만 잰다.
const alive = () => jest.mocked(useAgentLiveness).mockReturnValue({
  liveness: {agentMemberId: 'a', state: 'responsive', lastSignalAtMs: 0},
  nowMs: 3 * 60_000,
});

describe('에이전트 프로필(AgentDetailScreen): 비용 줄', () => {
  it('프로필의 다른 줄(「프로필」 라벨·카드)과 같은 가터에서 시작하고, 가터는 한 겹이다', async () => {
    jest.mocked(fetchAgentUsage).mockResolvedValue(data());
    detail();
    // 불러온 뒤의 줄(캡처가 보여 준 모양)을 잰다. 줄은 불러오는 중에도 서므로 글이 바뀔 때까지 기다린다.
    await waitFor(() => expect(screen.getByTestId('agent-usage-status')).toHaveTextContent(/정확/));
    const status = screen.getByTestId('agent-usage-status');
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(status)).toBe(leftEdge(screen.getByText('프로필')));
    expect(leftEdge(status)).toBe(leftEdge(screen.getByTestId('agent-profile-card')));
  });
  it('불러오는 중에도 같은 가터에서 시작한다', async () => {
    jest.mocked(fetchAgentUsage).mockReturnValue(new Promise(() => {}));
    detail();
    const status = await screen.findByText(COPY.loading);
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(status)).toBe(leftEdge(screen.getByText('프로필')));
  });
  it('읽지 못했을 때 줄과 「다시 불러오기」가 같은 가터에서 시작한다', async () => {
    jest.mocked(fetchAgentUsage).mockRejectedValue(new Error('unavailable'));
    detail();
    const status = await screen.findByText(COPY.error);
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(screen.getByRole('button', {name: '다시 불러오기'}))).toBe(SAFE_GUTTER);
  });
});

describe('에이전트 목록(AgentsScreen): 로딩·오류·숨은 개인 에이전트 문장', () => {
  // 목록은 `agentId` 없이 이 부품을 세운다: 줄이 서는 것은 이 세 상태뿐이다.
  it('불러오는 중 문장이 목록의 줄(행 제목)과 같은 가터에서 시작한다', async () => {
    jest.mocked(fetchAgentUsage).mockReturnValue(new Promise(() => {}));
    list();
    const status = await screen.findByText(COPY.loading);
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(status)).toBe(leftEdge(screen.getByText('기록 도우미')));
  });
  it('읽지 못했을 때 문장과 「다시 불러오기」가 같은 가터에서 시작한다', async () => {
    jest.mocked(fetchAgentUsage).mockRejectedValue(new Error('unavailable'));
    list();
    const status = await screen.findByText(COPY.error);
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(status)).toBe(leftEdge(screen.getByText('기록 도우미')));
    expect(leftEdge(screen.getByRole('button', {name: '다시 불러오기'}))).toBe(SAFE_GUTTER);
  });
  it('숨은 개인 에이전트 문장이 같은 가터에서 시작한다', async () => {
    jest.mocked(fetchAgentUsage).mockResolvedValue(data());
    list();
    const status = await screen.findByText('숨겨진 개인 에이전트 3개');
    expect(leftEdge(status)).toBe(SAFE_GUTTER);
    expect(leftEdge(status)).toBe(leftEdge(screen.getByText('기록 도우미')));
  });
});

// ---- 생존 라벨의 가터 (#4982) ---------------------------------------------------------------------------
// `AgentLivenessLabel` 은 목록 행 안에서도 쓰이고(행이 이미 여백을 진다) 상세에서는 가로 여백이 없는 스크롤에 직접 선다. 부품이
// 가터를 지면 행 안에서 이중 인셋이 되고, 아무도 안 지면 상세의 라벨이 화면 가장자리에 붙는다. 그래서 가터는 **끼우는 자리**가 준다.
describe('에이전트 생존 라벨: 가터는 끼우는 자리가 준다', () => {
  it('상세에서는 프로필의 다른 줄(비용 줄·「프로필」)과 같은 가터에서 시작하고, 가터는 한 겹이다', async () => {
    alive();
    jest.mocked(fetchAgentUsage).mockResolvedValue(data());
    detail();
    const label = await screen.findByTestId('agent-detail-liveness');
    expect(label).toHaveTextContent('응답함 3분 전'); // 라벨이 실제로 섰다(없으면 아래 가터 단정이 헛돈다)
    // 잰 것은 라벨의 **첫 그림**(점)이다: `leftEdge` 는 요소 자신의 padding 을 세지 않으므로, 부품이 몰래 가터를 지면(이중 인셋) 점이 밀려난다.
    const dot = within(label).getByTestId('agent-liveness-dot');
    expect(leftEdge(dot)).toBe(SAFE_GUTTER);
    await waitFor(() => expect(screen.getByTestId('agent-usage-status')).toHaveTextContent(/정확/));
    expect(leftEdge(dot)).toBe(leftEdge(screen.getByTestId('agent-usage-status')));
    expect(leftEdge(dot)).toBe(leftEdge(screen.getByText('프로필')));
  });
  it('목록 행 안의 쓰임은 그대로다: 행 제목과 같은 x 이고 가터를 더하지 않으며, 행의 비용 줄은 어절 우선 줄바꿈 + 스레드 카드와 같은 서식이다', async () => {
    alive();
    jest.mocked(fetchAgentUsage).mockResolvedValue(data());
    list();
    const label = await screen.findByTestId('agent-liveness-a');
    expect(label).toHaveTextContent('응답함 3분 전');
    expect(leftEdge(within(label).getByTestId('agent-liveness-dot'))).toBe(leftEdge(screen.getByText('기록 도우미')));
    // 같은 행의 비용 줄(#4982): 한글 낱말을 가운데서 끊지 않고, 비용은 `formatMicroUsd` 한 서식이다.
    const line = await screen.findByText(new RegExp(`^${COPY.title}: `));
    expect(line.props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(line).toHaveTextContent('비용 $1.00', {exact: false});
  });
});
