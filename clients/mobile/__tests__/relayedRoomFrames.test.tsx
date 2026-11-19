import type {Member, Message} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
import {act, renderHook, waitFor} from '@testing-library/react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {createChannelRail} from '../src/realtime/channelRail';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {drainRender, jsonResponse} from './testkit';

// =============================================================================
// 개인 채널로 옮겨 온 방 프레임 (ADR-0177 증보 2026-11-14 D17, #5876).
//
// 1:1 에서 상대가 나간 방의 하한 아래 옛 글에 대한 뒤늦은 수정·반응·고정은 방 채널이 아니라 볼 수 있는 멤버의 개인 채널
// (`user:read-state#<나>`)로 오고 프레임에 `room_channel` 이 실린다. 진짜 `createChannelRail`(가짜 Centrifuge 위)과 진짜 `useTimeline` 을
// 그대로 쓰고, 화면이 읽는 끝(`state.messages`·`reactions`)에서 잰다. 웹 `realtime.relayedRoom.test.ts` 의 폰 짝이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaab';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE = 'https://api.example.com';
const PERSONAL = `user:read-state#${SELF_ID.toUpperCase()}`;
const ROOM = centrifugoChannelName(WS, CH);
const OLD_ID = 'cccccccc-1111-4111-8111-cccccccccc03';
const NEW_ID = 'cccccccc-1111-4111-8111-cccccccccc05';

const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};

interface FakeSub {
  state: string;
  options: unknown;
  unsubscribeCount: number;
  __emit: (event: string, ctx: unknown) => void;
  __subscribed: (options?: {recovered?: boolean}) => void;
}
interface FakeClient {
  subs: Map<string, FakeSub>;
  getSubscription: (name: string) => FakeSub | null;
}

function row(id: string, seq: number, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: PEER_ID,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: 1_700_000_000_000 + seq,
  };
}

/** 첫 `GET …/messages` 만 두 글(seq 3·5)을 주고 이후는 비어 있다 - 꼬리 되읽기가 옛 본문으로 덮지 않게. */
function installFetch(): void {
  let reads = 0;
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/messages')) {
      reads += 1;
      return jsonResponse(200, {messages: reads === 1 ? [row(OLD_ID, 3, '옛 글'), row(NEW_ID, 5, '새 글')] : []});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  }) as unknown as typeof fetch;
}

function editedFrame(id: string, seq: number, body: string, room: string | null) {
  return {
    type: 'message.edited',
    v: 1,
    ts: 1_700_000_099_000,
    seq,
    payload: {
      id,
      channel_id: CH,
      seq,
      hlc_ts: seq,
      hlc_count: 0,
      author_member_id: PEER_ID,
      type: 'text',
      state: 'edited',
      body,
      props: {},
      root_id: null,
      reply_to_id: null,
      run_id: null,
      client_msg_id: null,
      created_at_ms: 1_700_000_000_000 + seq,
      edited_at_ms: 1_700_000_099_000,
      deleted_at_ms: null,
    },
    ...(room === null ? {} : {room_channel: room}),
  };
}

function reactionFrame(id: string, seq: number, room: string | null) {
  return {
    type: 'reaction.added',
    v: 1,
    ts: 1_700_000_099_000,
    seq,
    payload: {action: 'added', message_id: id, member_id: PEER_ID, emoji: '👍'},
    ...(room === null ? {} : {room_channel: room}),
  };
}

let client: FakeClient;

function makeRail(selfId: string | null) {
  const centrifuge = jest.requireMock('centrifuge') as {Centrifuge: new (url: string, options: unknown) => never};
  client = new centrifuge.Centrifuge('ws://stub', {}) as unknown as FakeClient;
  return createChannelRail(() => client as never, () => selfId);
}

const personal = () => client.getSubscription(PERSONAL);
const tick = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

async function openTimeline(selfId: string | null, floor: number | null = null) {
  installFetch();
  const rail = makeRail(selfId);
  const view = renderHook(() => useTimeline(rail, WS, CH, SELF_ID, floor));
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  act(() => {
    client.getSubscription(ROOM)?.__subscribed({recovered: false});
  });
  await tick();
  return view;
}

const bodyOf = (view: Awaited<ReturnType<typeof openTimeline>>, id: string) =>
  view.result.current.state.messages.find(message => message.id === id)?.body;

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

describe('개인 채널로 옮겨 온 방 프레임 (D17)', () => {
  it('이 방의 수정·반응은 방 채널로 온 것과 같이 그려지고, 다른 방 이름·room_channel 없는 신호는 그리지 않는다', async () => {
    const view = await openTimeline(SELF_ID);
    expect(personal()?.state).toBe('subscribed');

    act(() => {
      // 대소문자를 가리지 않는다.
      personal()?.__emit('publication', {data: editedFrame(OLD_ID, 3, '고친 옛 글', ROOM.toLowerCase())});
    });
    expect(bodyOf(view, OLD_ID)).toBe('고친 옛 글');

    act(() => {
      personal()?.__emit('publication', {data: editedFrame(NEW_ID, 5, '다른 방 이름의 수정', centrifugoChannelName(WS, OTHER_CH))});
      personal()?.__emit('publication', {data: editedFrame(NEW_ID, 5, '방 이름 없는 수정', null)});
      personal()?.__emit('publication', {data: {type: 'inbox_item.created', v: 1, payload: {id: 'i-1'}}});
    });
    expect(bodyOf(view, NEW_ID)).toBe('새 글');

    act(() => {
      personal()?.__emit('publication', {data: reactionFrame(OLD_ID, 3, ROOM)});
    });
    expect(Object.keys(view.result.current.reactions)).toEqual([OLD_ID]);
  });

  it('같은 프레임이 방 채널과 개인 채널로 둘 다 와도 한 번 온 것과 같다(반응 한 명 한 칩)', async () => {
    const view = await openTimeline(SELF_ID);
    act(() => {
      client.getSubscription(ROOM)?.__emit('publication', {data: reactionFrame(OLD_ID, 3, null)});
      personal()?.__emit('publication', {data: reactionFrame(OLD_ID, 3, ROOM)});
    });
    expect(view.result.current.reactions[OLD_ID]?.['👍']).toEqual([PEER_ID]);
  });

  it('나간 사람의 하한 아래 프레임은 개인 채널로 와도 그리지 않고, 하한부터는 그린다', async () => {
    const view = await openTimeline(SELF_ID, 5);
    act(() => {
      personal()?.__emit('publication', {data: editedFrame(OLD_ID, 3, '하한 아래 수정', ROOM)});
      personal()?.__emit('publication', {data: reactionFrame(OLD_ID, 3, ROOM)});
    });
    expect(view.result.current.reactions).toEqual({});
    act(() => {
      personal()?.__emit('publication', {data: editedFrame(NEW_ID, 5, '하한 위 수정', ROOM)});
    });
    expect(bodyOf(view, NEW_ID)).toBe('하한 위 수정');
  });

  it('멤버를 모르면 개인 채널을 듣지 않고(옛 판과 같다), 화면을 떠나면 그 구독도 놓는다', async () => {
    const without = await openTimeline(null);
    expect(personal()).toBeNull();
    expect([...client.subs.keys()]).toEqual([ROOM]);
    without.unmount();

    const view = await openTimeline(SELF_ID);
    const sub = personal();
    expect(sub?.options).toEqual({recoverable: true, positioned: true});
    view.unmount();
    expect(sub?.unsubscribeCount).toBe(1);
    expect(client.subs.size).toBe(0);
  });
});
