import { useState, type FocusEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import { useCreateChannelOpen } from "@/features/channels/useCreateChannel";
import {
  shouldShowSectionActions,
  type SidebarSectionId,
} from "./sidebarSectionModel";

// Flat rows with a hover background, not one rounded "web card" per list item
// (design-taste-web §8). Everything interactive is a real link/button with a
// visible focus ring.
// `tap-target`은 폰에서만 이 행을 44px로 세운다 (goal B6). 데스크탑의 30px 행은
// 포인터에 맞춘 밀도이고, 손가락으로는 옆 채널이 함께 눌린다. 넓은 창에서는 이
// 유틸리티가 아무 규칙도 갖지 않으므로 목록 밀도는 그대로다.
const rowClass =
  "tap-target flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body " +
  "transition-colors focus-visible:focus-ring";

const inactiveClass =
  "text-ink hover:bg-surface-hover";
const activeClass =
  "bg-accent-soft text-ink";

export interface SidebarRowProps {
  to: string;
  icon: ReactNode;
  label: string;
  /**
   * "@handle", shown right after the name when the name alone is shared by two
   * members of this workspace. Two rows reading 김인턴 are not a list, they are
   * a coin toss.
   */
  handle?: string | null;
  /** The row names an agent: identity is the --agent token on the name (§9). */
  agent?: boolean;
  /** Server unread count (P7). Renders only when the projection supplies one. */
  unreadCount?: number;
  /** Server mention count; promotes the badge to an accent pill. */
  mentionCount?: number;
  /** Trailing slot, e.g. the agent turn badge. */
  trailing?: ReactNode;
  testId?: string;
  dataAttrs?: Record<string, string>;
}

export function SidebarRow({
  to,
  icon,
  label,
  handle = null,
  agent = false,
  unreadCount = 0,
  mentionCount = 0,
  trailing,
  testId,
  dataAttrs,
}: SidebarRowProps) {
  const hasUnread = unreadCount > 0;
  const hasMention = mentionCount > 0;
  return (
    <li>
      <NavLink
        to={to}
        data-sidebar-row=""
        data-testid={testId}
        {...dataAttrs}
        className={({ isActive }) =>
          cn(rowClass, isActive ? activeClass : inactiveClass)
        }
      >
        <span className="shrink-0 opacity-70" aria-hidden="true">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span
            className={cn(
              "min-w-0 truncate",
              hasUnread && "font-semibold",
              agent && "text-agent"
            )}
          >
            {label}
          </span>
          {handle && (
            <span
              className="min-w-0 truncate text-meta text-ink-muted"
              data-testid="row-handle"
            >
              {handle}
            </span>
          )}
        </span>
        {trailing}
        {hasMention ? (
          <span
            className="shrink-0 rounded-sm bg-accent px-1 text-timestamp font-medium text-on-accent"
            data-numeric
            data-testid="mention-badge"
          >
            {mentionCount}
          </span>
        ) : hasUnread ? (
          <span
            className="shrink-0 text-timestamp text-ink-muted"
            data-numeric
            data-testid="unread-count"
          >
            {unreadCount}
          </span>
        ) : null}
      </NavLink>
    </li>
  );
}

/**
 * Section header. Sentence case, no uppercase-tracking micro label.
 *
 * Collapse is always mounted (a keyboard user reaches it without hovering).
 * Create/overflow actions follow the UX-HT contract: conditional render, never
 * an opacity/visibility hide. Pointer rest shows none; hover, `:focus-visible`,
 * an open overlay, or a touch surface (`hover: none`) shows the real actions
 * only.
 */
export function SidebarSection({
  title,
  sectionId,
  children,
  action,
  collapsed,
  onCollapsedChange,
  unreadCount = 0,
  mentionCount = 0,
}: {
  title: string;
  sectionId: SidebarSectionId;
  children: ReactNode;
  action?: ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Collapsed-header aggregate. Hidden while expanded: the rows speak then. */
  unreadCount?: number;
  mentionCount?: number;
}) {
  const touchSurface = useHoverNone();
  const [headerHovered, setHeaderHovered] = useState(false);
  const [headerKeyboardFocused, setHeaderKeyboardFocused] = useState(false);
  // Same overlay pin as MessageRow → hoverToolbarModel. The + that opened
  // 채널 만들기 must stay mounted so Radix can restore focus on close (B-1).
  // Open-state alone is not enough: the provider flips it false in the same
  // commit that unmounts the dialog, so a hold keeps the trigger alive until
  // the header actually blurs after restore.
  const overlayOpen = useCreateChannelOpen();
  const [overlayHeld, setOverlayHeld] = useState(false);
  if (overlayOpen && !overlayHeld) setOverlayHeld(true);
  const showActions = shouldShowSectionActions({
    pointerCanHover: !touchSurface,
    headerHovered,
    headerKeyboardFocused,
    overlayOpen: overlayOpen || overlayHeld,
  });
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const listId = `sidebar-section-${sectionId}-list`;
  const hasUnread = unreadCount > 0;
  const hasMention = mentionCount > 0;

  const onHeaderFocus = (event: FocusEvent<HTMLDivElement>) => {
    // Pointer click focuses the collapse button but must not paint a ring or
    // reveal hover actions (#1743 B-4 / UX-HT 포인터·키보드 분리). Only a
    // keyboard stop (`:focus-visible`) opens the hover cluster.
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(":focus-visible")) {
      setHeaderKeyboardFocused(true);
    }
  };
  const onHeaderBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setHeaderKeyboardFocused(false);
    if (!overlayOpen) setOverlayHeld(false);
  };

  return (
    <section
      className="flex flex-col gap-1 px-2 py-2"
      data-testid={`sidebar-section-${sectionId}`}
      data-collapsed={collapsed ? "" : undefined}
    >
      <div
        className="flex h-control-sm items-center gap-1 px-2"
        data-testid={`sidebar-section-${sectionId}-header`}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        onFocusCapture={onHeaderFocus}
        onBlurCapture={onHeaderBlur}
      >
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : listId}
            title={`${title} 섹션 ${collapsed ? "펼치기" : "접기"}`}
            data-testid={`section-collapse-${sectionId}`}
            className="flex h-control-sm w-full min-w-0 items-center gap-1 rounded-sm text-left text-meta font-medium text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
          >
            <Chevron className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{title}</span>
          </button>
        </h2>
        {collapsed && hasMention ? (
          <span
            className="shrink-0 rounded-sm bg-accent px-1 text-timestamp font-medium text-on-accent"
            data-numeric
            data-testid={`section-unread-${sectionId}`}
          >
            {mentionCount}
          </span>
        ) : collapsed && hasUnread ? (
          <span
            className="shrink-0 text-timestamp text-ink-muted"
            data-numeric
            data-testid={`section-unread-${sectionId}`}
          >
            {unreadCount}
          </span>
        ) : null}
        {showActions ? action : null}
      </div>
      {collapsed ? null : (
        <ul id={listId} className="flex flex-col">
          {children}
        </ul>
      )}
    </section>
  );
}
