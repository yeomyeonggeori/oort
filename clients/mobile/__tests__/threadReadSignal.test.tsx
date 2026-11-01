import {ApiError, type Message, type RosterMember, type ThreadReadState} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render} from '@testing-library/react-native';
import React from 'react';
import {AppState} from 'react-native';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 폰 스레드 화면이 「여기까지 읽었어요」를 보내는 때와 그 응답의 길 (#4878, #4889 2단계).
// 서버는 가짜 응답이다. 규칙(앞으로만·404 중단·옛 응답)의 단위 시험은 코어 `threadRead.test.ts`에 있고, 여기서는 화면이
// **언제 부르고 응답을 어디로 넘기는가**를 잰다. 신호가 가야 「새 답글 M」 칩이 사라진다.
// =============================================================================

const mockMarkThreadRead = jest.fn();
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: name,
    handle: name,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([member(SELF, '곽성재'), member(OTHER, '김인턴')]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '배포는 금요일에 합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}
const ROOT = message({id: ROOT_ID, seq: 10});
const reply = (seq: number) => message({id: `reply-${seq}`, seq, rootId: ROOT_ID, body: `답글 ${seq}`});
const read = (unreadReplyCount: number): ThreadReadState => ({
  following: true,
  lastReadReplySeq: 12,
  unreadReplyCount,
});

function timeline(messages: Message[], applyThreadRead: jest.Mock): UseTimelineResult {
  return {
    state: {messages, oldestSeq: ROOT.seq, newestSeq: 30},
    status: 'ready',
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => {},
    applyThreadRead,
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
  } as unknown as UseTimelineResult;
}

function panel(messages: Message[], applyThreadRead: jest.Mock, over: {workspaceId?: string | null; channelId?: string | null} = {}) {
  const workspaceId = over.workspaceId === null ? undefined : (over.workspaceId ?? 'ws');
  const channelId = over.channelId === null ? undefined : (over.channelId ?? 'ch');
  return (
    <ThreadPanel
      root={ROOT}
      timeline={timeline(messages, applyThreadRead)}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      workspaceId={workspaceId}
      channelId={channelId}
      onClose={() => {}}
    />
  );
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

// RN jest preset의 `AppState.addEventListener`는 `jest.fn`이다(`appIconBadge.test.tsx`의 같은 도구): 구독을 가로채 전이를 손으로 낸다.
const appStateListen = AppState.addEventListener as unknown as jest.Mock;
const presetAppStateListen = appStateListen.getMockImplementation();
function captureAppState(): (status: string) => void {
  const handlers: ((status: string) => void)[] = [];
  appStateListen.mockImplementation(((_event: string, fn: (status: string) => void) => {
    handlers.push(fn);
    return {remove: () => handlers.splice(handlers.indexOf(fn), 1)};
  }) as never);
  return status => {
    act(() => {
      for (const fn of [...handlers]) fn(status);
    });
  };
}

beforeEach(() => {
  mockMarkThreadRead.mockReset();
  mockMarkThreadRead.mockResolvedValue(read(0));
});
afterEach(() => {
  cleanup();
  appStateListen.mockReset();
  if (presetAppStateListen) appStateListen.mockImplementation(presetAppStateListen);
});

describe('읽음 신호를 보내는 때', () => {
  it('답글을 받아 그리면 든 답글의 최대 seq를 한 번 보내고, 응답을 든 루트의 요약으로 넘긴다', async () => {
    const applyThreadRead = jest.fn();
    render(panel([ROOT, reply(11), reply(12)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead).toHaveBeenCalledTimes(1);
    expect(mockMarkThreadRead).toHaveBeenCalledWith('ws', 'ch', ROOT_ID, 12);
    await settle();
    expect(applyThreadRead).toHaveBeenCalledWith(ROOT_ID, read(0));
  });

  it('새 답글이 그려지면 더 높은 seq를 다시 보내고, 같은 목록이 다시 그려져도 보내지 않는다', async () => {
    const applyThreadRead = jest.fn();
    const view = render(panel([ROOT, reply(11), reply(12)], applyThreadRead));
    await settle();
    view.rerender(panel([ROOT, reply(11), reply(12)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead).toHaveBeenCalledTimes(1);
    view.rerender(panel([ROOT, reply(11), reply(12), reply(13)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead).toHaveBeenCalledTimes(2);
    expect(mockMarkThreadRead).toHaveBeenLastCalledWith('ws', 'ch', ROOT_ID, 13);
  });

  it('앱이 뒤에 있는 동안 온 답글은 읽은 것으로 치지 않고, 앞으로 오면 그때 보낸다', async () => {
    const emit = captureAppState();
    const applyThreadRead = jest.fn();
    const view = render(panel([ROOT, reply(11)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead.mock.calls.map(call => call[3])).toEqual([11]);
    emit('background');
    view.rerender(panel([ROOT, reply(11), reply(12)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead.mock.calls.map(call => call[3])).toEqual([11]);
    emit('active');
    await settle();
    expect(mockMarkThreadRead.mock.calls.map(call => call[3])).toEqual([11, 12]);
  });

  it('보낼 곳(워크스페이스·채널)을 모르는 격리 하니스는 보내지 않는다', async () => {
    render(panel([ROOT, reply(11)], jest.fn(), {workspaceId: null, channelId: null}));
    await settle();
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('답글이 없는 스레드는 보낼 것이 없다', async () => {
    render(panel([ROOT], jest.fn()));
    await settle();
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('옛 서버(404)면 그 뒤 새 답글에도 더 보내지 않는다', async () => {
    mockMarkThreadRead.mockRejectedValue(new ApiError(404, 'no route'));
    const applyThreadRead = jest.fn();
    const view = render(panel([ROOT, reply(11)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead).toHaveBeenCalledTimes(1);
    view.rerender(panel([ROOT, reply(11), reply(12)], applyThreadRead));
    await settle();
    expect(mockMarkThreadRead).toHaveBeenCalledTimes(1);
    expect(applyThreadRead).not.toHaveBeenCalled();
  });
});
