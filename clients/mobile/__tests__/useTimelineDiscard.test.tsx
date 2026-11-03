import {act, cleanup, renderHook} from '@testing-library/react-native';
import {sendMessage, sendThreadReply, type Message} from '@momo/core/lib/api';

import '../src/boot/polyfills';
import {useTimeline} from '../src/features/conversation/useTimeline';

// =============================================================================
// 보내지 못한 메시지 지우기 (#5210, 웹 `useTimeline.discard.test.tsx` 의 짝).
//
// 판정은 코어 `discardPending` 이고(코어 시험이 갈래마다 잠근다) 여기서는 진짜 `useTimeline` 이 그 판정을 **그대로
// 따르는지**를 잰다: 지우면 서버 호출이 없고, 보내는 중에는 못 지우고, 지운 뒤의 다시 보내기는 아무 요청도 내지 않고,
// 스레드 답글의 행을 지우면 그 뿌리 표도 함께 정리된다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

function hook() {
  return renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

beforeEach(() => {
  jest.mocked(sendMessage).mockReset();
  jest.mocked(sendThreadReply).mockReset();
  // 서버에 닿지 못한 전송 — 행이 실패 상태로 남는다.
  jest.mocked(sendMessage).mockRejectedValue(new Error('offline'));
  jest.mocked(sendThreadReply).mockRejectedValue(new Error('offline'));
});

afterEach(cleanup);

describe('useTimeline.discard — 보내지 못한 메시지를 이 기기에서만 지운다', () => {
  it('실패한 행을 지우면 줄이 사라지고 서버 호출은 늘지 않는다. 지운 뒤 다시 보내기는 요청을 내지 않는다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.send('금요일 공지');
    });
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0]).toMatchObject({status: 'failed', body: '금요일 공지'});
    const id = view.result.current.pending[0].clientMsgId;
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);

    let removed: unknown = null;
    act(() => {
      removed = view.result.current.discard(id);
    });
    expect(removed).toMatchObject({clientMsgId: id, body: '금요일 공지', status: 'failed'});
    expect(view.result.current.pending).toEqual([]);
    // 지우기에는 서버로 가는 길이 없다.
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);

    await act(async () => {
      await view.result.current.resend(id);
    });
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending).toEqual([]);

    // 같은 키로 한 번 더 지우려 해도 아무 일도 없다.
    act(() => {
      removed = view.result.current.discard(id);
    });
    expect(removed).toBeNull();
  });

  it('보내는 중인 행은 지우지 않는다. 응답이 오면 줄이 정리된다', async () => {
    const first = deferred<Message>();
    jest.mocked(sendMessage).mockReturnValueOnce(first.promise);
    const view = hook();
    await act(async () => {
      void view.result.current.send('보내는 중');
    });
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0].status).toBe('sending');
    const id = view.result.current.pending[0].clientMsgId;

    let removed: unknown = 'untouched';
    act(() => {
      removed = view.result.current.discard(id);
    });
    expect(removed).toBeNull();
    expect(view.result.current.pending).toHaveLength(1);
    expect(view.result.current.pending[0].status).toBe('sending');

    await act(async () => {
      first.resolve({
        id: 'm-1',
        channelId: 'channel',
        seq: 1,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: 'self',
        type: 'text',
        body: '보내는 중',
        state: 'sent',
        createdAtMs: 1,
      } as Message);
    });
    expect(view.result.current.pending).toEqual([]);
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);
  });

  it('두 실패 행 중 하나를 지워도 다른 행은 그대로이고 그 행의 다시 보내기는 같은 키로 나간다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.send('네');
    });
    await act(async () => {
      await view.result.current.send('네');
    });
    const [keep, drop] = view.result.current.pending.map(row => row.clientMsgId);
    expect(view.result.current.pending.map(row => row.status)).toEqual(['failed', 'failed']);

    act(() => {
      view.result.current.discard(drop);
    });
    expect(view.result.current.pending.map(row => row.clientMsgId)).toEqual([keep]);

    await act(async () => {
      await view.result.current.resend(keep);
    });
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(3);
    expect(jest.mocked(sendMessage).mock.calls[2][2]).toBe(keep);
  });

  it('스레드 답글의 실패 행은 대화 화면에도 서고(#4888), 지우면 스레드의 줄과 함께 사라진다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply('root', '스레드 답글');
    });
    expect(view.result.current.repliesPending('root')).toHaveLength(1);
    const id = view.result.current.repliesPending('root')[0].clientMsgId;
    // 밀어서 보낸 답글은 스레드를 열지 않으므로 실패를 대화 화면에서 알려야 한다 — 같은 행이 두 자리에 선다(둘 중 하나만 보인다).
    expect(view.result.current.pending.map(row => row.clientMsgId)).toEqual([id]);
    expect(view.result.current.pending[0]).toMatchObject({status: 'failed', rootId: 'root'});

    act(() => {
      view.result.current.discard(id);
    });
    expect(view.result.current.repliesPending('root')).toEqual([]);
    expect(view.result.current.pending).toEqual([]);

    await act(async () => {
      await view.result.current.resend(id);
    });
    expect(jest.mocked(sendThreadReply)).toHaveBeenCalledTimes(1);
  });

  it('지운 키를 채널 전송에 다시 써도 옛 스레드로 새지 않는다 (뿌리 표를 함께 정리한다)', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply('root', '스레드 답글');
    });
    const id = view.result.current.repliesPending('root')[0].clientMsgId;
    act(() => {
      view.result.current.discard(id);
    });
    // 같은 키로 채널 메시지를 보낸다(`send` 의 `reuseClientMsgId`). 뿌리 표에 옛 칸이 남았다면 이 요청이 스레드 답글 길로 간다.
    await act(async () => {
      await view.result.current.send('채널로 다시 쓴 글', undefined, undefined, id);
    });
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(sendMessage).mock.calls[0][2]).toBe(id);
    expect(jest.mocked(sendThreadReply)).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending.map(row => row.clientMsgId)).toEqual([id]);
    expect(view.result.current.repliesPending('root')).toEqual([]);
  });
});
