/**
 * Cold-cache warm-up for rendering suites (#3796).
 *
 * ## What it fixes
 *
 * React Native loads most of its internals lazily: the renderer, the Animated
 * node classes, the DOM-ish public-instance classes, ScrollView's helpers, the
 * LogBox data layer and so on are `require`d on FIRST USE, which in a suite is the
 * first `render()` of a file -- inside the first test's body, under its 5 s timer.
 * Jest then babel-transforms each of those files right there, because every one
 * of them is node_modules source that `transformIgnorePatterns` lets through.
 *
 * With a warm transform cache that costs almost nothing (the first test of
 * `composerDraftOffline` measured 47 ms of CPU), which is why a file "passes
 * alone" on a developer machine. The merge-tree gate
 * (`scripts/verify_merge_tree.sh`) and CI never have a warm cache: jest's
 * transform cache does not carry over to a new project root (measured: the same
 * commit in a fresh worktree path re-transforms everything), and the gate builds
 * a brand-new worktree path on every run. So every gate run pays it, concurrently
 * in every worker, in the first test that renders.
 *
 * Measured on this tree with a cold cache and a lightly loaded machine: 20 of 148
 * files transformed 235 distinct modules INSIDE a test body -- 524 transforms,
 * 16.2 s of babel time summed over the run, 1.6-2.2 s per file in
 * `deviceKeyEnrollment`, `composerDraftOffline`, `connectKeyboard`, `teamBoard`,
 * `conversationVisual`, `approvalCard` and `timelineEntryEnd`. The first test that
 * rendered in those files took 2.1-3.0 s of wall time (1.7-2.2 s of CPU) and
 * crossed jest's 5 s default as soon as the machine was busy. Those are the
 * "always the first test, always 5 s, never an assertion" failures.
 *
 * ## What it does
 *
 * It does the first render's lazy loading once, in a `beforeAll`, which jest
 * does not charge to any test. The hook has its own explicit budget (below)
 * because on a cold cache the work is real: it is the same transform work the
 * first test used to do, now spent where a slow machine cannot turn it into a
 * test failure. With a warm cache it is cheap (the load of RN and RNTL measured
 * 0.29 s).
 *
 * After it, the same cold run transforms 1 module inside a test body (8 ms).
 *
 * Only suites that render are warmed (a pure-logic suite never mounts anything,
 * so warming it would be pure cost) and the warm tree is torn down before the
 * first test, so nothing it mounted is visible to a test. It loads the same
 * modules the first test would have loaded, from the same registry, after the
 * test file's own `jest.mock` calls -- so no module can bind a different
 * dependency than it would have bound lazily.
 */
const fs = require('fs');

/**
 * Hang guard for the warm-up itself, not a performance budget. Measured (loading
 * RN and RNTL in isolation): 2.6 s with a cold cache, 0.29 s warm. 120 s is ~45x
 * the cold figure -- far above any starvation seen (the worst event-loop stalls in
 * the load sweeps were ~10x) -- and still short enough that a genuinely hung
 * require is reported.
 */
const WARM_TIMEOUT_MS = 120_000;

const RENDERS = /@testing-library\/react-native|react-test-renderer/;

/**
 * RN exports that the render below does not reach but a suite can. A named list on
 * purpose: iterating `Object.keys(RN)` also touches the deprecated getters
 * (`Clipboard`, `SafeAreaView`, `ProgressBarAndroid`, ...), each of which logs a
 * `console.warn` when read. A name missing from this list costs nothing but the
 * old behaviour (its module is transformed on first use).
 */
const LAZY_EXPORTS = [
  'ActionSheetIOS',
  'AppState',
  'PanResponder',
  'SectionList',
  'Share',
  'Switch',
  'useWindowDimensions',
];

async function warmTree() {
  const React = require('react');
  const RN = require('react-native');
  const {renderAsync, fireEvent} = require('@testing-library/react-native');
  const {
    ActivityIndicator,
    Animated,
    Easing,
    FlatList,
    Image,
    KeyboardAvoidingView,
    Modal,
    Pressable,
    RefreshControl,
    ScrollView,
    Text,
    TextInput,
    View,
  } = RN;
  const h = React.createElement;

  // Lazy getters on the RN index that screens reach for later (a section list, a
  // switch, a share/action sheet, pan gestures). Touching them loads the module;
  // none of them renders or arms anything.
  for (const name of LAZY_EXPORTS) void RN[name];

  const driven = new Animated.Value(0);
  const scaled = Animated.multiply(driven, new Animated.Value(2));
  const opacity = driven.interpolate({inputRange: [0, 1], outputRange: [0, 1]});
  const scrollRef = React.createRef();

  const tree = await renderAsync(
    h(
      KeyboardAvoidingView,
      {behavior: 'padding'},
      h(
        View,
        {style: [{flex: 1}, {opacity: 1}], onLayout: () => {}},
        h(Text, {numberOfLines: 1}, 'warm'),
        h(ActivityIndicator, null),
        h(Image, {source: {uri: 'file:///warm.png'}, style: {width: 1, height: 1}}),
        h(TextInput, {value: '', onChangeText: () => {}}),
        h(
          ScrollView,
          {
            ref: scrollRef,
            onScroll: () => {},
            refreshControl: h(RefreshControl, {refreshing: false, onRefresh: () => {}}),
          },
          h(Pressable, {onPress: () => {}, testID: 'warm-press'}, h(Text, null, 'press')),
        ),
        h(FlatList, {
          data: [{id: 'a'}, {id: 'b'}],
          keyExtractor: item => item.id,
          renderItem: ({item}) => h(Text, null, item.id),
        }),
        h(Animated.View, {style: {opacity, transform: [{scale: scaled}]}}),
        // A visible Modal wraps its children in `AppContainer` (dev), which pulls in
        // the LogBox notification container and the debugging overlay registry.
        h(Modal, {visible: true, transparent: true}, h(View, null)),
      ),
    ),
  );
  fireEvent.press(tree.getByTestId('warm-press'));
  fireEvent.scroll(scrollRef.current, {
    nativeEvent: {
      contentOffset: {y: 1},
      contentSize: {height: 10, width: 1},
      layoutMeasurement: {height: 1, width: 1},
    },
  });
  // Native-driven animations are what the app runs (`useNativeDriver: true`
  // everywhere). Starting one on a mounted Animated.View is what first loads the
  // public-instance classes (`getNativeTagFromPublicInstance` ->
  // ReactFabricPublicInstance -> the DOM-ish node classes). The driver is native,
  // so nothing is scheduled in JS: no timer is left for a test that installs
  // fake timers.
  Animated.spring(driven, {toValue: 1, useNativeDriver: true}).start();
  Animated.timing(driven, {
    toValue: 0,
    duration: 1,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  }).start();
}

async function warmRender() {
  const {cleanupAsync} = require('@testing-library/react-native');
  try {
    await warmTree();
  } finally {
    // The async variant: RNTL's sync `cleanup()` fires its unmount `act`s without
    // awaiting them, and a test that renders next would then hit "overlapping act()".
    // In a `finally` so a warm tree that throws half-built is still torn down.
    await cleanupAsync();
  }
}

beforeAll(async () => {
  if (!RENDERS.test(fs.readFileSync(expect.getState().testPath, 'utf8'))) return;
  try {
    await warmRender();
  } catch (error) {
    // The warm-up is an optimisation. If it cannot run (a suite that replaces
    // `react-native` wholesale, an RN upgrade that moves a module) the suite must
    // still run exactly as it did before this file existed -- first render loading
    // RN lazily -- not fail in a hook it never asked for. Said out loud so the loss
    // of the benefit is visible instead of silent.
    console.warn(
      `[jest.warm] skipped, first render will load React Native lazily: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, WARM_TIMEOUT_MS);

// Haptic calls require an active app. RN's preset uses a function for currentState.
// Each fake test clock starts a fresh global 100ms window (mocked modules may omit it).
beforeEach(() => {
  require('react-native').AppState.currentState = 'active';
  require('./src/lib/haptics').__resetHapticClockForTests?.();
});
