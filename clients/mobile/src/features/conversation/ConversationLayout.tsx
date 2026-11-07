import React, {useCallback, useEffect, useRef} from 'react';
import {Keyboard, StyleSheet, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {KeyboardPane} from '../../lib/keyboardPane';
import {WORD} from '../../lib/techWords';
import {ComposerPanelContext, useComposerPanelState} from './composerPanel';
import {createDockFollow, DockFollowContext, type DockFollow} from './dockFollow';

// =============================================================================
// Timeline above, composer below, and the composer stays visible when the
// keyboard is up. This is the RN answer to the problem the web client solved
// with `visualViewport` (goal B9).
//
// ## Why this is a component and not six lines inside `ConversationScreen`
//
// Because it is the thing being measured. The requirement is a claim about
// pixels ("컴포저가 키보드에 가리지 않을 것"), and while this composition lived
// inline in the screen the harness could not reach it without also standing up
// a session, a query client and a realtime rail — so it measured `Timeline` and
// `Composer` side by side in a plain View instead, which is a DIFFERENT layout.
// Naming the composition means `measure/` renders the tree that ships.
//
// ## `KeyboardAvoidingView` was tried first, and measured wrong
//
// `behavior="padding"` computes its inset as `frame.y + frame.height -
// keyboardFrame.screenY`, where `frame` comes from its own `onLayout` — which
// is in PARENT coordinates, while `screenY` is in screen coordinates. The two
// only agree when the view is the root. This layout never is: in the app it
// sits under a safe-area inset and a header, in the harness under a results
// panel. Measured in the harness, `KeyboardAvoidingView` produced 75px of a
// needed 335px and left the composer 260px behind the keyboard; in the app the
// same error is smaller and nastier, short by exactly the top safe-area inset
// (~59pt), which looks like a design choice rather than a bug.
//
// `keyboardVerticalOffset` exists to correct precisely this, but the value that
// corrects it is "how far this view's coordinate origin is from the top of the
// screen" — a different number at every mount point, which the component cannot
// know and the caller should not have to.
//
// What is true by construction is simpler: **this view's bottom edge is the
// screen's bottom edge**, in both places it is mounted. So the inset it needs is
// exactly the keyboard's height, which the OS reports directly. No coordinate
// spaces to reconcile, and one number that the harness reads back to check.
//
// The safe-area inset is paid ONLY while the keyboard is down. A raised keyboard
// already covers the home indicator, so paying both leaves a dead band between
// the input and the keys; with the keyboard down, that inset is what keeps the
// send button out of the system's gesture area.
//
// ## The pane SLIDES, it does not shrink (성재, 두 번째 보고: "1 여전히 느려")
//
// The inset used to be an animated `paddingBottom`, and padding is a layout
// prop: not native-driver eligible, so every frame of the keyboard travelled
// through the JS thread and re-laid-out the list above it. `useKeyboard` records
// what that costs and why the property, not the animation, was the blocker.
//
// A transform is native-driver eligible, so the movement is a `translateY` on
// the whole pane and the padding underneath it is a constant. Two things follow,
// and they are the reason this is a real design change rather than a swap:
//
//   **The top has to be clipped.** Lifting the pane by the keyboard's height
//   carries its top edge up under the header, and a transformed view draws
//   outside its parent unless the parent says otherwise. So the pane is wrapped
//   in a view whose only job is `overflow: 'hidden'` — the header stays a header
//   instead of having a conversation slide over it.
//
//   **The list needs no inset arithmetic at all**, which was the open question.
//   Its height never changes; it moves, with its bottom edge pinned to the
//   composer. So the newest message stays exactly where it was relative to the
//   input, and what is given up is the top of the viewport — the same trade iOS
//   itself makes when a keyboard pushes a conversation up. The padding model
//   made the opposite trade (keep the top, cut the bottom) and needed
//   `Timeline`'s `onLayout` to scroll back to the tail afterwards; nothing has
//   to be corrected here, because nothing moved relative to anything else.
//
// ## …and now it is not JavaScript that decides WHEN (goal RN-P3)
//
// The transform above was still armed from a JS callback. `useKeyboard` said so
// in as many words — "the travel is free of the JS thread, the starting gun is
// not" — and named the reason it stopped there: binding the keyboard frame
// natively needs a native module, and it believed adding one "rewrites the Xcode
// project this batch is forbidden to touch".
//
// For a LOCAL Expo module that turns out to be false. `modules/momo-keyboard-native`
// is compiled as a pod through `use_expo_modules!`, and
// `ios/MomoMobile.xcodeproj/project.pbxproj` is not edited at all — which is
// worth more than convenience here, since that file now also holds the
// notification-service target goal RN-N1 attached.
//
// So the pane is that module's view. It subscribes to
// `UIKeyboardWillChangeFrameNotification` itself and animates its own transform
// on the main thread with the keyboard's own duration and its real (private,
// unnameable in JS) curve. The JS thread is not on the path at all — not for the
// travel, and no longer for the start.
//
// **The two rules that survive from the version above, because breaking either
// brings the defect back:** what moves is a transform, and what does not move
// (the padding) is a constant. Both are still true; only the thing that decides
// the transform has moved. `__tests__/conversationLayout.test.tsx` holds the
// line on both, and on the third rule that is new here — that no `transform`
// style is set from JS, because React Native writes `layer.transform` whenever
// that prop changes and would take the property back from the native side.
//
// ## Two gaps, two owners: below the pill and ABOVE it (#4264)
//
// Everything above is about the gap UNDER the pill (`KEYBOARD_GAP`: pill ↔ keys,
// and the home-indicator inset that exists only while the keyboard is down).
//
// The gap ABOVE the pill — last row ↔ pill — is a different number with a
// different owner, and it was misdiagnosed once: 성재 (2026-10-23) found it
// "조금 과한" and the issue suspected the safe-area inset (34) left under the list
// while typing. It is not. While the keyboard is up this pane pays only
// `insets.bottom - bottomInset` (= `KEYBOARD_GAP`) and the list ends exactly on the
// dock's top edge (`__tests__/conversationGap.test.tsx` reads both from the real
// tree). The number was the SUM of three spacers decided at three different times:
// list tail 8 + the reserved 「작성 중」 line 20 + the composer's own top air 8 = 36
// (44 to the glyph, simulator-measured). `CONV.listPillGap` now names the sum (20, Buzz) and the
// pieces derive from it; the same value holds with the keyboard up or down because
// none of the three reads the keyboard — the lift is the native pane's, as one unit.
//
// What this component owns of that sum is **nothing**: no padding or margin on the
// list wrapper or the dock wrapper, and the dock is a flow sibling that never
// overlaps the list. That is the "마지막 행이 알약에 가려지지 않는다" guarantee, and
// the test fails if either wrapper starts paying a spacer (a safe-area inset, say).
// =============================================================================

/**
 * 올라온 키보드와 알약 컴포저 바닥 사이의 틈. 스케일의 가장 작은 칸(`space.xs`, 4)이다.
 *
 * 옛 값 `space.sm`(8)은 iOS 26 의 유리 키보드에서 과했다(성재 3047 실기기 #4016: "채팅이랑 키보드
 * 사이에 간격이 조금 과한 것 같아"). 키보드 틀 위쪽에 이미 둥근 모서리와 글쇠 위 여백이 있어서 눈에는
 * 8 이 아니라 그 곱절로 읽혔다. 중복으로 더해지던 safe-area 는 아니다: 올라온 동안 `insets.bottom` 은
 * 이 틈만큼만 남고 나머지는 네이티브 리프트가 뺀다(`bottomInset`). 틈의 값이 곧 간격이다.
 */
export const KEYBOARD_GAP = space.xs;

/**
 * 쉬는 상태의 바닥 여백. 홈 인디케이터가 있는 기기는 그 인셋(34)이고, 없는 기기(iPhone SE, 인셋 0)는
 * 틈 하나(4)다(#4044). 둘 다 `KEYBOARD_GAP` 이상이어야 올라간 동안의 틈이 어느 기기에서나 4 다:
 * 틈 = 패딩 - 네이티브에 넘기는 `bottomInset`(`패딩 - GAP`, 0 미만 아님)이라, 인셋 0 에서 패딩이 0
 * 이면 틈도 0 이 되어 알약이 키보드에 붙는다. 내려갔을 때 알약이 화면 바닥에 붙던 것도 같이 풀린다.
 */
export function restingBottomPadding(bottomInset: number): number {
  return Math.max(bottomInset, KEYBOARD_GAP);
}

export function ConversationLayout({
  list,
  composer,
}: {
  list: React.ReactNode;
  composer: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();
  // 입력창이 자라는 프레임에 목록이 같이 바닥을 따라가게 하는 다리(`dockFollow.ts`, #4518). 목록 자리의 `Timeline` 이 처리기를 걸고 도크 자리의 `Composer` 가 부른다.
  const dockFollow = useRef<DockFollow | null>(null);
  if (dockFollow.current === null) dockFollow.current = createDockFollow();
  // 키보드 자리의 창(#5452, `composerPanel.tsx`). 창이 없는 동안(= 늘)은 아래 값이 전부 옛 값 그대로다: 같은 `bottomInset`, 목록·도크에 덧붙는 스타일 없음.
  const panel = useComposerPanelState();
  const panelOpen = panel.state.phase !== WORD.closed;
  const resting = restingBottomPadding(insets.bottom);
  // 창이 서면 도크가 변환으로 올라 있던 자리(= 키보드 높이 + 틈 - 쉬는 여백)만큼을 레이아웃의 빈 칸으로 받는다. 목록은 같은 만큼 위로 끌어올려(음의 위 여백) 크기가 안 변한다 -
  // 키보드가 올렸을 때와 똑같이 대화 전체가 통째로 올라가고 위쪽만 잘린다(`styles.clip`). 이 둘과 `bottomInset` 이 **한 커밋**에 바뀌어야 도크가 안 움직인다.
  const lift = panelOpen ? Math.max(0, panel.state.height + KEYBOARD_GAP - resting) : 0;
  // 창이 서 있는 동안 네이티브 리프트를 눕힌다: 리프트는 `키보드 높이 - bottomInset`(0 아래로는 안 내려간다)이라, 창 높이보다 큰 값이면 키보드가 와도 가도 안 움직인다.
  const paneInset = panelOpen ? Math.max(windowHeight, panel.state.height) : Math.max(0, resting - KEYBOARD_GAP);
  // 창이 마운트되어 빈 칸이 레이아웃에 닿은 **뒤에** 키보드를 내린다. 먼저 내리면 네이티브가 옛 리프트를 내리는 애니메이션을 시작해 버린다.
  const phaseRef = useRef(panel.state.phase);
  phaseRef.current = panel.state.phase;
  const keyboardOutOfTheWay = useCallback(() => {
    if (phaseRef.current === WORD.open) Keyboard.dismiss();
  }, []);
  // 키보드가 올라오는 도중(handoff)에 ☺ 를 다시 눌렀다: 빈 칸은 이미 서 있어 위의 레이아웃 신호가 오지 않으니 여기서 바로 내린다.
  const previousPhase = useRef(panel.state.phase);
  useEffect(() => {
    if (previousPhase.current === WORD.handoff && panel.state.phase === WORD.open) Keyboard.dismiss();
    previousPhase.current = panel.state.phase;
  }, [panel.state.phase]);

  return (
    <DockFollowContext.Provider value={dockFollow.current}>
    <ComposerPanelContext.Provider value={panel.api}>
      {/* The clip. Nothing else lives here: a transformed child draws outside its
          parent's bounds by default, and the child below is lifted by up to a
          keyboard's height — straight over the header. */}
      <View style={styles.clip} testID="conversation-clip">
        {/* The moving part, and it moves without asking JavaScript. `bottomInset`
            is the only thing this side still decides: how much of the keyboard's
            height is already paid for as padding. */}
        <KeyboardPane
          // 알약 컴포저가 키보드에 붙지 않게 틈을 남긴다(DS2-4 검수 M-1): 네이티브는
          // `키보드 높이 - bottomInset` 만큼 올리므로, 인셋을 틈만큼 덜 넘기면 그만큼 더
          // 올라간다. 쉬는 상태의 여백(패딩)은 그대로 상수다 — 두 규칙(움직이는 것은
          // 변환, 안 움직이는 것은 상수)이 둘 다 산다.
          bottomInset={paneInset}
          style={[styles.root, {paddingBottom: resting}]}
          testID="conversation-layout">
          <View
            style={panelOpen ? [styles.list, {marginTop: -lift}] : styles.list}
            testID="conversation-list">
            {list}
          </View>
          <View testID="composer-dock">{composer}</View>
          {panelOpen ? (
            <>
              <View style={{height: lift}} onLayout={keyboardOutOfTheWay} testID="composer-panel-room" />
              <View style={[styles.slot, {height: panel.state.height}]} testID="composer-panel">
                {panel.content}
              </View>
            </>
          ) : null}
        </KeyboardPane>
      </View>
    </ComposerPanelContext.Provider>
    </DockFollowContext.Provider>
  );
}

// 바닥색이 없다 (DS2-4 #2716). 대화 화면의 바닥은 시안 A `.a-conv` 그라데이션이고
// 그것은 이 층 **밑의** 화면이 칠한다 — 여기서 `bg` 를 다시 깔면 알약 컴포저 둘레와
// 목록 위쪽이 그라데이션 대신 평평한 판이 된다. 스레드 판은 자기 판이 바닥을 진다.
const buildStyles = (_color: Palette) => StyleSheet.create({
  clip: {flex: 1, overflow: 'hidden'},
  root: {flex: 1},
  list: {flex: 1},
  // 키보드 자리의 창(#5452): 화면 바닥에 붙어 키보드가 있던 자리를 채운다. 도크 밑의 빈 칸(`composer-panel-room`)은 흐름이고 이 칸은 그 위에 겹쳐 서는 그림이다.
  slot: {position: WORD.absolute, left: 0, right: 0, bottom: 0},
});
