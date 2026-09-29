import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import {
  MISSED_CARD_VISIBLE_DIGESTS,
  behindHeadLabel,
  digestSourceLabel,
  type MissedCardState,
} from "@momo/core/features/memory/presentation";
import { EvidenceLinks } from "./EvidenceLinks";

// =============================================================================
// 놓친 대화 요약 카드 (ADR-0196 D12 V1, #3165). The view half: it draws a
// `MissedCardState` and nothing else. Every state is a function of what the
// server returned (`deriveMissedCard`); this file writes no summary of its own
// and has no "regenerating" line, because a stale digest is hidden by the
// database and the API cannot say it is being rebuilt.
//
// A flat band above the timeline, not a floating card: it belongs to the
// channel the reader just opened, and it leaves with one press.
// =============================================================================

export function MissedSummaryCard({
  state,
  channelId,
  onRetry,
  onDismiss,
  onJump,
}: {
  state: Exclude<MissedCardState, { kind: "hidden" }>;
  channelId: string;
  onRetry: () => void;
  onDismiss: () => void;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const [showOlder, setShowOlder] = useState(false);
  return (
    <section
      aria-label="안 읽은 동안 요약"
      data-testid="missed-summary-card"
      data-state={state.kind}
      className="mx-4 my-2 flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body font-semibold text-ink">안 읽은 동안</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="요약 닫기"
          data-testid="missed-summary-dismiss"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {state.kind === "loading" && (
        <div
          role="status"
          aria-busy="true"
          data-testid="missed-summary-loading"
          className="flex flex-col gap-2"
        >
          <span className="sr-only">요약을 불러오고 있어요</span>
          <span className="h-3 w-full rounded-sm bg-surface-muted" aria-hidden="true" />
          <span className="h-3 w-4/5 rounded-sm bg-surface-muted" aria-hidden="true" />
          <span className="h-3 w-3/5 rounded-sm bg-surface-muted" aria-hidden="true" />
        </div>
      )}

      {(state.kind === "off" ||
        state.kind === "notYet" ||
        state.kind === "empty") && (
        <p
          className="break-keep text-body text-ink-muted"
          data-testid={`missed-summary-${state.kind}`}
        >
          {state.message}
        </p>
      )}

      {state.kind === "error" && (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p
            className="break-keep text-body text-ink"
            data-testid="missed-summary-error"
          >
            {state.message}
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="missed-summary-retry"
            onClick={onRetry}
          >
            다시 시도
          </Button>
        </div>
      )}

      {state.kind === "ready" && (
        <ReadyBody
          state={state}
          channelId={channelId}
          showOlder={showOlder}
          onToggleOlder={() => setShowOlder((value) => !value)}
          onJump={onJump}
        />
      )}
    </section>
  );
}

function ReadyBody({
  state,
  channelId,
  showOlder,
  onToggleOlder,
  onJump,
}: {
  state: Extract<MissedCardState, { kind: "ready" }>;
  channelId: string;
  showOlder: boolean;
  onToggleOlder: () => void;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const olderCount = Math.max(0, state.digests.length - MISSED_CARD_VISIBLE_DIGESTS);
  const digests = showOlder
    ? state.digests
    : state.digests.slice(olderCount);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {olderCount > 0 && (
        <button
          type="button"
          className="self-start rounded-sm text-meta text-ink-muted press hover:text-ink focus-visible:focus-ring"
          aria-expanded={showOlder}
          data-testid="missed-summary-older"
          onClick={onToggleOlder}
        >
          {showOlder ? "이전 요약 접기" : `이전 요약 ${olderCount}개 보기`}
        </button>
      )}
      {digests.map((digest) => (
        <article
          key={digest.id}
          className={cn("min-w-0")}
          data-testid="missed-summary-digest"
        >
          <p className="whitespace-pre-line break-keep text-body text-ink">
            {digest.body}
          </p>
          <p className="mt-1 text-meta text-ink-muted">{digestSourceLabel(digest)}</p>
          <EvidenceLinks
            evidence={digest.evidence}
            currentChannelId={channelId}
            onJump={onJump}
            testId="missed-summary-evidence"
          />
        </article>
      ))}
      {state.behindHead && (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="missed-summary-behind"
        >
          {behindHeadLabel(state.unsummarizedCount)}
        </p>
      )}
    </div>
  );
}
