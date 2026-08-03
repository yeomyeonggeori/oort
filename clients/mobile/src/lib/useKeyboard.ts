import {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, Keyboard} from 'react-native';

// =============================================================================
// How tall the software keyboard is right now, and therefore whether the bottom
// safe-area inset is still ours to pay.
//
// When the keyboard is UP it already covers the home indicator, so adding the
// bottom inset underneath the composer as well leaves a dead 34-point band
// between the input and the keys. When it is down, that inset is exactly what
// keeps the send button out of the system gesture area. One number decides both.
//
// ## Why this returns an `Animated.Value` and not just a number
//
// 성재, iPhone 17 / iOS 26.5.1: "채팅창을 누르면 올라오긴 하는데, 키보드보다
// 늦게 올라오는 딜레이가 있어." The composer arrived, but late — and the first
// version of this hook had already done the obvious thing (`keyboardWillShow`
// plus `LayoutAnimation`), so the obvious thing was not the answer.
//
// **What was actually wrong, checked rather than guessed.** The first suspicion
// was that `LayoutAnimation` is ignored under the New Architecture. It is not:
// in this version `ReactNativeFeatureFlagsDefaults.h` answers
// `enableLayoutAnimationsOnIOS() -> true`, and `React/Fabric/RCTScheduler.mm`
// builds a `LayoutAnimationDriver` behind exactly that flag. The animation runs.
//
// The lateness is in **when it is allowed to start**. `configureNext` does not
// animate anything by itself — it arms the NEXT commit. So the real sequence was:
//
//     keyboardWillShow  →  setState  →  React render  →  Fabric commit  →  animation begins
//
// Every arrow is work, and iOS has been sliding the keyboard since before the
// first one. The composer could not be on time; it could only be consistently a
// couple of frames behind, which is precisely what a person sees as "늦게".
//
// An `Animated.Value` removes that queue. `Animated.timing(...).start()` runs
// the instant the listener fires, and an animated style on an `Animated.View`
// updates the node directly — **no React re-render, no commit** in the critical
// path, and (this matters here) no re-render of the `FlatList` sitting above the
// composer. The duration comes from the event, so the two travel together.
//
// The number is still returned as state as well, because the safe-area decision
// is a boolean about where things ended up and does not need to be frame-exact.
//
// ## 성재 said it again: "1 여전히 느려." The above was true and not enough.
//
// The first fix moved the START out of the render queue. It left the animation
// itself on the JS thread, and that is the half a person feels on a real phone,
// because the keyboard comes up at exactly the moment this client is busiest:
// the composer is re-filtering mentions while a `FlatList` re-renders. Read in
// `react-native/src/private/animated/createAnimatedPropsHook.js` rather than
// assumed — its own comment says it plainly:
//
//     NOTE: When using the JS animation driver, this callback is called on
//     every animation frame. When using the native driver, this callback is
//     called when the animation completes.
//
// and the JS branch it lands in, for a Fabric host, is `instance.setNativeProps`
// **on every frame** plus a `scheduleUpdate()` (a full React commit) debounced
// to every 48ms to keep the Fiber and Shadow trees in step. Fifteen frames of
// keyboard therefore cost fifteen JS callbacks and five commits, every one of
// which queues behind whatever the JS thread is already doing. A busy thread
// does not make this animation slower and smoother; it makes it **stutter and
// arrive late**, which is what "여전히 느려" describes.
//
// **The reason it could not use the native driver was the property, not the
// animation.** `paddingBottom` is a layout prop: it feeds Yoga, so it cannot be
// driven off the JS thread, and every frame of it also re-lays-out the list
// above the composer. `transform: translateY` is not a layout prop — the native
// driver takes it, the whole travel runs on the UI thread, and this callback
// fires exactly once, at the end. `ConversationLayout` is where that trade is
// paid for (the pane slides as one and is clipped at the top); the note there
// explains why the list needs no inset arithmetic to go with it.
//
// What this does NOT buy, stated because measuring it is this batch's job: the
// event that arms the animation is still a JS callback. A JS thread that is busy
// when `keyboardWillShow` arrives delays `start()` itself. Binding the keyboard
// frame to a native value with no JS in the loop needs a native module
// (`react-native-keyboard-controller` is the one that does it), and adding a pod
// rewrites the Xcode project this batch is forbidden to touch. So: the travel is
// free of the JS thread, the starting gun is not.
//
// ## The `did` pair only speaks when it disagrees
//
// It is watched because a hardware keyboard (a simulator, an iPad) can change
// the software keyboard's height without a will-show, and a stale height there
// is a gap under the composer. But firing `setHeight` with a value equal to the
// one `willShow` just set schedules a second commit for no change at all — one
// more chance to land a frame late. It now speaks only when it actually differs.
// =============================================================================

export interface KeyboardState {
  /** Height of the keyboard in points, or 0 when it is not on screen. */
  height: number;
  visible: boolean;
  /**
   * The same height, animated with the keyboard's own duration, **on the native
   * driver**.
   *
   * Bind it to a `transform` and nothing else. Once a value has been animated
   * with `useNativeDriver: true` it lives on the native side, and React Native
   * throws on the next attempt to read it from a JS-driven style — so a layout
   * prop here is not a slower option, it is a crash. Interpolations and
   * `Animated.multiply` of it stay native-eligible; that is what
   * `ConversationLayout` uses to turn "keyboard height" into "how far up".
   */
  offset: Animated.Value;
}

/**
 * iOS animates the keyboard on a private curve (`UIViewAnimationCurve` 7) that
 * is not one of the four public ones, so it cannot be named — only approximated.
 * This is the bezier the platform's curve is commonly matched with. The duration
 * is exact (it rides the event); only the shape is an approximation, and being
 * a few points off mid-flight is invisible next to starting late, which is the
 * thing this file exists to fix.
 */
const KEYBOARD_EASING = Easing.bezier(0.38, 0.7, 0.125, 1);

/** iOS occasionally reports 0; a keyboard that took no time still needs a tick. */
const MIN_DURATION_MS = 10;
const DEFAULT_DURATION_MS = 250;

export function useKeyboard(): KeyboardState {
  const [height, setHeight] = useState(0);
  const offset = useRef(new Animated.Value(0)).current;
  const heightRef = useRef(0);

  useEffect(() => {
    const travel = (to: number, duration: number | undefined) => {
      heightRef.current = to;
      Animated.timing(offset, {
        toValue: to,
        duration:
          duration !== undefined && duration > MIN_DURATION_MS
            ? duration
            : DEFAULT_DURATION_MS,
        easing: KEYBOARD_EASING,
        // The whole travel runs on the UI thread. Every frame between here and
        // the destination is drawn without asking the JS thread for anything,
        // which is the half the first fix left behind. Only legal because the
        // consumer binds this to a transform — see the header and `KeyboardState`.
        useNativeDriver: true,
      }).start();
    };

    const show = Keyboard.addListener('keyboardWillShow', event => {
      const next = event.endCoordinates.height;
      travel(next, event.duration);
      setHeight(next);
    });
    const hide = Keyboard.addListener('keyboardWillHide', event => {
      travel(0, event.duration);
      setHeight(0);
    });
    // Only when it disagrees — see the header.
    const didShow = Keyboard.addListener('keyboardDidShow', event => {
      const next = event.endCoordinates.height;
      if (next === heightRef.current) return;
      travel(next, event.duration);
      setHeight(next);
    });
    const didHide = Keyboard.addListener('keyboardDidHide', () => {
      if (heightRef.current === 0) return;
      travel(0, undefined);
      setHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
      didShow.remove();
      didHide.remove();
    };
  }, [offset]);

  return useMemo(
    () => ({height, visible: height > 0, offset}),
    [height, offset],
  );
}
