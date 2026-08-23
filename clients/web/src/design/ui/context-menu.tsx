import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/design/lib/cn";
import { menuRowClass } from "@/design/ui/dropdown-menu";

// shadcn/ui new-york ContextMenu (vendored, Radix primitive).
//
// A message row already has a visible DropdownMenu trigger and a touch action
// sheet. This primitive adds the pointer-native summons without creating a
// third visual language: its panel, rows, focus treatment and separators reuse
// the exact DropdownMenu classes. Positioning, collision handling, arrow-key
// roving and focus restoration remain Radix's responsibility.

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
