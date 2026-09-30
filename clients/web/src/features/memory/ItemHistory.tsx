import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { InlineBanner } from "@/features/common/States";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import type { MembershipRole } from "@momo/core/lib/api";
import type { MemoryItemEvent } from "@momo/core/features/memory/model";
import {
  DETAIL_HISTORY_EMPTY,
  DETAIL_HISTORY_ERROR,
  DETAIL_HISTORY_HEADING,
  memberMayWriteMemory,
  memoryEventLabel,
} from "@momo/core/features/memory/browser";
import {
  CLEANUP_NOTE,
  REVERT_ALREADY,
  REVERT_AUTOMATIC,
  REVERT_BUSY,
  REVERT_CANCEL_LABEL,
  REVERT_CONFIRM_LABEL,
  REVERT_CONSEQUENCE,
  REVERT_GUEST_READONLY,
  REVERT_LABEL,
  REVERT_OFFLINE,
  REVERT_TITLE,
  canRevertEvent,
  consolidationEventView,
  revertError,
  revertedSuccessFrom,
  type ConsolidationEventView,
} from "@momo/core/features/memory/timeline";
import { useRevertConsolidation } from "./useMemory";

// =============================================================================
// 기억 하나의 이력 + 자동 정리 되돌리기 (ADR-0196 D4 · D12 V5, #3174).
//
// 상세 창의 이력 목록을 이 컴포넌트가 이어받는다(복제하지 않는다). 정리 사건(합침·기간 닫힘·
// 감쇠·되돌림)만 이름표와 「되돌리기」를 더 얻는다. 되돌리기는 확인을 한 번 거치고, 실패는
// 403·404·409·422를 각각 한 문장으로 돌려준다. 게스트와 연결 끊김은 버튼 대신 이유를 말한다.
// =============================================================================

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function ItemHistory({
  workspaceId,
  itemId,
  events,
  role,
  offline,
  onReverted,
  onGone,
}: {
  workspaceId: string;
  itemId: string;
  events: {
    isPending: boolean;
    isError: boolean;
    data: MemoryItemEvent[] | undefined;
  };
  role: MembershipRole | undefined;
  offline: boolean;
  onReverted: (message: string) => void;
  onGone: (message: string) => void;
}) {
  const directory = useDirectory(workspaceId).directory;
  const revert = useRevertConsolidation(workspaceId);
  const [target, setTarget] = useState<ConsolidationEventView | null>(null);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = (events.data ?? []).map((event) =>
    consolidationEventView(
      event,
      events.data ?? [],
      memoryEventLabel(event.action, event.detail)
    )
  );
  const hasRevertable = rows.some(
    (row) => row.kind !== null && !row.alreadyReverted
  );
  const hasCleanup = rows.some(
    (row) => row.kind !== null || row.event.action === "reverted"
  );
  const mayWrite = memberMayWriteMemory(role);

  function confirm() {
    if (target === null || revert.isPending) return;
    setError(null);
    revert.mutate(
      { itemId, eventId: target.event.id },
      {
        onSuccess: (result) => {
          setTarget(null);
          onReverted(revertedSuccessFrom(result));
        },
        onError: (failure) => {
          setTarget(null);
          const view = revertError(failure);
          setError(view.message);
          if (view.gone) onGone(view.message);
        },
      }
    );
  }

  return (
    <section
      aria-label={DETAIL_HISTORY_HEADING}
      className="flex flex-col gap-2"
      data-testid="memory-history"
    >
      <h3 className="text-meta font-medium text-ink-muted">
        {DETAIL_HISTORY_HEADING}
      </h3>
      {hasCleanup && (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="memory-history-cleanup-note"
        >
          {CLEANUP_NOTE}
        </p>
      )}
      {hasRevertable && !mayWrite && (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="memory-history-guest"
        >
          {REVERT_GUEST_READONLY}
        </p>
      )}
      {hasRevertable && mayWrite && offline && (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="memory-history-offline"
        >
          {REVERT_OFFLINE}
        </p>
      )}
      {error !== null && (
        <InlineBanner
          message={error}
          actionLabel="닫기"
          onAction={() => setError(null)}
          testId="memory-history-error"
        />
      )}
      {events.isPending ? (
        <p className="text-meta text-ink-muted">불러오고 있어요.</p>
      ) : events.isError || !events.data ? (
        <p
          className="text-meta text-ink-muted"
          data-testid="memory-detail-events-error"
        >
          {DETAIL_HISTORY_ERROR}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-meta text-ink-muted">{DETAIL_HISTORY_EMPTY}</p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="memory-detail-events">
          {rows.map((row) => {
            const actor =
              row.event.actorMemberId !== undefined
                ? (memberFor(directory, row.event.actorMemberId)?.displayName ??
                  null)
                : null;
            const revertable = canRevertEvent(row, role);
            return (
              <li
                key={row.event.id}
                className="flex flex-col gap-1 text-meta"
                data-testid="memory-detail-event"
                data-event-kind={row.kind ?? undefined}
              >
                <span className="text-ink">{row.label}</span>
                <span className="text-ink-muted">
                  {actor !== null
                    ? `${actor} · `
                    : row.kind !== null || row.event.action === "reverted"
                      ? `${REVERT_AUTOMATIC} · `
                      : ""}
                  {DATE_TIME.format(row.event.createdAtMs)}
                </span>
                {row.kind !== null && row.alreadyReverted && (
                  <span
                    className="text-ink-muted"
                    data-testid="memory-event-reverted"
                  >
                    {REVERT_ALREADY}
                  </span>
                )}
                {revertable && (
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="tap-target"
                      disabled={offline}
                      onClick={(click) => {
                        setOpener(click.currentTarget);
                        setTarget(row);
                      }}
                      data-testid="memory-event-revert"
                    >
                      {REVERT_LABEL}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !revert.isPending) setTarget(null);
        }}
      >
        <DialogContent
          opener={opener}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (revert.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (revert.isPending) event.preventDefault();
          }}
          data-testid="memory-revert-dialog"
        >
          <div className="flex flex-col gap-3 p-4">
            <DialogTitle>{REVERT_TITLE}</DialogTitle>
            <DialogDescription data-testid="memory-revert-description">
              {target?.kind != null ? REVERT_CONSEQUENCE[target.kind] : ""}
            </DialogDescription>
            {target !== null && (
              <p className="break-keep text-body text-ink">{target.label}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="tap-target"
                disabled={revert.isPending}
                onClick={() => setTarget(null)}
                data-testid="memory-revert-cancel"
              >
                {REVERT_CANCEL_LABEL}
              </Button>
              <Button
                type="button"
                size="sm"
                className="tap-target"
                aria-busy={revert.isPending || undefined}
                onClick={confirm}
                data-testid="memory-revert-confirm"
              >
                {revert.isPending && (
                  <Loader2 aria-hidden="true" className="spinner-busy" />
                )}
                {revert.isPending ? REVERT_BUSY : REVERT_CONFIRM_LABEL}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
