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
