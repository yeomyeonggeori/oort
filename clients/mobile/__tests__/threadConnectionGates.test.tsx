import NetInfo from '@react-native-community/netinfo';
import {DISPLAY_GRACE_MS, HEALED_MS} from '@momo/core/features/connection/thresholds';
import {fetchWithDeadline} from '@momo/core/lib/http';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React, {useRef} from 'react';

import {FixedScheme} from '../src/design/theme';
import {
  ConnectionProvider,
  NO_FEED,
  type SocketFeed,
} from '../src/features/connection/ConnectionProvider';
import type {ApprovalGate} from '../src/features/conversation/approvalGate';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';
import type {DisplayEvent} from '../src/realtime/connectionDisplay';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 스레드 안의 승인 카드와 스레드 입력창도 연결 상태 모델의 게이트를 따른다 (#5262, #5222 후속, #5201 결정 ③).
//
// 두 자리는 NetInfo 하나만 읽었다(`useOnline`): 서버에 닿지 못해도 기기는 온라인이라 단추가 서 있었고, 눌러야 실패했다. 이제
// `useConnectionGates()` 가 답한다 - 기기 오프라인과 서버에 닿지 못함만 막고(원인별 문장), 실시간만 끊기면 열어 둔다.
//
// 원인 셋은 **실제 입력**으로 만든다(NetInfo 목 · 서로 다른 REST 요청 셋의 실패 · 전송이 먹이는 소켓 사건). 문장은 손으로 지은 장면이 아니라
// 코어 모델이 고른 사전 키가 말한다. 시간은 가짜 시계로 흘린다.
// =============================================================================

const WS = 'ws-1';
const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ROOT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;
const ME = {id: SELF, workspaceId: WS, displayName: '곽성재'} as Member;

const OFFLINE_COMPOSER = '오프라인이라 지금은 보낼 수 없어요. 쓰던 글은 그대로 있고, 다시 연결되면 여기서 보낼 수 있어요.';
const SERVER_COMPOSER = '서버에 닿지 못해 지금은 보낼 수 없어요. 쓰던 글은 그대로 있고, 다시 연결되면 여기서 보낼 수 있어요.';
const OFFLINE_APPROVAL = '오프라인이라 지금은 결정할 수 없어요. 다시 연결되면 여기서 승인하거나 거부할 수 있어요.';
const SERVER_APPROVAL = '서버에 닿지 못해 지금은 결정할 수 없어요. 다시 연결되면 여기서 승인하거나 거부할 수 있어요.';

function member(id: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: id === AGENT ? 'agent' : 'human',
    status: 'active',
    displayName: id === AGENT ? '김인턴' : '곽성재',
    handle: id === AGENT ? 'intern-kim' : 'seongjae',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([member(SELF), member(AGENT)]);

const ROOT = {
  id: ROOT_ID,
  channelId: 'ch',
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: '이 스레드에서 의논해요',
  state: 'sent',
  createdAtMs: BASE_MS,
} as Message;

/** 스레드 안의 승인 요청 카드. 묶음(intent)이 있는 판과 없는 판이 서로 다른 문장 자리를 가진다. */
function approvalCard(approvalId: string, seq: number, over: Record<string, unknown> = {}): Message {
  return {
    id: `msg-${approvalId}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'approval_request',
    body: '툴 호출 승인',
    state: 'sent',
    rootId: ROOT_ID,
    createdAtMs: BASE_MS + seq,
    props: {
      approval_id: approvalId,
      title: 'github.search_issues 실행 허가',
      approval_status: 'pending',
      ...over,
    },
  } as unknown as Message;
}

const PLAIN = approvalCard('ap-1', 11);
const BUNDLE = approvalCard('ap-2', 12, {
  intent: '자기 소개를 바꾸려고 해요',
  can_decide: true,
  decision_mode: 'inline',
  action_type: 'workspace_action',
  action: {
    id: 'agent.profile.update',
    rows: [{label: '소개', value: '다음 소개', before: '이전 소개', after: '다음 소개'}],
    rationale: '요청한 소개를 반영해요',
  },
});

const GATES = new Map<string, ApprovalGate>([
  ['ap-1', {approvalId: 'ap-1', reversible: false, expiresAtMs: null}],
  ['ap-2', {approvalId: 'ap-2', reversible: false, expiresAtMs: null}],
]);

const timeline = {
  state: {messages: [ROOT, PLAIN, BUNDLE], oldestSeq: 10, newestSeq: 12},
  status: 'ready',
  resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
  recoveryMarkers: [],
  pending: [],
  send: async () => {},
  resend: async () => {},
  discard: async () => null,
  toggleReaction: async () => {},
  editBody: async () => {},
  removeMessage: async () => {},
  loadReplies: async () => ({following: false}),
  sendReply: async () => {},
  repliesPending: (): PendingMessage[] => [],
  loadOlder: async () => {},
  reload: () => {},
  reactions: new Map(),
  pins: new Map(),
  unfurls: new Map(),
  applyThreadRead: () => {},
} as unknown as UseTimelineResult;

const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};
const feedRef: React.MutableRefObject<SocketFeed> = {current: NO_FEED};

function Host(): React.JSX.Element {
  const holder = useRef(feedRef);
  const client = useRef(
    new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}}),
  );
  return (
    <FixedScheme scheme="light">
      <RealtimeContext.Provider value={{rail: null, status: 'connected', subscriptionsWanted: true}}>
        <ConnectionProvider feedRef={holder.current}>
          <QueryClientProvider client={client.current}>
            <SessionProvider member={ME}>
              <ThreadPanel
                root={ROOT}
                timeline={timeline}
                directory={DIRECTORY}
                myMemberId={SELF}
                nowMs={BASE_MS}
                onClose={() => {}}
                approvalGates={GATES}
                approvalsProvided
              />
            </SessionProvider>
          </QueryClientProvider>
        </ConnectionProvider>
      </RealtimeContext.Provider>
    </FixedScheme>
  );
}

const feed = (event: DisplayEvent) => act(() => feedRef.current(event));
const raw = (status: 'connected' | 'connecting' | 'disconnected') => feed({kind: 'raw', status});
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const emitNet = (online: boolean) =>
  act(() => netInfo.__emit({isConnected: online, isInternetReachable: online}));

const REST_OK = {status: 200, ok: true, text: async () => '{}', headers: {get: () => null}};
async function restFail(path: string) {
  (globalThis.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));
  await act(async () => {
    await fetchWithDeadline(`https://api.example.com/v1${path}`).catch(() => undefined);
  });
}
async function restOk(path: string) {
  (globalThis.fetch as jest.Mock).mockResolvedValueOnce(REST_OK);
  await act(async () => {
    await fetchWithDeadline(`https://api.example.com/v1${path}`);
  });
}
/** 서로 다른 요청 셋이 응답 없이 끝났다: 서버에 닿지 못함 선언. 기기는 온라인인 채로다. */
async function serverUnreachable() {
  await restFail('/channels');
  await restFail('/roster');
  await restFail('/read-state');
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(1_700_000_000_000);
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  feedRef.current = NO_FEED;
  render(<Host />);
  // 스레드를 여는 읽기(`loadReplies`)가 끝나 `ready` 가 되는 갱신까지 act 안에서 받는다.
  await tick(0);
  // 소켓이 붙어 오래 건강하다: 이 뒤의 끊김은 새 틈이다.
  await raw('connected');
  await tick(HEALED_MS + 100);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

const plainActions = () => screen.queryByTestId('card-approval-ap-1-actions');
const plainNote = () => screen.queryByTestId('card-approval-offline');
const bundleApprove = () => screen.queryByTestId('card-approval-ap-2-approve');
const bundleWaiting = () => screen.queryByTestId('request-bundle-waiting');
const composerNote = () => screen.queryByTestId('composer-offline');
/** 빈 입력창의 보내기 단추는 연결과 무관하게 꺼져 있다. 글을 친 뒤의 단추가 연결의 답이다. */
function sendButton() {
  fireEvent.changeText(screen.getByTestId('composer-input'), '답글 쓰기');
  return screen.getByTestId('composer-send');
}

describe('스레드 안 승인 카드와 입력창은 연결 모델이 막는 만큼만 막는다', () => {
  it('처음에는 열려 있다: 승인 단추가 서고 입력창에 막는 문장이 없다', () => {
    expect(plainActions()).toBeTruthy();
    expect(bundleApprove()).toBeTruthy();
    expect(plainNote()).toBeNull();
    expect(composerNote()).toBeNull();
    expect(sendButton().props.accessibilityState.disabled).toBeFalsy();
  });

  it('기기 오프라인: 승인은 단추 대신 「오프라인이라」 문장, 입력창도 같은 원인 문장으로 잠긴다', async () => {
    await emitNet(false);
    expect(plainActions()).toBeNull();
    expect(bundleApprove()).toBeNull();
    expect(plainNote()).toHaveTextContent(OFFLINE_APPROVAL);
    expect(bundleWaiting()).toHaveTextContent(OFFLINE_APPROVAL);
    expect(composerNote()).toHaveTextContent(OFFLINE_COMPOSER);
    const send = sendButton();
    expect(send.props.accessibilityState.disabled).toBe(true);
    expect(send.props.accessibilityHint).toBe(OFFLINE_COMPOSER);
  });

  it('서버에 닿지 못함: 기기는 온라인이어도 막고, 「오프라인」이 아니라 「서버에 닿지 못해」라고 말한다', async () => {
    await serverUnreachable();
    expect(plainActions()).toBeNull();
    expect(bundleApprove()).toBeNull();
    expect(plainNote()).toHaveTextContent(SERVER_APPROVAL);
    expect(bundleWaiting()).toHaveTextContent(SERVER_APPROVAL);
    expect(composerNote()).toHaveTextContent(SERVER_COMPOSER);
    const send = sendButton();
    expect(send.props.accessibilityState.disabled).toBe(true);
    expect(send.props.accessibilityHint).toBe(SERVER_COMPOSER);
    // 쓰던 글은 그대로 있다: 막아도 입력은 열려 있다.
    expect(screen.getByTestId('composer-input').props.value).toBe('답글 쓰기');
  });

  it('실시간만 끊김: 소켓이 10초 넘게 끊겨도 승인 단추도 입력창도 열려 있다 - 전송도 결정도 REST 라서', async () => {
    await raw('connecting');
    await tick(DISPLAY_GRACE_MS + 500);
    // 끊김을 말하는 시점인데도(소켓 틈 10초 초과) 두 자리는 막히지 않는다.
    expect(plainActions()).toBeTruthy();
    expect(bundleApprove()).toBeTruthy();
    expect(plainNote()).toBeNull();
    expect(bundleWaiting()).toBeNull();
    expect(composerNote()).toBeNull();
    expect(sendButton().props.accessibilityState.disabled).toBeFalsy();
  });

  it('서버가 다시 답하면 다시 열린다 - 막음이 풀린 뒤에도 문장이 남지 않는다', async () => {
    await serverUnreachable();
    expect(composerNote()).toBeTruthy();
    await restOk('/channels');
    expect(composerNote()).toBeNull();
    expect(plainNote()).toBeNull();
    expect(plainActions()).toBeTruthy();
    expect(within(screen.getByTestId('composer-root')).queryByTestId('composer-offline')).toBeNull();
  });
});
