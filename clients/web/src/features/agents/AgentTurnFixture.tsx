import { useEffect } from "react";
import { useSession } from "@/app/session";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import {
  agentTurnFixtureSignals,
  type AgentTurnFixtureMode,
} from "./turnFixture";
import { markAgentWorking } from "./agentWorkingSignal";

/**
 * Renders nothing; seeds the turn store when `?agentwork=` is on (SKILL §11
 * capture loop). Mounted INSTEAD of AgentWorkingRail, never beside it, so the
 * store never has a live writer and a fixture writer arguing over one key.
 */
export function AgentTurnFixture({ mode }: { mode: AgentTurnFixtureMode }) {
  const { workspaceId } = useSession();
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);

  // The queries hand back new arrays on every settle; the joined ids are what
  // actually changed, and `mode` only decides whether this component mounts.
  const channelKey = groups.channels.map((c) => c.id).join(",");
  const agentKey = directory.members
    .filter((m) => m.kind === "agent" && m.status === "active")
    .map((m) => m.id)
    .join(",");

  useEffect(() => {
    if (channelKey === "" || agentKey === "") return;
    const signals = agentTurnFixtureSignals(
      channelKey.split(","),
      agentKey.split(","),
      Date.now()
    );
    for (const signal of signals) markAgentWorking(signal);
  }, [mode, channelKey, agentKey]);

  return null;
}
