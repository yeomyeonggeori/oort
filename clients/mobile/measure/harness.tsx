import type {Message} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {matchMembers} from '../src/features/conversation/mentionQuery';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {
  Timeline,
  type TimelineGeometry,
} from '../src/features/conversation/Timeline';
import {color, font, SAFE_GUTTER, space} from '../src/design/tokens';
import {FixedScheme} from '../src/design/theme';
import {keyboardNative} from '../src/lib/keyboardPane';
import {useKeyboard} from '../src/lib/useKeyboard';

// =============================================================================
// The measurement harness. **Not app code** — it lives outside `src/` for the
// same reason `clients/mobile-spike` lives outside `clients/mobile`.
//
// It exists because these claims are about pixels, and a claim about pixels that
// is argued rather than measured is a claim about nothing:
//
//   1. a message arriving while the reader is scrolled back moves the anchor 0px
//   2. loading older messages moves the anchor 0px
//   3. the composer is not covered by the software keyboard
//   4. the composer travels WITH the keyboard rather than after it   (RN-C5)
//   5. my own message comes to me even from mid-history               (RN-C5)
//
// ## 4 and 5 exist because measuring only the destination hid a real defect
//
// 성재 on an iPhone 17 reported both of them: "키보드보다 늦게 올라오는 딜레이가
// 있어" and "내가 친 채팅이 채팅창 아래로 떠서 스크롤을 해야 나와". Claim 3 was
// already being measured and was PASSING at 0px — because 0px is where the
// composer ends up, and the defect was in how it got there. A number that can
// only be right is not a measurement.
//
// So claim 4 times the JOURNEY: how long after the keyboard event does the
// composer start moving, and when does it arrive. And claim 5 asks the question
// the follow rule is actually about — after sending from mid-history, is the
// thing I just wrote on screen.
//
// ## It measures the SHIPPING components
//
// `Timeline` and `Composer` are imported from `src/`, not reimplemented. The
// spike's gate 5 wrote its own list and said so; the numbers it produced were
// about that list. These numbers are about the one in the app, which is the
// only kind that can be quoted in a PR about the app.
//
// ## Why it auto-runs, and how it is reached
//
// The iOS simulator cannot be driven: spike #837 found the accessibility tree
// does not expose React Native's elements and coordinate clicks do not land. A
// harness needing a tap could not be run by anyone but a human with the device
// in their hand. So this one runs itself on mount and prints its answers large
// enough to screenshot, exactly as gate 3 did.
//
// It is selected by a LAUNCH ARGUMENT, not by a tab or a build flag:
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure YES
//
// `-key value` arguments land in NSUserDefaults' argument domain, which is what
// React Native's `Settings` module reads. Nothing is left switched on in the
// app: with no argument, `index.js` mounts `App` and this file is never
// evaluated. `scripts/measure.sh` runs the whole thing.
// =============================================================================

const SELF_ID = '00000000-0000-7000-8000-000000000001';
const CHANNEL = '00000000-0000-7000-8000-0000000002ff';
const BASE_MS = 1_700_000_000_000;

const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);
const AUTHORS = ROSTER.filter(m => m.status === 'active');

/**
 * Korean rows of mixed height (2–5 lines), which is the condition gate 5 used:
 * a uniform-height list is the easy case and hides exactly the errors a
 * position correction is supposed to absorb.
 */
function makeMessage(seq: number): Message {
  // `((n % m) + m) % m`: the prepended rows carry seqs BELOW the first page, and
  // JavaScript's `%` keeps the sign of the dividend — so a plain `seq % len` on
  // a lower seq indexes off the front of the array and reads `undefined.id`.
  const pick = (m: number) => ((seq % m) + m) % m;
  const lines = 2 + pick(4);
  const body = Array.from(
    {length: lines},
    (_, i) => `${seq}번째 메시지의 ${i + 1}번째 줄입니다. 한국어 가변 높이 확인용 문장.`,
  ).join('\n');
  return {
    id: `measure-${seq}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AUTHORS[pick(AUTHORS.length)].id,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 60_000,
  };
}

/**
 * Seqs start high so that "older" rows are still positive — a channel's history
 * does not begin at 1 either, and starting there made the prepend fixture the
 * only place in this file with negative seqs.
 */
const FIRST_SEQ = 1000;
const INITIAL_COUNT = 200;
/**
 * The row whose absolute position is watched. Deliberately in the middle of the
 * history: at either end an edge effect (the list clamping at offset 0, or the
 * tail-follow at the bottom) could flatter the result.
 */
const ANCHOR_SEQ = FIRST_SEQ + 45;

// ---- goal RN-U1: the SHORT conversation ------------------------------------
//
// 성재: "스레드에서도 뭔가 채팅을 하면 위에 숨겨져 있어서 채팅 닫아야 보이더라."
//
// Everything above this line measures a channel carrying 200 rows, and that is
// the wrong fixture for this claim: with 200 rows the content is always taller
// than the viewport, which is exactly the case in which this defect cannot
// happen. What reproduces it is a conversation SHORTER than the screen — the
// list then draws its content at the top with nothing to scroll, and
// `ConversationLayout`'s keyboard lift carries that content up under the header
// where an `overflow: 'hidden'` clip removes it. A thread is where a person meets
// it first only because a thread is nearly always short.
//
// One line each, and no more: the fixture has to stay well under one viewport
// for the measurement to be about anything.
const THREAD_ROOT_SEQ = FIRST_SEQ + INITIAL_COUNT + 100;

function makeShortMessage(seq: number, rootId?: string): Message {
  return {
    id: `measure-thread-${seq}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AUTHORS[seq % AUTHORS.length].id,
    type: 'text',
    body: `${seq}번째 줄. 스레드 답글 가시성 측정용 짧은 문장.`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 60_000,
    ...(rootId === undefined ? {} : {rootId}),
  };
}

const THREAD_ROOT = makeShortMessage(THREAD_ROOT_SEQ);

const wait = (ms: number) => new Promise<void>(r => setTimeout(() => r(), ms));

/**
 * The Korean keyboard's height on an iPhone 17 Pro, in points. Used only when
 * the simulator refuses to raise the real one; on a device the OS supplies the
 * number and this constant is never read.
 */
const KEYBOARD_HEIGHT_PT = 336;

/**
 * Push a keyboard frame onto the emitter iOS itself publishes on.
 *
 * `Keyboard` exposes `addListener` but not `emit`; the emitter underneath is a
 * plain `NativeEventEmitter`, which does have it. Reaching for it is exactly as
 * unofficial as it looks, which is why it lives in the harness and not in
 * `src/`.
 *
 * **Kept only as the fallback.** It publishes on React Native's JS-side emitter,
 * which is one layer ABOVE the notification centre — so it can drive
 * `useKeyboard()` and it cannot drive `modules/momo-keyboard-native`, whose
 * whole point is that it listens to UIKit instead of to JavaScript. A run that
 * lands here is measuring the old path, and `keyboardSource` says so.
 */
function keyboardEmitter():
  | {emit: (event: string, payload: unknown) => void}
  | undefined {
  return (
    Keyboard as unknown as {
      _emitter?: {emit: (event: string, payload: unknown) => void};
    }
  )._emitter;
}

function injectKeyboardFrame(height: number): void {
  const emitter = keyboardEmitter();
  emitter?.emit('keyboardWillShow', {
    endCoordinates: {height, screenX: 0, screenY: 0, width: 0},
    duration: 250,
    easing: 'keyboard',
  });
  emitter?.emit('keyboardDidShow', {
    endCoordinates: {height, screenX: 0, screenY: 0, width: 0},
    duration: 250,
    easing: 'keyboard',
  });
}

/** The reverse, so the three runs each start from a keyboard that is down. */
function injectKeyboardHide(): void {
  const emitter = keyboardEmitter();
  const payload = {
    endCoordinates: {height: 0, screenX: 0, screenY: 0, width: 0},
    duration: 250,
    easing: 'keyboard',
  };
  emitter?.emit('keyboardWillHide', payload);
  emitter?.emit('keyboardDidHide', payload);
}

/**
 * The frame, posted where iOS posts it (goal RN-P3).
 *
 * `NotificationCenter.default`, from native, with a real keyboard geometry — so
 * every observer that matters receives it: the pane, AND `RCTKeyboardObserver`,
 * which keeps `useKeyboard()` in step for free. The JS emitter above cannot
 * reach the first of those, which is why the measurement had to move down a
 * layer along with the thing being measured.
 */
function postKeyboardFrame(height: number, durationMs: number): boolean {
  if (!keyboardNative) return false;
  keyboardNative.simulateKeyboard(height, durationMs);
  return true;
}

/** The keyboard's own duration, and therefore how long a block has to last. */
const KEYBOARD_DURATION_MS = 250;

/**
 * Occupy the JS thread with the work this client actually does while a keyboard
 * is coming up.
 *
 * Not a `while (spin) {}` of arithmetic: the requirement is about the composer,
 * and what the composer is doing at that exact moment is re-filtering the
 * mention roster on every keystroke. So the load is `matchMembers` over the
 * stress roster, which is the shipping function on the shipping data — if it
 * ever gets cheap enough not to matter, this load gets weaker with it, honestly.
 */
function burnJs(forMs: number): number {
  const until = Date.now() + forMs;
  let rounds = 0;
  const queries = ['s', 'se', 'seo', '김', '김인', 'da', 'dayeon', 'x'];
  while (Date.now() < until) {
    matchMembers(ROSTER, queries[rounds % queries.length]);
    rounds += 1;
  }
  return rounds;
}

// =============================================================================
// Measuring an animation that deliberately no longer touches the JS thread
// (goal RN-P2, 성재 두 번째 보고: "1 여전히 느려")
//
// The composer now travels on a native-driven `transform`. That is the fix, and
// it breaks the instrument that measured the old one — which is worth stating
// carefully, because "the number went to -1" and "the thing stopped working"
// look identical in a table.
//
// Read out of React Native 0.86.2 rather than assumed:
//
//   * `ReactNativeFeatureFlagsDefaults.h` — `cxxNativeAnimatedEnabled()` is
//     **false**, so animated props go through the Obj-C driver.
//   * `RCTPropsAnimatedNode.mm` — that driver applies them with
//     `synchronouslyUpdateViewOnUIThread`, straight onto the mounted `UIView`.
//     The shadow tree is not told.
//   * `UIManagerBinding.cpp` → `DOM.cpp` — `measureInWindow` answers from
//     `currentRevision`, i.e. the **shadow tree** (with `includeTransform:
//     true`, so a transform that IS committed does count).
//
// So `measureInWindow` cannot see this animation while it runs, and CAN see
// where it ended: `createAnimatedPropsHook.js` calls `scheduleUpdate()` once on
// completion to put the Fiber and shadow trees back in step. Which gives three
// instruments instead of one, each answering something the others cannot:
//
//   `travelStartMs` / `travelSettleMs`   the OLD sampler, unchanged. It reads
//       the shadow tree every frame. With the fix in place it should now report
//       **no movement at all** until the end — that is not a regression, it is
//       the direct evidence that the travel left the commit path.
//
//   `Travel` (below)                     the animated value's own updates,
//       emitted by the native driver. This is the journey, timed.
//
//   `keyboardGapPx`                      unchanged, and still the requirement:
//       the composer's last pixel against the keyboard's first, read after the
//       animation has landed and been committed.
// =============================================================================

/**
 * One keyboard raise, read off the DISPLAY by the native instrument.
 *
 * ## Why the instrument itself had to be replaced (goal RN-P3)
 *
 * The previous version of this type was filled in from JS, by listening to the
 * `Animated.Value` the composer rode. goal RN-P2 shipped it and said what was
 * wrong with it in the same breath: the native driver reports frames back to JS
 * on a JS-scheduled callback, so every time it produced was an UPPER BOUND
 * inflated by however busy the JS thread was — under the one condition worth
 * testing. It could not prove a 17ms ignition and it could not disprove one.
 *
 * So the numbers now come from `modules/momo-keyboard-native`, taken on the main
 * thread off a `CADisplayLink` reading the PRESENTATION layer, and JS collects
 * them afterwards. Being late to collect costs nothing, because the clock that
 * mattered stopped natively.
 *
 * `frames` and `midFlight` are as load-bearing as the times: a run that snapped
 * straight to the destination has `midFlight === 0`, and no pair of timestamps
 * can tell you that.
 */
interface Travel {
  /** ms from the keyboard notification to the first MOVED frame on screen. */
  igniteMs: number;
  /** ms to the first frame on which Core Animation was RUNNING the travel. */
  armedMs: number;
  /** ms to the animation being committed — the ignition latency, unquantised. */
  commitMs: number;
  /** ms to the first frame at the destination. */
  arriveMs: number;
  /** Frames sampled. */
  frames: number;
  /** How many of them were strictly between the two ends — i.e. it glided. */
  midFlight: number;
  /** Where it went, in points. Negative is up. */
  toPx: number;
  /** What duration went INTO `UIView.animate`, in ms. */
  durationMs: number;
  /** False when the native instrument was unavailable and nothing was read. */
  available: boolean;
}

const UNAVAILABLE_TRAVEL: Travel = {
  igniteMs: -1,
  armedMs: -1,
  commitMs: -1,
  arriveMs: -1,
  frames: 0,
  midFlight: 0,
  toPx: 0,
  durationMs: 0,
  available: false,
};

/** Read the native record. `-1` keeps its meaning: could not measure. */
function readNativeTravel(): Travel {
  const record = keyboardNative?.lastTravel();
  if (!record || record.available !== 1) return UNAVAILABLE_TRAVEL;
  return {
    igniteMs: Math.round((record.igniteMs ?? -1) * 10) / 10,
    armedMs: Math.round((record.armedMs ?? -1) * 10) / 10,
    commitMs: Math.round((record.commitMs ?? -1) * 100) / 100,
    arriveMs: Math.round((record.arriveMs ?? -1) * 10) / 10,
    frames: record.frames ?? 0,
    midFlight: record.midFlight ?? 0,
    toPx: Math.round((record.toPx ?? 0) * 10) / 10,
    durationMs: Math.round((record.durationMs ?? 0) * 10) / 10,
    available: true,
  };
}

/** Where the pane is resting, which `measureInWindow` cannot see — see below. */
function nativeLiftPx(): number {
  return keyboardNative?.lastTravel().liftPx ?? 0;
}

interface Results {
  incomingShiftPx: number | null;
  prependShiftPx: number | null;
  keyboardGapPx: number | null;
  keyboardHeightPx: number | null;
  /**
   * How far the native pane is displaced, in points (negative is up).
   *
   * A term in `composerBottomPx` rather than a curiosity: `measureInWindow`
   * reads the shadow tree, which since goal RN-P3 never learns about the lift at
   * all. See the effect that folds them together.
   */
  paneLiftPx: number | null;
  composerBottomPx: number | null;
  keyboardTopPx: number | null;
  /** ms from the keyboard event to the composer's FIRST movement. */
  travelStartMs: number | null;
  /** ms from the keyboard event to the composer reaching its final position. */
  travelSettleMs: number | null;
  /** The same journey, read off the animation itself. See `Travel`. */
  travelIdle: Travel | null;
  travelLoaded: Travel | null;
  travelBlocked: Travel | null;
  /** Was the sender's own message on screen after sending from mid-history? */
  selfSendVisible: boolean | null;
  /** The raw readings behind it, so a failure names its own kind. */
  sentRowY: number | null;
  dockY: number | null;
  /**
   * The list footer's last pixel, in window coordinates — i.e. where the content
   * ENDS. Unlike `sentRowY` this is never null (`ListFooterComponent` is outside
   * the render mask), which is the whole reason it was added: see `tailGapPx`.
   */
  tailBottomY: number | null;
  /**
   * `tailBottomY - dockY`. Zero or less means the end of the conversation is at
   * or above the composer, so the message just sent is on screen; positive is
   * exactly how many points below the fold it was left.
   *
   * This is the instrument the last batch did not have. It reported 「미측정」
   * because the only seam was a wrapper on the sent ROW, and a row the
   * virtualiser never mounted answers `null` — the same reading a broken seam
   * gives. One number that always exists separates "could not measure" from
   * "measured, and it failed", which is the distinction goal RN-P3 was told to
   * stop losing.
   */
  tailGapPx: number | null;
  /** The list's own arithmetic for the same question, from its scroll metrics. */
  selfSendDistancePx: number | null;
  /**
   * The same question from a distance a person actually reaches.
   *
   * The probe above starts where `reachAnchor` left the reader — about twenty
   * screens back in a 200-message fixture — because it was written to prove the
   * anchor rules, not this one. That is a real case and it is not the common
   * one, and a single verdict over both cannot say which of them is fixed. So
   * this one sends from THREE screens back, which is what scrolling up to
   * re-read something looks like.
   */
  nearSendGapPx: number | null;
  nearSendVisible: boolean | null;
  /** How far from the end it started, so the number has a scale. */
  nearSendFromPx: number | null;
  /**
   * What the list's geometry DID during the correction, sampled every 100ms.
   *
   * Here because two rounds of guessing at why the correction stalled both cost
   * a build and both were wrong. A stalled climb has three possible shapes and
   * they are indistinguishable from the final number alone: the scroll never
   * moved, the scroll moved but the content grew as fast, or the scroll moved
   * and something moved it back.
   */
  selfSendTrace: string | null;

  // ---- goal RN-U1 ----------------------------------------------------------
  /**
   * 결함 1. How far the list's scroll offset moved across a keyboard DISMISS.
   *
   * The requirement is that putting the keyboard away costs the reader nothing:
   * the pane slides back down and the conversation is where it was. Since RN-P2
   * the list's height never changes, so this ought to be structurally zero —
   * which is worth measuring rather than asserting, because "ought to be zero"
   * is what the padding model also said before it was measured.
   */
  dismissOffsetShiftPx: number | null;
  /** The same event read from the other end: the anchor row's window position. */
  dismissAnchorShiftPx: number | null;
  /** Constant across the raise, or the slide has turned back into a resize. */
  dismissViewportPx: string | null;
  /**
   * 결함 4. Where the just-sent reply's TOP edge sits relative to the top of the
   * visible conversation, in points, with the keyboard up.
   *
   * Negative is the defect, and it is not a near miss: it means the row is above
   * the clip that `ConversationLayout` draws under the header, so the row is not
   * merely off-screen but cut out of the screen. Positive means it is inside the
   * band a person can see. `nativeLiftPx()` is added because `measureInWindow`
   * reads the shadow tree, which never learns about the pane's UIKit transform.
   */
  threadSentAbovePx: number | null;
  /** The same row against the composer, so both edges of the band are stated. */
  threadSentBelowDockPx: number | null;
  /**
   * The SPLIT (goal RN-U1, 리서치 배치 요청). The same short thread and the same
   * send, with the keyboard DOWN. Visible here and hidden with the keyboard up
   * means the scroll correction is fine and the lift is the cause; hidden in
   * both means the correction is the cause after all.
   */
  threadDownAbovePx: number | null;
  /**
   * buzz's counterexample, answered with a number: the gap between a
   * root-only thread's last pixel and the composer above which it sits.
   */
  threadRootGapPx: number | null;
  /** Raw readings behind the two above, so the verdict can be re-derived. */
  threadTrace: string | null;

  originSentByRn: string | null;
  note: string;
}

const EMPTY: Results = {
  incomingShiftPx: null,
  prependShiftPx: null,
  keyboardGapPx: null,
  keyboardHeightPx: null,
  paneLiftPx: null,
  composerBottomPx: null,
  keyboardTopPx: null,
  travelStartMs: null,
  travelSettleMs: null,
  travelIdle: null,
  travelLoaded: null,
  travelBlocked: null,
  selfSendVisible: null,
  sentRowY: null,
  dockY: null,
  tailBottomY: null,
  tailGapPx: null,
  selfSendDistancePx: null,
  selfSendTrace: null,
  nearSendGapPx: null,
  nearSendVisible: null,
  nearSendFromPx: null,
  dismissOffsetShiftPx: null,
  dismissAnchorShiftPx: null,
  dismissViewportPx: null,
  threadSentAbovePx: null,
  threadSentBelowDockPx: null,
  threadDownAbovePx: null,
  threadRootGapPx: null,
  threadTrace: null,
  originSentByRn: null,
  note: '측정 중…',
};

export default function MeasureHarness(): React.JSX.Element {
  // 스킴을 다크로 못 박는다 (U2). 이 하네스가 그리는 것은 **배송되는 컴포넌트**
  // 이고, 그것들은 이제 스킴을 따라간다 — 시뮬레이터가 라이트면 이 사진/측정도
  // 라이트가 된다. 이 하네스가 답하는 질문(기하·복원·상태)에 스킴은 변수가
  // 아니므로, 답이 기기 설정에 매이지 않게 여기서 고정한다. 스킴이 변수인
  // 캡처는 `measure/surfaces.tsx` 가 인자로 받는다.
  return (
    <FixedScheme scheme="dark">
      <SafeAreaProvider>
        <Harness />
      </SafeAreaProvider>
    </FixedScheme>
  );
}

function Harness(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>(() =>
    Array.from({length: INITIAL_COUNT}, (_, i) => makeMessage(FIRST_SEQ + i)),
  );
  const [results, setResults] = useState<Results>(EMPTY);
  const anchorRef = useRef<View | null>(null);
  const tailRef = useRef<View | null>(null);
  const metricsRef = useRef<TimelineGeometry | null>(null);
  const dockRef = useRef<View | null>(null);
  const listRef = useRef<FlatList<never> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  // Which row carries the measurement wrapper. It starts on the history anchor
  // (claims 1 and 2) and moves to the just-sent row for claim 5, so one seam
  // serves both rather than the list growing a second one.
  const [anchoredSeq, setAnchoredSeq] = useState(ANCHOR_SEQ);
  // When iOS said the keyboard was coming. Travel is timed from HERE, because
  // the gap between focus() and the event belongs to the OS, not to this layout.
  const keyboardEventAtRef = useRef<number | null>(null);
  const [selfSendToken, setSelfSendToken] = useState(0);

  // ---- goal RN-U1: the thread stage ----------------------------------------
  // A SECOND set of seams rather than a reused one. Both compositions cannot be
  // mounted at once — each carries its own `KeyboardPane`, and two panes
  // listening to one UIKit notification is a fixture that measures itself — so
  // the stage swaps, and while it does the refs must not be shared: a ref that
  // survives the swap answers about a view that has been unmounted.
  const [stage, setStage] = useState<'channel' | 'thread'>('channel');
  const [threadReplies, setThreadReplies] = useState<Message[]>([]);
  const [threadAnchoredSeq, setThreadAnchoredSeq] = useState(THREAD_ROOT_SEQ);
  const [threadSelfSendToken, setThreadSelfSendToken] = useState(0);
  const threadAnchorRef = useRef<View | null>(null);
  const threadTailRef = useRef<View | null>(null);
  const threadMetricsRef = useRef<TimelineGeometry | null>(null);
  const threadDockRef = useRef<View | null>(null);
  const threadListRef = useRef<FlatList<never> | null>(null);
  /**
   * The stage itself — the top edge of the visible conversation.
   *
   * This is the line the defect is measured against, and it has to be measured
   * rather than assumed: in the app it is the header's underside, here it is the
   * report panel's, and the number that matters ("is the row above it") is the
   * same question in both. Assuming a constant would make this harness's answer
   * true only of this harness.
   */
  const stageRef = useRef<View | null>(null);

  const keyboard = useKeyboard();
  const ranRef = useRef(false);
  const [keyboardSource, setKeyboardSource] = useState<'os' | 'posted' | 'injected'>('os');
  // Read from inside the async run, which cannot see a re-rendered `keyboard`.
  const keyboardVisibleRef = useRef(false);
  keyboardVisibleRef.current = keyboard.visible;

  // Absolute WINDOW position, not `contentOffset`. A list that fails to correct
  // leaves the offset untouched and slides the content underneath it, so an
  // offset reading says "nothing moved" about the exact failure being hunted.
  // What a person experiences is the line they were reading jumping, which is
  // the anchor row's absolute position — and that number means the same thing
  // in every list implementation.
  const measureNode = useCallback(
    (ref: React.MutableRefObject<View | null>): Promise<number | null> =>
      new Promise(resolve => {
        const node = ref.current;
        if (!node) {
          resolve(null);
          return;
        }
        node.measureInWindow((_x, y) => resolve(y));
      }),
    [],
  );

  const measureAnchor = useCallback(
    (): Promise<number | null> => measureNode(anchorRef),
    [measureNode],
  );

  /** Same reading, plus the height — the tail's question is about its LAST pixel. */
  const measureNodeBottom = useCallback(
    (ref: React.MutableRefObject<View | null>): Promise<number | null> =>
      new Promise(resolve => {
        const node = ref.current;
        if (!node) {
          resolve(null);
          return;
        }
        node.measureInWindow((_x, y, _w, height) => resolve(y + height));
      }),
    [],
  );

  /**
   * Put the reader somewhere the anchor row is mounted, and say so.
   *
   * Scanning rather than one computed offset: row heights are deliberately
   * uneven (that is the point of the fixture), so any arithmetic from "row N is
   * about 90px" is a guess that silently lands on the wrong screen — which is
   * exactly what the first run of this harness did. The scan asks the only
   * authority there is: can the anchor be measured from here.
   */
  const reachAnchor = useCallback(async (): Promise<number | null> => {
    for (let offset = 0; offset <= 14_000; offset += 500) {
      listRef.current?.scrollToOffset({offset, animated: false});
      await wait(220);
      const y = await measureAnchor();
      if (y !== null) {
        // One more nudge so the row is comfortably inside the render window
        // rather than at its edge, where the next update could drop it.
        listRef.current?.scrollToOffset({offset: offset + 300, animated: false});
        await wait(400);
        return measureAnchor();
      }
    }
    return null;
  }, [measureAnchor]);

  // ---- the animation's own trace --------------------------------------------
  // `addListener` on a native-driven value asks the native driver to report each
  // frame back to JS. The reporting is JS-scheduled and therefore late whenever
  // the JS thread is busy — which is exactly the condition under test — so the
  // TIMES here are upper bounds and are read as such. What is not an upper bound
  // is the SEQUENCE: values that only the UI thread could have produced arrive
  // whether or not JS was free to hear them promptly, and that is what separates
  // "it glided while I was busy" from "it froze and then jumped".
  //
  // This watches the harness's own `useKeyboard()` rather than the one inside
  // `ConversationLayout`. Same hook, same events, same tick — and it keeps the
  // shipping component free of a measurement seam it would otherwise carry
  // forever.
  const offsetTraceRef = useRef<{at: number; v: number}[]>([]);
  useEffect(() => {
    const id = keyboard.offset.addListener(({value}) => {
      offsetTraceRef.current.push({at: Date.now(), v: value});
    });
    return () => keyboard.offset.removeListener(id);
  }, [keyboard.offset]);

  const runTravel = useCallback(
    async ({
      load = false,
      block = false,
    }: {
      load?: boolean;
      block?: boolean;
    }): Promise<Travel> => {
      offsetTraceRef.current = [];
      let loadTimer: ReturnType<typeof setInterval> | null = null;
      if (load) {
        // ~12ms of real mention filtering out of every ~16ms. A JS thread that
        // is busy but not wedged, which is what a person typing "@김" produces.
        loadTimer = setInterval(() => {
          burnJs(12);
        }, 16);
      }
      // Posted natively, so the pane's own observer hears it. `simulateKeyboard`
      // hands the post to the main queue and returns, which is exactly the shape
      // the `block` case needs: the notification is already on its way when this
      // thread disappears.
      const posted = postKeyboardFrame(KEYBOARD_HEIGHT_PT, KEYBOARD_DURATION_MS);
      if (!posted) injectKeyboardFrame(KEYBOARD_HEIGHT_PT);
      // The wedged case: the event has arrived and the JS thread goes away for
      // longer than the whole keyboard animation. If the ignition were still a
      // JS callback, nothing could move until this returns.
      if (block) burnJs(KEYBOARD_DURATION_MS + 50);
      await wait(1600);
      if (loadTimer !== null) clearInterval(loadTimer);

      const travel = readNativeTravel();
      if (posted) {
        postKeyboardFrame(0, KEYBOARD_DURATION_MS);
      } else {
        injectKeyboardHide();
      }
      await wait(900);
      offsetTraceRef.current = [];
      return travel;
    },
    [],
  );

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      const next: Results = {...EMPTY, note: ''};

      // ---- 1. a message arrives while the reader is scrolled back -----------
      // Scrolled back on purpose: at the bottom the list follows the tail, and
      // that movement is wanted. The question this measures is the other one —
      // does someone READING history get moved by someone else typing.
      await wait(1200);
      let before = await reachAnchor();
      if (before === null) {
        // Recorded as a failure, never left looking like "still measuring".
        // The spike's own gate 5 shipped a run where an unmeasured case and a
        // 0px case were indistinguishable in the table; that is worse than a
        // loud failure, because it reads as a pass.
        setResults(current => ({
          ...current,
          incomingShiftPx: -1,
          prependShiftPx: -1,
          note: '앵커 행을 찾지 못했다',
        }));
        return;
      }

      setMessages(current => [...current, makeMessage(FIRST_SEQ + INITIAL_COUNT)]);
      await wait(900);
      let after = await measureAnchor();
      next.incomingShiftPx =
        after === null ? -1 : Math.round(Math.abs(after - before) * 10) / 10;

      // ---- 2. older messages are prepended ---------------------------------
      await wait(400);
      before = await measureAnchor();
      if (before === null) {
        next.prependShiftPx = -1;
      } else {
        // 20 older rows at the head, the shape `loadOlder` produces.
        setMessages(current => [
          ...Array.from({length: 20}, (_, i) => makeMessage(FIRST_SEQ - 20 + i)),
          ...current,
        ]);
        // Retried, for the same reason the self-send probe is: one read at a
        // fixed delay after a prepend is a bet on how far the virtualiser has
        // got, and losing it prints 측정 실패 about a list that is behaving.
        after = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await wait(attempt === 0 ? 1200 : 300);
          after = await measureAnchor();
          if (after !== null) break;
        }
        next.prependShiftPx =
          after === null ? -1 : Math.round(Math.abs(after - before) * 10) / 10;
      }
      // Merged, not replaced: the keyboard and Origin probes run on their own
      // schedules and have already written into this object. Rebuilding it from
      // the blank record is how the Origin reading kept disappearing.
      setResults(current => ({
        ...current,
        incomingShiftPx: next.incomingShiftPx,
        prependShiftPx: next.prependShiftPx,
        note: next.note,
      }));

      // ---- 2b. my own message comes to me (RN-C5) --------------------------
      // The reader is still mid-history from the step above, which is exactly
      // the condition the defect needed: `following` is false, so before the
      // fix a send landed below the fold with nothing to say it had happened.
      const lastSeq = FIRST_SEQ + INITIAL_COUNT + 1;
      setAnchoredSeq(lastSeq);
      setMessages(current => [...current, makeMessage(lastSeq)]);
      setSelfSendToken(token => token + 1);
      // Visible means: the row exists AND its top edge is above the composer.
      //
      // **Two seams, because one of them can only fail silently.** The row
      // wrapper answers `null` for a row the virtualiser never mounted — which
      // is precisely the failure being hunted, so the instrument goes blind at
      // the exact moment it matters and the last batch had to write 「미측정」.
      // The footer wrapper (`tailRef`) is outside the render mask and therefore
      // ALWAYS mounted, so `tailBottomY` exists at every scroll position and
      // says, in points, where the conversation ends.
      //
      // Together they close the gap the ticket named:
      //   row measurable            → the direct answer, and the verdict
      //   row null, tail below dock → the end of the list is itself below the
      //                               fold, so the row cannot be on screen. A
      //                               real FAIL, provable without the row.
      //   row null, tail above dock → the list IS at the end and the wrapper
      //                               still did not attach. Only THIS is 미측정.
      // Sample the list's geometry THROUGH the correction, not just after it.
      const offsets: number[] = [];
      const heights: number[] = [];
      const sampler = setInterval(() => {
        const geometry = metricsRef.current;
        if (geometry === null) return;
        offsets.push(Math.round(geometry.offsetY));
        heights.push(Math.round(geometry.contentHeight));
      }, 100);

      let sentY: number | null = null;
      let dockY: number | null = null;
      let tailBottom: number | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        await wait(400);
        sentY = await measureAnchor();
        dockY = await measureNode(dockRef);
        tailBottom = await measureNodeBottom(tailRef);
        // The correction is bounded (`SELF_SEND_PIN_MS`), so keep looking until
        // the row is there rather than reading one frame into a travel that is
        // still running and calling the mid-point the answer.
        if (sentY !== null && dockY !== null) break;
      }
      clearInterval(sampler);
      next.selfSendTrace =
        offsets.length === 0
          ? '샘플 없음'
          : `오프셋 ${offsets[0]}→${offsets[offsets.length - 1]}(최대 ${Math.max(
              ...offsets,
            )}) · 콘텐츠 ${heights[0]}→${heights[heights.length - 1]}(최대 ${Math.max(
              ...heights,
            )}) · n=${offsets.length}`;
      next.sentRowY = sentY;
      next.dockY = dockY;
      next.tailBottomY = tailBottom;
      next.tailGapPx =
        tailBottom === null || dockY === null
          ? null
          : Math.round((tailBottom - dockY) * 10) / 10;
      const geometry = metricsRef.current;
      next.selfSendDistancePx =
        geometry === null || geometry.contentHeight <= 0
          ? null
          : Math.round(
              (geometry.contentHeight -
                (geometry.offsetY + geometry.viewportHeight)) *
                10,
            ) / 10;
      // `null` is NOT `false`, and `false` is NOT `null`. The rule is the one
      // the anchor scan states: an unmeasured case must never be reported as a
      // measured one — and the converse, which the last batch paid for, is that
      // a case the instrument CAN see must not be filed as unmeasured.
      next.selfSendVisible =
        sentY !== null && dockY !== null
          ? sentY < dockY
          : next.tailGapPx !== null && next.tailGapPx > 1
          ? false
          : null;
      setResults(current => ({
        ...current,
        selfSendVisible: next.selfSendVisible,
        sentRowY: next.sentRowY,
        dockY: next.dockY,
        tailBottomY: next.tailBottomY,
        tailGapPx: next.tailGapPx,
        selfSendDistancePx: next.selfSendDistancePx,
        selfSendTrace: next.selfSendTrace,
      }));
      console.log(
        `MOMO_MEASURE_SELFSEND ${JSON.stringify({
          sentRowY: sentY,
          dockY,
          tailBottomY: tailBottom,
          tailGapPx: next.tailGapPx,
          distanceFromEndPx: next.selfSendDistancePx,
          visible: next.selfSendVisible,
        })}`,
      );

      // ---- 2c. …and from a distance a person actually reaches ---------------
      // Same rule, ordinary conditions. Three screens back is what scrolling up
      // to re-read something looks like; twenty is what the fixture above
      // happens to produce. Both are worth knowing and they are not one number.
      // Get to the ACTUAL tail first. The probe above deliberately leaves the
      // list wherever its correction ran out, and measuring "three screens back"
      // from there measures three screens back from a failure — which is not the
      // ordinary case, it is the extreme case plus three screens. The first
      // version of this probe did exactly that and reported a number that looked
      // like a second failure and was the first one wearing a hat.
      for (let attempt = 0; attempt < 40; attempt++) {
        listRef.current?.scrollToEnd({animated: false});
        await wait(150);
        const at = metricsRef.current;
        if (
          at !== null &&
          at.contentHeight > 0 &&
          at.contentHeight - (at.offsetY + at.viewportHeight) <= 1
        ) {
          break;
        }
      }
      await wait(600);
      const geometryNow = metricsRef.current;
      if (geometryNow !== null && geometryNow.viewportHeight > 0) {
        const backBy = geometryNow.viewportHeight * 3;
        listRef.current?.scrollToOffset({
          offset: Math.max(0, geometryNow.offsetY - backBy),
          animated: false,
        });
        await wait(900);
        const from = metricsRef.current;
        next.nearSendFromPx =
          from === null
            ? null
            : Math.round(
                (from.contentHeight - (from.offsetY + from.viewportHeight)) * 10,
              ) / 10;

        const nearSeq = lastSeq + 1;
        setAnchoredSeq(nearSeq);
        setMessages(current => [...current, makeMessage(nearSeq)]);
        setSelfSendToken(token => token + 1);

        let nearSent: number | null = null;
        let nearDock: number | null = null;
        let nearTail: number | null = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          await wait(400);
          nearSent = await measureAnchor();
          nearDock = await measureNode(dockRef);
          nearTail = await measureNodeBottom(tailRef);
          if (nearSent !== null && nearDock !== null) break;
        }
        next.nearSendGapPx =
          nearTail === null || nearDock === null
            ? null
            : Math.round((nearTail - nearDock) * 10) / 10;
        next.nearSendVisible =
          nearSent !== null && nearDock !== null
            ? nearSent < nearDock
            : next.nearSendGapPx !== null && next.nearSendGapPx > 1
            ? false
            : null;
        setResults(current => ({
          ...current,
          nearSendGapPx: next.nearSendGapPx,
          nearSendVisible: next.nearSendVisible,
          nearSendFromPx: next.nearSendFromPx,
        }));
      }

      // ---- 3. the keyboard --------------------------------------------------
      // `focus()` rather than a tap, because a simulator cannot be driven by a
      // script — spike #837 found React Native's elements absent from the
      // accessibility tree and coordinate clicks landing nowhere. Focus itself
      // works (the caret appears), and on a device it raises the real keyboard.
      // Sample the dock every frame ACROSS the whole keyboard raise, whichever
      // way it arrives. The first version of this put the sampler inside the
      // injection branch, and the run where the simulator raised a real keyboard
      // measured nothing at all — the one case most worth having.
      //
      // Time is measured from the KEYBOARD EVENT, not from `focus()`: the gap
      // between them is iOS's business, and charging it to the composer would
      // flatter or damn this client for something it does not control.
      const trace: {t: number; y: number}[] = [];
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        dockRef.current?.measureInWindow((_x, y) => {
          const at = keyboardEventAtRef.current;
          if (at !== null) trace.push({t: Date.now() - at, y});
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      inputRef.current?.focus();
      await wait(2500);

      // ...but on THIS simulator it does not, even with the hardware keyboard
      // disconnected in both the global and the per-device preference, and the
      // menu toggle needs the UI automation that is unavailable here. Rather
      // than leave the requirement unmeasured, the same event channel iOS uses
      // is driven directly with a real keyboard geometry.
      //
      // Honest about what this proves. Since goal RN-P3 the frame is posted on
      // `NotificationCenter.default` from native, which is the SAME channel
      // UIKit posts on — so the pane's observer, `RCTKeyboardObserver` and
      // `useKeyboard` all receive it exactly as they would a real keyboard, and
      // no part of the path is stubbed. What it still does not prove is that
      // iOS posts the notification, which is UIKit's contract and was never in
      // question. `keyboardSource` records which path produced the number so the
      // PR cannot claim the stronger one by accident.
      if (!keyboardVisibleRef.current) {
        const posted = postKeyboardFrame(
          KEYBOARD_HEIGHT_PT,
          KEYBOARD_DURATION_MS,
        );
        if (!posted) injectKeyboardFrame(KEYBOARD_HEIGHT_PT);
        setKeyboardSource(posted ? 'posted' : 'injected');
        await wait(1200);
      }

      sampling = false;
      if (trace.length > 2) {
        const start = trace[0].y;
        const end = trace[trace.length - 1].y;
        const moved = trace.find(point => Math.abs(point.y - start) > 1);
        const settled = trace.find(point => Math.abs(point.y - end) <= 1);
        setResults(current => ({
          ...current,
          travelStartMs: moved ? moved.t : -1,
          travelSettleMs: settled ? settled.t : -1,
        }));
        console.log(
          `MOMO_MEASURE_TRAVEL ${JSON.stringify({
            samples: trace.length,
            startY: start,
            endY: end,
            travelStartMs: moved ? moved.t : -1,
            travelSettleMs: settled ? settled.t : -1,
          })}`,
        );
      }

      // ---- 4. the same journey, three ways, read off the animation ----------
      // See the note above `Travel`. This is the instrument that survives the
      // move to the native driver, and the third run is the one that answers
      // the question 성재's second report actually asks: does a busy JS thread
      // still make the composer late.
      // Put the keyboard back down FIRST, and wait for iOS to finish doing it.
      // Step 3 above left it up (that is how it measured the gap), and a "raise"
      // that starts at 336 travels nowhere: the first run of this section
      // reported 0 mid-flight samples and start == settle, which reads exactly
      // like a broken animation and was a broken measurement.
      Keyboard.dismiss();
      if (!postKeyboardFrame(0, KEYBOARD_DURATION_MS)) injectKeyboardHide();
      await wait(1500);
      const idle = await runTravel({});
      const loaded = await runTravel({load: true});
      const blocked = await runTravel({block: true});
      setResults(current => ({
        ...current,
        travelIdle: idle,
        travelLoaded: loaded,
        travelBlocked: blocked,
      }));
      console.log(
        `MOMO_MEASURE_TRAVEL_V2 ${JSON.stringify({idle, loaded, blocked})}`,
      );

      // ---- 5. putting the keyboard away costs the reader nothing (RN-U1 1) --
      // 성재: "채팅창은 여는 건 성공했는데, 그냥 다시 닫을 때는 어떻게 해야 해?"
      //
      // The fix for that is a dismiss GESTURE (`keyboardDismissMode="on-drag"`
      // and the tap rule in `MessageRow`), and neither can be driven here — a
      // simulator cannot be dragged or tapped by a script. What CAN be measured
      // is the thing the gesture must not cost, and it is the half a person
      // actually notices: after the keyboard goes down, is the conversation
      // still where they left it.
      //
      // It should be structurally free — since RN-P2 the pane slides rather than
      // resizes, so no layout pass reaches the list and nothing asks it to
      // scroll. "Should be structurally free" is also what the padding model
      // said about itself before anyone measured it, which is why this is a
      // reading and not a claim.
      const anchorBeforeRaise = await measureAnchor();
      if (!postKeyboardFrame(KEYBOARD_HEIGHT_PT, KEYBOARD_DURATION_MS)) {
        injectKeyboardFrame(KEYBOARD_HEIGHT_PT);
      }
      await wait(1500);
      const raised = metricsRef.current ? {...metricsRef.current} : null;
      Keyboard.dismiss();
      if (!postKeyboardFrame(0, KEYBOARD_DURATION_MS)) injectKeyboardHide();
      await wait(1500);
      const lowered = metricsRef.current ? {...metricsRef.current} : null;
      const anchorAfterLower = await measureAnchor();

      const dismissOffsetShiftPx =
        raised === null || lowered === null
          ? null
          : Math.round(Math.abs(lowered.offsetY - raised.offsetY) * 10) / 10;
      const dismissAnchorShiftPx =
        anchorBeforeRaise === null || anchorAfterLower === null
          ? -1 // 잴 수 없었다. 0 이 아니다 — 그 둘을 같은 칸에 적으면 거짓말이다.
          : Math.round(Math.abs(anchorAfterLower - anchorBeforeRaise) * 10) / 10;
      const dismissViewportPx =
        raised === null || lowered === null
          ? null
          : `뷰포트 ${Math.round(raised.viewportHeight)}→${Math.round(
              lowered.viewportHeight,
            )} · 오프셋 ${Math.round(raised.offsetY)}→${Math.round(
              lowered.offsetY,
            )}`;
      setResults(current => ({
        ...current,
        dismissOffsetShiftPx,
        dismissAnchorShiftPx,
        dismissViewportPx,
      }));
      console.log(
        `MOMO_MEASURE_DISMISS ${JSON.stringify({
          dismissOffsetShiftPx,
          dismissAnchorShiftPx,
          anchorBeforeRaise,
          anchorAfterLower,
          raised,
          lowered,
        })}`,
      );

      // ---- 6. a short thread, with the keyboard up (RN-U1 결함 4) -----------
      // 성재: "스레드에서도 뭔가 채팅을 하면 위에 숨겨져 있어서 채팅 닫아야
      // 보이더라."
      //
      // Every case above ran against 200 rows, and 200 rows is the one fixture in
      // which this cannot reproduce: taller than the viewport means the list
      // scrolls, and a list that scrolls puts its tail at the bottom where the
      // lift cannot reach it. So the stage swaps to what `ThreadPanel` actually
      // renders — the same `ConversationLayout`, the same `Timeline` with a
      // thread's props, the same `Composer` — holding a root and one reply.
      //
      // The reading is the row's top edge against the top of the visible
      // conversation. Negative does not mean "a bit high": it means the row is
      // above the clip, i.e. cut out of the screen rather than merely scrolled
      // past, which is why closing the keyboard was the only thing that brought
      // it back.
      setStage('thread');
      setThreadReplies([]);
      setThreadAnchoredSeq(THREAD_ROOT_SEQ);
      await wait(1500);

      // 6a. The counterexample the research batch brought back: buzz tried
      // bottom-packing a thread and reverted it, because the ROOT ended up jammed
      // against the composer (`thread_detail_page.dart:253-256`). That is a claim
      // about a gap, so it is answered with the gap rather than with an opinion —
      // and a thread holding nothing but its root is the worst case for it.
      const rootBottom = await measureNodeBottom(threadAnchorRef);
      const rootDockTop = await measureNode(threadDockRef);
      const threadRootGapPx =
        rootBottom === null || rootDockTop === null
          ? null
          : Math.round((rootDockTop - rootBottom) * 10) / 10;

      // 6b. **The split**, and it is the reading that decides whose hypothesis is
      // right. Same short thread, same send, keyboard DOWN.
      //
      // If a reply sent with the keyboard down is ALSO hidden, the cause is the
      // scroll correction — the ticket's guess, RN-P3's family. If it is visible
      // with the keyboard down and hidden with it up, the correction is doing its
      // job and the cause is the lift meeting a top-aligned short list. One
      // measurement separates them, so neither has to be argued.
      const downSeq = THREAD_ROOT_SEQ + 1;
      setThreadAnchoredSeq(downSeq);
      setThreadReplies([makeShortMessage(downSeq, THREAD_ROOT.id)]);
      setThreadSelfSendToken(token => token + 1);
      let downY: number | null = null;
      let downStageY: number | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await wait(350);
        downY = await measureNode(threadAnchorRef);
        downStageY = await measureNode(stageRef);
        if (downY !== null && downStageY !== null) break;
      }
      const threadDownAbovePx =
        downY === null || downStageY === null
          ? null
          : Math.round((downY + nativeLiftPx() - downStageY) * 10) / 10;
      setResults(current => ({...current, threadRootGapPx, threadDownAbovePx}));
      console.log(
        `MOMO_MEASURE_THREADDOWN ${JSON.stringify({
          threadRootGapPx,
          threadDownAbovePx,
          downY,
          downStageY,
          liftWhileDown: nativeLiftPx(),
        })}`,
      );

      if (!postKeyboardFrame(KEYBOARD_HEIGHT_PT, KEYBOARD_DURATION_MS)) {
        injectKeyboardFrame(KEYBOARD_HEIGHT_PT);
      }
      await wait(1500);

      // The reply, exactly as `ThreadPanel.onSend` issues it: the echo row and
      // the token in the same commit, before any round trip.
      const replySeq = THREAD_ROOT_SEQ + 2;
      setThreadAnchoredSeq(replySeq);
      setThreadReplies(current => [
        ...current,
        makeShortMessage(replySeq, THREAD_ROOT.id),
      ]);
      setThreadSelfSendToken(token => token + 1);

      let replyY: number | null = null;
      let stageY: number | null = null;
      let threadDockY: number | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        await wait(400);
        replyY = await measureNode(threadAnchorRef);
        stageY = await measureNode(stageRef);
        threadDockY = await measureNode(threadDockRef);
        if (replyY !== null && stageY !== null) break;
      }
      // `measureInWindow` reads the shadow tree, and since RN-P3 the lift is a
      // UIKit transform the shadow tree never hears about. Without this term the
      // harness would report the position the row WOULD have had if the keyboard
      // were down — which is the one number that cannot answer this question.
      const threadLift = nativeLiftPx();
      const threadSentAbovePx =
        replyY === null || stageY === null
          ? null
          : Math.round((replyY + threadLift - stageY) * 10) / 10;
      const threadSentBelowDockPx =
        replyY === null || threadDockY === null
          ? null
          : Math.round((threadDockY - replyY) * 10) / 10;
      const threadGeometry = threadMetricsRef.current;
      const threadTrace = `행 ${
        replyY === null ? '미마운트' : Math.round(replyY)
      } · 스테이지 윗변 ${
        stageY === null ? '?' : Math.round(stageY)
      } · 컴포저 윗변 ${
        threadDockY === null ? '?' : Math.round(threadDockY)
      } · 팬 리프트 ${Math.round(threadLift)} · 콘텐츠 ${
        threadGeometry === null ? '?' : Math.round(threadGeometry.contentHeight)
      }/뷰포트 ${
        threadGeometry === null ? '?' : Math.round(threadGeometry.viewportHeight)
      }`;
      setResults(current => ({
        ...current,
        threadSentAbovePx,
        threadSentBelowDockPx,
        threadTrace,
      }));
      console.log(
        `MOMO_MEASURE_THREADSEND ${JSON.stringify({
          replyY,
          stageY,
          threadDockY,
          threadLift,
          threadSentAbovePx,
          threadSentBelowDockPx,
          contentHeight: threadGeometry?.contentHeight ?? null,
          viewportHeight: threadGeometry?.viewportHeight ?? null,
        })}`,
      );
    })();
    // `measureNodeBottom` joins the list because goal RN-U1 reads it too; every
    // one of these is a `useCallback` with an empty dependency array, so the
    // effect's own `ranRef` guard remains the only thing that decides it runs
    // once.
  }, [measureAnchor, reachAnchor, measureNode, measureNodeBottom, runTravel]);

  // The instant iOS announced the keyboard. Subscribed here rather than read
  // from `useKeyboard` because a state update arrives a render later, and a
  // render later is the very quantity being measured.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardWillShow', () => {
      if (keyboardEventAtRef.current === null) {
        keyboardEventAtRef.current = Date.now();
      }
    });
    return () => sub.remove();
  }, []);

  // Measured in its own effect because it has to run AFTER the keyboard is up,
  // and the dock's position is only meaningful then. (`dockRef` is declared with
  // the other refs at the top — the travel sampler needs it too.)
  useEffect(() => {
    if (!keyboard.visible) return;
    // **The shadow tree does not know the pane has moved, and after goal RN-P3
    // it never will.** `measureInWindow` answers from `currentRevision` — the
    // shadow tree — and the lift is now a UIKit animation on the mounted view's
    // own transform. There is no `scheduleUpdate()` at the end to put the two
    // trees back in step, because there is no `Animated` in the loop to call it.
    //
    // Which is not a hole in the measurement, it is a term in it: the pane's
    // displacement is a number the native side can be asked for directly
    // (`liftPx`), so the composer's true bottom edge is the shadow-tree reading
    // PLUS that displacement. Both halves are measured; neither is assumed.
    //
    // The 900ms is now only "long enough for the 250ms animation to have
    // landed", so that `liftPx` is the settled destination rather than a value
    // still being interpolated.
    const timer = setTimeout(() => {
      // The dock's bottom edge in WINDOW coordinates. Paired with the screen
      // height and the keyboard height in the fold below, that is the whole
      // question: is the composer's last pixel above the keyboard's first one.
      dockRef.current?.measureInWindow((_x, y, _w, height) => {
        const lift = nativeLiftPx(); // negative: the pane is up by this much
        setResults(current => ({
          ...current,
          keyboardHeightPx: keyboard.height,
          paneLiftPx: Math.round(lift * 10) / 10,
          composerBottomPx: Math.round((y + height + lift) * 10) / 10,
        }));
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [keyboard.visible, keyboard.height]);

  const onLayoutRoot = useCallback(
    (event: {nativeEvent: {layout: {height: number}}}) => {
      rootHeightRef.current = event.nativeEvent.layout.height;
    },
    [],
  );
  const rootHeightRef = useRef(0);

  // Fold the keyboard numbers once both halves are known.
  useEffect(() => {
    if (results.composerBottomPx === null || results.keyboardHeightPx === null) {
      return;
    }
    if (results.keyboardGapPx !== null) return;
    const keyboardTop = rootHeightRef.current - results.keyboardHeightPx;
    const gap = Math.round((keyboardTop - results.composerBottomPx) * 10) / 10;
    setResults(current => ({
      ...current,
      keyboardTopPx: Math.round(keyboardTop * 10) / 10,
      // Positive: the composer's bottom edge sits ABOVE the keyboard's top
      // edge, which is the whole requirement. Negative means covered.
      keyboardGapPx: gap,
    }));
    // One JSON line, so the numbers can be read off the Metro log as well as
    // off a screenshot. A screenshot that has to be squinted at is how a
    // measurement quietly becomes an anecdote.
    console.log(
      `MOMO_MEASURE ${JSON.stringify({
        incomingShiftPx: results.incomingShiftPx,
        prependShiftPx: results.prependShiftPx,
        keyboardGapPx: gap,
        keyboardHeightPx: results.keyboardHeightPx,
        composerBottomPx: results.composerBottomPx,
        paneLiftPx: results.paneLiftPx,
        keyboardTopPx: keyboardTop,
        screenHeightPx: rootHeightRef.current,
        keyboardSource,
      })}`,
    );
  }, [results, keyboardSource]);

  // ---- the Origin probe -----------------------------------------------------
  // Spike #837 gate 3 found that React Native's WebSocket sends an `Origin`
  // header — the opposite of what the pre-spike research assumed — and that this
  // repo's Centrifugo `allowed_origins` therefore rejects every LAN and loopback
  // address. That is reproduced here rather than quoted: the socket below opens
  // against a zero-dependency Node stub (`measure/origin-stub.mjs`) whose only
  // job is to report the header it was handed.
  useEffect(() => {
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket('ws://127.0.0.1:18991/probe');
      socket.onmessage = event => {
        const origin = String(event.data);
        setResults(current => ({...current, originSentByRn: origin}));
        console.log(`MOMO_MEASURE_ORIGIN ${origin}`);
      };
      socket.onerror = () => {
        setResults(current => ({
          ...current,
          originSentByRn: current.originSentByRn ?? '(스텁 미기동)',
        }));
      };
    } catch {
      /* the stub is optional; the scroll numbers do not depend on it */
    }
    return () => socket?.close();
  }, []);

  return (
    <View style={styles.root} onLayout={onLayoutRoot}>
      <ScrollView style={styles.report} contentContainerStyle={styles.reportBody}>
        <Text style={styles.title}>RN-U1 / RN-P3 측정</Text>
        {/* ---- goal RN-U1 ---------------------------------------------- */}
        <Row
          label="키보드를 닫은 뒤 리스트 위치"
          value={
            results.dismissAnchorShiftPx === null
              ? '측정 중…'
              : `${px(results.dismissAnchorShiftPx)} · 오프셋 ${px(
                  results.dismissOffsetShiftPx,
                )}`
          }
          pass={passes(results.dismissAnchorShiftPx)}
        />
        <Row
          label="짧은 스레드에서 보낸 내 답글이 보이는가"
          value={
            results.threadSentAbovePx === null
              ? '측정 중…'
              : results.threadSentAbovePx < 0
              ? `잘림(대화 윗변보다 ${signedPx(
                  -results.threadSentAbovePx,
                )} 위)`
              : `보인다 (윗변에서 ${signedPx(
                  results.threadSentAbovePx,
                )} 아래 · 컴포저까지 ${signedPx(results.threadSentBelowDockPx)})`
          }
          pass={
            results.threadSentAbovePx === null
              ? null
              : results.threadSentAbovePx >= 0 &&
                (results.threadSentBelowDockPx ?? -1) > 0
          }
        />
        <Text style={styles.meta}>
          {`키보드 닫힘: ${results.dismissViewportPx ?? '측정 중…'}`}
        </Text>
        <Text style={styles.meta}>
          {`짧은 스레드: ${results.threadTrace ?? '측정 중…'}`}
        </Text>
        <Row
          label="같은 전송을 키보드 내린 채로 (원인 가르기)"
          value={
            results.threadDownAbovePx === null
              ? '측정 중…'
              : results.threadDownAbovePx >= 0
              ? `보인다 (윗변에서 ${signedPx(results.threadDownAbovePx)} 아래) — 원인은 리프트지 스크롤이 아니다`
              : `잘림 ${signedPx(results.threadDownAbovePx)} — 원인이 스크롤 쪽이다`
          }
          pass={
            results.threadDownAbovePx === null
              ? null
              : results.threadDownAbovePx >= 0
          }
        />
        <Text style={styles.meta}>
          {`루트만 있는 스레드에서 루트와 컴포저 사이 (buzz 반례): ${
            results.threadRootGapPx === null ? '측정 중…' : `${results.threadRootGapPx}px`
          }`}
        </Text>

        <Row
          label="새 메시지 도착 시 앵커 이동"
          value={px(results.incomingShiftPx)}
          pass={passes(results.incomingShiftPx)}
        />
        <Row
          label="과거 프리펜드 시 앵커 이동"
          value={px(results.prependShiftPx)}
          pass={passes(results.prependShiftPx)}
        />
        <Row
          label="컴포저 하단과 키보드 상단 간격"
          value={px(results.keyboardGapPx)}
          pass={results.keyboardGapPx === null ? null : results.keyboardGapPx >= 0}
        />
        {/* The shadow-tree sampler, kept as a NEGATIVE control. It measured the
            original animation because that one committed every frame. Since the
            lift became a UIKit animation on the mounted view, this can no longer
            see it at all and should read 측정 실패 in both rows — which is the
            direct evidence that the travel left React's commit path entirely,
            not a hole in the measurement. The real numbers are the three below,
            taken natively. */}
        <Row
          label="[섀도트리·음성대조] 커밋 경로에서 본 이동"
          value={
            results.travelStartMs === null
              ? '측정 중…'
              : results.travelStartMs < 0
              ? '이동 없음(정상 — 커밋 밖)'
              : `${ms(results.travelStartMs)} — 커밋 경로로 샜다`
          }
          // 여기서 숫자가 나오면 리프트가 다시 React 커밋을 타고 있다는 뜻이다.
          pass={
            results.travelStartMs === null ? null : results.travelStartMs < 0
          }
        />
        {/* 판정: 첫 이동 ≤ 17ms(한 프레임) · 도착 ≤ 300ms. 시각은 네이티브
            CADisplayLink 의 targetTimestamp — 움직인 픽셀이 화면에 뜨는 시각 —
            에서 알림 수신 시각을 뺀 값이다. */}
        <TravelRow label="[네이티브] 한가한 JS" travel={results.travelIdle} />
        <TravelRow label="[네이티브] 바쁜 JS (75%)" travel={results.travelLoaded} />
        <TravelRow label="[네이티브] JS 완전 차단" travel={results.travelBlocked} />
        <Row
          label="중간에서 보낸 내 메시지가 보이는가"
          value={
            results.selfSendVisible === null
              ? results.dockY === null
                ? '측정 중…'
                : '측정 실패(끝은 화면 안인데 행 앵커 미부착)'
              : results.selfSendVisible
              ? '보인다'
              : results.sentRowY === null
              ? `가려짐(대화의 끝이 ${results.tailGapPx}px 아래)`
              : '가려짐'
          }
          pass={results.selfSendVisible}
        />
        <Row
          label="세 화면 뒤에서 보냈을 때 (일상 거리)"
          value={
            results.nearSendVisible === null
              ? '측정 중…'
              : `${
                  results.nearSendVisible ? '보인다' : '가려짐'
                } (출발 ${signedPx(results.nearSendFromPx)} → 남음 ${signedPx(
                  results.nearSendGapPx,
                )})`
          }
          pass={results.nearSendVisible}
        />
        <Text style={styles.meta}>
          {`보낸 행 y ${
            results.dockY === null ? '측정 중…' : px(results.sentRowY) === '측정 중…' ? '행 미마운트' : px(results.sentRowY)
          } · 컴포저 상단 y ${px(results.dockY)}`}
        </Text>
        <Text style={styles.meta}>
          {`대화 끝 y ${px(results.tailBottomY)} · 컴포저까지 ${signedPx(
            results.tailGapPx,
          )} · 리스트가 보는 끝까지 거리 ${signedPx(results.selfSendDistancePx)}`}
        </Text>
        <Text style={styles.meta}>
          {`전송 중 리스트 기하: ${results.selfSendTrace ?? '측정 중…'}`}
        </Text>
        <Text style={styles.meta}>
          {`키보드 높이 ${px(results.keyboardHeightPx)} · 컴포저 하단 ${px(
            results.composerBottomPx,
          )} · 키보드 상단 ${px(results.keyboardTopPx)} · 팬 리프트 ${signedPx(
            results.paneLiftPx,
          )}`}
        </Text>
        <Text style={styles.meta}>
          {`키보드 프레임 출처: ${
            keyboardSource === 'os'
              ? 'iOS 이벤트'
              : keyboardSource === 'posted'
              ? '네이티브 알림 주입(iOS 와 같은 NotificationCenter 채널)'
              : 'JS 이미터 주입(네이티브 모듈 미탑재 — 옛 경로를 잰 것이다)'
          }`}
        </Text>
        {/* The raw native record for the last run, so a surprising ms figure can
            be traced rather than argued about. `요청 지속시간` is what went INTO
            `UIView.animate`; if 도착 is not close to it, the difference belongs
            to the environment (a simulator slowing animations) rather than to
            this layout — and that has to be visible, not inferred. */}
        <Text style={styles.meta}>
          {`마지막 이동 원본: 요청 지속시간 ${ms(
            results.travelBlocked?.durationMs ?? null,
          )} · 프레임 ${results.travelBlocked?.frames ?? '\u2026'} · 도달 ${signedPx(
            results.travelBlocked?.toPx ?? null,
          )} · 시간배율 ${
            results.travelBlocked && results.travelBlocked.durationMs > 0
              ? (
                  results.travelBlocked.arriveMs /
                  results.travelBlocked.durationMs
                ).toFixed(2)
              : '\u2026'
          }x`}
        </Text>
        <Text style={styles.meta}>
          {`RN 이 보낸 Origin: ${results.originSentByRn ?? '측정 중…'}`}
        </Text>

        <Text style={styles.meta}>{`판정 기준: 앵커 이동 ≤ 2px`}</Text>
      </ScrollView>

      <View ref={stageRef} collapsable={false} style={styles.stage}>
        {/* The SHIPPING composition, not a lookalike. An earlier revision of
            this harness put `Timeline` and `Composer` side by side in a plain
            View and measured the composer 335px behind the keyboard — a true
            statement about a tree the app never renders. That is why the
            keyboard handling is a named component now.

            goal RN-U1 adds a second one beside it, and for the same reason: the
            channel composition cannot reproduce a defect that needs a
            conversation shorter than the screen. What is below is `ThreadPanel`'s
            own tree, prop for prop — `markReplies={false}`, `reachedStart`,
            `status="ready"` (a thread always has its root, so it is never
            empty), and the composer's own 답글 labels. Only the data is a
            fixture, which is what a measurement wants; faking the 18-member
            `useTimeline` instead would have measured the fake. */}
        {stage === 'thread' ? (
          <ConversationLayout
            list={
              <Timeline
                messages={[THREAD_ROOT, ...threadReplies]}
                directory={DIRECTORY}
                status="ready"
                myMemberId={SELF_ID}
                nowMs={BASE_MS}
                reachedStart
                markReplies={false}
                selfSendToken={threadSelfSendToken}
                anchorSeq={threadAnchoredSeq}
                anchorRef={threadAnchorRef}
                tailRef={threadTailRef}
                metricsRef={threadMetricsRef}
                listRef={threadListRef as never}
              />
            }
            composer={
              <View ref={threadDockRef} collapsable={false}>
                {/* `ThreadPanel.tsx` puts this line in the composer slot while a
                    thread has no replies, and it is load-bearing for the one
                    number buzz's counterexample is about: it is what stands
                    between a bottom-packed root and the input. A harness that
                    dropped it would report that gap smaller than the app's. */}
                {threadReplies.length === 0 ? (
                  <Text style={styles.threadInvite}>
                    첫 답글을 남겨 이 대화를 이어가세요.
                  </Text>
                ) : null}
                <Composer
                  channelLabel="스레드"
                  directory={DIRECTORY}
                  placeholder="답글 쓰기"
                  sendLabel="답글 보내기"
                  onSend={() => {}}
                />
              </View>
            }
          />
        ) : (
        <ConversationLayout
          list={
            <Timeline
              messages={messages}
              directory={DIRECTORY}
              status="ready"
              myMemberId={SELF_ID}
              nowMs={BASE_MS}
              selfSendToken={selfSendToken}
              anchorSeq={anchoredSeq}
              anchorRef={anchorRef}
              tailRef={tailRef}
              metricsRef={metricsRef}
              listRef={listRef as never}
            />
          }
          composer={
            <View ref={dockRef} collapsable={false}>
              <Composer
                channelLabel="측정"
                directory={DIRECTORY}
                inputRef={inputRef}
                onSend={() => {}}
              />
            </View>
          }
        />
        )}
      </View>
    </View>
  );
}

function passes(value: number | null): boolean | null {
  if (value === null) return null;
  if (value < 0) return false; // -1 is "could not measure", never "0px"
  return value <= 2;
}

function px(value: number | null): string {
  if (value === null) return '측정 중…';
  if (value < 0) return '측정 실패';
  return `${value}px`;
}

/**
 * The same, for numbers whose sign is the answer rather than an error code.
 *
 * `px()` reads any negative as "could not measure", which is right for a
 * distance that cannot be negative and wrong for a GAP: a tail sitting above the
 * composer is the passing case and it reads -12.4.
 */
function signedPx(value: number | null): string {
  if (value === null) return '측정 중…';
  return `${value}px`;
}

function ms(value: number | null): string {
  if (value === null) return '측정 중…';
  if (value < 0) return '측정 실패';
  return `${value}ms`;
}

/**
 * One `Travel`, with the two thresholds this batch was given and the sample
 * counts that say whether the times mean anything.
 *
 * The verdict is deliberately BOTH times: a run that starts on time and arrives
 * late is the stutter, and a run that arrives on time having started late is the
 * lateness 성재 reported. `midFlight` is printed beside them because a zero
 * there means the animation never glided at all — it snapped — and no pair of
 * times can tell you that.
 */
function TravelRow({
  label,
  travel,
}: {
  label: string;
  travel: Travel | null;
}): React.JSX.Element {
  if (travel === null) {
    return <Row label={label} value="측정 중…" pass={null} />;
  }
  if (!travel.available) {
    // Not a failure of the pane — a failure to ask it. Said in those words so
    // that a build without the native module cannot be read as a slow one.
    return <Row label={label} value="계측기 없음(네이티브 모듈 미탑재)" pass={null} />;
  }
  const onTime =
    travel.igniteMs >= 0 &&
    travel.igniteMs <= 17 &&
    travel.arriveMs >= 0 &&
    travel.arriveMs <= 300;
  return (
    <View style={styles.travelRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.travelValues}>
        <Text
          style={[styles.rowValue, onTime ? styles.pass : styles.fail]}>
          {`점화 ${ms(travel.commitMs)} · 표시 ${ms(travel.igniteMs)} → 도착 ${ms(
            travel.arriveMs,
          )} · 중간 ${travel.midFlight}/${travel.frames}`}
        </Text>
        <Text style={[styles.verdict, onTime ? styles.pass : styles.fail]}>
          {onTime ? 'PASS' : 'FAIL'}
        </Text>
      </View>
    </View>
  );
}

function Row({
  label,
  value,
  pass,
}: {
  label: string;
  value: string;
  pass: boolean | null;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          pass === true && styles.pass,
          pass === false && styles.fail,
        ]}>
        {value}
      </Text>
      <Text
        style={[
          styles.verdict,
          pass === true && styles.pass,
          pass === false && styles.fail,
        ]}>
        {pass === null ? '…' : pass ? 'PASS' : 'FAIL'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0f1115'},
  report: {maxHeight: 400, borderBottomWidth: 1, borderBottomColor: '#2a2f38'},
  reportBody: {padding: 12, paddingTop: 48, gap: 2},
  title: {color: '#f2f3f5', fontSize: 18, fontWeight: '700', marginBottom: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowLabel: {flex: 1, color: '#9aa0a8', fontSize: 12},
  rowValue: {color: '#f2f3f5', fontSize: 14, fontWeight: '700', minWidth: 76},
  verdict: {fontSize: 12, fontWeight: '700', color: '#6b7280', minWidth: 44},
  pass: {color: '#93d3a8'},
  fail: {color: '#e0777d'},
  meta: {color: '#6b7280', fontSize: 10},
  // `ThreadPanel` 의 `styles.invite` 와 같은 값. 이 줄의 높이가 buzz 반례의
  // 숫자에 그대로 들어가므로, 비슷한 것이 아니라 같은 것이어야 한다.
  threadInvite: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
  travelRow: {gap: 1},
  travelValues: {flexDirection: 'row', alignItems: 'center', gap: 8},
  stage: {flex: 1},
});
