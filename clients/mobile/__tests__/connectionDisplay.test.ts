import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {
  createConnectionDisplay,
  DISPLAY_GRACE_MS,
  displayStep,
  initialDisplayState,
  type DisplayEvent,
  type DisplayState,
} from '../src/realtime/connectionDisplay';

// =============================================================================
// #2751 — a reconnect is not a disconnection until it has lasted long enough to
// be one. Asserted on the reducer and on its timer driver, never by watching.
// =============================================================================

function run(events: DisplayEvent[], from: DisplayState = initialDisplayState()) {
  let state = from;
  const shown: RealtimeStatus[] = [];
  for (const event of events) {
    state = displayStep(state, event).state;
    shown.push(state.shown);
  }
  return {state, shown};
}

describe('the display grace is inside the issue band', () => {
  it('is between 3 and 5 seconds', () => {
    expect(DISPLAY_GRACE_MS).toBeGreaterThanOrEqual(3_000);
    expect(DISPLAY_GRACE_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('displayStep', () => {
  it('reports the opening handshake as it is', () => {
    const {shown} = run([{kind: 'raw', status: 'connecting'}]);
    expect(shown).toEqual(['connecting']);
  });

  it('reports a refusal before the first connection as it is', () => {
    const {shown} = run([
      {kind: 'raw', status: 'connecting'},
      {kind: 'raw', status: 'disconnected'},
    ]);
    expect(shown).toEqual(['connecting', 'disconnected']);
  });

  it('holds `connected` through a reconnect — both `connecting` and a deliberate close', () => {
    const {shown} = run([
      {kind: 'raw', status: 'connected'},
      // force-reconnect: disconnect() then connect()
      {kind: 'raw', status: 'disconnected'},
      {kind: 'raw', status: 'connecting'},
      {kind: 'raw', status: 'connected'},
    ]);
    expect(shown).toEqual(['connected', 'connected', 'connected', 'connected']);
  });

  it('admits the outage once the grace runs out, and only once', () => {
    const {shown} = run([
      {kind: 'raw', status: 'connected'},
      {kind: 'raw', status: 'connecting'},
      {kind: 'grace-expired'},
      // the retry loop inside a long outage
      {kind: 'raw', status: 'connecting'},
      {kind: 'raw', status: 'connecting'},
      {kind: 'grace-expired'},
    ]);
    expect(shown).toEqual([
      'connected',
      'connected',
      'disconnected',
      'disconnected',
      'disconnected',
      'disconnected',
    ]);
  });

  it('a foreground return reads `connecting` with a fresh grace', () => {
    const {state} = run([
      {kind: 'raw', status: 'connected'},
      {kind: 'raw', status: 'disconnected'},
      {kind: 'grace-expired'},
      {kind: 'resume'},
    ]);
    expect(state.shown).toBe('connecting');
    expect(state.graceArmed).toBe(true);
    const step = displayStep(state, {kind: 'resume'});
    expect(step.actions).toEqual([{kind: 'cancel'}, {kind: 'arm'}]);
  });
});

describe('createConnectionDisplay (timer driver)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function drive() {
    const changes: RealtimeStatus[] = [];
    const display = createConnectionDisplay(status => changes.push(status));
    return {display, changes};
  }

  it('a reconnect shorter than the grace never reaches the reader', () => {
    const {display, changes} = drive();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(DISPLAY_GRACE_MS - 1);
    display.push({kind: 'raw', status: 'connected'});
    jest.advanceTimersByTime(DISPLAY_GRACE_MS * 3);
    expect(changes).toEqual(['connected']);
  });

  it('a gap longer than the grace is reported exactly at its end, once', () => {
    const {display, changes} = drive();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'connecting'});
    jest.advanceTimersByTime(DISPLAY_GRACE_MS - 1);
    expect(display.current()).toBe('connected');
    jest.advanceTimersByTime(1);
    expect(display.current()).toBe('disconnected');
    // Retries during the outage do not blink the label.
    for (let i = 0; i < 5; i += 1) {
      display.push({kind: 'raw', status: 'connecting'});
      jest.advanceTimersByTime(DISPLAY_GRACE_MS * 2);
    }
    expect(changes).toEqual(['connected', 'disconnected']);
    display.push({kind: 'raw', status: 'connected'});
    expect(changes).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('a timer that fell due while suspended does not fire over a resume', () => {
    const {display, changes} = drive();
    display.push({kind: 'raw', status: 'connected'});
    display.push({kind: 'raw', status: 'disconnected'}); // policy parked the socket
    jest.advanceTimersByTime(DISPLAY_GRACE_MS - 10);
    display.push({kind: 'resume'});
    // The old deadline passes; the fresh one has not.
    jest.advanceTimersByTime(DISPLAY_GRACE_MS - 10);
    expect(display.current()).toBe('connected');
    display.push({kind: 'raw', status: 'connected'});
    jest.advanceTimersByTime(DISPLAY_GRACE_MS * 2);
    expect(changes).toEqual(['connected']);
  });
});
