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

  // `max(keyboardHeight, bottomInset)`, as one animated expression.
  //
  // Branching on `visible` instead looks simpler and is wrong in a way that only
  // shows up while hiding: `visible` flips the instant the event arrives, so the
  // inset would be added back at the START of the hide — a 34-point jump, then a
  // smooth slide. Written as a max, the inset reappears exactly as the keyboard
  // passes under it, and neither direction has a step in it.
  //
  // `interpolate` needs a strictly increasing input range, which a device with
  // no home indicator (inset 0) would not give, so that case is the bare value.
  const paddingBottom =
    insets.bottom > 0
      ? keyboard.offset.interpolate({
          inputRange: [0, insets.bottom, insets.bottom + 1],
          outputRange: [insets.bottom, insets.bottom, insets.bottom + 1],
          // Default 'extend': beyond the last stop it continues with slope 1, so
          // the expression is the keyboard's own height from there on.
        })
      : keyboard.offset;

  return (
    // `Animated.View`, and the padding is the animated value rather than a
    // number this component re-renders with. That is the fix for 성재's "키보드
    // 보다 늦게 올라온다": an animated style updates the node directly, so the
    // travel does not queue behind a React render and a Fabric commit. See
    // `useKeyboard` for what was measured and what was ruled out.
    <Animated.View
      style={[styles.root, {paddingBottom}]}
      testID="conversation-layout">
      <View style={styles.list}>{list}</View>
      <View testID="composer-dock">{composer}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: color.bg},
  list: {flex: 1},
});
