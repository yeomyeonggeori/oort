import NetInfo from '@react-native-community/netinfo';
import {AUTO_RESEND_MAX_ATTEMPTS, AUTO_RESEND_WINDOW_MS} from '@momo/core/features/connection/thresholds';
import {
  ApiError,
  fetchChannelPins,
  fetchMessages,
  fetchReactionSnapshot,
  sendMessage,
  sendThreadReply,
  type Message,
} from '@momo/core/lib/api';
import {fetchWithDeadline, NetworkError} from '@momo/core/lib/http';
import {act, cleanup, renderHook} from '@testing-library/react-native';
import {AppState} from 'react-native';

import '../src/boot/polyfills';
import {recordDeviceOnline} from '../src/features/connection/deviceOnline';
import {readFailedSends, rememberFailedSend} from '../src/features/conversation/failedSends';
import {useTimeline} from '../src/features/conversation/useTimeline';
import type {ChannelRail} from '../src/realtime/channelRail';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// 보내지 못한 글: 이 기기에 남고(채널을 떠나도 · 앱이 죽어도), 네트워크로 못 보낸 글만 연결이 돌아오면 같은 멱등 키로 저절로 다시 간다
// (#5222, #5201 결정 ⑤, 웹 `useTimeline.failedSends.test.tsx` 의 짝). 판정(어떤 실패를 몇 번 얼마 동안)은 코어 `pickAutoResends` 하나이고,
// 이 파일은 진짜 `useTimeline` 이 그 판정을 **그대로 따르는지**를 잰다.
//
// 숫자는 상수가 아니라 글자 그대로(3회 · 5분 = 300_000ms)로 단정한다 - 상수를 깨뜨려도 같이 움직여 초록으로 남는 일이 없게.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
  fetchMessages: jest.fn(),
  fetchReactionSnapshot: jest.fn(),
  fetchChannelPins: jest.fn(),
}));

const WS = 'workspace';
const CH = 'channel';
const ME = 'self';
const T0 = 1_700_000_000_000;
const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

/** 구독만 받아 주는 레일: 이 시험은 실시간이 아니라 보내기를 잰다. */
const rail = {subscribeChannel: jest.fn(() => () => undefined)} as unknown as ChannelRail;

const send = jest.mocked(sendMessage);
const sendReply = jest.mocked(sendThreadReply);

function ok(id: string): Message {
  return {
    id,
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: 'text',
    body: id,
    state: 'sent',
    createdAtMs: 1,
  } as Message;
}

const hook = (channel = CH, member = ME) =>
  renderHook(() => useTimeline(rail, WS, channel, member));
const noNetwork = () => new NetworkError('unreachable', 15_000);

/** 서버가 답했다는 신호: REST 응답 하나(5xx 아님). 코어 관찰기가 이것을 알린다. */
async function serverAnswers() {
  (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
    status: 200,
    ok: true,
    text: async () => '{}',
    headers: {get: () => null},
  });
  await act(async () => {
    await fetchWithDeadline('https://api.example.com/v1/ping');
  });
}
async function settle(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

const realFetch = globalThis.fetch;
let store = memoryStore();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  store = memoryStore();
  __setNonSecretStore(store);
  recordDeviceOnline(null);
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  send.mockReset();
  sendReply.mockReset();
  send.mockRejectedValue(noNetwork());
  sendReply.mockRejectedValue(noNetwork());
  jest.mocked(fetchMessages).mockReset().mockResolvedValue({messages: [], nextBefore: undefined} as never);
  jest.mocked(fetchReactionSnapshot).mockReset().mockResolvedValue({} as never);
  jest.mocked(fetchChannelPins).mockReset().mockResolvedValue([] as never);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  __setNonSecretStore(null);
  recordDeviceOnline(null);
});

async function failOne(view: ReturnType<typeof hook>, body = '내일 봐요') {
  await act(async () => {
    await view.result.current.send(body);
  });
  await settle();
}

describe('이 기기에 남고, 다시 열면 같은 키의 실패 행으로 돌아온다', () => {
  it('실패한 글: 새 마운트(채널을 떠났다 돌아옴 · 앱 재시작)가 같은 멱등 키 · 본문 · 첨부로 되살리고 원인 종류도 이어진다', async () => {
    const first = hook();
    await act(async () => {
      await first.result.current.send('보고서 올려요', undefined, [
        {id: 'att-1', name: '보고서.pdf', mime: 'application/pdf', sizeBytes: 10},
      ]);
    });
    await settle();
    const [failed] = first.result.current.pending;
    expect(failed).toMatchObject({status: 'failed', body: '보고서 올려요'});
    expect(first.result.current.failureKinds.get(failed.clientMsgId)).toBe('server');
    first.unmount();

    const second = hook();
    await settle();
    expect(second.result.current.pending).toHaveLength(1);
    expect(second.result.current.pending[0]).toMatchObject({
      clientMsgId: failed.clientMsgId,
      status: 'failed',
      body: '보고서 올려요',
      attachments: [{id: 'att-1', name: '보고서.pdf'}],
    });
    expect(second.result.current.failureKinds.get(failed.clientMsgId)).toBe('server');

    // 되살린 행의 다시 보내기는 같은 키로 나간다 - 서버가 이미 받았어도 한 메시지다.
    send.mockReset();
    send.mockResolvedValue(ok('m-1'));
    await act(async () => {
      await second.result.current.resend(failed.clientMsgId);
    });
    expect(send.mock.calls[0][2]).toBe(failed.clientMsgId);
    expect(second.result.current.pending).toEqual([]);
    // 보냈으니 저장본도 없다: 세 번째로 열어도 되살아나지 않는다.
    second.unmount();
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  it('원인 종류: 기기가 꺼져 있었으면 오프라인, 서버가 거절했으면 거절 - 둘 다 이 기기에 종류가 남는다', async () => {
    const view = hook();
    recordDeviceOnline(false);
    await failOne(view, '오프라인에서');
    recordDeviceOnline(true);
    send.mockRejectedValue(new ApiError(422, 'invalid', 'invalid_request'));
    await failOne(view, '거절될 글');
    const [offline, rejected] = view.result.current.pending;
    expect(view.result.current.failureKinds.get(offline.clientMsgId)).toBe('offline');
    expect(view.result.current.failureKinds.get(rejected.clientMsgId)).toBe('rejected');
    view.unmount();
    const again = hook();
    await settle();
    expect(again.result.current.pending.map(p => again.result.current.failureKinds.get(p.clientMsgId))).toEqual([
      'offline',
      'rejected',
    ]);
  });

  it('서버가 이미 받았던 글(응답만 유실됐다)은 되살린 행이 머리를 읽은 뒤 확정 메시지와 만나 행도 저장본도 스스로 사라진다', async () => {
    const first = hook();
    await failOne(first, '응답을 못 받은 글');
    first.unmount();
    expect(readFailedSends(WS, CH, ME, T0)).toHaveLength(1);
    // 서버는 그 글을 갖고 있다: 채널 머리에 같은 사람이 쓴 같은 본문이 있다.
    jest.mocked(fetchMessages).mockResolvedValue({
      messages: [{...ok('server-copy'), body: '응답을 못 받은 글', seq: 9}],
      nextBefore: undefined,
    } as never);
    const again = hook();
    await settle();
    expect(again.result.current.pending).toEqual([]);
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  it('지운 글은 저장본에서도 사라져 되살아나지 않는다', async () => {
    const view = hook();
    await failOne(view);
    const id = view.result.current.pending[0].clientMsgId;
    act(() => {
      view.result.current.discard(id);
    });
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
    view.unmount();
    const again = hook();
    await settle();
    expect(again.result.current.pending).toEqual([]);
  });

  it('다른 사람이 쓴 글은 되살리지 않는다 - 같은 기기를 나눠 쓰는 계정', async () => {
    const mine = hook(CH, ME);
    await failOne(mine);
    mine.unmount();
    const other = hook(CH, 'someone-else');
    await settle();
    expect(other.result.current.pending).toEqual([]);
  });

  it('다른 채널의 글은 그 채널을 열 때만 돌아온다', async () => {
    const here = hook(CH);
    await failOne(here);
    here.unmount();
    const there = hook('another-channel');
    await settle();
    expect(there.result.current.pending).toEqual([]);
    there.unmount();
    const back = hook(CH);
    await settle();
    expect(back.result.current.pending).toHaveLength(1);
  });

  it('채널을 떠날 때 날아가던 글은 실패 행으로 남고, 늦게 실패하면 원인이 이어지고 늦게 성공하면 저장본이 사라진다', async () => {
    let fail: (error: unknown) => void = () => undefined;
    let succeed: (message: Message) => void = () => undefined;
    send.mockReset();
    send.mockImplementationOnce(() => new Promise<Message>((_ok, reject) => { fail = reject; }));
    send.mockImplementationOnce(() => new Promise<Message>(resolve => { succeed = resolve; }));
    const view = hook();
    await act(async () => {
      void view.result.current.send('날아가는 글');
      void view.result.current.send('이것도 날아가요');
    });
    expect(view.result.current.pending.map(p => p.status)).toEqual(['sending', 'sending']);
    const [first, second] = view.result.current.pending;
    view.unmount();
    // 떠나는 순간 두 글 모두 이 기기에 남았다(결과를 모르는 글은 실패 행으로 돌아온다).
    expect(readFailedSends(WS, CH, ME, T0).map(r => r.row.clientMsgId).sort()).toEqual(
      [first.clientMsgId, second.clientMsgId].sort(),
    );
    // 늦게 실패한다: 원인 종류가 저장본에 이어진다. 늦게 성공한다: 저장본이 지워진다.
    await act(async () => {
      fail(noNetwork());
      succeed(ok('late'));
    });
    const left = readFailedSends(WS, CH, ME, T0);
    expect(left.map(r => r.row.clientMsgId)).toEqual([first.clientMsgId]);
    expect(left[0].kind).toBe('server');
  });

  // ---- 스레드 답글 (#5262): 행이 `rootId` 를 싣고 다니므로(#4888) 대화의 글과 같은 저장소·같은 규칙으로 남는다 ----
  it('스레드 답글의 실패 행도 이 기기에 남는다 - 뿌리를 행이 싣고 있다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply('root-1', '답글이에요');
    });
    await settle();
    expect(view.result.current.repliesPending('root-1')).toHaveLength(1);
    const stored = readFailedSends(WS, CH, ME, T0);
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      rootId: 'root-1',
      body: '답글이에요',
      status: 'failed',
    });
    expect(stored[0].row).not.toHaveProperty('alsoInChannel');
    expect(stored[0].kind).toBe('server');
  });

  it('채널을 다시 열면 답글 실패 행이 같은 키 · 같은 뿌리로 돌아오고(스레드와 대화 목록 둘 다), 다시 보내기는 답글 길로 나간다', async () => {
    const first = hook();
    await act(async () => {
      await first.result.current.sendReply('root-1', '답글이에요');
    });
    await settle();
    const [failed] = first.result.current.repliesPending('root-1');
    first.unmount();

    const second = hook();
    await settle();
    // 스레드 화면이 읽는 자리(`repliesPending`)와, 실패한 답글이 서는 대화 목록의 자리(`pending`)에 모두 같은 행이 돌아왔다.
    expect(second.result.current.repliesPending('root-1').map(p => p.clientMsgId)).toEqual([failed.clientMsgId]);
    expect(second.result.current.pending.map(p => p.clientMsgId)).toEqual([failed.clientMsgId]);
    expect(second.result.current.pending[0]).toMatchObject({status: 'failed', rootId: 'root-1'});
    expect(second.result.current.failureKinds.get(failed.clientMsgId)).toBe('server');

    // 되살린 답글의 다시 보내기는 글 길(`sendMessage`)이 아니라 답글 길로, 같은 키 · 같은 뿌리 · 같은 옵션으로 나간다.
    send.mockClear();
    sendReply.mockReset();
    sendReply.mockResolvedValue({...ok('r-1'), rootId: 'root-1'} as Message);
    await act(async () => {
      await second.result.current.resend(failed.clientMsgId);
    });
    expect(send).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0].slice(0, 5)).toEqual([WS, CH, 'root-1', failed.clientMsgId, '답글이에요']);
    expect(sendReply.mock.calls[0][5]).toBeUndefined();
    expect(second.result.current.pending).toEqual([]);
    second.unmount();
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  // 사보타주: `post` 에 `...(row.alsoInChannel === true ? {alsoInChannel: true} : {})` 를 되살리면 이 시험이 RED 여야 한다(옛 판이 남긴 저장본도 키를 싣지 않는다).
  it('옛 판이 「대화에도 보내기」를 켠 채 남긴 저장본도 다시 보낼 때 그 키를 싣지 않는다 - 답글은 스레드에만 간다 (#5324)', async () => {
    const stale = {
      clientMsgId: 'stale-1',
      channelId: CH,
      authorMemberId: ME,
      body: '옛 판의 답글',
      createdAtMs: T0,
      sinceSeq: 0,
      status: 'failed',
      rootId: 'root-1',
      alsoInChannel: true,
    };
    rememberFailedSend(WS, stale as never, 'server', T0);
    const view = hook();
    await settle();
    expect(view.result.current.repliesPending('root-1').map(p => p.clientMsgId)).toEqual(['stale-1']);
    sendReply.mockReset();
    sendReply.mockResolvedValue({...ok('r-stale'), rootId: 'root-1'} as Message);
    await act(async () => {
      await view.result.current.resend('stale-1');
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0].slice(0, 5)).toEqual([WS, CH, 'root-1', 'stale-1', '옛 판의 답글']);
    expect(sendReply.mock.calls[0][5]).toBeUndefined();
    view.unmount();
  });

  it('채널을 떠날 때 날아가던 답글도 이 기기에 남는다 - 결과를 모르는 글은 실패 행으로 돌아온다', async () => {
    sendReply.mockReset();
    sendReply.mockImplementation(() => new Promise<Message>(() => undefined));
    const view = hook();
    await act(async () => {
      void view.result.current.sendReply('root-1', '날아가는 답글');
    });
    expect(view.result.current.repliesPending('root-1').map(p => p.status)).toEqual(['sending']);
    view.unmount();
    const kept = readFailedSends(WS, CH, ME, T0);
    expect(kept).toHaveLength(1);
    expect(kept[0].row).toMatchObject({rootId: 'root-1', body: '날아가는 답글', status: 'failed'});
    expect(kept[0].kind).toBeNull();
  });

  it('API 키 모양이 든 답글은 저장소에 남기지 않는다 - 화면의 실패 행은 그대로 있다', async () => {
    // 접두와 꼬리를 10자 아래 조각으로 이어 붙인다(저장소 비밀 검사가 시험 속 가짜 키를 진짜로 읽지 않게).
    const keyLike = ['s', 'k-', 'ant-', 'api03-', 'aB3xK9mQ', '2vL7nR4t', 'Y8wZ1cD5', 'fG6hJ0pS'].join('');
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply('root-1', `키는 ${keyLike} 이에요`);
    });
    await settle();
    expect(view.result.current.repliesPending('root-1')).toHaveLength(1);
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  it('서버가 이미 받았던 답글(응답만 유실됐다)은 되살린 행이 확정 답글과 만나 행도 저장본도 스스로 사라진다', async () => {
    const first = hook();
    await act(async () => {
      await first.result.current.sendReply('root-1', '응답을 못 받은 답글');
    });
    await settle();
    first.unmount();
    expect(readFailedSends(WS, CH, ME, T0)).toHaveLength(1);
    jest.mocked(fetchMessages).mockResolvedValue({
      messages: [{...ok('server-copy'), body: '응답을 못 받은 답글', seq: 9, rootId: 'root-1'}],
      nextBefore: undefined,
    } as never);
    const again = hook();
    await settle();
    expect(again.result.current.repliesPending('root-1')).toEqual([]);
    expect(again.result.current.pending).toEqual([]);
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  it('앱이 뒤로 가는 순간에도 날아가던 글을 남긴다(프로세스가 죽을 수 있다). 앞에 있는 동안에는 남기지 않는다', async () => {
    send.mockReset();
    send.mockImplementation(() => new Promise<Message>(() => undefined));
    // 공용 AppState 목을 건드리지 않는다(`mockRestore` 는 목의 구현을 지워 뒤 시험을 깨뜨린다): 호출 기록만 비운다.
    const register = AppState.addEventListener as unknown as jest.Mock;
    register.mockClear();
    const view = hook();
    await act(async () => {
      void view.result.current.send('날아가는 글');
    });
    const change = [...register.mock.calls].reverse().find(call => call[0] === 'change')?.[1] as
      | ((status: string) => void)
      | undefined;
    expect(change).toBeDefined();
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
    act(() => change?.('inactive'));
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
    act(() => change?.('background'));
    expect(readFailedSends(WS, CH, ME, T0)).toHaveLength(1);
  });
});

describe('결정 ⑤ — 네트워크로 못 보낸 글만 같은 멱등 키로 저절로 다시 보낸다', () => {
  it('서버가 답하면(응답 한 건) 못 보낸 글이 같은 키로 한 번 더 나가고, 성공하면 행도 저장본도 사라진다', async () => {
    const view = hook();
    await failOne(view);
    const id = view.result.current.pending[0].clientMsgId;
    expect(send).toHaveBeenCalledTimes(1);

    send.mockReset();
    send.mockResolvedValue(ok('m-1'));
    await serverAnswers();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toBe(id);
    expect(view.result.current.pending).toEqual([]);
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
  });

  it('기기가 꺼졌다 켜지면(NetInfo) 같은 신호다. 켜져 있던 채로 오는 보고는 신호가 아니다', async () => {
    const view = hook();
    await failOne(view);
    send.mockReset();
    send.mockResolvedValue(ok('m-1'));
    // 첫 보고(켜짐)와 망 종류만 바뀐 보고는 「돌아왔다」가 아니다.
    act(() => netInfo.__emit({isConnected: true, isInternetReachable: true}));
    act(() => netInfo.__emit({isConnected: true, isInternetReachable: true}));
    await settle();
    expect(send).not.toHaveBeenCalled();
    act(() => netInfo.__emit({isConnected: false, isInternetReachable: false}));
    await settle();
    expect(send).not.toHaveBeenCalled();
    act(() => netInfo.__emit({isConnected: true, isInternetReachable: true}));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('한 글당 3회까지다: 매번 네트워크로 실패하면 자동으로 정확히 3번만 더 보내고 멈춘다 - 손으로 보내는 것은 상한과 무관하다', async () => {
    expect(AUTO_RESEND_MAX_ATTEMPTS).toBe(3);
    const view = hook();
    await failOne(view);
    send.mockClear();
    for (let signal = 0; signal < 6; signal += 1) {
      await serverAnswers();
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(3);
    // 3번이 소진된 뒤에도 사람이 누르면 나간다(그 뒤는 사람이 정한다)
    const id = view.result.current.pending[0].clientMsgId;
    send.mockClear();
    await act(async () => {
      await view.result.current.resend(id);
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('손으로 보낸 것은 자동 횟수에 세지 않는다: 손으로 두 번 실패해도 자동은 여전히 3번 남아 있다', async () => {
    const view = hook();
    await failOne(view);
    const id = view.result.current.pending[0].clientMsgId;
    for (let manual = 0; manual < 2; manual += 1) {
      await act(async () => {
        await view.result.current.resend(id);
      });
    }
    send.mockClear();
    for (let signal = 0; signal < 5; signal += 1) {
      await serverAnswers();
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('첫 실패로부터 5분(300_000ms)이 지나면 자동으로 보내지 않는다 - 1ms 모자란 때까지는 보낸다', async () => {
    expect(AUTO_RESEND_WINDOW_MS).toBe(300_000);
    const view = hook();
    await failOne(view);
    send.mockClear();
    await settle(299_999);
    await serverAnswers();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    // 그 시도도 실패했다. 5분이 찼다.
    send.mockClear();
    await settle(1);
    await serverAnswers();
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('서버가 거절한 글(ApiError)과 응답이 온 5xx 실패(502)는 자동으로 보내지 않는다 - 손으로만', async () => {
    const view = hook();
    send.mockRejectedValue(new ApiError(422, 'invalid', 'invalid_request'));
    await failOne(view, '거절될 글');
    send.mockRejectedValue(new ApiError(502, 'bad gateway'));
    await failOne(view, '배포 중에 보낸 글');
    send.mockClear();
    send.mockResolvedValue(ok('m-1'));
    await serverAnswers();
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(view.result.current.pending.map(p => p.status)).toEqual(['failed', 'failed']);
  });

  it('되살린 행은 자동 대상이 아니다: 처음 실패한 때를 몰라 5분을 셀 수 없다', async () => {
    const first = hook();
    await failOne(first);
    first.unmount();
    const again = hook();
    await settle();
    expect(again.result.current.pending).toHaveLength(1);
    send.mockClear();
    send.mockResolvedValue(ok('m-1'));
    await serverAnswers();
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(again.result.current.pending).toHaveLength(1);
  });

  it('기기가 꺼져 있다고 알면 서버 응답 신호가 와도 기다린다. 꺼짐이 걷히면 다음 신호에 나간다', async () => {
    const view = hook();
    await failOne(view);
    send.mockClear();
    send.mockResolvedValue(ok('m-1'));
    recordDeviceOnline(false);
    await serverAnswers();
    await settle();
    expect(send).not.toHaveBeenCalled();
    recordDeviceOnline(true);
    await serverAnswers();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('한 번에 한 글이고 보낸 순서대로다. 하나가 또 실패하면 다음 신호까지 쉰다', async () => {
    const view = hook();
    await failOne(view, '첫째');
    await failOne(view, '둘째');
    const [a, b] = view.result.current.pending;
    send.mockReset();
    send.mockRejectedValueOnce(noNetwork());
    send.mockResolvedValue(ok('m-1'));
    await serverAnswers();
    await settle();
    // 첫째가 또 실패했으니 둘째는 이번 신호에서 나가지 않는다.
    expect(send.mock.calls.map(call => call[2])).toEqual([a.clientMsgId]);
    send.mockClear();
    await serverAnswers();
    await settle();
    // 첫째가 먼저(성공), 이어서 같은 신호 안에서 둘째.
    expect(send.mock.calls.map(call => call[2])).toEqual([a.clientMsgId, b.clientMsgId]);
    expect(view.result.current.pending).toEqual([]);
  });

  it('자동으로 다시 보낸 시도가 실패해도 진동을 주지 않는다 - 사람이 누른 다시 보내기의 실패는 준다', async () => {
    const buzzes = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;
    const view = hook();
    await failOne(view);
    const id = view.result.current.pending[0].clientMsgId;
    buzzes.length = 0;
    // 풍부 모드의 햅틱은 100ms 창을 공유한다: 첫 실패의 진동 직후라면 새 진동이 창에 먹혀 이 시험이 아무것도 못 재게 된다(깨뜨려도 초록).
    // 가짜 시계를 창 밖으로 보내, 가드를 지우면 **실제로** 울리는 상태에서 잰다.
    await settle(200);
    // 저절로 다시 보낸 시도가 실패한다: 시도는 갔고 행은 그대로 실패 행인데 소리 없이 지나간다.
    send.mockClear();
    await serverAnswers();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending[0].status).toBe('failed');
    expect(buzzes).toEqual([]);
    // 사람이 눌렀다가 실패하면 한 번 울린다. (풍부 모드의 햅틱은 100ms 창을 공유한다 - 가짜 시계를 그 창 밖으로 보낸다.)
    await settle(200);
    await act(async () => {
      await view.result.current.resend(id);
    });
    expect(buzzes).toEqual(['notification:error']);
  });
});
