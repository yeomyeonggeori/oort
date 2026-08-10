import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/design/lib/cn";

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

/** Section header. Sentence case, no uppercase-tracking micro label. */
export function SidebarSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1 px-2 py-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <h2 className="text-meta font-medium text-ink-muted">
          {title}
        </h2>
        {action}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}
