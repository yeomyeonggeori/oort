import { useCallback, useEffect, useRef } from "react";

// =============================================================================
// Long press (B11), the touch counterpart of hover.
//
// **Hover does not exist on a touch screen.** A message action bar revealed by
// `:hover` is, on a phone, revealed by nothing at all — B9 established that the
// phone gets its own affordance rather than a desktop one that happens to fit,
// and this is that affordance for the message row.
//
// Three rules, each of which the first naive version got wrong somewhere:
//
// 1. **Touch only.** A mouse fires pointer events too, and arming this for a
//    mouse would open a sheet under a cursor that already has the hover bar —
//    two affordances competing for one gesture.
// 2. **A scroll is not a press.** A finger that moves more than a few pixels is
//    reading, not choosing. Without the movement gate every flick down a busy
//    channel opens a sheet.
// 3. **`preventDefault` is never called on pointerdown.** It would cancel the
//    scroll the gesture might still turn out to be, which makes the whole
//    timeline feel stuck.
// =============================================================================

/** Long enough not to fire while scrolling, short enough not to feel broken. */
export const LONG_PRESS_MS = 450;

/** Beyond this the gesture is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * Spread the result onto the element that should respond to a long press.
 *
 * `onContextMenu` is suppressed **only for touch**: on Android a long press
 * raises the browser's own context menu on top of the sheet this opens, while on
 * desktop the native menu is genuinely useful (copy, inspect) and stays.
 */
export function useLongPress(
  onLongPress: () => void,
  options?: { enabled?: boolean; delayMs?: number }
): LongPressHandlers {
  const enabled = options?.enabled ?? true;
  const delayMs = options?.delayMs ?? LONG_PRESS_MS;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const isTouch = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  // A row can unmount mid-press (the virtualiser recycles aggressively while
  // scrolling); a timer that outlived it would open a sheet for a message that
  // is no longer on screen.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      isTouch.current = event.pointerType === "touch";
      if (!enabled || !isTouch.current) return;
      origin.current = { x: event.clientX, y: event.clientY };
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        callback.current();
      }, delayMs);
    },
    [clear, delayMs, enabled]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = origin.current;
      if (!start || timer.current === null) return;
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
    },
    [clear]
  );

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    if (isTouch.current) event.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu,
  };
}
