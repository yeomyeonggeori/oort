import { useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { Link } from "react-router-dom";
import {
  Hash,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  EmptyInvite,
  InlineBanner,
  Skeleton,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import { clearDraft } from "@/features/chat/draftStore";
import { relativeLabel } from "@momo/core/features/inbox/model";
import {
  channelPathForDraft,
  type DraftKind,
  type DraftViewItem,
} from "./model";
import { useDraftsPanel } from "./useDraftsPanel";

// =============================================================================
// 크로스채널 초안 패널 (#1901). 쓰다 만 글은 이미 draftStore에 있고, 여기는
// 그것을 한 목록으로 모아 해당 채널 컴포저로 돌려보낸다. 삭제는 로컬 초안이라
// 확인 없이 지운다. 실행 취소는 없으므로 지우는 손은 hover/⋯ 안에만 둔다.
// =============================================================================

const DRAFT_ROW_HINT_ID = "drafts-row-hint";

// MessageActions hover toolbar: raised bowl + muted→ink on hover. The row
// already washes to `surface-hover`, so the same fill on ⋯ is 1.00:1.
const overflowBowlClass =
  "absolute right-2 top-2 z-20 rounded-md border border-line-strong bg-surface-raised p-px shadow-lg";
const overflowTriggerClass =
  "tap-target flex size-control items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring data-[state=open]:bg-surface-hover data-[state=open]:text-ink";

function KindIcon({ kind }: { kind: DraftKind }) {
  const className = "size-4 text-ink-muted";
  if (kind === "dm") return <MessageSquare className={className} />;
  if (kind === "private") return <Lock className={className} />;
  return <Hash className={className} />;
}

function draftRowLink(
  list: HTMLUListElement | null,
  channelId: string
): HTMLElement | null {
  if (list === null) return null;
  for (const row of list.querySelectorAll('[data-testid="draft-row"]')) {
    if (row.getAttribute("data-channel-id") !== channelId) continue;
    const link = row.querySelector("a");
    return link instanceof HTMLElement ? link : null;
  }
  return null;
}

function DraftRow({
  item,
  nowMs,
  onDelete,
  onCloseAutoFocus,
}: {
  item: DraftViewItem;
  nowMs: number;
  onDelete: (item: DraftViewItem) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const hoverNone = useHoverNone();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const showOverflow = hoverNone || hovered || focusWithin || menuOpen;

  const onFocus = (event: FocusEvent<HTMLLIElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches(":focus-visible")
    ) {
      setFocusWithin(true);
    }
  };
  const onBlur = (event: FocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  };

  return (
    <li
      className="relative border-b border-line press hover:bg-surface-hover focus-within:bg-surface-hover"
      data-testid="draft-row"
      data-channel-id={item.channelId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      <Link
        to={channelPathForDraft(item.channelId)}
        aria-describedby={DRAFT_ROW_HINT_ID}
        className="flex gap-3 py-2 pl-4 pr-8 focus-visible:focus-ring"
      >
        <span className="shrink-0 pt-1" aria-hidden="true">
          <KindIcon kind={item.destination.kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-body font-semibold",
                item.destination.isAgent ? "text-agent" : "text-ink"
              )}
            >
              {item.destination.text}
            </span>
            {item.destination.handle && (
              <span className="min-w-0 truncate text-meta text-ink-muted">
                {item.destination.handle}
              </span>
            )}
            <span
              className="shrink-0 text-timestamp text-ink-muted"
              data-numeric
              data-testid="draft-row-time"
            >
              {relativeLabel(item.atMs, nowMs)}
            </span>
          </span>
          <span
            className="truncate text-body text-ink-muted"
            data-testid="draft-row-preview"
          >
            {item.preview}
          </span>
        </span>
      </Link>
      {showOverflow ? (
        <div className={overflowBowlClass}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="초안 메뉴"
                title="초안 메뉴"
                data-testid="draft-row-menu"
                className={overflowTriggerClass}
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              data-testid="draft-row-menu-panel"
              onCloseAutoFocus={onCloseAutoFocus}
            >
              <DropdownMenuItem
                tone="danger"
                data-testid="draft-row-delete"
                onSelect={() => {
                  onDelete(item);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                초안 지우기
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </li>
  );
}

export function DraftsRoute() {
  const panel = useDraftsPanel();
  const offline = useOffline();
  const nowMs = Date.now();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingLandingRef = useRef<string | "empty" | null>(null);
  const skipTriggerRestoreRef = useRef(false);
  const itemsRef = useRef(panel.items);
  itemsRef.current = panel.items;

  const placePendingFocus = () => {
    const landing = pendingLandingRef.current;
    if (landing == null) return;
    pendingLandingRef.current = null;
    if (landing === "empty") {
      emptyRef.current?.focus();
      if (document.activeElement !== emptyRef.current) {
        headingRef.current?.focus();
      }
      return;
    }
    const link = draftRowLink(listRef.current, landing);
    if (link !== null) {
      link.focus();
      return;
    }
    headingRef.current?.focus();
  };

  const onDelete = (item: DraftViewItem) => {
    const items = itemsRef.current;
    const index = items.findIndex((row) => row.channelId === item.channelId);
    const neighbor = items[index + 1] ?? items[index - 1] ?? null;
    pendingLandingRef.current = neighbor?.channelId ?? "empty";
    skipTriggerRestoreRef.current = true;
    clearDraft(item.workspaceId, item.channelId);
    window.setTimeout(placePendingFocus, 0);
  };

  const onCloseAutoFocus = (event: Event) => {
    if (!skipTriggerRestoreRef.current) return;
    skipTriggerRestoreRef.current = false;
    event.preventDefault();
    placePendingFocus();
  };

  useLayoutEffect(() => {
    if (pendingLandingRef.current == null) return;
    placePendingFocus();
  }, [panel.items]);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="drafts-route">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1
            ref={headingRef}
            tabIndex={-1}
            data-testid="drafts-heading"
            className="text-body font-semibold focus-visible:focus-ring"
          >
            초안
          </h1>
        </div>
        <span className="text-meta text-ink-muted">이 기기에 쓰다 만 글</span>
      </header>
      <span id={DRAFT_ROW_HINT_ID} className="sr-only">
        초안 이어서 쓰기
      </span>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="오프라인. 초안은 이 기기에 있습니다."
          testId="drafts-offline"
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Skeleton ready={!panel.isPending} rows={4} className="p-4">
          {panel.isPending ? null : panel.isError ? (
            <InlineBanner
              message="채널 목록을 불러오지 못해 초안 대상을 확인할 수 없습니다."
              actionLabel="다시 시도"
              onAction={panel.refetch}
              testId="drafts-error"
            />
          ) : panel.items.length === 0 ? (
            <div
              ref={emptyRef}
              tabIndex={-1}
              data-testid="drafts-empty"
              className="focus-visible:focus-ring"
            >
              <EmptyInvite
                headline="아직 초안이 없습니다."
                detail="쓰다 만 글은 자동으로 저장됩니다."
              />
            </div>
          ) : (
            <ul ref={listRef} data-testid="drafts-list">
              {panel.items.map((item) => (
                <DraftRow
                  key={`${item.workspaceId}:${item.channelId}`}
                  item={item}
                  nowMs={nowMs}
                  onDelete={onDelete}
                  onCloseAutoFocus={onCloseAutoFocus}
                />
              ))}
            </ul>
          )}
        </Skeleton>
      </div>
    </div>
  );
}
