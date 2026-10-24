import {act, renderHook} from '@testing-library/react-native';
import {AccessibilityInfo} from 'react-native';

import {
  retainReduceMotion,
  useReduceMotion,
  useReduceMotionRef,
  useRetainReduceMotion,
} from '../src/lib/useReduceMotion';

// =============================================================================
// 「동작 줄이기」 앱 수준 저장소 (#4293, design-review r2 M-1).
//
// 뷰어 Modal 은 열릴 때마다 새로 마운트되고, 첫 렌더의 `animationType` 으로 이미 떠 버린다. 훅이 마운트
// 때마다 시스템에 새로 물으면 답은 한 틱 뒤에 오므로 새로 선 화면은 언제나 모르는 채로 시작한다 —
// 동작 줄이기를 켠 사람이 열 때마다 시스템 페이드를 본다. 그래서 앱이 **한 번 읽어 간직하고 변경을
// 구독**하고, 새로 마운트된 화면은 그 값으로 시작한다. 이 파일은 그 저장소의 약속을 재생한다:
//   · 소비자가 몇이든 시스템에는 한 번만 묻고 한 번만 구독한다
//   · 이미 아는 값이 있으면 **첫 렌더부터** 그 값이다(모를 때만 `whileUnknown`)
//   · 변경 알림은 마운트된 소비자와 이후 소비자 모두에게 간다
//   · 붙드는 쪽이 없으면 구독을 풀고 값을 버린다 / 앱이 붙들고 있으면 소비자가 모두 내려가도 남는다
// =============================================================================

type Listener = (value: boolean) => void;

let answer: (value: boolean) => void;
let listeners: Listener[];
let removes: jest.Mock[];
let read: jest.SpyInstance;
let subscribe: jest.SpyInstance;
/** 시험이 붙든 것. 단정이 실패해도 새지 않게 끝에 모두 놓는다(저장소는 모듈 상태라 시험 사이로 샌다). */
let held: Array<() => void>;

/** 앱이 시작 때 하는 일(`App.tsx`): 저장소를 붙든다. */
function hold(): () => void {
  const release = retainReduceMotion();
  held.push(release);
  return release;
}

beforeEach(() => {
  listeners = [];
  removes = [];
  held = [];
  // RN 의 jest 대역은 이미 `jest.fn` 이라 `spyOn` 이 같은 함수를 돌려주고, 호출 기록이 시험 사이로 쌓인다.
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockClear();
  jest.mocked(AccessibilityInfo.addEventListener).mockClear();
  read = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(
    () =>
      new Promise<boolean>(resolve => {
        answer = resolve; // 시스템의 답을 시험이 늦게 준다
      }),
  );
  subscribe = jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _event: string,
    listener: Listener,
  ) => {
    listeners.push(listener);
    const remove = jest.fn();
    removes.push(remove);
    return {remove};
  }) as never);
});

afterEach(() => {
  for (const release of held) release();
  jest.restoreAllMocks();
});

/** 첫 렌더에 훅이 돌려준 값을 함께 돌려주는 마운트. */
function mountState(whileUnknown?: boolean) {
  const seen: boolean[] = [];
  const view = renderHook(() => {
    const value = useReduceMotion(whileUnknown);
    seen.push(value);
    return value;
  });
  return {...view, first: seen[0]};
}

describe('한 번 읽고 한 번 구독한다', () => {
  it('소비자가 둘이어도 시스템에는 한 번만 묻고 한 번만 구독한다', () => {
    mountState();
    mountState(false);
    mountRef();
    expect(read).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]?.[0]).toBe('reduceMotionChanged');
  });

  it('답이 오기 전에는 소비자마다 자기 `whileUnknown` 이다', () => {
    expect(mountState().first).toBe(true); // 기본: 모르면 줄인다(끝없이 도는 움직임)
    expect(mountState(false).first).toBe(false); // 한 번 서는 화면은 모르면 평소대로
  });

  it('답이 오면 마운트된 소비자 모두가 그 값이 된다', async () => {
    const a = mountState();
    const b = mountState(false);
    await act(async () => answer(true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
  });

  it('읽기가 실패하면 모름으로 남는다 — 지어내지 않는다', async () => {
    read.mockImplementation(() => Promise.reject(new Error('unavailable')));
    const a = mountState(false);
    await act(async () => {});
    expect(a.result.current).toBe(false);
  });
});

describe('새로 마운트된 소비자는 아는 상태로 시작한다 (M-1)', () => {
  it('앱이 이미 아는 값으로 첫 렌더부터 시작한다 — 답을 다시 기다리지 않는다', async () => {
    const app = hold(); // 앱이 시작 때 붙든다
    await act(async () => answer(true));
    // 뷰어처럼 `whileUnknown=false` 로 쓰는 소비자도, 기본값으로 쓰는 소비자도 첫 렌더가 아는 값이다.
    expect(mountState(false).first).toBe(true);
    expect(mountState().first).toBe(true);
    app();
  });

  it('아는 값이 꺼짐이면 첫 렌더부터 꺼짐이다 — 모를 때의 기본(켜짐)이 새지 않는다', async () => {
    const app = hold();
    await act(async () => answer(false));
    expect(mountState().first).toBe(false);
    app();
  });

  it('소비자가 모두 내려가도 앱이 붙들고 있으면 값이 남는다', async () => {
    const app = hold();
    const early = mountState(false);
    await act(async () => answer(true));
    early.unmount();
    expect(removes[0]).not.toHaveBeenCalled(); // 구독도 살아 있다
    expect(mountState(false).first).toBe(true);
    expect(read).toHaveBeenCalledTimes(1); // 다시 묻지 않았다
    app();
  });
});

describe('변경을 구독한다', () => {
  it('설정이 바뀌면 마운트된 소비자가 따라가고, 이후에 마운트되는 소비자도 새 값으로 시작한다', async () => {
    const app = hold();
    const a = mountState(false);
    await act(async () => answer(false));
    expect(a.result.current).toBe(false);

    act(() => listeners[0]?.(true));
    expect(a.result.current).toBe(true);
    expect(mountState(false).first).toBe(true);

    act(() => listeners[0]?.(false));
    expect(a.result.current).toBe(false);
    expect(mountState(false).first).toBe(false);
    app();
  });

  it('변경 알림이 읽기의 답보다 먼저 오면 알림이 이긴다 — 더 새 값이다', async () => {
    const a = mountState(false);
    act(() => listeners[0]?.(true));
    await act(async () => answer(false)); // 늦게 도착한 옛 답
    expect(a.result.current).toBe(true);
  });
});

describe('붙드는 쪽이 없으면 구독을 풀고 값을 버린다', () => {
  it('마지막 소비자가 내려가면 구독을 풀고, 다음 소비자는 새로 읽는다', async () => {
    const a = mountState(false);
    await act(async () => answer(true));
    a.unmount();
    expect(removes[0]).toHaveBeenCalledTimes(1);

    const b = mountState(false);
    expect(b.first).toBe(false); // 버렸으므로 모른다
    expect(read).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('내려간 저장소의 늦은 답은 새 저장소를 덮지 않는다', async () => {
    const a = mountState(false);
    const staleAnswer = answer;
    a.unmount();
    const b = mountState(false);
    const freshAnswer = answer;
    await act(async () => freshAnswer(true));
    await act(async () => staleAnswer(false));
    expect(b.result.current).toBe(true);
  });

  it('붙든 것을 놓는 함수는 여러 번 불러도 한 번만 놓인다', async () => {
    const app = hold();
    const other = hold();
    app();
    app(); // 두 번째는 아무 일도 아니다 — `other` 의 몫을 놓지 않는다
    expect(removes[0]).not.toHaveBeenCalled();
    other();
    expect(removes[0]).toHaveBeenCalledTimes(1);
  });
});

describe('앱의 뿌리가 붙든다 (`App.tsx` 의 `useRetainReduceMotion`)', () => {
  it('뿌리가 마운트되어 있는 동안, 다른 소비자가 모두 내려가도 값이 남는다', async () => {
    const root = renderHook(() => useRetainReduceMotion());
    const early = mountState(false);
    await act(async () => answer(true));
    early.unmount();
    expect(removes[0]).not.toHaveBeenCalled();
    expect(mountState(false).first).toBe(true); // 뒤늦게 열린 화면이 아는 상태로 시작한다
    expect(read).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('뿌리가 내려가면 놓는다 — 붙든 쪽이 없으면 구독을 푼다', () => {
    const root = renderHook(() => useRetainReduceMotion());
    expect(subscribe).toHaveBeenCalledTimes(1);
    root.unmount();
    expect(removes[0]).toHaveBeenCalledTimes(1);
  });
});

describe('ref 판', () => {
  it('답이 오기 전에는 false, 오면 그 값, 알림이 오면 그 값을 따른다', async () => {
    const view = renderHook(() => useReduceMotionRef());
    expect(view.result.current.current).toBe(false);
    await act(async () => answer(true));
    expect(view.result.current.current).toBe(true);
    act(() => listeners[0]?.(false));
    expect(view.result.current.current).toBe(false);
  });

  it('앱이 이미 아는 값이 있으면 처음부터 그 값이다', async () => {
    const app = hold();
    await act(async () => answer(true));
    const view = renderHook(() => useReduceMotionRef());
    expect(view.result.current.current).toBe(true);
    app();
  });
});

function mountRef() {
  return renderHook(() => useReduceMotionRef());
}
