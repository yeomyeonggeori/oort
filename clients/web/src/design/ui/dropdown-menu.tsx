import * as React from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { POPOVER_MOTION } from "@/design/motion";

// shadcn/ui new-york DropdownMenu (vendored, Radix primitive).
//
// Added in B11 R2 for the message row's overflow entry point. The row used to
// carry a six-button hover bar that §6 then forbade (always-visible button
// rows, one tab stop per button on every virtualized row). #1743 reintroduces
// a hover toolbar under a tighter contract: the toolbar is not mounted until
// hover/focus-within, it is one WAI-ARIA composite, and this menu remains the
// overflow (Edit/Delete live here, not on the bar). A menu still needs
// collision-aware positioning, a focus scope, arrow-key roving, Escape,
// outside-dismiss and focus return to the trigger; hand-rolling those inside
// a recycled row is how you ship a menu that survives every case but the one
// nobody tried.
//
// Same house deviations as the Dialog: no decorative chrome. Enter/exit is
// ADR-0179 D4 (open 240 / close 180) via POPOVER_MOTION. Radix Presence waits
// for the CSS animation when Content stays mounted through close; forceMount
// is not added. `{open && <DropdownMenuContent/>}` skips the exit.
//
// `ContextMenu` proper (right-click) is deliberately NOT used as the only path:
// a right-click menu has no visible affordance, and the row has to be operable
// by a pointer that never right-clicks and by Tab. The trigger is that
// affordance and this menu is what it opens.
//
// ## Submenus (`DropdownMenuSub*`): only for a group with no locked row — 이슈 #1383 → #5777
//
// If you came here to add one, this is the paragraph. The house rule is that
// **an ineligible option stays visible, with its reason.** The server ships
// ineligible hosts instead of filtering them (이슈 #1132), and `SpawnHostChoice`
// is a radio list rather than a `<select>` precisely because a closed control
// turned 「낡은 맥 (오프라인)」 into a footnote you had to open something to read.
// A submenu repeats that one level up: it puts a whole group behind a hover or
// an arrow key, so the answer to "왜 저기서는 못 돌리지" sits one interaction
// away. That is why #1383 kept submenus out and grouped with `DropdownMenuLabel`
// (a title over rows that stay on screen) instead.
//
// owner 2026-11-14 (#5777, the Buzz row menu) narrowed rather than dropped the
// rule: **a submenu may hold a group only when none of its rows can be locked.**
// The harm above is a hidden *reason*, and a group with no locked row (the
// channel row's 「복사 ›」 name/link/ID, 「섹션으로 이동 ›」 destinations) has no
// reason to hide. A group that can carry a disabled row (host pickers, anything
// with a stacked reason line) stays a title over visible rows. The rule is
// written in `docs/design-system/README.md` (「메뉴」), and `guardSubmenuRows`
// below makes a locked row inside a submenu panel an error in development.
//
// The same reasoning keeps the hover-consequence tooltip out: a consequence is a
// sentence, and a sentence belongs inline where it is read without a pointer —
// so `@radix-ui/react-tooltip` stays off this client's dependency list.

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

/**
 * The panel. Portaled, so a row that the virtualiser recycles cannot clip its
 * own menu, and `collisionPadding` keeps it inside the window near the last
 * message in the channel, which is exactly where this menu is opened most.
 */
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content> & {
    container?: HTMLElement | null;
    /** MenuContentImpl reads this; public MenuContentProps omits it as private. */
    onOpenAutoFocus?: (event: Event) => void;
  }
>(({ className, sideOffset = 4, container, onOpenAutoFocus, ...props }, ref) => (
  <MenuPrimitive.Portal container={container ?? undefined}>
    <MenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        "layer-overlay-surface min-w-pane-sm rounded-lg border border-line bg-surface-raised p-1 text-ink shadow-lg",
        POPOVER_MOTION,
        className
      )}
      {...props}
      {...({ onOpenAutoFocus } as React.ComponentPropsWithoutRef<
        typeof MenuPrimitive.Content
      >)}
      data-overlay-layer="surface"
    />
  </MenuPrimitive.Portal>
));
DropdownMenuContent.displayName = MenuPrimitive.Content.displayName;

/**
 * One row of the menu. `h-control` (32px) is the pointer measure. On a phone
 * (`tap-target`, width < 600px) the same row grows to 44px — the sheet-row
 * measure `MessageActions.tsx` already uses. The profile card is a first-class
 * phone-drawer entry, so this primitive can no longer claim it is never
 * opened by a thumb.
 *
 * Radix moves focus with the arrow keys, so the highlight is a focus ring and a
 * background, not a separate "selected" concept.
 *
 * **`layout="stack"`** (이슈 #1112) is for a menu whose items name a *thing*
 * rather than an action — the channel's pin list, where one row is an author
 * line over a message excerpt. It is a named variant rather than a `className`
 * at the call site because the two heights genuinely conflict (`h-control` vs
 * `h-auto`) and `tailwind-merge` does not know `h-control` is a height: the
 * override silently loses and the second line ships clipped to a few pixels of
 * glyph. That is exactly what happened once here. A variant cannot lose that
 * fight, and the 32px measure becomes the floor rather than the height.
 */
/**
 * The class list every row of this menu wears, in ONE place.
 *
 * It is a function rather than two copies because the menu now has two row
 * primitives (`Item` and `RadioItem`, the latter added for the presence control's
 * menuitemradio semantics). A second hand-copied list is how one of them quietly
 * loses the focus ring or the 32px measure while both keep passing their tests.
 *
 * Radix walks focus through the rows with the arrow keys, so the moving
 * background is the menu's own language and the browser's default ring is
 * suppressed. The house focus ring is restored on the same class list (§6): it
 * is what tells a Tab user which row Enter will fire.
 */
export function menuRowClass({
  tone,
  layout = "row",
  className,
}: {
  tone?: "danger";
  layout?: "row" | "stack";
  className?: string;
}) {
  return cn(
    "tap-target flex cursor-default select-none gap-2 rounded-md px-2 text-label outline-none press-instant-fill active:bg-surface-pressed focus:bg-surface-hover focus-visible:focus-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    layout === "stack"
      ? // `gap-2` between two lines of ONE item would read as a paragraph
        // break, so a stacked item sets its own vertical rhythm.
        "min-h-control flex-col items-start gap-px py-1"
      : "h-control items-center",
    tone === "danger" ? "text-danger" : "text-ink",
    className
  );
}

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    tone?: "danger";
    layout?: "row" | "stack";
  }
>(({ className, tone, layout = "row", ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={menuRowClass({ tone, layout, className })}
    {...props}
  />
));
DropdownMenuItem.displayName = MenuPrimitive.Item.displayName;

/**
 * A menu whose rows are a **single choice among several**, not a list of
 * actions (presence 6b design-review M1).
 *
 * The distinction is not decorative: a plain `Item` announces as `menuitem` and
 * carries no selected state, so a screen-reader user opening the status menu
 * heard three equal commands and could not tell which one they are currently in.
 * `RadioGroup` + `RadioItem` announce as `menuitemradio` with `aria-checked`
 * computed from the group's `value`, which is the same fact the check mark shows
 * sighted users. Radix owns the wiring, so the two cannot disagree.
 */
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.RadioItem
    ref={ref}
    // Same row measure and same focus ring as `DropdownMenuItem`: a radio row is
    // a row first. It does NOT reserve an indicator gutter — the caller draws the
    // check it wants, exactly as the action rows do.
    className={menuRowClass({ className })}
    {...props}
  />
));
DropdownMenuRadioItem.displayName = MenuPrimitive.RadioItem.displayName;

/**
 * An on/off row (`menuitemcheckbox`, `aria-checked`), for a choice that rides along
 * with the action rows rather than being one of them (new-session 「worktree 격리」,
 * #2775). Same row measure and focus ring as `RadioItem`; the caller draws the check.
 * `layout="stack"` lets a disabled row carry its reason on a second line.
 */
export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem> & { layout?: "row" | "stack" }
>(({ className, layout = "row", ...props }, ref) => (
  <MenuPrimitive.CheckboxItem
    ref={ref}
    className={menuRowClass({ layout, className })}
    {...props}
  />
));
DropdownMenuCheckboxItem.displayName = MenuPrimitive.CheckboxItem.displayName;

/**
 * A group's **title**: the line that names what the rows beneath it are, rather
 * than being one of them.
 *
 * Radix renders it as a plain `div`, outside the item collection, and that is
 * the property doing the work here: arrow-key roving walks past it, it takes no
 * focus, typeahead never lands on it. Which is why a title is this primitive and
 * not a `disabled` `Item` — a disabled item is still an item, and it announces
 * as one that failed.
 *
 * **It carries no aria linkage of its own.** Radix gives it no `id` and wires
 * nothing, so a title that only decorates leaves the group it heads unnamed to a
 * screen reader. The house answer is written next door in `HostPicker`: the
 * visible label takes an `id` and the group points back with `aria-labelledby`.
 * (Its sibling `SpawnHostChoice` reaches the same place through native
 * `fieldset`/`legend` instead, which needs no id at all — its `useId` feeds
 * `htmlFor` on the radio rows. A menu has neither element available, so this
 * primitive is on the `HostPicker` path.) A label is a name, not an ornament,
 * and `PresenceControl` is the worked example.
 *
 * Measure: `text-meta font-medium text-ink-muted`, the three classes
 * `SidebarSection`'s `<h2>` already wears. A group title inside a menu and a
 * section title in the sidebar are the same rank of thing, so they get the same
 * size, weight and ink rather than a fourth micro-label style. `py-1` keeps it
 * visibly shorter than the 32px rows, so it reads as a header before it reads as
 * a choice, and `px-2` sets it on the rows' own left edge.
 *
 * When a group may fold into a submenu instead (only if none of its rows can be
 * locked): file header.
 */
export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Label
    ref={ref}
    className={cn(
      "select-none px-2 py-1 text-meta font-medium text-ink-muted",
      className
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = MenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-line", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = MenuPrimitive.Separator.displayName;

// =============================================================================
// 하위 메뉴 (#5777, owner 2026-11-14) — 고를 수 없는 줄이 없는 묶음에만. 규칙과 이유: 파일 머리말.
//
// 이 아래 셋(판 클래스 · 줄 끝 ›  · 가드)은 컨텍스트 메뉴의 하위 메뉴(`context-menu.tsx`)도 같이 쓴다.
// 두 메뉴가 같은 판·같은 줄을 입는 것이 이 파일과 그 파일의 약속이다(그 파일 머리말).
// =============================================================================

/**
 * 하위 메뉴 판. 부모 판과 같은 그릇(층 · 테두리 · 그림자 · 안쪽 4px)이고, 컨텍스트 메뉴 판처럼 창보다
 * 길면 판 안에서 스크롤한다(`max-h-menu-available`, Radix 가 하위 판에도 가용 높이를 싣는다). 섹션
 * 목적지는 50개까지 늘 수 있다(ADR-0177). 폭도 그 쪽의 가용 폭을 넘지 않는다(`max-w-menu-available`): 부모
 * 판 양쪽 다 자리가 모자라면 Radix 는 뒤집기만 하고 줄이지 않으므로, 긴 섹션 이름은 판 안에서 잘린다(전체
 * 이름은 줄의 title).
 */
export const submenuPanelClass =
  "layer-overlay-surface min-w-pane-sm max-w-menu-available max-h-menu-available overscroll-contain scrollbar-visible rounded-lg border border-line bg-surface-raised p-1 text-ink shadow-lg";

/**
 * 하위 판이 서는 자리. 부모 판의 테두리 1 + 안쪽 4 = 5px 이 줄과 판 가장자리 사이에 있다.
 * - 세로(`alignOffset` −5): 하위 판의 첫 줄 윗변이 그 하위 메뉴를 연 줄의 윗변과 같은 높이에 선다.
 * - 가로(`sideOffset` 5 + 4): 두 판의 테두리가 겹치지 않고 4px 사이를 둔다(간격 사다리의 가장 작은 칸).
 * 창 가장자리에 닿으면 Radix 가 반대쪽으로 뒤집고 위아래로 밀어 넣는다(`collisionPadding` 8, 부모 판과 같다).
 */
export const SUBMENU_ALIGN_OFFSET = -5;
export const SUBMENU_SIDE_OFFSET = 9;

/**
 * 하위 메뉴를 여는 줄의 끝 표지(›). 줄의 글자보다 한 단 연한 잉크이고 오른쪽 끝에 붙는다. 읽는 이름은
 * Radix 가 `aria-haspopup="menu"` · `aria-expanded` 로 따로 말하므로 그림은 숨긴다.
 */
export function SubmenuChevron() {
  return (
    <ChevronRight
      className="ml-auto size-4 shrink-0 text-ink-muted"
      aria-hidden="true"
      data-submenu-chevron=""
    />
  );
}

/**
 * 하위 판 안에 고를 수 없는 줄이 있을 때 개발 중에 내는 말. 화면 문구가 아니라 개발자 콘솔의 말이라 사전 키가
 * 아니다(직접 문구 장부 밖). 시험이 이 문장을 그대로 기다린다.
 */
export const SUBMENU_LOCKED_ROW_ERROR =
  "[oort menu] A submenu panel holds a row that cannot be chosen. Submenus are only for groups with no locked row (docs/design-system/README.md, menus). Show this group as a title over rows that stay on screen.";

/**
 * 규칙 가드: 하위 판이 붙는 순간 그 안에 `data-disabled` 줄(Radix 가 잠긴 항목에 다는 표지)이 있으면
 * 개발 중 오류를 낸다. 판이 열릴 때마다 한 번 본다(판은 열릴 때 붙고 닫힐 때 떨어진다). 배포 빌드에서는
 * 아무 일도 하지 않는다.
 */
export function guardSubmenuRows(node: HTMLElement | null): void {
  if (!import.meta.env.DEV || node === null) return;
  if (node.querySelector("[data-disabled]") !== null) {
    console.error(SUBMENU_LOCKED_ROW_ERROR);
  }
}

/** 넘겨받은 ref 에 가드를 끼운다. 판이 붙을 때(노드) · 떨어질 때(null) 둘 다 넘긴다. */
export function useSubmenuGuardRef<T extends HTMLElement>(
  forwarded: React.ForwardedRef<T>
): (node: T | null) => void {
  return React.useCallback(
    (node: T | null) => {
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
      guardSubmenuRows(node);
    },
    [forwarded]
  );
}

export const DropdownMenuSub = MenuPrimitive.Sub;

/**
 * 하위 메뉴를 여는 줄. 다른 줄과 같은 자(`menuRowClass`)를 입고 끝에 › 가 선다. 열려 있는 동안은
 * 포인터가 하위 판으로 건너가도 이 줄이 호버 배경을 지켜, 떠 있는 판이 어느 줄의 것인지 말한다.
 * 키보드: Enter · Space · → 가 열고 첫 줄에 캐럿을 둔다. 하위 판 안의 ← 가 닫고 이 줄로 돌아온다(Radix).
 */
export const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.SubTrigger
    ref={ref}
    className={menuRowClass({
      className: cn("data-[state=open]:bg-surface-hover", className),
    })}
    {...props}
  >
    {children}
    <SubmenuChevron />
  </MenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = MenuPrimitive.SubTrigger.displayName;

export const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent> & {
    container?: HTMLElement | null;
  }
>(({ className, container, ...props }, ref) => {
  const guardedRef = useSubmenuGuardRef(ref);
  return (
    <MenuPrimitive.Portal container={container ?? undefined}>
      <MenuPrimitive.SubContent
        ref={guardedRef}
        sideOffset={SUBMENU_SIDE_OFFSET}
        alignOffset={SUBMENU_ALIGN_OFFSET}
        collisionPadding={8}
        className={cn(submenuPanelClass, POPOVER_MOTION, className)}
        {...props}
        data-overlay-layer="surface"
      />
    </MenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName = MenuPrimitive.SubContent.displayName;
