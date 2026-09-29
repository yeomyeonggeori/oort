import { useState } from "react";
import {
  deriveMissedCard,
  memoryOffReason,
  type MissedCardState,
} from "@momo/core/features/memory/presentation";
import { MissedSummaryCard } from "./MissedSummaryCard";
import {
  queryView,
  useMemorySettings,
  useMissedDigests,
} from "./useMemory";

// =============================================================================
// 놓친 대화 요약 (V1, #3165): the connected half. Mounted by the channel shell
// when the reader comes back to unread messages.
//
// The anchor is the read cursor AS IT STOOD when the channel was opened
// (`lastReadSeq`), and `headSeq` is the newest sequence at that moment. Both are
// visit-frozen by the shell, so the card does not change under the reader when
// the live cursor advances.
//
// Dismissal is per visit: it lives in this component's state, keyed by what the
// card showed (state and newest digest), so a newer digest or a different state
// shows again. Leaving the channel and coming back with new unread starts clean.
// =============================================================================

function shownKey(state: MissedCardState): string {
  if (state.kind === "ready") {
    const newest = state.digests.reduce((max, digest) => Math.max(max, digest.toSeq), 0);
    return `ready:${newest}`;
  }
  return state.kind;
}

export function MissedSummary({
  workspaceId,
  channelId,
  lastReadSeq,
  headSeq,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  /** The reader's cursor when the channel was opened; null for a channel never read. */
  lastReadSeq: number | null;
  /** The newest channel sequence when the channel was opened. */
  headSeq: number;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const settings = useMemorySettings(workspaceId);
  const off =
    settings.status === "success"
      ? memoryOffReason(settings.data, channelId)
      : null;
  // No digest request while memory is off: the answer would only be empty, and
  // the card must say WHY instead of reading as "nothing to summarize".
  const digests = useMissedDigests(
    workspaceId,
    channelId,
    lastReadSeq ?? 0,
    settings.status === "success" && off === null
  );

  const state: MissedCardState = deriveMissedCard({
    settings: queryView(settings),
    digests:
      settings.status === "success" && off === null ? queryView(digests) : null,
    channelId,
    headSeq,
  });
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (state.kind === "hidden") return null;
  const key = shownKey(state);
  if (dismissed === key) return null;
  return (
    <MissedSummaryCard
      state={state}
      channelId={channelId}
      onRetry={() => {
        void settings.refetch();
        if (digests.isError) void digests.refetch();
      }}
      onDismiss={() => setDismissed(key)}
      onJump={onJump}
    />
  );
}
