import {act, cleanup, renderHook} from '@testing-library/react-native';
import {FIXTURE_EXPRESSIONS} from '@momo/core/features/expressions/fixtures';
import type {MessageAttachment} from '@momo/core/lib/api';
import {sendMessage, type Message} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';

import '../src/boot/polyfills';
import {useTimeline} from '../src/features/conversation/useTimeline';

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
}));
jest.mock('../src/features/conversation/failedSends', () => ({
  forgetFailedSend: jest.fn(),
  readFailedSends: jest.fn(() => []),
  rememberFailedSend: jest.fn(),
}));

// =============================================================================
// 이모티콘과 글을 한 번에 보내는 묶음 — 폰 `useTimeline` (#5452, 웹 #5453 과 같은 와이어).
//
//   · 와이어는 **큰 표현 메시지(`:이름:` 하나) → 글 메시지** 둘이고, 메시지마다 다른 `client_msg_id` 다.
//   · 첫째가 확정되기 전에는 둘째가 나가지 않는다. 첫째가 실패하면 둘째는 요청 없이 실패한 행으로 남는다(글을 잃지 않는다).
//   · 다시 보내기는 어느 행에서 눌러도 첫째부터 같은 id 로 나간다(서버가 이미 받은 것은 그대로 돌려준다).
//   · 인용·첨부·링크 미리보기 끄기는 마지막 메시지(글)가 나른다.
// 순서 문 자체(`bundleMayPost`·`postBundleInOrder`)는 코어 시험이 재고, 이 시험은 폰 훅이 그 문을 **모든 길**(처음·다시·모두 다시)에 지나게 했는지를 값으로 잰다.
// =============================================================================

const send = jest.mocked(sendMessage);
const THUMBS = FIXTURE_EXPRESSIONS[2];
const message = (id: string, seq: number): Message =>
  ({id, channelId: 'channel', seq, hlcTs: seq, hlcCount: 0, authorMemberId: 'self', type: 'text', body: id, state: 'sent', createdAtMs: seq}) as Message;
const hook = () => renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
const calls = () => send.mock.calls.map(call => ({id: String(call[2]), body: String(call[3]), options: call[4] as Record<string, unknown> | undefined}));

afterEach(cleanup);
beforeEach(() => {
  send.mockReset();
});

describe('보내기 한 번 = 표현 메시지 → 글 메시지', () => {
  it('둘째는 첫째가 확정된 뒤에야 나간다 - 요청 순서는 `[:이름:, 글]`, id 는 서로 다르다', async () => {
    const view = hook();
    let confirmFirst: (m: Message) => void = () => undefined;
    send.mockReturnValueOnce(new Promise<Message>(done => (confirmFirst = done)));
    send.mockImplementation(async (_ws, _ch, id) => message(String(id), 2));
    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = view.result.current.send('안녕하세요', undefined, undefined, undefined, {expression: THUMBS});
    });
    // 보내자마자 행이 둘 서고(보내는 중), 둘째는 첫째 뒤에 매여 있다. 요청은 첫째 하나뿐이다.
    const rows = view.result.current.pending;
    expect(rows.map(row => [row.body, row.status])).toEqual([[':thumbs_up:', 'sending'], ['안녕하세요', 'sending']]);
    expect(rows[1].after).toBe(rows[0].clientMsgId);
    expect(rows[0].after).toBeUndefined();
    expect(rows[0].clientMsgId).not.toBe(rows[1].clientMsgId);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body).toBe(':thumbs_up:');
    // 첫째가 확정되면 둘째가 이어서 나간다.
    await act(async () => {
      confirmFirst(message(rows[0].clientMsgId, 1));
      await sending;
    });
    expect(calls().map(call => call.body)).toEqual([':thumbs_up:', '안녕하세요']);
    expect(calls().map(call => call.id)).toEqual([rows[0].clientMsgId, rows[1].clientMsgId]);
    expect(view.result.current.pending).toEqual([]);
  });

  it('글이 없으면 표현 메시지 하나다 · 표현이 없으면 예전과 같은 메시지 하나다(묶음이 아니다)', async () => {
    const view = hook();
    send.mockImplementation(async (_ws, _ch, id) => message(String(id), 1));
    await act(async () => {
      await view.result.current.send('', undefined, undefined, undefined, {expression: THUMBS});
    });
    expect(calls().map(call => call.body)).toEqual([':thumbs_up:']);
    send.mockClear();
    await act(async () => {
      await view.result.current.send('그냥 글');
    });
    expect(calls().map(call => call.body)).toEqual(['그냥 글']);
    expect(view.result.current.pending).toEqual([]);
  });

  it('인용·첨부·링크 미리보기 끄기는 마지막 메시지(글)만 나른다 - 표현 메시지는 `:이름:` 하나뿐이다', async () => {
    const view = hook();
    send.mockImplementation(async (_ws, _ch, id) => message(String(id), 1));
    const file = {id: 'att-1', name: 'a.png', mime: 'image/png', sizeBytes: 1} as MessageAttachment;
    await act(async () => {
      await view.result.current.send('사진도', 'quote-1', [file], undefined, {expression: THUMBS, suppressUnfurl: true});
    });
    const [first, second] = calls();
    expect(first.body).toBe(':thumbs_up:');
    expect(first.options ?? {}).toEqual({});
    expect(second.body).toBe('사진도');
    expect(second.options).toEqual({replyToId: 'quote-1', attachmentIds: ['att-1'], suppressUnfurl: true});
  });
});

describe('첫 메시지가 실패하면', () => {
  async function failHead(view: ReturnType<typeof hook>) {
    send.mockRejectedValueOnce(new NetworkError('unreachable', 15_000));
    await act(async () => {
      await view.result.current.send('글도 보낼래요', undefined, undefined, undefined, {expression: THUMBS});
    });
  }

  it('둘째는 요청 없이 실패한 행으로 남는다 - 글을 잃지 않는다', async () => {
    const view = hook();
    await failHead(view);
    expect(calls()).toHaveLength(1);
    expect(view.result.current.pending.map(row => [row.body, row.status])).toEqual([
      [':thumbs_up:', 'failed'],
      ['글도 보낼래요', 'failed'],
    ]);
  });

  it('둘째 행에서 다시 보내도 첫째부터 같은 id 로 나가고, 끝나면 둘 다 정리된다', async () => {
    const view = hook();
    await failHead(view);
    const [head, tail] = view.result.current.pending;
    send.mockReset();
    send.mockImplementation(async (_ws, _ch, id) => message(String(id), 1));
    await act(async () => {
      await view.result.current.resend(tail.clientMsgId);
    });
    expect(calls().map(call => [call.id, call.body])).toEqual([
      [head.clientMsgId, ':thumbs_up:'],
      [tail.clientMsgId, '글도 보낼래요'],
    ]);
    expect(view.result.current.pending).toEqual([]);
  });

  it('「모두 다시 보내기」도 묶음의 앞 메시지 차례에 뒤 메시지를 보낸다 - 한 번씩만, 앞지르지 않는다', async () => {
    const view = hook();
    await failHead(view);
    const [head, tail] = view.result.current.pending;
    send.mockReset();
    send.mockImplementation(async (_ws, _ch, id) => message(String(id), 1));
    await act(async () => {
      await view.result.current.resendAll();
    });
    expect(calls().map(call => call.id)).toEqual([head.clientMsgId, tail.clientMsgId]);
    expect(view.result.current.pending).toEqual([]);
  });

  it('다시 보내도 또 실패하면 둘째는 여전히 나가지 않는다', async () => {
    const view = hook();
    await failHead(view);
    const [, tail] = view.result.current.pending;
    send.mockReset();
    send.mockRejectedValue(new NetworkError('unreachable', 15_000));
    await act(async () => {
      await view.result.current.resend(tail.clientMsgId);
    });
    expect(calls()).toHaveLength(1); // 머리 하나만 다시 나갔다
    expect(view.result.current.pending.map(row => row.status)).toEqual(['failed', 'failed']);
  });
});
