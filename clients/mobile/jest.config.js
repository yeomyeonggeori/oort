const path = require('path');

/**
 * The core is compiled from `packages/momo-core/src` BY PATH, matching
 * `metro.config.js` and `tsconfig.json`. All three have to agree or the app
 * bundles one thing and the tests check another.
 */
const CORE_SRC = path.resolve(__dirname, '../../packages/momo-core/src');

module.exports = {
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
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-url-polyfill|react-native-keychain|react-native-mmkv|react-native-nitro-modules|react-native-safe-area-context|centrifuge|@tanstack)/)',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
  // Explicit, so a shared fixture placed next to the tests is not itself
  // collected as a suite and failed for containing no tests.
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx,js,jsx}'],
};
