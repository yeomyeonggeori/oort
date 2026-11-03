import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {ApiError, sendMessage, sendThreadReply, type Message} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import React from 'react';

import '../src/boot/polyfills';
import {FixedScheme} from '../src/design/theme';
import {ResendAllBar} from '../src/features/conversation/ResendAllBar';
import {resendAllOffer} from '../src/features/conversation/resendAllOffer';
import {Timeline} from '../src/features/conversation/Timeline';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {flat, member} from './testkit';

// =============================================================================
// 「N개 모두 다시 보내기」 (#5222, #5201 S-D, 결정 ⑤의 손으로 하는 쪽).
//
//   · 어디에 서나: 실패가 둘 이상일 때 첫 실패 줄 위에 한 번만(`resendAllOffer`, 순수).
//   · 무엇을 하나: 실패한 글 전부를 보낸 순서대로, 각자 같은 멱등 키로 한 번씩, 앞의 글이 끝난 뒤 다음 글을
//     (`useTimeline.resendAll`). 응답이 없는 실패에서는 멈추고, 서버가 거절한 글은 그 글만 실패로 남기고 이어 간다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
const DIRECTORY = makeDirectory([member({id: SELF, displayName: '박서연', handle: 'seoyeon'})]);

const row = (id: string, createdAtMs: number, status: 'failed' | 'sending' = 'failed'): PendingMessage => ({
  clientMsgId: id,
  channelId: 'channel',
  authorMemberId: SELF,
  body: `글 ${id}`,
  status,
  sinceSeq: null,
  createdAtMs,
});

afterEach(cleanup);

describe('resendAllOffer — 어디에 서나', () => {
  it('실패가 둘 미만이면 서지 않는다 (한 줄은 그 줄의 새로고침 아이콘이면 충분하다)', () => {
    expect(resendAllOffer(undefined)).toBeNull();
    expect(resendAllOffer([])).toBeNull();
    expect(resendAllOffer([row('a', NOW)])).toBeNull();
    // 보내는 중인 행은 실패가 아니다.
    expect(resendAllOffer([row('a', NOW), row('b', NOW + 1, 'sending')])).toBeNull();
  });

  it('둘 이상이면 보낸 순서로 가장 먼저 실패한 줄 위에 한 번만 서고, 실패한 수를 센다', () => {
    const offer = resendAllOffer([row('late', NOW + 5), row('sending', NOW + 6, 'sending'), row('early', NOW)]);
    expect(offer).toEqual({anchorId: 'early', count: 2});
  });
});

describe('ResendAllBar — 그리기', () => {
  function mount(count: number, onPress = jest.fn(), language = 'ko-KR') {
    render(
      <MobileLocaleProvider
        createController={() =>
          createMobileLocaleController({
            port: {
              readPreference: () => 'system',
              writePreference: () => {},
              readDevice: () => ({languages: [language], timeZone: 'UTC'}),
            },
          })
        }>
        <FixedScheme scheme="light">
          <ResendAllBar count={count} onPress={onPress} />
        </FixedScheme>
      </MobileLocaleProvider>,
    );
    return onPress;
  }

  it('「N개 모두 다시 보내기」 단추: 누르면 한 번 부르고, 누르는 면이 44pt 이상이다', async () => {
    const onPress = mount(3);
    const button = await screen.findByTestId('resend-all');
    expect(button.props.accessibilityLabel).toBe('3개 모두 다시 보내기');
    expect(flat(button.props.style).minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('영어는 복수형 틀이다: 둘이면 「Resend all 2 messages」', async () => {
    mount(2, jest.fn(), 'en-US');
    const button = await screen.findByTestId('resend-all');
    expect(button.props.accessibilityLabel).toBe('Resend all 2 messages');
  });
});

describe('Timeline — 단추는 첫 실패 줄 위에 한 번만 선다', () => {
  function mountTimeline(pending: PendingMessage[], onResendAll?: () => void) {
    return render(
      <FixedScheme scheme="light">
        <Timeline
          messages={[]}
          directory={DIRECTORY}
          status="ready"
          pending={pending}
          myMemberId={SELF}
          nowMs={NOW}
          onResendPending={jest.fn()}
          onResendAll={onResendAll}
        />
      </FixedScheme>,
    );
  }

  it('실패 셋이면 단추는 하나이고 첫 실패 줄 바로 앞에 서며, 누르면 onResendAll 을 한 번 부른다', async () => {
    const onResendAll = jest.fn();
    mountTimeline([row('a', NOW), row('b', NOW + 1), row('c', NOW + 2)], onResendAll);
    const bars = screen.getAllByTestId('resend-all');
    expect(bars).toHaveLength(1);
    expect(bars[0].props.accessibilityLabel).toBe('3개 모두 다시 보내기');
    // 줄마다 새로고침 아이콘은 그대로 있다(#5210).
    expect(screen.getAllByTestId('pending-resend')).toHaveLength(3);
    // 단추는 첫 실패 줄 앞에 선다: 그리는 순서로 읽으면 단추가 모든 새로고침 아이콘보다 먼저다.
    // 호스트 요소만 센다(합성 요소는 같은 testID 를 한 번 더 든다).
    const order = screen.UNSAFE_root
      .findAll(
        (node: {type: unknown; props: {testID?: string}}) =>
          typeof node.type === 'string' && ['resend-all', 'pending-resend'].includes(node.props.testID ?? ''),
        {deep: true},
      )
      .map((node: {props: {testID?: string}}) => node.props.testID);
    expect(order).toEqual(['resend-all', 'pending-resend', 'pending-resend', 'pending-resend']);
    fireEvent.press(bars[0]);
    expect(onResendAll).toHaveBeenCalledTimes(1);
  });

  it('실패가 하나뿐이면 서지 않는다 - 그 줄의 새로고침 아이콘이면 충분하다', () => {
    mountTimeline([row('a', NOW)], jest.fn());
    expect(screen.queryByTestId('resend-all')).toBeNull();
    expect(screen.getAllByTestId('pending-resend')).toHaveLength(1);
  });

  it('핸들러를 주지 않은 자리(읽기 전용 목록)에는 서지 않는다', () => {
    mountTimeline([row('a', NOW), row('b', NOW + 1)], undefined);
    expect(screen.queryByTestId('resend-all')).toBeNull();
  });
});

// ---- useTimeline.resendAll ---------------------------------------------------------------

function ok(id: string, seq: number): Message {
  return {
    id,
    channelId: 'channel',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: 'self',
    type: 'text',
    body: id,
    state: 'sent',
    createdAtMs: seq,
  } as Message;
}

describe('useTimeline.resendAll — 같은 키로 한 번씩, 보낸 순서대로', () => {
  const hook = () => renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
  const send = jest.mocked(sendMessage);
  const keysOf = () => send.mock.calls.map(call => call[2]);

  beforeEach(() => {
    send.mockReset();
    send.mockRejectedValue(new NetworkError('unreachable', 15_000));
  });

  async function failThree(view: ReturnType<typeof hook>) {
    for (const body of ['첫째', '둘째', '셋째']) {
      await act(async () => {
        await view.result.current.send(body);
      });
    }
    expect(view.result.current.pending.map(p => p.status)).toEqual(['failed', 'failed', 'failed']);
    expect(send).toHaveBeenCalledTimes(3);
  }

  it('실패 셋을 모두 다시 보내면 요청이 정확히 셋 더 나가고 키는 처음 보낸 그 키 그대로다 (한 글 한 번)', async () => {
    const view = hook();
    await failThree(view);
    const firstKeys = keysOf();
    expect(new Set(firstKeys).size).toBe(3);

    send.mockReset();
    send.mockImplementation(async (_ws, _ch, clientMsgId, body) => ok(`${clientMsgId}`, body === '첫째' ? 1 : body === '둘째' ? 2 : 3));
    await act(async () => {
      await view.result.current.resendAll();
    });
    // 보낸 순서(첫째 → 둘째 → 셋째)로, 각 글 한 번, 처음 보낸 키로.
    expect(keysOf()).toEqual(firstKeys);
    expect(send.mock.calls.map(call => call[3])).toEqual(['첫째', '둘째', '셋째']);
    expect(view.result.current.pending).toEqual([]);
  });

  it('앞의 글이 끝난 뒤에 다음 글을 보낸다: 둘이 동시에 날아가지 않는다', async () => {
    const view = hook();
    await failThree(view);
    send.mockReset();
    let inFlight = 0;
    let peak = 0;
    send.mockImplementation(async (_ws, _ch, clientMsgId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return ok(`${clientMsgId}`, 1);
    });
    await act(async () => {
      await view.result.current.resendAll();
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it('응답이 없는 실패(NetworkError)가 나면 거기서 멈춘다: 뒤의 글이 앞의 글을 앞지르지 않고, 닿지 않는 서버를 계속 두드리지 않는다', async () => {
    const view = hook();
    await failThree(view);
    send.mockReset();
    send.mockRejectedValue(new NetworkError('timeout', 15_000));
    await act(async () => {
      await view.result.current.resendAll();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending.map(p => p.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('서버가 거절한 글은 그 글만 실패로 남기고 뒤의 글은 이어서 보낸다', async () => {
    const view = hook();
    await failThree(view);
    send.mockReset();
    send.mockImplementation(async (_ws, _ch, clientMsgId, body) => {
      if (body === '둘째') throw new ApiError(422, 'rejected', 'invalid');
      return ok(`${clientMsgId}`, body === '첫째' ? 1 : 3);
    });
    await act(async () => {
      await view.result.current.resendAll();
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(view.result.current.pending.map(p => [p.body, p.status])).toEqual([['둘째', 'failed']]);
  });

  it('보내는 중인 글은 건드리지 않는다. 실패가 없으면 요청도 없다', async () => {
    const view = hook();
    let release: (message: Message) => void = () => undefined;
    send.mockReset();
    send.mockReturnValueOnce(new Promise<Message>(done => { release = done; }));
    await act(async () => {
      void view.result.current.send('보내는 중');
    });
    expect(view.result.current.pending[0].status).toBe('sending');
    await act(async () => {
      await view.result.current.resendAll();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending[0].status).toBe('sending');
    await act(async () => {
      release(ok('m', 1));
    });
    expect(view.result.current.pending).toEqual([]);
  });

  it('밀어서 보낸 답글의 실패 행도 대화 목록에 서므로(#4888) 단추가 센 수대로 함께 보낸다: 글은 글 길로, 답글은 같은 키·같은 뿌리로 답글 길로', async () => {
    const reply = jest.mocked(sendThreadReply);
    reply.mockReset();
    reply.mockRejectedValue(new NetworkError('unreachable', 15_000));
    const view = hook();
    await act(async () => {
      await view.result.current.send('채널 글');
    });
    await act(async () => {
      await view.result.current.sendReply('root-1', '답글');
    });
    // 목록이 그리는 행 둘(밀어서 보낸 답글은 실패하면 목록에도 선다)이고 단추도 둘로 센다.
    const offer = resendAllOffer(view.result.current.pending);
    expect(offer?.count).toBe(2);
    const channelKey = keysOf()[0];
    const replyKey = reply.mock.calls[0][3];

    send.mockReset();
    send.mockImplementation(async (_ws, _ch, clientMsgId) => ok(`${clientMsgId}`, 1));
    reply.mockReset();
    reply.mockImplementation(async (_ws, _ch, _root, clientMsgId) => ok(`${clientMsgId}`, 2));
    await act(async () => {
      await view.result.current.resendAll();
    });
    // 센 수와 보낸 수가 같다: 글 하나는 글 길로, 답글 하나는 답글 길로, 둘 다 처음 키 그대로 한 번씩.
    expect(keysOf()).toEqual([channelKey]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0].slice(2, 4)).toEqual(['root-1', replyKey]);
  });
});
