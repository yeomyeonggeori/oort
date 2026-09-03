import * as React from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
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
// ## Submenus (`DropdownMenuSub*`) are deliberately NOT introduced — 이슈 #1383
//
// If you came here to add one, this is the paragraph. Grouping arrived instead
// as `DropdownMenuLabel` (a title over rows that stay on screen), because a
// submenu does the one thing the house rule forbids: **an ineligible option
// stays visible, with its reason.** The server ships ineligible hosts instead of
// filtering them (이슈 #1132), and `SpawnHostChoice` is a radio list rather than
// a `<select>` precisely because a closed control turned 「낡은 맥 (오프라인)」
// into a footnote you had to open something to read. A submenu repeats that one
// level up: it puts a whole group behind a hover or an arrow key, so the answer
// to "왜 저기서는 못 돌리지" sits one interaction away, which is to say the
// screen does not answer it. A title over visible rows buys the grouping without
// spending the rows.
//
// Adopting submenus therefore means re-arguing that rule, which is ADR work and
// not a component change.
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
        "z-50 min-w-pane-sm rounded-md border border-line bg-surface-raised p-1 text-ink shadow-lg",
        POPOVER_MOTION,
        className
      )}
      {...props}
      {...({ onOpenAutoFocus } as React.ComponentPropsWithoutRef<
        typeof MenuPrimitive.Content
      >)}
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
    "tap-target flex cursor-default select-none gap-2 rounded-sm px-2 text-body outline-none focus:bg-surface-hover focus-visible:focus-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
 * Why grouping is a title over visible rows rather than a submenu: file header.
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
