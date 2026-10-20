import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { DM_CLOSE_LABEL } from "@momo/core/features/channels/model";
import { cn } from "@/design/lib/cn";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import { AttentionDot, AttentionPill } from "./AttentionBadge";
import { ensurePointerTrail, lastPointerAt } from "./pointerTrail";
import { badgeFor, type DotTone } from "./sidebarBadge";
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
// `tap-target`은 폰에서만 이 행을 44px로 세운다 (goal B6). 넓은 창에서는 이
// 유틸리티가 아무 규칙도 갖지 않으므로 목록 밀도는 그대로다.
//
// 기하는 `sidebar-row`(tokens.css, 시안 A `.a-srow`: 34 · 반경 10 · 아이콘 18)가
// 진다. 선택 행은 흰 면 + rest 그림자로 뜬다(`sidebar-row-selected`). 호박색
// (`signal-soft`)으로 칠하지 않는다: 호박색은 안 읽음·멘션 신호에만 쓴다
// (owner 결정 2026-09-26, #2738 검수 M4). 선택 행은 띠(노을띠) 위에서도 흰 면이라
// 원래 글자 역할을 되찾는다(`band-surface`).
const rowClass =
  "tap-target sidebar-row flex w-full items-center text-left focus-visible:focus-ring";

const inactiveClass = "hover:bg-surface-hover active:bg-surface-pressed";
const activeClass =
  "band-surface sidebar-row-selected text-ink active:bg-surface-pressed";

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
  /**
   * 경로만으로는 선택을 가를 수 없는 줄(#2854: 「내 작업」 `/work`와 「팀 작업」
   * `/work?view=team`은 경로가 같다)은 셸이 판정을 넘긴다. 없으면 NavLink가 정한다.
   */
  isActive?: boolean;
  /**
   * 배지(알약)가 말하는 뜻. 있으면 링크의 접근 가능한 이름이 「이름, 뜻」이 된다(예: 「인박스,
   * 나에게 필요한 일 4개」). 알약의 숫자는 `aria-hidden`이 아니지만 단독으로는 무엇의 수인지
   * 말하지 않는다. 없으면 예전 그대로다.
   */
  badgeLabel?: string;
  /**
   * 알약이 없는 줄에 서는 점(수를 못 그릴 때). 알약이 있으면 그려지지 않는다: 같은 자리에
   * 둘이 서면 알약이 이긴다(`sidebarBadge`).
   */
  dot?: DotTone | null;
  /**
   * 호버하면 오른쪽에 서는 X (DM 행의 「사이드바에서 닫기」, #3963). 없으면 X 가 서지 않는다.
   *
   * X 는 **링크 안이 아니라 링크의 형제**다: 앵커 안의 `<button>` 은 상호작용 콘텐츠의 중첩이라
   * 클릭이 어느 쪽인지 브라우저마다 다르다. 그래서 `<li>` 가 위치의 기준(`relative`)이 되고 X 는
   * 거기에 절대 위치한다. 우클릭 메뉴의 트리거 상자 안에 같이 들어가므로 X 위에서의 우클릭도 같은
   * 행 메뉴를 연다.
   *
   * 마운트 규율은 메시지 행 툴바의 **호버 쪽**과 같다(SKILL §6): 호버하지 않은 행에는 DOM 이 없다.
   * `opacity`·`visibility` 로 숨기지 않는다. 키보드 포커스로는 세우지 않는다(design-review R1 N2):
   * X 는 탭 정거장이 아니라서(`tabIndex={-1}`) 포커스로 세우면 닿을 수 없는 컨트롤이 보이게 된다.
   * 키보드의 길은 행 메뉴의 같은 이름 항목이고 그 경로는 끝까지 실측했다(`capture-3963.mjs` H).
   * **터치(`hover: none`)에는 호출부가 이 프롭을 주지 않는다**: 그 표면 판정은 이미 사이드바가
   * 하고(`touchSurface`), 행마다 미디어 쿼리 구독을 하나씩 더 들이지 않는다.
   *
   * **안 읽은 메시지(멘션 포함)가 있는 DM 에도 호출부가 이 프롭을 주지 않는다**(소유자 결정 2026-10-17 「안 읽음 있으면
   * X 숨김」, `dmCloseOffered` - 우클릭 메뉴의 닫기 항목과 같은 한 함수). 그래서 X 와 안 읽음 알약은 한 행에 함께 서지
   * 않는다. 읽고 나면 프롭이 다시 와서 X 가 선다.
   */
  onClose?: () => void;
  /** X 의 접근 가능한 이름(어느 대화인지 말한다). 없으면 낱말만 쓴다. */
  closeLabel?: string;
  /**
   * 아이콘 자리에 서는 것의 종류. `avatar` 는 24px 아바타(DM)다 - 18px 글리프 행과 **이름이
   * 같은 자리에서 시작하도록** 아바타가 글리프의 축 위에 앉는다(`sidebar-row`, tokens.css).
   */
  iconKind?: "glyph" | "avatar";
}

/**
 * 행이 포인터를 그 위에 둔 채 닫을 수 있게 바뀔 때, X 를 세우려면 포인터가 알려진 마지막 자리에서 움직여야 하는 거리(px).
 * 손의 흔들림(1~3px)은 넘고, 일부러 X 쪽으로 가는 움직임(알약에서 X 까지 20px 남짓)에는 한참 못 미친다.
 */
const CLOSE_REVEAL_TRAVEL_PX = 8;

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
  isActive: activeOverride,
  badgeLabel,
  dot = null,
  onClose,
  closeLabel,
  iconKind = "glyph",
}: SidebarRowProps) {
  // 알약은 한 줄에 하나다(필요 > 일반). 규칙은 `badgeFor`가 진다.
  const pill = badgeFor({ needsMe: mentionCount, unread: unreadCount });
  const hasUnread = unreadCount > 0;
  const closable = onClose !== undefined;
  const rowRef = useRef<HTMLLIElement>(null);
  const [hovered, setHovered] = useState(false);
  // 호버는 **네이티브** mouseenter/leave 로 듣는다. React 의 `onMouseLeave` 는 포털 자손을 행
  // 안으로 친다: 우클릭 메뉴(포털)로 포인터가 건너가도 leave 가 오지 않고, 메뉴가 닫힌 뒤에는
  // 그 leave 가 영영 오지 않아 X 가 남는다. 포털은 DOM 으로는 행 밖이므로 네이티브 이벤트가 맞다.
  // 닫을 수 없는 행(채널·전역 행)은 구독도 하지 않는다.
  useEffect(() => {
    const row = rowRef.current;
    if (!closable || row === null) return;
    ensurePointerTrail();
    // 「이미 행 위에 있던 포인터」를 지켜보는 중이면 그것을 걷는 함수(아래 설명). 지켜보는 동안에는 X 가 포인터의 움직임 뒤에만 선다.
    let unwatch: (() => void) | null = null;
    let anchor: { x: number; y: number } | null = null;
    /** 지켜보기의 기준 자리에서 `CLOSE_REVEAL_TRAVEL_PX` 이상 움직였는가. 기준이 없으면(포인터를 처음 본다) 이 이벤트가 기준이다. */
    const travelled = (event: MouseEvent): boolean => {
      if (anchor === null) {
        anchor = { x: event.clientX, y: event.clientY };
        return false;
      }
      return Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) >= CLOSE_REVEAL_TRAVEL_PX;
    };
    const reveal = () => {
      unwatch?.();
      setHovered(true);
    };
    // 평소의 호버는 mouseenter 한 번에 선다. 지켜보는 동안의 mouseenter 는 움직임이 따라온 것만 센다: Chromium 은 눌린 알약처럼
    // 포인터 밑의 요소가 사라지면 호버 사슬을 다시 세우며 행에 합성 mouseenter 를 쏜다(포인터는 그대로, 12ms 뒤).
    const enter = (event: MouseEvent) => {
      if (unwatch !== null && !travelled(event)) return;
      reveal();
    };
    const move = (event: MouseEvent) => {
      if (travelled(event)) reveal();
    };
    const leave = () => {
      unwatch?.();
      setHovered(false);
    };
    row.addEventListener("mouseenter", enter);
    row.addEventListener("mouseleave", leave);
    // 구독이 늦게 붙는 길(design-review R4 M1): 닫을 수 없던 행이 포인터를 그 위에 둔 채 닫을 수 있게 바뀌면 - 안 읽음 DM 을
    // 클릭해 열자마자 읽는 중이라 안 읽음이 0 으로 접히는 때, 새 메시지를 읽는 때 - `mouseenter` 는 이미 지나가서 오지 않는다.
    // 지금 포인터가 행 안에 있는지는 `:hover` 가 답한다. 우클릭 메뉴(포털)로 건너간 포인터는 행의 자손 위가 아니라
    // 거짓이다: 위의 네이티브 leave 와 같은 판정이다.
    //
    // 그 길에서는 X 를 바로 세우지 않고 **포인터가 움직인 뒤에** 세운다(마이크로 델타 H): 알약을 누른 포인터는 X 가 설 바로
    // 그 자리에 있어서, 같은 자리의 둘째 클릭(더블클릭)이 방금 뜬 X 를 눌러 읽으려고 연 DM 을 열자마자 닫았다. 흔들림(몇 px)은
    // 움직임이 아니다: 알려진 마지막 포인터 자리에서 `CLOSE_REVEAL_TRAVEL_PX` 이상 떨어져야 한다. 이벤트 한 번으로 크게 움직여도
    // 선다(이동은 이벤트 수가 아니라 거리다).
    if (row.matches(":hover")) {
      anchor = lastPointerAt();
      row.addEventListener("mousemove", move);
      unwatch = () => {
        row.removeEventListener("mousemove", move);
        unwatch = null;
      };
    }
    return () => {
      unwatch?.();
      row.removeEventListener("mouseenter", enter);
      row.removeEventListener("mouseleave", leave);
      setHovered(false);
    };
  }, [closable]);
  const showClose = closable && hovered;
  const linkProps = {
    to,
    "data-sidebar-row": "",
    "data-testid": testId,
    ...dataAttrs,
    ...dragProps,
    "data-unread": hasUnread ? "" : undefined,
    // X 가 서 있는 동안 오른쪽 안쪽 여백을 비우고 알약·점을 내린다(`sidebar-row`, tokens.css).
    "data-row-close": showClose ? "" : undefined,
    "aria-label": badgeLabel ? `${label}, ${badgeLabel}` : undefined,
  };
  // 오른쪽 끝의 것들(뒤따르는 슬롯 · 알약 · 점). 닫을 수 있는 행에서만 한 덩어리로 묶는다: `contents`
  // 라 레이아웃은 예전 그대로이고, X 가 서는 동안 이 덩어리 하나만 내리면 된다(tokens.css
  // `sidebar-row`). 닫을 수 없는 행의 DOM 은 예전 그대로다.
  const trailingCells = (
    <>
      {trailing}
      {pill ? (
        <AttentionPill
          spec={pill}
          testId={pill.tone === "ink" ? "mention-badge" : "unread-count"}
        />
      ) : dot ? (
        <AttentionDot tone={dot} testId="row-dot" />
      ) : null}
    </>
  );
  const content = (
    <>
      <span
        data-row-icon=""
        data-icon-kind={iconKind === "avatar" ? "avatar" : undefined}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        <span
          className={cn(
            "min-w-0 truncate",
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
      {closable ? (
        <span data-row-trailing="" className="contents">
          {trailingCells}
        </span>
      ) : (
        trailingCells
      )}
    </>
  );
  // 선택을 셸이 정하는 줄(`isActive` 지정)은 `Link`로 그린다. `NavLink`는 `aria-current`를 자기
  // 경로 판정으로만 내므로(쿼리가 다른 `/work` 두 줄, 접두어로 켜지는 `/c/…`) 선택 클래스와
  // 스크린리더에 읽히는 선택이 갈라진다. 지정이 없으면 예전 그대로 NavLink가 정한다.
  const link =
    activeOverride === undefined ? (
      <NavLink
        {...linkProps}
        className={({ isActive }) => cn(rowClass, isActive ? activeClass : inactiveClass)}
      >
        {content}
      </NavLink>
    ) : (
      <Link
        {...linkProps}
        aria-current={activeOverride ? "page" : undefined}
        className={cn(rowClass, activeOverride ? activeClass : inactiveClass)}
      >
        {content}
      </Link>
    );

  const closeButton = showClose ? (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClose}
      aria-label={closeLabel ?? DM_CLOSE_LABEL}
      title={DM_CLOSE_LABEL}
      data-testid="dm-close"
      // 자리: 오른쪽 8px(`right-2`) × 24px(`size-6`). `tokens.css` 의 `sidebar-row` 가 같은 숫자에서 이름의
      // 오른쪽 끝(36px = 24 + 8 + 간격 4)을 도출하므로 둘은 함께 움직인다(소스 시험이 36 을 잰다).
      className="press absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-pressed hover:text-ink focus-visible:focus-ring"
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  ) : null;
  // 링크와 X 는 **같은 트리거 상자 안**에 선다: X 위의 우클릭도 행 메뉴를 연다.
  const body = closeButton ? (
    <>
      {link}
      {closeButton}
    </>
  ) : (
    link
  );

  return (
    <li ref={rowRef} className={closable ? "relative" : undefined}>
      {wrapLink ? wrapLink(body) : body}
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
  overlayOpen = false,
  unreadCount = 0,
  mentionCount = 0,
  dot = null,
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
  /** 접혀 있고 알약이 없을 때만 서는 점(예: 아직 안 본 끝남). */
  dot?: DotTone | null;
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
  // 접힌 머리의 합산도 줄과 같은 문법이다: 잉크(필요) > 호박(일반 안 읽음) > 점.
  const sectionPill = badgeFor({ needsMe: mentionCount, unread: unreadCount });

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
        "flex flex-col rounded-md",
        "data-[drop-target]:bg-surface-hover data-[drop-target]:outline data-[drop-target]:outline-2 data-[drop-target]:outline-dashed data-[drop-target]:-outline-offset-2 data-[drop-target]:outline-accent"
      )}
      data-testid={`sidebar-section-${sectionId}`}
      data-collapsed={collapsed ? "" : undefined}
      {...dropProps}
    >
      <div
        className={cn(
          // 호버 강조는 **머리 상자 전체**다(#4108): 라벨 버튼만 칠하면 오른쪽의 +·「…」가
          // 강조 면 밖에 따로 떴다. 액션은 이 면 안 오른쪽(`pe-1`)에 선다. 면은 호버에만
          // 켜진다 — 터치(`hover: none`)에서는 호버가 없어 칠해지지 않는다.
          "sidebar-section-head flex min-h-control-sm items-center gap-1 rounded-md pe-1 hover:bg-surface-hover",
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
            className="sidebar-section-label w-full min-w-0 rounded-md text-left active:bg-surface-pressed focus-visible:focus-ring"
          >
            <Chevron className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{title}</span>
          </button>
        </h2>
        {collapsed && sectionPill ? (
          <AttentionPill spec={sectionPill} testId={`section-unread-${sectionId}`} />
        ) : collapsed && dot ? (
          <AttentionDot tone={dot} testId={`section-dot-${sectionId}`} />
        ) : null}
        {showActions ? action : null}
      </div>
      {collapsed ? null : wrapList ? (
        <ul id={listId} className="sidebar-stack">
          {children}
        </ul>
      ) : (
        children
      )}
    </section>
  );
}
