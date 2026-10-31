import {
  BACKGROUND_GRACE_MS,
  DISCONNECT_CALLED,
  FOREGROUND_MAX_RECONNECT_DELAY_MS,
  IDLE_MAX_RECONNECT_DELAY_MS,
  ONLINE_RECONNECT_MIN_INTERVAL_MS,
  TOKEN_ENDING_CODES,
  TOKEN_RETRY_DELAYS_MS,
  initialPolicyState,
  policyStart,
  policyStep,
  policyStop,
  reconnectCeilingMs,
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

/**
 * A NetInfo reading as the transport reports it: stamped with its own clock (ms),
 * and with whether the socket is up at that moment (down by default — the
 * interesting case for a recovery).
 */
function net(
  networkType: string | null,
  online: boolean = true,
  at: number = 0,
  socketUp: boolean = false,
): RealtimeSignal {
  return {kind: 'network', networkType, online, at, socketUp};
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
      // `resume` leaves a connected socket alone (the transport checks), so a
      // kept socket still means no reconnect, no token fetch and no recovery
      // replay — the benefit the grace period exists to buy. It exists for the
      // other case: a socket that died with the radio while away and is now
      // sitting in a backoff `connect()` cannot cut short (#2751).
      {kind: 'resume'},
    ]);
    expect(actions).not.toContainEqual({kind: 'connect'});
    expect(actions).not.toContainEqual({kind: 'force-reconnect'});
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
    expect(actions[actions.length - 1]).toEqual({kind: 'resume'});
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
      net('wifi'),
      net('cellular'),
    ]);
    expect(actions).toEqual([{kind: 'force-reconnect'}]);
  });

  it('treats the first observation as a baseline, not a transition', () => {
    const {actions} = run(connected(), [
      net('wifi'),
    ]);
    expect(actions).toEqual([]);
  });

  it('does not churn when the same type is reported again', () => {
    const {actions} = run(connected(), [
      net('wifi'),
      net('wifi'),
      net('wifi'),
    ]);
    expect(actions).toEqual([]);
  });

  it('does not reconnect into an offline radio', () => {
    const {actions} = run(connected(), [
      net('wifi'),
      net('none', false),
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

// =============================================================================
// #4895 — 앞에 둔 채로 「연결이 끊겼습니다」가 30초 넘게 남던 문제.
// 세 규칙: 같은 연결 종류의 온라인 회복 · 앞에 둘 때 짧은 재시도 상한 · 끝난 상태.
// =============================================================================

describe('reachability coming back on the SAME kind of connection (#4895)', () => {
  it('reconnects at once — the kind never changed, so the type rule could not see it', () => {
    // A cellular dead zone: still `cellular`, only `isInternetReachable` flipped.
    const {actions} = run(connected(), [
      net('cellular'),
      net('cellular', false),
      net('cellular', true, 5_000),
    ]);
    expect(actions).toEqual([{kind: 'online-reconnect'}]);
  });

  it('is one reconnect: a recovery that is also a kind change is answered by the type rule alone', () => {
    const {actions} = run(connected(), [
      net('wifi'),
      net('none', false),
      net('wifi', true, 5_000),
    ]);
    expect(actions).toEqual([{kind: 'force-reconnect'}]);
  });

  it('does not take the first report for a recovery (optimistic start, like useOnline)', () => {
    expect(initialPolicyState(true).online).toBe(true);
    expect(run(connected(), [net('wifi', true)]).actions).toEqual([]);
    // Reported offline first, then online: that IS a recovery.
    expect(
      run(connected(), [net('wifi', false), net('wifi', true, 5_000)]).actions,
    ).toEqual([{kind: 'online-reconnect'}]);
  });

  it('cuts a wait, so a socket that is still connected is left alone (a probe flap is not an outage)', () => {
    const {actions, state} = run(connected(), [
      net('cellular'),
      net('cellular', false),
      net('cellular', true, 5_000, true),
    ]);
    expect(actions).toEqual([]);
    // The reading is still recorded, and no interval is spent on a reconnect that did not happen.
    expect(state.online).toBe(true);
    expect(state.lastNetworkReconnectAt).toBeNull();
  });

  it('going offline does nothing — an offline radio is not retried into', () => {
    const {actions, state} = run(connected(), [
      net('cellular'),
      net('cellular', false),
    ]);
    expect(actions).toEqual([]);
    expect(state.online).toBe(false);
  });

  it('is only for a person who is looking, and only with a session', () => {
    // Parked in the background on purpose: the return rebuilds it.
    const away = run(connected(), [
      net('cellular'),
      {kind: 'visibility', status: 'background'},
      net('cellular', false),
      net('cellular', true, 5_000),
    ]);
    expect(away.actions).toEqual([{kind: 'arm-grace', delayMs: 15_000}]);
    // No session, no socket.
    expect(
      run(initialPolicyState(true), [
        net('cellular', false),
        net('cellular', true, 5_000),
      ]).actions,
    ).toEqual([]);
  });

  it('is limited to one per interval — a flapping radio must not keep restarting the handshake', () => {
    const t = ONLINE_RECONNECT_MIN_INTERVAL_MS;
    expect(t).toBe(2_000);
    const burst = run(connected(), [
      net('cellular'),
      net('cellular', false, 1_000),
      net('cellular', true, 2_000),
      net('cellular', false, 2_500),
      net('cellular', true, 2_000 + t - 1),
    ]);
    // The second recovery lands 1999 ms after the first: a duplicate.
    expect(burst.actions).toEqual([{kind: 'online-reconnect'}]);
    // Once the interval is over, the next recovery is a new one.
    const later = run(burst.state, [
      net('cellular', false, 2_000 + t),
      net('cellular', true, 2_000 + t),
    ]);
    expect(later.actions).toEqual([{kind: 'online-reconnect'}]);
  });

  it('a clock that moved backwards does not mute recoveries until it catches up', () => {
    const {actions} = run(connected(), [
      net('cellular'),
      net('cellular', false, 9_000),
      net('cellular', true, 10_000),
      net('cellular', false, 4_000),
      net('cellular', true, 5_000),
    ]);
    expect(actions).toEqual([
      {kind: 'online-reconnect'},
      {kind: 'online-reconnect'},
    ]);
  });
});

describe('the retry ceiling follows foreground and reachability (#4895)', () => {
  it('is 5 s in front and the old 20 s everywhere else', () => {
    expect(FOREGROUND_MAX_RECONNECT_DELAY_MS).toBe(5_000);
    expect(IDLE_MAX_RECONNECT_DELAY_MS).toBe(20_000);
    expect(reconnectCeilingMs(connected())).toBe(5_000);
  });

  it('inactive counts as in front, like everywhere in this file', () => {
    const {state} = run(connected(), [{kind: 'visibility', status: 'inactive'}]);
    expect(reconnectCeilingMs(state)).toBe(5_000);
  });

  it('background keeps the old ceiling, and coming back shortens it again', () => {
    const away = run(connected(), [{kind: 'visibility', status: 'background'}]);
    expect(reconnectCeilingMs(away.state)).toBe(20_000);
    const back = run(away.state, [{kind: 'visibility', status: 'active'}]);
    expect(reconnectCeilingMs(back.state)).toBe(5_000);
  });

  it('an offline radio keeps the old ceiling, and coming back online shortens it again', () => {
    const offline = run(connected(), [net('wifi'), net('none', false)]);
    expect(reconnectCeilingMs(offline.state)).toBe(20_000);
    const online = run(offline.state, [net('wifi', true, 5_000)]);
    expect(reconnectCeilingMs(online.state)).toBe(5_000);
  });
});

describe('an ENDED socket (`disconnected`) while the person is looking (#4895)', () => {
  const ended = (state: RealtimePolicyState, code: number) =>
    policyStep(state, {kind: 'ended', code});

  /** The state after the token retries are used up. */
  function exhausted(): RealtimePolicyState {
    return run(connected(), [
      {kind: 'ended', code: 3500},
      {kind: 'ended', code: 3500},
    ]).state;
  }

  it("never answers our own disconnect() — the grace, resume's close-before-open, stop, dispose", () => {
    expect(DISCONNECT_CALLED).toBe(0);
    const before = connected();
    const step = ended(before, DISCONNECT_CALLED);
    expect(step.actions).toEqual([]);
    // Unchanged, and no retry budget spent on something we did ourselves.
    expect(step.state).toBe(before);
  });

  it('retries a token ending after 1 s, then after 5 s, then holds it', () => {
    expect(TOKEN_RETRY_DELAYS_MS).toEqual([1_000, 5_000]);
    const first = ended(connected(), 3500);
    expect(first.actions).toEqual([
      {kind: 'terminal-retry', code: 3500, delayMs: 1_000},
    ]);
    const second = ended(first.state, 3500);
    expect(second.actions).toEqual([
      {kind: 'terminal-retry', code: 3500, delayMs: 5_000},
    ]);
    const third = ended(second.state, 3500);
    expect(third.actions).toEqual([{kind: 'terminal-hold', code: 3500}]);
  });

  it('names the token endings: client unauthorized, protocol unauthorized, invalid token', () => {
    expect([...TOKEN_ENDING_CODES]).toEqual([1, 101, 3500]);
    for (const code of TOKEN_ENDING_CODES) {
      expect(ended(connected(), code).actions).toEqual([
        {kind: 'terminal-retry', code, delayMs: 1_000},
      ]);
    }
  });

  it.each([2, 3, 102, 103, 107, 3501, 3502, 3503, 3504, 3505, 3506, 3507, 3508, 3509, 4501])(
    'holds code %i: the server or protocol said not to reconnect, and trying again repeats it',
    code => {
      expect(ended(connected(), code).actions).toEqual([
        {kind: 'terminal-hold', code},
      ]);
    },
  );

  it('does not spend the token budget on a held ending', () => {
    const {state} = ended(connected(), 3503);
    expect(state.terminalRetries).toBe(0);
  });

  it('a connected socket starts the count over', () => {
    const state = run(exhausted(), [{kind: 'connected'}]).state;
    expect(ended(state, 3500).actions).toEqual([
      {kind: 'terminal-retry', code: 3500, delayMs: 1_000},
    ]);
  });

  it.each<[string, RealtimeSignal[]]>([
    ['a return from the background', [
      {kind: 'visibility', status: 'background'},
      {kind: 'visibility', status: 'active'},
    ]],
    ['a network kind change', [net('wifi'), net('cellular')]],
    ['reachability coming back', [net('cellular', false), net('cellular', true, 5_000)]],
    ['the person asking', [{kind: 'manual'}]],
  ])('%s starts the count over', (_name, signals) => {
    expect(ended(exhausted(), 3500).actions).toEqual([
      {kind: 'terminal-hold', code: 3500},
    ]);
    const state = run(exhausted(), signals).state;
    expect(ended(state, 3500).actions).toEqual([
      {kind: 'terminal-retry', code: 3500, delayMs: 1_000},
    ]);
  });

  it('does nothing when nobody is looking — the return rebuilds with a new token anyway', () => {
    const away = run(connected(), [
      {kind: 'visibility', status: 'background'},
    ]).state;
    expect(ended(away, 3500).actions).toEqual([]);
    expect(ended(away, 3503).actions).toEqual([]);
  });

  it('does nothing without a session', () => {
    expect(ended(initialPolicyState(true), 3500).actions).toEqual([]);
    expect(ended(policyStop(connected()).state, 3503).actions).toEqual([]);
  });
});

describe('the person asks for a reconnect (「지금 다시 연결」, #4895)', () => {
  it('is its own action, so the connection record can name it', () => {
    const step = policyStep(connected(), {kind: 'manual'});
    expect(step.actions).toEqual([{kind: 'manual-reconnect'}]);
  });

  it('needs a session', () => {
    expect(
      policyStep(initialPolicyState(true), {kind: 'manual'}).actions,
    ).toEqual([]);
  });
});
