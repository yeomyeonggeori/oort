import { useQuery } from "@tanstack/react-query";
import {
  fetchWorkstream,
  fetchWorkstreamRuns,
  fetchWorkstreams,
  type Workstream,
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
    //
    // Retries are the app default (queryClient: retry 1). v1 pinned this one to
    // `false`, which is a different promise from every other list in the shell
    // for no reason this projection has: unlike the two reads below there is no
    // 404 to hurry to, so a single flaked GET drew "불러오지 못했습니다" where
    // 인박스·멤버·에이전트 would have quietly succeeded on the retry
    // (PR 918 R1 Low).
    refetchInterval: 60_000,
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

/**
 * 이 작업 세션이 속한 목표 (MOMO-679).
 *
 * The list read already takes `?sessionId=`, so the back link is the SAME
 * projection asked from the other end rather than a new shape on the wire: the
 * server answers with the workstream that owns this Run, scoped by the same
 * channel membership as every other workstream read, and a session that belongs
 * to no goal answers with an empty list and gets no link.
 *
 * It resolves to `null` rather than throwing on a miss, because "이 세션은 아직
 * 목표에 묶이지 않았다" is an ANSWER: workstreams are created from the anchor
 * thread (ADR-0143 P2) and plenty of sessions predate one.
 */
export function useSessionWorkstream(workspaceId: string, sessionId: string) {
  return useQuery<Workstream | null>({
    queryKey: ["workstream-of-session", key(workspaceId), key(sessionId)],
    queryFn: async () => {
      const rows = await fetchWorkstreams(workspaceId, { sessionId, limit: 1 });
      return rows[0] ?? null;
    },
    staleTime: 60_000,
  });
}
