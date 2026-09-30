import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  acceptMemoryProposal,
  editMemoryItem,
  forgetMemoryItem,
  getMemoryItem,
  getMemoryItemEvents,
  getMemorySettings,
  listMemoryItems,
  listMemoryProposals,
  rejectMemoryProposal,
  getRunMemoryReceipt,
  listMemoryDigests,
  patchChannelMemorySettings,
  patchMyMemorySettings,
  patchWorkspaceMemorySettings,
} from "@momo/core/features/memory/api";
import { fetchMessages, type Message } from "@momo/core/lib/api";
import { evidenceSeqRange } from "@momo/core/features/memory/browser";
import type {
  EditMemoryItemInput,
  ListMemoryItemsOptions,
  MemoryItemDetail,
  MemoryItemEvent,
  MemoryItemPage,
  MemoryProposal,
  MemoryProposalEvidence,
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
  proposals: (workspaceId: string, channelId: string, runId: string) =>
    ["memory", "proposals", workspaceId, channelId, runId] as const,
  evidenceText: (workspaceId: string, channelId: string, ids: string) =>
    ["memory", "evidence-text", workspaceId, channelId, ids] as const,
  items: (workspaceId: string) => ["memory", "items", workspaceId] as const,
  itemList: (workspaceId: string, options: ListMemoryItemsOptions) =>
    ["memory", "items", workspaceId, "list", options] as const,
  item: (workspaceId: string, itemId: string) =>
    ["memory", "items", workspaceId, "one", itemId] as const,
  itemEvents: (workspaceId: string, itemId: string) =>
    ["memory", "items", workspaceId, "events", itemId] as const,
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

// ---- 「기억해 둘게요」 제안 (#3170) --------------------------------------------

/**
 * The pending proposals under one agent reply. Unlike a receipt this MUTATES
 * (someone else may decide it), so it is fetched fresh per mount and there is no
 * realtime signal to wait for. The server returns an empty list for a channel the
 * caller cannot read, which is "no card", not an error.
 */
export function useRunProposals(
  workspaceId: string,
  channelId: string,
  runId: string | null,
  enabled: boolean
) {
  return useQuery<MemoryProposal[]>({
    queryKey: memoryKeys.proposals(workspaceId, channelId, runId ?? ""),
    queryFn: () =>
      listMemoryProposals(workspaceId, channelId, {
        runId: runId ?? "",
        status: "pending",
        limit: 5,
      }),
    enabled: enabled && runId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useProposalDecision(workspaceId: string) {
  return useMutation({
    mutationFn: ({
      proposalId,
      decision,
    }: {
      proposalId: string;
      decision: "accept" | "reject";
    }) =>
      decision === "accept"
        ? acceptMemoryProposal(workspaceId, proposalId)
        : rejectMemoryProposal(workspaceId, proposalId),
  });
}

/**
 * The text of a proposal's source messages. The API sends ids and sequence numbers
 * only, so the text comes through the ordinary message read path: one page read
 * over the sequence range when the sources sit together, single reads otherwise.
 * Resolves to `null` for a message that is gone or that this reader cannot see.
 */
export function useEvidenceMessages(
  workspaceId: string,
  channelId: string,
  evidence: MemoryProposalEvidence[],
  enabled: boolean
) {
  const ids = evidence.map((row) => row.messageId).join(",");
  return useQuery<Record<string, Message | null>>({
    queryKey: memoryKeys.evidenceText(workspaceId, channelId, ids),
    queryFn: async () => {
      const wanted = new Set(evidence.map((row) => row.messageId.toLowerCase()));
      const found = new Map<string, Message>();
      const keep = (messages: Message[]) => {
        for (const message of messages) {
          if (wanted.has(message.id.toLowerCase())) found.set(message.id.toLowerCase(), message);
        }
      };
      const range = evidenceSeqRange(evidence.map((row) => row.seq));
      if (range !== null) {
        keep((await fetchMessages(workspaceId, channelId, range)).messages);
      } else {
        const pages = await Promise.all(
          evidence.map((row) =>
            fetchMessages(workspaceId, channelId, { before: row.seq + 1, limit: 1 })
          )
        );
        for (const page of pages) keep(page.messages);
      }
      const out: Record<string, Message | null> = {};
      for (const row of evidence) {
        const message = found.get(row.messageId.toLowerCase());
        out[row.messageId] =
          message !== undefined && message.state !== "deleted" ? message : null;
      }
      return out;
    },
    enabled: enabled && evidence.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}

// ---- 기억 브라우저 (#3170) ----------------------------------------------------

export function useMemoryItemList(workspaceId: string, options: ListMemoryItemsOptions) {
  const searching = options.q !== undefined && options.q.trim() !== "";
  return useInfiniteQuery<MemoryItemPage>({
    queryKey: memoryKeys.itemList(workspaceId, options),
    queryFn: ({ pageParam }) =>
      listMemoryItems(workspaceId, {
        ...options,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        limit: options.limit ?? 30,
      }),
    initialPageParam: undefined as string | undefined,
    // A search is ranked and has no cursor (at most 50 hits).
    getNextPageParam: (last) => (searching ? undefined : last.nextCursor),
    retry: retryUnlessAbsent,
  });
}

export function useMemoryItem(workspaceId: string, itemId: string | null) {
  return useQuery<MemoryItemDetail>({
    queryKey: memoryKeys.item(workspaceId, itemId ?? ""),
    queryFn: () => getMemoryItem(workspaceId, itemId ?? ""),
    enabled: itemId !== null,
    // A 404 is "gone or hidden" and will not change on retry.
    retry: false,
  });
}

export function useMemoryItemEvents(workspaceId: string, itemId: string | null) {
  return useQuery<MemoryItemEvent[]>({
    queryKey: memoryKeys.itemEvents(workspaceId, itemId ?? ""),
    queryFn: () => getMemoryItemEvents(workspaceId, itemId ?? ""),
    enabled: itemId !== null,
    retry: false,
  });
}

export function useEditMemoryItem(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: EditMemoryItemInput }) =>
      editMemoryItem(workspaceId, itemId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: memoryKeys.items(workspaceId) }),
  });
}

export function useForgetMemoryItem(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => forgetMemoryItem(workspaceId, itemId),
    onSuccess: () => client.invalidateQueries({ queryKey: memoryKeys.items(workspaceId) }),
  });
}
