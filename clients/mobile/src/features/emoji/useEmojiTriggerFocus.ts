import {useEffect, useRef} from 'react';
import {AccessibilityInfo, findNodeHandle, type View} from 'react-native';

/** Returning from the picker restores keyboard/VoiceOver focus to the opener. */
export function useEmojiTriggerFocus(open: boolean) {
  const trigger = useRef<View>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && trigger.current) {
      trigger.current.focus();
      const handle = findNodeHandle(trigger.current);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }
    wasOpen.current = open;
  }, [open]);
  return trigger;
}
