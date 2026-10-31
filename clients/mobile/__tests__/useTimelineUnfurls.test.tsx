import type {Member, Message} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
import {act, renderHook, waitFor} from '@testing-library/react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {type ChannelRail, createChannelRail} from '../src/realtime/channelRail';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {drainRender, jsonResponse} from './testkit';

// =============================================================================
// 링크 카드가 방의 상태로 흘러 들어오는 길 (ADR-0170 D5, #4883).
//
// 진짜 `createChannelRail`(가짜 Centrifuge 위)과 진짜 `useTimeline` 을 쓰고 서버는 `fetch` 라우팅으로 둔다 —
// 웹 `useTimeline` 의 같은 배선과 같은 규칙을 폰이 지키는지 잰다:
//   ① 링크가 있을 수 있는 메시지만, 한 번, 읽는다  ② 실시간 프레임은 투영을 통째로 바꾸고 지우기는 묘비다
//   ③ 늦게 온 찬 읽기는 묘비를 덮지 않는다  ④ 읽기 실패는 조용한 부재다  ⑤ 작성자의 지우기와 메시지 삭제는 카드를 비운다.
// 화면(`MessageRow`)은 `unfurls` 지도만 읽으므로 시험은 그 지도에서 잰다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE = 'https://api.example.com';
const LINK_ID = 'cccccccc-1111-4111-8111-cccccccccc01';
const PLAIN_ID = 'cccccccc-1111-4111-8111-cccccccccc02';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

function row(id: string, seq: number, body: string, author = OTHER_ID): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: 1_700_000_000_000 + seq,
  };
}

const LINK_ROW = row(LINK_ID, 1, '이거 보세요 https://example.com/post');
const PLAIN_ROW = row(PLAIN_ID, 2, '링크 없는 말');

function wireCard(title: string, messageId = LINK_ID) {
  return {
    id: 'dddddddd-1111-4111-8111-dddddddddd01',
    messageId,
    url: 'https://example.com/post',
    status: 'ok',
    title,
    domain: 'example.com',
  };
}

interface Server {
  unfurlReads: string[];
  deletes: string[];
  /** `GET …/unfurls` 의 답을 정한다. 기본은 카드 하나. */
  unfurlAnswer: (messageId: string) => Promise<Response>;
  /** `DELETE …/unfurls` 의 답을 정한다. 기본은 성공. */
  deleteAnswer: () => Promise<Response>;
}

function installServer(head: Message[]): Server {
  const server: Server = {
    unfurlReads: [],
    deletes: [],
    unfurlAnswer: async messageId => jsonResponse(200, {unfurls: [wireCard('처음 제목', messageId)]}),
    deleteAnswer: async () => jsonResponse(200, {removed: true}),
  };
  let reads = 0;
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const unfurls = /\/messages\/([^/]+)\/unfurls$/.exec(url);
    if (unfurls) {
      if (init?.method === 'DELETE') {
        server.deletes.push(unfurls[1]);
        return server.deleteAnswer();
      }
      server.unfurlReads.push(unfurls[1]);
      return server.unfurlAnswer(unfurls[1]);
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages')) {
      reads += 1;
      return jsonResponse(200, {messages: reads === 1 ? head : []});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  }) as unknown as typeof fetch;
  return server;
}

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
      (client as unknown as {getSubscription: (name: string) => never}).getSubscription(
        centrifugoChannelName(WS, CH),
      ),
  };
}

const tick = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

function unfurlFrame(title: string) {
  return {
    type: 'message.unfurl',
    v: 1,
    ts: 1_700_000_100_000,
    seq: 1,
    payload: {
      message_id: LINK_ID,
      channel_id: CH,
      unfurls: [
        {
          id: 'dddddddd-1111-4111-8111-dddddddddd01',
          message_id: LINK_ID,
          url: 'https://example.com/post',
          status: 'ok',
          title,
          domain: 'example.com',
        },
      ],
    },
  };
}

const removedFrame = {
  type: 'message.unfurl.removed',
  v: 1,
  ts: 1_700_000_200_000,
  seq: 1,
  payload: {message_id: LINK_ID, channel_id: CH},
};

const deletedFrame = {
  type: 'message.deleted',
  v: 1,
  ts: 1_700_000_300_000,
  seq: 1,
  payload: {message_id: LINK_ID},
};

async function open(head: Message[]) {
  const server = installServer(head);
  const {rail, subscription} = makeRail();
  const hook = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    subscription().__subscribed({recovered: true});
  });
  await tick();
  return {server, hook, subscription};
}

const entry = (hook: {result: {current: ReturnType<typeof useTimeline>}}) =>
  hook.result.current.unfurls[LINK_ID.toLowerCase()];

beforeEach(() => {
  (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store.clear();
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

afterEach(drainRender);

describe('읽기 — 링크가 있을 수 있는 메시지만, 한 번', () => {
  it('링크가 든 메시지의 카드를 읽어 지도에 담고, 링크 없는 메시지는 묻지 않는다', async () => {
    const {server, hook} = await open([LINK_ROW, PLAIN_ROW]);
    await waitFor(() => expect(entry(hook)).toHaveLength(1));
    expect(entry(hook)[0]).toMatchObject({title: '처음 제목', status: 'ok'});
    expect(server.unfurlReads).toEqual([LINK_ID]);
    expect(hook.result.current.unfurls[PLAIN_ID.toLowerCase()]).toBeUndefined();
  });

  it('읽기가 실패하면(서버 꺼짐·옛 서버) 조용한 부재다 — 메시지는 그대로 읽히고 오류 상태가 없다', async () => {
    const server = installServer([LINK_ROW]);
    server.unfurlAnswer = async () => jsonResponse(500, {error: 'boom'});
    const {rail} = makeRail();
    const hook = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    await waitFor(() => expect(entry(hook)).toEqual([]));
    expect(hook.result.current.state.messages).toHaveLength(1);
  });
});

describe('실시간 — 투영은 통째로 바뀌고 지우기는 묘비다', () => {
  it('message.unfurl 프레임이 읽어 둔 카드를 통째로 바꾼다', async () => {
    const {hook, subscription} = await open([LINK_ROW]);
    await waitFor(() => expect(entry(hook)?.[0]?.title).toBe('처음 제목'));
    act(() => {
      subscription().__emit('publication', {data: unfurlFrame('바뀐 제목')});
    });
    expect(entry(hook)).toHaveLength(1);
    expect(entry(hook)[0].title).toBe('바뀐 제목');
  });

  it('message.unfurl.removed 는 빈 목록(묘비)이고, 늦게 도착한 찬 읽기가 그것을 덮지 않는다', async () => {
    const server = installServer([LINK_ROW]);
    let release!: () => void;
    const late = new Promise<void>(resolve => {
      release = resolve;
    });
    server.unfurlAnswer = async messageId => {
      await late;
      return jsonResponse(200, {unfurls: [wireCard('늦게 온 옛 카드', messageId)]});
    };
    const {rail, subscription} = makeRail();
    const hook = renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    act(() => {
      subscription().__subscribed({recovered: true});
    });
    await tick();
    // 찬 읽기가 아직 돌아오지 않은 사이에 작성자가 지웠다.
    act(() => {
      subscription().__emit('publication', {data: removedFrame});
    });
    expect(entry(hook)).toEqual([]);
    await act(async () => {
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(entry(hook)).toEqual([]);
  });

  it('메시지가 지워지면 카드도 묘비가 된다', async () => {
    const {hook, subscription} = await open([LINK_ROW]);
    await waitFor(() => expect(entry(hook)).toHaveLength(1));
    act(() => {
      subscription().__emit('publication', {data: deletedFrame});
    });
    expect(entry(hook)).toEqual([]);
  });
});

describe('작성자가 미리보기를 지운다', () => {
  it('DELETE 가 그 메시지로 나가고, 성공하면 이 화면의 카드가 곧바로 비는데 메시지는 남는다', async () => {
    const {server, hook} = await open([row(LINK_ID, 1, LINK_ROW.body ?? '', SELF_ID)]);
    await waitFor(() => expect(entry(hook)).toHaveLength(1));
    const mine = hook.result.current.state.messages[0];
    await act(async () => {
      await hook.result.current.removeUnfurls(mine);
    });
    expect(server.deletes).toEqual([LINK_ID]);
    expect(entry(hook)).toEqual([]);
    expect(hook.result.current.state.messages).toHaveLength(1);
    expect(hook.result.current.state.messages[0].state).toBe('sent');
  });

  it('서버가 거절하면 던지고(문장은 부른 쪽이 고른다) 카드는 그대로 남는다', async () => {
    const {server, hook} = await open([row(LINK_ID, 1, LINK_ROW.body ?? '', SELF_ID)]);
    await waitFor(() => expect(entry(hook)).toHaveLength(1));
    server.deleteAnswer = async () => jsonResponse(403, {error: 'author only'});
    const mine = hook.result.current.state.messages[0];
    await expect(
      act(async () => {
        await hook.result.current.removeUnfurls(mine);
      }),
    ).rejects.toBeDefined();
    expect(entry(hook)).toHaveLength(1);
  });
});
