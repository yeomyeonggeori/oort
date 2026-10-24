import { useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DM_CLOSED_LIST_EMPTY,
  DM_CLOSED_LIST_HINT,
  DM_CLOSED_LIST_LABEL,
  dmClosedReasonLabel,
  dmReopenLabelFor,
} from "@momo/core/features/sidebar/dmVisibility";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";

// =============================================================================
// DM 구역 머리 「⋯ › 닫은 대화」 (ADR-0177 증보 D11, #4228). 「나간 멤버와의 대화 N개」 줄을 대신한다: 줄은 지울 수 없는 채로
// 구역 끝에 서 있었다(성재 2026-10-24). 이 목록은 내가 **닫은** 대화와 상대가 **나간** 대화를 「다시 열기」와 함께 보여 주고,
// 지금 사이드바에 보이는 대화는 넣지 않는다. 호버 클러스터의 규약(`data-section-action`)을 입고, 닫은 대화가 없으면 문이 서지 않는다.
// =============================================================================

export interface DmClosedListItem {
  id: string;
  /** 행이 그리는 이름(`channelLabelParts`). */
  name: string;
  reason: "closed" | "gone";
}

export function DmClosedMenu({
  items,
  onOpenChange,
  onReopen,
}: {
  items: readonly DmClosedListItem[];
  /** 메뉴·목록이 열려 있는 동안 헤더의 호버 클러스터를 붙들어 둔다. */
  onOpenChange: (open: boolean) => void;
  /** 한 대화를 다시 연다. 열고 주소를 옮기는 일까지 호출부가 한다. */
  onReopen: (item: DmClosedListItem) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [listOpen, setListOpen] = useState(false);
  if (items.length === 0 && !listOpen) return null;
  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label="다이렉트 메시지 메뉴"
            title="다이렉트 메시지 메뉴"
            data-section-action=""
            data-testid="dm-section-menu"
            data-closed-count={items.length}
            className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="dm-section-menu-content">
          <DropdownMenuItem
            data-testid="dm-closed-list-open"
            onSelect={() => {
              setListOpen(true);
              onOpenChange(true);
            }}
          >
            {DM_CLOSED_LIST_LABEL}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={listOpen}
        onOpenChange={(next) => {
          setListOpen(next);
          if (!next) {
            onOpenChange(false);
            restoreDialogOpenerFocus(trigger.current);
          }
        }}
      >
        <DialogContent className="gap-4 p-4" data-testid="dm-closed-list">
          <div className="flex flex-col gap-1">
            <DialogTitle>{DM_CLOSED_LIST_LABEL}</DialogTitle>
            <DialogDescription className="break-keep">{DM_CLOSED_LIST_HINT}</DialogDescription>
          </div>
          {/* 목록이 열린 채 비면(다른 기기에서 다시 열었다·새 메시지로 돌아왔다) 제목과 힌트만 남지 않게 빈 상태를 말한다. */}
          {items.length === 0 && (
            <p className="py-2 text-body text-ink-muted" data-testid="dm-closed-list-empty">
              {DM_CLOSED_LIST_EMPTY}
            </p>
          )}
          <ul className="flex max-h-[50vh] flex-col overflow-y-auto" data-testid="dm-closed-list-items">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 py-2"
                data-testid="dm-closed-list-item"
                data-reason={item.reason}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-ink">{item.name}</span>
                  <span className="truncate text-meta text-ink-muted">
                    {dmClosedReasonLabel(item.reason)}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="dm-closed-list-reopen"
                  aria-label={`${item.name}, ${dmReopenLabelFor(item.reason)}`}
                  onClick={() => {
                    setListOpen(false);
                    onOpenChange(false);
                    onReopen(item);
                  }}
                >
                  {dmReopenLabelFor(item.reason)}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
