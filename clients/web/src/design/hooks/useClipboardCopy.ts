import { useCallback, useEffect, useRef, useState } from "react";

/** The same two-second receipt used by every copy control in the web client. */
export const COPY_FEEDBACK_MS = 2_000;

/**
 * Copies plain text and keeps the short-lived inline receipt state.
 *
 * The hook owns no visual feedback. A settings button, a menu row and a touch
 * sheet have different markup, but all of them must agree on what was copied,
 * how failure is reported and when 「복사됨」 returns to 「복사」.
 */
export function useClipboardCopy(value: string): {
  copied: boolean;
  copy: () => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );

  useEffect(() => {
    setCopied(false);
    window.clearTimeout(timer.current);
  }, [value]);

  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return false;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setCopied(false),
      COPY_FEEDBACK_MS
    );
    return true;
  }, [value]);

  return { copied, copy };
}
