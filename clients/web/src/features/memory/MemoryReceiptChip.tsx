import { useState } from "react";
import { BookOpen } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import {
  WITHHELD_EXPLAIN_COPY,
  deriveReceiptChip,
  digestSourceLabel,
  unlistedLabel,
  withheldLabel,
  type ReceiptChipModel,
} from "@momo/core/features/memory/presentation";
import { EvidenceLinks } from "./EvidenceLinks";
import { useMemoryReceipt } from "./useMemory";

// =============================================================================
// 「기억 n개 참고」 칩 (ADR-0196 D7 영수증 · D12 V2, #3165).
//
// Driven by the receipt the server wrote when it assembled the reply, so the
// number is what the run was served, not a guess. No receipt (404, a server
// without memory, zero served) means no chip: a chip that says "0" or "?" is
// worse than none. A failed request also draws nothing; a missing decoration is
// not worth an error line on every reply.
//
// `withheldCount` is a count and never content, and it is echoed only when the
// API returned it (the requester alone gets it).
// =============================================================================

export function MemoryReceiptChip({
  workspaceId,
  runId,
  channelId,
  onJump,
}: {
  workspaceId: string;
  runId: string;
  channelId: string;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const receipt = useMemoryReceipt(workspaceId, runId, true);
  const model = deriveReceiptChip(receipt.data);
  if (model === null) return null;
  return (
    <ReceiptChipView model={model} channelId={channelId} onJump={onJump} />
  );
}

export function ReceiptChipView({
  model,
  channelId,
  onJump,
}: {
  model: ReceiptChipModel;
  channelId: string;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="memory-receipt-chip"
          className={cn(
            "mt-1 inline-flex h-control-sm tap-target items-center gap-2 self-start rounded-full bg-surface-muted px-3 text-meta text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
          )}
        >
          <BookOpen className="size-4 shrink-0" aria-hidden="true" />
          <span data-numeric="">{model.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid="memory-receipt-popover"
        className="flex max-h-pane-md flex-col gap-3 overflow-y-auto"
      >
        <h3 className="text-body font-semibold text-ink">이 답이 참고한 기억</h3>
        {model.digests.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {model.digests.map((digest) => (
              <li key={digest.id} data-testid="memory-receipt-digest">
                <p className="whitespace-pre-line break-keep text-body text-ink">
                  {digest.body}
                </p>
                <p className="mt-1 text-meta text-ink-muted">
                  {digestSourceLabel(digest)}
                </p>
                <EvidenceLinks
                  evidence={digest.evidence}
                  currentChannelId={channelId}
                  onJump={(messageId, seq) => {
                    setOpen(false);
                    onJump?.(messageId, seq);
                  }}
                  testId="memory-receipt-evidence"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="break-keep text-body text-ink-muted">
            참고한 기억을 이 목록에서 열 수 없어요.
          </p>
        )}
        {model.unlistedCount > 0 && model.digests.length > 0 && (
          <p
            className="break-keep text-meta text-ink-muted"
            data-testid="memory-receipt-unlisted"
          >
            {unlistedLabel(model.unlistedCount)}
          </p>
        )}
        {model.withheldCount !== null && (
          <div
            className="flex flex-col gap-1 border-t border-line pt-3"
            data-testid="memory-receipt-withheld"
          >
            <p className="break-keep text-body text-ink">
              <span data-numeric="">{withheldLabel(model.withheldCount)}</span>
            </p>
            <p className="break-keep text-meta text-ink-muted">
              {WITHHELD_EXPLAIN_COPY}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
