import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {KeyboardPane} from '../../lib/keyboardPane';

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
// =============================================================================

/** 올라온 키보드와 도크 바닥 사이의 틈(Buzz·iMessage 의 숨 쉴 틈). */
export const KEYBOARD_GAP = space.sm;

export function ConversationLayout({
  list,
  composer,
}: {
  list: React.ReactNode;
  composer: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();

  return (
    // The clip. Nothing else lives here: a transformed child draws outside its
    // parent's bounds by default, and the child below is lifted by up to a
    // keyboard's height — straight over the header.
    <View style={styles.clip} testID="conversation-clip">
      {/* The moving part, and it moves without asking JavaScript. `bottomInset`
          is the only thing this side still decides: how much of the keyboard's
          height is already paid for as padding. */}
      <KeyboardPane
        // 알약 컴포저가 키보드에 붙지 않게 틈을 남긴다(DS2-4 검수 M-1): 네이티브는
        // `키보드 높이 - bottomInset` 만큼 올리므로, 인셋을 틈만큼 덜 넘기면 그만큼 더
        // 올라간다. 쉬는 상태의 여백(패딩)은 그대로 상수다 — 두 규칙(움직이는 것은
        // 변환, 안 움직이는 것은 상수)이 둘 다 산다.
        bottomInset={Math.max(0, insets.bottom - KEYBOARD_GAP)}
        style={[styles.root, {paddingBottom: insets.bottom}]}
        testID="conversation-layout">
        <View style={styles.list}>{list}</View>
        <View testID="composer-dock">{composer}</View>
      </KeyboardPane>
    </View>
  );
}

// 바닥색이 없다 (DS2-4 #2716). 대화 화면의 바닥은 시안 A `.a-conv` 그라데이션이고
// 그것은 이 층 **밑의** 화면이 칠한다 — 여기서 `bg` 를 다시 깔면 알약 컴포저 둘레와
// 목록 위쪽이 그라데이션 대신 평평한 판이 된다. 스레드 판은 자기 판이 바닥을 진다.
const buildStyles = (_color: Palette) => StyleSheet.create({
  clip: {flex: 1, overflow: 'hidden'},
  root: {flex: 1},
  list: {flex: 1},
});
