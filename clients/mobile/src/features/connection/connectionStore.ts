import type {ConnectionEvent} from '@momo/core/features/connection/model';
import {
  eventAction,
  initialConnectionState,
  nextWakeAt,
  reduceConnection,
  tickAction,
  visibilityAction,
  type ConnectionAction,
  type ConnectionState,
} from '@momo/core/features/connection/screenState';

// =============================================================================
// 연결 상태 모델을 담는 작은 저장소 (#5222, #5201 S-D).
//
// 코어 리듀서(`reduceConnection`)는 순수하다. 이 저장소가 더하는 것은 둘뿐이다.
//   1. 상태를 들고 바뀌면 구독자를 부른다(React 는 `useSyncExternalStore` 로 읽는다).
//   2. **시간으로 바뀌는 판정**(침묵 → 「연결 중」 → 「끊김」, 복구 표시 끝)이 오는 시각에 한 번 깨운다.
//
// 깨움 시계를 React 효과가 아니라 **저장소가 사건을 먹는 그 자리**에서 건다. 효과는 화면이 그려진 뒤에야 돌므로, 판정이 두 번 이어서
// 바뀌는 길(1초 뒤 「연결 중」, 거기서 다시 10초 뒤 「끊김」)이 렌더 사이를 기다리게 된다 - 렌더가 밀리는 순간(무거운 화면, 가짜 시계 시험)
// 에 다음 시계가 걸리지 못한다. 여기서는 한 시계가 울려 상태가 바뀌는 즉시 다음 시계를 건다.
//
// 타이머는 **모델의 시각 차**로 건다: 다음 깨움 시각(`wake`)에서 이 상태를 만든 행동의 시각(`clockAt`)을 뺀 만큼이다. 타이머가 울려 상태가
// 바뀌면 `clockAt` 은 방금 깬 `wake` 라서 이어지는 시계들의 합이 처음 사건에서 마지막 문턱까지의 시간과 같다. `Date.now()` 로 남은 시간을 다시
// 되재지 않는다 - 타이머 시계와 `Date.now()` 가 어긋나는 곳(절전에서 돌아온 직후, 시험의 가짜 타이머)에서도 약속이 그대로 지켜진다.
// 깨어난 시각은 **`wake` 이상**이다(타이머가 조금 일찍 깨도 「이 시각에 판정이 바뀐다」는 약속은 그대로다).
// =============================================================================

export interface ConnectionStore {
  getSnapshot(): ConnectionState;
  subscribe(listener: () => void): () => void;
  /** 사건 하나를 일어난 순간의 시각을 찍어 먹인다. */
  emit(make: (at: number) => ConnectionEvent | null): void;
  /**
   * 깨움 시계를 켠다. 마운트 효과가 부르고, 언마운트(또는 개발 모드의 효과 재실행)에서 `stop` 이 거둔다. 둘은 짝이라 여러 번 돌아도
   * 상태를 잃지 않는다.
   */
  start(): void;
  /** 깨움 시계를 거둔다. 상태와 구독은 그대로다. */
  stop(): void;
  /**
   * 앱이 뒤로 갔다(`false`)/앞으로 돌아왔다(`true`) (#5403). 뒤에 가 있던 시간은 화면을 보는 사람이 없던 시간이라, 돌아온 순간 소켓이 붙어
   * 있지 않으면 틈을 새 침묵으로 다시 시작하고 그동안 쌓인 「끊김이 보였다」 기억·복구 표시를 남기지 않는다. 이미 앞에 있는데 `true` 가 오면
   * (`inactive` → `active`) 아무것도 다시 시작하지 않고 **지금 시각으로 판정만 한 번 다시 한다** - 멈춘 깨움 시계가 낡은 복구 표시를 남기지
   * 않게(보내기 같은 다음 사건을 기다리지 않는다).
   */
  setVisible(visible: boolean): void;
}

export function createConnectionStore(
  initialOnline: boolean | null,
  now: () => number = Date.now,
): ConnectionStore {
  let state: ConnectionState = initialConnectionState(now(), initialOnline);
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  /** 지금 상태를 만든 행동의 시각. 다음 깨움까지의 시간을 이것에서 잰다. */
  let clockAt = now();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    clearTimer();
    if (!active) return;
    const wake = nextWakeAt(state);
    if (wake === null) return;
    timer = setTimeout(() => {
      timer = null;
      dispatch(tickAction(Math.max(now(), wake)));
    }, Math.max(0, wake - clockAt));
  }

  function dispatch(action: ConnectionAction): void {
    const next = reduceConnection(state, action);
    if (next === state) return;
    state = next;
    clockAt = action.at;
    arm();
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(make) {
      const at = now();
      const event = make(at);
      if (event !== null) dispatch(eventAction(at, event));
    },
    start() {
      active = true;
      clockAt = now();
      arm();
    },
    stop() {
      active = false;
      clearTimer();
    },
    setVisible(visible) {
      dispatch(visibilityAction(now(), visible));
    },
  };
}
