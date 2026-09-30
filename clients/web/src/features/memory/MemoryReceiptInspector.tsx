import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Button } from "@/design/ui/button";
import {
  INSPECTOR_CLOSE,
  INSPECTOR_DIGESTS_HEADING,
  INSPECTOR_ITEMS_HEADING,
  INSPECTOR_NOTE,
  INSPECTOR_NOTHING_READABLE,
  INSPECTOR_OPEN_ITEM,
  INSPECTOR_TITLE,
  RECEIPT_ONLY_READABLE,
  WITHHELD_EXPLAIN_COPY,
  digestSourceLabel,
  inspectorBudgetLabel,
  inspectorItemMeta,
  inspectorModelLabel,
  inspectorUnlistedLabel,
  receiptSummaryLabel,
  withheldLabel,
  type ReceiptChipModel,
} from "@momo/core/features/memory/presentation";
import {
  memoryKindLabel,
  memoryOriginLabel,
} from "@momo/core/features/memory/browser";
import { EvidenceLinks } from "./EvidenceLinks";

// =============================================================================
// 서빙 인스펙터: 「이 답에 쓰인 기억」 (ADR-0196 D7 영수증 · D12 V6, #3174).
//
// 서버가 이 답을 만들 때 쓴 영수증을 그대로 그린다: 실린 요약과 항목, 기억 칸 예산, 보류 개수.
// 지금 다시 찾은 결과가 아니다. 그래서 여기서는 아무것도 걸러 내거나 채워 넣지 않는다.
//   - 읽을 수 없는 기억은 목록에 없고 개수만 「열어 볼 수 없는 기억」으로 말한다.
//   - 보류 개수는 API가 주었을 때만(요청자에게만) 그리고 0이면 그리지 않는다. 내용은 없다.
// =============================================================================

const DAY = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });

export function MemoryReceiptInspector({
  open,
  onOpenChange,
  model,
  channelId,
  opener,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ReceiptChipModel;
  channelId: string;
  opener: HTMLElement | null;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const nothingListed = model.digests.length === 0 && model.items.length === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent opener={opener} data-testid="memory-inspector">
        <div className="flex max-h-pane-lg flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-col gap-1">
            <DialogTitle>{INSPECTOR_TITLE}</DialogTitle>
            <DialogDescription data-testid="memory-inspector-summary">
              <span data-numeric="">
                {receiptSummaryLabel(model.servedCount)}
              </span>
            </DialogDescription>
            <p
              className="break-keep text-meta text-ink-muted"
              data-testid="memory-inspector-budget"
            >
              <span data-numeric="">
                {inspectorBudgetLabel(model.usedChars, model.budgetChars)}
              </span>
            </p>
          </div>

          {model.digests.length > 0 && (
            <section
              aria-label={INSPECTOR_DIGESTS_HEADING}
              className="flex flex-col gap-2"
              data-testid="memory-inspector-digests"
            >
              <h3 className="text-meta font-medium text-ink-muted">
                {INSPECTOR_DIGESTS_HEADING}
              </h3>
              <ul className="flex flex-col gap-3">
                {model.digests.map((digest) => (
                  <li key={digest.id} data-testid="memory-inspector-digest">
                    <p className="whitespace-pre-line break-keep text-body text-ink">
                      {digest.body}
                    </p>
                    <p className="mt-1 text-meta text-ink-muted">
                      {digestSourceLabel(digest)}
                      {digest.model !== undefined
                        ? ` · ${inspectorModelLabel(digest.model)}`
                        : ""}
                    </p>
                    <EvidenceLinks
                      evidence={digest.evidence}
                      currentChannelId={channelId}
                      onJump={(messageId, seq) => {
                        onOpenChange(false);
                        onJump?.(messageId, seq);
                      }}
                      testId="memory-inspector-evidence"
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {model.items.length > 0 && (
            <section
              aria-label={INSPECTOR_ITEMS_HEADING}
              className="flex flex-col gap-2"
              data-testid="memory-inspector-items"
            >
              <h3 className="text-meta font-medium text-ink-muted">
                {INSPECTOR_ITEMS_HEADING}
              </h3>
              <ul className="flex flex-col gap-3">
                {model.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1"
                    data-testid="memory-inspector-item"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-surface-muted px-2 py-1 text-meta text-ink-muted">
                        {memoryKindLabel(item.kind)}
                      </span>
                      <span className="text-meta text-ink-muted">
                        {memoryOriginLabel(item.origin)}
                      </span>
                    </span>
                    <p className="whitespace-pre-line break-keep text-body text-ink">
                      {item.body}
                    </p>
                    <p className="text-meta text-ink-muted" data-numeric="">
                      {inspectorItemMeta(
                        DAY.format(item.validFromMs),
                        item.sourceCount
                      )}
                    </p>
                    <div>
                      <Link
                        to={`/memory?item=${encodeURIComponent(item.id)}`}
                        onClick={() => onOpenChange(false)}
                        className="tap-target inline-flex h-control-sm items-center rounded-md bg-surface-muted px-3 text-meta text-ink press hover:bg-surface-hover focus-visible:focus-ring"
                        data-testid="memory-inspector-item-link"
                      >
                        {INSPECTOR_OPEN_ITEM}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {nothingListed && (
            <p
              className="break-keep text-body text-ink-muted"
              data-testid="memory-inspector-nothing"
            >
              {INSPECTOR_NOTHING_READABLE}
            </p>
          )}
          {model.unlistedCount > 0 && (
            <p
              className="break-keep text-meta text-ink-muted"
              data-testid="memory-inspector-unlisted"
            >
              <span data-numeric="">
                {inspectorUnlistedLabel(model.unlistedCount)}
              </span>
            </p>
          )}
          <p className="break-keep text-meta text-ink-muted">
            {RECEIPT_ONLY_READABLE}
          </p>
          <p className="break-keep text-meta text-ink-muted">
            {INSPECTOR_NOTE}
          </p>

          {model.withheldCount !== null && (
            <div
              className="flex flex-col gap-1 border-t border-line pt-3"
              data-testid="memory-inspector-withheld"
            >
              <p className="break-keep text-body text-ink">
                <span data-numeric="">
                  {withheldLabel(model.withheldCount)}
                </span>
              </p>
              <p className="break-keep text-meta text-ink-muted">
                {WITHHELD_EXPLAIN_COPY}
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tap-target"
              onClick={() => onOpenChange(false)}
              data-testid="memory-inspector-close"
            >
              {INSPECTOR_CLOSE}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
