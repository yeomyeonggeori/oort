import type {Message} from '@momo/core/lib/api';
import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
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
import {Timeline} from '../src/features/conversation/Timeline';
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
 */
function injectKeyboardFrame(height: number): void {
  const emitter = (
    Keyboard as unknown as {
      _emitter?: {emit: (event: string, payload: unknown) => void};
    }
  )._emitter;
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

interface Results {
  incomingShiftPx: number | null;
  prependShiftPx: number | null;
  keyboardGapPx: number | null;
  keyboardHeightPx: number | null;
  composerBottomPx: number | null;
  keyboardTopPx: number | null;
  /** ms from the keyboard event to the composer's FIRST movement. */
  travelStartMs: number | null;
  /** ms from the keyboard event to the composer reaching its final position. */
  travelSettleMs: number | null;
  /** Was the sender's own message on screen after sending from mid-history? */
  selfSendVisible: boolean | null;
  /** The two raw readings behind it, so a failure names its own kind. */
  sentRowY: number | null;
  dockY: number | null;
  originSentByRn: string | null;
  note: string;
}

const EMPTY: Results = {
  incomingShiftPx: null,
  prependShiftPx: null,
  keyboardGapPx: null,
  keyboardHeightPx: null,
  composerBottomPx: null,
  keyboardTopPx: null,
  travelStartMs: null,
  travelSettleMs: null,
  selfSendVisible: null,
  sentRowY: null,
  dockY: null,
  originSentByRn: null,
  note: '측정 중…',
};

export default function MeasureHarness(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <Harness />
    </SafeAreaProvider>
  );
}

function Harness(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>(() =>
    Array.from({length: INITIAL_COUNT}, (_, i) => makeMessage(FIRST_SEQ + i)),
  );
  const [results, setResults] = useState<Results>(EMPTY);
  const anchorRef = useRef<View | null>(null);
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
  const keyboard = useKeyboard();
  const ranRef = useRef(false);
  const [keyboardSource, setKeyboardSource] = useState<'os' | 'injected'>('os');
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
        await wait(1200);
        after = await measureAnchor();
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
      // `measureInWindow` answers null for a row the virtualiser never mounted,
      // which is one of the two ways this can fail — and the two must not be
      // reported as one number, so both readings are kept. A null y is "the row
      // was never mounted"; a y below the dock is "mounted and off screen".
      let sentY: number | null = null;
      let dockY: number | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await wait(400);
        sentY = await measureAnchor();
        dockY = await measureNode(dockRef);
        if (sentY !== null && dockY !== null) break;
      }
      next.sentRowY = sentY;
      next.dockY = dockY;
      // `null` is NOT `false`. This harness's own rule (see the note on the
      // anchor scan) is that an unmeasured case must never be reported as a
      // measured one — and the first run of this probe broke it in the other
      // direction, printing FAIL for a row whose measurement wrapper had simply
      // never attached. `null` here means "could not measure"; the table prints
      // that word and the PR says it.
      next.selfSendVisible =
        sentY === null || dockY === null ? null : sentY < dockY;
      setResults(current => ({
        ...current,
        selfSendVisible: next.selfSendVisible,
        sentRowY: next.sentRowY,
        dockY: next.dockY,
      }));
      console.log(
        `MOMO_MEASURE_SELFSEND ${JSON.stringify({
          sentRowY: sentY,
          dockY,
          visible: next.selfSendVisible,
        })}`,
      );

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
      // Honest about what this proves. It exercises the part that can regress —
      // `KeyboardAvoidingView`'s response, and the decision to drop the bottom
      // safe-area inset while the keyboard is up — through `Keyboard._emitter`,
      // the exact emitter BOTH `KeyboardAvoidingView` and `useKeyboard`
      // subscribe to, so nothing about the layout path is stubbed. What it does
      // not prove is that iOS emits the event, which is React Native's contract
      // and was never in question. `keyboardSource` records which path produced
      // the number so the PR cannot claim the stronger one by accident.
      if (!keyboardVisibleRef.current) {
        injectKeyboardFrame(KEYBOARD_HEIGHT_PT);
        setKeyboardSource('injected');
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
    })();
  }, [measureAnchor, reachAnchor, measureNode]);

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
    const timer = setTimeout(() => {
      // The dock's bottom edge in WINDOW coordinates. Paired with the screen
      // height and the keyboard height in the fold below, that is the whole
      // question: is the composer's last pixel above the keyboard's first one.
      dockRef.current?.measureInWindow((_x, y, _w, height) => {
        setResults(current => ({
          ...current,
          keyboardHeightPx: keyboard.height,
          composerBottomPx: Math.round((y + height) * 10) / 10,
        }));
      });
    }, 300);
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
        <Text style={styles.title}>RN-C5 측정</Text>
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
        <Row
          label="키보드 이벤트 → 컴포저 첫 이동"
          value={ms(results.travelStartMs)}
          // One frame. The old path could not beat this: it had to render and
          // commit before the animation was even configured.
          pass={
            results.travelStartMs === null
              ? null
              : results.travelStartMs >= 0 && results.travelStartMs <= 17
          }
        />
        <Row
          label="키보드 이벤트 → 컴포저 도착"
          value={ms(results.travelSettleMs)}
          // The keyboard's own duration plus a frame; arriving later than the
          // keyboard is the defect itself.
          pass={
            results.travelSettleMs === null
              ? null
              : results.travelSettleMs >= 0 && results.travelSettleMs <= 300
          }
        />
        <Row
          label="중간에서 보낸 내 메시지가 보이는가"
          value={
            results.selfSendVisible === null
              ? results.dockY === null
                ? '측정 중…'
                : '측정 실패(앵커 미부착)'
              : results.selfSendVisible
              ? '보인다'
              : '가려짐'
          }
          pass={results.selfSendVisible}
        />
        <Text style={styles.meta}>
          {`보낸 행 y ${px(results.sentRowY)} · 컴포저 상단 y ${px(results.dockY)}`}
        </Text>
        <Text style={styles.meta}>
          {`키보드 높이 ${px(results.keyboardHeightPx)} · 컴포저 하단 ${px(
            results.composerBottomPx,
          )} · 키보드 상단 ${px(results.keyboardTopPx)}`}
        </Text>
        <Text style={styles.meta}>
          {`키보드 프레임 출처: ${
            keyboardSource === 'os' ? 'iOS 이벤트' : '주입(시뮬레이터가 키보드를 올리지 않음)'
          }`}
        </Text>
        <Text style={styles.meta}>
          {`RN 이 보낸 Origin: ${results.originSentByRn ?? '측정 중…'}`}
        </Text>
        <Text style={styles.meta}>{`판정 기준: 앵커 이동 ≤ 2px`}</Text>
      </ScrollView>

      <View style={styles.stage}>
        {/* The SHIPPING composition, not a lookalike. An earlier revision of
            this harness put `Timeline` and `Composer` side by side in a plain
            View and measured the composer 335px behind the keyboard — a true
            statement about a tree the app never renders. That is why the
            keyboard handling is a named component now. */}
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

function ms(value: number | null): string {
  if (value === null) return '측정 중…';
  if (value < 0) return '측정 실패';
  return `${value}ms`;
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
  report: {maxHeight: 260, borderBottomWidth: 1, borderBottomColor: '#2a2f38'},
  reportBody: {padding: 12, paddingTop: 56, gap: 4},
  title: {color: '#f2f3f5', fontSize: 18, fontWeight: '700', marginBottom: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowLabel: {flex: 1, color: '#9aa0a8', fontSize: 12},
  rowValue: {color: '#f2f3f5', fontSize: 14, fontWeight: '700', minWidth: 76},
  verdict: {fontSize: 12, fontWeight: '700', color: '#6b7280', minWidth: 44},
  pass: {color: '#93d3a8'},
  fail: {color: '#e0777d'},
  meta: {color: '#6b7280', fontSize: 11},
  stage: {flex: 1},
});
