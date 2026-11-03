import {
  CONNECTING_BAND_DELAY_MS,
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
// 띠(band)는 1초 넘게 걸릴 때만 선다 (#4949, owner 10-31)
//
// `shown`(소켓 상태를 읽는 쪽)은 그대로 곧바로 `connecting` 이다. 말이 없는 것은 **띠**뿐이다.
// ---------------------------------------------------------------------------

function driveBand() {
  const bands: RealtimeStatus[] = [];
  const shown: RealtimeStatus[] = [];
  const display = createConnectionDisplay(
    status => shown.push(status),
    DISPLAY_GRACE_MS,
    band => bands.push(band),
  );
  return {display, bands, shown};
}

describe('연결 띠는 1초 넘게 걸릴 때만 선다 (#4949)', () => {
  it('0.6초 안에 다시 이어지면 띠는 한 번도 서지 않는다 — 소켓 상태는 곧바로 connecting 이다', () => {
    expect(CONNECTING_BAND_DELAY_MS).toBe(1_000);
    const {display, bands, shown} = driveBand();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'connecting'});
    expect(display.current()).toBe('connecting');
    expect(shown).toEqual(['connected', 'connecting']);
    expect(display.band()).toBe('connected');
    jest.advanceTimersByTime(600);
    display.push({kind: 'raw', status: 'connected'});
    jest.advanceTimersByTime(20_000);
    expect(bands).toEqual([]); // 띠에 나간 말이 하나도 없다 — 조용함에서 조용함으로 가는 것은 변화가 아니다.
    expect(display.band()).toBe('connected');
    expect(jest.getTimerCount()).toBe(0);
    display.dispose();
    // 깨뜨리면: 조용한 시계를 없애(`arm-quiet` 를 빼) 띠가 `shown` 을 그대로 따르게 하면 `bands` 에 `connecting` 이 끼어 빨갛다.
  });

  it('1.5초 걸리면 1초부터 띠가 서고 이어지면 곧 걷힌다 — 끊김 지속은 지금처럼 10초에 끊김이다', () => {
    const {display, bands} = driveBand();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(CONNECTING_BAND_DELAY_MS - 1);
    expect(display.band()).toBe('connected');
    jest.advanceTimersByTime(1);
    expect(display.band()).toBe('connecting');
    jest.advanceTimersByTime(500);
    display.push({kind: 'raw', status: 'connected'});
    expect(display.band()).toBe('connected');
    expect(bands).toEqual(['connecting', 'connected']);

    // 끊김이 이어지면: 1초부터 「연결 중」, 10초에 「끊김」(재시도 이벤트는 마감을 늦추지 않는다).
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(CONNECTING_BAND_DELAY_MS);
    expect(display.band()).toBe('connecting');
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(DISPLAY_GRACE_MS - CONNECTING_BAND_DELAY_MS - 1);
    expect(display.band()).toBe('connecting');
    jest.advanceTimersByTime(1);
    expect(display.band()).toBe('disconnected');
    expect(display.current()).toBe('disconnected');
    display.dispose();
    // 깨뜨리면: 1초 문턱을 없애면(`quiet` 를 처음부터 거짓으로) 첫 `advanceTimersByTime(999)` 뒤 단정이 빨갛다.
  });

  it('이미 선 띠는 다시 조용해지지 않고, 조용한 띠는 복귀가 와도 조용하다(새 1초를 센다)', () => {
    const {display, bands} = driveBand();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(800);
    // 조용한 띠 + 복귀: 800ms 가 지났어도 복귀 시각부터 새로 1초 — 지금까지 말이 없었으니 계속 없다.
    display.push({kind: 'resume'});
    jest.advanceTimersByTime(900);
    expect(display.band()).toBe('connected');
    jest.advanceTimersByTime(100);
    expect(display.band()).toBe('connecting');
    // 선 띠 + 복귀: 내려가지 않고 그대로 「연결 중」이다.
    const before = bands.length;
    display.push({kind: 'resume'});
    expect(display.band()).toBe('connecting');
    expect(bands.length).toBe(before);

    // 끊김 띠(10초) + 「지금 다시 연결」: 조용해지지 않고 곧바로 「연결 중」으로 바뀐다 — 누른 손에 답이 보인다.
    jest.advanceTimersByTime(DISPLAY_GRACE_MS);
    expect(display.band()).toBe('disconnected');
    display.push({kind: 'resume'});
    expect(display.band()).toBe('connecting');
    display.dispose();
    // 깨뜨리면: `resume` 이 항상 `quiet: true` 를 세우면 마지막 두 단정이 빨갛다.
  });

  it('끝난 소켓(terminal)은 조용한 첫 1초에도 곧바로 끊김이고, 첫 연결(콜드 스타트)도 1초 문턱을 탄다', () => {
    const cold = driveBand();
    cold.display.push({kind: 'raw', status: 'connecting'}); // 첫 연결이 시작됐다
    expect(cold.display.band()).toBe('connected');
    jest.advanceTimersByTime(CONNECTING_BAND_DELAY_MS);
    expect(cold.display.band()).toBe('connecting');
    cold.display.dispose();

    const ended = driveBand();
    ended.display.push({kind: 'raw', status: 'connected'});
    ended.display.push({kind: 'raw', status: 'disconnected'});
    expect(ended.display.band()).toBe('connected');
    ended.display.push({kind: 'terminal'});
    expect(ended.display.band()).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
    ended.display.dispose();
  });
});
