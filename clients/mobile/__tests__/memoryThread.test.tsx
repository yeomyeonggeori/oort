import type {Message, RosterMember} from '@momo/core/lib/api';
import type {MemoryDigest} from '@momo/core/features/memory/model';
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

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// #3166 — 스레드의 「안 읽은 동안」 카드.
//
// 스레드에는 자기 안읽음 경계가 없다. 그래서 채널이 방문에서 얼린 경계(`sinceSeq`)
// 뒤에 온 **남의** 답글이 있을 때만 카드가 서고, 요청에는 threadRootId 가 실린다.
// 근거가 이 스레드 안 답글이면 판이 스스로 내려앉고, 밖이면 채널이 받아 간다.
// =============================================================================

const mockList = jest.fn();
jest.mock('@momo/core/features/memory/api', () => ({
  listMemoryDigests: (...args: unknown[]) => mockList(...args),
  getMemorySettings: async () => ({
    workspace: {enabled: true, paused: false, resetEpoch: 0},
    channels: [],
    me: {paused: false},
  }),
  getRunMemoryReceipt: async () => {
    throw new Error('not used');
  },
  patchMyMemorySettings: async () => ({paused: false}),
  // 답 밑의 제안 카드(#3171)가 부르는 자리. 이 파일은 제안을 시험하지 않으므로 빈 목록.
  listMemoryProposals: async () => [],
  acceptMemoryProposal: async () => {
    throw new Error('not used');
  },
  rejectMemoryProposal: async () => {
    throw new Error('not used');
  },
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CH = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws', kind: 'human', status: 'active', displayName: '이름', handle: 'h',
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...over,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`, channelId: CH, seq, hlcTs: seq, hlcCount: 0, authorMemberId: OTHER,
    type: 'text', body: `${seq}번째`, state: 'sent', createdAtMs: BASE_MS + seq * 1000, ...over,
  };
}

const ROOT = message(10, {id: ROOT_ID});
const REPLIES = Array.from({length: 5}, (_, i) =>
  message(20 + i, {id: `reply-${20 + i}`, rootId: ROOT_ID}),
);

function digest(evidenceId: string): MemoryDigest {
  return {
    id: 'd-1', channelId: CH, threadRootId: ROOT_ID, level: 'window', fromSeq: 20, toSeq: 24,
    body: '- 롤백 절차를 정리했어요.', sourceCount: 5, createdAtMs: BASE_MS,
    evidence: [{messageId: evidenceId, channelId: CH, seq: 22}],
  };
}

function renderThread(replies: Message[], memory?: React.ComponentProps<typeof ThreadPanel>['memory']) {
  const timeline = {
    state: {messages: [ROOT, ...replies], oldestSeq: 10, newestSeq: 99},
    status: 'ready', resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [], pending: [], send: async () => {}, resend: async () => {},
    toggleReaction: async () => {}, editBody: async () => {}, removeMessage: async () => {},
    loadReplies: async () => {}, sendReply: async () => {}, repliesPending: () => [],
    loadOlder: async () => {}, reload: () => {}, loadingOlder: false, reachedStart: true,
    reactions: {}, pins: new Map(), pinsStatus: 'ready', reloadPins: () => {}, togglePin: async () => {},
  } as unknown as UseTimelineResult;
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(
    <QueryClientProvider client={client}>
      <ThreadPanel
        root={ROOT}
        workspaceId="ws-1"
        channelId={CH}
        timeline={timeline}
        directory={DIRECTORY}
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        onClose={() => {}}
        memory={memory}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockList.mockReset());
afterEach(cleanup);

describe('스레드 요약 카드', () => {
  it('경계 뒤 남의 답글이 문턱만큼 쌓였을 때만 서고 threadRootId 를 싣는다', async () => {
    mockList.mockResolvedValue({digests: [digest('reply-22')], afterSeq: 15, summarizedThroughSeq: 24});
    renderThread(REPLIES, {sinceSeq: 15, headSeq: 24, onOpenEvidenceOutside: jest.fn()});
    await waitFor(() => expect(screen.getByTestId('missed-digest-ready')).toBeTruthy());
    expect(mockList).toHaveBeenCalledWith('ws-1', CH, expect.objectContaining({sinceSeq: 15, threadRootId: ROOT_ID}));
  });

  it('내가 쓴 답글은 안 읽은 것이 아니다', async () => {
    const mine = REPLIES.map(r => ({...r, authorMemberId: SELF}));
    renderThread(mine, {sinceSeq: 15, headSeq: 24, onOpenEvidenceOutside: jest.fn()});
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.queryByTestId('missed-digest-card')).toBeNull();
  });

  it('경계보다 앞선 답글뿐이면 카드가 없다', async () => {
    renderThread(REPLIES, {sinceSeq: 30, headSeq: 30, onOpenEvidenceOutside: jest.fn()});
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
  });

  it('memory 가 없으면 카드도 요청도 없다 (옛 호출자)', async () => {
    renderThread(REPLIES, undefined);
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
  });

  it('스레드 밖 근거는 채널에 넘긴다', async () => {
    const outside = jest.fn();
    mockList.mockResolvedValue({digests: [digest('main-msg-1')], afterSeq: 15, summarizedThroughSeq: 24});
    renderThread(REPLIES, {sinceSeq: 15, headSeq: 24, onOpenEvidenceOutside: outside});
    await waitFor(() => expect(screen.getByTestId('missed-digest-evidence-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('missed-digest-evidence-1'));
    expect(outside).toHaveBeenCalledWith({messageId: 'main-msg-1', channelId: CH, seq: 22});
  });

  it('스레드 안 답글 근거는 채널에 넘기지 않고 판이 직접 내려앉는다', async () => {
    const outside = jest.fn();
    mockList.mockResolvedValue({digests: [digest('reply-22')], afterSeq: 15, summarizedThroughSeq: 24});
    renderThread(REPLIES, {sinceSeq: 15, headSeq: 24, onOpenEvidenceOutside: outside});
    await waitFor(() => expect(screen.getByTestId('missed-digest-evidence-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('missed-digest-evidence-1'));
    expect(outside).not.toHaveBeenCalled();
  });
});
