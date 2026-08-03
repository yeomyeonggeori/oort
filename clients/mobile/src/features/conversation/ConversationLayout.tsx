import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {color} from '../../design/tokens';
import {useKeyboard} from '../../lib/useKeyboard';

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
// The composer's distance to the keyboard's top edge is still 0px, and it is
// still the same one number the OS reports — see the fold below.
// =============================================================================

export function ConversationLayout({
  list,
  composer,
}: {
  list: React.ReactNode;
  composer: React.ReactNode;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboard();

  // How far up, as `-max(keyboardHeight - bottomInset, 0)`.
  //
  // The pane keeps paying the safe-area inset the whole time (a constant), so
  // the distance it has to travel is only what the keyboard adds ON TOP of the
  // home-indicator gap it already covers. At rest that is 0 and the layout is
  // byte-for-byte the one that shipped; with a 336pt keyboard over a 34pt inset
  // it is 302, which puts the composer's last pixel on the keyboard's first.
  //
  // Written as one expression rather than a branch on `visible` for the reason
  // the padding version already had: `visible` flips the instant the event
  // arrives, so a branch would step by the inset at the START of the hide and
  // then slide. As a clamped subtraction, the inset reappears exactly as the
  // keyboard passes under it and neither direction has a jump in it.
  //
  // `interpolate` needs a strictly increasing input range, which a device with
  // no home indicator (inset 0) would not give, so that case is a bare negation.
  // Both forms stay native-driver eligible, which is the whole point.
  const lift =
    insets.bottom > 0
      ? keyboard.offset.interpolate({
          inputRange: [0, insets.bottom, insets.bottom + 1],
          outputRange: [0, 0, -1],
          // Default 'extend': past the last stop it continues with slope -1, so
          // from there on the expression is -(keyboardHeight - inset).
        })
      : Animated.multiply(keyboard.offset, -1);

  return (
    // The clip. Nothing else lives here: a transformed child draws outside its
    // parent's bounds by default, and the child below is lifted by up to a
    // keyboard's height — straight over the header.
    <View style={styles.clip} testID="conversation-clip">
      {/* `Animated.View`, and the moving part is a TRANSFORM rather than the
          padding this used to animate. That is the second half of 성재's "키보드
          보다 늦게 올라온다": a transform is native-driver eligible, so the
          travel runs on the UI thread and never queues behind the JS thread's
          work. See `useKeyboard` for what was read and what was ruled out. */}
      <Animated.View
        style={[
          styles.root,
          {paddingBottom: insets.bottom, transform: [{translateY: lift}]},
        ]}
        testID="conversation-layout">
        <View style={styles.list}>{list}</View>
        <View testID="composer-dock">{composer}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {flex: 1, overflow: 'hidden', backgroundColor: color.bg},
  root: {flex: 1, backgroundColor: color.bg},
  list: {flex: 1},
});
