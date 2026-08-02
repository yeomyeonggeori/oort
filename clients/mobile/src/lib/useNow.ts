import {useEffect, useState} from 'react';

// =============================================================================
// A clock that ticks, for the labels that are about elapsed time.
//
// `relativeLabel` and `deadlineLabel` (`@momo/core/features/inbox/model`) take
// `nowMs` as a parameter — the core is pure and does not read a clock. That is
// right, and it means the CALLER owns the question "when does this label become
// wrong?".
//
// The answer is: after a minute. Computing `Date.now()` once inside a `useMemo`
// keyed on the data leaves a row saying 방금 ten minutes later, and freezes a
// pending approval's `N분 후 만료` — on the one surface where the deadline is the
// entire point of the row.
//
// One minute, not one second: every label this feeds has minute granularity, so
// a faster tick would re-render the list for no visible change.
// =============================================================================

export const MINUTE_MS = 60_000;

export function useNow(intervalMs: number = MINUTE_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
