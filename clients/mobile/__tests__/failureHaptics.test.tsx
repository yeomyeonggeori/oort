import React from 'react';
import {AppState} from 'react-native';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react-native';
import {sendMessage, sendThreadReply, type Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import '../src/boot/polyfills';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {__resetHapticClockForTests, setHapticMode, type HapticMode} from '../src/lib/haptics';

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
}));

// Keep the real haptics module: these assertions count native requests, including
// shared mode, debounce and scope policy, rather than spying on an error wrapper.
const nativeCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;
const directory = makeDirectory([]);
const message: Message = {
  id: 'message', channelId: 'channel', authorMemberId: 'self',
  seq: 1, hlcTs: 1, hlcCount: 0, type: 'text', body: '안녕',
  state: 'sent', createdAtMs: 0,
};

function deferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
  return {promise, reject};
}

function row(onToggleReaction: MessageRowActions['onToggleReaction'], mine = false, id = message.id) {
  return <MessageRow message={{...message, id}} startsGroup directory={directory}
    chips={[{emoji: '👍', count: 1, mine}]} nowMs={0}
    actions={{myMemberId: 'self', onToggleReaction, onEdit: jest.fn(), onDelete: jest.fn()}} />;
}

async function fail(request: ReturnType<typeof deferred>, delay = 500) {
  await act(async () => {
    jest.advanceTimersByTime(delay);
    request.reject(new Error('request failed'));
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetHapticClockForTests();
  setHapticMode('rich');
  AppState.currentState = 'active';
  nativeCalls.length = 0;
  jest.mocked(sendMessage).mockReset();
  jest.mocked(sendThreadReply).mockReset();
});

afterEach(() => {
  cleanup();
  setHapticMode('rich');
  AppState.currentState = 'active';
  jest.useRealTimers();
});

describe('반응 실패 햅틱 (#4298 High 2)', () => {
  it.each<[HapticMode, boolean]>([
    ['rich', false], ['rich', true], ['basic', false], ['basic', true],
    ['off', false], ['off', true],
  ])('%s 모드, mine=%s: 달기·빼기 500ms 실패에서 error를 한 번 요청한다', async (mode, mine) => {
    setHapticMode(mode);
    const request = deferred();
    const toggle = jest.fn(() => request.promise);
    render(row(toggle, mine));
    fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledWith(message, '👍');
    expect(nativeCalls).toEqual(mode === 'off' ? [] : ['selection']);
    await fail(request);
    expect(screen.getByTestId('message-action-error')).toBeTruthy();
    expect(nativeCalls).toEqual(mode === 'off' ? [] : ['selection', 'notification:error']);
  });

  it.each([99, 100])('선택 뒤 %ims 실패는 공통 0.1초 경계를 따른다', async delay => {
    const request = deferred();
    render(row(() => request.promise));
    fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    await fail(request, delay);
    expect(nativeCalls).toEqual(delay < 100 ? ['selection'] : ['selection', 'notification:error']);
  });

  it.each(['unmount', 'return', 'background'])('%s: 화면 이탈 뒤 늦은 반응 실패는 무음이다', async departure => {
    const request = deferred();
    const toggle = () => request.promise;
    const view = render(row(toggle));
    fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    if (departure === 'unmount') view.unmount();
    if (departure === 'return') {
      view.rerender(row(toggle, false, 'other'));
      view.rerender(row(toggle));
    }
    if (departure === 'background') AppState.currentState = 'background';
    await fail(request);
    expect(nativeCalls).toEqual(['selection']);
  });
});

describe('보내기 실패 햅틱 (#4298 High 2)', () => {
  it.each<HapticMode>(['rich', 'basic', 'off'])('%s: 보내기·재시도·답글 실패마다 error 한 번이다', async mode => {
    setHapticMode(mode);
    const view = renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
    const send = deferred();
    jest.mocked(sendMessage).mockReturnValueOnce(send.promise);
    let sending!: Promise<void>;
    act(() => { sending = view.result.current.send('안녕'); });
    expect(nativeCalls).toEqual([]);
    await fail(send);
    await sending;
    expect(view.result.current.pending[0].status).toBe('failed');
    expect(nativeCalls).toEqual(mode === 'off' ? [] : ['notification:error']);

    const retry = deferred();
    jest.mocked(sendMessage).mockReturnValueOnce(retry.promise);
    act(() => { sending = view.result.current.resend(view.result.current.pending[0].clientMsgId); });
    await fail(retry);
    await sending;
    expect(jest.mocked(sendMessage).mock.calls[1][2]).toBe(jest.mocked(sendMessage).mock.calls[0][2]);

    const reply = deferred();
    jest.mocked(sendThreadReply).mockReturnValueOnce(reply.promise);
    act(() => { sending = view.result.current.sendReply('root', '답글'); });
    await fail(reply);
    await sending;
    expect(view.result.current.pending.every(p => p.status === 'failed')).toBe(true);
    expect(nativeCalls).toEqual(mode === 'off' ? [] : Array(3).fill('notification:error'));
  });

  it.each(['unmount', 'return', 'workspace', 'background'])('%s: 화면 이탈 뒤 늦은 보내기 실패는 무음이다', async departure => {
    const request = deferred();
    jest.mocked(sendMessage).mockReturnValueOnce(request.promise);
    const view = renderHook(({workspace, channel}: {workspace: string; channel: string}) => useTimeline(null, workspace, channel, 'self'), {
      initialProps: {workspace: 'workspace', channel: 'channel'},
    });
    let sending!: Promise<void>;
    act(() => { sending = view.result.current.send('안녕'); });
    if (departure === 'unmount') view.unmount();
    if (departure === 'return') {
      view.rerender({workspace: 'workspace', channel: 'other'});
      view.rerender({workspace: 'workspace', channel: 'channel'});
    }
    if (departure === 'workspace') view.rerender({workspace: 'other', channel: 'channel'});
    if (departure === 'background') AppState.currentState = 'background';
    await fail(request);
    await sending;
    expect(nativeCalls).toEqual([]);
  });

  it('동시에 실패한 보내기 두 건도 공통 0.1초 창에서 한 번만 울린다', async () => {
    const request = deferred();
    jest.mocked(sendMessage).mockReturnValue(request.promise);
    const {result} = renderHook(() => useTimeline(null, 'workspace', 'channel', 'self'));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.send('하나');
      second = result.current.send('둘');
    });
    await fail(request);
    await Promise.all([first, second]);
    expect(result.current.pending.map(p => p.status)).toEqual(['failed', 'failed']);
    expect(nativeCalls).toEqual(['notification:error']);
  });
});
