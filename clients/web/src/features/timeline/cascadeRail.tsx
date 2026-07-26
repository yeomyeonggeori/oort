import { useEffect, useState, type ReactNode } from "react";
import type { RealtimeHandle } from "@/lib/realtime";
import { agentTurnFixtureMode } from "@/features/agents/turnFixture";
import { CascadeContext } from "./cascadeContext";
import {
  EMPTY_CASCADE,
  mergeCascadeFallback,
  parseCascadeFallback,
  type CascadeByRun,
  type CascadeFallback,
} from "./cascadeModel";

// =============================================================================
// The provider cascade rail (ADR-0135 D1 / MOMO-627): one subscription per open
// channel, folded into the per-run map the message rows read through
// `useCascadeFallbacks` (cascadeContext.ts).
// =============================================================================

/**
 * The run id whose turn record the design capture seeds a fallback for.
 *
 * It matches the `run_id` on the settled WORKER turn record in
 * `scripts/capture-screens.mjs` (BODIES), which is the only way the cascade row
 * can appear in artifacts/design: the capture runs against a mocked REST
 * surface with no socket, so the frame that normally carries this can never
 * arrive there. Change one and change the other.
 *
 * Worker, not gateway, and that is the whole correction of D1/F3: the worker is
 * the only publisher of `provider.cascade.fallback` and its claim excludes
 * gateway jobs, so a turn that fell over is always a worker turn.
 */
const FIXTURE_RUN_ID = "0199aa11-2222-7000-8000-0000000000c3";

/**
 * The fixture transition, shaped exactly like a frame the worker writes:
 * position 0 (the operator's provider link) stopped answering and position 1
 * served the turn.
 */
const FIXTURE_FALLBACK: CascadeFallback = {
  runId: FIXTURE_RUN_ID,
  from: 0,
  to: 1,
  reason: "provider_unreachable",
  fromEndpointLabel: "api.anthropic.com",
  toEndpointLabel: "gateway.dawn.internal:8443",
};

export function CascadeProvider({
  realtime,
  workspaceId,
  channelId,
  children,
}: {
  realtime: RealtimeHandle | null;
  workspaceId: string;
  channelId: string | null;
  children: ReactNode;
}) {
  const [byRun, setByRun] = useState<CascadeByRun>(EMPTY_CASCADE);

  // Same seam as the sidebar pill and the composer activity line
  // (`?agentwork=`, turnFixture.ts): dead in a release build, and where it is
  // live the sidebar already prints a warn-coloured line saying the turns below
  // are not real. One fixture notice for one screen.
  const fixture = agentTurnFixtureMode() !== null;

  useEffect(() => {
    // Channel-scoped: the frames are published on the channel the run lives in,
    // and carrying another channel's transitions across a switch would pin a
    // notice to a turn that was served somewhere else.
    setByRun(
      fixture ? mergeCascadeFallback(EMPTY_CASCADE, FIXTURE_FALLBACK) : EMPTY_CASCADE
    );
    if (fixture || !realtime || channelId === null) return;
    return realtime.subscribeCascade(workspaceId, channelId, {
      onFallback: (frame) => {
        const fallback = parseCascadeFallback(frame);
        if (fallback === null) return;
        setByRun((current) => mergeCascadeFallback(current, fallback));
      },
    });
  }, [realtime, workspaceId, channelId, fixture]);

  return (
    <CascadeContext.Provider value={byRun}>{children}</CascadeContext.Provider>
  );
}
