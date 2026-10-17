/**
 * The fake clock for suites that mount the whole app shell and
 * wait on it with `waitFor` (#3796).
 *
 * ## Why these suites fake the clock
 *
 * RNTL's `waitFor` has a 1000 ms default budget, and under REAL timers that is
 * 1000 ms of wall clock. A shell navigation is a chain of async waves (press ->
 * mount -> queries resolve -> re-render -> next query), each ending in a heavy
 * synchronous render of the whole tree. Measured on a loaded machine: each of
 * those renders is ~50 ms idle and 400-580 ms starved (an event-loop-lag probe
 * logged 429/578/524/529 ms gaps), so two of them in a row spend the whole
 * budget — the wait fails while the product is fine.
 *
 * Under FAKE timers RNTL does not use the wall clock at all. Its loop is
 *
 *     advance the fake clock one interval (50 ms) inside act(),
 *     check the expectation, yield one macrotask  — at most timeout/interval
 *     (= 20) times
 *
 * so the budget is a number of polls, and a starved CPU only makes each poll
 * slower, not the budget shorter. A product that never gets there still fails,
 * after 20 polls, with the same assertion message as before.
 *
 * ## What stays real
 *
 * `nextTick`, `setImmediate` and `queueMicrotask`. React's scheduler and RNTL's
 * own macrotask yield (`flushMicroTasks`) run on `setImmediate`, and promise
 * continuations on the microtask queue; freezing them would stop the very work
 * the poll is waiting for. Everything the app arms with a delay — react-query's
 * notify batching, the pull-to-refresh minimum spinner, `Animated` frames,
 * debounces — is faked and is run by the polls.
 *
 * ## What it is not
 *
 * Not a way to make a slow test pass: a test that needs real elapsed time (a
 * debounce it must observe NOT firing, a measured duration) must say so with an
 * explicit `jest.advanceTimersByTime`. Install it in `beforeEach` and let the
 * suite's `afterEach` call `jest.useRealTimers()`.
 */
export function installAppClock(): void {
  jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask']});
}

/**
 * Same, but `Date` and `performance` keep reading the real clock. For a short
 * window inside an otherwise real-time test (see `displayGrace.ts`), where
 * swapping the time source under timestamps the screen already holds would be a
 * second change nobody asked for.
 */
export function installTimersOnlyClock(): void {
  jest.useFakeTimers({
    doNotFake: ['Date', 'performance', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
}

/**
 * Test timeout for a suite whose waits poll the whole app shell under the fake
 * clock. Not a performance budget: it is the room an honest FAILURE needs.
 *
 * Under fake timers RNTL's `waitFor` is a fixed number of polls (20 for the 1000 ms
 * default), so a wait that never succeeds costs 20 polls, and a poll on the shell
 * is an `act` flush that runs the app's pending timers (~50 ms each here). Measured
 * by forcing the loading block on in `WorkSessionDetailScreen`: the failing wait
 * took 5.2 s of wall time on a quiet machine and 10.6-11.7 s on a busy one. Under
 * jest's 5 s default the test timer fires first and the person reads
 * "Exceeded timeout of 5000 ms" instead of the assertion that actually failed.
 * 30 s (the figure `inboxApproval` and `pushTap` already use for the same reason) is
 * 2.5-6x those numbers, so the message is the assertion's. It does not slow a passing
 * test (a wait returns on the poll that sees its condition) and a genuine hang is
 * still reported. Call it at the top level of the suite: `jest.setTimeout` is read
 * once, when the file's run starts.
 */
export const SHELL_WAIT_TEST_TIMEOUT_MS = 30_000;
