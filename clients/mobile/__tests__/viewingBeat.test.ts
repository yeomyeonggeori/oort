import {act, renderHook} from '@testing-library/react-native';
import {AppState} from 'react-native';

import {resetViewingBeatForTests} from '@momo/core/features/readState/viewingBeat';
import {ApiError, touchChannelViewing} from '@momo/core/lib/api';
import {useAppForeground, useViewingBeat} from '../src/features/readState/useViewingBeat';

// =============================================================================
// 폰의 「보고 있음」 존재 신호 (#4063, ADR-0204 증보 3).
// 앱이 'active' 인 동안만 15초 주기로 보내고, 백그라운드·inactive 에서는 타이머가
// 멈춘다. 옛 서버(404)는 조용히 멈춘다. 주기·멈춤 규칙 본체는 core 시험이 잰다.
// 여기서는 AppState 어댑터와 훅의 마운트·해제 배선만 잰다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {...actual, touchChannelViewing: jest.fn()};
});

const mockSend = jest.mocked(touchChannelViewing);
const WS = '11111111-1111-4111-8111-111111111111';
const CH = '33333333-3333-4333-8333-333333333333';

let appStateHandler: ((next: string) => void) | null = null;
let currentState = 'active';

beforeEach(() => {
  jest.useFakeTimers();
  resetViewingBeatForTests();
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
  currentState = 'active';
  appStateHandler = null;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => currentState,
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (next: string) => void,
  ) => {
    appStateHandler = handler;
    return {
      remove: () => {
        appStateHandler = null;
      },
    };
  }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function goTo(next: string) {
  currentState = next;
  act(() => appStateHandler?.(next));
}

describe('폰 보고 있음 신호', () => {
  it('화면이 앞에 있는 동안 15초마다 보내고, 백그라운드로 가면 멈춘다', async () => {
    renderHook(() => useViewingBeat(WS, CH));
    expect(mockSend).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(2);

    goTo('background');
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(2);

    goTo('active');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('inactive(알림 센터·전화)에서도 멈춘다', async () => {
    renderHook(() => useViewingBeat(WS, CH));
    goTo('inactive');
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('화면을 떠나면(언마운트) 멈추고 구독을 푼다', async () => {
    const {unmount} = renderHook(() => useViewingBeat(WS, CH));
    unmount();
    expect(appStateHandler).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('같은 채널 화면이 두 번 마운트돼도 타이머는 하나다', async () => {
    renderHook(() => useViewingBeat(WS, CH));
    renderHook(() => useViewingBeat(WS, CH));
    expect(mockSend).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    // 타이머가 둘이면 주기마다 두 번 보낸다.
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('옛 서버(404)는 조용히 멈추고 다시 시도하지 않는다', async () => {
    mockSend.mockRejectedValue(new ApiError(404, 'nf'));
    renderHook(() => useViewingBeat(WS, CH));
    // 주기마다 응답이 정산되도록 한 칸씩 간다(한꺼번에 가면 진행 중 표시가 안 풀려 헛돈다).
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {});
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
    }
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('useAppForeground (#5032)', () => {
  it('스레드가 열려 있을 때만(enabled) 앱 앞뒤를 따라간다 — 꺼 두면 구독이 없고 늘 앞이며, 다시 켤 때 낡은 값이 먼저 읽히지 않는다', () => {
    const seen: boolean[] = [];
    const {result, rerender} = renderHook(
      ({on}: {on: boolean}) => {
        const value = useAppForeground(on);
        seen.push(value);
        return value;
      },
      {initialProps: {on: false}},
    );
    expect(appStateHandler).toBeNull();
    expect(result.current).toBe(true);
    // 앱이 뒤에 있는 채 켠다(알림에서 스레드가 열린다): 켜는 순간의 값으로 맞춘다.
    currentState = 'background';
    rerender({on: true});
    expect(appStateHandler).not.toBeNull();
    expect(result.current).toBe(false);
    goTo('active');
    expect(result.current).toBe(true);
    // 끄면 구독을 풀고 늘 앞이다. 꺼 둔 동안 뒤로 갔던 값이 다음에 켜는 첫 그림에 새어 나오지 않는다.
    goTo('background');
    rerender({on: false});
    expect(appStateHandler).toBeNull();
    expect(result.current).toBe(true);
    currentState = 'active';
    const before = seen.length;
    rerender({on: true});
    expect(seen[before]).toBe(true);
    expect(result.current).toBe(true);
  });
});
