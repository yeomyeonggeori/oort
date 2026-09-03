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

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      collisionPadding={8}
      className={cn(
        "z-50 min-w-pane-sm rounded-md border border-line bg-surface-raised p-1 text-ink shadow-lg",
        POPOVER_MOTION,
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    tone?: "danger";
  }
>(({ className, tone, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={menuRowClass({ tone, className })}
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
