import {
  BACKGROUND_GRACE_MS,
  initialPolicyState,
  policyStart,
  policyStep,
  policyStop,
  type RealtimeAction,
  type RealtimePolicyState,
  type RealtimeSignal,
} from '../src/realtime/backgroundPolicy';

// =============================================================================
// ADR-0137 D4's background policy, verified without a socket or a stopwatch.
//
// The reason this policy is a pure reducer is precisely so these can be
// assertions instead of a person sitting and watching for fifteen seconds.
// =============================================================================

function run(
  state: RealtimePolicyState,
  signals: RealtimeSignal[],
): {state: RealtimePolicyState; actions: RealtimeAction[]} {
  let current = state;
  const actions: RealtimeAction[] = [];
  for (const signal of signals) {
    const step = policyStep(current, signal);
    current = step.state;
    actions.push(...step.actions);
  }
  return {state: current, actions};
}

function connected(): RealtimePolicyState {
  return policyStart(initialPolicyState(true)).state;
}

describe('the 15-second grace period', () => {
  it('is the number the ADR names', () => {
    expect(BACKGROUND_GRACE_MS).toBe(15_000);
  });

  it('does not drop the socket the moment the app is backgrounded', () => {
    const {actions} = run(connected(), [
      {kind: 'visibility', status: 'background'},
    ]);
    expect(actions).toEqual([{kind: 'arm-grace', delayMs: 15_000}]);
    expect(actions).not.toContainEqual({kind: 'disconnect'});
  });

  it('keeps the socket when the person comes back inside the grace', () => {
    const {actions, state} = run(connected(), [
      {kind: 'visibility', status: 'background'},
      {kind: 'visibility', status: 'active'},
    ]);
    expect(actions).toEqual([
      {kind: 'arm-grace', delayMs: 15_000},
      {kind: 'cancel-grace'},
    ]);
    // No reconnect, so no token fetch and no recovery replay — which is the
    // entire benefit the grace period exists to buy.
    expect(actions).not.toContainEqual({kind: 'connect'});
    expect(state.gracePending).toBe(false);
  });

  it('drops the socket once the grace actually elapses', () => {
    const {actions} = run(connected(), [
      {kind: 'visibility', status: 'background'},
      {kind: 'grace-elapsed'},
    ]);
    expect(actions).toEqual([
      {kind: 'arm-grace', delayMs: 15_000},
      {kind: 'disconnect'},
    ]);
  });

  it('reconnects when returning after the grace elapsed', () => {
    const {actions} = run(connected(), [
      {kind: 'visibility', status: 'background'},
      {kind: 'grace-elapsed'},
      {kind: 'visibility', status: 'active'},
    ]);
    expect(actions[actions.length - 1]).toEqual({kind: 'connect'});
  });

  it('does not drop when the timer fires after the person already returned', () => {
    // The cancel and the timer can race. Losing that race must not cost the
    // socket of someone who is looking at the screen.
    const {actions} = run(connected(), [
      {kind: 'visibility', status: 'background'},
      {kind: 'visibility', status: 'active'},
      {kind: 'grace-elapsed'},
    ]);
    expect(actions).not.toContainEqual({kind: 'disconnect'});
  });
});

describe('iOS `inactive` is not backgrounding', () => {
  it('ignores the notification shade, the app switcher and incoming calls', () => {
    const {actions, state} = run(connected(), [
      {kind: 'visibility', status: 'inactive'},
    ]);
    expect(actions).toEqual([]);
    expect(state.gracePending).toBe(false);
  });

  it('still arms the grace on a real background transition after that', () => {
    const {actions} = run(connected(), [
      {kind: 'visibility', status: 'inactive'},
      {kind: 'visibility', status: 'background'},
    ]);
    expect(actions).toEqual([{kind: 'arm-grace', delayMs: 15_000}]);
  });
});

describe('network transitions', () => {
  it('forces a reconnect when the transport type changes', () => {
    // A socket held across Wi-Fi -> cellular can stay open as an object while
    // attached to a dead route: it neither errors nor delivers.
    const {actions} = run(connected(), [
      {kind: 'network', networkType: 'wifi', online: true},
      {kind: 'network', networkType: 'cellular', online: true},
    ]);
    expect(actions).toEqual([{kind: 'force-reconnect'}]);
  });

  it('treats the first observation as a baseline, not a transition', () => {
    const {actions} = run(connected(), [
      {kind: 'network', networkType: 'wifi', online: true},
    ]);
    expect(actions).toEqual([]);
  });

  it('does not churn when the same type is reported again', () => {
    const {actions} = run(connected(), [
      {kind: 'network', networkType: 'wifi', online: true},
      {kind: 'network', networkType: 'wifi', online: true},
      {kind: 'network', networkType: 'wifi', online: true},
    ]);
    expect(actions).toEqual([]);
  });

  it('does not reconnect into an offline radio', () => {
    const {actions} = run(connected(), [
      {kind: 'network', networkType: 'wifi', online: true},
      {kind: 'network', networkType: 'none', online: false},
    ]);
    expect(actions).toEqual([]);
  });
});

describe('there is no socket without a session', () => {
  it('ignores app-state churn before start()', () => {
    const {actions} = run(initialPolicyState(true), [
      {kind: 'visibility', status: 'background'},
      {kind: 'grace-elapsed'},
      {kind: 'visibility', status: 'active'},
    ]);
    expect(actions).toEqual([]);
  });

  it('cancels a pending grace when the session ends', () => {
    const afterBackground = run(connected(), [
      {kind: 'visibility', status: 'background'},
    ]).state;
    const stopped = policyStop(afterBackground);
    expect(stopped.actions).toEqual([
      {kind: 'cancel-grace'},
      {kind: 'disconnect'},
    ]);
    expect(stopped.state.wantConnected).toBe(false);
  });

  it('start() is idempotent', () => {
    const first = policyStart(initialPolicyState(true));
    expect(first.actions).toEqual([{kind: 'connect'}]);
    expect(policyStart(first.state).actions).toEqual([]);
  });
});
