import {
  deviceEvent,
  endedSocketEvent,
  resumeEvent,
  socketEvent,
} from '@momo/core/features/connection/screenState';
import {
  DISPLAY_GRACE_MS,
  HEALED_MS,
} from '@momo/core/features/connection/thresholds';

import {connectionEventOf} from '../src/features/connection/connectionEvents';
import {createConnectionStore} from '../src/features/connection/connectionStore';

// =============================================================================
// 연결 상태 저장소 (#5222, #5201 S-D): 사건을 먹이고, 시간으로 바뀌는 판정을 한 시계가 깨운다.
// 숫자는 상수가 아니라 글자 그대로(1_000, 10_000, 2_000) 단정한다 - 상수를 깨뜨려도 같이 움직여 초록으로 남는 일이 없게.
// =============================================================================

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const T0 = 1_700_000_000_000;

/** 오래 건강한 소켓: 틈이 풀려 있어 다음 끊김이 새 틈이다. */
function healthyStore(now: () => number) {
  const store = createConnectionStore(true, now);
  store.start();
  store.emit(at => socketEvent(at, 'connected'));
  return store;
}

describe('깨움 시계: 침묵 → 연결 중 → 끊김이 시계 하나씩 이어서 걸린다', () => {
  it('끊김 → 1초에 「연결 중」 → 10초에 「끊김」, 시계는 언제나 하나뿐이다', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);
    const phases: string[] = [];
    store.subscribe(() => phases.push(store.getSnapshot().view.phase));

    store.emit(at => socketEvent(at, 'connecting'));
    expect(store.getSnapshot().view.phase).toBe('quiet');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(999);
    expect(store.getSnapshot().view.phase).toBe('quiet');
    jest.advanceTimersByTime(1);
    expect(store.getSnapshot().view.phase).toBe('connecting');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(8_999);
    expect(store.getSnapshot().view.phase).toBe('connecting');
    jest.advanceTimersByTime(1);
    expect(store.getSnapshot().view.phase).toBe('down');
    expect(store.getSnapshot().view.cause).toBe('realtimeDown');
    // 더 걸 시계가 없다 - 「끊김」은 사건이 와야 바뀐다.
    expect(jest.getTimerCount()).toBe(0);
    // 구독자는 바뀐 때마다 한 번씩만 불렸다(침묵 → 연결 중 → 끊김).
    expect(phases).toEqual(['quiet', 'connecting', 'down']);
    store.stop();
  });

  it('타이머 시계와 Date.now() 가 어긋나도(절전 직후 · 시험의 가짜 타이머) 문턱은 10초 안에 이어진다', () => {
    // 시계를 얼린 `now`: 가상 시간은 흘러도 Date.now() 는 안 움직인다. 남은 시간을 `wake - Date.now()` 로 되재는 고리는 이 위에서 두 번째
    // 시계를 첫 시계의 길이만큼 늦게 걸어 10초를 넘긴다. 모델의 시각 차로 걸면 합이 정확히 10초다.
    const frozen = () => T0;
    const store = healthyStore(frozen);
    store.emit(at => socketEvent(at, 'connecting'));
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    expect(store.getSnapshot().view.phase).toBe('down');
    store.stop();
  });

  it('복구 표시도 시계가 거둔다: 끊김이 보였다 돌아오면 2초 뒤 걷히고, 연결 중만 보였다면 표시가 없다', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);

    // 연결 중만 보였던 틈: 말없이 사라진다.
    store.emit(at => socketEvent(at, 'connecting'));
    jest.advanceTimersByTime(1_500);
    expect(store.getSnapshot().view.phase).toBe('connecting');
    store.emit(at => socketEvent(at, 'connected'));
    expect(store.getSnapshot().view.phase).toBe('ok');
    expect(store.getSnapshot().recoveredUntil).toBeNull();
    jest.advanceTimersByTime(HEALED_MS + 100);

    // 끊김이 보였던 틈: 2초.
    store.emit(at => socketEvent(at, 'connecting'));
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    expect(store.getSnapshot().view.phase).toBe('down');
    store.emit(at => socketEvent(at, 'connected'));
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    jest.advanceTimersByTime(1_999);
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    jest.advanceTimersByTime(1);
    expect(store.getSnapshot().recoveredUntil).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    store.stop();
  });
});

describe('#5403 — 사람이 보지 못한 시간과 늦은 깨움', () => {
  it('앱이 뒤에 가 있는 동안 멈췄다 늦게 깨는 시계는 끊김으로 치지 않는다: 돌아와 붙으면 복구 표시가 없다', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);
    store.emit(at => socketEvent(at, 'connecting'));
    store.setVisible(false);
    // JS 가 멈춘 채 5분이 흐른다: 시계는 시각이 훌쩍 지난 뒤에야 깬다.
    jest.setSystemTime(T0 + 300_000);
    jest.advanceTimersByTime(10_000);
    expect(store.getSnapshot().sawDown).toBe(false);
    store.setVisible(true);
    store.emit(at => connectionEventOf({kind: 'resume'}, at));
    // 돌아온 순간은 새 침묵 1초다(곧바로 「연결 중」이 서지 않는다).
    expect(store.getSnapshot().view.phase).toBe('quiet');
    jest.advanceTimersByTime(400);
    store.emit(at => socketEvent(at, 'connected'));
    expect(store.getSnapshot().view.phase).toBe('ok');
    expect(store.getSnapshot().recoveredUntil).toBeNull();
    jest.advanceTimersByTime(5_000);
    expect(store.getSnapshot().recoveredUntil).toBeNull();
    store.stop();
  });

  it('깨움 시계가 5분 늦게 울려도 한 번에 복구 표시를 거둔다 (보내기를 기다리지 않는다)', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);
    store.emit(at => socketEvent(at, 'connecting'));
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    store.emit(at => socketEvent(at, 'connected'));
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    // 시각만 5분 뛴다. 깨움은 울리지 않았다.
    jest.setSystemTime(Date.now() + 300_000);
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    jest.advanceTimersByTime(2_000);
    expect(store.getSnapshot().recoveredUntil).toBeNull();
    store.stop();
  });

  it('앞에 있던 채(inactive → active) 시계를 잃었어도 복귀 알림 한 번에 낡은 복구 표시가 거두어진다', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);
    store.emit(at => socketEvent(at, 'connecting'));
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    store.emit(at => socketEvent(at, 'connected'));
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    store.stop();
    jest.setSystemTime(Date.now() + 300_000);
    expect(store.getSnapshot().recoveredUntil).not.toBeNull();
    store.setVisible(true);
    expect(store.getSnapshot().recoveredUntil).toBeNull();
  });
});

describe('수명', () => {
  it('stop() 은 시계를 거두고 start() 는 상태를 잃지 않고 다시 건다 (개발 모드의 효과 재실행)', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    jest.advanceTimersByTime(HEALED_MS + 100);
    store.emit(at => socketEvent(at, 'connecting'));
    expect(jest.getTimerCount()).toBe(1);
    store.stop();
    expect(jest.getTimerCount()).toBe(0);
    store.start();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    expect(store.getSnapshot().view.phase).toBe('down');
    store.stop();
  });

  it('구독을 풀면 더는 부르지 않고, 알리지 않는 사건(null)은 상태를 바꾸지 않는다', () => {
    jest.setSystemTime(T0);
    const store = healthyStore(Date.now);
    const listener = jest.fn();
    const off = store.subscribe(listener);
    const before = store.getSnapshot();
    store.emit(() => null);
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    store.emit(at => deviceEvent(at, false));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.emit(at => deviceEvent(at, true));
    expect(listener).toHaveBeenCalledTimes(1);
    store.stop();
  });
});

describe('전송의 사건이 모델의 사건으로 바뀐다 (connectionEventOf)', () => {
  it('날것의 상태 · 다시 열기 · 끝남은 그대로 옮기고, 10초 마감의 결과(grace-expired)는 옮기지 않는다', () => {
    const at = T0;
    expect(connectionEventOf({kind: 'raw', status: 'connecting'}, at)).toEqual(
      socketEvent(at, 'connecting'),
    );
    expect(connectionEventOf({kind: 'raw', status: 'connected'}, at)).toEqual(
      socketEvent(at, 'connected'),
    );
    expect(connectionEventOf({kind: 'resume'}, at)).toEqual(resumeEvent(at));
    expect(connectionEventOf({kind: 'terminal'}, at)).toEqual(endedSocketEvent(at));
    expect(connectionEventOf({kind: 'terminal'}, at)).toMatchObject({
      status: 'disconnected',
      ended: true,
    });
    // 전송 안의 읽는 쪽 시계가 낸 결과다. 모델은 자기 시계(틈이 시작된 때부터)로 판정한다.
    expect(connectionEventOf({kind: 'grace-expired'}, at)).toBeNull();
  });
});
