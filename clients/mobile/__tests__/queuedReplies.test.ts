import {ApiError} from '@momo/core/lib/api';

import {
  channelDraftKey,
  readDraft,
  readDrafts,
  saveDraft,
  threadDraftKey,
} from '../src/features/conversation/drafts';
import type {QueuedReplyStore} from '../src/push/native';
import {
  clearQueuedReplies,
  drainQueuedReplies,
  QUEUED_REPLY_GIVE_UP_MS,
  QUEUED_REPLY_MAX_AGE_MS,
  signedInDrainContext,
  type DrainContext,
  type DrainDeps,
  type QueuedReply,
} from '../src/push/queuedReplies';

// 저장된 세션(지금 들어와 있는 사람). 기본은 없음 — 초안의 글쓴이도 그때는 없음이다(`drafts.ts` `currentAuthor`).
let mockSession: {member: {id: string}} | null = null;
jest.mock('../src/storage/secureSession', () => ({
  getPersistedSession: () => mockSession,
}));

// =============================================================================
// #6036 — 잠금 화면 답장의 보관 목록을 비우는 쪽(JS). 네이티브가 남긴 항목을 사람의 세션으로 **같은 열쇠로
// 한 번만** 보내고, 끝내 못 보내면 그 대화의 초안으로 넣고 알리며, 다른 사람의 것은 보내지도 두지도 않는다.
// =============================================================================

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const ROOT = '66666666-6666-4666-8666-666666666666';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const ME = '77777777-7777-4777-8777-777777777777';
const SOMEONE = '88888888-8888-4888-8888-888888888888';
const NOW = 1_800_000_000_000;

function origin(thread = CHANNEL, workspace = WS) {
  return {
    aps: {badge: 1, 'thread-id': thread, category: 'momo.message'},
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: workspace,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-1',
      reason: 'dm',
    },
  };
}

function reply(over: Partial<QueuedReply> & {thread?: string} = {}): QueuedReply {
  const {thread, ...rest} = over;
  return {
    v: 1,
    clientMsgId: 'aaaaaaaa-0000-4000-8000-000000000001',
    workspaceID: WS,
    memberID: ME,
    text: '곧 갈게요',
    requestIdentifier: 'apns-1',
    origin: JSON.stringify(origin(thread)),
    createdAtMs: NOW - 60_000,
    ...rest,
  };
}

class FakeStore implements QueuedReplyStore {
  items = new Map<string, string>();
  removed: string[] = [];
  cleared = 0;
  marked: string[] = [];
  constructor(...replies: QueuedReply[]) {
    for (const r of replies) this.items.set(r.clientMsgId, JSON.stringify(r));
  }
  list() {
    return [...this.items.values()];
  }
  remove(id: string) {
    this.removed.push(id);
    this.items.delete(id);
  }
  /** Swift `markRefused` 처럼 항목에 거절된 때를 적는다(처음 한 번만). */
  markRefused(id: string) {
    const raw = this.items.get(id);
    if (raw === undefined) return false;
    this.marked.push(id);
    const item = JSON.parse(raw) as QueuedReply;
    this.items.set(id, JSON.stringify({...item, refusedAtMs: item.refusedAtMs ?? NOW}));
    return true;
  }
  clear() {
    this.cleared += 1;
    this.items.clear();
  }
}

const copy = {drafted: '초안으로 남겼어요', notSentTitle: '못 보냈어요', notSentBody: '앱에서 다시'};

function context(over: Partial<DrainContext> = {}): DrainContext {
  return {workspaceId: WS, memberId: ME, isCurrent: () => true, copy, ...over};
}

function deps(store: FakeStore, send: DrainDeps['send'], now = NOW) {
  const notify = jest.fn(async () => {});
  const dismiss = jest.fn(async () => {});
  return {store, send, now: () => now, notify, dismiss};
}

beforeEach(() => {
  mockSession = null;
  for (const key of [channelDraftKey(CHANNEL), threadDraftKey(ROOT)]) saveDraft(key, '', NOW);
});

/** 초안 지도에 이 글이 어느 자리에든 있는가 — 읽는 사람과 상관없이(`readDraft` 는 글쓴이로 거른다). */
function draftedAnywhere(text: string): boolean {
  return Object.values(readDrafts()).some(draft => draft.body === text);
}

describe('보낸다 — 같은 열쇠로, 한 번만', () => {
  it('남긴 열쇠로 보내고, 목록에서 지우고, 「앱을 열면 보내요」 줄을 걷는다', async () => {
    const store = new FakeStore(reply());
    const send = jest.fn(async () => {});
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);

    expect(send).toHaveBeenCalledTimes(1);
    const [sent, envelope] = send.mock.calls[0] as unknown as [QueuedReply, {channelId: string}];
    expect(sent.clientMsgId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(sent.text).toBe('곧 갈게요');
    expect(envelope.channelId).toBe(CHANNEL);
    expect(store.items.size).toBe(0);
    expect(d.dismiss).toHaveBeenCalledWith('apns-1');
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('비우기가 여러 번 겹쳐도(앱 시작 · 앞으로 옴 · 뒤에서 들은 답장) 한 번만 보낸다', async () => {
    const store = new FakeStore(reply(), reply({clientMsgId: 'aaaaaaaa-0000-4000-8000-000000000002', text: '둘째'}));
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const send = jest.fn(async (_reply: QueuedReply) => gate);
    const d = deps(store, send);

    const runs = [drainQueuedReplies(context(), d), drainQueuedReplies(context(), d), drainQueuedReplies(context(), d)];
    release();
    await Promise.all(runs);

    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(call => call[0].clientMsgId)).size).toBe(2);
  });

  it('망이 끊겼으면 목록에 두고, 다음 비우기에서 같은 열쇠로 다시 보낸다', async () => {
    const store = new FakeStore(reply());
    const send = jest
      .fn<Promise<void>, [QueuedReply, unknown]>()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValue(undefined);
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);
    expect(store.items.size).toBe(1);
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('');

    await drainQueuedReplies(context(), d);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1][0] as QueuedReply).clientMsgId).toBe((send.mock.calls[0][0] as QueuedReply).clientMsgId);
    expect(store.items.size).toBe(0);
  });

  it.each([
    ['5xx', new ApiError(503, 'unavailable')],
    ['429', new ApiError(429, 'slow down')],
  ])('%s 도 다시 보낼 수 있는 실패다 — 초안으로 넘기지 않는다', async (_name, error) => {
    const store = new FakeStore(reply());
    const d = deps(store, jest.fn().mockRejectedValue(error));

    await drainQueuedReplies(context(), d);

    expect(store.items.size).toBe(1);
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe('끝내 못 보내면 그 대화의 초안으로 넣고 알린다', () => {
  it('서버가 거절하면(403) 채널 초안에 넣고, 목록에서 지우고, 같은 줄을 바꿔 알린다', async () => {
    const store = new FakeStore(reply());
    const d = deps(store, jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')));

    await drainQueuedReplies(context(), d);

    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('곧 갈게요');
    expect(store.items.size).toBe(0);
    expect(d.notify).toHaveBeenCalledWith('apns-1', copy.drafted, '', origin());
  });

  it('스레드의 답장은 스레드 초안으로 간다', async () => {
    const store = new FakeStore(reply({thread: ROOT}));
    const d = deps(store, jest.fn().mockRejectedValue(new ApiError(404, 'gone')));

    await drainQueuedReplies(context(), d);

    expect(readDraft(threadDraftKey(ROOT), NOW)).toBe('곧 갈게요');
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('');
  });

  it('서버가 거절하면 항목에 「거절됨」을 적는다 — 초안 자리가 차 있어 남아도 다시 보내지 않는다', async () => {
    const store = new FakeStore(reply());
    const d = deps(store, jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')));

    await drainQueuedReplies(context(), d);

    expect(store.marked).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
  });

  it('그 자리에 쓰던 초안이 있으면 덮지 않고 목록에 둔다', async () => {
    saveDraft(channelDraftKey(CHANNEL), '쓰던 글', NOW);
    const store = new FakeStore(reply());
    const d = deps(store, jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')));

    await drainQueuedReplies(context(), d);

    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('쓰던 글');
    expect(store.items.size).toBe(1);
    expect(d.notify).not.toHaveBeenCalled();
  });

  // A7-13 수용 기준 4: 고치기 전에는 앞으로 올 때마다 같은 글을 다시 POST 했다(보안 검수 r1 M2 ②).
  it('거절됐고 초안 자리가 찬 항목: 앱이 세 번 앞으로 와도 보내기는 처음 한 번뿐이고, 자리가 나면 초안으로 간다', async () => {
    saveDraft(channelDraftKey(CHANNEL), '쓰던 글', NOW);
    const store = new FakeStore(reply());
    const send = jest.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    const d = deps(store, send);

    for (let foreground = 0; foreground < 3; foreground += 1) {
      await drainQueuedReplies(context(), d);
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(store.items.size).toBe(1);
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('쓰던 글');

    saveDraft(channelDraftKey(CHANNEL), '', NOW);
    await drainQueuedReplies(context(), d);

    expect(send).toHaveBeenCalledTimes(1);
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('곧 갈게요');
    expect(store.items.size).toBe(0);
  });

  // A7-13 수용 기준 5: 초안 저장소가 받지 않는 글(비밀 값처럼 보이는 글)은 고치기 전에는 목록에 영원히 남아 앞으로 올
  // 때마다 다시 보내졌다(r1 M2 ③).
  it('초안이 받지 않는 글: 목록에서 지우고 「보내지 못했어요」를 한 번 알린다', async () => {
    const keyShaped = `이거 써요 sk-${'a1'.repeat(12)}`;
    const store = new FakeStore(reply({text: keyShaped}));
    const d = deps(store, jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')));

    await drainQueuedReplies(context(), d);
    await drainQueuedReplies(context(), d);

    expect(store.items.size).toBe(0);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledWith('apns-1', copy.notSentTitle, copy.notSentBody, origin());
    expect(draftedAnywhere(keyShaped)).toBe(false);
  });

  // #6036 보안 검수 r1 L3: 「대화를 나가기 전에 보낸 글」의 재시도는 이미 있는 글이다. 거절로 읽으면 간 글이 초안에 또 든다.
  it('409 message_before_leave 는 이미 간 글이다 — 조용히 지우고 줄을 걷는다', async () => {
    const store = new FakeStore(reply());
    const d = deps(
      store,
      jest.fn().mockRejectedValue(new ApiError(409, 'sent before leave', 'message_before_leave')),
    );

    await drainQueuedReplies(context(), d);

    expect(store.items.size).toBe(0);
    expect(draftedAnywhere('곧 갈게요')).toBe(false);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.dismiss).toHaveBeenCalledWith('apns-1');
  });
});

// ADR-0204 증보 7 A7-13 「수명」: 나이는 남긴 시각부터, 보내기 **전에** 본다. 고치기 전에는 24시간을 보내기가 실패한 뒤에만
// 봐서 며칠 전 답장도 앱을 열면 그대로 나갔다(r1 M2).
describe('수명 — 보내기 전에 나이를 본다', () => {
  it('24시간 이상: 보내지 않고 초안으로 넘긴다(보내기 0 · 초안 1 · 목록 0)', async () => {
    const store = new FakeStore(reply({createdAtMs: NOW - QUEUED_REPLY_GIVE_UP_MS}));
    const send = jest.fn(async () => {});
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);

    expect(send).not.toHaveBeenCalled();
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('곧 갈게요');
    expect(store.items.size).toBe(0);
    expect(d.notify).toHaveBeenCalledWith('apns-1', copy.drafted, '', origin());
  });

  it('24시간에 1분 모자라면 보낸다(보내기 1)', async () => {
    const store = new FakeStore(reply({createdAtMs: NOW - QUEUED_REPLY_GIVE_UP_MS + 60_000}));
    const send = jest.fn(async () => {});
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);

    expect(send).toHaveBeenCalledTimes(1);
    expect(store.items.size).toBe(0);
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('');
  });

  it('7일 이상: 보내지도 초안에 두지도 않고 지운다 — 새로 알리지 않고 줄만 걷는다', async () => {
    const store = new FakeStore(reply({createdAtMs: NOW - QUEUED_REPLY_MAX_AGE_MS}));
    const send = jest.fn(async () => {});
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);

    expect(send).not.toHaveBeenCalled();
    expect(store.items.size).toBe(0);
    expect(draftedAnywhere('곧 갈게요')).toBe(false);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.dismiss).toHaveBeenCalledWith('apns-1');
  });});

describe('남의 답장은 보내지도, 초안으로 두지도 않고 지운다', () => {
  it.each([
    ['다른 멤버(다른 계정으로 다시 로그인)', {memberID: SOMEONE}],
    ['다른 워크스페이스', {workspaceID: OTHER_WS, origin: JSON.stringify(origin(CHANNEL, OTHER_WS))}],
  ])('%s', async (_name, over) => {
    const store = new FakeStore(reply(over));
    const send = jest.fn(async () => {});
    const d = deps(store, send);

    await drainQueuedReplies(context(), d);

    expect(send).not.toHaveBeenCalled();
    expect(store.items.size).toBe(0);
    expect(readDraft(channelDraftKey(CHANNEL), NOW)).toBe('');
    expect(d.notify).not.toHaveBeenCalled();
    // 지킬 수 없게 된 「앱을 열면 보내요」 줄은 걷는다(r1 L4). 새 알림은 없다(위).
    expect(d.dismiss).toHaveBeenCalledWith('apns-1');
  });

  // r1 M3: 보내기가 실패하는 도중 사람이 바뀌면 앞 사람의 글이 지금 사람의 초안에 들어가면 안 된다. 초안은 쓸 때의
  // 사람을 글쓴이로 적으므로, 이 자리에서 멈추지 않으면 그 글은 다음 사람의 입력창에 뜬다.
  it('보내기가 거절되는 도중 사람이 바뀌면 초안에 아무것도 넣지 않는다', async () => {
    mockSession = {member: {id: ME}};
    const store = new FakeStore(reply());
    const send = jest.fn(async () => {
      mockSession = {member: {id: SOMEONE}};
      throw new ApiError(403, 'forbidden');
    });
    const d = deps(store, send);

    await drainQueuedReplies(signedInDrainContext(WS, ME, copy), d);

    expect(send).toHaveBeenCalledTimes(1);
    expect(draftedAnywhere('곧 갈게요')).toBe(false);
    expect(d.notify).not.toHaveBeenCalled();
    // 항목은 남는다 — 다음 사람의 비우기가 「남의 것」으로 지운다.
    expect(store.items.size).toBe(1);
  });

  it('로그인한 트리의 문맥은 「지금도 같은 사람인가」를 저장된 세션으로 물을 때마다 다시 읽는다', () => {
    const live = signedInDrainContext(WS, ME.toUpperCase(), copy);
    mockSession = {member: {id: ME}};
    expect(live.isCurrent()).toBe(true);
    mockSession = {member: {id: SOMEONE}};
    expect(live.isCurrent()).toBe(false);
    mockSession = null;
    expect(live.isCurrent()).toBe(false);
  });

  it('비우는 중에 사람이 바뀌면(로그아웃) 거기서 멈춘다', async () => {
    let current = true;
    const store = new FakeStore(reply(), reply({clientMsgId: 'aaaaaaaa-0000-4000-8000-000000000002'}));
    const send = jest.fn(async () => {
      current = false;
    });
    const d = deps(store, send);

    await drainQueuedReplies(context({isCurrent: () => current}), d);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('로그아웃은 목록을 통째로 지운다', () => {
    const store = new FakeStore(reply());

    clearQueuedReplies(store);

    expect(store.cleared).toBe(1);
    expect(store.items.size).toBe(0);
  });
});
