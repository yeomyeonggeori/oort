import type {Member, Message} from '@momo/core/lib/api';
import {isStrictlyOrdered} from '@momo/core/features/timeline/model';
import {
  isStreamRunEnded,
  STREAM_CUT_OFF_MARK,
  STREAM_PROPS_KEY,
  streamStopMark,
} from '@momo/core/features/timeline/streamStop';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
import {act, cleanup, renderHook, waitFor} from '@testing-library/react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {endedRunIds, resetEndedRuns} from '../src/features/agents/endedRuns';
import {createChannelRail, type ChannelRail} from '../src/realtime/channelRail';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// The timeline hook: what it loads, what it receives, what it sends.
//
// Judgment functions rather than snapshots — every assertion below is about a
// decision (does a gap get healed, does a retry reuse its key, does a duplicate
// seq collapse) and not about how anything looks.
//
// The replay case is the one worth naming. Spike #837 gate 3 measured
// centrifuge-js on Hermes recovering **25/25 publications with missing 0** over
// a 25-second cut, against a real Centrifugo. That measurement is not repeated
// here — it was about the library and the runtime, and it is done. What IS
// repeated is the property the app must have on top of it: that 25 recovered
// publications flushed synchronously behind `subscribed` all land, in seq
// order, with nothing missing and nothing duplicated, and that a resubscribe
// which did NOT recover heals over REST instead.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: 1_700_000_000_000 + seq * 1000,
    ...over,
  };
}

/** A `message.new` frame as the relay publishes it. */
function frame(seq: number, over: Record<string, unknown> = {}) {
  return {
    type: 'message.new',
    v: 1,
    ts: 1_700_000_000_000 + seq * 1000,
    seq,
    payload: {
      id: `msg-${seq}`,
      channel_id: CH,
      seq,
      type: 'text',
      body: `메시지 ${seq}`,
      author_member_id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      hlc_ts: seq,
      hlc_count: 0,
      created_at_ms: 1_700_000_000_000 + seq * 1000,
      ...over,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Routes {
  /** Answers `GET .../messages`, keyed by the query string it was called with. */
  messages?: (url: string) => Response;
  send?: (body: Record<string, unknown>) => Response;
}

interface FetchLog {
  mock: jest.Mock;
  urls: string[];
  sendBodies: Record<string, unknown>[];
}

function installFetch(routes: Routes = {}): FetchLog {
  const urls: string[] = [];
  const sendBodies: Record<string, unknown>[] = [];
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sendBodies.push(body);
      return routes.send
        ? routes.send(body)
        : jsonResponse(
            200,
            message(100, {
              authorMemberId: SELF_ID,
              body: String(body.body),
              id: 'server-echo',
            }),
          );
    }
    if (url.includes('/messages')) {
      return routes.messages
        ? routes.messages(url)
        : jsonResponse(200, {messages: []});
    }
    if (url.includes('/read-state')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {mock, urls, sendBodies};
}

/**
 * A rail backed by the faked Centrifuge, so the code under test is the real
 * `createChannelRail` — refcount, frame narrowing and all — rather than a
 * hand-written stand-in that could disagree with it.
 */
function makeRail(): {
  rail: ChannelRail;
  subscription: () => {
    __subscribed: (options?: {
      recovered?: boolean;
      publications?: unknown[];
    }) => void;
    __emit: (event: string, ctx: unknown) => void;
    unsubscribeCount: number;
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

function renderTimeline(rail: ChannelRail | null) {
  return renderHook(() => useTimeline(rail, WS, CH, SELF_ID));
}

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
  resetEndedRuns();
});

afterEach(cleanup);

describe('읽기 — seq 가 유일한 순서 권위다', () => {
  it('내림차순 페이지를 오름차순으로 접는다', async () => {
    installFetch({
      messages: () =>
        jsonResponse(200, {messages: [message(3), message(1), message(2)]}),
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.state.messages.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(isStrictlyOrdered(result.current.state.messages)).toBe(true);
    expect(result.current.state.oldestSeq).toBe(1);
    expect(result.current.state.newestSeq).toBe(3);
  });

  it('불러오기 실패는 오류 상태이고, 서버 영어는 새어 나오지 않는다', async () => {
    installFetch({
      messages: () => jsonResponse(500, {error: {message: 'boom'}}),
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.state.messages).toEqual([]);
  });

  it('위로 더 불러오면 before 커서로 요청한다', async () => {
    let call = 0;
    const log = installFetch({
      messages: () => {
        call += 1;
        return call === 1
          ? jsonResponse(200, {messages: [message(10), message(11)], nextBefore: 10})
          : jsonResponse(200, {messages: [message(8), message(9)]});
      },
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(log.urls.some(u => u.includes('before=10'))).toBe(true);
    expect(result.current.state.messages.map(m => m.seq)).toEqual([8, 9, 10, 11]);
    // The server said there is nothing older, so the list stops asking.
    expect(result.current.reachedStart).toBe(true);
  });
});

describe('받기 — 실시간과 리플레이', () => {
  it('publication 을 seq 로 접고, 같은 seq 는 중복되지 않는다', async () => {
    installFetch({messages: () => jsonResponse(200, {messages: [message(1)]})});
    const {rail, subscription} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      subscription().__subscribed({recovered: false});
      subscription().__emit('publication', {data: frame(2)});
      subscription().__emit('publication', {data: frame(2)});
    });

    expect(result.current.state.messages.map(m => m.seq)).toEqual([1, 2]);
  });

  it('끊겼다 복구된 재구독은 25건을 전부 받고 빠짐이 0이다', async () => {
    // The app-side reproduction of spike gate 3 (25/25 · missing 0).
    installFetch({messages: () => jsonResponse(200, {messages: [message(1)]})});
    const {rail, subscription} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      subscription().__subscribed({recovered: false});
    });

    // 25 publications missed during the cut, replayed on the resubscribe.
    const missed = Array.from({length: 25}, (_, i) => frame(i + 2));
    act(() => {
      subscription().__subscribed({recovered: true, publications: missed});
    });

    const seqs = result.current.state.messages.map(m => m.seq);
    expect(seqs).toEqual(Array.from({length: 26}, (_, i) => i + 1));
    expect(isStrictlyOrdered(result.current.state.messages)).toBe(true);
    // missing 0.
    expect(seqs.length).toBe(26);
    expect(result.current.resume.lastRecovered).toBe(true);
    expect(result.current.resume.resubscribeCount).toBe(1);

    // The recovery marker states how far it was restored, and says the rail —
    // not REST — did it.
    await waitFor(() => expect(result.current.recoveryMarkers.length).toBe(1));
    expect(result.current.recoveryMarkers[0]).toMatchObject({
      seq: 26,
      source: 'replay',
    });
  });

  it('복구되지 않은 재구독은 REST ?after 로 메운다', async () => {
    let call = 0;
    const log = installFetch({
      messages: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, {messages: [message(1)]});
        // The backfill page, ascending.
        return call === 2
          ? jsonResponse(200, {messages: [message(2), message(3)]})
          : jsonResponse(200, {messages: []});
      },
    });
    const {rail, subscription} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      subscription().__subscribed({recovered: false});
    });
    // First subscribe: backfills, but records no marker — there was no gap to
    // heal, so a "재연결됨" line would be a reconnection that never happened.
    await waitFor(() => expect(result.current.state.messages.length).toBe(3));
    expect(result.current.recoveryMarkers).toEqual([]);

    await act(async () => {
      subscription().__subscribed({recovered: false});
    });

    await waitFor(() => expect(result.current.recoveryMarkers.length).toBe(1));
    expect(result.current.recoveryMarkers[0].source).toBe('backfill');
    expect(log.urls.some(u => u.includes('after=1'))).toBe(true);
  });

  it('삭제 프레임은 행을 제자리에서 지우고 seq 는 남긴다', async () => {
    installFetch({
      messages: () => jsonResponse(200, {messages: [message(1), message(2)]}),
    });
    const {rail, subscription} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      subscription().__emit('publication', {
        data: {
          type: 'message.deleted',
          v: 1,
          ts: 1_700_000_100_000,
          seq: 1,
          payload: {message_id: 'msg-1'},
        },
      });
    });

    // The row stays and keeps its seq: removing it would leave a gap that the
    // next reconnect could not tell apart from one this client never received.
    expect(result.current.state.messages.map(m => m.seq)).toEqual([1, 2]);
    expect(result.current.state.messages[0].state).toBe('deleted');
    expect(result.current.state.messages[0].body).toBeUndefined();
  });

  it('마지막 구독자가 놓을 때만 채널을 내린다', async () => {
    installFetch();
    const {rail, subscription} = makeRail();
    const first = renderTimeline(rail);
    const second = renderTimeline(rail);
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));

    const sub = subscription();
    first.unmount();
    expect(sub.unsubscribeCount).toBe(0); // the second reader is still there
    second.unmount();
    expect(sub.unsubscribeCount).toBe(1);
  });
});

describe('보내기 — 낙관적 반영과 화해', () => {
  it('보내는 즉시 pending 이 뜨고, 서버 응답이 seq 를 준다', async () => {
    const log = installFetch();
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.send('안녕하세요');
    });

    // The POST carried an idempotency key minted through the boot polyfill —
    // React Native has no `crypto` global, so this is proof it was installed.
    expect(log.sendBodies).toHaveLength(1);
    expect(String(log.sendBodies[0].clientMsgId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Settled: the response is the seq-authoritative echo.
    expect(result.current.pending).toEqual([]);
    expect(result.current.state.messages.map(m => m.body)).toContain('안녕하세요');
  });

  it('실패하면 그 자리에 남아 재시도를 제안하고, 키를 그대로 다시 쓴다', async () => {
    let attempt = 0;
    const log = installFetch({
      send: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(500, {error: {message: 'boom'}})
          : jsonResponse(200, message(100, {authorMemberId: SELF_ID, body: '안녕'}));
      },
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.send('안녕');
    });
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0].status).toBe('failed');

    const key = result.current.pending[0].clientMsgId;
    await act(async () => {
      await result.current.resend(key);
    });

    // The SAME key: a failed POST may still have committed, and the key is
    // what turns that ambiguity into "the server returns the original message"
    // rather than a second copy.
    expect(log.sendBodies.map(b => b.clientMsgId)).toEqual([key, key]);
    expect(result.current.pending).toEqual([]);
  });

  it('실시간 에코가 POST 응답을 앞질러도 중복이 남지 않는다', async () => {
    // The realtime frame does NOT carry client_msg_id, so this settlement can
    // only be decided on content: same author, same body, seq above the newest
    // that existed when the send started.
    // The POST hangs: the write committed on the server but the response was
    // lost. This is the case that used to leave a row reported as "sending" for
    // the rest of the session.
    let resolveSend: ((value: Response) => void) | undefined;
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/reactions')) return jsonResponse(200, {});
      if (url.includes('/messages') && init?.method === 'POST') {
        return new Promise<Response>(resolve => {
          resolveSend = resolve;
        });
      }
      if (url.includes('/messages')) return jsonResponse(200, {messages: []});
      throw new Error(`unrouted: ${url}`);
    }) as unknown as typeof fetch;

    const {rail, subscription} = makeRail();
    const {result} = renderTimeline(rail);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Held rather than awaited: this send does not resolve until the end of the
    // test, so awaiting it here would deadlock the assertions it exists for.
    let inFlight: Promise<void> | undefined;
    act(() => {
      inFlight = result.current.send('먼저 도착');
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    // The relay delivers my own message before my POST resolved.
    act(() => {
      subscription().__emit('publication', {
        data: frame(7, {author_member_id: SELF_ID, body: '먼저 도착'}),
      });
    });

    await waitFor(() => expect(result.current.pending).toEqual([]));
    expect(
      result.current.state.messages.filter(m => m.body === '먼저 도착'),
    ).toHaveLength(1);

    // Let the abandoned request finish so it does not outlive the test. The
    // late response merges by seq onto the row that is already there, which is
    // the other half of "중복 0".
    await act(async () => {
      resolveSend?.(
        jsonResponse(200, message(7, {authorMemberId: SELF_ID, body: '먼저 도착'})),
      );
      await inFlight;
    });
    expect(
      result.current.state.messages.filter(m => m.body === '먼저 도착'),
    ).toHaveLength(1);
  });
});

describe('#1166 — 페이지 읽기가 run 의 종결을 들고 온다', () => {
  const RUN = '019F9AB9-6DA4-7BE7-9BC9-4A3872D921FF';

  /** 닫는 PATCH 가 못 닿은 반쪽 답 — 열린 채로 남은 스트림. */
  function halfAnswer(runEnded?: boolean): Message {
    return message(4, {
      body: '그 파일을 열어 보면 첫 줄에',
      props: {[STREAM_PROPS_KEY]: {rev: 9, streaming: true}, run_id: RUN},
      ...(runEnded === undefined ? {} : {runEnded}),
    });
  }

  /**
   * **리로드 폐곡선, 훅을 통째로 지나서.**
   *
   * 이 세션은 그 run 의 터미널 프레임을 본 적이 없다 — 새로 뜬 앱이 하는 일은
   * REST 한 판을 긷는 것뿐이다. `applyBatch` 의 씨딩을 지우면 아래 꼬리가
   * `null` 로 돌아가고, 반쪽 답이 완결된 답의 옷을 입는다(ADR-0155 C안).
   */
  it('첫 페이지가 종결을 심어 꼬리가 선다', async () => {
    installFetch({
      messages: () => jsonResponse(200, {messages: [halfAnswer(true)]}),
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const row = result.current.state.messages[0];
    expect(endedRunIds().has(RUN.toLowerCase())).toBe(true);
    expect(streamStopMark(row, isStreamRunEnded(row, endedRunIds()))).toBe(
      STREAM_CUT_OFF_MARK,
    );
  });

  it('서버가 말하지 않으면 그 답은 도착 중인 채로 남는다', async () => {
    installFetch({
      messages: () => jsonResponse(200, {messages: [halfAnswer()]}),
    });
    const {rail} = makeRail();
    const {result} = renderTimeline(rail);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const row = result.current.state.messages[0];
    expect(endedRunIds().size).toBe(0);
    expect(
      streamStopMark(row, isStreamRunEnded(row, endedRunIds())),
    ).toBeNull();
  });
});
