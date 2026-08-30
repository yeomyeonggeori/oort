import { useEffect, useState } from "react";
import {
  customStatusAccessibleText,
  visibleCustomStatus,
  type CustomStatusFields,
  type VisibleCustomStatus,
} from "@momo/core/features/presence/customStatus";

/**
 * One-shot clock for a custom-status expiry.
 *
 * `visibleCustomStatus` is a pure function of (row, now). A render that
 * calls it with `Date.now()` once never redraws when the clock crosses the
 * stamp (design-review #1889 H-1). This schedules a single timeout for the
 * first millisecond after expiry and does not refetch.
 */
export function useNowMsForExpiry(expiresAtMs: number | undefined): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAtMs === undefined) return;
    const remaining = expiresAtMs - Date.now();
    if (remaining < 0) return;
    const id = window.setTimeout(() => {
      setNowMs(Date.now());
    }, remaining + 1);
    return () => window.clearTimeout(id);
  }, [expiresAtMs]);
  return nowMs;
}

export function useCustomStatusView(
  row: CustomStatusFields | null | undefined
): {
  visible: VisibleCustomStatus | null;
  accessible: string | null;
  nowMs: number;
} {
  const nowMs = useNowMsForExpiry(row?.statusExpiresAtMs);
  if (!row) return { visible: null, accessible: null, nowMs };
  return {
    visible: visibleCustomStatus(row, nowMs),
    accessible: customStatusAccessibleText(row, nowMs),
    nowMs,
  };
}
