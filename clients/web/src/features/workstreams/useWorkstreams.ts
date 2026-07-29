import { useQuery } from "@tanstack/react-query";
import {
  fetchWorkstream,
  fetchWorkstreamRuns,
  fetchWorkstreams,
  type WorkstreamStatus,
} from "@/lib/api";
import { isWorkstreamMissing } from "./model";

// =============================================================================
// Reads behind 작업 흐름 (ADR-0143). Three server projections, no local state
// machine: the goal layer has no realtime channel of its own, so the surface
// re-reads rather than deriving anything from a frame.
// =============================================================================

/** Lower-cased keys, because the same id arrives upper-cased from Swift. */
function key(value: string): string {
  return value.toLowerCase();
}

export function useWorkstreams(
  workspaceId: string,
  status: WorkstreamStatus | null
) {
  return useQuery({
    queryKey: ["workstreams", key(workspaceId), status ?? "all"],
    queryFn: () =>
      fetchWorkstreams(workspaceId, status === null ? {} : { status }),
    // The list is a work queue: someone comes here to find what stopped. A slow
    // poll keeps that honest without a channel subscription this projection
    // does not have.
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useWorkstream(workspaceId: string, workstreamId: string) {
  return useQuery({
    queryKey: ["workstream", key(workspaceId), key(workstreamId)],
    queryFn: () => fetchWorkstream(workspaceId, workstreamId),
    // A 404 here is an ANSWER, not a fault: it is what the server says about a
    // workstream anchored outside the reader's channels, and retrying it three
    // times only delays the sentence that states it.
    retry: (failureCount, error) => !isWorkstreamMissing(error) && failureCount < 2,
  });
}

export function useWorkstreamRuns(workspaceId: string, workstreamId: string) {
  return useQuery({
    queryKey: ["workstream-runs", key(workspaceId), key(workstreamId)],
    queryFn: () => fetchWorkstreamRuns(workspaceId, workstreamId),
    retry: (failureCount, error) => !isWorkstreamMissing(error) && failureCount < 2,
  });
}
