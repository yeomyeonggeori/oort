import {act} from '@testing-library/react-native';

import {DISPLAY_GRACE_MS} from '../../src/realtime/connectionDisplay';
import {installTimersOnlyClock} from './fakeClock';

/**
 * Drop the socket the way a real outage does: long enough to outlive the display
 * grace (#2751). A shorter gap is a reconnect and is deliberately not shown.
 *
 * The grace is a `DISPLAY_GRACE_MS` (4 s) `setTimeout` inside the app, and the
 * suites that need the 「끊겼다」 state used to wait it out on the wall clock:
 * 4.05 s of sleep inside jest's 5 s test timer. Measured with `process.hrtime`
 * and `process.cpuUsage` per test: 4.25 s wall for 0.15–0.3 s of CPU, and the
 * wall figure does not move with load — so the tests had a fixed ~0.75 s of
 * headroom for everything that does scale with load (cold JIT, a slow render,
 * a stalled event loop). Any stall past it was a 「Exceeded timeout of 5000 ms」
 * with nothing wrong in the product.
 *
 * The timer is the only thing being waited for, so the clock is faked for
 * exactly that window and advanced past the grace. Only the timer functions are
 * faked: `Date`, `performance` and the microtask queue stay real, so no
 * timestamp the screen reads changes under it. Timers that were armed BEFORE the
 * window (react-query, the 1 s elapsed-clock tick, RN internals) stay real, and
 * timers armed inside it are either run by the advance or dropped when the real
 * clock comes back — the grace timer, which is what the advance is for, is run.
 *
 * What does not change: the socket is cut AFTER the transport has seen
 * `connected` (the real 15 ms), the cut is the same `disconnected` event, and the
 * screen only gets to say 「끊겼다」 if the app's own grace timer fires — the
 * advance does not set any state, it only lets the app's timer run.
 */
export async function dropSocketPastDisplayGrace(
  emitDisconnected: () => void,
): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    installTimersOnlyClock();
    try {
      emitDisconnected();
      await jest.advanceTimersByTimeAsync(DISPLAY_GRACE_MS + 50);
    } finally {
      jest.useRealTimers();
    }
  });
}
