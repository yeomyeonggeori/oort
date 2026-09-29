import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMemorySettings,
  getRunMemoryReceipt,
  listMemoryDigests,
  patchChannelMemorySettings,
  patchMyMemorySettings,
  patchWorkspaceMemorySettings,
} from "@momo/core/features/memory/api";
import type {
  MemoryDigestPage,
  MemoryReceipt,
  MemorySettings,
  PatchChannelMemorySettingsInput,
  PatchWorkspaceMemorySettingsInput,
} from "@momo/core/features/memory/model";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import type { MemoryQueryView } from "@momo/core/features/memory/presentation";

// =============================================================================
// Team memory v2 queries (ADR-0196, #3165). The server decides visibility, so
// none of these filters a result: an empty page or a 404 is shown as such.
// =============================================================================

/** A server that answers 404/405/501 has no memory routes; asking again will not change that. */
function retryUnlessAbsent(count: number, error: unknown): boolean {
  return !serverSaysAbsent(error) && count < 1;
}

export const memoryKeys = {
  settings: (workspaceId: string) => ["memory", "settings", workspaceId] as const,
  digests: (workspaceId: string, channelId: string, sinceSeq: number) =>
    ["memory", "digests", workspaceId, channelId, sinceSeq] as const,
  receipt: (workspaceId: string, runId: string) =>
    ["memory", "receipt", workspaceId, runId] as const,
};

export function useMemorySettings(workspaceId: string, enabled = true) {
  return useQuery<MemorySettings>({
    queryKey: memoryKeys.settings(workspaceId),
    queryFn: () => getMemorySettings(workspaceId),
    enabled,
    retry: retryUnlessAbsent,
  });
}

/**
 * The digests behind the missed-conversation card, anchored at the reader's
 * cursor AS IT STOOD when the channel was opened. The live cursor moves as soon
 * as history is on screen, and `sinceLastRead` read after that would anchor at
 * the head and always answer with an empty page.
 */
export function useMissedDigests(
  workspaceId: string,
  channelId: string,
  sinceSeq: number,
  enabled: boolean
) {
  return useQuery<MemoryDigestPage>({
    queryKey: memoryKeys.digests(workspaceId, channelId, sinceSeq),
    queryFn: () =>
      listMemoryDigests(workspaceId, channelId, { sinceSeq, limit: 10 }),
    enabled,
    retry: retryUnlessAbsent,
  });
}

/**
 * The receipt behind one agent reply. A receipt never changes once written, so
 * it is cached for the session; a 404 (no receipt, or a server without memory)
 * caches as "no chip" and is not retried.
 */
export function useMemoryReceipt(
  workspaceId: string,
  runId: string | null,
  enabled: boolean
) {
  return useQuery<MemoryReceipt>({
    queryKey: memoryKeys.receipt(workspaceId, runId ?? ""),
    queryFn: () => getRunMemoryReceipt(workspaceId, runId ?? ""),
    enabled: enabled && runId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** Adapts a React Query result to the framework-free view the core derives from. */
export function queryView<T>(query: {
  status: "pending" | "error" | "success";
  data: T | undefined;
  error: unknown;
}): MemoryQueryView<T> {
  if (query.status === "success" && query.data !== undefined) {
    return { status: "success", data: query.data };
  }
  if (query.status === "error") return { status: "error", error: query.error };
  return { status: "pending" };
}

export function useWorkspaceMemoryMutation(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PatchWorkspaceMemorySettingsInput) =>
      patchWorkspaceMemorySettings(workspaceId, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: memoryKeys.settings(workspaceId) }),
  });
}

export function useMyMemoryMutation(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => patchMyMemorySettings(workspaceId, paused),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: memoryKeys.settings(workspaceId) }),
  });
}

export function useChannelMemoryMutation(workspaceId: string, channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PatchChannelMemorySettingsInput) =>
      patchChannelMemorySettings(workspaceId, channelId, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: memoryKeys.settings(workspaceId) }),
  });
}
