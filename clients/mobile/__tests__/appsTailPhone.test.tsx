import type {Member, Message, PluginCatalog, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {ChannelAudienceContext} from '../src/features/conversation/appsTail';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 「쓴 앱」 꼬리와 막힘 문장 — 폰 (ADR-0113 증보 2 E8·E10, #3950 U-S2). 문장은 코어가 정하고
// (`teamAiReply.test.ts` · `appNotice.test.ts`), 여기서는 폰 행에 배선됐는지를 못으로 박는다.
// 웹 판은 `clients/web/src/features/timeline/appsTail.test.tsx`다.
// =============================================================================

const mockListPlugins = jest.fn();
const mockRunDetail = jest.fn();
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {
    ...actual,
    listPlugins: (...args: unknown[]) => mockListPlugins(...args),
    fetchAgentRunDetail: (...args: unknown[]) => mockRunDetail(...args),
  };
});
const mockAbsoluteBase = jest.fn(() => 'https://oort.test');
jest.mock('@momo/core/runtime/host', () => {
  const actual = jest.requireActual('@momo/core/runtime/host');
  return {
    ...actual,
    coreHost: () => ({...actual.coreHost(), absoluteApiBase: mockAbsoluteBase}),
  };
});

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HERMES = 'cccccccc-1111-4111-8111-cccccccccc03';
const TRIGGER = '0199aa11-2222-7000-8000-0000000004a1';
const RUN = '0199aa11-2222-7000-8000-0000000006b1';
const CH = 'ch-general';
const BASE_MS = 1_760_000_000_000;

function rosterMember(
  id: string,
  kind: 'human' | 'agent',
  displayName: string,
  handle: string,
): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([
  rosterMember(SELF_ID, 'human', '곽성재', 'seongjae'),
  rosterMember(HERMES, 'agent', 'Hermes', 'hermes'),
]);
const ME: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const catalog = (installed: boolean): PluginCatalog =>
  ({
    plugins: [
      {
        pluginId: 'gmail',
        name: 'Gmail',
        version: '1',
        description: '',
        official: true,
        recommended: true,
        egressDomains: ['gmailmcp.googleapis.com'],
        recommendedFor: [],
        installed,
        enabled: true,
      },
    ],
    toolsByPlugin: new Map(),
  }) as PluginCatalog;

function reply(props: Record<string, unknown>): Message {
  return {
    id: '0199aa11-2222-7000-8000-0000000004b1',
    channelId: CH,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: HERMES,
    type: 'text',
    body: '받은편지함에서 두 건을 찾았어요.',
    state: 'sent',
    createdAtMs: BASE_MS,
    replyToId: TRIGGER,
    replyTo: {
      id: TRIGGER,
      seq: 9,
      authorMemberId: SELF_ID,
      type: 'text',
      state: 'sent',
      body: '메일 찾아줘',
    },
    props,
  } as unknown as Message;
}
const HERMES_PROPS = {source: 'hermes_gateway', status: 'succeeded', run_id: RUN};

const actions: MessageRowActions = {
  myMemberId: SELF_ID,
  workspaceId: WS,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

function renderRow(msg: Message, audience: number | null = null) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <ChannelAudienceContext.Provider value={audience}>
          <MessageRow
            message={msg}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={BASE_MS}
            approvalsProvided
            actions={actions}
          />
        </ChannelAudienceContext.Provider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockListPlugins.mockReset().mockResolvedValue(catalog(true));
  mockRunDetail.mockReset().mockResolvedValue({
    appsUsed: [{pluginId: 'gmail', tool: 'search_threads', calls: 2}],
  });
  mockAbsoluteBase.mockReset().mockReturnValue('https://oort.test');
});
afterEach(() => {
  cleanup();
});

describe('쓴 앱 꼬리 (폰)', () => {
  it('한 줄을 세우고, 나머지는 「자세히」 뒤에 접고, 행 낭독에는 접힌 것까지 싣는다', async () => {
    renderRow(reply(HERMES_PROPS), 12);
    await waitFor(() => expect(screen.getByTestId('apps-used-line')).toBeTruthy());
    expect(mockRunDetail).toHaveBeenCalledWith(WS, RUN);
    expect(screen.getByTestId('apps-used-line')).toHaveTextContent(
      '쓴 앱: Gmail 검색 2회 · Hermes에서 · 이 채널 12명에게 보여요',
    );
    expect(screen.queryByTestId('apps-detail-line')).toBeNull();
    fireEvent.press(screen.getByTestId('apps-details-toggle'));
    const details = screen.getAllByTestId('apps-detail-line').map(n => n.props.children).join('|');
    expect(details).toContain('곽성재 명의로 썼어요.');
    expect(details).toContain('연결: gmailmcp.googleapis.com');
    expect(details).toContain('oort는 확인하지 못해요');
    expect(details).toContain('요약만 올리는 게 원칙이에요');
    const label = screen.getByTestId('message-row').props.accessibilityLabel as string;
    expect(label).toContain('쓴 앱');
    expect(label).toContain('이 채널 12명에게 보여요');
    expect(label).toContain('요약만 올리는 게 원칙이에요');
  });

  it('DM(노출 수 없음)에는 둘째 줄이 없다', async () => {
    renderRow(reply(HERMES_PROPS), null);
    await waitFor(() => expect(screen.getByTestId('apps-used-line')).toBeTruthy());
    expect(screen.getByTestId('apps-used-line')).toHaveTextContent('쓴 앱: Gmail 검색 2회 · Hermes에서');
    expect(screen.getByTestId('apps-used-line')).not.toHaveTextContent(/이 채널/);
  });

  it('보고가 없으면 꼬리가 없다', async () => {
    mockRunDetail.mockResolvedValue({});
    renderRow(reply(HERMES_PROPS), 5);
    await waitFor(() => expect(mockRunDetail).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('apps-used-tail')).toBeNull();
  });

  it('켜진 앱이 하나도 없으면 run 도 부르지 않는다', async () => {
    mockListPlugins.mockResolvedValue(catalog(false));
    renderRow(reply(HERMES_PROPS), 5);
    await waitFor(() => expect(mockListPlugins).toHaveBeenCalled());
    await act(async () => {});
    expect(mockRunDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('apps-used-tail')).toBeNull();
  });
});

describe('막힘 문장 (폰)', () => {
  const blocked = (app_notice: Record<string, unknown>) =>
    reply({source: 'hermes_gateway', status: 'failed', run_id: RUN, app_notice});

  it('허용 안 함: 폰 문장 + 「웹에서 열기」 하나, 로터에도 같은 행동', async () => {
    const {Linking} = require('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    renderRow(blocked({kind: 'not_allowed'}));
    expect(screen.getByTestId('app-notice-sentence')).toHaveTextContent(
      '이 앱은 데스크탑이나 웹에서 허용해 주세요.',
    );
    expect(screen.getAllByTestId('app-notice-action')).toHaveLength(1);
    expect(screen.getByText('웹에서 열기')).toBeTruthy();
    const row = screen.getByTestId('message-row');
    const rotor = ((row.props.accessibilityActions ?? []) as {name: string; label: string}[]).find(
      a => a.label === '웹에서 열기',
    );
    expect(rotor).toBeDefined();
    act(() => {
      fireEvent(row, 'accessibilityAction', {nativeEvent: {actionName: rotor?.name}});
    });
    expect(open).toHaveBeenCalledWith('https://oort.test/ai/external/apps');
    expect(row.props.accessibilityLabel).toContain('이 앱은 데스크탑이나 웹에서 허용해 주세요.');
    open.mockRestore();
  });

  it('서버 주소를 모르면 열 수 없는 버튼을 세우지 않는다', () => {
    mockAbsoluteBase.mockReturnValue('');
    renderRow(blocked({kind: 'not_allowed'}));
    expect(screen.getByTestId('app-notice-sentence')).toBeTruthy();
    expect(screen.queryByTestId('app-notice-action')).toBeNull();
  });

  it('행동이 없는 막힘은 문장만', () => {
    renderRow(blocked({kind: 'grant_revoked'}));
    expect(screen.getByTestId('app-notice-sentence')).toHaveTextContent(
      '실행 중에 허용이 회수돼서 여기서 멈췄어요. 이미 한 일은 그대로예요.',
    );
    expect(screen.queryByTestId('app-notice-action')).toBeNull();
  });

  it('칸이 없는 행(옛 서버)은 변화 0이고 앱 목록도 부르지 않는다', () => {
    renderRow(reply({source: 'hermes_gateway', status: 'failed', run_id: RUN}));
    expect(screen.queryByTestId('app-notice')).toBeNull();
    expect(mockListPlugins).not.toHaveBeenCalled();
  });
});
