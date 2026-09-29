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

function newestToSeq(state: MissedCardState): number {
  return state.kind === "ready"
    ? state.digests.reduce((max, digest) => Math.max(max, digest.toSeq), 0)
    : 0;
}

export function MissedSummary({
  workspaceId,
  channelId,
  lastReadSeq,
  headSeq,
  onJump,
  onDismissed,
}: {
  workspaceId: string;
  channelId: string;
  /** The reader's cursor when the channel was opened; null for a channel never read. */
  lastReadSeq: number | null;
  /** The newest channel sequence when the channel was opened. */
  headSeq: number;
  onJump?: (messageId: string, seq: number) => void;
  /** Called after the reader closes the card, so the shell can put focus somewhere real. */
  onDismissed?: () => void;
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
  // Dismissal is remembered as "up to here": closing the card in any state hides
  // it for the visit, and only a digest that reaches PAST what was on screen (or
  // past the head the reader came back to) shows it again. Keying on the state
  // kind would bring the card back the moment loading turned into ready.
  const [dismissedThrough, setDismissedThrough] = useState<number | null>(null);

  if (state.kind === "hidden") return null;
  if (dismissedThrough !== null) {
    const fresh = state.kind === "ready" && newestToSeq(state) > dismissedThrough;
    if (!fresh) return null;
  }
  return (
    <MissedSummaryCard
      state={state}
      channelId={channelId}
      onRetry={() => {
        void settings.refetch();
        if (digests.isError) void digests.refetch();
      }}
      onDismiss={() => {
        setDismissedThrough(Math.max(headSeq, newestToSeq(state)));
        onDismissed?.();
      }}
      onJump={onJump}
    />
  );
}
