import {
  createConnectionDisplay,
  DISPLAY_GRACE_MS,
} from '../src/realtime/connectionDisplay';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function drive() {
  const changes: RealtimeStatus[] = [];
  const display = createConnectionDisplay(status => changes.push(status));
  return {display, changes};
}

it('opening and reconnecting stay connecting for ten seconds; retries do not restart the deadline (#4783)', () => {
  expect(DISPLAY_GRACE_MS).toBe(10_000);
  const {display, changes} = drive();
  display.push({kind: 'raw', status: 'disconnected'});
  jest.advanceTimersByTime(9_999);
  expect(display.current()).toBe('connecting');
  display.push({kind: 'raw', status: 'connecting'});
  jest.advanceTimersByTime(1);
  expect(display.current()).toBe('disconnected');
  display.push({kind: 'raw', status: 'connecting'});
  jest.advanceTimersByTime(20_000);
  expect(changes).toEqual(['disconnected']);
  display.push({kind: 'raw', status: 'connected'});
  display.push({kind: 'raw', status: 'connecting'});
  expect(display.current()).toBe('connecting');
  jest.advanceTimersByTime(9_999);
  expect(display.current()).toBe('connecting');
  jest.advanceTimersByTime(1);
  expect(display.current()).toBe('disconnected');
  display.dispose();
});

it('foreground return resets a suspended deadline, including an already displayed outage', () => {
  const {display, changes} = drive();
  display.push({kind: 'raw', status: 'connected'});
  display.push({kind: 'raw', status: 'disconnected'});
  jest.advanceTimersByTime(9_999);
  display.push({kind: 'resume'});
  jest.advanceTimersByTime(9_999);
  expect(display.current()).toBe('connecting');
  jest.advanceTimersByTime(1);
  expect(display.current()).toBe('disconnected');
  display.push({kind: 'resume'});
  expect(display.current()).toBe('connecting');
  display.push({kind: 'raw', status: 'connected'});
  jest.advanceTimersByTime(20_000);
  expect(changes).toEqual(['connected', 'connecting', 'disconnected', 'connecting', 'connected']);
  display.dispose();
});

it('a healed or disposed socket cannot later report an outage from its old timer', () => {
  const {display, changes} = drive();
  display.push({kind: 'raw', status: 'connected'});
  display.push({kind: 'raw', status: 'connecting'});
  jest.advanceTimersByTime(9_999);
  display.push({kind: 'raw', status: 'connected'});
  jest.advanceTimersByTime(20_000);
  expect(changes).toEqual(['connected', 'connecting', 'connected']);
  display.push({kind: 'raw', status: 'connecting'});
  display.dispose();
  jest.advanceTimersByTime(20_000);
  expect(display.current()).toBe('connecting');
  expect(jest.getTimerCount()).toBe(0);
});

it('a socket that ended and will not be reopened is an outage at once, not ten seconds of 「연결 중」 (#4895)', () => {
  const {display, changes} = drive();
  display.push({kind: 'raw', status: 'connected'});
  display.push({kind: 'raw', status: 'disconnected'});
  expect(display.current()).toBe('connecting');
  display.push({kind: 'terminal'});
  expect(display.current()).toBe('disconnected');
  // The grace the raw event armed was cancelled: nothing fires later.
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(20_000);
  expect(changes).toEqual(['connected', 'connecting', 'disconnected']);

  // Asking for a reconnect is a recovery with a fresh ten seconds, and it can end the same way.
  display.push({kind: 'resume'});
  expect(display.current()).toBe('connecting');
  jest.advanceTimersByTime(9_999);
  expect(display.current()).toBe('connecting');
  display.push({kind: 'terminal'});
  expect(display.current()).toBe('disconnected');
  expect(jest.getTimerCount()).toBe(0);
  display.dispose();
});

it('terminal on a socket that never reported anything else still shows the outage and arms nothing', () => {
  const {display, changes} = drive();
  display.push({kind: 'terminal'});
  expect(display.current()).toBe('disconnected');
  expect(changes).toEqual(['disconnected']);
  expect(jest.getTimerCount()).toBe(0);
  display.dispose();
});

// ---------------------------------------------------------------------------
// 띠(band)의 1초 침묵은 이 파일의 일이 아니다 (#5222, #5201 S-D)
//
// `shown`(소켓이 살아 있는가를 묻는 쪽이 읽는 상태)만 이 파일이 만든다. 사람에게 말하는 판정 — 끊긴 첫 1초의 침묵(#4949), 「연결 중」, 「끊김」의
// 원인 — 은 코어 연결 상태 모델이 하고 폰의 `ConnectionProvider` 가 소켓 사건을 먹인다. 옛 `bandOf`·`onBand`·조용한 시계 시험(#4949)은
// `connectionProvider.test.tsx` 가 같은 장면을 실제 공급자·머리로 다시 잰다(0.6초 안에 이어짐 · 1.5초 · 이미 선 띠 · 복귀 · 끝난 소켓).
// ---------------------------------------------------------------------------

it('이 시계는 말하는 일을 하지 않는다: 띠를 위한 조용한 시계·콜백이 남아 있지 않다', () => {
  const {display} = drive();
  display.push({kind: 'raw', status: 'connected'});
  display.push({kind: 'raw', status: 'connecting'});
  // 틈이 시작되면 시계는 하나(10초 마감)뿐이다 — 옛 판은 1초 조용한 시계를 하나 더 걸었다.
  expect(jest.getTimerCount()).toBe(1);
  expect(Object.keys(display).sort()).toEqual(['current', 'dispose', 'push']);
  display.dispose();
  expect(jest.getTimerCount()).toBe(0);
});
