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
// It exists because three of this batch's claims are about pixels, and a claim
// about pixels that is argued rather than measured is a claim about nothing:
//
//   1. a message arriving while the reader is scrolled back moves the anchor 0px
//   2. loading older messages moves the anchor 0px
//   3. the composer is not covered by the software keyboard
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
  const listRef = useRef<FlatList<never> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
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
  const measureAnchor = useCallback(
    (): Promise<number | null> =>
      new Promise(resolve => {
        const node = anchorRef.current;
        if (!node) {
          resolve(null);
          return;
        }
        node.measureInWindow((_x, y) => resolve(y));
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

      // ---- 3. the keyboard --------------------------------------------------
      // `focus()` rather than a tap, because a simulator cannot be driven by a
      // script — spike #837 found React Native's elements absent from the
      // accessibility tree and coordinate clicks landing nowhere. Focus itself
      // works (the caret appears), and on a device it raises the real keyboard.
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
      }
    })();
  }, [measureAnchor, reachAnchor]);

  // Measured in its own effect because it has to run AFTER the keyboard is up,
  // and the dock's position is only meaningful then.
  const dockRef = useRef<View | null>(null);
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
        <Text style={styles.title}>RN-C4 측정</Text>
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
              anchorSeq={ANCHOR_SEQ}
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
