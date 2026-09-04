import {
  useEffect,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import {
  shouldShowSectionActions,
  sidebarSectionListId,
  type SidebarSectionId,
} from "./sidebarSectionModel";
import type {
  SidebarDragHandleProps,
  SidebarDropZoneProps,
} from "./sidebarDnd";

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
  /**
   * 행의 링크를 감싸는 손 (BT-1 / #1929). 채널 행은 이것으로 우클릭 메뉴의
   * 트리거가 된다. 렌더 프롭인 이유: `<li>` 의 임자는 여기 남기면서도 이
   * 컴포넌트가 「채널이 무엇인지」를 알 필요는 없다 — 인박스·활동 같은 전역 행은
   * 이 프롭 없이 예전 그대로다.
   */
  wrapLink?: (link: ReactElement) => ReactElement;
  /**
   * 이 행을 끌 수 있게 하는 손잡이 (BT-5 / #1933). 링크 자신에 붙는 이유는
   * 앵커가 이미 브라우저의 드래그 원본이기 때문이다 — 감싸는 상자에 옮기면
   * 앵커의 기본 드래그(주소를 끄는 것)와 둘이 되고, 어느 쪽이 이기는지는
   * 브라우저마다 다르다. 여기 붙이면 그 하나를 우리 것으로 바꿔 쓴다.
   *
   * 없으면 예전 그대로다 — 전역 목적지 행도, 별표 섹션의 행도 끌리지 않는다.
   */
  dragProps?: SidebarDragHandleProps;
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
  wrapLink,
  dragProps,
}: SidebarRowProps) {
  const hasUnread = unreadCount > 0;
  const hasMention = mentionCount > 0;
  const link = (
    <NavLink
      to={to}
      data-sidebar-row=""
      data-testid={testId}
      {...dataAttrs}
      {...dragProps}
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
  );
  return <li>{wrapLink ? wrapLink(link) : link}</li>;
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
  overlayOpen = false,
  unreadCount = 0,
  mentionCount = 0,
  dropProps,
  headerDragProps,
  wrapList = true,
}: {
  title: string;
  sectionId: SidebarSectionId;
  children: ReactNode;
  action?: ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /**
   * 이 섹션이 이고 있는 드롭 구역 (BT-5 / #1933). 섹션 **전체**가 대상인 이유:
   * 접힌 섹션에는 행이 없고, 그때도 「여기로 옮긴다」는 여전히 뜻이 있다. 목록만
   * 대상으로 삼으면 접는 순간 그 섹션이 사라지는 문이 된다.
   */
  dropProps?: SidebarDropZoneProps;
  /** 머리글을 끌면 섹션 차례가 바뀐다. 커스텀 섹션만 받는다. */
  headerDragProps?: SidebarDragHandleProps;
  /**
   * This section's overlay, not a shell-wide flag. 채널 만들기 pins the
   * channel header; a DM compose pins the DM header. A workspace-wide
   * open flag wired into every section made ⌘K 채널 만들기 freeze the
   * DM + as well (R2-1).
   */
  overlayOpen?: boolean;
  /** Collapsed-header aggregate. Hidden while expanded: the rows speak then. */
  unreadCount?: number;
  mentionCount?: number;
  /**
   * When false, children already include the `<ul>` (a Skeleton wrapping the
   * list). Default true: this section is the list. SKILL §6 `ul > li`.
   */
  wrapList?: boolean;
}) {
  const touchSurface = useHoverNone();
  const [headerHovered, setHeaderHovered] = useState(false);
  const [headerKeyboardFocused, setHeaderKeyboardFocused] = useState(false);
  // Same overlay pin as MessageRow → hoverToolbarModel. The + that opened
  // 채널 만들기 must stay mounted so Radix can restore focus on close (B-1).
  // Open-state alone is not enough: the provider flips it false in the same
  // commit that unmounts the dialog, so a hold keeps the trigger alive for
  // one frame after close (restore runs in a microtask). Blur still drops
  // the hold as a backstop; the close transition is what actually releases
  // it, or a ⌘K-opened dialog would pin the actions for the rest of the
  // session (R2-1).
  const [overlayHeld, setOverlayHeld] = useState(false);
  if (overlayOpen && !overlayHeld) setOverlayHeld(true);
  useEffect(() => {
    if (overlayOpen || !overlayHeld) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (!cancelled) setOverlayHeld(false);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [overlayOpen, overlayHeld]);
  const showActions = shouldShowSectionActions({
    pointerCanHover: !touchSurface,
    headerHovered,
    headerKeyboardFocused,
    overlayOpen: overlayOpen || overlayHeld,
  });
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const listId = sidebarSectionListId(sectionId);
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
      // 드롭 표지는 색이 아니라 **꼴**로 포커스 링과 갈린다 (BT-5 #1933).
      //
      // 색은 같은 `--accent` 다 - 「지금 이 액센트가 향하는 자리」는 이 표면에
      // 하나이고, 두 번째 액센트를 만드는 것이 규칙 위반이다(SKILL §2). 대신
      // 파선이고, 채움이 함께 바뀐다. 실캡처에서 그 차이가 값을 했다: 드래그
      // 중인 프레임에는 캐럿이 든 행(실선 2px 링 + `--accent-soft`)과 받는
      // 섹션이 한 화면에 함께 서고, 둘 다 실선이면 「캐럿이 여기 있다」와
      // 「여기에 놓인다」가 같은 그림이 된다. 파선은 임시로 열린 자리를 뜻하는
      // 오래된 관용이고, 링은 결코 파선이 아니다.
      //
      // 대비 실측은 주석이 아니라 `tokens.contrast.test.ts` 의 「드롭 표지」가
      // 진다 - 그것이 이 클래스에서 토큰 이름을 읽어 두 바닥·두 스킴에서 3:1 을
      // 잰다. 표식 자체는 드래그가 살아 있는 동안에만 DOM 에 있다.
      className={cn(
        "flex flex-col gap-1 rounded-sm px-2 py-2",
        "data-[drop-target]:bg-surface-hover data-[drop-target]:outline data-[drop-target]:outline-2 data-[drop-target]:outline-dashed data-[drop-target]:-outline-offset-2 data-[drop-target]:outline-accent"
      )}
      data-testid={`sidebar-section-${sectionId}`}
      data-collapsed={collapsed ? "" : undefined}
      {...dropProps}
    >
      <div
        className={cn(
          "flex min-h-control-sm items-center gap-1 px-2",
          // 손잡이가 있으면 커서가 그렇게 말한다. 없는 섹션(기본·별표·DM)의
          // 머리글은 예전 그대로다.
          headerDragProps && "cursor-grab"
        )}
        data-testid={`sidebar-section-${sectionId}-header`}
        {...headerDragProps}
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
      {collapsed ? null : wrapList ? (
        <ul id={listId} className="flex flex-col">
          {children}
        </ul>
      ) : (
        children
      )}
    </section>
  );
}
