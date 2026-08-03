import {useEffect, useState} from 'react';
import {Keyboard, LayoutAnimation} from 'react-native';

// =============================================================================
// How tall the software keyboard is right now, and therefore whether the bottom
// safe-area inset is still ours to pay.
//
// This is NOT a re-implementation of `KeyboardAvoidingView` — that component
// still does the avoiding (see `ConversationScreen`). What it cannot do is
// answer the second question: when the keyboard is UP it already covers the
// home indicator, so adding the bottom inset underneath the composer as well
// leaves a dead 34-point band between the input and the keys. When it is down,
// that inset is exactly what keeps the send button out of the system gesture
// area. One number decides both, and it has to be readable to be measured
// (`measure/KeyboardMeasure.tsx` reads the same value it feeds the layout).
//
// `keyboardWillShow` rather than `keyboardDidShow`: iOS fires the "will" pair
// with the animation, so the composer travels with the keyboard instead of
// jumping into place after it has arrived.
// =============================================================================

export interface KeyboardState {
  /** Height of the keyboard in points, or 0 when it is not on screen. */
  height: number;
  visible: boolean;
}

export function useKeyboard(): KeyboardState {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // Match the keyboard's own animation, so the composer travels with it
    // instead of teleporting once it has arrived. This is the same thing
    // `KeyboardAvoidingView` does with the event's duration and easing, kept
    // because it is the part of that component worth having.
    const animate = (duration: number, easing: string) => {
      LayoutAnimation.configureNext({
        duration: duration > 10 ? duration : 10,
        update: {
          duration: duration > 10 ? duration : 10,
          type:
            LayoutAnimation.Types[
              easing as keyof typeof LayoutAnimation.Types
            ] ?? 'keyboard',
        },
      });
    };

    const show = Keyboard.addListener('keyboardWillShow', event => {
      animate(event.duration ?? 250, event.easing ?? 'keyboard');
      setHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardWillHide', event => {
      animate(event.duration ?? 250, event.easing ?? 'keyboard');
      setHeight(0);
    });
    // The "did" pair is also watched because a hardware keyboard attached to a
    // simulator (or an iPad) can change the software keyboard's height without
    // a will-show, and a stale height there is a gap under the composer.
    const didShow = Keyboard.addListener('keyboardDidShow', event => {
      setHeight(event.endCoordinates.height);
    });
    const didHide = Keyboard.addListener('keyboardDidHide', () => {
      setHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
      didShow.remove();
      didHide.remove();
    };
  }, []);

  return {height, visible: height > 0};
}
