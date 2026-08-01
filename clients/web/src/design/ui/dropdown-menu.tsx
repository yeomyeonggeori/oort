import * as React from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/design/lib/cn";

// shadcn/ui new-york DropdownMenu (vendored, Radix primitive).
//
// Added in B11 R2 for the message row's single action entry point. The row used
// to carry a six-button hover bar, which §6 rules out ("row-level actions live
// in ContextMenu, not always-visible button rows") and which cost one tab stop
// per button on every row of a virtualized list. A menu needs collision-aware
// positioning, a focus scope, arrow-key roving, Escape, outside-dismiss and
// focus return to the trigger; hand-rolling those inside a recycled row is how
// you ship a menu that survives every case but the one nobody tried.
//
// Same two house deviations as the Dialog: no animation (motion is feedback,
// §4), and no decorative chrome.
//
// `ContextMenu` proper (right-click) is deliberately NOT used as the only path:
// a right-click menu has no visible affordance, and the row has to be operable
// by a pointer that never right-clicks and by Tab. The trigger is that
// affordance and this menu is what it opens.

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
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        "z-50 min-w-pane-sm rounded-md border border-line bg-surface-raised p-1 text-ink shadow-lg",
        className
      )}
      {...props}
    />
  </MenuPrimitive.Portal>
));
DropdownMenuContent.displayName = MenuPrimitive.Content.displayName;

/**
 * One row of the menu. `h-control` (32px) is the pointer measure: this menu is
 * opened by a mouse or a Tab, never by a thumb (the phone opens the sheet in
 * `MessageActions.tsx`, whose rows are 44px).
 *
 * Radix moves focus with the arrow keys, so the highlight is a focus ring and a
 * background, not a separate "selected" concept.
 */
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    tone?: "danger";
  }
>(({ className, tone, ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={cn(
      // Radix walks focus through the items with the arrow keys, so the moving
      // background is the menu's own language and the browser's default ring is
      // suppressed below. The house focus ring is restored on the same class
      // list (§6): it is what tells a Tab user which row Enter will fire.
      "flex h-control cursor-default select-none items-center gap-2 rounded-sm px-2 text-body outline-none focus:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      tone === "danger" ? "text-danger" : "text-ink",
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = MenuPrimitive.Item.displayName;

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
