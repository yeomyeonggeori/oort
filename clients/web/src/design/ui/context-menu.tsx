import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/design/lib/cn";
import { POPOVER_MOTION } from "@/design/motion";
import { menuRowClass } from "@/design/ui/dropdown-menu";

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
 * `aria-labelledby`. The `DropdownMenuGroup` twin; the row menu's 「복사」 cluster
 * uses it (#3963), a title over three rows that stay on screen.
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
 * transplanted, and the transplant is the point: `dropdown-menu.tsx`'s header
 * argues at length that grouping in this app is *a title over rows that stay on
 * screen*, never a submenu, and BT-4's 「섹션으로 이동」 is the first grouping the
 * right-click menu needs. Reaching for `ContextMenuSub*` here would have
 * re-opened that decision inside a component change, which that file explicitly
 * says is ADR work; reaching for these keeps the two menus one grammar.
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
