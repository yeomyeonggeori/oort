import type {Member, Message, QuotedMessage} from '@momo/core/lib/api';
import {threadRollup} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
import {act, cleanup, renderHook, waitFor} from '@testing-library/react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {createChannelRail, type ChannelRail} from '../src/realtime/channelRail';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #4450 — 편집이 thread 롤업·인용을 지우지 않고, 안 든 줄의 편집은 끼어들지 않는다 (폰).
//
// 진짜 `createChannelRail`(가짜 Centrifuge 위)과 진짜 `useTimeline` 을 그대로 쓴다.
// 서버는 편집이 내는 두 투영, `message.edited` 프레임과 PATCH 응답에서 롤업(`thread`)과
// 풀린 인용(`replyTo`)을 뺀다(`interaction.rs` `build_message_edited_payload`,
// `routes/messages.rs` `edit` 의 `thread: None`·`reply_to: None`). 아래 프레임·응답은 그
// 키 그대로다 — 폰은 두 입구 모두 `payloadToMessage` → `useTimeline` 으로 들어온다.
//
// 「안 든 줄」 시험이 재는 피해는 눈에 보이는 한 줄이 아니라 **페이지 커서**다: 끼어든 줄이
// `oldestSeq` 를 내리면 「위로 더 읽기」(`before: state.oldestSeq`)가 그 사이 기록을
// 건너뛰고, 새로운 줄이 `newestSeqRef` 를 올리면 꼬리 되읽기(`after`)가 그 줄 앞을
// 건너뛴다. 그래서 단정은 서버로 실제로 나간 질의(`?before=`·`?after=`)에 건다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'cccccccc-1111-4111-8111-cccccccccc51'; // seq 7, 답글이 달린 루트
const QUOTING_ID = 'cccccccc-1111-4111-8111-cccccccccc52'; // seq 9, 원본을 인용한 줄
const QUOTED_ID = 'cccccccc-1111-4111-8111-cccccccccc31'; // seq 3, 창 밖의 원본
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const ROLLUP = {
  reply_count: 3,
  last_reply_seq: 12,
  last_reply_at: 1_700_000_500_000,
};
const QUOTE: QuotedMessage = {
  id: QUOTED_ID,
  seq: 3,
  authorMemberId: OTHER_ID,
  type: 'text',
  body: '금요일 배포 일정 확인 부탁드려요',
  state: 'sent',
};
const ROOT_EDITED = '배포 일정 공유드려요 (금요일 오전으로 확정)';
const QUOTING_EDITED = '네, 금요일 오전 열 시로 잡을게요';

/** 기록 페이지가 싣는, 답글이 달린 루트. */
function rootRow(author = OTHER_ID): Message {
  return {
    id: ROOT_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: '배포 일정 공유드려요',
    state: 'sent',
    createdAtMs: 1_700_000_007_000,
    thread: ROLLUP,
  };
}

/** 기록 페이지가 싣는, 원본(창 밖)을 인용한 줄 — 풀린 인용은 페이지에만 있다. */
function quotingRow(author = OTHER_ID): Message {
  return {
    id: QUOTING_ID,
    channelId: CH,
    seq: 9,
    hlcTs: 1_700_000_009_000,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: '네, 금요일 오전으로 잡을게요',
    state: 'sent',
    createdAtMs: 1_700_000_009_000,
    replyToId: QUOTED_ID,
    replyTo: QUOTE,
  };
}

/** 최근 꼬리: seq 10·11 만 든 창. */
function tailRow(seq: number): Message {
  return {
    id: `dddddddd-1111-4111-8111-dddddddddd${seq.toString().padStart(2, '0')}`,
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq * 1000,
    hlcCount: 0,
    authorMemberId: OTHER_ID,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: 1_700_000_000_000 + seq * 1000,
  };
}

/**
 * `build_message_edited_payload` 의 키 전부. **`attachments`·`thread`·`reply_to`·
 * `run_ended` 가 없다.**
 */
function editedFrame(row: Message, body: string) {
  return {
    type: 'message.edited',
    v: 1,
    ts: 1_700_000_099_000,
    seq: row.seq,
    payload: {
      id: row.id,
      channel_id: CH,
      seq: row.seq,
      hlc_ts: row.hlcTs,
      hlc_count: 0,
      author_member_id: row.authorMemberId,
      type: 'text',
      state: 'edited',
      body,
      props: {},
      root_id: row.rootId ?? null,
      reply_to_id: row.replyToId ?? null,
      run_id: null,
      client_msg_id: 'eeeeeeee-1111-4111-8111-eeeeeeeeee01',
      created_at_ms: row.createdAtMs,
      edited_at_ms: 1_700_000_099_000,
      deleted_at_ms: null,
    },
  };
}

/** 서버 `edit` 라우트의 응답: 갱신된 행이고 **롤업·풀린 인용·첨부 키가 없다**. */
function patchResponseOf(row: Message, body: string): Message {
  const response: Message = {
    ...row,
    body,
    state: 'edited',
    editedAtMs: 1_700_000_099_000,
  };
  delete response.attachments;
  delete response.thread;
  delete response.replyTo;
  delete response.runEnded;
  return response;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface FetchLog {
  /** `GET …/messages` 로 나간 질의 문자열(`?` 뒤)들. */
  reads: string[];
  patchBodies: Record<string, unknown>[];
}

/**
 * 머리 읽기(질의에 `before`·`after` 가 없다)만 줄을 돌려준다. 꼬리(`after`)·위로(`before`)
 * 읽기는 비어 있다 — 질의가 시험의 증거이고, 되읽기가 옛 본문으로 편집을 덮어 시험을
 * 흔들지 않게 한다.
 */
function installFetch(opts: {
  head: Message[];
  nextBefore?: number;
  patch?: (messageId: string, body: string) => Message;
}): FetchLog {
  const log: FetchLog = {reads: [], patchBodies: []};
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      log.patchBodies.push(body);
      const id = decodeURIComponent(url.split('/messages/')[1] ?? '');
      if (!opts.patch) throw new Error('patch not configured');
      return jsonResponse(200, opts.patch(id, String(body.body)));
    }
    if (url.includes('/messages')) {
      const query = url.split('?')[1] ?? '';
      log.reads.push(query);
      if (/(^|&)(before|after)=/.test(query)) {
        return jsonResponse(200, {messages: []});
      }
      return jsonResponse(200, {
        messages: opts.head,
        ...(opts.nextBefore === undefined ? {} : {nextBefore: opts.nextBefore}),
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return log;
}

/** 가짜 Centrifuge 위의 진짜 `createChannelRail`. */
function makeRail(): {
  rail: ChannelRail;
  subscription: () => {
    __subscribed: (options?: {recovered?: boolean}) => void;
    __emit: (event: string, ctx: unknown) => void;
  };
} {
  const centrifuge = jest.requireMock('centrifuge') as {
    Centrifuge: new (url: string, options: unknown) => never;
  };
  const client = new centrifuge.Centrifuge('ws://stub', {});
  const rail = createChannelRail(() => client as never);
  return {
    rail,
    subscription: () =>
      (client as unknown as {
        getSubscription: (name: string) => never;
      }).getSubscription(centrifugoChannelName(WS, CH)),
  };
}

const tick = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

beforeEach(() => {
  (
    jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
  ).__store.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  (jest.requireMock('centrifuge') as {__reset: () => void}).__reset();
});

afterEach(cleanup);

async function openChannel() {
  const {rail, subscription} = makeRail();
  const {result} = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  return {result, subscription};
}

describe('고쳐도 답글 롤업과 인용은 남는다 (#4450, 폰)', () => {
  it('기록으로 읽은 루트를 다른 사람이 고치면(실시간 프레임), 답글 롤업이 남는다', async () => {
    installFetch({head: [rootRow()]});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();
    expect(threadRollup(result.current.state.messages[0])?.replyCount).toBe(3);

    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(rootRow(), ROOT_EDITED),
      });
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(threadRollup(rows[0])?.replyCount).toBe(3);
    // 편집이 실제로 적용됐다 — 롤업이 남은 것이 편집이 먹지 않아서가 아님을 같은 시험이 보인다.
    expect(rows[0].body).toBe(ROOT_EDITED);
    expect(rows[0].state).toBe('edited');
  });

  it('고친 사람 자신의 화면도 같다 — PATCH 응답에는 롤업이 없다', async () => {
    const log = installFetch({
      head: [rootRow(SELF_ID)],
      patch: (_id, body) => patchResponseOf(rootRow(SELF_ID), body),
    });
    const {result} = await openChannel();

    await act(async () => {
      await result.current.editBody(result.current.state.messages[0], ROOT_EDITED);
    });

    expect(log.patchBodies).toEqual([{body: ROOT_EDITED}]);
    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(threadRollup(rows[0])?.replyCount).toBe(3);
    expect(rows[0].body).toBe(ROOT_EDITED);
    expect(rows[0].state).toBe('edited');
  });

  it('인용한 줄을 다른 사람이 고치면(실시간 프레임), 원본이 창 밖이어도 풀린 인용이 남는다', async () => {
    installFetch({head: [quotingRow()]});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();
    expect(result.current.state.messages[0].replyTo).toEqual(QUOTE);

    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(quotingRow(), QUOTING_EDITED),
      });
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].replyTo).toEqual(QUOTE);
    expect(rows[0].body).toBe(QUOTING_EDITED);
    expect(rows[0].state).toBe('edited');
  });

  it('고친 사람 자신의 화면도 같다 — PATCH 응답에는 풀린 인용이 없다', async () => {
    installFetch({
      head: [quotingRow(SELF_ID)],
      patch: (_id, body) => patchResponseOf(quotingRow(SELF_ID), body),
    });
    const {result} = await openChannel();

    await act(async () => {
      await result.current.editBody(
        result.current.state.messages[0],
        QUOTING_EDITED,
      );
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].replyTo).toEqual(QUOTE);
    expect(rows[0].body).toBe(QUOTING_EDITED);
  });
});

describe('편집은 안 든 줄을 만들지 않는다 (#4450, 폰)', () => {
  it('든 창보다 오래된 줄의 편집 프레임은 맨 위에 끼지 않고, 위로 더 읽기는 든 가장 오래된 줄 앞에서 읽는다', async () => {
    const log = installFetch({head: [tailRow(10), tailRow(11)], nextBefore: 10});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();
    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);

    // 서버가 오래된 카드·옛 글(seq 3)을 알린다 — 이 클라는 그 줄을 들지 않았다.
    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(tailRow(3), '오래된 글을 고쳤어요'),
      });
    });

    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);
    expect(result.current.state.oldestSeq).toBe(10);

    await act(async () => {
      await result.current.loadOlder();
    });

    // 끼어든 줄이 `oldestSeq` 를 3 으로 내렸다면 여기가 `before=3` 이 되어 4~9 가 영영 안 읽힌다.
    const older = log.reads.filter(query => /(^|&)before=/.test(query));
    expect(older).toHaveLength(1);
    expect(older[0]).toContain('before=10');
  });

  it('든 창보다 새로운 줄의 편집 프레임도 끼지 않고, 꼬리 되읽기 커서(after)를 앞세우지 않는다', async () => {
    const log = installFetch({head: [tailRow(10), tailRow(11)]});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(tailRow(20), '이 클라가 모르는 새 줄의 편집'),
      });
    });
    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);

    // 끊겼다 다시 이어졌다 — 꼬리를 메운다. 커서가 20 으로 올라가 있으면 그 사이(12~19)와
    // 20 자체를 영영 건너뛴다.
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    const tails = log.reads
      .map(query => /(?:^|&)after=(\d+)/.exec(query)?.[1])
      .filter((after): after is string => after !== undefined);
    expect(tails).toEqual(['11', '11']);
    expect(result.current.state.newestSeq).toBe(11);
  });

  it('응답한 줄이 이 창에 없으면(방을 옮긴 뒤 도착한 PATCH 응답) 타임라인에 끼지 않는다', async () => {
    installFetch({
      head: [tailRow(10), tailRow(11)],
      // 응답은 이 방의 창에 없는 줄(다른 방의 seq 3)이다.
      patch: (_id, body) => ({
        ...patchResponseOf(tailRow(3), body),
        id: 'dddddddd-1111-4111-8111-ddddddddddaa',
        channelId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      }),
    });
    const {result} = await openChannel();

    await act(async () => {
      await result.current.editBody(result.current.state.messages[0], '고친 글');
    });

    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);
    expect(result.current.state.oldestSeq).toBe(10);
  });

  it('응답한 줄이 다른 방의 같은 seq 줄이어도(두 방의 seq 는 각자 센다) 든 줄을 덮지 않는다', async () => {
    installFetch({
      head: [tailRow(10), tailRow(11)],
      // 방 A 에서 보낸 PATCH 가 방 B 를 보고 있을 때 돌아왔다. 방 B 에도 seq 10 이 있다.
      patch: (_id, body) => ({
        ...patchResponseOf(tailRow(10), body),
        id: 'dddddddd-1111-4111-8111-ddddddddddbb',
        channelId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
      }),
    });
    const {result} = await openChannel();

    await act(async () => {
      await result.current.editBody(
        result.current.state.messages[0],
        '다른 방의 글을 고쳤어요',
      );
    });

    const rows = result.current.state.messages;
    expect(rows.map(m => m.seq)).toEqual([10, 11]);
    // 이 방의 seq 10 은 그대로다 — id 를 보지 않으면 다른 방의 글이 이 줄을 덮는다.
    expect(rows[0].id).toBe(tailRow(10).id);
    expect(rows[0].body).toBe('메시지 10');
  });
});
