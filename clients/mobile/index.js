/**
 * @format
 *
 * Entry point. The order of these three imports is load-bearing and is asserted
 * by `__tests__/bootOrder.test.ts` — please read before rearranging.
 *
 * 1. `./src/boot/polyfills`
 *    Installs `react-native-url-polyfill`, which REPLACES the global `URL` and
 *    `URLSearchParams`. React Native's built-in `URL` is a regex wrapper, not a
 *    WHATWG implementation, and it cannot parse a custom scheme: spike #837
 *    gate 2 measured the same 19 cases at 0/19 on the built-in and 19/19 on the
 *    polyfill. `@momo/core` calls `new URL(...)` in `lib/serverUrl.ts`,
 *    `features/auth/deepLink.ts` and `features/timeline/artifacts.ts`, so every
 *    one of those is wrong until this import has run. It must be FIRST: a
 *    module that captured `URL` at import time would keep the broken one.
 *
 * 2. `./src/boot/coreHost`
 *    Installs the platform implementations the core asks for (server base,
 *    session tokens). Before this runs the core answers from its inert default,
 *    which is "" and "no session" — correct for a unit test, wrong for a render.
 *    Web does the same thing in the same position (`main.tsx` imports
 *    `coreHost.ts` first); this is that file's RN sibling.
 *
 * 3. `./App`
 *    Only now, because it imports core modules transitively.
 */
import './src/boot/polyfills';
import './src/boot/coreHost';

import React from 'react';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {measureMode} from './measure/root';

/**
 * Normally `App`. With the launch argument `-momoMeasure YES`, and only in a dev
 * build, the measurement harness takes the root instead (see `measure/`).
 *
 * The swap lives here rather than inside `App` so a normal launch never even
 * evaluates the harness: the only thing imported above is the one function that
 * reads the argument, and `require` below runs only when it answers yes.
 */
AppRegistry.registerComponent(appName, () => {
  const mode = measureMode();
  if (mode === null) return App;
  if (mode.kind === 'measure') return require('./measure/harness').default;
  if (mode.kind === 'states') return require('./measure/states').default;
  // A named surface (goal RN-C5): the action sheet, the editor, the delete
  // confirmation, or one of search's four states. `measure/surfaces.tsx` hands
  // the SHIPPING component that state directly, because none of them can be
  // reached by a script on a simulator.
  const Surfaces = require('./measure/surfaces').default;
  return function SurfaceRoot() {
    return React.createElement(Surfaces, {name: mode.name});
  };
});
