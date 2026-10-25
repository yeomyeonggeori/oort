import type {
  Member,
  Message,
  MessageAttachment,
  QuotedMessage,
} from '@momo/core/lib/api';
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
//
// 가짜 서버(`FetchLog.server`)는 실제 서버처럼 `?after=N` 에 **커서 값으로** 답한다(seq 가 N 보다
// 큰 줄, 편집이 반영된 현재 상태). 커서가 틀리면 줄이 오지 않으므로, 「버린 편집이 꼬리 되읽기를
// 막지 않는다」가 줄이 도착했다는 양성 단정으로 선다.
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
const PHOTO: MessageAttachment = {
  id: 'cccccccc-1111-4111-8111-ccccccccccf1',
  name: 'IMG_0412.jpg',
  mime: 'image/jpeg',
  sizeBytes: 183_204,
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
function editedFrame(
  row: Message,
  body: string,
  over: Record<string, unknown> = {},
) {
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
      ...over,
    },
  };
}

/** `message.new` 프레임 — 대조군(남의 새 줄은 표지를 세운다)에 쓴다. */
function newFrame(row: Message) {
  return {
    type: 'message.new',
    v: 1,
    ts: row.createdAtMs,
    seq: row.seq,
    payload: {
      id: row.id,
      channel_id: CH,
      seq: row.seq,
      hlc_ts: row.hlcTs,
      hlc_count: 0,
      author_member_id: row.authorMemberId,
      type: 'text',
      body: row.body,
      state: 'sent',
      created_at_ms: row.createdAtMs,
    },
  };
}

/** `message.deleted` 프레임 — 서버는 id 만 싣는다(지운 본문을 다시 퍼뜨리지 않으려고). */
function deletedFrame(row: Message) {
  return {
    type: 'message.deleted',
    v: 1,
    ts: 1_700_000_300_000,
    seq: row.seq,
    payload: {message_id: row.id},
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
  /** 서버가 지금 들고 있는 줄들(편집 반영). `?after=N` 은 seq > N 인 줄을 오름차순으로 돌려준다. */
  server: Message[];
}

/**
 * 머리 읽기(질의에 `before`·`after` 가 없다)는 `head`, 꼬리(`after`) 읽기는 가짜 서버의 현재
 * 상태(`log.server`, 기본은 비어 있다), 위로(`before`) 읽기는 비어 있다 — 질의가 시험의
 * 증거이고, 되읽기가 옛 본문으로 편집을 덮어 시험을 흔들지 않게 한다. `patchGate` 는 PATCH 응답을
 * 붙잡아 둔다(요청이 도는 사이 다른 기기가 지우는 경주를 재현).
 */
function installFetch(opts: {
  head: Message[];
  nextBefore?: number;
  patch?: (messageId: string, body: string) => Message;
  patchGate?: Promise<void>;
}): FetchLog {
  const log: FetchLog = {reads: [], patchBodies: [], server: []};
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      log.patchBodies.push(body);
      const id = decodeURIComponent(url.split('/messages/')[1] ?? '');
      if (!opts.patch) throw new Error('patch not configured');
      if (opts.patchGate) await opts.patchGate;
      return jsonResponse(200, opts.patch(id, String(body.body)));
    }
    if (url.includes('/messages')) {
      const query = url.split('?')[1] ?? '';
      log.reads.push(query);
      const after = /(?:^|&)after=(\d+)/.exec(query)?.[1];
      if (after !== undefined) {
        return jsonResponse(200, {
          messages: log.server
            .filter(m => m.seq > Number(after))
            .sort((a, b) => a.seq - b.seq),
        });
      }
      if (/(^|&)before=/.test(query)) {
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
    __subscribed: (options?: {
      recovered?: boolean;
      publications?: unknown[];
    }) => void;
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

describe('든 묘비 위의 늦은 편집은 무시한다 (#4450 planner 결정 5, 폰)', () => {
  it('지운 줄에 늦게 온 message.edited 프레임(지우기 전에 보낸 것)은 본문을 되살리지 않는다', async () => {
    installFetch({head: [rootRow()]});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    // 다른 기기가 그 줄을 지웠다. 줄은 제자리에 묘비로 남는다.
    act(() => {
      subscription().__emit('publication', {data: deletedFrame(rootRow())});
    });
    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0].state).toBe('deleted');
    expect(result.current.state.messages[0].body).toBeUndefined();

    // 지우기 전에 보낸 편집 프레임이 되쏘기로 늦게 닿았다. 서버는 지운 뒤의 편집을 받지 않으므로
    // 묘비가 이긴다 — 지운 글이 화면에 다시 서면 안 된다.
    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(rootRow(), ROOT_EDITED),
      });
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('deleted');
    expect(rows[0].body).toBeUndefined();
  });

  it('내 편집 요청이 도는 사이 다른 기기가 지웠다 — PATCH 응답이 늦게 와도 묘비가 남는다', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    installFetch({
      head: [rootRow(SELF_ID)],
      patch: (_id, body) => patchResponseOf(rootRow(SELF_ID), body),
      patchGate: gate,
    });
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    let editing: Promise<void> | undefined;
    await act(async () => {
      editing = result.current.editBody(
        result.current.state.messages[0],
        ROOT_EDITED,
      );
      await Promise.resolve();
    });
    act(() => {
      subscription().__emit('publication', {
        data: deletedFrame(rootRow(SELF_ID)),
      });
    });
    expect(result.current.state.messages[0].state).toBe('deleted');

    await act(async () => {
      release();
      await editing;
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('deleted');
    expect(rows[0].body).toBeUndefined();
  });
});

describe('버린 편집은 꼬리 되읽기가 완전한 투영으로 메운다 (#4450 planner 결정 2, 폰)', () => {
  /** 서버가 지금 들고 있는 seq 12 — 누군가 고친 뒤의 현재 상태. 페이지 읽기는 장식을 싣는다. */
  function serverRow12(): Message {
    return {
      ...tailRow(12),
      state: 'edited',
      body: '고친 뒤의 글',
      editedAtMs: 1_700_000_099_000,
      replyToId: QUOTED_ID,
      replyTo: QUOTE,
      thread: ROLLUP,
      attachments: [PHOTO],
    };
  }

  it('못 본 새 줄(seq 12)의 편집 프레임은 버려지고, 다음 꼬리 되읽기가 편집본을 롤업·인용·첨부와 함께 들인다', async () => {
    const log = installFetch({head: [tailRow(10), tailRow(11)]});
    const {result, subscription} = await openChannel();
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();
    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);

    // 끊긴 사이 남이 쓴 줄(seq 12)을 또 남이 고쳤다. 이 클라는 message.new 를 못 받았고 편집
    // 프레임만 닿는다.
    act(() => {
      subscription().__emit('publication', {
        data: editedFrame(tailRow(12), '고친 뒤의 글', {reply_to_id: QUOTED_ID}),
      });
    });
    // 버려졌다 — 반쪽 행이 끼지 않았고, 꼬리 커서(`newestSeq`)도 그대로다.
    expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);
    expect(result.current.state.newestSeq).toBe(11);

    // 복구: 서버의 현재 상태(편집이 반영된 줄)를 읽는다. 서버는 커서 값에 답하므로 커서가 12 로
    // 올라가 있었다면 이 줄은 영영 오지 않는다.
    log.server = [serverRow12()];
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    const tails = log.reads
      .map(query => /(?:^|&)after=(\d+)/.exec(query)?.[1])
      .filter((after): after is string => after !== undefined);
    expect(tails).toEqual(['11', '11']);
    const rows = result.current.state.messages;
    expect(rows.map(m => m.seq)).toEqual([10, 11, 12]);
    expect(rows[2].body).toBe('고친 뒤의 글');
    expect(rows[2].state).toBe('edited');
    expect(threadRollup(rows[2])?.replyCount).toBe(3);
    expect(rows[2].replyTo).toEqual(QUOTE);
    expect(rows[2].attachments).toEqual([PHOTO]);
    // 버린 편집은 도착 장부에도 흔적을 남기지 않았다 — 이 줄은 이 타임라인에 **처음** 든 남의
    // 줄이라 복구 표지가 선다. (편집 프레임이 줄 id 를 「이미 든 줄」로 등록했다면 여기서 표지가
    // 사라진다.)
    expect(result.current.recoveryMarkers).toHaveLength(1);
    expect(result.current.recoveryMarkers[0]).toMatchObject({
      source: 'backfill',
      seq: 12,
    });
  });
});

describe('복구 재생 구간의 편집은 복구 표지를 올리지 않는다 (#4450 planner 결정 7, 폰)', () => {
  it.each([
    {seq: 20, label: '이 클라보다 새 줄 — message.new 를 놓쳤다'},
    {seq: 5, label: '이 클라의 창보다 오래된 줄 — 어제 글'},
  ])(
    '안 본 줄($label)의 message.edited 가 되쏘기로 와도 표지를 세우지 않는다 — 편집은 남이 새로 보낸 줄이 아니다',
    async ({seq}) => {
      installFetch({head: [tailRow(10), tailRow(11)]});
      const {result, subscription} = await openChannel();
      act(() => {
        subscription().__subscribed({recovered: false});
      });
      await tick();

      await act(async () => {
        subscription().__subscribed({
          recovered: true,
          publications: [editedFrame(tailRow(seq), '고쳐 썼어요')],
        });
      });
      await tick();

      // 줄도 끼지 않았고 표지도 서지 않았다. (수리 전에는 이 프레임이 「남이 새로 보낸 줄」로
      // 세어져 반쪽 행과 함께 표지를 올렸다.)
      expect(result.current.state.messages.map(m => m.seq)).toEqual([10, 11]);
      expect(result.current.recoveryMarkers).toEqual([]);

      // 대조군: 같은 배선이 남의 새 줄에는 표지를 **세운다.** 위의 「없다」가 배선이 죽어서
      // 없는 것이 아님을 보인다.
      await act(async () => {
        subscription().__subscribed({
          recovered: true,
          publications: [newFrame(tailRow(30))],
        });
      });
      await tick();
      expect(result.current.recoveryMarkers).toHaveLength(1);
      expect(result.current.recoveryMarkers[0]).toMatchObject({
        source: 'replay',
        seq: 30,
      });
    },
  );
});
