import type {Member, Message, MessageAttachment} from '@momo/core/lib/api';
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
// #4441 — 사진 달린 메시지의 글을 고쳐도 사진 카드가 남는다 (폰).
//
// 진짜 `createChannelRail`(가짜 Centrifuge 위)과 진짜 `useTimeline` 을 그대로 쓴다.
// 서버는 편집이 내는 두 투영, `message.edited` 프레임과 PATCH 응답에서 첨부를 뺀다
// (`routes/messages.rs` `edit`, `interaction.rs` `build_message_edited_payload`).
// 아래 프레임·응답은 그 키 그대로다 — 폰은 두 입구 모두 `applyBatch` →
// `reconcileMessages` 한 길로 접으므로, 시험은 그 길의 끝(`state.messages`)에서 잰다.
// 화면(`MessageRow`)은 `message.attachments` 만 읽는다: 거기서 사라지면 카드가 사라진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const MSG_ID = 'cccccccc-1111-4111-8111-cccccccccc41';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const PHOTO: MessageAttachment = {
  id: 'dddddddd-1111-4111-8111-dddddddddd01',
  name: 'IMG_0412.jpg',
  mime: 'image/jpeg',
  sizeBytes: 183_204,
};
const BODY = '점심 먹은 곳 사진이에요';
const EDITED_BODY = '점심 먹은 곳 사진이에요 (가게 이름 추가)';

/** 기록 페이지가 싣는 사진 행 — 서버는 기록에는 첨부를 싣는다. */
function photoRow(author = OTHER_ID): Message {
  return {
    id: MSG_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body: BODY,
    state: 'sent',
    createdAtMs: 1_700_000_007_000,
    attachments: [PHOTO],
  };
}

/** `message.new` 프레임 — 첨부는 있을 때만 실린다. */
function newFrame(author = OTHER_ID) {
  return {
    type: 'message.new',
    v: 1,
    ts: 1_700_000_007_000,
    seq: 7,
    payload: {
      id: MSG_ID,
      channel_id: CH,
      seq: 7,
      type: 'text',
      body: BODY,
      author_member_id: author,
      hlc_ts: 1_700_000_007_000,
      hlc_count: 0,
      root_id: null,
      reply_to_id: null,
      attachments: [PHOTO],
    },
  };
}

/** `build_message_edited_payload` 의 키 전부. **`attachments` 가 없다.** */
function editedFrame(author = OTHER_ID) {
  return {
    type: 'message.edited',
    v: 1,
    ts: 1_700_000_099_000,
    seq: 7,
    payload: {
      id: MSG_ID,
      channel_id: CH,
      seq: 7,
      hlc_ts: 1_700_000_007_000,
      hlc_count: 0,
      author_member_id: author,
      type: 'text',
      state: 'edited',
      body: EDITED_BODY,
      props: {},
      root_id: null,
      reply_to_id: null,
      run_id: null,
      client_msg_id: 'eeeeeeee-1111-4111-8111-eeeeeeeeee01',
      created_at_ms: 1_700_000_007_000,
      edited_at_ms: 1_700_000_099_000,
      deleted_at_ms: null,
    },
  };
}

/** 서버 `edit` 라우트의 응답: 갱신된 행이고 **`attachments` 키가 없다**. */
function patchResponse(body: string): Message {
  return {
    id: MSG_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: SELF_ID,
    type: 'text',
    body,
    state: 'edited',
    createdAtMs: 1_700_000_007_000,
    editedAtMs: 1_700_000_099_000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface FetchLog {
  mock: jest.Mock;
  patchBodies: Record<string, unknown>[];
}

/**
 * 첫 `GET …/messages` 만 사진 행을 돌려주고 이후는 비어 있다 — 구독 직후의 꼬리
 * 되읽기(`healTail`)가 옛 본문으로 편집을 덮어 시험을 흔들지 않게 한다.
 */
function installFetch(head: Message[]): FetchLog {
  const patchBodies: Record<string, unknown>[] = [];
  let reads = 0;
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patchBodies.push(body);
      return jsonResponse(200, patchResponse(String(body.body)));
    }
    if (url.includes('/messages')) {
      reads += 1;
      return jsonResponse(200, {messages: reads === 1 ? head : []});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {mock, patchBodies};
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

describe('고쳐도 사진 카드는 남는다 (#4441)', () => {
  it('기록으로 읽은 사진 메시지를 다른 사람이 고치면, 실시간 편집 프레임 뒤에도 사진이 남는다', async () => {
    installFetch([photoRow()]);
    const {rail, subscription} = makeRail();
    const {result} = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();
    expect(result.current.state.messages[0].attachments).toEqual([PHOTO]);

    act(() => {
      subscription().__emit('publication', {data: editedFrame()});
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toEqual([PHOTO]);
    // 편집이 실제로 적용됐다 — 사진이 남은 것이 편집이 먹지 않아서가 아님을 같은 시험이 보인다.
    expect(rows[0].body).toBe(EDITED_BODY);
    expect(rows[0].state).toBe('edited');
    expect(rows[0].editedAtMs).toBe(1_700_000_099_000);
  });

  it('실시간으로 받은 사진 메시지도 마찬가지다 (message.new → message.edited)', async () => {
    installFetch([]);
    const {rail, subscription} = makeRail();
    const {result} = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    act(() => {
      subscription().__emit('publication', {data: newFrame()});
    });
    expect(result.current.state.messages[0].attachments).toEqual([PHOTO]);

    act(() => {
      subscription().__emit('publication', {data: editedFrame()});
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toEqual([PHOTO]);
    expect(rows[0].body).toBe(EDITED_BODY);
  });

  it('고친 사람 자신의 화면도 같다 — PATCH 응답에는 첨부가 없다', async () => {
    const log = installFetch([photoRow(SELF_ID)]);
    const {rail} = makeRail();
    const {result} = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const mine = result.current.state.messages[0];
    expect(mine.attachments).toEqual([PHOTO]);

    await act(async () => {
      await result.current.editBody(mine, EDITED_BODY);
    });

    expect(log.patchBodies).toEqual([{body: EDITED_BODY}]);
    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toEqual([PHOTO]);
    expect(rows[0].body).toBe(EDITED_BODY);
    expect(rows[0].state).toBe('edited');
  });

  it('응답과 에코 프레임이 겹쳐 와도(고친 사람 화면) 사진이 남는다', async () => {
    installFetch([photoRow(SELF_ID)]);
    const {rail, subscription} = makeRail();
    const {result} = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      subscription().__subscribed({recovered: false});
    });
    await tick();

    await act(async () => {
      await result.current.editBody(result.current.state.messages[0], EDITED_BODY);
    });
    act(() => {
      subscription().__emit('publication', {data: editedFrame(SELF_ID)});
    });

    const rows = result.current.state.messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toEqual([PHOTO]);
    expect(rows[0].body).toBe(EDITED_BODY);
  });
});
