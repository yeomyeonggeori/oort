import {fetchChannelPins, fetchMessages, fetchReactionSnapshot} from '@momo/core/lib/api';
import type {ServerInboxPage} from '@momo/core/features/inbox/serverInbox';
import type {MessageNewEvent} from '@momo/core/lib/realtimeEvents';
import {QueryClient, type InfiniteData} from '@tanstack/react-query';
import {act, cleanup, renderHook} from '@testing-library/react-native';

import '../src/boot/polyfills';
import {
  attachmentSurfaceKey,
  resetAttachmentDraftsForTest,
  setPickerIssue,
  useAttachmentSurface,
} from '../src/features/attachments/draftStore';
import {channelDraftKey, readDrafts, saveDraft, threadDraftKey} from '../src/features/conversation/drafts';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {openFailedSendsForSession, readFailedSends, rememberFailedSend} from '../src/features/conversation/failedSends';
import {heldThreadRoots, phoneDmLeaveCleanupPort} from '../src/features/sidebar/dmLeaveCleanup';
import type {ChannelRail} from '../src/realtime/channelRail';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// 1:1 「대화 나가기」의 폰 쪽 두 이음매 (ADR-0177 증보 2026-11-14 D22 한계 3 · D17 기기 줄, #5826).
//
//   1. 실시간 하한: 열린 대화의 레일로 하한 아래 seq 의 프레임(다시 보내기로 온 나가기 전 글과 그 반응·고정·카드·지움)이 와도 그리지 않는다.
//   2. 성공 뒤 정리 문(`phoneDmLeaveCleanupPort`): 검색·받은함 캐시, 초안·스레드 초안·첨부 트레이에서 **그 방의 것만** 지운다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchMessages: jest.fn(),
  fetchReactionSnapshot: jest.fn(),
  fetchChannelPins: jest.fn(),
}));

const WS = 'workspace';
const CH = 'ch-dm-human';
const OTHER = 'ch-dm-other';
const ME = 'self';

type Handlers = Parameters<ChannelRail['subscribeChannel']>[2];

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

let handlers: Handlers | null = null;
const rail = {
  subscribeChannel: jest.fn((_ws: string, _ch: string, next: Handlers) => {
    handlers = next;
    return () => undefined;
  }),
} as unknown as ChannelRail;

function newFrame(seq: number): MessageNewEvent {
  return {
    type: 'message.new',
    v: 1,
    ts: 1,
    seq,
    payload: {
      id: `m-${seq}`,
      channel_id: CH,
      seq,
      type: 'text',
      body: `글 ${seq}`,
      author_member_id: 'peer',
      state: 'sent',
      created_at_ms: 1_700_000_000_000 + seq,
    } as MessageNewEvent['payload'],
  };
}

async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  __setNonSecretStore(memoryStore());
  handlers = null;
  jest.mocked(fetchMessages).mockReset().mockResolvedValue({messages: [], nextBefore: undefined} as never);
  jest.mocked(fetchReactionSnapshot).mockReset().mockResolvedValue({} as never);
  jest.mocked(fetchChannelPins).mockReset().mockResolvedValue([] as never);
  resetAttachmentDraftsForTest();
  openFailedSendsForSession(ME);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  __setNonSecretStore(null);
});

describe('실시간 하한 — 하한 아래 발행물은 그리지 않는다 (D22 한계 3)', () => {
  it('새 글·반응·고정·지움 프레임: 하한(5) 아래 seq 는 버리고, 하한부터는 그린다', async () => {
    const view = renderHook(
      ({floor}: {floor: number | null}) => useTimeline(rail, WS, CH, ME, floor),
      {initialProps: {floor: 5}},
    );
    await settle();
    expect(handlers).not.toBeNull();
    act(() => {
      handlers?.onMessage(newFrame(3));
      handlers?.onMessage(newFrame(5));
      handlers?.onMessage(newFrame(6));
    });
    await settle();
    expect(view.result.current.state.messages.map(message => message.seq)).toEqual([5, 6]);

    act(() => {
      handlers?.onReaction?.({
        type: 'reaction.added',
        v: 1,
        ts: 1,
        seq: 3,
        payload: {action: 'added', message_id: 'm-3', member_id: 'peer', emoji: '👍'},
      });
      handlers?.onReaction?.({
        type: 'reaction.added',
        v: 1,
        ts: 1,
        seq: 6,
        payload: {action: 'added', message_id: 'm-6', member_id: 'peer', emoji: '👍'},
      });
      handlers?.onPin?.({
        type: 'message.pinned',
        v: 1,
        ts: 1,
        seq: 3,
        payload: {
          message_id: 'm-3',
          channel_id: CH,
          seq: 3,
          author_member_id: 'peer',
          type: 'text',
          state: 'sent',
          body: '나가기 전 고정',
          created_at_ms: 1,
          pinned_by: 'peer',
          pinned_at_ms: 2,
        },
      });
    });
    await settle();
    expect(Object.keys(view.result.current.reactions)).toEqual(['m-6']);
    expect(Object.keys(view.result.current.pins)).toEqual([]);

    const card = (messageId: string) => ({
      id: `u-${messageId}`,
      messageId,
      url: 'https://example.com/a',
      status: 'ok' as const,
      title: '카드',
    });
    act(() => {
      handlers?.onUnfurl?.({
        type: 'message.unfurl',
        v: 1,
        ts: 1,
        seq: 3,
        payload: {message_id: 'm-3', channel_id: CH, unfurls: [card('m-3')]},
      });
      handlers?.onUnfurl?.({
        type: 'message.unfurl',
        v: 1,
        ts: 1,
        seq: 6,
        payload: {message_id: 'm-6', channel_id: CH, unfurls: [card('m-6')]},
      });
    });
    await settle();
    expect(Object.keys(view.result.current.unfurls).map(key => key.toLowerCase())).toEqual(['m-6']);

    // 하한 아래 글의 지움 프레임은 그려진 줄(5)을 건드리지 않는다 — 대상이 하한 위면 그대로 지운다.
    act(() => {
      handlers?.onMessageDeleted?.({type: 'message.deleted', v: 1, ts: 9, seq: 4, payload: {message_id: 'm-5'}});
    });
    await settle();
    expect(view.result.current.state.messages.find(message => message.seq === 5)?.deletedAtMs).toBeUndefined();
  });

  it('하한이 없으면(나가지 않은 대화) 거르지 않는다', async () => {
    const view = renderHook(() => useTimeline(rail, WS, CH, ME, null));
    await settle();
    act(() => {
      handlers?.onMessage(newFrame(3));
    });
    await settle();
    expect(view.result.current.state.messages.map(message => message.seq)).toEqual([3]);
  });
});

function inboxPage(items: Array<{channelId: string; messageId: string; rootId?: string}>): ServerInboxPage {
  return {
    items: items.map((item, index) => ({
      id: `i-${index}`,
      kind: 'mention',
      reasons: ['mention'],
      channel: {id: item.channelId, name: null, kind: 'dm'},
      message: {id: item.messageId, seq: index + 1, authorMemberId: 'peer', preview: '미리보기', deleted: false},
      ...(item.rootId ? {rootId: item.rootId} : null),
      actorMemberId: 'peer',
      createdAtMs: 1,
      readAtMs: null,
    })),
    nextCursor: null,
    unreadCount: items.length,
  } as unknown as ServerInboxPage;
}

describe('성공 뒤 정리 문 — 그 방의 것만 (D17 기기 줄)', () => {
  it('검색 결과·받은함 항목·받은함 미리보기 캐시에서 그 방만 빠지고 다른 방은 그대로다', () => {
    const client = new QueryClient();
    const searchKey = ['message-search', WS, '회의', undefined];
    client.setQueryData(searchKey, {
      pages: [{hits: [{channelId: CH, messageId: 'a'}, {channelId: OTHER, messageId: 'b'}]}],
      pageParams: [undefined],
    });
    client.setQueryData(['inbox', WS, 'all'], {
      pages: [inboxPage([{channelId: CH, messageId: 'x'}, {channelId: OTHER, messageId: 'y'}])],
      pageParams: [undefined],
    });
    client.setQueryData(['inbox-dm', WS, CH, 2], {messages: [{id: 'r-1', channelId: CH, seq: 1}]});
    client.setQueryData(['inbox-dm', WS, OTHER, 4], {messages: [{id: 'r-9', channelId: OTHER, seq: 1}]});
    client.setQueryData(['inbox-thread-reply', WS, 'r-1', 3], {messages: []});
    const port = phoneDmLeaveCleanupPort({client, workspaceId: WS, selfMemberId: ME, threadRootIds: []});
    port.dropSearchResults(CH);
    port.dropInboxItems(CH);
    const search = client.getQueryData<InfiniteData<{hits: Array<{channelId: string}>}>>(searchKey);
    expect(search?.pages[0].hits.map(hit => hit.channelId)).toEqual([OTHER]);
    const inbox = client.getQueryData<InfiniteData<ServerInboxPage>>(['inbox', WS, 'all']);
    expect(inbox?.pages[0].items.map(item => item.channel.id)).toEqual([OTHER]);
    expect(client.getQueryData(['inbox-dm', WS, CH, 2])).toBeUndefined();
    expect(client.getQueryData(['inbox-thread-reply', WS, 'r-1', 3])).toBeUndefined();
    expect(client.getQueryData(['inbox-dm', WS, OTHER, 4])).toBeDefined();
  });

  it('초안: 그 방의 입력칸·스레드 초안(이 기기가 든 뿌리)·첨부 트레이만 지운다', () => {
    const client = new QueryClient();
    saveDraft(channelDraftKey(CH), '나가기 전 초안');
    saveDraft(threadDraftKey('root-in'), '그 방 스레드 답글');
    saveDraft(threadDraftKey('root-inbox'), '받은함으로 안 그 방 스레드');
    saveDraft(threadDraftKey('root-out'), '다른 방 스레드 답글');
    saveDraft(channelDraftKey(OTHER), '다른 방 초안');
    client.setQueryData(['inbox', WS, 'all'], {
      pages: [inboxPage([{channelId: CH, messageId: 'z', rootId: 'root-inbox'}])],
      pageParams: [undefined],
    });
    const mine = attachmentSurfaceKey({workspaceId: WS, channelId: CH});
    const mineThread = attachmentSurfaceKey({workspaceId: WS, channelId: CH, rootId: 'root-in'});
    const theirs = attachmentSurfaceKey({workspaceId: WS, channelId: OTHER});
    const issue = {kind: 'tooLarge'} as never;
    setPickerIssue(mine, issue);
    setPickerIssue(mineThread, issue);
    setPickerIssue(theirs, issue);

    const roots = heldThreadRoots(client, WS, CH, ['root-in', 'm-1']);
    expect(roots.sort()).toEqual(['root-in', 'root-inbox']);
    phoneDmLeaveCleanupPort({client, workspaceId: WS, selfMemberId: ME, threadRootIds: roots}).clearDrafts(CH);

    const drafts = readDrafts();
    expect(Object.keys(drafts).sort()).toEqual([channelDraftKey(OTHER), threadDraftKey('root-out')].sort());
    const surface = (key: string) => renderHook(() => useAttachmentSurface(key)).result.current.pickerIssue;
    expect(surface(mine)).toBeNull();
    expect(surface(mineThread)).toBeNull();
    expect(surface(theirs)).not.toBeNull();
  });

  it('스레드 초안: 이 기기가 뿌리를 연 적이 없어도 그 대화에 속한 것은 열쇠로 다 지우고 다른 대화 것은 그대로다', () => {
    const client = new QueryClient();
    // 입력칸이 채널을 적어 둔 초안(`saveDraft` 의 넷째 인자). 뿌리는 이 기기가 든 메시지 id 에 없다.
    saveDraft(threadDraftKey('root-never-opened'), '든 적 없는 뿌리의 답글', undefined, CH);
    saveDraft(threadDraftKey('root-other-room'), '다른 대화의 스레드 답글', undefined, OTHER);
    saveDraft(threadDraftKey('root-legacy-held'), '채널을 안 적은 옛 초안', undefined);
    const roots = heldThreadRoots(client, WS, CH, ['root-legacy-held']);
    expect(roots).toEqual(['root-legacy-held']);
    phoneDmLeaveCleanupPort({client, workspaceId: WS, selfMemberId: ME, threadRootIds: roots}).clearDrafts(CH);
    expect(Object.keys(readDrafts())).toEqual([threadDraftKey('root-other-room')]);
  });

  it('못 보낸 글: 나간 순간까지 쓴 글은 정리 뒤에 다시 적히지 않고, 다시 이어진 뒤 쓴 글·다른 대화 글은 평소처럼 남는다', () => {
    const client = new QueryClient();
    const row = (clientMsgId: string, channelId: string, createdAtMs: number) => ({
      clientMsgId,
      channelId,
      authorMemberId: ME,
      body: clientMsgId,
      createdAtMs,
      sinceSeq: null,
      status: 'failed' as const,
    });
    const port = phoneDmLeaveCleanupPort({client, workspaceId: WS, selfMemberId: ME, threadRootIds: []});
    const before = Date.now();
    port.forgetFailedSends(CH);
    // 대화가 걷히며 보내는 중이던 글을 적는다 · 그 요청이 늦게 실패해 또 적는다.
    rememberFailedSend(WS, row('sending-at-leave', CH, before - 5), null);
    rememberFailedSend(WS, row('late-failure', CH, before), null);
    expect(readFailedSends(WS, CH, ME)).toHaveLength(0);
    // 다른 대화는 그대로 적힌다.
    rememberFailedSend(WS, row('other-room', OTHER, before - 5), null);
    expect(readFailedSends(WS, OTHER, ME)).toHaveLength(1);
    // 다시 이어진 뒤(나간 순간 이후)에 새로 쓴 글의 실패는 평소처럼 남는다.
    rememberFailedSend(WS, row('after-rejoin', CH, Date.now() + 1), null);
    expect(readFailedSends(WS, CH, ME).map(item => item.row.clientMsgId)).toEqual(['after-rejoin']);
  });

  it('투영 행: 그 방의 행만 `update` 로 바꾼다', () => {
    const client = new QueryClient();
    const row = (channelId: string) => ({
      channelId,
      lastReadSeq: 1,
      latestSeq: 2,
      unreadCount: 1,
      mentionCount: 0,
      markedUnreadBeforeSeq: null,
    });
    client.setQueryData(['read-state', WS], [row(CH), row(OTHER)]);
    phoneDmLeaveCleanupPort({client, workspaceId: WS, selfMemberId: ME, threadRootIds: []}).updateReadRow(
      CH,
      current => ({...current, historyFromSeq: 3}),
    );
    const rows = client.getQueryData<Array<{channelId: string; historyFromSeq?: number}>>(['read-state', WS]);
    expect(rows?.map(item => item.historyFromSeq)).toEqual([3, undefined]);
  });
});
