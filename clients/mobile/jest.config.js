const os = require('os');
const path = require('path');

/**
 * The core is compiled from `packages/momo-core/src` BY PATH, matching
 * `metro.config.js` and `tsconfig.json`. All three have to agree or the app
 * bundles one thing and the tests check another.
 */
const CORE_SRC = path.resolve(__dirname, '../../packages/momo-core/src');

/**
 * Worker cap (#3796). Jest's default is `cores - 1`; on an 18-core machine that is
 * 17 workers, each a full RN environment, and the suite cannot use them: its
 * longest single file is ~15 s and the whole run is ~80 CPU-seconds, so it stops
 * getting faster at about 8 workers. Measured on this tree (shared machine, warm
 * cache, wall / CPU):
 *
 *     17 workers  17.1 s / 98.6 s     8 workers  15.2 s / 80.7 s
 *      6 workers  21.0 s / 77.1 s     4 workers  37.7 s / 75.5 s
 *
 * Eight is as fast as seventeen and spends ~18% less CPU (every worker re-pays
 * module loading), and it puts 9 fewer processes in the run queue of whatever else
 * the machine is doing — the merge-tree gate is routinely run next to other
 * gates, reviewers and builds. `availableParallelism() - 1` keeps jest's default on
 * smaller machines (a 4-vCPU CI runner still gets 3).
 */
const MAX_WORKERS = Math.min(8, Math.max(os.availableParallelism() - 1, 1));

/**
 * Per-test timeout (#4633). Many sheet and layer tests wait for REAL animations with
 * `waitFor(…, {timeout: 8000})` (sheetContract, aiSheet, home, profile*, memoryUi …), and a
 * few wait twice in a row. Jest's default test timeout is 5 s, shorter than the waits it
 * hosts, so on a slow CI runner Jest killed the test before `waitFor` could finish — the
 * failure said "Exceeded timeout of 5000 ms", not that the UI was wrong (#4629/#4638/#4641 CI,
 * 10-27). The test timeout must exceed the longest wait chain; 20 s covers two 8 s waits plus
 * render.
 *
 * This is a stopgap for the suites that still wait in REAL time, not the fix (#4708). Measured for
 * settingsPage "VoiceOver escape" (idle machine): the layer exit timers are 150-180 ms of a ~1.8 s test;
 * the rest is the shell re-rendering, and polling a big tree with `waitFor` (real or fake clock) is
 * what made it slow, not the animation. That block now drives each exit by advancing the clock by
 * exactly the layer's timer length (no polling, ~0.1 s a test), and sidebarRowSheet runs on the fake
 * app clock (`__tests__/fixtures/fakeClock.ts`, #3796). Suites that still wait with a real-time
 * `{timeout: 8000}` (aiConnectSuggestion, sheetKeyboardAction, aiSheet, profileStatus, shellChrome,
 * sheetKit, home, memoryUi, ...) are why this stays at 20 s; each moves in its own change, and this
 * value comes down when the last one has.
 */
const TEST_TIMEOUT_MS = 20_000;

module.exports = {
  maxWorkers: MAX_WORKERS,
  testTimeout: TEST_TIMEOUT_MS,
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@momo/core/(.*)$': `${CORE_SRC}/$1`,
    // Core source is transpiled while living outside this project, so babel's
    // runtime helpers have to be pinned to this project's copy. The core
    // declares ZERO runtime dependencies by design and its own node_modules
    // holds only typescript and vitest — there is no `@babel/runtime` over
    // there to find, and there must not be. Same reason `metro.config.js`
    // sets `extraNodeModules`.
    '^@babel/runtime/(.*)$': `${path.resolve(__dirname, 'node_modules/@babel/runtime')}/$1`,
  },
  // Every one of these ships ESM, and node_modules is not transformed by
  // default. `react-native/Libraries/Blob/URL` is in the default allowance and
  // is needed by `urlPolyfill.test.ts`, which compares the built-in URL against
  // the polyfilled global — the measurement spike #837 gate 2 made on a device,
  // reproduced here so a regression is caught without one.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-url-polyfill|react-native-keychain|react-native-mmkv|react-native-nitro-modules|react-native-safe-area-context|centrifuge|@tanstack|@formatjs|intl-messageformat)/)',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Runs after the test framework is installed, because it needs `beforeAll`.
  // See the header of `jest.warm.js` for why a cold transform cache needs it.
  setupFilesAfterEnv: ['<rootDir>/jest.warm.js'],
  // `node` 환경에 재시도 등록부(#4708)를 얹은 것: 등록된 시험만 1회 다시 돈다. `jest.environment.js` 머리말 참고.
  testEnvironment: '<rootDir>/jest.environment.js',
  // Explicit, so a shared fixture placed next to the tests is not itself
  // collected as a suite and failed for containing no tests.
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx,js,jsx}'],
};
