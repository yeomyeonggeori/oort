import React from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen, waitFor} from '@testing-library/react-native';
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, type AgentUsageResponse,
} from '@momo/core/features/settings/agentUsage';
import AgentDetailScreen from '../src/screens/AgentDetailScreen';
import AgentsScreen from '../src/screens/AgentsScreen';
import {SAFE_GUTTER} from '../src/design/tokens';
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
  useAgentLiveness: () => ({liveness: null, nowMs: 0}),
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
afterEach(() => {cleanup(); client?.clear(); jest.mocked(fetchAgentUsage).mockReset();});

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
