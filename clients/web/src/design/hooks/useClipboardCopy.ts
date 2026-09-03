import { useCallback, useEffect } from "react";
import {
  INLINE_CONFIRM_MS,
  useInlineConfirm,
} from "@/design/ui/inlineConfirm";

/** ADR-0182 D5 type-1 hold. Same clock as `useInlineConfirm`. */
export const COPY_FEEDBACK_MS = INLINE_CONFIRM_MS;

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
  const { confirmed: copied, confirm, reset } = useInlineConfirm();

  useEffect(() => {
    reset();
  }, [value, reset]);

  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return false;
    }
    confirm();
    return true;
  }, [value, confirm]);

  return { copied, copy };
}
