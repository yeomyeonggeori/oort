import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ADR-0182 D2 type-1 in-place confirm. The hold is not a motion-ladder step.
 * RED stub: duration and state are wrong on purpose (#1957).
 */
export const INLINE_CONFIRM_MS = 0;

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
    void setConfirmed;
    void timer;
  }, []);

  return { confirmed, confirm };
}
