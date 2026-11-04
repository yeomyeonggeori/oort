import {act, cleanup, renderHook} from '@testing-library/react-native';
import {sendMessage, sendThreadReply} from '@momo/core/lib/api';

import '../src/boot/polyfills';
import {useTimeline} from '../src/features/conversation/useTimeline';

// =============================================================================
// 입력칸 ✕로 링크 미리보기를 끈 전송이 요청에 닿는 길 (#5016, 웹 `useTimeline.suppressUnfurl.test.tsx` 의 짝).
//
// 진짜 `useTimeline` 위에서 코어 전송 함수(`sendMessage`·`sendThreadReply`)의 **받은 인자**를 잰다. 대기 행이 표시를
// 들고 다니므로(`PendingMessage.suppressUnfurl`) 실패한 전송의 「다시 보내기」도 같은 요청이어야 한다 — 서버는 이미
// 저장된 메시지의 재시도에서 이 필드를 다시 판단하지 않으므로, 떨구는 순간 사람이 끈 카드가 되살아난다. 켜지 않은
// 전송은 이 필드 이전과 **같은 호출**이어야 한다(요청은 closed-world라 옛 서버는 모르는 키를 400으로 거절한다).
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

const LINK = 'https://a.example/post';

function hook() {
  return renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
}

beforeEach(() => {
  jest.mocked(sendMessage).mockReset();
  jest.mocked(sendThreadReply).mockReset();
  // 서버에 닿지 못한 전송 — 행이 실패 상태로 남아 「다시 보내기」를 기다린다.
  jest.mocked(sendMessage).mockRejectedValue(new Error('offline'));
  jest.mocked(sendThreadReply).mockRejectedValue(new Error('offline'));
});

afterEach(cleanup);

describe('입력칸 ✕로 끈 전송 (#5016)', () => {
  it('채널 전송: 켠 때만 키가 가고, 실패한 전송을 다시 보내도 같은 요청이다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.send(LINK, undefined, undefined, undefined, {suppressUnfurl: true});
    });
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    const [, , firstKey, , firstOptions] = jest.mocked(sendMessage).mock.calls[0];
    expect(firstOptions).toMatchObject({suppressUnfurl: true});
    expect(view.result.current.pending[0]).toMatchObject({status: 'failed', suppressUnfurl: true});

    await act(async () => {
      await view.result.current.resend(view.result.current.pending[0].clientMsgId);
    });
    expect(jest.mocked(sendMessage)).toHaveBeenCalledTimes(2);
    const [, , secondKey, , secondOptions] = jest.mocked(sendMessage).mock.calls[1];
    // 같은 멱등키로 같은 요청을 다시 보낸다.
    expect(secondKey).toBe(firstKey);
    expect(secondOptions).toMatchObject({suppressUnfurl: true});
  });

  it('켜지 않은 채널 전송은 키가 없다 — 이 필드 이전과 같은 요청이다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.send(LINK);
    });
    const [, , , , options] = jest.mocked(sendMessage).mock.calls[0];
    expect(options).not.toHaveProperty('suppressUnfurl');
    expect(view.result.current.pending[0]).not.toHaveProperty('suppressUnfurl');
  });

  it('스레드 답글: 켠 때만 키가 가고 다시 보내기도 같은 요청이며, 켜지 않은 답글은 옵션이 아예 없다', async () => {
    const view = hook();
    await act(async () => {
      await view.result.current.sendReply('root', LINK, undefined, {suppressUnfurl: true});
    });
    expect(jest.mocked(sendThreadReply)).toHaveBeenCalledTimes(1);
    const [, , rootId, firstKey, , firstOptions] = jest.mocked(sendThreadReply).mock.calls[0];
    expect(rootId).toBe('root');
    expect(firstOptions).toEqual({suppressUnfurl: true});

    // 답글의 에코는 채널 목록(`pending`)이 아니라 그 스레드(`repliesPending`)에만 선다.
    await act(async () => {
      await view.result.current.resend(view.result.current.repliesPending('root')[0].clientMsgId);
    });
    const [, , , secondKey, , secondOptions] = jest.mocked(sendThreadReply).mock.calls[1];
    expect(secondKey).toBe(firstKey);
    expect(secondOptions).toEqual({suppressUnfurl: true});

    // 켜지 않은 답글은 예전과 같은 호출이다: 옵션 자리가 비어 있다.
    await act(async () => {
      await view.result.current.sendReply('root', '평범한 답글');
    });
    const plain = jest.mocked(sendThreadReply).mock.calls[2];
    expect(plain[4]).toBe('평범한 답글');
    expect(plain[5]).toBeUndefined();
  });
});
