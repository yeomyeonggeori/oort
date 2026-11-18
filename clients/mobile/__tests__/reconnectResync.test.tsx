import { act, cleanup, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import '../src/boot/polyfills';
import '../src/boot/coreHost';
import { RESYNC_SETTLE_MS } from '@momo/core/features/timeline/reconnectResync';
import {
  createRealtimeTransport,
  type RealtimeTransport,
} from '../src/realtime/centrifugeTransport';
import { createChannelRail } from '../src/realtime/channelRail';
import { useTimeline } from '../src/features/conversation/useTimeline';
import { sessionPort, __resetSessionStore } from '../src/storage/secureSession';
import {
  setServerBase,
  __resetServerBaseCache,
} from '../src/storage/serverBase';

// #5885 — 재연결한 폰이 끊긴 사이의 수정 · 지움 · 반응 · 고정을 한 번 다시 읽어 맞춘다(ADR-0177 증보 2026-11-14 D17 「보관하지 않아요」 · D22 한계 5).
// 진짜 centrifuge-js 와 가짜 소켓 · 가짜 서버(`foregroundReconnect.test.tsx` 와 같은 틀). 앱이 뒤로 갔다 앞으로 오면(잠금 → 풀림) 소켓을 새로 열고
// 다시 구독한다. 개인 채널로만 간 프레임은 보관되지 않으므로 복구된 구독도 그것을 다시 주지 않는다 — 서버 상태만 바꿔 그것을 흉내 낸다.
jest.mock('centrifuge', () => jest.requireActual('centrifuge'));
const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const originalSocket = globalThis.WebSocket;
const appStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
let transport: RealtimeTransport | undefined;
let clock = 1_800_000_000_000;
let handlers: ((state: AppStateStatus) => void)[] = [];
let visibility: AppStateStatus = 'active';
let recoveredReply = false;
let rows: Record<string, unknown>[] = [];
let reactions: Record<string, Record<string, string[]>> = {};
let pins: Record<string, unknown>[] = [];
let reads = { reactions: 0, pins: 0, messages: [] as string[] };
const jwt = (expiresAt: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString('base64url')}.signature`;
const row = (seq: number, body: string | null, extra: Record<string, unknown> = {}) => ({
  id: id(seq),
  channelId: CH,
  seq,
  hlcTs: seq,
  hlcCount: 0,
  authorMemberId: OTHER,
  type: 'text',
  body,
  state: 'sent',
  createdAtMs: 1_700_000_000_000 + seq,
  ...extra,
});
const pin = (seq: number, body: string) => ({
  messageId: id(seq),
  channelId: CH,
  seq,
  authorMemberId: OTHER,
  type: 'text',
  state: 'sent',
  body,
  createdAtMs: 1_700_000_000_000 + seq,
  pinnedBy: OTHER,
  pinnedAtMs: 1_700_000_050_000 + seq,
});
const reply = (body: unknown) =>
  ({ status: 200, ok: true, text: async () => JSON.stringify(body) } as Response);

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror = null;
  closed = false;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {
    this.closed = true;
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }
  send(data: string) {
    for (const line of data.split('\n')) {
      const command = JSON.parse(line);
      if (!command.id) continue;
      const kind = command.connect ? 'connect' : command.subscribe ? 'subscribe' : 'other';
      let result: unknown = {};
      if (kind === 'connect') result = { client: 'fake', version: '6', ping: 25, pong: true };
      if (kind === 'subscribe')
        result = {
          recoverable: true,
          positioned: true,
          offset: 1,
          epoch: 'epoch',
          recovered: command.subscribe.recover === true && recoveredReply,
        };
      setTimeout(() => {
        if (!this.closed) this.onmessage?.({ data: JSON.stringify({ id: command.id, [kind]: result }) });
      }, 0);
    }
  }
}

function emit(state: AppStateStatus) {
  visibility = state;
  for (const handler of handlers) handler(state);
}
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
/** 앱이 잠겼다 풀린다(뒤 → 앞): 소켓을 새로 열고 다시 구독한다. */
async function returnToForeground() {
  act(() => emit('inactive'));
  clock += 1_000;
  act(() => emit('active'));
  await advance(50);
}
function mount() {
  transport = createRealtimeTransport({
    url: 'wss://api.example.invalid/connection/websocket',
    now: () => clock,
  });
  transport.start();
  const rail = createChannelRail(transport.client);
  return renderHook(() => useTimeline(rail, WS, CH, SELF));
}
/** 대화를 연 때: 글 넷, 2번에 👍, 3번 고정. */
function seed() {
  rows = [row(1, '하나'), row(2, '둘'), row(3, '셋'), row(4, '넷')];
  reactions = { [id(2).toUpperCase()]: { '👍': [OTHER.toUpperCase()] } };
  pins = [pin(3, '셋')];
  reads = { reactions: 0, pins: 0, messages: [] };
}
/** 끊긴 사이(개인 채널로만 간 프레임): 2번 고침 · 4번 지움 · 2번 👍 빠지고 1번에 ❤️ · 3번 고정 풀고 1번 고정. */
function changeWhileAway() {
  rows = [row(1, '하나'), row(2, '끊긴 사이에 고친 글', { editedAtMs: 1_700_000_090_000 }), row(3, '셋'), row(4, null, { state: 'deleted', deletedAtMs: 1_700_000_091_000 })];
  reactions = { [id(1).toUpperCase()]: { '❤️': [OTHER.toUpperCase()] } };
  pins = [pin(1, '하나')];
}

beforeEach(() => {
  jest.useFakeTimers();
  clock = 1_800_000_000_000;
  handlers = [];
  visibility = 'active';
  recoveredReply = false;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    handlers.push(handler);
    return { remove: () => { handlers = handlers.filter(h => h !== handler); } };
  });
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => visibility });
  (jest.requireMock('react-native-mmkv') as { __store: Map<string, string> }).__store.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.invalid');
  sessionPort.applyLogin({
    accessToken: jwt(clock + 900_000),
    refreshToken: 'refresh-fixture',
    realtimeWebSocketUrl: 'wss://api.example.invalid/connection/websocket',
    member: { id: SELF, workspaceId: WS, kind: 'human', displayName: 'Fixture', handle: 'fixture' },
  });
  globalThis.fetch = jest.fn(async (url: string) => {
    const path = new URL(url);
    if (path.pathname.endsWith('/realtime-token')) return reply({ token: 'realtime-fixture' });
    if (path.pathname.endsWith('/messages')) {
      reads.messages.push(path.search);
      const after = path.searchParams.get('after');
      const before = path.searchParams.get('before');
      const limit = Number(path.searchParams.get('limit') ?? 50);
      let list = [...rows].sort((a, b) => (b.seq as number) - (a.seq as number));
      if (after !== null) list = list.filter(m => (m.seq as number) > Number(after)).reverse();
      if (before !== null) list = list.filter(m => (m.seq as number) < Number(before));
      return reply({ messages: list.slice(0, limit) });
    }
    if (path.pathname.endsWith('/pins')) {
      reads.pins += 1;
      return reply({ pins });
    }
    if (path.pathname.endsWith('/reactions')) {
      reads.reactions += 1;
      return reply(reactions);
    }
    throw new Error('unexpected fixture route');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  transport?.dispose();
  transport = undefined;
  globalThis.WebSocket = originalSocket;
  if (appStateDescriptor) Object.defineProperty(AppState, 'currentState', appStateDescriptor);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each([
  ['복구됨', true],
  ['복구 안 됨', false],
])('앱이 앞으로 돌아온 재연결(%s): 끊긴 사이의 고침 · 지움 · 반응 · 고정이 한 번의 다시 읽기로 맞는다', async (_label, recovered) => {
  seed();
  const { result } = mount();
  await advance(RESYNC_SETTLE_MS + 100);
  expect(result.current.state.messages.map(m => m.seq)).toEqual([1, 2, 3, 4]);
  expect(reads.reactions).toBe(1); // 첫 구독에서는 다시 읽지 않는다(대화를 여는 길의 한 번뿐)
  changeWhileAway();
  recoveredReply = recovered;
  await returnToForeground();
  await advance(RESYNC_SETTLE_MS + 100);

  expect(result.current.resume.resubscribeCount).toBe(1);
  expect(result.current.resume.lastRecovered).toBe(recovered);
  expect(reads.reactions).toBe(2);
  expect(reads.pins).toBe(2);
  const byId = new Map(result.current.state.messages.map(m => [m.id, m]));
  expect(byId.get(id(2))?.body).toBe('끊긴 사이에 고친 글');
  expect(byId.get(id(4))?.state).toBe('deleted');
  expect(result.current.reactions).toEqual({ [id(1)]: { '❤️': [OTHER] } });
  expect(Object.keys(result.current.pins)).toEqual([id(1)]);
});

it('다른 표면이 이미 붙여 둔 방(첫 `subscribed` 가 오지 않음)에서도 첫 재연결에 다시 읽는다', async () => {
  seed();
  transport = createRealtimeTransport({ url: 'wss://api.example.invalid/connection/websocket', now: () => clock });
  transport.start();
  const rail = createChannelRail(transport.client);
  const stopOther = rail.subscribeChannel(WS, CH, { onSubscribed: () => {}, onMessage: () => {} });
  await advance(50);
  const { result } = renderHook(() => useTimeline(rail, WS, CH, SELF));
  await advance(RESYNC_SETTLE_MS + 100);
  expect(result.current.state.messages.map(m => m.seq)).toEqual([1, 2, 3, 4]);
  changeWhileAway();
  recoveredReply = true;
  await returnToForeground();
  await advance(RESYNC_SETTLE_MS + 100);
  expect(reads.reactions).toBe(2);
  expect(result.current.state.messages.find(m => m.id === id(2))?.body).toBe('끊긴 사이에 고친 글');
  stopOther();
});

it('짧게 겹친 재연결은 한 번 읽고, 다시 읽은 결과가 같으면 화면 값이 같은 객체로 남는다', async () => {
  seed();
  const { result } = mount();
  await advance(RESYNC_SETTLE_MS + 100);
  const before = { messages: result.current.state.messages, reactions: result.current.reactions, pins: result.current.pins };
  recoveredReply = true;
  await returnToForeground();
  await returnToForeground();
  await advance(RESYNC_SETTLE_MS + 100);
  expect(result.current.resume.resubscribeCount).toBe(2);
  expect(reads.reactions).toBe(2);
  expect(result.current.state.messages).toBe(before.messages);
  expect(result.current.reactions).toBe(before.reactions);
  expect(result.current.pins).toBe(before.pins);
});
