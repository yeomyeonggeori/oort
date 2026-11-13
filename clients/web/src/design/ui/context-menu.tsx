import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/design/lib/cn";
import { POPOVER_MOTION } from "@/design/motion";
import {
  menuRowClass,
  SUBMENU_ALIGN_OFFSET,
  SUBMENU_SIDE_OFFSET,
  submenuPanelClass,
  submenuChevron,
  useSubmenuGuardRef,
} from "@/design/ui/dropdown-menu";

// shadcn/ui new-york ContextMenu (vendored, Radix primitive).
//
// A message row already has a visible DropdownMenu trigger and a touch action
// sheet. This primitive adds the pointer-native summons without creating a
// third visual language: its panel, rows, focus treatment and separators reuse
// the exact DropdownMenu classes, including POPOVER_MOTION (ADR-0179 D4).
// Positioning, collision handling, arrow-key roving and focus restoration
// remain Radix's responsibility.

// =============================================================================
// 메뉴를 연 제스처의 뗌은 항목이 받지 않는다 (#3963 design-review R2 H1)
//
// macOS 는 `contextmenu` 를 **누르는 순간** 쏘고 메뉴는 그 순간 열린다. 트랙패드 두 손가락 탭은 누름과
// 뗌이 몇 ms 사이라서, 그 제스처의 `pointerup` 이 판이 자리를 잡기 전(첫 프레임: 창 왼쪽 위, 투명하지만
// 히트 테스트는 받는다)에 서 있던 항목 위로 떨어진다. Radix `MenuItem` 은 「누름 없는 뗌」을 「눌러서
// 끌어 온 선택」으로 읽어 `click()` 하므로(`react-menu` 의 `onPointerUp`), 포인터 아래 항목이 메뉴가
// 열리는 순간 실행된다 - 섹션 이동·알림 끄기·읽지 않음 표시처럼 서버에 쓰는 항목도 그렇다. 실측: 섹션
// 6개·창 높이 480 에서 행의 왼쪽(x=100)을 누름·뗌 간격 0 으로 우클릭하면 새 페이지의 첫 시도에서 항목이
// 실행되고 `PUT sidebar-prefs` 가 나갔다.
//
// 그래서 **메뉴를 연 제스처의 뗌**을 항목이 받지 않게 한다. 조건은 둘이다: 메뉴 안에서 누른 적이 없고
// (`pointerdown`), 마지막 `contextmenu` 로부터 `OPENING_GESTURE_MS` 가 지나지 않았다. 둘을 다 채우면
// 캡처 단계에서 삼킨다. 메뉴 안에서 누른 뒤의 뗌(= 일부러 고른 클릭)과 그 시간이 지난 뒤의 뗌(= 오래
// 눌러 끌어서 고르기)은 건드리지 않는다. 이 프리미티브를 쓰는 모든 우클릭 메뉴(메시지 행·세션 목록
// 포함)가 같은 보호를 받는다.
// =============================================================================

/** 메뉴를 연 제스처의 뗌이라고 볼 시간(ms). 열림 직후 첫 프레임 몇 개가 문제이고, 사람이 일부러 고르는 속도보다는 짧다. */
export const OPENING_GESTURE_MS = 400;

const openingGesture = { at: Number.NEGATIVE_INFINITY, pressedInside: false };
let openingClockInstalled = false;

/**
 * 모든 `contextmenu` 를 캡처로 들어 시계를 맞춘다. 메뉴는 이 이벤트로 열리고(Radix 트리거) 키보드
 * (Shift+F10·메뉴 키)도 같은 이벤트다. 열린 메뉴는 하나뿐이므로 모듈 하나의 시계로 충분하다.
 */
function installOpeningGestureClock(): void {
  if (openingClockInstalled || typeof document === "undefined") return;
  openingClockInstalled = true;
  document.addEventListener(
    "contextmenu",
    () => {
      openingGesture.at = performance.now();
      openingGesture.pressedInside = false;
    },
    true
  );
}
installOpeningGestureClock();

function isOpeningGestureRelease(): boolean {
  return (
    !openingGesture.pressedInside &&
    performance.now() - openingGesture.at < OPENING_GESTURE_MS
  );
}

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
/**
 * A plain (non-radio) group: `role="group"`, named by a `ContextMenuLabel` through
 * `aria-labelledby`. The `DropdownMenuGroup` twin, for a group whose rows can be
 * locked and so must stay on screen under a title. The row menu's 「복사」 cluster
 * used it until #5777 folded that lock-free group into the 「복사 ›」 submenu.
 */
export const ContextMenuGroup = ContextMenuPrimitive.Group;

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
    container?: HTMLElement | null;
    /** MenuContentImpl reads this; public MenuContentProps omits it as private. */
    onOpenAutoFocus?: (event: Event) => void;
  }
>(
  (
    {
      className,
      container,
      onOpenAutoFocus,
      onPointerDownCapture,
      onPointerUpCapture,
      ...props
    },
    ref
  ) => {
    React.useEffect(installOpeningGestureClock, []);
    return (
      <ContextMenuPrimitive.Portal container={container ?? undefined}>
        <ContextMenuPrimitive.Content
          ref={ref}
          collisionPadding={8}
          className={cn(
            // `scrollbar-visible`: 넘치는 판은 열리는 순간 「아래에 더 있다」를 보여야 한다(R2 H2). macOS
            // 오버레이 스크롤바는 스크롤을 시작한 뒤에야 나타난다.
            "layer-overlay-surface min-w-pane-sm max-h-menu-available overscroll-contain scrollbar-visible rounded-lg border border-line bg-surface-raised p-1 text-ink shadow-lg",
            POPOVER_MOTION,
            className
          )}
          {...props}
          {...({ onOpenAutoFocus } as React.ComponentPropsWithoutRef<
            typeof ContextMenuPrimitive.Content
          >)}
          onPointerDownCapture={(event) => {
            openingGesture.pressedInside = true;
            onPointerDownCapture?.(event);
          }}
          onPointerUpCapture={(event) => {
            onPointerUpCapture?.(event);
            if (isOpeningGestureRelease()) {
              event.stopPropagation();
              event.preventDefault();
            }
          }}
          data-overlay-layer="surface"
        />
      </ContextMenuPrimitive.Portal>
    );
  }
);
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    tone?: "danger";
    /** The `DropdownMenuItem` twin: `stack` lets a dimmed row carry its reason on a second line. */
    layout?: "row" | "stack";
  }
>(({ className, tone, layout = "row", ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={menuRowClass({ tone, layout, className })}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

/**
 * A group's **title** inside a context menu, and the radio rows it heads.
 *
 * These three are the `DropdownMenuLabel` / `RadioGroup` / `RadioItem` trio
 * transplanted, and the transplant is the point: the two menus are one grammar.
 * A group whose rows can be locked is *a title over rows that stay on screen*
 * (`dropdown-menu.tsx` header). Since #5777 a group with **no** lockable row may
 * fold into a submenu instead (`ContextMenuSub*` below): BT-4's 「섹션으로 이동」,
 * the first grouping this menu needed, now lives behind 「섹션으로 이동 ›」, and its
 * radio rows sit in that submenu panel.
 *
 * `RadioItem` rather than `Item` for the same reason `PresenceControl` uses it:
 * picking a section is **one choice among several**, so the row has to announce
 * as `menuitemradio` with the current section `aria-checked`. Plain items would
 * read as N equal commands with no way to hear which one you are already in.
 *
 * The label carries no aria of its own (Radix gives it no `id`), so the caller
 * gives it one and points the group back at it with `aria-labelledby` - the
 * `HostPicker` path, spelled out in `DropdownMenuLabel`'s docstring.
 */
export const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "select-none px-2 py-1 text-meta font-medium text-ink-muted",
      className
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

export const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={menuRowClass({ className })}
    {...props}
  />
));
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

export const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-line", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

// =============================================================================
// 하위 메뉴 (#5777) — 드롭다운의 하위 메뉴와 같은 판 · 같은 줄 · 같은 가드. 규칙: `dropdown-menu.tsx` 머리말
// (고를 수 없는 줄이 없는 묶음에만). 하위 판은 포털로 따로 뜨지만 React 트리에서는 위 `ContextMenuContent`
// 안이라, 「메뉴를 연 제스처의 뗌」 보호(위 머리말)가 하위 판의 누름 · 뗌도 그대로 센다.
// =============================================================================

export const ContextMenuSub = ContextMenuPrimitive.Sub;

export const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={menuRowClass({
      className: cn("data-[state=open]:bg-surface-hover", className),
    })}
    {...props}
  >
    {children}
    {submenuChevron()}
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

export const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> & {
    container?: HTMLElement | null;
  }
>(({ className, container, ...props }, ref) => {
  const guardedRef = useSubmenuGuardRef(ref);
  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.SubContent
        ref={guardedRef}
        sideOffset={SUBMENU_SIDE_OFFSET}
        alignOffset={SUBMENU_ALIGN_OFFSET}
        collisionPadding={8}
        className={cn(submenuPanelClass, POPOVER_MOTION, className)}
        {...props}
        data-overlay-layer="surface"
      />
    </ContextMenuPrimitive.Portal>
  );
});
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;
