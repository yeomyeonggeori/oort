import { createContext, useContext, useMemo } from "react";
import {
  cascadeFor,
  EMPTY_CASCADE,
  type CascadeByRun,
  type CascadeFallback,
} from "@momo/core/features/timeline/cascadeModel";

// =============================================================================
// The context half of the cascade rail (ADR-0135 D1 / MOMO-627), split from the
// provider so neither file mixes a hook with a component (react-refresh).
//
// A context rather than a prop chain, for the reason AgentCard already reaches
// for `useSession`: the row that needs this sits three components below the
// shell, and the same row is rendered by both the timeline and the thread
// panel. Threading one map through Timeline, ThreadPanel and MessageRow would
// widen the blast radius of this change for nothing.
//
// Not mounted is a valid state, not a bug: consumers read the empty map and
// render no notice, which is the same thing a channel with no fallback does.
// That is what keeps a unit test or a future surface from having to know the
// provider exists.
// =============================================================================

export const CascadeContext = createContext<CascadeByRun>(EMPTY_CASCADE);

/** Transitions recorded for one run in this session. Empty when there are none. */
export function useCascadeFallbacks(
  runId: string | null
): readonly CascadeFallback[] {
  const byRun = useContext(CascadeContext);
  return useMemo(() => cascadeFor(byRun, runId), [byRun, runId]);
}
