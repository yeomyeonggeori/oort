import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ADR-0182 D2 type-1 in-place confirm hold.
 *
 * Not a motion-ladder step. Appear uses `--motion-instant`, disappear
 * `--motion-fast`; the 1.6s is how long the control keeps saying the result.
 */
export const INLINE_CONFIRM_MS = 1_600;

export function useInlineConfirm(): {
  confirmed: boolean;
  confirm: () => void;
} {
  const [confirmed, setConfirmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );

  const confirm = useCallback(() => {
    setConfirmed(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setConfirmed(false);
    }, INLINE_CONFIRM_MS);
  }, []);

  return { confirmed, confirm };
}
