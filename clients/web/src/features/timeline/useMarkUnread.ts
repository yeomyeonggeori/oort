import { useQueryClient } from "@tanstack/react-query";
import { uuidEq, type ReadState } from "@momo/core/lib/api";
import { markUnreadFailureMessage } from "@momo/core/features/readState/copy";
import { advertiseReadState } from "@/features/chat/advertiseReadState";
import { applyReadStateToCache } from "@/features/workspace/useWorkspace";

export interface MarkUnreadInput {
  channelId: string;
  lastReadSeq: number;
  seq: number;
}

/**
 * 「여기부터 안 읽음」. Optimistic local mark, then PUT with
 * `mark_unread_before_seq` and no `read_intent` (background). A 400/403
 * rolls the cache back; the caller puts the Korean sentence on the row
 * banner.
 */
export function useMarkUnread(workspaceId: string): {
  run: (input: MarkUnreadInput) => Promise<void>;
} {
  const client = useQueryClient();
  return {
    async run({ channelId, lastReadSeq, seq }) {
      const queryKey = ["read-state", workspaceId] as const;
      const previous = client.getQueryData<ReadState[]>(queryKey);
      const cursor =
        previous?.find((row) => uuidEq(row.channelId, channelId))
          ?.lastReadSeq ?? lastReadSeq;
      client.setQueryData<ReadState[]>(queryKey, (current) => {
        if (!current) return current;
        return current.map((row) =>
          uuidEq(row.channelId, channelId)
            ? { ...row, markedUnreadBeforeSeq: seq }
            : row
        );
      });
      try {
        const next = await advertiseReadState(
          workspaceId,
          channelId,
          cursor,
          "mark_unread",
          { markUnreadBeforeSeq: seq }
        );
        applyReadStateToCache(client, workspaceId, next);
      } catch (error) {
        if (previous !== undefined) {
          client.setQueryData(queryKey, previous);
        }
        throw new Error(markUnreadFailureMessage(error));
      }
    },
  };
}
