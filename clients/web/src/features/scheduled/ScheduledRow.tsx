import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { Hash, Loader2, Lock, MoreHorizontal } from "lucide-react";
import { SCHEDULED_COPY, failureLines } from "@momo/core/features/scheduled/copy";
import type { ScheduledErrorLine } from "@momo/core/features/scheduled/errors";
import { isScheduledStub } from "@momo/core/features/scheduled/events";
import {
  actionLabel,
  attachmentChipLine,
  rowActions,
  rowAriaName,
  rowMenuAriaName,
  rowWhenLine,
  scheduledPreview,
  type ScheduledActionId,
} from "@momo/core/features/scheduled/model";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { MemberAvatar } from "@/features/common/MemberAvatar";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import type { ScheduledPlaceInfo } from "./useScheduled";

// =============================================================================
// 목록의 행 하나 (UI 명세 1.7·1.8, ADR-0208 D8·D9·D14, #4215).
//
//   보낼 예정   채널 이름 · 미리보기 두 줄 · 첨부 칩 · 「{시각}에 보내요」(마감 30초 안은 「곧 보내요」, 지난 뒤는
//               「보내는 중」). 행 끝 `⋯`에 지금 보내기·시간 바꾸기·고치기·지우기. 상시 버튼은 없다.
//   보내지 못함 위험 어조의 이유 줄과 보조 어조의 다음 행동 줄. **이 행은 「행 동작은 상시 버튼이 아니다」의 명시된
//               예외다**(README 4 오류: 다음 행동을 맥락 안에): 되살릴 수 있는 사유(`missed`·`send_error`)는
//               「지금 보내기」(주, 잉크)·「다시 예약」(보조), 나머지는 「내용 복사」(보조)만 보인다. 전체는 `⋯`에 있다.
//   sessions_ended 행에는 「내용 확인」만 보인다(`⋯`에도 지금 보내기·다시 예약이 없다): 본문 전체를 본 확인 안에서만
//               서버를 부른다.
//
// 동작의 집합과 순서는 코어 `rowActions`가 정한다(웹·폰이 같은 답). 오프라인에서는 모든 동작이 흐리고(캐시된 목록은 그대로
// 보인다), 마감 30초 안의 「시간 바꾸기」·「고치기」는 `lock.reason`을 둘째 줄로 말하며 흐리다. 「지금 보내기」·「지우기」는
// 보내기 전까지 계속 된다. 흐린 항목은 `disabled`가 아니라 `aria-disabled`라서 키보드가 닿고 사유가 읽힌다.
//
// 같은 동작이 두 문으로 열린다(명세 1.1: 「행 끝 `⋯` 오버플로 + 컨텍스트 메뉴」): 행 끝 `⋯`(키보드·터치의 문)와 행의
// 우클릭(포인터의 문). 둘은 **같은 항목 목록을 같은 함수로** 그린다(`renderMenuItems`). 우클릭 문은 `(hover: none)`에서
// 닫는다: 폰·태블릿에서는 목록을 끌어 올리려는 손가락이 길게 눌러 메뉴를 여는 일이 생긴다(사이드바 행 메뉴의 같은 판정).
// =============================================================================

/** 두 메뉴의 항목이 받는 것 중 이 행이 쓰는 몫. 드롭다운 항목과 우클릭 항목은 같은 모양의 프롭을 받는다. */
interface RowMenuItemProps {
  tone?: "danger";
  layout?: "row" | "stack";
  className?: string;
  "aria-disabled"?: boolean;
  "data-testid"?: string;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
}
type RowMenuItem = ComponentType<RowMenuItemProps>;
const DropdownItem = DropdownMenuItem as RowMenuItem;
const ContextItem = ContextMenuItem as RowMenuItem;

/**
 * 행 앞머리. DM은 상대의 아바타(명세 1.7: 「{이름}과의 대화」와 아바타)이고, 나머지는 채널 종류 아이콘이다. 앞머리 칸은 **모든
 * 행이 24px 한 칸**이다(아바타가 24px이고 아이콘은 그 칸에 가운데로 선다): 칸이 행마다 다르면 DM 행의 이름만 8px 오른쪽에서
 * 시작해 목록의 왼쪽 선이 흔들린다. 상대를 못 읽는 행(나간 멤버)도 `MemberAvatar`가 자리를 지킨다(글자를 지어내지 않는다).
 */
function Leading({ place }: { place: ScheduledPlaceInfo }) {
  if (place.kind === "dm") return <MemberAvatar member={place.peer} size="sm" />;
  const className = "size-4 text-ink-muted";
  return place.kind === "private" ? <Lock className={className} /> : <Hash className={className} />;
}

export interface ScheduledRowProps {
  row: ScheduledMessage;
  place: ScheduledPlaceInfo;
  nowMs: number;
  offline: boolean;
  /** 이 행에서 지금 나는 동작(「보내는 중」). */
  busy: ScheduledActionId | null;
  /** 이 행의 마지막 동작이 실패했다(시간으로 사라지지 않는다). */
  error: ScheduledErrorLine | null;
  onAction: (action: ScheduledActionId, row: ScheduledMessage, opener: HTMLElement | null) => void;
}

export function ScheduledRow({ row, place, nowMs, offline, busy, error, onAction }: ScheduledRowProps) {
  const actions = rowActions(row, nowMs);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chosen = useRef<ScheduledActionId | null>(null);
  const stub = isScheduledStub(row);
  const hoverNone = useHoverNone();
  const copyBody = useClipboardCopy(row.body ?? "");
  // 복사가 실패했다(클립보드를 못 쓰는 곳). 되살릴 수 없는 실패 행에서 「내용 복사」는 유일한 상시 단추라 조용히 아무 일도 안 하면
  // 사람이 영문을 모른다: 행 안에 이유와 다음 행동이 선다. 다음 복사가 성공하면 걷힌다.
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = () => {
    void copyBody.copy().then((ok) => setCopyFailed(!ok));
  };
  const preview = scheduledPreview(row);
  const attachments = attachmentChipLine(row);
  const failed = row.status === "failed";
  const lines = failed ? failureLines(row.failureReason, place.errorWord) : null;
  const name = rowAriaName(row, place.label, nowMs, place.errorWord);

  // 본문이 아직 없는 행(이벤트로만 안 행)은 복사할 것이 없다.
  const unavailable = (action: ScheduledActionId): boolean =>
    offline || (action === "copy" && stub) || actions.locked.includes(action);

  const run = (action: ScheduledActionId, opener: HTMLElement | null) => {
    if (action === "copy") {
      copy();
      return;
    }
    onAction(action, row, opener);
  };

  const inlineButton = (action: ScheduledActionId, primary: boolean) => {
    const sending = action === "sendNow" && busy === "sendNow";
    return (
      <Button
        key={action}
        type="button"
        size="sm"
        variant={primary ? "default" : "secondary"}
        aria-disabled={unavailable(action) || undefined}
        aria-busy={sending || undefined}
        className={cn("tap-target", unavailable(action) && "opacity-50")}
        data-testid={`scheduled-row-${action}`}
        onClick={(event) => {
          if (unavailable(action) || busy !== null) return;
          run(action, event.currentTarget);
        }}
      >
        {sending && <Loader2 aria-hidden="true" className="spinner-busy" />}
        {sending
          ? SCHEDULED_COPY.list.sending
          : action === "copy" && copyBody.copied
            ? "복사됨"
            : actionLabel(action)}
      </Button>
    );
  };

  /** 메뉴가 닫힌 **뒤에** 동작한다: 대화상자의 초점이 메뉴의 초점 반환과 싸우지 않는다. 두 문이 같은 규칙이다. */
  const onMenuClosed = (event: Event) => {
    const action = chosen.current;
    chosen.current = null;
    if (action === null) return;
    event.preventDefault();
    onAction(action, row, triggerRef.current);
  };

  /** 두 메뉴가 같은 항목을 같은 규칙으로 그린다. 시험 이름표만 문마다 다르다. */
  const renderMenuItems = (Item: RowMenuItem, testPrefix: string) =>
    actions.menu.map((action) => {
      const dim = unavailable(action);
      const lockedReason = !offline && actions.locked.includes(action);
      return (
        <Item
          key={action}
          {...(action === "delete" ? { tone: "danger" as const } : {})}
          layout={lockedReason ? "stack" : "row"}
          aria-disabled={dim || undefined}
          data-testid={`${testPrefix}-${action}`}
          onSelect={(event: Event) => {
            if (dim || busy !== null) {
              event.preventDefault();
              return;
            }
            if (action === "copy") {
              // 메뉴를 열어 둔다: 「복사됨」은 항목 자신의 낱말이다.
              event.preventDefault();
              copy();
              return;
            }
            chosen.current = action;
          }}
        >
          {/* 흐린 것은 **낱말**뿐이다. 항목을 통째로 흐리면 둘째 줄(왜 흐린가)이 한 번 더 흐려져 읽히지 않는다
              (`ink-muted`의 50%는 라이트 2.2:1, design-review #4215 M2): 그 줄은 이 항목이 왜 흐린지를 말하는 유일한 문장이다. */}
          <span className={cn(dim && "opacity-50")}>
            {action === "copy" && copyBody.copied ? "복사됨" : actionLabel(action)}
          </span>
          {lockedReason && <span className="text-meta text-ink-muted">{SCHEDULED_COPY.lock.reason}</span>}
        </Item>
      );
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={hoverNone}>
        <li
          className="relative border-b border-line"
          data-testid="scheduled-row"
          data-row-id={row.id}
          data-status={row.status}
          {...(row.failureReason === undefined ? {} : { "data-failure": row.failureReason })}
        >
          <div role="group" aria-label={name} className="flex gap-3 py-2 pl-4 pr-3">
            <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <Leading place={place} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 truncate text-body font-semibold",
                    place.isAgent ? "text-agent" : "text-ink"
                  )}
                  data-testid="scheduled-row-place"
                >
                  {place.label}
                </span>
                {attachments !== null && (
                  <span className="shrink-0 text-meta text-ink-muted" data-testid="scheduled-row-attachments">
                    {attachments}
                  </span>
                )}
              </div>
              {stub ? (
                // 이벤트로만 안 행: 본문은 뒤따르는 목록 읽기가 채운다. 높이를 지키는 중성 막대다.
                <div
                  // 손으로 그린 막대다: 이 앱의 `Skeleton`을 쓸 수 없다. 목록 전체가 이미 `Skeleton`(ready) 안에 있고, 그 CSS
                  // 규칙 `.skel.is-settled .skel-bars`가 **자손 전부**의 막대 층을 숨겨서(높이 0·visibility hidden) 중첩된
                  // `Skeleton`은 아무것도 그리지 못한다(진짜 브라우저 캡처가 높이 0으로 잡았다). 막대 모양은 `Skeleton`의
                  // 막대(`h-6 rounded-sm bg-surface-hover`)와 같다.
                  className="h-6 w-2/3 rounded-sm bg-surface-hover"
                  aria-hidden="true"
                  data-testid="scheduled-row-stub"
                />
              ) : (
                preview !== "" && (
                  <p className="line-clamp-2 break-keep text-body text-ink-muted" data-testid="scheduled-row-preview">
                    {preview}
                  </p>
                )
              )}
              {lines === null ? (
                <p className="text-meta text-ink-muted" data-numeric data-testid="scheduled-row-when">
                  {rowWhenLine(row, nowMs)}
                </p>
              ) : (
                <>
                  <p className="break-keep text-meta text-danger" data-testid="scheduled-row-reason">
                    {lines.reason}
                  </p>
                  <p className="break-keep text-meta text-ink-muted" data-testid="scheduled-row-next">
                    {lines.next}
                  </p>
                </>
              )}
              {error !== null && (
                <div className="flex flex-col gap-1" role="alert" data-testid="scheduled-row-error">
                  <p className="break-keep text-meta text-danger">{error.text}</p>
                  {error.next !== undefined && (
                    <p className="break-keep text-meta text-ink-muted">{error.next}</p>
                  )}
                </div>
              )}
              {actions.inline.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {actions.inline.map((action, index) => inlineButton(action, index === 0 && action !== "copy"))}
                </div>
              )}
              {/* 실패 줄은 단추 **아래**에 선다: 위에 서면 방금 누른 단추가 44px 밀려 포인터 밑에서 움직인다(design-review 재확인 Nitpick). */}
              {copyFailed && (
                <div className="flex flex-col gap-1" role="alert" data-testid="scheduled-row-copy-error">
                  <p className="break-keep text-meta text-danger">{SCHEDULED_COPY.list.copyFailed.reason}</p>
                  <p className="break-keep text-meta text-ink-muted">{SCHEDULED_COPY.list.copyFailed.next}</p>
                </div>
              )}
            </div>
            <div className="shrink-0">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    ref={triggerRef}
                    type="button"
                    aria-label={rowMenuAriaName(row, place.label, nowMs)}
                    data-testid="scheduled-row-menu"
                    className="tap-target flex size-control items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  data-testid="scheduled-row-menu-panel"
                  onCloseAutoFocus={onMenuClosed}
                >
                  {renderMenuItems(DropdownItem, "scheduled-row-menu")}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="scheduled-row-context-panel"
        aria-label={rowMenuAriaName(row, place.label, nowMs)}
        onCloseAutoFocus={onMenuClosed}
      >
        {renderMenuItems(ContextItem, "scheduled-row-context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}
