import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createAgent, type CreateAgentInput, type CreatedAgent } from "@/lib/api";
import { useSession } from "@/app/session";
import { createAgentFailure, type CreateAgentFailure } from "./createModel";

// =============================================================================
// 에이전트 만들기 (goal B5.3b). Shaped after useCreateChannel, with one
// deliberate difference: it does NOT seed the created row into the roster cache.
//
// The create answers with three fields (`id`, `handle`, `displayName`) and the
// roster row needs eight more (status, role, channelIds, capabilities, model,
// owner, timestamps). Inventing plausible values for those would put a row on
// screen that says "0개 채널" and "capability 없음" as if the server had said so.
// It refetches instead, which costs one request and keeps every field on this
// surface something a server actually sent.
// =============================================================================

export interface CreateAgentHandle {
  /** A create is in flight. The dialog keeps its inputs but blocks resubmit. */
  pending: boolean;
  /** The last rejection, addressed to a field or to the form. */
  failure: CreateAgentFailure | null;
  /** The created agent, or null when the attempt was refused. */
  create: (input: CreateAgentInput) => Promise<CreatedAgent | null>;
  /** Drop the rejection because the input it was about has changed. */
  clearFailure: () => void;
}

export function useCreateAgent(): CreateAgentHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateAgentFailure | null>(null);

  const create = useCallback(
    async (input: CreateAgentInput): Promise<CreatedAgent | null> => {
      setPending(true);
      setFailure(null);
      try {
        const created = await createAgent(workspaceId, input);
        await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
        return created;
      } catch (error) {
        setFailure(createAgentFailure(error));
        return null;
      } finally {
        setPending(false);
      }
    },
    [workspaceId, client]
  );

  return {
    pending,
    failure,
    create,
    clearFailure: useCallback(() => setFailure(null), []),
  };
}
